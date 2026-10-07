# 一个守护进程跑多个飞书机器人（多个 lark-bot 通道实例）

> 状态：提案（2026-10-07），未实现，待拍板。拍板结果由 owner 记入 `docs/design/locus/DECISIONS.md`，本文不改动它。
> 依据：`docs/POSITIONING.md` §2（机制与策略的判据）、§4（多 agent 同场的作者认定）；`docs/design/locus/DECISIONS.md` 决定 1–6；`docs/critique/ops-security.md` §2（飞书 ID 有作用域）；待定提案 `docs/design/channel-stamping`（来源盖章、"一个通道 id 只属于一种适配器"）。
> 代码以当前工作区（`e69462a`）为准，下文行号都已对照代码核实。

## 1. 一句话

**让一个 aio 守护进程同时运行多个 `lark-bot` 通道实例，每个实例是一个飞书应用（机器人），在通道条目里用 `env:NAME` 引用自己的凭据，用 `account` 区分。** 入站、去重、记录、会话键、Binding 匹配今天已经按账号区分；缺的是三件事：配置只能读一套 `LARK_APP_*`、出站渲染只按通道 id 选适配器（多实例时会用错机器人发消息）、控制台只肯创建一个机器人。另外，"本部署自己的机器人"的识别需要从"一张手写的账号表"变成按应用识别，才能在多机器人下正确区分"我自己的回声"与"同部署的其他机器人"。

## 2. 问题

### 2.1 谁需要

一个部署跑多个机器人是常见形态，不同部署的分法不同：

- **按项目分**：每个项目一个机器人，各自拉进自己的群，背后是不同的 agent 与工作目录。
- **按 agent 分**：一个"写代码"的机器人、一个"值班"的机器人，用户直接私聊想找的那个。
- **团队机器人 + 个人机器人**：团队群里一个公用机器人，每个成员另有自己的私人助手机器人，同在一个守护进程里。
- **多租户 / 多品牌**：同一套服务给几个飞书租户（或飞书与 Lark 国际版）各建一个应用，凭据、域名都不同。

今天这些部署只能每个机器人跑一个守护进程（各自一份数据目录、socket、控制台端口），宿主要连多个守护进程，跨机器人的会话、记录、话题无法在一处看到。

### 2.2 配置：凭据只有一套，且固定从环境读

- 通道条目只有 `type`、`account`、`tier`、`config`（`packages/daemon/src/config.ts:127-131`、`:134-135`），注释写明"App id, secret and domain come from LARK_APP_ID / LARK_APP_SECRET / LARK_DOMAIN"（`config.ts:134`）。
- `resolveChannel` 对每个 `lark-bot` 条目都读同一组变量（`config.ts:1017-1021`），解析结果带 `lark: { appId, appSecret, domain }`（`config.ts:480`）。所以配两个 `lark-bot` 条目时，两者拿到的是**同一个应用**的凭据。
- 构造适配器时 `new LarkBotAdapter({ ...(ch.config ?? {}), ...ch.lark })`（`packages/daemon/src/gateway.ts:1251`）：`ch.lark` 覆盖 `config` 里的同名字段。也就是说，即使有人在 `config.appId`/`config.appSecret` 里写了别的应用，也会被静默替换。
- `mail`、`bridge` 的 `config`/`env` 会做 `env:NAME` 替换（`config.ts:1023-1032`，`substituteEnv` 在 `:1037`），`lark-bot` 的 `config` **不做**。而控制台已经把 `channels[i].config.appSecret` / `encryptKey` / `verificationToken` 当作凭据字段，要求写成 `env:NAME`（`packages/daemon/src/console-config.ts:81`）。结果是：按控制台的要求写 `"encryptKey": "env:LARK_ENCRYPT_KEY"`，适配器收到的是字面量字符串 `env:LARK_ENCRYPT_KEY`。这是现存的不一致，本提案顺带修掉（§5.1）。

### 2.3 同一应用开两条长连接会分走事件

lark-bot 每个适配器对象在 `start` 里用自己的凭据建一条 WebSocket 长连接（`channel/lark-bot/src/adapter.ts:224`），这一点天然支持"每个应用一条连接"。但按飞书长连接模式的规则，同一应用有多条连接时，每个事件只推给其中一条（集群模式，不广播）。今天两个 `lark-bot` 条目会得到同一应用的凭据（§2.2），事件会在两个账号之间随机分配：同一个群的消息有的进 `account a` 的会话，有的进 `account b`。今天的配置校验不拦这种情况。

### 2.4 出站：按通道 id 选适配器，多实例时用错机器人

入站侧已经按账号区分（见 §2.6），出站侧有三处只看通道 id：

