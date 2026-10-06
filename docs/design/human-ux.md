# agents-io：以人和端的体验为先的 Agent IO 设计

> 视角：先问每个端（飞书卡片、飞书会议、小米音箱、邮件、Web、私有通道）上的人到底需要什么，再从这些需求反推协议。
> 依据：`docs/research/*.md` 六份调研，以及 scratchpad/repos 下 happyclaw / botmux / openclaw / multica 源码的抽查。推测处标注【推测】。
> 前提：runtime 确定直接用 Claude Code 和 Codex 本体，不自写 agent loop。

---

## 0. 先回答问题

| 问题 | 结论 |
| --- | --- |
| 统一 IO 协议，还是每个工具各自处理？ | **网关内部统一，边缘各自处理。** 统一的是三样东西：入站信封 `InboundEnvelope`、会话事件流 `SessionEvent`、控制命令 `SessionCommand`。runtime 原生协议（Claude stream-json、Codex app-server）和 channel 原生能力（CardKit、邮件线程、音频）都留在适配器里，并且通过 `raw` 字段和 capability 声明保留下来，不压成最小公分母。这个结论有正反两面的证据：openclaw、happyclaw、multica 都收敛到一个 canonical 事件（`src/infra/agent-events.ts`、`shared/stream-event.ts`、`server/pkg/agent/agent.go`）；botmux 没有统一事件总线，结果每加一个展示端就要再接一条数据通道（截图、WS 字节流、transcript 各取各的），CLI 专属字段也渗进了公共的 `WorkerToDaemon` 联合类型。 |
| 怎样能接受最广的输入、做出最广的输出？ | 输入：任何来源（IM 消息、会议转写、语音、邮件、卡片按钮、定时任务、webhook）都归一成 `InboundEnvelope`。信封分两部分：结构化的 facts（发送者、会话、回复位置、信任等级），和 content blocks（text/image/audio/file/quote/event）。每条入站还要带一个 admission：`dispatch` 表示开新一轮，`observeOnly` 只作为上下文，`steer` 注入运行中的轮次。输出：agent 产出的东西是**一条事件流**，也可以通过 **host 提供的 MCP 输出工具**（发卡片、发邮件、TTS 播报、发文件）主动选择输出形态。端侧用渲染配置决定呈现多少，不要求 agent 知道有哪些端。 |
| 输出能不能看成订阅某个 agent 的输出？ | **可以，但要拆成两件事。** (1) **投影（projection）**：任何有权限的端都能订阅 session 事件流，带游标和快照，可以多端同时看。(2) **投递（delivery）**：「这条回复要主动推给谁」，默认只推回输入的来源。happyclaw 把这条写成了业务规则（`docs/BUSINESS-MODEL.md`「回复归属」；`src/channel-reply-source.ts`：“Reply transport belongs to an input, never to a workspace or old session”）。openclaw 也是这样：IM 回到来源 channel，Gateway 客户端用 `sessions.messages.subscribe` 旁观。区别在于，我们把 IM 端也做成订阅者：一个 IM 订阅就是「订阅 + 渲染配置 + 投递目标」，这样「在音箱上开始、到飞书继续看」只是给 session 加一个订阅。 |
| 输入能不能多端？ | **能，而且应该能。** 一个 session 一条串行 lane。忙的时候来的输入按 queue mode 处理：`steer` 注入运行中轮次，`followup` 排到下一轮，`collect` 合并，`interrupt` 打断。每条输入带 origin（来源端加 sender）和信任等级。不同路由的输入不合并成同一轮（happyclaw `selectChannelReplyBatch`、openclaw collect 按目标分别 drain），所以每一轮的回复目的地是唯一的。 |
| 能不能看到中间过程？ | 能。两个 runtime 都给出了完整的结构化过程：Claude 的 `stream_event` / tool_use / tool_result / task_* / hook_*，Codex 的 item started/delta/completed、commandExecution outputDelta、plan、diff。问题不在拿不拿得到，而在每个端怎么呈现。方法是给每个事件标 `displayLevel`（primary/detail/debug，来自 happyclaw）和 `audience`（answer/commentary/status/approval），再由每个端的渲染配置挑出自己要的那部分（见 §3）。 |

---

## 1. 从端倒推需求

每个端都要回答五件事：要不要流式、过程看多细、审批怎么做、长度和频率上限、谁的输入算数。

### 1.1 飞书私聊或群聊（主力端）

