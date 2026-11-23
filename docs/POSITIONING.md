# agents-io 定位：Agent 输入输出基建

> 状态：草案（2026-10-06）。本文给出仓库边界，`RECOMMENDATION.md` 给出边界内的设计。两者冲突时以本文为准。

## 1. 一句话

**agents-io 把任何通道的输入变成统一信封，把任何 harness 会话的过程变成可订阅的事件流，再把输出投递到任何通道。** 它是一组协议、库和可选守护进程，本身不是 agent 系统：不知道任务、决定、记忆、经验，也不替使用者做信任和审批判断。

使用者（下称"宿主"）可以是 x-work-os、某人自己的 bot、一个客服系统，或者一个只想"在飞书里看 Codex 在干什么"的脚本。agents-io 不依赖任何宿主，宿主也不必用它的全部。

## 2. 边界

| agents-io 做（机制） | agents-io 不做（交给宿主） |
|---|---|
| 通道适配器：收消息、归一化成 `InboundEnvelope`、按能力渲染并投递、编辑、撤回、TTS | 某条输入该不该处理、进哪个 session、开不开任务 |
| 身份**证据**：适配器提交"平台签名 / DKIM 通过 / 仅设备"等证据，网关盖章 `Origin` | 身份**结论**：渠道用户是谁、属于什么角色、有多大权限 |
| 身份**表明**：每条入站消息带作者（人 / agent / 外部），agent 发出的每条消息随附自己的身份，回流时还原、默认不再处理 | 哪些 agent 账号可信、多人多 agent 同场时谁的话算数 |
| Harness 适配器：驱动 Claude Code、Codex 等 harness 本体，事件映射到 `SessionEvent` | 选哪个模型、何时升级到更强的模型、模型能力分级 |
| 会话事件流：每 session 一条带 seq 的日志、订阅、快照、多端 fan-out | 记忆、上下文组装（brief）、经验 |
| 输入 lane：queue / steer / interrupt、合批对账（admitted ≠ consumed） | 谁有资格 steer、冲突时谁优先 |
| 请求生命周期：`request.opened/resolved`，可插拔的 resolver | 审批策略：自动放行、交给模型审、还是找人 |
| 投递义务：outbox、幂等、`delivery.settled` | 投递给谁、多久汇总一次、何时打扰人 |
| 进程外协议（JSONL）：任何语言写通道或 harness 适配器 | 任务调度、执行节点、租约 |

判据：**一个能力如果不同宿主会有不同答案，它就是策略，放在宿主里；agents-io 只提供让宿主表达这个答案的钩子。**

## 3. 分层与包

每层都可单独使用，上层只依赖下层的协议，不依赖实现。

```
L3  aio daemon（可选）   gateway + runtimed 两进程，配置文件驱动，开箱即用
L2  session              lane · log(seq) · hub(subscribe/snapshot) · compositor(tier) · outbox
L1  adapters             channel/*（feishu, mail, voice-front, jsonl-bridge…）
                         harness/*（claude-code, codex, jsonl-bridge…）
L0  protocol             类型 + JSON Schema + JSONL 帧 + 一致性测试套件
    hooks                Policy 接口（见 §4），全部可选，默认实现只够单人自用
```

