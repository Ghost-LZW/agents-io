# agent 之间的通信：地址、身份、因果链与防循环（地基）

> 状态：提案（2026-10-10），待 owner 拍板。
> 依据：`docs/ROADMAP.md` §1（原则 2、4、6、7）、§2（第 1、6 项为本提案采纳范围；第 2、3、4、5 项只说明怎样接上）、§4 "现在"第 2 项；`docs/design/locus/DECISIONS.md` 决定 3、4、5、9、11、12；`docs/POSITIONING.md` §2、§4；`docs/HOSTS.md` §3。代码以当前 `main`（c52bad5）为准，下文的行号都已对照代码核实。

## 1. 一句话

**给每个 agent 与 session 一个稳定地址；agent 产生的输入由守护进程盖章（`kind: "agent"`、守护进程签发的主体与证据），并带一条 cause 链（根、跳数、来自哪个 turn）；在 lane 收输入的唯一入口处按跳数和"同一对 agent 来回次数"截停，截停的输入只记为上下文、不开 turn，日志与 `aio explain` 可查。** 这一步不增加任何模型工具，模型只在来源前言里多看到一个 `hop=`。

## 2. 现状

### 2.1 已有的零件

| 零件 | 代码 | 现状 |
|---|---|---|
| 来源类型 | `packages/protocol/src/inbound.ts:66-72` `OriginKind` | 已有 `agent`；`Origin`（`:75-88`）有 `principal`、`evidence`、`declared`、`self`、`via`、`adapter` |
| 证据 | `packages/protocol/src/common.ts` `Evidence` | `platform_signed` / `dkim_pass` / `device_only` / `none`，没有"守护进程自己签发"这一档 |
| 输入记录 | `inbound.ts:91-98` `InputRecord` | `inputId`、`origin`、`content`、`replyRoute`、`channelContext`；没有任何因果字段 |
| 盖章 | `packages/session/src/ingress.ts:262-270` | `origin` 来自 `Policy.identify` 的结论，`via` 是回复路由的 routeKey |
| 身份规则 | `packages/session/src/identity.ts:99-112` | `selfAccounts` 里的账号 → `kind: agent, self: true`；`agentAccounts` 里的账号可声明身份（声明成成员视为伪造）；其他 `isBot` → `kind: agent, principal: null` |
| 回声 | `router.ts:504`、`router.ts:725`、`watch.ts:349`、`watch.ts:602` | `origin.self` 的输入：规则默认不匹配（除非 `includeSelf`），匹配了也从 `dispatch` 降为 `context`；watch 默认排除，`trigger` 降为 `context`。即"本部署自己的输出永远不开 turn" |
| `selfAccounts` 来源 | `gateway.ts:281`、`config.ts:314` | 只来自配置 `policy.selfAccounts`，不会从运行中的通道（例如飞书 `botOpenId`）自动补 |
| agent 的身份 | `packages/host-mcp/src/tools.ts:146-152` `agentOrigin` | `{ kind: agent, principal: null, evidence: none, declared: "session:<key>", via: "agent:<key>", adapter: "host-mcp" }`，**只用于创建 watch**，不是任何输入的来源 |
| 输出工具 | `tools.ts:543-560` `message`、`:400-430` `deliver` | `send_message` / `reply_to` 经 `Policy.outbound` 后由 Outbox 发到通道；记 `agents-io.output` 事件（带本轮 provenance）；**不产生任何输入**。目的地只能是本轮回复路由、本轮输入的回复路由或预登记路由（`policy.ts:111-117`） |
| 随附发送方 | `SendOp.as`（`protocol/src/channel.ts:125`）、`compositor.ts:502` 等、`outbox.ts:98` | 机制在，但守护进程从不设置：`HostTools` 没传 `as`，`Compositor` 也没有。飞书适配器的 `declared` 存储、邮件的 `X-Agents-IO-Sender` 头因此在守护进程里都是空的 |
| 出站记录 | `daemon/src/records.ts` `daemon_outbox`、`outbox.ts:14-22` | 按 operationId 记结算结果与 `providerMessageId`；`DeliveryRecord` 不存 turnId（`Delivery.turnId` 有，只写进 `delivery.settled` 事件）；没有 "providerMessageId → 哪个 turn" 的索引 |
| 本轮来源 | `lane.ts:333-353` `provenance` / `track`、`protocol/src/host.ts:190-201` `TurnProvenance` | `triggeredBy`、`watched`、`external`、`group`；随宿主写请求与输出事件出去（决定 4） |
| 外部来源判定 | `lane.ts:1259` `isExternal` | `principal === null` 且不是宿主/系统输入 |
| 前言 | `harness/claude-code/src/content.ts:31-38`、`harness/codex/src/map.ts:25-31` | `from= kind= via= declared= self=`，再把 `channelContext` 的每一项都列出来 |
| explain | `cli.ts:512`、`host.ts:138`、`router.ts` `explain` | 只有路由解释（匹配了哪些规则、callout、launch、拒绝）；不能从一条输入追到产生它的 turn |
| 话题换手 | `tools.ts:651-654` | 已有一个局部防乒乓：刚被换手过来的输入不能再换手 |
| 宿主/本地输入 | `daemon/src/host.ts:63`、`gateway.ts:1692` | 宿主是 `kind: system, principal: host:<name>`；本地客户端是 `kind: human, evidence: device_only` |