- **要什么**：一张随回答实时刷新的卡片。正文像打字一样出来，下面有一个可折叠的「过程」区（工具时间线、todo、子任务），另外要有「中断」按钮、审批按钮，以及「查看完整 trace」的深链。
- **硬约束**（happyclaw 调研 `docs/feishu-streaming-card-research-2026-09-13.md`，已核对原文）：单卡 CardKit 全部操作合计 10 次/秒；整卡不超过 30KB、200 个组件；流式开启 10 分钟后自动关闭；卡片可更新期限 14 天。
- **反推**：
  - 网关要有一个节流合成器。happyclaw 是约 1200ms 或 50 字符 flush 一次；openclaw 有 `progress-draft-compositor.ts`。所以 channel 只需要实现 `send/edit/finalize` 这几个原语，不用自己理解 tool 事件。
  - 正文用累积全量更新，不发增量。happyclaw 的 `append(accumulatedText)` 和 botmux 的 CotEntry 都是累积全量，好处是重复或乱序的更新天然幂等。
  - 过程区默认安静。openclaw 的 progress draft 默认只显示 headline、plan 和审批，工具行要 opt-in。
  - 超长时开新卡续写（happyclaw），10 分钟到期前主动 finalize，再开一张续卡。
  - 卡片底部放 Web trace 深链（happyclaw `buildWebTraceUrl`、Slack 的「Open in OpenClaw」）。
- **群聊**：@ 门控加发送者白名单（happyclaw、openclaw ingress resolver）。多个人输入同一个 session 时，每条消息带 sender 标签（botmux `renderSenderTag`）。

### 1.2 飞书会议

会议端是一个「多人、持续、主要在旁听」的端，和聊天完全不同。

- **输入**：会中转写、聊天消息和参会事件的量远大于「对 agent 说话」。绝大多数应该是 `observeOnly`，只进 session 上下文，不触发轮次（openclaw 的 admission `observeOnly`）。只有被点名（「小 X，帮我查一下…」）或在会中聊天里 @ 时才 `dispatch`。
- **输出**分三档：
  1. 会中聊天文本：只发 final，要短。对应 botmux 设计里的 `vc:meeting.message:write`，是「文本回复（轻）」。
  2. 实时语音：只说 primary 的、口语化的短句。走 botmux `docs/design/2026-07-01-vc-bot-realtime-voice.md` 的路径 1，即 PCM s16le 24kHz 的三层协议 WS，那份设计自己也说这是「最重的一块」。
  3. 旁路的「监听群」完整卡片，过程细节都放在这里（botmux P0/P1 的做法）。
- **字幕或「live captions」**：飞书没有给 bot 写字幕的官方能力【推测：调研中没看到】。可行的替代是在监听群或 Web 大屏上用 narration 模式滚动 agent 的状态，形式是只读的 outboundOnly mirror（Claude bridge 有 `outboundOnly` 这个概念）。
- **多 agent 进同一个会**：照 botmux `2026-07-10-vc-multi-agent-consumer-delivery.md`，「分析可以多份，副作用必须单出口」。每个 consumer 有独立 cursor，所有发言和发消息都过一个 action gate。

### 1.3 小米音箱（实时语音）

- **要什么**：低延迟（首音 < 1s）、能 barge-in（用户开口 bot 立刻闭嘴）、不念代码和路径、长任务不让人干等。
- **反推**：音箱不能直接接 Claude Code 或 Codex 的事件流，因为它们一轮可能跑几分钟。照 openclaw `docs/plugins/voice-call/realtime-and-streaming.md`：**realtime 模型（gpt-realtime）当前台**，负责寒暄、确认和打断，需要干活时调 `agent_consult` 把任务委托给后台的 Claude Code 或 Codex session。
  - barge-in 在前台本地处理：realtime 的 VAD 截断播放，这不是 agent runtime 的事。
  - 用户语义上说「停下」「算了」，就映射成 `SessionCommand.interrupt`；说「另外再把测试跑一下」，就映射成 `steer`。
  - 前台以 **narration 模式**订阅 session（openclaw：≤16k 的尾部快照，每 2 秒一次），只读 `displayLevel=primary` 且 `audience=status|answer` 的事件。用户问「做到哪了？」时，前台根据最新 narration 口述进度。
  - 结果太长或含代码时，音箱只说结论，详情交给飞书，也就是 §2 的接力。
- Codex 自带 `thread/realtime/*`（实验性），但它只绑 Codex，不能用于 Claude。所以把它当作可选优化，主路径用独立的 realtime 前台。

### 1.4 邮件

- **要什么**：异步，不要流式，也不要过程刷屏。一轮结束后发一封摘要，内容是结论、改了什么（diff 统计）、链接、需要我决定的事。
- **反推**：渲染配置用 `final-only + digest`。邮件线程用 Message-ID / In-Reply-To 映射到 session。回复邮件算 `followup` 输入。
- **信任**：邮件发件人可伪造，按 openclaw 的分级信任（verified/asserted/unverified，IMAP `senderAuth.min`），默认 `asserted`，不能审批。审批类事项放链接，跳到 Web 或飞书卡片去点。

### 1.5 Web 控制台

