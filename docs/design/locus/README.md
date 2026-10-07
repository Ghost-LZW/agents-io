# 智能在哪、谁拉起 agent：五个方案与推荐

> 状态：决策稿（2026-10-07）。同目录 A–E 是五个方案按最强形态写的论证，本文汇总三位评审（可复用性 / x-work-os 契合 / 安全运维）的意见，给出推荐和待拍板的决定。
> 依据：`docs/POSITIONING.md`、`docs/HOSTS.md`（草案）、`packages/protocol/src/{policy,host,watch,harness,channel}.ts`、`packages/session/src/{ingress,policy,lane,watch}.ts`，x-work-os 提案 0001r1 / 0003 / 0006 / 0008 / 0010。

## 1. 问题重述

用户的原话可以拆成三个问题：

1. **谁拉起 agent？** 是 agents-io 自己 spawn/resume Claude Code、Codex，还是宿主拉起，agents-io 只管收发？
2. **谁决定哪些消息唤醒哪个 agent、哪个 agent 监听哪些消息？** 这件事放在 agents-io 里（配置或表），还是放在宿主里（宿主过滤后再喂进去）？
3. **智能来源在哪？** 是宿主做大脑、agents-io 只做 IO？还是 agents-io 本身就是 agent，只是 IO 范围比 Claude Code、Codex 宽，宿主把它当成一个好用的 agent？

今天的代码其实已经站在两边：`Policy.admit` 的默认实现和 `ownerSessionKey: "main"`（`session/src/policy.ts`）让 agents-io 自己决定唤醒谁；HOSTS.md §3.2 又让每条消息同步回调宿主（3 秒超时，fail closed）。另外有两处真实缺口：`Admission.action: 'host'` 在 `ingress.ts` 里没有处理分支，会落进 dispatch（ingress.ts:229 只区分 observe 和其他）；`actionClick` 只认 `req:` 和 `turn:` 前缀（ingress.ts:19、35），宿主卡片上的按钮点击会被当成 unknown_request。

## 2. 五个方案

**A 纯 IO 总线（A-io-bus.md）。** 一句话：agents-io 只搬运消息，从不自己决定打开 harness。智能在宿主和宿主打开的 harness 里。只有宿主能 `endpoint.open` 拉起 agent。路由是宿主装进来的订阅和 pipe：
```jsonc
{"type":"endpoint.open","endpoint":"coder","run":{"harness":"codex","profile":"restricted"},"as":"agent:coder"}
{"type":"pipe","from":"in/lark-bot/default/oc_grp1","to":"ep/coder","filter":{"mentions":["agent:coder"]},"mode":"trigger","maxHops":2}
```
无宿主的 S1 要靠一个随附的默认宿主进程 `hosts/personal`。

**B agents-io 是智能来源（B-agent-service.md）。** 一句话：agents-io 对外就是一组有名字的 agent，宿主只声明、委托、订阅。智能在 agents-io，包括 persona 和可选的 arbiter 模型路由。agents-io 拉起 agent。路由写在声明式 agent 表里：
```jsonc
"me": {"harness":"claude","persona":"personas/me.md","session":"per-principal",
       "listen":[{"channel":"lark-bot","kind":"dm","from":"owner"}],"see":[{"conversation":"oc_team","mode":"digest","every":"1h"}]},
"xwo-executor": {"mode":"task","harness":"codex"}          // 宿主用 agent.run 调用；配置加载时禁止任何 listen 指向它
```

**C 拉起是机制，唤醒谁是策略（C-mechanism-policy.md）。** 一句话：agents-io 负责拉起和运行（harness、lane、审批、渲染），"哪条输入唤醒哪个 agent"写在一张可替换的 Binding 表里。智能来自模型；判断叫醒谁属于策略层。agents-io 拉起 agent，触发方式有三种：输入、宿主 `run.start`、定时。路由由 `WatchSource/WatchFilter` 推广而来：
```jsonc
{"id":"g-coder","match":{"account":"lark-bot:coder","conversation":"oc_dev","mentions":["@self"]},"agent":"coder","on":"dispatch"}
{"id":"g-ctx","match":{"conversation":"oc_dev"},"agent":["coder","reviewer"],"on":"context"}
{"id":"xwo","match":{"action":"xwo:*"},"on":"host"}
```
宿主有四档覆盖方式：T1 配置、T2 `bindings.put` 推表、T3 逐条 admit 回调、T4 `on:host` 后自己处理。

