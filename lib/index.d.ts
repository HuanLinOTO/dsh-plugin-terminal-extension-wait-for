import z from "@deepseek-ai/schemastery";
import { Context } from "@deepseek-ai/cordis";
//#region src/index.d.ts
declare const name = "terminal-extension-wait-for";
declare const inject: string[];
/** Plugin configuration (all fields optional; defaults documented below). */
interface Config {
  /** Wait bound used when the model omits `timeout_ms` (default 10000). */
  defaultTimeoutMs?: number;
  /** Hard cap for any single wait; larger requests are clamped (default 600000). */
  maxTimeoutMs?: number;
  /** Smallest wait bound; smaller requests are clamped (default 100). */
  minTimeoutMs?: number;
  /** Poll interval in milliseconds (default 150). */
  pollIntervalMs?: number;
  /** Most recent retained lines scanned on every poll (default 2000). */
  scanLines?: number;
  /** Lines carried by a `timeout` outcome (default 30; 0 disables the tail). */
  tailLines?: number;
  /** Character cap for `found.lineText` (default 1000; 0 disables it). */
  maxLineTextChars?: number;
  /** UTF-8 byte cap for `timeout.tail` (default 8192; 0 disables it). */
  maxTailBytes?: number;
}
/** Schemastery configuration schema; defaults mirror {@link resolveConfig}. */
declare const Config: z<Config>;
/** Configuration after validation, with every field resolved. */
interface ResolvedConfig {
  defaultTimeoutMs: number;
  maxTimeoutMs: number;
  minTimeoutMs: number;
  pollIntervalMs: number;
  scanLines: number;
  tailLines: number;
  maxLineTextChars: number;
  maxTailBytes: number;
}
/** Validate configuration loudly instead of silently degrading. */
declare function resolveConfig(config?: Config): ResolvedConfig;
/** Register `terminal_wait_for` once the terminal service is available. */
declare function apply(ctx: Context, config?: Config): void;
//#endregion
export { Config, ResolvedConfig, apply, inject, name, resolveConfig };