# 方案 C：拉起是机制，唤醒谁是策略（agent 绑定表）

> 状态：讨论稿（2026-10-07）。对照组见同目录其他方案。本文按"最强形态"论证当前方向，并在 §8 列出真实弱点。

## 1. 一句话

**agents-io 拥有"把一个 agent 实例接上 IO 并跑起来"的全部机制（harness 适配器、lane、审批、渲染、投递）；"哪条输入唤醒哪个 agent 实例、谁只旁听"是一张可替换的绑定表（Binding），默认表由配置给出，宿主可以整表推送、逐条回调，或完全绕过（`run.start`）。**

智能来源的回答：**智能只来自模型（经 harness），判断"把哪份智能叫醒"的权力在策略层；agents-io 既不是大脑也不是哑管道，它是"神经 + 肌肉"：自带一套能独立工作的反射（默认绑定表），大脑（宿主）在场时由大脑覆盖。** 所以用户的二选一在 C 里不是二选一，而是同一机制的两种部署：
- 无宿主（S1）：agents-io 看起来就是"一个 IO 范围比 Claude Code 大得多的 agent"；
- 有宿主（S2）：宿主是大脑与权威状态，agents-io 是它的 IO 层兼执行器启动器。

## 2. 为什么"拉起"必须在 agents-io（机制论证）

如果 agents-io 只做 IO 分发、不拉起 agent（方案 B 类），以下能力会断开或被每个宿主重写：

| 能力 | 依赖"IO 层同时握着 harness 会话"的原因 | 代码 |
|---|---|---|
| steer / interrupt | 飞书里的插话要在 turn 边界或 native 注入，必须知道 turn 状态与 `expectedTurnId` | `packages/session/src/lane.ts:392`（steer 时重算 plan，profile 变了就降级为排队） |
| 审批按钮 | 卡片按钮 → `hub.locate(requestId)` → lane.resolve → `HarnessSession.respond` | `ingress.ts` 中 `actionClick` 分支 |
| 过程卡片 | compositor 从 `SessionEvent` 流直接渲染 card / final tier | `compositor.ts`、`channel.ts: ProgressView` |
| admitted ≠ consumed 对账 | 合批时哪些输入真正进了哪一轮，只有握着 harness 的一方知道 | `lane.ts` |
| profile 不借用 | 陌生人输入触发的轮次必须 restricted；判定发生在开轮前 | `policy.ts: plan` 默认实现 |
| 输出工具 MCP | 每个 harness 实例按 `sessionKey+generation` 挂专属 MCP token | `gateway.ts:253`、`packages/host-mcp` |

结论：拉起与 IO 是同一件事的两半，拆开只会让每个宿主重做 lane。**但"何时拉、拉谁"不同宿主答案不同 → 策略**（POSITIONING §2 的判据原样适用）。

## 3. 新概念：Agent 与 Binding

今天的缺口：`Admission` 只有一个 `sessionKey`（`protocol/src/policy.ts:278`），session 由会话路由键派生，harness 由 `plan` 每轮决定，**没有"agent"这个名字**；"谁监听什么"只能靠 watch。S4 两个 agent 同群因此无法表达。C 的最强形态补两张表：

### 3.1 Agent（命名的 agent 实例 = 智能的承载者）

```jsonc
"agents": {
  "coder":    { "harness": "codex",  "model": "gpt-5.5-codex", "profile": "restricted",
                "cwd": "~/work/repo", "account": "lark-bot:coder",          // 它用哪个通道账号发言（declaresSender）
                "instructions": "~/.agents-io/agents/coder.md",             // 只是透传给 harness 的系统提示文件
                "tools": ["send_message", "choices", "watch_add"] },
  "reviewer": { "harness": "claude", "model": "opus", "profile": "restricted",
                "account": "lark-bot:reviewer" },
  "assistant":{ "harness": "claude", "model": "sonnet", "profile": "bypass" }   // S1 的默认 agent
}
```

