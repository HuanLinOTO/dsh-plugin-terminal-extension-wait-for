# terminal_wait_for 实现计划

> **For agentic workers:** 逐任务执行；每步用 `- [ ]` 跟踪。本计划实现设计文档
> `docs/plans/2026-09-30-terminal-wait-for-design.md`。

**Goal:** 交付 host-only 单工具插件 `@huanlin/dsh-plugin-terminal-extension-wait-for`：在
`ctx.terminals` 公开面上提供 `terminal_wait_for`，轮询保留输出直到正则命中 / 超时 / 会话退出 / 消失 / 取消。

**Architecture:** 纯逻辑核心 `src/wait-for.ts`（无宿主依赖，依赖注入 read/list/now/sleep，可单测）
+ 薄注册层 `src/index.ts`（Config、defineTool、把 `ctx.terminals` 适配成核心的 deps）。
类型走影子声明 `src/types.d.ts`，不 import 私有包。

**Tech Stack:** TypeScript 5.9 / tsdown / vitest / @deepseek-ai/schemastery；DSH 0.2.0-rc.1 宿主契约。

**Spec:** `docs/plans/2026-09-30-terminal-wait-for-design.md`

## Global Constraints

- 插件 `name = 'terminal-extension-wait-for'`；工具名 `terminal_wait_for`
- `inject = ['terminals', 'tools']`；peer 仅 `@deepseek-ai/cordis` `^4.0.1` + `@deepseek-ai/dsh-tools` `^0.2.0-rc.1`
- 不 import `@deepseek-ai/dsh-terminal`；`lib/` 预构建入库；A6 不导出 default
- 配置默认：`defaultTimeoutMs=10000` `maxTimeoutMs=600000` `minTimeoutMs=100` `pollIntervalMs=150`
  `scanLines=2000` `tailLines=30` `maxLineTextChars=1000` `maxTailBytes=8192`
- C4/C5/C6：execute 返回规范 JSON 值；业务非理想态走值（cancelled 等），基础设施失败 throw；`exec.signal` 全程响应
- 零 DSH 源码 patch；profile 安装用 `link:`；`dsh web` 由人类重启

---

### Task 1: 仓库骨架 + 工程配置

**Files:**
- Create: `package.json` `tsconfig.json` `tsdown.config.ts` `vitest.config.ts` `.npmrc` `.gitignore`
  `pnpm-workspace.yaml` `cordis.patch.yml` `README.md` `AGENTS.md`

**Interfaces:**
- Produces: 可 `pnpm install` / `pnpm test` / `pnpm run typecheck` / `pnpm run build` 的工程；`dsh.bundle.patch` 指向 `cordis.patch.yml`

- [ ] **Step 1:** 按 dsh-sleep 模板写工程文件（预构建 `lib/` 策略：无 `prepare`，`lib/` 不入
  `.gitignore`；`files = ["lib/", "cordis.patch.yml"]`；`pnpm-workspace.yaml` 开 `allowBuilds: esbuild`）
- [ ] **Step 2:** `pnpm install` 成功；`Test-Path node_modules/@deepseek-ai/schemastery` 为 True
- [ ] **Step 3:** Commit

### Task 2: 等待核心 `src/wait-for.ts`（TDD）

**Files:**
- Create: `src/wait-for.ts`, `tests/wait-for.spec.ts`

**Interfaces:**
- Produces: `compilePattern(pattern): CompiledPattern`、`resolveTimeoutMs(requested, cfg): number`、
  `sleepWithAbort(ms, signal): Promise<boolean>`、`scanPage(page, pattern, tailLines, maxLineTextChars, maxTailBytes): ScanResult`、
  `waitForPattern(deps, request): Promise<WaitOutcome>`、`renderWaitOutcome(value): string`、`isNoSessionError(error): boolean`
  以及类型 `TerminalReadResult` `TerminalSessionSnapshot` `WaitOutcome` `WaitDeps`

- [ ] **Step 1: 写失败测试**（fake terminals 按 terminal-bash 语义实现 `read` 的 newest-relative 分页）：
  已存在即命中（含绝对行号/列）、regex 交替命中、非法正则回退子串、轮询后命中、timeout 带 tail、
  exited、gone（list 缺失 / read 抛 `NO_SESSION`）、cancelled、超时钳制、分页行号换算、render 五分支
