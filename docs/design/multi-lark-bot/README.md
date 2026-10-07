# 一个守护进程跑多个飞书机器人（多个 lark-bot 通道实例）

> 状态：第一阶段已采纳（2026-10-07，记入 `docs/design/locus/DECISIONS.md` 决定 8，§11 第 1–3 项按推荐，第 4 项暂不做）；第二阶段等 live 核实。
> 依据：`docs/POSITIONING.md` §2（机制与策略的判据）、§4（多 agent 同场的作者认定）；`docs/design/locus/DECISIONS.md` 决定 1–6；`docs/critique/ops-security.md` §2（飞书 ID 有作用域）；待定提案 `docs/design/channel-stamping`（来源盖章、"一个通道 id 只属于一种适配器"）。
> 代码：行号按 `f8e51fd` 加当前工作区核实。`packages/daemon/src/config.ts`、`packages/daemon/src/records.ts`、`packages/session/src/router.ts` 在工作区里有未提交的改动（会话启动的实现正在进行），这三个文件的行号以写作时的工作区为准，落地前需再刷新；引用时同时给出函数名。

## 1. 一句话

**让一个 aio 守护进程同时运行多个 `lark-bot` 通道实例：每个实例是一个飞书应用（机器人），在通道条目里用 `env:NAME` 引用自己的凭据，用 `account` 区分；回复、工具消息和宿主投递都由收到消息的那个机器人发出。** 这是**第一阶段**，它修的是今天就存在的错误（两个条目拿到同一套凭据、出站选错机器人、`lark-bot` 的 `env:` 引用不生效），自身完整，不依赖任何未核实的平台行为。

"认出同部署的其他机器人"（共享的已发消息表、`app:<appId>`、`selfAccount`、`includeSiblings`）是**第二阶段**，前提是 live 测试证实飞书会把一个机器人发的群消息推送给同群的其他机器人（§11 第 5 项）。证实之前不做；若飞书不推送，第二阶段整体取消，第一阶段不受影响。

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
- `resolveChannel`（`config.ts:1071`）对每个 `lark-bot` 条目都读同一组变量（`lark-bot` 分支 `config.ts:1074-1079`），解析结果带 `lark: { appId, appSecret, domain }`（`ResolvedChannel`，`config.ts:515`）。所以配两个 `lark-bot` 条目时，两者拿到的是**同一个应用**的凭据。
- 构造适配器时 `new LarkBotAdapter({ ...(ch.config ?? {}), ...ch.lark })`（`buildChannel`，`packages/daemon/src/gateway.ts:1252`）：`ch.lark` 覆盖 `config` 里的同名字段。即使有人在 `config.appId`/`config.appSecret` 里写了别的应用，也会被静默替换。
- `mail`、`bridge` 的 `config`/`env` 会做 `env:NAME` 替换（`config.ts:1080-1089`，`substituteEnv` 在 `:1094`），`lark-bot` 的 `config` **不做**。而控制台已经把 `channels[i].config.appSecret` / `encryptKey` / `verificationToken` 当作凭据字段，要求写成 `env:NAME`（`packages/daemon/src/console-config.ts:81`）。结果是：按控制台的要求写 `"encryptKey": "env:LARK_ENCRYPT_KEY"`，适配器收到的是字面量字符串 `env:LARK_ENCRYPT_KEY`。这是现存的错误，第一阶段顺带修掉（§5.1）。

### 2.3 同一应用开两条长连接会分走事件

lark-bot 每个适配器对象在 `start` 里用自己的凭据建一条 WebSocket 长连接（`channel/lark-bot/src/adapter.ts:224`），天然支持"每个应用一条连接"。但按飞书长连接模式的规则，同一应用有多条连接时，每个事件只推给其中一条（集群模式，不广播）。今天两个 `lark-bot` 条目会得到同一应用的凭据（§2.2），事件会在两个账号之间随机分配：同一个群的消息有的进 `account a` 的会话，有的进 `account b`。今天的配置校验不拦这种情况。

### 2.4 出站：按通道 id 选适配器，多实例时用错机器人

入站侧已经按账号区分（§2.6），出站侧有三处只看通道 id：

| 位置 | 做法 | 多实例时的后果 |
|---|---|---|
| 会话渲染：每个会话为**每个**运行中的通道建一个 compositor（`gateway.ts:583`、`:683`，`compose` 在 `:895`）；compositor 只按 `route.channel === adapter.id` 认领路由，新轮次在 `track`（`packages/session/src/compositor.ts:441`），进程重启后接续未完成的轮次在 `restore`（`compositor.ts:427`）；`CompositorOptions` 没有账号（`compositor.ts:317-327`） | 两个 lark-bot 实例的 compositor 都认领同一条回复路由 | 两者用同一个 operationId 调 outbox（`compositor.ts:469-471` 的 `base` 含 `routeKey`，`routeKey` 含账号但不含"由谁发"），outbox 按 operationId 去重（`packages/session/src/outbox.ts:86-93`），**谁先到谁发**：约一半的回复由错误的应用发出（该应用不在群里则失败，在群里则以错误的机器人身份出现）；输掉竞争的 compositor 随后用自己的应用去编辑对方发出的卡片（`compositor.ts:551`），必然失败。重启后 `restore` 也一样：两个实例都按日志里的 `render.anchor` 接续同一张卡片 |
| 输出工具：`HostTools` 的 `adapter(id)` 取第一个同 id 的通道（`gateway.ts:298`），`tier` 同样（`gateway.ts:301`）；接口只有 `adapter(channel)`（`packages/host-mcp/src/tools.ts:83`，用于 `:243`、`:358`） | `send_file`、`ask_choice` 等总是走第一个 lark-bot | 第二个机器人的会话里，工具消息从第一个机器人发出 |
| 宿主 `deliver`（`gateway.ts:708`）、系统回复（`systemReply`，`gateway.ts:733`）、回复能力（`replyCaps`，`gateway.ts:951`）：先按 `(id, account)`，找不到再只按 id | 账号写错时退到别的机器人 | 静默地以另一个机器人发消息（channel-stamping §10 第 5 项已列为待定） |

lark-bot 适配器自己也不检查：`send` 用构造时的应用发，不看 `route.account`（`adapter.ts:132` 的 `account` 只在 `start` 时记下，`adapter.ts:212`）。

### 2.5 "本部署的机器人"靠手写的账号表（第二阶段要解决的问题）

- 回声识别：`policy.selfAccounts` 是一组 `${channel}:${channelUserId}`（`config.ts:257`），`IdentityMap.identify` 命中即标 `self`（`packages/session/src/identity.ts:100-102`），键不含账号（`identity.ts:34`）。`IdentifyArgs` 其实带了 `account`（`packages/protocol/src/policy.ts:10-18`），但没有被用到。
- 飞书 open_id 按应用区分（`docs/critique/ops-security.md:56`）。机器人 A 的消息被 A 自己收到时，发送者 id 是 A 在 A 应用下的 open_id；**如果**同群的机器人 B 也收到（是否推送未核实，§11 第 5 项），是 A 在 **B 应用下**的另一个 open_id。手写表要覆盖 N 个机器人互相看到的 N² 个 id，实际上写不出来。
- lark-bot 适配器自己能认出"自己发的"：`echo = sender open_id === botOpenId`（`channel/lark-bot/src/inbound.ts:214`），但只用来把 `admission` 设为 `observe`（`inbound.ts:240`），不进身份结论。适配器对 `sender_type === 'app'` 的消息已经会查随附身份（`adapter.ts:300-303`、`inbound.ts:213-215`）。
- "随附身份、回流还原"（POSITIONING §2 第三行，`docs/POSITIONING.md:16`）在守护进程里没有接上：适配器只在 `op.as` 存在时记录（`adapter.ts:504`、`:763`），而守护进程的 compositor 与输出工具都没有传 `as`（`compositor.ts:491` 只在 `this.o.as` 有值时带；`compose` 不设它，`gateway.ts:895-902`）。记录本身是每个适配器私有的内存表（`adapter.ts:164`），兄弟机器人互相看不到。

