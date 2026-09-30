/**
 * Core wait-for tests. The fake terminal mirrors terminal-bash read() paging:
 * newest-relative offset, byte-bounded tail, lineBegin/lineEnd metadata.
 */

import { describe, expect, it } from 'vitest'
import {
  compilePattern,
  isNoSessionError,
  renderWaitOutcome,
  resolveTimeoutMs,
  scanPage,
  waitForPattern,
  type TerminalReadResult,
  type TerminalSessionSnapshot,
  type TerminalSessionStatus,
  type WaitDeps,
  type WaitOutcome,
} from '../src/wait-for.js'

const TIMEOUT_CONFIG = { defaultTimeoutMs: 10000, minTimeoutMs: 100, maxTimeoutMs: 600000 }
const SCAN_OPTIONS = { tailLines: 30, maxLineTextChars: 1000, maxTailBytes: 8192 }

interface FakeTerminals {
  lines: string[]
  status: TerminalSessionStatus | null
  pageCount: number
  read(request?: { offset?: number; count?: number }): TerminalReadResult
  list(): TerminalSessionSnapshot[]
}

function makeFakeTerminals(sessionId = 'pty-1'): FakeTerminals {
  const fake: FakeTerminals = {
    lines: [],
    status: { kind: 'running' },
    pageCount: 0,
    read(request = {}) {
      const totalLines = fake.lines.length
      const offset = request.offset ?? 0
      const count = request.count ?? 500
      if (offset >= totalLines) {
        return { text: '', totalLines, lineBegin: offset, lineEnd: offset, truncated: false }
      }
      const end = totalLines - offset
      const start = Math.max(0, end - count)
      const text = fake.lines.slice(start, end).join('\n')
      const returnedLines = text.length === 0 ? 0 : text.split('\n').length
      fake.pageCount += 1
      return { text, totalLines, lineBegin: offset, lineEnd: offset + returnedLines, truncated: false }
    },
    list() {
      return fake.status === null ? [] : [{ sessionId, status: fake.status }]
    },
  }
  return fake
}

function fakeClock(): { now: () => number; advance: (ms: number) => void } {
  let seconds = 0
  return {
    now: () => seconds,
    advance: (ms: number) => {
      seconds += ms
    },
  }
}

function depsFor(fake: FakeTerminals, overrides: Partial<WaitDeps> = {}): WaitDeps {
  return {
    read: () => fake.read({ offset: 0, count: 2000 }),
    list: () => fake.list(),
    now: () => 0,
    sleep: async () => true,
    ...overrides,
  }
}

function request(pattern: string, overrides: Partial<Parameters<typeof waitForPattern>[1]> = {}) {
  return {
    sessionId: 'pty-1',
    pattern: compilePattern(pattern),
    timeoutMs: 1000,
    pollIntervalMs: 100,
    ...SCAN_OPTIONS,
    signal: new AbortController().signal,
    ...overrides,
  }
}

describe('compilePattern', () => {
  it('compiles a valid regex and reports the matched text', () => {
    const compiled = compilePattern('BUILD_(OK|FAIL)')
    expect(compiled.isRegex).toBe(true)
    expect(compiled.match('all good BUILD_OK after 3s')).toEqual({ index: 9, match: 'BUILD_OK' })
    expect(compiled.match('nothing here')).toBeNull()
  })

  it('falls back to verbatim matching when the pattern does not compile', () => {
    const compiled = compilePattern('BUILD_(OK')
    expect(compiled.isRegex).toBe(false)
    expect(compiled.match('x BUILD_(OK y')).toEqual({ index: 2, match: 'BUILD_(OK' })
    expect(compiled.match('x BUILD_OK y')).toBeNull()
  })
})

describe('resolveTimeoutMs', () => {
  it('uses the default for a missing or non-finite request', () => {
    expect(resolveTimeoutMs(undefined, TIMEOUT_CONFIG)).toBe(10000)
    expect(resolveTimeoutMs(Number.NaN, TIMEOUT_CONFIG)).toBe(10000)
  })

  it('clamps to the configured minimum and maximum', () => {
    expect(resolveTimeoutMs(5, TIMEOUT_CONFIG)).toBe(100)
    expect(resolveTimeoutMs(1_000_000_000, TIMEOUT_CONFIG)).toBe(600000)
    expect(resolveTimeoutMs(12_345.9, TIMEOUT_CONFIG)).toBe(12345)
  })
})