### 2.2 今天 agent A 的输出到了 agent B 会怎样

逐条路径核对：

| 路径 | 会发生什么 | 会不会循环 |
|---|---|---|
| 同一守护进程两个飞书机器人在同一个群（决定 8） | 飞书是否把机器人 A 的群消息推给机器人 B **还没核实**（ROADMAP §4 "被外部条件挡住"）。若推：B 的适配器看到 `sender_type: app`，`isBot: true`，`platform_signed`（`lark-bot/src/inbound.ts:213-240`）。A 的 open_id 只有在运维手写进 `policy.selfAccounts` 时才算 `self`；否则是 `kind: agent, principal: null` 的陌生 agent | 默认表下不会：开 turn 的默认规则都要求 `owner` 标签（`router.ts:815` 起），陌生 agent 只落到 `observe-group`（上下文）。A 用 `mention` 工具 @ 了 B，B 的适配器会给 `admission: dispatch`，但仍不是主人，仍只是上下文 |
| 跨部署两个机器人在同一个群 | 同上，B 看到的是 `agentAccounts` 里声明过的 agent（principal `{id: declared, labels: ["agent"]}`）或陌生 agent | 默认不会，理由同上 |
| 邮件互发（两套部署，或部署与外部自动程序） | 收件侧只把 `Auto-Submitted`、`Precedence: bulk` 等丢掉（`mail/src/inbound.ts:40-50`）；agent 回信不带 `Auto-Submitted`，带 `In-Reply-To` 进同一线程 | 默认不会（非主人邮件是 `observe-mail` 上下文）。**一旦配置让对方的信开 turn，就是无界的来回** |
| `send_message` 发到本部署另一个 session 在听的路由 | 输出只走通道。同一机器人账号发到自己听的会话：飞书一般不回推自己发的消息；若回推，`echo` 判定会给 `admission: observe`（`inbound.ts:214、240`），不会命中 `mentions: ["self"]`。发往 `local` 只写事件流，不产生输入 | 不会 |
| 监听（watch） | `trigger` 监听只排除 `self`，不排除别的 agent；被触发的 turn 的回复路由是目标 session 的"主路由"（`gateway.ts:1672`，例如主人私聊），不回到被监听的群 | 默认不会。要循环需要双方都有 trigger 监听，且群路由被预登记、模型主动 `send_message` 到群里 |
| 宿主（`on: host`、`inbound.redispatch`、`input` 帧） | 宿主的输入是 `kind: system` | 宿主自己的事 |

**结论：默认配置下今天没有循环风险。** 守住的是三件事：默认表只让主人开 turn、`self` 回声永远不开 turn、模型只能发到本轮相关路由。但风险是**配置出来的**，而且一旦出现没有任何东西兜底：

1. 只要有一条规则（本地或宿主表、callout 答复、`labels` 映射）允许非主人的 agent 消息开 turn（"群里谁 @ 机器人都回"、`known: false` 的邮件客服、把对方 agent 映射成带标签的成员），两个 agent 就可以无限来回：没有跳数、没有频率上限、没有断路器。
2. 同部署多机器人时，兄弟机器人是不是 `self` 全靠运维手写 `selfAccounts`；忘了写，本部署的输出回流时被当成陌生 agent，失去"回声不开 turn"的保护。
3. 出了事查不了：B 的输入和 A 的 turn 之间没有任何记录相连，`aio explain` 只能说明 B 的输入命中了哪条规则。
4. POSITIONING §2 承诺的"agent 发出的每条消息随附自己的身份"在守护进程里没有接上（`as` 从不设置）。

## 3. 判据

- **只做 IO**（原则 6、决定 12）：地址、盖章、因果记录、截停都是投递机制；谁能联系谁、哪些 agent 可信、协作是否完成，是宿主（x-work-os）或本地配置的策略。
- **只标来源，不降权**（决定 4、5）：cause 链与跳数是来源标记；截停只针对"开不开新 turn"，不改变权限 profile，也不拦截宿主写命令。
- **不加模型负担**（原则 2）：第一步不加工具；模型看到的变化只在前言里。
- **可检验**（原则 4）：截停与 cause 链各对应一条不变量，`aio explain` 可从任意 agent 输入追到根。

## 4. 设计

### 4.1 地址

- **agent 地址**：`<agent>`（配置里的 agent 名，已限定为字母、数字、`.`、`_`、`-`，`config.ts:786`，不含 `/` 和 `:`）。
- **session 地址**：`<agent>/<sessionKey>`，即 ROADMAP 的写法。`sessionKey` 原样使用（例如 `dev/dev:lark-bot:default:oc_x`、`dev/dev:main`、`exec/run:r1`）。
- **路由形式**：一个虚拟通道 `agent`：`ReplyRoute { channel: "agent", account: <agent>, conversationId: <sessionKey> }`，routeKey 为 `agent:<agent>:<sessionKey>`。这样 `Origin.via`（定义就是"来源的 routeKey"）、回复路由、`Policy.outbound`、`parseRoute`（`tools.ts:366-378`，第三段起整体作为 conversationId）都不用改形状。

