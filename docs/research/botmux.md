# botmux 深读笔记（deepcoldy/botmux）

> 研究对象：`scratchpad/repos/botmux`，HEAD `32839be`（2026-09-29 merge #1615）。
> 规模：`src/` 约 50 万行 TS（`daemon.ts` 2.98 万行、`worker.ts` 2.38 万行、`core/worker-pool.ts` 1.89 万行）。下文路径都相对仓库根目录。
> 结论先行：botmux 是一个**只支持飞书**的「IM ↔ 真实 CLI 进程」桥。它**没有**全局统一的 agent IO 协议，但有几处内部契约很值得借鉴：worker↔daemon IPC 的 `WorkerToDaemon` 判别联合、`CotEntry` 过程事件、`remote-runner` JSONL 协议、in-band OSC 控制帧、per-session MCP Gateway。

---

## 0. 一句话定位

"在飞书里遥控你的 AI 编程 CLI。一条消息启动一个会话，每个会话一个独立 CLI 进程，实时流式回传——手机、电脑、终端三端同步。"（README.md）
设计理念一节明确写着「直接桥接 CLI，不做 SDK wrapper」：桥接的是完整 CLI 进程（hooks / memory / plan mode / MCP / `/` 命令），而不是 SDK 暴露的接口面。

## 1. 进程模型与模块

`docs-site/docs/zh/architecture.md`：

```
飞书长连接事件 → daemon（每 bot 一个进程） → worker（每话题/会话一个子进程） → CLI 进程（挂在 PTY / tmux 等后端上）
```

- **daemon**（`src/daemon.ts`）：监听飞书 WS 事件、路由、权限、会话生命周期、卡片渲染。**一个 bot 一个 daemon**，多 bot 就是多 daemon，进程完全隔离（同一节文档里写的）。fleet supervisor 统一管理（`src/core/fleet-supervisor.ts`）。
- **worker**（`src/worker.ts`）：用 `child_process.fork` + Node IPC（`process.send`，见 `worker.ts:21930` 的 `send()` 和 `core/self-spawn.ts`）。负责：通过 CLI 适配器拉起 CLI；把输入写进 CLI；读 PTY 字节流喂给 headless xterm；tail CLI 的 transcript；起该会话自己的 Web 终端 HTTP/WS 服务；托管该会话的 MCP Gateway。
- **CLI 适配器**（`src/adapters/cli/*.ts`，每种 CLI 一个文件，`CliId` 里有 33 个）。
- **会话后端**（`src/adapters/backend/*.ts`）：`BackendType = 'pty' | 'tmux' | 'herdr' | 'zellij' | 'zmx' | 'riff' | 'mojo' | 'remote-runner'`。
- **IM 层**：`src/im/lark/*` 全是飞书。`src/im/types.ts` 里虽然定义了一个通用的 `ImAdapter` / `ImEventHandler` 接口，但**没有任何实现**（只在 `core/types.ts:57` 的一段注释里出现过 `LarkImAdapter`），daemon 直接 import `im/lark/*`。也就是说 IM 侧**事实上不可扩展**。

`packages/` 目录跟 IO 没什么关系：`binary-<os>-<arch>` 是按平台分发自包含 bun 二进制的 npm 壳包；`workflow-core` 是从 daemon 抽出来的 v3 workflow DAG / 调度 / gate 契约（README：「deliberately does not export the Botmux daemon driver, Feishu cards, ephemeral worker pool, PTY/session integration」）。

## 2. 输入路径（飞书消息 → CLI）

