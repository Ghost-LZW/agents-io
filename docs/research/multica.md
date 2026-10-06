# multica (multica-ai/multica) 调研笔记 — agent IO 视角

> 源码：`scratchpad/repos/multica`。下文路径都相对仓库根目录。只记代码和文档里能看到的东西，推测的地方会标【推测】。

## 0. 一句话

Multica 是一个"人 + agent 协作的 issue 平台"：**Go server（Postgres + Redis）+ 用户机器上的 Go daemon + 直接 spawn 本地 Claude Code / Codex / 20 多种 CLI**。
输入端统一成 **Task（agent_task_queue 一行）**，来源包括 issue 指派、评论 @、web chat、IM 频道（飞书、Slack、钉钉、企微、Telegram）、autopilot（定时/webhook）。
输出端统一成 **TaskMessage 事件流**（text / thinking / tool_use / tool_result / error，带 seq），先在 server 落库，再通过进程内事件总线 fan-out 给 WebSocket 前端和各 IM outbound 订阅者。

---

## 1. 拓扑与传输

```
[IM 平台] --adapter(Channel)--> server engine.Router --> chat_session/chat_message --> agent_task_queue
[Web/Desktop/Mobile] --HTTP--> server handler -----------------------------------------> agent_task_queue
                                                                                             |
server --WS hint "daemon:task_available"(无内容)--> daemon --HTTP/WS-RPC claim--> Task(胖 payload)
daemon --spawn--> claude -p --input-format stream-json --output-format stream-json ...
                  codex app-server --listen stdio://   (JSON-RPC)
                  xxx acp (ACP JSON-RPC)
daemon --HTTP POST /api/daemon/tasks/{id}/messages (500ms 批)--> server 落库 task_message
server events.Bus.Publish(task:message) --> realtime.Hub(WS) --> 浏览器/桌面/移动端
                                         \-> telegram.Outbound / lark.Patcher / slack.Outbound ... (bus.Subscribe)
daemon --HTTP complete/fail--> server --> chat:done / task:completed --> 各订阅者
```

- server↔daemon：**WS 只发提示（hint），不带数据**；真正的数据走 HTTP，或者走 WS 上的通用 RPC 信封。见 `server/pkg/protocol/messages.go`：
  ```go
  // TaskAvailablePayload carries content-free task and supplement wakeup hints.
  type TaskAvailablePayload struct { RuntimeID string; TaskID string `json:",omitempty"` }
  type RPCRequestPayload  // daemon→server，带 RequestID / Method（如 "tasks.claim"）/ Body
  ```
  `CLI_AND_DAEMON.md`「How It Works」原文：wake signal 推过来以后批量 claim；30s 轮询作兜底，15s 一次心跳。
  `server/internal/daemon/wsrpc.go`：WS-RPC 失败就回退到 HTTP。如果是 "uncertain"（帧已经发出但连接断了），**不回退**，避免同一个任务被 claim 两次。
- WS 外层信封：`protocol.Message{Type string; Payload json.RawMessage}`，所有 WS 帧都套这一层。

## 2. Runtime 适配：怎么驱动 Claude Code / Codex

统一接口在 `server/pkg/agent/agent.go`，注释里写着 "mirrors the happy-cli AgentBackend pattern"：

```go
type Backend interface {
    Execute(ctx context.Context, prompt string, opts ExecOptions) (*Session, error)
}
type Session struct {
    Supplement      func(context.Context, string) error // 运行中注入人类追加指令
    SupplementReady func() bool
    ToolActivity    func() (int32, time.Time)
    InterruptBackgroundTools func() bool
    TerminalObserved func() bool
    Messages <-chan Message   // 过程事件流
    Result   <-chan Result    // 恰好一个终态
}
type Message struct {
    Type MessageType // text|thinking|tool-use|tool-result|status|error|log
    Content, Tool, CallID string; Input map[string]any; Output, Status, Level, SessionID string
}
type Result struct { Status, Output, Error string; DurationMs int64; SessionID string; Usage map[string]TokenUsage; ResumeRejected bool; ... }
```

各 runtime 的具体驱动方式：

