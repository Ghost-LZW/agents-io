# agents-io 最终建议：Agent IO 层怎么做

> 角色：lead architect 终稿。输入：`docs/research/*.md`（6 份调研）、`docs/design/*.md`（thin-bridge / event-sourced / human-ux 三份方案）、`docs/critique/*.md`（可行性核查、运维安全对抗评审）。
> 前提（用户已定）：agent runtime 直接用 **Claude Code 本体** 和 **Codex 本体**，不自写 agent loop。
> 标注：**[事实]** 有代码/文档出处；**[推测]** 是判断，未验证。文中路径都相对各参考仓库根目录或本仓库 `docs/`。
>
> **r1 修订（2026-10-06）**：仓库定位改为"输入输出基建"，边界见 `POSITIONING.md`，冲突时以它为准。本文据此改了三处：(1) 审批与信任从"一等公民的策略"改为"一等公民的机制 + 宿主可插拔策略"，审批默认 `auto`；(2) harness 与 model 分离，`RuntimeAdapter.open` 接收 `RunSpec{harness, model, effort, profile}`；(3) `Trust` 枚举改为宿主给出的 `Principal.labels`。改动处标 **[r1]**。

---

## 0. 一页结论

| 问题 | 决定 |
|---|---|
| 统一协议还是各自处理？ | **统一"接缝"，不统一"内容"。** 统一 3 个窄契约：入站 `InboundEnvelope`、会话事件 `SessionEvent`（带 seq 的信封 + 约 20 种 kind + `native` 原样透传）、命令 `Command`（input / interrupt / resolve / subscribe，每条带由网关盖章的 origin）。**不统一**：runtime 原生协议（Claude stream-json / Codex app-server 原样用）、runtime 的 transcript（Claude jsonl / Codex rollout 是上下文唯一权威）、工具语义细节、富卡片渲染、音频帧。 |
| 输出 = 订阅 session 事件流？ | **是。** 每个 session 一条 append-only、网关分配 seq 的日志，任何端 `subscribe(fromSeq, tier)`。但必须拆成两件事：**投影**（谁有权限谁能看，可多端同时看）和**投递**（这一轮的正式答复主动推给谁，默认只推回输入来源 + 显式登记的附加目标）。 |
| 多端展示？ | 是。同一事件流按 tier 渲染：`full`（Web/TUI）、`card`（飞书流式卡）、`headline`（音箱/手表/会议大屏，一句话状态）、`final`（邮件/低能力私有通道）。 |
| 多端输入？ | 是，但**全部串进每 session 一条网关持有的 lane**。网关持有队列，不把队列交给 runtime（Claude CLI 会自己合批，见 §2.4）。模式只留 `queue / steer / interrupt`，砍掉 `collect`。 |
| 冲突怎么处理？ | 单写者 lane + 权限不借用 + 每轮回复目标确定 + `admitted ≠ consumed`（以 Claude `user_message_uuids` / Codex `userMessage.clientId` 事后对账）+ 审批 first-wins 且服务端重验资格。 |
| 什么形态能接受最广输入/做最广输出？ | 输入：**窄信封 + content blocks + `raw`（core 不读）+ admission（dispatch / observeOnly / drop）**，非消息事件（会议邀请、卡片点击、文档评论、cron、webhook）都进同一管道。输出：**订阅事件流（被动）+ 宿主 MCP 输出工具（agent 主动，路由由宿主限定）** 两条路，而不是把每种输出形态塞进协议。私有通道走**进程外 JSONL 协议**，任意语言实现。 |
| 中间过程？ | 两个 runtime 都给全量结构化过程（Claude `stream_event/tool_progress/task_*`，Codex `item/*` delta/plan/diff）。core 做一个 compositor 从日志 fold 出 `ProgressView{headline, plan, tools, pendingRequests, text}`；端只实现 send/edit/finalize 原语。默认安静，**审批永远可见**，卡片带鉴权的 Web trace 深链。 |
| 拓扑 | **网关进程 ≠ runtime 宿主进程**：`aio-gateway`（channel、lane、log、hub）+ `aio-runtimed`（持有 Claude/Codex 子进程，可重连）。网关部署不杀正在跑的 turn。 |

---

## 1. 参考项目 IO 处理方式对比

| | happyclaw | botmux | openclaw | multica | Claude Code 原生 | Codex 原生 |
|---|---|---|---|---|---|---|
| **输入路径** | 8 个 IM + Web → 落 SQLite `NewMessage`（`src/types.ts:426`，带 `ingest_sequence`）→ `GroupQueue` → 文件 IPC（`data/ipc/<folder>/input/*.json`）→ runner 内 push 型 `MessageStream` 喂 SDK `query()` | 飞书 WS → daemon（每 bot 一个）→ fork worker（每话题一个）→ PTY/tmux `send-keys` 逐字打字并读 jsonl 确认（`adapters/cli/claude-code.ts:1212`）；Codex 走 app-server `turn/start`；另有 `/api/trigger`、会议事件、cron | `ChannelPlugin.gateway.startAccount` → `inbound.run{ingest→classify→preflight→resolveTurn}` → `MsgContext`（约 250 字段，`src/auto-reply/templating.ts:117`）→ `session:<key>` lane | 一切变 `Task`（胖 payload，按来源平铺字段，`daemon/types.go`）；IM 侧 `Channel` 接口 + 窄 `InboundMessage{… Raw}`（`channel/message.go`）→ Router → `agent_task_queue` | stdin `SDKUserMessage{priority, origin, uuid, shouldQuery}`（sdk.d.ts:6242）+ `control_request`；Channels MCP 通知（`-p` 下忽略）；cross-session inbox socket；hooks `additionalContext` | JSON-RPC `turn/start{input: UserInput[], clientUserMessageId}`；`turn/steer{expectedTurnId}`；`UserInput` 原生多模态（text/image/audio/skill/mention）；`thread/inject_items` |
| **输出路径** | runner stdout `---HAPPYCLAW_OUTPUT_START---` 帧 → `broadcastStreamEvent` 按 ACL 推 WS（`src/web.ts:3129`）+ 来源 IM 的 `StreamingSession` + 持久 outbox | 4 条并行通道：终端截图卡、CoT 时间线（`CotEntry`，`src/types.ts:1859`）、最终答案（`botmux send` 工具 / transcript bridge）、`turn_terminal` | `AgentEventPayload{runId, seq, stream, data}`（`src/infra/agent-events.ts`）→ WS `agent`/`chat` 帧给订阅者；channel 走每 turn 的 `ReplyDispatcher` **回原路** | `agent.Message` → daemon 500ms 批 POST → `task_message` 落库（带 seq）→ `events.Bus` → WS workspace 广播 + 各 IM outbound 订阅 bus | stdout NDJSON `SDKMessage` 联合（sdk.d.ts:5336）+ `control_request{can_use_tool}` | 通知广播给该 thread 的**所有**连接（`outgoing_message.rs`），**不带 seq**（`ServerNotificationEnvelope` 只有 `emittedAtMs`） |
| **内部协议** | `shared/stream-event.ts` 一份共享 `StreamEvent`（Claude 形状的扁平可选字段 bag，`displayLevel` 分级）；自己的规则 6 要求改 typed contract | `DaemonToWorker/WorkerToDaemon` 判别联合（混入大量 CLI 专属字段）；`remote-runner` JSONL（版本化、caps 协商、generation 栅栏）最干净 | 进程内 `AgentEventPayload`（stream 开放字符串、`data: Record`）+ 闭合的 `ChatEvent` 投影；SDK 再归一成 `OpenClawEventType` | `agent.Message{Type: text\|thinking\|tool-use\|tool-result\|status\|error\|log}` + `Result` + `Supplement`，7 类覆盖 20+ CLI | 本身就是统一协议（CLI 与 SDK 同线协议） | Thread/Turn/Item + started/delta/completed + serverRequest；`generate-ts` 可导出类型 |
| **runtime 接入** | 仅 Claude：Agent SDK `query()`（`container/agent-runner/src/index.ts:2763`），bypassPermissions，Docker 隔离 | 真实交互式 CLI 跑在 tmux/PTY（33 个 CLI 适配器）；Codex hybrid：engine 连 app-server 写、`codex --remote` TUI 旁观 | Codex app-server stdio；claude-cli 双向 stream-json 常驻 + `--permission-prompt-tool stdio`（`extensions/anthropic/cli-runtime-args.ts`）；ACP 兜底 | `claude -p` stream-json bypass；`codex app-server --listen stdio://` 全自动 accept；ACP 系 | — | — |
| **多端** | Web 按 ACL 看全部；IM 只在本渠道触发的 turn 上挂投递；**观察与投递分离**（`src/channel-reply-source.ts`） | 飞书卡片 / Web 终端 / 本地 tmux 看同一进程，但各通道各取数据，无统一总线 | `sessions.messages.subscribe{mode: full\|narration}`，可被动看他人发起的 run；channel 不是订阅者 | 多端看（Web/桌面/移动/IM）；per-task scope 订阅已建未启用（MUL-1138） | stdio 单宿主；Remote Control 多端但绑 claude.ai、后端私有 | 原生多连接订阅 + 广播；审批 first-wins + `serverRequest/resolved` + 迟到连接重放挂起请求 |
| **多端输入/冲突** | 每 session 一条 lane；`queue\|steer` + `/break`；不同路由不合批（`selectChannelReplyBatch`） | FIFO + `active-turn-authority.ts` + principal lanes；终端输入绕过一切 | 四种 queue mode；**权限不借用**（不同权限降级 followup）；writer CAS | 排队合并评论；运行中 supplement（Codex steer / Claude hook）仅 issue 场景 | `priority: next(默认)\|later\|now`；CLI 会自己合批 | 任一连接可 `turn/start`；`expectedTurnId` 乐观并发 |
| **过程可见性** | 最好：Web trace、CardKit 流式卡（`src/feishu-streaming-card.ts`）、`displayLevel`、重连快照 | 截图（任意 CLI 兜底）+ 飞书原生 CoT 气泡（AG-UI 事件） | progress drafts（headline/plan/审批，工具行 opt-in）、narration、`item` 语义层 | Web timeline 强；IM 弱（仅 Telegram 流式） | 全量 | 全量（含 diff、plan、命令输出 delta） |
| **扩展方式** | 封闭集合，加通道改约 8 处 | IM 不可扩展（`ImAdapter` 死代码）；插件 MCP gateway | out-of-tree npm 插件，最小约 80 行 | `Channel` + `Factory` + `ResolverSet` 注册表 | MCP 工具、hooks | dynamic tools（`item/tool/call`）、MCP |
| **审批** | 无（bypass） | 默认 bypass + hook 兜底 | 一等公民，转到各端 | 无（全自动） | `can_use_tool` | requestApproval server request |