1. 飞书 `im.message.receive_v1` 事件 → `src/im/lark/event-dispatcher.ts` 解析，判断归属（@mention、话题、群权限）。消息解析在 `src/im/lark/message-parser.ts`（含合并转发、引用、图片/文件附件下载：`core/session-manager.ts:690 downloadResources`）。
2. 斜杠命令用一个纯函数做一次分类：`classifySlash(...)`（`src/core/command-router.ts`），命令注册表只在 `src/core/command-schema.ts`（CLAUDE.md「命令路由」一节）。daemon 有两个入口 `handleNewTopicAdmitted` / `handleThreadReplyAdmitted`。
3. 权限分三层：canTalk / canOperate / 管理命令（`docs-site/docs/zh/session-model.md`）。
4. **Prompt 封装**：daemon 把人说的话包成 XML 风格的 envelope 再交给 CLI：
   - `renderSenderTag()`（`core/session-manager.ts:848`）→ `<sender type=".." open_id=".." name=".." email=".." />`
   - `buildNewTopicCliInput` / `buildFollowUpCliInput`（同文件 1482 / 1872）→ `<user_message>`、`<botmux_reminder>`、`<session_id>` 等块。
   - 外部 API 事件包成 `<botmux_external_event trusted="false">`，可信指令包成 `<botmux_task trusted="true">`（`docs-site/docs/zh/api-task-trigger.md` §3.3）。
   - Claude Code 有一个可选的**不可见注入**：用 `UserPromptSubmit` hook 把 envelope 作为 additionalContext 注入（成为 system-reminder，TUI 里看不到），上限 8k，超过就回落成 inline（`resolveEnvelopeInjectionMode`，session-manager.ts 约 1800 行）。
   - 「零注入」模式（`promptInjection: "none"`）只传任务正文。
5. daemon → worker IPC：`{ type: 'message'; content; turnId; trustedCaller; codexAppInput?; ... }`（`src/types.ts`，`DaemonToWorker` 联合，约 1748 行）。
6. worker 侧排队：`pendingMessages` + `src/utils/input-gate.ts shouldWriteNow()`（CLI idle 时写入，或者适配器支持 type-ahead 时在 busy 期间也写），`core/inject-queue-policy.ts`（`/cd` 这类 barrier 注入优先），`core/active-turn-authority.ts`（谁能打断 / steer 当前 turn）。
7. **真正写进 CLI**：`CliAdapter.writeInput(pty, content, ctx)`（`adapters/cli/types.ts`）。不同适配器的写法差别很大：
   - **claude-code**（`adapters/cli/claude-code.ts:1212`）：在 tmux 里用 `send-keys -l` 逐字「打字」，换行用 `\` + Enter 作软换行，按字节限速以避开 Ink 的 paste-burst 判定，最后 Enter 提交；然后**读 `~/.claude/projects/.../<id>.jsonl`，确认新增了 user 行才算提交成功**，没有就重试 Enter。启动参数：`--session-id/--resume`、`--dangerously-skip-permissions`、`--append-system-prompt`、`--plugin-dir`、`--settings`。
   - **codex（TUI 模式）**：tmux + transcript。
   - **codex「hybrid RPC input」**（`src/codex-rpc-engine.ts`，按 bot 用 `codexRpcInput` 开启）：每个会话起一个 `codex app-server --listen ws://127.0.0.1:<port>`。输入走 JSON-RPC `turn/start`（有 ack），tmux pane 里跑的是真 TUI `codex --remote ws://... resume <threadId>`，**只当查看器用**。源码注释写明 app-server 会把同一 thread 的事件**广播给所有打开该 thread 的连接**，所以 TUI 能实时渲染 engine 发起的 turn。
   - **codex-app**（`adapters/cli/codex-app.ts` + `src/codex-app-runner.ts`）：不跑 TUI，用一个 node runner 通过 stdio 跟 `codex app-server` 讲 JSON-RPC，把文本渲染到 PTY，结构化事件用 OSC 控制帧带出（见 §3.3）。`writeStructuredInput()` 走结构化 `CodexAppTurnInput`。
   - **remote-runner**：`submitTurn()` 发 JSONL `turn` 命令（§5）。
8. 其它输入源（全都汇进同一套 session/turn 机制）：
   - `POST /api/trigger`（webhook / CI / 编排器；同步 `waitForFinalOutput`、异步 `asyncReturnSessionId`、即发即忘三种；target 可以是虚拟会话、真群、已有话题、已有会话；带 `idempotencyKey` / `turnIdempotencyKey`）——`docs-site/docs/zh/api-task-trigger.md`
   - 定时任务（`core/scheduler.ts`）、飞书文档评论（`core/doc-comment-poller.ts`）、飞书会议事件（`src/vc-agent/*`）、Dashboard 新建会话、Web 终端直接敲键、本机 `tmux attach`、`/adopt` 接管本地已有的 tmux/zellij 会话。