- Agent 是 `RunSpec` 的命名默认值 + 身份（发言账号、`declared` 名 `agent:<name>`）+ cwd + 工具白名单。`plan` 仍可逐轮覆盖 model/profile（升档、降权）。
- sessionKey 规范化为 `<agent>/<scope>`，例如 `coder/lark:oc_123`、`assistant/main`。同一会话里两个 agent = 两个 session、两条 seq 日志、两个 harness 会话，互不串上下文。
- harness 实例（`examples/dev-gateway/aio.config.example.json` 的 `harnesses`）不变：它是"怎么跑"（二进制、home、env），Agent 是"谁在跑"。

### 3.2 Binding（谁听哪些输入、以什么方式被唤醒）

Binding 把现有 `WatchSource/WatchFilter/WatchMode`（`protocol/src/watch.ts`）推广为唯一的路由原语。watch 退化为"agent 自己运行时创建的 binding"。

```jsonc
"bindings": [
  // S1：主人私聊和主人邮件 → assistant 的同一个 session
  { "id": "owner-dm",   "match": { "channel": "lark-bot", "kind": "dm", "from": "owner" },  "agent": "assistant", "session": "main", "on": "dispatch" },
  { "id": "owner-mail", "match": { "channel": "mail", "from": "owner" },                     "agent": "assistant", "session": "main", "on": "dispatch" },
  // S4：同一个群，按 @ 谁、经哪个账号进来分流
  { "id": "g-coder",    "match": { "account": "lark-bot:coder",    "conversation": "oc_dev", "mentions": ["@self"] }, "agent": "coder",    "on": "dispatch" },
  { "id": "g-reviewer", "match": { "account": "lark-bot:reviewer", "conversation": "oc_dev", "mentions": ["@self"] }, "agent": "reviewer", "on": "dispatch" },
  { "id": "g-ctx",      "match": { "conversation": "oc_dev" }, "agent": ["coder", "reviewer"], "on": "context" },
  // S3：旁听 + 每小时汇总
  { "id": "digest",     "match": { "conversation": "oc_team" }, "agent": "assistant", "session": "main",
    "on": "digest", "digest": { "everyMs": 3600000, "maxItems": 50 }, "replyTo": "owner-dm" },
  // S2：凡是点了宿主卡片、或宿主关心的会话，交宿主
  { "id": "xwo",        "match": { "action": "xwo:*" }, "on": "host" }
]
```

字段语义：
- `match`：`channel/account/conversation/kind/senders/from(principal label)/mentions/keywords/action(按钮 id 前缀)/authorKind(human|agent|external)`。只做确定性匹配，语义判断仍在 `Policy.triage`。
- `on`：`dispatch`（开轮，mode 取 queue|steer|interrupt）、`context`（observe_only）、`digest`、`trigger`、`host`（交宿主 `inbound` 帧）、`drop`。
- `agent` 可以是数组：一条消息可同时进多个 session（一个 dispatch，其余 context）。
- `replyTo`：被旁听触发的轮次回复去哪（今天是"主路由"，见 CHANNELS §6），**永远不回被旁听的会话**这一不变量保留。
- 求值：所有命中项都生效（fan-out），同一 `(agent, session)` 取最强动作（dispatch > trigger > digest > context），`drop`/`host` 只压制自己 `exclusive: true` 的范围。

### 3.3 Admission 从单目标变为投递列表

```ts
// packages/protocol/src/policy.ts
export interface Delivery { agent: string; sessionKey: string; on: 'dispatch'|'context'|'digest'|'trigger'; mode?: InputMode; replyTo?: ReplyRoute; binding?: string }
export interface Admission { deliveries: Delivery[]; host?: boolean; /* 兼容：action/sessionKey/mode 映射为单元素 deliveries */ }
```

默认 `admit` = "对绑定表求值"。宿主有三档覆盖方式（由轻到重），**同一条消息只走一档**：