**从表里得出的四条结论**：
1. 所有长期演进的项目（openclaw、happyclaw、multica）都收敛到"一个 canonical 事件流 + runtime projector"。没有总线的 botmux 每加一个展示端就多接一条数据通道，CLI 专属字段也渗进公共 IPC。→ **要统一事件层**。
2. 统一得太厚也会失控：openclaw `MsgContext` 250 字段 + legacy 别名、Codex 投影约 356 个文件。→ **统一要窄，原生细节放 `native`**。
3. "观察 vs 投递"是三家都独立得出的规则（happyclaw 回复归属、openclaw 回原路 + 删掉 channel docking、multica `channel_task_delivery`）。→ **直接采用**。
4. 四个参考项目里三个没有人在回路的审批（bypass）。**[r1]** 这本身是对的：反复找人审批会浪费注意力、打断流程，强模型本来就该被信任。我们的差异点不在"多审批"，而在两件不占用人注意力的事：**来源身份盖章**（谁有资格指挥 agent，模型再强也解决不了外人借它下命令）和**按来源决定执行 profile**。审批只是可插拔的 resolver（auto / 模型 / 人 / 宿主），策略由宿主决定。

---

## 2. 直接回答用户的问题

### 2.1 统一协议 vs 各自处理：统一什么、不统一什么

| 统一（核心维护） | 不统一（留在适配器 / `native`） |
|---|---|
| `InboundEnvelope`：谁（channel 命名空间内的 userId）、在哪（conversation）、说了什么（content blocks）、回哪（replyRoute）、admission | 平台私有字段（放 `raw`，core 从不读）；平台身份解析细节 |
| `SessionEvent` 信封：`sessionKey, seq, ts, turnId, attempt, itemId, parentItemId, level, audience, visibility` + 约 20 种 body kind | Codex `commandExecution/fileChange` 与 Claude `tool_use{Bash}` 的完整字段（只抽 `title/status/inputSummary`，其余进 `native`） |
| `Command`：input / interrupt / resolve / control / subscribe，**origin 由网关盖章** | runtime 原生协议本身（不发明 runtime 协议，不用 ACP 做核心） |
| 审批/提问的 `request.opened/resolved` 生命周期 + `Decision` | 各 runtime 的审批约束细节（按 runtime 携带：Claude `permission_suggestions/suppress_always_allow_rule/default_to_no`，Codex `acceptWithExecpolicyAmendment/cancel`） |
| `ChannelAdapter` 原语（send/edit/finalize/typing/speak）+ capability 声明 | 富卡片怎么拼（CardKit JSON 由飞书 adapter 自己处理；`channelData` 逃生口） |
| `RuntimeAdapter` 接口 + `RuntimeCaps` | transcript / 上下文（Claude jsonl、Codex rollout 是权威，日志是 IO 日志，**不用于重建上下文**） |
| 进程外 channel / runtime 的 JSONL 帧协议 | 语音音频帧（语音前台是 channel 内部的事） |

判据：**一个字段如果路由、权限、多端同步或审批需要它，就进核心；如果只是为了渲染得更好看，就进 `native`/`channelData`。**

### 2.2 输出 = 订阅 session 事件流？多端展示？

是，而且这是全文的中心抽象：

- 每个 session 一条日志。网关是唯一写者，分配无空洞 seq（Codex 通知没有 seq，Claude stdio 单宿主，这两点正好要求网关自己补）。
- 任何端都是订阅者：`subscribe{sessionKey, fromSeq, tier, filter}`。中途加入或重连：`fromSeq` 早于压缩线时，先发 `snapshot`（partialText、activeItems、pendingRequests、plan、state），再续推增量（Claude bridge 的 `fromSequenceNum/catch_up_truncated`、openclaw"首帧带快照"、happyclaw `active_run_snapshot` 的统一版）。
- **投影 vs 投递**：
  - 投影：Web/TUI 这类 operator 端默认可订阅全量，受 ACL 限制，可丢帧（`dropIfSlow`）。
  - 投递：每个 turn 在 `turn.started` 时写定 `replyRoute`，并维护一个只增不减的 `extraDeliveries[]`。对这些路由有**投递义务**：走持久 outbox、operationId 幂等、写 `delivery.settled`。投递义务只覆盖 `final` 和 `request.*`；progress 是可合并的累积全量，可以丢中间帧。
  - 把 session 镜像到另一个 IM（例如"把这个 session 的 final 推到我飞书私聊"）就是加一个带投递义务的订阅，**只能由 owner 显式创建**，群聊不能被 agent 主动订阅进来。

### 2.3 多端输入

能。所有端的输入都变成 `Command{type:'input'}` 进同一个 lane。三种模式：

| 模式 | 语义 | 谁能用 |
|---|---|---|
| `queue`（默认） | 当前 turn 结束后作为新 turn | 所有有 talk 权限的来源 |
| `steer` | 注入正在运行的 turn | 仅 **同一 principal** 且其输入不会让本轮 profile 降级（[r1] 由 `Policy.admit/plan` 判断）；语音只能 steer 本设备发起的 turn |
| `interrupt` | 停止当前 turn，可选清空队列 | turn owner / session owner；跨 principal 的 interrupt 只给 owner |

