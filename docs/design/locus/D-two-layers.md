# 方案 D：拆成两个可单独使用的产品——IO 层 + Agent 运行时

> 状态：讨论稿（2026-10-07），供与方案 A/B/C 对比。本文按最强形态论证，§8 列真实弱点。

## 1. 一句话

agents-io 拆成两个产品，之间是稳定的进程外协议：**aio-io**（通道、身份证据、投递、订阅/路由）和 **aio-runtime**（harness 实例、session、lane、审批）。宿主按需组合；单机自用 = 两者 + 一个默认路由。
"谁是智能来源"不是 agents-io 的架构属性，而是**每条路由的配置**：一条路由指向运行时里的 agent，那一处就是"agents-io 当 agent 用"；指向宿主，那一处就是"宿主是智能，agents-io 只做 IO"。

## 2. 为什么是两层而不是一层

今天的代码已经有两种使用者在拉扯同一个 `Ingress`（`packages/session/src/ingress.ts`）：

- x-work-os 只要 IO：0003 [adapter.contract] 的 to-human 适配器只发消息，0008/0010 的接收程序只收消息，执行器"一轮一进程、不推消息"（0006 [ask.answer](2)）。它用不上 lane、steer、session 续接，只是被迫穿过它们——HOSTS.md 里的 `Admission.action: 'host'`（`policy.ts`）就是从 session 层"借道"把输入还给宿主的补丁。
- 单人助手只要 agent：主人在飞书和邮件里说话，期望有个"会用 Claude Code 的东西"回应，不想写宿主。

两种需求的接缝其实清楚：**一条消息从平台到"某个消费者"为止是 IO；从"某个消费者把它变成一轮"开始是运行时**。现在这条缝藏在 `Ingress.process()` 中间（identify → admit → watch → lane），D 把它变成协议。

## 3. 各层拥有什么

| | aio-io（IO 层） | aio-runtime（运行时） |
|---|---|---|
| 进程内对象 | `ChannelAdapter`（channel/*）、`BlobStore`、`MailStore`、Outbox、LiveMessage、Router、Directory | `HarnessAdapter`（harness/*）、SessionLog（seq）、Lane、Hub、Compositor、RequestBroker、host-mcp |
| 数据 | 入站流（带 cursor）、投递记录、订阅表、渠道身份绑定（可选，见下） | session 日志、native session id、待决请求、agent 定义 |
| 判断 | 证据盖章、作者三分类（human/agent/external + self）、按**确定性规则**路由、目的地白名单 | 进哪个 session、何时开轮、steer/interrupt、选 RunSpec、谁来答请求 |
| 不知道 | session、turn、harness、模型 | 平台接口、卡片格式、DKIM、邮件线程头 |
| 来自 `Policy`（`policy.ts`） | `identify`、`outbound`（目的地部分）、新增 `route` | `admit`（改名 `bind`）、`plan`、`resolve`、`escalate`、`control`、`triage`、`watch` |

两条关键约定：

1. **运行时只是 IO 的一个消费者**，与宿主、脚本平级。它在 IO 上的地址是 `rt:agent/<name>`。
2. **流式展示是 IO 的原语，展示内容是运行时的事**。IO 提供 `live.open / live.patch / live.close`（承接今天 lark-bot 的 CardKit 节流、降级、`reconcile`）；Compositor 留在运行时，把 SessionEvent 折叠成 `RenderedMessage + ProgressView` 再 patch 过去。IO 不认识 SessionEvent。

## 4. 两套协议

两者都是 JSONL 帧 + JSON Schema（`scripts/emit-schema.mjs` 分别产出 `io.v1`、`rt.v1`），各自一套一致性套件（`packages/testkit` 拆分）。合并部署时同一 socket 按 `ns` 字段复用。

### 4.1 IO 协议（消费者 ↔ aio-io）

```jsonc
→ { "ns":"io","type":"hello","consumer":"host:xwo","token":"…","from":{"cursor":"c_8812"} }   // 断线按 cursor 续收
← { "ns":"io","type":"input","seq":"c_8813","rule":"eng-all","delivery":"context",
    "input":{ /* InputRecord，origin 已盖章：kind/principal/declared/self/evidence */ },
    "envelope":{ /* InboundEnvelope 去 raw */ }, "cause":{"depth":1,"by":"agent:coder"} }
