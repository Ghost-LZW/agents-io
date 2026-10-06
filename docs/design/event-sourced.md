# agents-io 设计提案：Event-sourced Session Bus

> 视角：**agent session 是一条持久的、只追加、带单调 seq 的事件日志**。每个端（飞书 bot、飞书会议、小米音箱、邮件、Web、私有通道）都同时是：
> 1. 一个 **subscriber**：拿 cursor 订阅日志，用自己的 projection/renderer 把事件画成本端形态；
> 2. 一个 **input producer**：把本端输入写成 `InputCommand`，由 session 的唯一写者（Sequencer）决定接纳、排队、steer 还是拒绝。
>
> 本文把这个视角推到最强：**连"回复投递"也只是一种带投递义务的订阅**；连"审批""投递回执""渲染锚点（卡片 id）"也都是事件。runtime（Claude Code / Codex）只是挂在总线上的另一对 producer/consumer。
>
> 证据来源：`docs/research/*.md` 与 scratchpad 下的 happyclaw / botmux / openclaw / multica 源码，以及 Claude Agent SDK 的 `sdk.d.ts` / `browser-sdk.d.ts` / `bridge.d.ts`、Codex app-server 0.160.1 生成的 schema。推测的地方标注为【推测】。

---

## 0. 直接回答用户的问题

| 问题 | 结论（一句话） | 依据 |
|---|---|---|
| 维护统一 IO 协议，还是每个工具独立处理？ | **统一在 gateway 的两个接缝上**：runtime→总线（canonical 事件）、总线→端（订阅协议 + 渲染原语）。**不统一**的是各 runtime 的原生协议本身（直接用 Claude stream-json、Codex app-server）和各端的原生渲染（CardKit、邮件 HTML、TTS）。canonical 事件里永远附带 `raw` 原生 payload 作逃生口。 | openclaw 所有 runtime 投影进同一个 `AgentEventPayload`（`src/infra/agent-events.ts`），channel 不知道哪个 runtime 跑的；happyclaw 一个 `shared/stream-event.ts` 被 runner/server/web 共用；multica 7 种 `agent.Message` 覆盖 20+ CLI。反例：botmux 没有总线，`WorkerToDaemon` 被各 CLI 专属字段（codexApp*、mojo*…）污染，每加一个端就要再接一条通道。 |
| 什么形态能接受最广泛的输入、做到最广泛的输出？ | 输入：**窄 envelope + 内容块数组（text/image/audio/file/ref）+ origin + replyTo 路由键**，平台私有部分放 `raw`（core 不读）。非消息事件（会议邀请、文档评论、webhook、定时）统一转成 `InputCommand`，可设 `admission: observeOnly`（只入日志不开 turn）。输出：**分层事件 + 分级（displayLevel）+ 每端声明能力**，core 按能力降级；同时把"发到某端"也做成 agent 可调用的工具（MCP），让 agent 主动选择输出形态。 | multica `InboundMessage{… Raw json.RawMessage}` + `Capability` 位掩码；openclaw `ChannelEventClass` + admission `dispatch|observeOnly|handled|drop`、飞书 VC 邀请转 synthetic DM（`monitor.vc-meeting-invited-handler.ts`）；happyclaw MCP `send_message/send_image/send_file`；botmux `botmux send`；openclaw 共享 `message` tool。 |
| 输出是不是可以认为是"订阅某个 agent 的输出"？能多端展示？ | **是，而且要更彻底**：订阅的是 *session 日志*（不是某次 run 的回调）。Web/移动端是 full 订阅；IM 端是带 *投递义务* 的 progress/final 订阅（默认只对"源自本路由的 turn"有义务）；音箱是 narration 订阅；会议大屏是只读镜像订阅。late join / 重连靠 `fromSeq` + snapshot。 | openclaw `sessions.messages.subscribe {key, mode: full|narration}`，"passive views of runs started by another client"；happyclaw `broadcastStreamEvent` + `StreamingSnapshotEntry` + `active_run_snapshot`；Claude Remote Control 的 `fromSequenceNum` / `catch_up_truncated`（`browser-sdk.d.ts:52`）；Codex app-server 每个 thread 广播给所有已订阅连接（`outgoing_message.rs`）。 |
| 输入能不能也多端输入？ | **能**。所有端的输入都进同一个 session 的单写者 lane；冲突由 policy 决定：`queue / steer / collect / interrupt`，steer 带 `expectedTurnId` 乐观并发，权限不能借用（不同权限的人只能 followup），每个 turn 只有一个回复目的地。 | openclaw `messages.queue.mode`（默认 steer、500ms debounce、collect 按 channel/thread 分开 drain）；happyclaw `GroupQueue` + `FollowUpMode queue|steer` + `/break`，不同 route 绝不合批；Codex `turn/steer {expectedTurnId}`；Claude `SDKUserMessage.priority: 'now'|'next'|'later'`（`sdk.d.ts:6230`）。 |
| 想看到中间过程 | 中间过程本来就在日志里（item 生命周期 + delta）。每端只是选不同 tier：Web 全量 trace；飞书卡片 = progress-draft（headline/plan/工具行/审批）+ 深链到 Web trace；音箱只念 primary 级旁白；邮件只收 final + trace 链接。 | happyclaw `displayLevel primary|detail|debug` + 飞书卡片 `buildWebTraceUrl`；openclaw progress-drafts（`src/channels/progress-draft-compositor.ts`）；botmux 飞书原生 CoT 气泡（`src/im/lark/cot-message.ts`）。 |

---

## 1. Thesis（推到最强形态）

**一切 IO 都是同一条 session 日志上的读与写。** 具体而言：

