# 方案 E：一切皆端点（对称 pub/sub 总线）

> 状态：讨论稿（2026-10-07），供"智能在哪、谁拉起 agent"的选型对比。本文按最强形态论证，§8 列真实弱点。
> 依据：`docs/POSITIONING.md`、`docs/HOSTS.md`、`docs/CHANNELS.md` §6–7、`packages/protocol/src/{policy,host,watch,inbound}.ts`、
> x-work-os 0001 §4.2/§4.4.7（"成员是人或 agent，二者使用同一协议"）、0003 §4.6、0006 §4.6–4.7、0010 §4.2/§4.7/§4.8。

## 0. 一句话

**agents-io 是一条带身份的消息总线：人（经通道）、agent（经 harness）、宿主（经 socket）都是总线上的端点；"谁听哪些消息、哪些消息叫醒谁"是一张订阅表；智能是端点的属性，不是层的属性。**

用户的二选一（"宿主是智能、agents-io 只管 IO" vs "agents-io 是 IO 范围更广的 agent"）在 E 里不是架构决定，而是**两种配置**：
- 只有宿主端点订阅全部通道话题、自己 `spawn` 一次性 agent → 等价于"宿主是智能来源"（x-work-os 的用法）。
- 没有宿主，只有配置里常驻的 agent 端点订阅主人的话题 → 等价于"agents-io 是一个很方便的 agent"（个人助理）。
E 的主张是：这两者本来就该是同一套机制的两个取值，今天代码里已经有三份重复的"订阅"（`Policy.admit`、`Watch`、Hub 输出订阅），E 把它们合成一个。

## 1. 四个概念

| 概念 | 是什么 | 今天对应 |
|---|---|---|
| 端点 Endpoint | 有 id、有身份、能收能发的参与者。`kind: human \| agent \| host \| external` | `Principal`、session、host 连接、未知发送者 |
| 话题 Topic | 一条有序消息流，带名字 | 通道会话（routeKey）、session 事件流 |
| 消息 BusMessage | 总线盖章过作者与因果链的统一信封 | `InboundEnvelope` + `Origin` + `InputRecord` |
| 订阅 Subscription | "端点 X 以模式 M 接收话题 T 上满足 F 的消息" | `Admission`、`Watch`、Hub `subscribe` |

**话题命名**（全部是字符串，支持 `*` 通配）：
- `ch/<channel>/<account>/<conversation>[/<thread>]`：通道会话，例 `ch/lark-bot/default/oc_team`、`ch/mail/me@x.com/inbox`。
- `ep/<endpoint>`：直达某个端点的私信箱（发给 agent = 叫醒它；发给人 = 按其偏好路由投递）。
- `sess/<sessionKey>`：agent 端点的过程事件流（今天 Hub 提供的 `SessionEvent`，终端 attach 就是订阅它）。
- `app/<host>/...`：宿主自定义话题，例 `app/xwo/asks/ask-123`（卡片按钮的回流去处）。

**端点的"收"由 kind 决定实现**，这是 E 的核心统一：

| kind | 收到 trigger 消息时总线做什么 | 发出 |
|---|---|---|
| agent | 进该端点的 lane（queue/steer/interrupt 照旧），必要时 `HarnessAdapter.open`，开一轮 | 回答、输出工具调用 → `pub` |
| human | 按端点的 `inbox` 偏好选路由，经通道渲染投递（tier、卡片、outbox 照旧） | 渠道消息，经 `identify` 绑定成该端点 |
| host | 发 `deliver` 帧到宿主 socket，宿主 `ack` 后才算送达（at-least-once） | 任何 `pub` / 控制帧 |
| external | 不可订阅；只是作者 | 渠道消息，作者标 external |

"拉起 agent"因此不是单独的 API：**给 agent 端点投一条 trigger 消息就是拉起它**。lane、合批、steer、admitted≠consumed 全部保留，只是入口统一了。

## 2. 消息与订阅的类型

