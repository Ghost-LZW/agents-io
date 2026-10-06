# Codex (+ACP) 嵌入面调研

> 调研日期 2026-10-06。本地 `codex-cli 0.160.1`。协议类型均来自本地 `codex app-server generate-ts [--experimental]` 生成结果（与运行版本严格一致），
> 文档来自 `developers.openai.com/codex/app-server`（现 308 到 `learn.chatgpt.com/docs/app-server`）、`openai/codex` 仓库源码 / SDK README，
> 以及 scratchpad 里 botmux / multica / openclaw / happyclaw 的实际接入代码。标 **[推测]** 的为未经代码/文档直接证实的判断。

## 0. 一句话

Codex 官方已经把"统一 IO 协议"做好了：**`codex app-server`** 是一个 JSON-RPC 2.0 服务（stdio / unix socket / websocket），
以 **Thread → Turn → Item** 建模，item 有 `started / *delta / completed` 生命周期，审批是 server→client 的 JSON-RPC request；
**一个 thread 可以被多个 connection 同时订阅（事件广播）、多个 connection 都能往里 `turn/start` / `turn/steer`，审批"先答者赢"并用 `serverRequest/resolved` 通知其他端**。
Codex 自己的 TUI（`codex --remote`）、Desktop app、VS Code 插件、Python SDK、`codex-acp` 都是它的 client。
=> 对 agents-io：Codex 侧不需要自己发明协议，gateway 只需当一个 app-server client（或多个）。

## 1. 官方嵌入面一览

| 面 | 形态 | 交互能力 | 适用 |
|---|---|---|---|
| `codex app-server` | JSON-RPC 2.0；`--listen stdio://`(默认) / `unix://[PATH]` / `ws://IP:PORT` / `off` | 全双工：多 thread、多 turn、steer、interrupt、审批、user input、MCP elicitation、fs、config、model、realtime 语音(exp)… | **首选**，富客户端 / gateway |
| `codex app-server daemon start/stop/...` + `codex agents` | 本机共享 app-server 守护进程（control socket），`codex agents` "Browse all agent sessions on the shared local app-server daemon" | 同上，多客户端共享 | 多端共享同一 runtime |
| `codex remote-control start/pair` (exp) | daemon + 远程控制 + 配对码（`remoteControl/pairing/start`、`remoteControl/client/list/revoke`） | 远端设备接入 | 手机/远端（官方通道） |
| `codex --remote ws://…/unix://… [resume <id>]` | 官方 TUI 作为 app-server 的远程 client | 人类终端视图 | 给"终端端"复用官方渲染 |
| `codex exec --json` / `exec resume <id>` | 一次性进程，stdout JSONL | 单向；无审批往返（只能事先设 approval/sandbox 策略） | CI/批处理 |
| `@openai/codex-sdk` (TS) | 包 `codex exec --experimental-json`（`sdk/typescript/src/exec.ts:95`） | `run()` / `runStreamed()`；resume 走 `exec resume` | 轻量脚本 |
| `openai-codex` (Python SDK) | 基于 app-server（`sdk/python/src/openai_codex/client.py`、`tests/test_app_server_run.py`，生成模型 `generated/`） | 较全 | Python 宿主 |
| `codex mcp-server` | 0.160.1 的 `codex --help` 已不列出该子命令（`grep -c mcp-server` = 0）**[推测：已移除或隐藏]** | — | 不建议依赖 |
| ACP | 官方不内建；社区/联盟 adapter `@agentclientprotocol/codex-acp`："starts the Codex App Server, translates ACP requests into Codex operations" | ACP 能力子集 + AIR 扩展 | 接 Zed/JetBrains 等 ACP 客户端 |

## 2. app-server 协议细节