1. **Session Log 是唯一的 IO 事实源**（不是 runtime 的上下文事实源，见 §8 ownership）。日志里有：输入（submitted/admitted/queued/steered/rejected）、turn 生命周期、item 生命周期与 delta、审批请求与裁决、用量、投递回执、渲染锚点。
2. **Sequencer 是每个 session 的唯一写者**，分配无空洞的 `seq`。这一点 Claude Code 自己就要求（"Two processes can't write to the same transcript"），openclaw 用 `activeWriterRunId` CAS，Claude bridge 用 `epoch` 防多 worker 同时写。我们把它提升为整个 gateway 的核心不变量。
3. **Runtime adapter = 投影器 + 执行器**：消费日志里 `input.admitted` 并调用 Claude/Codex 原生协议；把原生事件投影成 canonical 事件追加回日志。它不直接跟任何端说话。
4. **Channel adapter = 输入 producer + 渲染器**：无状态（状态 = cursor + 锚点，都由 core 存成事件），只实现平台原语（post/edit/delete/react/typing/speak）。
5. **"回复"不是特殊路径**：每个 turn 在 `turn.started` 上写死 `replyTo`（继承自触发它的输入）。路由 X 的订阅者对 `replyTo == X` 的 turn 有 *投递义务*（durable cursor、必须 ack、写 `delivery.*` 事件）；对其它 turn 只是 *观察*（可选、可丢）。这把 happyclaw 刻意分开的 "projection vs delivery" 统一成同一机制的两种订阅语义，同时保留它的业务规则（"Reply transport belongs to an input, never to a workspace or old session"，`src/channel-reply-source.ts:8`）。
6. **审批是日志事件 + 竞争消费**：`request.opened` 广播给所有具备审批权的订阅者，第一条 `request.resolve` 赢，Sequencer 写 `request.resolved`，其它端据此撤卡。这正是 Codex app-server 的语义（first answer wins + `serverRequest/resolved` + 对 late joiner 重放 pending request），也是 Claude Remote Control/Channels permission relay 的语义（先到先得）。
7. **端可以无限加**：加一个端 = 写一个 subscriber + 一个 producer，不碰 runtime；加一个 runtime = 写一个 projector，不碰任何端。

---

## 2. 架构

```
                         ┌──────────────────────── agents-io gateway ────────────────────────┐
  Producers / Subscribers│                                                                   │
  (Channel adapters)     │   InputCommand                                                    │
                         │  ───────────────▶ ┌────────────┐  admit/queue/steer   ┌─────────┐ │
 飞书 bot ──┐            │                   │ Ingress    │─────────────────────▶│Sequencer│ │
 飞书会议 ──┤ in-proc     │  (dedup, identity,│ Resolver   │                      │(1 writer│ │
 小米音箱 ──┤ plugin      │   route, policy)  └────────────┘                      │ /session│ │
  (realtime)│   or        │                                                        │ lane)   │ │
 邮件 ──────┤ out-of-proc │                                                        └────┬────┘ │
 Web/移动 ──┤ JSONL/WS    │                            append(seq++)                     │      │
 私有通道 ──┘ protocol    │                 ┌──────────────────────────────────────────▼────┐ │
      ▲                   │                 │   Session Log  (append-only, per session)     │ │
      │                   │                 │   hot segment: deltas  | cold: items/turns   │ │
      │  render(events)   │                 │   + snapshots @seq     | + compaction horizon │ │
      │                   │                 └───────┬───────────────────────────▲───────────┘ │
      │                   │       subscribe(fromSeq, │tier, filter)              │ append      │
      │   ┌───────────────┴──────┐                   │                           │ canonical   │
      └───│ Subscription Hub     │◀──────────────────┘                    ┌──────┴────────┐    │
          │ per-sub cursor,      │                                        │ Runtime       │    │
          │ tier/filter, ack,    │   input.admitted ─────────────────────▶│ Adapters      │    │
          │ outbox (obligated),  │                                        │  claude-cli   │    │
          │ progress compositor, │                                        │  codex-app    │    │
          │ capability degrade   │                                        │  (acp fallback)│   │
          └──────────────────────┘                                        └──────┬────────┘    │
                         │                                                       │             │
                         └───────────────────────────────────────────────────────┼─────────────┘
                                                                                 │ native protocol
                                         claude -p --input-format stream-json ...│ (stdio NDJSON +
                                         codex app-server --listen stdio|ws ...  │  control_request /
                                                                                 ▼  JSON-RPC)
                                                                    Claude Code / Codex 进程
                                                         (可选：codex --remote TUI 作为第二个原生客户端)
```

组件职责：

- **Ingress Resolver**：dedup（openclaw `channel+peer+account+thread+msgid` 20min TTL；multica 两阶段 Claim-Mark-Release）、身份（allowlist、pairing、identityLinks）、路由到 `sessionKey`、admission（dispatch/observeOnly/drop）、permission class。照抄 openclaw `ingress.resolve` 与 multica `ResolverSet` 的拆法。可选 durable ingress：先存原始 envelope 再 ack（openclaw `ingress-queue.ts`）。
- **Sequencer**：每个 session 一个串行 lane（openclaw `session:<key>`、happyclaw `GroupQueue`），唯一写者，执行 follow-up policy，分配 seq，fence 过期 attempt（happyclaw `streamRunFence.observeExact(queryRunId, turnId)`；openclaw `emitAgentEventIfCurrent`；botmux turnId+dispatchAttempt；remote-runner generation）。
- **Session Log**：append-only 存储。热段放 delta，冷段放 item/turn 完成事件；周期 snapshot。MVP 用 SQLite（happyclaw、openclaw ingress 都用 SQLite）；多副本时换 Postgres + Redis Stream（multica `ws:scope:{type}:{id}:stream`）。
- **Subscription Hub**：管理订阅者（cursor、tier、filter、背压 `dropIfSlow`、ACL）。对有投递义务的订阅做 durable outbox（happyclaw `channel-outbox-delivery.ts`：enqueue/claim/sending/complete/fail + idempotent chunkIndex）。内置 progress-draft compositor 与 presentation 降级（openclaw）。
- **Runtime Adapters**：见 §5。

---

## 3. 事件 schema（canonical）

设计原则（每条都有出处）：