稳定性：

- **跨重启**：sessionKey 由路由规则确定性算出并持久化（日志、`daemon_session_agents` 先到者为准），地址随之稳定。
- **跨话题**：话题会话各有自己的 key（第一个话题是对话自己的 key，之后是 `#<topicId>`，`router.ts` `topicKey`）。地址指的是**确切的那个 session**，不自动改投"当前话题"：对方回复 A 时应回到发问的那个 session（与 `ask_choice` 的答案回到发问 session 一致）。停放的话题仍可收输入，lane 打开时按原生会话续接。发现（第 2 项）列出的是当前话题，首次联系自然落在当前话题。
- **task run**：`<agent>/run:<runId>` 只在 run 运行期间可寻址（同 `gateway.ts` 对 `run:` 的现有限制）。

### 4.2 盖章：agent 产生的输入

由守护进程（不是 agent、不是适配器）盖章，客户端不能自填，与 `Origin` 现有规则一致：

```ts
// 本部署内产生的 agent 输入（第一步：回流找回；第二步起：agent_send / agent_run）
origin = {
  kind: 'agent',
  principal: { id: 'agent:<agent>', labels: ['agent'] },   // 宿主身份映射可改写，见下
  evidence: 'daemon',                                      // 新的一档：守护进程自己产生的记录
  via: 'agent:<agent>:<sessionKey>',                       // 发送方 session 的 routeKey
  adapter: 'agent',
}
```

- **新证据档 `daemon`**：本机最强一档，含义是"这条记录由守护进程自己产生（它运行的 agent 的 turn）"，不经任何外部平台。不复用 `platform_signed`（会被身份映射默认接受，语义混淆），也不复用 `device_only`（那是本地客户端，含义更弱）。
- **主体**：默认 `agent:<agent>`（按 agent，不按 session：同一 agent 的不同会话是同一个主体，具体会话在 `via`）。宿主可以沿用决定 3 的身份映射，把 `{ channel: "agent", channelUserId: "<agent>" }` 映射成自己的成员 id 和 labels（例如 x-work-os 的 agent 成员 id）。**agent 主体不能带 `owner` 标签**：映射里出现即配置错误（本地表启动失败，宿主表 `bindings.put` 拒绝）。这保证默认 `plan`（只有全主人输入才 `bypass`，`policy.ts:94`）与默认 `control`、审批资格都不会因为 agent 转话而升级。
- **回流的本部署输出**（第一步就做）：入站时用新的出站索引（§4.3.3）查 `(channel, envelope.id)`，命中即是本部署某个 turn 发出的消息：`self: true`（**不再依赖手写 `selfAccounts`**），主体为发出它的 agent，证据保持通道的（`platform_signed` 等，因为记录本身来自平台），cause 的 `basis: "recovered"`。路由行为不变：`self` 永远不开 turn。
- **随附身份**：守护进程开始设置 `SendOp.as`：值为 `agent:<agent>`（只给 agent 名，不给 sessionKey：邮件头会被外部收件人看到，sessionKey 里有会话 id）。具体 session 由出站索引在本机找回。
- **外部 agent**（另一部署、第三方机器人）：照旧由身份规则判定（`agentAccounts` 声明、`isBot`），不得到 `daemon` 证据。

### 4.3 cause 链

#### 4.3.1 字段：放在 `InputRecord.cause`，不放 `channelContext`

```ts
export const InputCause = Type.Object({
  /** 发送方：本部署 agent 的 session 地址，或渠道身份 `<channel>:<channelUserId>`（外部 agent）。 */
  peer: Type.String(),
  /** 守护进程凭什么知道：internal（agent_send/agent_run，第二步）、recovered（本部署发出的消息经通道回来）、declared（受信 agent 账号声明，见 §4.3.4）、none（只知道是 agent，链断了）。 */
  basis: Type.Union([Type.Literal('internal'), Type.Literal('recovered'), Type.Literal('declared'), Type.Literal('none')]),
  /** 距根的跳数：1 = 由根输入触发的 turn 产生。链断（basis none）时不填。 */
  hop: Type.Optional(Type.Integer({ minimum: 1 })),
  /** 链 id：根输入的 inputId（declared 时是对方给的不透明 id）。 */
  chain: Type.Optional(Type.String()),
  /** 产生它的本部署 turn。 */
  from: Type.Optional(Type.Object({ sessionKey: Type.String(), turnId: Type.String() })),
  /** 根输入的主体（null = 未知），只作来源标记。 */
  rootPrincipal: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  /** 产生它的 turn 的来源标记，原样带过来（不洗白，§4.7）。 */
  carried: Type.Optional(Type.Object({ external: Type.Boolean(), watched: Type.Boolean(), group: Type.Boolean() })),
});
InputRecord.cause?: InputCause   // 只出现在 origin.kind === 'agent' 的输入上
```

为什么不放 `channelContext`：

