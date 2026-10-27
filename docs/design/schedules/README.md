# 定时任务：`schedules`

> 状态：已实现（2026-10-27）：核心、配置、agent 工具、宿主请求、对外 MCP、`aio schedule`。
> 依据：`docs/POSITIONING.md` §2（机制与策略的判据）；`docs/CHANNELS.md` §6（监听：digest 的持久化与到点触发）、§7（输出工具）；`docs/HOSTS.md` §4（宿主请求、`session.prewarm` 里"提醒、例行快到点"的用途）；决定 13（扩展冻结时只加有真实出处的能力）。
> 出处：主人 2026-10-27：「加自定义消息监控和定时任务……特定时间推送什么的，感觉像是一个通用能力」；同日「怎么让别的 agent 知道怎么用这个定时任务的能力呢？以及发消息的能力呢？」。

## 1. 一句话

**到了约定的时间，守护进程往一个会话投一条输入（开一轮），或往一个路由发一条消息；主人在配置里写，agent 用输出工具给自己建，宿主用请求建。** 时间表与下次触发时刻存在网关的 SQLite 里，重启不漏、不重；没有任何定时任务时什么都不变。

## 2. 问题

| 位置 | 现状 | 结果 |
|---|---|---|
| `packages/session/src/watch.ts` | 只有监听的 digest 会"到点"开一轮，而且只在攒了消息时 | "每天 9 点看看日历""明天 10 点提醒我"做不到 |
| `docs/HOSTS.md` §4 `session.prewarm` | 宿主要自己知道"快到点了"，自己定时 | 每个宿主各写一套定时器，重启、错过、补发各管各的 |
| `packages/host-mcp/src/tools.ts` | agent 能 `send_message`、`watch_add`，不能约时间 | agent 答应了"到时候提醒你"却没有办法兑现 |
| agents-io-herdr 等宿主 | 没有 agent 的守护进程（宿主自己开 agent） | 定时只能落回宿主自己 |

定时触发是机制（什么时候、投到哪、只投一次），投什么、给谁看是策略；和监听一样属于 agents-io。

## 3. 方案

| 方案 | 做法 | 取舍 |
|---|---|---|
| **A 定时任务是一条记录，到点产生一条系统输入（采用）** | `schedules` 表 + 一个定时器；到点按动作开一轮、发一条消息或交给宿主 | 与监听的 digest 同构（持久化、到点、重启后重排）；不引入新进程 |
| B 外部 cron 调 `aio input` | 操作系统定时任务 | 每台机器各配，agent 建不了，重启补发、去重都没有 |
| C 宿主各自实现 | 交给 agents-io-herdr 等 | 只有那一个宿主能用，agent 的工具没有落点 |

## 4. 设计

### 4.1 一条定时任务

```jsonc
{
  "id": "morning",                       // 同一创建者内唯一；缺省生成 sc_<随机>
  "when": { "cron": "0 9 * * 1-5", "tz": "Asia/Shanghai" },   // 或 { "at": "2026-10-28T10:00:00+08:00" }（一次性）、{ "everyMinutes": 30 }
  "action": "turn",                      // turn：往 target 会话投一条输入开一轮；message：往 route 发 text，不开轮；host：交给宿主
  "target": { "sessionKey": "main" },    // action=turn：投进哪个会话（agent 建的永远是它自己的会话）
  "route": "lark-bot:default:oc_…",      // action=message：发往哪；action=turn：这一轮的回复去哪（缺省：会话的主路由，同监听）
  "text": "看看今天日历和待办，列出要我处理的事",
  "missed": "once",                      // 停机期间错过：once（补发一次，缺省）、skip（跳过，只排下一次）
  "until": "2026-12-31",                 // 可选：之后自动删除；一次性的触发后即删
  "note": "工作日早上的例行"               // 可选：随输入给出（为什么有这个定时）
}
```

- `when` 三选一。`cron` 是五段式（分 时 日 月 周），`tz` 缺省守护进程的时区；`at` 是一个时刻；`everyMinutes` ≥ 1。下次触发时刻由守护进程算好存下（`nextAt`），不在每次 tick 时重算整张表。
- 触发产生的输入：`origin` 为 `{ kind: "system", via: "schedule:<id>", adapter: "schedule" }`，内容是一行 `[schedule <id>] <text>`（`note` 有时另起一行），`channelContext` 带 `schedule=<id>`、`scheduledAt`（本该触发的时刻）、`firedAt`。它像 digest 一样排队（`queue`），不打断正在跑的一轮。
- `action: "message"` 经 outbox 发出（operationId `schedule:<id>:<scheduledAt>`，DL-1、DL-2），过 `Policy.outbound`；不开轮。
- `action: "host"`：作为一条宿主入站条目进宿主队列（`bindingId: "schedule:<id>"`），宿主照常读、ack；用于没有 agent 的守护进程（宿主自己决定怎么做，例如开一个 agent）。

### 4.2 只触发一次，跨重启

- 一张表 `schedules`（与监听同一个 SQLite 文件）：定义、`nextAt`、`lastFiredAt`、`createdBy`。
- 触发分两步，同监听 digest 的 flush：先写一条待定记录 `firing(id, scheduledAt)`，再投递，投递后删记录、推进 `nextAt`。进程死在中间：下次启动按待定记录重做，输入 id 固定为 `schedule:<id>:<scheduledAt>`，会话里已经有这个 id 就是重复（`duplicate`），不会投两次。
- 启动时：`nextAt` 已过的，`missed: "once"` 补一次（`channelContext.missed=true`，`scheduledAt` 是错过的那个最近时刻），`skip` 直接排下一次。不论错过几次，最多补一次。
- 一个定时器：总是只等最近的那个 `nextAt`（上限 2^31-1 ms），到点处理所有到期的，再等下一个。