- 全量 trace：正文、thinking、工具时间线（入参摘要、截断输出）、子 agent 面板（按 parentToolUseId 隔离）、diff、todo、用量。
- 中途加入要看到进行中的状态。happyclaw 用 `active_run_snapshot` + `stream_snapshot`，openclaw 是首帧带完整快照，multica 是 REST 快照加 WS 增量按 seq 合并。
- Web 是唯一默认能看到 debug 级事件的端。

### 1.6 私有通道（约束不可预知）

私有通道可能只能发纯文本，可能有长度上限，可能不能编辑消息、只能轮询，可能单向，也可能是别的语言写的进程。

- 所以 **channel 适配器必须很薄，能力靠声明**。multica 用 `Capability` 位掩码（text/rich_card/thread_reply/attachment/voice/typing_indicator/message_edit）；openclaw 有 `presentationCapabilities` 和 live capabilities。
- 降级由网关做：不能编辑就退化为「开始一条、结束一条」；不能流式就只发 final；有长度上限就由网关分块（openclaw `EmbeddedBlockChunker` 不切代码块）。
- 允许**进程外**的适配器，按 botmux remote-runner 的思路：版本化 JSONL 或 WS，hello 时协商 capability。这样私有通道可以用任意语言实现，不用 fork 网关。happyclaw 加一个通道要改约 8 处，botmux 的 `ImAdapter` 只有定义没有实现，这两种都是反例。

---

## 2. 多端接力（handoff）

场景：在音箱上说「帮我把 X 仓库的 flaky test 修掉」，然后出门，在飞书上接着看、接着说。

### 2.1 前提：session 和端解耦

- session 是一等对象，端只是 attach 到它上面（openclaw `docs/concepts/session-attachment.md`：所有客户端订阅 Gateway 持有的 session state，不各自保存副本）。
- 跨端的人要先能认出是同一个人：用 `identityLinks`（openclaw）把「音箱绑定用户 = 飞书 open_id = 邮箱」合并成一个 principal。没有 identity link 就不能自动接力，只能用配对码（openclaw pairing：8 位码、1 小时 TTL）显式绑定。
- 默认 DM 汇聚：同一个 principal 的私聊端（音箱、飞书私聊、Web）汇进 `principal:<id>:main`（openclaw `dmScope=main`）。群和会议各自是独立 session。

### 2.2 接力的三种触发

1. **agent 主动**：音箱前台发现结果不适合口播，调 host 工具 `handoff({to:"feishu:dm", profile:"progress"})`，然后说「细节我发你飞书了」。网关给 session 加一个飞书订阅，立刻推一张带当前快照的卡片。
2. **用户在新端声明**：在飞书私聊说「刚才音箱那个」或 `/attach`，网关列出该 principal 最近的活跃 session，选中后 attach，补发快照。
3. **策略自动**：一轮跑超过 N 秒、来源端是语音时，自动给 principal 的默认文本端加订阅【推测：需要产品决定，默认关】。

### 2.3 接力之后的规则

- 投递：这一轮的 final 回复，默认既回到来源（音箱口播一句结论），也发给接力时声明的目标（飞书卡片）。接力本质上是给这一轮显式加了一个投递目标，没有破坏「默认回来源」的规则。
- 输入：飞书上的新消息进同一个 session lane。如果音箱那一轮还在跑，就按 queue mode 走 steer 或 followup。
- 审批：广播给所有能审批的端，先到先得，其余撤卡（Codex `serverRequest/resolved`、Claude Remote Control 和 Channels relay 都是这个语义）。音箱不能审批，最多说一句「需要你在飞书上确认」。

---

## 3. 中间过程在每个端怎么呈现

所有端消费同一条 `SessionEvent` 流，区别只在渲染配置（RenderProfile）。

| profile | 用于 | 正文 | thinking | 工具 | plan/todo | 审批 | 节流 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `full` | Web、TUI | token 级 | 显示 | 全量（入参、截断输出） | 显示 | 卡片 | 无，100ms 合批（multica 前端） |
| `card` | 飞书、钉钉、Slack | 累积全量 | 折叠 | 折叠时间线，只有标题和状态 | 显示 | 按钮 | 约 1.2s，单卡不超过 10 QPS |
| `progress` | 不能流式的 IM、私有通道 | 只发 final | 不显示 | 一条可编辑的状态行（headline） | 里程碑 | 按钮或链接 | 能编辑就 3 到 5 秒一次，不能编辑就不发 |
| `narration` | 音箱、手表、会议大屏 | 不推 | 不显示 | 口语化 headline | 只说里程碑 | 口头提示「去飞书确认」 | 2s 快照（openclaw） |
| `final-only` | 邮件、webhook | 只发 final | 不显示 | 不显示 | 不显示 | 链接 | 每轮一次，也可以合并成 digest |

headline（「正在跑测试，3/12 失败」）从哪里来：