## 3. 输出路径（CLI → 飞书 / 各端）

botmux 的输出不是一条流，而是**4 条并行通道**，各自来源和可靠性都不同。这是它最值得研究的地方。

### 3.1 画面通道：终端截图 / 流式卡片（「过程可见」的兜底）

- worker 把 PTY 字节喂给 `@xterm/headless`（`src/utils/terminal-renderer.ts`），用 `@napi-rs/canvas` 渲染成 PNG（`src/utils/screenshot-renderer.ts`，Tokyo Night 配色）。
- 空闲 / 忙碌靠**刮屏启发式**判断：`src/utils/idle-detector.ts`（spinner 字符集 `[·✢✳✶✻✽⠀-⣿■⬝]`、2s 静默、3s spinner guard），加上每个适配器自己的 `completionPattern` / `busyPattern` / `readyPattern`（Claude 的 ready 是 `/❯/`）。
- IPC：`screen_update { content, status: ScreenStatus }`、`screenshot_uploaded { imageKey }`。其中 `ScreenStatus = 'working' | 'idle' | 'analyzing' | 'limited' | 'stalled'`。
- 飞书侧：每轮一张实时刷新的卡片，「终端画面原样截图回传」，上一轮卡片冻结（`docs-site/docs/zh/cards.md`）。
- 刮屏还被用来识别 TUI 菜单：`tui_prompt { description, options[] }` → 飞书选项卡片 → 用户点击 → `tui_keys` 发回按键（`worker-pool.ts:14762`）。

### 3.2 过程通道：CoT / 工具调用时间线（结构化，来自 transcript 或 RPC）

`src/types.ts:1859`：

```ts
export type CotEntry =
  | { kind: 'thinking'; text: string }
  | { kind: 'text'; text: string }              // 轮次中途的旁白
  | { kind: 'tool_call'; id: string; name: string; args: string; subject?: string }
  | { kind: 'tool_result'; id: string; result: string };
```

- 来源：Claude 是 tail session JSONL（`services/claude-transcript.ts extractCotEntries`）；Codex 是结构化 bridge queue / app-server 通知（`services/codex-app-cot.ts`）；cursor、antigravity、pi 也各有自己的 `*-cot.ts`。
- worker 端的累积核心与 CLI 无关（`worker.ts:4874-5020`，`observeCotEntries`）：每轮只追加，1.5s trailing throttle，每次发**完整的累积列表**，上限 60KB。IPC 是 `thinking_update { entries, turnId, dispatchAttempt }`。
- daemon 端 `src/im/lark/cot-message.ts`：调飞书 `im.v1 message_cot` 原生「思考气泡」API，**用的是 AG-UI 协议事件**：RUN_STARTED / REASONING_START / CONTENT / END / TOOL_CALL_START(title 里放命令或文件路径) / TOOL_CALL_RESULT / RUN_FINISHED。只推还没推过的 entry；同一会话同时只有一个 PUT 在飞，latest-wins。
- 文件头注释写了"Strictly cosmetic"：这条通道**永远不影响 turn 结算**。开关是 per-bot `cotEnabled` + per-chat `/cot off`；`thinkingCardToolResult:false` 只隐藏工具结果正文（`docs/tool-result-presentation.md`）。

### 3.3 最终答案通道：两种互补机制

**(a) agent 主动推送：`botmux send`（skill + CLI 子命令）**
`src/skills/definitions.ts:318 SEND_SKILL` 告诉模型：「用户在飞书上阅读，看不到你的终端输出。想让用户看到的内容**必须**通过 `botmux send` 发送。」支持 markdown、图片、文件、原始卡片 JSON（之后可以用 `botmux card patch/stream` 更新）、`--mention-back`、`--attention`（举手，进 dashboard「需要你」列）、`--urgent`、`--response-kind progress|final`。也就是**把"输出"做成 agent 自己调用的一个工具**。