- **只要通道**（L0 + channel/*）：宿主自己有事件存储，只想"从飞书收、往飞书发"。x-work-os 的接收程序和 to-human 适配器就是这种用法。
- **只要观察**（L0 + harness/* + L2 的 hub）：宿主用无头方式跑 harness，把事件流 tee 给多端只读展示，不注入任何输入。
- **完整会话网关**（L3）：多端看、多端说、审批，即 `RECOMMENDATION.md` 的形态。

## 4. 策略钩子

宿主通过这几个钩子表达策略。每个钩子都有默认实现，默认值只覆盖"一个主人自己用"。

```ts
interface Policy {
  // 渠道身份 → 宿主主体。返回 null 表示未知发送者。
  identify?(e: { channel: string; channelUserId: string; evidence: Evidence }): Promise<Principal | null>;
  // 一条输入要不要处理、进哪个 session、以什么模式。
  admit?(input: StampedInput): Promise<Admission>;   // { action: 'dispatch'|'observe'|'drop', sessionKey, mode }
  // 这一轮用哪个执行配置：harness、model、权限 profile 都由宿主给出。
  plan?(turn: TurnDraft): Promise<RunSpec>;          // { harness, model, effort?, profile, mcp? }
  // 某个请求（工具审批、提问）由谁来答。
  resolve?(req: RequestOpened, ctx: TurnContext): Promise<Resolver>;
  //   Resolver = { kind: 'auto', decision } | { kind: 'model', model, prompt? }
  //            | { kind: 'human', principals, routes } | { kind: 'host' }（宿主异步回调）
  // 主动外发前检查目的地。
  outbound?(d: { from: TurnContext; to: ReplyRoute }): Promise<'allow' | 'deny'>;
}

type Principal = { id: string; labels: string[] };   // labels 由宿主定义，agents-io 不解释
```

默认策略：
- `identify`：只认配置里列出的主人。
- `admit`：主人的消息进主人的 session；未知发送者在私聊里 `drop`，在群里 `observe`。
- `plan`：主人的轮次用 `bypass`；含外部来源输入的轮次用 `restricted`。
- `resolve`：默认 `auto`。
- `outbound`：只允许本轮回复路由和主人预登记的路由。

多人、多 agent 同场（一个群里有主要用户、其他成员、本部署的多个 agent、别家的机器人）时，作者认定按三步走：
1. 适配器给出平台层面的发送账号和证据；
2. 若发送账号是 `Policy` 认可的 agent 账号，采信消息随附的 `declared` 身份；否则文本里的任何自称都不算；
3. `identify` 把结果映射为主体，或标为外部。本部署 agent 自己发出的消息回流时标 `self`，默认丢弃，避免 agent 之间互相回声。

这里没有"信任等级"这样的内置枚举。`owner/member/guest` 只是默认策略里的一种 labels 用法。

## 5. Harness 与 Model 分离

Claude Code、Codex 是 harness（工具、沙箱、上下文、会话管理），智能来自它搭载的模型。所以：

- `RunSpec = { harness, model, effort?, profile }`，harness 与 model 是两个独立维度，agents-io 原样传给 harness 适配器。
- `HarnessCaps`（能否中途 steer、有无审批回调、能否多客户端）由适配器 `probe()` 声明。
- 模型能力分级（`ModelProfile`）、"弱模型向强模型求助"、"用强模型做审批"都是宿主策略：前者在 `plan` 里决定，后两者是 `resolve` 返回 `{ kind: 'model' }`。agents-io 只负责执行这个 resolver：拉起一次轻量模型调用，或者把请求交给宿主。

## 6. 稳定性承诺

要让别人放心复用，协议必须比实现稳定。

1. `protocol` 包语义化版本，帧带 `v`，未知字段必须保留透传。
2. 一致性测试套件：任何语言的通道或 harness 适配器跑过它就算兼容。
3. 进程外 JSONL 协议与进程内 TS 接口一一对应，私有通道不需要 fork 本仓库。
4. 核心只认 `native` / `channelData` / `raw` 作为扩展口，平台私有字段不进核心类型。

## 7. 与 x-work-os 的关系

x-work-os 是一个宿主，agents-io 不为它特化。对照它已定稿的提案：

| x-work-os 的位置 | 用 agents-io 的哪部分 | 说明 |
|---|---|---|
| 0008 接收程序（IM、邮件拉取） | channel/* 收消息 → 宿主写 `input add` | 0008 明确不定义接收程序契约，这正是适配器层 |
| 0003 to-human 适配器（`notify`） | channel/* 的 send，包一层一次性进程 | 0003 要求一进一出 JSON，薄包装即可 |
| 0006 推送与 inbox | outbox + 渲染 tier | 推什么、何时推由 0006 决定，agents-io 只投递 |
| 0006 §7.7 人从 IM、邮件回复变成回答 | channel/* 收回复 + `identify` 钩子 + `Origin.declared` | x-work-os 草案 0010（渠道身份表明与经渠道回答）定义规则，agents-io 只是其一种实现 |
| 0001 §4.4.3 终端只供人观察 | harness/* + hub，只读订阅 | 不注入输入、不解析最终文本，与 0003 [runner.output] 一致 |
| 0005 F 会话中确认决定 | 讨论在 agents-io 的会话里进行，会话引用由它提供 | 引用格式由部署决定，agents-io 提供稳定的 `sessionKey` + seq |

x-work-os 的执行器是"一轮一个无头进程、只通过命令输出、运行中不推消息"（0003 §4.6、0006 [ask.answer](2)）。所以 agents-io 的 steer、多端输入不用于 x-work-os 的执行器，只用于讨论会话和其他宿主。这一点不冲突：agents-io 的 lane 是可选能力，"只要观察"模式就不用它。

集成代码（把 channel 包成 0003 的 `notify` 进程、把回复转成 `answer` 调用）放在本仓库之外，或放在 `examples/x-work-os/` 里，不进核心包。

## 8. 对现有设计文档的修订

`RECOMMENDATION.md` 写于定位确定之前，以下几处按本文修订（已在原文标注）：

1. "审批和信任必须是一等公民" → **机制是一等公民，策略不是**。审批默认 `auto`，人只处理宿主指定的动作。
2. `Trust` 枚举 → `Principal.labels`，由 `identify` 钩子给出。
3. `RuntimeAdapter.open({profile: 'owner'|'restricted'})` → `open(RunSpec)`，harness 与 model 分离。
4. M2 的上线闸门由"必须有审批流"改为"必须有身份盖章，并按来源决定 profile"。

## 9. 在 agent 框架生态里的位置

> 补记（2026-11-23，决定 16 采纳）：把定位从"x-work-os 等宿主的 IO 层"扩大为"各 agent 框架共用的会话 IO 运行时"。§1–§6 的边界不变，本节说明在众多框架之间它占哪一层、替代各框架里的哪一部分，以及怎样做到不耦合业务。

### 9.1 分层

| 层 | 解决什么 | 代表（2026-11） | 与 agents-io 的关系 |
|---|---|---|---|
| 模型 | 推理 | 各家模型与模型网关 | 不碰：`RunSpec.model` 原样传给 harness |
| harness / agent loop | 工具、上下文、沙箱、一轮怎么跑 | Claude Code、Codex、OpenCode、Gemini CLI；框架有 Claude Agent SDK、OpenAI Agents SDK、LangGraph、Mastra、Google ADK、CrewAI | **南向**：驱动它们（`HarnessAdapter`） |
| agent ↔ 工具 | 调工具 | MCP | 给 agent 挂 IO 工具；对外 MCP 端点 |
| agent ↔ agent | 发现、委派 | A2A | 远端 agent 可作为一种 harness；`run.start` 可对外以 A2A 暴露（规划） |
| agent ↔ 单个前端 | 把一个 agent 的事件流交给一个在线的界面 | AG-UI、ACP（Zed 的 Agent Client Protocol）、A2UI、MCP Apps | **北向投影**：任何会话都能以这些形式被一个端订阅（规划） |
| 通道 | 各 IM 平台的收发 | Vercel Chat SDK、Bot Framework、openclaw 的通道插件 | **北向通道**：自有适配器，也可桥接 Chat SDK 的适配器（规划） |
| 产品 / 宿主 | 任务、记忆、信任、界面 | persona、openclaw、x-work-os、multica、happyclaw、botmux | **宿主**：经 `Policy` 钩子和宿主协议使用 agents-io |

标准协议规定的是**某一条边的线格式**：MCP 是 agent 到工具，A2A 是 agent 到 agent，AG-UI 和 ACP 是 agent 到一个在线前端。它们都不管**中间**那一层：

- 同一个会话被多个通道、多个端、多个人同时看、同时说；
- 进程或守护进程重启后不丢输入、不丢正在跑的一轮；
- 每条消息是谁说的、有没有资格让 agent 做事；
- 每次投递有没有真正送到、会不会发两次。

于是每个产品都自己造一遍这一层：

- persona 在 Go 里写了 seq 续传、三种回执、审批路由、通道读轮、needs-you 计数（`docs/design/core-slimming/` §7）；
- openclaw 有约 250 个字段的 `MsgContext`；
- happyclaw、botmux、multica 各有一套（`RECOMMENDATION.md` §1）。

**agents-io 占的就是这一层：会话 IO 运行时**，相当于 agent 的 tty 加 tmux：

- 通道适配器是终端设备；
- lane 是行规程（排队、插话、Ctrl-C）；
- 日志加订阅是可以随时 attach / detach 的多路复用器。

### 9.2 替代各框架里的哪一部分

替代的是各框架自己手写的这 7 件事，不替代框架本身：

1. 入站归一、来源盖章、去重；
2. 确定的会话路由（Binding 表），每会话单写者 lane（queue / steer / interrupt），admitted ≠ consumed 对账；
3. 过程日志：seq、快照、续传、多端 fan-out、按 tier 投影（中立的卡片模型）；
4. 请求生命周期：审批和提问只结算一次、超时、可插拔 resolver；
5. 投递义务：outbox、幂等、`delivery.settled`、流式编辑的节奏；
6. 因果与可解释：`aio explain`、因果链、防循环；
7. 重启接续：轮次接管、排队输入有明确终态。

不替代的：agent loop、工具语义、记忆与上下文、任务的真相、信任结论、产品界面。

**护城河是这 7 件事的语义（`INVARIANTS.md` 的 102 条承诺），不是适配器的数量。** 适配器是可以买来的：Chat SDK 已经覆盖了一批 IM 平台，ACP 已经覆盖了一批 coding agent。但这些语义，没有哪个标准规定过。

### 9.3 怎样成为不耦合业务的通用组件

1. **内核不认识任何具体通道、harness、模型**：由 `scripts/boundaries.mjs` 守住，基线只降（`docs/design/core-slimming/` §6）。内建适配器与第三方走同一条契约。
2. **内核不发起模型调用、不带产品默认值**：话题标题、预设、陌生人放行、改运行配置的聊天命令，都做成可替换的模块或交还宿主（core-slimming §2 的 host 级）。
3. **三个面都接标准协议**，这样框架接入时一行代码都不用改：
   - **南向**：原生适配器接 Claude Code、Codex（最深：插话、对账、重启接管）；**一个 ACP 适配器**接一批支持 ACP 的 coding agent；**一个 AG-UI 客户端适配器**接以 AG-UI 暴露后端的框架；JSONL harness 帧兜底任意程序。
   - **北向**：原生通道（飞书、邮件）、JSONL 桥、**Chat SDK 桥**（复用它的 Slack / Teams / Discord / Telegram / WhatsApp 等适配器）；会话按标准协议对外投影：**AG-UI 服务端**让网页界面订阅任意会话，**ACP 服务端**让编辑器加入会话，MCP 端点（已有）给外部 agent，A2A 服务端（规划）给调用方形态的 agent 通信。
   - **宿主**：`Policy` 钩子和宿主协议，任意语言（HOSTS §1）。
4. **语义可以离开 TS 验证**：一致性 fixture（core-slimming G8）让其他语言的实现和宿主不跑 TS 也能自检。实现语言的取舍见 core-slimming §8。

框架与宿主的接入路线，与 §3 的三种用法一一对应：

- **只要通道**：例如 LangGraph、Mastra 应用只想让 agent 进飞书和邮件，就用 channel 模块加 Compositor。
- **只要观察**：已有 harness 的产品想让多端看到过程，就用 harness 适配器加 Hub。
- **完整会话网关**：例如 persona 这类产品，可以把通道读轮与中立卡片（persona #13408）、`interactive_sessions` 的会话语义（#13551）、`work_executor`（#13555）交给 agents-io，自己只留业务。
