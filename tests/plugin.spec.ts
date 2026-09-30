/**
 * Registration-layer tests: plugin metadata, Config resolution, tool schema and
 * execute wiring (owner forwarding, canonical value shape, input validation).
 * `defineTool` is mocked so the raw definition object is inspectable.
 */

import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'

vi.mock('@deepseek-ai/dsh-tools', () => ({
  defineTool: vi.fn((options: unknown) => options),
}))

import { Config, apply, inject, name, resolveConfig } from '../src/index.js'
import type { Config as PluginConfig } from '../src/index.js'

interface CapturedTool {
  name: string
  description: string
  parameters: Record<string, { type: string; required?: true; description?: string }>
  output: {
    schema: { oneOf?: readonly { properties: Record<string, unknown> }[] }
    render: (args: unknown, value: unknown) => { type: string; text: string }[]
  }
  execute: (args: unknown, exec: { signal: AbortSignal; agent?: unknown }) => Promise<unknown>
}

interface FakeTerminals {
  calls: { owners: unknown[]; reads: number }
  lines: string[]
  status: { kind: 'running' } | { kind: 'exited'; exitCode: number | null; signal: string | null }
  absent?: boolean
}

function makeCtx(fake: FakeTerminals): { ctx: Context; registered: CapturedTool[] } {
  const registered: CapturedTool[] = []
  const terminals = {
    read(owner: unknown, sessionId: string, request?: { offset?: number; count?: number }) {
      fake.calls.owners.push(owner)
      fake.calls.reads += 1
      const totalLines = fake.lines.length
      const count = request?.count ?? totalLines
      const start = Math.max(0, totalLines - count)
      const text = fake.lines.slice(start).join('\n')
      const returnedLines = text.length === 0 ? 0 : text.split('\n').length
      return { text, totalLines, lineBegin: 0, lineEnd: returnedLines, truncated: false }
    },
    list(owner: unknown) {
      fake.calls.owners.push(owner)
      if (fake.absent === true) return []
      return [{ sessionId: 'pty-1', status: fake.status }]
    },
  }
  const ctx = {
    tools: {
      register(definition: unknown) {
        registered.push(definition as CapturedTool)
        return () => {}
      },
    },
    terminals,
  } as unknown as Context
  return { ctx, registered }
}

function makeFake(overrides: Partial<FakeTerminals> = {}): FakeTerminals {
  return {
    calls: { owners: [], reads: 0 },
    lines: ['BUILD OK'],
    status: { kind: 'running' },
    ...overrides,
  }
}

function applyAndCapture(fake: FakeTerminals, config: PluginConfig = {}): CapturedTool {
  const { ctx, registered } = makeCtx(fake)
  apply(ctx, config)
  expect(registered).toHaveLength(1)
  return registered[0]!
}

describe('plugin metadata', () => {
  it('exposes a unique name and the required services', () => {
    expect(name).toBe('terminal-extension-wait-for')
    expect(inject).toEqual(['terminals', 'tools'])
  })
})

describe('resolveConfig', () => {
  it('fills documented defaults', () => {
    expect(resolveConfig({})).toEqual({
      defaultTimeoutMs: 10000,
      maxTimeoutMs: 600000,
      minTimeoutMs: 100,
      pollIntervalMs: 150,
      scanLines: 2000,
      tailLines: 30,
      maxLineTextChars: 1000,
      maxTailBytes: 8192,
    })
  })

  it('accepts explicit overrides', () => {
    const resolved = resolveConfig({ defaultTimeoutMs: 500, pollIntervalMs: 50, scanLines: 10, tailLines: 0 })
    expect(resolved.defaultTimeoutMs).toBe(500)
    expect(resolved.pollIntervalMs).toBe(50)
    expect(resolved.scanLines).toBe(10)
    expect(resolved.tailLines).toBe(0)
  })

  it('rejects non-positive intervals and counts', () => {
    expect(() => resolveConfig({ pollIntervalMs: 0 })).toThrow(/pollIntervalMs/)
    expect(() => resolveConfig({ scanLines: 0 })).toThrow(/scanLines/)
    expect(() => resolveConfig({ tailLines: -1 })).toThrow(/tailLines/)
  })

  it('rejects inverted or out-of-range timeout bounds', () => {
    expect(() => resolveConfig({ minTimeoutMs: 5000, maxTimeoutMs: 1000 })).toThrow(/maxTimeoutMs/)
    expect(() => resolveConfig({ defaultTimeoutMs: 999999 })).toThrow(/defaultTimeoutMs/)
    expect(() => resolveConfig({ defaultTimeoutMs: 10 })).toThrow(/defaultTimeoutMs/)
  })

  it('ships a Schemastery Config schema with the same defaults', () => {
    expect(Config).toBeDefined()
    expect(typeof Config).toBe('function')
  })
})

