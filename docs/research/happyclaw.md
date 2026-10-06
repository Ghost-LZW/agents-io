# HappyClaw 调研笔记（agent IO 视角）

- 仓库：https://github.com/riba2534/happyclaw （本地浅克隆，HEAD `cef72b2`）
- 定位：自托管、多用户的 **Claude Code 工作台**。Web + 8 个 IM 渠道（飞书、Telegram、QQ、钉钉、微信、企业微信、Discord、WhatsApp）接入同一套 Agent/Workspace/Session。
- 规模：TS 约 37 万行（含测试）。`src/index.ts` 23k 行、`src/db.ts` 15k 行，典型 "modular monolith"。
- **只支持 Claude**（`@anthropic-ai/claude-agent-sdk`），没有 Codex runtime（grep `codex` 只在 plugin 相关代码里出现）。

---

## 1. 整体架构

`docs/RUNTIME-ARCHITECTURE.md`：

```text
Web / Channel Adapter
        │
        ▼
Application services
        │
        ▼
SQLite durable state ──► Conversation lane / GroupQueue
                               │
                               ▼
                         Runner supervisor
                         ├─ Host Agent      (spawn node agent-runner)
                         └─ Docker Agent    (docker run -i --rm ...)
                               │
                               ▼
                     Web + channel projections
```

三层进程/边界：

1. **控制面主进程**（`src/index.ts`, `src/web.ts`, `src/im-manager.ts`, `src/group-queue.ts`, `src/db.ts`）：HTTP/WS、渠道连接、SQLite 持久化、per-conversation 串行队列。
2. **Agent Runner**（`container/agent-runner/src/index.ts`，5k 行）：一个独立 Node 进程，内部调用 Claude Agent SDK `query()`。Host 模式直接 `spawn(hostNodeBinary, [agentRunnerDist])`（`src/container-runner.ts:3840`），容器模式 `docker run -i --rm --name ...`（`src/container-runner.ts:2278`, `:2531`）。
3. **Claude Code CLI**：由 SDK 再拉起（`pathToClaudeCodeExecutable`），版本锁定。

层级模型（`docs/BUSINESS-MODEL.md`）：`User → Agent(AgentProfile) → Workspace → Sessions`。渠道会话通过 **Channel Mount** 显式绑定到某个 Session（私聊/普通群）或 Workspace（话题群：一话题一 Session）。

---

## 2. Runtime 集成：Host ↔ Runner 协议

### 2.1 Runner 的 IO 协议（文件 + stdout 帧）

`container/agent-runner/src/index.ts` 头注释即协议说明：

```text
Input protocol:
  Stdin: Full ContainerInput JSON (read until EOF)
  IPC:   Follow-up messages written as JSON files to /workspace/ipc/input/
         Files: {type:"message", text:"..."}.json — polled and consumed
         Sentinel: /workspace/ipc/input/_close — signals session end
Stdout protocol:
  Each result is wrapped in OUTPUT_START_MARKER / OUTPUT_END_MARKER pairs.
```

- 冷启动：stdin 一次性写入 `ContainerInput`（prompt、sessionId、turnId、queryRunId、channelContext、agentProfile、plugins、skillManifest、images…）。
- 热会话追加输入：主进程 `GroupQueue.sendMessage()`（`src/group-queue.ts:1716`）把 `{type:'message', text, images, queryRunId, sourceJid, channelContext, taskId, receipt}` 原子写（tmp + rename）到 `data/ipc/<folder>/input/*.json`；runner 用 `fs.watch` + 轮询消费。
- 控制哨兵文件：`_close`（结束会话）、`_drain`（当前 query 完成后退出）、`_interrupt`（内容是 queryId，触发 `query.interrupt()`）。
- 输出：runner `writeOutput()` 打印
  ```
  ---HAPPYCLAW_OUTPUT_START---
  {ContainerOutput JSON}
  ---HAPPYCLAW_OUTPUT_END---
  ```
  主进程 `src/agent-output-parser.ts` 做字符串感知的 JSON 括号匹配解析（防止内容里含 marker）。