- `channelContext` 的前半段来自适配器（`ingress.ts` `channelContext` 先展开 `env.context`），是"声明"；cause 是守护进程的结论，必须和 `origin` 一样不可由客户端或适配器填写。
- 前言会把 `channelContext` 每一项都列给模型（`content.ts:35`、`map.ts:29`），链 id、turnId 这些对模型是噪音（原则 2）。
- `InputRecord` 整体进 `input.admitted` 与 `router_explain`，cause 自然持久化，lane 从日志重建时也在。

#### 4.3.2 计算与传播

- **人和宿主的输入**没有 cause，跳数视为 0，自己是一条链的根（chain = 它的 inputId）。
- **一个 turn 的链**：在 `Lane.track`（`lane.ts:339`）里与 provenance 一起算：`hop = max(触发输入的 hop，没有 cause 的算 0)`，chain / rootPrincipal 取跳数最大的那条输入的；`carried` 是本轮 provenance 的 `external/watched/group`。steer 进来的输入跳数更大时，更新本轮的值。上下文输入（只记录的）不参与：它们没有触发本轮。harness 自己开的 turn（`initiator: harness`，决定 11 的委托 turn 除外）沿用该 session 上一轮的值。
- 结果写进 `TurnProvenance` 新增的可选 `cause: { hop, chain, rootPrincipal }`，随宿主写请求与 `agents-io.output` 事件出去（决定 4 的通道不变）。
- **这个 turn 产生的输入**得到 `hop = turn.hop + 1`、同一 chain、`from = { sessionKey, turnId }`。第一步里产生的途径只有"回流"（§4.3.3）；第二步的 `agent_send` / `agent_run` 在工具调用时直接从 `provenance(sessionKey, turnId)` 取。
- **原样传递、不加跳**：watch 把输入转投到目标 session（`watch.ts` `deliver` 新建 InputRecord 时复制 cause）、话题换手（`session_rotate` / `session_switch`）、`inbound.redispatch`（已原样复制 `item.input`）。这些是"同一条输入换了地方"，不是新的一跳。

#### 4.3.3 跨通道：本部署内用出站索引找回，不在消息里夹带

本部署两个 agent 经飞书群、邮件等平台相遇时，链没法放进消息本身（飞书文本里夹标记会被人看见、可伪造；卡片的隐藏字段不随普通消息回推）。但守护进程知道自己发过什么：

- 新表 `daemon_outbound (channel, provider_message_id, session_key, turn_id, operation_id, at)`：Outbox 结算为 `delivered` 且有 `providerMessageId`、`turnId` 时写一行（输出工具的发送、compositor 的回复卡片都带 turnId，`compositor.ts:585`）。保留期同 `daemon_outbox`（30 天）。
- 入站时（`Ingress.process`，在 `identify` 之后、路由之前）用 `(env.channel, env.id)` 查表。飞书的入站 `id` 就是 `message_id`（`lark-bot/src/inbound.ts:221`），与发送结果的 `providerMessageId` 相同且在机器人之间通用；邮件的入站 id 是我们生成的 Message-ID。命中 → §4.2 的回流盖章，`cause = { peer: <A 的 session 地址>, basis: "recovered", hop: A 那轮 + 1, chain, from, ... }`。
- 这条路径的输入仍是 `self`，按现规则不开 turn。所以第一步里它只带来两样东西：兄弟机器人不再需要手写 `selfAccounts`；记录能连起来（explain）。将来若要让同部署的 agent 在群里"当着人"互相 @ 对话，可以按规则显式开启（`includeSelf` + 允许 dispatch），届时跳数上限自然生效；这一步不做。

**诚实的限度**：

- 飞书是否把机器人消息推给同群其他机器人还没核实；不推则这条路径在飞书上根本不出现。
- 适配器把长消息拆成多条时只报最后一条的 id（`SendResult` 注释），前面几条回流找不回，只能落到 `basis: none` 的判定（但发送账号仍可能在 `selfAccounts`）。
- 出站索引过了保留期、或另一台机器的守护进程，都找不回。

#### 4.3.4 跨部署：链断，承认它

另一套部署或第三方机器人发来的消息，链在通道上带不过来：

- 默认 `basis: "none"`：只有 `peer`（渠道身份），没有 hop。跳数上限对它无效，靠 §4.4.2 的成对来回上限兜底。两边都是 agents-io 时，各自的上限都在，来回次数不超过两边上限中较小的那个。
- 可选（待拍板 4）：邮件出站在设了 `as` 时同时加 `X-Agents-IO-Hop: <n>; chain=<不透明 id>`；收件侧只在发件账号属于 `agentAccounts` 且 `dkim_pass` 时采信（与 `declared` 同一规则，`mail/src/inbound.ts:77-82`），得到 `basis: "declared"`。飞书没有对等的隐藏字段，不做。

### 4.4 防循环

检查点只有一个：**lane 收到要开 turn 的输入时**（`Lane.input`，`lane.ts:530`，`queue` / `steer` / `interrupt` 都经过这里）。所有路径——通道规则的 dispatch、watch trigger、宿主 `input` 帧、`inbound.redispatch`、以后的 `agent_send` / `agent_run` 回传——都在这里汇合，不需要在每条路径上各写一遍。`observe`（上下文）不检查：它不开 turn。

#### 4.4.1 跳数上限