| 位置 | 做法 | 多实例时的后果 |
|---|---|---|
| 会话渲染：每个会话为**每个**运行中的通道建一个 compositor（`gateway.ts:582`、`:682`，`compose` 在 `:894`）；compositor 只按 `route.channel === adapter.id` 认领路由（`packages/session/src/compositor.ts:427`、`:441`），`CompositorOptions` 没有账号（`compositor.ts:317-327`） | 两个 lark-bot 实例的 compositor 都认领同一条回复路由 | 两者用同一个 operationId 调 outbox（`compositor.ts:470` 的 `base` 含 `routeKey`，`routeKey` 含账号但不含"由谁发"），outbox 按 operationId 去重（`packages/session/src/outbox.ts:87-92`），**谁先到谁发**：约一半的回复由错误的应用发出（该应用不在群里则失败，在群里则以错误的机器人身份出现）；输掉竞争的 compositor 随后用自己的应用去编辑对方发出的卡片（`compositor.ts:551`），必然失败 |
| 输出工具：`HostTools` 的 `adapter(id)` 取第一个同 id 的通道（`gateway.ts:297`），`tier` 同样（`gateway.ts:300`）；接口只有 `adapter(channel)`（`packages/host-mcp/src/tools.ts:83`，用于 `:243`、`:358`） | `send_file`、`ask_choice` 等总是走第一个 lark-bot | 第二个机器人的会话里，工具消息从第一个机器人发出 |
| 宿主 `deliver`、系统回复、回复能力：先按 `(id, account)`，找不到再只按 id（`gateway.ts:707`、`:732`、`:950`） | 账号写错时退到别的机器人 | 静默地以另一个机器人发消息（channel-stamping §10 第 5 项已列为待定） |

lark-bot 适配器自己也不检查：`send` 用构造时的应用发，不看 `route.account`（`adapter.ts:132`、`:212` 只记下启动时的账号）。

### 2.5 "本部署的机器人"靠手写的账号表，且没有按账号区分

- 回声识别：`policy.selfAccounts` 是一组 `${channel}:${channelUserId}`（`config.ts:234`），`IdentityMap.identify` 命中即标 `self`（`packages/session/src/identity.ts:99-102`），键不含账号（`identity.ts:34`）。`IdentifyArgs` 其实带了 `account`（`packages/protocol/src/policy.ts:10-18`），但没有被用到。
- 飞书 open_id 按应用区分（`docs/critique/ops-security.md:56`）。机器人 A 的消息被 A 自己收到时，发送者 id 是 A 在 A 应用下的 open_id；被同群的机器人 B 收到时，是 A 在 **B 应用下**的另一个 open_id。手写表要覆盖 N 个机器人互相看到的 N² 个 id，实际上写不出来。
- lark-bot 适配器自己能认出"自己发的"：`echo = sender open_id === botOpenId`（`channel/lark-bot/src/inbound.ts:214`），但只用来把 `admission` 设为 `observe`（`inbound.ts:240`），不进身份结论。
- "随附身份、回流还原"（POSITIONING §2 第三行，`docs/POSITIONING.md:17`）在守护进程里没有接上：适配器只在 `op.as` 存在时记录（`adapter.ts:504`、`:763`），而守护进程的 compositor 与输出工具都没有传 `as`（`compositor.ts:491` 只在 `this.o.as` 有值时带；`compose` 不设它，`gateway.ts:894-901`）。记录本身是每个适配器私有的内存表（`adapter.ts:164`），兄弟机器人互相看不到。

所以在多机器人部署里，今天无法可靠地区分：(1) 我这个机器人自己的回声；(2) 同部署另一个机器人发的消息；(3) 别家的机器人。

### 2.6 已经按账号区分、不需要改的部分

- 入站去重键是 `(channel, account, id)`（`packages/session/src/ingress.ts:217-218`），注释写明"a platform message id is shared by every bot account that receives it"。
- 会话键由 `conversationRouteKey` 派生，含账号（`packages/session/src/policy.ts:66-72`）；不同机器人的同一个群是不同会话。
- 宿主入站队列按 `(account, channelRef)` 去重（`packages/protocol/src/host.ts:230-232`）；`input.verify` 的结果"一个接收账号一条记录"（`host.ts:398`，写入见 `packages/daemon/src/records.ts:56-77`）。
- `BindingMatch` 有 `account`（`host.ts:34`，匹配见 `packages/session/src/router.ts:621`），watch 来源有 `account`。
- lark-bot 的发送幂等键含账号（`channel/lark-bot/src/render.ts:10-11` `uuidFor(account, …)`）。

### 2.7 控制台：只肯创建一个机器人

`POST /api/bots/lark` 调用 create-lark-bot 时固定传 `--write-env <env 文件>`（`packages/daemon/src/provision.ts:111`），create-lark-bot 总是写 `LARK_APP_ID` / `LARK_APP_SECRET` / `LARK_DOMAIN` 三个固定名字（本机缓存的 create-lark-bot 0.2.2 的 README 第 49 行；配置里钉住的是 v0.2.3，`config.ts:430`，未能离线核对，但 0.2.x 都没有改名选项）。为了不覆盖已有机器人的凭据，任务开始前只要配置里已有一个 `lark-bot` 条目、或这两个变量已设置，就返回 409（`provision.ts:78-86`；`packages/daemon/README.md:179-182` 写明"one lark-bot channel per daemon"）。成功时加入的通道条目不写凭据引用（`provision.ts:213`），结果里的引用是固定名字（`provision.ts:232`，协议注释 `packages/protocol/src/admin.ts:296`）。

## 3. 机制还是策略

按 POSITIONING §2 的判据（`docs/POSITIONING.md:25`）逐项看：

