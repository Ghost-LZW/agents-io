# 入站信封的渠道与账号由守护进程盖章，证据按通道声明封顶

> 状态：提案（2026-10-07，按评审意见修订），未实现，待负责人决定后记入 `docs/design/locus/DECISIONS.md`。
> 依据：`docs/POSITIONING.md` §2、§4，`docs/RECOMMENDATION.md` §3.5 第 1 条，`docs/critique/ops-security.md` §2，决定 3、4、5；
> 代码：`packages/session/src/{ingress,identity,policy,host-queue}.ts`、`packages/daemon/src/{gateway,config,records}.ts`、`packages/protocol/src/admin.ts`、`channel/jsonl-bridge/src/{host,serve}.ts`、`packages/testkit/src/channel-conformance.ts`。

## 1. 一句话

**一条入站信封属于哪个通道、哪个账号，由守护进程按"它是从哪个已配置通道发出来的"来定，不由信封自己说；一个通道 id 只属于一种适配器；适配器能提交的身份证据，以该通道声明的范围为上限。** 这是 RECOMMENDATION §3.5 第 1 条"网关盖章：adapter 只提交本命名空间内的 `channelUserId`"在运行时的落实，今天只在一致性测试里要求、运行时没有执行。

## 2. 现状

### 2.1 渠道和账号完全由信封自报

- `InboundEnvelope` 的定义就说"这里的一切都是声明"（`packages/protocol/src/inbound.ts:14-18`），`channel`、`account` 是信封里的普通字段（`inbound.ts:23-24`）。
- 守护进程给每个通道的 `emit` 都是同一个闭包，直接调 `Gateway.accept(env)`，不比较 `env.channel`/`env.account` 与发出它的通道（`packages/daemon/src/gateway.ts:895-898`）。`Gateway.accept` 先调 `ingress.accept(env)`，再用**它自己手里的那个 `env`** 调 `records.recordInput`（`gateway.ts:514-524`）。守护进程从不调用 `Ingress.emitter()`。
- `Ingress.accept` 依次做 schema 校验（`packages/session/src/ingress.ts:191`）、按 `(channel, account, id)` 查去重表（`:194-196`）、再 `process`。`process` 直接用信封字段调 `Policy.identify` 并盖 `Origin`（`ingress.ts:223-240`），其中 `Origin.adapter` 取的是 `env.channel`（`ingress.ts:239`），而 `Origin` 的定义说它"由网关盖章，客户端不能设置"（`inbound.ts:74`）。库层的 `Ingress.emitter()`（`ingress.ts:183`）只是 `accept` 的薄包装，不接受来源参数。
- 进程外通道更进一步：连通道 id 都来自子进程的 hello（`channel/jsonl-bridge/src/host.ts:195-197`、`:309-311`），子进程重启后可以在下一次 hello 里换一个 id；入站帧原样转给 `ctx.emit`（`host.ts:420-428`）。
- 一致性套件已经要求 `env.channel === adapter.id`、`env.account === driver.account`（`packages/testkit/src/channel-conformance.ts:73-74`）。也就是说契约早就有，只是运行时不检查。

### 2.2 证据也完全由信封自报

- 身份映射只看信封里的 `evidence` 是否在条目接受的集合里，默认 `platform_signed`、`dkim_pass`（`packages/session/src/identity.ts:21`、`:109-111`）。
- 通道其实已经在能力里声明了自己能给出哪些证据：`ChannelCaps.evidence`（`packages/protocol/src/channel.ts:26-27`；lark-bot 为 `['platform_signed']`，`channel/lark-bot/src/adapter.ts:186`；mail 视 `internalDelivery` 而定，`channel/mail/src/adapter.ts:64`）。但全仓库没有任何代码读它。进程外通道的 caps 同样来自子进程自己的 hello。

### 2.3 身份与记录的键都不含账号