| 档 | 宿主做什么 | 延迟 | 适合 |
|---|---|---|---|
| T1 配置 | 写 `agents` + `bindings`，不连 socket | 0 | S1、S3、S6 中只要静态路由的 |
| T2 推表 | 连接后发 `bindings.put {bindings, agents?, version}`，守护进程原子替换；宿主状态变（新任务、新讨论群）就重推 | 0（逐条），推表时一次 | x-work-os、S6 的非 TS 系统 |
| T3 逐条 | `host.hello.hooks` 含 `admit`，每条输入一个 `policy` 回调，返回 `Admission`（可以在 T2 表的结果上改：回调参数里带 `proposed`） | 一次 RPC（默认 3s 超时 fail closed） | 需要查业务状态才知道归谁 |
| T4 绕过 | `on: host` 收原始输入，自己判断后 `input` 注入或 `run.start` | 宿主自定 | x-work-os 执行器、完全自有调度 |

## 4. 拉起的三种方式（都在机制里，触发者不同）

1. **输入驱动**：Delivery `dispatch/trigger/digest` → lane 开轮 → `plan` → harness 开会话或 resume。这是"agents-io 像 agent"的路径。
2. **宿主驱动**：`run.start`（`protocol/src/host.ts:373`），新 session `run:<runId>`，一轮即关，结果只有 `run.ended.exitCode`。这是"宿主是大脑"的路径。新增可选 `run.start.agent`：用 Agent 的默认值，宿主只给指令。
3. **时间驱动**：digest 计时器（`session/src/watch.ts`）；可推广为 `bindings[].on: "schedule"`，cron 由宿主或配置给出。

## 5. 防回声与多 agent（S4 的硬规则）

- **身份按 agent 记，不按部署记**：`Identity.self` 扩成 `Identity.selfAgent?: string`。`lark-bot:coder` 发的消息回流时，对 coder 是 `self`（丢弃），对 reviewer 是 `authorKind: agent, principal: agent:coder`。今天 `defaultPolicy.identify` 对 `selfAccounts` 一律 `self` → 丢弃，导致 reviewer 看不见 coder（`session/src/policy.ts` identify 第一分支），这是要改的点。
- **跳数预算**：InputRecord 带 `hop`（触发链长度，存在 `channelContext.hop`）；agent 作者的消息 `hop = 触发它那轮的 max(hop)+1`；默认 binding 对 `authorKind: agent` 且 `hop >= maxHops(1)` 的输入只给 `context`，不开轮。于是 coder @reviewer 可以唤醒一次 review，reviewer 的回复不会再唤醒 coder，除非人参与（人的消息 hop 归零）。
- **declared 不可伪造**：沿用 POSITIONING §4 三步：只有 `agentAccounts` 里的平台账号的 `declared` 才被采信。

## 6. 六个场景

**S1 个人助理（无宿主）。** 配置：一个 `assistant` agent，`owner-dm`/`owner-mail` 两条 binding 指到 `assistant/main`。飞书适配器收私聊 → ingress `identify`（`platform_signed` 认主人）→ 默认 admit 求值命中 `owner-dm` → lane `main` 开轮 → `plan` 给 bypass → Claude Code 跑 → compositor 渲染 card 回私聊。邮件同理（`dkim_pass`），回复走 final tier、In-Reply-To 回原邮件。同一个 session 所以邮件里能接着聊飞书里的事。agents-io 在这里就是"那个 agent"。