| 能力 | 不同宿主会有不同答案吗 | 归属 |
|---|---|---|
| 每个飞书应用一条长连接、用自己的凭据收发 | 不会：用错凭据或用错机器人发消息，没有哪个宿主想要 | **机制**（通道适配器，POSITIONING §2 第一行） |
| 回复由收到消息的那个机器人发出，`route.account` 必须被尊重 | 不会 | **机制**（投递义务） |
| 一条消息是不是本部署某个机器人发出的、是哪一个 | 不会：这是事实，只有守护进程知道自己发过什么 | **机制**（身份证据与身份表明，`POSITIONING.md:16-17`） |
| 哪个机器人对应哪个 agent、哪些群唤醒谁 | 会 | **策略**：Binding 表的 `match.account`（决定 2） |
| 同部署其他机器人的消息要不要处理、作为上下文还是唤醒 | 会 | **策略**：Binding 规则自选（POSITIONING §2 第三行右栏"哪些 agent 账号可信、多人多 agent 同场时谁的话算数"） |
| 用户在不同机器人下是不是同一个人 | 会 | **策略**：身份映射（决定 3） |

与已有决定的关系：

- **决定 2**：不新增路由机制。"每个机器人一个 agent"写成带 `match.account` 的 Binding 即可；本提案只给无宿主部署提供一个最简写法（§5.5，待拍板）。
- **决定 3**：身份映射格式不变，仍是 `{channel, channelUserId} → principal`。union_id 在同一开发者的多个应用间稳定（`channel/lark-bot/src/inbound.ts:18-23` 的注释），同一开发者的多个机器人共用一条身份条目；不同租户、不同开发者主体下的同一个人是不同的渠道身份，由宿主映射到同一个 principal。
- **决定 4、5**：本提案把"同部署其他机器人发出的"作为来源标记的一部分（§5.4），让模型和宿主看得见，不做硬拦截，与"让来源清楚可见"一致。
- **决定 1、6**：不涉及。每个机器人的会话照常进各自的话题表与宿主队列。
- **channel-stamping**：本提案依赖它的三条规则并与之一致（§5.7）。

## 4. 方案比较

### 4.1 凭据放在哪

| 方案 | 做法 | 优点 | 缺点 |
|---|---|---|---|
| A 按账号推导变量名 | `account: "proj-a"` → 自动读 `LARK_PROJ_A_APP_ID` 等 | 配置短 | 隐式规则：名字从哪来要看文档；账号改名就丢凭据；`proj-a` 与 `proj_a` 撞名；与 mail、bridge、harness 的"显式 `env:NAME`"不一致 |
| **B 条目里显式引用**（推荐） | `config.appId` / `config.appSecret` / `config.domain` 写值或 `env:NAME`，与 mail 一样做 `env:` 替换 | 与其他通道、控制台的凭据规则一致（`console-config.ts:81` 已按此识别）；账号与变量名解耦；顺带修好 `encryptKey` 的 `env:` 不生效 | 每个条目多三行 |
| C 每个机器人一份凭据文件 | 条目写 `credentialsFile` | 与 create-lark-bot `--out` 对上 | 又一种凭据形态；控制台的"只显示 `env:NAME`"规则不适用 |

旧的 `LARK_APP_ID` 等作为**一个**条目的兜底保留（§8）。

### 4.2 出站选哪个实例

| 方案 | 做法 | 问题 |
|---|---|---|
| D1 一个适配器对象服务多个账号 | 接口本来就是 `caps(account)`、`start(ctx.account)` | lark-bot 适配器的全部状态（客户端、卡片降级、上传缓存、去重）都按单应用设计；改造面大，收益只是少几个对象 |
| **D2 每个 `(id, account)` 一个对象，选路时带上账号**（推荐） | compositor、输出工具、`deliver` 都按 `(channel, account)` 选通道 | 需要改三处调用点与两个接口 |

### 4.3 怎样认出"本部署的机器人"

| 方案 | 做法 | 问题 |
|---|---|---|
| E1 手写 `selfAccounts` / `agentAccounts` | 现状 | open_id 按应用区分，N 个机器人要写 N² 个 id，且要先拿到这些 id（§2.5） |
| E2 事件里的应用 id | 若飞书对机器人发送者给出 app_id，直接用 | 未核实飞书事件对其他应用发送的消息给不给 app_id、给不给推送（§10 第 4 项）；不能作为唯一依据 |
| **E3 按"我们发过的消息"认**（推荐） | 守护进程为所有 lark-bot 实例提供**一张共享的已发消息表**（message_id → 发送账号、应用 id、随附身份）；收到消息时查表；自己的回声另有 `botOpenId` 兜底 | 只认得本守护进程发出的消息。这正是"本部署"的定义；同一应用被别的程序用来发的消息本来就不是本部署 agent 发的 |

E3 是 POSITIONING §2 第三行"agent 发出的每条消息随附自己的身份，回流时还原"的落实，只是把记录从每个适配器私有改成守护进程内共享、可持久。

### 4.4 同部署其他机器人的消息算什么