- 输入的 `cause.hop > maxHops` → 截停。
- 默认 `maxHops: 8`。配置：`policy.loopGuard.maxHops`；宿主可在 `Policy.plan` 之外另行收紧（见 §4.6，是策略）。
- 合批时取最大值（保守）：人和一条第 8 跳的 agent 输入同轮，这一轮按第 8 跳算。人重新说话会开一条新链，跳数从 0 开始。

#### 4.4.2 成对来回上限

对不知道跳数的输入同样有效，也拦住"每次都换个话头、跳数不涨"的两人对话：

- 每个接收 session 按 peer 计数：**自上一次由非 agent 输入触发的 turn 以来、窗口期内，由这个 peer 的 agent 输入触发的 turn 数**。peer 对本部署 agent 取 agent 名（话题轮换不换主体），对外部取渠道身份。
- 计数达到 `maxTurns` → 该 (session, peer) 进入"已截停"，此后这个 peer 的 agent 输入都截停，直到：这个 session 里有一次非 agent 输入触发的 turn（人回来了），或窗口期过去。
- 默认 `pair: { maxTurns: 10, windowMs: 15 分钟 }`。配置 `policy.loopGuard.pair`。
- 计数器在内存里（每个 lane 一个小表），重启清零。跳数上限随 cause 持久化，重启后仍有效；成对上限重启后重新计数，接受这个代价（待拍板 5）。

#### 4.4.3 截停时做什么

| 去向 | 做什么 |
|---|---|
| 输入本身 | 不开 turn，改为**记成上下文**（`input.admitted { disposition: "observe_only" }`，带 `channelContext.loopGuard: "hops" \| "pair"`）。满足"每条输入要么被消费、要么被明确拒绝"：它进了对话记录，下一个由人触发的 turn 会带着标注看到它。选上下文而不是 `input.rejected`，是为了人回来时 agent 知道对方说过什么 |
| 接收 session 日志 | `notice { code: "loop_guard" }`（`NoticeCode` 新增一项），`visibility: operators`，正文写明 hop / 上限，或 peer / 次数 / 窗口，以及解除条件。`aio attach`、控制台照常显示 |
| 发送 session 日志 | 能确定发送 turn 时（`internal` / `recovered`），在那边也记一条同样的 notice |
| explain | `RouteExplanation` 新增 `cause` 与 `loopGuard: { tripped: "hops" \| "pair", hop?, limit, peer?, count?, windowMs? }`；`aio explain <inputId>` 直接显示 |
| 宿主 | 经已有途径看到：上述 session 事件，以及（被截停输入若是 `on: host` 再派发来的）`inbound.redispatch` 的结果。不新增宿主帧；状态推送属于第 5 项 |
| 通道 | 默认**不发**任何消息：断路器自己往群里说话可能正好喂给对面的 agent。可配置 `policy.loopGuard.announce: true`，每次截停在该输入的回复路由上发一条系统短句（每个窗口至多一次），见待拍板 3 |
| 发送方模型 | 第一步没有直接告知途径（它的消息已经发出去了）。第二步 `agent_send` 被截停时工具返回错误 `loop_guard: …；停下来，向用户报告`，模型在工具结果里看到 |

### 4.5 模型看到什么

只在前言里加一项，别的不变（原则 2）：

```
[agents-io input from=agent:reviewer kind=agent via=agent:reviewer:reviewer:main hop=3 ...]
```

- `hop=` 只在输入带已知跳数时出现；链 id、turnId、`carried` 不给模型。
- 被截停后又作为上下文交给后来的 turn 时，前言里会有 `loopGuard=pair`（来自 `channelContext`），模型知道这条当时没被处理。
- 第一步不加工具，不改工具说明。

### 4.6 可见与许可：只定义钩子

谁能列出、联系、派活给、观察哪个 agent，不同宿主答案不同，是策略。第一步只定义钩子，第二步的工具才调用它：

```ts
interface Policy {
  // ...
  /** agent 之间的一次联系是否允许。op：list（出现在发现结果里）、send、run、observe、control。 */
  contact?(a: { from: AgentAddress; to: AgentAddress | { agent: string }; op: 'list' | 'send' | 'run' | 'observe' | 'control'; turn: TurnContext | null }): Promise<'allow' | 'deny'>;
}
type AgentAddress = { agent: string; sessionKey: string };
```

- 宿主回调：`host.hello.callouts` 增加 hook 名 `contact`，超时或出错按本地默认（与 `resolve` 相同的失败模式，决定 9）。
- 本地默认：`policy.agentContacts: [{ from: "<agent>|*", to: "<agent>|*", ops?: [...] }]`；**不写就是全部拒绝**（工具本来也默认关闭，原则 2）。
- 截停参数（`maxHops`、`pair`）也是策略的一种，第一步只做本地配置；宿主要逐会话调整时再加到 `contact` 的答复或单独的帧里，等有需要再说。

### 4.7 与决定 4/5/12、原则 7 的关系

