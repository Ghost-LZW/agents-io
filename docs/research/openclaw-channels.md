# OpenClaw：channel / gateway 侧调研笔记

> 仓库：https://github.com/openclaw/openclaw （本地快照 commit `3a7139a6`，2026-10-06）
> 范围：只看 channel/gateway 侧。包括 channel plugin 接口、inbound 归一化、路由到 session、outbound（分块、渲染、流式、进度）、同一 session 接多个 channel、pairing、身份和 allowlist。
> 所有路径都相对于 repo 根。标【推测】的是我的推断，代码或文档里没有直接写。

---

## 0. 一句话

OpenClaw 是一个 **Gateway 拥有 session** 的个人 agent 平台。每个 IM 平台都是一个 `ChannelPlugin`，以 adapter 包的形式提供，里面几十个可选面。插件只负责"平台事实 + 原生收发"。归一化 context（`MsgContext`）、路由、session、排队/steer、分块、富消息降级、进度卡片的策略都由 core 统一负责。输出侧有两套机制：

1. **channel 回包**：按 turn 走回调，原路回到发起 channel，不是订阅；
2. **Gateway WS 客户端**（Control UI / TUI / mobile / attach）：通过 `sessions.messages.subscribe` **订阅 session 事件流**，多端同时看。

---

## 1. Channel plugin 接口（扩展点）

### 1.1 包结构与清单

插件是一个 npm 包，`openclaw.plugin.json` 里的 `channels: ["acme-chat"]` 声明它拥有某个 channel（docs/plugins/sdk-channel-plugins.md "Package and manifest"）：

```json
{ "id": "acme-chat", "channels": ["acme-chat"],
  "channelConfigs": { "acme-chat": { "schema": {...}, "uiHints": {...} } } }
```

- `index.ts` → `defineChannelPluginEntry({ id, plugin, registerCliMetadata, registerFull })`
- `setup-entry.ts` → `defineSetupPluginEntry(plugin)`：channel 未配置时只加载轻量 setup 部分
- 入站 webhook 在 `registerFull` 里用 `api.registerHttpRoute({ path, auth: "plugin", handler })` 注册
- 外部私有插件同样走这套（"Installed external plugins can also support DM pairing if they implement OpenClaw's pairing API"，docs/channels/pairing.md）。**私有通道完全可以做成 out-of-tree 插件**。

### 1.2 `ChannelPlugin` 类型（src/channels/plugins/types.plugin.ts:48）

```ts
export type ChannelPlugin<ResolvedAccount = any, Probe = unknown, Audit = unknown, GatewayVersion extends 1|2 = 1> =
  Omit<ChannelSetupPlugin, "config"> & {
  defaults?: { queue?: { debounceMs?: number } };
  reload?: { configPrefixes: string[]; noopPrefixes?: string[]; accountScopedRestart?: boolean };
  config: ChannelConfigAdapter<ResolvedAccount>;      // 唯一必需：账号解析
  pairing?: ChannelPairingAdapter;
  security?: ChannelSecurityAdapter<ResolvedAccount>; // DM 策略/allowlist
  groups?: ChannelGroupAdapter;
  mentions?: ChannelMentionAdapter;
  outbound?: ChannelOutboundAdapter;                  // 发送
  status?: ChannelStatusAdapter<...>;
  gateway?: ChannelGatewayAdapter<ResolvedAccount>;   // startAccount/stopAccount（长连接/monitor）
  auth?; approvalCapability?; elevated?; commands?; lifecycle?; secrets?; allowlist?; doctor?;
  bindings?; conversationBindings?;
  streaming?: ChannelStreamingAdapter;
  threading?: ChannelThreadingAdapter;
  message?: ChannelMessageAdapterShape;               // 新版发送面：live preview / finalizer / receipts
  messaging?: ChannelMessagingAdapter;                // session grammar、target 解析
  agentPrompt?: ChannelAgentPromptAdapter;            // 给模型的格式提示
  directory?; resolver?; actions?: ChannelMessageActionAdapter; heartbeat?;
  agentTools?: ChannelAgentToolFactory | ChannelAgentTool[];
};
```

生命周期入口在 `gateway.startAccount(ctx)`（src/channels/plugins/types.adapters.ts:187-216）：

```ts
export type ChannelGatewayContext<ResolvedAccount> = {
  cfg; accountId; account: ResolvedAccount; runtime; abortSignal: AbortSignal;
  log?; getStatus(); setStatus(next);
  channelRuntime?: ChannelRuntimeSurface;  // core 注入：dispatch/routing/sessions/text/media/pairing...
};
export type ChannelGatewayAdapter<R> = {
  startAccount?: (ctx: ChannelGatewayContext<R>) => Promise<unknown>;
  stopAccount?: (ctx) => Promise<void>;
  loginWithQrStart?; loginWithQrWait?; logoutAccount?; ...
};
```