- **判别联合，不是扁平可选字段袋**。happyclaw `StreamEvent` 是一大包 optional 字段（他们自己的 `docs/RUNTIME-ARCHITECTURE.md` rule 6 要求改成 typed contracts）；openclaw wire 上 `data: Record<string, unknown>` 只靠约定、只有 `ChatEvent` 闭合。我们用闭合 union + 开放的 `ext.*` 命名空间。
- **核心词汇以 Codex app-server 的 Thread/Turn/Item 为骨架**（item started → delta → completed，`serverRequest` → resolved），Claude stream-json 映射进来。理由：它是两者中更规整的一个，openclaw/multica 的 Codex projector 都几乎 1:1 映射。
- **同时有原始层与语义层**：`item`（工具调用带 args/result）和 `activity`（title/status/summary/hideFromChannelProgress，给 IM 进度卡），照抄 openclaw `tool` vs `item(AgentActivityItemSchema)` 两层。
- **每个事件带 `level` 与 `scope`**（happyclaw `displayLevel`、`agentScope`），让每端选保真度。
- **`raw` 永远保留**（happyclaw `raw_sdk_event`、OpenClawEvent `raw`、multica `Raw`），但存成单独 blob、默认不推给端。
- **用量只用 runtime 原生上报，缺了留空**（botmux 原则）。

```ts
// ---------- 公共信封 ----------
type SessionId = string;            // 物理代际：reset/new 时轮换（openclaw sessionId vs sessionKey）
type SessionKey = string;           // 逻辑地址：agent:<id>:main / agent:<id>:feishu:group:<chat>:thread:<t>
type RouteKey = string;             // provider:account:chat[:thread[:root]]，happyclaw channel-address.ts 风格

interface Envelope<B extends Body = Body> {
  v: 1;
  sessionKey: SessionKey;
  sessionId: SessionId;
  seq: number;                      // per-session 无空洞单调，由 Sequencer 分配
  id: string;                       // ULID，全局唯一，幂等键
  ts: number;
  epoch: number;                    // runtime binding 代际（重启/换 runtime 时 +1），旧代事件拒收
  turnId?: string;
  attemptId?: string;               // 重试/failover 的 attempt；fence 用
  itemId?: string;
  parentItemId?: string;            // 子代理/Task 嵌套（Claude parent_tool_use_id、Codex subAgentActivity）
  scope: 'main' | 'subagent' | 'task' | 'system';
  level: 'primary' | 'detail' | 'debug';
  visibility: 'participants' | 'operators' | 'internal'; // internal 永不出 gateway（happyclaw context_audit 不发浏览器）
  durability: 'durable' | 'ephemeral';                   // ephemeral = delta，turn 结束后可被 compaction
  causedBy?: { inputId?: string; requestId?: string };
  body: B;
  rawRef?: { runtime: RuntimeId; blobId: string };       // 原生 payload，按需拉取
}

// ---------- Body 判别联合 ----------
type Body =
  // session
  | { t: 'session.opened'; agentId: string; runtime: RuntimeId; nativeRef?: NativeRef }
  | { t: 'session.runtime_bound'; runtime: RuntimeId; nativeRef: NativeRef; capabilities: RuntimeCaps }
  | { t: 'session.state'; state: 'idle' | 'running' | 'requires_action' | 'stalled' | 'error' } // Claude session_state_changed / Codex thread/status/changed
  | { t: 'session.reset'; reason: 'new' | 'clear' | 'fresh'; nextSessionId: SessionId }
  | { t: 'session.snapshot'; atSeq: number; blobId: string }

  // input（输入也是事件）
  | { t: 'input.submitted'; input: InputRecord }
  | { t: 'input.admitted'; inputId: string; disposition: 'new_turn' | 'steer' | 'queued' | 'collected' | 'observe_only'; turnId?: string }
  | { t: 'input.consumed'; inputIds: string[]; turnId: string } // Claude result 的 user_message_uuids；Codex userMessage item
  | { t: 'input.rejected'; inputId: string; reason: 'unauthorized' | 'stale_turn' | 'duplicate' | 'policy' | 'runtime_unsupported' }
  | { t: 'input.cancelled'; inputIds: string[]; by: Origin }   // /break 取消队列（happyclaw）
  | { t: 'input.observed'; input: InputRecord }                 // 由原生第二客户端（codex --remote TUI）发起、gateway 旁听到的输入

  // turn
  | { t: 'turn.started'; turnId: string; inputIds: string[]; replyTo: RouteKey | null; owner: PrincipalRef; mode: 'assistant' | 'proactive' }
  | { t: 'turn.plan'; steps: { text: string; status: 'pending' | 'running' | 'done' }[] } // Codex turn/plan/updated、Claude TodoWrite
  | { t: 'turn.diff'; unifiedDiff?: string; files: { path: string; op: 'add' | 'modify' | 'delete' }[] }
  | { t: 'turn.completed'; status: 'completed' | 'interrupted' | 'failed' | 'ambiguous'; finalItemId?: string; usage?: Usage; error?: { kind: string; message: string; retryable: boolean } }

  // item（原始层）
  | { t: 'item.started'; item: ItemHead }
  | { t: 'item.delta'; channel: 'text' | 'reasoning' | 'command_output' | 'tool_input'; delta: string } // ephemeral
  | { t: 'item.progress'; elapsedMs?: number; message?: string }      // Claude tool_progress / Codex mcpToolCall/progress
  | { t: 'item.completed'; item: ItemFull }

  // activity（语义层，给进度卡/旁白）
  | { t: 'activity'; activityId: string; phase: 'start' | 'update' | 'end'; kind: string; title: string;
      status?: 'running' | 'completed' | 'failed' | 'blocked' | 'skipped'; summary?: string; hideFromChannelProgress?: boolean }
  | { t: 'narration'; text: string; atSeq: number }                    // 节流的可见尾部摘要（openclaw session.narration ≤16k/2s）

  // 人在回路
  | { t: 'request.opened'; requestId: string; kind: 'tool_approval' | 'file_change' | 'permissions' | 'question' | 'elicitation';
      title: string; preview: string /* 已脱敏截断 */; options: Decision['kind'][]; expiresAt?: number; eligible: PrincipalSelector }
  | { t: 'request.resolved'; requestId: string; decision: Decision; by: Origin | 'timeout' | 'runtime_cancelled' }

  // 用量 / 系统
  | { t: 'usage'; usage: Usage }                                      // 只用原生上报
  | { t: 'system.notice'; code: 'compacting' | 'api_retry' | 'rate_limited' | 'hook' | 'runtime_restart'; message: string; data?: unknown }

  // 投递与渲染（端的副作用也是事件 → 可审计、可重启恢复）
  | { t: 'delivery.attempted'; subscriberId: string; turnId: string; operationId: string; chunk: number }
  | { t: 'delivery.settled'; subscriberId: string; operationId: string; result: 'delivered' | 'rejected' | 'unknown'; providerMessageId?: string }
  | { t: 'render.anchor'; subscriberId: string; turnId: string; anchor: { kind: 'card' | 'message' | 'thread'; providerId: string; leaseUntil?: number } }

  // 逃生口：runtime/通道特有，namespaced
  | { t: `ext.${string}`; data: unknown };

type ItemKind = 'user_message' | 'agent_message' | 'reasoning' | 'command' | 'file_change' | 'mcp_tool' | 'tool'
              | 'subagent' | 'web_search' | 'image' | 'compaction' | 'hook';
interface ItemHead { id: string; kind: ItemKind; name?: string /* tool name */; inputSummary?: string; phase?: 'commentary' | 'final_answer' }
interface ItemFull extends ItemHead {
  status: 'completed' | 'failed' | 'declined';
  text?: string;                       // agent_message / reasoning 完整文本（delta compaction 的落点）
  args?: unknown; result?: unknown; resultTruncated?: boolean | null; // null = 未知（multica 三态）
  exitCode?: number; durationMs?: number;
  attachments?: ContentPart[];
}

// ---------- 输入 ----------
type Origin =
  | { kind: 'human'; principal: PrincipalRef; via: RouteKey }           // 飞书/邮件/Web/音箱上的人
  | { kind: 'channel_event'; via: RouteKey; event: string }             // 会议邀请、文档评论（不可信，trusted=false）
  | { kind: 'system'; source: 'schedule' | 'webhook' | 'api'; id: string }
  | { kind: 'peer'; fromSession: SessionKey }                           // 其它 agent，不能审批不能改配置（Claude SDKMessageOrigin peer 语义）
  | { kind: 'native_client'; clientInfo: string };                      // codex --remote TUI 等

interface PrincipalRef { userId: string; trust: 'verified' | 'asserted' | 'unverified'; permissionClass: string } // openclaw 分级信任

type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; ref: BlobRef; mime: string }
  | { type: 'audio'; ref: BlobRef; mime: string; transcript?: string }
  | { type: 'file'; ref: BlobRef; name: string; mime: string }
  | { type: 'quote'; ofRoute: RouteKey; messageId: string; text: string }
  | { type: 'ref'; uri: string; title?: string };                       // 指针（multica：prompt 放指针，agent 用工具拉全量）

interface InputRecord {
  inputId: string;                    // = idempotencyKey
  origin: Origin;
  content: ContentPart[];
  replyTo: RouteKey | null;           // 不可变；null = 不要回复（observe_only / proactive）
  channelContext: Record<string, string | number | boolean>; // credential-free、allowlist 归一化（happyclaw ChannelTurnContext）
  rawRef?: BlobRef;                   // 平台私有原文，core 不读
}

type InputCommand =
  | { cmd: 'submit'; input: InputRecord; policy: 'auto' | 'queue' | 'steer' | 'collect' | 'interrupt';
      expectedTurnId?: string; admission?: 'dispatch' | 'observe_only' }
  | { cmd: 'resolve'; requestId: string; decision: Decision; origin: Origin }
  | { cmd: 'interrupt'; turnId?: string; cancelQueue?: boolean; origin: Origin }
  | { cmd: 'control'; op: 'set_model' | 'set_effort' | 'set_permission_mode' | 'reset'; arg?: string; origin: Origin };

type Decision =
  | { kind: 'allow_once' } | { kind: 'allow_session' } | { kind: 'deny'; message?: string }
  | { kind: 'answer'; answers: Record<string, string | string[]> } | { kind: 'amend'; updatedInput: unknown };
```