第一阶段之后，多机器人部署里"自己的回声"仍按今天的方式处理（每个实例各自用 `botOpenId` 把它标成 `observe`，`selfAccounts` 可手写）；同部署其他机器人的消息与别家机器人的消息一样处理（§5.7）。这与今天"每个机器人一个守护进程"时的结果相同，不是第一阶段引入的退化。

### 2.6 已经按账号区分、不需要改的部分

- 入站去重键是 `(channel, account, id)`（`packages/session/src/ingress.ts:218-219`），注释写明"a platform message id is shared by every bot account that receives it"。
- 会话键由 `conversationRouteKey` 派生，含账号（`packages/session/src/policy.ts:66-73`）；不同机器人的同一个群是不同会话。
- 宿主入站队列按 `(account, channelRef)` 去重（`packages/protocol/src/host.ts:282-284`）；`input.verify` 的结果"一个接收账号一条记录"（`host.ts:456`，写入见 `packages/daemon/src/records.ts:60-79`）。
- `BindingMatch` 有 `account`（`host.ts:34`，匹配见 `router.ts` 的 `matches`，`packages/session/src/router.ts:683`），watch 来源有 `account`。
- lark-bot 的发送幂等键含账号（`channel/lark-bot/src/render.ts:10-11` `uuidFor(account, …)`）。

### 2.7 控制台：只肯创建一个机器人

`POST /api/bots/lark` 调用 create-lark-bot 时固定传 `--write-env <env 文件>`（`packages/daemon/src/provision.ts:111`），create-lark-bot 总是写 `LARK_APP_ID` / `LARK_APP_SECRET` / `LARK_DOMAIN` 三个固定名字（本机缓存的 create-lark-bot 0.2.2 的 README 第 49 行；配置里钉住的是 v0.2.3，`config.ts:465`，未能离线核对，但 0.2.x 都没有改名选项）。为了不覆盖已有机器人的凭据，任务开始前只要配置里已有一个 `lark-bot` 条目、或这两个变量已设置，就返回 409（`provision.ts:78-86`；`packages/daemon/README.md:171-182` 写明"one lark-bot channel per daemon"）。成功时加入的通道条目不写凭据引用（`provision.ts:213`），结果里的引用是固定名字（`provision.ts:232`，协议注释 `packages/protocol/src/admin.ts:296`）。

另有两个今天就有的时序问题，多机器人时会变得常见：

- 冲突检查只在任务开始时做（`provision.ts:78-86`）。任务可能停在"等扫码"几分钟，其间控制台 `PUT /api/config` 可以改配置；`succeed` 写配置时只检查"有没有任何 `lark-bot` 条目"（`provision.ts:213`），不复查其他冲突。
- `succeed` 用 `ConfigStore.update` 写配置（`console-config.ts:290-295`），它不跑启动校验；`PUT` 会跑（`console-config.ts:252-289`，`check` 里调 `resolveConfig`）。所以开通任务写进去的配置若不合法，要到下次启动才暴露。

## 3. 机制还是策略

按 POSITIONING §2 的判据（`docs/POSITIONING.md:24`）逐项看：

| 能力 | 不同宿主会有不同答案吗 | 归属 | 阶段 |
|---|---|---|---|
| 每个飞书应用一条长连接、用自己的凭据收发 | 不会：用错凭据或用错机器人发消息，没有哪个宿主想要 | **机制**（通道适配器，POSITIONING §2 第一行） | 一 |
| 回复由收到消息的那个机器人发出，`route.account` 必须被尊重 | 不会 | **机制**（投递义务） | 一 |
| 哪个机器人对应哪个 agent、哪些群唤醒谁 | 会 | **策略**：Binding 表的 `match.account`（决定 2） | 一（已有） |
| 用户在不同机器人下是不是同一个人 | 会 | **策略**：身份映射（决定 3） | 一（已有） |
| 一条消息是不是本部署某个机器人发出的、是哪一个 | 不会：这是事实，只有守护进程知道自己发过什么 | **机制**（身份证据与身份表明，`POSITIONING.md:15-16`） | 二 |
| 同部署其他机器人的消息要不要处理、作为上下文还是唤醒 | 会 | **策略**：Binding 规则自选（POSITIONING §2 第三行右栏） | 二 |

与已有决定的关系：

- **决定 2**：不新增路由机制。"每个机器人一个 agent"写成带 `match.account` 的 Binding 即可；本提案只给无宿主部署提供一个最简写法（§5.4，待拍板）。
- **决定 3**：身份映射格式不变，仍是 `{channel, channelUserId} → principal`。union_id 在同一开发者的多个应用间稳定（`channel/lark-bot/src/inbound.ts:18-23` 的注释），同一开发者的多个机器人共用一条身份条目；不同租户、不同开发者主体下的同一个人是不同的渠道身份，由宿主映射到同一个 principal。
- **决定 4、5**：第二阶段把"同部署其他机器人发出的"作为来源标记的一部分（§6.4），让模型和宿主看得见，不做硬拦截，与"让来源清楚可见"一致。
- **决定 1、6**：不涉及。每个机器人的会话照常进各自的话题表与宿主队列。
- **channel-stamping**：本提案依赖它的三条规则并与之一致（§5.6）。

## 4. 方案比较

### 4.1 凭据放在哪

| 方案 | 做法 | 优点 | 缺点 |
|---|---|---|---|
| A 按账号推导变量名 | `account: "proj-a"` → 自动读 `LARK_PROJ_A_APP_ID` 等 | 配置短 | 隐式规则：名字从哪来要看文档；账号改名就丢凭据；`proj-a` 与 `proj_a` 撞名；与 mail、bridge、harness 的"显式 `env:NAME`"不一致 |
| **B 条目里显式引用**（推荐） | `config.appId` / `config.appSecret` / `config.domain` 写值或 `env:NAME`，与 mail 一样做 `env:` 替换 | 与其他通道、控制台的凭据规则一致（`console-config.ts:81` 已按此识别）；账号与变量名解耦；顺带修好 `encryptKey` 的 `env:` 不生效 | 每个条目多三行 |
| C 每个机器人一份凭据文件 | 条目写 `credentialsFile` | 与 create-lark-bot `--out` 对上 | 又一种凭据形态；控制台的"只显示 `env:NAME`"规则不适用 |

旧的 `LARK_APP_ID` 等作为**一个**条目的兜底保留（§9）。

### 4.2 出站选哪个实例

| 方案 | 做法 | 问题 |
|---|---|---|
| D1 一个适配器对象服务多个账号 | 接口本来就是 `caps(account)`、`start(ctx.account)` | lark-bot 适配器的全部状态（客户端、卡片降级、上传缓存、去重）都按单应用设计；改造面大，收益只是少几个对象 |
| **D2 每个 `(id, account)` 一个对象，选路时带上账号**（推荐） | compositor、输出工具、`deliver` 都按 `(channel, account)` 选通道 | 需要改三处调用点与两个接口 |