- 身份键是 `identityKey = ${channel}:${channelUserId}`（`identity.ts:34`），`selfAccounts`、`agentAccounts` 与条目索引都用它（`identity.ts:99-108`）。即**同一个通道 id 下，不同账号共享同一个身份命名空间**。
- `input.verify` 的键是 `channelRef = channel:<channel>/<id>`（`packages/session/src/host-queue.ts:53-56`），与账号无关；`verify` 按它取出所有记录（`packages/daemon/src/records.ts:73-77`）。
- 出站查通道先按 `(id, account)`，找不到再退回只按 id（`gateway.ts:693`、`:703`）。

所以"按 `(id, account)` 唯一"挡不住冒充：只要通道 id 相同，换个账号照样落在别人的身份命名空间与记录集合里。

### 2.4 后果

任何一个通道进程（典型是部署方自己写的 JSONL bridge，例如一个网页聊天入口），只要发出 `channel:'lark-bot'`、主人的 `channelUserId`、`evidence:'platform_signed'`，就会：

1. **被盖章为主人。** `identify` 命中主人条目，`Origin.principal` 是主人，按决定 5 这一轮走放行 profile。
2. **进入主人的会话。** 会话键由 `conversationRouteKey(env)` 从信封的 `channel/account/conversation` 派生（`packages/session/src/policy.ts:66-72`），可以直接落进主人在飞书私聊的那条 lane。
3. **劫持回复与外发白名单。** `replyRoute` 也是自报的；回复按 `route.channel` 找渲染它的通道（`gateway.ts:296`、`packages/session/src/compositor.ts:427`），默认 `outbound` 允许"本轮输入自己的回复路由"（`policy.ts:110-116`）。伪造的 `replyRoute` 让 agent 以合法通道的机器人身份往伪造者选定的会话发消息。
4. **污染宿主可依赖的记录。** `input.verify` 记的是信封原值（`records.ts:56`、`:64`），宿主用它核验"确认消息的作者"（`docs/HOSTS.md:67`）时拿到的是伪造的平台作者与证据。宿主入站队列里的 `InboundItem.envelope`（`packages/protocol/src/host.ts:230`）同理。
5. **冒充 agent 账号或本部署回声。** 伪造通道名就能让消息被当成本部署的回声丢掉，或以受信 agent 账号的名义 `declared` 任意身份（§2.3）。

只有一个通道的部署不受影响；**凡是同时跑两个以上通道，其中有一个是进程外 bridge 或第三方代码的部署，都受影响**。bridge 本身多半还对外开放了自己的输入面（网页、webhook、另一个 IM），它的一个解析错误就足以跨通道冒充。

## 3. 为什么这是 agents-io 的机制

- POSITIONING §2 把"身份**证据**：适配器提交证据，网关盖章 `Origin`"列在 agents-io 一侧，把"身份**结论**"列在宿主一侧。证据如果能跨通道伪造，宿主的任何结论都建立在沙子上。判据"不同宿主会有不同答案的才是策略"在这里不成立：没有哪个宿主希望 bridge 能冒充飞书。
- **宿主做不了这件事。** "这条信封是从哪个通道进程来的"只有守护进程知道；宿主经 `inbound`、`route` 回调、`input.verify` 看到的都已经是信封字段（`packages/protocol/src/host.ts:222-243`），没有来源信息可供二次校验。
- 决定 3 说"映射命中但证据不足，仍按外部来源处理"。这句话成立的前提是证据本身可信。
- 决定 4、5 选择不拦截、不降档，代价由"让来源清楚可见"来承担，且用户的理由是"相信模型能自己判断哪些内容不可信"。来源标记一旦能伪造，这两条决定的前提就不成立。所以本提案是决定 4、5 的配套，而不是与之冲突的收紧。
- RECOMMENDATION §3.5 第 1 条与 ops-security §2（"必须由网关盖章：适配器只能提交本命名空间内的 channelUserId……并为每个适配器设 trust 上限（私有适配器的 verified 需要单独授权）"）已经是被接受的要求。本提案只是把它做完。

