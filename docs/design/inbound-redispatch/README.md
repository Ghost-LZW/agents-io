# 宿主入站补投：`inbound.redispatch`

> 状态：提案已实现（2026-10-07，分支 `feat/host-resolve-redispatch`），待 owner 拍板后记入 `docs/design/locus/DECISIONS.md`。
> 依据：`docs/POSITIONING.md` §2（机制与策略的判据）；`docs/HOSTS.md` §2.1（宿主入站队列）、§2.2（回调 `onFailure`）；`docs/design/locus/DECISIONS.md` 决定 1–8（尤其决定 7：会话 launch 随键固定）。

## 1. 一句话

**宿主可以把自己入站队列里的一条输入，以它到达时的原始 origin（发送者、主体、证据、来路）投递到宿主指定的会话；按 cursor 幂等，`aio explain` 两头可查。** 不调用就没有任何变化。

## 2. 问题

| 位置（`origin/main`） | 现状 | 结果 |
|---|---|---|
| `docs/HOSTS.md:49-54`、`packages/session/src/host-queue.ts:156-182` | 宿主入站队列只能读（`read`）、确认（`ack`） | 队列里的输入要进会话，宿主只能另发一条 |
| `docs/HOSTS.md:58`、`packages/protocol/src/host.ts:77-82` | 回调超时、出错、宿主不在线时按 `onFailure`（默认 `host`）进队列 | 宿主离线或回调超时期间到达的输入都停在队列里 |
| `packages/daemon/src/host.ts`（宿主连接的 origin 为 `host:<name>`，`kind: "system"`） | 宿主用客户端 `input` 帧转发时，origin 是宿主自己 | 发送者身份、证据、来路丢失；`human` 请求的资格、审计、回复路由都对不上；只能请人重发 |
| `packages/protocol/src/host.ts:274` | `HostRequestFrame` 没有把队列条目送回会话的请求 | — |

origin 只由守护进程盖章（`docs/HOSTS.md` §3）；宿主不能也不应伪造。补投的判断（投给谁、何时投）是宿主的策略，按原样投递是机制，属于 agents-io。

## 3. 方案

| 方案 | 做法 | 取舍 |
|---|---|---|
| **A `inbound.redispatch { cursor, agent?, session?, launch? }`（采用）** | 守护进程从队列取出该条目，以原 origin 投递，记 explain | origin 仍由守护进程出具（来自它自己落盘的条目）；宿主只能引用队列里有的条目 |
| B 客户端 `input` 帧允许宿主带 `origin` | 宿主自填 origin | 宿主可伪造任意发送者，破坏 origin 只由守护进程盖章 |
| C 重新跑一遍路由（`reroute`） | 按当前表重新路由 | 宿主表一般仍把它送回宿主（死循环）；宿主想要的是"投到这里"，不是"重新判断" |

会话选择沿用绑定规则的语义（`agent` + `SessionScope`，缺省 `per-conversation`），launch 沿用回调答复的校验（决定 7：随键固定，冲突即拒）——不发明新的会话寻址方式。

## 4. 设计

- 请求：`inbound.redispatch { cursor, agent?, session?, launch? }`，仅限已 `host.hello` 的连接（任何带 token 的连接，与 `inbound.read` / `inbound.ack` 相同）。只能引用宿主入站队列里**仍在**的条目（已 ack 但未被清理的也可）；否则 `unknown_cursor`。
- 投递：`Router.redirect` 用一条合成规则（`bindingId: "host:redispatch"`，`source: "host"`，`on: "dispatch"`）给出会话；本部署自己的回声仍记为 context，不起 turn。输入 = 原 `InputRecord`，`inputId` 改为 `<原 id>~r<cursor>`，`channelContext.redispatchedBy = "host:<name>"`；origin、内容、回复路由不变。
- 幂等：成功的结果按 cursor 记入 `host_redispatch` 表（与队列同库），再次请求原样返回并带 `duplicate: true`；并发的同一 cursor 合并为一次。失败（未知 agent、launch 冲突、会话拒绝、agent 不可用）不记，宿主可换会话再试。记录随条目保留，条目清理后再保留 `refTtlMs`。
- 不 ack：补投与消费游标无关，宿主照常 `ack`。
- `explain`：新输入的记录带 `redispatchOf: { inputId, cursor, by }`；原输入的记录追加 `redispatched: [{ cursor, inputId, sessionKey, agent?, by, at }]`。
- 错误码：`unknown_cursor`、`unknown_agent`、`not_interactive_agent`（task agent）、`invalid_frame`（坏的 `session` / `launch`）、launch 校验码（`launch_conflict`、`launch_not_allowed`、`bad_cwd`、`bad_env`、`launch_unsupported`）、`agent_unavailable`、`stopped`。
- 命令行：`aio redispatch <cursor> [--agent <name>] [--session main|per-conversation|per-thread|topic|<key>|<json>] [--cwd <dir>] [--env K=V …]`。

## 5. 协议 / Schema / 配置影响

- 新增宿主请求帧 `inbound.redispatch`（`HostRequestFrame` 成员，`HOST_REQUEST_FRAME_TYPES`），结果 `InboundRedispatchResult`（`{ cursor, of, inputId, sessionKey, agent?, on, launch?, disposition?, at, by, duplicate }`）。
- `RouteExplanation` 增可选 `redispatchOf`、`redispatched`。
- `host.hello` 结果 `features` 增 `"inbound.redispatch"`；旧守护进程对未知帧答 `invalid_frame`，宿主按 features 判断。
- 存储：`HostQueue` 库新增表 `host_redispatch`（`CREATE TABLE IF NOT EXISTS`）。无配置项。
- `PROTOCOL_VERSION` 不变；`pnpm schema` 重新生成。

## 6. 测试

`packages/daemon/test/inbound-redispatch.test.ts`：
- 非 owner 发送者的输入只进宿主队列；补投后会话收到的 origin 与队列条目完全相同，内容相同，带 `redispatchedBy`；`explain` 两头可查；不 ack。
- 同一 cursor 再请求（含换会话）答 `duplicate: true`，不重复投递；并发两个首次请求只投递一次。
- 缺省会话为 per-conversation；`unknown_cursor`、`unknown_agent`、`invalid_frame`；失败不记录，之后可成功。
- 未 `hello` 的连接答 `unauthorized`。
- `aio redispatch` 参数解析。

## 7. 迁移

无需迁移。新表按需创建；不发 `inbound.redispatch` 的宿主行为不变。