- **Claude Code**（`server/pkg/agent/claude.go`，`buildClaudeArgs`）：
  `-p --output-format stream-json --input-format stream-json --verbose --permission-mode bypassPermissions --disallowedTools AskUserQuestion [--resume <sid>] [--mcp-config ...] [--settings ...]`
  - stdin 一直开着，因为 stream-json 会在运行中发 `control_request`，需要回 `control_response`。
  - **运行中注入**（`claude_supplement.go`）：启动时发 `control_request{subtype:"initialize", hooks:{UserPromptSubmit,PreToolUse,PostToolUse,PostToolUseFailure,Stop}}`，注册 SDK hook 回调。有追加输入时，在 hook 边界通过 `additionalContext` 注入；Stop hook 有 pending 的话就让同一轮继续跑。注释里的说法："No supplement is ever a new user prompt"。
  - 没用 `--include-partial-messages`（grep 不到），所以 Claude 的 text 是按 assistant 消息块到达的，不是 token 级流【据 grep 推断】。
  - 审批：全部 bypass。AskUserQuestion 被禁用，理由是 "no UI for the prompt"（GH #2588）；让 agent 改用 issue 评论来澄清问题。
- **Codex**（`codex.go`）：`codex app-server --listen stdio://`，JSON-RPC 调用 `initialize → thread/start | thread/resume → turn/start`，通知走 `item/*`、`turn/started`、`turn/completed`，text 增量走 `item/agentMessage/delta`。
  - 运行中注入：`turn/steer {threadId, expectedTurnId, input:[{type:text}]}`（`supplementCodexTurn`）。
  - 取消：`turn/interrupt`，超时预算 2s。
  - 审批：`handleServerRequest` 里**全部自动同意**：
    ```go
    case "item/commandExecution/requestApproval", "execCommandApproval": c.respond(id, map[string]any{"decision": "accept"})
    case "item/fileChange/requestApproval", "applyPatchApproval": ...accept
    case "item/permissions/requestApproval": 只回 network/fileSystem，scope:"turn"
    case "mcpServer/elicitation/request": accept
    ```
- **ACP 系**（kiro、qoder、trae、grok、qwenpaw、mcode、dim 等）：`acp_session.go` 等，`session/new|resume|load|prompt`。
- 运行中注入能力按版本做门控，见 `pkg/agent/version.go: SupportsTaskSupplement`：codex >= 0.100.0、claude >= 2.1.110、grok >= 1.0.14，其余 runtime 不支持。
- 系统提示走文件：每个任务在 workdir 里写 CLAUDE.md / AGENTS.md / CODEBUDDY.md / QWEN.md（`ExecOptions.SystemPrompt` 注释）。每轮变化的上下文放进 per-turn 的 user message，这样能保住 prompt cache（`daemon/prompt.go: perTurnContextBlocks`，MUL-5377）。
- 会话续接：`Task.PriorSessionID` 加上 `--resume` 或 `thread/resume`。daemon 在拿到 `MessageStatus.SessionID` 时立即 `PinTaskSession`，防止 daemon 崩溃后丢掉 resume 指针。

**评价**：没有自己写 agent loop。用的是各 CLI 的"机器协议"（stream-json、app-server JSON-RPC、ACP），在 Go 里归一成 `agent.Message`。代价是每个 runtime 一份适配代码（claude.go 1600 行，codex.go 4300 行），watchdog、超时、resume 拒绝判定之类的边角也很多。

## 3. 输入：什么能成为 agent 的输入

输入**没有统一的消息协议**。统一的是"任务"这个载体：`daemon/types.go: Task` 是一个**胖 payload**，按来源平铺字段：

- issue 类：`IssueID`、`TriggerCommentID/Content/AuthorName`、`CoalescedComments`（排队期间新来的评论会并进同一次 run，MUL-4195）、`NewCommentCount`、`IssueChangedFields`、`HandoffNote`……
- chat 类：`ChatSessionID`、`ChatMessage`、`ChatMessageAttachments`、`ChatChannelType`（slack/feishu/…）、`ChatType`（group|p2p）、`ChatInThread`、`ChatChannelDeliversFiles`
- autopilot 类：`AutopilotRunID`、`AutopilotSource`（manual|schedule|webhook|api）、`AutopilotTriggerPayload json.RawMessage`
- quick-create、wakeup（`WakeupSystemRule`，比如 child_done）、squad leader……
- 身份：`InitiatorType/ID/Name`、`AuthToken`（server 在 claim 时签发的 task 级 token，作为 `MULTICA_TOKEN` 注入给 agent）

daemon 的 `prompt.go` 按来源**拼不同的 prompt**。很多上下文不往 prompt 里塞，而是教 agent 用 CLI 自己去拉，例如：
`multica issue get <id>`、`multica issue comment list <id> --roots-only --summary`、`multica chat history`、`multica chat thread`、`multica attachment download <id>`。
也就是说，**输入是"指针 + 少量摘要"，agent 按需通过工具拉全量**。