- Codex 有 `agentMessage.phase=commentary` 和 plan。
- Claude 有 `agentProgressSummaries`（happyclaw 开了）和 `tool_progress`。
- openclaw 用一个工具模型生成 `session.observer` headline，并提供 `onNarrationUpdate`。
- 我们的做法：先用 runtime 原生的 commentary 和 plan，没有时由网关规则生成，形式是「工具名 + 主体」，例如「编辑 src/foo.ts」。可选再用一个小模型改写成口语，给 narration 用。

规则：

- `audience=approval` 的事件**任何 profile 都不能吞掉**（openclaw：“quiet progress must always keep approval requests visible”）。
- `debug` 级（context_audit、raw）永远不出 Web（happyclaw 不把 context_audit 发给浏览器）。
- 用量只用 runtime 原生上报的数据，不估算（botmux）。

---

## 4. 架构

```
            ┌──────────────── Channel Adapters（进程内插件或进程外 JSONL/WS）────────────────┐
  飞书IM ── │ lark-im   lark-vc(转写/会中聊天/实时音频)   email   web   private-x (remote) │
  会议   ── │   ingest() → InboundEnvelope           render(primitives) ← RenderJob      │
  音箱   ── │ voice-front: gpt-realtime + agent_consult 工具（自己就是一个 channel）      │
  邮件   ── └───────────────┬─────────────────────────────────────▲────────────────────┘
                            │ InboundEnvelope                     │ send/edit/finalize/speak
                 ┌──────────▼──────────┐               ┌──────────┴───────────┐
                 │ Ingress pipeline    │               │ Projector/Compositor │ 按 RenderProfile
                 │ dedup·身份/信任·路由 │               │ 节流·分块·降级·headline│ 合成每个订阅的视图
                 │ admission·queue mode│               └──────────▲───────────┘
                 └──────────┬──────────┘                          │
                            │ SessionCommand          Subscriptions(cursor, profile, delivery)
                 ┌──────────▼───────────────────────────────────────┴───────┐
                 │ Session Core: 每 session 一条串行 lane                    │
                 │  · Event Log (append-only, seq, 持久化) ← 唯一事实来源     │
                 │  · Turn 归属: origin + replyRoute + extraDeliveries       │
                 │  · Approval broker: 广播 / first-wins / 撤回 / 迟到重放    │
                 │  · Outbox: 幂等投递, 回执                                │
                 │  · Host MCP Gateway: send_card/send_email/speak/handoff…  │
                 └──────────┬──────────────────────────────────▲────────────┘
                            │ RuntimeCommand                   │ SessionEvent(+raw)
                 ┌──────────▼──────────┐          ┌────────────┴──────────┐
                 │ claude-code adapter │          │ codex adapter         │
                 │ claude -p stream-json│          │ codex app-server      │
                 │ 双向 + control_request│          │ JSON-RPC (stdio/ws)   │
                 └─────────────────────┘          └───────────────────────┘
```

各组件来源：

- Event Log 加 seq：multica 的 `task_message` 表和 seq，Claude bridge 的 `sequence_num/from_sequence_num`。Codex 通知没有 seq【推测】，所以由网关来分配。
- Turn 归属表：multica `channel_task_delivery`，happyclaw reply source。
- Approval broker：Codex `outgoing_message.rs` 的 fan-out、first-wins 和 replay。
- Host MCP Gateway：botmux 每会话一个 MCP Gateway，注入 trustedCaller；happyclaw 的 `send_message` 等 40 多个工具。
- Outbox：happyclaw `channel-outbox-delivery.ts`，botmux 的 operationId 加 delivered/rejected/unknown（unknown 不自动重放）。

---

## 5. 协议（TypeScript 草案）

### 5.1 入站

```ts
type TrustLevel = 'verified' | 'asserted' | 'unverified';   // openclaw 分级
interface Origin {
  channel: string;            // 'lark-im' | 'lark-vc' | 'voice' | 'email' | 'web' | 'private-x'
  account: string;            // bot / 邮箱账号
  conversation: { id: string; kind: 'dm'|'group'|'meeting'|'thread'|'call'; threadId?: string; rootId?: string };
  sender: { channelUserId: string; principalId?: string; displayName?: string; isBot?: boolean; trust: TrustLevel };
  messageId?: string;
}
type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image' | 'file' | 'audio'; ref: string; mime: string; name?: string }   // ref 指向对象存储，先落库再给 agent
  | { type: 'quote'; text: string; fromMessageId?: string }
  | { type: 'transcript'; speaker?: string; text: string; startMs: number; endMs: number; final: boolean }
  | { type: 'event'; name: string; data: Record<string, unknown> };                   // 会议邀请、卡片点击、文档评论

interface InboundEnvelope {
  v: 1;
  id: string;                   // 去重 key：channel+account+conversation+messageId
  receivedAt: number;
  origin: Origin;
  content: ContentBlock[];
  replyRoute: ReplyRoute;       // 不可变，这条输入的回复默认投到这里
  admission: 'dispatch' | 'observeOnly' | 'command' | 'interaction' | 'drop';
  queueHint?: QueueMode;        // 端可以建议，最终由 lane 决定
  channelContext?: Record<string, string|number|boolean>; // 白名单化、不含凭据，作为 verified 上下文注入（happyclaw ChannelTurnContext）
  raw?: unknown;                // 平台原始 payload，core 不读（multica InboundMessage.Raw）
}
interface ReplyRoute { channel: string; account: string; conversationId: string; threadId?: string; replyToMessageId?: string; routeRevision?: number }
type QueueMode = 'steer' | 'followup' | 'collect' | 'interrupt';
```

