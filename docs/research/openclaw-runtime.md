# OpenClaw：agent runtime 与 Gateway 协议调研

- 仓库：https://github.com/openclaw/openclaw（本地快照 commit `3a7139a6`，2026-10-06）
- 范围：只看 agent runtime 侧和 Gateway WS 协议/事件模型。不看 channel 插件的具体实现（channel 部分只看接口）。
- 标注规则：没写 "猜测" 的结论都有文件可查；标了 **[猜测]** 的是推断。

---

## 0. 一句话

OpenClaw 是一个长驻的 **Gateway 守护进程**。它统一持有所有 channel 连接（Telegram/Slack/Feishu/WhatsApp…）和所有 agent session。agent 的执行交给可插拔的 **harness/runtime**：内置 `openclaw`（原 pi）、Codex app-server（JSON-RPC over stdio）、claude-cli（Claude Code `--input-format stream-json` 双向 stdio），外部 harness 还可以走 ACP/acpx。不同 runtime 的原生事件都先投影成**同一套进程内事件** `AgentEventPayload{runId, seq, stream, ts, data}`，再由 Gateway 投影成两种 WS 事件：`agent`（原始流）和 `chat`（显示用流）。按"连接 × session 订阅"扇出给 Web UI、移动端、CLI、ACP bridge 和 channel 回复分发器。

---

## 1. Agent runtime 怎么跑

### 1.1 分层：Provider / Model / Runtime / Channel

`docs/concepts/agent-runtimes.md` 把这几层明确拆开了：

| Layer | 例子 | 含义 |
|---|---|---|
| Provider | anthropic, openai | 鉴权、模型发现 |
| Model | claude-opus-4-6 | 本轮用的模型 |
| Agent runtime | `claude-cli`, `codex`, `copilot`, `openclaw` | 执行这一轮的底层 loop |
| Channel | Discord, Slack… | 消息从哪进、回哪去 |

runtime 有两大类（同一文档）：
- **Embedded harness**：在 OpenClaw 准备好的 agent loop 里运行。包括内置 `openclaw`，以及插件注册的 `codex`（Codex app-server）、`copilot`。
- **CLI backend**：起一个本地 CLI 子进程，例如 `claude-cli`。文档特意说明它"不是 embedded harness id"。
- 第三类是 **ACP**（`runtime: "acp"`，经 acpx 插件），用于 Claude Code、Gemini CLI、OpenCode、Cursor 等外部 harness。决策树原文（`agent-runtimes.md`）："Claude Code, Gemini CLI, OpenCode, Cursor, Droid, or another external harness -> ACP/acpx"。不过 claude-cli backend 本身也是一等的 Claude Code 驱动方式（见 1.4）。

runtime 选择看 model/provider 维度的 `agentRuntime.id` 配置，不按整个 agent 设：

```json5
agents.defaults.models["anthropic/claude-opus-5"].agentRuntime = { id: "claude-cli" }
```

`auto` 模式下，插件 harness 可以按 provider route "认领"一轮；没人认领就回落到 `openclaw`（`docs/agent-runtime-architecture.md` "Runtime Selection"）。

### 1.2 "谁拥有什么"的矩阵

这张表最值得借鉴（`docs/concepts/agent-runtimes.md` "Runtime ownership"）：

| Surface | OpenClaw embedded | Codex app-server |
|---|---|---|
| Model loop owner | OpenClaw | Codex app-server |
| Canonical thread state | OpenClaw transcript | **Codex thread + OpenClaw transcript mirror** |
| OpenClaw dynamic tools | 原生 | 经 Codex adapter 桥接 |
| Native shell/file tools | OpenClaw | Codex 原生，经 native hooks 桥接 |
| Compaction | OpenClaw | Codex 原生，OpenClaw 收通知并维护 mirror |
| Channel delivery | OpenClaw | OpenClaw |

设计原则原文："if OpenClaw owns the surface, it can provide normal plugin hook behavior. If the native runtime owns the surface, OpenClaw needs runtime events or native hooks. If the native runtime owns canonical thread state, OpenClaw mirrors and projects context rather than rewriting unsupported internals."

**对我们的意义**：直接用 Claude Code/Codex，线程状态的权威就在它们那边。我们这层只做 **mirror + projection**，不要试图接管它们的内部状态。