### 2.1 传输与握手
- 线格式："JSON-RPC 2.0 without the header on wire"；stdio 为 NDJSON，WebSocket 一帧一条消息；WS 有 `GET /readyz`、`/healthz`。
- WS 鉴权（文档原文）："Non-loopback WebSocket listeners currently allow unauthenticated connections by default during rollout" → 支持
  `--ws-auth capability-token --ws-token-file PATH` / `--ws-token-sha256 HEX` / `--ws-auth signed-bearer-token --ws-shared-secret-file PATH`（+ `--ws-issuer/--ws-audience`），
  握手时 `Authorization: Bearer <token>`，"app-server enforces auth before JSON-RPC initialize"。
- 必须先 `initialize`（`clientInfo{name,title,version}` + `capabilities`），再发 `initialized` 通知。
  `InitializeCapabilities` 关键字段：
  ```ts
  { experimentalApi: boolean, requestAttestation: boolean,
    optOutNotificationMethods?: Array<string> | null,   // 每连接按方法名精确屏蔽通知，如 "item/agentMessage/delta"
    extensions?: {...}, explicitGatewayOauth?: boolean, mcpServerOpenaiFormElicitation?: boolean }
  ```
  `optOutNotificationMethods` 对多端很有用：邮件端可以屏蔽 delta，只要 `item/completed`。

### 2.2 Thread / Turn / Item
```ts
// v2/Turn.ts
type Turn = { id: string /*UUIDv7*/, items: Array<ThreadItem>, itemsView: TurnItemsView,
  status: "completed" | "interrupted" | "failed" | "inProgress", error: TurnError | null,
  startedAt, completedAt, durationMs }
// v2/ThreadStatus.ts
type ThreadStatus = {type:"notLoaded"} | {type:"idle"} | {type:"systemError"}
  | {type:"active", activeFlags: Array<"waitingOnApproval" | "waitingOnUserInput">}
```
`ThreadItem` 判别联合（`v2/ThreadItem.ts`）的 type：
`userMessage`(含 `clientId`!)、`hookPrompt`、`agentMessage`(`phase: commentary|final_answer`, `delivery`, `questions`)、`functionCallOutput`、`plan`、`reasoning`(`summary[]`,`content[]`)、
`commandExecution`(`command,cwd,status,commandActions,aggregatedOutput,exitCode,durationMs`)、`fileChange`(`changes,status`)、`mcpToolCall`(`server,tool,arguments,result,error,mcpAppUi`)、
`dynamicToolCall`、`collabAgentToolCall`、`subAgentActivity`、`webSearch`、`imageView`、`sleep`、`imageGeneration`、`enteredReviewMode`、`exitedReviewMode`、`contextCompaction`。

输入 `UserInput`（`v2/UserInput.ts`）——**多模态输入是一等公民**：
```ts
type UserInput = {type:"text", text, text_elements} | {type:"image", url|fileId} | {type:"localImage", path}
  | {type:"audio", url} | {type:"localAudio", path} | {type:"skill", name, path} | {type:"mention", name, path}
```

### 2.3 Client → Server 主要方法（非实验，摘自生成的 `ClientRequest.ts`）
- thread：`thread/start` `thread/resume` `thread/fork` `thread/read` `thread/list` `thread/loaded/list` `thread/turns/list` `thread/items/list`
  `thread/unsubscribe` `thread/archive|unarchive|delete` `thread/name/set` `thread/goal/*` `thread/metadata/update` `thread/compact/start`
  `thread/shellCommand` `thread/inject_items` `thread/revert` `thread/attachment/*`
- turn：`turn/start`、`turn/steer`、`turn/interrupt`、`review/start`
- 其他：`command/exec*`、`fs/*`、`model/list`、`config/*`、`mcpServer/*`、`skills/*`、`plugin/*`、`account/*`
- 实验（`--experimental` 生成）：`thread/queue/add|list|update|delete|reorder|start`、`thread/realtime/start|appendAudio|appendText|appendSpeech|stop|listVoices`、
  `remoteControl/enable|disable|status/read|pairing/start|pairing/status|client/list|client/revoke`、`process/spawn|writeStdin|kill|resizePty`

