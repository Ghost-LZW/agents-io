# agents-io 不变量清单

> 状态：2026-10-10 初版，对应 `docs/ROADMAP.md` §1 原则 4（承诺可检验）与 §3。来源：各设计文档、决定 1–12、代码注释与行为。代码位置以写作时的 `main` 为准（`c52bad5` 加上未提交的文档改动），行号会漂移，以函数名为准。
> 用途：改动 agents-io 的人或 agent 用它判断"这个改动有没有打破某个承诺"。新增承诺先写进这里，再写测试；测试改名时同步改这里。

## 0. 怎么读

每条不变量写成：

- **承诺**：一句话，能被测试判真假。
- **实现**：在哪里保证（文件:行）。
- **测试**：测试文件与 `it(...)` 名称。
- **状态**：`有测试`（主路径与已知边界都有测试）/ `部分覆盖`（主路径有测试，某些路径没有，或某些路径不成立）/ `没有测试`。
- **不成立**：代码里找到的、与承诺相反的路径。只写读代码确认过的；"可能"表示读代码得出、没有用测试复现。

术语：投递结算的取值是 `delivered` / `rejected` / `unknown`（`packages/protocol/src/events.ts:189-193`）；`ambiguous` 是 turn 与 run 的状态，不用于投递。

除特别说明，"跨重启"都以守护进程默认的 SQLite 日志为前提（见 RS-9）。

---

## 1. 输入生命周期（IN）

### IN-1 每条被接纳的输入都有终态

- **承诺**：进入 lane 的每条输入（`input.admitted`）最终有 `input.consumed`、`input.rejected` 或 `input.cancelled` 之一，不会静默消失；lane 关闭、detach、守护进程停止或崩溃都不例外（决定 13）。
- **实现**：`packages/session/src/lane.ts` `finishTurn`（未消费的重排一次，否则 `input.rejected`）；`pump` 的开轮失败（`start_failed`）；`onHarnessClosed`（harness 中途断开，`ambiguous` 并拒掉未消费的）；`take` / `cancelQueue` 记 `input.cancelled`；`stopTimers` → `rejectQueue`（`close` / `detach` 时拒掉排队的，之后 `pump` 和 `handle` 再遇到排队的也拒：关闭中结束的轮次重排的、admission 正等策略钩子的）；`settleDangling`（遗留 turn 结算时拒掉它没被消费的输入，含 steer 进去的）；`settleLeftoverInputs`（启动时拒掉上一个进程留下的 `snapshot.queued`，`gateway.ts` `settleLeftoverInputs` 在任何 lane 打开前对每个非 run session 调用）；`packages/session/src/log.ts` `foldSnapshot`（`turn.adopted` 也把它的输入移出 `queued`）；`packages/daemon/src/gateway.ts` `refuseUnavailable`（还没有 lane 时由网关写 `input.rejected`）。
- **测试**：`packages/session/test/lane.test.ts` "re-queues admitted-but-unconsumed inputs once, then rejects them"、"closes the turn as ambiguous when the harness stream ends mid-turn"、"interrupts the active turn and optionally clears the queue"、"interrupt-mode input stops the turn and runs next"、"close rejects queued inputs (lane_closed) and the interrupted turn's; nothing stays queued"、"an input requeued as the turn ends during close is rejected, not stranded"、"an input whose admission was awaiting a policy hook when the lane closed is rejected"、"detach rejects the inputs queued behind the running turn (lane_closed, with their route), never the turn's own; the next lane still adopts it"、"crash leftovers: inputs a previous process admitted and never settled are rejected (host_restarted) at startup; the open turn is left to adoption"、"settles a turn nobody adopted as ambiguous before the next turn starts, rejecting its unconsumed inputs"；`packages/session/test/e2e.test.ts` "stop with queued inputs: rejected (lane_closed) and the sender gets a notice on the route; the running turn ends on its own card"；`packages/daemon/test/stop-inputs.test.ts` "stop with queued inputs: they are rejected (lane_closed) and the sender is told on the chat; after a restart nothing stays queued"、"crash leftovers: inputs admitted but never settled by the previous process are rejected (host_restarted) at startup, and the snapshot lists none queued"；`packages/session/test/context.test.ts` "a turn that fails to start leaves the context pending for the next one"；`packages/daemon/test/runs.test.ts` "a session whose recorded agent is gone refuses input with agent_unavailable, never falling back to the default agent"；`packages/daemon/test/topics.test.ts` "a follow-up queued in the old topic while its turn rotates moves to the new topic"。
- **状态**：部分覆盖（停止、detach、崩溃遗留、遗留 turn 有测试；下面几条仍不成立）。
- **决定（决定 13，依据原则 1 与 §3 第一条）**：
  1. **拒绝原因码**：`lane_closed: <关闭原因>`（lane 关闭或 detach 时还在排队，含停止期间重排的；守护进程停止时原因是 `gateway stopping`）；`host_restarted`（上一个进程留下的：启动时的排队遗留，和没人接管的遗留 turn 里没被消费的输入，与该 turn 的 `error.code` 相同）；`start_failed: <错误>` 不变。格式统一为"代码"或"代码: 细节"，渲染端只看冒号前的代码。
  2. **通知**：只在输入还没进任何一轮渲染时通知（排队中被关闭、开轮失败）：这类 `input.rejected` 带 `replyRoute`（按路由分组，每组一条事件），compositor 在该路由上经 outbox 回一句（`rejectionNotice`，operationId `<session>:rejected:<首个 input id>:<路由>`，幂等）。冒号后的细节不发到通道（可能含路径、主机）。已经有卡片的轮次（`interrupted`、`ambiguous`、`not_consumed`）不带路由、不另发，卡片状态行已经说明。停止时通道已停收，通知是尽力而为（channel 在 compositor 停止之后才 `close`）。
  3. **崩溃遗留不通知**：`input.admitted` 不带记录（也不带路由），启动时的 `host_restarted` 只落日志、`aio sessions` 排队数归零，不发通道提示。不重放（重放属于 claude-persistence）。
  4. **接管路径不受影响**：`detach` 只拒排队的，不碰当前 turn 的输入；启动清理跳过日志里仍开着的 turn 的输入（它们不在 `queued`，由接管或 `settleDangling` 结算）；`settleDangling` 只在没人接管时运行（`turn.adopted` 先清掉 `dangling`）。run session（`run:`）的启动清理留给 `Runs`。
- **不成立**：
  1. **策略钩子抛错丢输入。** `known.add(inputId)` 在前（`lane.ts` `input`），随后无保护地 await `policy.control`（interrupt 模式）或 `policy.plan`（steer）。抛错时什么都没记，同 id 重试答 `duplicate`。
  2. **live 委托溢出。** `handoffs` 上限 32（`onHarnessEvent` 的 `live.handoff`），被挤出的、或 harness 一直没开 turn 的委托只有 `input.admitted new_turn`。
  3. 被接管（`turn.adopted`）的 turn 以 `inputs: []` 开始，harness 没报 consumed 的被接管输入没有终态（不能凭本进程的 `consumed` 判断：之前的进程可能已记过）。
  4. **detach 发生在开轮途中（可能）。** 输入已 `startTurn` 交给 Codex unix、`turn.started` 还没记下时停机：日志里它仍在 `queued`、没有开着的 turn，下次启动记为 `host_restarted`，而 Codex 可能已经在跑它（应为 ambiguous）。没有测试复现。
  5. lane 关闭后到达的输入答 `{ ok: false, reason: 'closed' }`，没进 lane、没有 `input.admitted`；调用方（ingress）是否在原路由上说明不在本条范围内。

### IN-2 未消费的输入重排一次，再拒绝

- **承诺**：harness 没消费的输入在 turn 正常结束或可重试失败后重排一次（`requeueLimit` 默认 1），之后 `input.rejected not_consumed`。
- **实现**：`lane.ts:1066-1081`。
- **测试**：`lane.test.ts` "re-queues admitted-but-unconsumed inputs once, then rejects them"。
- **状态**：有测试。

### IN-3 一轮不混两个主体或两个路由

- **承诺**：合批只合并相邻的、同一主体且同一回复路由的输入；后来者不会插到别人前面。
- **实现**：`lane.ts:760-770`（`takeBatch`、`batchKey`）。
- **测试**：`lane.test.ts` "never merges inputs from two principals or two routes into one turn"。
- **状态**：有测试。

### IN-4 harness 自行合批时记 ambiguous

- **承诺**：harness 消费了没交给本轮的输入（admitted ≠ consumed），本轮记 `ambiguous`，不当作成功。
- **实现**：`lane.ts:1060-1061`（`foreignConsumed`）。
- **测试**：`lane.test.ts` "marks a turn ambiguous when the harness consumed inputs it was not given"。
- **状态**：有测试。

### IN-5 同一条渠道消息只进一次

