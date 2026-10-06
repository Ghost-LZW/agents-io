# Thin Bridge：极简 agent IO 架构提案

> 视角：极简 / 务实。在能复用的地方一律复用原生协议（Codex app-server、Claude Code stream-json / Agent SDK），只自己造"原生协议真的缺"的那一小块。
> 依据：docs/research/*.md 中对 happyclaw、botmux、openclaw、multica、Claude Code、Codex 的调研。标注 [推测] 的是没有在代码里验证的判断。

---

## 0. 一句话结论

**不要维护一个"大"的统一 IO 协议，也不要每个工具各干各的。** 统一三样很小的东西，其余全部原样透传：

1. **入站信封** `Inbound`：谁、从哪来、说了什么、回复该回哪（约 10 个字段）。
2. **会话事件信封** `SessionEvent`：`{sessionId, seq, ts, kind, level, native}`，`kind` 只有约 12 种，`native` 原样放 runtime 原始事件。
3. **交互请求**（审批 / 提问）：`request` + `resolve`，first-wins。

真正值得自建的只有一个组件：**每个 session 一份带 seq 的 append-only 事件日志 + 订阅 fan-out**。原因是：Claude Code 每进程只允许一个宿主、一个 transcript 写者；Codex app-server 虽然支持多连接，但通知不带 seq，重连只能重读历史。这两个缺口加起来，正好就是"多端订阅 + 断线续传"。

其余东西（富卡片、工具语义、跨 runtime transcript、语音）**统一不值得**，理由见第 3 节。

---

## 1. 直接回答用户的问题

### Q1 统一 IO 协议，还是每个工具独立处理？

两个极端都已经有人走过并且付出了代价：

| 做法 | 代表 | 代价（证据） |
|---|---|---|
| 大统一 | openclaw `MsgContext` 约 250 个可选字段、带大量 legacy 别名（src/auto-reply/templating.ts）；`ReplyPayload` + `MessagePresentation`；Codex 投影层约 356 个非测试文件 | 复杂度失控，文档里到处是删除日期和兼容 shim |
| 每个各管各 | botmux：每个 CLI 一个适配器，各自刮屏 / 打字 / tail transcript | CLI 专属字段渗进公共协议：`WorkerToDaemon` 里有 `codexApp*`、`mojo*`、`riff*`；worker.ts 2.4 万行；1500+ 测试文件在补边角 |
| 只统一过程事件 | multica `agent.Message{Type: text\|thinking\|tool-use\|tool-result\|status\|error\|log}`，用 7 种类型覆盖 20+ CLI（server/pkg/agent/agent.go） | 这层很成功；它弱的地方在输入侧（`daemon.Task` 按来源平铺字段）和 IM 富输出 |

**本提案的立场就是 multica 的"窄核心"再收窄一点，同时补上 happyclaw / openclaw 那种订阅语义**：

- 统一 = 路由和展示所需的**最小公分母**（谁、哪个 turn、文本、工具开始和结束、审批、终态）。
- 不统一 = 一切"渲染得更好看"所需的细节，这些都放在 `native` 里，由需要它的端自己解析（Web 的 Codex diff 面板读 `native` 里的 `turn/diff/updated` 即可）。

happyclaw 的 `shared/stream-event.ts` 证明了"一份共享事件类型被 runner/server/web 共用"是对的；但它是一个 Claude 形状、拍平的可选字段 bag，自己的 docs/RUNTIME-ARCHITECTURE.md 第 6 条都在要求 typed contract。我们取它的思想，不取它的形状。

### Q2 什么形态能接受最广的输入、做到最广的输出？

**形态 = "session 是中心，channel 和 runtime 都是插头"**：

- 输入侧：任何来源（飞书消息、会议事件、邮件、音箱、私有通道、cron、HTTP trigger）都先变成 `Inbound`，进同一个 session lane。非消息事件（会议邀请、文档评论）转成合成消息，这是 openclaw `monitor.vc-meeting-invited-handler.ts` 和 multica autopilot 的做法。
- 输出侧有两条路，**而且只需要两条**：
  1. **订阅**：任何端订阅 session 的事件流，按自己的 tier 渲染（full / progress / final / narration）。
  2. **主动发送工具**：给 agent 一个 MCP 工具 `send(target?, content)`，让它主动决定"往哪发、发什么形态"（卡片、文件、TTS、邮件）。这是 happyclaw 的 `send_message/send_image/send_file`、botmux 的 `botmux send`、Claude Channels 的 reply 工具、Codex 的 `item/tool/call` 共同指向的模式。宿主根据认证过的 session/turn 推导路由，不允许 runtime 指定任意路由（botmux remote-runner 规则："外发消息不允许 provider 指定路由"）。

"最广输出"靠第 2 条，而不是靠把每种输出形态塞进统一协议。

### Q3 输出是不是可以认为是订阅某个 agent 的输出？可以多端展示？

**是。** 而且三个参考项目已经收敛到同一个答案，只是落地程度不同：

- Codex 原生支持：一个 thread 多个连接，`ThreadScopedOutgoingMessageSender.connection_ids` 广播（codex-rs/app-server/src/outgoing_message.rs）；botmux 用 engine 连接写 `turn/start`、`codex --remote` TUI 作为第二个客户端旁观（src/codex-rpc-engine.ts 头注释说已验证）。
- openclaw：`sessions.messages.subscribe {key, mode: full|narration}`，"passive views of runs started by another client"（src/gateway/server-methods/sessions-subscriptions.ts）。
- happyclaw：`broadcastStreamEvent` 按 ACL fan-out，连接时补发 `active_run_snapshot` + `stream_snapshot`（src/web.ts:1608-1730）。
- multica：`task_message` 落库 + `task:message` 广播，客户端按 seq 合并快照和增量（packages/core/chat/queries.ts `mergeTaskMessagesBySeq`）。

**但要区分"投影"和"投递"**（happyclaw docs/BUSINESS-MODEL.md "回复归属"、openclaw lastRoute、multica `channel_task_delivery` 三家都这么做）：

- **投影（projection）**：谁都可以订阅看，受 ACL 约束。
- **投递（delivery）**：一个 turn 的"正式回复"默认只回发起这条输入的那个 route（channel+account+chat+thread）。往别处发要么由 agent 调 `send` 工具，要么是该端显式订阅了 `final` tier。

为什么不让所有 IM 都自动镜像？happyclaw 和 openclaw 都**明确拒绝**了自动镜像（openclaw 还删掉了 channel docking），原因是群聊里突然出现别的渠道的对话属于信任和隐私问题。所以我们的做法是：IM 端"订阅"只能由 owner 显式开启（比如"把这个 session 的 final 推到我的飞书私聊"），默认只有 Web/TUI 这类 operator 端是全量订阅者。

### Q4 输入是不是也可以多端输入？

**可以，但必须串行到一个 lane。** 冲突语义只保留三种（openclaw 有四种 steer/followup/collect/interrupt，collect 砍掉，因为它带来"不同 route 的消息合并后回复该回哪"的复杂度，happyclaw 的 `selectChannelReplyBatch` 和 openclaw 都要专门处理这个问题）：

| 模式 | 语义 | Claude 映射 | Codex 映射 |
|---|---|---|---|
| `queue`（默认于不同 route / 不同权限的发送者） | 当前 turn 结束后作为新 turn | stdin 写 `SDKUserMessage{priority:'later'}` 或等 `result` 后再写 | 等 `turn/completed` 后 `turn/start` |
| `steer`（默认于同一 route 同一发送者） | 注入当前 turn | `SDKUserMessage{priority:'next'}`（sdk.d.ts:6242，工具调用之间并入）；老版本退回 multica 的 hook `additionalContext`（claude_supplement.go） | `turn/steer {threadId, input, expectedTurnId}`（TurnSteerParams.ts），`expectedTurnId` 不匹配就降级为 queue |
| `interrupt` | 取消当前 turn，丢弃 queue | `control_request{subtype:'interrupt'}` | `turn/interrupt` |

两条硬规则（来自 openclaw docs/concepts/queue-steering.md 和 botmux active-turn-authority.ts）：
1. **权限不能借用**：权限不同的发送者，消息只能 queue，不能 steer 别人的 turn。
2. **每个 turn 只有一个 reply route**：不同 route 的输入永远不合并成同一个 turn（happyclaw channel-reply-source.ts）。

---

## 2. 架构

```
   私有通道(任意语言)   飞书/会议   邮件    小米音箱(语音)      Web / TUI / 手机
        │ JSONL/stdio      │          │      │                     │ WS
        ▼                  ▼          ▼      ▼                     ▼
  ┌──────────────── Channel Adapters（薄：收、发、渲染）───────────┐ ┌─────────┐
  │ in: emit(Inbound)        out: render(SessionEvent by tier)    │ │ WS API  │
  └───────────────┬──────────────────────────────▲───────────────┘ └──┬───▲──┘
                  │ Inbound                      │ SessionEvent        │   │
                  ▼                              │ (subscribe fromSeq) │   │
  ┌──────────────────────────── Gateway（唯一自建的厚一点的部分）─────────────┐
  │  Router: route → sessionId（显式绑定，未绑定不回）                          │
  │  Lane:   每 session 一条串行 lane，queue / steer / interrupt               │
  │  Log:    每 session append-only 事件日志（seq），SQLite                      │
  │  Hub:    订阅 fan-out + 快照补齐 + tier 过滤                                │
  │  Interact: 审批/提问 广播，first-wins，resolved 撤卡                       │
  │  MCP:    宿主工具 send / get_context（每 run 一个 token）                   │
  └──────────┬─────────────────────────────────────▲───────────────────────┘
             │ 原生命令                              │ 原生事件 → projector(~200 行) → SessionEvent{native}
             ▼                                      │
  ┌─────────────── Runtime Adapters（不发明协议，只做映射）───────────────┐
  │ ClaudeAdapter: claude -p --input-format stream-json                    │
  │   --output-format stream-json --include-partial-messages               │
  │   --replay-user-messages --permission-prompt-tool stdio  (常驻, --resume) │
  │ CodexAdapter:  codex app-server --listen unix://… (JSON-RPC)           │
  │   turn/start | turn/steer | turn/interrupt | serverRequest 审批          │
  │   └─ 可选：codex --remote 作为额外的原生客户端直接挂上去（不经网关）   │
  └────────────────────────────────────────────────────────────────────────┘
```

语音不是一个 channel，而是一个**前台 agent**：

```
 小米音箱 / 飞书会议音频 ⇄ realtime 模型(gpt-realtime) ── 工具 agent_consult(text) ──▶ Gateway Inbound(steer/queue)
                                ▲                                                 │
                                └──── 订阅 narration tier / final 摘要 ◀──────────┘
```

---

## 3. 哪里统一 **不值得**（本视角的核心论点）

1. **富展示（卡片 / 按钮 / 表格）不统一。** openclaw 的 `MessagePresentation` + `presentationCapabilities` + 自动降级 + 合约测试是一整套系统；multica 的 `OutboundMessage` 只有纯文本，富输出散落在各 adapter 里，但也能跑。我们选 multica 这边：核心只提供 `text` 和 `kind`，飞书 adapter 自己决定怎么拼 CardKit 卡片（参考 happyclaw src/feishu-streaming-card.ts、openclaw extensions/feishu/src/streaming-card.ts，飞书自己的 10 QPS/30KB/10 分钟限制只有飞书 adapter 需要知道）。需要"agent 指定卡片"时，走 `send` 工具 + 通道私有 payload（openclaw `channelData` 逃生舱的同款思路）。
2. **工具语义不统一。** Codex 的 `commandExecution{command,cwd,exitCode,aggregatedOutput}`、`fileChange{changes}` 和 Claude 的 `tool_use{name:'Bash',input}` 语义差异很大。核心只抽 `{id, name, title, status}`，其他放 `native`。openclaw 想把这层做全，结果就是 356 个文件的投影。
3. **跨 runtime 的 transcript 不统一。** 线程状态以原生为准：Claude 的 `~/.claude/projects/*.jsonl`、Codex 的 rollout。openclaw 的 runtime ownership 矩阵也承认 "Codex-owned thread，OpenClaw 只 mirror"。我们的事件日志是**展示日志**，不是 runtime 的权威状态，不用于 resume。
4. **不用 ACP 做核心。** codex-acp / claude-agent-acp 确实给了一个统一 schema，但会丢掉 Codex 的多客户端、queue、realtime、turn diff、expectedTurnId，还多一跳进程（docs/research/codex.md）。ACP 留作第三方 agent 的兜底 adapter。
5. **不做 PTY 刮屏。** botmux 证明了它可行但极脆（paste-burst、spinner 正则、启动时机）。两个目标 runtime 都有结构化协议，刮屏没有存在理由。唯一例外：想让人直接接管时，Codex 用 `codex --remote` 挂到同一个 app-server 上（原生多客户端），而不是 tmux。
6. **不统一语音。** 语音的半双工、打断、延迟要求和文本 agent 完全不同。openclaw 的做法（realtime 前台 + `agent_consult` 委托到后台 session）把语音变成"另一个输入源 + 一个 narration 订阅者"，不需要在核心协议里加音频帧。Codex 的 `thread/realtime/*` 还是 experimental，可以作为后续实验，不进核心。
7. **不统一入站的平台细节。** 只放 multica `InboundMessage` 那样的跨平台共有字段，平台私有字段放 `raw`，核心不读。不要复刻 openclaw 那 250 个字段。
8. **不做 seq 以外的复杂 fence。** openclaw 的 epoch / one-shot handoff / 各种 custody 模式，对单机小团队太重。保留两个就够：`seq`（订阅续传）和 `turnId`/`attempt`（拒收旧 attempt 的迟到事件，happyclaw `streamRunFence`、botmux `dispatchAttempt`）。

---

## 4. 协议（全部类型）

```ts
// ---------- 入站 ----------
type Trust = 'owner' | 'member' | 'guest' | 'peer';      // peer=其他 agent，不能审批
interface Route {                                       // 回复目的地，不可变
  channel: string; account: string; chat: string; thread?: string;
}
interface Inbound {
  id: string;                 // 通道侧消息 id，用于 dedupe
  route: Route;
  sender: { id: string; name?: string; trust: Trust };
  text: string;
  attachments?: { name: string; mime: string; path: string }[]; // 已落盘
  replyTo?: string;
  mode?: 'auto' | 'queue' | 'steer' | 'interrupt';
  raw?: unknown;              // 平台私有，核心不读
}

// ---------- 会话事件（出站，唯一自建的统一层）----------
type Kind =
  | 'input.accepted'          // 某条 Inbound 进入了哪个 turn（多端可见谁说了什么）
  | 'turn.started' | 'turn.finished'
  | 'text.delta' | 'text.final'
  | 'thinking.delta'
  | 'tool.started' | 'tool.finished'
  | 'request.opened' | 'request.resolved'   // 审批 / AskUserQuestion / elicitation
  | 'status'                  // idle | running | waiting(approval|input) | error
  | 'native';                 // 没有映射的原生事件，只给 full tier

interface SessionEvent {
  sessionId: string;
  seq: number;                // gateway 分配，单调
  ts: number;
  runtime: 'claude' | 'codex';
  turnId?: string; attempt?: number; inputId?: string;
  kind: Kind;
  level: 'primary' | 'detail' | 'debug';   // 抄 happyclaw displayLevel
  text?: string;
  tool?: { id: string; name: string; title?: string; status?: 'ok' | 'error' };
  request?: { id: string; type: 'approval' | 'question'; title: string; options: string[] };
  result?: { status: 'completed' | 'failed' | 'interrupted'; usage?: unknown };
  native?: unknown;           // 原始 SDKMessage / app-server notification，原样
}

// ---------- 客户端 → 网关（WS，Web/TUI/私有 UI 共用）----------
type ClientCmd =
  | { op: 'subscribe'; sessionId: string; fromSeq?: number; tier: 'full' | 'progress' | 'final' | 'narration' }
  | { op: 'unsubscribe'; sessionId: string }
  | { op: 'send'; sessionId: string; inbound: Omit<Inbound, 'route'> }   // route = 该 WS 端自身
  | { op: 'resolve'; sessionId: string; requestId: string; choice: string }
  | { op: 'interrupt'; sessionId: string };

type ServerMsg =
  | { op: 'snapshot'; sessionId: string; upToSeq: number; status: string; partial?: string; openRequests: SessionEvent[] }
  | { op: 'event'; event: SessionEvent }
  | { op: 'gap'; sessionId: string; reason: 'truncated' }   // 抄 CCR catch_up_truncated
  | { op: 'ack'; ref: string; ok: boolean; error?: string };
```

tier 的含义（全部是服务端过滤，不需要端自己理解所有 kind）：

| tier | 收到的 kind | 典型端 |
|---|---|---|
| full | 全部，包括 `native` | Web trace、TUI、调试 |
| progress | level ≤ detail，不含 native；text.delta 合并节流 | 飞书流式卡片 |
| final | input.accepted、request.*、text.final、turn.finished | 邮件、普通 IM |
| narration | 每 2 秒一份可见文本尾部快照（≤ 4k）、request.* | 音箱、手表、侧栏（抄 openclaw narration） |

---

## 5. Channel Adapter 接口（私有通道要实现的全部）

```ts
interface ChannelAdapter {
  id: string;                                   // 'feishu' | 'mail' | 'acme-im' ...
  caps: { edit?: boolean; files?: boolean; buttons?: boolean; maxText?: number };
  start(ctx: {
    emit(msg: Inbound): Promise<void>;          // 入站，网关负责 dedupe/路由/lane
    signal: AbortSignal;
    log(...a: unknown[]): void;
  }): Promise<void>;
  // 网关为每个"需要投递到该通道的 turn"或"显式订阅"调用一次，传入已按 tier 过滤的事件流
  render(route: Route, events: AsyncIterable<SessionEvent>, tier: Tier): Promise<void>;
  // agent 调 send 工具 / 审批卡被点击时
  send?(route: Route, content: { text?: string; files?: string[]; channelData?: unknown }): Promise<{ messageId?: string }>;
}
```

关键设计：**`render` 吃一个 AsyncIterable，而不是 openclaw 那样一长串 `onToolStart/onItemEvent/onPlanUpdate...` 回调**。最简单的通道写成

```ts
for await (const e of events) if (e.kind === 'text.final') await api.post(route.chat, e.text)
```

就完事了；飞书 adapter 则在同一个循环里维护 CardKit 卡片状态。审批卡被点击时，adapter 调网关的 `resolve`（通过 ctx 注入，简化起见省略）。

**进程外形态（私有通道的推荐方式）**：同一个接口按 JSONL 跑在 stdio 上，抄 botmux remote-runner 协议的骨架：`hello{caps}` 握手 → 子进程写 `{"t":"inbound",...}`，网关写 `{"t":"render","route":...,"event":...}`、`{"t":"send",...}`，子进程回 `{"t":"sent","opId":...,"status":"delivered|rejected|unknown"}`（unknown 不自动重放，抄 botmux）。这样私有通道可以用任何语言写，不用 fork 网关。happyclaw 加一个通道要改 8 处、botmux 的 `ImAdapter` 根本没接上，这两个都是反例。

---

## 6. Runtime Adapter：怎么包 Claude Code 和 Codex，哪里有损

```ts
interface RuntimeAdapter {
  kind: 'claude' | 'codex';
  open(s: { sessionId: string; cwd: string; resume?: string; mcpUrl: string; mcpToken: string }): Promise<RuntimeSession>;
}
interface RuntimeSession {
  nativeId(): string | undefined;               // Claude session_id / Codex threadId，用于 resume
  send(input: { text: string; attachments?: unknown[]; mode: 'queue' | 'steer' }, inputId: string): Promise<'accepted' | 'queued'>;
  interrupt(): Promise<void>;
  resolve(requestId: string, choice: string): Promise<void>;
  events: AsyncIterable<SessionEvent /* seq 留空，由网关分配 */>;
  close(): Promise<void>;
  caps: { midTurnSteer: boolean; nativeMultiClient: boolean };
}
```

**Claude Code**（openclaw extensions/anthropic/cli-transport.ts、multica claude.go 的做法）
- 进程：`claude -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages --replay-user-messages --permission-prompt-tool stdio [--resume <id>] --mcp-config <网关 MCP>`，常驻，跨 turn 复用。
- 输入：stdin 写 `SDKUserMessage`，`priority` 映射 steer/queue；`origin:{kind:'channel', server}` 带上来源。
- 输出：`stream_event` → text/thinking.delta；`assistant.tool_use` → tool.started；`user.tool_result` → tool.finished；`result` → turn.finished；`session_state_changed` → status；`control_request{can_use_tool}` → request.opened。
- 也可以用 TS Agent SDK `query({prompt: AsyncIterable})`（happyclaw 的方式），协议相同，好处是可以进程内挂 `createSdkMcpServer`；坏处是多一层 SDK 版本兼容（happyclaw 写了 sdk-compat.ts）。**二选一，MVP 选 CLI stream-json**，因为它和 Codex 一样是"子进程 + 线协议"，adapter 对称。
- 有损：没有原生多客户端（网关 Hub 补）；`priority:'next'` 依赖较新版本（[推测] 需要握手时用 `system/init` 里的版本/capabilities 做特性探测）；Channels 在 `-p` 模式被忽略，所以不用 Claude Channels，直接写 stdin；AskUserQuestion 在 headless 下要自己渲染成 request。
- 必须注意的坑：stdin/stdout 两端都要持续读，否则死锁（multica 记录过）。

**Codex**（botmux codex-rpc-engine.ts、openclaw extensions/codex、multica codex.go）
- 进程：每个工作区一个 `codex app-server --listen unix://<path>`，握手 `initialize` 时 assert 版本（抄 openclaw `assertSupportedCodexAppServerVersion`），并用 `generate-ts` 锁定类型。
- 输入：`turn/start` / `turn/steer{expectedTurnId}` / `turn/interrupt`；`clientUserMessageId = inputId`，用来回绑哪条输入。
- 输出：`item/agentMessage/delta` → text.delta；`item/started|completed` → tool.*（按 item.type 取 title）；`turn/completed` → turn.finished；`thread/status/changed` → status；server requests `item/*/requestApproval`、`item/tool/requestUserInput` → request.opened；`serverRequest/resolved` → request.resolved。
- 不丢的部分：Codex 原生支持多客户端，所以**允许人类直接 `codex --remote unix://… resume <threadId>` 挂上去看和打字**，绕过网关也没关系。网关作为另一个客户端仍能收到这些 turn（app-server 广播给所有连接），会以 `input.accepted{sender: 'native-tui'}` 的形式出现在日志里。
- 有损：通知不带 seq（网关日志补）；空 thread 没 rollout 时第二个客户端没法 resume；30 分钟无订阅会卸载 thread（网关保持一个常连即可）；app-server 仍是 experimental。