## 4. 方案比较

### 4.1 渠道与账号

| 方案 | 做法 | 优点 | 缺点 |
|---|---|---|---|
| A 只写文档 | 提醒部署方"bridge 必须可信" | 零代码 | 等于承认 §2.4 全部成立；违背 RECOMMENDATION §3.5 第 1 条 |
| B 静默覆盖 | 守护进程用来源通道的 id/account 改写信封 | 不拒收任何消息 | 改写后去重键、会话键、`channelRef` 都变了，错误被掩盖；`replyRoute` 改不改都说不通 |
| **C 校验，不一致即拒收**（推荐） | 来源不符直接 `accepted:false`，记日志并计数 | 合规适配器零影响（一致性套件早已要求相等）；错误显性；不改线上协议 | 不合规的现有 bridge 会被拒（§8） |
| D 宿主二次校验 | 把来源信息放进 `InboundItem` 让宿主判断 | 宿主可自定 | 每个宿主重写同一段检查；无宿主部署没人检查；本质上不是策略（§3） |

### 4.2 通道 id 的归属

C 只保证"信封说的通道 = 发出它的通道"。还要保证"发出它的通道"本身不能冒用别人的 id（§2.3）。

| 方案 | 做法 | 问题 |
|---|---|---|
| F1 `(id, account)` 唯一 | 初稿方案 | 身份键、`channelRef` 都不含账号，换个账号即可冒充（§2.3） |
| F2 bridge 必须配置 `id` | 配置层强制 | 单独不够：配置写 `"id": "lark-bot"` 仍然冒用；且对现有配置是破坏性变更 |
| F3 id 不得与内置适配器或其他条目重名 | 只针对 bridge | 漏掉"两个不同的 bridge 程序用同一个 id"与嵌入方传入的适配器 |
| **F4 一个 id 只属于一种适配器**（推荐） | 所有运行中的通道按 id 分组；同组内必须是同一种适配器，只允许账号不同 | 需要定义"同一种"（§5.2） |

F4 涵盖 F3，并在第二阶段配合 F2（§8）。

### 4.3 证据上限

| 方案 | 做法 | 问题 |
|---|---|---|
| E1 只信 `IdentityEntry.evidence` | 现状：每个身份条目写自己接受哪些证据 | 条目描述的是"这个人需要多强的证据"，不是"哪个通道进程有资格给出这种证据"；宿主不知道某个通道名背后是哪种进程 |
| E2 只信 `caps.evidence` | 用适配器自己声明的能力封顶 | 对进程内适配器（仓库自带的代码）足够；对 bridge 是自己给自己封顶，等于没封 |
| **E3 配置声明 ∩ caps**（推荐） | 部署方在通道条目上写 `evidence`，与 caps 取交集；bridge 的强证据必须由部署方显式授予 | 多一个配置字段 |

超出上限的证据**降为 `none`**，不拒收：消息本身仍然有用，只是按外部来源处理（与决定 3 一致）。现有 `Evidence` 枚举是 `platform_signed | dkim_pass | device_only | none`（`packages/protocol/src/common.ts:65-70`），没有 `unverified`，不新增枚举值。

## 5. 推荐设计

### 5.1 来源绑定（Ingress，L2）

新增库层类型，守护进程和直接用 `session` 包的宿主都能用：

```ts
interface EmitSource {
  channel: string;          // 通道 id（进程内：adapter.id；bridge：见 §5.2）
  account: string;          // 配置里的账号
  evidence: Evidence[];     // 允许的证据（§5.3 算好的结果，总含 'none'）
  declaresSender: boolean;  // caps.declaresSender
}

// packages/session/src/ingress.ts
accept(env: InboundEnvelope, source?: EmitSource): Promise<IngressResult>;
emitter(source?: EmitSource): (env) => Promise<{ accepted: boolean; inputId?: string }>; // 仍是 accept 的薄包装
interface IngressResult { /* 现有字段 */ envelope?: InboundEnvelope } // 新增：实际处理的（规范化后的）信封

// packages/daemon/src/gateway.ts
accept(env: InboundEnvelope, source?: EmitSource): Promise<IngressResult>;
```

