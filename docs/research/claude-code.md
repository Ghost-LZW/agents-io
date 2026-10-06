# Claude Code 官方嵌入面调研（2026-10，CLI 2.1.291 / Agent SDK 0.3.291）

来源：
- 官方文档 code.claude.com/docs/en/{headless, channels, channels-reference, remote-control, cross-session-messaging, hooks, agent-view, agent-sdk/typescript}（2026-10-06 抓取）
- `npm pack @anthropic-ai/claude-agent-sdk@0.3.291` 后读到的 `sdk.d.ts` / `bridge.d.ts` / `browser-sdk.d.ts`（下文 “sdk.d.ts:行号” 指这个版本）
- 本地参考仓库（scratchpad/repos）：multica、openclaw、happyclaw、botmux 是怎么调用 claude 的

标注：**[事实]** 来自文档或代码；**[推测]** 是我的推断。

---

## 0. 结论先行

1. Claude Code 本身已经有一套**统一的、带类型的事件协议**：`SDKMessage`（stdout 上的 NDJSON）+ `control_request/control_response`（双向 RPC，审批、中断、改模型这些都走它）。`claude -p --input-format stream-json --output-format stream-json` 和 Agent SDK 的 `query()` 用的是**同一套线协议**，SDK 只是把 CLI 子进程包了一层（multica 的 Go 代码注释里直接管它叫 “Claude SDK JSON types”，claude.go:645）。
2. 官方往 session 里“注入输入”有 5 个入口：stdin 的 `SDKUserMessage`（带 `priority` / `origin` / `shouldQuery`）、**Channels**（MCP 通知 `notifications/claude/channel`）、**cross-session messaging**（每个 session 一个 inbox unix socket）、**Remote Control**（claude.ai/手机经 Anthropic 中继进来）、**hooks** 的 `additionalContext`。其中 `SDKMessageOrigin` 已经把来源分成 `human | channel | peer` 几类（sdk.d.ts:5341）。可见官方自己在 session 层把**输入当成多源汇聚**来处理。
3. 多端输出：官方 Remote Control 已经做到“一个本地 session，终端、网页、手机同步看，任何一端都能输入”（文档原话：*send messages from your terminal, browser, and phone interchangeably*）。审批 prompt 会**同时发到多个端，先到的答案生效**（Channels 的 permission relay 也是这个规则）。底层 transport 是 SSE + `sequence_num` 续传（bridge.d.ts 的 `initialSequenceNum`、`outboundOnly` mirror 模式）。不过它绑定 claude.ai 订阅，也不对第三方开放，我们没法直接拿来当总线。
4. 给 agents-io 的建议 **[推测]**：网关内部维护一个**很薄的统一事件信封**（session_id、seq、origin、kind、payload），把 Claude 的 `SDKMessage` **原样**放进 payload，同时投影出一层“通用视图事件”（text_delta / tool_start / tool_end / approval_request / result），给飞书卡片、语音这类端用。输出用“订阅 session 事件流 + seq 续传”的形态；输入用“多源写入 session 队列 + origin 标注 + priority”的形态；审批用“广播到所有可审批端，first-wins，按 request_id 关闭其他端”。这套形态直接对应 Claude 自家 Remote Control 的设计，不是凭空发明的。

---

## 1. Headless：`claude -p` + stream-json（最底层、最通用）

### 输入
- `-p "<prompt>"` 或 stdin 管道（文本，上限 10MB）。
- `--input-format stream-json`：stdin 每行一个 JSON。用户消息的格式是 `SDKUserMessage`（sdk.d.ts:6230）：

```ts
type SDKUserMessage = {
  type: 'user';
  message: MessageParam;            // Anthropic Messages API user message，可含 image/document block
  parent_tool_use_id: string | null;
  priority?: 'now' | 'next' | 'later';
  origin?: SDKMessageOrigin;        // human | channel{server} | peer{from,fromMode,name,fromSession}
  shouldQuery?: boolean;            // false = 只追加进 transcript，不触发 turn
  client_composed?: true;           // 不做 @path 展开 / slash 命令派发
  timestamp?: string; uuid?: UUID; tool_use_result?: unknown; isSynthetic?: boolean;
}
```

  `priority` 的语义（官方 TS 参考）：`next`（默认）是工具跑完后在同一个 turn 内读到；`later` 是开一个新 turn；`now` 是把当前工作挪到后台、立刻读（需要 v2.1.286+）。**这就是官方给出的“运行中插话”语义**，直接适合多端输入。