**S2 x-work-os。** 执行器：x-work-os 的 start-executor 适配器（Go）读 0003 `StartRequest` → `run.start{agent:"executor-codex", runId, cwd, input:["Read the brief…"], env:{XWO_CREDENTIAL_FILE}}` → agents-io 拉起 Codex 无头一轮；执行器经 `x ask` 提问并阻塞（0003 §4.6）；agents-io 不推任何东西进去。x-work-os 的 to-human 适配器 `deliver` 一张卡片，按钮 id `xwo:ask-123:opt-2`。主人点击 → 飞书回调 → ingress 先 `identify`（0010 绑定由宿主实现 identify hook）→ binding `xwo` 命中 `on: host` → `inbound` 帧 → 宿主写 `answer`；按钮点击不再被 `hub.locate` 当作未知请求（今天 `ingress.ts` 的 `actionClick` 只认 `req:`/`turn:` 前缀，`xwo:` 前缀要按 binding 走）。超时则执行器结束，下一次 `run.start` 的 brief 带回答案。**讨论会话**：宿主 `bindings.put` 一条 `{match:{conversation:"oc_disc"}, agent:"discussant", on:"dispatch"}` 外加 `{..., on:"host"}`（同一消息同时进讨论 session 和宿主，宿主据此 `input add` 并保留渠道引用）。确认决定时由 discussant 调 x-work-os 命令；0010 §4.8 要求确认的行动者是那条消息的作者，agents-io 提供 `channelContext` 中的消息 id 作为会话引用，核实由宿主做。权威状态全在 x-work-os。

**S3 旁听汇总。** binding `digest`：群消息（需 `im:message.group_msg`）与主人收件箱（需主人身份登录的 IMAP 通道，CHANNELS §6 平台前提）都命中 → `assistant/main` 记 context 并缓存 → 每小时排一条系统输入开轮 → `plan` 见到非主人输入给 restricted → 回复投 `replyTo: owner-dm`。`Policy.triage` 可由宿主或一个便宜模型实现（"这封邮件值不值得进摘要"）。

**S4 双 agent 同群。** 两个飞书应用 = 两个通道账号，每个 agent 用自己的"耳朵"：同一条群消息到达两次（两个 account），`g-coder` 只匹配 coder 账号，`g-reviewer` 只匹配 reviewer 账号，`g-ctx` 只在一个账号上求值（按 `providerMessageId` 去重，复用 watch 的"同一消息只投一次"）。人 @coder → coder 开轮，reviewer 记 context。coder 回复（`as: agent:coder`）回流：对 coder 是 self 丢弃，对 reviewer 是 agent 作者 hop=1 → context；若 coder 在回复里 @reviewer 且 `hop<maxHops` → reviewer 开一轮 review；reviewer 的回复 hop=2 → 对 coder 只是 context，不成环。

**S5 会议。** meeting 通道（参照 `docs/research/meeting.md` 路线）把转写片段作为 `kind: meeting` 输入，`admission: observe`。binding：`{match:{kind:"meeting"}, agent:"scribe", on:"context"}` + `{match:{kind:"meeting", mentions:["@self"]}, agent:"scribe", on:"dispatch", mode:"steer"}`；回复路由是会议聊天。语音阶段：channel `voiceOut: stream`，harness 换成 realtime 模型的 harness 适配器（同样实现 `HarnessAdapter`），barge-in 走 `interrupt`。路由层不变，变的只是 harness 与通道。

**S6 别的团队、非 TS。** 用 `agents-io serve` + JSON 配置（T1），或 Python 进程连 unix socket 发 `bindings.put`（T2），复杂时实现 `admit` 回调（T3），私有通道走 `channel/jsonl-bridge`。他们写的是数据（表）和少量 RPC，不是插件；协议在 `packages/protocol` 的 JSON Schema（`scripts/emit-schema.mjs`）。

## 7. 相对今天要改什么

1. `protocol/src/policy.ts`：新增 `Delivery`；`Admission` 变为 `{ deliveries, host? }`（旧字段兼容一版）；`Identity.selfAgent`；`TurnDraft` 带 `agent`。
2. 新增 `protocol/src/binding.ts`：`AgentDef`、`Binding`、`BindingMatch`；`Watch` 改为 `Binding` 的子集别名（`createdBy` 为 agent 时受 `Policy.watch` 约束不变）。
3. `protocol/src/host.ts`：`bindings.put` / `bindings.get` 帧，`run.start.agent` 可选字段；`admit` 回调参数加 `proposed: Admission`。
4. `session/src/ingress.ts`：admission 处理改为循环 deliveries；实现 `host`（今天 `'host'` 在 ingress 中未处理，会落到 dispatch）；按钮点击先查 binding 的 `action` 前缀再查 hub。
5. `session/src/watch.ts`：求值器抽成通用 binding 求值器（来源匹配、过滤、去重、digest 计时都复用）；hop 计算。
6. `session/src/policy.ts`：`defaultPolicy` 的 `admit` = 绑定表求值，`ownerSessionKey` 迁移为一条默认 binding；`identify` 按 agent 区分 self。
7. `examples/dev-gateway/src/config.ts`：`agents`、`bindings` 两个顶层字段；`defaultHarness` 变为默认 agent。
8. 文档：POSITIONING §2 表格第一行改为"agents-io 提供绑定表求值；表的内容是策略"；HOSTS §3 加 T2；CHANNELS §6 改写为 binding 的一种。