### 1.3 Harness 插件契约（`src/agents/harness/types.ts`）

```ts
type AgentHarnessContract<TAttemptParams, TSideQuestionParams> = {
  id: string; label: string; pluginId?: string;
  autoSelection?: { providerIds: readonly string[] };
  supports(ctx: AgentHarnessSupportContext): AgentHarnessSupport;
  runAttempt(params: TAttemptParams): Promise<AgentHarnessAttemptResult>;   // 核心
  finalizeSettledTurn?(...); runSideQuestion?(...); compact?(...); reset?(...);
  sessionForkV2?: {...}; loadMcpToolCatalog?(...); loadModelCatalog?(...);
  dispose?(): ...;
  // 以及一堆 policy 声明：supportsTurnScopedToolRestrictions, conversationToolPolicySupport, ...
};
```

`runAttempt` 的入参（`src/agents/embedded-agent-runner/run/params.ts`）是一组回调：`onAgentEvent`、`onToolResult`、`onReasoningStream`、`onBlockReplyFlush`、`onRunProgress`、`onLaneWait`、`onSessionIdChanged`…… harness 通过 `emitAgentHarnessAttemptEvent`（`src/agents/harness/attempt-events.ts`）同时做两件事：调用全局 `emitAgentEvent(...)`，以及调用 `attempt.onAgentEvent`。lifecycle 的 `start` / `model` / `end` / `error` 由 `createAgentHarnessAttemptLifecycle` 统一生成。

### 1.4 三种 runtime 的具体接法

**(a) Codex：app-server JSON-RPC over stdio**
- 启动：`codex app-server --listen stdio://`（`extensions/codex/src/app-server/transport-stdio.ts`；另有 `transport-websocket.ts`）。
- 发起和控制：`turn/start`、`turn/steer`（`attempt-steering.ts`）、`turn/interrupt`（`attempt-client-cleanup.ts`）。
- 原生通知投影：`extensions/codex/src/app-server/event-projector.ts` 把 `item/agentMessage/delta`、`item/reasoning/*Delta`、`item/plan/delta`、`turn/plan/updated`、`item/started|completed`、`item/commandExecution/outputDelta`、`thread/tokenUsage/updated`、`turn/completed`、`hook/started|completed`、`error`… 逐个映射到 OpenClaw 的 agent event 流。
- 审批：`approval-bridge.ts` 把 `item/commandExecution/requestApproval`、`item/fileChange/requestApproval` 这类 server request 转成 OpenClaw 的 plugin/exec approval 往返（`plugin-approval-roundtrip.ts`）。
- 结束判定由 Codex 原生的 `turn/completed` 决定，OpenClaw 不靠超时或静默去猜（`docs/concepts/agent-loop.md`）。

**(b) Claude Code：claude-cli backend，双向 stream-json**
- 参数（`extensions/anthropic/cli-runtime-args.ts`）：
  ```
  --print --input-format stream-json --output-format stream-json --verbose
  --include-partial-messages --replay-user-messages
  --permission-prompt-tool stdio --permission-mode default
  --setting-sources <...> --model <id> [--tools ...]
  ```
- `extensions/anthropic/cli-transport.ts`："One Claude Code subprocess and its bidirectional stream-json control channel"。stdin 写 JSONL；stdout 按行解析，分别处理 `control_request`（权限回调，可以 await 操作者）、`control_response`（initialize 握手）、`control_cancel_request` 和 `keep_alive`，其余交给 `onMessage`。
- 进程常驻：`liveSession: "claude-stdio"`，连续兼容的轮次复用同一个 Claude Code 进程。进程死了或 Gateway 重启就 `--resume <stored session id>`，resume 前会先校验 `~/.claude/projects/` 下的 transcript 是否存在（`docs/gateway/cli-backends.md`）。
- 工具：OpenClaw 自己的工具通过 **loopback HTTP MCP server**（`bundleMcp: true`，带每次运行有效的 `OPENCLAW_MCP_TOKEN`）注入，名字形如 `mcp__openclaw__*`。原生工具的审批走 `PreToolUse` hook 和 permission-prompt stdio，统一过 `before_tool_call` 策略。审批选项有 "Allow once / Allow always（仅限当前 live session）/ Deny"。
- 事件投影：`src/agents/cli-runner/execute-events.ts` 用 `projectAgentToolActivity` + `emitAgentEvent` 把 stream-json 里的 tool_use、tool_result、thinking、compaction 映射成同一套 `tool` / `item` / `thinking` 流。
- 限制：claude-cli 不支持同轮 steer。active run 期间新进来的消息排队成 followup（`docs/concepts/queue.md`："including when a native CLI cannot accept steering"；`docs/tools/subagents/slash-command.md`："including a busy CLI run"）。compaction 交给 Claude Code 自己做（`ownsNativeCompaction: true`）。