| 方案 | 结论 | 问题 |
|---|---|---|
| F1 一律 `self` | 与自己的回声一样默认丢弃 | 团队机器人在群里的回答，个人机器人的 agent 连上下文都看不到；也区分不了"我的回声"和"兄弟的消息" |
| F2 一律当作普通 agent 账号（不标 `self`） | 采信随附身份，按 Binding 正常处理 | 违背 `Origin.self` 的定义（"Message produced by this deployment's own agents, echoed back by the channel"，`packages/protocol/src/inbound.ts:82-83`）与 POSITIONING §4 第 3 步（`POSITIONING.md:77`："本部署 agent 自己发出的消息回流时标 `self`，默认丢弃"）；两个机器人互相 @ 时，默认表之外的规则可能形成回声循环 |
| **F3 都标 `self`，另标发送账号；规则可单独放行兄弟消息**（推荐） | 身份结论与 agent 账号相同（`kind: agent`，采信随附身份），路由上默认丢弃；Binding 可用新字段 `includeSiblings` 只放行"同部署其他机器人"，不放行自己的回声 | 协议多两个可选字段（§6） |

## 5. 推荐设计

### 5.1 通道条目

```jsonc
"channels": [
  // 旧写法，不变：凭据来自 LARK_APP_ID / LARK_APP_SECRET / LARK_DOMAIN
  { "type": "lark-bot" },

  // 新写法：每个实例显式引用自己的凭据
  { "type": "lark-bot", "account": "proj-a",
    "config": { "appId": "env:LARK_PROJ_A_APP_ID", "appSecret": "env:LARK_PROJ_A_APP_SECRET", "domain": "env:LARK_PROJ_A_DOMAIN" } },
  { "type": "lark-bot", "account": "brand-intl",
    "config": { "appId": "cli_xxx", "appSecret": "env:LARK_INTL_SECRET", "domain": "lark", "encryptKey": "env:LARK_INTL_ENCRYPT_KEY" } }
]
```

规则（全部在 `resolveChannel` 的 `lark-bot` 分支，`config.ts:1017-1021`）：

1. `config` 整体先做 `substituteEnv`（与 mail 相同，`config.ts:1023-1024`），缺失的变量报错并点名、不带值。
2. **显式优先**：`config.appId` 与 `config.appSecret` 都给出时，用它们；`config.domain` 缺省为 `feishu`，取值只能是 `feishu` / `lark`。只给其中一个是错误。
3. **兜底只给一个条目**：两者都没给时，读 `LARK_APP_ID` / `LARK_APP_SECRET` / `LARK_DOMAIN`（今天的行为）。这样的条目至多一个，否则报错："lark-bot channels X and Y both read LARK_APP_ID; give each its own config.appId / config.appSecret"。
4. **一个应用只跑一个实例**：解析后两个条目的 `appId` 相同（且 `domain` 相同）即报错，原因写明 §2.3（事件会被分走）。比较的是解析后的值，错误信息只点名条目，不打印 appId 以外的值。
5. **`(type, account)` 唯一**：同为 `lark-bot` 的条目账号不得重复（channel-stamping §5.2 的"同一归属、同 `(id, account)` 重复 → failed"，这里在配置阶段就拒绝）。
6. **账号名**：多于一个 `lark-bot` 条目时，账号必须匹配 `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`（与实例名同一规则，`config.ts:125`）。账号进入 `routeKey`（`packages/protocol/src/common.ts:19-21`，以 `:` 分隔）和会话键，含 `:` 会让键有歧义。只有一个条目时不强制（不破坏现有配置），但出现 `:` 时告警。
7. `buildChannel` 改为 `new LarkBotAdapter({ ...resolvedConfig })`，不再用 `ch.lark` 覆盖（`gateway.ts:1251`）；`ResolvedChannel` 的 `lark` 字段并入解析后的 `config`（`config.ts:480`）。

账号名就是机器人在 agents-io 里的名字：出现在 `aio status` 的通道列表（`gateway.ts:452`）、`ReplyRoute.account`、会话键、Binding 的 `match.account`、watch 的 `source.account`、`input.verify` 的记录里。建议用"项目 / agent / 品牌"之类稳定的名字；改账号名等于换了一个机器人（旧会话键不再命中），在文档里写明。

### 5.2 出站：按 `(channel, account)` 选实例

1. **Compositor**：`CompositorOptions` 加 `account?: string`；设了时只认领 `route.channel === adapter.id && route.account === account` 的路由（`compositor.ts:427`、`:441`）。不设时行为不变（库用户、单账号）。守护进程 `compose` 传入通道的账号（`gateway.ts:894`，调用点 `:582`、`:682`）。
2. **输出工具**：`HostToolsOptions.adapter(channel)` 改为 `adapter(route: ReplyRoute)`（或加可选的 `account` 参数），`tier` 同理（`packages/host-mcp/src/tools.ts:83`、`:243`、`:358`；守护进程侧 `gateway.ts:297`、`:300`）。
3. **退路收窄**：`deliver`、`systemReply`、`replyCaps` 在 `(id, account)` 未命中时，**只有当该 id 恰好只有一个运行中的账号**才退回按 id 匹配（`gateway.ts:707`、`:732`、`:950`）。单机器人部署行为不变（宿主写了 `account: "default"` 而实际账号是别的名字时照常发出）；多机器人时返回 `unknown_channel`，消息写明可用的 `(id, account)`。这回答了 channel-stamping §10 第 5 项在多账号情形下的部分。
4. **适配器自检**：lark-bot 的 `send` / `edit` / `finalize` / `retract` 在 `route.account !== this.account` 时抛不可重试的错误（`LarkApiError`），作为纵深防御：上面三处任何一处漏改，都会变成显性的投递失败，而不是以错误的机器人发出。