- **承诺**：同一 `(channel, account, id)` 的信封只被接纳一次；并发到达的副本合并；不同机器人账号收到同一消息 id 是两条。
- **实现**：`packages/session/src/ingress.ts:220-251`（`seen` + `inflight`，默认窗口 1 万条）；lane 内 `known`（`lane.ts:531`）；宿主队列另有持久去重（见 HQ-2）。
- **测试**：`packages/session/test/ingress.test.ts` "dedups by (channel, id)"、"dedups a duplicate that arrives while the first copy is still being processed"、"dedups per account: the same platform message id reaching two accounts is two envelopes"、"rejects invalid envelopes without remembering them"；`lane.test.ts` "ignores a duplicate inputId"；`packages/daemon/test/multi-lark.test.ts` "the same message id arriving at both bots: two inputs, two sessions, two input.verify records"。
- **状态**：部分覆盖。
- **不成立**：
  1. 去重表在内存里（`ingress.ts:193`），重启后平台重投的同一消息会以新的 input id 再进一次会话（宿主队列那份仍去重）。
  2. 部分失败后重试会重复：`deliverOwn` 对非 `LaneUnavailableError` 的错误直接抛出（`ingress.ts:460`），之前已投给其他会话的不回滚，`accept` 也不 `remember`（`ingress.ts:235-236`）；飞书适配器随后删掉自己的去重键等平台重投（`channel/lark-bot/src/adapter.ts:284`），重投以新 id（`ingress.ts:298`）再进那些会话。
  3. 窗口按条数不按时间，挤出时连带丢掉修订映射（`ingress.ts:249`）。

### IN-6 只记录的 context 输入在下一轮交出，跨重启不丢

- **承诺**：`context` 动作的输入不开轮，在该 session 下一次开轮时按到达顺序排在触发输入前面；有条数与字符上限，超出时保留最新并加一行说明；重启后从日志重建"已记录、未交出"的部分；digest 条目不重复交出。
- **实现**：`lane.ts:256-264`（记录时带完整输入）、`lane.ts:725-756`（`rebuildContext`）；上限见 `CONTEXT_DEFAULTS`。
- **测试**：`packages/session/test/context.test.ts` "context recorded but not handed before the restart goes to the next turn; handed context does not"、"provenance: flags come from the context actually handed, and stay for later turns"。
- **状态**：有测试。

---

## 2. 投递（DL）

### DL-1 每次投递以一条 delivery.settled 结束

- **承诺**：经 outbox 的每次投递恰好写一条 `delivery.settled`（`delivered` / `rejected` / `unknown`）；不可重试的错误是 `rejected`，重试用尽是 `unknown`，`unknown` 不再重放。单次尝试有上限（`attemptTimeoutMs`，默认 60 s），超时即 `unknown`、不重试（平台可能已收到）。外发检查抛错即 `rejected`（fail closed）。守护进程停止时最多等 5 s 让正在发的投递结算（通道与库都还开着），等待重试的立刻结算为 `unknown`；5 s 后仍在发的保留进行中记录，由下次启动结算（DL-2）。
- **实现**：`packages/session/src/outbox.ts` `Outbox.run`（政策检查、重试循环、`withTimeout`）、`settle`（先写 store 再写日志）、`drain` / `close`；`Gateway.stop()`（`gateway.ts:1827` 在 compositor 停止之后、通道关闭之前 `outbox.drain(5000)`，`:1835` 在关库之前 `outbox.close()`）。
- **测试**：`packages/session/test/outbox.test.ts` "delivers each operationId once, even when called again or concurrently"、"retries with backoff, then settles"、"settles as rejected on a non-retryable error and unknown when retries run out"、"an attempt that times out settles unknown and is not retried (the platform may have it)"、"an outbound check that throws rejects (fail closed) and is settled"、"drain waits for running attempts, stops retries; close leaves what still runs in flight for the next recover"；`packages/daemon/test/host.test.ts` "stop waits for a send in flight: it settles before the records close"；`packages/host-mcp/test/host-mcp.test.ts` "send_file on the local route is event-only (no adapter), still settled"。
- **状态**：有测试。
- **细节（按原则自决，决定 13）**：
  1. 超时默认 60 s（飞书上传大文件也够），嵌入方可经 `OutboxOptions.attemptTimeoutMs` 改；超时后的迟到结果被忽略。
  2. 停止时不再重试：重试前的错误多半表示没发出，但停止后无从确认，记 `unknown` 比留到下次启动更早进日志（原则 1）。
  3. `close()` 之后新投递答 `rejected`（`outbox closed`，确实没发，不写库），之后的结算不写库也不写日志，进行中记录留给下次启动。
- **不在承诺范围内（按设计）**：卡片流式编辑不经 outbox（`packages/session/src/compositor.ts:562-569`，RECOMMENDATION §3.1"progress 可以丢中间帧"）；宿主 `deliver` 找不到通道直接答 `unknown_channel`（`gateway.ts:1076`）。

### DL-2 operationId 幂等，跨重启

- **承诺**：同一 operationId 至多一次平台发送，重复调用返回第一次的结果；每次尝试在调用适配器**之前**写进行中记录，结算时在同一 savepoint 里写结果并删掉进行中记录。进程在两者之间死掉，下次启动把留下的进行中记录结算为 `unknown`（会话日志写 `delivery.settled`，守护进程日志一条 warn），**不自动重发**；同一 operationId 再来（还没恢复时也一样）直接得到这个 `unknown`。通道再各自做一层（飞书请求 uuid、邮件 Message-ID）。
- **实现**：`outbox.ts` `Outbox.deliver`（已结算 / 本进程在发 / 上个进程留下的进行中记录，三种都不再发）、`run` 里的 `store.begin`、`recover`；`OutboxStore` 接口加 `begin` / `inFlight` / `allInFlight`，内存实现 `MemoryOutboxStore`；SQLite 表 `daemon_outbox` 与 `daemon_outbox_inflight`（`packages/daemon/src/records.ts:35-36`、`DaemonRecords.put` / `begin`，接线 `gateway.ts:336`），启动时 `gw.outbox.recover()`（`gateway.ts:468`，在通道启动之前）；宿主 `deliver` 用 `host:` 命名空间（`gateway.ts:1072-1074`）；飞书 `adapter.ts:503-521`；邮件 `channel/mail/src/outbound.ts:17-21`、`channel/mail/src/adapter.ts:106-138`。输出工具的 operationId 是 `tool:<sessionKey>:<调用 id>`（CHANNELS.md §输出工具）。
- **测试**：`outbox.test.ts` "delivers each operationId once, even when called again or concurrently"、"a crash between the in-flight mark and the settlement: the next process settles it unknown and never resends"、"the same operationId is not sent again while an earlier process has it in flight, even before recover"、"marks each attempt in flight before calling the adapter, and settling clears the mark"；`packages/daemon/test/host.test.ts` "deliver is idempotent per operationId, across a restart too; an unknown channel is an error"、"a send in flight when the daemon died is settled unknown on the next start (logged in its session) and not sent again"；`channel/lark-bot/test/outbound.test.ts` "is idempotent: same operationId gives one platform message and a stable uuid"、"retries a failed operation under the same uuid"；`channel/mail/test/mail.test.ts` "is idempotent: same operationId, same Message-ID, one transport call"、"retries a pending send with the same Message-ID"；`host-mcp.test.ts` "is idempotent per tool call id"。
- **状态**：部分覆盖。
- **细节（按原则自决，决定 13）**：
  1. 进行中记录按尝试更新（记 `attempts`、`startedAt`、`turnId`），退避等待期间也在；死在退避里同样记 `unknown`（上一次尝试的结果本来就不明）。
  2. 进行中记录不随 30 天清理删除：下次启动总会结算它。
  3. 不自动重发：`unknown` 交给宿主或人决定（原则 6），代价是可能少发一次；重复发送（飞书上传、邮件 SMTP）不可撤回，少发可补。
- **不成立**：
  1. 结算记录 30 天后清理（`records.ts` `outPrune`），之后同一 operationId 会再发。
  2. 嵌入方不传持久 store 时（`MemoryOutboxStore`）跨进程不成立，见 RS-9。

### DL-3 回复只回到来源

- **承诺**：一轮的正式回复只投递到发起它的路由（`turn.started.replyRoute`）和 `extraDeliveries`；终端发起的轮次不会推到飞书。
- **实现**：`compositor.ts:445-451`（`owns()` 按 `(channel, account)` 认领路由）。
- **测试**：`packages/daemon/test/gateway.test.ts` "channel input → ingress → lane → harness → compositor card back on the route; local subscriber sees the stream"；`packages/session/test/compositor-accounts.test.ts` "a route of account b is rendered by b only"；`lane.test.ts` "steers only the turn owner; others are queued; another route becomes an extra delivery"。
- **状态**：部分覆盖（"终端发起的轮次飞书收不到"只在手工清单 E2E.md 里）。

### DL-4 多个飞书机器人时不以别的机器人发出

- **承诺**：多账号时 `deliver` / `systemReply` / `replyCaps` / 输出工具按 `(channel, account)` 选实例，只有该通道 id 恰好一个**配置条目**时才退回（数配置，不数在跑的：b 停掉或启动失败后 a 不会变成唯一的机器人）；找不到实例时 `deliver` 答 `unknown_channel`，区分“已配置但未运行”与“未配置”，并列出可用的 `(通道, 账号)`；`systemReply` 记 warn 不发；飞书适配器拒绝发往别的账号的路由（决定 8）。
- **实现**：`gateway.ts` `channelFor` / `configured` / `noChannelMessage`；`compositor.ts:445-448`；`channel/lark-bot/src/adapter.ts:492-495`（`ownRoute`，用于 send / edit / finalize / retract）。
- **测试**：`multi-lark.test.ts` "a bot that failed to start is configured but not running: its messages are never sent as the other bot"、"a DM to bot b is answered by b only, and its output-tool messages go out through b"、"host deliver: to its own account; an account that is not running is unknown_channel (no fallback with several bots)"、"one bot only: a delivery naming another account still goes out, as that bot's account"、"a binding with match.account only takes that bot's inputs"；`compositor-accounts.test.ts` "a route of account b is rendered by b only"、"restore: only the route's account picks up the open turn and finalizes its card"；`outbound.test.ts` "send / edit / finalize / retract refuse a route of another account, not retryable, without calling the API"。
- **状态**：已覆盖（停掉或启动失败的账号不退回，已修）。