`Ingress.accept(env, source)` 的顺序固定为：

1. **schema 校验**（今天的 `ingress.ts:191`）。
2. **来源检查**（仅当传了 `source`）：
   - `env.channel === source.channel` 且 `env.account === source.account`；
   - `env.replyRoute` 为 `null`，或其 `channel/account` 同样等于来源；
   - 任一不符：返回 `{ accepted: false, action: 'invalid', error: 'source_mismatch: …' }`。不查、不写去重表，不写 `input.verify`。
3. **证据封顶**，产出规范化信封 `norm`。Ingress **不改调用方的对象**，而是在需要时浅拷贝出新信封（新 `sender` 对象）：
   - `env.sender.evidence` 不在 `source.evidence` 内 → `norm.sender.evidence = 'none'`；
   - `source.declaresSender === false` 且信封带 `sender.declared` → `norm` 去掉 `declared`。这里把 `caps.declaresSender`（原本定义给出站 `SendOp.as` 与回声识别，`channel.ts` 中 `as` 的注释）**明确扩展为**"该通道是否有资格在入站随附身份"：不能在出站声明身份的通道，入站也不该替别人声明。适配器只能"从它控制的元数据"填这个字段（`inbound.ts` 中 `declared` 的注释）。
   - 未封顶时 `norm === env`，零拷贝。
4. **去重查表**（今天的 `:194-196`），键由 `norm` 计算（与 `env` 相同，因为第 2 步已保证 `channel/account/id` 一致）。
5. `process(norm)`：`identify`、`Origin`、宿主入站队列的 `InboundItem.envelope`、`route` 回调都只看到 `norm`。原始声明的证据只进路由解释（§6 `claimedEvidence`）。
6. 返回值带 `envelope: norm`（`duplicate` 时也带本次的 `norm`）。

来源检查必须在去重之前：否则一条伪造信封只要撞上已见过的 `(channel, account, id)`，就会以 `duplicate` 拿回真实消息的 `inputId`。

`Gateway.accept(env, source)` 改为把 `source` 传给 `ingress.accept`，并用 **`r.envelope ?? env`** 调 `records.recordInput`，保证 `input.verify` 存的是封顶后的值。守护进程在 `startChannels` 的 `emit` 闭包里（`gateway.ts:895-898`）为每个通道构造 `EmitSource` 传入。

`Origin.adapter`（`ingress.ts:239`）在有 `source` 时取 `source.channel`。第 2 步之后它与 `env.channel` 必然相等，保留只作纵深防御。

不传 `source` 的 `accept(env)` 行为与今天逐字段一致，文档写明"调用方即受信方"，兼容现有测试和嵌入用法。

### 5.2 通道 id 的归属

进程内适配器的 id 是代码常量（lark-bot `CHANNEL_ID`，`channel/lark-bot/src/inbound.ts:4`；mail `'mail'`）。bridge 的 id 来自子进程 hello，需要固定并登记归属。

**规则：一个通道 id 只属于一种适配器。** 守护进程启动通道时维护 `id → 归属` 表，归属的定义：

- 内置类型条目（`lark-bot`、`mail`）：归属 = 条目 `type`。内置类型的 id 被**保留**，即使配置里没有启用该类型，bridge 与嵌入方适配器也不得使用。
- bridge 条目：归属 = `bridge:<配置的 id>`，并要求同 id 的所有 bridge 条目 `command`/`args` 相同（同一程序，多个账号）。
- 嵌入方经 `GatewayOptions.channels` 传入的适配器：归属 = 适配器对象本身；同 id 只允许同一个对象。

同 id、不同归属 → 后来者进入 `failed`（`aio status` 的 channels 已有 `state/error`，`gateway.ts:448`），不接管任何入站或出站。同一归属、同 `(id, account)` 重复 → 同样 `failed`。