### 5.3 入站：每个实例一条长连接，其余不变

- 每个 `LarkBotAdapter` 对象各自 `discoverBot`（`adapter.ts:244`）、各自建长连接（`adapter.ts:224`）、各自的去重窗口与卡片降级状态。不需要改。
- 同一条群消息被两个机器人收到（例如 B 有"获取群组中所有消息"权限），会变成两个信封、两条输入、两条 `input.verify` 记录，各进各自账号的会话（§2.6）。默认表下，被 @ 的那个机器人的信封 `admission` 是 `dispatch`，另一个是 `observe`（`inbound.ts:240`），所以默认只有被 @ 的机器人回答，另一个只记入上下文。
- `mentions: ["self"]` 的判断（`router.ts:612-615`）对飞书依赖 `admission` 提示，而提示本来就是按接收机器人算的，多机器人下天然正确。它的另一支"@ 了任一 `selfAccounts`"是部署级的，飞书信封不填 `mentions`，目前不受影响；本提案把这一支也改为只看接收账号自己的机器人（§5.4 第 4 点），避免将来出错。

### 5.4 本部署机器人的识别（E3 + F3）

**(1) 共享的已发消息表。** 守护进程在 SQLite 日志库里建一张表，作为所有 lark-bot 实例共用的发送记录（lark-bot 包里扩展现有的 `DeclaredSenderStore`，`channel/lark-bot/src/store.ts`）：

```ts
interface SentRecord { account: string; appId: string; as?: string }
interface DeclaredSenderStore {
  set(providerMessageId: string, as: string): void | Promise<void>;            // 现有
  get(providerMessageId: string): string | undefined | Promise<string | undefined>; // 现有
  record?(providerMessageId: string, r: SentRecord): void | Promise<void>;     // 新增
  lookup?(providerMessageId: string): SentRecord | undefined | Promise<SentRecord | undefined>; // 新增
}
```

- 适配器**每发出一条消息都记录**（含拆分出的附件与续页），不再只在 `op.as` 存在时记录（`adapter.ts:504`、`:763`、`:767`、`:823`）。飞书 message_id 全局唯一，表以它为键。
- 保留期按时间（建议 30 天）与条数双重上限，守护进程定期清理。不记录消息内容。
- 守护进程构造每个 lark-bot 适配器时传入同一个 store（`gateway.ts:1251` 的第二个参数，`LarkBotOptions.store`，`adapter.ts:62`）。库用户不传时仍是每个对象私有的内存表，行为与今天相同。

**(2) 适配器把本部署机器人归一为应用 id。** 收到发送者是应用的消息（`adapter.ts:300`）时：

- 查表命中 → 发送者 `channelUserId` 写成 `app:<appId>`（发出它的那个应用），`declared` 取记录里的 `as`。
- 未命中但 `open_id === botOpenId`（自己的回声，例如守护进程重启前、表启用前发出的）→ `app:<自己的 appId>`。
- 其他情况（别家机器人、同应用被其他程序使用）→ 保持今天的 `senderId`（`inbound.ts:24`）。

`app:<appId>` 在所有应用的视角下相同，正好解决 §2.5 的 N² 问题。这是适配器从**它控制的元数据**（守护进程自己的发送记录、平台签名的发送者 id）得出的结论，符合 `declared` 字段的约束（`inbound.ts:36-40`）。

**(3) 守护进程自动登记本部署的机器人。** 网关启动通道后，把每个 lark-bot 实例的 `lark-bot:app:<appId>` 加入 `selfAccounts`，并记下 `app id → account`。`policy.selfAccounts` 里手写的条目照旧生效（兼容），不再需要为多机器人手写任何 id。

**(4) 身份结论带发送账号。** `IdentityRules` 增加 `selfAccountOf?: (key) => string | undefined`；`identify` 命中 self 时返回 `selfAccount`（发出它的账号），`Ingress` 把它写进 `Origin.selfAccount`。由此：

- `self && selfAccount === env.account`：**自己的回声**。默认丢弃（今天的语义）。
- `self && selfAccount !== env.account`：**同部署其他机器人**（兄弟）。`kind: agent`，`declared` 为对方随附的身份（若有），默认同样丢弃。
- `addressesSelf` 的 `mentions` 一支改为只认接收账号自己的机器人（`router.ts:613`）。

**(5) 规则可单独放行兄弟消息。** `BindingMatch` 加 `includeSiblings?: boolean`（`router.ts:619` 的 `if (origin.self && !m.includeSelf) return false` 改为：自己的回声需要 `includeSelf`，兄弟消息需要 `includeSelf` 或 `includeSiblings`）。watch 的 filter 同步加同名字段。

默认表是否放行兄弟消息作为上下文，是默认策略的选择，列入 §10 第 2 项。推荐只给 `default:observe-<kind>`（`on: context`，`router.ts:724`）加 `includeSiblings: true`：团队机器人在群里的回答进入个人机器人会话的上下文，但永远不会唤醒它，没有回声循环的风险。