**能力不对称怎么处理**：`caps.midTurnSteer=false` 时 lane 把 steer 降级为 queue，并发一个 `status` 事件告诉各端（openclaw 对 claude-cli 就是这么降级的）。不要为了对称而在宿主侧模拟 steer。

---

## 7. 过程可见性方案

用户要求"看见中间过程"。分层实现，每层都只消费 `SessionEvent`：

1. **Web（full tier）**：时间线 = text、thinking、工具卡片（name/title/status，展开看 `native` 里的 args/result）、审批卡、status。抄 multica task-transcript 的 seq 渲染 + happyclaw 的 `?turn=<id>&trace=1` 深链接。Codex diff、Claude subagent 嵌套这些 runtime 特有的展示，读 `native`，按 runtime 写两个小组件，不进核心协议。
2. **飞书（progress tier）**：每个 turn 一张流式卡片 = 正文（累积文本）+ 折叠区（最近 N 个工具行）+ 状态行 + 审批按钮 + "在 Web 查看完整过程"链接。节流约 1.2s（happyclaw 的数值，飞书 CardKit 单卡 10 QPS）。默认安静（openclaw progress-draft 的经验：工具行默认不展开，审批永远可见）。
3. **邮件 / 普通 IM（final tier）**：只发最终答复 + 链接。
4. **音箱（narration tier）**：只播报 primary 级别的一句状态，比如"正在跑测试""需要你确认是否删除文件"。
5. **可选的原生 TUI**：Codex 用 `codex --remote` 直接看原生 TUI；Claude 没有等价的东西（`claude attach` 只允许单终端），所以 Claude 只靠 Web。