- **决定 4/5（只标来源，不降档）**：cause 链是来源标记，随 provenance 交给宿主；截停只决定"开不开新 turn"，不改 profile、不拦宿主写命令。agent 转话不洗白来源：`carried` 让 B 这一轮的 provenance 继承 A 那一轮的 `external/watched/group`（`lane.ts` `track` 里并进去）。否则陌生人的话经 A 转一手，到 B 就变成"有主体、非外部"的输入。主体为 `agent:<A>` 的输入本身不算 external（它有守护进程签发的主体），但带过来的标记照算。
- **默认 profile**：agent 触发的 turn 不是"全主人输入"，默认 `plan` 给 `restricted`（`policy.ts:94-103`）。这是现行规则按"触发本轮的输入"决定 profile 的直接结果，不是新加的降档。宿主若认为"主人开的链上的 agent 转话"应该放行，用 `rootPrincipal` 在自己的 `Policy.plan` 里决定；agents-io 默认不用它决定权限。
- **决定 12**：agents-io 只记 IO 因果，不记任务、分工、验收。agent 代为审批是第 5 项的事，须显式开启；本提案保证 agent 主体默认不在任何审批资格里（不能带 `owner` 标签；默认 `control` 只认主人与本轮 owner）。
- **原则 7**：链只在控制面（输入、provenance、explain）流动。x-work-os 要把一次协作与自己的任务对上，用宿主写请求附带的 provenance（含 cause），或第二步 `run.start` 的关联 id；agents-io 不把链写进 agent 的工作区或环境。

### 4.8 `aio explain`

- `aio explain <inputId>`：现有路由解释，加 `cause`、`loopGuard`。
- `aio explain --chain <inputId>`：沿 `cause.from` 往回走：这条输入 → 产生它的 turn（`from.sessionKey` 日志里的 `turn.started.inputIds`）→ 那一轮的触发输入 → …，直到跳数为 0 的根；每一级列 hop、inputId、session 地址、主体、turnId、是否截停。链断（`basis: none`）处停下并注明。往前走（某个输入引出了哪些后代）用新表 `daemon_causes (input_id, chain, hop, session_key, from_session, from_turn, at)`，按 chain 查整条链；保留期同 explain（7 天）。
- 宿主帧 `explain` 加可选 `chain: true`，返回同样的列表。

这补上了 ROADMAP §3 "任何副作用都能由 `aio explain` 追溯到触发它的轮次与输入"中跨 agent 的那一段。

## 5. 后续各项怎样接上

| 项 | 用到的地基 |
|---|---|
| 2 发现（`agents_list`） | 地址是列表的主键；`Policy.contact(op: list)` 过滤；状态取 lane 现有状态与 `ProgressView` |
| 3 消息（`agent_send`） | 目标地址 → lane；输入按 §4.2 盖章，`basis: internal`，`hop = 本轮 + 1`；回复路由是发送方的 `agent` 路由，对方的回复（compositor 对 `agent` 通道的投递）在守护进程内变成发送方 session 的新输入，同样加一跳；`Policy.contact(op: send)`；截停时工具返回错误 |
| 4 任务（`agent_run`） | 复用 `run.start` 的 `Runs` 路径（`daemon/src/runs.ts`），内部调用多带 `cause`；run 的输入 `hop = 本轮 + 1`，`RunEnded` 结果作为调用方 session 的输入回来，再加一跳；宿主发起的 `run.start` 可带不透明的关联 id（只记录、explain 可见），本身是根 |
| 5 观察与控制 | 状态通知是 `kind: system` 输入，不是 agent 输入，不加跳、不计成对次数；打断/插话走 `Policy.control`（agent 主体是本轮 owner 时可打断自己开的轮次）；代为审批是新的 Resolver 种类，`ResolvedBy.via = "agent:<agent>:<sessionKey>"`，须显式开启 |
| 外部 MCP 端点 | 外部 agent 进来时 `kind: agent`、证据为端点的认证方式（不是 `daemon`），cause 由对方声明时 `basis: declared` |

## 6. 方案比较

| 选择点 | 备选 | 取舍 |
|---|---|---|
| cause 放哪 | (a) `InputRecord.cause`（推荐）；(b) `channelContext` 键；(c) 只放在 `router_explain` 里 | (b) 可被适配器填写、会全部进前言；(c) lane 看不到，截停没法在唯一入口做，watch、换手、redispatch 也带不过去 |
| 截停在哪 | (a) lane 入口（推荐）；(b) ingress / router；(c) 各工具发送端 | (b) 漏掉宿主 `input`、watch trigger、本地客户端与以后的内部路径；(c) 漏掉经通道回流的那条路，而且发送端不知道接收端的成对计数 |
| 截停后的输入 | (a) 记成上下文（推荐）；(b) `input.rejected`；(c) 交给宿主队列 | (b) 人回来后 agent 不知道对方说过什么；(c) 没有宿主时无处可去，有宿主时也要宿主专门处理 |
| 跨部署的链 | (a) 承认断链，靠成对上限（推荐）；(b) 在消息文本里夹标记；(c) 邮件加 `Auto-Submitted` | (b) 人能看到、对方可伪造，违背原则 2；(c) 会让两套部署之间正当的 agent 邮件也被对面整封丢弃（`isAutomated`），并改变对人的语义；作为部署方可选项可以留着 |
| agent 主体粒度 | (a) 按 agent（推荐）；(b) 按 session | (b) 话题一轮换就是新主体，成对计数与宿主映射都对不上；具体会话已经在 `via` |
| 证据 | (a) 新档 `daemon`（推荐）；(b) 复用 `platform_signed`；(c) 复用 `device_only` | (b) 身份映射默认接受 `platform_signed`，会让 agent 输入意外命中成员条目；(c) 语义更弱，且与本地客户端混在一起 |
| 合批跳数 | (a) 取最大（推荐）；(b) 有人输入就清零 | (b) 简单地被"顺带一句人话"绕过；人要重开链，单独说一句即可 |
| 回流本部署输出 | (a) 出站索引找回并自动 `self`（推荐）；(b) 继续靠手写 `selfAccounts` | (b) 多机器人部署容易漏，漏了就失去回声保护，且查不到来源 |