### 4.3 谁能建

- **主人**：配置文件 `schedules: [...]`；本地 socket（`aio schedule add|list|remove`，attach 里 `/schedule`）。
- **agent**：输出工具（§4.4），目标永远是调用者自己的会话；`action: "message"` 的路由照常过 `Policy.outbound`（主人发起的一轮可以发往任何地方，其他只能 `current` 与预登记路由）。数量上限 `policy.scheduleLimit`（缺省每个会话 20 条），最短间隔 `policy.scheduleMinMinutes`（缺省 5 分钟）：防止 agent 把自己变成一个每分钟跑一次的循环。
- **宿主**：`schedule.put` / `schedule.remove { scheduleId }` / `schedule.list` 请求（feature `schedules`），可以指定任何会话或 `action: "host"`。
- 新钩子 `Policy.schedule({ schedule, by })`（默认：主人、宿主放行；agent 按上面两条限制；其他人拒绝）。
- 删除：创建者自己；主人、宿主可以删任何一条。

### 4.4 给 agent 的工具（输出工具，CF-6：按 agent 开启）

| 工具 | 做什么 |
|---|---|
| `schedule_add(when, text, action?, route?, missed?, until?, note?, id?)` | 给自己约一个时间：到点开一轮（缺省），或发一条消息；`when` 写 `{ at }`、`{ cron, tz? }` 或 `{ every_minutes }` |
| `schedule_list()` | 投进自己会话的定时任务（`mine` 标出自己建的） |
| `schedule_remove(id)` | 删自己建的 |

工具说明写清：到点时你会收到一条 `[schedule …]` 输入，那时再做事；一次性的提醒用 `at`；不要用很短的间隔轮询。

### 4.5 让 agent 知道它能做什么（发消息、定时、监听）

只有挂了输出工具的 agent 才有这些能力；它通过三处知道：

1. **工具本身**（主要）：MCP 的工具列表和说明，Claude Code 的 `alwaysLoad` 让它们总在提示里。`schedule_*` 与 `send_message`、`watch_*` 一样带完整说明。
2. **`get_channel_context()`**（已有）增加 `abilities`：这一轮可用的工具名、允许发往的路由、定时与监听的上限，让模型一次问清"我能做什么"。
3. **不在 agents-io 里的 agent**（外部 harness、宿主自己开的 agent）：对外 MCP 端点（§4.2 of HOSTS）加 `schedule_*`，scope `schedule:<会话模式>`；宿主可以把这个端点挂给它开的 agent，配一个说明这些工具怎么用的 skill（例如 agents-io-herdr 的 spawn 规则 `skills`）。发消息已有 `send_message`（scope `send:<路由模式>`）。

### 4.6 可解释性

`aio explain <inputId>` 对定时任务产生的输入给出 `schedule: { id, createdBy, scheduledAt, missed? }`；`aio schedule list` 列出全部（下次时刻、上次触发、创建者）。触发和补发各在目标会话日志里记一条 `notice`。

## 5. 协议 / Schema / 配置影响

- 协议：`Schedule`、`ScheduleDraft`；宿主请求 `schedule.put`、`schedule.remove`、`schedule.list` 与结果；`features` 增 `schedules`；`EffectExplanation` / `RouteExplanation` 增可选 `schedule`；`Policy.schedule`。
- 配置：`schedules`、`policy.scheduleLimit`、`policy.scheduleMinMinutes`。
- 存储：`schedules`、`schedule_firing` 两张表（`CREATE TABLE IF NOT EXISTS`）。
- 工具：`schedule_add` / `schedule_list` / `schedule_remove`（输出工具与对外 MCP）；`get_channel_context` 增 `abilities`。
- `PROTOCOL_VERSION` 不变；`pnpm schema`。

## 6. 不变量（新）

- **SC-1 每次到点只触发一次**：同一 `(id, scheduledAt)` 至多产生一次投递，跨重启；死在投递中途的按固定输入 id 重做，会话去重。
- **SC-2 错过的按 `missed` 处理，至多补一次**。
- **SC-3 agent 建的定时任务只投进它自己的会话，受数量与最短间隔限制；发消息过外发检查**（同 CF-7、DL-5）。

## 7. 分步

1. 核心：`ScheduleRegistry`（表、`nextAt`、待定记录）+ `ScheduleDispatcher`（一个定时器、到点按动作投递）+ cron 解析（五段式，不引第三方依赖）；配置 `schedules`；SC-1、SC-2 的测试。
2. agent 工具 `schedule_*`、`Policy.schedule`、限额；`get_channel_context.abilities`；SC-3 的测试。
3. 宿主请求 `schedule.*` 与 `action: "host"`；对外 MCP 的 `schedule_*`；`aio schedule` 命令行；HOSTS / CHANNELS 文档。

## 8. 不做

- 秒级精度、复杂日历（节假日、工作日历）：五段式 cron 加时区够用。
- 分布式（多台机器抢同一个定时任务）：一个守护进程管自己的表；多机靠各自的部署。
- 定时任务的输出另开一种渲染：触发的就是一轮普通的轮次，渲染、投递照常。