**D 两个产品两套协议（D-two-layers.md）。** 一句话：拆成 aio-io（通道、身份证据、确定性路由、可重放入站流）和 aio-runtime（harness、session、lane），中间是线协议。智能在哪由每条路由的 `to` 决定。只有 runtime 拉起 agent。路由例子：
```jsonc
{"id":"eng-coder","match":{"conversation":"oc_eng","mentions":["bot:coder"]},"to":"rt:agent/coder","delivery":"trigger"}
{"id":"xwo-actions","match":{"event":"action","actionPrefix":"xwo:"},"to":"host:xwo","delivery":"trigger"}
// 宿主：io.hello{from:{cursor}} → io.input{seq} → io.ack，至少一次投递
```

**E 一切皆端点（E-everything-is-endpoint.md）。** 一句话：人、agent、宿主都是总线端点，路由是一张订阅表，智能是端点的属性。给 agent 端点投一条 trigger 消息就等于拉起它，宿主也可以用 `ep.spawn` 拉起。路由例子：
```jsonc
{"endpoint":"coder","topic":"ch/lark-bot/*/oc_dev","when":{"mentionsMe":true},"mode":"trigger","fromAgents":{"allow":true,"maxHops":3}}
"xwo":{"kind":"host","grants":["spawn{maxProfile:restricted}","subscribe:app/xwo/*","resolve:app/xwo/*"]}
```

## 3. 对比

| | A 纯总线 | B agent 服务 | C Binding 表 | D 两层两协议 | E 全端点 |
|---|---|---|---|---|---|
| S1 个人助手 | 需要默认宿主进程；宿主一崩，审批和表外 identify 都停 | 最顺：一份配置，进程内路由 | 两条 binding 指向 `assistant/main`，和今天一样 | `aio serve` 合并部署，可用 | 可用，但用户得先懂端点和话题 |
| S2 x-work-os | 执行器不挂 pipe，结构上推不进去；但每个入站决定都要宿主在线 | `mode:task` 从结构上禁止推送；但 persona、owner 判定成了第二份真相 | `run.start{agent}` 加 `on:host` 加扇出，可以覆盖；T3 有丢回答风险 | 可重放入站流加 ack，唯一满足 0003 §4.8"不丢记录" | `lifetime:turn` 可用；human inbox 与 0006 收件箱冲突 |
| S3 旁听汇总 | digest pipe；`watch_add` 要宿主审批往返 | `see` 的 digest | `on:digest` binding | 运行时侧 digest，跨两层 | digest 订阅，明确按污染降档 |
| S4 多 agent | maxHops 可测；没 @ 任何人时要回宿主 | hop 预算；arbiter 用模型选人，不可复现 | 按 agent 认 self，加 hop，修掉今天 selfAccounts 一律丢弃 | 防环放在 IO 层，可跨机器 | L1–L6 最完整，但 grant 最复杂 |
| S5 会议 | 打断写成 pipe 硬编码 | 进程内，延迟最低 | context 加 mention dispatch；语音是另一个 harness | 打断多一跳跨进程 | 实时语音可作为平级端点，表达最强 |
| S6 非 TS 团队 | 最自然，但会话生命周期每队重写 | 复杂路由要走 `onUnmatched:host`，退化成 A | 写 JSON 表加 `bindings.put`，复杂的用 `on:host` | 能只取一半，但目前没有这种用户 | 能做，概念门槛高 |
| 复用性（评审 1） | 6：边界最干净，但 pipe 就是没承认的 Binding 表 | 5：产品口味进了协议，冻不住 | **7**：增量最小，路由来源要砍到一个 | 5：两套 schema，稳定成本翻倍 | 4：概念最多，成了第二套成员和权限系统 |
| x-work-os 契合（评审 2） | 5：宿主不在线就丢回答 | 5：身份两份，判断不可重放 | **7**：T3 和长会话要收紧 | 6：入站流契约最对，拆包无增益 | 4：两个收件箱 |
| 安全运维（评审 3） | 5：删 plan 后无逐轮降档，有注入风险 | 4：模型路由加宿主写工具，注入可写权威状态 | **7**：保留 plan 和 resolve；要 explain 和 TTL | 5：出站和审批授权跨进程劈开 | 6：防环最强，授权面最大 |
| 改动量 | 大：ingress 改 publish，策略搬家 | 大：改定位，加 router 和 persona | **小到中**：deliveries、binding 求值、host 分支 | 最大：session 包拆两半 | 中到大，可渐进 |
| **三评审合计** | 16 | 14 | **21** | 16 | 14 |