describe('scanPage', () => {
  it('maps a page hit to the absolute retained line index', () => {
    const fake = makeFakeTerminals()
    fake.lines = ['l0', 'l1', 'l2', 'l3', 'l4']
    const page = fake.read({ offset: 0, count: 2 })
    const scan = scanPage(page, compilePattern('l3'), SCAN_OPTIONS)
    expect(scan.match).toEqual({ index: 0, match: 'l3' })
    expect(scan.line).toBe(3)
    expect(scan.column).toBe(0)
    expect(scan.lineText).toBe('l3')
    expect(scan.totalLines).toBe(5)
    expect(scan.scannedLines).toBe(2)
  })

  it('keeps only the tail bytes of the timeout excerpt', () => {
    const fake = makeFakeTerminals()
    fake.lines = ['abc', 'def']
    const page = fake.read({ offset: 0, count: 10 })
    const scan = scanPage(page, compilePattern('never'), { ...SCAN_OPTIONS, tailLines: 30, maxTailBytes: 3 })
    expect(scan.match).toBeNull()
    expect(scan.tail).toBe('def')
  })

  it('truncates a long matching line', () => {
    const fake = makeFakeTerminals()
    fake.lines = [`needle ${'x'.repeat(50)}`]
    const page = fake.read({ offset: 0, count: 10 })
    const scan = scanPage(page, compilePattern('needle'), { ...SCAN_OPTIONS, maxLineTextChars: 6 })
    expect(scan.lineText).toBe('needle…[truncated]')
  })
})

