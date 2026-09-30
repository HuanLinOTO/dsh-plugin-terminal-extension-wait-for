# terminal_wait_for 插件设计（dsh-plugin-terminal-extension-wait-for）

> 2026-09-30 · 已获用户批准（含 preset 集成与 GitHub + npm 全量交付）

## 背景

DSH 原生 terminal 系列（`@deepseek-ai/dsh-tool-terminal`）的 `terminal_send` 只等待
「就绪」（`stdin_read | inferred_idle | timeout | session_exit`），没有按字符串等待的能力；
`terminal_read` 是一次性分页读取；`job_output(wait)` 只等 job 完结。better-sidebar 自带的
`terminal_wait_for` 跑在其自有 PTY 栈上，不作用于 DSH 原生 terminal 服务。

本插件在 `ctx.terminals` 的公开面（owner 隔离的 `read` / `list`）上补一个
`terminal_wait_for` 工具：轮询保留输出直到正则命中 / 超时 / 会话退出 / 会话消失 / 调用被取消。

## 形态

- 仓库 `dsh-plugin-terminal-extension-wait-for`，npm `@huanlin/dsh-plugin-terminal-extension-wait-for`
- 插件 `name = 'terminal-extension-wait-for'`，host-only 单工具 bundle，预构建 `lib/` 入库
- peer：`@deepseek-ai/cordis`、`@deepseek-ai/dsh-tools`；deps：`@deepseek-ai/schemastery`
- **不 import `@deepseek-ai/dsh-terminal`**：只按服务名 `inject = ['terminals', 'tools']` 访问，
  类型走 `src/types.d.ts` 影子声明，避免运行时解析私有包

## 工具契约 `terminal_wait_for`

参数：

| 参数 | 必填 | 语义 |
|---|---|---|
| `sessionId` | 是 | `terminal_open` / `terminal_list` 返回的会话 id |
| `pattern` | 是 | JS 正则；编译失败回退原文子串匹配；不得为空 |
| `timeout_ms` | 否 | 上限等待毫秒，默认 `defaultTimeoutMs`，钳制 `[minTimeoutMs, maxTimeoutMs]` |

结果（oneOf，规范 JSON 值 + 独立 render 投影）：

| kind | 字段 |
|---|---|
| `found` | `pattern` `match` `line`（保留 transcript 绝对行号，0 起）`column` `line_text` `elapsedMs` |
| `timeout` | `pattern` `timeoutMs` `totalLines` `tail`（尾部 ≤ tailLines 行） |
| `exited` | `pattern` `exitCode` `signal` |
| `gone` | `pattern`（`list` 不再包含该 id，或 `read` 抛 `NO_SESSION`） |
| `cancelled` | `pattern` `elapsedMs`（`exec.signal` 中止；C5：业务非理想态走值不走 throw） |

## 轮询语义

1. 首轮立即扫描（pattern 已存在于保留输出 → 立即 found）。
2. 每轮 `ctx.terminals.read(owner, id, { offset: 0, count: scanLines })`（非消费式，不干扰在跑 job），
   对全文做一次 `exec`/回退 `indexOf`；命中即算绝对行号：`totalLines - lineEnd + 匹配行索引`。
3. 未命中时 `ctx.terminals.list(owner)` 查状态：`exited` → exited；不在列表 → gone。
4. 轮询间隔 `pollIntervalMs`，可被 `exec.signal` 立即打断（sleep 与 abort 竞争）。
5. 截止前最后一次扫描，仍未命中 → timeout + tail。

## 配置（Schemastery，fail loud）

| 字段 | 默认 | 约束 |
|---|---|---|
| `defaultTimeoutMs` | 10000 | ≥ minTimeoutMs，≤ maxTimeoutMs |
| `maxTimeoutMs` | 600000 | ≥ 1 |
| `minTimeoutMs` | 100 | ≥ 1 |
| `pollIntervalMs` | 150 | ≥ 1 |
| `scanLines` | 2000 | ≥ 1 |
| `tailLines` | 30 | ≥ 0 |

`timeout_ms` 缺省、非有限或越界时钳制并返回实际生效值。

## realm 集成（关键）

用户的 `ptc-custom` preset 把 terminal 服务/后端/工具放进
`isolate: { terminals: true }` 隔离组（`dsh-preset-ptc-custom/cordis.patch.yml` 的
`persistent-shell`，与上游 `minimal` preset 同构）。profile 根级插件看不到该 realm 的
`ctx.terminals`，inject 永不满足。

- 插件 bundle 自带 `cordis.patch.yml`（根级 insert，适用于终端服务在根级的部署）；
  在隔离 preset 下该行保持 pending、不注册工具，不会与 preset 内的行冲突。
- 用户 preset 的 `persistent-shell` 组内追加兄弟行，工具随 terminal 家族在 ptc-custom 下可用：
  `- id: terminal-extension-wait-for` / `name: '@huanlin/dsh-plugin-terminal-extension-wait-for'`
- README 说明两种挂载位置与选择依据。

## 测试（Unit，vitest 三层中的第一层）

fake `ctx.terminals`（可控 `read`/`list` + 计数）、fake `ctx.tools`（记录注册定义）：
已存在即命中、出现后命中（fake timers）、timeout + tail、exited、gone（list 缺失 / read 抛
`NO_SESSION`）、cancelled、正则回退、超时钳制、render 各分支、注册与 config 校验、
`exec.agent` 缺失抛错。不 mock 被测逻辑本身；不需要真实宿主。

## 交付

1. 插件仓库 scaffold → typecheck / test / build（预构建 `lib/`）
2. git init + commit；`gh repo create huanlinoto/dsh-plugin-terminal-extension-wait-for --public` + push
3. 仓库描述（双语）、topic `dsh-plugin`、README dshfind card
4. `dsh plugin --profile web add link:<path>` 安装；preset 加行；用户重启 `dsh web` + 硬刷新
5. npm：`pnpm publish --registry https://registry.npmjs.org/`，2FA 由用户在交互终端完成；
   发布后 ~3 分钟再做 registry 复核，不复发