**模式**：插件拿到 `abortSignal` 和 `channelRuntime`，自己开 WS、长轮询或 webhook。每条事件进来就调用 `channelRuntime.inbound.*`。core 不关心传输方式。

### 1.3 职责划分（docs/plugins/sdk-channel-plugins.md "What your plugin owns"）

- **插件负责**：Config、Security（DM 策略/allowlist）、Pairing、**Session grammar**（平台会话 id → base chat/thread/parent）、Outbound、Threading、心跳 typing、格式提示。
- **core 负责**：共享的 `message` tool（"Channel plugins do not implement send/edit/react tools; core provides one shared `message` tool"）、prompt wiring、session key 外层形状、`:thread:` 记账、dispatch、多 agent 群线程的参与者选择和轮次预算、model picker。

这一点很关键：**agent 只看到一个统一的 `message` tool**（action = send/edit/react/read/pin/...），由 channel 的 `actions` adapter 实现，并通过 `describeMessageTool` 声明自己支持哪些 action。

### 1.4 builder 糖

`createChatChannelPlugin({ base, security.dm, pairing.text, threading, outbound.attachedResults })` 把声明式选项组合成 adapter。最小插件约 80 行（见文档里 `acme-chat` 的例子）。参考实现：`extensions/qa-channel/`（约 5.6k 行，含测试，用 HTTP bus 轮询的测试 channel，适合当私有通道模板）。

---

## 2. Inbound：平台事件 → 归一化 context

### 2.1 流程

docs/plugins/sdk-channel-inbound.md：

```text
platform event -> inbound facts/context -> agent reply -> message delivery
```

`runtime.channel.inbound.run(...)` 跑一条事件的完整生命周期：**ingest → classify → preflight → resolve → record → dispatch → finalize**。adapter 类型见 src/channels/turn/types.ts:425：

```ts
type ChannelTurnAdapter<TRaw, ...> = {
  ingest: (raw: TRaw) => MaybePromise<NormalizedTurnInput | null>;
  classify?: (input) => MaybePromise<ChannelEventClass>;
  preflight?: (input, eventClass) => MaybePromise<PreflightFacts | ChannelTurnAdmission | null>;
  resolveTurn: (input, eventClass, preflight) => MaybePromise<ChannelTurnResolved<...>>;
  onFinalize?: (result) => void;
};
export type ChannelEventClass = {
  kind: "message" | "command" | "interaction" | "reaction" | "lifecycle" | "unknown";
  canStartAgentTurn: boolean; requiresImmediateAck?: boolean;
};
export type ChannelTurnAdmission =
  | { kind: "dispatch" } | { kind: "observeOnly"; reason } | { kind: "handled"; reason }
  | { kind: "drop"; reason; recordHistory?: boolean };
```

归一化用的"事实"类型（src/channels/turn/types.ts:54-130）：`NormalizedTurnInput{id,timestamp,rawText,textForAgent,textForCommands,raw}`、`SenderFacts{id,name,username,roles,isBot,isSelf}`、`ConversationFacts{kind,id,threadId,parentId,nativeChannelId,link,routePeer}`、`RouteFacts{agentId,routeSessionKey,...}`、`ReplyPlanFacts{to,replyToId,messageThreadId,sourceReplyDeliveryMode}`、`MessageFacts{body,rawBody,bodyForAgent,commandBody,inboundHistory,sourceModality}`、`InboundMediaFacts`。

### 2.2 统一的 inbound 结构：`MsgContext`

src/auto-reply/templating.ts:117，约 250 个字段的大扁平对象。这是"统一输入协议"本体，部分字段如下：