- stdin 上还能发 `control_request`，比如 `initialize`（注册 hooks callback id、SDK MCP server）、`interrupt`、`set_permission_mode`、`set_model`、`stop_task`、`mcp_set_servers`、`rewind_files` 等，全集见 `SDKControlRequestInner`（sdk.d.ts:4994），大约 40 种。

### 输出（stdout NDJSON，`--verbose` 必加）
`SDKMessage` 联合类型（sdk.d.ts:5336），常用的有：
- `system/init`：model、tools、mcp_servers、plugins、`capabilities[]`（用来做特性探测，比如 `interrupt_receipt_v1`）。
- `assistant` / `user`：完整消息，包括 tool_use、tool_result、thinking block。子代理的消息带 `parent_tool_use_id`。`--forward-subagent-text` 打开后还会转发子代理的 text 和 thinking。
- `stream_event`（`--include-partial-messages`）：原样透传 Anthropic 流式事件：

```ts
type SDKPartialAssistantMessage = { type: 'stream_event'; event: BetaRawMessageStreamEvent;
  parent_tool_use_id: string|null; uuid; session_id; ttft_ms?; user_message_uuid?; user_message_uuids?; resume_reason? }
```
  `user_message_uuid(s)` 用来把回复流绑回“是哪一次 send 引起的”。多端输入时，靠它判断该回给哪一端。
- `tool_progress`（tool_use_id、elapsed_time_seconds、heartbeat）、`system/task_started|task_progress|task_updated|task_notification`（后台任务、workflow）、`system/hook_started|hook_progress|hook_response`、`system/api_retry`、`system/compact_boundary`、`system/status`（compacting/requesting）、`system/session_state_changed`（`idle|running|requires_action`，sdk.d.ts:5867）、`permission_denied`、`rate_limit_event`、`prompt_suggestion`、`memory_recall`……
- `result`：最终文本、`total_cost_usd`、usage、`permission_denials`、`terminal_reason`、`structured_output`（配合 `--json-schema`）。
- `control_request`（CLI 发给宿主）：最重要的是 `subtype: 'can_use_tool'`（sdk.d.ts:4787），字段有 tool_name、input、permission_suggestions、decision_reason、blocked_path。宿主回 `{"type":"control_response","response":{"subtype":"success","request_id":..,"response":{"behavior":"allow","updatedInput":{..}}}}`。CLI 还可能发 `control_cancel_request` 撤销这条请求。

### 其他相关 flag
`--resume <id|jsonl路径>`、`--continue`、`--session-id`、`--fork-session`、`--resume-session-at`（隐藏 flag，openclaw 有用到）、`--replay-user-messages`（把 stdin 的 user 消息回显到 stdout，方便多端同步看到“谁说了什么”）、`--permission-prompt-tool <mcp tool>`、`--permission-prompts none`（v2.1.259+，无人值守时直接拒绝）、`--bare`（不加载宿主环境，官方说以后会变成 -p 的默认）、`--mcp-config`、`--strict-mcp-config`、`--json-schema`。

### 多客户端
一个进程只有一对 stdin/stdout，是**单宿主**的。多端得由宿主（也就是我们的网关）自己做 fan-out。