- Agent 主动输出（`send_message`/`send_image`/`send_file`/`schedule_task`…）走 **MCP 工具**（runner 内 `createSdkMcpServer`，`container/agent-runner/src/mcp-tools.ts`），工具实现写 JSON 文件到 `ipc/messages`、`ipc/tasks` 目录，由主进程 `ipc-watcher-manager.ts` 消费。

### 2.2 SDK 用法（`index.ts:2763-2830`）

```ts
const q = query({ prompt: stream /* MessageStream AsyncIterable */, options: {
  cwd: WORKSPACE_GROUP, resume: sessionId, systemPrompt, allowedTools,
  thinking: { type: 'adaptive', display: 'summarized' },
  permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true,
  agentProgressSummaries: true,
  includePartialMessages: true,     // 拿到 token 级 stream_event
  forwardSubagentText: true,        // 子 agent 文本也流出来
  mcpServers: { ...userMcpServers, happyclaw: mcpServerConfig },
  hooks: {...}, plugins, skills, settingSources,
}});
```

- 关键技巧：`prompt` 传的是 **push 型 AsyncIterable**（`class MessageStream`，`index.ts:723`），保持 `isSingleUserTurn=false`，这样一个 SDK query 进程里可以持续注入后续用户消息（steer），子 agent 也能跑完。
- 每条 user message 前置 `<channel_context source="happyclaw_host" trust="verified">{json}</channel_context>`（`types.ts formatChannelTurnContextForPrompt`），并前置本地时间——放在 user turn 而非 system prompt，以免击穿 prompt cache。
- 多条消息合并时用 XML：`<messages><message id sender source="feishu:xxx" reply_to time>…</message></messages>`（`src/message-prompt.ts:148`）。
- **权限：bypassPermissions，没有审批流**。README 明说 "智能体始终拥有完整工具权限"；安全边界靠 Docker 沙箱 + 宿主机模式仅限管理员。`AskUserQuestion` 被当作特殊工具渲染（Web 卡 / 飞书 ASK 面板），回答通过普通下一条消息回来（推测，未深追回调）。

### 2.3 优缺点（观察）

- 优点：文件 IPC 可崩溃恢复（`ipc-input-claims.ts` 有 claim/requeue），进程可在容器内外同构；stdout 帧简单。
- 缺点：协议不是通用的（专为 Claude SDK 定制，`ContainerOutput` 里有大量 provider quota/failure 字段）；轮询文件有延迟；大量复杂度在处理 "warm runner 注入跨身份/跨模式 → drain 重启"、重放、截断续写等边角（`group-queue.ts` 3.4k 行）。

---

## 3. 统一的事件协议：`StreamEvent`

**有统一事件类型**，单一真源 `shared/stream-event.ts`，构建时复制到 runner / server / web 三处。

```ts
export type StreamEventType =
  | 'text_delta' | 'thinking_delta'
  | 'tool_use_start' | 'tool_use_end' | 'tool_progress' | 'tool_result'
  | 'hook_started' | 'hook_progress' | 'hook_response'
  | 'task_start' | 'task_progress' | 'task_updated' | 'task_notification'
  | 'permission_denied' | 'memory_recall' | 'compact_boundary'
  | 'notification' | 'prompt_suggestion' | 'raw_sdk_event'
  | 'context_audit' | 'todo_update' | 'usage' | 'status' | 'init';

export type StreamAgentScope = 'main' | 'task' | 'subagent' | 'system';
export type StreamDisplayLevel = 'primary' | 'detail' | 'debug';

export interface StreamEvent {
  eventType: StreamEventType;
  agentScope?: StreamAgentScope;
  queryRunId?: string;      // 精确的 query attempt，用于丢弃过期流
  turnId?: string;          // 一次用户 turn
  sessionId?: string; messageUuid?: string;
  displayLevel?: StreamDisplayLevel; // primary 内联 / detail 轨迹面板 / debug 开发者
  text?: string; title?: string; summary?: string; detail?: string;
  toolName?: string; toolUseId?: string; parentToolUseId?: string | null;
  isNested?: boolean; skillName?: string; toolInputSummary?: string; toolResult?: string;
  hookName?: string; ... taskId?: string; taskStatus?: string; workflowRun?: WorkflowRunSnapshot;
  todos?: Array<{id; content; status}>;
  usage?: { inputTokens; outputTokens; cacheRead...; costUSD; durationMs; numTurns; ... };
  // …还有 permissionDenied、contextAudit、rawEvent 等
}
```