**(6) 随附身份（可选，跟进项）。** 守护进程今天不给发送传 `as`（§2.5）。有了共享表，自己的回声与兄弟消息不依赖 `as` 也能识别；`as` 只决定 `Origin.declared` 能否说出"是哪个 agent / 哪个会话"发的。建议跟进：compositor 与输出工具传 `as = "aio:<agent>"`，网关的 `isSelfDeclared` 认 `aio:` 前缀。不阻塞本提案。

### 5.5 无宿主时"每个机器人一个 agent"的写法（待拍板）

有宿主或写了 `bindings` 的部署，用 `match.account` 即可：

```jsonc
"bindings": [
  { "id": "a-dm",    "match": { "channel": "lark-bot", "account": "proj-a", "conversationKind": "dm", "labels": ["owner"] }, "on": "dispatch", "agent": "proj-a", "session": "topic" },
  { "id": "a-group", "match": { "channel": "lark-bot", "account": "proj-a", "conversationKind": "group", "labels": ["owner"], "mentions": ["self"] }, "on": "dispatch", "agent": "proj-a", "session": "per-thread" }
]
```

没写 `bindings` 时，默认表（`router.ts:709-727`）把所有机器人的输入都交给 `defaultAgent`。为了让"按 agent 分机器人"在无宿主时开箱可用，可以允许通道条目写 `"agent": "<名字>"`：默认表为该账号生成同样的三类规则（私聊、群里 @、群里观察）并指向这个 agent，其余账号仍用 `defaultAgent`。它只影响默认表；同时写了 `bindings` 时报错，避免两处各说一半。这是与 `owners` 同性质的"本地配置给出最简策略"（决定 3 最后一条），不是新的路由机制。

### 5.6 控制台：创建第二个机器人

`POST /api/bots/lark` 的 `account` 决定变量名与条目：

| 账号 | 写入的变量 | 加入的条目 |
|---|---|---|
| `default`（不传） | `LARK_APP_ID` / `LARK_APP_SECRET` / `LARK_DOMAIN`（与今天相同） | `{ "type": "lark-bot", "config": { "appId": "env:LARK_APP_ID", "appSecret": "env:LARK_APP_SECRET", "domain": "env:LARK_DOMAIN" } }` |
| 其他，例如 `proj-a` | `LARK_PROJ_A_APP_ID` / `LARK_PROJ_A_APP_SECRET` / `LARK_PROJ_A_DOMAIN`（账号大写，非字母数字换成 `_`） | `{ "type": "lark-bot", "account": "proj-a", "config": { …同上，引用这三个名字 } }` |

新建的条目总是写显式引用，所以控制台创建的机器人从不依赖兜底；变量名只是控制台的命名约定，守护进程加载配置时不推导名字（§4.1 方案 B）。

**create-lark-bot 需要能写自定义变量名。** 0.2.x 的 `--write-env` 只写固定名字（§2.7）。两种做法：

| 做法 | 说明 |
|---|---|
| **G1 给 create-lark-bot 加 `--env-prefix <P>`**（推荐） | 写 `<P>APP_ID` / `<P>APP_SECRET` / `<P>DOMAIN`；守护进程对非 `default` 账号传 `--env-prefix LARK_PROJ_A_`。凭据仍然只经过 create-lark-bot 写进 env 文件，守护进程从不经手密钥，保持 `provision.ts:16-18` 的约定。需要发布新版本并更新钉住的版本（`config.ts:430`）。部署方自定义的 `larkBotCommand` 不支持该参数时，任务以 create-lark-bot 的报错失败，错误信息提示升级。 |
| G2 守护进程自己写 env 文件 | 用 `--out <任务私有目录>/app.json` 取凭据，守护进程读出后以原子写入方式改 env 文件，再删除临时文件 | 不依赖上游，但守护进程要经手并改写 env 文件里的密钥，需要新增一个可靠的 env 文件编辑器（保留注释与其他行、0600） |

冲突检查（替换 `provision.ts:78-86`）：

- 配置里已有同账号的 `lark-bot` 条目 → 409。
- 目标变量名任一已设置（env 文件或进程环境，`ConfigStore.defined`，`console-config.ts:221`）→ 409，点名变量。
- 新账号的变量名与已有条目引用的变量名冲突（例如 `proj-a` 与 `proj_a` 映射到同一前缀）→ 409。
- 账号不合 §5.1 第 6 条 → 400。
- "同一时间一个任务"不变（`provision.ts:72-73`）：两个任务都在等扫码时，用户分不清扫的是哪个。
- `owner`：照旧把已验证的 `lark-bot:<union_id>` 加进 `policy.owners`（`provision.ts:206-218`）。同一开发者主体下的多个机器人得到同一个 union_id，去重后只有一条；不同主体下得到不同的 union_id，各加一条。

结果里的 `env` 换成该账号实际引用的名字（`provision.ts:232`，协议注释 `admin.ts:296` 同步改）。`packages/daemon/README.md` 的 Console API 一节（`:171-182`）改写"one lark-bot channel per daemon"一句。

