# 方案 A：agents-io 是纯 IO 总线，从不自己拉起 agent

> 状态：讨论稿（2026-10-07），供"智能在哪、谁拉起 agent"这一决定对比用。本文按最强形态论证，§7 如实列出弱点。
> 依据：`docs/POSITIONING.md`、`docs/HOSTS.md`、`packages/protocol/src/{policy,host,watch,harness,channel}.ts`、
> `packages/session/src/{lane,watch,ingress,policy}.ts`、x-work-os 提案 0001r1 / 0003 / 0006 / 0008 / 0010。

## 0. 一句话

**agents-io 只搬运字节和事件，不做任何"该不该、给谁、让谁来想"的判断。** 通道是端点，harness 会话也是端点，
订阅者（宿主、终端、网页）也是端点；总线把消息从一个端点送到声明了要它的端点。**智能只在两处：宿主，
以及宿主亲手打开的 harness 端点里的模型。** agents-io 从不自己决定打开一个 harness 端点。

对用户问题的回答：智能来源是宿主（或宿主提供的 agent）；agents-io 对宿主来说是"一块 IO 卡 + 一组驱动"，
对 harness 来说是"更宽的输入输出"，但这个"更宽"是宿主插上去的，不是 agents-io 自带的。

## 1. 判据：把 POSITIONING §2 推到底

POSITIONING 的判据是"不同宿主会给出不同答案的能力就是策略"。今天的代码仍有三处由 agents-io 自己回答策略：

| 今天由 agents-io 回答 | 位置 | 为什么其实是策略 |
|---|---|---|
| 这条输入进哪个 session、开不开一轮 | `Policy.admit` 默认实现 + `ownerSessionKey: "main"`（`packages/session/src/policy.ts`，`examples/dev-gateway/aio.config.json`） | x-work-os 要"一个任务一轮一进程"，个人助手要"一个主人一个长会话"，客服要"一个客户一个会话" |
| 这一轮用哪个 harness、什么 profile | `Policy.plan` 默认（主人 bypass、外部 restricted） | 模型分级、成本、权限全是宿主的业务 |
| 宿主断开后谁来判断 | HOSTS.md §2"退回默认策略" | 等于守护进程里藏了一个小宿主 |

方案 A 的立场：**这三处全部移出守护进程**。守护进程里不再有 `defaultPolicy`；"单人自用"的那套默认值变成一个
独立的、可替换的**默认宿主**（§4）。守护进程只保留"给定指令，可靠执行"的机制：lane 合批与 steer、seq 日志、
compositor、outbox、身份证据盖章、blob。

## 2. 端点模型

```
          ┌─ channel 端点 ─┐   ┌─ harness 端点 ─┐   ┌─ 订阅端点 ─┐
          lark-bot / mail /     claude-code /        attach / web /
          jsonl-bridge / meet   codex / jsonl-bridge  宿主连接
                 │  publish            │ publish           │ subscribe / control
                 ▼                     ▼                   ▼
   ┌──────────────── agents-io 总线（守护进程） ───────────────────────────────┐
   │ topic 树：in/<channel>/<account>/<conv>[/<thread>]   ← 通道入站（已盖章 Origin）│
   │           ep/<endpointId>/events                      ← harness 会话事件(seq)   │
   │           ep/<endpointId>/requests                    ← request.opened         │
   │ 机制：订阅表 · pipe 表（宿主装的静态规则）· lane · outbox · compositor · 因果链 │
   └────────────────────────────────────────────────────────────────────────────┘
```

- **channel 端点**：现有 `ChannelAdapter`（`packages/protocol/src/channel.ts`）不变。`ctx.emit` 的去向从
  "Ingress → Policy.admit → lane"改为"发布到 `in/...` topic"。
- **harness 端点**：现有 `HarnessAdapter` / `HarnessSession`（`harness.ts`）+ `lane.ts` 打包成一个端点。
  **只有宿主连接能 `endpoint.open`**；打开时宿主给定 `RunSpec`、`cwd`、身份 `as`、MCP 工具集。
  `run.start`（`host.ts`）保留为语法糖：`endpoint.open(ephemeral) + input + 结束即 close`。
- **订阅端点**：`Hub.subscribe(tier)`（`hub.ts`）推广到任意 topic；宿主连接本身就是一个订阅端点。

## 3. 路由：订阅 + pipe，二者都是宿主装进来的数据

"什么 agent 监听哪些消息、什么消息拉起什么 agent"在 A 里拆成两个正交问题：

1. **拉起**：只有宿主能做，显式 `endpoint.open`。总线永远不因一条消息而打开端点；需要时发
   `endpoint.wanted` 给宿主（某条 pipe 指向的端点未打开），由宿主决定开不开。