`TurnStartParams` 要点：`{threadId, input: UserInput[], clientUserMessageId?, turnTrigger?, cwd?, approvalPolicy?, approvalsReviewer?, sandboxPolicy?, model?, effort?, summary?, outputSchema?, ...}`（每 turn 可覆盖模型/沙箱/审批）。
`TurnSteerParams`：`{threadId, clientUserMessageId?, input, expectedTurnId}` —— "Required active turn id precondition"，即**乐观并发控制**：多端同时 steer 时，turn 已换就失败。
`thread/queue/add`：`{threadId, input, clientUserMessageId}` —— 服务端排队的后续提交（exp），`thread/queue/changed` 通知。

### 2.4 Server → Client 通知（`ServerNotification.ts`，节选）
- thread：`thread/started` `thread/status/changed` `thread/closed` `thread/name/updated` `thread/tokenUsage/updated` `thread/queue/changed` `thread/compacted` `thread/settings/updated`
- turn：`turn/started` `turn/completed` `turn/diff/updated` `turn/plan/updated`
- item：`item/started` `item/completed` `item/agentMessage/delta` `item/plan/delta` `item/reasoning/summaryTextDelta|summaryPartAdded|textDelta`
  `item/commandExecution/outputDelta` `item/commandExecution/terminalInteraction` `item/fileChange/outputDelta` `item/fileChange/patchUpdated` `item/mcpToolCall/progress`
  `item/autoApprovalReview/started|completed`
- hook：`hook/started` `hook/completed`；其他：`serverRequest/resolved` `error` `warning` `model/rerouted` `account/rateLimits/updated` `remoteControl/status/changed`
- realtime（exp）：`thread/realtime/started|itemAdded|item/started|item/transcript/delta|item/completed|transcript/delta|transcript/done|outputAudio/delta|sdp|error|closed`

```ts
type ItemStartedNotification = { item: ThreadItem, threadId: string, turnId: string, startedAtMs: number }
type AgentMessageDeltaNotification = { threadId: string, turnId: string, itemId: string, delta: string }
type ServerRequestResolvedNotification = { threadId: string, requestId: RequestId }
```
每条事件都带 `threadId/turnId/itemId`，天然可按 thread 路由、按 item 聚合（"中间过程"直接可见）。

### 2.5 审批 / 交互请求（Server → Client request，`ServerRequest.ts`）
`item/commandExecution/requestApproval`、`item/fileChange/requestApproval`、`item/permissions/requestApproval`、`item/tool/requestUserInput`(exp)、
`mcpServer/elicitation/request`、`item/tool/call`（动态工具，由 client 执行！）、`account/chatgptAuthTokens/refresh`、`attestation/generate`，以及 v1 旧名 `execCommandApproval` / `applyPatchApproval`。
```ts
type CommandExecutionRequestApprovalParams = { kind, threadId, turnId, itemId, startedAtMs, approvalId?, environmentId,
  reason?, networkApprovalContext?, command?, cwd?, commandActions?, proposedExecpolicyAmendment?, proposedNetworkPolicyAmendments? }
type CommandExecutionApprovalDecision = "accept" | "acceptForSession" | {acceptWithExecpolicyAmendment:{...}}
  | {applyNetworkPolicyAmendment:{...}} | "decline" | "cancel"
type FileChangeApprovalDecision = "accept" | "acceptForSession" | "decline" | "cancel"
```
消息顺序（文档）：`item/started`(status inProgress) → `item/*/requestApproval` → client 用 JSON-RPC response 回 `{decision}` → `serverRequest/resolved` → `item/completed`(completed|failed|declined)。
turn 状态变化（新 turn / 完成 / interrupt）会清掉挂起请求（`abort_pending_server_requests`："client request resolved because the turn state was changed"）。

注意 `item/tool/call`：**client 可以给 Codex 注册动态工具并自己执行**——这正是"让 agent 能广泛输出"的口子（发飞书卡片、发邮件、让音箱说话都可做成 client 侧工具）[推测：具体注册方式需看 `thread/start` 的 dynamic tools 参数]。

## 3. 多端：订阅 / 多输入 / 冲突（关键）