describe('waitForPattern', () => {
  it('finds a pattern that is already present without sleeping', async () => {
    const fake = makeFakeTerminals()
    fake.lines = ['$ make', 'BUILD OK', 'done']
    let sleeps = 0
    const outcome = await waitForPattern(depsFor(fake, { sleep: async () => { sleeps += 1; return true } }), request('BUILD OK'))
    expect(outcome).toMatchObject({ kind: 'found', match: 'BUILD OK', line: 1, column: 0, lineText: 'BUILD OK', elapsedMs: 0 })
    expect(sleeps).toBe(0)
  })

  it('reports which alternative of a multi-outcome pattern matched', async () => {
    const fake = makeFakeTerminals()
    fake.lines = ['3 tests failed: FAIL']
    const outcome = await waitForPattern(depsFor(fake), request('(PASS|FAIL)'))
    expect(outcome).toMatchObject({ kind: 'found', match: 'FAIL', column: 16 })
  })

  it('matches verbatim when the pattern is not a valid regex', async () => {
    const fake = makeFakeTerminals()
    fake.lines = ['x BUILD_(OK y']
    const outcome = await waitForPattern(depsFor(fake), request('BUILD_(OK'))
    expect(outcome).toMatchObject({ kind: 'found', match: 'BUILD_(OK', column: 2 })
  })

  it('polls until the pattern appears and reports elapsed time', async () => {
    const fake = makeFakeTerminals()
    fake.lines = ['$ run']
    const clock = fakeClock()
    let sleeps = 0
    const deps = depsFor(fake, {
      now: clock.now,
      sleep: async (ms) => {
        sleeps += 1
        clock.advance(ms)
        if (sleeps === 2) fake.lines.push('READY')
        return true
      },
    })
    const outcome = await waitForPattern(deps, request('READY', { pattern: compilePattern('READY') }))
    expect(outcome).toMatchObject({ kind: 'found', match: 'READY', line: 1, elapsedMs: 200 })
    expect(sleeps).toBe(2)
  })

  it('times out with a bounded tail and retained line count', async () => {
    const fake = makeFakeTerminals()
    fake.lines = ['a', 'b', 'c']
    const clock = fakeClock()
    const deps = depsFor(fake, {
      now: clock.now,
      sleep: async (ms) => { clock.advance(ms); return true },
    })
    const outcome = await waitForPattern(deps, request('never', { tailLines: 2 }))
    expect(outcome).toMatchObject({ kind: 'timeout', timeoutMs: 1000, totalLines: 3, tail: 'b\nc', elapsedMs: 1000 })
  })

  it('returns exited with the exit code before the pattern appears', async () => {
    const fake = makeFakeTerminals()
    fake.lines = ['$ crash']
    const clock = fakeClock()
    let sleeps = 0
    const deps = depsFor(fake, {
      now: clock.now,
      sleep: async (ms) => {
        sleeps += 1
        clock.advance(ms)
        if (sleeps === 1) fake.status = { kind: 'exited', exitCode: 3, signal: null }
        return true
      },
    })
    const outcome = await waitForPattern(deps, request('never'))
    expect(outcome).toMatchObject({ kind: 'exited', exitCode: 3, signal: null, elapsedMs: 100 })
  })

  it('returns gone when the session disappears from the owner list', async () => {
    const fake = makeFakeTerminals()
    fake.lines = ['$ run']
    fake.status = null
    const outcome = await waitForPattern(depsFor(fake), request('never'))
    expect(outcome).toMatchObject({ kind: 'gone' })
  })

  it('returns gone when reading throws the NO_SESSION terminal error', async () => {
    const error = Object.assign(new Error('unknown PTY session pty-1'), { code: 'NO_SESSION' })
    const deps = depsFor(makeFakeTerminals(), { read: () => { throw error } })
    const outcome = await waitForPattern(deps, request('never'))
    expect(outcome).toMatchObject({ kind: 'gone' })
  })

  it('rethrows unrelated terminal errors', async () => {
    const error = Object.assign(new Error('belongs to another agent'), { code: 'FOREIGN_SESSION' })
    const deps = depsFor(makeFakeTerminals(), { read: () => { throw error } })
    await expect(waitForPattern(deps, request('never'))).rejects.toBe(error)
  })

  it('returns cancelled as a value when the signal aborts during a sleep', async () => {
    const fake = makeFakeTerminals()
    fake.lines = ['$ run']
    const clock = fakeClock()
    const deps = depsFor(fake, {
      now: clock.now,
      sleep: async (ms) => { clock.advance(ms); return false },
    })
    const outcome = await waitForPattern(deps, request('never'))
    expect(outcome).toMatchObject({ kind: 'cancelled', elapsedMs: 100 })
  })
})

describe('isNoSessionError', () => {
  it('recognizes only the NO_SESSION code', () => {
    expect(isNoSessionError({ code: 'NO_SESSION' })).toBe(true)
    expect(isNoSessionError({ code: 'FOREIGN_SESSION' })).toBe(false)
    expect(isNoSessionError(new Error('plain'))).toBe(false)
    expect(isNoSessionError(null)).toBe(false)
  })
})

describe('renderWaitOutcome', () => {
  const cases: Array<[WaitOutcome, string[]]> = [
    [{ kind: 'found', match: 'OK', line: 3, column: 2, lineText: 'xx OK', elapsedMs: 150, scannedLines: 10 }, ['[found]', '"OK"', 'line 3', 'column 2', '150ms', 'xx OK']],
    [{ kind: 'timeout', timeoutMs: 1000, totalLines: 7, tail: 'b\nc', scannedLines: 7, elapsedMs: 1000 }, ['[timeout]', '1000ms', '7 lines', 'b\nc']],
    [{ kind: 'exited', exitCode: 3, signal: null, elapsedMs: 20 }, ['[exited]', '3']],
    [{ kind: 'gone', elapsedMs: 0 }, ['[gone]']],
    [{ kind: 'cancelled', elapsedMs: 42 }, ['[cancelled]', '42ms']],
  ]
  for (const [value, fragments] of cases) {
    it(`renders ${value.kind}`, () => {
      const text = renderWaitOutcome(value)
      for (const fragment of fragments) expect(text).toContain(fragment)
    })
  }
})