### 3.1 delta 与 compaction（让"日志"在 token 级流式下也撑得住）

- `item.delta` 是 `ephemeral`：进热段（内存环 + 可选 WAL），seq 与 durable 事件共享同一序列，因此订阅者的 cursor 语义一致。
- `item.completed` 必须携带完整文本/结果。turn 结束后，热段 delta 可以丢弃，`compactionHorizon` 前移。
- 订阅 `fromSeq < compactionHorizon` → 先发 `session.snapshot`（物化视图：partialText、activeTools、pending requests、todos、systemStatus，相当于 happyclaw `StreamingSnapshotEntry` 的持久版）再续推。这是 Claude bridge `catch_up_truncated` + REST 回补、openclaw "first frame carries full message snapshot" 的统一版本，并补上 openclaw 自认的缺陷（"Events are not replayed. Clients must refresh on gaps"）与 Codex 通知无 seq 的缺陷。
- 累积全量 vs 增量：对 CoT/工具时间线类低频投影，Hub 可以给订阅者推"累积全量 + seq"（botmux CotEntry 做法，天然幂等，适合 IM edit），对 Web 推真增量。

---

## 4. 订阅协议与 Channel Adapter 接口

### 4.1 订阅

```ts
interface SubscribeRequest {
  subscriberId: string;               // 稳定 id → durable cursor（如 "feishu:acct1:chatX"、"web:conn-uuid"）
  sessionKey: SessionKey;
  fromSeq?: number;                   // 缺省 = 当前 head（只看新的）
  tier: 'full' | 'progress' | 'final' | 'narration';
  obligation: 'origin' | 'mirror' | 'none';
  //  origin: 对 replyTo==我的路由 的 turn 负有投递义务（durable、ack、outbox）
  //  mirror: 对所有 turn 投递（需显式授权，见 §6.3）
  //  none  : 纯观察，可丢、可降级（dropIfSlow）
  filter?: { levels?: Envelope['level'][]; scopes?: Envelope['scope'][]; optOut?: Body['t'][] }; // Codex optOutNotificationMethods
  caps: string[];                     // 例如 'approvals', 'tool-events', 'audio-out'（openclaw connect caps）
}
```

Tier 到事件的投影（core 实现，端不用自己写）：

| tier | 收到什么 | 典型端 |
|---|---|---|
| full | 全部 participants 可见事件 + delta | Web、移动端、桌面、会议大屏 |
| progress | turn.*、activity、turn.plan、request.*、agent_message 的累积文本（节流）、final | 飞书 bot 卡片、Telegram/Slack 类 |
| final | turn.started（用于 typing）、request.*（若有 caps approvals）、final agent_message、turn.completed | 邮件、微信、短信类、私有低能力通道 |
| narration | narration 快照（≤16k、≥2s 间隔）+ final 的口语摘要 + request.*（语音可答）| 小米音箱、手表、侧栏 |