### 3.1 官方语义
- 文档："`thread/unsubscribe` removes the current connection's subscription to a thread … If this was the last subscriber, the server keeps the thread loaded until it has no subscribers and no thread activity for 30 minutes … emits `thread/status/changed` → notLoaded plus `thread/closed`."
  ⇒ **订阅是 per-connection 的；`thread/start`/`thread/resume` 即订阅**。
- `ThreadResumeParams` 注释："If thread_id identifies a running thread, app-server **rejoins** that thread"——第二个 client 对正在运行的 thread 调 `thread/resume` 就是 attach。`excludeTurns: true` + `thread/turns/list`/`thread/items/list` 分页补历史。
- 源码 `codex-rs/app-server/src/outgoing_message.rs`：
  - `ThreadScopedOutgoingMessageSender { connection_ids: Arc<Vec<ConnectionId>>, thread_id }`，`send_server_notification` → `send_server_notification_to_connections(self.connection_ids, …)`：**thread 事件广播给所有订阅连接**。
  - `send_request_to_connections`：审批类 server request **以同一个 request id 发给所有订阅连接**；回调是单个 `oneshot`，`notify_client_response` 通过 `take_connection_callback` 取走 —— **先答者赢**，之后其他端收到 `serverRequest/resolved`。例外：user-verification 类 elicitation 只发给一个 owner（"One app owns this ceremony. Reconnect and other subscribers cannot answer it."）。
  - `replay_requests_to_connection_for_thread`：**新加入的连接会被重放该 thread 仍挂起的请求**（晚到的端也能看到并处理待审批）。
- 输入并发：`turn/start` 任意订阅端可发；活跃 turn 中用 `turn/steer` 并必须带 `expectedTurnId`（不匹配即失败）；`thread/queue/*`(exp) 提供服务端排队；`userMessage.clientId` / `clientUserMessageId` 可用于标注"哪端发的"。

### 3.2 实证：botmux 已在生产使用多 client
`botmux/src/codex-rpc-engine.ts` 头注释（原文节选）：
> Runs one `codex app-server --listen ws://127.0.0.1:<port>` per session … The session's tmux pane runs the real `codex --remote ws://... resume <threadId>` TUI … User input is delivered via `turn/start` (an acked RPC) instead of a tmux paste …
> Coordination (verified — raw-WS repro + real `codex --remote` TUI): the app-server BROADCASTS a thread's turn/item events to EVERY connection that has the thread open … and the real TUI renders events for a turn another connection issued.
> … an empty thread has no rollout so the TUI can't resume it, hence the first turn persists the rollout BEFORE the TUI attaches

即：飞书消息端（engine 连接）+ 官方 TUI（另一个连接）同时挂在一个 thread 上，输入走 RPC，渲染两端同步。坑：空 thread 无 rollout，第二端无法 resume，需先跑一个 turn。
`botmux/src/core/existing-app-server.ts`：可 attach 到"already-running App Server"（Codex Desktop 的），仅允许 `unix://` 绝对路径或 `ws://127.0.0.1:<port>`，拒绝凭证/query/非回环（安全边界）。
botmux 用到的方法：`turn/start`×21、`turn/steer`×17、`thread/start/resume/read/unsubscribe/turns/list`、`item/tool/requestUserInput`、`item/permissions/requestApproval` 等（grep 统计）。
另一条路 `botmux/src/codex-app-runner.ts:341`：`spawn(codexBin, ['app-server','--listen','stdio://'])` 单连接模式。

