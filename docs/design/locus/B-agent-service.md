# 方案 B：agents-io 是智能来源——一个 IO 范围很宽的 agent 服务

> 状态：讨论稿（2026-10-07），供"智能放在哪"的选型对比。本文按最强形式论证 B，§7 列出真实弱点。
> 对照：`docs/POSITIONING.md`（现行定位：纯 IO 基建）、`docs/HOSTS.md`（宿主协议草案）、`packages/protocol/src/{policy,host,watch,harness,run}.ts`。

## 1. 一句话

**agents-io 对外就是"一个 agent"（更准确：一组有名字的 agent 身份），只是它的输入输出范围比 Claude Code / Codex 宽得多：飞书、邮件、会议、私有通道、别的 agent。** 宿主（x-work-os、个人 bot、别的团队的系统）不实现 agent，也不在热路径上替 agents-io 做判断；宿主只做三件事：

1. **声明**有哪些 agent 身份、各自听什么、用什么 harness/model、能用宿主的哪些工具（一份配置）；
2. **委托**：把任务或消息交给某个 agent，拿回结果（`agent.run` / `agent.tell`）；
3. **订阅**：异步收 agent 的产出和人的结构化操作（按钮、回复），写进自己的权威状态。

智能来自 harness 搭载的模型；agents-io 负责"让模型在对的时间、带着对的上下文、以对的身份醒来"，这部分编排本身就是 agent 的一部分，所以 B 把它算作 agents-io 的职责，而不是宿主的策略。

## 2. 为什么这样划分（核心论证）

- **路由就是智能的一部分。** "群里这句话该谁接""这封邮件要不要现在叫醒我""两个 agent 谁来答"——这些判断要么是确定性规则（@、发送者、会话），要么本来就该交给模型（triage）。前者是通用机制，几乎所有宿主答案相同；后者需要模型调用。两者都不需要宿主的业务状态，放在宿主里只会让每个宿主重写一遍。`Policy.admit/triage/watch`（`packages/protocol/src/policy.ts`）在 S1/S3/S4/S5 里没有一个宿主特有的答案。
- **同步策略回调是脆弱点。** `HOSTS.md` §3.2 让守护进程在每条入站消息上同步调宿主（3 秒超时、fail closed）。宿主重启 = 全部通道静默；会议场景（S5）的延迟预算容不下跨进程往返。B 把宿主移出热路径：路由是本地声明的数据，宿主只在异步事件里出现。
- **宿主真正独有的是"权威状态"和"可写的命令"，不是 IO 判断。** x-work-os 的独特价值是任务、决定、提问、经验（0001 §4.2），它本来就规定执行者"只经命令写入"（0003 [runner.output](1)）。这正好对应 B 的接口：宿主把命令作为工具挂给 agent，agent 用工具写状态；agents-io 永远不持有业务真相。
- **"宿主当成一个 agent"在 B 里反过来成立：宿主把 agents-io 当成一个 agent 成员。** x-work-os 0001 [member] 说人和 agent 用同一协议——agents-io 正好是那个"能听飞书、能读邮件、能开会"的 agent 成员，以 `runner:<id>/run:<ref>` 行动者身份写入。

## 3. 组件与职责

```
宿主（任意语言）            ── agent.run / agent.tell / deliver ──▶   agents-io 服务
  权威状态 + 命令             ◀── events（异步，带签名的 InputRecord）──    agents（声明式）
  以 MCP / CLI 暴露工具       ◀── 工具调用（agent 写宿主状态）───────    router · lanes · sessions
                                                                          harness 实例 · 通道 · outbox
```

| agents-io 拥有 | 宿主拥有 |
|---|---|
| agent 身份：名字、persona 文件、harness 实例、model、权限 profile、通道账号（`SendOp.as`） | 业务对象与真相：任务、决定、提问、成员绑定 |
| 路由：哪条输入叫醒哪个 agent、哪些只作上下文（现 `watch` 泛化为 `listen/see`） | 业务规则：什么输入要开任务（x-work-os 的 [input.standing]） |
| 拉起与生命周期：交互 session、一次性 task run、并发上限、空闲回收 | 选择"派哪个 agent 做这件事"（委托时给出 agent 名） |
| 防回声与 agent 间跳数预算 | 宿主工具的鉴权（凭据只对一次 run 有效，0003 [runner.actor](2)） |
| 会话内短期上下文（native session resume），**不做长期记忆** | 长期记忆、brief、经验 |
| 入站盖章 + 签名（宿主可验证"这条确实是某渠道身份发的"） | 身份结论：渠道身份 → 成员（0010 [channel.identity]） |