```ts
export type MsgContext = Partial<CanonicalInboundText> & {
  Body?; BodyForAgent?; BodyForCommands?; InboundHistory?: HistoryEntry[];
  From?; To?; SessionKey?; AgentId?; AccountId?; ParentSessionKey?;
  MessageSid?; ReplyToId?; ReplyToBody?; RootMessageId?; ReplyChain?: [...];
  ForwardedFrom?...; ThreadStarterBody?; ThreadHistoryBody?;
  media?: MediaFact[];                     // 有序附件事实，下标即身份
  SourceModality?: InboundSourceModality;  // 转写前的原始模态（语音等）
  Transcript?; MediaUnderstanding?; LinkUnderstanding?;
  ChatType?; GroupSubject?; GroupMembers?; MemberRoleIds?;
  SupplementalContext?: SupplementalContextFacts;      // quote/forwarded/thread/群 system prompt
  ChannelPromptContext?: string[]; ChannelStructuredContext?: ...;  // 非可信元数据
  InputProvenance?; InternalTurnSource?: "heartbeat"|"cron"|"exec"|"progress-card-refresh";
  SenderId?; SenderName?; SenderIsBot?; SenderIsSelf?;
  Provider?; Surface?; WasMentioned?; ExplicitlyMentionedBot?; MentionedUserIds?;
  CommandAuthorized?; CommandSource?: "text"|"native";
  GatewayClientScopes?; GatewayClientCaps?;
  MessageThreadId?; NativeChannelId?; ConversationLink?; ChannelContext?;
  OriginatingChannel?; OriginatingTo?;     // ★ 回包路由：回到哪个 channel/目标
  InboundAccessAuthorized?; ...
};
```

`CanonicalInboundText = { commandText; agentText; rawText }` 由 `finalizeInboundContext` 统一填充。

**观察**：

- 结构是"一个超集 struct + 大量可选字段"，不是 tagged union。很多字段是 legacy 别名，正在废弃，比如 `MediaPath*` 已被 `media[]` 取代，`removeAfter 2026-10-01`。这说明他们是在演进中慢慢把各 channel 的 ad-hoc 字段收敛进来的。
- 引用、转发、线程、群信息走 `SupplementalContext`。core 按可见性策略把它渲染成给模型的 untrusted context block。插件只给事实，不拼 prompt（"Core applies the configured context visibility policy and renders the reply relationship for the model"）。

### 2.3 Feishu 实例（extensions/feishu/src/）

- 传输：`monitor.transport.ts` 用 `@larksuiteoapi/node-sdk` 的 WS client 或 webhook，带签名时间戳防重放（`FEISHU_WEBHOOK_TIMESTAMP_MAX_SKEW_MS = 1h`）和 in-flight 限流。
- 事件注册：`monitor.account.ts:314` `eventDispatcher.register({...})`，订阅了 `im.message.receive_v1`、`im.message.message_read_v1`、`drive.notice.comment_add_v1`（文档评论）、`vc.bot.meeting_invited_v1`（会议邀请）、`im.message.reaction.created_v1/deleted_v1`、`card.action.trigger`（卡片按钮回调）。
- **非消息事件 → 合成 DM 消息**：`monitor.vc-meeting-invited-handler.ts` 把"会议邀请"事件包成一条合成的 p2p 文本消息（`message_id: "vc-invited:event:<id>"`，内容是 "Use the available tool to join the meeting with meeting number ... immediately"），然后走同一个 `handleFeishuMessage`。默认 `vcAutoJoin=false` 时忽略。这是把异构事件塞进统一输入管道的一个朴素做法。
- 主管道：`bot.ts:256 handleFeishuMessage` 依次做 group/DM ingress 鉴权（`groupIngress.ingress.admission !== "dispatch"` 就返回）→ `core.channel.routing.resolveAgentRoute({channel:"feishu", accountId, peer:{kind, id}, parentPeer})`（bot.ts:791）→ 必要时动态创建 agent → `core.channel.inbound.buildContext({...})`（bot.ts:1322）→ `createFeishuReplyDispatcher` → `core.channel.inbound.run`。
- `buildContext` 的参数形状就是归一化的规范输入（bot.ts:1322-1395）：

```ts
core.channel.inbound.buildContext({
  channelIngress: boundChannelIngress, channel: "feishu",
  supplemental: { quote, thread: {starterBody, historyBody, label}, groupSystemPrompt },
  media: inboundMedia, messageId, timestamp, from,
  sender: { id, name, isBot },
  conversation: { kind, id, routePeer, nativeChannelId, parentId, label, threadId },
  route: { ...route, agentId, accountId, routeSessionKey },
  reply: { to, replyToId, messageThreadId },
  message: { body, bodyForAgent, inboundHistory, rawBody, commandBody },
  sessionTranscript: { historyLimit },
  access: { mentions: {canDetectMention, wasMentioned, requireMention}, commands: {authorized} },
  extra: { RootMessageId, Transcript, GroupSubject },
});
```

### 2.4 可靠性：dedupe、debounce、durable ingress