### 3.3 multica（Go）
`multica/server/pkg/agent/codex.go:357-364`："codexBackend implements Backend by spawning `codex app-server --listen stdio://`"，每次执行一个进程，`thread/start` 或 `thread/resume`（按 issue 复用 thread），`turn/start`、`turn/steer`、`turn/interrupt`。
审批全自动（`codex.go:~2930` `handleServerRequest`）：
```go
case "item/commandExecution/requestApproval", "execCommandApproval": c.respond(id, map[string]any{"decision": "accept"})
case "item/fileChange/requestApproval", "applyPatchApproval":        c.respond(id, map[string]any{"decision": "accept"})
case "mcpServer/elicitation/request": c.respond(id, map[string]any{"action": "accept", ...})
default: c.respondError(id, -32601, "unsupported codex app-server request: ...")
```
大量运维经验注释：首 item 超时（gpt-5.5 >30s）、handshake 超时、`thread/resume` 响应过大导致 scanner overflow（MUL-5722）、进程组清理。=> app-server 很强但需要健壮的进程/超时管理。

### 3.4 openclaw
双路径：
- 原生：`openclaw/extensions/codex/src/app-server/*`（`client.ts` 支持 `transport: "stdio" | "websocket" | "unix"`，`approval-bridge.ts` 把 app-server 审批桥接到 OpenClaw 自己的审批系统/各聊天渠道，自动批准仅限具体调用 `CONCRETE_TOOL_AUTO_APPROVAL_METHODS`）、`conversation-binding.ts`、`native-session-binding-api.ts`（把聊天会话绑定到原生 Codex thread）。
- ACP：`openclaw/extensions/acpx/package.json` 依赖 `@agentclientprotocol/claude-agent-acp@0.79.0`、`@agentclientprotocol/codex-acp@1.12.0`、`acpx@0.19.1`；`src/codex-adapter.ts`：`CODEX_ACP_PACKAGE = "@agentclientprotocol/codex-acp"`，`LEGACY_CODEX_ACP_PACKAGE = "@zed-industries/codex-acp"`（包已从 zed-industries 迁到 agentclientprotocol 组织）。

### 3.5 happyclaw
未发现 codex runtime 集成（只在 plugin 命令索引里出现 "codex:status" 等插件名），只跑 Claude。

## 4. `codex exec --json` / TS SDK 事件模型（简化版）
`sdk/typescript/src/events.ts`：
```ts
type ThreadEvent = {type:"thread.started", thread_id} | {type:"turn.started"} | {type:"turn.completed", usage}
  | {type:"turn.failed", error:{message}} | {type:"item.started"|"item.updated"|"item.completed", item: ThreadItem}
  | {type:"error", message}
```
item 类型（`items.ts`）：`agent_message`、`reasoning`、`command_execution`、`file_change`、`mcp_tool_call`、`web_search`、`todo_list`、`error`。
无 token 级 delta（只有 `item.updated` 快照）、无审批往返、单进程单 turn；resume 用 `codex exec resume <id>`。线程持久化于 `~/.codex/sessions`。
=> 只适合批处理；gateway 应走 app-server。

## 5. ACP（Agent Client Protocol）对比
- 规范仓库 `agentclientprotocol/agent-client-protocol`（原 Zed 发起），`schema/v1/meta.json`：
  - agentMethods：`initialize` `authenticate` `session/new` `session/load` `session/resume` `session/list` `session/delete` `session/close` `session/prompt` `session/cancel` `session/set_mode` `session/set_config_option` `logout`
  - clientMethods：`session/request_permission` `session/update` `fs/read_text_file` `fs/write_text_file` `terminal/create|output|release|wait_for_exit|kill` `elicitation/create|complete`
  - `SessionUpdate.sessionUpdate` 变体：`user_message_chunk` `agent_message_chunk` `agent_thought_chunk` `tool_call` `tool_call_update` `plan` `available_commands_update` `current_mode_update` `config_option_update` `session_info_update` `usage_update`
  - `PermissionOptionKind`：`allow_once` `allow_always` `reject_once` `reject_always`