2. **监听**：订阅或 pipe。pipe 是宿主预装的"常备指令"，让热路径不必每条消息都回宿主（性能，不是智能）。
   pipe 只做确定性匹配（复用 `WatchFilter` 的 keywords / mentions / excludeSelf），语义判断永远回宿主。

```jsonc
// 宿主 → 守护进程（JSONL，扩展 host.ts）
{"v":1,"type":"host.hello","id":"1","token":"…","name":"xwo","claims":["in/lark-bot/**","in/mail/**"]}
{"v":1,"type":"sub","id":"2","topic":"in/lark-bot/default/**","deliver":"host"}           // 全部给宿主
{"v":1,"type":"endpoint.open","id":"3","endpoint":"coder","harness":"codex","cwd":"/repo",
 "run":{"harness":"codex","model":"gpt-5.5","profile":"restricted"},"as":"agent:coder",
 "tools":["send_message","reply_to","ask_choice"]}
{"v":1,"type":"pipe","id":"4","from":"in/lark-bot/default/oc_grp1","to":"ep/coder",
 "filter":{"mentions":["agent:coder"]},"mode":"trigger","reply":"source","maxHops":2}
{"v":1,"type":"pipe","id":"5","from":"in/lark-bot/default/oc_grp1","to":"ep/coder","mode":"context"}
{"v":1,"type":"input","id":"6","endpoint":"coder","mode":"steer","content":[…],"origin":{…}} // 宿主直接喂
```

- `mode` 取值沿用 `WatchMode`（`watch.ts`）：`context` 记成下一轮可见的上下文，`trigger` 开一轮，`digest`
  由总线按时间窗攒批，到点向目标发一条合并输入。**watch 就是端点作为订阅者的 pipe**，不再是单独概念。
- `reply: "source"` 让 compositor 把这一轮渲染回来源路由（今天的"回复只回到来源"，CHANNELS.md §0）；
  `reply: "host"` 则只把事件流交给宿主，由宿主决定 `deliver` 到哪。
- **身份与信任仍是数据**：宿主在 hello 后下发 `bindings`（渠道账号 → Principal，见 0010 [channel.identity]），
  总线据此盖 `Origin`；`identify` 回调只在绑定表未命中时触发。证据（`platform_signed` / `dkim_pass`）由适配器给，
  总线不降级、不升级。
- **因果链**：harness 端点发出的每条消息带 `as` 与 `cause=<inputId>`、`hop=n`（`SendOp.as` + `declaresSender`
  已在 `channel.ts`）。回流时总线恢复 `self` 与 hop；`hop > maxHops` 的 pipe 不触发。这是防环机制，不是策略。
- **请求（审批）**：`request.opened` 发布到 `ep/<id>/requests`；谁订阅谁回答（`resolve` 帧）。卡片按钮的
  `actionId` 编解码（`ingress.ts` 的 `actionId/parseActionId`）是机制，留在总线：点击直接成为 `resolve`，
  但"这个人有没有资格点"由宿主装的 `resolvers` 表（principal 列表）判定，表外的点击转给宿主。

## 4. S1 没有宿主时：默认宿主 `aio-host-personal`

A 的诚实做法：**不存在"没有宿主"，只存在"最小的宿主"。** 仓库附带一个 ~300 行的独立进程
`hosts/personal/`（TS 写，但只讲 JSONL，可以被任何语言重写），它读一个路由文件，启动时装好绑定、端点和 pipe，
之后只处理少数回调。`agents-io serve` 发现没有宿主配置时自动拉起它（同一个二进制的子命令），对用户就是一条命令。

```jsonc
// personal.routes.json —— 今天 dev-gateway 默认策略的等价物
{ "owners": ["lark-bot:on_bc38…", "mail:me@corp.com"],
  "endpoints": { "main": { "harness": "claude-code", "cwd": "~", "profile": "bypass", "persist": true } },
  "pipes": [
    { "from": "in/lark-bot/*/dm:owner",  "to": "ep/main", "mode": "trigger", "reply": "source" },
    { "from": "in/mail/*/*:owner",       "to": "ep/main", "mode": "trigger", "reply": "source" },
    { "from": "in/lark-bot/*/group",     "to": "ep/main", "filter": {"mentions": ["self"]}, "mode": "trigger" } ],
  "strangers": "drop", "resolve": "auto" }
```

这个文件就是 `DefaultPolicyOptions`（`session/src/policy.ts`）原样搬家。区别在于：它是一个**可以被删掉、替换、
fork 的宿主**，守护进程里不再有任何一行"主人是谁"的代码。