### 4.2 Channel Adapter（私有通道实现这个）

两种形态：**in-process 插件**（TS）与 **out-of-process 协议**（任意语言，JSONL over stdio 或 WS；协议形状借 botmux remote-runner：版本化、hello 时做 capability 协商、generation 栅栏、外发不允许对端指定路由）。私有通道强烈建议后者，这样 gateway 不需要 fork（botmux/happyclaw 的通道都是闭集，加私有通道要改 7-8 处核心代码，这是我们要避免的）。

```ts
interface ChannelAdapter<Account = unknown> {
  id: string;                                   // 'feishu' | 'mail' | 'xiaomi' | 'acme-im' ...
  capabilities: ChannelCaps;
  // —— 生命周期（openclaw gateway.startAccount / multica Connect 阻塞收循环）
  start(ctx: ChannelContext<Account>): Promise<void>;   // 阻塞直到 ctx.signal abort；断线抛错由 supervisor 退避重连
  // —— 渲染原语（core 的 compositor 调这些；不支持的不实现）
  surface: Surface;
}

interface ChannelContext<Account> {
  account: Account;
  signal: AbortSignal;
  submit(cmd: InputCommand, raw?: unknown): Promise<{ accepted: boolean; inputId: string; disposition?: string }>;
  resolveRoute(addr: { chat: string; thread?: string; root?: string; sender: string }): RouteKey;
  log: Logger;
}

interface Surface {
  post(route: RouteKey, msg: OutboundMessage, op: OpMeta): Promise<{ providerMessageId: string }>;
  edit?(route: RouteKey, providerMessageId: string, msg: OutboundMessage, op: OpMeta): Promise<void>;
  remove?(route: RouteKey, providerMessageId: string): Promise<void>;
  stream?(route: RouteKey, op: OpMeta): Promise<StreamHandle>;          // 原生流式（飞书 CardKit、钉钉 AI Card、Slack agent card）
  typing?(route: RouteKey, on: boolean): Promise<void>;
  react?(route: RouteKey, messageId: string, emoji: string | null): Promise<void>;
  speak?(route: RouteKey, utterance: { text: string; interruptible: boolean }): Promise<void>; // 语音端
  renderRequest?(route: RouteKey, req: RequestView, op: OpMeta): Promise<{ providerMessageId: string }>; // 审批/提问卡
  retractRequest?(route: RouteKey, providerMessageId: string, outcome: string): Promise<void>;
  reconcile?(anchor: Anchor): Promise<'alive' | 'gone'>;               // 重启后对 durable 卡片 lease 做对账（happyclaw reconcileStreamingCard）
}

interface StreamHandle { append(fullText: string): Promise<void>; setDetails(view: ProgressView): Promise<void>; finish(final: OutboundMessage): Promise<void>; abort(reason: string): Promise<void> }

interface OpMeta { operationId: string; chunkIndex: number; turnId: string }   // 幂等键（happyclaw deliveryId+chunkIndex；botmux operationId）

interface ChannelCaps {
  text: { maxChars: number; markdown: 'full' | 'basic' | 'none' };
  edit: boolean; nativeStream: boolean; maxEditsPerSec?: number;  // 飞书 CardKit：10 QPS/卡、30KB、200 组件、流式 10 分钟自动关
  presentation: ('buttons' | 'select' | 'table' | 'card')[];
  media: ('image' | 'file' | 'audio' | 'video')[];
  threads: boolean; approvals: boolean; voice: 'none' | 'tts' | 'full_duplex';
  defaultTier: SubscribeRequest['tier'];
}

type OutboundMessage = {
  text?: string; spokenText?: string;                     // openclaw ReplyPayload.spokenText
  presentation?: Presentation;                            // portable：title/tone/blocks(text|context|divider|buttons|select|table)
  media?: ContentPart[];
  lane: 'answer' | 'progress' | 'reasoning' | 'status' | 'error';
  deepLink?: string;                                      // Web trace：/s/<key>?turn=<id>&trace=1
  channelData?: unknown;                                  // 通道私有逃生口
};
```

out-of-process 版本就是把上述方法变成帧：gateway→adapter `{type:'post'|'edit'|'stream.append'|'request.render'|...}`，adapter→gateway `{type:'submit'|'op_result{operationId, result: delivered|rejected|unknown}'|'status'}`。规则照抄 remote-runner：`unknown` 不自动重放（避免重复发送）；adapter 不能在出站帧里指定 route 以外的目的地。

一个最小私有通道只要：`start()` 里收消息调 `ctx.submit`，加一个 `surface.post`。其它全靠 capability 声明，由 core 降级（final tier、无 edit、纯文本）。这对应 openclaw `createChatChannelPlugin` 约 80 行的最小插件，以及 multica `Channel{Type, Connect, Disconnect, Send, Capabilities}`。

### 4.3 Projector/Compositor 在 core

openclaw 的教训：进度通过一长串每 turn 回调（`onToolStart/onItemEvent/onPlanUpdate/...`）给到 channel，导致飞书 `reply-dispatcher.ts` 约 1600 行；happyclaw 的 `feedStreamEventToCard` 里有 `instanceof StreamingCardController` 特例。我们让 core 的 `ProgressCompositor` 从日志 fold 出 `ProgressView{headline, plan, tools[], pendingRequests[], text, status}`，端只拿 view 调 `stream.setDetails` 或 `edit`。quiet-by-default（openclaw：headline/plan/审批始终可见，工具行 opt-in，命令文本默认 status 而非 raw）。

---

## 5. Runtime Adapter 接口（Claude Code / Codex）