```ts
interface BusMessage {
  v: 1; id: string; topic: string; ts: number;
  kind: 'say' | 'event' | 'request' | 'resolve' | 'notice';
  author: { endpoint: string | null; kind: 'human'|'agent'|'host'|'external'|'system';
            evidence: Evidence; channelUserId?: string };      // 总线盖章，端点不可自填
  onBehalfOf?: string;            // 仅持 speakFor:<ep> 授权的宿主可填，且原作者保留
  to?: string[];                  // 显式收件端点（@ 解析而来，或 pub 时指定）
  cause: { root: string; parent?: string; agentHops: number; path: string[] };
  content: ContentBlock[];        // common.ts 原样
  replyTopic?: string;            // 回复/按钮点击回到哪个话题（默认 = 本话题）
  request?: { requestId: string; addressees: string[]; options?: string[] };  // kind=request
  channelRef?: { channel: string; messageId: string };  // 0010 §4.4 的渠道引用
}

interface Subscription {
  id: string; endpoint: string; topic: string;            // 可通配
  when?: { authors?: string[]; authorKinds?: Origin['kind'][]; mentionsMe?: boolean;
           keywords?: string[]; kinds?: BusMessage['kind'][] };
  mode: 'trigger' | 'context' | 'digest' | 'deliver';     // deliver = 原样转给 host/human
  digest?: { everyMs: number; maxItems?: number };
  fromAgents?: { allow: boolean; maxHops?: number };      // §4 防环
  gate?: string;                                          // 语义闸门端点（今天的 Policy.triage）
  createdBy: string; expiresAt?: number;
}
```

`Watch`（`watch.ts`）就是 `mode ∈ {context,digest,trigger}` 且 `topic` 不属于目标端点的 Subscription；`Admission.dispatch` 就是"默认订阅表命中了 trigger"；`Admission.host` 就是 `mode: deliver` 给宿主端点。

## 3. 路由的表达（配置 + 动态帧）

```jsonc
// agents-io.json —— 个人部署，无宿主
{
  "endpoints": {
    "owner":     { "kind": "human", "bindings": [{ "channel": "lark-bot", "user": "ou_owner" },
                                                  { "channel": "mail", "user": "me@x.com" }],
                   "inbox": { "push": ["ch/lark-bot/default/dm:ou_owner"], "fallback": ["ch/mail/me@x.com/*"] } },
    "assistant": { "kind": "agent", "harness": "claude-main", "session": "persistent",
                   "run": { "model": "opus", "profile": "bypass" } }
  },
  "subscriptions": [
    { "endpoint": "assistant", "topic": "ch/lark-bot/*/dm:*",  "when": { "authors": ["owner"] }, "mode": "trigger" },
    { "endpoint": "assistant", "topic": "ch/mail/me@x.com/*",  "when": { "authors": ["owner"] }, "mode": "trigger" },
    { "endpoint": "assistant", "topic": "ch/lark-bot/*/oc_team", "mode": "digest",
      "digest": { "everyMs": 3600000, "maxItems": 30 } }
  ],
  "loops": { "agentHopsPerRoot": 2, "triggersPerRootPerEndpoint": 3 }
}
```

动态帧（JSONL，同一 unix socket，任何语言）：

```jsonc
{"type":"bus.hello","id":"1","endpoint":"xwo","token":"…"}
{"type":"ep.spawn","id":"2","endpoint":{"id":"run:R1","kind":"agent","harness":"codex","lifetime":"turn",
   "cwd":"/work/t17","env":{"XWO_CREDENTIAL_FILE":"/run/xwo/c1"},"run":{"model":"…","profile":"restricted"}}}
{"type":"pub","id":"3","msg":{"topic":"ep/run:R1","kind":"say","content":[{"type":"text","text":"Read .brief.md"}]}}
{"type":"sub","id":"4","sub":{"endpoint":"xwo","topic":"app/xwo/asks/*","mode":"deliver"}}
// 总线 → 宿主
{"type":"deliver","id":"d9","sub":"…","msg":{ /* BusMessage */ }}      // 宿主回 {"type":"ack","id":"d9"}
{"type":"ep.retired","endpoint":"run:R1","status":"completed","exitCode":0}
{"type":"msg.attest","id":"5","msgId":"m_77"}  // 查询某条消息的作者与证据（给 0010 §4.8 用）
```

## 4. 防环（最强形态）

对称总线最大的风险是 agent 互相叫醒。规则全部由总线机械执行，不靠模型自觉：

