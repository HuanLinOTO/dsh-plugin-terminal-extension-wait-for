/**
 * wait-for.ts — terminal_wait_for core.
 *
 * Host-free logic: the caller injects `read` / `list` / `now` / `sleep`, so the
 * poll loop, pattern compilation/fallback, absolute line math, and rendering are
 * unit-testable without a live DSH composition.
 *
 * Conventions (plugin-development-guide.md §3):
 *   C4 — the registered tool returns one canonical JSON value; rendering is a
 *        separate pure projection ({@link renderWaitOutcome}).
 *   C5 — cancellation is a business outcome (`cancelled`) rather than a throw;
 *        infrastructure failures (unknown session errors, read failures that are
 *        not NO_SESSION) propagate.
 *   C6 — the caller's signal is honored at every await point (sleep).
 *
 * @module @huanlin/dsh-plugin-terminal-extension-wait-for/wait-for
 */

/** Bounded retained-output page returned by `ctx.terminals.read`. */
export interface TerminalReadResult {
  /** Retained text in chronological order. */
  text: string
  /** Number of lines currently retained. */
  totalLines: number
  /** Inclusive newest-relative offset of the first returned line. */
  lineBegin: number
  /** Exclusive newest-relative offset after the returned page. */
  lineEnd: number
  /** Whether older retained output or the returned page exceeded a bound. */
  truncated: boolean
}

/** Top-level terminal status, mirroring the terminal service snapshot. */
export type TerminalSessionStatus =
  | { kind: 'running' }
  | { kind: 'exited'; exitCode: number | null; signal: string | null }

/** Owner-visible session summary used to detect exit and disappearance. */
export interface TerminalSessionSnapshot {
  sessionId: string
  status: TerminalSessionStatus
}

/** One hit inside a single line. */
export interface PatternMatch {
  /** 0-based character index of the match start within the line. */
  index: number
  /** The text that actually matched. */
  match: string
}

/** Compiled pattern plus the matching strategy actually in force. */
export interface CompiledPattern {
  /** The original caller-supplied pattern. */
  readonly source: string
  /** False when the pattern failed to compile and verbatim matching is used. */
  readonly isRegex: boolean
  match(line: string): PatternMatch | null
}

/**
 * Compile the caller pattern as a JavaScript regular expression; a pattern that
 * fails to compile falls back to verbatim substring matching (better-sidebar
 * precedent). Matching is case-sensitive and stateless.
 */
export function compilePattern(pattern: string): CompiledPattern {
  try {
    const expression = new RegExp(pattern)
    return {
      source: pattern,
      isRegex: true,
      match(line) {
        const found = expression.exec(line)
        return found === null ? null : { index: found.index, match: found[0] }
      },
    }
  } catch {
    return {
      source: pattern,
      isRegex: false,
      match(line) {
        const index = line.indexOf(pattern)
        return index < 0 ? null : { index, match: pattern }
      },
    }
  }
}

/** Deployment bounds applied to a per-call timeout request. */
export interface TimeoutConfig {
  defaultTimeoutMs: number
  minTimeoutMs: number
  maxTimeoutMs: number
}

/**
 * Resolve a per-call `timeout_ms` against the configured bounds: a missing or
 * non-finite request uses the default; everything else is floored and clamped.
 */
export function resolveTimeoutMs(requested: number | undefined, config: TimeoutConfig): number {
  const base = typeof requested === 'number' && Number.isFinite(requested)
    ? Math.floor(requested)
    : config.defaultTimeoutMs
  return Math.min(config.maxTimeoutMs, Math.max(config.minTimeoutMs, base))
}

/**
 * Sleep for `ms`, resolving `false` when `signal` aborts first and `true` when
 * the timer completes. An already-aborted signal resolves `false` without
 * scheduling a timer; the abort listener is removed on both paths.
 */
export function sleepWithAbort(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false)
  if (!(ms > 0)) return Promise.resolve(true)
  return new Promise<boolean>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const onAbort = (): void => {
      if (timer !== undefined) clearTimeout(timer)
      resolve(false)
    }
    timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve(true)
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/** Bounds for one scan's excerpts. */
export interface ScanOptions {
  tailLines: number
  maxLineTextChars: number
  maxTailBytes: number
}

/** One page scan: the first match plus bounded excerpts. */
export interface PageScan {
  match: PatternMatch | null
  /** Absolute 0-based line index (from the oldest retained line) of the match. */
  line: number
  column: number
  lineText: string
  totalLines: number
  tail: string
  scannedLines: number
}