- 内存 dedupe：key 为 agent scope + channel route（channel + peer + account + thread）+ message id，TTL 20 分钟，最多 5000 条（docs/concepts/messages.md）。
- Inbound debounce：`messages.inbound.debounceMs/byChannel`。只对纯文本生效；媒体立即 flush；控制命令绕过。
- **Durable ingress**（docs/plugins/sdk-channel-plugins/durable-ingress.md，代码在 src/channels/message/ingress-queue*.ts）：在唯一的接收点把原始 envelope 入 SQLite 队列（"no normalization at receive time"），webhook 的 ack 要等 durable append 成功，每个 conversation 一个串行 lane，主键 `(queue_name, event_id)`，完成时写 tombstone 防止平台重投。
- ack 策略（`createMessageReceiveContext`）：`after_receive_record | after_agent_dispatch | after_durable_send | manual`。

---

## 3. 路由到 session

### 3.1 选 agent（docs/channels/channel-routing.md）

确定性路由，**模型不选 channel**。优先级：exact peer binding → parent peer（线程继承）→ peer wildcard → guild+roles（Discord）→ guild → team（Slack）→ account → channel → fallback owner。

```ts
// src/routing/resolve-route.ts:59
export type ResolvedAgentRoute = {
  agentId; channel; accountId; dmScope?; groupScope?;
  sessionKey: string;          // 持久化 + 并发控制
  mainSessionKey: string;
  lastRoutePolicy: "main" | "session";   // 哪个 session 接收 lastRoute 更新
  matchedBy: "binding.peer" | ... | "default";
};
```

### 3.2 Session key 形状

- DM 默认合并到 `agent:<agentId>:main`（**所有 channel 的私聊汇到同一个 main session**）。
- `session.dmScope`：`main`（默认）| `per-peer`（跨 channel 按人）| `per-channel-peer` | `per-account-channel-peer`。
- 群：`agent:<id>:<channel>:group:<id>`；频道：`...:channel:<id>`；线程追加 `:thread:<id>`；Telegram topic 用 `:topic:<id>`。
- `session.groupScope: "main"` 或 binding 级覆盖可以把某个群也并入 main。
- **跨 channel 身份合并**：`session.identityLinks: { alice: ["telegram:111", "discord:222"] }`（src/routing/resolve-route.ts:108，测试在 resolve-route.test.ts:336），配合 `per-peer` 让同一个人在不同 channel 共用一个 session。
- 平台 id 解析由插件负责：`messaging.resolveSessionConversation(rawId) → {baseConversationId, threadId, parentConversationCandidates}`（docs/plugins/sdk-channel-plugins/sessions-and-bindings.md）。Feishu 另外提供 bootstrap 用的 `extensions/feishu/session-key-api.ts`。

### 3.3 Main DM route pinning

多人共享 main 时，为了不让非 owner 的 DM 覆盖 `lastRoute`（心跳、后台通知会投递到 lastRoute），如果 `allowFrom` 恰好只有一个具体 id，就推断它为 pinned owner。不匹配的 sender 照样记录 metadata，但不更新 lastRoute（channel-routing.md "Main DM route pinning"）。

---

## 4. Outbound：回包、分块、渲染、流式

### 4.1 统一输出载荷 `ReplyPayload`（src/shared/reply-payload.types.ts:31）

```ts
export type ReplyPayload = {
  text?: string; fallbackText?: {...};
  mediaUrl?; mediaUrls?; attachments?: ReplyMediaAttachment[];
  presentation?: MessagePresentation;      // 可移植富消息（卡片/按钮/表格/图表）
  delivery?: { pin?: boolean | {...} };
  replyToId?; replyToCurrent?; audioAsVoice?; videoAsNote?; location?;
  spokenText?; ttsSupplement?;
  isError?; isReasoning?; isCommentary?; isCompactionNotice?; isFallbackNotice?; isStatusNotice?;
  channelData?: Record<string, unknown>;   // 每个 channel 的私有逃生口
};
```

用 `is*` 标志区分 lane（答案 / 推理 / 旁白 / 状态）。channel 自己决定渲染还是丢弃，例如 "Channels that do not have a dedicated reasoning lane (e.g. WhatsApp, web) should suppress it"。

### 4.2 富消息：`MessagePresentation` + 能力声明 + 降级

src/interactive/payload.ts:372-388，docs/plugins/message-presentation.md：

```ts
type MessagePresentation = { title?; tone?: "neutral"|"info"|"success"|"warning"|"danger";
  blocks: Array<text | context | divider | buttons | select | chart(pie/bar/line/area) | table> };
```