### 3.1 IM 频道：唯一真正做了统一协议的地方

`server/internal/integrations/channel/`（doc.go 里写的是 MUL-3506/3515 设计）：

```go
type Channel interface {
    Type() Type
    Connect(ctx context.Context) error   // 阻塞跑收消息循环，自己调 Config.Handler
    Disconnect(ctx context.Context) error
    Send(ctx context.Context, out OutboundMessage) (SendResult, error)
    Capabilities() Capability             // 只声明，不做降级
}
type Factory func(cfg Config) (Channel, error)        // Config{Type, Raw json.RawMessage, ID, Handler}
type InboundHandler func(ctx context.Context, msg InboundMessage) error
type Registry // Type→Factory，last-writer-wins，可以覆盖内置实现
```

`InboundMessage`（`channel/message.go`）只放各平台共有的字段：
`EventID, MessageID, Source{ChannelType, ChatID, ChatType, SenderID, SenderStableID, ThreadID}, Type(text|image|file|audio|video|unknown), Text, CommandText, MediaRefs[], ReplyTo{MessageID, RootID}, AddressedToBot, ForceFresh, SkipAgentRun, Raw json.RawMessage`。
平台特有的东西都塞在 `Raw`，**core 从不读 Raw**。

`OutboundMessage` 刻意做得很小：`{ChatID, Text, ThreadID, ReplyTo}`。注释原文："Rich cards, media uploads, and outbound webhooks are deliberately NOT modeled here — an adapter that supports richer output exposes it on its own type"。

Capability 是位掩码：`CapText | CapRichCard | CapThreadReply | CapQuoteReply | CapAttachment | CapVoice | CapTypingIndicator | CapMessageEdit`。

`channel/engine/`：
- Supervisor：遍历所有 installation，用 Redis lease CAS 保证每个 installation 只有一个副本连接，断线指数退避重连，凭据轮换时重启。
- Router：所有平台共用一条入站流水线：
  `installation route → 两阶段 dedup(Claim/Mark/Release) → 群聊 @bot 过滤 → 身份绑定+成员校验 → ensure session → append+mark → /issue → 防抖 batcher → EnqueueChannelChatTask`
- 每个平台注册一个 `ResolverSet{Installation, Identity, Dedup, Session, Media, Audit, Replier, Typing, OriginType}`（`engine/resolvers.go`）。
- 媒体：adapter 不直接放字节，`MediaResolver` 先下载、上传到对象存储，再挂成 `MediaRef`。上传前先写意图账本（`MediaIntentLedger`），由对账器回收失败的上传。
- 控制命令：`/new`、`/clear`（ForceFresh）、`/issue`，在 `engine/fresh_command.go`、`issue_command.go` 里统一解析。

**新增一个私有频道** = 实现 `Channel` + 注册 `Factory` + 提供一套 `ResolverSet` + 写一个订阅 bus 的 outbound。按 doc.go 的说法，"never edit the engine"。实际看，飞书、Slack、企微、Telegram 每个都还有一大坨自己的 outbound、typing 和 media 代码。

## 4. 输出：过程事件如何流出去

1. 在 daemon 里，`daemon.go`（约 9440–9690 行）做 drain 循环：
   - text/thinking 相邻同类型的片段先拼起来（`appendPending`），tool_use、tool_result、error 各自独立成一条；每条分配单调递增的 `seq`。
   - tool_use 的 input 在 **daemon 侧先脱敏**（`redact.InputMap`），tool_result 截断成预览（`toolOutputPreview`，带三态 `OutputTruncated`）。
   - 每 500ms 批量 POST 一次 `/api/daemon/tasks/{id}/messages`；**第一条可见事件立即 flush**（`flushFirstVisible`），降低首字延迟。
   - 结构：
     ```go
     type TaskMessageData struct { CallID string; Seq int; Type string; Tool, Content string; Input map[string]any; Output string; CreatedAt time.Time; OutputTruncated *bool }
     ```
2. 在 server 里，`handler/daemon.go`（约 5150–5235 行）：再脱敏一次，做 Postgres 清洗，批量写入 `task_message` 表，然后按 seq 顺序逐条 `publishTask(protocol.EventTaskMessage, ...)`，payload 是 `protocol.TaskMessagePayload{CallID, TaskID, IssueID, Seq, Type, Tool, Content, Input, Output, OutputTruncated, CreatedAt}`。
3. 事件总线：`internal/events/bus.go`，进程内、同步执行，支持 `Subscribe(type)` 和 `SubscribeAll`。
   ```go
   type Event struct { Type, WorkspaceID, ActorType, ActorID string; Payload any; TaskID, ChatSessionID string }
   ```