`collect`（防抖合批）**砍掉**：它在群里会把多条低信任消息合成一个 turn（ops 评审），还会和 Claude 自身合批叠加，使归属更难对账。

### 2.4 冲突怎么处理（硬规则）

1. **网关持有全部队列**。Claude CLI 会把挨得近的多条 user message 合成一个 turn，默认 `priority:'next'` 会把消息折进正在跑的 turn，turn 恰好结束时又会开新 turn（sdk.d.ts:5711、官方 agent-sdk 文档，见 critique/feasibility.md §1.1）。所以：
   - idle 时：一次只写**一个路由、一个 principal** 的输入批，显式 `priority:'later'`，然后等 `result`。
   - running 时：只写满足 steer 条件的输入，显式 `priority:'next'`；其他全部留在网关队列。
   - **每次写入都显式设置 priority**，不依赖默认值（默认就是 steer）。
   - **不用 `'now'` 做打断**：带 human origin 的 `now` 会把 shell/subagent/MCP 挪到后台继续跑，副作用不会停。停止一律走 `control_request{subtype:'interrupt'}` / Codex `turn/interrupt`。
2. **admitted ≠ consumed**。`input.admitted` 只表示网关接纳；`input.consumed{inputIds, turnId}` 必须来自 Claude `result.user_message_uuids`（会列出本轮实际消费的全部消息，含合批和中途折入的）或 Codex `userMessage` item 的 `clientId`（我们把 `clientUserMessageId` 设为 inputId）。对不上就把 turn 标成 `ambiguous`，同时修正 turn 归属（以 `next` 写入的 steer 可能因为竞态变成了新 turn）。
3. **steer 失败一律降级为 queue，不 reject**：Codex 的 `stale`（expectedTurnId 不匹配）、`ActiveTurnNotSteerable{Review|Compact}`（codex-rs/core/src/session/mod.rs:252-274）、`no active turn` 竞态；Claude 没有中途 steer 能力时也一样。降级后广播 `input.admitted{disposition:'queued'}`。
4. **steer 的回复归属**：steer 只允许同一 principal。如果 steer 输入来自另一个路由（例如同一个人在飞书发起，又在 Web 插话），就把该路由追加进 `extraDeliveries`，这一轮的 final 两边都投。这样修复了 critique 指出的"音箱 steer 进飞书 turn 却听不到回答"的矛盾。
5. **权限不借用**：**[r1]** 本轮 profile 由 `Policy.plan` 依据被合并的所有输入的 origin 决定，默认取最受限的那个（§3.5）。
6. **撤回排队消息**：interrupt 带 `cancelQueue` 时，网关清自己的队列；已经写进 Claude stdin 但还没被消费的消息用 `cancel_async_message{message_uuid}`（sdk.d.ts:3876）撤回。
7. **待答问题优先**：有挂起的 `question` 时，来自 eligible principal 的下一条消息先当作答案（openclaw）。
8. **Codex 只让网关写**（MVP）。`codex --remote` **没有只读模式**（`codex --help`），TUI 写入带来的 foreign turn 归属问题在 botmux `codex-app-runner.ts:1062-1072, 1603-1615, 1925-1945` 有大量 fencing 代码。MVP 不给人类 TUI 凭证；TUI 写入放到 v2。

### 2.5 什么形态能接受最广输入、做到最广输出

- **最广输入 = 窄信封 + 内容块 + admission + raw**：任何东西（IM 消息、会议转写片段、邮件、卡片按钮、文档评论、cron、webhook、私有系统事件）都能表达成 `content: ContentBlock[]` + `admission`。不想开 turn 的就 `observeOnly`（只进日志，不进 runtime 上下文或批量摘要后再进）。大内容给指针（`ref`），让 agent 用工具按需拉取（multica 的做法）。
- **最广输出 = 订阅（被动）+ 宿主 MCP 工具（主动）**：
  - 被动：任何端按 tier 订阅日志。新增一个端不需要动 runtime。
  - 主动：网关给每个 runtime 会话挂一个 loopback MCP server（每次运行一个短 token，类似 openclaw `OPENCLAW_MCP_TOKEN`），提供 `reply`、`send_file`、`speak`、`get_channel_context` 等工具。Claude 通过 `--mcp-config`/SDK `mcpServers` 挂上；Codex 通过 MCP 配置或 dynamic tools（`item/tool/call`，具体注册参数 [推测] 待验证）。**目的地只能是本 turn 的 replyRoute/extraDeliveries 或 owner 预登记的路由**，其他目的地要 owner 审批（防注入外泄，ops 评审 §1.4）。
- **私有通道 = 进程外 JSONL 协议**（botmux remote-runner 骨架）：hello 协商 caps → `inbound` / `send` / `edit` / `op_result{delivered|rejected|unknown}`。任意语言写，不 fork 网关。

### 2.6 中间过程如何呈现

| tier | 用于 | 正文 | 过程 | 审批 | 节流 |
|---|---|---|---|---|---|
| `full` | Web、TUI | token 级 delta | thinking、全部 item（入参摘要、截断输出、子 agent 树）、plan、diff、usage | 按钮 | 100ms 合批 |
| `card` | 飞书 / 钉钉 / Slack 类 | 累积全量 snapshot | 折叠时间线（仅 title + status）、plan、headline | 按钮（**仅私聊 owner**；群里给链接） | 约 1.2s，限额可配置 |
| `headline` | 音箱、手表、会议大屏、长任务降级 | 不推 | 一句话 headline（只在有新 activity 时更新） | 口头提示"请到飞书确认" | 事件驱动 |
| `final` | 邮件、低能力私有通道 | 只发 final | 不显示 | 鉴权链接 | 每轮一次 / digest |

- headline 的来源优先级：Codex `agentMessage.phase=commentary` / `turn/plan/updated` → Claude `agentProgressSummaries` / `tool_progress` → 网关规则（"工具名 + 主体"，例如"编辑 src/foo.ts"）。不用 openclaw 的 16KB narration 尾部当语音输入（那是 UI 侧栏用的）。
- `audience=approval` 的事件任何 tier 都不能吞。
- 长任务（> N 分钟）在群里自动降级为"一张定期编辑的 headline 卡 + 鉴权 Web 链接"，不连续续卡刷屏。
- Codex 首个 item 可能超过 30 秒（multica 注释）：网关在 `turn.started` 后立即发合成的 `headline{"思考中…"}`，避免 IM 端空白。
- 只用 runtime 原生上报的用量，缺了就留空（botmux 原则）。

---

## 3. 推荐架构

### 3.1 拓扑