特点：
- 是 **Claude SDK 事件的"扁平化+语义化"投影**（`container/agent-runner/src/stream-processor.ts` 2.1k 行把 SDK `stream_event`/assistant/user/system/task 消息转换成 StreamEvent）。字段是 Claude 风格（hook、Task、Skill、Workflow、compact），没有为 Codex 抽象过。
- 一个大 "bag of optional fields" 而不是 discriminated union。`RUNTIME-ARCHITECTURE.md` 自己也写了规则 6："New shared Host/Runner messages should use typed contracts instead of adding unrelated optional fields to a generic payload"——说明他们已意识到这个问题。
- `displayLevel` 和 `agentScope` 是给多端渲染做分级的好设计。
- 外层包络 `ContainerOutput { status: 'success'|'error'|'stream'|'closed'; result; streamEvent?; inputTurnId; sourceKind; finalizationReason; ipcReceipts; pendingBgTasks; queryIdle; ... }`（`src/agent-runtime-contracts.ts`）。即：**流事件 + 最终结果 + 投递回执** 三类信息共用一个帧。

**入站没有统一协议类型**：入站统一落到 DB 的 `NewMessage`（`src/types.ts:426`），带 `source_jid`、`channel_context: ChannelTurnContext`、`delivery_mode: 'queue'|'steer'` 等。`ChannelTurnContext`（`container/agent-runner/src/types.ts`）是给 agent 的"渠道身份上下文"，schemaVersion=1，provider/bot/chat/message/sender/mentions/capabilities，**明确不含凭据**。

---

## 4. 输入路径（以飞书为例）

1. `src/feishu.ts` 通过 WebSocket 收事件 → 解析、@ 门控、`/steer` `/break` 等 runtime 控制命令、斜杠命令（`/list /bind /new /clear /fresh`）。
2. `resolveEffectiveChatJid` / `channel-inbound-routing.ts` / `channel-mount-service.ts`：按 Channel Mount 把 IM 原生 jid（`feishu:<chatId>…`，地址格式见 `channel-address.ts`）折叠到目标 Session 的 jid（Workspace `web:*` 或 `jid#agent:<id>` 虚拟 jid）。未绑定 → 静默丢弃（但可发现）。
3. `storeMessageDirect(...)` 写 SQLite（`feishu.ts:3247`），带 `ingest_sequence`（主机分配的到达顺序）；飞书还有 durable inbox（`tests/feishu-durable-inbox.test.ts`）。
4. `onMessagePersisted` → Web `broadcastNewMessage`（Web 端实时看到 IM 发来的消息）。
5. `queue.enqueueMessageCheck(chatJid)` → `processGroupMessages()`（`src/index.ts:6397`）。
6. GroupQueue：若该 Session 已有 warm runner 且兼容（同 Bot 身份、同 interactionMode、不是定时任务）→ `sendMessage()` 写 IPC 文件注入；否则冷启动 `runContainerAgent` / `runHostAgent`。
7. Runner 收到 IPC → `MessageStream.push()` → SDK。

Web 输入：WS `{type:'send_message', chatJid, content, attachments, agentId, followUpBehavior}`（`src/types.ts:1112`，`src/web.ts:1781`）→ 同样落 DB → 同样的队列。

**多端输入同一 Session：支持**。冲突处理：
- 每个 Session 一条串行 lane（GroupQueue）。
- 运行中到达的输入有两种 `FollowUpMode = 'queue' | 'steer'`：`queue` 等当前 turn 结束后合并处理；`steer` 直接注入正在运行的 query（飞书 `@Bot /steer xxx`）；`/break` 中断并取消已排队。Follow-up 状态机 `queued|promoting|released|cancelled|awaiting_companion|subsumed`，并通过 WS `follow_up_update` 推给 Web。
- **不同来源的输入不会合并成一个批次**（`src/channel-reply-source.ts selectChannelReplyBatch`）：按 `source_jid + provider + accountId + chatId + threadId + rootId` 做路由 key，第一条之后不同路由的消息留在游标后面下一批处理。原因是"一个 turn 只有一个回复目标"。

