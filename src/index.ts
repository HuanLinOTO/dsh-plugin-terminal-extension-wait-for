/**
 * index.ts — dsh-plugin-terminal-extension-wait-for entry (host half).
 *
 * Single model-facing tool: `terminal_wait_for`. It blocks until a pattern
 * appears in a persistent terminal's retained output, or until timeout / session
 * exit / session gone / cancellation — without writing any input. All state is
 * read through the owner-scoped `ctx.terminals` service, so the plugin never
 * imports `@deepseek-ai/dsh-terminal` and never touches terminal internals.
 *
 * Conventions (plugin-development-guide.md §3):
 *   C4 — execute returns one canonical JSON value; render is a separate pure
 *        projection.
 *   C5 — cancellation and the other non-ideal wait outcomes are values, not
 *        thrown errors; infrastructure failures (missing agent, foreign
 *        session) throw.
 *   C6 — exec.signal is honored while polling.
 *
 * Tool registration is effect-based: disposing the plugin fiber (e.g. on config
 * change) unregisters the tool and the next apply() re-registers with the fresh
 * config.
 *
 * @module @huanlin/dsh-plugin-terminal-extension-wait-for
 */

import z from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  compilePattern,
  renderWaitOutcome,
  resolveTimeoutMs,
  sleepWithAbort,
  waitForPattern,
  type WaitOutcome,
} from './wait-for.js'

export const name = 'terminal-extension-wait-for'
export const inject = ['terminals', 'tools']

/** Plugin configuration (all fields optional; defaults documented below). */
export interface Config {
  /** Wait bound used when the model omits `timeout_ms` (default 10000). */
  defaultTimeoutMs?: number
  /** Hard cap for any single wait; larger requests are clamped (default 600000). */
  maxTimeoutMs?: number
  /** Smallest wait bound; smaller requests are clamped (default 100). */
  minTimeoutMs?: number
  /** Poll interval in milliseconds (default 150). */
  pollIntervalMs?: number
  /** Most recent retained lines scanned on every poll (default 2000). */
  scanLines?: number
  /** Lines carried by a `timeout` outcome (default 30; 0 disables the tail). */
  tailLines?: number
  /** Character cap for `found.lineText` (default 1000; 0 disables it). */
  maxLineTextChars?: number
  /** UTF-8 byte cap for `timeout.tail` (default 8192; 0 disables it). */
  maxTailBytes?: number
}

/** Schemastery configuration schema; defaults mirror {@link resolveConfig}. */
export const Config: z<Config> = z.object({
  defaultTimeoutMs: z.number().default(10000).description('Wait bound used when the model omits timeout_ms.'),
  maxTimeoutMs: z.number().default(600000).description('Hard cap for any single wait; larger requests are clamped.'),
  minTimeoutMs: z.number().default(100).description('Smallest wait bound; smaller requests are clamped.'),
  pollIntervalMs: z.number().default(150).description('Poll interval in milliseconds.'),
  scanLines: z.number().default(2000).description('Most recent retained lines scanned on every poll.'),
  tailLines: z.number().default(30).description('Lines carried by a timeout outcome.'),
  maxLineTextChars: z.number().default(1000).description('Character cap for found.lineText.'),
  maxTailBytes: z.number().default(8192).description('UTF-8 byte cap for timeout.tail.'),
})

/** Configuration after validation, with every field resolved. */
export interface ResolvedConfig {
  defaultTimeoutMs: number
  maxTimeoutMs: number
  minTimeoutMs: number
  pollIntervalMs: number
  scanLines: number
  tailLines: number
  maxLineTextChars: number
  maxTailBytes: number
}

function resolveCount(label: string, value: number | undefined, fallback: number, minimum: number): number {
  const resolved = value ?? fallback
  if (typeof resolved !== 'number' || !Number.isSafeInteger(resolved) || resolved < minimum) {
    throw new Error(`terminal-extension-wait-for: ${label} must be a safe integer >= ${minimum}`)
  }
  return resolved
}

/** Validate configuration loudly instead of silently degrading. */
export function resolveConfig(config: Config = {}): ResolvedConfig {
  const minTimeoutMs = resolveCount('minTimeoutMs', config.minTimeoutMs, 100, 1)
  const maxTimeoutMs = resolveCount('maxTimeoutMs', config.maxTimeoutMs, 600000, 1)
  if (maxTimeoutMs < minTimeoutMs) {
    throw new Error('terminal-extension-wait-for: maxTimeoutMs must be >= minTimeoutMs')
  }
  const defaultTimeoutMs = resolveCount('defaultTimeoutMs', config.defaultTimeoutMs, 10000, 1)
  if (defaultTimeoutMs < minTimeoutMs || defaultTimeoutMs > maxTimeoutMs) {
    throw new Error('terminal-extension-wait-for: defaultTimeoutMs must be within [minTimeoutMs, maxTimeoutMs]')
  }
  return {
    defaultTimeoutMs,
    maxTimeoutMs,
    minTimeoutMs,
    pollIntervalMs: resolveCount('pollIntervalMs', config.pollIntervalMs, 150, 1),
    scanLines: resolveCount('scanLines', config.scanLines, 2000, 1),
    tailLines: resolveCount('tailLines', config.tailLines, 30, 0),
    maxLineTextChars: resolveCount('maxLineTextChars', config.maxLineTextChars, 1000, 0),
    maxTailBytes: resolveCount('maxTailBytes', config.maxTailBytes, 8192, 0),
  }
}