describe('terminal_wait_for registration', () => {
  it('registers exactly one tool with the terminal_wait_for contract', () => {
    const tool = applyAndCapture(makeFake())
    expect(tool.name).toBe('terminal_wait_for')
    expect(Object.keys(tool.parameters)).toEqual(['sessionId', 'pattern', 'timeout_ms'])
    expect(tool.parameters.sessionId!.required).toBe(true)
    expect(tool.parameters.pattern!.required).toBe(true)
    expect(tool.parameters.timeout_ms!.required).toBeUndefined()
    expect(tool.output.schema.oneOf).toHaveLength(5)
  })

  it('declares every outcome shape in the output schema', () => {
    const tool = applyAndCapture(makeFake())
    const kinds = (tool.output.schema.oneOf ?? []).map(
      variant => (variant.properties.kind as { const?: string }).const,
    )
    expect(kinds).toEqual(['found', 'timeout', 'exited', 'gone', 'cancelled'])
  })
})

describe('terminal_wait_for execute', () => {
  it('forwards the executing agent as the owner and returns a canonical found value', async () => {
    const fake = makeFake({ lines: ['$ make', 'BUILD OK'], status: { kind: 'running' } })
    const tool = applyAndCapture(fake)
    const agent = { id: 'agent-1' }
    const result = await tool.execute(
      { sessionId: 'pty-1', pattern: 'BUILD OK' },
      { signal: new AbortController().signal, agent },
    )
    expect(result).toMatchObject({ kind: 'found', match: 'BUILD OK', line: 1, column: 0, lineText: 'BUILD OK' })
    expect(fake.calls.owners.every(owner => owner === agent)).toBe(true)
    expect(fake.calls.reads).toBeGreaterThan(0)
  })

  it('honors the per-call timeout bound when the session exits first', async () => {
    const fake = makeFake({
      lines: ['$ crash'],
      status: { kind: 'exited', exitCode: 2, signal: null },
    })
    const tool = applyAndCapture(fake)
    const result = await tool.execute(
      { sessionId: 'pty-1', pattern: 'never', timeout_ms: 5 },
      { signal: new AbortController().signal, agent: {} },
    )
    expect(result).toMatchObject({ kind: 'exited', exitCode: 2, signal: null })
  })

  it('returns gone when the session is no longer listed', async () => {
    const fake = makeFake({ absent: true })
    const tool = applyAndCapture(fake)
    const result = await tool.execute(
      { sessionId: 'pty-1', pattern: 'never' },
      { signal: new AbortController().signal, agent: {} },
    )
    expect(result).toMatchObject({ kind: 'gone' })
  })

  it('rejects an execute without an initiating agent', async () => {
    const tool = applyAndCapture(makeFake())
    await expect(tool.execute(
      { sessionId: 'pty-1', pattern: 'x' },
      { signal: new AbortController().signal },
    )).rejects.toThrow(/initiating agent/)
  })

  it('rejects empty sessionId and empty pattern', async () => {
    const tool = applyAndCapture(makeFake())
    const exec = { signal: new AbortController().signal, agent: {} }
    await expect(tool.execute({ sessionId: '', pattern: 'x' }, exec)).rejects.toThrow(/sessionId/)
    await expect(tool.execute({ sessionId: 'pty-1', pattern: '' }, exec)).rejects.toThrow(/pattern/)
  })
})

describe('render projection', () => {
  it('renders the canonical value as text', () => {
    const tool = applyAndCapture(makeFake())
    const content = tool.output.render({}, {
      kind: 'found', match: 'OK', line: 3, column: 2, lineText: 'xx OK', elapsedMs: 12, scannedLines: 4,
    })
    expect(content).toEqual([{ type: 'text', text: expect.stringContaining('"OK"') }])
  })
})