三位评审各自独立给出的最佳组合几乎一致：**以 C 为骨架，用 A 的纪律删掉路由里的智能，入站给宿主改用 D 的可重放流，再拿 B 的 `mode:task` 和 E 的 cause、attest、污染降档。不拆包，不做纯总线，不用 grant 系统。**

## 4. 推荐：C 骨架 + 五条硬规则

1. **拉起只在 agents-io。** agents-io 是唯一 spawn、resume harness 的地方，因为 lane、steer、审批按钮、compositor、admitted≠consumed 对账都要和 harness 在同一进程（C §2）。宿主从不直接 spawn，否则每个 S6 团队都要重写 lane。`agents` 段只存命名的 RunSpec 默认值：harness、model、profile、cwd、发言账号、工具白名单、instructions 文件路径。不加 persona 概念，路由里也不调模型。
2. **路由只有一张确定性的 Binding 表。** match 字段固定为 channel、account、conversation、kind、from-labels、authorKind、mentions、keywords、actionPrefix，不支持 OR、正则、时间窗。`on` 取 `dispatch | context | digest | host | drop`。所有命中的规则都生效（扇出），同一 `(agent, session)` 取最强的动作。表的来源只有两个：本地配置，或宿主用 `bindings.put {version, bindings}` 原子替换整表。删掉逐条 admit 回调（C 的 T3）。需要语义判断的消息走 `on:host`，宿主判断后再 `input` 或 `run.start` 回来，延迟由宿主承担。`watch_add` 就是 agent 在运行时新增一条 binding，由 `Policy.watch` 批准。
3. **宿主的入站是可重放流，不是同步回调。** `on:host` 的输入写进持久化流，带 seq、渠道引用、证据和原样的 declared。宿主按 cursor 拉取，处理完 ack，至少一次投递，幂等键是 `channel:lark-bot/<msgId>`。宿主不在线时只增加延迟，不丢记录（0003 §4.8）。必须当场回答的同步回调只剩 `resolve` 和 `outbound`，都 fail closed。宿主卡片点击靠 `host.hello.actionPrefixes`（或配置里的 `actionPrefix` binding）分流，不再走 `hub.locate`。
4. **两种 session 用类型隔开。** `mode: task` 的 agent（x-work-os 执行器）只能经 `run.start` 启动，每次新开 `run:<runId>`，没有 lane 输入口；配置加载时，任何 binding 指向它都报错（借 B）。交互 agent（个人助理、讨论 agent）可以有长会话，但会话可以丢弃，agents-io 不存长期记忆。
5. **安全与可观测是上线门槛。** (a) 污染降档：一轮的 profile 取本轮 prompt 里所有输入的最弱档，包括 context、digest、observed，不只看触发输入（今天 policy.ts:113-121 只看 `turn.inputs`）。(b) 防环：self 按 agent 认（`Identity.selfAgent`），outbox 用 `providerMessageId` 认回作者，出站带 `cause{root,hops}`，hops 到上限就降级为 context 并通知人；只有 `agentAccounts` 里的 declared 才被采信。(c) 宿主写命令（x 工具）只挂给 task 轮次或全部输入都来自主人的轮次。(d) agents-io 提供 `input.verify`（即 E 的 `msg.attest`），只出证据，不下"他是不是成员"的结论。(e) 每次入站记下命中的 binding id、来源层、表版本、hop 和最终 profile，交付 `aio explain <inputId>`。