1. **L1 不自激**：作者端点永远不被自己的消息 trigger；本部署发出的消息回流时按 outbox 的 `providerMessageId` 认回作者（不依赖元数据，比 `Origin.self` 更硬）。
2. **L2 因果跳数**：每条消息带 `cause`。人或外部人类发的消息开新 root、`agentHops=0`；端点在一轮里发出的消息继承该轮输入的 root，`agentHops+1`。订阅默认 `fromAgents.allow=false`：agent 写的消息对它只是 context。显式允许时 `agentHops < maxHops`（默认 2）才 trigger，否则降级为 context。
3. **L3 路径回访**：`cause.path` 已含目标端点时默认不 trigger（阻断 A→B→A）；需要"coder↔reviewer 来回修"的订阅写 `fromAgents.maxHops: 4`，由 L2 兜底。
4. **L4 预算**：每 root 每端点最多触发 N 轮（默认 3），每端点每分钟全局限速。超预算的消息降级为 context，并向 root 作者（通常是人）的 `ep/` 发一条 `notice`："循环在 reviewer 处被截断"。
5. **L5 外部机器人**：没有总线因果链的 bot（别家系统）作者 `kind=external`、`isBot`，默认不 trigger；即使允许，也算 `agentHops=maxHops-1`，只能叫醒一次。
6. **L6 digest 不放大**：digest 轮次的产出只发往订阅端点的 `inbox`/主话题，不发回被监听话题（沿用 CHANNELS.md §6"永远不会回到被监听的那个会话"）。

## 5. 权威（谁能做什么）

- **作者认定是总线唯一的硬职责**。`identify`（bindings 表或宿主回调）把渠道账号映射成端点；文本自称不改变作者；agent 端点共用一个 bot 账号时，作者由总线自己的 outbox 记录认定（0010 §4.2 "随附行动者"由总线代办，且不可伪造）。
- **代理不升权**：agent 发的消息永远是 agent 作者，哪怕内容是"主人说同意"。`onBehalfOf` 只给持 `speakFor` 授权的宿主，且原作者仍在消息里。这正是 0010 §4.8 的要求，`msg.attest` 让宿主可以核验。
- **授权是端点上的 grant**，根权威是部署配置（主人），可委托：
  `publish:<topic>`、`subscribe:<topic>`、`trigger:<endpoint>`、`resolve:<request-pattern>`、`spawn{maxProfile}`、`speakFor:<ep>`、`bind`。
  例：`"xwo": { "kind": "host", "grants": ["spawn{maxProfile:restricted}", "subscribe:app/xwo/*", "publish:ep/*", "resolve:app/xwo/*"] }`。
- **订阅只给读**：订阅一个话题不给在那里发言的权限（今天的 `Policy.outbound` 变成 `publish` grant 检查）。
- **污点传播**：一轮的 profile = 本轮输入作者里最弱者对应的 profile（今天默认 `plan` 的一般化）；digest 系统输入取被汇总作者里最弱者。
- **请求**：`kind=request` 带 `addressees`；只接受 addressees 的 `resolve`，先到者胜，其余返回 `already_resolved`（0010 §4.7 / 0006 [ask.events]）。

## 6. 场景

**S1 个人助理（无宿主）**。端点 `owner`（human，飞书+邮箱绑定）、`assistant`（agent，常驻 session）。飞书私聊消息 → 通道适配器 → `identify` 认成 `owner` → 话题 `ch/lark-bot/default/dm:ou_owner` → 订阅命中 trigger → `assistant` lane 开一轮 → 回答 `pub` 到 `replyTopic`（同一私聊），卡片流式渲染照旧。邮件同理，进同一个 `assistant`（一个 session、两条话题），回复回各自话题。没有宿主时 E 的配置就是今天 dev-gateway 默认策略的展开，零新组件。

**S2 x-work-os**。`xwo` 以 host 端点连接，持 `spawn` / `resolve:app/xwo/*` 授权。
- 执行：runner 的 start-executor 适配器（Go 薄客户端）发 `ep.spawn{lifetime:"turn"}` + `pub ep/run:R1`；一轮结束收 `ep.retired` 映射成退出码。执行器只经 x-work-os 命令输出（0003 §4.6），总线不解析最终文本；**总线从不往 run:R1 推第二条消息**——它是 `lifetime:"turn"`，没有任何订阅。
- 提问：执行器调 `xwo ask`（权威在 x-work-os），to-human 适配器 `pub` 到 `ep/owner`，`kind=request`、`addressees:["owner"]`、`replyTopic:"app/xwo/asks/ask-123"`。总线按 `owner.inbox` 投飞书卡片。主人点按钮 → 通道产生 action → 作者认定为 `owner`（platform_signed）→ `resolve` 消息进 `app/xwo/asks/ask-123` → `xwo` 订阅 `deliver` → 写 `answer`（行动者=owner，渠道引用=`channelRef`）后 `ack`。下一次运行的 brief 带回答（0006 §4.7）。别人点了：不在 addressees，总线拒绝，或按 0010 §4.7 作为普通 `say` 转给 xwo 记 `input add`。
- 讨论会话：常驻 agent 端点 `discuss` 订阅群话题（`mentionsMe` trigger，其余 context）。主人在群里说"就按方案二"→ `discuss` 调 `xwo facts confirm --ref m_77`；xwo 用 `msg.attest m_77` 核验作者是绑定成员 `owner`，才记确认。agent 无法把别人的话归给主人（§5 代理不升权）。