### DL-4b agent 写出的每条消息带 agent 身份（`SendOp.as`）

- **承诺**：会话的卡片（compositor）和输出工具发出的每条消息都带 `as = session:<sessionKey>`（`agentIdentity`，与来源 `declared`、watch 的 `createdBy` 同一格式），适配器记下它，回流时作为 `declared` 读回（POSITIONING §2 身份表明）。宿主 `deliver` 与系统回复不是 agent 写的，不带 `as`。
- **实现**：`gateway.ts` `compose`（`as`）与 `HostTools.as`。
- **测试**：`multi-lark.test.ts` "every agent-authored message carries the agent identity (SendOp.as); host deliveries and system replies carry none"。
- **状态**：已覆盖。回流时 `agentAccounts` 里的账号声明本部署的 `session:<key>` 即认作 self（守护进程接 `isSelfDeclared`，按会话日志、lane、登记判断），不触发任何规则；测试 "an agent account's message declaring one of our sessions is our own echo: never a turn"。

### DL-5 外发目的地检查；宿主 outbound 回调失败即拒

- **承诺**：输出工具发往的每个路由都过 `Policy.outbound`（默认只允许本轮回复路由与预登记路由）；宿主声明了 `outbound` 钩子时由宿主决定，超时、出错、答复不合 schema 一律拒绝（决定 9）。
- **实现**：`gateway.ts:324-334`；`packages/daemon/src/host.ts:242-254`；`packages/host-mcp/src/tools.ts:380-397`（`allowed()`）。
- **测试**：`packages/daemon/test/host-callouts.test.ts` "the host decides; timeout, error and bad answers deny; without the hook the local policy decides"、"a host that only answers route callouts leaves outbound to the local policy"；`host-mcp.test.ts` "denies destinations outside Policy.outbound with a clear error and a notice"。
- **状态**：部分覆盖。
- **不成立**：
  1. 宿主断线时退回本地策略：`answers('outbound')` 在宿主断开后为假（`host.ts:97-100`），`gateway.ts:327` 改用 `local.outbound`。宿主收紧过的外发在它离线期间放宽，是 fail open，不是 fail closed。
  2. `live_join` 的目标（`gateway.ts:1164-1171`）不过 outbound 检查：agent 可以让机器人加入任意会议号。
  3. outbox 自带的 outbound 检查只在 `Delivery.from` 存在时生效（`outbox.ts:108`），守护进程里没有调用方传 `from`，实际只靠输出工具的 `allowed()`。

---

## 3. 宿主入站队列与补投（HQ）

### HQ-1 交给宿主的输入 ack 前不丢

- **承诺**：`on: host` 的输入写进持久队列，按消费者记游标，至少一次投递，宿主 ack 后才前移；推送与拉取语义相同；断线期间留在队列，重连后补推；`takeover` 时旧连接未确认的推送改推新连接（决定 1、10）。
- **实现**：`packages/session/src/host-queue.ts:82-87`（表）、`:190-196`（`ack` 只前移）、`:218-226`、`:282-305`（推送从已 ack 游标开始，只在接受时 ack）；`host.ts:203-221`；入队 `ingress.ts:344-347`；与日志共用 SQLite（`gateway.ts:266-270`）。
- **测试**：`packages/session/test/host-queue.test.ts` "keeps one cursor per consumer; ack only moves forward; read after an explicit cursor"、"push: delivers in order and acks what the consumer accepts; retries a refusal"、"push: unacked items are redelivered after a reconnect (at least once), also across a restart"、"a new subscription for the same consumer replaces the old one"、"retention: deletes only what every known consumer acked, after retainAckedMs"；`host.test.ts` "push: delivered in order, the cursor moves on { accepted: true }; a refusal is redelivered; unacked items come again after a reconnect"、"pull: inbound.read never moves the cursor; inbound.ack does; channel redeliveries are one item"；`packages/daemon/test/host-liveness.test.ts` "without takeover a second host is refused; with it the old connection is closed and its unacked push goes to the new host"。
- **状态**：有测试（跨重启只在 `HostQueue` 层测，网关层没有）。
- **注意**：`ack` 夹到 `head()`（`host-queue.ts:192`），宿主 ack 一个很大的游标会把没读过的也确认掉（按设计）；清理只算已登记的消费者（`:202-205`），之后才登记的消费者看不到已清理的条目。

### HQ-2 队列按渠道消息引用幂等

- **承诺**：幂等键是 `channel:<渠道>/<消息 id>`（按账号区分），同一消息重投返回第一次的游标。
- **实现**：`host-queue.ts:53-56`、`:107-133`。
- **测试**：`host-queue.test.ts` "appends idempotently on the channel reference: a redelivery returns the first cursor"、"dedups per account: the same message id on another bot account is a different message"；`packages/session/test/routing.test.ts` "queues host rules durably, idempotent on the channel reference, alongside the session deliveries"。
- **状态**：有测试。
- **注意**：引用在条目清理后再保留 7 天（`host-queue.ts:209` `pruneRefs`），更晚的重投会再入队。

### HQ-3 宿主不在线只变慢，不丢

- **承诺**：路由回调失败（无宿主、超时、出错、答复不合 schema、launch 被拒）走规则的 `onFailure`，默认 `host`，即进 HQ-1 的持久队列；不会在宿主不知情时拉起 agent（决定 2）。回调与否、结果都记入 explain。
- **实现**：`packages/session/src/router.ts:530-552`、`:430-437`。
- **测试**：`host.test.ts` "timeout → onFailure (default host: the durable queue); recorded in explain"、"an answer replaces the rule; no host → no_host and onFailure"；`packages/session/test/router.test.ts` "timeout → onFailure (default host); error and a bad answer too; recorded"、"no host (none connected, or no callout function) → onFailure without calling"、"a refused launch counts as an error answer: onFailure applies without the launch, the reason is recorded"。
- **状态**：有测试。
- **注意**：只在 `onFailure` 保持默认时成立；配置 `onFailure: 'dispatch'` 时回调失败会直接派发（`router.ts:531`），这是部署方的选择。

### HQ-4 补投按 cursor 至多一次，保留原来源

- **承诺**：`inbound.redispatch` 以原 origin、内容、回复路由投递，只在 `channelContext.redispatchedBy` 记宿主；同一 cursor 至多一次，投递被停止截断时答 `interrupted: true` 且不再发；失败不记，可换会话重试；explain 两头可查（决定 9）。
- **实现**：`gateway.ts:848-930`（`redispatchOnce`，待定记录 `:893`、补全 `:921`）；表 `host_redispatch`（`host-queue.ts:85`）；`ingress.ts:410-438`；`router.ts:483-492`。
- **测试**：`packages/daemon/test/inbound-redispatch.test.ts` "delivers a queued item with its original origin, records both sides in explain, and is idempotent per cursor"、"concurrent first requests deliver once"、"at most once: a redispatch cut off before its outcome was recorded is reported, never sent again"、"a delivery refused by the session is not recorded: a retry elsewhere (with a launch) goes through; agent_conflict; the result names the session's own agent"、"concurrent requests: when the first fails, a waiter tries again with its own arguments"。
- **状态**：有测试（"截断"是在同一进程里注入待定记录，不是真重启）。
- **注意**：原输入的 explain 过期（7 天）后，`redispatched` 反向链接静默不写（`ingress.ts:434`）。

### HQ-5 宿主推送的表带版本，宿主下线时按 onHostDown 生效

- **承诺**：`bindings.put` 整表原子替换，同版本同内容是空操作；宿主推送的表默认 `suspend`，宿主下线期间不生效；重启后保留最后一张表，挂起到宿主重连（`keep` 除外）；只拉取的宿主（`aio tail`）始终视为不在线，它的表用 `onHostDown: "keep"` 加定期重推、每次刷新 `expiresAt` 当租约（HOSTS.md §4、§6；`host.hello.lease` 已删除，决定 13）。
- **实现**：`router.ts:269-279`、`:312-318`、`:237-247`。
- **测试**：`router.test.ts` "atomic replace with version; the same version again is a no-op"、"suspends while the host is down (default) or keeps routing with onHostDown: keep"、"persists: a restart keeps the last table, suspended until the host reconnects (unless keep)"、"expires at expiresAt"、"pull-only host lease: onHostDown keep + a periodic re-push with a fresh expiresAt routes without a host connection, and lapses when the re-push stops"；`packages/protocol/test/admin-topics.test.ts` "host.hello has no presence lease (decision 13): pull-only hosts use onHostDown keep + expiresAt"；`host.test.ts` "installs the host table (routing follows it), persists it, and suspends it while the host is away"、"onHostDown keep stays active without a host"。
- **状态**：部分覆盖。
- **不成立**：
  1. ~~**`lease` 没有实现。**~~ 已删（决定 13）：`host.hello.lease`、`HostHelloResult.lease`、`AdminHostState.leaseExpiresAt` 从协议与 schema 删除；租约的正式做法是 `onHostDown: "keep"` + 重推刷新 `expiresAt`。旧宿主仍带 `lease` 不会被拒（对象 schema 允许多余字段），只是被忽略。
  2. 版本不比较先后：任何版本都替换当前表（`router.ts:270-275`），迟到的旧推送会覆盖新表。文档只说"带版本号"，没说单调；若宿主依赖单调，这里不成立。

### HQ-6 同一时刻至多一个宿主；接管要 token；/ws 有心跳