### 4.3 分不分阶段

| 方案 | 做法 | 问题 |
|---|---|---|
| H1 一次做完（原稿） | 凭据、出站、开通、兄弟识别一起落地 | 兄弟识别的全部价值取决于一个未核实的平台行为：飞书是否把机器人 A 的群消息推送给同群的机器人 B。若不推送，新增的协议字段（`Origin.selfAccount`、`includeSiblings`）、SQLite 表和适配器改写永远不生效，却要一直维护 |
| **H2 两阶段**（推荐） | 第一阶段：§5（凭据、出站、开通、无宿主写法）；第二阶段：§6（兄弟识别），以 live 核实为前提 | 第二阶段若取消，多机器人同群时兄弟消息按别家机器人处理（§5.7），与今天多个守护进程时相同 |

第一阶段修的都是今天就存在的错误（§2.2–§2.4、§2.7），不依赖第二阶段的任何东西。

### 4.4 （第二阶段）怎样认出"本部署的机器人"

| 方案 | 做法 | 问题 |
|---|---|---|
| E1 手写 `selfAccounts` / `agentAccounts` | 现状 | open_id 按应用区分，N 个机器人要写 N² 个 id，且要先拿到这些 id（§2.5） |
| E2 事件里的应用 id | 若飞书对机器人发送者给出 app_id，直接用 | 未核实飞书事件是否带发送应用的 app_id（§11 第 5 项）；不能作为唯一依据 |
| **E3 按"我们发过的消息"认**（推荐） | 守护进程维护一张已发消息索引（channel + 平台消息 id → 发送账号、随附身份）；收到应用发来的消息时查索引；自己的回声另有 `botOpenId` 兜底 | 只认得本守护进程发出的消息；有发送与回声的时序竞争，需要专门处理（§6.3） |

E3 是 POSITIONING §2 第三行"agent 发出的每条消息随附自己的身份，回流时还原"的落实，只是把记录从每个适配器私有改成守护进程内共享、可持久。

**索引放在哪一层。** 有三种放法：

| 放法 | 说明 | 取舍 |
|---|---|---|
| I1 lark-bot 包里扩展 `DeclaredSenderStore`，表也算 lark-bot 的 | 原稿的写法 | 别的通道（mail 的 Message-ID、桥接）要做同样的事时得各建一张表 |
| I2 只用 outbox 的 `providerMessageId` | outbox 已持久化（`daemon_outbox`，`records.ts:34`） | outbox 一次操作只记主消息的 id（`outbox.ts:14-22`）；附件、续页是适配器内部拆出的另外几条消息（`adapter.ts:767`、`:823`），outbox 看不到；而且 outbox 也是在发送返回之后才写，竞争问题一样 |
| **I3 守护进程级索引，适配器通过 store 钩子写入**（推荐） | 表在 `DaemonRecords`（`records.ts:21`）里，键是 `(channel, providerMessageId)`，与通道无关；lark-bot 看到的仍是 `LarkBotOptions.store`（`adapter.ts:62`）这个注入点，接口扩展两个可选方法 | 只有适配器知道一次发送拆成了哪几条平台消息，所以写入必须从适配器发起；但表与查询是守护进程的，mail 或桥接以后接同一张表即可。不改 `ChannelAdapter` 接口（另一种做法是让 `SendResult` 返回全部分片 id，那要改所有适配器，且不解决时序） |

### 4.5 （第二阶段）同部署其他机器人的消息算什么

| 方案 | 结论 | 问题 |
|---|---|---|
| F1 一律 `self`，与自己的回声相同 | 默认丢弃，身份结论也相同（principal 为空） | 区分不了"我的回声"和"兄弟的消息"；宿主想放行兄弟消息时只能连自己的回声一起放行 |
| F2 一律当作普通 agent 账号（不标 `self`） | 采信随附身份，按 Binding 正常处理 | 违背 `Origin.self` 的定义（"Message produced by this deployment's own agents, echoed back by the channel"，`packages/protocol/src/inbound.ts:82-83`）与 POSITIONING §4 第 3 步（`POSITIONING.md:77`）；两个机器人互相 @ 时，默认表之外的规则可能形成回声循环 |
| **F3 都标 `self`，另标发送账号；兄弟消息的身份结论与 agent 账号相同；规则可单独放行兄弟消息**（推荐） | 见 §6.4：兄弟消息 `kind: agent`、`self: true`、`selfAccount: <发出账号>`，principal 按 agent 账号的规则给出（不再是 null）；默认丢弃；Binding 可用 `includeSiblings` 只放行兄弟消息 | 协议多两个可选字段（§7） |

## 5. 推荐设计：第一阶段

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

规则（全部在 `resolveChannel` 的 `lark-bot` 分支，`config.ts:1074-1079`）：

1. `config` 整体先做 `substituteEnv`（与 mail 相同，`config.ts:1080-1081`），缺失的变量报错并点名、不带值。
2. **显式优先**：`config.appId` 与 `config.appSecret` 都给出时，用它们；`config.domain` 缺省为 `feishu`，取值只能是 `feishu` / `lark`。只给其中一个是错误。
3. **兜底只给一个条目**：两者都没给时，读 `LARK_APP_ID` / `LARK_APP_SECRET` / `LARK_DOMAIN`（今天的行为）。这样的条目至多一个，否则报错："lark-bot channels X and Y both read LARK_APP_ID; give each its own config.appId / config.appSecret"。
4. **一个应用只跑一个实例**：解析后两个条目的 `appId` 相同（且 `domain` 相同）即报错，原因写明 §2.3（事件会被分走）。比较的是解析后的值，错误信息只点名条目与 appId，不打印其他值。
5. **`(type, account)` 唯一**：同为 `lark-bot` 的条目账号不得重复（channel-stamping §5.2 的"同一归属、同 `(id, account)` 重复 → failed"，这里在配置阶段就拒绝）。
6. **账号名**：多于一个 `lark-bot` 条目时，账号必须匹配 `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`（与实例名同一规则，`INSTANCE_NAME`，`config.ts:125`）。账号进入 `routeKey`（`packages/protocol/src/common.ts:18-22`，以 `:` 分隔）和会话键，含 `:` 会让键有歧义。只有一个条目时不强制（不破坏现有配置），但出现 `:` 时告警。
7. `buildChannel` 改为 `new LarkBotAdapter({ ...resolvedConfig })`，不再用 `ch.lark` 覆盖（`gateway.ts:1252`）；`ResolvedChannel` 的 `lark` 字段并入解析后的 `config`（`config.ts:515`）。

**这些错误让整个守护进程启动失败。** 第 2–6 条都在 `resolveConfig` 里以 `ConfigError` 报出，与今天任何配置错误一样：`aio` 以退出码 2 结束（`packages/daemon/src/cli.ts:566`），一个通道都不启动。这与运行时某个通道失败（例如密钥错误、连不上）不同，后者只把那一个通道标成 `failed`，其余照常（`gateway.ts:936-940`）。选择整体失败，是因为这几种错误（同一应用两条连接、两个条目读同一套变量）若只停掉其中一个条目，剩下的那个可能是错的那个，部署方也不容易发现。