bridge 的 id：

- 配置条目新增 `id`。设了：每次 hello 的 `adapterId` 必须等于它，否则按 `bad_hello` 处理，杀掉子进程并按现有退避重启（`host.ts:309-311` 的同一分支），日志写明原因。
- 没设（仅第一阶段允许，§8）：第一次成功 hello 的 `adapterId` 被固定，之后换 id 同样按 `bad_hello` 处理；固定时**同样走归属检查**，hello 自称 `lark-bot` 或其他条目的 id 即 `failed`。

这样 §2.3 的三处"不含账号"的键都只会被同一种适配器共享。出站在 `(id, account)` 未命中时退回按 id 匹配（`gateway.ts:693`、`:703`）因此最多落到同一种适配器的另一个账号；这条退路本身是否保留不在本提案范围，见 §10。

### 5.3 证据上限的计算

```
allowed = (entry.evidence ?? 默认) ∩ caps.evidence ∪ {'none'}
默认：进程内适配器 = caps.evidence
      bridge         = caps.evidence（第一阶段，见 §8） → caps.evidence ∩ {'device_only','none'}（第二阶段）
```

- `entry.evidence` 里出现 caps 不支持的值：启动时告警（不是错误，取交集即可）。
- bridge 的 caps 在重启后可能变（`packages/protocol/src/wire.ts:78` 的注释），所以每次 hello 后重算。

### 5.4 可见性

- 拒收与降级都写 `warn` 日志（同一通道同一原因按分钟限流），并在 `aio status` 每个通道上给出计数：`rejected`、`evidenceCapped`（§6，`AdminChannel` 加可选字段）。
- 拒收不产生 session 事件：被拒的信封没有归属的 session，不应往任何人的会话里写东西。

## 6. 对协议、schema、配置的影响

| 位置 | 变化 | 兼容性 |
|---|---|---|
| `packages/protocol/src/host.ts` | `RouteExplanation`（`evidence` 字段旁）增加可选 `claimedEvidence`：仅在被封顶时出现 | 纯增量，未知字段透传 |
| `packages/protocol/src/admin.ts` | `AdminChannel`（`admin.ts:86-92`）加可选 `rejected?: number`、`evidenceCapped?: number` | 纯增量；旧客户端忽略 |
| `packages/protocol` 的 `ChannelContext.emit`、`InboundEnvelope`、JSONL 帧 | 不变；被拒时 bridge 收到的仍是 `result ok:true value {accepted:false}` | — |
| `packages/session` | `Ingress.accept(env, source?)`、`emitter(source?)`、导出 `EmitSource`；`IngressResult` 加可选 `envelope`；`IngressResult.error` 的前缀 `source_mismatch:` 作为**稳定值**写入注释（嵌入方与测试可依赖；不上线协议） | 参数与字段均可选，旧调用不变 |
| `packages/daemon/src/config.ts` | `ChannelCommon`（`config.ts:127-131`）加可选 `evidence: Evidence[]`；bridge 条目（`config.ts:138-150`）加 `id`（第一阶段可选，第二阶段必填，§8） | 第一阶段都可选；条目是 `Closed` 对象，旧配置照常通过 |
| `packages/daemon/src/gateway.ts` | `accept(env, source?)`、用 `r.envelope` 记录；`startChannels` 构造 `EmitSource`；id 归属检查；status 计数 | — |
| `channel/jsonl-bridge` | `BridgeOptions` 加可选 `expectId`；hello 时固定 id | 不设时行为只多一条"id 不许变" |
| 文档 | CHANNELS.md §5 写明 bridge 的 id、归属与证据上限，以及 `accepted:false` 是终态；HOSTS.md §3 写明 `input.verify` 的证据是封顶后的值 | — |

不涉及：`Policy.identify` 签名、身份映射格式、Binding 表、决定 1–6 的任何条款。

## 7. 不做什么

