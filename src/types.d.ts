/**
 * types.d.ts — peer 依赖的最小环境声明。
 *
 * `@deepseek-ai/cordis` 与 `@deepseek-ai/dsh-tools` 是运行时由宿主 dsh 提供的
 * peer 依赖，本文件只为 src/* 的独立 typecheck 提供最小声明：只声明用到的
 * 成员与形状，与官方类型不完全一致；官方权威定义见 DSH checkout 的
 * packages/core/tools/src/ 与 vendor/cordis。
 *
 * `@deepseek-ai/dsh-terminal` 刻意不被 import：插件通过服务名 `terminals`
 * 取用（此处声明为 Context 上的结构类型），避免运行时解析私有包。
 *
 * 0.2.0-rc.1 校对：`defineTool` 对用到的成员（name/description/parameters/
 * output.schema/output.render/execute）无漂移；`ToolRunContext` 增加了
 * `agent`（执行 agent，本插件用作终端 owner）。
 */

declare module '@deepseek-ai/dsh-tools' {
  export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

  export interface ValueSchemaAnnotations {
    description?: string
    title?: string
    default?: JsonValue
    examples?: JsonValue
  }

  export interface StringValueSchemaSpec extends ValueSchemaAnnotations {
    type: 'string'
    enum?: readonly string[]
    const?: string
  }

  export interface NumberValueSchemaSpec extends ValueSchemaAnnotations {
    type: 'number'
    enum?: readonly number[]
    const?: number
  }

  export interface IntegerValueSchemaSpec extends ValueSchemaAnnotations {
    type: 'integer'
    enum?: readonly number[]
    const?: number
  }

  export interface BooleanValueSchemaSpec extends ValueSchemaAnnotations {
    type: 'boolean'
  }

  export interface NullValueSchemaSpec extends ValueSchemaAnnotations {
    type: 'null'
  }

  export interface ArrayValueSchemaSpec extends ValueSchemaAnnotations {
    type: 'array'
    items?: ValueSchemaSpec
  }

  export interface ObjectValueSchemaSpec extends ValueSchemaAnnotations {
    type: 'object'
    properties?: ParameterSchemaSpec
    additionalProperties: boolean
  }

  export interface JsonValueSchemaSpec extends ValueSchemaAnnotations {
    type: 'json'
  }

  export interface OneOfValueSchemaSpec extends ValueSchemaAnnotations {
    oneOf: readonly [ValueSchemaSpec, ValueSchemaSpec, ...ValueSchemaSpec[]]
  }

  export type ValueSchemaSpec =
    | StringValueSchemaSpec
    | NumberValueSchemaSpec
    | IntegerValueSchemaSpec
    | BooleanValueSchemaSpec
    | NullValueSchemaSpec
    | ArrayValueSchemaSpec
    | ObjectValueSchemaSpec
    | JsonValueSchemaSpec
    | OneOfValueSchemaSpec

  export type ParameterPropertySpec = ValueSchemaSpec & { required?: true }

  export type ParameterSchemaSpec = {
    [key: string]: ParameterPropertySpec
    [key: symbol]: never
  }

  export interface ToolTextBlock {
    type: 'text'
    text: string
  }

  export interface ToolRunContext {
    readonly signal: AbortSignal
    readonly callId: string
    readonly name: string
    readonly arguments: unknown
    /** Executing agent; the terminal owner for every registry operation. */
    readonly agent?: unknown
  }

  export interface DefineToolOptions {
    readonly name: string
    readonly description: string
    readonly parameters: ParameterSchemaSpec
    readonly output: {
      readonly schema: ValueSchemaSpec
      render(args: unknown, value: unknown): ToolTextBlock[]
    }
    readonly timeoutMs?: number
    execute(args: unknown, exec: ToolRunContext): Promise<unknown>
  }

  export function defineTool(options: DefineToolOptions): unknown
}

declare module '@deepseek-ai/cordis' {
  export interface Context {
    tools: {
      register(definition: unknown): () => void
    }
    /**
     * Structural subset of the terminal session service
     * (`@deepseek-ai/dsh-terminal`, `ctx.terminals`). Only the owner-scoped
     * read/list surface this plugin consumes is declared.
     */
    terminals: {
      read(owner: unknown, sessionId: string, request?: { offset?: number; count?: number }): {
        text: string
        totalLines: number
        lineBegin: number
        lineEnd: number
        truncated: boolean
      }
      list(owner: unknown): readonly {
        sessionId: string
        status: { kind: 'running' } | { kind: 'exited'; exitCode: number | null; signal: string | null }
      }[]
    }
    effect(fn: () => unknown, label?: string): () => void
    readonly logger: {
      info(...args: unknown[]): void
      warn(...args: unknown[]): void
      error(...args: unknown[]): void
      debug(...args: unknown[]): void
    }
  }
}