**(c) 内置 openclaw runtime（原 pi）**
- `src/agents/embedded-agent-runner/`、`packages/agent-core/`。`legacy alias pi normalizes to openclaw`。它是 OpenClaw 自研的 loop，我们不打算用，这里不展开。

**(d) ACP**：两个方向都支持
- OpenClaw 作为 ACP **client**：通过 acpx 跑 Claude Code、Gemini 等（`docs/tools/acp-agents.md`）。
- OpenClaw 作为 ACP **server**：`openclaw acp` 在 stdio 上讲 ACP，背后把请求转成 Gateway WS 的 `chat.send` 和 abort。`tool_call` / `tool_call_update` / `agent_thought_chunk` 由 Gateway 事件翻译而来；exec 审批翻成 `session/request_permission`（`docs/cli/acp.md` 兼容矩阵）。
- 另外还有 `openclaw mcp serve`：把 Gateway 的 channel 会话当 MCP 暴露给外部 Claude Code/Codex（`docs/cli/mcp.md`）。也就是反过来，让 Claude Code 把 channel 当工具用。

---

## 2. 统一的内部事件协议

### 2.1 进程内事件（所有 runtime 的汇合点）

`src/infra/agent-events.ts`：

```ts
export type AgentEventStream =
  | "lifecycle" | "tool" | "assistant" | "usage" | "error" | "item" | "plan"
  | "approval" | "command_output" | "patch" | "compaction" | "thinking"
  | (string & {});           // 开放扩展

export type AgentEventPayload = {
  runId: string;
  seq: number;              // 每个 run 单调递增
  stream: AgentEventStream;
  ts: number;
  data: Record<string, unknown>;
  sessionKey?: string; sessionId?: string; agentId?: string;
  lifecycleGeneration?: string;   // 不可枚举，重启代际
};
```

- `emitAgentEvent()` 负责分配 seq 和 ts、盖上 run context，再通知 listener。`onAgentEvent` 是全局订阅；`onAgentEventForRun(runId)` 是按 run 订阅。
- 带 owner 和代际的变体：`emitAgentEventIfCurrent`、`emitAgentEventForRunContext`。过期 run 的事件直接丢掉（防止重启或 reset 后，旧 run 的事件把新 session 冲掉）。
- 终态去重：`reserveAgentTerminalEvent`。一旦发布了确定性的 `lifecycle end/error`，后续同一个 execution 的 lifecycle 都会被压掉（`agent-loop.md` "Event streams"）。

### 2.2 各 stream 的 data 形状（节选）

- `lifecycle`：`{ phase: "start" | "model" | "finishing" | "end" | "error", startedAt?, error?, errorObservation?, executionSettled? ... }`
- `assistant`：`{ delta?: string, text?: string /*权威快照*/, replace?: boolean }`
- `tool`（`src/agents/embedded-agent-subscribe.handlers.tools.start.ts` / `.progress.ts` / `.completion.ts`）：
  ```ts
  { phase: "start", name, toolCallId, parentToolCallId?, args, hideFromChannelProgress? }
  { phase: "update", name, toolCallId, partialResult }
  { phase: "result", name, toolCallId, result, isError, ... }
  ```
- `item`：已经归一化的"活动条目"，给 UI 和进度卡用（`packages/gateway-protocol/src/schema/logs-chat.ts`）：
  ```ts
  AgentActivityItem = {
    itemId; phase: "start"|"update"|"end"; kind; title;
    status?: "running"|"completed"|"failed"|"blocked"|"skipped";
    name?; meta?; toolCallId?; startedAt?; endedAt?; error?; summary?; progressText?;
    hideFromChannelProgress?; approvalId?; ...
  }
  ```