**控制台在写入之前就报出这些错误。** `PUT /api/config` 与 `POST /api/config/validate` 跑的是同一套启动校验（`console-config.ts:252-289`，`check` 调 `resolveConfig`，env 文件当场重读），有错误时返回 422 并列出问题，不写文件。所以只要校验放在 `resolveConfig` 里，控制台无需另写一份。开通任务的写入路径今天绕过了它，§5.5 补上。

账号名就是机器人在 agents-io 里的名字：出现在 `aio status` 的通道列表（`gateway.ts:453`）、`ReplyRoute.account`、会话键、Binding 的 `match.account`、watch 的 `source.account`、`input.verify` 的记录里。建议用"项目 / agent / 品牌"之类稳定的名字；改账号名等于换了一个机器人（旧会话键不再命中），在文档里写明。

### 5.2 出站：按 `(channel, account)` 选实例

1. **Compositor**：`CompositorOptions` 加 `account?: string`；设了时只认领 `route.channel === adapter.id && route.account === account` 的路由，`track`（`compositor.ts:441`）与 `restore`（`compositor.ts:427`）两处都改。不设时行为不变（库用户、单账号）。守护进程 `compose` 传入通道的账号（`gateway.ts:895`，调用点 `:583`、`:683`）。
2. **输出工具**：`HostToolsOptions.adapter(channel)` 改为 `adapter(route: ReplyRoute)`（或加可选的 `account` 参数），`tier` 同理（`packages/host-mcp/src/tools.ts:83`、`:243`、`:358`；守护进程侧 `gateway.ts:298`、`:301`）。
3. **退路收窄**：`deliver`、`systemReply`、`replyCaps` 在 `(id, account)` 未命中时，**只有当该 id 恰好只有一个运行中的账号**才退回按 id 匹配（`gateway.ts:708`、`:733`、`:951`）。单机器人部署行为不变（宿主写了 `account: "default"` 而实际账号是别的名字时照常发出）；多机器人时返回 `unknown_channel`，消息写明可用的 `(id, account)`。这回答了 channel-stamping §10 第 5 项在多账号情形下的部分。
4. **适配器自检**：lark-bot 的 `send` / `edit` / `finalize` / `retract` 在 `route.account !== this.account` 时抛不可重试的错误（`LarkApiError`），作为纵深防御：上面三处任何一处漏改，都会变成显性的投递失败，而不是以错误的机器人发出。

### 5.3 入站：每个实例一条长连接，其余不变

- 每个 `LarkBotAdapter` 对象各自 `discoverBot`（`adapter.ts:244`）、各自建长连接（`adapter.ts:224`）、各自的去重窗口与卡片降级状态。不需要改。
- 同一条群消息被两个机器人收到（例如 B 有"获取群组中所有消息"权限），会变成两个信封、两条输入、两条 `input.verify` 记录，各进各自账号的会话（§2.6）。默认表下，被 @ 的那个机器人的信封 `admission` 是 `dispatch`，另一个是 `observe`（`inbound.ts:240`），所以默认只有被 @ 的机器人回答，另一个只记入上下文。
- `mentions: ["self"]` 的判断（`addressesSelf`，`router.ts:674-677`）对飞书依赖 `admission` 提示，提示本来就是按接收机器人算的，多机器人下天然正确。

### 5.4 无宿主时"每个机器人一个 agent"的写法（待拍板）

有宿主或写了 `bindings` 的部署，用 `match.account` 即可：

```jsonc
"bindings": [
  { "id": "a-dm",    "match": { "channel": "lark-bot", "account": "proj-a", "conversationKind": "dm", "labels": ["owner"] }, "on": "dispatch", "agent": "proj-a", "session": "topic" },
  { "id": "a-group", "match": { "channel": "lark-bot", "account": "proj-a", "conversationKind": "group", "labels": ["owner"], "mentions": ["self"] }, "on": "dispatch", "agent": "proj-a", "session": "per-thread" }
]
```

没写 `bindings` 时，默认表（`defaultBindings`，`router.ts:771-789`）把所有机器人的输入都交给 `defaultAgent`。为了让"按 agent 分机器人"在无宿主时开箱可用，可以允许通道条目写 `"agent": "<名字>"`：默认表为该账号生成同样的三类规则（私聊、群里 @、群里观察）并指向这个 agent，其余账号仍用 `defaultAgent`。它只影响默认表；同时写了 `bindings` 时报错，避免两处各说一半。这是与 `owners` 同性质的"本地配置给出最简策略"（决定 3 最后一条），不是新的路由机制。

### 5.5 控制台：创建第二个机器人

`POST /api/bots/lark` 的 `account` 决定变量名与条目：

| 账号 | 写入的变量 | 加入的条目 |
|---|---|---|
| `default`（不传） | `LARK_APP_ID` / `LARK_APP_SECRET` / `LARK_DOMAIN`（与今天相同） | `{ "type": "lark-bot", "config": { "appId": "env:LARK_APP_ID", "appSecret": "env:LARK_APP_SECRET", "domain": "env:LARK_DOMAIN" } }` |
| 其他，例如 `proj-a` | `LARK_PROJ_A_APP_ID` / `LARK_PROJ_A_APP_SECRET` / `LARK_PROJ_A_DOMAIN`（账号大写，非字母数字换成 `_`） | `{ "type": "lark-bot", "account": "proj-a", "config": { …同上，引用这三个名字 } }` |

新建的条目总是写显式引用，所以控制台创建的机器人从不依赖兜底；变量名只是控制台的命名约定，守护进程加载配置时不推导名字（§4.1 方案 B）。

**create-lark-bot 需要能写自定义变量名。** 0.2.x 的 `--write-env` 只写固定名字（§2.7）。两种做法：

| 做法 | 说明 | 失败时 env 文件 |
|---|---|---|
| **G1 给 create-lark-bot 加 `--env-prefix <P>`**（推荐） | 写 `<P>APP_ID` / `<P>APP_SECRET` / `<P>DOMAIN`；守护进程对非 `default` 账号传 `--env-prefix LARK_PROJ_A_`。凭据仍然只经过 create-lark-bot 写进 env 文件，守护进程从不经手密钥，保持 `provision.ts:16-18` 的约定。需要发布新版本并更新钉住的版本（`config.ts:465`）。部署方自定义的 `larkBotCommand` 不支持该参数时，任务以 create-lark-bot 的报错失败，错误信息提示升级 | create-lark-bot 退出前已写入变量；守护进程随后的检查失败时，这些变量留在 env 文件里（未被引用，无害），见下文"写入时复查" |
| G2 守护进程自己写 env 文件 | 用 `--out <任务私有目录>/app.json` 取凭据，守护进程读出后以原子写入方式改 env 文件，再删除临时文件 | 守护进程在所有检查通过之后才写 env 文件，失败时不留变量；代价是守护进程要经手并改写 env 文件里的密钥，需要新增一个可靠的 env 文件编辑器（保留注释与其他行、0600） |

**任务开始时的检查**（替换 `provision.ts:78-86`）：

- 配置里已有同账号的 `lark-bot` 条目 → 409。
- 目标变量名任一已设置（env 文件或进程环境，`ConfigStore.defined`，`console-config.ts:221`）→ 409，点名变量。
- 新账号的变量名与已有条目引用的变量名冲突（例如 `proj-a` 与 `proj_a` 映射到同一前缀）→ 409。
- 账号不合 §5.1 第 6 条 → 400。
- "同一时间一个任务"不变（`provision.ts:72-73`）：两个任务都在等扫码时，用户分不清扫的是哪个。

