<p align="center">
  <a href="https://dshfind.com/zh/plugins/huanlinoto/dsh-plugin-terminal-extension-wait-for"><img src="https://dshfind.com/api/card/huanlinoto/dsh-plugin-terminal-extension-wait-for?lang=zh" alt="dsh-plugin-terminal-extension-wait-for card"></a>
</p>

# dsh-plugin-terminal-extension-wait-for

给 DSH 原生 terminal 系列补一个 `terminal_wait_for` 工具：**阻塞到某个字符串出现在持久终端的保留输出里**，
或等到超时 / 会话退出 / 会话消失 / 调用被取消。

原生 `terminal_send` 只等待「就绪」（`stdin_read | inferred_idle | timeout | session_exit`），
`terminal_read` 是一次性分页读取——两者都无法表达「等 `BUILD OK` 或 `BUILD FAIL` 出现」。
本插件在 `ctx.terminals` 的公开 owner 隔离面上轮询保留输出实现该能力，**不发送任何输入，不干扰在跑的后台 job**。

## 工具契约

| 参数 | 必填 | 语义 |
|---|---|---|
| `sessionId` | 是 | `terminal_open` / `terminal_list` 返回的会话 id |
| `pattern` | 是 | JavaScript 正则（大小写敏感）；编译失败自动回退为原文子串匹配；不得为空 |
| `timeout_ms` | 否 | 上限等待毫秒，默认 10000，钳制到 `[minTimeoutMs, maxTimeoutMs]` |

结果五态（规范 JSON 值）：

| kind | 说明 |
|---|---|
| `found` | 命中：`match`（实际命中的文本，多分支模式可据此判断成败）、`line`（保留 transcript 绝对行号，0 起）、`column`、`line_text`、`elapsedMs` |
| `timeout` | 超时：`totalLines` + 尾部 `tail`（≤ `tailLines` 行），可据此再 `terminal_read` |
| `exited` | 顶层 shell 已退出：带 `exitCode` / `signal` |
| `gone` | 会话已不存在（被关闭） |
| `cancelled` | 工具调用被中止（`exec.signal`），立即返回 |

典型用法（配合后台发送，避免忙轮询）：

```
terminal_send(sessionId, "make build", run_in_background: true) → jobId
terminal_wait_for(sessionId, "(BUILD OK|BUILD FAIL)", timeout_ms: 300000) → found, match=BUILD FAIL
job_output(jobId) → 收集剩余输出
```

首轮立即扫描：pattern 已存在于保留输出时立刻返回 `found`。每轮扫描最近 `scanLines` 行
（非消费式读取），未命中时检查会话状态。pattern 被 scrollback 上限挤出后会找不到——这是刻意的有界语义。

## 挂载位置与 realm

插件通过服务名 `inject = ['terminals', 'tools']` 访问 `ctx.terminals`，因此**必须和终端服务在同一个 realm**：

- **终端服务挂在 profile 根级**：`dsh plugin --profile <p> add <本包>` 即可，bundle 的
  `cordis.patch.yml` 会在根级插入插件行。
- **终端服务挂在 agent preset 的隔离组里**（上游 `minimal` preset、本机 `ptc-custom` preset 都是
  `isolate: { terminals: true }` 的 `persistent-shell` 组）：根级行会一直 pending，不会注册工具也不会报错。
  此时把包名按行加进那个组的插件列表：

  ```yaml
  - id: persistent-shell
    name: cordis:group
    group: true
    isolate:
      terminals: true
    config:
      - id: pty
        name: '@deepseek-ai/dsh-terminal'
      # ... 后端与 tool-terminal ...
      - id: terminal-extension-wait-for
        name: '@huanlin/dsh-plugin-terminal-extension-wait-for'
  ```

  包本身仍要装进 profile（`dsh plugin add`），Loader 才能从 profile node_modules 解析到它。

插件不 import `@deepseek-ai/dsh-terminal`，只在运行时按服务名取用，因此不增加对私有包的解析依赖。

## 配置

| 字段 | 默认 | 含义 |
|---|---|---|
| `defaultTimeoutMs` | `10000` | 模型省略 `timeout_ms` 时的等待上限 |
| `maxTimeoutMs` | `600000` | 单次等待硬上限，更大的请求被钳制 |
| `minTimeoutMs` | `100` | 最小等待上限，更小的请求被钳制 |
| `pollIntervalMs` | `150` | 轮询间隔；每次轮询都是一次非消费式读取 |
| `scanLines` | `2000` | 每次轮询扫描的最近保留行数 |
| `tailLines` | `30` | `timeout` 结果携带的尾部行数 |
| `maxLineTextChars` | `1000` | `found.line_text` 的字符上限（超出截断） |
| `maxTailBytes` | `8192` | `timeout.tail` 的 UTF-8 字节上限（保留尾部） |

非法配置（非正数间隔/行数、max < min 等）在插件 apply 时 fail loud。

## 开发

```sh
pnpm install
pnpm run typecheck   # tsc --noEmit（src，影子类型）
pnpm test            # vitest（纯逻辑核心 + 注册层）
pnpm run build       # tsc + tsdown → lib/（预构建入库）
```

- `src/wait-for.ts`：等待核心（类型、正则编译与回退、超时钳制、扫描/行号换算、轮询、渲染），依赖注入，可单测
- `src/index.ts`：插件入口（`name` / `inject` / `Config` / `apply`），注册 `terminal_wait_for`
- `src/types.d.ts`：peer 包的最小影子声明（独立 typecheck，不需要安装宿主）
- 设计/计划：`docs/plans/2026-09-30-terminal-wait-for-design.md`、`docs/plans/2026-09-30-terminal-wait-for-plan.md`

## 运行

```sh
# 开发热更新（link:）
dsh plugin --profile <profile> add link:D:\Projects\deepseek-harness\dsh-plugin-terminal-extension-wait-for
# 分发（预构建 lib/，github: 开箱即用）
dsh plugin --profile <profile> add github:huanlinoto/dsh-plugin-terminal-extension-wait-for
# npm
dsh plugin --profile <profile> add @huanlin/dsh-plugin-terminal-extension-wait-for
```

按「挂载位置与 realm」确认插件行的位置，然后重启 `dsh web` 并硬刷新（`Ctrl+Shift+R`）。

## 检查

```sh
pnpm run typecheck
pnpm test
node -e "import('./lib/index.js').then(m => console.log(m.name, m.inject))"
```

## License

AGPL-3.0
