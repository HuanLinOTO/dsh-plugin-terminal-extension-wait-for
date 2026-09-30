import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
//#region src/wait-for.ts
/**
* Compile the caller pattern as a JavaScript regular expression; a pattern that
* fails to compile falls back to verbatim substring matching (better-sidebar
* precedent). Matching is case-sensitive and stateless.
*/
function compilePattern(pattern) {
	try {
		const expression = new RegExp(pattern);
		return {
			source: pattern,
			isRegex: true,
			match(line) {
				const found = expression.exec(line);
				return found === null ? null : {
					index: found.index,
					match: found[0]
				};
			}
		};
	} catch {
		return {
			source: pattern,
			isRegex: false,
			match(line) {
				const index = line.indexOf(pattern);
				return index < 0 ? null : {
					index,
					match: pattern
				};
			}
		};
	}
}
/**
* Resolve a per-call `timeout_ms` against the configured bounds: a missing or
* non-finite request uses the default; everything else is floored and clamped.
*/
function resolveTimeoutMs(requested, config) {
	const base = typeof requested === "number" && Number.isFinite(requested) ? Math.floor(requested) : config.defaultTimeoutMs;
	return Math.min(config.maxTimeoutMs, Math.max(config.minTimeoutMs, base));
}
/**
* Sleep for `ms`, resolving `false` when `signal` aborts first and `true` when
* the timer completes. An already-aborted signal resolves `false` without
* scheduling a timer; the abort listener is removed on both paths.
*/
function sleepWithAbort(ms, signal) {
	if (signal.aborted) return Promise.resolve(false);
	if (!(ms > 0)) return Promise.resolve(true);
	return new Promise((resolve) => {
		let timer;
		const onAbort = () => {
			if (timer !== void 0) clearTimeout(timer);
			resolve(false);
		};
		timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve(true);
		}, ms);
		signal.addEventListener("abort", onAbort, { once: true });
	});
}
function boundChars(text, maxChars) {
	if (maxChars <= 0) return "";
	return text.length <= maxChars ? text : `${text.slice(0, maxChars)}…[truncated]`;
}
/**
* Keep the trailing UTF-8 bytes of `text`. A cut through a code point drops the
* damaged leading replacement character rather than emitting it.
*/
function boundTailBytes(text, maxBytes) {
	if (maxBytes <= 0) return "";
	const buffer = Buffer.from(text, "utf8");
	if (buffer.byteLength <= maxBytes) return text;
	return buffer.subarray(buffer.byteLength - maxBytes).toString("utf8").replace(/^\uFFFD/, "");
}
/**
* Scan one retained-output page for the first line matching `pattern`. The
* absolute line index is `totalLines - lineEnd + indexInPage`, matching the
* backend's newest-relative paging.
*/
function scanPage(page, pattern, options) {
	const lines = page.text.length === 0 ? [] : page.text.split("\n");
	const absoluteStart = Math.max(0, page.totalLines - page.lineEnd);
	let match = null;
	let line = -1;
	let lineText = "";
	for (let index = 0; index < lines.length; index += 1) {
		const found = pattern.match(lines[index] ?? "");
		if (found !== null) {
			match = found;
			line = absoluteStart + index;
			lineText = lines[index] ?? "";
			break;
		}
	}
	const tailSource = options.tailLines > 0 ? lines.slice(-options.tailLines).join("\n") : "";
	return {
		match,
		line,
		column: match?.index ?? -1,
		lineText: boundChars(lineText, options.maxLineTextChars),
		totalLines: page.totalLines,
		tail: boundTailBytes(tailSource, options.maxTailBytes),
		scannedLines: lines.length
	};
}
/** Recognize the terminal registry's `NO_SESSION` error by its stable code. */
function isNoSessionError(error) {
	return typeof error === "object" && error !== null && error.code === "NO_SESSION";
}
/**
* Poll retained output until the pattern matches, the deadline elapses, the
* session exits or disappears, or the signal aborts. The first scan happens
* immediately, so a pattern already present resolves without sleeping.
*/
async function waitForPattern(deps, request) {
	const start = deps.now();
	for (;;) {
		let page;
		try {
			page = deps.read(request.sessionId);
		} catch (error) {
			if (isNoSessionError(error)) return {
				kind: "gone",
				elapsedMs: deps.now() - start
			};
			throw error;
		}
		const scan = scanPage(page, request.pattern, request);
		if (scan.match !== null) return {
			kind: "found",
			match: scan.match.match,
			line: scan.line,
			column: scan.column,
			lineText: scan.lineText,
			elapsedMs: deps.now() - start,
			scannedLines: scan.scannedLines
		};
		const snapshot = deps.list().find((item) => item.sessionId === request.sessionId);
		if (snapshot === void 0) return {
			kind: "gone",
			elapsedMs: deps.now() - start
		};
		if (snapshot.status.kind === "exited") return {
			kind: "exited",
			exitCode: snapshot.status.exitCode,
			signal: snapshot.status.signal,
			elapsedMs: deps.now() - start
		};
		const elapsed = deps.now() - start;
		const remaining = request.timeoutMs - elapsed;
		if (remaining <= 0) return {
			kind: "timeout",
			timeoutMs: request.timeoutMs,
			totalLines: scan.totalLines,
			tail: scan.tail,
			scannedLines: scan.scannedLines,
			elapsedMs: elapsed
		};
		if (!await deps.sleep(Math.min(request.pollIntervalMs, remaining), request.signal)) return {
			kind: "cancelled",
			elapsedMs: deps.now() - start
		};
	}
}
/** Project a wait outcome to the model-facing text (pure; replay-safe). */
function renderWaitOutcome(value) {
	switch (value.kind) {
		case "found": return `[found] match ${JSON.stringify(value.match)} at line ${value.line}, column ${value.column} (waited ${value.elapsedMs}ms)\n${value.lineText}`;
		case "timeout": return `[timeout] pattern did not appear within ${value.timeoutMs}ms; ${value.totalLines} lines retained, scanned ${value.scannedLines}. Tail:\n${value.tail}`;
		case "exited": return `[exited] terminal session exited (${value.exitCode ?? value.signal ?? "unknown"}) before the pattern appeared (waited ${value.elapsedMs}ms)`;
		case "gone": return `[gone] terminal session no longer exists; the pattern was not seen (waited ${value.elapsedMs}ms)`;
		case "cancelled": return `[cancelled] wait was cancelled after ${value.elapsedMs}ms`;
	}
}
//#endregion
//#region src/index.ts
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
const name = "terminal-extension-wait-for";
const inject = ["terminals", "tools"];
/** Schemastery configuration schema; defaults mirror {@link resolveConfig}. */
const Config = z.object({
	defaultTimeoutMs: z.number().default(1e4).description("Wait bound used when the model omits timeout_ms."),
	maxTimeoutMs: z.number().default(6e5).description("Hard cap for any single wait; larger requests are clamped."),
	minTimeoutMs: z.number().default(100).description("Smallest wait bound; smaller requests are clamped."),
	pollIntervalMs: z.number().default(150).description("Poll interval in milliseconds."),
	scanLines: z.number().default(2e3).description("Most recent retained lines scanned on every poll."),
	tailLines: z.number().default(30).description("Lines carried by a timeout outcome."),
	maxLineTextChars: z.number().default(1e3).description("Character cap for found.lineText."),
	maxTailBytes: z.number().default(8192).description("UTF-8 byte cap for timeout.tail.")
});
function resolveCount(label, value, fallback, minimum) {
	const resolved = value ?? fallback;
	if (typeof resolved !== "number" || !Number.isSafeInteger(resolved) || resolved < minimum) throw new Error(`terminal-extension-wait-for: ${label} must be a safe integer >= ${minimum}`);
	return resolved;
}
/** Validate configuration loudly instead of silently degrading. */
function resolveConfig(config = {}) {
	const minTimeoutMs = resolveCount("minTimeoutMs", config.minTimeoutMs, 100, 1);
	const maxTimeoutMs = resolveCount("maxTimeoutMs", config.maxTimeoutMs, 6e5, 1);
	if (maxTimeoutMs < minTimeoutMs) throw new Error("terminal-extension-wait-for: maxTimeoutMs must be >= minTimeoutMs");
	const defaultTimeoutMs = resolveCount("defaultTimeoutMs", config.defaultTimeoutMs, 1e4, 1);
	if (defaultTimeoutMs < minTimeoutMs || defaultTimeoutMs > maxTimeoutMs) throw new Error("terminal-extension-wait-for: defaultTimeoutMs must be within [minTimeoutMs, maxTimeoutMs]");
	return {
		defaultTimeoutMs,
		maxTimeoutMs,
		minTimeoutMs,
		pollIntervalMs: resolveCount("pollIntervalMs", config.pollIntervalMs, 150, 1),
		scanLines: resolveCount("scanLines", config.scanLines, 2e3, 1),
		tailLines: resolveCount("tailLines", config.tailLines, 30, 0),
		maxLineTextChars: resolveCount("maxLineTextChars", config.maxLineTextChars, 1e3, 0),
		maxTailBytes: resolveCount("maxTailBytes", config.maxTailBytes, 8192, 0)
	};
}
const OUTCOME_SCHEMA = { oneOf: [
	{
		type: "object",
		additionalProperties: false,
		properties: {
			kind: {
				type: "string",
				required: true,
				const: "found"
			},
			match: {
				type: "string",
				required: true,
				description: "The text that actually matched; for a multi-outcome pattern this tells which alternative hit."
			},
			line: {
				type: "integer",
				required: true,
				description: "0-based line index in the retained transcript."
			},
			column: {
				type: "integer",
				required: true,
				description: "0-based character index of the match within its line."
			},
			lineText: {
				type: "string",
				required: true,
				description: "The full matched line, possibly truncated."
			},
			elapsedMs: {
				type: "integer",
				required: true,
				description: "Wall-clock milliseconds from wait start to the match."
			},
			scannedLines: {
				type: "integer",
				required: true,
				description: "Lines scanned in the matching poll."
			}
		}
	},
	{
		type: "object",
		additionalProperties: false,
		properties: {
			kind: {
				type: "string",
				required: true,
				const: "timeout"
			},
			timeoutMs: {
				type: "integer",
				required: true,
				description: "The configured timeout that elapsed."
			},
			totalLines: {
				type: "integer",
				required: true,
				description: "Lines retained when the timeout fired."
			},
			tail: {
				type: "string",
				required: true,
				description: "Bounded tail of the retained output at the timeout."
			},
			scannedLines: {
				type: "integer",
				required: true,
				description: "Lines scanned in the final poll."
			},
			elapsedMs: {
				type: "integer",
				required: true,
				description: "Wall-clock milliseconds actually waited."
			}
		}
	},
	{
		type: "object",
		additionalProperties: false,
		properties: {
			kind: {
				type: "string",
				required: true,
				const: "exited"
			},
			exitCode: {
				required: true,
				oneOf: [{ type: "integer" }, { type: "null" }],
				description: "Exit code of the top-level shell, if known."
			},
			signal: {
				required: true,
				oneOf: [{ type: "string" }, { type: "null" }],
				description: "Exit signal of the top-level shell, if killed by one."
			},
			elapsedMs: {
				type: "integer",
				required: true,
				description: "Wall-clock milliseconds waited before the exit was observed."
			}
		}
	},
	{
		type: "object",
		additionalProperties: false,
		properties: {
			kind: {
				type: "string",
				required: true,
				const: "gone"
			},
			elapsedMs: {
				type: "integer",
				required: true,
				description: "Wall-clock milliseconds waited before the session disappeared."
			}
		}
	},
	{
		type: "object",
		additionalProperties: false,
		properties: {
			kind: {
				type: "string",
				required: true,
				const: "cancelled"
			},
			elapsedMs: {
				type: "integer",
				required: true,
				description: "Wall-clock milliseconds waited before the call was aborted."
			}
		}
	}
] };
const TOOL_DESCRIPTION = "Block until a pattern appears in a persistent terminal's retained output, or until the timeout elapses, or until the session exits or disappears — whichever happens first. Does not write input, so it is safe while a background command or job is still running. Use it after terminal_send returned inferred_idle/timeout or started a background job, to synchronize on command cues (a shell prompt, \"Listening on\", \"(PASS|FAIL)\") instead of busy-polling terminal_read. The pattern is a JavaScript regular expression (case-sensitive); a pattern that fails to compile falls back to verbatim substring matching. One pattern may cover several outcomes, e.g. (BUILD OK|BUILD FAIL) — the found result's match field tells which alternative hit. Every poll scans the most recently retained output, so a needle that scrolled past the newest chunk is still a match while it remains inside the configured scan window. Returns kind=found with the matched text, retained line number, column and line text; kind=timeout with a bounded tail; kind=exited or kind=gone; or kind=cancelled when the call is aborted.";
/** Register `terminal_wait_for` once the terminal service is available. */
function apply(ctx, config = {}) {
	const resolved = resolveConfig(config);
	ctx.tools.register(defineTool({
		name: "terminal_wait_for",
		description: TOOL_DESCRIPTION,
		parameters: {
			sessionId: {
				type: "string",
				required: true,
				description: "Terminal session id returned by terminal_open or terminal_list."
			},
			pattern: {
				type: "string",
				required: true,
				description: "JavaScript regular expression to wait for (case-sensitive); an invalid pattern falls back to verbatim substring matching. Must be non-empty."
			},
			timeout_ms: {
				type: "integer",
				description: "Maximum wait in milliseconds. Defaults to the plugin default and is clamped to the plugin bounds."
			}
		},
		output: {
			schema: OUTCOME_SCHEMA,
			render: (_args, value) => [{
				type: "text",
				text: renderWaitOutcome(value)
			}]
		},
		async execute(args, exec) {
			const parsed = args;
			if (parsed.sessionId.length === 0) throw new Error("sessionId must be a non-empty string");
			if (parsed.pattern.length === 0) throw new Error("pattern must be a non-empty string");
			const owner = exec.agent;
			if (owner === void 0) throw new Error("terminal_wait_for requires an initiating agent");
			return await waitForPattern({
				read: (sessionId) => ctx.terminals.read(owner, sessionId, {
					offset: 0,
					count: resolved.scanLines
				}),
				list: () => ctx.terminals.list(owner),
				now: () => Date.now(),
				sleep: sleepWithAbort
			}, {
				sessionId: parsed.sessionId,
				pattern: compilePattern(parsed.pattern),
				timeoutMs: resolveTimeoutMs(parsed.timeout_ms, resolved),
				pollIntervalMs: resolved.pollIntervalMs,
				tailLines: resolved.tailLines,
				maxLineTextChars: resolved.maxLineTextChars,
				maxTailBytes: resolved.maxTailBytes,
				signal: exec.signal
			});
		}
	}));
}
//#endregion
export { Config, apply, inject, name, resolveConfig };