- **不鉴权通道进程本身。** 能改守护进程配置、或以同一用户身份运行的进程，本来就能读 `aio.sock` 的 token 和 SQLite。本提案把一个通道的错误或被攻破**限制在它自己的命名空间**，不是 OS 隔离的替代。
- **不判定身份。** 仍然只提供证据；谁是谁、证据够不够，由身份映射与 `Policy.identify` 决定。
- **不支持跨通道回复路由。** 需要"在 A 通道收、在 B 通道答"的，用 Binding 的 `replyTo` 或宿主 `deliver`，由策略层决定，而不是由信封自称。是否需要为此开口子见 §10。
- **不改身份键。** 身份键不含账号是现有设计（§2.3），本提案靠 §5.2 让它安全，不在这里改它；改不改见 §10。

## 8. 迁移

与 `inheritEnv` 的"先告警、后翻转"不同，**来源检查在第一版就直接拒收**，理由：

- 契约不是新的：一致性套件一直要求 `env.channel === adapter.id`、`env.account === driver.account`（`channel-conformance.ts:73-74`），通过套件的适配器不受影响；仓库内的 lark-bot、mail、e2e 的 `FakeChannel('e2e', …)`（`packages/daemon/src/e2e.ts:171`）都满足。
- 告警窗口内漏洞照旧可用（§2.4），而受影响的只有本来就违反契约的 bridge。
- 发现不合规的 bridge 时，代价是消息被拒并有日志与计数，修法是改一行 `channel`/`account`。

被拒时 bridge 看到的是 `result ok:true value {accepted:false}`（`host.ts:424-425`，经 `serve.ts:83` 解析成 `emit` 的返回值）。约定：**`accepted:false` 是终态，适配器不应重试**；需要重试的瞬时故障仍以抛错表达（bridge 侧为 `ok:false`、`emit_failed`、`retryable:true`，`host.ts:428`）。仓库内适配器已经如此：lark-bot 只在 `emit` 抛错时重试（`channel/lark-bot/src/adapter.ts:260-270`），mail 只在抛错时不推进检查点（`channel/mail/src/adapter.ts:90-92`）。因此不新增 retryable 信号，只在 CHANNELS.md 写明这条约定。

其余分阶段：

1. **第一版：**
   - 来源检查（§5.1 第 2 步）与 id 归属检查（§5.2）直接生效。
   - 证据上限：进程内适配器按 caps 封顶立即生效；bridge 默认仍取自报的 caps，但凡 bridge 的 caps 含 `platform_signed` 或 `dkim_pass` 而配置没写 `evidence`，启动时点名告警："通道 X 自报可提供 platform_signed，下一版起需要在配置中显式授予"。
   - bridge 未配置 `id`：告警"下一版起必填"。
2. **下一版：** bridge 默认上限翻转为 `caps.evidence ∩ {'device_only','none'}`；bridge 条目 `id` 必填。在 DECISIONS.md 记录。

需要强证据的 bridge（例如一个确实校验了平台签名的私有 IM 适配器）只需在条目上写 `"evidence": ["platform_signed"]`。

## 9. 测试

`packages/session/test/ingress.test.ts`：
- `accept(env, source)` 拒收 `channel`、`account`、`replyRoute.channel`、`replyRoute.account` 任一不符的信封，`action:'invalid'`，`error` 以 `source_mismatch:` 开头，不进去重表（同 id 的合规信封随后仍能被接受）。
- 顺序：先用合规信封接受一条，再用同 `(channel, account, id)` 但来源不符的信封调用 → `invalid`，不是 `duplicate`，不返回 `inputId`。
- 证据超出上限降为 `none`：主人条目不再命中，`Origin.principal === null`，`Origin.evidence === 'none'`，路由解释含 `claimedEvidence`，`r.envelope.sender.evidence === 'none'`，且调用方传入的 `env` 未被修改。
- `declaresSender:false` 时 `declared` 被丢弃，`agentAccounts` 里的账号也不能借它随附身份。
- `emitter(source)` 与 `accept(env, source)` 结果一致；不传 source 时行为与今天逐字段一致（回归）。