- **承诺**：带 `consumer` 或回调的 `hello` 才是宿主，同时至多一个；第二个默认 `host_connected`，`takeover: true` 且 token 正确才替换旧连接；`/ws` 心跳清掉半开连接。
- **实现**：`host.ts:155-180`（`timingSafeEqual` 先于角色判断）；`packages/daemon/src/console.ts:435-456`。
- **测试**：`host-liveness.test.ts` "closes a connection that stops answering pings, which frees the host role"、"keeps a connection that answers"、"without takeover a second host is refused; with it the old connection is closed and its unacked push goes to the new host"、"over /ws: a takeover closes the old (half-open) connection, which goes away even though it never answers"、"takeover with no host connected is a plain hello"。
- **状态**：有测试。
- **注意**：心跳只在 `/ws`；unix socket 上的半开宿主连接一直占着宿主位，直到有人 takeover。

### HQ-7 token 文件 0600

- **承诺**：token 文件不存在则生成（0600，目录 0700），存在则读；别人可读、太短、目录别人可写时拒绝启动。
- **实现**：`packages/daemon/src/token.ts:22-31`、`:50-58`、`:107-112`。
- **测试**：`packages/daemon/test/token-file.test.ts` "generates the file (0600, directory 0700) when missing, then reads it at every later start"、"refuses files others can read, short tokens, and directories others can write; the daemon does not start"；`host.test.ts` "writes a 0600 token file next to the socket; the token is required; frames before hello are refused"。
- **状态**：有测试。

---

## 4. 来源与身份（ID）

### ID-1 每条输入带来源

- **承诺**：每条 `InputRecord` 都有 `Origin`（kind、principal、evidence、via、adapter，可选 declared、self）；合成的输入（略去行、live 委托、话题摘要、digest）用 system 来源，`principal: null`。
- **实现**：`packages/protocol/src/inbound.ts:74-92`（必填字段）；`ingress.ts:253-271`；`packages/session/src/watch.ts:423`（被监听的保留原发送者）；`lane.ts:685`、`:928-934`；`gateway.ts:1255`。
- **测试**：`ingress.test.ts` "stamps origin from Policy.identify and dispatches owner input to a lane"；`watch.test.ts` "records a watched group message as context in the target, keeping the original origin"；`packages/session/test/live.test.ts` "a delegation becomes an input from the far side and the harness-started turn runs as the lane turn"。
- **状态**：有测试。

### ID-2 模型看得到来源

- **承诺**：交给 harness 的每条输入前面有发送者说明（主体、来源类型、经由的路由、是否经 watch），被监听与外部内容明确标注（决定 5）。
- **实现**：`harness/claude-code/src/content.ts:31-38`、`:128`；`harness/codex/src/map.ts:25-30`。
- **测试**：`harness/claude-code/test/claude-code.test.ts` "one SDKUserMessage per input, uuid bound to inputId, explicit priority, preface"、"preface marks unknown senders and agents"、"labels context-only inputs as not addressed to the agent, keeping their own sender preface"；`harness/codex/test/codex.test.ts` "labels context-only inputs as not addressed to the agent (also without the sender preface)"。
- **状态**：部分覆盖。
- **不成立**：
  1. 两个 harness 的说明都不含 `origin.evidence`（`content.ts:33`、`map.ts:27`）；决定 5 列的"证据"模型看不到。Codex 还不显示 `self`。
  2. Codex 的 `preface: false`（`harness/codex/src/session.ts:79`、`map.ts:65`）整个关掉发送者说明，连 watch 标记一起没了。
  3. 没有测试断言 `watch=` 标记出现在模型输入里。
  4. 模块 harness 自己渲染输入，核心不保证有说明。

### ID-3 Origin 由网关盖章，客户端不能设置

- **承诺**：`Origin` "由网关盖章，客户端不能设置"（`inbound.ts:74`）；适配器只提交本命名空间内的 `channelUserId` 与证据（RECOMMENDATION §3.5 第 1 条，POSITIONING §2）。
- **实现**（channel-stamping，决定 13，`docs/design/channel-stamping/`）：
  1. **来源绑定（C）**：网关为每个通道的 `emit` 构造 `EmitSource`（`gateway.ts` `startChannel` 的 `emit`、`emitSource`），`Ingress.accept(env, source)` 在去重之前核对 `env.channel/account` 与 `replyRoute` 的 `channel/account`，不符即 `accepted:false`、`error` 以 `SOURCE_MISMATCH`（`source_mismatch:`）开头，不进去重表、不写 `input.verify`（`ingress.ts` `accept`、`sourceMismatch`）；网关记日志（每通道每原因每分钟一条）并计 `AdminChannel.rejected`（`gateway.ts` `stamped`）。
  2. **id 归属（F4）**：一个通道 id 只属于一种适配器（`gateway.ts` `channelOwner`、`idConflict`）；内置 id `lark-bot`/`mail`/`local` 不许 bridge、module 使用；不同 bridge 程序共用 `id` 在配置校验时失败（`config.ts` `resolveChannels`），module、嵌入方适配器与已连上 bridge 的冲突在启动时失败（`startChannels`），live apply 时进 `failed`；bridge 的 id 由配置 `id`（`expectId`）或第一次 hello 固定，换 id 或 hello 的 id 被网关拒绝（`acceptId`）都是 `bad_hello`（`channel/jsonl-bridge/src/host.ts` `connect`）。
  3. **证据封顶（E3）**：上限 = 条目 `evidence` ∩ `caps.evidence` ∪ `none`，不写时 bridge、module 只有 `device_only`（`config.ts` `UNGRANTED_EVIDENCE`、`gateway.ts` `emitSource`）；超出降为 `none`、`caps.declaresSender` 为 false 时丢 `declared`，在浅拷贝上做，调用方对象不变（`ingress.ts` `capEnvelope`）；`identify`、`Origin`、宿主入站队列、watch 与 `input.verify`（`Gateway.accept` 记 `r.envelope`）都只看封顶后的信封；`RouteExplanation.claimedEvidence` 记原声明，`AdminChannel.evidenceCapped` 计数。

  本地 socket 与宿主连接的 origin 由连接决定（`packages/daemon/src/local-server.ts:343-347`、`host.ts:63`、`:178`）。
- **测试**：`packages/session/test/ingress.test.ts` "refuses an envelope claiming another channel, account or reply route, without remembering it"、"checks the source before dedup: a forged copy of a seen (channel, account, id) is invalid, not a duplicate"、"caps evidence beyond the source to none: the owner is a stranger, the explanation keeps the claim, the caller object is untouched"、"drops sender.declared when the source may not declare senders, also from a trusted agent account"、"emitter(source) answers like accept(env, source); without a source nothing is checked or capped"；`packages/daemon/test/channel-stamping.test.ts` "a channel claiming another channel as the owner is refused: no lane, no input.verify record, counted"、"a bridge whose hello claims a built-in id is failed: its inbound is never taken, it routes nothing as lark-bot"、"a bridge whose hello takes the id of another running adapter fails the start (F4)"、"one bridge program under one id runs several accounts"、"a bridge may not use a built-in channel id"、"two different bridge programs may not share a channel id; one program with two accounts may"、"parses an evidence grant on any channel entry; entries without one are unchanged"、"a bridge without a grant gives no platform_signed: the owner is a stranger, recorded as none, counted"、"a granted bridge gives it (∩ caps); a grant beyond caps is warned about and ignored"、"an in-process adapter is capped by its caps"；`packages/daemon/test/module-channel.test.ts` "fails when two entries give the same (channel, account), also against another channel"、"without an evidence grant its platform_signed is capped to none (stranger, counted in status, recorded as none)"；`channel/jsonl-bridge/test/bridge.test.ts` "expectId: a hello declaring another id is bad_hello; with retryFirstConnect the peer is restarted and stays refused"、"without expectId the first hello pins the id: a restarted peer declaring another is refused"、"acceptId can refuse a hello id (bad_hello)"、"a refused inbound is answered ok:true with {accepted:false}"；一致性套件 `inbound.channel_id`、`inbound.account`、`inbound.evidence_in_caps`（`packages/testkit/src/channel-conformance.ts`）。
- **状态**：有测试。
- **边界**（有意如此，不算不成立）：
  1. 不传 `source` 的 `Ingress.accept(env)` / `Gateway.accept(env)` 把调用方当受信方（嵌入方自己构造信封、测试），行为与盖章前相同。
  2. 嵌入方经 `GatewayOptions.channels` 传入的适配器按类归属：同类的多个对象（多个机器人）可共用 id；嵌入方代码与守护进程同等受信。
  3. 身份键不含账号（`identity.ts` `identityKey`）：F4 之后只有同一种适配器的多个账号共享身份命名空间，不再能跨通道冒充（提案 §10 第 4 项）。
  4. 出站按 id 退回（DL-4）不属于本条。

### ID-4 证据不足的主人按陌生人处理

- **承诺**：身份映射命中但证据不在接受集合（默认 `platform_signed`、`dkim_pass`）里时 `principal: null`；文本或 `declared` 里的自称不能冒充主人（决定 3，POSITIONING §4）。
- **实现**：`packages/session/src/identity.ts:21`、`:109-112`。
- **测试**：`packages/session/test/policy.test.ts` "an owner address without evidence is a stranger (forged From)"、"a DKIM-verified or platform-signed owner is the owner"、"never accepts a declared identity that names an owner, even from a trusted agent account"；`router.test.ts` "stamps principal and labels only with accepted evidence (default platform_signed, dkim_pass)"、"owners config is the minimal map; a host map overrides it per channel identity and is suspended with its table"。
- **状态**：有测试。证据本身由 ID-3 保证可信：只可能来自有资格给出它的通道（条目授予 ∩ caps），否则降为 `none`，测试见 ID-3（`channel-stamping.test.ts` "a bridge without a grant gives no platform_signed: the owner is a stranger, recorded as none, counted"）。