**写入时复查**（`succeed`，`provision.ts:202`）。任务可能等扫码几分钟，其间配置可能被 `PUT` 改掉，所以 `succeed` 在写配置前重新读取配置并复查：

1. 把 `!channels.some(c => c.type === 'lark-bot')`（`provision.ts:213`）改成按账号判断：已有**同账号**的条目 → 不加条目，任务以 `conflict` 失败；已有其他账号的条目 → 照常追加。
2. 重跑开始时的变量名冲突检查（相对此刻的配置）。
3. **appId 去重**：把结果的 `appId` 与此刻配置里每个 `lark-bot` 条目解析出的 `appId`（用 `ConfigStore` 的 env 解析）比较，相同 → 不加条目，任务以 `duplicate_app` 失败，消息点名已有的账号。这一条防的是"开通结果其实是一个已配置的应用"：本机缓存的 create-lark-bot 0.2.2 里，`selectExistingApp` 只在 `update` 子命令（`updateLarkBot`）里使用，控制台调用的创建流程不会选到已有应用；但钉住的 v0.2.3 未能离线核对，部署方也可以把 `larkBotCommand` 换成别的脚本。没有这一条，重复的 appId 要到下次启动才被 §5.1 第 4 条拦下，而那会让整个守护进程启动失败。
4. **写入前跑启动校验**：对将要写入的文档跑与 `PUT` 相同的检查（`console-config.ts:252-289`，可以给 `ConfigStore.update` 加一个"校验后写"的变体），有错误就不写，任务以 `config_invalid` 失败并列出问题。今天的 `update` 不校验（`console-config.ts:290-295`）。

第 1–4 条任一失败时，env 文件里已经写入的变量（G1）不由守护进程删除，任务消息点名这些变量，并说明：它们未被任何条目引用，可以手工删除；不删的话，同一账号下次开通会在"目标变量已设置"处得到 409。这与今天 `config_write_failed` 的处理一致（`provision.ts:195-199`）。采用 G2 时这一段不适用。

`owner`：照旧把已验证的 `lark-bot:<union_id>` 加进 `policy.owners`（`provision.ts:206-218`）。同一开发者主体下的多个机器人得到同一个 union_id，去重后只有一条；不同主体下得到不同的 union_id，各加一条。条目加入失败（上面第 1–4 条）时 owner 也不写。

结果里的 `env` 换成该账号实际引用的名字（`provision.ts:232`，协议注释 `admin.ts:296` 同步改）。`packages/daemon/README.md` 的 Console API 一节（`:171-182`）改写"one lark-bot channel per daemon"一句。

### 5.6 与 channel-stamping 的一致性

- **"一个通道 id 只属于一种适配器"**（channel-stamping §5.2）：所有 `lark-bot` 条目归属同一种适配器（条目 `type`），多个条目只是账号不同，允许；§5.1 第 5 条在配置阶段先拒绝 `(id, account)` 重复。
- **来源绑定**（channel-stamping §5.1）：每个实例的 `emit` 闭包盖上它自己的 `(channel, account)`，一个实例不能以另一个机器人的账号提交信封；这让 `match.account` 与第二阶段 `selfAccount` 的比较可信。本提案不要求 channel-stamping 先落地，但第二阶段与它一起落地时，兄弟识别才不会被不合规的 bridge 伪造（bridge 冒用 `lark-bot` id 会被 channel-stamping 拒绝）。
- **证据上限**：channel-stamping 的条目级 `evidence` 字段按条目生效，每个 lark-bot 实例各自计算。
- **身份键不含账号**（channel-stamping §10 第 4 项）：本提案**不改**。人的身份用 union_id 时跨应用稳定，不需要账号；只拿得到 open_id 时，不同应用下的 open_id 是不同字符串，不会碰撞，只是需要为每个机器人写一条（这是平台的作用域，不是 agents-io 的键设计造成的）。
- **channel-stamping 的行号已过期**，落地前应刷新：出站退路 `gateway.ts:693`、`:703` 现在是 `:708`（`deliver`）、`:733`（`systemReply`），另有同样写法的 `:951`（`replyCaps`）该文没有列出；`emit` 闭包 `gateway.ts:895-898` 现在是 `:927-930`；`Gateway.accept` `gateway.ts:514-524` 现在从 `:519` 开始。

### 5.7 第一阶段下同部署其他机器人的消息

第一阶段不认兄弟：机器人 A 发的群消息若被同群的机器人 B 收到，在 B 看来就是一个 `isBot` 的外部发送者（`inbound.ts:213`），与别家机器人相同。默认表下它没有 `owner` 标签，不会命中 `default:owner-<kind>`，只会被 `default:observe-<kind>` 记成上下文（`router.ts:786`），不会唤醒 B，不会形成循环。宿主若写了"任何人 @ 机器人都唤醒"之类不看标签的规则，两个机器人互相 @ 时可能来回对答；这种情况今天在"每个机器人一个守护进程"时同样存在，部署方可用 `senders` 排除对方机器人的 open_id（每个机器人在对方应用下的 open_id 各一个）。第二阶段要解决的正是这里。

## 6. 推荐设计：第二阶段（本部署机器人的识别，等 live 核实）

**前提与停止条件。** 先做 §8 的 live 测试（§11 第 5 项）：两个真实应用在同一个群，A 发一条普通消息、一张卡片、一条 @B 的消息，看 B 是否收到 `im.message.receive_v1`、事件里的 `sender_type` / `sender_id` / 是否带 app_id；再看 A 编辑卡片后 B 是否收到任何事件。结论决定第二阶段：

- B 收不到 A 的消息 → 第二阶段取消。只保留一个小改动：每个实例把自己的 `lark-bot:<botOpenId>` 自动登记为 `selfAccounts`（今天要手写），其余不做。
- B 收得到 → 按下文做。若事件带 app_id，§6.2 可以在索引未命中时直接用它，§6.3 的竞争问题随之消失。

### 6.1 已发消息索引（守护进程级）

在 `DaemonRecords`（`records.ts:21`）里加一张表，与 `daemon_inputs`、`daemon_outbox` 同库、同样按时间清理（`records.ts:52`，默认 30 天）：

```sql
CREATE TABLE IF NOT EXISTS daemon_sent (
  channel TEXT NOT NULL, provider_message_id TEXT NOT NULL,
  account TEXT NOT NULL, declared TEXT, at INTEGER NOT NULL,
  PRIMARY KEY (channel, provider_message_id)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS daemon_sender_alias (      -- §6.3 (b)
  channel TEXT NOT NULL, receiving_account TEXT NOT NULL, channel_user_id TEXT NOT NULL,
  sender_account TEXT NOT NULL, at INTEGER NOT NULL,
  PRIMARY KEY (channel, receiving_account, channel_user_id)) WITHOUT ROWID;
```

表与通道无关（§4.4 I3）。lark-bot 侧只扩展注入点 `DeclaredSenderStore`（`channel/lark-bot/src/store.ts`）：

```ts
interface SentRecord { account: string; as?: string }
interface DeclaredSenderStore {
  set(providerMessageId: string, as: string): void | Promise<void>;                     // 现有
  get(providerMessageId: string): string | undefined | Promise<string | undefined>;     // 现有
  record?(providerMessageId: string, r: SentRecord): void | Promise<void>;              // 新增
  lookup?(providerMessageId: string, o?: { waitForConversation?: string }): SentRecord | undefined | Promise<SentRecord | undefined>; // 新增
  sending?(conversationId: string, account: string): () => void;                        // 新增，§6.3 (a)
}
```