- `command_output`（`src/infra/agent-activity-events.ts`）：`{ itemId, phase: "delta"|"end", title, toolCallId, output?, exitCode?, durationMs?, cwd? }`
- `patch`：`{ itemId, phase: "end", added[], modified[], deleted[], summary }`
- `approval`：`AgentApprovalEventData = { phase: "requested"|"resolved", kind: "exec"|"plugin", status, title, toolCallId?, approvalId?, command?, reason?, scope? }`
- `plan`：`{ phase: "update", steps, explanation? }`

**要点**：`tool` 是原始层（带 args 和 result），`item` / `command_output` / `patch` 是语义层（标题、状态、摘要），两层同时存在。不同客户端按能力挑一层消费。

### 2.3 Gateway WS 协议（`packages/gateway-protocol/src/schema/frames.ts`）

三种帧，按 `type` 区分：
```ts
RequestFrame  = { type: "req",  id, method, params?, traceparent?, expectedProfileId? }
ResponseFrame = { type: "res",  id, ok, payload?, error?: { code, message, details?, retryable?, retryAfterMs? } }
EventFrame    = { type: "event", event, payload?, seq?, stateVersion?, recipientProfileId? }
```
- 第一帧必须是 `connect`。`ConnectParams` 包含 `minProtocol/maxProtocol`、`client{id, mode, platform, version...}`、`role`（operator/node/worker）、`scopes`、`caps`、`commands`、`device{id, publicKey, signature, nonce}`、`auth{token|password|deviceToken...}`。
- 服务端回 `hello-ok`：`features.methods / events / capabilities`、`snapshot`、`auth{role, scopes, sessionCap: "write"|"suggest"|"view"|"none"}`、`policy{maxPayload, maxBufferedBytes, tickIntervalMs}`。
- schema 用 TypeBox 定义，生成 JSON Schema，再生成 Swift 模型（`docs/concepts/architecture.md`）。
- 副作用方法（`send` / `agent` / `chat.send`）必须带 `idempotencyKey`，服务端有短期去重缓存。
- 不变量："Events are not replayed. Clients must refresh on gaps."（`architecture.md`）。断线恢复靠 `chat.history` 的增量和 reset（`ChatHistoryDeltaResultSchema`：超过 200 条或超出字节预算就返回 `reset`）。

WS 上的 agent 事件（`packages/gateway-protocol/src/schema/agent.ts`）：
```ts
AgentEventSchema = { runId, seq, stream, ts, spawnedBy?, isHeartbeat?, data: Record<string, unknown> }
```
**注意 `data` 是 `Record<string, unknown>`，wire 上不做强类型**。stream 名就是判别字段，具体语义靠约定。

显示用的 chat 事件（`logs-chat.ts`），是闭合的 union：
```ts
ChatEventBase = { runId, sessionKey, agentId?, spawnedBy?, seq }
ChatEvent = Status{state:"status", phase: "waiting_for_state"|"preparing_workspace"|...|"starting_model", retry?}
          | Delta{state:"delta", deltaText, message?/*首帧给完整快照*/, replace?}
          | Final{state:"final", message?, usage?, stopReason?}
          | Aborted{state:"aborted", ...} | Error{state:"error", errorKind, errorDetail?, ...}
```
- 关于 delta 和快照的规则：接收者看到某个 run 的第一个文本帧时，一定附带完整的 `message` 快照，中途 attach 或重连也一样。之后的帧只带追加部分。`replace=true` 表示整段替换（`docs/gateway/protocol/rpc-bootstrap-and-events.md`）。这样即使中途加入的观察者也能正确渲染。
- 一个客户端只消费 `agent.assistant` 和 `chat` 两者之一，同时消费两者会导致重复。客户端可以在 caps 里声明 `chat-only-assistant-text`，让服务端不再发 assistant 文本的 agent 事件。

其它事件族（同一文档）：`session.message`、`session.operation`、`session.tool`、`session.narration`（≤16k 的可见尾部快照，2 秒节流，给侧栏和背景观察者用）、`session.approval`、`session.observer`（工具模型生成的 headline 摘要）、`sessions.changed`、`exec.approval.requested/resolved`、`plugin.approval.requested/resolved`、`presence`、`tick`、`health`、`cron`、`talk.event`……

### 2.4 SDK 再归一化一层（`packages/sdk/src/normalize.ts`、`types.ts`）