```
 飞书IM  飞书会议   邮件   音箱(语音前台)  私有通道(任意语言)        Web / TUI / 手机
   │       │        │        │               │ JSONL over stdio/WS        │ WS
   ▼       ▼        ▼        ▼               ▼                            ▼
 ┌──────────────── Channel Adapters（进程内 TS 插件 或 进程外协议）──────────────┐
 │ start(ctx){ ctx.emit(InboundEnvelope) }      send/edit/finalize/speak/typing   │
 └───────────────┬───────────────────────────────────────────▲───────────────────┘
                 │ InboundEnvelope（声明，不可信）               │ RenderedMessage
 ┌───────────────▼───────────────────── aio-gateway ──────────┴───────────────────┐
 │ Ingress: dedup · 身份解析(网关盖章 Origin, Policy.identify) · 路由绑定 │
 │          (未绑定=沉默) · admission · 低信任→隔离 session                        │
 │ Lane(每 session 一条, 唯一写者): queue/steer/interrupt · 队列在网关 · 对账       │
 │ Log: append-only, seq; delta=ephemeral 内存环, item/turn=durable(SQLite)        │
 │ Hub: subscribe(fromSeq,tier) · snapshot · ACL · 每订阅字节预算                   │
 │ Compositor: ProgressView → card/headline/final · 分层 token bucket(审批>final>进度)│
 │ Approvals: 广播给 eligible · first-wins · resolve 时服务端重验 · 超时 deny · 撤卡 │
 │ Outbox: operationId 幂等 · provider 侧 uuid 重试 · delivery.settled             │
 │ Host MCP: reply/send_file/speak/get_context（目的地受限, 每运行一个 token）      │
 └───────────────┬───────────────────────────────────────────▲───────────────────┘
                 │ RuntimeCommand（unix socket JSONL, 可重连）  │ CanonicalEvent + native
 ┌───────────────▼──────────────────── aio-runtimed ─────────┴───────────────────┐
 │ 持有子进程，网关重启不受影响；缓冲事件直到网关 ack；LRU 空闲回收后 resume       │
 │ ClaudeAdapter: Agent SDK query(AsyncIterable) → 拉起本机 claude CLI            │
 │ CodexAdapter:  codex app-server --listen unix://…  (JSON-RPC, generate-ts 锁版本)│
 └────────────────────────────────────────────────────────────────────────────────┘
          语音：  音箱 ⇄ [语音前台: ASR/TTS 或 realtime 模型] ──agent_consult──▶ gateway(queue)
                                         ▲────────────── subscribe(tier=headline) ─────┘
```

为什么拆 `aio-runtimed`：两份评审都指出网关重启会杀掉 stdio 子进程，在跑的 turn 和 IM 上挂了几小时的审批一起丢失。runtimed 很薄（只管进程生命周期、事件缓冲和协议转发），很少需要部署；网关可以随便重启。协议抄 botmux remote-runner：`hello/start/resume{reattach|rebuild}/turn/cancel/detach/reattach` + generation 栅栏。

### 3.2 核心类型