`packages/daemon/test/gateway.test.ts`：
- 两个通道（一个 `FakeChannel('lark-bot')`、一个 `FakeChannel('web')`），从 `web` 的 `emit` 发出 `channel:'lark-bot'` 的主人消息 → 拒收、主人 lane 不存在、`input.verify` 查不到、status `rejected` +1。
- **bridge 的 hello `adapterId = 'lark-bot'`、账号 `'x'`**（与已运行的 lark-bot 账号不同）→ 该 bridge 进入 `failed`，其入站不被接受，`input.verify('channel:lark-bot/<id>')` 不含它的记录，`deliver` 到 `lark-bot` 任一账号都不走它。
- 两个不同 bridge 程序配置同一 `id` → 后者 `failed`；同一 bridge 程序两个账号 → 都运行。
- 证据被封顶时，`input.verify` 返回的记录 `evidence === 'none'`（验证 `Gateway.accept` 记录的是 `r.envelope`）。
- 配置 `evidence` 与 caps 取交集；caps 外的值告警；status `evidenceCapped` 计数。

`channel/jsonl-bridge/test/bridge.test.ts`（用现有 `raw_child.mjs` fixture）：
- 配置 `id` 与 hello 的 `adapterId` 不符 → `bad_hello`、重启；
- 未配 `id` 时第二次 hello 换 id → 拒绝；
- 被拒的入站：子进程收到 `ok:true`、`{accepted:false}`。

`packages/testkit`：一致性套件已有 `inbound.channel_id`/`inbound.account`；增加 `inbound.evidence_in_caps`（发出的证据必须在 `caps.evidence` 内），让适配器作者在本地就发现问题。

`packages/daemon/test/config.test.ts`：新字段的解析、旧配置不变。

## 10. 待定

1. 第二阶段 bridge 的默认上限是否保留 `device_only`。保留的理由：它不会命中默认身份条目（`identity.ts:21`），只是额外信息；去掉的理由：更简单。
2. 是否存在合理的"信封自带跨通道 `replyRoute`"用例（例如会议转写通道把纪要回到 IM 群）。若有，可以在通道条目上加 `replyChannels: string[]` 白名单；本提案默认不开。
3. 被拒信封是否要进宿主入站队列供审计。本提案倾向不进：它不属于任何绑定，日志和计数足够。
4. **身份键是否应含账号。** 飞书的 open_id 按应用区分（ops-security §2"飞书 ID 有作用域"，`docs/critique/ops-security.md:56`，那里建议多应用部署以 union_id 为键），同一个人在两个 lark-bot 账号（两个应用）下 open_id 不同，同一个 open_id 也只在一个应用内有意义。今天 `identityKey` 不含账号（`identity.ts:34`），多账号飞书部署要么为每个账号重复写身份条目，要么依赖 open_id 在应用间不碰撞。改为 `${channel}:${account}:${channelUserId}`（或允许条目可选限定账号）会改变身份映射格式，超出本提案，建议单独讨论；本提案的 §5.2 已保证"同 id 只属于同一种适配器"，所以这个问题只涉及同一种适配器的多账号，不再是跨通道冒充。
5. 出站在 `(id, account)` 未命中时按 id 退回（`gateway.ts:693`、`:703`）是否保留。§5.2 之后它只会选到同一种适配器的另一个账号，不再跨通道；但以错误的机器人账号发消息可能仍不符合部署方预期。

## 11. 体量

- `Ingress`：`accept` 一个可选参数、`IngressResult` 一个可选字段，约 40 行检查与拷贝。
- `Gateway`：`accept` 透传来源并记录规范化信封；id 归属表；两项计数。
- 配置：两个字段。
- bridge：hello 时比较 id。
- 协议：`RouteExplanation` 一个可选字段，`AdminChannel` 两个可选字段。