---

## 5. 输出路径

Runner stdout 帧 → `agent-output-parser.ts` → `src/index.ts` 中的 onOutput 回调（约 `index.ts:8150-8400`）：

1. `usage` 先做计费归一化。
2. `TurnOutputCoordinator.reduceStreamEvent()`（`turn-output-coordinator.ts`）把事件规约成"可见答案文本"。
3. `broadcastStreamEvent(chatJid, event, agentId?)`（`src/web.ts:3129`）：
   - `context_audit` 不下发到浏览器，仅服务端记录。
   - `streamRunFence.observeExact(snapshotJid, queryRunId, turnId)`：丢弃被替代的旧 query attempt 的迟到事件。
   - `safeBroadcast({type:'stream_event', chatJid, event, agentId, runId}, ..., allowedUserIds)`：**按 ACL 广播给所有有权限的 WS 客户端**（多 tab/多设备同时看）。
   - `updateStreamingSnapshot()`：服务端维护一个 `StreamingSnapshotEntry`（partialText、thinkingText、activeTools、recentEvents、traceEvents、taskStates、todos、systemStatus、activeHook…），新连接 / 重连时先发 `active_run_snapshot` 再发 `stream_snapshot`（`web.ts:1608-1730`），中途加入也能看到进行中的过程。
4. IM 渠道：如果这次输入来自 IM，且渠道支持流式（`IM_CHANNEL_CAPABILITIES.supports_streaming_updates`），则有一个 `StreamingSession`（每渠道一个控制器），`feedStreamEventToCard(session, se, accumulatedText, traceUrl)`（`src/index.ts:668`）把 StreamEvent 映射成 `append / appendThinking / startTool / endTool / updateToolSummary / setTodos / setHook / updateTask / pushRecentEvent / setSystemStatus`。
5. 最终结果 / `send_message` → `channel-outbox-delivery.ts` 的持久化 Outbox（`enqueueChannelOutbox → claim → sending → complete/fail`，带 providerMessageId、幂等 chunkIndex）→ `IMChannel.sendMessage/sendFile/sendImage`。
6. 流式卡片也有持久化记录（`channel-turn-runtime.ts`：`createStreamingCardRecord / finalizeStreamingCardRecord / heartbeat / lease`），服务重启后能 reconcile 未定稿的卡片（`IMChannel.reconcileStreamingCard`）。

### 回复归属规则（`docs/BUSINESS-MODEL.md` "回复归属"，非常值得借鉴）

> 每条用户输入拥有自己的回复来源。一个 Session 可以接收来自不同入口的输入，但回复目标必须随这条输入确定……
> 不自动镜像到同 Workspace 的其他会话、其他 Bot 或 Web 之外的渠道。Web 历史展示与渠道出站是不同操作：记录回复不构成向其他收件人投递的授权。

即 **两种输出语义被刻意分开**：
- **观察（projection）**：Web 永远能看到该 Session 的全部输入、流式过程与结果（ACL 内所有客户端 fan-out）。
- **投递（delivery）**：只回到触发这条输入的那个渠道/账号/会话/话题；不广播到其他 IM。

`src/channel-reply-source.ts`：`/** Reply transport belongs to an input, never to a workspace or old session. */`

---

## 6. 中间过程可见性