**各场景走一遍。** S1：`agents-io serve` 加两条 binding，不需要宿主进程。S2：执行器用 `aio run --agent executor-codex`（即 `run.start`），阻塞到退出码；提问用 `aio send`，按钮 id 为 `xwo:ask-<n>:<opt>`；接收程序跑 `aio tail --consumer xwo` 并调用 `x answer` 或 `x input add`，成功后 ack。讨论群同一条消息扇出给 discussant（dispatch）和 host；确认时 x-work-os 用 `input.verify` 核对作者。S3：digest binding，按污染降档到 restricted，回复发到主人私聊。S4：按 agent 认 self，加 hop 预算。S5：context 加 mention dispatch；实时语音是另一个 harness 适配器，和路由无关。S6：写 JSON 表加 JSONL，附一个约 100 行的 Python 参考宿主作证明。

**对三个问题的直接回答。**
- **谁拉起 agent：agents-io。** 宿主可以命令它拉起（`run.start`），但宿主从不自己 spawn。
- **谁决定哪些消息唤醒谁：** 决定权属于部署者或宿主，表达形式是一张确定性的 Binding 表，由 agents-io 执行。表里放不下的判断，用 `on:host` 交给宿主。agents-io 不在路由里调模型。用户问的"agent 监听哪些消息"和"宿主过滤什么消息拉起什么 agent"是同一张表：宿主在表里也只是一个可以被投递的目标（`on:host`）。
- **智能来源：模型，加上宿主的权威状态。** agents-io 不是大脑，但也不是哑管道，它是"神经加肌肉"。没有宿主时，它看起来就是一个 IO 范围很宽的 agent，这是默认 Binding 表的效果，不是架构立场。有宿主时，宿主把它当成"会驱动 Claude Code/Codex 的 IO 层"。所以两种用法都成立，代码上是同一套机制。

**为什么不选其他方案。** A 把会话生命周期推给每个宿主，宿主在线成了必要条件，S1 也要多一个进程，而且 hosts/personal 最终会长成 B。B 把产品口味（persona、arbiter）放进对外协议，身份又多出一份，路由也无法从事件重放。D 在只有一个使用者时就冻结两套协议，授权被劈成两半。E 让 agents-io 成了第二个成员和权限系统。这些方案里各有一块好东西，推荐已经吸收进来。

## 5. 需要你拍板的决定

**决定 1：x-work-os 怎么接，常驻宿主连接还是进程适配器加入站流？**
- 选项 a：照 HOSTS.md，x-work-os 维持常驻 socket 宿主，同步收 `inbound`。
- 选项 b：x-work-os 不常驻，只用三个 CLI 适配器：`aio run`、`aio send`、`aio tail --consumer`（后者带 cursor 和 ack）。
- **建议 b。** 0003 §4.8 否决了"常驻、监听、鉴权的网络服务"，0008 §148 不定义接收程序；选项 a 在宿主重启时会丢掉主人点的回答。socket 帧保留给需要常驻的 S6 宿主，两者共用同一个流和 cursor。

**决定 2：路由真相有几个来源？**
- 选项 a：配置、`bindings.put`、逐条 admit 回调三层都要（C 原样）。
- 选项 b：只要配置和 `bindings.put`，删掉逐条回调，复杂判断走 `on:host` 再回注。
- 选项 c：同 b，但允许单条 binding 显式打开 `admit: host` 回调，会议类 binding 禁用。
- **建议 b。** 同时规定：宿主推的表带 `ttl`，每条 binding 写 `onHostDown: keep | suspend`，宿主推来的默认 suspend，本地配置的默认 keep。等真有用户证明 b 不够，再加 c。

**决定 3：成员和身份的真相放在哪？**
- 选项 a：agents-io 维护通用的 principals 目录（B、E 的做法）。
- 选项 b：agents-io 只给渠道身份和证据，加一张本地 `labels` 表（`owner` 等），只给本地 binding 匹配用。交给宿主的输入不做成员解析，由宿主按自己的绑定判定（0010 §4.3）。
- **建议 b。** 有宿主时成员表只有一份；无宿主时只要一张 owner 绑定表。出站的 `as` 原样透传 `runner:<id>/run:<ref>`，agents-io 不解释它。