"memory-free"的含义：agents-io 的 session 只是一段对话缓冲，可以丢弃；凡是要跨 session 存活的东西，都必须经宿主工具写到宿主那里。这和 x-work-os 0001 §4.4.4"会话可随时丢弃，接手者依靠 brief 恢复"同构。

## 4. 路由模型：声明式 agent 表

一份配置描述"有哪些 agent、听什么、看什么"。它是现有 dev-gateway 配置（`examples/dev-gateway/aio.config.example.json` 的 `harnesses`、`policy.ownerSessionKey`、`watches`）的上一层：

```jsonc
// agents-io.json
{
  "principals": { "owner": { "lark-bot": "ou_owner", "mail": "me@example.com" } },  // 仅用于默认路由；宿主可不填
  "agents": {
    "me": {                                  // S1 个人助理
      "harness": "claude", "model": "sonnet", "persona": "personas/me.md",
      "session": "per-principal",            // 同一个人跨飞书和邮件是同一 session
      "listen": [{ "channel": "lark-bot", "kind": "dm", "from": "owner" },
                 { "channel": "mail", "to": "me@example.com", "from": "owner" }],
      "see":    [{ "channel": "lark-bot", "conversation": "oc_team", "mode": "digest", "every": "1h",
                   "note": "总结这一小时，列出要我处理的事" },          // S3
                 { "channel": "mail", "account": "owner-imap", "mode": "digest", "every": "1h" }],
      "replyTo": "origin"                    // 监听开的轮次回主路由，永不回被监听的会话
    },
    "coder":    { "harness": "codex",  "as": "lark:cli_coder",  "session": "per-thread",
                  "listen": [{ "channel": "lark-bot", "conversation": "oc_dev", "mention": "self" }],
                  "see":    [{ "channel": "lark-bot", "conversation": "oc_dev", "mode": "context", "authors": ["human", "agent"] }] },
    "reviewer": { "harness": "claude", "as": "lark:cli_reviewer", "session": "per-thread",
                  "listen": [{ "channel": "lark-bot", "conversation": "oc_dev", "mention": "self" }],
                  "see":    [{ "channel": "lark-bot", "conversation": "oc_dev", "mode": "context", "authors": ["human", "agent"] }] },
    "xwo-executor": { "mode": "task", "harness": "codex", "profile": "restricted",
                      "tools": [{ "cli": "x" }] },      // 无 listen：只能被委托；不接受推入
    "xwo-discuss":  { "harness": "claude", "session": "per-thread",
                      "listen": [{ "channel": "lark-bot", "conversation": "oc_xwo_discuss" }],
                      "tools": [{ "mcp": "http://127.0.0.1:7801/xwo", "auth": "env:XWO_DISCUSS_TOKEN" }] }
  },
  "routing": { "agentHops": 2, "onUnmatched": "drop", "actions": { "xwo:": "host" } }
}
```

规则（全部在 agents-io 里、确定性执行）：
- 一条入站先盖章（证据 + 作者类别：人 / 本部署 agent / 外部，沿用 POSITIONING §4 三步），再与所有 agent 的 `listen` 匹配：命中者开轮（`trigger`），只命中 `see` 的记作 `context`/`digest`。
- 多个 `listen` 命中同一条：按 `mention` 精确者优先；仍并列时由 `routing.arbiter`（可选的一次轻量模型调用）选一个，默认都不叫醒并记 notice。
- **防回声**：agent 自己的消息永不触发自己；agent 的消息只有在显式 @ 另一个 agent 时才可能触发它，并且每条线程累计 `agentHops`，到上限后只记 context。这把 x-work-os 0010 [channel.author] 的"本部署运行"作者类别直接用作路由输入。
- `mode: "task"` 的 agent 没有 lane：没有 steer、没有排队输入，路由表禁止任何 `listen` 指向它（加载配置时报错）。
- `routing.actions`：按钮 action id 前缀 → 交给谁。`"host"` 表示作为事件推给订阅的宿主，不进任何 session。

宿主 API（JSONL over unix socket，另提供同构 HTTP，任何语言可用）：

```jsonc
{ "type": "agent.run",  "id": "1", "agent": "xwo-executor", "runId": "run-0001", "cwd": "/work/t17",
  "input": [{ "type": "text", "text": "Read .brief.md" }], "env": { "XWO_CREDENTIAL_FILE": "/run/xwo/c1" },
  "override": { "model": "gpt-5.5" }, "observe": { "routes": [] } }        // → run.ended {status, exitCode}
{ "type": "agent.tell", "id": "2", "agent": "me", "session": "per-principal:owner", "text": "提醒我 3 点开会" }
{ "type": "deliver",    "id": "3", "as": "xwo-concierge", "operationId": "ask-123", "route": {…}, "message": {…} }
{ "type": "events.subscribe", "id": "4", "filter": { "kinds": ["action", "run.ended", "output.sent"], "agents": ["*"] } }
{ "type": "input.verify", "id": "5", "ref": "channel:lark-bot/om_abc" }   // → { author: {channel, channelUserId, evidence}, sig }
{ "type": "agents.reload", "id": "6" }                                   // 宿主改配置后热加载
```