### 5.7 与 channel-stamping 的一致性

- **"一个通道 id 只属于一种适配器"**（channel-stamping §5.2）：所有 `lark-bot` 条目归属同一种适配器（条目 `type`），多个条目只是账号不同，允许；§5.1 第 5 条在配置阶段先拒绝 `(id, account)` 重复。
- **来源绑定**（channel-stamping §5.1）：每个实例的 `emit` 闭包盖上它自己的 `(channel, account)`，一个实例不能以另一个机器人的账号提交信封；这让 `match.account` 与 `selfAccount` 的比较可信。本提案不要求 channel-stamping 先落地，但两者一起落地时，§5.4 的兄弟识别才不会被不合规的 bridge 伪造（bridge 冒用 `lark-bot` id 会被 channel-stamping 拒绝）。
- **证据上限**：channel-stamping 的条目级 `evidence` 字段按条目生效，每个 lark-bot 实例各自计算。
- **身份键不含账号**（channel-stamping §10 第 4 项）：本提案**不改**。人的身份用 union_id 时跨应用稳定，不需要账号；只拿得到 open_id 时，不同应用下的 open_id 是不同字符串，不会碰撞，只是需要为每个机器人写一条（这是平台的作用域，不是 agents-io 的键设计造成的）。机器人自己则归一为 `app:<appId>`（§5.4），也不需要账号。
- 引用核对时发现：channel-stamping 文中的 `gateway.ts:895-898`（emit 闭包）在当前树上已移到 `gateway.ts:926-929`，落地前应刷新该文的行号。

## 6. 对协议、schema、配置的影响

| 位置 | 变化 | 兼容性 |
|---|---|---|
| `packages/daemon/src/config.ts` | `lark-bot` 条目的 `config` 做 `env:` 替换；`appId`/`appSecret`/`domain` 显式优先，旧变量兜底至多一个条目；重复应用、重复账号、账号名检查；可选 `agent`（§5.5，待拍板）；`ResolvedChannel.lark` 并入 `config` | 旧配置（单条目、无显式凭据）行为不变 |
| `packages/session/src/compositor.ts` | `CompositorOptions.account?` | 可选 |
| `packages/host-mcp/src/tools.ts` | `adapter` / `tier` 按路由（含账号）查 | 包内接口；守护进程同步改 |
| `packages/session/src/identity.ts`、`router.ts` | `IdentityRules.selfAccountOf?`；`Identity.selfAccount?`；`addressesSelf` 按接收账号；`matches` 处理 `includeSiblings` | 可选 |
| `packages/protocol/src/inbound.ts` | `Origin.selfAccount?: string` | 纯增量 |
| `packages/protocol/src/host.ts` | `BindingMatch.includeSiblings?`；watch filter 同名字段；`VerifiedInput.selfAccount?`（`host.ts:383` 旁） | 纯增量；旧宿主忽略 |
| `packages/protocol/src/admin.ts` | `AdminLarkBotRequest.account` 注释写明命名规则；结果 `env` 注释改为"该账号的引用" | 形状不变 |
| `channel/lark-bot` | `DeclaredSenderStore.record?/lookup?`；每次发送都记录；发送者归一为 `app:<appId>`；`send` 等检查 `route.account` | store 新方法可选；`channelUserId` 对本部署机器人的取值改变（§8） |
| 守护进程 SQLite | 新表：已发消息（message_id、账号、应用 id、可选 `as`、时间） | 新表，无迁移 |
| create-lark-bot | `--env-prefix`（G1） | 上游新版本 |
| 文档 | `packages/daemon/README.md` Console API 一节；`docs/CHANNELS.md:68` 关于 `selfAccounts` 的说明改为"自动登记，手写仍可用" | — |

不涉及：`InboundEnvelope` 的形状、`ChannelAdapter` 接口、身份映射格式、Binding 表的其他字段、宿主入站队列、决定 1–6 的任何条款。

## 7. 测试

`packages/daemon/test/config.test.ts`：
- 单个无显式凭据的条目读 `LARK_APP_*`（回归）；两个都无显式凭据 → 报错并点名两个条目。
- 显式 `env:` 引用被替换；缺变量报错点名变量、不含值；只给 `appId` 不给 `appSecret` → 报错。
- `config.encryptKey: "env:X"` 解析为变量值（修复 §2.2 的不一致）。
- 两个条目解析出同一 `appId` → 报错；同账号两个条目 → 报错；多条目时账号含 `:` → 报错。

`packages/session/test/compositor.test.ts`：两个同 id、不同账号的假适配器各一个 compositor，回复路由的账号是 b → 只有 b 发送和编辑；a 的 `send` 调用次数为 0。不设 `account` 时行为不变。

`packages/daemon/test/gateway.test.ts`（两个 `FakeChannel('lark-bot')`，账号 `a`、`b`）：
- 从 b 进来的私聊，回复只经 b 发出；输出工具 `send_file` 只经 b。
- 宿主 `deliver` 到 `account: 'c'` → `unknown_channel`；只有一个账号运行时 `deliver` 到错误账号仍退回（回归）。
- 同一 message id 从 a、b 各进来一次 → 两条输入、`input.verify` 两条记录、两个会话键。
- Binding `match.account: 'a'` 只命中 a 的输入。