对外 SDK 把 Gateway 原始事件再压成一套干净的词表：
```ts
type OpenClawEventType =
  | "run.created"|"run.queued"|"run.started"|"run.completed"|"run.failed"|"run.cancelled"|"run.timed_out"
  | "assistant.delta"|"assistant.message"|"thinking.delta"
  | "tool.call.started"|"tool.call.delta"|"tool.call.completed"|"tool.call.failed"
  | "approval.requested"|"approval.resolved"|"question.requested"|"question.answered"
  | "artifact.created"|"artifact.updated"
  | "session.created"|"session.updated"|"session.compacted"
  | "git.branch"|"git.diff"|"git.pr"|"raw";

type OpenClawEvent<T> = { version: 1; id; ts; type; runId?; sessionId?; sessionKey?; agentId?; data: T; raw?: GatewayEvent };
```
映射关系：`stream==="tool"|"item"|"command_output"` 按 `phase` / `status` 落到 `tool.call.*`；`patch` 落到 `artifact.updated`；不认识的一律 `raw`，原样透传。**这套词表可以直接参考来做我们自己的 canonical 事件**。

---

## 3. 输出：订阅模型和多端扇出

### 3.1 事件到 WS 的扇出（`src/gateway/server-chat.ts`、`server-runtime-subscriptions.ts`）

- `startGatewayEventSubscriptions` 调用 `onAgentRuntimeEvent(evt => ...)`，统一处理所有 runtime 的事件。
- 每条事件同时投影成 `agent` 帧和 `chat` 帧（delta 有缓冲合并；tool start 前会先 flush 掉待发的 assistant 文本，保证"工具卡片之上的文字是完整的"）。
- 接收者有三类登记表：
  1. **run 级 tool recipients**（`server-chat-tool-recipients.ts`）：发起 run 的连接，按 `runId → Set<connId>` 记录，TTL 10 分钟，终态后宽限 30 秒。只有 caps 里声明了 `tool-events` 的连接才收结构化工具事件。
  2. **session 消息订阅**（`SessionMessageSubscriberRegistry`，见 `server-chat-state.ts`）：
     ```ts
     subscribe(connId, sessionKey, { includeApprovals?, provisional?, mode?: "narration", subscriptionId? })
     get(sessionKey) / getApprovals(sessionKey) / getNarration(sessionKey)
     ```
     对应 RPC `sessions.messages.subscribe` / `unsubscribe`。默认 mode 下收完整的 `chat` + `agent` 流，**包括其他客户端发起的 run**（"passive views of runs started by another client"）。
  3. **session 列表订阅**（`sessions.subscribe`），收 `sessions.changed` 行级增量。
- 中途 attach 的观察者不知道 runId，所以工具事件还会镜像一份成 `session.tool` 发给 session 订阅者（代码注释原文："Session subscribers power operator UIs that attach to an existing in-flight session after the run has already started... Mirror tool lifecycle onto a session-scoped event"）。
- 背压：广播时可以带 `dropIfSlow: true`，慢客户端会丢掉中间帧，靠快照和终态帧来纠正。
- 移动端 node 走 `nodeSendToSession(sessionKey, "agent", payload)`。

**结论：OpenClaw 的输出就是"订阅某个 session（或 run）的事件流"**。发起者、旁观的 Web UI、iOS/Android、TUI、ACP bridge 都只是订阅者，区别只在 mode（full / narration）、caps（tool-events、chat-only-assistant-text）和权限（includeApprovals 还要求审批权限）。

### 3.2 Channel 侧的输出：同一事件流的另一种投影