### 5.2 命令（端到 session，多端输入都走这里）

```ts
type SessionCommand =
  | { type: 'input'; sessionKey: string; envelope: InboundEnvelope; mode?: QueueMode; expectedTurnId?: string }
  | { type: 'interrupt'; sessionKey: string; turnId?: string; by: Origin }
  | { type: 'approval.resolve'; sessionKey: string; requestId: string; decision: 'allow_once'|'allow_session'|'deny'|'cancel'; updatedInput?: unknown; by: Origin }
  | { type: 'question.answer'; sessionKey: string; requestId: string; answers: Record<string, string>; by: Origin }
  | { type: 'subscribe'; sessionKey: string; subscriber: SubscriberSpec; fromSeq?: number }
  | { type: 'unsubscribe'; subscriptionId: string }
  | { type: 'handoff'; sessionKey: string; to: ReplyRoute; profile: RenderProfile; scope: 'turn'|'session' };

type RenderProfile = 'full' | 'card' | 'progress' | 'narration' | 'final-only';
interface SubscriberSpec {
  id: string;
  principalId: string;              // 用于 ACL 判断
  profile: RenderProfile;
  deliver?: ReplyRoute;             // 有它就是主动推送的 IM 订阅，没有就是被动连接（Web WS）
  filter?: { minLevel?: DisplayLevel; streams?: string[]; optOut?: string[] }; // Codex optOutNotificationMethods
  canApprove: boolean;
}
```

### 5.3 会话事件（唯一的输出流）

形状借自 Codex 的 Thread/Turn/Item，Claude stream-json 映射进来；层次和 openclaw 一样，原始层和语义层都发。

```ts
type DisplayLevel = 'primary' | 'detail' | 'debug';
type Audience = 'answer' | 'commentary' | 'status' | 'approval' | 'internal';

interface EventBase {
  v: 1;
  sessionKey: string;
  seq: number;                 // 网关分配，单 session 单调递增；订阅和续传都用它
  ts: number;
  turnId?: string;
  attempt?: number;            // 重试或重新拉起的代际，用于丢弃迟到事件（happyclaw queryRunId，botmux dispatchAttempt）
  itemId?: string;
  parentItemId?: string;       // 子 agent 嵌套（Claude parent_tool_use_id）
  scope?: 'main' | 'subagent' | 'task' | 'system';
  level: DisplayLevel;
  audience: Audience;
  runtime: 'claude-code' | 'codex';
  raw?: unknown;               // runtime 原生事件，只给 debug 或 full 订阅
}

type SessionEvent = EventBase & (
  | { kind: 'turn.started'; inputs: string[] /* envelope ids, 对应 Claude user_message_uuids */; replyRoute: ReplyRoute }
  | { kind: 'turn.completed'; status: 'completed'|'interrupted'|'failed'|'ambiguous'; usage?: Usage; error?: { code: string; retryable: boolean } }
  | { kind: 'input.accepted'; envelopeId: string; mode: QueueMode; state: 'queued'|'steered'|'merged'|'cancelled' }
  | { kind: 'text.delta'; delta: string }                         // answer / commentary
  | { kind: 'text.snapshot'; text: string; final: boolean }       // 累积全量，给 card 和 IM 用，幂等
  | { kind: 'reasoning.delta'; delta: string; summary: boolean }
  | { kind: 'item.started'; item: ItemSummary }
  | { kind: 'item.updated'; itemId: string; progressText?: string; outputDelta?: string }
  | { kind: 'item.completed'; item: ItemSummary; result?: { preview: string; truncated: boolean | null; isError: boolean } }
  | { kind: 'plan.updated'; steps: { text: string; status: 'pending'|'in_progress'|'completed' }[] }
  | { kind: 'diff.updated'; files: { path: string; added: number; removed: number }[]; unified?: string }
  | { kind: 'approval.requested'; requestId: string; title: string; detail: string /* 已脱敏、截断 */; options: string[] }
  | { kind: 'approval.resolved'; requestId: string; decision: string; by?: Origin }
  | { kind: 'question.requested'; requestId: string; questions: { id: string; text: string; options?: string[] }[] }
  | { kind: 'headline'; text: string }                            // narration 和 progress 的来源
  | { kind: 'session.state'; state: 'idle'|'running'|'requires_action' }
  | { kind: 'delivery.receipt'; operationId: string; route: ReplyRoute; status: 'delivered'|'rejected'|'unknown' }
  | { kind: 'runtime.raw'; name: string }                         // 未知的原生事件透传，raw 字段有内容
);

interface ItemSummary {
  itemId: string;
  type: 'command' | 'file_change' | 'mcp_tool' | 'web_search' | 'subagent' | 'tool' | 'hook' | 'compaction';
  title: string;                // 例如 "bash: pnpm test"、"edit src/foo.ts"
  status: 'running'|'completed'|'failed'|'skipped'|'blocked';
  inputSummary?: string;        // 源头脱敏（multica 双重 redact）
}
```