## 5. 六个场景逐一走

**S1 个人助手（飞书私聊 + 邮件）。** lark-bot / mail 端点发布入站 → 总线按 `bindings` 盖 `Origin{principal:owner}`
→ 命中 pipe → 喂进 `ep/main`（lane 负责合批、运行中来的走 steer）→ claude-code 跑一轮 → compositor 按来源通道档位
渲染（飞书 `card`，邮件 `final`）→ outbox 投递。personal 宿主只在启动时装表，运行中只回答绑定表外的 `identify`。

**S2 x-work-os。** x-work-os 核心（Go）就是宿主。
- 执行：start-executor 适配器发 `run.start{runId, run, cwd, input:["Read the brief at …"], env}`；总线打开临时端点
  `run:<runId>`，**不装任何 pipe**，所以运行中没有任何外部消息能进来（符合 0003 §4.6"不向运行中的执行者推送"）。
  执行者经 x-work-os 命令 `ask`，命令阻塞等待（0004 [cli.wait]）；`run.ended` 给退出码。
- 提问到人：to-human 适配器发 `deliver{operationId:"ask-123-notify", route, message:{actions:[…]}}`；
  卡片按钮的 actionId 由宿主自己编码（含提问序号，0010 §4.5），总线不认识它，所以点击作为 `in/lark-bot/...`
  的 `event action` 发布到宿主订阅；宿主按 0010 [channel.answer] 写 `answer --key channel:lark-bot/<msgId>`。
- 下一次运行：0006 §4.7 回答由下一次 brief 带回，总线不参与。
- 讨论会话（0005 F / 0010 §4.8）：宿主 `endpoint.open("discuss:<decisionId>", persist)`，对讨论群装
  `trigger(mentions:self)` + `context` 两条 pipe。确认决定时 agent 调 x-work-os 命令；确认的行动者取**那条消息**的
  作者——宿主从该入站的 `Origin` 和渠道引用 `channel:lark-bot/<msgId>` 得到，总线保证这两者不可伪造。
- 总线对 x-work-os 的价值：通道、渲染、幂等投递、证据盖章、过程卡片观察（`observe.routes`）；没有一处替它做判断。

**S3 每小时汇总群聊 + 收件箱。** 宿主（或 personal 宿主的配置）打开 `ep/digest`，装两条 `digest` pipe：
`in/lark-bot/default/oc_grp → ep/digest {everyMs:3600000}`、`in/mail/default/inbox → ep/digest {everyMs:3600000}`，
`reply:{route:"lark-bot:default:dm_owner"}`。总线到点合并成一条输入开一轮；经 watch 进来的输入 `Origin` 保持原发送者
（`watch.ts` 的"不可信"规则不变），所以 `plan` 由宿主装的 profile 决定为 restricted。agent 想自己加监听时调用
host-mcp 的 `watch_add`（`packages/host-mcp/src/server.ts`），A 下它变成一个发给宿主的请求，宿主批准后装 pipe。

**S4 Codex coder + Claude reviewer 同群。** 宿主打开 `ep/coder`（`as:agent:coder`）和 `ep/reviewer`（`as:agent:reviewer`），
各装两条 pipe：`mentions:[自己] → trigger`，其余 → `context`。coder 回复群里时消息带 `as=agent:coder, hop=1`；
回流后对 reviewer 是 `context`（看得见），对 coder 是 `self`（丢弃）。若 coder 的回复 @reviewer，reviewer 被
`trigger`（hop=2），它再 @coder 时 hop=3 > `maxHops:2`，不触发，只记 context——环在机制层被截断。
"这条没 @ 任何人的问题该谁答"是语义路由，A 交给宿主：宿主订阅该群，可以用一次轻量模型调用决定后发 `input`。

**S5 会议。** 会议端点（botmux 路线，RECOMMENDATION §4.3）把转写作为 `transcript` 内容块发布到
`in/meet/default/<meetingId>`；宿主装 `context`（转写流全部进 `ep/meet`）+ `trigger(mentions:self)`（会议聊天里 @bot）。
回答 `reply:"source"` 投到会议聊天。语音阶段：同一端点的 `speak()`（`channel.ts`）作输出；插话打断装成 pipe
`{from:"in/meet/…/vad", on:"speech_start", action:"interrupt", to:"ep/meet"}`，留在总线热路径，不回宿主。
实时语音模型（Codex realtime）作为一种 harness 端点，音频帧走总线的二进制旁路。