channel 不订阅 WS，而是在 run 内部通过 **ReplyDispatcher** 拿到输出：
- `src/auto-reply/reply/reply-dispatcher.types.ts`：`type ReplyDispatchKind = "tool" | "block" | "final"`
- `ReplyDispatcherOptions.deliver(payload: ReplyPayload, info)` 由 channel 实现。
- `ReplyPayload`（`src/shared/reply-payload.types.ts`）是 channel 无关的输出单元，字段有 `text`、`mediaUrls`、`presentation`（富展示，由 core 降级或交给 channel 渲染）、`isReasoning`、`isCommentary`、`isError`、`audioAsVoice`、`spokenText`、`replyToId`、`delivery`……
- 中间过程怎么在 IM 里展示：
  - **Block streaming**：按块发出完整的消息，不发 token delta（`docs/concepts/streaming.md`："there is no true token-delta streaming to channel messages"）。
  - **Preview streaming**：发一条预览消息然后不断 edit（Telegram/Discord/Slack/Matrix/Teams）。
  - **Progress drafts**（`docs/concepts/progress-drafts.md`）：一条消息不停 edit，显示 headline、plan 步骤（✅ ▸ ▢）、审批请求，可选滚动工具日志（`streaming.progress.toolProgress: true`）。数据来源就是 `item` / `plan` / `approval` 流，`hideFromChannelProgress` 字段决定哪些条目不上 IM。
  - `/verbose` 控制是否把工具详情当消息发到 IM。但 WS 上的 tool 事件"Always broadcast ... regardless of verboseLevel"（`server-chat.ts` 注释）。

### 3.3 回复路由

"OpenClaw routes replies back to the channel where a message came from. The model does not choose a channel"（`docs/channels/channel-routing.md`）。session 记录 `lastRoute`。`agent` RPC 有 `deliver` / `bestEffortDeliver` / `replyChannel` / `to` 参数，可以显式指定投递目标。

---

## 4. 输入：多端输入同一个 session

### 4.1 session key 是汇合点

- 默认 `session.dmScope: "main"`：所有 channel 的私聊（Telegram、WhatsApp、Web……）都落进 **同一个** `agent:<agentId>:main`（`docs/concepts/main-session.md`："Ask something on your phone, follow up from your laptop, and the agent has the same context in both places"）。
- 群和频道各自独立：`agent:<id>:<channel>:group:<id>`、`...:channel:<id>:thread:<tid>`。
- `session.identityLinks` 把同一个人在不同 channel 的身份合并。
- 群活动以"compact notice"的形式汇入 main session（被动感知，不会每条都唤醒）。

### 4.2 冲突处理：per-session lane + queue mode

- 每个 session 一个串行 lane（`session:<key>`），CLI、embedded、Codex 共用。外面再套一个全局 `main` lane 控制并发（`docs/concepts/queue.md`）。
- active run 期间又有新输入进来时，按 queue mode 处理（`QUEUE_MODES = ["steer","followup","collect","interrupt"]`，见 `logs-chat.ts`）：
  - `steer`（默认）：注入当前运行的 runtime。内置 runtime 在 tool batch 边界检查；Codex 先按 quiet window 攒一批，再发一次 `turn/steer`；runtime 不支持同轮 steer 的（例如 claude-cli）退化为 followup。
  - `followup`：排在当前 run 之后。
  - `collect`：静默窗口内攒的消息合并成一轮；如果目标 channel 或 thread 不同，就分开 drain，以保住路由。
  - `interrupt`：中止当前 run，执行最新那条。
  - 带 debounce（默认 500ms）、`cap: 20`、`drop: "summarize"|"old"|"new"`。
- 权限不借用："Collecting messages or steering an active run requires compatible operator sources and tool permissions; other input waits in FIFO order instead of borrowing the active or newest sender's permissions"（queue.md）。
- 写入防护：run 准入时写一条 `activeWriterRunId` claim，每次写 transcript 都带 `expectedWriterRunId` 做 CAS（`agent-loop.md`），被取代的 run 写不进去。
- 客户端乐观并发：`chat.send` 的 `expectedLeafEntryId`（transcript 分支 CAS）、`expectedPermissionMode`、`expectedToolOverrides`。
- pending question 优先："A plain-text answer to a pending agent question goes to that question before ordinary queue handling"。

### 4.3 输入 RPC

- `chat.send`（`ChatSendParamsSchema`）：`{ sessionKey, message, attachments?, mentions?, workContext?, queueMode?, thinking?, fastMode?, originatingChannel?/To?/AccountId?/ThreadId?, replyToId?, systemInputProvenance?, expectedLeafEntryId?, idempotencyKey }`
- `agent`（`AgentParamsSchema`）：更底层的 run 请求，带 `deliver`、`channel`、`replyChannel`、`lane`、`cwd`、`internalEvents`、`inputProvenance`、`idempotencyKey`…… 请求立即返回 `{runId, acceptedAt}`，随后流式推事件；`agent.wait` 等终态。
- `chat.abort`、`chat.inject`（往 transcript 插一条操作者可见的合成消息）、`sessions.send`、`sessions.abort`、`exec.approval.resolve`（需要 `operator.approvals`）。
- `InputProvenanceSchema = { kind, originSessionId?, sourceSessionKey?, sourceChannel?, sourceTool?, sourceRole?, jobId?, runId? }`：每条输入都带来源，用于权限判断和展示。