### ID-5 本部署的回流不开轮

- **承诺**：本部署自己发出的消息回流时标 `self`，默认丢弃；即使规则或监听设了包含回流，也只记作 context，永远不开轮。
- **实现**：`ingress.ts:262`、`:276`；`router.ts:503`；watch 的 `excludeSelf`。
- **测试**：`ingress.test.ts` "drops self echoes and unknown DMs; observes strangers in groups"；`watch.test.ts` "own echoes: excluded by default; with excludeSelf false only ever context, never a turn (no loops)"。
- **状态**：有测试。

### ID-6 权限 profile 按触发输入定，不按上下文降档

- **承诺**：`Policy.plan` 只看触发本轮的输入（默认：全部来自主人才 `bypass`），上下文里混入的监听、群聊、外部内容不改变 profile；会让 profile 变化的 steer 改为排队（决定 5）。
- **实现**：`lane.ts:856`（plan 不含 context 记录）、`lane.ts:573-574`；`policy.ts:96-101`。
- **测试**：`policy.test.ts` "bypass only when every input is from an owner"；`watch.test.ts` "a trigger turn keeps the original sender: restricted for a stranger, bypass for the owner"；`lane.test.ts` "auto: answers immediately per policy (bypass → allow)"、"auto deny for a restricted turn"；`routing.test.ts` "the owner @-ing in a group after strangers talked: tagged watched + external + group (never blocked or downgraded)"。
- **状态**：部分覆盖（"context 不改变 plan"和 steer 的 `profile_change` 降级没有直接测试）。
- **注意**：live 委托 turn 不调 `plan`，沿用 `lastRun`（`lane.ts:968`），所以主人放行的一轮之后，会议里任何人的委托都按 `bypass` 自动放行审批（`policy.ts:106`）。这是决定 11"与文字会话同权限"的字面结果，不算违反，但值得在决定 11 里写明这个后果。

---

## 5. 可解释性（EX）

### EX-1 每个路由决定都记下，explain 跨重启可查

- **承诺**：每条输入的路由决定（命中的规则、回调与否及结果、失败模式、`skipped_pinned`、`agent_unavailable`、补投两头）持久记录，`aio explain <inputId>` 重启后仍能查。
- **实现**：`router.ts:223-233`、`:655-665`；`packages/daemon/src/cli.ts:512-517`。
- **测试**：`router.test.ts` "are persisted: explain(inputId) works across a restart"；`host.test.ts` "explain returns the routing record of an input; unknown ids are an error"；`routing.test.ts` "only-host inputs report action host; explain(inputId) shows the rules"、"a dropped input is explained too"；`runs.test.ts` "a channel message to a session whose agent is gone: refused (no harness), a notice on the route, and explain says agent_unavailable"。
- **状态**：有测试。
- **注意**：记录保留 7 天（`explainTtlMs`，`router.ts:165-166`）。

### EX-2 从任何副作用追溯到触发它的轮次与输入

- **承诺**：发消息、宿主写命令、审批等任何副作用都能由 `aio explain` 追溯到触发它的轮次与输入（ROADMAP §1 原则 4、决定 4）。
- **实现**：没有。`explain` 只接受 inputId（`cli.ts:512-517`，协议 `Explain = { inputId }` 在 `packages/protocol/src/host.ts:286`），只返回路由记录（`router.ts:662-665`）；没有按 operationId、providerMessageId、requestId、turnId 的查询。能手工从日志串起来的：输出工具与卡片的 `delivery.settled` 带 `turnId`，`render.anchor` 把平台消息 id 映射到 turn，`turn.started.inputIds` 再到输入。串不起来的：系统回复（`gateway.ts:1104-1109`，只有 `${code}:${inputId}` 形式的 operationId，没有 turn）、宿主 `deliver`（`sessionKey: host:<name>`）、卡片流式编辑、`live_say`（什么都不记）。本轮来源摘要（`lane.ts:338-353`）不含 inputIds，只在内存里保留最近 256 轮。
- **测试**：无。
- **状态**：没有测试。
- **不成立**：原则 4 后半句与决定 4"`aio explain` 能从任意写入追溯到触发它的轮次与输入"目前都没有实现。

### EX-3 宿主写请求附带本轮来源标记

- **承诺**：输出工具的每次调用附带本轮来源摘要（是否含 context / digest / 外部 / 群聊），不拦截（决定 4，HOSTS.md §宿主写命令的来源标记）。
- **实现**：`tools.ts:404-405`（`provenance` 写进 `agents-io.output` 记录）；`lane.ts:338-353`。来源不进 harness 子进程环境：任务运行只带 `AGENTS_IO_RUN_ID`（`gateway.ts` `openRunLane`），`AGENTS_IO_TURN_PROVENANCE` 已删除（决定 13）。
- **测试**：`host-mcp.test.ts` "tags every write with the turn provenance (never blocks it)"；`packages/daemon/test/runs.test.ts` "env goes into the run child only: the instance built for the run has it; the log, explain records and other instances do not"（带 `AGENTS_IO_RUN_ID`、不带 `AGENTS_IO_TURN_PROVENANCE`）；`context.test.ts` "provenance: flags come from the context actually handed, and stay for later turns"；`routing.test.ts` "an owner DM: triggered by the owner, nothing watched, external or group"、"a watch trigger from a stranger: triggered by null, watched, external"。
- **状态**：部分覆盖（agent 在工作区里直接调 `x` 这类宿主命令时，交互 session 拿不到本轮来源，宿主无从核查）。

---

## 6. 会话与 lane（LN）

### LN-1 每个 session 一条 seq 连续、只增的日志

- **承诺**：持久事件的 seq 按 session 从 1 连续递增，不改写；delta 等易失事件不占 seq、不落盘；压缩只把旧事件折进快照；订阅者从任意 seq 续上不缺不重。
- **实现**：`log.ts:227-249`；`packages/session/src/sqlite-log.ts:46`、`:58-61`（`(session_key, seq)` 主键，只 INSERT）、`:73-77`、`:84-100`。
- **测试**：`packages/session/test/log.test.ts` "assigns gapless per-session seq to durable events only"、"forces deltas ephemeral and other kinds durable whatever they claim"、"survives reopen: head, events and fold are restored"、"compacts old events into a stored snapshot"、"trims to `retain` and reports the floor"；`packages/session/test/hub.test.ts` "resumes from a seq: replay then live, no gaps"、"gives two subscribers the same durable sequence"；`gateway.test.ts` "reconnecting with fromSeq replays exactly what was missed"；`lane.test.ts` "runs a turn and wraps harness events into a gapless, conforming session stream"。
- **状态**：有测试（主键挡住重复 seq 这一点没有测试）。

### LN-2 一个 session 只有一个写者 lane，同一时刻至多一个 turn

- **承诺**：每个会话键至多一个 `Lane`；命令与 harness 事件在 lane 里逐个处理；同一时刻至多一个 turn。
- **实现**：`gateway.ts:223`、`:703-736`（同步的取或建）；`lane.ts:455-459`（`serial`）；`lane.ts:833`、`:853`（先置 `this.turn` 再 await）。
- **测试**：`lane.test.ts` "never merges inputs from two principals or two routes into one turn"；`live.test.ts` "a delegation becomes an input from the far side and the harness-started turn runs as the lane turn"。"一个键一个 lane"本身没有测试。
- **状态**：部分覆盖。
- **不成立（可能）**：`closeLane`（停放话题空闲时关闭）先把 lane 从表里删掉，再最多等 8 s 关闭它（`gateway.ts:1316-1324`）。这期间到达的输入会为同一个键建第二个 `Lane`（`gateway.ts:715`），旧 lane 的事件循环只检查 generation 与 detached、不检查 closed（`lane.ts:885`），两个 harness 会话可能同时续接同一个原生会话。日志 seq 仍单调（共用同步日志），但有两个写者。

### LN-3 一个 session 至多一个 live

- **承诺**：同一 session 同时至多一个 live；已有 live 时 `live_join` 报错；并发的第二个 `live_join` 在 `await openLive` 之前就被 `joining` 占位拒绝，不碰正在跑的 live，也不为它开端点（决定 11）。
- **实现**：`gateway.ts` `joinLive`（`joining` 占位）；`lane.ts:386`。
- **测试**：`live.test.ts`（session）"starts the harness live, records live.started, refuses a second one, and needs a harness that has it"；`packages/daemon/test/live.test.ts` "two concurrent live_join: one wins, the other is refused without touching the running live or opening an endpoint"、"live_join pairs the channel peer with the harness voice; the far side hanging up ends both; live_say / live_leave"。
- **状态**：已覆盖（先后两次与并发两次）。

### LN-4 live 任一端结束，两端都结束并记 live.ended

- **承诺**：对端离会、harness 关闭、`live_leave`、守护进程停止，任一发生都关闭另一端并记 `live.ended`。
- **实现**：`gateway.ts:1204-1208`、`:1231-1246`、`:1791`；`lane.ts:951-954`。
- **测试**：`daemon/test/live.test.ts` "live_join pairs the channel peer with the harness voice; the far side hanging up ends both; live_say / live_leave"、"live_leave ends the live; the gateway stopping ends a running one"。
- **状态**：部分覆盖（"harness 结束 → 端点关闭"只测了回调；"停止时记 live.ended"只断言端点关闭）。
- **不成立（可能）**：守护进程停止时 Codex 只在 `thread/realtime/closed` 或 5 s 兜底后发 `live.ended`（`harness/codex/src/session.ts:795-803`），而 `leaveLive` 整步限时 5 s（`gateway.ts:1791`），随后 lane 被 detach，之后的事件被丢弃（`lane.ts:885`），`live.ended` 可能不进日志。