```ts
type RuntimeId = 'claude-code' | 'codex' | `acp:${string}`;

interface RuntimeCaps {
  steer: 'native' | 'tool_boundary' | 'none';      // Codex turn/steer = native；Claude priority:'next' = tool_boundary
  interrupt: boolean; approvals: boolean; questions: boolean;
  tokenDeltas: boolean; multiNativeClient: boolean;   // Codex app-server 可多客户端
  realtimeVoice: boolean;                             // Codex thread/realtime（experimental）
  resume: boolean; fork: boolean; ownsCompaction: boolean;
}

interface RuntimeAdapter {
  id: RuntimeId;
  probe(): Promise<{ version: string; caps: RuntimeCaps }>;     // 版本钉死 + 断言（openclaw assertSupportedCodexAppServerVersion）
  open(b: RuntimeBinding, sink: CanonicalSink): Promise<RuntimeSession>;
}

interface RuntimeBinding { sessionKey: SessionKey; epoch: number; nativeRef?: NativeRef; cwd: string; env: Record<string, string>;
  mcpGatewayUrl: string; mcpToken: string;            // 宿主工具 loopback MCP，一次运行一个 token（openclaw OPENCLAW_MCP_TOKEN）
  permissionMode: 'ask' | 'auto' | 'bypass'; }
type NativeRef = { kind: 'claude'; sessionId: string } | { kind: 'codex'; threadId: string; endpoint?: string };

interface RuntimeSession {
  startTurn(t: { turnId: string; inputs: InputRecord[] }): Promise<void>;
  steer?(t: { inputs: InputRecord[]; expectedTurnId: string }): Promise<'accepted' | 'stale' | 'unsupported'>;
  interrupt(turnId: string): Promise<void>;
  respond(requestId: string, d: Decision): Promise<void>;
  close(reason: string): Promise<void>;
}
interface CanonicalSink { emit(b: Body, meta: Partial<Envelope>, raw?: unknown): void }  // adapter 不分配 seq
```

### 5.1 Claude Code（`claude-code` adapter）

- 启动：`claude -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages --replay-user-messages --permission-prompt-tool stdio [--resume <sid>] [--mcp-config ...]`（openclaw `extensions/anthropic/cli-runtime-args.ts`；multica `claude.go:1078 buildClaudeArgs`）。进程常驻跨 turn（openclaw `liveSession: 'claude-stdio'`）。或者用 Agent SDK `query({prompt: AsyncIterable<SDKUserMessage>})`（happyclaw `container/agent-runner/src/index.ts:2826`）——两者是同一线协议。
- 输入：`SDKUserMessage{type:'user', message, priority?:'now'|'next'|'later', origin?}`（`sdk.d.ts:6230`）。steer = `priority:'next'`（在工具调用之间并入当前 turn）；interrupt+立即读 = `'now'`；followup = `'later'`。旧版本退回 multica `claude_supplement.go`：hook `additionalContext` + Stop hook 续跑。`input.consumed` 用 result/stream_event 上的 `user_message_uuid(s)` 写出。
- 输出映射：`stream_event`(text/thinking delta) → `item.delta`；assistant `tool_use` → `item.started{kind:'tool'}`；user `tool_result` → `item.completed`；`tool_progress` → `item.progress`；`system/task_*` → `item.*{kind:'subagent'}` + `parentItemId = parent_tool_use_id`；`session_state_changed` → `session.state`；`compact_boundary`/`status` → `system.notice`；`result` → final `agent_message` + `turn.completed{usage}`；`api_retry` → `system.notice`。
- 审批：`control_request{subtype:'can_use_tool', tool_name, input, permission_suggestions}` → `request.opened`；裁决 → `control_response{behavior, updatedInput}`；`control_cancel_request` → `request.resolved{by:'runtime_cancelled'}`。按 request_id 去重（openclaw `cli-transport.ts:205`）。AskUserQuestion → `request.opened{kind:'question'}`（botmux 用 PreToolUse hook 转飞书卡，答案以 directive 回写）。
- **有损点**：Workflow/hook 细节只能进 `ext.claude.*`；没有原生多客户端（gateway 必须是唯一宿主，transcript 单写者）；Remote Control 依赖 claude.ai 订阅不能当总线；stdout 没人读会死锁（multica 有记录）→ adapter 必须持续 drain；`priority` 字段受版本约束【推测：`'now'` 需 v2.1.286+，来自研究笔记，未逐版本核对】；Channels（`notifications/claude/channel`）在 `-p`/SDK 下自研通道需 dev flag 且被忽略，所以**不用 Claude Channels 作为输入路径**。

### 5.2 Codex（`codex` adapter）

- 启动：`codex app-server --listen stdio://`（multica `codex.go:357`、openclaw `transport-stdio.ts`），或 `--listen ws://127.0.0.1:PORT` + `--ws-auth`（botmux `codex-rpc-engine.ts:305`），以便让官方 `codex --remote ws://.. resume <id>` TUI 作为第二客户端观看（botmux hybrid 模式已验证）。
- 输入：`turn/start {threadId, input: UserInput[], clientUserMessageId}`；steer = `turn/steer {expectedTurnId}`（stale 时返回失败 → `input.rejected{stale_turn}` 或降级为 queued）；`turn/interrupt`；`thread/inject_items` 可用于 observe_only 的上下文注入【推测：语义未实测】。
- 输出映射几乎 1:1：`item/started|completed` → `item.*`；`item/agentMessage/delta`、`item/reasoning/summaryTextDelta`、`item/commandExecution/outputDelta` → `item.delta`；`turn/plan/updated` → `turn.plan`；`turn/diff/updated` → `turn.diff`；`thread/status/changed` → `session.state`；`thread/tokenUsage/updated` → `usage`；`turn/completed` → `turn.completed`；`agentMessage.phase === 'final_answer'` 标出最终答案。
- 审批：`item/commandExecution/requestApproval` 等 server request → `request.opened`；回 JSON-RPC response `{decision: accept|acceptForSession|decline|cancel}`；`serverRequest/resolved` → `request.resolved`。
- **原生第二客户端**：若 TUI 也在同一 thread 上 `turn/start`，gateway 连接会收到其事件 → 写 `input.observed{origin: native_client}` + 对应 turn（replyTo = null，不触发 IM 投递）。这是 event-sourced 视角下"gateway 不是唯一输入方但仍是唯一日志写者"的处理方式。
- **有损点**：app-server 仍标 experimental，字段每几个版本会变（multica 还在处理 v1 `execCommandApproval`）→ `generate-ts` 钉版本；通知无 seq【推测】→ seq 由我们补；空 thread 无 rollout 时第二客户端不能 resume；30 分钟无订阅者 unload → adapter 保持订阅；首个 item 可能 >30s（multica 注释）。