"推累积全量、消费者做 diff"（botmux CotEntry 的做法）只在 progress tier 里使用：卡片每次 patch 的都是全量文本，天然幂等。

---

## 8. 语音与实时

- 小米音箱、飞书会议都**不直接接** Claude Code/Codex。它们前面是 realtime 模型（gpt-realtime），负责听、说、打断。
- realtime 模型只有三个工具：`agent_consult(text)`（→ 网关 `send`，mode 默认 steer 或 queue）、`agent_status()`（读 narration 快照）、`agent_cancel()`（→ interrupt）。这是 openclaw `openclaw_agent_consult` 的同款设计（docs/plugins/voice-call/realtime-and-streaming.md）。
- 音箱同时订阅该 session 的 narration tier；当 `request.opened` 到来时，realtime 模型用语音问"要不要允许…"，用户口头回答后调 `resolve`。审批选项只给 allow once / deny，"always" 不允许口头授予（[推测] 理由：语音识别的错误率不适合授予持久权限）。
- 会议：沿用 botmux 会议设计里的"分析可以多份，副作用单出口"——会议转写作为 `Inbound`（`trust: 'guest'`、mode=queue）喂进去，agent 的发言只能通过 `send` 工具，经由会议 adapter 唯一出口。
- 延迟：Claude/Codex 的 turn 是秒到分钟级，语音不能等它，所以 realtime 模型必须先口头回应"我去查一下"，再异步播报 final。这就是为什么语音不能做成普通 channel。
- Codex `thread/realtime/*` 是 experimental，作为第二阶段实验：对 Codex session 可以省掉自建 realtime 桥。