**(b) transcript bridge 兜底**（`replyDelivery: 'send' | 'transcript'`）：worker tail CLI 的原生 transcript（Claude JSONL；Codex rollout `~/.codex/sessions/.../rollout-*.jsonl`，以 `task_complete.last_agent_message` 为终态，见 `services/codex-transcript.ts` 头注释），抽出最终 assistant 文本，发 `final_output { content, turnId, kind, suppressDelivery?, usage? }`。如果模型这一轮已经用 `botmux send` 发过（IPC `explicit_reply_observed`），就 `suppressDelivery`，不重复发。零注入模式完全靠这条通道。

**(c) 轮次终态**：`turn_terminal { sessionId, turnId, dispatchAttempt, status: 'completed'|'failed'|'cancelled'|'ambiguous', retryable?, outputDisposition?: 'nothing_to_send', completedAtMs?, durationMs? }`。这和"有没有输出"是**正交**的。

### 3.4 in-band 控制帧（结构化事件和显示字节共用 PTY）

`src/adapters/cli/runner-control-channel.ts`：

```ts
export const RUNNER_CONTROL_PREFIX = '\x1b]777;botmux:';   // OSC 777
export const RUNNER_CONTROL_END = '\x07';
marker(kind, payload) → `${PREFIX}${kind}:${base64(JSON)}${END}`
display(value) → 把显示文本里所有 ESC 替换成 '␛'（结构上防伪造）
```

codex-app-runner 把 `activity` / `thinking` / `final` 等 marker 混在 PTY 流里发，worker 用 `RunnerControlDecoder` 剥离（能处理跨 chunk 的帧，超限的帧作废）。codex-app 另外还有一个签名 control socket（`utils/codex-app-control.ts`），final 要两阶段结算。

### 3.5 Web 终端 & 本地 tmux（终端级多端）

- 每个 worker 起一个 `WebSocketServer`（`worker.ts:19924`），xterm.js 前端。只读链接直接挂在卡片上；可写链接要 `writeToken`（由 dashboard secret + sessionId 派生，`deriveTerminalWriteToken`），并且经私聊发送。
- 连接管理：`wsClients`（所有连接）/ `authedClients`（可写）。**tmux 模式下每个 web 客户端各自开一个 `tmux attach` PTY**（tmux 原生多 client）；非 tmux 模式则用共享 scrollback 广播字节流（`worker.ts:11789` 附近）。
- 「三端同步」：飞书话题、Web 终端、本地 tmux 看到的是**同一个**CLI 进程；在任何一端输入效果一样（`docs-site/docs/zh/web-terminal.md`）。

### 3.6 Dashboard 事件总线

`src/core/dashboard-events.ts`：一个进程内 pub/sub `DashboardEventBus`，事件有 `session.spawned/update/exited`、`schedule.*`、`bots.changed`、`heartbeat`，通过 SSE（`text/event-stream`，`dashboard-ipc-server.ts:8681`）推给 dashboard。这是**会话元数据**级的订阅，不是 agent 内容流。

## 4. 内部协议：有没有统一消息类型？

- **IM ↔ daemon**：没有通用抽象（`ImAdapter` 是死代码）。直接用飞书类型。
- **daemon ↔ worker**：`DaemonToWorker` / `WorkerToDaemon` 判别联合（`src/types.ts:1736-2276`），这是**事实上的内部统一协议**，但非常庞大，并且带着大量 CLI 专属字段（`codexApp*`、`mojoLivePatch`、`riff_*`、`bridge_source_session: 'hermes'`）。核心子集：
  - 入：`init`、`message`、`raw_input`、`tui_keys`、`tui_text_input`、`term_action`、`interrupt_turn`、`close`、`restart`、`suspend`、`refresh_screen`
  - 出：`ready`、`prompt_ready`、`turn_input_received/committed/rejected`、`screen_update`、`screenshot_uploaded`、`thinking_update`、`tui_prompt(_resolved)`、`stuck_warning`、`final_output`、`turn_terminal`、`explicit_reply_observed`、`cli_session_id`、`error`、`worker_fatal`
  - 所有和轮次相关的消息都带 `turnId` + `dispatchAttempt`（防止迟到事件结算新的一次尝试），worker 还要校验 `sessionId`（防止旧 worker 写进别的话题）。