```ts
// ===== 身份与路由 =====
// [r1] 不再内置 Trust 枚举。主体由宿主 Policy.identify 给出，labels 含义由宿主定义；
// 默认策略用 labels ['owner'] / ['member'] / ['guest'] 表达原来的等级。
interface Principal { id: string; labels: string[] }
type RouteKey = string;                                  // `${channel}:${account}:${conversation}[:${thread}]`
interface ReplyRoute { channel: string; account: string; conversationId: string; threadId?: string; replyToMessageId?: string }

// ===== 入站信封（adapter → gateway；只是"声明"）=====
interface InboundEnvelope {
  v: 1;
  id: string;                         // adapter 命名空间内的消息 id，用于 dedup
  channel: string;                    // adapter id，网关校验与连接身份一致
  account: string;
  conversation: { id: string; kind: 'dm' | 'group' | 'thread' | 'meeting' | 'call' | 'mail'; threadId?: string };
  sender: { channelUserId: string; displayName?: string; isBot?: boolean;
            authEvidence?: 'platform_signed' | 'dkim_pass' | 'device_only' | 'none' }; // 证据，不是结论
  content: ContentBlock[];
  replyRoute: ReplyRoute | null;      // null = 不要回复
  admission?: 'dispatch' | 'observeOnly' | 'interaction' | 'drop';
  modeHint?: 'queue' | 'steer' | 'interrupt';
  revisionOf?: string;                // 会议转写同一 sentence_id 的修订（latest-wins）
  raw?: unknown;                      // core 不读
}
type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image' | 'file' | 'audio'; ref: string; mime: string; name?: string }   // 先落对象存储
  | { type: 'quote'; text: string; fromMessageId?: string }
  | { type: 'transcript'; speaker?: string; text: string; startMs: number; endMs: number; stable: boolean }
  | { type: 'event'; name: string; data: Record<string, unknown> }                    // 会议邀请、卡片点击、文档评论
  | { type: 'ref'; uri: string; title?: string };                                     // 指针，agent 按需拉

// ===== 网关盖章后的输入 =====
interface Origin { kind: 'human' | 'agent' | 'channel_event' | 'system' | 'peer';
  principal: Principal | null;        // [r1] null = 未知发送者
  declared?: string;                  // [r1] 发送方主动表明的身份（如 agent 的 run 引用），只是声明；
                                      // 只有发送账号在 Policy 认可的 agent 账号内才被采信，文本里的自称一律不算
  self?: boolean;                     // [r1] 本部署 agent 自己发出的消息回流，默认 admit=drop，防回声
  evidence: 'platform_signed' | 'dkim_pass' | 'device_only' | 'none';
  via: RouteKey; adapter: string }
interface InputRecord { inputId: string; origin: Origin; content: ContentBlock[];
  replyRoute: ReplyRoute | null; channelContext: Record<string, string | number | boolean> }

// ===== 命令（所有端 → session；Web/TUI/私有 UI 共用）=====
type Command =
  | { type: 'input'; sessionKey: string; input: InputRecord; mode: 'queue' | 'steer' | 'interrupt'; expectedTurnId?: string }
  | { type: 'interrupt'; sessionKey: string; turnId?: string; cancelQueue?: boolean; origin: Origin }
  | { type: 'resolve'; sessionKey: string; requestId: string; decision: Decision; origin: Origin }
  | { type: 'control'; sessionKey: string; op: 'set_model' | 'set_effort' | 'reset' | 'resume_interrupted'; arg?: string; origin: Origin }
  | { type: 'subscribe'; sessionKey: string; fromSeq?: number; tier: Tier; filter?: { minLevel?: Level; optOut?: string[] } }
  | { type: 'unsubscribe'; sessionKey: string };
// origin 永远由网关根据连接/adapter 身份填写，客户端传入的值被覆盖

type Decision =
  | { kind: 'allow_once' }
  | { kind: 'allow_session'; updatedPermissions?: unknown }   // Claude: 回填 permission_suggestions；仅 owner + Web/私聊
  | { kind: 'deny'; message?: string; interruptTurn?: boolean } // Codex: decline / cancel；Claude: deny + interrupt
  | { kind: 'answer'; answers: Record<string, string | string[]> }
  | { kind: 'native'; payload: unknown };                       // acceptWithExecpolicyAmendment 等

// ===== 会话事件（唯一输出流）=====
type Tier = 'full' | 'card' | 'headline' | 'final';
type Level = 'primary' | 'detail' | 'debug';
interface SessionEvent<B extends Body = Body> {
  v: 1;
  sessionKey: string;
  seq: number;                        // 网关分配，单 session 单调无空洞
  ts: number;
  harness: string;                    // [r1] 'claude-code' | 'codex' | 私有 harness；model 在 turn.started.run 里
  generation: number;                 // runtime 绑定代际，旧代迟到事件丢弃
  turnId?: string; itemId?: string; parentItemId?: string;
  level: Level;
  audience: 'answer' | 'commentary' | 'status' | 'approval' | 'internal';
  visibility: 'participants' | 'operators' | 'internal';   // internal 在 Hub 出口白名单拦截
  durability: 'durable' | 'ephemeral';                     // delta 是 ephemeral
  body: B;
  native?: unknown;                   // 只给 full tier；大对象存 blob 按需拉
}
type Body =
  | { t: 'session.state'; state: 'idle' | 'running' | 'requires_action' | 'stalled' | 'error' }
  | { t: 'input.admitted'; inputId: string; disposition: 'new_turn' | 'steer' | 'queued' | 'observe_only'; principalId?: string }
  | { t: 'input.consumed'; inputIds: string[]; turnId: string }
  | { t: 'input.cancelled' | 'input.rejected'; inputIds: string[]; reason: string }
  | { t: 'turn.started'; turnId: string; inputIds: string[]; replyRoute: ReplyRoute | null; run: RunSpec; owner?: string }   // [r1] 本轮执行配置由 Policy.plan 给出
  | { t: 'turn.delivery_added'; turnId: string; route: ReplyRoute; reason: 'steer' | 'handoff' | 'mirror' }
  | { t: 'turn.completed'; turnId: string; status: 'completed' | 'interrupted' | 'failed' | 'ambiguous'; usage?: unknown; error?: { code: string; retryable: boolean } }
  | { t: 'text.delta'; delta: string; channel: 'answer' | 'reasoning' | 'command_output' }
  | { t: 'text.snapshot'; text: string; final: boolean }            // 累积全量，卡片用，幂等
  | { t: 'item.started' | 'item.completed'; item: ItemSummary }
  | { t: 'item.progress'; itemId: string; text?: string; elapsedMs?: number }
  | { t: 'plan.updated'; steps: { text: string; status: 'pending' | 'in_progress' | 'completed' }[] }
  | { t: 'diff.updated'; files: { path: string; added: number; removed: number }[] }
  | { t: 'headline'; text: string }
  | { t: 'request.opened'; requestId: string; kind: 'tool_approval' | 'file_change' | 'permissions' | 'question' | 'elicitation';
      title: string; risk: { writes?: boolean; network?: boolean; elevated?: boolean }; detailRef: string;
      allowedDecisions: Decision['kind'][]; allowAlways: boolean; defaultDeny: boolean; expiresAt: number;
      resolver: Resolver }             // [r1] 由 Policy.resolve 决定；只有 kind:'human' 才推给人
  | { t: 'request.resolved'; requestId: string; decision: Decision | null;
      by: { kind: 'auto' | 'model' | 'human' | 'host' | 'harness'; id?: string } | 'timeout' | 'runtime_cancelled' }
  | { t: 'usage'; usage: unknown }
  | { t: 'notice'; code: 'compacting' | 'api_retry' | 'rate_limited' | 'runtime_restart' | 'auto_review' | 'continuity'; message: string }
  | { t: 'delivery.settled'; operationId: string; route: ReplyRoute; result: 'delivered' | 'rejected' | 'unknown'; providerMessageId?: string }
  | { t: 'render.anchor'; route: ReplyRoute; turnId: string; providerMessageId: string; leaseUntil?: number }
  | { t: 'native'; name: string };                                  // 未映射的原生事件，只进 full tier
interface ItemSummary { itemId: string; type: 'command' | 'file_change' | 'mcp_tool' | 'tool' | 'subagent' | 'web_search' | 'hook' | 'compaction' | 'user_message';
  title: string; status: 'running' | 'completed' | 'failed' | 'declined' | 'skipped'; inputSummary?: string;
  result?: { preview: string; truncated: boolean | null; isError: boolean } }

// ===== Channel 适配器（私有通道实现这个；进程外就是同名 JSONL 帧）=====
interface ChannelCaps {
  text: { maxChars: number; markdown: 'none' | 'basic' | 'full' };
  edit: boolean; nativeStream?: { minIntervalMs: number; maxBytes: number; ttlMs?: number }; // 限额可配置，不写死
  buttons: boolean; media: ('image' | 'file' | 'audio')[]; voiceOut: 'none' | 'tts' | 'stream';
  threads: boolean; approvals: 'buttons' | 'link' | 'none'; defaultTier: Tier;
  evidence: Origin['evidence'][];      // [r1] 本适配器能提供的身份证据；结论由 Policy.identify 给出
}
interface ChannelAdapter {
  readonly id: string;
  caps(account: string): ChannelCaps;
  start(ctx: { account: string; config: unknown; signal: AbortSignal;
    emit(env: InboundEnvelope): Promise<{ inputId?: string; disposition?: string }>;
    log(...a: unknown[]): void }): Promise<void>;
  send(route: ReplyRoute, msg: RenderedMessage, op: { operationId: string; as?: string }): Promise<{ providerMessageId?: string }>;
  //   [r1] as = 发送者身份（如 'runner:x/run:y'）；adapter 必须随消息携带（元数据或页脚），回流时还原成 Origin.declared
  edit?(route: ReplyRoute, id: string, msg: RenderedMessage, op: { operationId: string; sequence: number }): Promise<void>;
  finalize?(route: ReplyRoute, id: string, msg: RenderedMessage): Promise<void>;
  retract?(route: ReplyRoute, id: string, outcome: string): Promise<void>;   // 撤审批卡
  speak?(route: ReplyRoute, u: { text: string; interruptible: boolean }): Promise<void>;
  typing?(route: ReplyRoute, on: boolean): Promise<void>;
  reconcile?(route: ReplyRoute, id: string): Promise<'alive' | 'gone'>;      // 重启后接管流式卡
}
interface RenderedMessage { text: string;
  sections?: { kind: 'body' | 'details' | 'status' | 'footer'; text: string; collapsed?: boolean }[];
  actions?: { id: string; label: string; style?: 'primary' | 'danger' }[];     // 点击回 gateway，带 operator 身份
  attachments?: { ref: string; mime: string; name?: string }[];
  link?: { label: string; url: string };                                       // 鉴权 trace 深链
  channelData?: unknown }

// ===== Runtime 适配器（跑在 aio-runtimed）=====
// [r1] Claude Code / Codex 是 harness，智能来自它搭载的模型：两者是独立维度。
interface RunSpec {
  harness: string;                     // 'claude-code' | 'codex' | …
  model: string;                       // 原样传给 harness（--model / thread model），agents-io 不解释
  effort?: string;
  profile: string;                     // 权限 profile 名，映射见下；默认策略只有 'bypass' 与 'restricted'
}
// profile → harness 原生权限：Claude permissionMode/allowedTools，Codex sandboxPolicy + approvalPolicy。
// 映射表是部署配置，不写死在适配器里。
interface RuntimeCaps { steer: 'native' | 'tool_boundary' | 'none'; interrupt: true; approvals: boolean; questions: boolean;
  tokenDeltas: boolean; cancelQueued: boolean; injectWithoutTurn: boolean; resume: boolean;
  models?: string[]; switchModelMidSession: boolean }
interface RuntimeAdapter {
  id: string;                          // harness 名
  probe(): Promise<{ version: string; caps: RuntimeCaps }>;   // 版本断言，不在白名单内拒绝启动
  open(b: { sessionKey: string; generation: number; cwd: string; resume?: string;
            run: RunSpec;              // profile 变化需要不同进程/thread 时，由 lane 换 generation
            mcp: { url: string; token: string } }): Promise<RuntimeSession>;
}
// 模型能力分级（ModelProfile）、弱模型向强模型求助、用强模型做审批，都是宿主策略：
// 前者体现在 Policy.plan 返回的 RunSpec.model，后两者是 Policy.resolve 返回 { kind: 'model', model }。
interface RuntimeSession {
  nativeId(): string | undefined;                              // 拿到就持久化（multica PinTaskSession）
  startTurn(turnId: string, inputs: InputRecord[]): Promise<void>;
  steer(inputs: InputRecord[], expectedTurnId: string): Promise<'steered' | 'stale' | 'not_steerable' | 'no_active_turn' | 'unsupported'>;
  cancelQueued(inputIds: string[]): Promise<void>;
  interrupt(turnId: string): Promise<void>;
  respond(requestId: string, d: Decision): Promise<void>;
  events: AsyncIterable<Omit<SessionEvent, 'seq' | 'sessionKey'>>;  // seq 由网关分配
  close(reason: string): Promise<void>;
}
```

### 3.3 Claude Code 映射与有损点

**接入方式：用 TS Agent SDK `query({prompt: AsyncIterable<SDKUserMessage>})`，由 SDK 拉起本机 `claude` CLI。** 这仍然是"直接用 Claude Code 本体"，因为 SDK 只是把 CLI 子进程包了一层、线协议相同。选 SDK 而不是裸 `claude -p` 的理由：`--permission-prompt-tool stdio` 不是 CLI 公开文档的值（`--help` 只写 `<mcp tool>`，feasibility §1.1），而 SDK 的 `canUseTool` 回调是公开 API；SDK 也给出类型化的 `interrupt()`、`setPermissionMode()`、进程内 `createSdkMcpServer`。裸 stream-json 作为备选（openclaw 证明可行）。

