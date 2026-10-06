# 可行性与事实核查评审（event-sourced / thin-bridge / human-ux）

审查视角：设计里关于 Claude Code、Codex 和参考仓库的说法，是否有代码或文档支撑。设计假设了哪些实际不存在的能力。

核查依据（以下所有路径都在 scratchpad 下）：
- Claude Agent SDK 0.3.291 / CLI 2.1.291：`sdkpkg/package/sdk.d.ts`、`browser-sdk.d.ts`、`sdk.mjs`；本机 `claude --help`（2.1.291）。
- 官方文档 code.claude.com/docs/en/agent-sdk/typescript（2026-10-06 用 WebFetch 抓取）。
- Codex 0.160.1：`codexschema/ts/**`（generate-ts 生成）、`codexdocs/appserver.txt`、`codexdocs/outgoing.rs`，以及本机源码 `~/Projects/codex/codex-rs/core/src/session/mod.rs`。
- 参考仓库：`repos/{botmux,happyclaw,openclaw,multica}`。

标记约定：**[核实]** 表示已在代码或文档中直接看到；**[推测]** 表示我的判断，没有直接证据。

---

## 0. 结论先行

三份设计在 Claude 和 Codex 的协议细节上**大体是对的**，研究做得扎实。标志位、事件类型、`expectedTurnId`、`serverRequest/resolved`、30 分钟卸载、通知无 seq 都能在代码里找到。真正的问题在三个地方：

1. **Claude 自己会合并输入**。CLI 会把挨得近的几条 user message 合进同一个 turn；默认 priority `next` 会把消息折进**正在跑的** turn；turn 恰好结束时，`next` 的消息又会自己开一个新 turn。所以三份设计都写的"不同 replyTo 永不合并进同一 turn"，只有在网关**自己持有队列、每个 turn 只往 stdin 写一条消息**时才成立。只有 thin-bridge 顺带提了一句"或等 result 之后再发"，没有一份把它写成硬规则。
2. **小米音箱没有可用的音频通道**。三份设计都写"音箱音频 → realtime 模型"，但没有一份说明音频从哪来。原厂小爱音箱没有给第三方的麦克风流 API。社区方案分两类：MiGPT 走 MiNA/MIoT 接口，轮询对话记录再调 TTS，做不到全双工，也做不到 barge-in；open-xiaoai 刷补丁固件，只支持 LX06 和 OH2P 两个型号。openclaw voice-call 是 Twilio/Telnyx **电话**通道（`openclaw/docs/plugins/voice-call/realtime-and-streaming.md:25` "realtime.enabled is supported for Twilio and Telnyx"），不能拿来类比音箱硬件。这是三份设计共同的**可行性空洞**。
3. **"Codex 原生第二客户端"比设计写的难得多**。`codex --remote` 没有只读模式（`codex --help` 里只有 `--remote` 和 `--remote-auth-token-env`），TUI 里的人可以直接 `turn/start`。botmux 为处理"foreign turn"的归属和 unknown outcome 写了大量 fencing 代码（`botmux/src/codex-app-runner.ts:1062-1072`、`:1603-1615`、`:1925-1945`）。human-ux 说 TUI"只读挂上"是**错的**。event-sourced 说把 TUI 输入记成 `input.observed{replyTo:null}` 就行，这低估了归属问题：TUI 发起的 turn 里产出的 item，必须靠 turnId 和网关自己的 turn 区分开。

---

## 1. 逐条核查

### 1.1 Claude Code