channel 在 outbound adapter 上声明 `presentationCapabilities`（src/channels/plugins/outbound.types.ts:33：`supported/buttons/selects/context/divider/charts/tables/limits.actions.{maxActions,maxActionsPerRow,maxRows,maxLabelLength}`）。core 按能力降级后调 `renderPresentation({payload, presentation, sourcePresentation, ctx})` 生成原生载荷（Feishu 在 `presentation-card.ts`）。原则是"不往共享 message tool 里加 provider 原生字段"，Discord `components` 是唯一获批的例外。

### 4.3 `ChannelOutboundAdapter`（src/channels/plugins/outbound.types.ts:128）

```ts
export type ChannelOutboundAdapter = {
  deliveryMode: "direct" | "gateway" | "hybrid";
  chunker?: (text, limit, ctx?) => string[]; chunkerMode?: "text"|"markdown";
  textChunkLimit?: number; extractMarkdownImages?; sanitizeText?;
  normalizePayload?; normalizePayloadBatch?;
  presentationCapabilities?; resolvePresentationCapabilities?; renderPresentation?;
  deliveryCapabilities?; pinDeliveredMessage?;
  resolveTarget?: ({to, allowFrom, accountId, mode}) => {ok:true,to}|{ok:false,error};
  sendPayload?; sendFormattedText?; sendFormattedMedia?;
  sendText?: (ctx) => Promise<OutboundDeliveryResult>;
  sendMedia?; sendPoll?;
};
```

### 4.4 分块（docs/concepts/streaming.md）

- 分块由 `EmbeddedBlockChunker` 负责：`minChars/maxChars`，切分优先级 paragraph → newline → sentence → whitespace → hard break；**不在代码块中间切**，强制切时先闭合再重开 fence；表格放得下就整块，放不下按行切。`maxChars` 会被 clamp 到 channel 的 `textChunkLimit`（默认 4000）。
- Coalesce：`{minChars, maxChars, idleMs}` 合并碎块。Discord/Signal/Slack 默认 `{1500, 1000ms}`。
- 可选 `humanDelay`，在 block 之间随机停顿 800-2500ms。
- **没有 token 级流式**："there is no true token-delta streaming to channel messages"。

### 4.5 流式 + 进度：两层

1. **Block streaming**：把完成的块当普通消息发出去。默认关。
2. **Preview streaming**（`channels.<id>.streaming.mode`）：`off | partial`（单条预览替换成最新文本）`| block`（按块追加或轮换）`| progress`（工具进度状态草稿，结束时给最终答案）。各 channel 默认值：Telegram/Slack 默认 progress，Discord 默认 off，Mattermost/Teams 默认 partial。
   - Telegram：`sendMessage` + `editMessageText`。
   - Slack：原生 `chat.startStream/appendStream/stopStream` 和 agent card（带计划清单、"Open in OpenClaw" 链接）。
   - Teams：原生 progress stream。
   - **Feishu**：CardKit 流式卡片（`extensions/feishu/src/streaming-card.ts`，调 `/cardkit/v1/cards`，`streaming_mode: true`，每次更新递增 `sequence` 并带 `uuid` 幂等），关闭时 `streaming_mode:false`。
- 进度内容可配：`streaming.progress.{toolProgress, commentary, commandText: "status"|"raw", maxLines, maxLineChars, label}`。默认是"安静"模式：只显示标题、commentary/reasoning、计划里程碑、审批请求；工具行要开 `toolProgress: true` 才显示。
- message adapter 的能力声明（docs/plugins/sdk-channel-plugins/message-adapter.md）：`message.live.capabilities: draftPreview | previewFinalization | progressUpdates | nativeStreaming | quietFinalization`；`finalizer.capabilities: finalEdit | normalFallback | discardPending | previewReceipt | retainOnAmbiguousFailure`。并且要求**有契约测试证明**（`verifyChannelMessageLiveCapabilityAdapterProofs`）。
- 共享进度渲染器：`src/channels/progress-draft-compositor.ts`、`progress-draft-lines.ts`、`status-reactions.ts`（用 reaction 表示状态）、`typing-lifecycle.ts`。

### 4.6 中间过程的事件面（channel 侧）

每个 turn，channel 在 `replyOptions` 里挂回调来接收中间过程。src/auto-reply/get-reply-options.types.ts:255-410：