### 本地仓库怎么用（证据）
- **multica** `server/pkg/agent/claude.go:1078` `buildClaudeArgs`：`-p --output-format stream-json --input-format stream-json --verbose --permission-mode bypassPermissions --disallowedTools AskUserQuestion [--resume id]`。注释说 stdin 必须一直开着，因为 *“Claude's stream-json protocol can emit control_request events mid-run and expects matching control_response frames”*（claude.go:164）。`handleControlRequest` 一律回 allow（claude.go:578）。`claude_supplement.go` 是一个很巧的做法：用 `initialize` 注册 `UserPromptSubmit/PreToolUse/PostToolUse/Stop` 的 hook callback，在 turn 的边界用 `additionalContext` 塞进**运行中补充输入**。Stop hook 有待处理输入时会让 loop 继续（注释：*“Claude has no conditional, current-turn-only user input request. SDK hooks instead insert context while the provider is waiting at a turn boundary.”*）。注：这是 `priority` 字段普及之前的绕法 **[推测]**。
- **openclaw** `extensions/anthropic/cli-backend.ts:38`：`-p --output-format stream-json --include-partial-messages --verbose --setting-sources user --allowedTools mcp__openclaw__*`。`cli-transport.ts` 实现了完整的控制通道，处理 `control_request`、`control_cancel_request`（用 AbortController 撤掉审批），还有一行注释 *“Redelivered in-flight requests must not open a second operator approval.”*（cli-transport.ts:205）。审批会真正转给 operator，不是一律放行。
- **happyclaw** `container/agent-runner/src/index.ts:2755-2830`：用的是 TS Agent SDK `query({prompt: stream /*AsyncIterable*/, options})`，选项包括 `includePartialMessages: true`、`forwardSubagentText: true`、`agentProgressSummaries: true`、`resume`、`resumeSessionAt`、`hooks: {PreToolUse, PreCompact}`、`mcpServers: {happyclaw: createSdkMcpServer(...)}`。另外维护了一套自己的 `StreamEventType`（`container/agent-runner/src/stream-event.types.ts`，有 text_delta、thinking_delta、tool_use_start/end、tool_progress、hook_*、task_*、permission_denied、todo_update、usage、status……），注释说它是 *“single source of truth”*，会被复制到 runner、server、web 三处。这就是“宿主自己做一层统一投影事件”的实例。
- **botmux** 不走结构化协议，用 PTY/tmux 托管交互式 CLI（docs-site/docs/zh/architecture.md:51）。只有 `docs/constrained-invocations.md:43` 的一次性推理用了 `--print --input-format stream-json --output-format stream-json`。

---

## 2. Claude Agent SDK（TS / Python）

- `query({prompt: string | AsyncIterable<SDKUserMessage>, options})` 返回 `Query extends AsyncGenerator<SDKMessage>`。prompt 传 AsyncIterable 就是 streaming input 模式，可以持续往里推消息（happyclaw 就是这样把 IPC 消息塞进运行中的 query）。
- `Query` 的控制方法有 `interrupt()`、`setPermissionMode()`、`setModel()`、`applyFlagSettings()`、`streamInput()`、`stopTask()`、`mcpServerStatus()`、`setMcpServers()`、`getContextUsage()`、`rewindFiles()`、`supportedCommands/Models/Agents()`、`close()`。它们和 stdin 上的 control_request 一一对应。
- 审批回调：

```ts
type CanUseTool = (toolName: string, input: Record<string, unknown>, options: {
  signal: AbortSignal; suggestions?: PermissionUpdate[]; blockedPath?: string;
  decisionReason?: string; toolUseID: string; agentID?: string; requestId: string; ...
}) => Promise<PermissionResult | null>;
type PermissionResult =
  | { behavior: 'allow'; updatedInput?; updatedPermissions?: PermissionUpdate[] }
  | { behavior: 'deny'; message: string; interrupt?: boolean };
```
  `signal` 在 CLI 发 control_cancel_request 时会 abort（比如别的端已经答复，或者 turn 被中断）。这正好用来实现“多端审批、先到先得、其余端撤卡”。
- 还有 `onElicitation`、`OnUserDialog`（AskUserQuestion 这类对话框也能交给宿主渲染），这是 browser-sdk.d.ts 导出的类型。
- `options.hooks`：进程内 JS/Python 回调，事件全集是 `HOOK_EVENTS`（sdk.d.ts:959，33 个）：PreToolUse、PostToolUse、PostToolUseFailure、PostToolBatch、Notification、UserPromptSubmit、UserPromptExpansion、SessionStart、SessionEnd、Stop、StopFailure、SubagentStart、SubagentStop、PreCompact、PostCompact、PreModelSwitch、PostModelSwitch、PermissionRequest、PermissionDenied、Setup、TeammateIdle、TaskCreated、TaskCompleted、Elicitation、ElicitationResult、ConfigChange、WorktreeCreate、WorktreeRemove、InstructionsLoaded、CwdChanged、FileChanged、DirectoryAdded、MessageDisplay。
- 会话：`resume`、`resumeSessionAt`、`forkSession`、`sessionId`、`persistSession`。另有 `listSessions()`、`getSessionMessages()`、`getSessionInfo()`、`renameSession()`、`tagSession()`。可以拿来补历史、做“后加入的端先回放历史”。
- MCP：`mcpServers`（stdio/http/sse/sdk-in-process），`createSdkMcpServer` + `tool()` 能把网关自己的能力（发飞书、发邮件、TTS）作为工具暴露给 agent。这是“最广泛输出”的主动通道：agent **调工具**去输出，而不是只吐文本。
- 子路径导出：`@anthropic-ai/claude-agent-sdk/bridge`（`attachBridgeSession`，@alpha）和 `/browser`（浏览器端通过 WebSocket 或 SSE 连 CCR session 的 `query`）。看下面第 4 节。