**S6 另一个团队、不用 TypeScript。** 这是 A 最强的场景：他们用 Python/Go 写宿主，只讲 `host.ts` + 本文 §3 的 JSONL；
自己的路由逻辑就是自己的代码，pipe 只是缓存。通道或 harness 也可以用 jsonl-bridge 写成私有端点。
守护进程对他们没有任何"默认行为要先关掉"的负担。

## 6. 相对今天要改什么

| 位置 | 改动 |
|---|---|
| `packages/protocol/src/policy.ts` | `Admission` 去掉 `dispatch`/`observe` 的守护进程语义：入站一律发布，是否进端点由 pipe 决定；`admit`/`plan` 钩子删除，变成宿主侧代码。保留 `identify`（表未命中时）、`resolve`（无订阅者时）、`outbound`、`control` |
| `packages/protocol/src/host.ts` | 新增 `sub`、`pipe`、`pipe.remove`、`endpoint.open/close`、`bindings`、`endpoint.wanted`；`run.start` 改为糖；允许多个订阅连接、一个"控制"宿主 |
| `packages/protocol/src/watch.ts` | `Watch` 合并进 `Pipe`（`target` 变 `to: ep/<id>`），`WatchFilter` 加 `maxHops` |
| `packages/session/src/ingress.ts` | 从"admit → lane"改为"盖章 → publish"；actionId 编解码保留 |
| `packages/session/src/policy.ts` | `defaultPolicy` 整体搬到 `hosts/personal/` |
| `packages/session/src/watch.ts` | `WatchRegistry` 推广为 pipe 表（匹配、digest 攒批代码可直接复用） |
| `packages/session/src/lane.ts` | 不变，成为 harness 端点的内部件 |
| `packages/host-mcp` | `watch_add`、`send_message` 到非来源路由 → 宿主请求 |
| `docs/HOSTS.md` §2 | 删除"宿主断开退回默认策略"；宿主断开时 pipe 照常运行（宿主装的就是它对断线期间的指令），回调 fail closed |
| `examples/dev-gateway` | 拆成 `agents-io serve`（总线）+ `hosts/personal`（默认宿主） |

## 7. 弱点（如实）

1. **S1 是"默认宿主"不是"无宿主"。** 对只想要一个助手的人，多一个概念、多一个进程（即使自动拉起）。
   而且 personal 宿主写着写着会长出模型选择、记忆、会话重置……那就是方案"agents-io 就是 agent"换了个目录。
2. **pipe 会长成规则引擎。** 为了不让每条消息都回宿主，pipe 要支持 mentions、hop、digest、VAD 事件、打断……
   每加一个字段都在把"智能"往总线里拉。边界靠纪律维持："只确定性匹配，不调模型"。
3. **会话生命周期全推给宿主。** 什么时候 reset、何时 resume native id（`HarnessSession.nativeId()`）、上下文满了怎么办、
   换模型、空闲回收——每个宿主各写一遍。x-work-os 恰好不需要（一轮一进程），但讨论会话、S1、S4 都需要。
4. **热路径延迟。** pipe 未覆盖的消息（S4 的未 @ 语义路由）要过一次宿主往返，宿主若再调模型，飞书里会慢 1–3 秒。
5. **宿主是单点。** 回调 fail closed 意味着宿主挂了，新绑定、审批、路由变更全部停摆；pipe 只能维持已有的行为。
6. **agent 自主性变弱。** agent 想"去监听那个群"、"给别人发一封邮件"都要宿主批准往返；在单人场景这是摩擦，
   而 POSITIONING 原本允许默认 allowlist 无需审批。
7. **审批 UX 分裂。** 总线认识自己的审批 actionId，却不认识宿主的提问 actionId；同一张卡上两类按钮走两条路，
   宿主实现者要理解这个区别。
8. **产品定位。** "agents-io 是比 Claude Code 更宽 IO 的 agent，开箱即用"这一卖点在 A 里消失：
   拿到手的是总线 + 驱动 + 一个示例宿主，开箱体验取决于 personal 宿主做得多好。
9. **两套 id。** 宿主想的是任务 / 决定 / 成员，总线想的是 endpoint / topic / route；映射表在每个宿主里各存一份。

## 8. 什么时候选 A

- 你相信 agents-io 的长期用户主要是**已有自己系统的团队**（x-work-os、S6），他们要的是可靠的 IO 与驱动，而不是又一个 agent。
- 你愿意把"个人助手"当成 agents-io 的**示例宿主**而不是主产品，并接受 §7.1 的漂移风险。
- 判据一句话：**agents-io 里任何一行代码，如果它的存在需要回答"这条消息该不该让某个 agent 想一想"，就不属于 agents-io。**