4. WS fan-out：`cmd/server/listeners.go: registerListeners` 用 `SubscribeAll` 把事件转成 `{type,payload,actor_id,actor_type}`，再 `BroadcastToWorkspace`。有 `internalOnlyPayloadKeys` 表，出站前剥掉内部字段。
   - **按 task/chat 订阅的作用域已经实现，但还没启用**：Hub 支持 `subscribe/unsubscribe` 帧和 `ScopeTask/ScopeChat` 的 `ScopeAuthorizer`，Redis Streams relay 也已上线。但注释写着客户端还没发 subscribe 帧、重连后也不会重放订阅，所以 task 和 chat 事件目前**仍然广播给整个 workspace**（MUL-1138 Phase 1）。前端的 SECURITY 注释也提到这一点：chat 的 `task:*` 是 workspace fanout，payload 里不带可见性信息，所以不能乐观地写聚合缓存。
   - 多副本：`realtime/redis_relay.go`、`sharded_stream_relay.go`，Redis Stream key 是 `ws:scope:{type}:{id}:stream`，用 XADD/XREADGROUP，副本重启后会重放一个 grace 窗口，并按 ULID 去重。
5. 前端：`packages/core/realtime/use-realtime-sync.ts`
   - `ws.on("task:message")`：只处理当前持有 timeline 缓存的 task（`isTaskMessageTimelineHeld`），第一条立即渲染，之后按 100ms 窗口合批（`TASK_MESSAGE_FLUSH_MS`）。
   - 初始数据 = REST 快照，再和 WS 增量**按 seq 合并、去重**：`packages/core/chat/queries.ts: mergeTaskMessagesBySeq` 和权威覆盖版本的合并函数。
   - 渲染：`packages/views/common/task-transcript/`（build-timeline.ts、run-timeline.tsx、trace-event-presenter.ts），`TimelineItem{seq,type,tool,callId,content,input,output,output_truncated}`，相邻 text/thinking 再合并一次。
   - 其他 `task:*` 生命周期事件只用来让 React Query 缓存失效（invalidate），不直接写入。
6. IM outbound 各自订阅 bus，订阅粒度差别很大：
   - Telegram（`integrations/telegram/outbound.go`）：订阅 `EventTaskMessage`，先发一条占位消息，再节流地 `editMessageText`，最后在 `EventChatDone` 时做最终编辑。这是唯一把过程"流"到 IM 里的实现。
   - 飞书（`lark/outbound.go`）：卡片状态机 `CardKind{thinking, running, final, error}`，订阅 `TaskFailed/ChatDone/TaskCancelled`。Renderer 可以替换。**不展示工具调用细节**。
   - Slack、钉钉、企微：基本只订阅 `ChatDone` 和 failed/cancelled，再加一个 typing indicator。
   - 回到哪个频道由 `channel_task_delivery` 表决定（migration 420）：每个 task 记录 `binding_id, installation_id, channel_type, channel_chat_id, channel_thread_id, route_revision`，也就是**输出锚定到触发它的那个外部会话**。
   - 注释写明："Channel outbounds (Slack/Lark) deliberately do not subscribe to [chat:cancel_finalized] — cancellation stays silent on external channels"。
7. 还有第二条输出路径：**agent 用工具直接写平台**。prompt 让 agent 自己执行 `multica issue comment add <id> --parent <comment> --content-file ./reply.md`，凭据是 task 级的 MULTICA_TOKEN。issue 场景下，"最终回答"其实就是 agent 自己发的一条评论。chat 场景下最终回答是 `Result.Output`，对应 `chat:done.content`。

## 5. 多端：订阅与多端输入