**S3 监听汇总**。两条 `digest` 订阅：`ch/lark-bot/*/oc_team` 与 `ch/mail/me@x.com/inbox`（后者要用主人身份登录的邮件通道，CHANNELS.md §6 平台前提），目标 `assistant`，`everyMs: 3600000`。每小时总线排一条 system 输入开一轮，profile 取被汇总作者里最弱者（restricted）；产出发到 `ep/owner`（按 inbox 推送），不发回群（L6；且 `assistant` 没有 `publish:ch/.../oc_team`）。

**S4 双 agent 同群**。端点 `coder`（codex）、`reviewer`（claude），订阅：
```jsonc
{ "endpoint": "coder",    "topic": "ch/lark-bot/*/oc_dev", "when": { "mentionsMe": true }, "mode": "trigger",
  "fromAgents": { "allow": true, "maxHops": 3 } },
{ "endpoint": "reviewer", "topic": "ch/lark-bot/*/oc_dev", "when": { "mentionsMe": true }, "mode": "trigger",
  "fromAgents": { "allow": true, "maxHops": 3 } },
{ "endpoint": "coder",    "topic": "ch/lark-bot/*/oc_dev", "mode": "context" },
{ "endpoint": "reviewer", "topic": "ch/lark-bot/*/oc_dev", "mode": "context" }
```
人 @coder → coder 一轮，产出 "@reviewer 请看 PR#12"（hops=1）→ reviewer trigger（hops=1<3）→ "@coder 第 40 行有竞态"（hops=2）→ coder trigger（path 含 coder，但 maxHops=3 显式放行）→ coder 再 @reviewer（hops=3）→ 降级为 context，人收到 notice。双方都在 context 里看到对方全部消息。`mentionsMe` 的解析：两个 agent 若共用一个飞书应用，平台 @ 只能指向这个 bot，需要用两个飞书应用（各自 bot open_id 绑定到端点），或约定文本前缀 `@coder` 由通道适配器解析成 `to`（弱于平台 @，见 §8）。

**S5 会议**。话题 `ch/lark-meeting/default/m_123/transcript`（stable 片段，`revisionOf` 取最新）与 `.../chat`。`assistant` 对 transcript 订阅 `context`、对 chat 订阅 `mentionsMe` trigger；回答 `pub` 到 chat。语音阶段：一个实时语音模型以 **agent 端点**经 JSONL 接入（智能不在 harness 里，也不在宿主里），订阅 transcript trigger，回答经会议通道 TTS 输出；需要深度工作时它向 `ep/assistant` 发 `request`，assistant 的结果作为 `resolve` 回来。这是 E 独有的表达：一个非 harness 的智能体与 harness agent 平级协作。

**S6 别的团队、无 TypeScript**。Python 服务以 host 端点连 socket（纯 JSONL，schema 由 `scripts/emit-schema.mjs` 产出）。两种用法都不写 TS：①只写 `agents-io.json` 的 endpoints/subscriptions，用内置 harness 端点；②自己的 Python LLM 循环注册为 `kind:agent` 的外部端点（`ep.register{external:true}`，总线投 `deliver`，它 `pub` 回答），agents-io 只提供通道、身份、路由、防环。自定义路由用 `sub`/`unsub` 帧动态改，或把语义判断挂成 `gate` 端点（总线问 gate：drop/context/trigger）。

## 7. 相对今天要改什么