- 拓扑差异：ACP 是 **"编辑器(client) ↔ agent 子进程" 一对一 stdio** 设计，client 还要提供 fs/terminal 能力；规范里**没有**多 client 订阅同一 session 的语义 **[基于 meta.json 方法表 + overview 页未提及；属推断]**。Codex app-server 是 **服务端、多连接、广播 + 先答者赢**。
- Adapter：
  - `@agentclientprotocol/codex-acp`：stdio ACP server，内部启动 Codex App Server 并做双向翻译；支持审批、终端输出、reasoning、plan、MCP、subagent 会话等（README）。
  - `@agentclientprotocol/claude-agent-acp`：基于 Claude Agent SDK 实现 ACP agent（tool call+permission、TODO、子 agent transcript、终端、slash commands、client MCP）。
  - 两者都有 JetBrains "AIR" 扩展（`_meta.jetbrains.air.*`），说明 ACP 本体能力不够，各家在 `_meta` 上扩。
- 结论：ACP 适合作为 agents-io 的 **"统一 runtime 适配层"候选**（Claude/Codex/Gemini 等都有 adapter，一套 `session/update` 事件），代价是有损（丢 Codex 的 turn diff、queue、realtime、多连接、`expectedTurnId` 等）且多一跳进程。
  更合理 **[推测/建议]**：自定义内部事件模型以 app-server 的 Thread/Turn/Item 为骨架（它是目前最完整的），Codex 直连 app-server；Claude 走 Agent SDK / stream-json 映射到同一模型；ACP 作为"第三方 agent 兜底"适配器。

## 6. 对用户问题的回答（Codex 视角）
1. **统一协议 vs 各自处理？** Runtime 侧：Codex app-server 已是完整协议，直接用，不必自建 runtime 协议；但 Claude Code 协议不同，gateway 内部仍需一个统一事件模型（建议对齐 Thread/Turn/Item + delta + serverRequest）。Channel 侧：统一。
2. **最广输入**：`UserInput` 支持 text/image/audio/localAudio/skill/mention；`thread/inject_items` 注入上下文不起 turn；`thread/realtime/*`(exp) 直接把语音会话挂到 thread（transport websocket/webrtc/existingCall，`appendAudio/appendText/appendSpeech`）——小米音箱 / 飞书会议可考虑。
3. **最广输出**：订阅 thread 事件流；按端 `optOutNotificationMethods` 裁剪；`item/tool/call` 让 client 提供输出型工具；`outputSchema` 约束最终消息结构化；`agentMessage.phase` 区分 commentary / final_answer（IM 端只推 final，看板端全推）。
4. **输出 = 订阅？** 是，官方语义就是 per-connection subscription + 广播；断线重连用 `thread/resume`(rejoin) + `thread/turns/list`/`items/list` 补历史 + 挂起请求重放。注意：app-server 本身**不提供事件 offset / 断点续传**，补漏只能靠读 thread 历史 **[推测：未见 seq/cursor 字段于通知]**，gateway 若要可靠多端扇出，应自己加事件序号/持久化。
5. **多端输入？** 是：任意订阅连接 `turn/start`；活跃期 `turn/steer` + `expectedTurnId` 防竞态；或 `thread/queue/*`。审批多端同时弹出，先答者赢，其余端收 `serverRequest/resolved` 撤卡片。
6. **中间过程**：item 生命周期 + 各类 delta（命令输出、patch、reasoning 摘要、plan、MCP progress、turn diff）全都有；适合飞书卡片"流式更新"。

## 7. 风险与坑
- app-server 和 `--listen` 仍标 `[experimental]`（`codex app-server --help`），方法/字段迭代极快（0.14x→0.160 期间多次改名，multica 仍兼容 v1 `execCommandApproval`）。务必用 `generate-ts`/`generate-json-schema` 锁版本，并做版本断言（openclaw `assertSupportedCodexAppServerVersion`）。
- 非回环 WS 默认无鉴权；必须 `--ws-auth`。
- 空 thread 无 rollout，第二个 client 无法 resume（botmux 实测）。
- 无订阅 30 分钟后 thread 卸载（`thread/closed`）。
- 首 token / 首 item 可能 >30s、resume 大历史响应过大（multica 注释）——需要分页（`excludeTurns`）和宽松超时。
- 审批广播意味着每个订阅端都要能"撤回"审批 UI；只读端（如邮件）应 `optOut` 或忽略 server request。