和参照项目的不同之处，以及理由：

- 用判别联合，不用 happyclaw 那种一个扁平结构里堆一堆可选字段（它自己的 `docs/RUNTIME-ARCHITECTURE.md` 规则 6 也要求 typed contracts）。
- 每个事件都持久化，并带 seq。openclaw 不重放事件（“Events are not replayed”），multica 的 per-scope 订阅还没开（MUL-1138），我们一开始就做好。
- `text.delta` 和 `text.snapshot` 并存：Web 用 delta，卡片用 snapshot。这能避开 openclaw 的问题：agent 流和 chat 流两套文本投影并存，客户端用错就会重复。

---

## 6. Channel 适配器接口（私有通道实现这个）

```ts
interface ChannelCapabilities {
  text: { maxChars: number; markdown: 'none'|'basic'|'full' };
  edit: boolean;                 // 能否原地编辑（流式卡片的前提）
  streaming?: { minIntervalMs: number; maxBytes: number; ttlMs?: number };  // 飞书：1000/30KB/10min
  cards?: { buttons: boolean; collapsible: boolean; maxComponents: number };
  media: { image: boolean; file: boolean; audioOut: boolean; audioIn: boolean };
  threads: boolean;
  approvals: 'buttons' | 'link' | 'none';
  typing: boolean;
  defaultProfile: RenderProfile;
}

interface ChannelAdapter {
  readonly id: string;                            // 'private-x'
  capabilities(account: string): ChannelCapabilities;
  start(ctx: {
    account: string;
    config: unknown;
    abortSignal: AbortSignal;
    emit: (env: InboundEnvelope) => Promise<void>;  // 只发归一化后的事实；路由和持久化归网关（避免 happyclaw 的 30 个回调）
    log: Logger;
  }): Promise<void>;
  // 输出原语：网关 compositor 已经做完节流、分块和降级，适配器只负责执行
  send(route: ReplyRoute, msg: RenderedMessage, opts: { operationId: string }): Promise<{ providerMessageId?: string }>;
  edit?(route: ReplyRoute, providerMessageId: string, msg: RenderedMessage, opts: { operationId: string; sequence: number }): Promise<void>;
  finalize?(route: ReplyRoute, providerMessageId: string, msg: RenderedMessage): Promise<void>;
  speak?(route: ReplyRoute, audio: AsyncIterable<Uint8Array> | { text: string }): Promise<void>;
  setTyping?(route: ReplyRoute, on: boolean): Promise<void>;
  reconcile?(route: ReplyRoute, providerMessageId: string): Promise<'alive'|'gone'>;  // 重启后接管流式卡片（happyclaw）
}

// 可移植的展示结构（openclaw MessagePresentation 的子集），channelData 作逃生口
interface RenderedMessage {
  text: string;
  sections?: { kind: 'body'|'details'|'status'|'footer'; text: string; collapsed?: boolean }[];
  actions?: { id: string; label: string; style?: 'primary'|'danger'; command: SessionCommand }[];
  attachments?: { ref: string; mime: string; name?: string }[];
  link?: { label: string; url: string };          // Web trace 深链
  channelData?: Record<string, unknown>;
}
```

进程外的形态：同一个接口按 JSONL 或 WS 帧序列化（`hello{capabilities}` / `inbound` / `send` / `edit` / `result{operationId,status}`），参照 botmux `adapters/backend/remote-runner-protocol.ts` 的版本化、capability 协商、generation 栅栏，以及「外发消息由宿主推导路由，不由对端指定」这条规则。

---

## 7. Runtime 适配器