| 今天 | E 之后 |
|---|---|
| `Policy.admit`（`policy.ts`，`session/src/policy.ts:98`） | 默认订阅表；admit 保留为"编译后的订阅匹配"，自定义 admit 退化为 `gate` |
| `Watch`/`WatchDispatcher`（`watch.ts`，`session/src/watch.ts`） | Subscription 的子集，表和 digest 缓存原样复用，`target.sessionKey` → `endpoint` |
| `Admission.action: 'host'` + `InboundFrame`（`host.ts`） | 宿主端点的 `deliver` 订阅 |
| `run.start/run.ended`（`host.ts` `RunStart`/`RunEnded`） | `ep.spawn{lifetime:"turn"}` + `pub ep/<id>` / `ep.retired` |
| `Deliver`（`host.ts`） | `pub` 到 `ep/<human>` 或 `ch/...`，幂等键 = 消息 id |
| `Origin`（`inbound.ts:75`）、`Origin.self`/`declared` | `author` + `cause`；self 由 outbox 认回；declared 仅用于跨部署 |
| `Policy.outbound`、输出工具 `send_message(route)`（`host-mcp`） | `publish` grant；工具改成 `publish(topic)` / `subscribe(...)`（`watch_add` 的推广） |
| Hub `subscribe(sessionKey)`（`session/src/hub.ts`） | 订阅 `sess/<key>`，attach 终端是一个 human 端点 |
| `Principal.labels` | 保留，作为 grant 的选择器 |
| `POSITIONING.md` §2 "进哪个 session 交给宿主" | 改为"路由是数据：订阅表归部署者/宿主所有，agents-io 执行它" |

实施可以渐进：先引入 `cause` 与 `author.endpoint`（防环与认作者今天就需要），再让 Watch 与 admit 共用一个匹配器，最后把 host 帧改写成 `ep.*`/`pub`/`sub`，旧帧作为别名保留一个版本。lane、log、compositor、outbox、harness 适配器不动。

## 8. 弱点（诚实）

1. **范围膨胀**：E 实际上是"消息代理 + actor 运行时 + 能力授权"。POSITIONING 的判据"不同宿主答案不同就是策略"——路由恰恰是策略；E 把策略变成数据交给 agents-io 执行，边界从"钩子"滑向"规则引擎"，长期会长出条件表达式、优先级、例外。
2. **两份事实**：总线有自己的消息日志与作者认定，x-work-os 也有权威事件。"谁说了什么"在两处，靠 `msg.attest` 对齐；总线日志的保留期、删除（0010 §4.1 担心的个人信息）成了新问题。
3. **对称是假的对称**：人没有 lane、不能"开一轮"，有延迟和打扰成本；宿主没有 turn；agent 有 steer。统一的 `deliver` 掩盖了差异，`inbox` 偏好又与 x-work-os 0006 的收件箱/汇总职责重叠——谁决定"何时打扰人"会打架（E 的回答：有宿主时 human 端点的 `inbox` 设为 `deliver→xwo`，但这是又一条要配对的规则）。
4. **防环是启发式**：跨部署 bot 没有因果链，两个系统各自守 L2 仍可能 A 系统→B 系统→A 系统无限循环；预算只能限速不能根治。
5. **平台现实不对称**：飞书单应用无法让两个 agent 各自被原生 @，S4 要么多建应用，要么用文本前缀（可被任何人伪造为"提及"，但不影响作者认定）。
6. **可调试性**："为什么 reviewer 醒了/没醒"需要 `explain <msgId>`：列出命中/未命中的订阅、hop、预算、gate 结果。没有它 E 不可用，这是额外工作。
7. **授权模型复杂**：grant 委托、`speakFor`、`spawn{maxProfile}` 一旦配错，registrar 宿主就是全局高权限目标；比"宿主回调 4 个钩子"难审计。
8. **S1 用户被迫理解概念**：默认配置可以隐藏端点/话题，但报错与文档无法不提它们；对"只想在飞书看 Codex"的人，E 比方案"纯 IO 层"重。
9. **没有观点**：E 能表达 A 和 B 两种智能位置，也意味着它不替用户回答"智能该在哪"。默认值和示例必须明确选边，否则使用者会各自拼出不可比的拓扑。

## 9. 结论（E 的主张）

选 E 的理由不是"更通用"，而是：**今天已经存在三套订阅（admit、watch、hub）、两套身份（Origin.self/declared 与 0010 三类作者）、两种拉起方式（lane 与 run.start）**，E 把它们合并为端点 + 话题 + 订阅 + 因果链，并把防环与作者认定从"各处的约定"变成总线的硬规则。代价是 agents-io 拥有路由执行权，必须同时交付 `explain` 工具和保守的默认订阅表。