| 端 | 呈现 |
| -- | -- |
| Web | `web/src/stores/chat.ts applyStreamEvent()`（4.6k 行 store）+ `components/chat/StreamingDisplay.tsx`：实时 Markdown、thinking、工具轨迹（含 toolInputSummary、toolResult 截断）、子 agent/Task 面板、Workflow 进度（`WorkflowRunSnapshot` phases/agents）、Todo、Hook、usage。`?trace=1` 打开完整 trace。 |
| 飞书 | CardKit 流式卡（`src/feishu-streaming-card.ts` 4.5k 行）：正文打字机 + 折叠的"详情"区（工具时间线、任务、思考）、AskUserQuestion 面板、中断按钮（`onCardInterrupt`）、usage 注脚；卡片里放 **Web trace 链接**（`buildWebTraceUrl` → `/chat/<folder>?turn=<turnId>&trace=1`）。节流 `minInterval=1200ms, minDelta=50`。研究文档 `docs/feishu-streaming-card-research-2026-09-13.md` 详细列了 CardKit 限制（单卡 10 QPS、30KB、200 组件、10 分钟流式自动关闭）。 |
| 钉钉 | AI Card 流式（`dingtalk-streaming-card.ts`） |
| Discord / QQ / 企微 | 消息编辑式流式（`discord-streaming-edit.ts` 等），只实现部分方法（如 Discord `setHook` 是 no-op）。 |
| Telegram/微信/WhatsApp | 不支持流式更新，只发最终结果 + typing。 |

分级手段：`StreamEvent.displayLevel`（primary/detail/debug）+ `agentScope`；子 agent 事件靠 `parentToolUseId` 从主卡隔离。

---

## 7. 扩展性（新增私有渠道要做什么）

**没有渠道插件机制，是封闭集合**。新增一个渠道需要改：

1. `src/channel-registry.ts`：`ChannelImplementationModules` 加 `xxx: typeof import('./xxx.js')` 和 loader（懒加载 SDK）。
2. `shared/channel-prefixes.ts`：`CHANNEL_PREFIXES` 加 `xxx: 'xxx:'`（JID 前缀即路由）。
3. `src/types.ts`：`ChannelProvider` union。
4. `src/im-channel.ts`：写 `createXxxChannel(config): IMChannel` 工厂。
5. `src/im-manager.ts`：写 `connectUserXxx(...)`（每个渠道一个 connect 方法，`im-manager.ts:1355-2020`）。
6. `src/im-channel-capabilities.ts`：能力声明。
7. 如果支持流式：写一个 controller，加入 `StreamingSession` union；`feedStreamEventToCard` 里有 `instanceof StreamingCardController` 的飞书特判（`index.ts` 中 9 处）。
8. 前端设置页、DB 账号表、routes/channel-accounts.ts。

核心接口（`src/im-channel.ts:224`）：

```ts
export interface IMChannel {
  readonly channelType: string;
  connect(opts: IMChannelConnectOpts): Promise<boolean>;
  disconnect(): Promise<void>;
  logout?(): Promise<void>;
  sendMessage(chatId: string, text: string, localImagePaths?: string[], options?: ChannelMessageDeliveryOptions): Promise<void>;
  sendFile?(chatId, filePath, fileName, options?): Promise<void>;
  sendImage?(chatId, imageBuffer, mimeType, caption?, fileName?, options?): Promise<void>;
  setTyping(chatId: string, isTyping: boolean, leaseId?: string): Promise<void>;
  beginAckReaction?(chatId, inputMessageId): Promise<void>;
  clearAckReaction?(chatId, inputMessageId): Promise<void>;
  isConnected(): boolean;
  syncGroups?(): Promise<void>;
  createStreamingSession?(chatId, onCardCreated?, lifecycle?, inputMessageId?): Promise<StreamingSession | undefined>;
  reconcileStreamingCard?(input): Promise<{ version: number; method: 'cardkit' | 'message_patch' }>;
  getChatInfo?(chatId): Promise<{...} | null>;
  executeFeishuCapability?(context: ChannelTurnContext, request): Promise<FeishuCapabilityResult>;  // 飞书泄漏进通用接口
}
```

`IMChannelConnectOpts`（`im-channel.ts:115`）是 **host 回调集合**（onMessagePersisted、resolveEffectiveChatJid、onFollowUpMessage、onSessionBreak/Clear/Fresh、onCommand、shouldProcessGroupMessage、onCardInterrupt…，约 30 个，其中多个 Feishu/WeChat/WeCom 专用）。也就是说 **adapter 自己负责落库+路由+命令解析**，而不是返回一个规范化的 inbound 事件交给核心——这是扩展成本高的根本原因。