## 7. 不做

- 不加模型工具（`agents_list` 等是第二步）。
- 不记协作状态、任务、谁该回复谁（决定 12）。
- 不按链的来源降权限或拦写命令（决定 4、5）。
- 不在飞书消息里夹带任何链信息。
- 不让本部署的回流输出开 turn（`self` 规则不变）。
- 不做跨机器守护进程之间的链传递（ROADMAP §2 末段）。
- 截停参数不做宿主逐会话下发（等有需要）。

## 8. 对协议、schema、配置的影响与改动文件

| 位置 | 改动 | 粗略大小 |
|---|---|---|
| `packages/protocol/src/inbound.ts` | `InputCause`、`InputRecord.cause?` | +35 |
| `packages/protocol/src/common.ts` | `Evidence` 加 `daemon` | +3 |
| `packages/protocol/src/events.ts` | `notice.code` 加 `loop_guard` | +1 |
| `packages/protocol/src/host.ts` | `TurnProvenance.cause?`、`RouteExplanation.cause?` / `loopGuard?`、`Explain.chain?` 与结果、`callouts` 认 `contact` | +50 |
| `packages/protocol/src/policy.ts` | `Policy.contact?`、`AgentAddress` | +20 |
| `packages/protocol/src/address.ts`（新） | 地址的格式化、解析、`agent` 路由互转 | +50 |
| schema | 重新生成 | — |
| `packages/session/src/loop-guard.ts`（新） | 跳数判定、成对计数与窗口、截停结果 | +150 |
| `packages/session/src/lane.ts` | `track` 算链并并入 `carried`；`input()` 前调用 guard，截停转 `observe` 并发 notice | +70 |
| `packages/session/src/ingress.ts` | 出站索引查询（注入函数）、回流盖章、cause 进 explanation | +50 |
| `packages/session/src/watch.ts` | 转投时复制 cause | +5 |
| `packages/session/src/identity.ts` / `router.ts` | `agent` 通道条目不得带 `owner`；explain 带 cause | +20 |
| `packages/session/src/outbox.ts` | 结算时回调 `onDelivered(d, rec)`（交给守护进程写索引） | +10 |
| `packages/host-mcp/src/tools.ts` | `agentOrigin` 改用新地址（`watch` 的 `createdBy` 保持 `session:<key>` 不迁移）；`as` 传入 | +15 |
| `packages/daemon/src/records.ts` | `daemon_outbound`、`daemon_causes` 两张表及查询 | +70 |
| `packages/daemon/src/gateway.ts` | 接线：guard 配置、出站索引、`as`、发送方 session 的 notice、`contact` 默认与宿主回调 | +90 |
| `packages/daemon/src/host.ts` | `contact` 回调、`explain { chain }` | +40 |
| `packages/daemon/src/config.ts` | `policy.loopGuard { maxHops, pair { maxTurns, windowMs }, announce }`、`policy.agentContacts` | +40 |
| `packages/daemon/src/cli.ts`、`client.ts` | `aio explain --chain` | +60 |
| `harness/claude-code/src/content.ts`、`harness/codex/src/map.ts` | 前言加 `hop=` | +4 |
| `channel/mail`（若待拍板 4 同意） | `X-Agents-IO-Hop` 出入 | +30 |
| 文档 | `docs/HOSTS.md` §3（agent 主体与 `contact`）、§4（explain chain）；`docs/CHANNELS.md`（自动 `self`）；`docs/INVARIANTS.md` 两条 | — |

生产代码约 800 行，测试约 600 行。全部是可选字段与新表（`CREATE TABLE IF NOT EXISTS`），无数据迁移。`Evidence` 加一档对严格校验的进程外宿主是可见变化，按 POSITIONING §6 记在协议变更说明里。

## 9. 测试

单元与集成（`packages/session/test/`、`packages/daemon/test/`）：