多客户端：一个 `query` 对应一个子进程、一个宿主，自己没有多订阅者。多端要宿主自己 fan-out。

---

## 3. Channels（MCP 推送进正在跑的 session）—— research preview

### 输入
MCP server（stdio，由 Claude Code 拉起）在 capabilities 里声明 `experimental: {'claude/channel': {}}`，然后发：

```ts
await mcp.notification({ method: 'notifications/claude/channel',
  params: { content: 'build failed ...', meta: { chat_id: '1', severity: 'high' } } })
```
模型看到的是 `<channel source="<server名>" chat_id="1" severity="high">...</channel>`。meta 的 key 只能用 `[A-Za-z0-9_]`。**没有 ack**。session 忙的时候，新事件会排队，下个 turn 合并处理。

### 输出
Channels 本身**没有输出流**。回复的路子是 channel server 再暴露一个普通 MCP 工具（比如 `reply(chat_id, text)`），由 agent 自己去调。官方文档原话：终端里只显示 tool call 和 “sent”，回复正文只出现在对端平台。
**结论**：Channels 对“看到中间过程”没有帮助，它只是一个注入入口加一个工具出口。

### 审批转发（permission relay）
声明 `'claude/channel/permission': {}` 之后，Claude Code 会发 `notifications/claude/channel/permission_request`，`params` 是 `{request_id(5个字母,a-z去掉l), tool_name, description, input_preview}`，channel 回 `notifications/claude/channel/permission` `{request_id, behavior:'allow'|'deny'}`。**终端对话框和远端同时生效，先到的答案为准**。项目 trust、MCP consent 这两类对话框不转发。

### 限制
- 要 claude.ai 或 Console 认证；Bedrock、Vertex、Foundry 不可用；Team/Enterprise 要管理员打开 `channelsEnabled`。
- 自研 channel 不在 allowlist 上，只能用 `--dangerously-load-development-channels server:<name>`，**而且这个 flag 在 `-p` 和 Agent SDK 下会被忽略**。要正式用，得让 Team/Enterprise 管理员把我们的 plugin 加进 `allowedChannelPlugins`。所以 **headless/SDK 宿主基本用不上自研 Channels** [事实，channels-reference “Test during the research preview”]。
- 可以挂多个 channel（`--channels a b`），但一个 session 内是串行的；官方建议 *“To process independent event streams concurrently, run separate sessions.”*

**对 agents-io 的意义 [推测]**：如果走“交互式 claude 常驻 + 我们做网关”（botmux 那条路），Channels 是官方认可的注入口和审批转发口。如果走 SDK/headless，直接用 stdin 的 `SDKUserMessage{origin, priority}` 更简单，Channels 的价值主要是参考它的协议设计：meta 当路由属性、reply 工具、审批 first-wins。

---

## 4. Remote Control / 多设备（官方的“多端订阅 + 多端输入”实现）

- 启动方式：`claude remote-control`（server 模式，`--spawn same-dir|worktree|session`，`--capacity`，默认 32 个并发 session）、`claude --remote-control [name]` / `--rc`（交互式，同时也能远程）、会话内敲 `/remote-control`。
- 传输：本地**只发 outbound HTTPS**，向 Anthropic API 注册后轮询拿任务。设备连上来以后，由服务端经流式连接转发。多个短期凭证各自独立过期。
- **多端**：*“the conversation and the progress of subagents and dynamic workflows stay in sync across all connected devices, so you can send messages from your terminal, browser, and phone interchangeably.”* 手机/网页能发图片和文件（文件会下载到本地，以 `@` 引用的形式交给模型）。`/model`、`/effort`、`/compact`、`/clear` 这些命令能从远端发。permission prompt 和 AskUserQuestion 会转发过去，一直开着等人答。
- 限制：只支持 claude.ai 订阅（不能用 API key）；非 server 模式下一个进程只能有一个 remote session；`/plugin`、`/resume` 只能在本地用。
- SDK 层对应 `@anthropic-ai/claude-agent-sdk/bridge`（bridge.d.ts，@alpha）：