```ts
onPartialReply, onReasoningStream, onReasoningEnd, onAssistantMessageStart,
onBlockReplyQueued, onBlockReply, onPreparedBlockReply,
onToolResult, onToolStart({itemId, toolCallId, name, phase, args}),
onItemEvent({itemId, toolCallId, kind, title, name, phase, status, summary, progressText, approvalId, ...}),
onNarrationUpdate({text}),          // utility model 生成的进度旁白
onPlanUpdate({phase, title, explanation, steps}),
onApprovalEvent({phase, kind, status, title, command, approvalId, ...}),
onCommandOutput({output, status, exitCode, durationMs, cwd}),
onPatchSummary({added, modified, deleted}),
onCompactionStart/End, onModelSelected, ...
// 返回 ProgressCallbackResult：true 表示"已经对用户可见"，false 表示 pending 或未展示
```

Feishu 的接法（extensions/feishu/src/reply-dispatcher.ts:1516-1580）：`onPartialReply` 更新卡片正文快照；`onReasoningStream` 把思考合并进卡片；`onItemEvent` 用 `formatChannelProgressDraftLineForEntry` 格式化成状态行；`onCompactionStart` 显示 "📦 Compacting context..."。

### 4.7 投递结算

- 每个逻辑 payload 恰好一个 `message_sending` owner（durable / direct / provider funnel 三选一）。
- 结果用 `MessageReceipt` 表示；`visibleReplySent` 区分"真的发出去了"；部分成功用 `createChannelPartialDeliveryError`；不确定用 `ambiguous: true` 并以 `unknown` custody 记录。
- `preparePayload` 返回 null 表示 channel 主动抑制。
- 有 hook 会改写或取消 payload 时，**禁止提前展示 preview**，避免泄露改写前的内容。

---

## 5. 统一的 agent 事件流（gateway 侧）与多端订阅

### 5.1 进程内事件总线（src/infra/agent-events.ts）

```ts
export type AgentEventStream = "lifecycle"|"tool"|"assistant"|"usage"|"error"|"item"|"plan"
  |"approval"|"command_output"|"patch"|"compaction"|"thinking"|(string & {});
export type AgentEventPayload = {
  runId: string; seq: number; stream: AgentEventStream; ts: number;
  data: Record<string, unknown>; sessionKey?; sessionId?; agentId?;
};
emitAgentEvent(...); onAgentEvent(listener); onAgentEventForRun(runId, listener);
```

这是"统一输出协议"的内核：**以 run 为单位、带 seq 的 typed stream**，任何 runtime（内置、Codex app-server、Claude CLI）都要映射到它。

### 5.2 Gateway WS 协议上的输出（packages/gateway-protocol/src/schema/）

- `AgentEventSchema = { runId, seq, stream, ts, spawnedBy?, isHeartbeat?, data }`（agent.ts:60）
- `ChatEventSchema = status | delta{deltaText, replace?} | final{stopReason} | aborted | error{errorKind, errorDetail}`，base 字段为 `{runId, sessionKey, agentId?, seq}`（logs-chat.ts:382-522）
- 其他事件族：`session.message`、`session.operation`、`session.tool`、`session.narration`、`session.approval`、`session.observer`、`sessions.changed`（docs/gateway/protocol/rpc-bootstrap-and-events.md）

### 5.3 订阅 = 多端观看（★核心）

`sessions.messages.subscribe { key, agentId?, mode?, subscriptionId?, includeApprovals? }`（src/gateway/server-methods/sessions-subscriptions.ts:91）：

- 一个连接订阅一个 session 的实时流。**能被动看到由其他客户端或 channel 发起的 run**（"passive views of runs started by another client"）。
- `mode: "narration"`：不推 token delta，改推 `session.narration` 快照（最多 16k 字符，最多每 2 秒一次，终态时立即 flush），适合侧边栏或低带宽端。
- 中途加入或重连时，第一帧带完整 `message` 快照，之后只推增量。
- `includeApprovals` 需要 paired device + approvals scope，"Subscribe before the authoritative snapshot so a transition cannot land between replay and live delivery. Clients reconcile by id"。也就是**先订阅、再拉快照、按 id 对账**。
- 连接 caps `chat-only-assistant-text`：只消费 chat 投影，避免 chat 和 agent 两套文本重复。
- docs/concepts/session-attachment.md："The Control UI, mobile clients, ACP, `openclaw tui <target>`, and `openclaw attach <target>` project that Gateway-owned state instead of keeping independent session copies"。

### 5.4 但 channel 不是订阅者