### 4.4 Channel 入口（接口层）

channel 插件在 `gateway.startAccount` 里起长连接，收到消息后调 `core.channel.inbound.run({ channel, accountId, raw, adapter: { ingest, resolveTurn } })`（`src/plugins/runtime/types-channel.ts`、用例 `extensions/feishu/src/bot.ts:1629`）：
- `ingest()` 返回 `{ id, timestamp, rawText, textForAgent, textForCommands, raw }`
- `resolveTurn()` 返回 `{ route: {agentId, sessionKey}, ctxPayload: MsgContext, dispatcherOptions, delivery, replyOptions }`，或者 `admission: { kind: "observeOnly" }`（只旁听不回复，用于群广播）。

`ChannelPlugin`（`src/channels/plugins/types.plugin.ts`）由一组可选 adapter 组成：`config`、`gateway`、`outbound`（`sendText` / `sendMedia` / `sendPayload` / `sendPoll`、`chunker`、`textChunkLimit`）、`streaming`、`threading`、`approvalCapability`、`commands`、`security`、`pairing`、`agentTools`、`gatewayMethods`…… 都是可选的，channel 按能力实现。

### 4.5 实时语音（和"小米音箱 + gpt-realtime"直接相关）

`docs/gateway/protocol/rpc-talk-config-and-agents.md`：
- `talk.session.create`：Gateway 托管的 realtime relay、transcription relay 或 stt-tts managed-room。`talk.session.appendAudio` 推 PCM，`talk.session.cancelOutput` 处理 barge-in。
- `talk.client.create`：客户端直连 realtime provider（WebRTC 或 provider-websocket），**凭据、指令、工具策略由 Gateway 掌握**。
- 关键模式：realtime 模型调用 `openclaw_agent_consult` 工具（`talk.client.toolCall`），Gateway 把它变成一个普通 agent run，返回 `runId` / `agentSessionKey`。客户端照常订阅 chat lifecycle 等结果，再把结果作为 tool result 交回 realtime provider。也就是 **realtime 模型负责前台对话，Claude Code/Codex 负责后台思考**。
- `talk.client.transcript` 把最终的语音转写写回普通 agent session（幂等，靠 `entryId`）。`talk.session.steer` / `talk.client.steer` 让语音可以 steer 正在运行的 run（mode 有 status / steer / cancel / followup）。
- `talk.event` 是唯一的 Talk 事件通道，realtime、transcription、TTS、电话、会议都走它。

---

## 5. 过程可见性：总结

| 端 | 怎么看到中间过程 |
|---|---|
| Control UI（Web） | `chat` delta + `agent` tool/item 流，工具卡片；启动阶段的 `chat status`（preparing_workspace / starting_model…）；`session.observer` headline；approval 卡片 |
| 侧栏/背景观察者 | `mode: "narration"` 的 `session.narration`（2 秒节流的可见尾部快照）+ tool / lifecycle |
| iOS/Android/TUI | 完整流（`sessions.messages.subscribe` 默认 mode） |
| IM channel | Progress draft（一条消息反复 edit：headline + plan + approval + 可选工具日志）、preview streaming、block streaming；`/verbose` 决定是否单独发工具消息 |
| ACP 客户端（IDE） | `tool_call` / `tool_call_update` / `agent_thought_chunk` / `session/request_permission` |
| 审计 | lifecycle 和 tool start/terminal 投影进 metadata-only 的 audit ledger（不含内容） |

---

## 6. 对我们的启示（结论部分）

1. **维护统一的 IO 协议，但分两层**：
   - 内层是 canonical **AgentEvent**：`{runId, sessionKey, seq, ts, stream, data}`，stream 是开放字符串、data 是宽松 record。每个 runtime 写一个 projector（Codex 的 `event-projector.ts`、Claude 的 `execute-events.ts`），把原生事件映射进来。这一层保留原始信息（args、result、partial）。
   - 外层是给各种"端"用的**投影**：chat（显示文本，带首帧快照和 replace 语义）、item（语义化活动条目，带 title / status / summary）、narration（节流的尾部快照）、progress card（IM 用）、ACP（IDE 用）。端按 caps 和 mode 选择投影。
   - OpenClaw 证明了：wire 上 `data: Record<string, unknown>` 足够灵活；真正需要强类型的是**投影层**（ChatEvent 是闭合 union）。