```ts
type BridgeSessionHandle = { sessionId; getSequenceNum(); write(msg: SDKMessage); sendResult();
  sendControlRequest(req); sendControlResponse(res); sendControlCancelRequest(id);
  reportState('idle'|'running'|'requires_action'); reportDelivery(eventId,'processing'|'processed'); flush(); close() }
type AttachBridgeSessionOptions = { sessionId; ingressToken; apiBaseUrl; epoch?;
  initialSequenceNum?;   // SSE 续传高水位，“resumes instead of replaying full history”
  outboundOnly?;         // mirror 模式：远端只能看不能驱动
  onInboundMessage?; onPermissionResponse?; onInterrupt?; onStopTask?; onSetModel?; onSetPermissionMode?; onClose?(code) }
```
  browser-sdk.d.ts 的 `SSEOptions{streamUrl:'…/v1/code/sessions/{id}/events/stream', sendUrl:'…/events', fromSequenceNum, onCatchUpTruncated}` 也能看出，**官方的多端模型是：session 事件日志带单调 `sequence_num`，客户端用 SSE 订阅加游标续传，写入走 POST events，审批走 control_request/response，epoch 防止两个 worker 同时写**。这几乎可以照搬当 agents-io 网关的设计蓝本。

**注意**：这个 bridge 只能连 Anthropic 的 CCR 后端（需要 ingressToken），我们不能把它当自己的总线用 **[事实 + 推测]**。

---

## 5. Cross-session messaging（session 之间、脚本到 session）

- 每个 session（包括 `claude -p`，`--bare` 除外）都会绑定一个 inbox unix socket，路径放在 `CLAUDE_CODE_MESSAGING_SOCKET`，token 在 `CLAUDE_CODE_MESSAGING_TOKEN`。脚本可以 `{"type":"auth","token":..}` 然后往里写消息（文档提到 *“when you want a script or hook to post into a session”*；具体消息帧格式文档没写全，**[待验证]**）。
- 投递语义：运行中就在工具调用之间读，空闲就新开一个 turn。`crossSessionInbound: accept|hold|refuse`；peer 消息**不能当作审批同意**，也不能改配置。队列上限 50 条，hold 上限 100 条。
- 跨机器经由 Remote Control。
- 对应 `SDKMessageOrigin.kind='peer'`。

对 agents-io 的意义：这是“外部进程往一个**已经在跑**的交互式 claude 注入文本”的官方口子，比 tmux send-keys 可靠。但它是纯文本，没有结构化回执。

---

## 6. Hooks（旁路观察 + 拦截）

- 处理器类型：`command`（stdin JSON，可 `async`/`asyncRewake`）、`http`（POST JSON 到 URL）、`mcp_tool`、`prompt`、`agent`。
- 公共输入：`session_id, prompt_id, transcript_path, cwd, permission_mode, hook_event_name, agent_id?...`。
- 输出控制：`continue/stopReason/systemMessage`、`hookSpecificOutput.additionalContext`、PreToolUse 的 `permissionDecision: allow|deny|ask|defer` 加 `updatedInput`、PermissionRequest 的 `decision.behavior`、Stop 的 `decision:'block'`（让它继续干活）。
- **用途 [推测]**：对 PTY/tmux 托管的交互式 claude，`type:"http"` hook 是拿到结构化中间过程（工具调用开始/结束、Stop、Notification）最便宜的办法，可以推给网关的事件总线。`PermissionRequest` hook 可以把审批接到飞书卡片上。缺点是拿不到 token 级流式文本（MessageDisplay 事件或许能拿到，**[待验证]**）。

---

## 7. 会话续接