- channel 回包是**按 turn 回调**，路由到 `OriginatingChannel/OriginatingTo`，即"replies route back to the channel where a message came from"。
- 文档明确说："Multiple devices/channels can map to the same session, but history is not fully synced back to every client. Use one primary device for long conversations"（docs/concepts/messages.md）。也就是说：Telegram 发起的 turn，回复只回 Telegram；WebChat/Control UI 能看到是因为它订阅了 session；WhatsApp 看不到。
- 跨 channel 投递只能显式进行：agent 调用 `message` tool 指定 channel/target，或 `chat.send` 带 `deliver: true, originatingChannel, originatingTo`（logs-chat.ts:340）。
- "Channel docking"（手动把回复焦点切到另一个 channel 的 `/dock-*`）**已被移除**（docs/concepts/session.md "Retired channel docking"）。【推测】原因是语义混乱、安全风险，他们收敛成"回到原处 + 显式 message tool"。

---

## 6. 多端输入同一个 session：队列与 steer

docs/concepts/queue.md、docs/concepts/queue-steering.md：

- 每个 session key 一条 lane（`session:<key>`），CLI/embedded/Codex runtime 共用，保证同一 session 不会并发跑两个 turn；再进入全局 `main` lane 限制总并发。
- 活跃 run 期间新消息的处理（`messages.queue.mode`，可按 channel 设置）：
  - `steer`（默认）：注入到正在运行的 runtime。**不打断正在执行的工具**。顺序执行时，未开始的尾部工具调用会被跳过，并生成 "Skipped to process an incoming message." 的合成结果，保证 tool_call/result 配对。Codex app-server 用原生 `turn/steer`，quiet window 内的输入合并成一次批量发送。
  - `followup`：排队，当前 run 结束后再跑。
  - `collect`：去抖合并成一个 followup turn；目标 channel/thread 不同的消息分开 drain，以保留路由。
  - `interrupt`：中止当前 run，跑最新那条。
- 默认值：500ms debounce，`cap: 20`，`drop: "summarize"`。
- **冲突与权限**："Different signed-in people with the same permissions can steer each other's active turn"。权限不同（role scope、sandbox、tool policy 等）就降级为 followup，"instead of borrowing the active or newest sender's permissions"。turn 保留原 owner 的权限和审批目标；多人 steer 时个人化工具需要显式传 `requester_profile.id`。
- 每条 steer 进来的用户输入都会单独得到一个答案（内置 runtime）。

---

## 7. Pairing、身份、allowlist、信任

- **DM 策略**：`dmPolicy: pairing | allowlist | open(需 "*") | ...`。`pairing` 模式下陌生人收到一个 8 位码（去掉 0O1I），1 小时过期，每个账号最多 3 个 pending 请求；在 Control UI "DM access requests" 或 `openclaw pairing approve <channel> <CODE>` 批准（docs/channels/pairing.md）。批准只授予 DM 权限，**不授予群权限**，也**不等于 command owner**（`commands.ownerAllowFrom` 单独设置，CLI 首次批准时会自动设置 owner）。
- **访问组**：`accessGroups.<name> = { type: "message.senders", members: { discord: [...], telegram: [...] } }`，在 allowlist 里用 `accessGroup:<name>` 引用，跨 channel 复用。
- **Ingress resolver**（docs/plugins/sdk-channel-ingress.md）：`runtime.channel.inbound.ingress.resolve({ channelId, accountId, identity, subject, conversation, contextBinding, event, policy, allowFrom, groupAllowFrom, accessGroups, route, readStoreAllowFrom, command })`。返回 `ingress`（有序决策图 + admission）、`senderAccess`、`routeAccess`、`commandAccess`、`activationAccess`。插件**不要自己预先算 allowlist**，交给 core 统一计算。
  - 身份描述符：`defineStableChannelIngressIdentity({ key, normalize, sensitivity: "pii" })`。
  - 身份可信度分级：`IdentifierAuthentication = verified | asserted | unverified | mutable`。邮件（imap）就用这个控制最低可信度（`senderAuth.min`，降到 `unverified/mutable` 会被标为 dangerous flag）。
  - resolver 的结果必须**原样**传给 `buildContext({ channelIngress })`，并绑定 agent/session/message/event（一次性、有 epoch），防止插件伪造参与者证据。
- **设备 / 客户端信任**：Gateway WS 客户端要做设备配对（`pairing-required` → Settings > Devices 批准），token 按 origin 隔离，用 operator scope（如 `operator.sessions.read`、approvals scope）控制能订阅、能审批什么。
- **审批**：`approvalCapability` + 原生审批卡片（Feishu `card-ux-approval.ts`、按钮回调 `card.action.trigger`）。进度渲染器即使在安静模式下也必须保留审批请求。

---

## 8. Runtime 集成（简要，非本次重点）

docs/concepts/agent-runtimes.md：