- **worker ↔ CLI**：每种 CLI 各写各的（`CliAdapter` 接口 + 一堆可选能力位：`supportsTypeAhead`、`reliableTurnTerminal`、`asksViaHook`、`injectsReadyHook`、`emitsStructuredRateLimit`、`supportsInvisiblePromptHook`、`altScreen`、`inputEnvelope: 'standard'|'service-user'`、`mcpGateway`、`hookInstall` ……）。
- **后端抽象** `SessionBackend`（`adapters/backend/types.ts`）：PTY 层的 `spawn/write/resize/onData/onExit/kill/captureCurrentScreen`，**外加**结构化可选回调 `submitTurn / onTurnFinal / onTurnFailure / onOutboundMessage / onUsageSnapshot / onBackendState / onReady`。也就是说同一个接口既能装"字节流后端"，也能装"结构化轮次后端"。

## 5. Remote Runner 协议（最接近"统一 runtime 适配协议"的东西）

`docs/remote-runner.md` + `src/adapters/backend/remote-runner-protocol.ts`。provider 子进程用 stdin/stdout JSONL，每行带 `{"protocol":"botmux.remote-runner","version":1,"type":...}`。

命令（host→provider）：`hello{requiredCapabilities}`、`start{cwd,model?,reasoningEffort?}`、`resume{state,resumeMode:'reattach'|'rebuild'}`、`turn{turnId,content,trustedCaller?}`、`cancel`、`detach`、`reattach`、`status`、`outbound_message_result`、`terminal_input{generation,data}`、`terminal_resize`。

事件（provider→host）：

```ts
| { type: 'hello'; requestId; provider; capabilities: string[] }
| { type: 'ready'; requestId; state: RemoteRunnerBackendState }
| { type: 'progress'; turnId; content }
| { type: 'outbound_message'; operationId; turnId; generation; content; responseKind: 'progress'|'auxiliary'; mention: 'none'|'requester' }
| { type: 'final'; turnId; content; state?; usage? }
| { type: 'failure'; requestId?; turnId?; code; message; status: 'failed'|'ambiguous'|'cancelled'; retryable }
| { type: 'access_url'; url }
| { type: 'lineage_changed'; state }
| { type: 'terminal_screen'; generation; sequence; cols; rows; snapshot }
| { type: 'status'; requestId; status: 'starting'|'ready'|'busy'|'closed'|'detached'|'error'; state? }
```

几个关键设计：
- capability 协商：未知 capability 透传忽略，未知事件类型直接按协议错误关闭；终端能力和主动消息都是**可选**的。
- 每个 turn 必须先回 `status: busy` ACK，之后才允许发 `progress/final`；ACK 之后的 failure 必须带 `turnId`。
- `generation` 栅栏：`remoteSessionId`（计算资源）和 `agentThreadId`（对话血缘）**生命周期独立**；旧 generation 的迟到事件一律丢弃。
- `terminal_screen` 是**整帧快照替换**，不追加到 scrollback；文档写明它「不能被解析成业务终态」，任务完成只看 `final/failure`。
- `outbound_message` **不允许 provider 指定路由**（没有 chat、topic、open_id 字段），目的地由 host 根据认证过的 session/turn 推导；`operationId` 在单 turn 内幂等，每 turn 最多 10 个；结果分 `delivered|rejected|unknown`，`unknown` 不能自动重放。
- 用量 `usage.snapshot`：缺的指标保持缺失，「不得由 provider 估算」（CONTEXT.md 也反复强调 Token/Context 绝不估算）。
- 参考实现：`examples/remote-runner/reference-runner.mjs`。

## 6. MCP 插件聚合（MCP Gateway）