- [ ] **Step 2:** `pnpm test` 失败（模块不存在）
- [ ] **Step 3:** 实现核心（循环：scan → status → 剩余时间 → sleep；`totalLines - lineEnd + i` 绝对行号；
  regex 编译失败回退 `indexOf`；tail/line_text 按字符与字节上限截断）
- [ ] **Step 4:** `pnpm test` 全绿
- [ ] **Step 5:** Commit

### Task 3: 注册层 `src/index.ts` + 影子类型 `src/types.d.ts`（TDD）

**Files:**
- Create: `src/index.ts`, `src/types.d.ts`, `tests/plugin.spec.ts`

**Interfaces:**
- Consumes: Task 2 的全部导出
- Produces: `name` / `inject` / `Config` / `resolveConfig` / `apply`；工具 `terminal_wait_for` 的 schema
  （parameters: `sessionId` `pattern` `timeout_ms`；output oneOf 五态）与 execute（owner = `exec.agent`）

- [ ] **Step 1: 写失败测试**（mock `@deepseek-ai/dsh-tools` 的 `defineTool`）：apply 注册恰好一个工具、
  名称/参数/oneOf 正确；execute 把 owner 传给 `read/list`、命中返回 found；缺 `exec.agent`/空 pattern/
  空 sessionId 抛错；`resolveConfig` 默认值与非法配置 fail loud
- [ ] **Step 2:** `pnpm test` 失败
- [ ] **Step 3:** 实现 index + types.d.ts（影子声明只含用到的成员：`ctx.tools.register`、`ctx.terminals.read/list`、
  `ToolRunContext.{agent,signal}`）
- [ ] **Step 4:** `pnpm test` 全绿 + `pnpm run typecheck` 干净
- [ ] **Step 5:** Commit

### Task 4: 构建 + 产物验证

- [ ] **Step 1:** `pnpm run build`，确认 `lib/index.js` 存在且 import `@deepseek-ai/dsh-tools` 为外部引用
- [ ] **Step 2:** `git status --short` 确认 `lib/` 未忽略、被跟踪；Commit `v0.1.0`

### Task 5: 发布 + 挂载（GitHub / npm / profile / preset）

- [ ] **Step 1:** `gh repo create huanlinoto/dsh-plugin-terminal-extension-wait-for --public --source=. --push`
- [ ] **Step 2:** `gh repo edit` 双语描述 + topic `dsh-plugin`；README 顶部 dshfind card
- [ ] **Step 3:** `dsh plugin --profile web add link:D:\...\dsh-plugin-terminal-extension-wait-for`
- [ ] **Step 4:** `dsh-preset-ptc-custom/cordis.patch.yml` 的 `persistent-shell` 组内加行并 push
- [ ] **Step 5:** `pnpm publish --registry https://registry.npmjs.org/`（2FA 交互终端，由用户完成；
  ~3 分钟后复核 registry，不复发）
- [ ] **Step 6:** 人类重启 `dsh web` + 硬刷新；在 ptc-custom agent 下实测
  `terminal_open → terminal_send(run_in_background) → terminal_wait_for`

---

## 执行记录（2026-09-30）

- Task 1–4 完成：`pnpm install` / `pnpm test`（37 passed）/ `pnpm run typecheck` /
  `pnpm run build`（`lib/index.js` 15.7 kB，externals = `@deepseek-ai/dsh-tools` + `@deepseek-ai/schemastery`）
- Task 5：
  - GitHub `huanlinoto/dsh-plugin-terminal-extension-wait-for`（PUBLIC，topic `dsh-plugin`，双语描述）
  - dshfind card `HTTP 200`
  - profile web `dsh plugin add link:...` 完成（依赖 + bundles + symlink + `lib/` + `cordis.patch.yml` 均可见）
  - `dsh-preset-ptc-custom/cordis.patch.yml` 的 `persistent-shell` 组已加插件行（该目录非 git repo，直接改文件）
  - npm：已登录 `huanlin`，等待在交互式终端执行 `pnpm publish --registry https://registry.npmjs.org/` 完成 2FA
- 待人类操作：重启 `dsh web` + 硬刷新后实测；npm 2FA 发布