### 5.3 ACP

保留为第三方 agent 的兜底 adapter（`codex-acp`、`claude-agent-acp`，openclaw `extensions/acpx`），不作为核心协议：它会丢掉 Codex 多客户端、queue、realtime、turn diff、expectedTurnId。

### 5.4 统一了什么、没统一什么

- **统一**：canonical Body 词汇、seq/turn/attempt/epoch 栅栏、InputCommand、Decision、caps 声明、用量形状。
- **不统一（保留原生）**：runtime 的上下文/线程状态（Claude transcript jsonl、Codex rollout，openclaw "runtime ownership matrix"：原生 runtime 拥有线程状态，我们只做 mirror 与投影）；runtime 专有特性（Claude hooks/skills/workflow、Codex review/realtime）走 `ext.*` 与 `rawRef`；steer 粒度不对称（caps.steer 声明，Sequencer 据此降级）。

---

## 6. 多端输入：Sequencer 规则

1. **单写者 lane**：每个 session 一个 lane；所有端的 `InputCommand` 都在这里线性化（openclaw `session:<key>`；happyclaw GroupQueue；multica server 侧串行化）。
2. **policy**（每端可设默认，每条可覆盖）：
   - `steer`：有活跃 turn 且 `caps.steer != none` 且发送者 permissionClass 与 turn.owner 兼容 → `runtime.steer(expectedTurnId)`；否则降级为 `queue`。（openclaw：不同权限的人只能 followup，"does not borrow the active sender's permissions"；botmux `active-turn-authority.ts`。）
   - `queue`：进入队列，下个 turn 合并；**不同 replyTo 的输入绝不合入同一 turn**（happyclaw `selectChannelReplyBatch`；openclaw collect 按 channel/thread 分开 drain），保证每个 turn 只有一个回复目的地。
   - `collect`：debounce 500ms、cap 20 合批（openclaw 默认值）。
   - `interrupt`：中断当前 turn，可选取消队列（happyclaw `/break`）。
3. **乐观并发**：`expectedTurnId` 不匹配 → `input.rejected{stale_turn}` 广播，所有端可见（Codex `turn/steer` 语义；openclaw `expectedLeafEntryId`）。
4. **状态机对所有端可见**：`input.submitted → admitted(queued|steer|new_turn) → consumed | cancelled | rejected`（happyclaw follow-up 状态机 queued/promoting/released/cancelled/subsumed 推到 Web）。
5. **待答问题优先**：有 `request.opened{kind:'question'}` 时，来自 eligible 用户的下一条消息优先作为答案（openclaw）。
6. **会话合并策略**：默认私聊跨通道汇成 `agent:<id>:main`（openclaw `dmScope=main` + `identityLinks`），群/话题各自成 session（happyclaw channel mount：话题群一话题一 session；botmux 一话题一 session）。

### 6.3 镜像（mirror）需要显式授权

happyclaw 与 openclaw 都**刻意不**把回复自动镜像到其它 IM（happyclaw `docs/BUSINESS-MODEL.md` "回复归属"；openclaw 移除了 channel docking）。event-sourced 视角下镜像只是一个 `obligation: 'mirror'` 的订阅，技术上零成本，但必须由 session owner 显式创建（例如飞书里 `/watch` 某 session），并受 ACL 约束。跨端主动发送仍应走 agent 工具（`send_to(route)`），由宿主根据认证过的 session/turn 推导可达目的地。

---

## 7. 中间过程可见性

- Web：full tier；按 `parentItemId` 重建子代理树；按 `level` 折叠 detail/debug；trace 视图 `/s/<key>?turn=<id>&trace=1`（happyclaw）。
- 飞书 bot：progress tier → core compositor → `surface.stream`（CardKit：typewriter 正文 + 可折叠详情：工具时间线、plan ✅▸▢、审批面板、中断按钮、用量页脚、Web trace 深链）。节流 ~1200ms 或 50 字（happyclaw）、遵守 10 QPS/卡、30KB、10 分钟自动关流 → 写 `render.anchor` 续卡。可选飞书原生 CoT 气泡（botmux `cot-message.ts`，"strictly cosmetic"，不参与结算）。
- 邮件：final tier + 本 turn trace 链接；审批若有，发带签名链接的"批准/拒绝"（链接回 Web 完成，避免邮件端直接执行）【推测：设计选择】。
- 音箱：narration tier，只念 `level=primary` 的 activity title 与 final 的 `spokenText`。
- 结算：只有 `turn.completed` 参与结算；过程事件丢失不影响结果（botmux：CoT 与 turn_terminal 分离）。
- 审计：`visibility: internal` 不出 gateway；工具 input 在源头脱敏，output 截断带三态 truncated（multica）；审批 preview 去不可见/方向控制字符、首尾截断、凭证打码（Claude Channels relay）。

---

## 8. 语音与实时（小米音箱、飞书会议）

### 8.1 小米音箱 + gpt-realtime

- 实时语音模型 **不是** runtime，它是 **Voice Channel adapter 内部的前台对话者**（openclaw voice-call：realtime 模型前台，`openclaw_agent_consult` 工具委托给后台 agent session，`docs/plugins/voice-call/realtime-and-streaming.md:31`）。
- 流程：音箱音频 → adapter 内 realtime 会话（ASR+对话+TTS，低延迟闲聊自己答）→ 需要干活时 realtime 模型调用 `consult(question)` → adapter `ctx.submit({policy:'steer'|'queue', replyTo: 'xiaomi:<device>'})` → 以 narration tier 订阅同一 session → 把 `activity` 标题与 final `spokenText` 喂回 realtime 模型播报（"正在跑测试…"）。
- barge-in：用户开口 → adapter 停止 TTS；若内容是"停/算了" → `InputCommand.interrupt`；否则 `steer`。consult 进行中暂停本地打断与 idle hangup（openclaw 同文 :33、:45）。
- 转写幂等写回：每次通话的最终 transcript 作为 `input.submitted{admission:'observe_only'}` 写入 session，保证 Web 上能看到语音对话历史。
- 备选：Codex `thread/realtime/*`（experimental）让语音直接绑在 Codex thread 上；仅在 runtime=codex 时可用，作为 caps.realtimeVoice 的增强路径，不作为主路径。

