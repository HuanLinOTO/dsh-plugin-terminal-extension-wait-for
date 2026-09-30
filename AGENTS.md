# dsh-plugin-terminal-extension-wait-for — Agent Guide

## Plugin overview

Bundle-style host-only DSH plugin adding a single model-facing tool, `terminal_wait_for`, that
polls `ctx.terminals` retained output until a regex matches, or until timeout / session exit /
session gone / call cancellation. It never writes input.

## Key conventions

- **Bundle form**: `cordis.patch.yml` inserts one plugin row; `package.json` has `dsh.bundle.patch`.
  No source patches to the DSH checkout.
- **Pre-built `lib/` strategy**: `lib/` is committed (not in `.gitignore`); no `prepare` script;
  `github:` install works out of the box.
- **No `@deepseek-ai/dsh-terminal` import**: the service is reached by the `terminals` inject name
  only; `src/types.d.ts` carries minimal shadow declarations for `@deepseek-ai/cordis` and
  `@deepseek-ai/dsh-tools` so `pnpm run typecheck` works standalone.
- **Realm**: the row must live in the same realm as the terminal service. If the terminal family
  sits inside an agent-preset group with `isolate: { terminals: true }`, mount this package inside
  that group (the bundle's root insert stays pending and harmless otherwise).
- **Semantics** (plugin-development-guide §3): `execute` returns one canonical JSON value;
  cancellation is a business outcome (`cancelled`) rather than a throw; `exec.signal` is honored
  at every await point.

## File responsibilities

| File | Role |
|------|------|
| `src/index.ts` | Entry: `name`, `inject = ['terminals', 'tools']`, `Config` (Schemastery), `resolveConfig`, `apply` |
| `src/wait-for.ts` | Core: pattern compile/fallback, timeout clamp, page scan + absolute line math, poll loop, render |
| `src/types.d.ts` | Shadow declarations for peer modules (standalone typecheck) |
| `tests/wait-for.spec.ts` | Core unit tests (fake terminals with terminal-bash paging semantics) |
| `tests/plugin.spec.ts` | Registration/config/execute tests (mocked `defineTool`) |

## Commands

```sh
pnpm run typecheck
pnpm test
pnpm run build
```

## Gotchas

- `read()` is non-consuming; it returns the newest `scanLines` lines. A pattern evicted by the
  backend scrollback bound is intentionally not recoverable.
- `gone` covers both "not in `list()`" and `read()` throwing code `NO_SESSION`; `FOREIGN_SESSION`
  is a real error and is rethrown.
- Absolute line numbers use `totalLines - lineEnd + indexInPage`, matching terminal-bash's
  newest-relative paging.