→ { "ns":"io","type":"ack","seq":"c_8813" }                         // 至少一次，消费者去重（与 0008 [input.capture] 同构）
→ { "ns":"io","type":"send","operationId":"ask-123","route":{…},"message":{ /* RenderedMessage */ },
    "as":"runner:r1/run:x","cause":"in_77" }                        // as = 0010 [channel.author](3)
→ { "ns":"io","type":"live.open","operationId":"turn-9","route":{…},"as":"agent:main" }  // patch/close 同理
→ { "ns":"io","type":"subscribe","rule":{ /* 同 §5 路由规则 */ },"expiresAt":… }        // watch 的 IO 半边
→ { "ns":"io","type":"caps","route":{…} }   ← ChannelCaps                              // Compositor 用
← { "ns":"io","type":"settled","operationId":"ask-123","result":"delivered","providerMessageId":"om_…" }
```

### 4.2 运行时协议（驱动者 ↔ aio-runtime）

驱动者是宿主，或者是"把 IO 输入接给 agent"的绑定器（合并部署时在进程内）。

```jsonc
→ { "ns":"rt","type":"input","agent":"main","sessionKey":"main","mode":"auto",
    "inputs":[ /* InputRecord */ ],"replyRoute":{…} }               // 交互 session：排队/合批/steer 由 Lane 决定
→ { "ns":"rt","type":"run.start","runId":"…","run":{ /* RunSpec */ },"cwd":"…","input":[…],"env":{…},
    "observe":{"routes":[…]} }                                       // 即 HOSTS.md §3.4，原样搬过来
→ { "ns":"rt","type":"subscribe","sessionKey":"run:…","tier":"full","from":0 }       // Hub
→ { "ns":"rt","type":"resolve","requestId":"…","decision":{…},"by":{ /* Origin */ } }
← { "ns":"rt","type":"event", … } / { "type":"run.ended", … } / { "type":"policy","hook":"plan|resolve|control", … }
```

运行时要往外说话时，用自己在 IO 上的消费者身份发 `send / live.*`，并带 `cause`（触发这一轮的输入 id）。

## 5. "什么消息拉起什么 agent、什么 agent 听什么"怎样表达

拆成两半，各管一半，都是数据：

- **IO 路由表**回答"这条消息给谁、以什么强度"：所有命中的规则都生效（扇出），同一消费者取最强的 `delivery`（`trigger` > `context`），都没命中就只记入站流。规则只用确定性条件（今天 `WatchSource` + `WatchFilter` 的超集）；语义判断留给消费者（运行时的 `triage`、或宿主自己）。
- **运行时 agent 定义**回答"收到后进哪个 session、用哪个 harness、怎么开轮"。

```jsonc
// aio-io.json
{ "directory": { "bindings": [ { "principal":"m:lzw","labels":["owner"],
      "ids":[ {"channel":"lark-bot","user":"on_bc38"}, {"channel":"mail","user":"lzw@corp.com"} ] } ],
    "hook": null },                                     // 或 "host:xwo"：由宿主回调 identify（x-work-os 0010 绑定表）
  "agentAccounts": ["lark-bot:coder","lark-bot:reviewer","lark-bot:default"],
  "routes": [
    { "id":"xwo-actions", "match":{"event":"action","actionPrefix":"xwo:"}, "to":"host:xwo", "delivery":"trigger" },
    { "id":"rt-actions",  "match":{"event":"action","actionPrefix":"rt:"},  "to":"rt", "delivery":"trigger" },
    { "id":"owner-direct","match":{"conversationKind":["dm","mail"],"labels":["owner"]}, "to":"rt:agent/main", "delivery":"trigger" },
    { "id":"eng-coder",   "match":{"conversation":"oc_eng","mentions":["bot:coder"]},    "to":"rt:agent/coder", "delivery":"trigger" },
    { "id":"eng-reviewer","match":{"conversation":"oc_eng","mentions":["bot:reviewer"]}, "to":"rt:agent/reviewer", "delivery":"trigger" },
    { "id":"eng-all",     "match":{"conversation":"oc_eng"}, "to":["rt:agent/coder","rt:agent/reviewer"], "delivery":"context" } ],
  "loops": { "maxAgentDepth": 2, "excludeOwnEcho": true } }