流式控制器隐式接口（duck-typed，未声明为 interface）：
`isActive / append(fullText) / appendThinking / setThinking / startTool / endTool / updateToolSummary / getToolInfo / setSystemStatus / setHook / setTodos / pushRecentEvent / complete(finalText) / abort / dispose / getAllMessageIds / patchUsageNote`。注意 `append` 传的是**累积全文**（契合飞书 CardKit 正文接口要求累积全文）。

渠道层面的 "agent 能力" 通过 MCP 工具暴露给 agent：`get_channel_context`、`feishu_*`（get_chat/list_members/get_history/send_card/add_reaction/edit_message/recall_message/api_request）、`discord_*`、`send_image`、`send_file`、`send_message(delivery_role: progress|final|separate)` 等（`container/agent-runner/src/mcp-tools.ts`）。凭据不进 runner，飞书能力通过 host 代执行（`executeFeishuCapability` + `ActiveChannelTurnRegistry` 校验当前 turn 的 correlationId）。

---

## 8. Session / 身份 / 信任

- Session = DB 中的 workspace 主会话 jid 或 `agents(kind='conversation')`；SDK session id 存 `sessions` / `workspace_runtime_sessions`，按 provider 粘性 resume。
- 渠道绑定必须显式（Channel Mount），连接账号 ≠ 授权回复。
- 群聊门控：是否需要 @、响应所有人/仅 owner、发言者白名单（`isSenderAllowedInGroup`）。
- RBAC + Workspace ACL（`docs/ACL-MATRIX.md`, `src/group-acl.ts`），Web 广播按 `getGroupAllowedUserIds` 过滤。
- `ChannelTurnContext` 进 prompt 时标记 `trust="verified"`，仅含 host 校验过的 ID，丢弃未知字段（防 token 泄漏）。
- Warm runner 不跨 Bot 身份复用：容器环境变量里的飞书 CLI 凭据不可变，换 Bot → drain 重启（`group-queue.ts:1735`）。
- 工具权限：全开（bypassPermissions），无人工审批；隔离靠 Docker 非 root 容器。
- `interactionMode: 'assistant' | 'proactive'`：assistant 模式 SDK final 文本即回复；proactive 模式 final 文本不发布，只有 agent 显式 `send_message` 才发（适合"潜伏在群里的 agent"）。

---

## 9. 对我们设计的启示

### 回答用户的问题

1. **统一 IO 协议还是各自处理？** HappyClaw 的实践是：**输出侧统一**（StreamEvent 一个类型三处共享，所有端都消费同一事件流），**输入侧半统一**（统一落到 `NewMessage` + `ChannelTurnContext`，但 adapter 直接调用 host 回调做落库/路由，耦合重）。结论：值得维护统一协议，并且应把入站也做成规范化事件，adapter 只做 provider 协议翻译。
2. **输出 = 订阅 agent session 事件流？** 是的，HappyClaw 的 Web 端本质就是 "按 Session 订阅 + ACL 过滤 + 快照补齐"。IM 端则是"仅在本 turn 由本渠道触发时，挂一个投递投影"。它把 **观察（subscribe）** 和 **投递（deliver / reply routing）** 分成两件事，这是关键区分。
3. **多端输入同一 Session？** 支持，靠 per-session 串行 lane + `queue/steer` follow-up 模式 + 不同来源分批（一个 turn 一个回复目标）。
4. **中间过程**：`displayLevel` 分级 + 服务端快照 + 低带宽端（飞书卡）只展示摘要并给 Web trace 链接。

### 缺口（我们需要额外考虑）

- 只有 Claude；StreamEvent 字段强 Claude 化，Codex（app-server 的 item/turn 事件）需要一个中立的 core 事件层。
- 没有审批（approval）通路，我们若不全开权限需要把 `permission_request / permission_response` 设计成一等事件，并允许任意订阅端应答（first-wins）。
- 语音/会议这类"实时、半双工、可打断"的端完全没有覆盖。
- 渠道是封闭集合，私有渠道无法以插件形式接入。