### 8.2 飞书会议

- 会议事件（邀请、转写片段、发言人）是 `channel_event` origin，默认 `admission:'observe_only'`（只入日志，不开 turn）；被 @ 或命中唤醒词才 `dispatch`（openclaw admission；会议邀请转 synthetic 消息）。
- 多 agent 消费同一会议：同一份 canonical 会议 feed（一个 "meeting session" 日志），每个 agent 一个独立 cursor 的订阅者，**分析可以多份，副作用单出口**（botmux `docs/design/2026-07-10-vc-multi-agent-consumer-delivery.md`）——在我们这里就是：只有一个订阅者对 `meeting:<id>` 路由有 `obligation:'origin'`。
- 会中语音应答需要 turn-taking / barge-in / 回声隔离（botmux `2026-07-01-vc-bot-realtime-voice.md:110` 列为待解问题）——复用 8.1 的 Voice adapter 内核。
- 会议大屏：`obligation:'none'` 的只读 full 订阅（Claude bridge `outboundOnly` 的对应物）。

---

## 9. 风险

1. **日志体积**：token 级 delta 全部入日志会爆。对策：delta 为 ephemeral 热段，turn 结束后 compaction 到 `item.completed`；`rawRef` 单独 blob、设 TTL。
2. **双事实源**：我们的日志 vs runtime 的 transcript/rollout。规则：日志是 IO 事实源，runtime 是上下文事实源（openclaw ownership matrix）；永远不从日志"重建"runtime 上下文，只在 resume 失败时注入 continuity notice（multica `ResumeContinuityNotice`）。
3. **原生协议漂移**：Codex app-server 标 experimental、Claude stream-json 字段受版本控制（happyclaw `sdk-compat.ts`）。对策：`probe()` 钉版本 + 断言，契约测试，`raw` 永远保留。
4. **输入"已接纳"≠"已被模型看到"**：Claude steer 在工具边界才并入；必须用 `user_message_uuid(s)` / Codex userMessage item 写 `input.consumed`，否则多端会以为指令已生效。
5. **投递不可能 exactly-once**：IM 发送超时状态未知。对策：operationId 幂等 + `delivery.settled{unknown}` 不自动重放（botmux remote-runner），卡片 lease + 重启 reconcile（happyclaw）。
6. **审批跨端安全**：任意端可裁决意味着攻击面变大。对策：`eligible` principal selector + 分级信任；peer/channel_event 不能审批；first-wins 后撤卡；超时视为 deny（openclaw）；不要像 happyclaw/multica/botmux 默认 bypass。
7. **订阅泄露**：multica 先 workspace 广播、前端过滤（代码里有 SECURITY 警示）。对策：从第一天起 per-session scope + ACL 在 Hub 侧过滤；visibility=internal 永不出 gateway。
8. **IM 限流与流式上限**：飞书 CardKit 10 QPS/卡、30KB、200 组件、10 分钟自动关流。对策：compositor 节流、`render.anchor` 续卡、长输出换新卡。
9. **复杂度失控**：openclaw fence/epoch/receipt 体系极重（Codex 投影约 356 文件），happyclaw `index.ts` 2.3 万行、botmux `daemon.ts` 3 万行。对策：MVP 单进程 SQLite、两个 runtime、三个端，严格限制 core 里出现通道/runtime 特例（用 `ext.*`）。
10. **Claude 无原生多客户端**：gateway 必须独占 Claude 进程，用户不能再同时在终端 `claude attach` 写同一 transcript；需要"在终端接管"时只能走 Web 终端或 Codex 的 `--remote` 路线。
11. **语音延迟**：后台 agent 动辄数十秒，音箱体验依赖 realtime 前台的"边干边说"与 narration 质量。

## 10. MVP 计划

1. **M0 协议包**：`packages/protocol`：Envelope/Body/InputCommand/Decision/Caps 的 TS 定义 + JSON Schema（TypeBox 或 zod），版本号 `v:1`；供 gateway、Web、out-of-process adapter 共用（happyclaw shared/、openclaw gateway-protocol 做法）。
2. **M1 Session Log + Sequencer**：SQLite 表 `events(session_key, seq, id, ts, epoch, turn_id, body_json, durability)` + `subscribers(id, session_key, cursor, tier, obligation)` + `outbox`；每 session 一条 lane；policy queue/steer/interrupt；snapshot 物化（partialText、activeTools、pendingRequests）。
3. **M2 Codex adapter**：app-server stdio，turn/start、turn/steer(expectedTurnId)、turn/interrupt、requestApproval 双向；projector 1:1 映射；`generate-ts` 钉版本。
4. **M3 Claude adapter**：`claude -p` 双向 stream-json 常驻进程、`--permission-prompt-tool stdio`、priority 'next' 做 steer、`--resume`；loopback MCP gateway 注入宿主工具（send_to、get_channel_context）。
5. **M4 Web 端**：WS `subscribe{fromSeq, tier:'full'}` + `submit` + `resolve`；trace 视图；late join 用 snapshot。验证"飞书发起、Web 实时观看并审批"。
6. **M5 飞书 bot adapter**（in-process）：ingress（dedup、@ gating、allowlist、route）、progress tier + CardKit 流式卡 + 审批卡 + Web 深链，`obligation:'origin'`。
7. **M6 out-of-process Channel 协议**：JSONL/WS 帧 + hello caps 协商 + 参考实现（类比 botmux `examples/remote-runner/reference-runner.mjs`）；用它接第一个私有通道，证明不需要改 core。
8. **M7 邮件 adapter**：final tier、Message-ID 线程化、签名链接审批。
9. **M8 Voice adapter（小米音箱 + gpt-realtime）**：realtime 前台 + consult 工具 + narration 订阅 + barge-in → interrupt/steer；transcript observe_only 回写。
10. **M9 飞书会议**：会议 session 日志 + observe_only 转写 + 唤醒 dispatch + 多 agent cursor + 单出口副作用。
11. **M10 硬化**：durable ingress、delivery reconcile、Postgres/Redis Stream 多副本、契约测试（声明的 caps 必须有测试支撑，openclaw `verifyChannelMessageLiveCapabilityAdapterProofs`）。