```

```jsonc
// aio-runtime.json
{ "harnesses": { "claude": { "transport":"sdk" }, "codex": { "transport":"app-server" } },
  "agents": {
    "main":     { "run":{"harness":"claude","model":"opus","profile":"owner"}, "session":"main", "lane":{"batchMs":1500} },
    "coder":    { "run":{"harness":"codex","model":"gpt-5","profile":"restricted"}, "session":"by-conversation", "as":"agent:coder", "ioAccount":"coder" },
    "reviewer": { "run":{"harness":"claude","model":"sonnet","profile":"restricted"}, "session":"by-conversation", "as":"agent:reviewer", "ioAccount":"reviewer" },
    "digest":   { "run":{"harness":"claude","model":"sonnet","profile":"readonly"}, "session":"digest",
                  "bind":{"mode":"digest","everyMs":3600000,"maxItems":200} } } }
```

谁拉起 agent：**只有运行时拉起 harness 进程**——要么因为宿主发了 `run.start`，要么因为 IO 投来一条 `delivery: trigger` 的输入。IO 永远不启动任何东西；宿主永远不直接 spawn harness（它可以，但那就是不用 aio-runtime）。

## 6. 场景

**S1 单人助手（无宿主）。** `aio serve` 在一个进程里起 io + runtime + 默认路由（上面的 `owner-direct`、`rt-actions`，加"陌生人私聊丢弃、群里非主人只记录"——今天 `session/policy.ts` 默认 admit 的翻译）。主人飞书私聊：lark-bot 盖 `platform_signed` → directory 认出 `m:lzw` → 命中 `owner-direct` → 运行时 agent `main` 收到，Lane 合批，Claude Code 开轮；运行时 `live.open` 一张流式卡片，Compositor 每 600ms `live.patch`。同一人发邮件：mail 盖 `dkim_pass` → 同一 principal → 同一 session `main`，回复路由是邮件，`final` 档，IO 负责 In-Reply-To。harness 要审批：`resolve` 默认策略给 human → 运行时 `send` 带 `rt:` 前缀按钮 → 点击作为 action 事件命中 `rt-actions` → 运行时核对点击者是 turn owner → `respond()`。

**S2 x-work-os。** x-work-os（Go）连两个命名空间，消费者名 `host:xwo`，并做 directory hook（0010 [channel.identity] 的绑定表）。
- 执行：runner 的 start-executor 适配器读 `StartRequest`，发 `rt.run.start{run: codex, cwd, env: XWO_CREDENTIAL_FILE}`，等 `run.ended` 写 `exit_code`。运行时 spawn codex，一轮结束关 session。`observe.routes` 可选地让运行时把过程卡推到某个群（只看）。
- 提问：执行器自己跑 `x ask …` 写 `ask.created`（0006）；**运行时完全不参与**。to-human 适配器按绑定把成员映射成路由，直接发 `io.send{operationId: "ask-123-notify", message: 卡片, actions: [xwo:ask-123:opt-a …]}`。
- 回答：主人点按钮 → lark-bot 收 card action，盖 `platform_signed` → directory hook 认出成员 → 命中 `xwo-actions` → `host:xwo` 收 `io.input`，调 `answer --key channel:lark-bot/<msgid>`（0010 [channel.ref]），然后 `ack`。下一次 runner 轮询领取、再发 `run.start`。没有任何东西推入运行中的执行器，符合 0006 [ask.answer](2)。
- 讨论会话：讨论群配两条规则——`to: rt:agent/discuss, delivery: trigger`（@bot 时）和 `to: host:xwo, delivery: context`（全部）。agent 在群里讨论、用 x CLI 查任务；主人说"确认"时，这条消息**同时**到达宿主，宿主按 0010 [channel.confirm] 以消息作者为行动者写确认，会话引用就是这条消息的渠道引用。今天 `Admission: 'host'` 只能二选一，这里靠扇出自然解决。

**S3 监听汇总。** 主人对 `main` 说"每小时总结 oc_team 和我的收件箱"。agent 调 host-mcp `watch_add` → 运行时问 `Policy.watch`（主人允许）→ 运行时向 IO 发 `subscribe{match:{conversation:"oc_team"}, to:"rt:agent/digest", delivery:"context"}` 和 mail 收件箱一条 → IO 把命中消息按 cursor 投给运行时 → agent `digest` 的 `bind.mode: digest` 把它们缓存在运行时，满一小时开一轮，输出用 `send` 发到主人私聊。来源 origin 保持原发送者（`watch.ts` 现有的"watched input untrusted"规则不变），所以 digest 轮用 `readonly` profile。

**S4 多 agent 同群。** coder（codex）和 reviewer（claude）各有一个飞书机器人账号（`agentAccounts`），也可以是同一账号靠 `as` 区分。`@coder` 命中 `eng-coder` → trigger；同时 `eng-all` 给 reviewer 一份 context。coder 回复时运行时发 `send{as:"agent:coder", cause:"in_77"}`；回流时 IO 认出 agent 账号、采信 `declared=agent:coder`，对 coder 标 `self` 并按 `excludeOwnEcho` 不投给它；对 reviewer 是 `kind:agent` 的 context。若 coder 的回复里 @reviewer，命中 `eng-reviewer` 变成 trigger，`cause.depth` 加 1；到 `maxAgentDepth` 后 IO 把 trigger 降级成 context 并在入站流里注明——**防环在 IO 做，因为只有 IO 同时看到出站的 cause 和入站的回声**。两个 agent 甚至可以在两台机器的两个运行时里，只要都是同一个 IO 的消费者。

**S5 会议。** 新通道 `channel/lark-meeting`（见 `docs/research/meeting.md`）发 `conversationKind: meeting` 的 transcript 块。路由：全部 transcript → `rt:agent/meet`，`context`（运行时用 `inject` 不开轮，或缓冲到下一轮）；会议聊天里 @bot → `trigger`。回答走会议聊天 `send`。语音阶段：IO 给通道加 `speak` 与 barge-in 事件，barge-in 作为高优先级 `io.input{event:"barge_in"}` 投给运行时，运行时 `interrupt`。真正全双工的实时模型见 §8 第 3 条。

**S6 别的团队、非 TypeScript。** 三种接法都不碰 TS：只用 aio-io（Python 服务作消费者，收 `io.input`、发 `io.send`，自己的 agent 自己跑）；只用 aio-runtime（Rust 服务自己接渠道，把输入发 `rt.input` / `run.start`，订阅事件流）；两者都用但关掉默认路由，由他们的服务通过 `io.subscribe` 动态下发规则、或注册为 directory hook。私有通道照旧走 `channel/jsonl-bridge`，私有 harness 走 `harness` 的 JSONL 桥。他们只需对照 `io.v1` / `rt.v1` 两份 JSON Schema 和对应一致性套件。

## 7. 相对今天要改什么

1. **包**：`packages/session` 拆为 `packages/io`（Router、Directory、Outbox、LiveMessage、BlobStore、订阅表、ingress 的校验/去重/identify 部分）和 `packages/runtime`（log、sqlite-log、lane、hub、tier、compositor、RequestBroker、watch 的 digest/trigger 部分、绑定器）。`host-mcp` 归运行时，出站工具改为经 IO 协议发送。
2. **协议**：`packages/protocol` 分 `io/`（inbound、channel、common 的 ReplyRoute/Evidence、新 `route.ts`、IO 帧）与 `rt/`（events、run、harness、requests、commands、client、host 的 run.*）。`wire.ts` 加 `ns`。
3. **Policy**：`policy.ts` 一分为二；`Admission.action: 'host'` 删除，由"路由到 `host:*` 消费者"取代；`admit` 改名 `bind`，只决定 sessionKey/mode。
4. **Watch**：`watch.ts` 的 `WatchSource/WatchFilter` 下沉为 IO 路由规则的子集，`WatchMode`、digest 计时留在运行时；`WatchDispatcher` 不再直接写 Lane。
5. **耦合点**：`compositor.ts` 现在 import `ingress.ts` 的 `actionId`——改为运行时自有 `rt:` 前缀命名空间，IO 只按前缀路由。lark-bot 的流式卡片逻辑从"被 compositor 调 edit"改为实现 IO 的 `live.*`。
6. **文档**：HOSTS.md 改写成"宿主 = IO 消费者 +（可选）运行时驱动者"；POSITIONING.md §3 的 L0–L3 改为两列两栈；`examples/dev-gateway` 变成 `aio serve` 的组合示例（io + runtime + 默认路由）。
7. **新增义务**：IO 入站流持久化 + cursor（今天 Ingress 的 `seen` 是内存 Map）；cause 链；IO 与运行时之间的认证（运行时要信任 IO 盖的 principal）。

## 8. 真实弱点

1. **它没有回答用户的问题，而是把问题变成了配置。** "智能在哪"从架构决定降级为"谁写路由表"。如果团队其实需要一个明确立场来指导取舍（例如默认值、文档叙事、先做什么），D 容易变成"都支持、都不精"。
2. **两套协议的稳定成本翻倍。** 版本、Schema、一致性套件、兼容矩阵都要两份，外加合并模式；对一个刚起步、只有一个宿主的项目，这是在协议还没被用熟时就冻结一条接缝。
3. **实时语音/实时模型会撕开这条缝。** Codex realtime 一类全双工模型本身就同时是 IO 和智能：音频帧进、音频帧出、自带打断。它塞不进"IO 投递 input → 运行时开 turn"，要么运行时直通音频（IO 退化成传输），要么 IO 里长出 agent。
4. **审批、steer 的权威跨两层。** 点击者是谁由 IO 盖章，点击者是否有权由运行时判定；运行时必须信任 IO 的 principal，directory 在两边都要用（IO 路由按 labels，运行时按 owner 鉴权），要么重复配置、要么跨进程回调，fail-closed 的语义要在两边各写一遍。
5. **`outbound` 被劈开。** 目的地白名单在 IO，"这一轮有没有资格往那发"需要 TurnContext，在运行时。两边都得检查，任何一边漏查就是越权外发。
6. **展示仍然耦合。** Compositor 需要每条路由的 ChannelCaps，live 原语需要承载 ProgressView 这种来自运行时语义的结构；`RenderedMessage.progress` 实际上是运行时的概念穿过 IO 协议。拆出来的"纯 IO"并不纯。
7. **运维与延迟。** 两个守护进程（或一个进程两个命名空间）、两条 cursor、两份日志（入站流与 session 日志）——同一条消息在两处各存一份，排查时要对齐两个 id。流式卡片多一次跨进程，600ms 节奏下可接受，语音下不可忽略。
8. **重构成本真实存在。** `Ingress.process()` 把 identify、admit、watch、lane 写在一个流程里，`WatchDispatcher` 直接写 Lane，compositor 依赖 ingress；拆开要动 session 包的大半。

## 9. 什么时候选 D

- 预期会出现"只要 IO 不要 agent"（x-work-os 的 to-human/接收程序、S6 的 Python 团队）和"只要 agent 不要我们的通道"两类真实用户，且各自数量不少。
- 预期一个 IO 前面挂多个运行时/多个宿主（S4 跨机器多 agent、S2 宿主与讨论 agent 共听一群）。
- 能接受先在单进程里用两个命名空间落地、等第二个外部使用者出现再承诺两份协议的稳定性（降低弱点 2 的代价）。

如果答案是"agents-io 主要就是一个更会收发的 agent"或"agents-io 主要就是宿主的 IO 库"，单层方案更省；D 的价值在于两种用法都长期存在。