| 说法 | 结论 | 证据 |
|---|---|---|
| `claude -p --input-format stream-json --output-format stream-json --include-partial-messages --replay-user-messages` 存在 | **[核实]** | `claude --help` 第 120、123、190 行 |
| `--permission-prompt-tool stdio` → `can_use_tool` control_request | **[核实]**，但这是 SDK 内部用法：`sdk.mjs` 里 `K.push("--permission-prompt-tool","stdio")`；`--help` 只写了 `<mcp tool>`。官方没有把 `stdio` 作为 CLI 的公开值写进文档，随版本变化的风险比设计估计的高 | `sdk.mjs`、`sdk.d.ts:4788` |
| `SDKUserMessage.priority: 'now'\|'next'\|'later'` | **[核实]** | `sdk.d.ts:6242`。thin-bridge 写的 `:6242` 准确，event-sourced 写的 `:6230` 偏了几行，无伤大雅 |
| priority 语义 | **[核实]**，官方原文：`next`（**默认**，不传就是它）表示"在同一 turn 内、当前工具跑完后读到；**turn 先结束，它就开下一个 turn**"；`later` 表示"turn 结束后作为新 turn"；`now` 带 `origin:{kind:'human'}` 时（v2.1.286+）把能挪的工作挪到后台、同一 turn 内读到，挪不了就打断；`now` 不带 human origin 时直接打断 | WebFetch agent-sdk/typescript |
| human-ux："Claude 在 v2.1.286 以上可以用 priority='next'" | **错**。v2.1.286 是 `now` 的门槛，`next` 是默认行为，文档没写版本门槛 | 同上 |
| event-sourced："'now' = interrupt-and-read" | **不准确**。带 human origin 的 `now` 会先把 shell、subagent、MCP、WebFetch 挪到**后台继续跑**，所以被打断的工具可能还在跑并产生副作用。网关的 interrupt 语义不能简单映射成 `now` | 同上 |
| `user_message_uuid(s)` 可以绑定回复 → `input.consumed` | **[核实]**，而且比设计写的更强：`result.user_message_uuids` 列出本 turn 消费的全部消息，包括"several messages sent close together run as one turn"的批，以及"queued user message folded into the running turn between tool rounds" | `sdk.d.ts:3628`、`:5502`、`:5711` |
| 跨 replyTo 不合并 | **在 Claude 侧不能自动保证**。见上一行：CLI 会**自己合批**。网关一旦把两条不同 route 的消息连着写进 stdin，就会变成一个 turn | 同上 |
| 撤回已写入 stdin 的排队消息 | **[核实]** `cancel_async_message{message_uuid}`："No-op if already dequeued"。三份设计都没提这个能力。event-sourced 的 `interrupt.cancelQueue` 需要用到它 | `sdk.d.ts:3876-3882` |
| `session_state_changed` → `session.state` | 类型存在（`sdk.d.ts:5869`），但 `sdk.mjs` 有 `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS` 环境变量。**[推测]** 默认不发这个事件，需要设置该环境变量。三份设计都没提 | `sdk.mjs` env 表 |
| `tool_progress`、`task_started/progress/notification`、`stream_event`、`agentProgressSummaries` | **[核实]** | `sdk.d.ts:6126`、`6056`、`6031`、`6001`、`5487`、`2082` |
| interrupt = `control_request{subtype:'interrupt'}` | **[核实]** | `sdk.d.ts:4602` |
| `control_cancel_request` → `request.resolved{runtime_cancelled}` | **[核实]**。注释里还写了"or one that another client already answered"，说明 Claude 自己也在为多客户端审批做准备 | `sdk.d.ts:3884` |
| Claude 没有原生多客户端（stdio 下） | **[核实]**（`--bg` 每次只能 attach 一个终端；"Two processes can't write to the same transcript"，见 research/claude-code.md:171）。不过 `initialize` 响应会带 `pending_permission_requests`，"a client joining an already-initialized session learns about in-flight prompts"（`sdk.d.ts:392`），只在 CCR/bridge 模式下可用 | — |
| Channels 在 `-p` 下被忽略 | **[核实]**（research/claude-code.md:118 引用了官方 channels-reference） | — |
| Remote Control 不能当总线用 | **[核实]**（需要 claude.ai 订阅，后端私有） | — |
| 审批 Decision `allow_session` | **映射不完整**。Claude 的 `can_use_tool` 带 `permission_suggestions`、`suppress_always_allow_rule`、`default_to_no`、`classifier_approvable`、`decision_reason_type`（`sdk.d.ts:4792-4814`）。`allow_session` 必须回填 suggestions 里的 `updatedPermissions`；`suppress_always_allow_rule=true` 时 IM 卡片**不能**出现"总是允许"按钮；`default_to_no` 时不能把允许作为默认选项。三份设计的 Decision 都是平铺的枚举，没有这些约束 | 同上 |

### 1.2 Codex app-server