### LN-5 live 传输不符时在 start 之前拒绝；frames 的视频只给声明了 video 的 live

- **承诺**：`live_join` 在 `start` 之前拒绝 harness 不支持的传输（错误里有传输名），关闭端点、不留登记；frames 端点在 live 没声明 `video` 时滤掉视频帧；只对 webrtc 调 `endpoint.answer`（决定 11 补记）。
- **实现**：`lane.ts:389-391`（`LiveTransportError`）、`lane.ts:396`、`:1313-1316`（`audioOnly`）；`gateway.ts:1176-1199`。
- **测试**：无（提交 e18f7bc 没有带测试）。
- **状态**：没有测试。

### LN-6 live 委托的输入形状

- **承诺**：语音端每次委托记一条输入：`transcript` 块、`origin.principal = null`、`channelContext.live = true`、回复路由 = 发起 live 的路由；harness 自己开的 turn 交给 lane 当作当前 turn，turn 本身没有回复路由（决定 11）。
- **实现**：`lane.ts:923-947`、`:960-976`。
- **测试**：`live.test.ts`（session）"a delegation becomes an input from the far side and the harness-started turn runs as the lane turn"；`daemon/test/live.test.ts` "a delegated turn (no reply route) sends to \"current\" = the chat that opened the live"。
- **状态**：有测试。

---

## 7. 审批（RQ）

### RQ-1 一个请求只结算一次，资格在服务端复核

- **承诺**：`request.opened` 之后恰好一条 `request.resolved`，先到者为准；按钮点击和 resolve 命令都由 lane 重新检查资格；harness 侧的重复 resolve 被忽略。
- **实现**：`lane.ts:1187-1200`、`:1029`；`ingress.ts:276-295`（点击送到持有请求的 session）。
- **测试**：`lane.test.ts` "human: re-checks eligibility server side; first resolve wins"、"host: only a system origin may resolve"；`packages/session/test/e2e.test.ts` "approval by button click on the card, re-checked server side"；`ingress.test.ts` "turns an approval button click into a resolve command (eligibility re-checked by the lane)"；`harness/codex/test/unix.test.ts` "an approval answered while reconnecting is delivered when Codex replays it, and only then reported resolved"。
- **状态**：有测试。

### RQ-2 turn 结束时未答的请求被取消；人工超时为拒绝

- **承诺**：turn 结束时属于它的未答请求记 `runtime_cancelled`；空闲时开的请求不受下一轮结束影响；`human` 超时按拒绝；`policy.escalate` 抛错按拒绝。
- **实现**：`lane.ts:1053-1059`。
- **测试**：`lane.test.ts` "cancels open requests when the turn ends without answering them"、"a request opened while idle is not cancelled by the next turn ending"、"human: times out to deny"、"a throwing policy.escalate after a model escalation denies the request with a notice"、"a throwing policy.escalate without a reviewer denies the request and keeps the harness session"；`codex.test.ts` "passes native decisions through and cancels open requests when the turn ends"。
- **状态**：有测试。

### RQ-3 代人作答只给宿主连接，并记 by.via

- **承诺**：`resolve { onBehalfOf }` 只有宿主连接能用，日志记 `by.via: "host:<name>"`（决定 9）。
- **实现**：`gateway.ts:1746`；`lane.ts:1209-1215`。
- **测试**：`lane.test.ts` "onBehalfOf: only a host connection (system origin through the host adapter) may relay"；`host-callouts.test.ts` "the host picks the resolver (human) and answers on the principal's behalf; the log records the principal and the host"、"a host resolver answered on behalf of a principal records it with via"。
- **状态**：有测试。
- **注意**：决定 12 说代为审批"与 `onBehalfOf` 一样须显式开启"，但 `onBehalfOf` 没有开关，任何通过 token 认证的宿主都能用（`host.ts:263` 直接列在 `FEATURES` 里）。要么改决定 12 的措辞，要么给它加开关。

### RQ-4 resolve 回调失败退回本地策略

- **承诺**：宿主未连接、没开 `resolve`、超时、出错、答复不合 schema，都按本地策略决定并记 notice，不因宿主挂掉而卡住（决定 9）。
- **实现**：`gateway.ts:296-308`；`host.ts:236`（默认 3 s）。
- **测试**：`host-callouts.test.ts` "timeout, error and a bad answer fall back to the local policy; a host without the hook is never asked"。
- **状态**：有测试。

---

## 8. 失败即关闭（FC）

### FC-1 会话的 agent 不在了就拒绝，不退回默认 agent

- **承诺**：会话记录的 agent 被删或变成任务 agent 时，输入以 `agent_unavailable` 拒绝，在原路由回一条说明，explain 记下；绝不改用默认 agent。
- **实现**：`gateway.ts:762-771`（`pickAgent` 抛 `LaneUnavailableError`）；`ingress.ts:451-460`、`:362-370`；`gateway.ts:1088-1101`。
- **测试**：`runs.test.ts` "a session whose recorded agent is gone refuses input with agent_unavailable, never falling back to the default agent"、"a session whose recorded agent is a task agent now refuses input with agent_unavailable"、"a channel message to a session whose agent is gone: refused (no harness), a notice on the route, and explain says agent_unavailable"；`packages/daemon/test/session-launch.test.ts` "a launched session whose agent was removed refuses input instead of falling back to the default agent"。
- **状态**：有测试。

### FC-2 harness 起不来时明确拒绝

- **承诺**：开轮失败时本轮输入 `input.rejected start_failed: …`，context 留给下一轮。
- **实现**：`lane.ts` `pump`（`input.rejected start_failed: …`，带本批的 `replyRoute`）；`compositor.ts` `notifyRejected` / `rejectionNotice`（在路由上回"the agent could not start"，不带错误细节）。
- **测试**：`lane.test.ts` "opens the adapter the turn names, attributes events to it, and switches generations when the plan changes it"（断言 `start_failed: no harness nope`）；`context.test.ts` "a turn that fails to start leaves the context pending for the next one"；`e2e.test.ts` "start_failed is visible: the sender gets a notice instead of silence (no detail from the error)"、"a rejection without a route (its turn's card tells the story, or the route is unknown) sends nothing"。
- **状态**：有测试。

### FC-3 没有可用的交互 agent 时明确拒绝

- **承诺**：（隐含于 IN-1）找不到任何交互 agent 时，输入应被明确拒绝。
- **实现**：`gateway.ts:774` 抛普通 `Error`（不是 `LaneUnavailableError`），`ingress.ts:452-460` 原样抛出，`accept` 整个失败，不写 `input.rejected`、不回说明、explain 没有记录。
- **测试**：无。
- **状态**：没有测试。
- **不成立**：如上。配置正确时不会发生（默认 agent 总存在），但配置热改或任务 agent 前缀误配时会。

### FC-4 launch 不在允许范围就拒绝

- **承诺**：agent 没有 `sessionParams` 时任何 launch 都是 `launch_not_allowed`；`cwd` / env 超出 `cwdRoots` / `envKeys` / `envPathRoots` 拒绝；`CLAUDE_CONFIG_DIR` / `CODEX_HOME` 列入 `envKeys` 必须配 `envPathRoots`（决定 7）。
- **实现**：`packages/daemon/src/launch.ts:36`；`packages/daemon/src/config.ts:497-498`、`:833`。
- **测试**：`session-launch.test.ts` "a callout launch for an agent without sessionParams goes to onFailure; session.prepare says launch_not_allowed"；`packages/daemon/test/config.test.ts` "CLAUDE_CONFIG_DIR / CODEX_HOME in envKeys need envPathRoots"。
- **状态**：有测试。

外发的 fail closed 见 DL-5，resolve 的退回本地见 RQ-4。

---

## 9. launch（LA）

### LA-1 launch 随会话键固定，先到者为准

- **承诺**：launch 随会话键持久化；相同的再来通过（`same`），不同的（包括无 launch 的已有会话收到 launch）一律 `launch_conflict`；被拒的 launch 走规则的 `onFailure`（默认进宿主队列）；重启后按记录重开并续接。
- **实现**：`gateway.ts:787-816`（`launchCheck`、`sessionExists`）、`:697-701`；`records.ts:135-145`（`pin` 用普通 INSERT，第二次写会抛）。
- **测试**：`session-launch.test.ts` "the same launch again passes; another one is launch_conflict and the input waits in the host queue; also with the lane live; an existing session without a launch conflicts"、"session.prepare: idempotent with the same values, launch_conflict / agent_conflict otherwise; a log-only session conflicts, topic bookkeeping alone does not"、"a restart reopens the session with its launch and resumes it"、"agent and launch rows are written in one transaction"。
- **状态**：有测试。

### LA-2 skipWhenPinned 只在每个键的首条输入回调

- **承诺**：开了 `skipWhenPinned` 的规则，本地能算出目标键且该键已有 launch 时不回调，explain 记 `skipped_pinned`（决定 7）。
- **实现**：`router.ts:535-538`、`:353`。
- **测试**：`router.test.ts` "skipWhenPinned: once the rule's own session is pinned the host is not asked; explain says skipped_pinned"；`session-launch.test.ts` "skipWhenPinned: the host is asked for the first input of a session only; later ones route by the rule with the pinned launch"。
- **状态**：有测试。
- **注意**：判断用的是规则自己的 agent 与会话范围（`router.ts:536`）；宿主答复改了 agent 或会话时，那个键永远不会被认作"已固定"，每条输入都会回调。