`channel/lark-bot/test`：
- 发送（含附件、续页）每一部分都写入 store；`route.account` 与实例不符 → 抛错，不调用 SDK。
- 共享 store：实例 A 发出的消息被实例 B 收到 → `channelUserId === 'app:<A 的 appId>'`、`declared` 为 A 的 `as`；A 自己收到 → `app:<A 的 appId>`；store 未命中但 `open_id === botOpenId` → 同样归一；别的应用 → 原 id。

`packages/session/test/identity.test.ts`、`router.test.ts`：
- 自动登记的 `app:` 键命中 self，`selfAccount` 正确；手写 `selfAccounts` 仍生效。
- 自己的回声：`includeSiblings` 不放行，`includeSelf` 放行；兄弟消息：两者都放行；都不写时都丢弃。
- `addressesSelf`：@ 了兄弟机器人不算 @ 自己。

`packages/daemon/test/provision.test.ts`（用假的 create-lark-bot）：
- 已有 `default` 机器人时，`account: 'proj-a'` 的任务被接受，参数含 `--env-prefix LARK_PROJ_A_`；成功后加入带显式引用的条目，结果 `env` 是新名字。
- 同账号已有条目、目标变量已设置、前缀冲突 → 409；非法账号 → 400。
- 不传 `account` 且没有任何机器人：与今天一致，但条目写显式引用。

live（`channel/lark-bot/test/live.test.ts` 旁，需两个真实应用，默认跳过）：两个机器人在同一个群，各自 @ 后只有被 @ 的那个回答；核实 §10 第 4 项的平台行为。

## 8. 迁移

- **单机器人、旧写法**：不需要任何改动。条目无显式凭据 → 读 `LARK_APP_*`，账号 `default`。
- **从一个加到多个**：旧条目可以保持兜底写法，新条目必须写显式引用；也可以把旧条目改成 `"appId": "env:LARK_APP_ID"` 这样的显式写法（结果相同）。控制台创建的第二个机器人自动按显式写法加入。
- **本部署机器人的 `channelUserId` 变化**：经守护进程发出的消息回流时，发送者从 open_id 变为 `app:<appId>`。影响面：手写在 `selfAccounts` / `agentAccounts` / `identities` / Binding `senders` 里的本部署机器人 open_id。`selfAccounts` 由自动登记替代，不会因此失效；其余三处若写了本部署机器人的 open_id，升级说明里点名提示改为 `app:<appId>`。启动时若发现这些表里的某个 id 等于某个运行中实例的 `botOpenId`，输出一条告警。
- 宿主侧：`Origin.selfAccount`、`VerifiedInput.selfAccount`、`includeSiblings` 都是新增可选字段，不使用的宿主不受影响。
- create-lark-bot：先发布带 `--env-prefix` 的版本，再更新守护进程钉住的版本；在此之前控制台对非 `default` 账号返回 400，提示手工创建（或采用 G2）。

## 9. 不做

- **不做一个适配器对象服务多个应用**（§4.2 D1）。
- **不做跨机器人的会话合并**：同一个人分别私聊两个机器人是两个会话；要合并用 Binding 的 `session: { key }`，属于策略。
- **不做同一应用的多进程/多守护进程协调**：同一应用被两个守护进程同时使用，事件会被分走（§2.3），这是部署错误，只在文档里写明。
- **不改身份键**（§5.7）。
- **不替宿主决定兄弟消息的处理**：机制只给出"是兄弟发的、是哪个账号、随附了什么身份"，默认表的取舍在 §10 第 2 项。

## 10. 待拍板

1. **凭据写法**：采用条目内显式 `env:` 引用（§4.1 B），旧变量只作为至多一个条目的兜底。是否接受。
2. **兄弟消息的语义（F3）**：同部署其他机器人发的消息标 `self` 并带 `selfAccount`，身份上与 agent 账号相同（采信随附身份），路由上默认丢弃、可用 `includeSiblings` 放行；默认表是否给 `observe-<kind>` 加 `includeSiblings: true`（推荐加，只作上下文、不唤醒）。若希望兄弟机器人完全按普通 agent 账号处理（F2），需要先修订 POSITIONING §4 第 3 步与 `Origin.self` 的定义。
3. **create-lark-bot 的改法**：G1（上游加 `--env-prefix`，推荐）还是 G2（守护进程自己写 env 文件）。
4. **平台行为待核实**：飞书是否把一个机器人发的群消息推送给同群的其他机器人、是否推送给发送者自己，以及事件里是否带发送应用的 app_id。设计在两种情况下都成立（不推送时兄弟识别只是用不上；带 app_id 时可在表未命中时也归一），但默认表的取舍（第 2 项）的实际效果取决于它，需在 live 测试里确认。
5. **通道条目上的 `agent`**（§5.5）：是否为无宿主部署提供这一最简写法。
6. **随附身份 `as` 的格式与是否本次一起做**（§5.4 第 6 点）：推荐 `aio:<agent>`，作为跟进项。
7. **出站退路**：多账号时不再按 id 退回（§5.2 第 3 点）。这同时部分回答 channel-stamping §10 第 5 项；单账号时是否也取消退路，留给那一项决定。