---

## 9. 会话与身份（最小集）

- `sessionId` 是网关自己的 id；绑定表 `route → sessionId` 必须显式建立（happyclaw Channel Mount、multica `channel_chat_session_binding`），未绑定的群一律沉默。
- 会话记录 `runtime` 和 `nativeId`（Claude session_id / Codex threadId），用于 resume。
- `trust`：owner 可以审批和 steer；member 可以 queue；guest（会议转写、邮件陌生人）只能 queue，且内容用 `trusted=false` 包裹（botmux `botmux_external_event`）；peer（其他 agent）不能审批（Claude 的 `SDKMessageOrigin.peer` 规则）。
- 渠道凭据不进 runtime；MCP `send` 工具用每 run 一个短 token 鉴权（openclaw `OPENCLAW_MCP_TOKEN`、multica task 级 `MULTICA_TOKEN`）。
- 审批：广播给所有能审批的订阅端，first-wins，其他端收到 `request.resolved` 后撤卡（Codex `serverRequest/resolved`、Claude Remote Control 同样语义）。迟到加入的端在 snapshot 里拿到 `openRequests`（Codex `replay_requests_to_connection_for_thread`）。

---

## 10. MVP 计划

1. **定类型**：`packages/protocol`，就是第 4 节的 TS 类型，zod 或 TypeBox 出 JSON Schema（给私有通道用）。约 200 行。
2. **Gateway 核心**：SQLite 两张表 `events(session_id, seq, ...)`、`bindings(route_key, session_id)`；lane（每 session 一个 Promise 链 + 待处理队列）；Hub（内存订阅表 + `fromSeq` 从 SQLite 回放；超过 N 条发 `gap`）。
3. **ClaudeAdapter**：stream-json 子进程 + projector；先 bypassPermissions 跑通，再接 `--permission-prompt-tool stdio`。
4. **Web 端**：一个页面，`subscribe full`，渲染时间线 + 输入框 + 审批按钮。这一步做完就能验证"多 tab 同时看、同时发"。
5. **飞书 adapter**：先做 final tier（纯文本回复），再做 progress 流式卡片。
6. **CodexAdapter**：app-server unix socket + projector + steer；顺手验证 `codex --remote` 挂同一 thread。
7. **MCP `send` 工具 + 进程外 JSONL channel 协议**，用一个 50 行的 echo 私有通道做参考实现（抄 botmux examples/remote-runner/reference-runner.mjs、openclaw extensions/qa-channel 的思路）。
8. **语音**：realtime 前台 + `agent_consult`，接 narration tier。
9. **邮件**：final tier + 入站 trust=guest。