| 方向 | Claude 原生 | → canonical |
|---|---|---|
| 新 turn | `SDKUserMessage{priority:'later', uuid: inputId, origin}`（只在 idle 时写，一次一个路由批） | `input.admitted{new_turn}` |
| steer | `priority:'next'`，仅同 principal | `input.admitted{steer}`，事后以 `user_message_uuids` 确认 |
| 撤回排队 | `cancel_async_message{message_uuid}` | `input.cancelled` |
| 停止 | `query.interrupt()` / `control_request{interrupt}`（**不用 `now`**） | `turn.completed{interrupted}` |
| 文本/思考 | `stream_event`（需 `includePartialMessages`） | `text.delta` |
| 工具 | assistant `tool_use` / user `tool_result` / `tool_progress` | `item.started/completed/progress` |
| 子 agent | `system/task_*` + `parent_tool_use_id`（需 `forwardSubagentText`） | `item{type:'subagent'}` + `parentItemId` |
| 审批 | `canUseTool(toolName, input, {suggestions, signal, requestId, …})` | `request.opened`；`signal` abort → `request.resolved{runtime_cancelled}` |
| 结束 | `result{user_message_uuids, total_cost_usd, usage}` | `input.consumed` + `turn.completed` |
| 状态 | **网关自己从 turn 生命周期推导**；`session_state_changed` 可能要 `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS` 才发 [推测]，不依赖它 | `session.state` |

**有损点**：
- 没有原生多客户端，transcript 单写者：多端完全由网关补。必须检测"有人在终端 `claude --resume` 同一 session"（启动时用 pid 锁 + `system/init` 里的 session_id 比对）。
- Claude **没有"注入上下文但不开 turn"**（`shouldQuery:false` 只追加到 transcript [推测：在 headless 下的行为待验证]）。会议 observeOnly 不能逐句注入，只能批量摘要后作为 ref 或在下一个 dispatch 时带上。
- 中途 steer 粒度是工具边界（`tool_boundary`），不是任意时刻。
- 审批约束必须原样带出：`suppress_always_allow_rule=true` → 卡片不出现"总是允许"；`default_to_no` → 不默认选允许；`decision_reason` 含 ANSI 需清洗。
- Channels / Remote Control 不可用（`-p`/SDK 下忽略自研 channel；Remote Control 绑 claude.ai）。
- 重启恢复：**默认不设置** `CLAUDE_CODE_RESUME_INTERRUPTED_TURN`（自动重跑会重复 `git push`/发邮件这类副作用）。中断的 turn 标 `ambiguous`，下一个 turn 开头注入 continuity notice，在端上给 owner 一个"继续上次任务"按钮（`control{op:'resume_interrupted'}`），由人决定是否重跑。
- 内存成本：每 session 一个常驻 CLI 进程 [推测：几百 MB 级]，runtimed 做 LRU 空闲回收，回收前确保没有挂起审批，回收后靠 `resume` 续接。

### 3.4 Codex 映射与有损点

**接入方式：runtimed 起 `codex app-server --listen unix://<path>`，网关所在的 runtimed 是唯一写连接。** 握手断言版本（openclaw `assertSupportedCodexAppServerVersion`），`generate-ts` 锁定类型。

| 方向 | Codex 原生 | → canonical |
|---|---|---|
| 新 turn | `turn/start{threadId, input, clientUserMessageId: inputId}` | `input.admitted{new_turn}` |
| steer | `turn/steer{expectedTurnId, clientUserMessageId}`；失败 → 降级 queue | `input.admitted{steer\|queued}` |
| 停止 | `turn/interrupt` | `turn.completed{interrupted}` |
| 过程 | `item/started|completed`、`item/agentMessage/delta`、`item/reasoning/*Delta`、`item/commandExecution/outputDelta`、`turn/plan/updated`、`turn/diff/updated` | `item.*` / `text.delta` / `plan.updated` / `diff.updated` |
| 旁白/最终 | `agentMessage.phase = commentary \| final_answer` | `audience: commentary \| answer`；commentary 喂 headline |
| 审批 | `item/*/requestApproval` → 回 `{decision}`；`serverRequest/resolved` | `request.opened/resolved`；`deny`→`decline`，`deny+interruptTurn`→`cancel` |
| 自动审查 | `approvalsReviewer: auto_review\|guardian_subagent` + `item/autoApprovalReview/*` | `notice{auto_review}` + `request.resolved{by:'auto_review'}` |
| 状态 | `thread/status/changed`（`active{waitingOnApproval}`） | `session.state` |
| consumed | `userMessage` item 的 `clientId` | `input.consumed` |

**有损点**：
- 通知不带 seq（已核实），断线只能 `thread/resume` + `thread/turns/list` 补；网关日志是唯一可续传的序列。
- 无订阅者 30 分钟卸载：runtimed 保持订阅，但要配合 LRU，否则每个活跃 thread 长期占进程。
- 空 thread 没有 rollout 时第二个客户端无法 resume（botmux 实测）。
- 原生 `thread/queue/*`（experimental）与网关 lane 并存会冲突：**MVP 不用原生队列**。
- 新连接会被重放挂起的审批（`replay_requests_to_connection_for_thread`），任何挂上来的 TUI 都能批。所以 MVP 不给人类 TUI 凭证（unix socket 权限 0700）。
- app-server 和 `--listen` 仍标 experimental；字段迭代快，必须 contract test。
- `thread/realtime/*` 是另一种架构（语音绑在 Codex thread 上），不是可选优化，不进主路径。

### 3.5 信任与安全：机制在库内，策略在宿主 [r1]

**原则**：人的注意力是最稀缺的资源，逐次审批默认关闭。agents-io 内置的是**不占用人注意力**的机制：身份盖章、按来源选 profile、外发目的地检查、请求生命周期。下面每一条里，"谁、什么条件"都由 `Policy` 钩子决定（`POSITIONING.md` §4），文中写的是默认策略。

**审批 resolver**（`Policy.resolve` 的返回值）：
- `auto`（默认）：按 profile 直接放行或拒绝，不出现在任何端上，只记 `request.resolved{by:auto}`。
- `model`：交给宿主指定的强模型判断，输入是动作描述 + 会话摘要，不需要拉起完整 harness。判不了时可以返回 `escalate`，变成 `human`。Codex 原生的 `approvalsReviewer` 是同一思路，可直接映射。
- `human`：只用于宿主明确列出的动作（如对外付款、删库、对外发布），推给指定主体与路由。
- `host`：宿主异步处理，例如 x-work-os 把它变成一个 approval 类 ask，走它自己的分诊（0006）。

以下条目中，凡写"审批"的，都只在 resolver 为 `human` 时适用。