## 8. 弱点（诚实列出）

1. **两套"大脑"并存的心智负担**：同一部署里，路由可能出自配置表、宿主推的表、逐条回调三处；排查"为什么 reviewer 没醒"要看三层。缓解只能靠 `admission` 事件把命中的 binding id 和来源层写进日志——但这仍是复杂度。
2. **绑定表会长成 DSL**：`match` 字段一旦不够，用户会要求 OR/NOT/正则/时间窗/"上一条是谁说的"。守不住就变成又一个规则引擎（x-work-os 0001 §4.4.1 明确警惕"规则会积累"）。守住就把复杂需求推给 T3，而 T3 有 RPC 延迟与 fail-closed 风险。
3. **Agent 定义与宿主的成员模型重叠**：x-work-os 把 agent 当成员、用 `runner:<id>/run:<ref>` 作身份；agents-io 再有一个 `agents.coder` 命名空间，两边要对齐（`declared` 映射）。宿主若把 agents-io 的 Agent 只当 RunSpec 别名，§3.1 的身份部分就是冗余。
4. **"拉起"的长寿会话与宿主的"一轮一进程"哲学冲突**：输入驱动的 session 会 resume、长期持有上下文，判断力存在会话里——正是 x-work-os 0001 §4.4.4 想避免的。C 只能说"x-work-os 不用这条路径"，但同一个守护进程里两种语义并存，容易被误用（例如把执行器绑到交互 session）。
5. **跨进程状态与权威性**：binding 表、digest 缓冲、session 日志在 agents-io 的 SQLite 里；宿主推的表若与宿主状态不同步（宿主重启、推表失败），会出现"任务已关但群仍唤醒 agent"。需要版本号与宿主断开时的 fail-closed（HOSTS §2 已有雏形），但这是一类新的一致性问题。
6. **单宿主限制**：HOSTS §5 只允许一个宿主连接；S6 团队若想与 x-work-os 共用一个守护进程，T2/T3 都要分区（按 binding 前缀或 agent 归属分配给不同宿主），协议还没有。
7. **智能放在哪仍然模糊**：路由本身需要智能时（"这条消息是在问 coder 还是 reviewer"），C 的答案是 `triage`/T3 回调——即又拉起一个模型做分诊，但它不在任何 Agent 的上下文里，成本、可观测性、谁为它负责都没定义。
8. **飞书多应用的平台成本**：S4 的"每 agent 一个耳朵"要求每个 agent 一个飞书应用与权限审批；单应用多身份（`declaresSender`）方案下 @ 无法区分目标 agent，只能退化为关键词/命令前缀路由。
9. **实时场景的边界**：S5 语音要求百毫秒级打断，Claude Code/Codex 的轮次启动以秒计；C 的机制层能承载 realtime harness，但那个 harness 适配器本身是独立的大工程，路由设计对它帮助有限。

## 9. 何时 C 是错的选择

若最终决定"agents-io 永远不持有长寿交互会话，所有 agent 都由宿主一轮一轮拉起"，C 的 lane/steer/binding 大半是死重，应选更薄的方案；若决定"agents-io 就是一个产品化的个人 agent"，C 的宿主三档覆盖是过度设计。C 的价值建立在**两类用户都要服务**这一前提上。