| 说法 | 结论 | 证据 |
|---|---|---|
| `turn/steer{expectedTurnId}`，不匹配就失败 | **[核实]**："must match the active turn id. The request fails if there is no active turn" | `codexdocs/appserver.txt:865-870`、`ts/v2/TurnSteerParams.ts` |
| review/compaction 轮次拒绝 steer（thin-bridge） | **[核实]** `SteerInputError::ActiveTurnNotSteerable{Review\|Compact}` → "cannot steer a {kind} turn" | `codex-rs/core/src/session/mod.rs:252-274` |
| event-sourced 只写了 stale → `input.rejected{stale_turn}` | **不完整**。还有 `not_steerable` 和"无 active turn"两种失败，后者是 turn 刚结束时的竞态。三种都应该降级为 queue，而不是 reject | 同上 |
| 通知没有 seq | **[核实]**。`ServerNotificationEnvelope` 只有 `emittedAtMs?`，三份设计标的 [推测] 可以去掉 | `ts/ServerNotificationEnvelope.ts` |
| 没有订阅者 30 分钟后卸载 | **[核实]** | `appserver.txt:677` |
| 审批先答者赢，并发 `serverRequest/resolved` | **[核实]**（research/codex.md:118，`outgoing.rs`）。例外：user-verification elicitation 只发给 owner 连接 | — |
| 审批决策集合 | Codex 是 `accept\|acceptForSession\|{acceptWithExecpolicyAmendment}\|{applyNetworkPolicyAmendment}\|decline\|cancel`（`ts/v2/CommandExecutionApprovalDecision.ts`）。`cancel` 会中断 turn，`decline` 只拒绝这一项。设计的 `deny` 没有区分两者 | — |
| 审批可能根本到不了人 | 设计里**没提**。`ApprovalsReviewer = "user"\|"auto_review"\|"guardian_subagent"`，另有 `item/autoApprovalReview/*` 通知。一旦配置成 auto_review，request.opened 永远不会出现，事件 schema 需要能表达"自动审查中/已自动批准" | `ts/v2/ApprovalsReviewer.ts`、`ServerNotificationEnvelope.ts` |
| `clientUserMessageId` 可以当 inputId | **[核实]**：`TurnStartParams`、`TurnSteerParams` 里有，`ThreadItem.userMessage.clientId` 会回显 | `ts/v2/ThreadItem.ts:34` |
| 服务端队列 `thread/queue/*` | 存在，标为 experimental，有 `thread/queue/changed` 通知。三份设计都自己做 lane，没讨论和原生队列会不会冲突。TUI 端用户可能往原生队列里塞东西 | `ServerNotificationEnvelope.ts` |
| `codex --remote` 只读（human-ux） | **错**。CLI 没有只读模式，TUI 可以写 | `codex --help` |
| TUI 输入记为 `input.observed` 就完事（event-sourced、thin-bridge） | **低估**。botmux 必须处理 foreign/autonomous turn 刷新 liveness、steer 竞态，以及 unknown outcome 时 fence 整个 generation（"guessing a final would advance the worker FIFO past a turn whose true disposition is unknown"） | `botmux/src/codex-app-runner.ts:1603-1615`、`:1925-1945` |
| 空 thread 第二客户端无法 resume | 是 botmux 实测结论（research/codex.md:126），我没有独立复现 | — |

### 1.3 参考仓库引用

| 引用 | 结论 |
|---|---|
| happyclaw `src/channel-reply-source.ts:8` "Reply transport belongs to an input" | **[核实]**；`selectChannelReplyBatch` 在 `:32` |
| openclaw narration 2s / 16k | **[核实]** `src/gateway/server-broadcast-narration.ts:17-18`（`NARRATION_INTERVAL_MS=2_000`、`NARRATION_TAIL_CHARS=16_384`）。但这是**16KB 的可见文本尾部**，给 UI 侧栏用的。拿它当音箱 TTS 的输入（event-sourced 的 narration tier "≤16k"）不合理：音箱需要的是一句 headline。human-ux 的 headline 设计在这一点上更对 |
| openclaw `openclaw_agent_consult` :31，consult 期间暂停打断 | **[核实]** `docs/plugins/voice-call/realtime-and-streaming.md:31`、`:45`。注意它的宿主是电话通道 |
| botmux `cot-message.ts`、`remote-runner-protocol.ts`、`active-turn-authority.ts`、VC 设计文档 2026-07-01 / 07-10 | **[核实]**，文件都存在 |
| multica `claude_supplement.go` hook additionalContext | **[核实]**，文件存在 |
| botmux daemon.ts 约 30k 行，happyclaw index.ts 约 23k 行 | **[核实]**，分别为 29840 行和 23371 行 |
| 飞书 CardKit 单卡 10 QPS / 30KB / 200 组件 / 10 分钟 | **二手资料**，出自 happyclaw 自己的调研文档（research/happyclaw.md:193）。我用 WebSearch 没能在飞书官方文档里确认，**需要回到开放平台文档核实**后再写进 caps 常量 |
| human-ux："飞书会议是否给 bot 开放字幕能力，调研中没看到" | **错（过时）**。botmux 实测：bot 入会后应用身份能拉到 `transcript_received`（含 speaker、起止时间、`sentence_id`、文本），另外还有 `chat_received` 和 `participant_joined`。前提是会议开了"允许智能体加入"和 AI Summary，并且应用申请了 `vc:meeting.meetingevent:read`（TAT 和 UAT 要分开验证）。说话需要 `vc:meeting.bot.realtime:write` 加 protobuf 实时音频 WS（`botmux/docs/design/2026-06-30-vc-bot-subscriptions-integration.md:75-100`、`2026-07-01-vc-bot-realtime-voice.md` §2） |