1. **网关盖章**：adapter 只提交本命名空间内的 `channelUserId` 和身份证据（`evidence`）；`Principal` 由 `Policy.identify` 给出，adapter 不能自填。
2. **profile 不借用**：一轮合并了多条输入时，`Policy.plan` 拿到所有输入的 origin。默认策略：全部来自主人用 `bypass`；含外部来源输入用 `restricted`（不同的 Claude 进程 permission mode / Codex `sandboxPolicy` + `approvalPolicy`）。这是降权，不是弹窗。
3. **低信任来源进隔离 session**：邮件、会议、`channel_event`、私有通道的外部事件、群里非 owner 默认不进 owner 主 session。要把内容拉进主 session，必须由 owner 触发，以摘要或 `ref` 形式。**不做"私聊默认汇入 main"**，跨通道合并只靠显式配对码绑定，以飞书 `union_id` 为键，并提供撤销流程。
4. **resolve / interrupt 都带 origin，并在服务端重新校验** eligible。`allow_session` 只在 Web 或私聊端，只给 owner。群卡片上的审批只给"去私聊/Web 批准"的链接。
5. **语音和会议不能审批**，默认只能 queue、interrupt（仅本设备发起的 turn）、查询状态。
6. **外发目的地受限**：只能是 replyRoute、extraDeliveries，或 owner 预登记的路由；否则需要 owner 审批。工具调用由宿主注入 `trustedCaller`，并剥离模型写入的同名键（botmux 做法）。
7. **审批默认短超时**（建议 10 分钟，可配），超时 deny；审批挂起期间允许 interrupt 并清队列，避免 lane 被一个夜间审批卡到第二天。
8. **审批卡显示风险摘要**（是否写文件、联网、提权）和鉴权的全文链接，不做会藏掉中间部分的首尾截断。
9. 邮件：校验 DKIM/SPF/DMARC，通过也最多 `member`，永远不能 steer 或审批；审批链接的 GET 必须只读（企业邮件网关可能预取链接 [推测]），批准要登录后 POST。
10. 日志静态加密、设保留期，`native` blob 设 TTL；`visibility:internal` 在 Hub 出口白名单强制。
11. 账号级并发上限 + 预算熔断（Claude `rate_limit_event`、`total_cost_usd`，Codex `account/rateLimits/updated`）。

---

## 4. 语音 / 会议等实时端

### 4.1 共同原则

- 实时端**不直接接** Claude/Codex 事件流（一轮是秒到分钟级）。前面放一个**语音前台**（channel adapter 内部组件），负责听、说、确认、打断；需要干活时调 `agent_consult(text)` → 网关 `Command{input, mode:'queue'}`；以 `headline` tier 订阅结果。
- 前台**只能通过工具描述后台状态**（`agent_status` 读最新 headline），不能自己编造进度；先说一句"好，我去看一下"再 consult。
- 转写以 `transcript` 内容块写回 session（`observeOnly`），保证接力到飞书或 Web 时历史连得上。
- 结果太长或含代码：只念结论，并通过 `extraDeliveries` 把完整内容投到 owner 的飞书私聊（只有已配对的 principal 才能这样做）。

### 4.2 小米音箱：先做 1 周 spike，再定方案

三份设计共同的空洞：原厂小爱**没有给第三方的麦克风流 API**（feasibility §2.1）。三条路线：

| 路线 | 输入 | 输出 | barge-in / 全双工 | 适用 |
|---|---|---|---|---|
| A. MiGPT 式（MiNA/MIoT） | 轮询小爱已识别的对话文本（秒级延迟，小爱自己会抢答） | TTS / 播放 URL | 不支持 | 原厂设备，最低成本 MVP |
| B. open-xiaoai 刷补丁固件 | 麦克风音频流 → realtime 模型 | 音频流 | 可做 | 仅 LX06 / OH2P，需 SSH，有保修和安全风险 |
| C. 自制端（ESP32/树莓派 + 麦克风阵列，或手机/网页 WebRTC 页面） | 音频流 → gpt-realtime | 音频流 | 可做 | 体验最好，硬件另配 |

**决定**：MVP 走 A，`voiceOut:'tts'`，无 barge-in，只念 headline 和 final 的口语摘要（`spokenText`）。gpt-realtime 前台只在 B/C 路线验证延迟和稳定性之后才上。spike 的产出：真实端到端延迟、小爱抢答的抑制方法、设备是否支持持续对话。另外，音箱是共享设备：默认策略给它的主体 labels 最多 `member`，不能审批，只能 steer 本设备发起的 turn。

### 4.3 飞书会议：按 botmux 已验证的路线

- **前提**（botmux 实测，`docs/design/2026-06-30-vc-bot-subscriptions-integration.md:75-100`）：会议开启 AI Summary 和"允许智能体加入"，应用申请 `vc:meeting.meetingevent:read`。bot 入会后能拿到 `transcript_received`（speaker、起止时间、`sentence_id`、文本）、`chat_received`、`participant_joined`。P0 是轮询，延迟秒级到十秒级。
- **会议是独立 session**（`meeting:<id>`），和 owner 主 session 隔离；参会者默认 `guest`。
- **转写可修订**：同一 `sentence_id` 会被修订（latest-wins）。只消费 `stable: true` 的句子（稳定窗口），用 `revisionOf` 表达修订。
- **dispatch 门槛**：会中聊天 @bot，或白名单说话人的唤醒词（speaker 能否映射到 open_id [推测] 待验证）；其他一律 `observeOnly`。转写按时间窗摘要后再作为上下文，不逐句进 runtime（Claude 没有 inject-without-turn）。
- **输出分阶段**：v0 只发会中聊天的 final 短文本 + 旁路监听群卡片（card tier）；v1 再做实时音频发言（`vc:meeting.bot.realtime:write` + protobuf 音频 WS，PCM 24kHz），复用 4.2 的语音前台内核。
- **副作用单出口**：多个 agent 可以消费同一会议 feed（各自 cursor），但对外发言/发消息只有一个 action gate（botmux `2026-07-10-vc-multi-agent-consumer-delivery.md`）。

### 4.4 邮件

`final` tier + digest；Message-ID / In-Reply-To 映射到 session；回复邮件作为 `queue` 输入；默认进隔离 session；审批只给鉴权链接。

---

## 5. 采纳与驳回的批评

### 5.1 采纳

| 批评 | 来源 | 落地位置 |
|---|---|---|
| Claude CLI 自行合批、`next` 是默认值并会折入运行中 turn → 网关持有队列、显式 priority、`user_message_uuids` 对账 | feasibility 致命 2；ops §4 | §2.4 规则 1–2 |
| `'now'` 不是 interrupt | 两份都有 | §2.4、§3.3 |
| 小米音箱缺设备侧音频通道 → spike | feasibility 致命 1 | §4.2 |
| steer 跨端时 replyTo 矛盾 → steer 仅同 principal + `extraDeliveries` | feasibility 致命 3 | §2.4 规则 4、`turn.delivery_added` |
| 网关重启杀 runtime → 拆 `aio-runtimed`；禁止自动重跑；`ambiguous` 一等 | 两份都有 | §3.1、§3.3 |
| Codex TUI 无只读模式 → MVP 只让网关写，不发 TUI 凭证 | feasibility 致命 5；ops §3 | §2.4 规则 8 |
| steer 失败三类都降级 queue | feasibility | §2.4 规则 3 |
| `cancel_async_message` 实现清队列 | feasibility | §2.4 规则 6 |
| Decision 按 runtime 带约束（suggestions、suppress_always_allow、default_to_no、cancel vs decline、auto_review） | feasibility | §3.2 `Decision`、`request.opened` |
| 网关盖章 Origin（[r1] 结论由 Policy.identify 给出） | ops 致命 3 | §3.5 第 1 条 |
| [r1] profile 由 Policy.plan 按全部输入来源决定；默认外部来源进隔离 session 或受限 profile | ops 致命 1、2 | §3.5 第 2–3 条 |
| resolve/interrupt 带 origin、服务端重验；`allow_session` 仅 owner + Web/私聊 | ops | §3.5 第 4 条 |
| 语音/会议不能审批 | ops 致命 4 | §3.5 第 5 条、§4 |
| 外发目的地受限（防外泄） | ops | §3.5 第 6 条 |
| 审批短超时 deny、挂起时允许 interrupt | ops | §3.5 第 7 条 |
| delta 走内存环（ephemeral），不逐 token 写 SQLite，保护 stdout drain | ops（批 TB） | §3.1 Log |
| 分层 token bucket + 优先级；长任务降级 headline 卡；深链鉴权；群默认不展示工具细节 | ops | §2.6、§3.1 |
| CardKit 限额是二手数据 → 做成可配置并回官方文档核实 | 两份都有 | `ChannelCaps.nativeStream` |
| 会议转写可修订、P0 是轮询；会议字幕/转写能力"没看到"已过时 | feasibility | §4.3 |
| `session_state_changed` 可能默认不发 → 网关自己推导状态 | feasibility | §3.3 |
| 首 item > 30s → 合成 headline | feasibility | §2.6 |
| 砍掉 collect | ops（附议 TB） | §2.3 |
| ~~第一个外部通道上线前必须有审批流~~ **[r1]** 第一个外部通道上线前必须有身份盖章和按来源选 profile；主人自己的轮次可以 bypass | ops 致命 5 | §6 M2 闸门 |
| 用 provider 侧幂等（飞书请求 uuid）收敛 `unknown` | ops | §3.1 Outbox（去重窗口 [推测] 待核实） |