const OUTCOME_SCHEMA = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: { type: 'string', required: true, const: 'found' },
        match: { type: 'string', required: true, description: 'The text that actually matched; for a multi-outcome pattern this tells which alternative hit.' },
        line: { type: 'integer', required: true, description: '0-based line index in the retained transcript.' },
        column: { type: 'integer', required: true, description: '0-based character index of the match within its line.' },
        lineText: { type: 'string', required: true, description: 'The full matched line, possibly truncated.' },
        elapsedMs: { type: 'integer', required: true, description: 'Wall-clock milliseconds from wait start to the match.' },
        scannedLines: { type: 'integer', required: true, description: 'Lines scanned in the matching poll.' },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: { type: 'string', required: true, const: 'timeout' },
        timeoutMs: { type: 'integer', required: true, description: 'The configured timeout that elapsed.' },
        totalLines: { type: 'integer', required: true, description: 'Lines retained when the timeout fired.' },
        tail: { type: 'string', required: true, description: 'Bounded tail of the retained output at the timeout.' },
        scannedLines: { type: 'integer', required: true, description: 'Lines scanned in the final poll.' },
        elapsedMs: { type: 'integer', required: true, description: 'Wall-clock milliseconds actually waited.' },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: { type: 'string', required: true, const: 'exited' },
        exitCode: { required: true, oneOf: [{ type: 'integer' }, { type: 'null' }], description: 'Exit code of the top-level shell, if known.' },
        signal: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }], description: 'Exit signal of the top-level shell, if killed by one.' },
        elapsedMs: { type: 'integer', required: true, description: 'Wall-clock milliseconds waited before the exit was observed.' },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: { type: 'string', required: true, const: 'gone' },
        elapsedMs: { type: 'integer', required: true, description: 'Wall-clock milliseconds waited before the session disappeared.' },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: { type: 'string', required: true, const: 'cancelled' },
        elapsedMs: { type: 'integer', required: true, description: 'Wall-clock milliseconds waited before the call was aborted.' },
      },
    },
  ],
} as const

const TOOL_DESCRIPTION = 'Block until a pattern appears in a persistent terminal\'s retained output, or until the timeout elapses, or until the session exits or disappears — whichever happens first. '
  + 'Does not write input, so it is safe while a background command or job is still running. '
  + 'Use it after terminal_send returned inferred_idle/timeout or started a background job, to synchronize on command cues (a shell prompt, "Listening on", "(PASS|FAIL)") instead of busy-polling terminal_read. '
  + 'The pattern is a JavaScript regular expression (case-sensitive); a pattern that fails to compile falls back to verbatim substring matching. '
  + 'One pattern may cover several outcomes, e.g. (BUILD OK|BUILD FAIL) — the found result\'s match field tells which alternative hit. '
  + 'Every poll scans the most recently retained output, so a needle that scrolled past the newest chunk is still a match while it remains inside the configured scan window. '
  + 'Returns kind=found with the matched text, retained line number, column and line text; kind=timeout with a bounded tail; kind=exited or kind=gone; or kind=cancelled when the call is aborted.'

interface WaitArgs {
  sessionId: string
  pattern: string
  timeout_ms?: number
}

/** Register `terminal_wait_for` once the terminal service is available. */
export function apply(ctx: Context, config: Config = {}): void {
  const resolved = resolveConfig(config)

  ctx.tools.register(defineTool({
    name: 'terminal_wait_for',
    description: TOOL_DESCRIPTION,
    parameters: {
      sessionId: { type: 'string', required: true, description: 'Terminal session id returned by terminal_open or terminal_list.' },
      pattern: { type: 'string', required: true, description: 'JavaScript regular expression to wait for (case-sensitive); an invalid pattern falls back to verbatim substring matching. Must be non-empty.' },
      timeout_ms: { type: 'integer', description: 'Maximum wait in milliseconds. Defaults to the plugin default and is clamped to the plugin bounds.' },
    },
    output: {
      schema: OUTCOME_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: renderWaitOutcome(value as WaitOutcome) }],
    },
    async execute(args, exec) {
      const parsed = args as WaitArgs
      if (parsed.sessionId.length === 0) throw new Error('sessionId must be a non-empty string')
      if (parsed.pattern.length === 0) throw new Error('pattern must be a non-empty string')
      const owner = exec.agent
      if (owner === undefined) throw new Error('terminal_wait_for requires an initiating agent')
      const outcome = await waitForPattern({
        read: sessionId => ctx.terminals.read(owner, sessionId, { offset: 0, count: resolved.scanLines }),
        list: () => ctx.terminals.list(owner),
        now: () => Date.now(),
        sleep: sleepWithAbort,
      }, {
        sessionId: parsed.sessionId,
        pattern: compilePattern(parsed.pattern),
        timeoutMs: resolveTimeoutMs(parsed.timeout_ms, resolved),
        pollIntervalMs: resolved.pollIntervalMs,
        tailLines: resolved.tailLines,
        maxLineTextChars: resolved.maxLineTextChars,
        maxTailBytes: resolved.maxTailBytes,
        signal: exec.signal,
      })
      return outcome
    },
  }))
}