- 插件 = 一个 npm 包，可以贡献 Skill / MCP / CLI 命令 / Dashboard 页 / Host Service（`docs-site/docs/zh/plugins.md`）。每个插件最多一个 MCP server，transport 只支持 `stdio | streamable-http`。
- 每个 CLI 的全局配置里**只写一条** `botmux` MCP 入口（`McpGatewayInstallSpec { configPath; format: 'codex-toml'|'claude-json' }`，`core/plugins/mcp/gateway-installer.ts`），命令是 `~/.botmux/bin/botmux mcp serve`。
- `mcp serve` 是个 relay，通过 per-session unix socket（`/tmp/bmcp-<uid>-<sha16(dataDir,sessionId)>/g.sock`，路径确定，所以 worker 重启后 relay 能重连；目录必须是 0700，连接要轮换 token，见 `core/plugins/mcp/host.ts`、`socket-auth.ts`）连到 worker 里托管的 `PluginMcpGateway`（`core/plugins/mcp/gateway.ts`，基于 `@modelcontextprotocol/sdk`）。
- Gateway 聚合下游各插件的 tools/prompts/resources：工具名只有一个插件提供时保留原名，冲突时改成 `<pluginId>__<tool>`（gateway.ts:592）。插件集合和凭证快照**以 CLI 进程为边界**，改了要新开会话。
- **可信调用身份注入**：转发 `tools/call` 时，注入宿主盖章的 `_meta.botmuxTrustedCaller { requestUserOpenId, requestUserUnionId, requestLarkAppId }`；HTTP transport 还加 `x-botmux-trusted-*` 请求头。注入前**无条件剥离**模型自己塞进去的 `botmux*` 键。没有身份时插件必须 fail-closed。

## 7. 审批 / 提问（Human-in-the-loop）

- 默认就是 bypass：Claude 加 `--dangerously-skip-permissions`；codex-app runner 对 `item/commandExecution/requestApproval`、`fileChange`、`execCommandApproval`、`applyPatchApproval` **一律自动回 `acceptForSession` / `approved_for_session`**，`requestUserInput` 回空答案，`mcpServer/elicitation` 回 cancel（`codex-app-runner.ts:924-965`）。
- 提问 / 确认走 hook：`botmux hook <cliId>` 被装进 CLI 的 hooks（`adapters/hook-installer.ts`）：
  - Claude：`PreToolUse(matcher=AskUserQuestion)` + `PermissionRequest`（无 matcher；用来接住 bypass 下仍会弹出的内置安全确认框，比如危险 rm）+ `SessionStart`（就绪信号）+ `UserPromptSubmit`（不可见上下文注入）。
  - hook 客户端 POST `http://127.0.0.1:<ipcPort>/api/asks` 并长轮询 → daemon `ask-broker` → 飞书互动卡片（多问 / 多选 + Submit）→ 用户点击 → 答案作为 **directive 写回 hook stdout**（Claude：`hookSpecificOutput.decision.updatedInput.answers`），CLI 直接消费，不用碰键盘（`docs/design/2026-05-25-botmux-ask-hooks-design.md`）。
  - hook 不支持回填的 CLI，就退回到刮屏识别菜单（`tui_prompt`）+ 注入按键。

## 8. 多 bot、多端、多人输入

- **多 bot**：同一个群里放多个 bot（不同 CLI），用 @mention 路由；bot-to-bot 用 `botmux dispatch` 派单，签名回报绑定（`docs/dispatch-receipt.md`、`core/dispatch*.ts`）。每个 bot 一个 daemon。
- **一会话多端查看**：飞书卡片（截图 + CoT 气泡 + 最终回复）、Web 终端（只读 / 可写）、本地 `tmux attach`、Dashboard（SSE 元数据）。注意：这**不是**一个统一的"订阅 agent 事件流"抽象，而是**每条通道各自**从 worker 取数据（字节流、截图、transcript）。
- **一会话多端输入**：
  - 飞书里**多个发送者**进同一个 Session：CONTEXT.md 里 Sender Identity 是「follows each message turn rather than being fixed to a Session; multiple senders may therefore appear in one Session」。每轮都带 `<sender>` 标签 + `trustedCaller`。
  - 冲突处理：worker 侧的 FIFO `pendingMessages` + 每轮 `turnId`；type-ahead（Claude/Codex/CoCo 在忙的时候也能把输入塞进 TUI 自己的队列）；Codex 可以 `turn/steer`（API `options.steer`）；`active-turn-authority.ts` 决定谁能控制或打断当前 turn（同一 principal 或任务 controller）；`group-serial-input` 是群级串行开关。
  - **XPI 跨身份打断隔离 / principal lanes**（`docs/principal-lanes.md`）：开启后同一个群里**每个真人有自己独立的 CLI 上下文和 git worktree**；引用别人的任务时进入「建议 / 确认」流程，由任务发起人采纳或拒绝。
  - 终端端（web 可写 / 本地 tmux）的输入**绕过**这一切直接进 PTY；零注入模式下 Web 终端里直接敲的轮次，最终答案也会回传到飞书（`terminal_turn_started` / `final_output.terminalLocal`）。