---

## 2. 致命或接近致命的问题

1. **小米音箱的输入输出通道不存在**（三份都有）。设计里画了"音箱音频 ⇄ realtime"，却没有说明设备侧怎么接。原厂设备上只能拿到"小爱已经识别完的文本"（MiNA 对话记录轮询，有秒级延迟，而且小爱自己的回答经常会抢先播报），出口只能是 TTS 或播放 URL。barge-in、本地 VAD、full_duplex 在原厂固件上都**做不到**。要做到，必须刷 open-xiaoai 补丁（仅 LX06/OH2P，需 SSH，有保修和安全风险），或者换成自制设备（ESP32 或树莓派加麦克风阵列）。M5/M8 的 gpt-realtime 前台设计依赖这个前提，应该先做 spike 再定。
2. **Claude 的合批和 `next` 折叠会破坏"一个 turn 一个 replyTo"**（三份都有）。修正规则：网关持有全部 queue；Claude 运行中只允许写 steer（`next`），而且只能是**同 replyTo、同 principal** 的消息；跨 route 的输入一律留在网关队列，等 `result` 之后再写入（或者用 `later`，但"多个 `later` 是否合批"没有文档说明，**[推测]** 会合批）。每个 `result` 都要用 `user_message_uuids` **反向校验**这一轮实际消费了哪些输入，校验不符就记 `ambiguous`。
3. **steer 跨端时 replyTo 自相矛盾**（event-sourced、human-ux）。音箱 consult 用 `policy steer, replyTo 'xiaomi:<device>'` 注入一个飞书发起的 turn，按规则"turn.started 时 replyTo 已固定"，这个回答应该投回飞书，音箱听不到。设计没有说明一个 steer 进来的输入自己的回复去哪。要么规定 steer 只允许同 replyTo，要么把 steer 输入的回复作为"附加投递"显式建模。human-ux 的 extraDeliveries 方向是对的，但它没有和 steer 规则连起来。
4. **网关重启会杀死 Claude 进程，in-flight turn 和挂起的审批一起丢失**（三份都没写）。`claude -p` 通过 stdio 挂在网关进程上，网关一挂子进程就跟着死。IM 审批可能要等几分钟甚至几小时，这期间网关部署或崩溃，审批就悬空了。可以借助 `CLAUDE_CODE_RESUME_INTERRUPTED_TURN`、`resumed_turn_reason`（`sdk.d.ts:3632`）和 `pending_permission_requests` 部分恢复，但设计必须写明。Codex 应该用 `unix://` 或 `codex app-server daemon`，让 runtime 进程比网关活得久。thin-bridge 用 unix socket 是对的，event-sourced 和 human-ux 默认用 `stdio://`，会遇到同样的问题。
5. **human-ux 的事实错误**：`next` 的版本门槛写错；TUI 被写成"只读"；会议字幕被说成"没看到"。这三点会直接把实现带偏。

## 3. 未经支撑或夸大的说法

- event-sourced：把"input.observed 能覆盖原生第二客户端"当成已解决的问题，但没有证据表明 TUI 发起的 turn 能干净地纳入网关的 turn 状态机。botmux 的实现说明这里有大量边界情况。
- event-sourced：说 "Claude uses epochs" 并把它类比成网关 fencing。epoch 只出现在 bridge/CCR 的 `AttachBridgeSessionOptions` 里，stdio 模式没有这个概念，不能指望 runtime 帮忙做 fencing。
- event-sourced 和 thin-bridge：没有证据表明 `session_state_changed` 默认会发出，它很可能需要设置环境变量（见 1.1）。
- 三份都说"审批 first-wins，其余端撤卡"。在 Codex 一侧这是原生能力。在 Claude stdio 一侧，first-wins 完全由网关实现，需要网关自己对 `control_response` 做去重。这本身问题不大，但不能写成"同 Codex"。
- event-sourced："Codex `thread/realtime/*` 可选路径"。它在 `--experimental` 下才生成，而且会把 realtime 会话绑到 Codex thread 上，与"realtime 前台 + 后台 agent"是两种不同的架构，不是可以互换的可选优化。
- thin-bridge："审批只允许口头 allow once 或 deny" 合理，但口头审批本身就需要说话人身份。音箱上谁都能说话，设计没讨论声纹或配对，等于任何路过的人都能批准 `rm -rf`。
- CardKit 限额被三份设计当成确定常量写进了 caps，实际只有二手来源。