```ts
interface RuntimeAdapter {
  id: 'claude-code' | 'codex';
  capabilities: { midTurnSteer: 'native'|'between-tools'|'none'; approvals: boolean; questions: boolean; tokenDeltas: boolean; multiClient: boolean };
  open(o: { sessionKey: string; cwd: string; resume?: string; mcp: McpEndpoint /* host MCP gateway */; policy: PermissionPolicy }): Promise<RuntimeSession>;
}
interface RuntimeSession {
  nativeId(): string | undefined;               // Claude session_id / Codex threadId，拿到就立刻持久化（multica PinTaskSession）
  startTurn(inputs: InboundEnvelope[], turnId: string): Promise<void>;
  steer(input: InboundEnvelope, expectedTurnId: string): Promise<'steered'|'unsupported'|'stale'>;
  interrupt(turnId: string): Promise<void>;
  resolve(requestId: string, decision: unknown): Promise<void>;
  events: AsyncIterable<Omit<SessionEvent, 'seq'|'sessionKey'>>;   // seq 由 core 分配
  close(): Promise<void>;
}
```

### Claude Code

- 启动方式：`claude -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages --replay-user-messages --permission-prompt-tool stdio [--resume <id>]`。这是 openclaw `extensions/anthropic/cli-runtime-args.ts` 的参数组合。进程常驻跨轮复用（openclaw liveSession `claude-stdio`）。
- 也可以用 Agent SDK `query({prompt: AsyncIterable})`（happyclaw）。两者是同一套线协议。
- 映射：
  - `stream_event` 映射到 `text.delta` / `reasoning.delta`。
  - assistant 消息里的 tool_use 映射到 `item.started`，user 消息里的 tool_result 映射到 `item.completed`。
  - `tool_progress` 映射到 `item.updated`。
  - `system/task_*` 映射到子 agent item。
  - `session_state_changed` 映射到 `session.state`。
  - `control_request can_use_tool` 映射到 `approval.requested`。
  - `result` 映射到 `turn.completed`。
- 运行中输入：用 `SDKUserMessage.priority:'next'`，在工具执行之间并入当前轮，要求 v2.1.286 以上（见 claude-code 调研）。版本不够时，退回 multica 的 hook `additionalContext`（`server/pkg/agent/claude_supplement.go`），再不行就降级为 followup。openclaw 的 claude-cli 路径目前也只能做 followup。
- **有损处**：
  - 单进程只有一个宿主，transcript 只允许一个写者，所以多端 fan-out 必须由网关做。
  - 自研 Channels（`notifications/claude/channel`）在 `-p` 下会被忽略，不能用。
  - 子 agent 文本要开 `forwardSubagentText`。
  - AskUserQuestion 在 headless 下要宿主自己渲染，否则只能禁用（multica 选择禁用）。
  - 双向管道两端都要持续读，否则会死锁（multica 有记录）。

### Codex

- 启动方式：`codex app-server --listen stdio://`（multica、openclaw），或 `ws://127.0.0.1` 加 `--ws-auth`（botmux hybrid）。
- 握手和输入：先 `initialize`，然后 `thread/start|resume`，`turn/start`；运行中用 `turn/steer{expectedTurnId}` 和 `turn/interrupt`。
- 映射：`item/*` 映射到 item，`item/agentMessage/delta` 映射到 `text.delta`；`agentMessage.phase` 是 commentary 时 audience 为 commentary，是 final_answer 时为 answer；`turn/plan/updated` 映射到 `plan.updated`，`turn/diff/updated` 映射到 `diff.updated`；`*/requestApproval` 映射到 `approval.requested`。
- 版本：用 `generate-ts` 锁定 schema，握手时断言版本（openclaw `assertSupportedCodexAppServerVersion`）。
- **有损处**：
  - 通知没有 seq【推测】，断线后要用 `thread/turns/list` 补拉。
  - 空 thread 没有 rollout，第二个客户端没法 resume。
  - 没有订阅者时 thread 30 分钟后卸载。
  - app-server 本身支持多客户端，但我们**只让网关一个连接写**。官方 TUI `codex --remote` 只当额外的观察端（botmux hybrid 已验证），这样事件和 seq 只有一个事实来源。

### 不对称的处理

能力差异通过 `capabilities` 暴露给 lane：`midTurnSteer` 不是 native 时，steer 降级为 followup，并发 `input.accepted{state:'queued'}` 让各端看到。openclaw 也是这么做的：runtime 不支持就转成 followup。

---

## 8. 多端输入的冲突规则

1. 每个 session 一条串行 lane（openclaw `session:<key>`，happyclaw GroupQueue）。
2. 默认 queue mode 按端区分：
   - 语音默认 `steer`，因为说话就是插话。
   - IM 默认 `steer`，runtime 不支持时退为 followup。
   - 邮件默认 `followup`。
   - 会议转写默认 `observeOnly`。
   - 用户说「停」或点了按钮，就是 `interrupt`。