- **输出多端展示**：是。一次 run 的过程事件 = `task_message` 表（持久）+ `task:message` 事件（实时），任意多个端都可以看：Web、Desktop（Electron，`apps/desktop`）、Mobile（Expo，`apps/mobile/data/queries/chat.ts`）、IM。现在的语义是"workspace 内所有在线连接都会收到"，前端自己过滤；per-task scope 订阅的基础设施已经在了，还没切换。
- **多端输入到同一会话**：
  - issue：多人评论都能触发；排队期间的多条评论会合并进同一次 run（`CoalescedComments`）。**运行中**新增的评论会成为 `task_supplement`，daemon 的 `runTaskSupplementLoop` 先 claim，再调 `Session.Supplement` 注入（Codex 用 turn/steer，Claude 用 hook additionalContext），最后 ack，ack 结果会以评论回执的形式广播（`publishCommentSupplementUpdate`）。注入的文本是固定模板 `[ADDITIONAL GUIDANCE] Human X added guidance while you were working ... Treat this as additional guidance for the same active task, not as a replacement`。
  - chat：一个外部会话（ChatID / thread）绑定一个 `chat_session`（`channel_chat_session_binding`，带 `route_revision`、`/new` 换代）。Web chat 是创建者私有的。`ChatSessionCreatedPayload.ChannelSource{ChannelType, InstallationID, RouteRevision}` + `IsCurrentChannelRoute` 说明一个 chat_session 同一时刻只有一个"当前频道路由"。我没看到"飞书和 Web 同时往同一个 chat_session 输入"的设计。【推测】Web 端能看到 IM 发起的 chat，但不一定能在里面续写。
  - 冲突处理：server 端串行（队列 + dedup + 防抖 batcher）。chat 场景运行中的追加消息走防抖，进入下一轮，不做中途注入（supplement 只对 `task.IssueID != ""` 生效，见 `daemon.go:8397`）。
- 取消：UI 的 stop 按钮。Codex 走 `turn/interrupt`，Claude 关 stdin 后发 SIGTERM，再升级到 SIGKILL 杀进程组。取消之后有 `chat:cancel_finalized`：转录为空就把草稿还给用户，否则补一条 "Stopped."。

## 6. 身份 / 权限 / 审批

- daemon 用用户登录 token。每个任务由 server 签发 task 级 `AuthToken`，作为 MULTICA_TOKEN 注入；agent 拿不到 daemon 自己的凭据（MUL-3292）。
- IM 身份：首次发消息先绑定账号（发一个 binding link），之后每条消息都重新校验绑定和 workspace 成员资格（`IdentityResolver`），并检查 `MemberMayInvokeAgent`。
- 审批：**完全没有人在回路里**。Claude 用 bypassPermissions，Codex 的所有 requestApproval 自动接受。这是产品定位决定的："agent 是队友，在隔离 workdir 里干活"。
- 脱敏：daemon 和 server 各做一遍（`pkg/redact`）。
- WS 认证：JWT 或 PAT，校验 Origin 白名单，按成员关系授权 scope。

## 7. 插件（不是频道扩展点）

`packages/plugin-sdk`、`server/pkg/plugincontract`：iframe surface（issue_panel/modal），hook 触发方式有 UI / manual / event / agent（作为 MCP 工具暴露给 agent）/ schedule，传输方式有 http 和 mcp。可订阅的事件词表见 `pkg/eventcontract/events.go`（`issue.* / comment.* / task.queued|started|completed|failed|cancelled ...`）。**这里没有 task.message 级别的过程事件**，插件拿不到流式过程。

## 8. 对我们的启示

1. **runtime 层用"统一事件 + 每个 CLI 一个适配器"**：`agent.Message` 就七种类型（text/thinking/tool-use/tool-result/status/error/log），外加 `Result` 和 `Supplement` 注入口，已经覆盖 20 多个 CLI。这个形状值得照抄，注意 CallID 用来配对、seq 由 daemon 分配。
2. **IM 层用"窄的统一 envelope + Raw + Capability 位掩码 + Registry"**：core 只认共有字段，富输出交给 adapter 自己处理。私有频道照这个形状接入就行。
3. **输出 = 持久化事件日志 + 实时广播 + 客户端按 seq 合并**：这正是"订阅某个 agent session 的输出"。Multica 已经设计了 per-task/per-chat scope 和 Redis Stream 重放，只是还没打开。
4. **输出回路锚定**：`channel_task_delivery` 记录这次 run 应该回到哪个外部会话；其他端只是旁观。
5. **运行中多端输入**：用 Codex `turn/steer` 和 Claude SDK hook 的 `additionalContext` 做"追加指导，不替换目标"，并带 claim/ack 回执。这在 Claude/Codex 上是可行的，有现成的版本门槛可参考。
6. 不足：IM 端的过程可见性很弱，只有 Telegram 有流式；审批没有任何路径能到 IM 或 UI；Task payload 是按来源平铺字段的胖结构，每加一种来源都要改 Task、prompt 和 server。