每一步都可以单独交付；1–4 合起来就是一个"多端看、多端说的 Claude Code"。

---

## 11. 风险

- **原生协议漂移**：Codex app-server 是 experimental，Claude stream-json 字段迭代很快。对策：握手时 assert 版本、用 `generate-ts` 锁定类型、`native` 透传保证新事件不丢，projector 遇到不认识的事件一律出 `kind:'native'`。
- **最小公分母太小**：某些端会想要 runtime 特有的展示（Codex diff、Claude subagent 树）。对策：这些读 `native`，代价是这些端要按 runtime 写分支。这是有意的取舍，第 3 节已经论证过。
- **steer 能力不对称**：Claude 的 `priority:'next'` 依赖版本，Codex 的 steer 会被 review/compaction turn 拒绝。对策：降级为 queue 并通知各端。
- **双写者**：Codex 允许原生 TUI 直接写，网关日志可能看到"不是经网关来的输入"。对策：把它当作 `sender:'native-tui'` 的普通事件记录；Claude 侧不开放原生直连。
- **事件日志膨胀**：text.delta 量大。对策：turn 结束后把 delta 压缩成一条 `text.final`，delta 只保留最近 N 个 turn。
- **IM 订阅的信任问题**：显式订阅可能把私密 session 推到群里。对策：只允许 owner 把 session 订阅到自己的私聊；群里只有该群发起的 turn 才会投递。
- **长 turn 和卡片限制**：飞书流式卡片 10 分钟自动关闭、30KB 上限。对策：由飞书 adapter 自己续卡（happyclaw 有现成做法），核心不感知。
- **stream-json 管道死锁、Codex 首个 item 超过 30s、进程组清理**：这些都是 multica 踩过的坑，adapter 里要有 watchdog，但 watchdog 留在 adapter 内部，不进协议。