function boundChars(text: string, maxChars: number): string {
  if (maxChars <= 0) return ''
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}…[truncated]`
}

/**
 * Keep the trailing UTF-8 bytes of `text`. A cut through a code point drops the
 * damaged leading replacement character rather than emitting it.
 */
function boundTailBytes(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return ''
  const buffer = Buffer.from(text, 'utf8')
  if (buffer.byteLength <= maxBytes) return text
  return buffer.subarray(buffer.byteLength - maxBytes).toString('utf8').replace(/^\uFFFD/, '')
}

/**
 * Scan one retained-output page for the first line matching `pattern`. The
 * absolute line index is `totalLines - lineEnd + indexInPage`, matching the
 * backend's newest-relative paging.
 */
export function scanPage(page: TerminalReadResult, pattern: CompiledPattern, options: ScanOptions): PageScan {
  const lines = page.text.length === 0 ? [] : page.text.split('\n')
  const absoluteStart = Math.max(0, page.totalLines - page.lineEnd)
  let match: PatternMatch | null = null
  let line = -1
  let lineText = ''
  for (let index = 0; index < lines.length; index += 1) {
    const found = pattern.match(lines[index] ?? '')
    if (found !== null) {
      match = found
      line = absoluteStart + index
      lineText = lines[index] ?? ''
      break
    }
  }
  const tailSource = options.tailLines > 0 ? lines.slice(-options.tailLines).join('\n') : ''
  return {
    match,
    line,
    column: match?.index ?? -1,
    lineText: boundChars(lineText, options.maxLineTextChars),
    totalLines: page.totalLines,
    tail: boundTailBytes(tailSource, options.maxTailBytes),
    scannedLines: lines.length,
  }
}

/** Settled outcome of one wait. */
export type WaitOutcome =
  | {
    kind: 'found'
    match: string
    line: number
    column: number
    lineText: string
    elapsedMs: number
    scannedLines: number
  }
  | {
    kind: 'timeout'
    timeoutMs: number
    totalLines: number
    tail: string
    scannedLines: number
    elapsedMs: number
  }
  | { kind: 'exited'; exitCode: number | null; signal: string | null; elapsedMs: number }
  | { kind: 'gone'; elapsedMs: number }
  | { kind: 'cancelled'; elapsedMs: number }

/** One wait request resolved by the tool layer. */
export interface WaitRequest {
  sessionId: string
  pattern: CompiledPattern
  timeoutMs: number
  pollIntervalMs: number
  signal: AbortSignal
}

/** Injected host surface for {@link waitForPattern}. */
export interface WaitDeps {
  read(sessionId: string): TerminalReadResult
  list(): readonly TerminalSessionSnapshot[]
  now(): number
  sleep(ms: number, signal: AbortSignal): Promise<boolean>
}

/** Recognize the terminal registry's `NO_SESSION` error by its stable code. */
export function isNoSessionError(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && (error as { code?: unknown }).code === 'NO_SESSION'
}

/**
 * Poll retained output until the pattern matches, the deadline elapses, the
 * session exits or disappears, or the signal aborts. The first scan happens
 * immediately, so a pattern already present resolves without sleeping.
 */
export async function waitForPattern(
  deps: WaitDeps,
  request: WaitRequest & ScanOptions,
): Promise<WaitOutcome> {
  const start = deps.now()
  for (;;) {
    let page: TerminalReadResult
    try {
      page = deps.read(request.sessionId)
    } catch (error) {
      if (isNoSessionError(error)) return { kind: 'gone', elapsedMs: deps.now() - start }
      throw error
    }
    const scan = scanPage(page, request.pattern, request)
    if (scan.match !== null) {
      return {
        kind: 'found',
        match: scan.match.match,
        line: scan.line,
        column: scan.column,
        lineText: scan.lineText,
        elapsedMs: deps.now() - start,
        scannedLines: scan.scannedLines,
      }
    }
    const snapshot = deps.list().find(item => item.sessionId === request.sessionId)
    if (snapshot === undefined) return { kind: 'gone', elapsedMs: deps.now() - start }
    if (snapshot.status.kind === 'exited') {
      return {
        kind: 'exited',
        exitCode: snapshot.status.exitCode,
        signal: snapshot.status.signal,
        elapsedMs: deps.now() - start,
      }
    }
    const elapsed = deps.now() - start
    const remaining = request.timeoutMs - elapsed
    if (remaining <= 0) {
      return {
        kind: 'timeout',
        timeoutMs: request.timeoutMs,
        totalLines: scan.totalLines,
        tail: scan.tail,
        scannedLines: scan.scannedLines,
        elapsedMs: elapsed,
      }
    }
    const slept = await deps.sleep(Math.min(request.pollIntervalMs, remaining), request.signal)
    if (!slept) return { kind: 'cancelled', elapsedMs: deps.now() - start }
  }
}

/** Project a wait outcome to the model-facing text (pure; replay-safe). */
export function renderWaitOutcome(value: WaitOutcome): string {
  switch (value.kind) {
    case 'found':
      return `[found] match ${JSON.stringify(value.match)} at line ${value.line}, column ${value.column} (waited ${value.elapsedMs}ms)\n${value.lineText}`
    case 'timeout':
      return `[timeout] pattern did not appear within ${value.timeoutMs}ms; ${value.totalLines} lines retained, scanned ${value.scannedLines}. Tail:\n${value.tail}`
    case 'exited': {
      const detail = value.exitCode ?? value.signal ?? 'unknown'
      return `[exited] terminal session exited (${detail}) before the pattern appeared (waited ${value.elapsedMs}ms)`
    }
    case 'gone':
      return `[gone] terminal session no longer exists; the pattern was not seen (waited ${value.elapsedMs}ms)`
    case 'cancelled':
      return `[cancelled] wait was cancelled after ${value.elapsedMs}ms`
  }
}