---

## 10. 重启（RS）

原则 5 要求"守护进程重启或升级不丢对话、不丢正在跑的 turn（或确定地续上）"。下面如实写现状。

### RS-1 跨重启保留的状态

- **承诺**：以下状态在默认 SQLite 日志下跨重启保留。
- **实现与测试**：

| 状态 | 位置 | 测试 |
|---|---|---|
| 会话日志与快照 | `sqlite-log.ts:31-44` | `log.test.ts` "survives reopen: head, events and fold are restored" |
| 原生会话 id（续接） | `gateway.ts:1360-1366`、`lane.ts:784-792` | `gateway.test.ts` "lanes open the instance the plan names (its cwd, options, id); a restart resumes per instance"；`codex.test.ts` "resumes an existing thread" |
| 话题表 | `packages/session/src/topics.ts:135` | `packages/session/test/topics.test.ts` "switches back, persists across reopen (same database as the log), and keeps native ids"；`daemon/test/topics.test.ts` "chat commands answer with a system reply; switching back after a restart resumes the native session" |
| 宿主入站队列与游标 | `host-queue.ts:76-87` | `host-queue.test.ts` "push: unacked items are redelivered after a reconnect (at least once), also across a restart" |
| launch 记录 | `records.ts:36` | `session-launch.test.ts` "a restart reopens the session with its launch and resumes it" |
| outbox 结算与进行中记录 | `records.ts:35-36` | `host.test.ts` "deliver is idempotent per operationId, across a restart too; an unknown channel is an error"、"a send in flight when the daemon died is settled unknown on the next start (logged in its session) and not sent again" |
| 监听与 digest 缓冲 | `watch.ts:124-134` | `watch.test.ts` "buffered items and the watch survive a restart, and flush afterwards"、"is idempotent per (watch, envelope), also across a restart"；`daemon/test/watch.test.ts` "a digest buffered before a gateway restart is delivered after it; it replies to the target home route" |
| 宿主表与路由解释 | `router.ts:223-247` | `router.test.ts` "persists: a restart keeps the last table, suspended until the host reconnects (unless keep)"、"are persisted: explain(inputId) works across a restart" |
| 待交出的 context | `lane.ts:245`、`:725` | `context.test.ts` "context recorded but not handed before the restart goes to the next turn; handed context does not" |
| 遗留卡片收尾 | compositor restore | `e2e.test.ts` "finalizes the card of a turn that was running when the previous host stopped" |
| blob | `packages/session/src/blobs.ts:91-100`（文件系统） | 无重启测试 |

- **状态**：有测试（blob 除外）。

### RS-2 Codex（unix socket）正在跑的 turn 由新进程接管

- **承诺**：停止时 Codex unix 实例的 lane detach，turn 留在日志里不结束；启动后重开会话，harness 发 `turn.adopted`，新 lane 把它当作当前 turn，排在它后面的输入继续排队；停机期间重放的审批照常处理。
- **实现**：`lane.ts:433-442`（`detach`）；`gateway.ts:1643-1655`（`adoptRunningTurns`）；`harness/codex/src/session.ts:215`、`:367-372`。
- **测试**：`unix.test.ts` "a restarted host adopts a running turn and its replayed approval"、"settles an adopted turn that finished while no host was attached"、"keeps the adopted turn when Codex still runs it"；`lane.test.ts` "detach leaves the running turn open in the log"、"a new lane adopts the turn (turn.adopted), keeps it as the active turn and queues behind it"、"an input that arrives before the harness reports its adoption waits for it instead of settling the turn as ambiguous"；`harness/codex/test/live.test.ts` "survives a host restart mid-turn over a unix socket (spawn: own)"（需真 Codex，默认跳过）。
- **状态**：有测试。

### RS-3 Claude Code 正在跑的 turn 在重启时丢失

- **现状**：停止时 Claude Code 的 lane 被关闭，harness 打断当前 turn（`harness/claude-code/src/session.ts:307-313`），记 `interrupted`，未消费的输入被拒。turn 不续上。原生会话 id 保留，下一条输入会续接对话，但打断的那一轮的工作停在半路。
- **测试**：无（E2E.md 自己写了"e2e 未自动覆盖"）。
- **状态**：没有测试。
- **与原则不符**：原则 5。已列入 ROADMAP §4 第 6 项（`docs/design/claude-persistence.md`）。

### RS-4 Codex（stdio）正在跑的 turn 在重启时丢失，且日志里不结束

- **现状**：停止时网关按 harness 类型挑出 Codex lane 一律 detach（`gateway.ts:1808-1816`），但 stdio 的 app-server 随守护进程退出（`harness/codex/src/harness.ts:415-427` 注释"over stdio it dies with us"）。turn 既没被接管也没被结束，留在日志里，直到 RS-5。
- **测试**：无。
- **状态**：没有测试。
- **不成立（可能）**：与"确定地续上"相反，且比 Claude Code 更差：后者至少记了 `interrupted`。

### RS-5 遗留 turn 在下一条输入时记 ambiguous

- **承诺**：上一个进程留下的、没被接管的 turn，在下一轮开始前记 `turn.completed ambiguous host_restarted`。任务 run 在启动时就结算（exit 3）。
- **实现**：`lane.ts:801-833`；`packages/daemon/src/runs.ts:175-192`。
- **测试**：`runs.test.ts` "a run an earlier daemon left mid-turn is ambiguous (exit 3) after the restart"。
- **测试（续）**：`lane.test.ts` "settles a turn nobody adopted as ambiguous before the next turn starts, rejecting its unconsumed inputs"（结算时它没被消费的输入记 `input.rejected host_restarted`，不带路由：卡片收尾为 Outcome unknown）。
- **状态**：部分覆盖。
- **不成立**：交互 session 只在有新输入时才结算（`pump` 要求 `queue.length`），没有新输入的会话的 turn 一直开着（快照、`aio sessions` 显示运行中）。启动时不提前结算，是为了让 compositor 在 lane 打开时接管旧卡片再收尾（RS-1"遗留卡片收尾"）。

### RS-6 排队未开始的输入在停止或重启时明确拒绝，不重放

- **承诺**：停止（含 Codex 的 detach）时排队的输入记 `input.rejected lane_closed: gateway stopping` 并在原路由上通知发送者；崩溃留下的在下次启动时记 `input.rejected host_restarted`；`snapshot.queued` 不留幽灵 id。不重放（决定 13，重放属于 claude-persistence）。
- **实现**：见 IN-1（`rejectQueue`、`settleLeftoverInputs`、`foldSnapshot`）；`gateway.ts` `stop` 调 `detach('gateway stopping')` / `close('gateway stopping')`，`start` 在接管之前调 `settleLeftoverInputs`。
- **测试**：`packages/daemon/test/stop-inputs.test.ts` 两条（见 IN-1）；`lane.test.ts` "detach rejects the inputs queued behind the running turn …"、"crash leftovers: …"；`e2e.test.ts` "stop with queued inputs: …"。
- **状态**：有测试。
- **与原则不符**：原则 5"不丢对话"仍只做到"不静默丢"：发送者要自己重发。

### RS-7 不跨重启的状态（按设计或已知）

- **live**：不恢复（决定 11 明写）。没有测试。
- **待审批请求**：在内存里（`lane.ts:200-201`）。Claude Code 随打断记 `runtime_cancelled`；Codex unix 接管时重放（RS-2 有测试）；Codex stdio 或进程被杀时丢失，`snapshot.pendingRequests` 要等下一个 `turn.completed` 才清（`log.ts:138`），旧卡片上的按钮答 `unknown_request`。
- **入站去重、lane 的 `known`、Hub 的请求与 turn 索引**：在内存里。重启后点旧卡片上的审批或停止按钮答 `stale_turn` / `unknown_request`（`ingress.ts:280`）。
- **本轮来源摘要**：内存，最近 256 轮。
- **思维链气泡**：重启前没结束的一直转圈（CHANNELS.md §8）。
- **飞书"确认后再下载"**：确认事件之后、交给网关之前崩溃，这条消息丢失（CHANNELS.md §8）。
- **监听投递至多一次**：记"已投递"之后、写进目标 session 之前崩溃会丢；digest 相反，可能重复一次（CHANNELS.md §8；`watch.test.ts` "a flush begun before a crash is redone with the same input id"）。

### RS-8 守护进程停止时有界

- **承诺**：`stop()` 每一步都有上限（通道 3 s、lane 关闭 8 s、`whenIdle` 3 s、compositor 5 s 等），不会因为某个 harness 或通道卡住而挂住。
- **实现**：`gateway.ts:1785-1834`（`within(...)`）。
- **测试**：`gateway.test.ts` "socket is private, rejects bad frames, and tells subscribers when the gateway stops"；`daemon/test/live.test.ts` "live_leave ends the live; the gateway stopping ends a running one"。
- **状态**：部分覆盖（有界本身没有测试；有界的代价是 LN-4；outbox 在关库前最多等 5 s，超出的留进行中记录，见 DL-1；超时没报完的 turn 留到下次启动按 RS-5 结算）。

### RS-9 持久化以 SQLite 日志为前提

- **现状**：宿主队列、`DaemonRecords`（outbox、launch、input.verify）、路由表都和日志共用一个 SQLite 库（`gateway.ts:266-270`）。嵌入方传入非 SQLite 的日志或 `logPath: ':memory:'` 时，它们全部在内存里，没有告警。`aio serve` 默认 `dataDir/log.sqlite`（`config.ts:736`），不受影响。
- **状态**：没有测试（网关层没有"非 SQLite 时告警"之类的测试）。