- 适配器**每发出一条消息都记录**（含拆分出的附件与续页），不再只在 `op.as` 存在时记录（`adapter.ts:504`、`:763`、`:767`、`:823`）。飞书 message_id 全局唯一，配上 `channel` 作键。
- 守护进程为每个 lark-bot 实例传入同一个由 `DaemonRecords` 实现的 store（`buildChannel` 的 `LarkBotOptions.store`，`adapter.ts:62`）。库用户不传时仍是每个对象私有的内存表（`adapter.ts:164`），行为与今天相同。
- 不记录消息内容。

### 6.2 适配器把本部署机器人归一为 `app:<appId>`（选项，守护进程打开）

`LarkBotOptions` 加 `selfIds?: 'open_id' | 'app'`，默认 `'open_id'`（今天的输出）。只有设为 `'app'` 时，收到发送者是应用的消息（`adapter.ts:300`）才改写：

- 索引命中 → 发送者 `channelUserId` 写成 `app:<发出账号的 appId>`，`declared` 取记录里的 `as`。
- 未命中但 `open_id === botOpenId`（自己的回声，例如索引启用前发出的）→ `app:<自己的 appId>`。
- 别名表命中（§6.3 (b)）→ `app:<那个账号的 appId>`，`declared` 为空。
- 其他情况（别家机器人、无法确认的）→ 保持今天的 `senderId`（`inbound.ts:24`）。

做成选项、默认关闭，是因为改写会改变 lark-bot 包对所有库用户的输出：`open_id === botOpenId` 这一支即使没有共享索引也会生效，一个单机器人的库用户若在自己的 `selfAccounts` / `senders` 里写了机器人的 open_id，会静默失效。守护进程在第二阶段落地时对所有 lark-bot 实例设 `'app'`（单机器人部署也一样，以保持语义统一），并按 §9 处理守护进程用户的迁移。

`app:<appId>` 在所有应用的视角下相同，正好解决 §2.5 的 N² 问题。

**为什么 `evidence: 'platform_signed'` 仍然成立。** `evidence` 说的是"适配器能证明什么"。改写后的 `channelUserId` 由两样东西决定：入站事件里的 message_id（来自经应用凭据认证的长连接，与今天的 open_id 同一来源），以及守护进程发送时飞书在 API 响应里返回的同一个 message_id（守护进程用该应用的凭据调用、飞书分配的 id）。两端都是平台给出的数据，守护进程只是把它们对上，不取消息文本里的任何东西，符合 `declared` 字段"只从适配器控制的元数据得出"的约束（`packages/protocol/src/inbound.ts:36-41`）。别名表（§6.3 (b)）同理：它记的是"某个平台签名的 open_id 曾经发出过我们发出的消息"。

### 6.3 发送与回声的时序竞争

适配器在 `sendOne` 返回之后才写索引（`adapter.ts:503-504`、`:763`），而 B 的长连接可能在 A 的 HTTP 响应回来之前就收到这条消息。自己的回声仍有 `botOpenId` 兜底；但兄弟消息会在索引里查不到，被当成别家机器人。如果 A 的回复 @ 了 B，B 收到的信封 `admission` 是 `dispatch`，在宿主写了不看标签的规则时两个机器人可能来回对答。处理分两步：

- **(a) 发送中标记 + 有界等待。** 适配器在每次 `sendOne` 之前调 `store.sending(conversationId, account)`，记录"账号 A 正在向这个会话发消息"，发送返回并写入索引后释放。收到发送者是应用的消息、索引未命中时：若此刻有**其他账号**正在向同一会话发送，等它释放后再查一次（`lookup` 的 `waitForConversation`），最多等 3 秒；没有正在进行的发送就不等。标记只在内存里（同一进程内的所有实例共用一个 store），等待只影响这一条入站，不阻塞别的事件。HTTP 超时、响应丢失时等待到期，消息按别家机器人处理。
- **(b) 记住兄弟在本应用下的 open_id。** 一个兄弟消息第一次在索引里命中时，把 `(lark-bot, 接收账号, 发送者 open_id) → 发出账号` 写进别名表（`daemon_sender_alias`）。之后 B 再看到这个 open_id，不依赖索引与时序就能认出是 A。这与自己的回声用 `botOpenId` 判断（`inbound.ts:214`）是同一个道理：同一应用经别的程序发出的消息也会被认作本部署（`declared` 为空）；用的是我们持有凭据的应用，这样归类是合理的。

两步之后剩下的窗口只有"某个兄弟第一次在这个群里说话、且发送响应超过 3 秒才回来"，这种情况按别家机器人处理，默认表下不会唤醒（§5.7）。

### 6.4 身份结论

- **自动登记**：网关启动通道后，把每个 lark-bot 实例的 `lark-bot:app:<appId>` 加入 `selfAccounts`，并记下 `appId → account`。`policy.selfAccounts` 里手写的条目照旧生效。
- `IdentityRules` 增加 `selfAccountOf?: (key) => string | undefined`；`identify` 命中 self 时（`identity.ts:100-102`）分两种：
  - `selfAccount === 接收账号`：**自己的回声**。结论与今天相同：`kind: agent`、`self: true`、`principal: null`，`declared` 原样带上。默认丢弃。
  - `selfAccount !== 接收账号`：**兄弟消息**。`kind: agent`、`self: true`、`selfAccount`；principal 按 agent 账号的规则（`identity.ts:103-107`）给出：随附身份存在且不是某个成员时 `{ id: declared, labels: ['agent'] }`；没有随附身份时 `{ id: 'lark-bot:app:<appId>', labels: ['agent'] }`（与 `owners` 作为身份条目时"principal 就是那个键"同一做法，`identity.ts:36-37`）；随附身份冒称成员时 principal 退回 `{ id: 'lark-bot:app:<appId>', labels: ['agent'] }`，`declared` 不采信。
  - 原稿写"兄弟与 agent 账号相同（采信随附身份）"但又走 self 分支，self 分支给的是 `principal: null`，所以 `includeSiblings` 加 `labels` 的规则永远不会命中。这里改成兄弟消息不走 self 分支的 principal，规则可以写 `labels: ["agent"]` 或 `senders: ["app:<appId>"]`。
- `Ingress` 把 `selfAccount` 写进 `Origin.selfAccount`，`records.recordInput` 写进 `VerifiedInput.selfAccount`（`host.ts:441-442` 旁）。
- `addressesSelf` 的 `mentions` 一支（`router.ts:675`）改为只认接收账号自己的机器人，@ 了兄弟不算 @ 自己。

### 6.5 规则字段，默认表不变

`BindingMatch` 加 `includeSiblings?: boolean`（`matches` 里 `if (origin.self && !m.includeSelf) return false`，`router.ts:681`，改为：自己的回声需要 `includeSelf`，兄弟消息需要 `includeSelf` 或 `includeSiblings`）。watch 的 filter（`WatchFilter`，`packages/protocol/src/watch.ts:22-29`）的 `excludeSelf` 默认仍丢弃两者，另加 `includeSiblings?: boolean` 只放回兄弟消息。