- runtime 两大类：**embedded harness**（内置 `openclaw` loop，以及插件 harness `codex` = Codex app-server、`copilot`）和 **CLI backend**（如 `claude-cli`：拉起本地 CLI，`jsonlDialect: "claude-stream-json"`，`liveSession: "claude-stdio"` 表示长驻进程；见 docs/plugins/cli-backend-plugins.md 和 `src/agents/cli-output-records.ts`）。Claude Code 或其他外部 harness 也可以走 ACP/acpx。
- Codex app-server 下，canonical thread 归 Codex，OpenClaw 保存一份 transcript mirror；steer 映射到 `turn/steer`；Codex 的 preamble/commentary 走与工具进度相同的 preview 路径。
- 不管哪种 runtime，最后都汇成 §5.1 的 `AgentEventPayload` 和 §4.6 的回调。**channel 不感知 runtime**。

---

## 9. 语音、会议、邮件：不是 channel

- 会议（google-meet / teams-meetings / zoom-meetings / slack-huddles）是独立的 **meeting plugin**，"separate from messaging channels"（docs/plugins/meeting-plugins.md）。有三种模式：
  - `agent`：实时转写 → OpenClaw agent → TTS 播报；
  - `bidi`：实时语音模型直接对话，需要时委派给 agent；
  - `transcribe`：只旁听转写。
- Voice Call：实时模型通过共享的 `openclaw_agent_consult` 工具委派给完整 agent（GPT-Live 用原生 delegation）。consult 的 session key 优先复用通话 session，否则按 `sessionScope`（`per-phone` 默认 / `per-call` / `main`）决定（docs/plugins/voice-call/realtime-and-streaming.md:31-38）。**这正是"实时语音前端 + 慢 agent 后端"的模式**，适用于小米音箱。
- IMAP 是 "email trigger" 插件（extensions/imap/openclaw.plugin.json：`"Watch IMAP mailboxes and dispatch authenticated incoming email to isolated agent sessions"`），不是完整 channel。
- Feishu 文档评论（`drive.notice.comment_add_v1` → comment-handler/comment-dispatcher）和会议邀请都被 Feishu 插件当成入站事件处理。

---

## 10. 对我们设计的启示

1. **要统一协议，但分三层**：
   - (a) **入站事实**（sender/conversation/reply/message/media/supplemental/access）：插件填，core 渲染 prompt；
   - (b) **agent 事件流**（`{runId, seq, stream, ts, data}`，stream 是可扩展的字符串枚举）：runtime 适配器产出；
   - (c) **出站载荷**（`ReplyPayload` + lane 标志 + 可移植 `presentation` + `channelData` 逃生口）：channel 按**能力声明**渲染或降级。
   OpenClaw 用的 `MsgContext` 是个巨大的扁平 struct，带着沉重的历史包袱。我们可以一开始就做成分组的 facts 结构（它的 `buildContext` 参数形状已经是分组的，值得直接抄）。
2. **输出 = 订阅 session 事件流**：OpenClaw 对 UI 类客户端已经这么做了（`sessions.messages.subscribe`，支持 full/narration 两档、先订阅后快照、按 id 对账、seq）。但它的 IM channel 仍是按 turn 回调、只回原路。我们可以更进一步，把 IM channel 也当订阅者：每个 subscriber 声明"渲染档位"（full / progress / final-only / narration），同时保留"回原路"作为默认投递策略。
3. **多端输入同一个 session**：必须有 per-session lane 和 queue mode（steer/followup/collect/interrupt），并且要回答"谁的权限"。OpenClaw 的规则是"同权限可以 steer，不同权限降级为 followup，turn 保留原 owner 的权限"。
4. **中间过程可见**：做一个 channel 无关的 progress compositor，输入是 item/tool/plan/approval/command_output/patch 事件，输出是"进度草稿快照"。channel 只需实现 `draftPreview/edit/finalize/delete` 这些原语，加能力声明和契约测试。默认安静，审批永远可见。
5. **私有通道扩展**：最小 adapter 只需要 `config.resolveAccount`、`gateway.startAccount(ctx{abortSignal, channelRuntime})`、`outbound.sendText/sendMedia`，再加可选的 `security.dm` 和 `pairing`。其他能力都可选，并通过 capability 声明。
6. **异构事件**（会议邀请、文档评论、卡片按钮）：OpenClaw 把它们合成为消息走同一条管道，或用 `ChannelEventClass.kind = interaction|reaction|lifecycle` 区分。我们可以直接给 inbound event 一个 `kind` 和 `canStartAgentTurn`。
7. **语音**：实时模型前端 + `agent_consult` 委派后端，session 复用 call session 或按人或 main 决定。