2. **输出等于订阅 session**：连接级 `subscribe(sessionKey, {mode, includeApprovals, subscriptionId})`。发起者和旁观者在协议上是同一种东西。中途 attach 靠"首帧完整快照 + 后续增量"和 history delta 补齐；慢消费者用 dropIfSlow 加终态纠正。
3. **输入等于多端写入同一个 session lane**：每个 session 一个串行 lane，配合 steer / followup / collect / interrupt 四种 queue mode、来源 provenance、权限不借用、writer claim CAS。runtime 是否支持同轮 steer 要作为能力声明出来（Codex 支持 `turn/steer`；Claude Code stream-json 在 OpenClaw 里没实现同轮 steer，退化为 followup）。
4. **审批是一等事件**：runtime 发起请求后，Gateway 广播 `*.approval.requested`，任何有 `operator.approvals` 权限的端（Web、IM 按钮、ACP permission）都可以 resolve。Claude Code 用 `--permission-prompt-tool stdio` + control_request；Codex 用 app-server 的 requestApproval server-request。
5. **Channel 插件契约应该很小**：入口是 `ingest` + `resolveTurn`（路由到 sessionKey），出口是 `deliver(ReplyPayload, kind: tool|block|final)`，外加可选的 edit/stream/approval 能力。私有通道只要实现这几个就能接入。
6. **语音和实时**：realtime 模型做前台，通过一个 `agent_consult` 工具把任务委托给后台的 Claude Code/Codex session，转写写回同一个 session。小米音箱这类场景可以直接照搬。

---

## 7. 关键文件索引

- `docs/concepts/agent-runtimes.md`：runtime 分层、ownership 矩阵、选择规则
- `docs/concepts/agent-loop.md`：run 序列、事件流、writer claim、超时
- `docs/concepts/queue.md`、`docs/concepts/queue-steering.md`：多端输入和 queue mode
- `docs/concepts/architecture.md`：Gateway 架构、帧格式、不变量
- `docs/gateway/protocol/rpc-bootstrap-and-events.md`：订阅、narration、事件族（最重要）
- `docs/gateway/protocol/handshake.md`：connect、caps、roles/scopes
- `docs/gateway/cli-backends.md`：claude-cli 细节
- `docs/cli/acp.md`、`docs/tools/acp-agents.md`：ACP 双向
- `docs/concepts/progress-drafts.md`、`docs/concepts/streaming.md`：IM 侧过程展示
- `docs/gateway/protocol/rpc-talk-config-and-agents.md`：实时语音
- `src/infra/agent-events.ts`：进程内统一事件
- `src/infra/agent-activity-events.ts`：item / command_output / patch 数据类型
- `src/agents/harness/types.ts`：AgentHarness 契约
- `src/agents/harness/attempt-events.ts`：harness 发事件
- `src/agents/embedded-agent-subscribe.handlers.tools.*.ts`：tool 事件形状
- `src/agents/cli-runner/execute-events.ts`：CLI（Claude）事件投影
- `extensions/anthropic/cli-transport.ts`、`cli-runtime-args.ts`：Claude Code stream-json 双向 stdio
- `extensions/codex/src/app-server/event-projector.ts`、`attempt-steering.ts`、`approval-bridge.ts`、`transport-stdio.ts`：Codex app-server
- `packages/gateway-protocol/src/schema/frames.ts`、`agent.ts`、`logs-chat.ts`：WS 协议 schema
- `packages/sdk/src/types.ts`、`normalize.ts`：SDK 归一化事件词表
- `src/gateway/server-chat.ts`、`server-runtime-subscriptions.ts`、`server-chat-state.ts`、`server-chat-tool-recipients.ts`：扇出
- `src/channels/plugins/types.plugin.ts`、`outbound.types.ts`、`src/plugins/runtime/types-channel.ts`：channel 契约
- `src/auto-reply/reply/reply-dispatcher.types.ts`、`src/shared/reply-payload.types.ts`：channel 输出单元