3. 权限不能借用：低信任或不同 principal 的输入不能 steer 别人的轮次，只能排成 followup（openclaw queue-steering；botmux `active-turn-authority.ts`）。
4. 不同 replyRoute 的输入不合并成同一轮（happyclaw、openclaw collect）。
5. 一轮的归属在 `turn.started` 时就固定（origin、replyRoute、发起者权限），中途 steer 进来的输入不改变它。steer 方另外会收到 `input.accepted{steered}`。
6. 审批：只有 `canApprove` 且信任等级为 verified 的端能决策，first-wins，其余端收到 `approval.resolved` 后撤卡。peer、agent、邮件这类来源不能审批（Claude SDKMessageOrigin 的规则）。

---

## 9. 语音与实时

```
 用户 ⇄ (音频) ⇄ voice-front[gpt-realtime] ──tool: agent_consult(task, mode)──► Session lane (Claude/Codex)
                   ▲   │                                          │
                   │   └─ 本地 VAD barge-in：截断 TTS，不惊动后台     │
                   └──── subscribe(profile=narration) ◄─────────────┘ headline / turn.completed / approval.requested
```

- 前台 realtime 模型负责对话；后台 agent 负责干活。前台的转写以 `InboundEnvelope(content=transcript, final=true)` 的形式幂等写回同一个 session，保证在飞书上接力时历史连得上（openclaw：转写写回同一个 session）。
- `agent_consult` 有两种模式：`await`，短任务，前台等结果再念；`background`，前台说「我在做，好了告诉你」，`turn.completed` 到达后由前台主动播报，或者转飞书。
- 前台需要的 host 工具有：`agent_consult`、`agent_status`（读最新 headline）、`agent_interrupt`、`agent_steer`、`handoff`。
- 会议语音也复用这套前台，只是 channel 换成 lark-vc 的实时音频 WS。要额外处理回声隔离和只在被点名时才开口（botmux 设计 §138 列为待澄清）。
- 首音延迟由前台负责：先说一句确认「好，我看一下」，再 consult。

---

## 10. 风险

- 飞书 CardKit 的限额（10 QPS/卡、30KB、10 分钟）会直接决定流式卡片的体验。需要网关侧的全局限流加分页续卡，测试要覆盖到期和超限。
- 两个 runtime 的协议都在快速迭代（Codex app-server 标为 experimental，Claude 字段受版本控制）。要锁版本、生成 schema、做 contract test，未知事件走 `runtime.raw`，不能让流程崩掉。
- Claude 中途 steer 依赖较新的版本（priority）。旧版本只能 followup，语音插话的体验会打折。
- 跨端接力依赖 identity link。错误合并身份等于越权，所以要显式配对，默认不自动合并。
- 语音前台和后台 agent 有两份上下文，可能出现「前台承诺了、后台没做」。缓解办法是前台只能通过工具描述后台状态，不允许自己编造进度。
- 只让网关单写 runtime，就放弃了 Codex 原生的多客户端写，换来一个事实来源。如果用户直接在官方 TUI 里输入，网关需要从 `item/started userMessage` 反向感知并入日志【推测：需验证】。
- 事件日志全量持久化（含 tool 输出）有存储和隐私成本。要在源头脱敏和截断（multica），raw 设 TTL。
- 会议 observeOnly 的转写会让 Claude/Codex 的上下文膨胀。需要把转写做摘要后再注入，不逐句注入【推测：实现策略待定】。
- 私有通道的约束不可预知，capability 声明可能不够表达。保留 `channelData` 逃生口，并允许适配器自定义 profile。

---

## 11. MVP 路线

1. **M0 核心骨架**：Session lane、持久化 Event Log（SQLite，含 seq）、`SessionEvent`/`InboundEnvelope`/`SessionCommand` 类型包。Codex 适配器（app-server stdio）和 Claude 适配器（stream-json 双向），两者都只实现 startTurn、interrupt、事件映射，审批先默认 deny，并在事件里可见。
2. **M1 Web full 订阅**：WS `subscribe{fromSeq}`，加快照、增量和断线续传；全量 trace 视图。用它校验两个 runtime 的映射是否完整。
3. **M2 飞书 IM card profile**：compositor（节流、累积全量、续卡、深链）、中断按钮、审批按钮；approval broker（广播、first-wins、撤卡）。
4. **M3 多端输入**：queue mode（steer/followup/interrupt）、权限不借用、不同路由不合并、`input.accepted` 事件；Claude 的 priority steer，Codex 的 turn/steer。
5. **M4 进程外 channel 协议**（JSONL/WS），拿一个私有通道和邮件（final-only 加 digest）验证。
6. **M5 音箱语音前台**：gpt-realtime、agent_consult、narration 订阅、handoff 到飞书；identity link 加配对码。
7. **M6 飞书会议**：转写 observeOnly、会中聊天 final、监听群卡片；之后再做实时音频发言（沿用 botmux v0/v1 分阶段）。