### 5.2 驳回或修改

| 批评/提议 | 处理 | 理由 |
|---|---|---|
| feasibility："以 thin-bridge 为骨架" vs ops："以 event-sourced 为骨架" | **折中**：协议面取 TB 的窄度（kind 约 20 个、`native` 透传、不做 epoch/custody 全家桶），运行语义取 ES（admitted/consumed、ambiguous、runtime_cancelled、ephemeral delta、visibility、delivery.settled、render.anchor） | 两份评审其实只在"从哪份抄"上分歧，各自要保留的点并不冲突 |
| feasibility 建议"Claude MVP 接受网关重启即中断，依赖 `CLAUDE_CODE_RESUME_INTERRUPTED_TURN` 恢复" | **驳回自动重跑**，改为拆 runtimed + 人工确认重跑 | ops 指出自动重跑会重复副作用；拆 runtimed 的成本低（一个薄 daemon），且一并解决了 IM 长审批悬空 |
| thin-bridge "Claude 用裸 CLI stream-json，和 Codex 对称" | **改为 Agent SDK** | `--permission-prompt-tool stdio` 不是 CLI 公开值；SDK `canUseTool` 是公开 API。对称性不如稳定性重要 |
| event-sourced / human-ux 的 `dmScope=main` 默认合并私聊、identityLinks 自动接力 | **驳回** | 上下文污染不可撤回（runtime 拥有 transcript）。改为显式绑定 + 配对码 |
| human-ux 语音和 IM 默认 steer | **驳回**，默认 queue | 语音无说话人认证；IM 群里多人。steer 只在同 principal 时自动启用 |
| event-sourced narration tier "≤16k、2s 快照" | **驳回**，用 human-ux 的 headline | 16KB 是 UI 侧栏的文本尾部，不适合 TTS |
| human-ux "headline 小模型每 2 秒改写" | **修改**：只在有新 activity 时触发，默认关 | 成本和额外的数据出境点（ops §9） |
| ops "voice 默认只能 queue/interrupt/查询，不能 steer" | **部分采纳**：允许 steer 本设备发起的 turn | 否则"另外再把测试跑一下"这种语音插话完全不可用；同设备 steer 不跨 principal |
| ops "群里非 owner 一律隔离 session" | **修改**：群 session 本身就和 owner 主 session 隔离；群内非 owner 输入用 restricted profile，不另开 session | 群聊协作本来就需要共享上下文；隔离的是群与私有主 session |
| event-sourced 把 Codex `thread/realtime/*` 作为可选增强 | **驳回进入主路径** | feasibility 指出它是另一种架构（语音绑 Codex thread），且 experimental |
| event-sourced 的 durable ingress、Postgres + Redis Stream 多副本、epoch 全套 | **推迟**到硬化阶段 | 单机小团队，SQLite + 单网关 + runtimed 足够；先保证语义正确 |
| ACP 作为统一 runtime 层 | **驳回做核心**，保留为第三方 agent 兜底 | 丢 Codex 多客户端、expectedTurnId、diff、queue，多一跳进程 |
| 统一富展示（openclaw `MessagePresentation` 全套 + 合约测试） | **只取子集**（sections/actions/link/attachments + `channelData`） | 富展示是渲染问题，不是路由问题 |

---

## 6. 风险与 MVP 路线

### 6.1 风险（按影响排序）

| 风险 | 缓解 |
|---|---|
| 原生协议漂移（Codex app-server experimental；Claude 字段受版本控制） | `probe()` 版本白名单；`generate-ts` 锁类型；contract test 回放录制的原生事件；未知事件进 `native` 不崩 |
| 注入 → 越权/外泄 | §3.5 全套；[r1] 身份盖章和受限 profile 先于任何外部通道上线（人工审批不是前提） |
| Claude 合批导致归属错 | 网关持有队列 + 显式 priority + `user_message_uuids` 对账 + `ambiguous` |
| 小米音箱不可行或延迟太差 | spike 先行；退路是路线 C（网页/手机语音端）或只做"文本轮询 + TTS 播报结论" |
| 飞书限流/卡片限额 | 分层 token bucket、优先级、长任务降级、限额可配置并核实官方文档 |
| 进程/内存成本（每 session 常驻 CLI + app-server） | runtimed LRU 回收 + resume；账号级并发上限 |
| 会议上下文膨胀/成本 | 隔离 session + 窗口摘要；observeOnly 不逐句进 runtime |
| 日志存密钥 | 源头脱敏 + 静态加密 + TTL + 出口白名单 |
| 自建复杂度失控（前车：openclaw、botmux 3 万行 daemon） | core 不许出现 runtime/通道特例（只能进 adapter 或 `native/channelData`）；kind 数量设上限，新增要评审 |

### 6.2 分阶段

| 阶段 | 内容 | 退出条件（闸门） |
|---|---|---|
| **M0 骨架**（约 2 周 [推测]） | `packages/protocol`（§3.2 类型 + JSON Schema）；`aio-gateway`：lane、Log（SQLite durable + 内存 ephemeral 环）、Hub（`fromSeq` + snapshot）；`aio-runtimed` + ClaudeAdapter（Agent SDK、`canUseTool`、`includePartialMessages`、`forwardSubagentText`）；Web `full` tier：时间线、输入框、审批按钮 | 多 tab 同时看、同时发；网关重启后 turn 不断、审批不丢；Claude 合批场景下 `input.consumed` 对账正确 |
| **M1 Codex + 多端输入** | CodexAdapter（unix socket、steer 降级、`clientUserMessageId`、auto_review 映射）；queue/steer/interrupt 全规则；`cancel_async_message`；`ambiguous` + continuity notice + "继续"按钮 | 两个 runtime 的录制事件 contract test 通过；steer 竞态测试通过 |
| **M2 飞书 IM（第一个外部通道）** | Ingress 盖章、显式路由绑定（未绑定沉默）、restricted profile、`card` tier compositor（累积全量、续卡、长任务降级、鉴权深链）、私聊 owner 审批卡（[r1] 仅当 resolver=human）、群里链接、分层限流、outbox + provider uuid 重试 | §3.5 第 1–8 条全部有测试；群里非 owner 无法批准、无法打断 owner 的 turn |
| **M3 私有通道 + 邮件** | 进程外 JSONL channel 协议 + 50 行参考实现（一个 echo 私有通道）；邮件 adapter（final + digest、DKIM、隔离 session、只读 GET 链接） | 接入第一个真实私有通道且不改 core 代码 |
| **M4 语音 spike → 语音 v0** | 1 周对比路线 A/B/C；v0 = 路线 A：headline + final 播报、`agent_consult`、配对码绑定 principal | 端到端延迟数据；语音无法审批的测试 |
| **M5 飞书会议 v0** | 会议 session、转写轮询 + 稳定窗口 + 修订、聊天 @ dispatch、窗口摘要、会中聊天 final、监听群卡片、单出口 action gate | 一场真实会议跑通且无误触发 |
| **M6 硬化 / v2** | runtimed LRU、账号级预算熔断、日志加密与保留期；Codex TUI 写入（带 foreign turn fencing）；会议实时语音（v1）；realtime 语音前台（路线 B/C 通过后）；durable ingress | — |

M0 + M1 合起来就已经是一个"多端看、多端说、能审批、重启不丢"的 Claude Code / Codex 控制台；之后每接一个端都不需要改 runtime 侧。