- 存储：`~/.claude/projects/<proj>/<session>.jsonl`。`--resume` 支持 id 或 jsonl 绝对路径，跨目录也能找到（v2.1.223+）。`--fork-session` 分叉。SIGTERM 会留下未完成的 turn；`CLAUDE_CODE_RESUME_INTERRUPTED_TURN=1` 让它在续接时重跑。
- 后台 session：`claude --bg`，由 supervisor（`claude daemon`）托管，`~/.claude/jobs/<id>/`，`claude attach <id>`。**同一时间只能 attach 一个终端**（*“Can't open — this session is running in another terminal”*）；在 `claude logs` 或 peek 面板输入的内容会进消息队列。*“Two processes can't write to the same transcript.”*
- 结论：**transcript 是单写者**。“多端输入同一个 session”只能通过“单一宿主进程 + 输入队列”实现，不能让多个进程各自 resume。

---

## 8. 各嵌入面一览

| 嵌入面 | 输入 | 输出事件 | 中间过程 | 多客户端 attach | 对第三方可用性 |
|---|---|---|---|---|---|
| `-p` stream-json | stdin SDKUserMessage + control_request | 全量 SDKMessage + can_use_tool | 全（partial、tool、task、hook） | 否，单宿主 | 完全可用，API key / 订阅都行 |
| Agent SDK | AsyncIterable / streamInput / Query 方法 | 同上（类型化） | 全 | 否，单宿主 | 完全可用 |
| Channels | MCP notification（文本 + meta） | 无，靠 reply 工具 | 无 | 多个 channel 进同一 session | 预览期；自研要 dev flag 且仅交互式 |
| Remote Control | claude.ai / app | 全量同步 | 全 | **是**，多设备同时 | 仅 claude.ai 订阅，后端私有 |
| Cross-session | inbox socket 文本 | 无（对方可 SendMessage 回） | 无 | 多发送方 | 本机可用 |
| Hooks | additionalContext / decision | 旁路 JSON（command/http） | 工具级 | 可配多个 hook | 完全可用 |
| `--bg` + attach | 终端、logs 队列 | TUI | TUI | 否，单 attach | 本机 |

---

## 9. 对“统一协议 vs 各自处理”的回答 [推测，有上面证据支撑]

- **不要发明一套“覆盖一切”的 agent 协议**，也不要让每个 channel 直接对接 Claude 和 Codex。中间放一层：
  - **Runtime 适配器**（Claude、Codex 各一个）：负责把原生事件包成信封，**原样保留 payload**（happyclaw 留了 `raw_sdk_event` 这种逃生口；openclaw、multica 也都直接解析原生 stream-json），同时投影出一小组通用 kind。
  - **通用 kind**（参考 happyclaw 的 `StreamEventType` 和 ACP）：`session.started`、`input.accepted{origin}`、`text.delta`、`thinking.delta`、`tool.started{name,input_preview}`、`tool.progress`、`tool.finished{ok,summary}`、`approval.requested{request_id, tool, description, input_preview, choices}`、`approval.resolved{by_origin}`、`status{idle|running|requires_action}`（直接沿用 Claude 的 `session_state_changed`）、`turn.result{text,cost}`、`error`。
  - **Channel 适配器**按自己的能力订阅不同粒度：飞书卡片订阅 tool.* 和节流后的 text.delta，然后 patch 卡片；音箱语音只订阅 turn.result 或句子级 text，审批通过语音 yes/no 回传；邮件只要 result。
- **输出 = 订阅 session 事件日志**：每个 session 一个 append-only 日志加单调 seq，端用 `from_seq` 订阅续传。这就是 CCR / Remote Control 的做法（`sequence_num`、`fromSequenceNum`、`catch_up_truncated`）。
- **输入 = 多源写 session 输入队列**：每条输入带 `origin{channel, user, chat_id}` 和 `priority`，由单一宿主进程串行写入 runtime（Claude 用 `SDKUserMessage.priority` / `origin`；Codex 待查）。回复路由靠 `user_message_uuid(s)` 绑定回发起端，同时广播给所有订阅端。
- **审批 = 广播 + first-wins + cancel**：和 Channels relay、Remote Control、`control_cancel_request` 的语义一致。openclaw 的“重投递不重复弹审批”也要照做。
- **身份与信任**：沿用 Claude 的分级，human（可审批）、channel（需要发送方 allowlist）、peer/agent（不能审批、不能改配置）。