`Policy` 钩子不删，降为**可选逃生口**：声明式表达不了的路由，可以把某个 `listen` 写成 `{ "exec": "./my-router" }`（一次性进程，stdin 一个 InputRecord，stdout 一个决定）。默认部署一个回调都没有。

## 5. 场景

**S1 个人助理（无宿主）。** `agents-io serve` + 上面的 `me`。飞书私聊和邮件都命中 `me.listen`，`session: per-principal` 让两边进同一 session：邮件里说的话，飞书里接着问能接上。回复按来源渲染（飞书卡片流式、邮件 final，`docs/CHANNELS.md` §2/§3）。没有任何宿主进程；长期记忆没有（memory-free），需要的话给 `me` 挂一个笔记工具或让它写 cwd 里的文件——这是用户自己的选择，不是 agents-io 内建。

**S2 x-work-os。**
- 执行：runner 领取任务（0003 [runner.claim]）→ Go 写的 start-executor 适配器发 `agent.run {agent:"xwo-executor"}`，`env` 带运行凭据（不进 argv，符合 [runner.actor](2)）。agents-io 拉起 codex，执行者只经 `x` 命令写状态；agents-io 不解析最终文本，只回 `run.ended.exitCode`（[runner.output]）。
- 提问：执行者自己调 `x ask …` 然后按 0006 [ask.answer](2) 用 `x wait` 拉取或直接退出。agents-io 什么都不做——"不推入运行中的执行者"由 `mode: task` 在 agents-io 里**结构性地保证**，不是靠约定。
- 推送：x-work-os 的分诊结束后，to-human 适配器发 `deliver {as:"xwo-concierge"}`，卡片按钮 id 为 `xwo:ask:123:opt2`。这里不需要模型：B 仍然提供纯 IO 能力，只是不止于此。
- 点击：飞书回调 → agents-io 盖章 → `routing.actions["xwo:"] = "host"` → 作为 `action` 事件推给订阅的 x-work-os，带渠道身份、证据、渠道引用 `channel:lark-bot/<msgId>` 和签名。x-work-os 按 0010 [channel.answer](3) 自己判断作者是不是被问者，再以渠道引用为幂等键写 `ask.answered`。agents-io 不知道"提问"是什么。
- 下一轮：任务重新就绪 → 新的 `agent.run`，新 session，靠 brief 恢复（0001 §4.4.4）。
- 讨论会话：`xwo-discuss` 是长驻交互 agent，听讨论群；它挂着 x-work-os 的 MCP 工具（`decision add` 等）。确认决定时，0010 [channel.confirm] 要求行动者是"表明确认那条消息的作者"：agent 调 `decision confirm --ref channel:lark-bot/om_x`，x-work-os 收到后调 `input.verify` 向 agents-io 核对这条消息确实由绑定成员发出——agent 没法伪造作者。权威状态仍然只在 x-work-os。

**S3 监听汇总。** `me.see` 两条 digest：群（机器人需在群里且开 `im:message.group_msg`）和主人邮箱（`owner-imap` 是以主人身份登录的邮件通道，CHANNELS §6"平台前提"）。每小时一轮，输入是 digest 系统块（不可信标注、`restricted` 档），回复到主人私聊，永不回群。和现在的 watch 实现完全一样，只是从"session 上挂的 watch"变成"agent 的声明"。

**S4 多 agent。** `coder`、`reviewer` 各用一个飞书应用身份（或同一应用 + `declaredSender`）。人 @coder → 只叫醒 coder；两者通过 `see … authors:["human","agent"]` 看到彼此的消息作为 context。coder 在回复里 @reviewer → 该线程 hop=1，叫醒 reviewer；reviewer 再 @coder → hop=2 到上限，只记 context 并发 notice"需要人接手"。没有宿主参与，也不会无限乒乓。

**S5 会议。** 会议通道把转写流作为 `kind: meeting` 的输入：`meeting-bot.see` 记 context（不开轮），`listen: {mention:"self"}` 命中"@bot"那句时开轮，回复走会议聊天。路由在进程内，没有跨进程策略往返，延迟只剩模型本身。语音阶段：同一个 agent 加 `voiceOut: stream` 通道，打断（barge-in）就是 lane 的 interrupt——这类强时序的逻辑放在宿主里根本做不好，是 B 最有利的场景。