**决定 4：被群消息唤醒的交互 agent 能不能拿宿主写工具？**
- 选项 a：可以，靠 `input.verify` 事后核对。
- 选项 b：不能。宿主写工具只挂给 task 轮次，或全部输入都来自主人的轮次；其他轮次只能发 notice 或经 `on:host` 提议，确认由宿主核验消息作者。
- **建议 b。** 评审 3 指出，选项 a 下 agent 可以拿一条真实的主人消息去确认另一个决定。讨论 agent 的写操作因此变成两步：先提议，再由主人消息加宿主核验完成。

## 6. 采纳推荐后的改动清单

**protocol**
- `policy.ts`：`Admission` 改为 `{ deliveries: Delivery[]; host?: boolean }`，旧字段兼容一版；删除二选一的 `'host'` action；加 `Identity.selfAgent`；`TurnDraft` 带上 `agent` 和本轮的 context 输入，供 plan 做污染降档。
- 新增 `binding.ts`：`AgentDef`（含 `mode: 'interactive' | 'task'`）、`Binding`、`BindingMatch`、`onHostDown`；`watch.ts` 的 `Watch` 变成"agent 运行时创建的 Binding"的别名。
- `host.ts`（未提交草案）：`host.hello` 去掉 `admit/plan/triage/identify` 钩子，加 `actionPrefixes`；新增 `bindings.put/get`、`run.start.agent`、`inbound.subscribe{consumer,cursor}`、`inbound{seq}`、`ack`、`input.verify`；保留 `deliver`、`input`、`resolve`、`run.ended`。
- `scripts/emit-schema.mjs`：产出一套 `host.v1` schema，包括 binding；`packages/testkit` 加一致性套件；新增 `examples/host-python/`（约 100 行）。

**session**
- `ingress.ts`：admission 改成按 deliveries 循环；补上 `host` 分支（今天落进 dispatch，:229）；按钮先查 actionPrefix 再查 hub（:19/:35/:211）；入站盖 `cause{root,hops}`；`seen`（:105 的内存 Map）改为持久化入站流，带 consumer cursor。
- `watch.ts`：求值器抽成通用 binding 求值器，复用匹配、按 `providerMessageId` 去重、digest 计时；加 hop 降级。
- `policy.ts`：`defaultPolicy.admit` 改为对 binding 表求值；`ownerSessionKey` 迁移成一条默认 binding；`identify` 按 agent 区分 self，不再把 selfAccounts 一律丢弃；`plan`（:113-121）改为取所有进 prompt 的输入里最弱的档。
- `lane.ts`：task agent 不建 lane 输入口；observed 输入进 prompt 时参与降档。
- outbox：记录 `providerMessageId → agent`，用于回流时认回作者。
- 记录每次准入的 `bindingId / layer / tableVersion / hop / profile`，实现 `aio explain`。

**host-mcp、CLI、示例**
- `packages/host-mcp`：宿主写工具按决定 4 的规则挂载；`watch_add` 改为新增 binding。
- CLI：`aio run`、`aio send`、`aio tail --consumer`、`aio ack`、`aio explain`、`aio verify`。
- `examples/dev-gateway`：配置加 `agents`、`bindings` 两段，`defaultHarness` 改为默认 agent；顶层 `watches` 并入 bindings。

**docs/HOSTS.md**
- §1：写明"宿主是 Binding 表的所有者和 `on:host` 的消费者，不在热路径上"。
- §2：删掉"宿主断开退回默认策略"；改为已装的表按 `onHostDown` 运行，`on:host` 的输入在流里排队。"至多一个宿主"放宽为一个表所有者加多个流消费者。
- §3.1：钩子只剩 `resolve`、`outbound`，加 `actionPrefixes`。
- §3.2：删掉 identify、admit 等同步回调和"admit 超时当作 drop"。
- §3.3：用可重放入站流（cursor、ack、幂等键）替换 `inbound` 帧加 `accepted`。
- §3.4：`run.start` 加 `agent?`，写明 task agent 不接受推送。
- 新增 `bindings.put` 和 `input.verify` 两节。
- §4：把 x-work-os 例子改写成三个 CLI 适配器加 `aio tail`。

**docs/POSITIONING.md**
- §2 表第一行改为"agents-io 执行 Binding 表；表的内容是策略，属于部署者或宿主"。判据补一句："路由里不调模型。"