**默认表不放行兄弟消息，原稿"给 `default:observe-<kind>` 加 `includeSiblings`"的建议撤回。** 原稿的理由是"团队机器人在群里的回答会进入个人机器人会话的上下文"，这在流式卡片下不成立：compositor 在轮次一开始就发出卡片（`compositor.ts:461-462`，"Send right away so the end is never blank"），之后只编辑这张卡片（`compositor.ts:551`）并在结束时 finalize（`compositor.ts:568-592`）；`im.message.receive_v1` 只在消息创建时触发一次，兄弟收到的是空白或"思考中"的卡片，不是最终答案。只有 `tier: final` 的路由（不编辑，`compositor.ts:451`）和适配器拆出的附件、续页（`adapter.ts:767`、`:823`）在创建时就带有实际内容。飞书是否对编辑推送事件给其他机器人，列入 live 核实；即便推送，也要另做"编辑后的内容替换上下文里的旧条目"，不在本提案内。所以第二阶段的价值是**正确地区分并默认丢弃**兄弟消息、给宿主一个可选的放行开关，不是"自动共享上下文"。

### 6.6 随附身份（可选，跟进项）

守护进程今天不给发送传 `as`（§2.5）。有了索引，自己的回声与兄弟消息不依赖 `as` 也能识别；`as` 只决定兄弟消息的 principal 能否说出"是哪个 agent / 哪个会话"发的（§6.4）。建议跟进：compositor 与输出工具传 `as = "aio:<agent>"`，网关的 `isSelfDeclared`（`identity.ts:31`）认 `aio:` 前缀。不阻塞第二阶段。

## 7. 对协议、schema、配置的影响

第一阶段：

| 位置 | 变化 | 兼容性 |
|---|---|---|
| `packages/daemon/src/config.ts` | `lark-bot` 条目的 `config` 做 `env:` 替换；`appId`/`appSecret`/`domain` 显式优先，旧变量兜底至多一个条目；重复应用、重复账号、账号名检查（`ConfigError`，启动失败）；可选 `agent`（§5.4，待拍板）；`ResolvedChannel.lark` 并入 `config` | 旧配置（单条目、无显式凭据）行为不变 |
| `packages/session/src/compositor.ts` | `CompositorOptions.account?`；`track`、`restore` 按账号认领 | 可选 |
| `packages/host-mcp/src/tools.ts` | `adapter` / `tier` 按路由（含账号）查 | 包内接口；守护进程同步改 |
| `packages/daemon/src/gateway.ts` | `compose` 传账号；`deliver`/`systemReply`/`replyCaps` 退路收窄；`buildChannel` 不再覆盖 | — |
| `packages/daemon/src/provision.ts`、`console-config.ts` | 按账号的冲突检查；写入时复查、appId 去重、写前校验；`--env-prefix`（G1） | 新错误码 `duplicate_app`、`config_invalid` |
| `packages/protocol/src/admin.ts` | `AdminLarkBotRequest.account` 注释写明命名规则；结果 `env` 注释改为"该账号的引用" | 形状不变 |
| `channel/lark-bot` | `send` 等检查 `route.account` | 库用户传错账号会得到错误而不是错发 |
| create-lark-bot | `--env-prefix`（G1） | 上游新版本 |
| 文档 | `packages/daemon/README.md` Console API 一节 | — |

第二阶段（取消时都不做）：

| 位置 | 变化 | 兼容性 |
|---|---|---|
| `packages/protocol/src/inbound.ts` | `Origin.selfAccount?: string` | 纯增量 |
| `packages/protocol/src/host.ts` | `BindingMatch.includeSiblings?`；`VerifiedInput.selfAccount?` | 纯增量；旧宿主忽略 |
| `packages/protocol/src/watch.ts` | `WatchFilter.includeSiblings?` | 纯增量 |
| `packages/session/src/identity.ts`、`router.ts` | `IdentityRules.selfAccountOf?`；兄弟消息的 principal；`addressesSelf` 按接收账号；`matches` 处理 `includeSiblings` | 可选 |
| `channel/lark-bot` | `DeclaredSenderStore.record?/lookup?/sending?`；每次发送都记录；`selfIds: 'app'` 选项 | 默认 `'open_id'`，库用户输出不变 |
| `packages/daemon/src/records.ts` | 新表 `daemon_sent`、`daemon_sender_alias` | 新表，无迁移 |
| 文档 | `docs/CHANNELS.md:68` 关于 `selfAccounts` 的说明改为"自动登记，手写仍可用" | — |

不涉及：`InboundEnvelope` 的形状、`ChannelAdapter` 接口、身份映射格式、Binding 表的其他字段、宿主入站队列、决定 1–6 的任何条款。

## 8. 测试

### 8.1 第一阶段

`packages/daemon/test/config.test.ts`：
- 单个无显式凭据的条目读 `LARK_APP_*`（回归）；两个都无显式凭据 → `ConfigError` 点名两个条目。
- 显式 `env:` 引用被替换；缺变量报错点名变量、不含值；只给 `appId` 不给 `appSecret` → 报错。
- `config.encryptKey: "env:X"` 解析为变量值（修复 §2.2）。
- 两个条目解析出同一 `appId` → 报错；同账号两个条目 → 报错；多条目时账号含 `:` → 报错。
- 上面每种错误经 `ConfigStore.validate` / `put` 返回 422 与对应 issue，文件不变（`packages/daemon/test/console.test.ts` 的 `console config` 一组）。

compositor（`packages/session/test/progress.test.ts` 的 `compositor progress` 一组，或新建 `compositor.test.ts`）：
- 两个同 id、不同账号的假适配器各一个 compositor，回复路由的账号是 b → 只有 b 发送和编辑；a 的 `send` 调用次数为 0。不设 `account` 时行为不变。
- `restore` 两个账号：日志里有一个未完成的轮次，路由账号是 b，带 `render.anchor`；新建 a、b 两个 compositor → 只有 b 接续并 finalize 那张卡片，a 不调用 `edit`/`finalize`（`compositor.ts:427`）。

`packages/daemon/test/gateway.test.ts`（两个 `FakeChannel('lark-bot')`，账号 `a`、`b`）：
- 从 b 进来的私聊，回复只经 b 发出；输出工具 `send_file` 只经 b。
- 宿主 `deliver` 到 `account: 'c'` → `unknown_channel`；只有一个账号运行时 `deliver` 到错误账号仍退回（回归）。
- 同一 message id 从 a、b 各进来一次 → 两条输入、`input.verify` 两条记录、两个会话键。
- Binding `match.account: 'a'` 只命中 a 的输入。

`channel/lark-bot/test/outbound.test.ts`：`route.account` 与实例不符 → 抛错，不调用 SDK。

开通（`packages/daemon/test/console.test.ts` 的 `console Lark bot provisioning` 一组，用假的 create-lark-bot）：
- 已有 `default` 机器人时，`account: 'proj-a'` 的任务被接受，参数含 `--env-prefix LARK_PROJ_A_`；成功后加入带显式引用的条目，结果 `env` 是新名字。
- 同账号已有条目、目标变量已设置、前缀冲突 → 409；非法账号 → 400。
- 不传 `account` 且没有任何机器人：与今天一致，但条目写显式引用。
- **并发的配置写入**：任务停在 `waiting_scan` 时，经 `PUT /api/config` 加入一个同账号的 `lark-bot` 条目；假 create-lark-bot 随后成功 → 任务 `failed`（`conflict`），配置里只有 PUT 写入的那一个条目，消息点名已写入的变量。另一用例：PUT 加入的是**别的**账号 → 任务成功，两个条目都在。
- **结果 appId 与已有条目重复**：假 create-lark-bot 返回的 `appId` 等于已配置条目解析出的 `appId` → 任务 `failed`（`duplicate_app`），配置不变，owner 不写，消息点名已有账号与留在 env 文件里的变量。
- 写前校验：让新文档无法通过 `resolveConfig`（例如另一个条目引用的变量此刻缺失）→ 任务 `failed`（`config_invalid`），文件不变。