**S6 别的团队、无 TypeScript。** 他们写一份 `agents-io.json`，用任何语言通过 socket/HTTP 发 `agent.run` / `agent.tell`、订阅 `events`；自己的业务命令用任意语言的 MCP 服务或 CLI 挂给 agent。路由能用声明式表达的（绝大多数：会话、发送者、@、关键词）就写配置；表达不了的，用 `listen.exec` 一次性进程，或者干脆不给 agent 写 `listen`，所有入站都经 `onUnmatched: "host"` 交给自己，再按自己的逻辑 `agent.tell` 给某个 agent——此时他们事实上退化成方案 A 的用法，B 允许但不推荐。

## 6. 相对现状要改什么

1. `docs/POSITIONING.md` §1"本身不是 agent 系统"改为"不是业务系统，但是 agent 服务"；§2 表中"进哪个 session、开不开轮""谁有资格 steer"移到左栏；判据改为"**需要业务真相的才是宿主策略**"。
2. `docs/HOSTS.md`：`run.start {run: RunSpec}` → `agent.run {agent, override?}`（RunSpec 由 agent 定义给出，宿主只能覆盖）；同步 `policy` 回调从主路径移除，保留为 `listen.exec` 逃生口；新增 `agent.tell`、`events.subscribe`、`input.verify`、`agents.reload`；"同一时刻至多一个宿主"可放宽为多订阅者，因为订阅者不在热路径。
3. `packages/protocol`：新增 `AgentDef`（harness、model、persona、session 策略、listen/see、tools、as、mode）；`Watch`（`watch.ts`）成为 `AgentDef.see` 的运行时形式，`target.sessionKey` 由 session 策略推导；`Admission.action: 'host'` 改为 `routing.actions` / `onUnmatched` 的一种去向；`InputRecord` 增加签名字段。
4. `packages/session`：新增 router（listen 匹配、hop 计数、仲裁）、session 策略（per-principal / per-thread / per-conversation / task）、`mode: task` 禁用 lane。
5. `packages/host-mcp`：除了输出工具，还要把宿主声明的 MCP / CLI 工具代理挂进 harness（每 run 一枚 token，沿用现有 `(sessionKey, generation)` 绑定）。
6. `examples/dev-gateway` 配置：`policy.ownerSessionKey`、顶层 `watches` 被 `agents` 段取代；`harnesses` 段原样保留，成为 agent 的下层。
7. persona 文件：agents-io 第一次拥有"提示词"（系统提示追加），需要版本化与按 agent 管理。

## 7. 真实弱点

- **身份表两份。** agents-io 有 `principals`/`agents`，x-work-os 有成员与渠道绑定（0010 [channel.identity](1) 要求在部署配置里）。B 用"agents-io 只给证据、宿主做结论"缓解，但默认路由（`from: owner`）仍需要一份身份表，两处会漂移。
- **配置 DSL 会长胖。** `listen/see/mention/authors/hops/arbiter/exec` 已经是一门小语言；openclaw `MsgContext` 的教训（`docs/design/thin-bridge.md` §1）说明这条路容易失控。
- **"派谁"的智能被拆成两半。** x-work-os 0001 [adapter](1) 把"选择 agent 产品与模型"交给适配器；B 里它在 agents-io 的 agent 定义里，宿主只能 `override`。按经验调模型（0007）要么回写 agents-io 配置，要么每次 override，两者都别扭。
- **agents-io 变成有观点的产品。** session 策略、persona、仲裁、hop 上限都是观点；不同宿主答案不同时，只能加选项或逃生口——这正是 POSITIONING 判据想避免的。
- **爆炸半径大。** 一个进程同时持有所有通道凭据、所有 harness、所有宿主工具 token；被监听内容的提示注入面也集中在这里。
- **逃生口一用就回到 A。** S6 里路由逻辑复杂的团队会走 `listen.exec` 或 `onUnmatched: host`，B 的价值对他们只剩"会驱动 harness 的 IO 层"。
- **可测试性。** 路由里有模型（arbiter、triage）后，"这条消息为什么叫醒了 reviewer"需要额外的可解释记录；宿主无法在自己的事件里复现。
- **与 x-work-os "核心不依赖特定适配器"的张力。** x-work-os 不依赖 agents-io 的代码，但讨论会话的体验（多 agent、@、监听）全部长在 agents-io 里，换掉它成本高，事实上的锁定比方案 A 强。