---

## 11. 通道、配置与给模型的工具（CF）

### CF-1 bridge 首次连接失败不阻止启动

- **承诺**：bridge 通道首次 hello 失败时标 `failed` 并按退避重试，不让守护进程启动失败；命令本身无法执行（`ENOENT` / `EACCES`）仍让启动失败（决定 10）。
- **实现**：`gateway.ts:2040-2041`；`channel/jsonl-bridge/src/host.ts:222-227`。
- **测试**：`packages/daemon/test/bridge-startup.test.ts` "does not stop the daemon: status shows it failed with the reason, and it connects once the peer works"、"a bridge whose command cannot be run still fails the start"；`packages/daemon/test/live-channels.test.ts` "a bridge whose first connect fails is reported failed (not started) and the file not applied, until it connects"。
- **状态**：有测试。

### CF-2 通道热生效只启停变化的通道

- **承诺**：`console.liveChannels: true` 时，经 `PUT /api/config` 的通道增删改只启停变化的那些；默认关闭时等重启（决定 10 原文没提这个开关，以设计文档为准）。
- **实现**：`gateway.ts:1499-1531`。
- **测试**：`live-channels.test.ts` "starts added channels, restarts changed ones, keeps unchanged ones, stops removed ones"、"off (default): a channel added by PUT waits for a restart, as before"、"a channel whose start rejects is reported failed, forgotten, and started again by the next apply"、"a rotated secret in the env file counts as a change: the channel restarts with the same config document"。
- **状态**：有测试。

### CF-3 多个飞书机器人的配置冲突在启动前报出

- **承诺**：两个兜底条目、重复应用（同 appId + domain）、重复账号、多条目时非法账号名都让守护进程启动失败，控制台写入前同样报出（决定 8）。
- **实现**：`config.ts`（多 lark 校验）。
- **测试**：`packages/daemon/test/multi-lark-config.test.ts` "${what}: validate and PUT answer 422, the file is unchanged"（参数化）、"two bots with their own references are accepted"。
- **状态**：有测试。

### CF-4 模块 harness 配置错误使启动失败

- **承诺**：`use: 'module'` 的模块不存在、有未知键是配置错误；导出不是函数、工厂抛错、返回的不是 adapter 都使启动失败，错误里有实例名（决定 11 补记）。
- **实现**：`config.ts:1038-1039`、`:134-143`、`:997-998`；`gateway.ts:1999-2016`、`:478-480`。
- **测试**：无（没有任何测试用到 `use: 'module'` 的 harness）。
- **状态**：没有测试。

### CF-5 监听开的轮次永远不回到被监听的会话

- **承诺**：trigger 与 digest 开的轮次回复到目标 session 的主路由，永远不回到被监听的那个会话（CHANNELS.md:275，`watch.ts:405-409` 注释）。
- **实现**：`gateway.ts:368`（`replyRoute: homeRoute(target)`）、`:1672-1675`。没有任何地方比较主路由与 `w.source`。
- **测试**：`watch.test.ts` "never delivers into the session the input already went to"（只覆盖"输入本身已进目标 session"的情况）。
- **状态**：部分覆盖。
- **不成立（可能）**：群 G 的 @ 会话自己建一个监听 G 中非 @ 消息的 watch 时，目标的主路由就是 G，trigger 开的轮次会回到 G。`Policy.watch`（`policy.ts:135`）与 `add`（`watch.ts:485-486`）都不拒绝 source 与目标主路由相同。

### CF-6 给模型的工具默认关闭，按 agent 开启

- **承诺**：给模型的工具默认关闭、按 agent 配置开启（ROADMAP §1 原则 2）。
- **实现**：`outputTools` 默认 `true`（`config.ts:727`），每个 agent 只有一个布尔 `tools`（`config.ts:214`、`:806`）；开启时 15 个工具全部注册（`packages/host-mcp/src/server.ts:20-131`），`live_*` 在没有任何通道能开 live 时也出现（`gateway.ts:382-399`）。
- **测试**：`packages/daemon/test/output-tools.test.ts` "outputTools: false mounts nothing"；`host-mcp.test.ts` "are listed over MCP only when the host provides watches"；`packages/host-mcp/test/topic-tools.test.ts` "are listed over MCP only when the host provides topics"。
- **状态**：部分覆盖（整体开关有测试；逐个工具的默认关闭不存在）。
- **不成立**：与原则 2 相反。已列入 ROADMAP §4 第 11 项（工具负担复查）。

---

## 12. 缺口

按风险从高到低。"不成立"指读代码确认、与文档承诺相反；"未测"指承诺可能成立但没有测试守着。

1. ~~**通道可以冒充别的通道与主人（ID-3）。**~~ 已修（channel-stamping，决定 13）：信封的 `channel/account`/回复路由按发出它的通道实例核对，不符拒收；一个通道 id 只属于一种适配器；证据按条目授予 ∩ caps 封顶。见 ID-3。
2. ~~**排队中的输入在停止或重启时静默丢失（IN-1 / RS-6）。**~~ 已修（决定 13）：停止时拒掉并在原路由通知，崩溃遗留在启动时拒掉，遗留 turn 结算时拒掉它的输入，开轮失败在通道上可见。剩下 IN-1 不成立第 1–5 条（策略钩子抛错、live 委托溢出、被接管输入、开轮途中 detach、关闭后到达）。
3. **`aio explain` 不能从副作用反查（EX-2，不成立）。** 只接受 inputId，返回路由记录；系统回复、宿主 `deliver`、`live_say` 连手工串的线索都没有。原则 4 与决定 4 都以它为"不拦截"的配套。
4. **重启丢 turn（RS-3 / RS-4，不成立于原则 5）。** Claude Code 的 turn 被打断；Codex stdio 的 turn 既不接管也不结束，挂到下一条输入才记 ambiguous（RS-5），没有新输入就一直显示运行中。三者都没有测试。
5. ~~outbox 结算前崩溃会重复发送；停止时投递可能既不结算也不记录（DL-1、DL-2）。~~ 已修（决定 13）：发送前写进行中记录，重启后结算为 `unknown` 不重发；`stop()` 有界等待 outbox；单次尝试有超时。
6. **多机器人退回仍会发生（DL-4，不成立）。** 机器人 b 停掉或启动失败后，`channelFor` 只看到 a，发给 b 的 `deliver` / `systemReply` / `live_join` 改写成 a 发出。决定 8 的本意是"不以别的机器人发出"。
7. ~~**宿主 `lease` 未实现（HQ-5，不成立）。**~~ 已删（决定 13）：只拉取的宿主用 `onHostDown: "keep"` + 定期重推刷新 `expiresAt`，HOSTS §4、§6 写明。
8. **宿主 outbound 在宿主离线时退回本地策略（DL-5，不成立于"fail closed"）；`live_join` 目标不过 outbound 检查。**
9. **并发 `live_join` 停掉已有 live 并泄漏端点（LN-3，不成立）。** 需要在 `gateway.ts:1168` 检查后同步占位。
10. **入站去重只在内存，部分失败重试会重复进会话（IN-5，不成立）。**
11. **没有可用交互 agent 时 `accept` 直接抛错（FC-3，不成立）**。（harness 起不来时只在日志里拒绝的 FC-2 已修。）
12. **`closeLane` 窗口可能出现同一键两个 lane（LN-2，可能）**；**监听回复可能回到被监听的群（CF-5，可能）**：都需要先写测试复现。
13. **未测的承诺**：live 传输拒绝与视频过滤（LN-5）、模块 harness 启动失败（CF-4）、Claude Code 停止时的行为（RS-3）、非 SQLite 持久化（RS-9）、模型输入里的 watch 标记（ID-2）。
14. **文档本身的出入**：决定 12 说 `onBehalfOf` "须显式开启"而它没有开关（RQ-3）；工具默认开启与原则 2 相反（CF-6，ROADMAP 已列复查）；`docs/E2E.md` 的"已知缺口"仍写 outbox 在内存、compositor 不接管旧卡片、没有宿主 MCP 工具，三条都已过时。
15. **A 组合并评审（2026-10-11）遗留**，按原则 4 记下，未修：
    - **启动时为每个会话折叠全量日志**（`settleLeftoverInputs` 调 `hub.snapshot`）：没有压缩时随日志线性增长；等日志压缩一起做。
    - **崩溃后同一输入两种结局（IN-1，可能）**：digest flush 的 `input.admitted` 落盘后、`endFlush` 前崩溃，重启时 `settleLeftoverInputs` 拒掉该 id，watch 的 redo 又以同一 id 收下并消费（`watch.ts:450`、`:671`）。需先写测试复现。
    - **同进程兄弟机器人的回流认不出 self（DL-4b）**：lark-bot 的 `declared` 只来自本适配器实例的发送记录，兄弟机器人各有一份，所以兄弟的消息回来不带 `declared`，仍要靠 `selfAccounts`。agent-messaging 提案的出站索引解决它。
    - **热更新时启动失败的模块通道**按 `type` 记为已配置（模块 id 加载后才知道），同 id 的另一账号仍可能被退回使用（DL-4）。bridge 写了 `id` 时已按 id 记。
    - 已修：bridge 类通道收不到停止提示（停止时先拒入站、最后才中止通道）；拒绝提示不再带 `as`；`startChannel` 同步 emit 读到未赋值的 `entry`；邮件 `config.account` 覆盖条目账号；停止期间完成的 `live_join` 未关闭。