### 8.2 第二阶段

live（`channel/lark-bot/test/live.test.ts` 旁，需两个真实应用，默认跳过）：§6 开头的平台行为核实；两个机器人在同一个群，各自 @ 后只有被 @ 的那个回答。

`channel/lark-bot/test`：
- 发送（含附件、续页）每一部分都调用 `record`。
- `selfIds` 未设：发送者为应用时输出与今天相同（包括 `open_id === botOpenId` 的情形）。
- `selfIds: 'app'` + 共享 store：A 发出的消息被 B 收到 → `channelUserId === 'app:<A 的 appId>'`、`declared` 为 A 的 `as`；A 自己收到 → `app:<A 的 appId>`；store 未命中但 `open_id === botOpenId` → 同样归一；别的应用 → 原 id。
- **回声先于写入**：假飞书让 B 的入站事件在 A 的 `sendOne` 返回之前到达 → 有 `sending` 标记时 B 等到写入后得到 `app:<A>`；去掉标记（模拟别的程序发送）→ 按原 id 处理；A 的响应超过等待上限 → 按原 id 处理且不阻塞 B 的下一条事件。
- 别名：兄弟第一次命中后写入别名表；之后同一 open_id 的消息在索引未命中时也得到 `app:<A>`、`declared` 为空。

`packages/daemon/test`：
- **索引跨重启**：A 发出一条消息，关闭并以同一数据目录重启守护进程，再把这条消息作为 B 的入站送入 → 仍识别为 A 的兄弟消息；别名表同样保留。超过保留期的记录被清理。

`packages/session/test/router.test.ts`（含 `IdentityMap` 的用例）：
- 自动登记的 `app:` 键命中 self，`selfAccount` 正确；手写 `selfAccounts` 仍生效。
- 兄弟消息：principal 为 `{ id: declared, labels: ['agent'] }`；无 `declared` 时为 `lark-bot:app:<appId>`；`declared` 冒称成员时不采信。自己的回声 principal 仍为 null。
- 自己的回声：`includeSiblings` 不放行，`includeSelf` 放行；兄弟消息：两者都放行；都不写时都丢弃；`includeSiblings` + `labels: ['agent']` 能命中兄弟消息。
- 默认表不放行兄弟消息（回归，防止误加）。
- `addressesSelf`：@ 了兄弟机器人不算 @ 自己。

## 9. 迁移

第一阶段：

- **单机器人、旧写法**：不需要任何改动。条目无显式凭据 → 读 `LARK_APP_*`，账号 `default`。
- **从一个加到多个**：旧条目可以保持兜底写法，新条目必须写显式引用；也可以把旧条目改成 `"appId": "env:LARK_APP_ID"` 这样的显式写法（结果相同）。控制台创建的第二个机器人自动按显式写法加入。
- **配置里已有两个 `lark-bot` 条目的部署**（今天它们共用一套凭据，§2.3）：升级后启动失败，报错点名两个条目，要求给每个条目写自己的凭据。这是有意的：旧行为是事件被随机分走。
- **在 `config` 里写了 `env:` 的 `lark-bot` 条目**（今天是字面量，§2.2）：升级后变量被替换，变量未设置时启动失败并点名。
- create-lark-bot：先发布带 `--env-prefix` 的版本，再更新守护进程钉住的版本；在此之前控制台对非 `default` 账号返回 400，提示手工创建（或采用 G2）。

第二阶段：

- **lark-bot 库用户**：`selfIds` 默认 `'open_id'`，输出不变，不需要改动。想要归一的库用户自行设 `'app'`，并把自己 `selfAccounts` / `senders` / 身份表里机器人的 open_id 改成 `app:<appId>`。
- **守护进程用户**：守护进程对所有 lark-bot 实例设 `'app'`，经守护进程发出的消息回流时，发送者从 open_id 变为 `app:<appId>`。`selfAccounts` 由自动登记替代，手写的旧 open_id 不会因此失效；`agentAccounts` / `identities` / Binding `senders` 里若写了本部署机器人的 open_id，需要改为 `app:<appId>`，升级说明里点名提示。启动时若发现这些表里的某个 id 等于某个运行中实例的 `botOpenId`，输出一条告警。
- 宿主侧：`Origin.selfAccount`、`VerifiedInput.selfAccount`、`includeSiblings` 都是新增可选字段，不使用的宿主不受影响。

## 10. 不做

- **不做一个适配器对象服务多个应用**（§4.2 D1）。
- **不做跨机器人的会话合并**：同一个人分别私聊两个机器人是两个会话；要合并用 Binding 的 `session: { key }`，属于策略。
- **不做同一应用的多进程/多守护进程协调**：同一应用被两个守护进程同时使用，事件会被分走（§2.3），这是部署错误，只在文档里写明。
- **不改身份键**（§5.6）。
- **不替宿主决定兄弟消息的处理**：机制只给出"是兄弟发的、是哪个账号、随附了什么身份"；默认表不放行（§6.5）。
- **不做兄弟之间的上下文共享**：流式卡片下兄弟只看得到初始卡片（§6.5）。

## 11. 待拍板

**阻塞第一阶段实现的三项：**

1. **凭据写法**：采用条目内显式 `env:` 引用（§4.1 B），旧变量只作为至多一个条目的兜底；重复应用、两个兜底条目、非法账号名让整个守护进程启动失败（§5.1）。是否接受。
2. **出站退路**：多账号时不再按 id 退回（§5.2 第 3 点）。这同时部分回答 channel-stamping §10 第 5 项；单账号时是否也取消退路，留给那一项决定。
3. **create-lark-bot 的改法**：G1（上游加 `--env-prefix`，推荐；失败时 env 文件里会留下未引用的变量）还是 G2（守护进程自己写 env 文件，失败时不留变量，但守护进程要经手密钥）（§5.5）。

**不阻塞，可以随第一阶段或之后定：**

4. **通道条目上的 `agent`**（§5.4）：是否为无宿主部署提供这一最简写法。

**第二阶段，全部取决于第 5 项的 live 核实：**

5. **平台行为**：飞书是否把一个机器人发的群消息推送给同群的其他机器人；事件里是否带发送应用的 app_id；卡片编辑是否产生其他机器人能收到的事件。不推送 → 第二阶段取消，只保留自动登记自己的 `botOpenId`（§6 开头）。
6. **兄弟消息的语义（F3）**：标 `self` 并带 `selfAccount`，principal 按 agent 账号给出（§6.4），路由上默认丢弃、可用 `includeSiblings` 放行，默认表不放行（§6.5）。若希望兄弟机器人完全按普通 agent 账号处理（F2），需要先修订 POSITIONING §4 第 3 步与 `Origin.self` 的定义。
7. **随附身份 `as` 的格式与是否一起做**（§6.6）：推荐 `aio:<agent>`，作为跟进项。