- **会议（多 agent 消费）**（`docs/design/2026-07-10-vc-multi-agent-consumer-delivery.md`）：单 listener、单 canonical meeting feed → hub 给**每个 agent 签发独立连续的 `deliverySeq`、独立 cursor**；「分析可以有多份，副作用必须是单出口」——所有对外副作用都经过 daemon 的确定性 action gate、唯一 sink owner、稳定 `actionId`。归一化的会议事件类型见 `src/vc-agent/types.ts`（`participant_joined/left`、`chat_received`、`transcript_received{sentenceId, revision, isFinal}`、`magic_share_*`）。
- **会议实时语音**（`docs/design/2026-07-01-vc-bot-realtime-voice.md`、`src/vc-agent/realtime/*`）：飞书会议实时音频 WS（Frontier proto2 + ClientEvent/ServerEvent proto3，PCM s16le 24kHz），100ms pacer、背压；v0 单向播报（TTS），v1 对话式；失败降级到会中文本消息。

## 9. 回答用户问题时可以引用的证据

| 用户问题 | botmux 的做法 | 证据 |
|---|---|---|
| 统一 IO 协议还是各自处理？ | **混合**：CLI 侧各自处理（33 个适配器 + 能力位），但 worker↔daemon 收敛到一套判别联合；对"未知 / 远端 runtime"提供了一个干净的 JSONL 协议 | `adapters/cli/types.ts`、`types.ts` WorkerToDaemon、`remote-runner-protocol.ts` |
| 输出是不是订阅？ | 会话级"多 viewer"是按通道实现的（WS 广播、tmux 多 client、飞书卡片），**没有**统一事件总线；CoT 是"每次发累积全量，消费者自己算 delta"的幂等推送 | `worker.ts:4874`、`cot-message.ts`、`worker.ts:11789` |
| 多端输入？ | 支持，但冲突靠 turn 队列 + authority + XPI lane，而不是 CRDT 之类 | `active-turn-authority.ts`、`input-gate.ts`、`principal-lanes.md` |
| 过程可见？ | 三层：终端截图（任意 CLI 都有）→ CoT/工具时间线（transcript / RPC 结构化）→ agent 主动 `botmux send --response-kind progress` | §3 |
| 私有通道扩展？ | IM 侧**不可扩展**（只有飞书）；扩展点是插件（MCP / Skill / Service / CLI 命令）、`/api/trigger`、remote-runner | `im/types.ts` 未使用、`plugins.md` |

## 10. 观察到的代价

- 刮屏 + 打字式输入非常脆：Claude 的 `writeInput` 要处理 paste-burst、bracketed paste 被关、软换行，还要靠 JSONL 字节增长来确认提交；idle 判断靠 spinner 正则。仓库里大量 test（1500+ 文件）和超长注释都在补这些边角。
- 单文件体量失控（daemon.ts 3 万行），IPC 联合类型里混着各 CLI 的专属字段，说明"每个 CLI 各自处理"的成本最终会渗漏到公共层。
- 审批默认全放行（bypass + 自动 accept），安全依赖沙箱（bwrap / Seatbelt）和 hook 兜底。
- 飞书写死：卡片、CoT、权限模型、身份（open_id 是 app-scoped）全都和 Lark 耦合。