1. 盖章：回流命中出站索引 → `kind: agent`、主体 `agent:<A>`、`self: true`、`cause.basis: recovered`、hop = A 那轮 + 1；不在 `selfAccounts` 里的兄弟机器人也是如此。未命中且 `isBot` → `basis: none`，只有 peer。
2. 客户端不能设 cause：本地 `input`、宿主 `input` 帧、适配器 `env.context` 里写 `cause` / `hop` 都被丢弃或不生效。
3. agent 主体不得带 `owner`：本地表带 → 启动失败；宿主表带 → `bindings.put` 被拒。
4. turn 的链：合批取最大；steer 进来更大的跳数会更新本轮；上下文输入不参与；provenance 带 `cause`，`agents-io.output` 事件与宿主写请求里可见。
5. 不洗白：A 的一轮含陌生人上下文 → B 由 A 触发的那轮 `provenance.external === true`。
6. 原样传递：watch 转投、`session_rotate`、`session_switch`、`inbound.redispatch` 后 cause 不变、不加跳。
7. 跳数截停：hop = maxHops 开 turn；hop = maxHops + 1 → `observe_only` + `channelContext.loopGuard: hops` + 接收方与发送方各一条 `notice(loop_guard)` + explain 有 `loopGuard`；没有任何出站。
8. 成对截停：同一 peer 第 `maxTurns + 1` 次被截；其间一次人触发的 turn 清零；窗口过去清零；另一个 peer 不受影响；`basis: none` 的输入同样计数。
9. 四条入口都经过 guard：通道 dispatch、watch trigger、宿主 `input` 帧、`inbound.redispatch`。
10. 截停后的上下文交给下一个人触发的 turn，前言里有 `loopGuard=`。
11. 前言：带已知跳数的输入有 `hop=`，人输入没有；两个 harness 一致。
12. 持久化：重启后 lane 从日志重建的排队输入仍带 cause；`aio explain --chain` 重启后可用；成对计数清零（与文档一致）。
13. `explain --chain`：三跳链从叶子走到根；链断处注明 `basis: none`；按 chain id 列出整条链。
14. `as`：飞书、邮件出站带 `agent:<agent>`，不含 sessionKey。
15. `announce: true`：截停时在回复路由发一条系统短句，同一窗口内只发一次；默认不发。
16. `contact`：未配置 `agentContacts` 时默认拒绝；宿主声明 `contact` 时转给宿主，超时回本地默认（第一步只测钩子本身）。

e2e（`aio e2e`，`packages/daemon/src/e2e.ts` 加场景 `agent-loop-guard`）：

- 两个 agent `a`、`b` 跑在同一实例上，假通道 `e2e` 有两个机器人账号；测试用的绑定让对方机器人 @ 自己的消息开 turn（模拟"群里谁 @ 都回"的危险配置），提示词让两边每次都 @ 对方回一句。
- 假通道把 A 发出的消息以同一 `providerMessageId`、B 账号收到的形式再注入（模拟飞书把机器人消息推给同群机器人）。`maxHops: 3`。
- 断言：跳数为 1、2、3 的输入开了 turn；第 4 跳被截停，两边日志各有一条 `loop_guard` notice；`aio explain --chain` 从被截停的输入走回最初主人的那条消息；回流输入都是 `self`。
- 变体：注入时换掉消息 id（找不回链，`basis: none`），`pair.maxTurns: 3` 截停。

`docs/E2E.md` 同步加手动场景：真实飞书群里两个机器人（核实飞书是否推送机器人消息的同时验证找回）。

## 10. 迁移

- 默认行为不变：默认表下 agent 输入本来就不开 turn；新增的只有记录、`hop=` 前言和兄弟机器人自动 `self`。
- 自动 `self` 是收紧：以前漏写 `selfAccounts`、靠兄弟机器人消息开 turn 的部署（若有）会停止那样工作，需要改走第二步的 `agent_send`，或待以后显式开启（§4.3.3）。
- `agentOrigin` 的 `via` 从 `agent:<sessionKey>` 变为 `agent:<agent>:<sessionKey>`；watch 的 `createdBy` 仍是 `session:<key>`，已有 watch 不受影响。
- 宿主：`Evidence` 多了 `daemon`；`TurnProvenance` 多了可选 `cause`；严格枚举校验的宿主需更新。

## 11. 待拍板

1. 是否采纳总体形态：地址 `<agent>/<sessionKey>`（路由形式 `agent:<agent>:<sessionKey>`）、`InputRecord.cause`、lane 入口唯一检查点、截停转上下文。
2. **默认值**：`maxHops: 8`，`pair: { maxTurns: 10, windowMs: 15 分钟 }`。x-work-os 里评审来回可能更长，是否要更宽（例如 16 / 20），还是由宿主按会话放宽（需要新增下发途径）。
3. **截停时是否在通道里说一句**：推荐默认不说（`announce: false`），只记日志与 notice；群里的人会看到机器人突然不回。
4. **邮件跨部署的跳数头**（`X-Agents-IO-Hop`，只信 `agentAccounts` + DKIM）：是否随第一步做。推荐做，邮件是现实里最容易循环的通道。
5. **成对计数是否持久化**：推荐不持久化（重启清零，跳数上限仍在）；持久化需再加一张表。
6. **新证据档的名字与位置**：`daemon`，排在 `platform_signed` 之上；或者不加新档，用 `adapter: "agent"` + `platform_signed` 表达（不推荐，见 §6）。
7. **兄弟机器人自动 `self`**（§4.3.3、§10）：推荐采纳；这会关掉"同部署机器人在群里互相 @ 开 turn"的可能，以后要时再显式开启。
8. **`contact` 的本地默认**：推荐未配置即全部拒绝；另一种是"同部署的 agent 互相可见"，对单人自用更省事，但与"工具默认关、按配置开启"的口径不一致。