## 4. 遗漏的考虑

1. Claude `cancel_async_message`：用它可以撤回已经写进 stdin 的排队消息，实现"interrupt + 清队列"。
2. Claude 审批的附加约束（`permission_suggestions`、`suppress_always_allow_rule`、`default_to_no`、`blocked_path`、`decision_reason` 含 ANSI 需要清洗），以及 Codex 的 `cancel` 和 `decline` 语义不同、`acceptWithExecpolicyAmendment`。Decision 类型需要按 runtime 携带 suggestions。
3. Codex 的 `auto_review`/`guardian_subagent` 审批路径，以及原生 `thread/queue/*` 和网关 lane 可能发生冲突。
4. steer 的失败分类：stale、not_steerable（review/compact）、no_active_turn（竞态）。三种都应该进 queue，并通知各端。
5. Claude 的 `next` 在 turn 结束竞态中会变成新 turn。`admitted(steer)` 的消息实际可能开了一个新 turn，turn 归属必须以 `user_message_uuids` 为准，在事后修正。
6. 会议转写**不是不可变的输入**：同一个 `sentence_id` 会被修订（latest-wins upsert）。append-only 的 `input.submitted` 需要支持修订事件或稳定窗口（botmux 的做法是只消费"已稳定"的句子），否则 agent 会基于被修订掉的错字去行动。此外 P0 是轮询 `+meeting-events`，没有 push，延迟是秒到十秒级，"点名即 dispatch"的体验要按这个预期来设计。
7. 每个 session 常驻一个 Claude 进程的资源成本：**[推测]** 每个进程几百 MB 内存，需要 idle 驱逐，下次输入时再 `--resume`；驱逐后还要处理 pending 审批。
8. 语音审批的身份问题：音箱是共享设备，trust 不能是 owner。
9. Claude stdio 下网关就是"唯一宿主"。如果用户在终端用 `claude --resume <同一 id>` 打开同一个 session，会出现两个写者；设计里没有锁或检测机制（例如 pid 文件，或在 `system/init` 里比对 session_id）。
10. Codex 首个 item 可能超过 30 秒（multica 注释）。IM 端在这段时间没有任何过程可展示，需要网关自己发合成的 "thinking…" 状态。

## 5. 各设计最值得保留的点

- **event-sourced**：`input.consumed` 必须来自 `user_message_uuid(s)` 或 Codex 的 userMessage item，"admitted ≠ consumed"。这是三份里对 Claude 语义理解最准确的一条，而且 `user_message_uuids` 的语义证实了它。delivery 的 `unknown` 不自动重放、`render.anchor` 入日志、`RuntimeCaps.steer` 三态，这几点也值得保留。
- **thin-bridge**：Codex 走 `unix://`，让 runtime 进程的生命周期和网关分离；明确列出 review/compaction 不可 steer（已核实）；"等 result 之后再发"；口头审批不授予 always；协议面最小，未知事件一律走 `native` 透传。
- **human-ux**：headline 比 16k 文本尾部更适合语音和 IM；extraDeliveries/handoff 把"附加投递"显式建模；明确规定任何 profile 都不能吞掉 approval；identity link 用配对码显式绑定；会议 v0/v1 分阶段，和 botmux 的实际进展一致。

## 6. 建议

以 thin-bridge 的核心（最小信封、native 透传、unix socket）为骨架，吸收 event-sourced 的 `input.consumed` 和 delivery 收据，以及 human-ux 的 headline 和 extraDeliveries。同时把下面几条改成**硬规则**：

1. **网关持有全部队列**。Claude 运行中只能写同 replyTo、同 principal 的 `next` steer，其余一律等 `result`。每轮用 `user_message_uuids` 对账，不符就记 `ambiguous`。
2. 让 runtime 进程的寿命超过网关：Codex 用 daemon 或 unix socket。Claude 在 MVP 阶段接受"网关重启 = turn 中断"，并依赖 `CLAUDE_CODE_RESUME_INTERRUPTED_TURN` 恢复，同时写进风险清单。
3. 把 Codex TUI 写入看作 v2 功能，MVP 只允许网关写。
4. 小米音箱先花一周做 spike：比较 MiGPT 式的"文本轮询 + TTS"和 open-xiaoai 刷机，确认真实延迟和可控性之后，再决定 voice tier 和 barge-in 的设计。飞书会议按 botmux 已验证的路线走：结构化转写轮询，加会中聊天文本回复，实时音频放到后面。
5. 把 Decision 改成按 runtime 携带 suggestions 和约束的结构；把 CardKit 限额改成可配置项，并回到官方文档核实。
