# agents-io 不变量清单

> 状态：2026-10-10 初版，对应 `docs/ROADMAP.md` §1 原则 4（承诺可检验）与 §3。来源：各设计文档、决定 1–12、代码注释与行为。代码位置以写作时的 `main` 为准（`c52bad5` 加上未提交的文档改动），行号会漂移，以函数名为准。
> 2026-10-11：决定 14 加入 18 个编号（PR、CN、HC、SE、CT、RQ-5、OB、RT、RN、IN-7、TP、MD、LA-3，来源 `docs/design/test-suite-review/` §3.2），代码位置按当日 `main` 读过；实施时又加了 CF-7（监听的授权）、CF-8（飞书平台需求清单），两组测试原来守着它们却没有编号。每条"不成立"都有带编号的 `it.fails`（LN-4 只有 `it.todo`，假 harness 复现不了）。
> 用途：改动 agents-io 的人或 agent 用它判断"这个改动有没有打破某个承诺"。新增承诺先写进这里，再写测试；测试改名时同步改这里。

## 0. 怎么读

每条不变量写成：

- **承诺**：一句话，能被测试判真假。
- **实现**：在哪里保证（文件:行）。
- **测试**：测试文件与 `it(...)` 名称（不含名字末尾的 `#ID` 标签）。守着某条的测试名字里带它的标签，例如 `#IN-1`，用 `vitest -t '#IN-1\b'` 选出；`it.fails` 标的是已知的不成立路径，修好后它会变红、改回 `it`。分层与怎么选测试见 `docs/TESTING.md`。
- **状态**：`有测试`（主路径与已知边界都有测试）/ `部分覆盖`（主路径有测试，某些路径没有，或某些路径不成立）/ `没有测试`。
- **不成立**：代码里找到的、与承诺相反的路径。只写读代码确认过的；"可能"表示读代码得出、没有用测试复现。

术语：投递结算的取值是 `delivered` / `rejected` / `unknown`（`packages/protocol/src/events.ts:189-193`）；`ambiguous` 是 turn 与 run 的状态，不用于投递。

除特别说明，"跨重启"都以守护进程默认的 SQLite 日志为前提（见 RS-9）。

---

## 1. 输入生命周期（IN）

### IN-1 每条被接纳的输入都有终态

- **承诺**：进入 lane 的每条输入（`input.admitted`）最终有 `input.consumed`、`input.rejected` 或 `input.cancelled` 之一，不会静默消失；lane 关闭、detach、守护进程停止或崩溃都不例外（决定 13）。
- **实现**：`packages/session/src/lane.ts` `finishTurn`（未消费的重排一次，否则 `input.rejected`）；`pump` 的开轮失败（`start_failed`）；`onHarnessClosed`（harness 中途断开，`ambiguous` 并拒掉未消费的）；`take` / `cancelQueue` 记 `input.cancelled`；`stopTimers` → `rejectQueue`（`close` / `detach` 时拒掉排队的，之后 `pump` 和 `handle` 再遇到排队的也拒：关闭中结束的轮次重排的、admission 正等策略钩子的）；`settleDangling`（遗留 turn 结算时拒掉它没被消费的输入，含 steer 进去的）；`settleLeftoverInputs`（启动时拒掉上一个进程留下的 `snapshot.queued`，`gateway.ts` `settleLeftoverInputs` 在任何 lane 打开前对每个非 run session 调用）；`packages/session/src/log.ts` `foldSnapshot`（`turn.adopted` 也把它的输入移出 `queued`）；`packages/daemon/src/gateway.ts` `refuseUnavailable`（还没有 lane 时由网关写 `input.rejected`）。
- **测试**：`packages/session/test/lane.test.ts` "re-queues admitted-but-unconsumed inputs once, then rejects them #IN-1 #IN-2"、"closes the turn as ambiguous when the harness stream ends mid-turn #IN-1"、"interrupts the active turn and optionally clears the queue #IN-1 #CT-1"、"interrupt-mode input stops the turn and runs next #IN-1"、"close rejects queued inputs (lane_closed) and the interrupted turn's; nothing stays queued #IN-1 #RS-6"、"an input requeued as the turn ends during close is rejected, not stranded #IN-1"、"an input whose admission was awaiting a policy hook when the lane closed is rejected #IN-1"、"detach rejects the inputs queued behind the running turn (lane_closed, with their route), never the turn's own; the next lane still adopts it #IN-1 #RS-6"、"crash leftovers: inputs a previous process admitted and never settled are rejected (host_restarted) at startup; the open turn is left to adoption #IN-1 #RS-6"、"settles a turn nobody adopted as ambiguous before the next turn starts, rejecting its unconsumed inputs #IN-1 #RS-5"；`packages/session/test/e2e.test.ts` "stop with queued inputs: rejected (lane_closed) and the sender gets a notice on the route; the running turn ends on its own card #IN-1 #RS-6"；`packages/daemon/test/stop-inputs.test.ts` "stop with queued inputs: they are rejected (lane_closed) and the sender is told on the chat; after a restart nothing stays queued #IN-1 #RS-6"、"crash leftovers: inputs admitted but never settled by the previous process are rejected (host_restarted) at startup, and the snapshot lists none queued #IN-1 #RS-6"；`packages/session/test/context.test.ts` "a turn that fails to start leaves the context pending for the next one #IN-1 #IN-6 #FC-2"；`packages/daemon/test/runs.test.ts` "a session whose recorded agent is gone refuses input with agent_unavailable, never falling back to the default agent #FC-1 #IN-1"；`packages/daemon/test/topics.test.ts` "a follow-up queued in the old topic while its turn rotates moves to the new topic #IN-1 #TP-1"。
- **状态**：部分覆盖（停止、detach、崩溃遗留、遗留 turn 有测试；下面几条仍不成立）。
- **决定（决定 13，依据原则 1 与 §3 第一条）**：
  1. **拒绝原因码**：`lane_closed: <关闭原因>`（lane 关闭或 detach 时还在排队，含停止期间重排的；守护进程停止时原因是 `gateway stopping`）；`host_restarted`（上一个进程留下的：启动时的排队遗留，和没人接管的遗留 turn 里没被消费的输入，与该 turn 的 `error.code` 相同）；`start_failed: <错误>` 不变。格式统一为"代码"或"代码: 细节"，渲染端只看冒号前的代码。
  2. **通知**：只在输入还没进任何一轮渲染时通知（排队中被关闭、开轮失败）：这类 `input.rejected` 带 `replyRoute`（按路由分组，每组一条事件），compositor 在该路由上经 outbox 回一句（`rejectionNotice`，operationId `<session>:rejected:<首个 input id>:<路由>`，幂等）。冒号后的细节不发到通道（可能含路径、主机）。已经有卡片的轮次（`interrupted`、`ambiguous`、`not_consumed`）不带路由、不另发，卡片状态行已经说明。停止时通道已停收，通知是尽力而为（channel 在 compositor 停止之后才 `close`）。
  3. **崩溃遗留不通知**：`input.admitted` 不带记录（也不带路由），启动时的 `host_restarted` 只落日志、`aio sessions` 排队数归零，不发通道提示。不重放（重放属于 claude-persistence）。
  4. **接管路径不受影响**：`detach` 只拒排队的，不碰当前 turn 的输入；启动清理跳过日志里仍开着的 turn 的输入（它们不在 `queued`，由接管或 `settleDangling` 结算）；`settleDangling` 只在没人接管时运行（`turn.adopted` 先清掉 `dangling`）。run session（`run:`）的启动清理留给 `Runs`。
- **不成立**：
  1. **策略钩子抛错丢输入。** `known.add(inputId)` 在前（`lane.ts` `input`），随后无保护地 await `policy.control`（interrupt 模式）或 `policy.plan`（steer）。抛错时什么都没记，同 id 重试答 `duplicate`。测试：`it.fails` `packages/session/test/lane.test.ts` "a throwing policy.control on an interrupt-mode input still settles it (input.rejected); a retry with the same id is not a duplicate #IN-1"、"a throwing policy.plan on a steer still settles the input (input.rejected); a retry with the same id is not a duplicate #IN-1"。
  2. **live 委托溢出。** `handoffs` 上限 32（`onHarnessEvent` 的 `live.handoff`），被挤出的、或 harness 一直没开 turn 的委托只有 `input.admitted new_turn`。测试：`it.fails` `packages/session/test/live.test.ts` "the 33rd pending delegation pushes the oldest out, and the evicted one still gets a terminal state #IN-1"。
  3. 被接管（`turn.adopted`）的 turn 以 `inputs: []` 开始，harness 没报 consumed 的被接管输入没有终态（不能凭本进程的 `consumed` 判断：之前的进程可能已记过）。测试：`it.fails` `packages/session/test/lane.test.ts` "an adopted turn that ends without reporting its inputs consumed settles them #IN-1 #RS-2"。
  4. **detach 发生在开轮途中（可能）。** 输入已 `startTurn` 交给 Codex unix、`turn.started` 还没记下时停机：日志里它仍在 `queued`、没有开着的 turn，下次启动记为 `host_restarted`，而 Codex 可能已经在跑它（应为 ambiguous）。没有测试复现。
  5. lane 关闭后到达的输入答 `{ ok: false, reason: 'closed' }`，没进 lane、没有 `input.admitted`；调用方（ingress）是否在原路由上说明不在本条范围内。
  6. **digest flush 崩溃后同一输入两种结局**（第 15 节第 15 项，已复现）：flush 的 `input.admitted` 落盘后、`endFlush` 前崩溃，重启时 `settleLeftoverInputs` 先把该 id 记 `input.rejected host_restarted`，watch 的 redo 又以同一 id 收下并消费（`watch.ts` `flush` / redo）。测试：`it.fails` `packages/session/test/watch.test.ts` "a flush that crashed after input.admitted and before endFlush: after the restart its input has exactly one outcome #IN-1"。
  7. **没有任何交互 agent 时**（只有任务 agent，watch trigger 能走到这里）`accept` 抛错，输入没有终态，见 FC-3。

### IN-2 未消费的输入重排一次，再拒绝

- **承诺**：harness 没消费的输入在 turn 正常结束或可重试失败后重排一次（`requeueLimit` 默认 1），之后 `input.rejected not_consumed`。
- **实现**：`lane.ts:1066-1081`。
- **测试**：`lane.test.ts` "re-queues admitted-but-unconsumed inputs once, then rejects them #IN-1 #IN-2"。
- **状态**：有测试。

### IN-3 一轮不混两个主体或两个路由

- **承诺**：合批只合并相邻的、同一主体且同一回复路由的输入；后来者不会插到别人前面。
- **实现**：`lane.ts:760-770`（`takeBatch`、`batchKey`）。
- **测试**：`lane.test.ts` "never merges inputs from two principals or two routes into one turn #IN-3 #LN-2"。
- **状态**：有测试。

### IN-4 harness 自行合批时记 ambiguous

- **承诺**：harness 消费了没交给本轮的输入（admitted ≠ consumed），本轮记 `ambiguous`，不当作成功。
- **实现**：`lane.ts:1060-1061`（`foreignConsumed`）。
- **测试**：`lane.test.ts` "marks a turn ambiguous when the harness consumed inputs it was not given #IN-4"。
- **状态**：有测试。

### IN-5 同一条渠道消息只进一次

- **承诺**：同一 `(channel, account, id)` 的信封只被接纳一次；并发到达的副本合并；不同机器人账号收到同一消息 id 是两条。
- **实现**：`packages/session/src/ingress.ts:220-251`（`seen` + `inflight`，默认窗口 1 万条）；lane 内 `known`（`lane.ts:531`）；宿主队列另有持久去重（见 HQ-2）。
- **测试**：`packages/session/test/ingress.test.ts` "dedups by (channel, id) #IN-5"、"dedups a duplicate that arrives while the first copy is still being processed #IN-5"、"dedups per account: the same platform message id reaching two accounts is two envelopes #IN-5"、"rejects invalid envelopes without remembering them #IN-5"；`lane.test.ts` "ignores a duplicate inputId #IN-5"；`packages/daemon/test/multi-lark.test.ts` "the same message id arriving at both bots: two inputs, two sessions, two input.verify records #IN-5"。
- **状态**：部分覆盖。
- **不成立**：
  1. 去重表在内存里（`ingress.ts:193`），重启后平台重投的同一消息会以新的 input id 再进一次会话（宿主队列那份仍去重）。测试：`it.fails` `packages/session/test/ingress.test.ts` "after a restart (a new Ingress) the same (channel, account, id) does not enter the session a second time #IN-5"。
  2. 部分失败后重试会重复：`deliverOwn` 对非 `LaneUnavailableError` 的错误直接抛出（`ingress.ts:460`），之前已投给其他会话的不回滚，`accept` 也不 `remember`（`ingress.ts:235-236`）；飞书适配器随后删掉自己的去重键等平台重投（`channel/lark-bot/src/adapter.ts:284`），重投以新 id（`ingress.ts:298`）再进那些会话。测试：`it.fails` `packages/session/test/ingress.test.ts` "an envelope fanned out to two sessions whose second delivery throws: the redelivery does not give the first session the input twice #IN-5"。
  3. 窗口按条数不按时间，挤出时连带丢掉修订映射（`ingress.ts:249`）。

### IN-6 只记录的 context 输入在下一轮交出，跨重启不丢

- **承诺**：`context` 动作的输入不开轮，在该 session 下一次开轮时按到达顺序排在触发输入前面；有条数与字符上限，超出时保留最新并加一行说明；重启后从日志重建"已记录、未交出"的部分；digest 条目不重复交出。
- **实现**：`lane.ts:256-264`（记录时带完整输入）、`lane.ts:725-756`（`rebuildContext`）；上限见 `CONTEXT_DEFAULTS`。
- **测试**：`packages/session/test/context.test.ts` "context recorded but not handed before the restart goes to the next turn; handed context does not #IN-6 #RS-1"、"provenance: flags come from the context actually handed, and stay for later turns #IN-6 #EX-3"。
- **状态**：有测试。

### IN-7 通道只在网关接受之后才向平台确认

- **承诺**：仓库内的通道适配器只在 `emit` 返回（网关已接受）之后才向平台确认（飞书事件 ack、邮件 checkpoint 前移）；`emit` 失败时不确认、不留去重键，平台重投能再进来；超过平台确认期限仍未接受的，适配器保留去重键并自己重试 `emit`。
- **实现**：`channel/lark-bot/src/adapter.ts` `deliver`（`ackTimeoutMs` 期限之前失败：删去重键并抛出，SDK 答 500 让飞书重投；期限之后：保留去重键，最多 `EMIT_RETRIES` 次退避重试）、`onMessage`（declared 查询失败、映射为空时也删去重键）、`onCardAction`；`channel/mail/src/adapter.ts` `start` 里的 `onMessage`（`await ctx.emit(env)` 之后才 `setCheckpoint`，抛错即下次重取）；网关一侧 `packages/daemon/src/gateway.ts` `startChannel` 的 `emit` → `Gateway.accept` → `packages/session/src/ingress.ts` `accept`（`accepted` 时才 `remember`）。
- **测试**：标签 `#IN-7`；例：`channel/lark-bot/test/inbound.test.ts` "forgets the dedup key when emit fails so the platform redelivery is processed #IN-7 #IN-5"、"a card click whose emit fails is not acked either #IN-7"、"an emit that fails after the ack deadline is retried by the adapter, keeping the dedup key #IN-7 #IN-5"、"a failing declared-sender lookup is not acked and leaves no dedup key behind #IN-7"；`channel/mail/test/mail.test.ts` "persists a checkpoint after the host accepts each message #IN-7"；`channel/lark-bot/test/enrich.test.ts` "acks within ackTimeoutMs while a download hangs, then emits in chat order once it ends #IN-7"。
- **状态**：部分覆盖（`emit` 抛错的路径有测试；`emit` 正常返回 `accepted: false` 的路径不成立，有 `it.fails`）。
- **不成立**：
  1. **停止期间收到的消息被确认后丢失。** `Gateway.stop` 先置 `refusingInbound`，通道还要再连着一段时间（等拒绝提示与收尾卡片发出）；这期间 `Gateway.accept` 答 `{ accepted: false, error: 'gateway stopping' }`，不抛错。飞书 `deliver` 只把抛错当失败，于是 ack 并保留去重键，飞书不再重投；邮件 `onMessage` 照常前移 checkpoint。两者都不会交给下一个进程。测试：`it.fails` `channel/lark-bot/test/inbound.test.ts` "an emit answering accepted:false is not acked and leaves no dedup key, so the redelivery gets in #IN-7"；`it.fails` `channel/mail/test/mail.test.ts` "does not move the checkpoint past a message the host answered accepted:false #IN-7"。
  2. 期限之后重试用尽（`EMIT_RETRIES`）或通道被中止时，飞书已经 ack，这条消息丢失（CHANNELS.md §8 已记）。

---

## 2. 投递（DL）

### DL-1 每次投递以一条 delivery.settled 结束

- **承诺**：经 outbox 的每次投递恰好写一条 `delivery.settled`（`delivered` / `rejected` / `unknown`）；不可重试的错误是 `rejected`，重试用尽是 `unknown`，`unknown` 不再重放。单次尝试有上限（`attemptTimeoutMs`，默认 60 s），超时即 `unknown`、不重试（平台可能已收到）。外发检查抛错即 `rejected`（fail closed）。守护进程停止时最多等 5 s 让正在发的投递结算（通道与库都还开着），等待重试的立刻结算为 `unknown`；5 s 后仍在发的保留进行中记录，由下次启动结算（DL-2）。
- **实现**：`packages/session/src/outbox.ts` `Outbox.run`（政策检查、重试循环、`withTimeout`）、`settle`（先写 store 再写日志）、`drain` / `close`；`Gateway.stop()`（`gateway.ts:1827` 在 compositor 停止之后、通道关闭之前 `outbox.drain(5000)`，`:1835` 在关库之前 `outbox.close()`）。
- **测试**：`packages/session/test/outbox.test.ts` "delivers each operationId once, even when called again or concurrently #DL-1 #DL-2"、"retries with backoff, then settles #DL-1"、"settles as rejected on a non-retryable error and unknown when retries run out #DL-1"、"an attempt that times out settles unknown and is not retried (the platform may have it) #DL-1"、"an outbound check that throws rejects (fail closed) and is settled #DL-1 #DL-5"、"drain waits for running attempts, stops retries; close leaves what still runs in flight for the next recover #DL-1"；`packages/daemon/test/host.test.ts` "stop waits for a send in flight: it settles before the records close #DL-1 #RS-8"；`packages/host-mcp/test/host-mcp.test.ts` "send_file on the local route is event-only (no adapter), still settled #DL-1"。
- **状态**：有测试。
- **细节（按原则自决，决定 13）**：
  1. 超时默认 60 s（飞书上传大文件也够），嵌入方可经 `OutboxOptions.attemptTimeoutMs` 改；超时后的迟到结果被忽略。
  2. 停止时不再重试：重试前的错误多半表示没发出，但停止后无从确认，记 `unknown` 比留到下次启动更早进日志（原则 1）。
  3. `close()` 之后新投递答 `rejected`（`outbox closed`，确实没发，不写库），之后的结算不写库也不写日志，进行中记录留给下次启动。
- **不在承诺范围内（按设计）**：卡片流式编辑不经 outbox（`packages/session/src/compositor.ts:562-569`，RECOMMENDATION §3.1"progress 可以丢中间帧"）；宿主 `deliver` 找不到通道直接答 `unknown_channel`（`gateway.ts:1076`）。

### DL-2 operationId 幂等，跨重启

- **承诺**：同一 operationId 至多一次平台发送，重复调用返回第一次的结果；每次尝试在调用适配器**之前**写进行中记录，结算时在同一 savepoint 里写结果并删掉进行中记录。进程在两者之间死掉，下次启动把留下的进行中记录结算为 `unknown`（会话日志写 `delivery.settled`，守护进程日志一条 warn），**不自动重发**；同一 operationId 再来（还没恢复时也一样）直接得到这个 `unknown`。通道再各自做一层（飞书请求 uuid、邮件 Message-ID）。
- **实现**：`outbox.ts` `Outbox.deliver`（已结算 / 本进程在发 / 上个进程留下的进行中记录，三种都不再发）、`run` 里的 `store.begin`、`recover`；`OutboxStore` 接口加 `begin` / `inFlight` / `allInFlight`，内存实现 `MemoryOutboxStore`；SQLite 表 `daemon_outbox` 与 `daemon_outbox_inflight`（`packages/daemon/src/records.ts:35-36`、`DaemonRecords.put` / `begin`，接线 `gateway.ts:336`），启动时 `gw.outbox.recover()`（`gateway.ts:468`，在通道启动之前）；宿主 `deliver` 用 `host:` 命名空间（`gateway.ts:1072-1074`）；飞书 `adapter.ts:503-521`；邮件 `channel/mail/src/outbound.ts:17-21`、`channel/mail/src/adapter.ts:106-138`。输出工具的 operationId 是 `tool:<sessionKey>:<调用 id>`（CHANNELS.md §输出工具）。
- **测试**：`outbox.test.ts` "delivers each operationId once, even when called again or concurrently #DL-1 #DL-2"、"a crash between the in-flight mark and the settlement: the next process settles it unknown and never resends #DL-2"、"the same operationId is not sent again while an earlier process has it in flight, even before recover #DL-2"、"marks each attempt in flight before calling the adapter, and settling clears the mark #DL-2"；`packages/daemon/test/host.test.ts` "deliver is idempotent per operationId, across a restart too; an unknown channel is an error #DL-2 #RS-1"、"a send in flight when the daemon died is settled unknown on the next start (logged in its session) and not sent again #DL-2 #RS-1"；`channel/lark-bot/test/outbound.test.ts` "is idempotent: same operationId gives one platform message and a stable uuid #DL-2"、"retries a failed operation under the same uuid #DL-2 #DL-1"；`channel/mail/test/mail.test.ts` "is idempotent: same operationId, same Message-ID, one transport call #DL-2"、"retries a pending send with the same Message-ID #DL-2"；`host-mcp.test.ts` "is idempotent per tool call id #DL-2"。
- **状态**：部分覆盖。
- **细节（按原则自决，决定 13）**：
  1. 进行中记录按尝试更新（记 `attempts`、`startedAt`、`turnId`），退避等待期间也在；死在退避里同样记 `unknown`（上一次尝试的结果本来就不明）。
  2. 进行中记录不随 30 天清理删除：下次启动总会结算它。
  3. 不自动重发：`unknown` 交给宿主或人决定（原则 6），代价是可能少发一次；重复发送（飞书上传、邮件 SMTP）不可撤回，少发可补。
  4. **结算记录不删，30 天后压成墓碑**（2026-10-11，依原则 1、4 自决）：`records.ts` `outPrune`（`:48-51`）把超过保留期的行改成 `at = 0`、去掉 `error` 与 `providerMessageId`，结果（`status`、`attempts`、路由）留下；同一 operationId 任何时候再来都得到它（`duplicate: true`），不再发。没有选"拒收早于保留期的 operationId"：operationId 由调用方取名，不带时间，看不出新旧。代价是每个 operationId 永久一小行（不含消息内容）。测试：`packages/daemon/test/host.test.ts` "after the 30-day prune of settled outbox records, the same operationId is not sent again"（原 `it.fails`，已修）。
- **不成立**：
  1. 嵌入方不传持久 store 时（`MemoryOutboxStore`）跨进程不成立，见 RS-9。

### DL-3 回复只回到来源

- **承诺**：一轮的正式回复只投递到发起它的路由（`turn.started.replyRoute`）和 `extraDeliveries`；终端发起的轮次不会推到飞书。
- **实现**：`compositor.ts:445-451`（`owns()` 按 `(channel, account)` 认领路由）。
- **测试**：`packages/daemon/test/gateway.test.ts` "channel input → ingress → lane → harness → compositor card back on the route; local subscriber sees the stream #DL-3"；`packages/session/test/compositor-accounts.test.ts` "a route of account b is rendered by b only #DL-3 #DL-4"；`lane.test.ts` "steers only the turn owner; others are queued; another route becomes an extra delivery #DL-3 #IN-3"；`packages/daemon/test/gateway.test.ts` "a turn started from the local terminal sends nothing to a channel, even in the session an owner DM shares #DL-3"。
- **状态**：有测试（决定 14 补上"终端发起的轮次不推到通道"）。

### DL-4 多个飞书机器人时不以别的机器人发出

- **承诺**：多账号时 `deliver` / `systemReply` / `replyCaps` / 输出工具按 `(channel, account)` 选实例，只有该通道 id 恰好一个**配置条目**时才退回（数配置，不数在跑的：b 停掉或启动失败后 a 不会变成唯一的机器人）；找不到实例时 `deliver` 答 `unknown_channel`，区分“已配置但未运行”与“未配置”，并列出可用的 `(通道, 账号)`；`systemReply` 记 warn 不发；飞书适配器拒绝发往别的账号的路由（决定 8）。
- **实现**：`gateway.ts` `channelFor` / `configured` / `noChannelMessage`；`compositor.ts:445-448`；`channel/lark-bot/src/adapter.ts:492-495`（`ownRoute`，用于 send / edit / finalize / retract）。
- **测试**：`multi-lark.test.ts` "a bot that failed to start is configured but not running: its messages are never sent as the other bot #DL-4"、"a DM to bot b is answered by b only, and its output-tool messages go out through b #DL-4 #DL-3"、"host deliver: to its own account; an account that is not running is unknown_channel (no fallback with several bots) #DL-4"、"one bot only: a delivery naming another account still goes out, as that bot's account #DL-4"、"a binding with match.account only takes that bot's inputs #DL-4 #RT-1"；`compositor-accounts.test.ts` "a route of account b is rendered by b only #DL-3 #DL-4"、"restore: only the route's account picks up the open turn and finalizes its card #DL-4 #RS-1"；`outbound.test.ts` "send / edit / finalize / retract refuse a route of another account, not retryable, without calling the API #DL-4"。
- **状态**：已覆盖（停掉或启动失败的账号不退回，已修）。

### DL-4b agent 写出的每条消息带 agent 身份（`SendOp.as`）

- **承诺**：会话的卡片（compositor）和输出工具发出的每条消息都带 `as = session:<sessionKey>`（`agentIdentity`，与来源 `declared`、watch 的 `createdBy` 同一格式），适配器记下它，回流时作为 `declared` 读回（POSITIONING §2 身份表明）。宿主 `deliver` 与系统回复不是 agent 写的，不带 `as`。
- **实现**：`gateway.ts` `compose`（`as`）与 `HostTools.as`。
- **测试**：`multi-lark.test.ts` "every agent-authored message carries the agent identity (SendOp.as); host deliveries and system replies carry none #DL-4b"。
- **状态**：已覆盖。回流时 `agentAccounts` 里的账号声明本部署的 `session:<key>` 即认作 self（守护进程接 `isSelfDeclared`，按会话日志、lane、登记判断），不触发任何规则；测试 "an agent account's message declaring one of our sessions is our own echo: never a turn #ID-5"。

### DL-5 外发目的地检查；宿主 outbound 回调失败即拒

- **承诺**：输出工具发往的每个路由都过 `Policy.outbound`（默认只允许本轮回复路由与预登记路由），`live_join` 的地点也一样；宿主声明了 `outbound` 钩子时由宿主决定，超时、出错、答复不合 schema 一律拒绝（决定 9）；这个宿主断开期间（含重启后）只放行本轮自己的回复路由，直到它重连或一个不声明 `outbound` 的宿主连上。
- **实现**：`gateway.ts` 构造函数里的 `outbound`（`host.outboundHeldBy()`、宿主回调、本地策略）；`packages/daemon/src/host.ts` `outboundHeldBy` 与 `hello`（宿主名记在 `DaemonRecords` 的 `daemon_flags`，跨重启）；`gateway.ts` `joinLive` / `liveAllowed`（通道有 `liveRoute` 时打开之前检查，否则检查打开后的端点路由，被拒即关闭端点）；`packages/host-mcp/src/tools.ts:380-397`（`allowed()`）。
- **测试**：`packages/daemon/test/host-callouts.test.ts` "the host decides; timeout, error and bad answers deny; without the hook the local policy decides #DL-5"、"a host that only answers route callouts leaves outbound to the local policy #DL-5"、"a host that declared the outbound callout disconnects: a send to a route other than the turn's own is still refused"（原 `it.fails`，已修；也覆盖重启后与交还本地策略）；`packages/daemon/test/live.test.ts` "live_join goes through the outbound check: a policy that denies every destination refuses it, no endpoint is opened"（原 `it.fails`，已修）、"live_join to a meeting that is not a preregistered destination is refused by the default policy; a channel that cannot name the route first has its endpoint closed"；`host-mcp.test.ts` "denies destinations outside Policy.outbound with a clear error and a notice #DL-5"。
- **状态**：部分覆盖。
- **决定（2026-10-11，依原则 4 与决定 9"`outbound` 任何失败都拒绝"自决；决定 13 冻结回调的扩展，这里是改正确性，不加新能力）**：
  1. 宿主离线时只放行本轮自己的回复路由：回复发问的地方不需要宿主授权，本地策略额外放宽的（预登记路由）正是宿主可能收紧过的，按 fail closed 拒绝。没有加配置开关（`host-callouts` §8 原设想的 `whenOffline`）。
  2. `live_join` 的地点按普通外发目的地处理：机器人在那里说话。缺省策略下要把会议路由预登记进 `policy.routes`，或由宿主 `outbound` 放行；`ChannelAdapter.liveRoute(account, target)`（可选）让网关在打开之前检查。
- **不成立**：
  1. ~~宿主断线时退回本地策略~~：已修，见上。
  2. ~~`live_join` 的目标不过 outbound 检查~~：已修，见上。
  3. outbox 自带的 outbound 检查只在 `Delivery.from` 存在时生效（`outbox.ts:108`），守护进程里没有调用方传 `from`，实际只靠输出工具的 `allowed()`。

---

## 3. 宿主入站队列与补投（HQ）

### HQ-1 交给宿主的输入 ack 前不丢

- **承诺**：`on: host` 的输入写进持久队列，按消费者记游标，至少一次投递，宿主 ack 后才前移；推送与拉取语义相同；断线期间留在队列，重连后补推；`takeover` 时旧连接未确认的推送改推新连接（决定 1、10）。
- **实现**：`packages/session/src/host-queue.ts:82-87`（表）、`:190-196`（`ack` 只前移）、`:218-226`、`:282-305`（推送从已 ack 游标开始，只在接受时 ack）；`host.ts:203-221`；入队 `ingress.ts:344-347`；与日志共用 SQLite（`gateway.ts:266-270`）。
- **测试**：`packages/session/test/host-queue.test.ts` "keeps one cursor per consumer; ack only moves forward; read after an explicit cursor #HQ-1"、"push: delivers in order and acks what the consumer accepts; retries a refusal #HQ-1"、"push: unacked items are redelivered after a reconnect (at least once), also across a restart #HQ-1 #RS-1"、"a new subscription for the same consumer replaces the old one #HQ-1"、"retention: deletes only what every known consumer acked, after retainAckedMs #HQ-1"；`host.test.ts` "push: delivered in order, the cursor moves on { accepted: true }; a refusal is redelivered; unacked items come again after a reconnect #HQ-1"、"pull: inbound.read never moves the cursor; inbound.ack does; channel redeliveries are one item #HQ-1 #HQ-2"；`packages/daemon/test/host-liveness.test.ts` "without takeover a second host is refused; with it the old connection is closed and its unacked push goes to the new host #HQ-6 #HQ-1"；`host.test.ts` "an unacked item is pushed again to the same consumer after a daemon restart #HQ-1"。
- **状态**：有测试（跨重启在 `HostQueue` 层与网关层都有）。
- **注意**：`ack` 夹到 `head()`（`host-queue.ts:192`），宿主 ack 一个很大的游标会把没读过的也确认掉（按设计）；清理只算已登记的消费者（`:202-205`），之后才登记的消费者看不到已清理的条目。

### HQ-2 队列按渠道消息引用幂等

- **承诺**：幂等键是 `channel:<渠道>/<消息 id>`（按账号区分），同一消息重投返回第一次的游标。
- **实现**：`host-queue.ts:53-56`、`:107-133`。
- **测试**：`host-queue.test.ts` "appends idempotently on the channel reference: a redelivery returns the first cursor #HQ-2"、"dedups per account: the same message id on another bot account is a different message #HQ-2"；`packages/session/test/routing.test.ts` "queues host rules durably, idempotent on the channel reference, alongside the session deliveries #HQ-2 #HQ-1"。
- **状态**：有测试。
- **注意**：引用在条目清理后再保留 7 天（`host-queue.ts:209` `pruneRefs`），更晚的重投会再入队。

### HQ-3 宿主不在线只变慢，不丢

- **承诺**：路由回调失败（无宿主、超时、出错、答复不合 schema、launch 被拒）走规则的 `onFailure`，默认 `host`，即进 HQ-1 的持久队列；不会在宿主不知情时拉起 agent（决定 2）。回调与否、结果都记入 explain。
- **实现**：`packages/session/src/router.ts:530-552`、`:430-437`。
- **测试**：`host.test.ts` "timeout → onFailure (default host: the durable queue); recorded in explain #HQ-3 #EX-1"、"an answer replaces the rule; no host → no_host and onFailure #HQ-3"；`packages/session/test/router.test.ts` "timeout → onFailure (default host); error and a bad answer too; recorded #HQ-3 #EX-1"、"no host (none connected, or no callout function) → onFailure without calling #HQ-3"、"a refused launch counts as an error answer: onFailure applies without the launch, the reason is recorded #HQ-3 #FC-4"。
- **状态**：有测试。
- **注意**：只在 `onFailure` 保持默认时成立；配置 `onFailure: 'dispatch'` 时回调失败会直接派发（`router.ts:531`），这是部署方的选择。

### HQ-4 补投按 cursor 至多一次，保留原来源

- **承诺**：`inbound.redispatch` 以原 origin、内容、回复路由投递，只在 `channelContext.redispatchedBy` 记宿主；同一 cursor 至多一次，投递被停止截断时答 `interrupted: true` 且不再发；失败不记，可换会话重试；explain 两头可查（决定 9）。
- **实现**：`gateway.ts:848-930`（`redispatchOnce`，待定记录 `:893`、补全 `:921`）；表 `host_redispatch`（`host-queue.ts:85`）；`ingress.ts:410-438`；`router.ts:483-492`。
- **测试**：`packages/daemon/test/inbound-redispatch.test.ts` "delivers a queued item with its original origin, records both sides in explain, and is idempotent per cursor #HQ-4 #ID-1 #EX-1"、"concurrent first requests deliver once #HQ-4"、"at most once: a redispatch cut off before its outcome was recorded is reported, never sent again #HQ-4"、"a delivery refused by the session is not recorded: a retry elsewhere (with a launch) goes through; agent_conflict; the result names the session's own agent #HQ-4 #LA-1"、"concurrent requests: when the first fails, a waiter tries again with its own arguments #HQ-4"。
- **状态**：有测试（"截断"是在同一进程里注入待定记录，不是真重启）。
- **注意**：原输入的 explain 过期（7 天）后，`redispatched` 反向链接静默不写（`ingress.ts:434`）。

### HQ-5 宿主推送的表带版本，宿主下线时按 onHostDown 生效

- **承诺**：`bindings.put` 整表原子替换，同版本同内容是空操作；宿主推送的表默认 `suspend`，宿主下线期间不生效；重启后保留最后一张表，挂起到宿主重连（`keep` 除外）；只拉取的宿主（`aio tail`）始终视为不在线，它的表用 `onHostDown: "keep"` 加定期重推、每次刷新 `expiresAt` 当租约（HOSTS.md §4、§6；`host.hello.lease` 已删除，决定 13）。
- **实现**：`router.ts:269-279`、`:312-318`、`:237-247`。
- **测试**：`router.test.ts` "atomic replace with version; the same version again is a no-op #HQ-5"、"suspends while the host is down (default) or keeps routing with onHostDown: keep #HQ-5"、"persists: a restart keeps the last table, suspended until the host reconnects (unless keep) #HQ-5 #RS-1"、"expires at expiresAt #HQ-5"、"pull-only host lease: onHostDown keep + a periodic re-push with a fresh expiresAt routes without a host connection, and lapses when the re-push stops #HQ-5"；`packages/protocol/test/admin-topics.test.ts` "host.hello has no presence lease (decision 13): pull-only hosts use onHostDown keep + expiresAt #HQ-5"；`host.test.ts` "installs the host table (routing follows it), persists it, and suspends it while the host is away #HQ-5"、"onHostDown keep stays active without a host #HQ-5"。
- **状态**：部分覆盖。
- **不成立**：
  1. ~~**`lease` 没有实现。**~~ 已删（决定 13）：`host.hello.lease`、`HostHelloResult.lease`、`AdminHostState.leaseExpiresAt` 从协议与 schema 删除；租约的正式做法是 `onHostDown: "keep"` + 重推刷新 `expiresAt`。旧宿主仍带 `lease` 不会被拒（对象 schema 允许多余字段），只是被忽略。
  2. 版本不比较先后：任何版本都替换当前表（`router.ts:270-275`），迟到的旧推送会覆盖新表。文档只说"带版本号"，没说单调；若宿主依赖单调，这里不成立。测试：`it.fails` `packages/session/test/router.test.ts` "a late older version does not replace a newer table #HQ-5"（以"单调"为准写的；若决定版本不保证单调，删掉它并在承诺里写明）。

### HQ-6 同一时刻至多一个宿主；接管要 token；/ws 有心跳

- **承诺**：带 `consumer` 或回调的 `hello` 才是宿主，同时至多一个；第二个默认 `host_connected`，`takeover: true` 且 token 正确才替换旧连接；`/ws` 心跳清掉半开连接。
- **实现**：`host.ts:155-180`（`timingSafeEqual` 先于角色判断）；`packages/daemon/src/console.ts:435-456`。
- **测试**：`host-liveness.test.ts` "closes a connection that stops answering pings, which frees the host role #HQ-6"、`host-liveness.e2e.test.ts` "keeps a connection that answers #HQ-6"、`host-liveness.test.ts` "without takeover a second host is refused; with it the old connection is closed and its unacked push goes to the new host #HQ-6 #HQ-1"、`host-liveness.e2e.test.ts` "over /ws: a takeover closes the old (half-open) connection, which goes away even though it never answers #HQ-6"、`host-liveness.test.ts` "takeover with no host connected is a plain hello #HQ-6"。
- **状态**：有测试。
- **注意**：心跳只在 `/ws`；unix socket 上的半开宿主连接一直占着宿主位，直到有人 takeover。

### HQ-7 token 文件 0600

- **承诺**：token 文件不存在则生成（0600，目录 0700），存在则读；别人可读、太短、目录别人可写时拒绝启动。
- **实现**：`packages/daemon/src/token.ts:22-31`、`:50-58`、`:107-112`。
- **测试**：`packages/daemon/test/token-file.test.ts` "generates the file (0600, directory 0700) when missing, then reads it at every later start #HQ-7 #SE-2"、"refuses files others can read, short tokens, and directories others can write; the daemon does not start #HQ-7 #SE-2"；`host.test.ts` "writes a 0600 token file next to the socket; the token is required; frames before hello are refused #HQ-7 #SE-2"。
- **状态**：有测试。

---

## 4. 来源与身份（ID）

### ID-1 每条输入带来源

- **承诺**：每条 `InputRecord` 都有 `Origin`（kind、principal、evidence、via、adapter，可选 declared、self）；合成的输入（略去行、live 委托、话题摘要、digest）用 system 来源，`principal: null`。
- **实现**：`packages/protocol/src/inbound.ts:74-92`（必填字段）；`ingress.ts:253-271`；`packages/session/src/watch.ts:423`（被监听的保留原发送者）；`lane.ts:685`、`:928-934`；`gateway.ts:1255`。
- **测试**：`ingress.test.ts` "stamps origin from Policy.identify and dispatches owner input to a lane #ID-1 #ID-3"；`watch.test.ts` "records a watched group message as context in the target, keeping the original origin #ID-1"；`packages/session/test/live.test.ts` "a delegation becomes an input from the far side and the harness-started turn runs as the lane turn #LN-6 #LN-2 #ID-1 #LN-4"。
- **状态**：有测试。

### ID-2 模型看得到来源

- **承诺**：交给 harness 的每条输入前面有发送者说明（主体、来源类型、经由的路由、是否经 watch），被监听与外部内容明确标注（决定 5）。
- **实现**：`harness/claude-code/src/content.ts:31-38`、`:128`；`harness/codex/src/map.ts:25-30`。
- **测试**：`harness/claude-code/test/claude-code.test.ts` "one SDKUserMessage per input, uuid bound to inputId, explicit priority, preface #ID-2"、"preface marks unknown senders and agents #ID-2"、"labels context-only inputs as not addressed to the agent, keeping their own sender preface #ID-2"；`harness/codex/test/codex.test.ts` "labels context-only inputs as not addressed to the agent (also without the sender preface) #ID-2"。
- **状态**：部分覆盖。
- **不成立**：
  1. 两个 harness 的说明都不含 `origin.evidence`（`content.ts:33`、`map.ts:27`）；决定 5 列的"证据"模型看不到。Codex 还不显示 `self`。测试：`it.fails` `harness/claude-code/test/claude-code.test.ts` "the sender preface names the origin evidence #ID-2"；`it.fails` `harness/codex/test/codex.test.ts` "the sender preface names the origin evidence #ID-2"。
  2. Codex 的 `preface: false`（`harness/codex/src/session.ts:79`、`map.ts:65`）整个关掉发送者说明，连 watch 标记一起没了。测试：`it.fails` `harness/codex/test/codex.test.ts` "preface: false still marks a watched input as watched #ID-2"。
  3. ~~没有测试断言 `watch=` 标记出现在模型输入里。~~ 已补（决定 14）：`claude-code.test.ts`、`codex.test.ts` 各一条 "a watched input reaches the model with the watch= marker in its sender preface #ID-2"。
  4. 模块 harness 自己渲染输入，核心不保证有说明。

### ID-3 Origin 由网关盖章，客户端不能设置

- **承诺**：`Origin` "由网关盖章，客户端不能设置"（`inbound.ts:74`）；适配器只提交本命名空间内的 `channelUserId` 与证据（RECOMMENDATION §3.5 第 1 条，POSITIONING §2）。
- **实现**（channel-stamping，决定 13，`docs/design/channel-stamping/`）：
  1. **来源绑定（C）**：网关为每个通道的 `emit` 构造 `EmitSource`（`gateway.ts` `startChannel` 的 `emit`、`emitSource`），`Ingress.accept(env, source)` 在去重之前核对 `env.channel/account` 与 `replyRoute` 的 `channel/account`，不符即 `accepted:false`、`error` 以 `SOURCE_MISMATCH`（`source_mismatch:`）开头，不进去重表、不写 `input.verify`（`ingress.ts` `accept`、`sourceMismatch`）；网关记日志（每通道每原因每分钟一条）并计 `AdminChannel.rejected`（`gateway.ts` `stamped`）。
  2. **id 归属（F4）**：一个通道 id 只属于一种适配器（`gateway.ts` `channelOwner`、`idConflict`）；内置 id `lark-bot`/`mail`/`local` 不许 bridge、module 使用；不同 bridge 程序共用 `id` 在配置校验时失败（`config.ts` `resolveChannels`），module、嵌入方适配器与已连上 bridge 的冲突在启动时失败（`startChannels`），live apply 时进 `failed`；bridge 的 id 由配置 `id`（`expectId`）或第一次 hello 固定，换 id 或 hello 的 id 被网关拒绝（`acceptId`）都是 `bad_hello`（`channel/jsonl-bridge/src/host.ts` `connect`）。
  3. **证据封顶（E3）**：上限 = 条目 `evidence` ∩ `caps.evidence` ∪ `none`，不写时 bridge、module 只有 `device_only`（`config.ts` `UNGRANTED_EVIDENCE`、`gateway.ts` `emitSource`）；超出降为 `none`、`caps.declaresSender` 为 false 时丢 `declared`，在浅拷贝上做，调用方对象不变（`ingress.ts` `capEnvelope`）；`identify`、`Origin`、宿主入站队列、watch 与 `input.verify`（`Gateway.accept` 记 `r.envelope`）都只看封顶后的信封；`RouteExplanation.claimedEvidence` 记原声明，`AdminChannel.evidenceCapped` 计数。

  本地 socket 与宿主连接的 origin 由连接决定（`packages/daemon/src/local-server.ts:343-347`、`host.ts:63`、`:178`）。
- **测试**：`packages/session/test/ingress.test.ts` "refuses an envelope claiming another channel, account or reply route, without remembering it #ID-3"、"checks the source before dedup: a forged copy of a seen (channel, account, id) is invalid, not a duplicate #ID-3 #IN-5"、"caps evidence beyond the source to none: the owner is a stranger, the explanation keeps the claim, the caller object is untouched #ID-3 #ID-4"、"drops sender.declared when the source may not declare senders, also from a trusted agent account #ID-3"、"emitter(source) answers like accept(env, source); without a source nothing is checked or capped #ID-3"；`packages/daemon/test/channel-stamping.test.ts` "a channel claiming another channel as the owner is refused: no lane, no input.verify record, counted #ID-3"、"a bridge whose hello claims a built-in id is failed: its inbound is never taken, it routes nothing as lark-bot #ID-3"、"a bridge whose hello takes the id of another running adapter fails the start (F4) #ID-3"、"one bridge program under one id runs several accounts #ID-3"、"a bridge may not use a built-in channel id #ID-3"、"two different bridge programs may not share a channel id; one program with two accounts may #ID-3"、"parses an evidence grant on any channel entry; entries without one are unchanged #ID-3"、"a bridge without a grant gives no platform_signed: the owner is a stranger, recorded as none, counted #ID-3 #ID-4"、"a granted bridge gives it (∩ caps); a grant beyond caps is warned about and ignored #ID-3"、"an in-process adapter is capped by its caps #ID-3"；`packages/daemon/test/module-channel.test.ts` "fails when two entries give the same (channel, account), also against another channel #ID-3"、"without an evidence grant its platform_signed is capped to none (stranger, counted in status, recorded as none) #ID-3 #ID-4"；`channel/jsonl-bridge/test/bridge.test.ts` "expectId: a hello declaring another id is bad_hello; with retryFirstConnect the peer is restarted and stays refused #ID-3"、"without expectId the first hello pins the id: a restarted peer declaring another is refused #ID-3"、"acceptId can refuse a hello id (bad_hello) #ID-3"、"a refused inbound is answered ok:true with {accepted:false} #ID-3"；一致性套件 `inbound.channel_id`、`inbound.account`、`inbound.evidence_in_caps`（`packages/testkit/src/channel-conformance.ts`）。
- **状态**：有测试。
- **边界**（有意如此，不算不成立）：
  1. 不传 `source` 的 `Ingress.accept(env)` / `Gateway.accept(env)` 把调用方当受信方（嵌入方自己构造信封、测试），行为与盖章前相同。
  2. 嵌入方经 `GatewayOptions.channels` 传入的适配器按类归属：同类的多个对象（多个机器人）可共用 id；嵌入方代码与守护进程同等受信。
  3. 身份键不含账号（`identity.ts` `identityKey`）：F4 之后只有同一种适配器的多个账号共享身份命名空间，不再能跨通道冒充（提案 §10 第 4 项）。
  4. 出站按 id 退回（DL-4）不属于本条。

### ID-4 证据不足的主人按陌生人处理

- **承诺**：身份映射命中但证据不在接受集合（默认 `platform_signed`、`dkim_pass`）里时 `principal: null`；文本或 `declared` 里的自称不能冒充主人（决定 3，POSITIONING §4）。
- **实现**：`packages/session/src/identity.ts:21`、`:109-112`。
- **测试**：`packages/session/test/policy.test.ts` "an owner address without evidence is a stranger (forged From) #ID-4"、"a DKIM-verified or platform-signed owner is the owner #ID-4"、"never accepts a declared identity that names an owner, even from a trusted agent account #ID-4 #CT-1"；`router.test.ts` "stamps principal and labels only with accepted evidence (default platform_signed, dkim_pass) #ID-4"、"owners config is the minimal map; a host map overrides it per channel identity and is suspended with its table #ID-4 #HQ-5"。
- **状态**：有测试。证据本身由 ID-3 保证可信：只可能来自有资格给出它的通道（条目授予 ∩ caps），否则降为 `none`，测试见 ID-3（`channel-stamping.test.ts` "a bridge without a grant gives no platform_signed: the owner is a stranger, recorded as none, counted #ID-3 #ID-4"）。

### ID-5 本部署的回流不开轮

- **承诺**：本部署自己发出的消息回流时标 `self`，默认丢弃；即使规则或监听设了包含回流，也只记作 context，永远不开轮。
- **实现**：`ingress.ts:262`、`:276`；`router.ts:503`；watch 的 `excludeSelf`。
- **测试**：`ingress.test.ts` "drops self echoes and unknown DMs; observes strangers in groups #ID-5 #ID-1"；`watch.test.ts` "own echoes: excluded by default; with excludeSelf false only ever context, never a turn (no loops) #ID-5"。
- **状态**：有测试。

### ID-6 权限 profile 按触发输入定，不按上下文降档

- **承诺**：`Policy.plan` 只看触发本轮的输入（默认：全部来自主人才 `bypass`），上下文里混入的监听、群聊、外部内容不改变 profile；会让 profile 变化的 steer 改为排队（决定 5）。
- **实现**：`lane.ts:856`（plan 不含 context 记录）、`lane.ts:573-574`；`policy.ts:96-101`。
- **测试**：`policy.test.ts` "bypass only when every input is from an owner #ID-6"；`watch.test.ts` "a trigger turn keeps the original sender: restricted for a stranger, bypass for the owner #ID-6 #ID-1 #CF-5"；`lane.test.ts` "auto: answers immediately per policy (bypass → allow) #ID-6 #RQ-1"、"auto deny for a restricted turn #ID-6"；`routing.test.ts` "the owner @-ing in a group after strangers talked: tagged watched + external + group (never blocked or downgraded) #EX-3 #ID-6"；`context.test.ts` "stranger messages in the context do not change the plan: the same run as without them #ID-6"；`lane.test.ts` "a steer that would change the turn's profile is queued instead (the profile comes from the turn's own inputs) #ID-6"。
- **状态**：有测试。
- **注意**：live 委托 turn 不调 `plan`，沿用 `lastRun`（`lane.ts:968`），所以主人放行的一轮之后，会议里任何人的委托都按 `bypass` 自动放行审批（`policy.ts:106`）。这是决定 11"与文字会话同权限"的字面结果，不算违反，但值得在决定 11 里写明这个后果。

---

## 5. 可解释性（EX）

### EX-1 每个路由决定都记下，explain 跨重启可查

- **承诺**：每条输入的路由决定（命中的规则、回调与否及结果、失败模式、`skipped_pinned`、`agent_unavailable`、补投两头）持久记录，`aio explain <inputId>` 重启后仍能查。
- **实现**：`router.ts:223-233`、`:655-665`；`packages/daemon/src/cli.ts:512-517`。
- **测试**：`router.test.ts` "are persisted: explain(inputId) works across a restart #EX-1 #RS-1"；`host.test.ts` "explain returns the routing record of an input; unknown ids are an error #EX-1"；`routing.test.ts` "only-host inputs report action host; explain(inputId) shows the rules #EX-1"、"a dropped input is explained too #EX-1"；`runs.test.ts` "a channel message to a session whose agent is gone: refused (no harness), a notice on the route, and explain says agent_unavailable #FC-1 #EX-1"。
- **状态**：有测试。
- **注意**：记录保留 7 天（`explainTtlMs`，`router.ts:165-166`）。

### EX-2 从任何副作用追溯到触发它的轮次与输入

- **承诺**：发消息、宿主写命令、审批等任何副作用都能由 `aio explain` 追溯到触发它的轮次与输入（ROADMAP §1 原则 4、决定 4）。
- **实现**：没有。`explain` 只接受 inputId（`cli.ts:512-517`，协议 `Explain = { inputId }` 在 `packages/protocol/src/host.ts:286`），只返回路由记录（`router.ts:662-665`）；没有按 operationId、providerMessageId、requestId、turnId 的查询。能手工从日志串起来的：输出工具与卡片的 `delivery.settled` 带 `turnId`，`render.anchor` 把平台消息 id 映射到 turn，`turn.started.inputIds` 再到输入。串不起来的：系统回复（`gateway.ts:1104-1109`，只有 `${code}:${inputId}` 形式的 operationId，没有 turn）、宿主 `deliver`（`sessionKey: host:<name>`）、卡片流式编辑、`live_say`（什么都不记）。本轮来源摘要（`lane.ts:338-353`）不含 inputIds，只在内存里保留最近 256 轮。
- **测试**：`it.fails` `packages/daemon/test/host.test.ts` "explain by the operationId of an output-tool send returns the turnId and that turn's inputIds #EX-2"（今天 `explain` 只认 inputId，答 `unknown_input`）。
- **状态**：不成立（只有 `it.fails`）。
- **不成立**：原则 4 后半句与决定 4"`aio explain` 能从任意写入追溯到触发它的轮次与输入"目前都没有实现。

### EX-3 宿主写请求附带本轮来源标记

- **承诺**：输出工具的每次调用附带本轮来源摘要（是否含 context / digest / 外部 / 群聊），不拦截（决定 4，HOSTS.md §宿主写命令的来源标记）。
- **实现**：`tools.ts:404-405`（`provenance` 写进 `agents-io.output` 记录）；`lane.ts:338-353`。来源不进 harness 子进程环境：任务运行只带 `AGENTS_IO_RUN_ID`（`gateway.ts` `openRunLane`），`AGENTS_IO_TURN_PROVENANCE` 已删除（决定 13）。
- **测试**：`host-mcp.test.ts` "tags every write with the turn provenance (never blocks it) #EX-3"；`packages/daemon/test/runs.test.ts` "env goes into the run child only: the instance built for the run has it; the log, explain records and other instances do not #SE-1 #EX-3"（带 `AGENTS_IO_RUN_ID`、不带 `AGENTS_IO_TURN_PROVENANCE`）；`context.test.ts` "provenance: flags come from the context actually handed, and stay for later turns #IN-6 #EX-3"；`routing.test.ts` "an owner DM: triggered by the owner, nothing watched, external or group #EX-3"、"a watch trigger from a stranger: triggered by null, watched, external #EX-3"。
- **状态**：有测试（输出工具的写入）。agent 在工作区里直接调 `x` 这类宿主命令时不经 agents-io，按决定 4 的修订（决定 13）由 EX-4 兑现。

### EX-4 来自渠道消息的输入在模型面前带可核验的 ref

- **承诺**：来自渠道消息的输入（直接派发、只记录、watch、补投、话题转交）带 `InputRecord.channelRef = channel:<通道>/<消息 id>`，由网关按核对过的信封盖章，客户端不能设置；两个 harness 的发送者说明行都把它原样（不截断）写成 `ref=…`；同一个键传给 `input.verify` / `aio verify` 能查到这条消息的盖章作者与证据。本地、宿主、任务运行与系统输入没有 `ref`（决定 4 修订，决定 13；HOSTS §4.1）。
- **实现**：`packages/session/src/ingress.ts` `process`（`channelRef: channelRefOf(env)`，`env` 是盖章后的信封）、`packages/session/src/watch.ts` `deliver`；补投与话题转交展开原 `InputRecord`，引用不变；客户端 `input` 帧逐字段构造 `InputRecord`（`gateway.ts` `case 'input'`），不带 `channelRef`。`harness/claude-code/src/content.ts` `preface`、`harness/codex/src/map.ts` `senderPreface`；`packages/daemon/src/records.ts` `recordInput` / `verify` 用同一个 `channelRefOf`。
- **测试**：`packages/daemon/test/channel-stamping.test.ts` "the harness gets channelRef = channel:<channel>/<message id>, the key aio verify answers with the stamped author #EX-4"；`harness/claude-code/test/claude-code.test.ts` "preface carries ref=channel:<channel>/<message id> only for a channel message, verbatim (never truncated) #EX-4"；`harness/codex/test/codex.test.ts` "sender preface carries ref=channel:<channel>/<message id> only for a channel message, bare like Claude Code #EX-4"。
- **状态**：部分覆盖（watch、补投路径的 `channelRef` 没有单独的测试）。
- **注意**：`ref` 只证明"这个人发过这条消息"，不证明它就是触发这次宿主命令的那条；agent 可以带会话里更早一条消息的 `ref`。宿主要靠 `verify` 结果里的 `conversation` / `receivedAt` / `inputId` 自己加约束。

---

## 6. 会话与 lane（LN）

### LN-1 每个 session 一条 seq 连续、只增的日志

- **承诺**：持久事件的 seq 按 session 从 1 连续递增，不改写；delta 等易失事件不占 seq、不落盘；压缩只把旧事件折进快照；订阅者从任意 seq 续上不缺不重。
- **实现**：`log.ts:227-249`；`packages/session/src/sqlite-log.ts:46`、`:58-61`（`(session_key, seq)` 主键，只 INSERT）、`:73-77`、`:84-100`。
- **测试**：`packages/session/test/log.test.ts` "assigns gapless per-session seq to durable events only #LN-1"、"forces deltas ephemeral and other kinds durable whatever they claim #LN-1"、"survives reopen: head, events and fold are restored #LN-1 #RS-1"、"compacts old events into a stored snapshot #LN-1 #RS-1"、"trims to `retain` and reports the floor #LN-1"；`packages/session/test/hub.test.ts` "resumes from a seq: replay then live, no gaps #LN-1"、"gives two subscribers the same durable sequence #LN-1"；`gateway.test.ts` "reconnecting with fromSeq replays exactly what was missed #LN-1"；`lane.test.ts` "runs a turn and wraps harness events into a gapless, conforming session stream #LN-1"；`log.test.ts` "a second writer of the same (session_key, seq) is refused by the primary key; the first event stays #LN-1"。
- **状态**：有测试。

### LN-2 一个 session 只有一个写者 lane，同一时刻至多一个 turn

- **承诺**：每个会话键至多一个 `Lane`；命令与 harness 事件在 lane 里逐个处理；同一时刻至多一个 turn。
- **实现**：`gateway.ts:223`、`:703-736`（同步的取或建）；`lane.ts:455-459`（`serial`）；`lane.ts:833`、`:853`（先置 `this.turn` 再 await）。
- **测试**：`lane.test.ts` "never merges inputs from two principals or two routes into one turn #IN-3 #LN-2"；`live.test.ts` "a delegation becomes an input from the far side and the harness-started turn runs as the lane turn #LN-6 #LN-2 #ID-1 #LN-4"。"一个键一个 lane"本身没有测试。
- **状态**：部分覆盖。
- **不成立**（决定 14 已复现）：`closeLane`（停放话题空闲时关闭）先把 lane 从表里删掉，再最多等 8 s 关闭它（`gateway.ts:1316-1324`）。这期间到达的输入会为同一个键建第二个 `Lane`（`gateway.ts:715`），旧 lane 的事件循环只检查 generation 与 detached、不检查 closed（`lane.ts:885`），两个 harness 会话可能同时续接同一个原生会话。日志 seq 仍单调（共用同步日志），但有两个写者。测试：`it.fails` `packages/daemon/test/topics.test.ts` "an input that arrives while a parked topic's lane is closing does not open a second lane for the same key #LN-2"（让旧会话的 `close()` 卡住，确定地复现）。

### LN-3 一个 session 至多一个 live

- **承诺**：同一 session 同时至多一个 live；已有 live 时 `live_join` 报错；并发的第二个 `live_join` 在 `await openLive` 之前就被 `joining` 占位拒绝，不碰正在跑的 live，也不为它开端点（决定 11）。
- **实现**：`gateway.ts` `joinLive`（`joining` 占位）；`lane.ts:386`。
- **测试**：`live.test.ts`（session）"starts the harness live, records live.started, refuses a second one, and needs a harness that has it #LN-3"；`packages/daemon/test/live.test.ts` "two concurrent live_join: one wins, the other is refused without touching the running live or opening an endpoint #LN-3"、"live_join pairs the channel peer with the harness voice; the far side hanging up ends both; live_say / live_leave #LN-3 #LN-4"。
- **状态**：已覆盖（先后两次与并发两次）。

### LN-4 live 任一端结束，两端都结束并记 live.ended

- **承诺**：对端离会、harness 关闭、`live_leave`、守护进程停止，任一发生都关闭另一端并记 `live.ended`。
- **实现**：`gateway.ts:1204-1208`、`:1231-1246`、`:1791`；`lane.ts:951-954`。
- **测试**：`daemon/test/live.test.ts` "live_join pairs the channel peer with the harness voice; the far side hanging up ends both; live_say / live_leave #LN-3 #LN-4"、"live_leave ends the live; the gateway stopping ends a running one #LN-4 #RS-8"、"the gateway stopping records live.ended in the log; the harness ending first closes the endpoint too #LN-4"。
- **状态**：部分覆盖（假 harness 下停止时记 `live.ended`、harness 先结束时端点关闭都有测试；下面 Codex 的路径假 harness 复现不了，没有 `it.fails`）。
- **不成立（可能）**：守护进程停止时 Codex 只在 `thread/realtime/closed` 或 5 s 兜底后发 `live.ended`（`harness/codex/src/session.ts:795-803`），而 `leaveLive` 整步限时 5 s（`gateway.ts:1791`），随后 lane 被 detach，之后的事件被丢弃（`lane.ts:885`），`live.ended` 可能不进日志。

### LN-5 live 传输不符时在 start 之前拒绝；frames 的视频只给声明了 video 的 live

- **承诺**：`live_join` 在 `start` 之前拒绝 harness 不支持的传输（错误里有传输名），关闭端点、不留登记；frames 端点在 live 没声明 `video` 时滤掉视频帧；只对 webrtc 调 `endpoint.answer`（决定 11 补记）。
- **实现**：`lane.ts:389-391`（`LiveTransportError`）、`lane.ts:396`、`:1313-1316`（`audioOnly`）；`gateway.ts:1176-1199`。
- **测试**：`packages/session/test/live.test.ts` "a transport the harness live does not take is refused before start, naming the transport; nothing is registered #LN-5"、"a frames live without video gets no video frames; one that declares video gets them #LN-5"；`packages/daemon/test/live.test.ts` "a frames endpoint for a harness whose live takes webrtc only: refused before start, naming the transport; the endpoint is closed and no live is registered #LN-5"。
- **状态**：有测试（决定 14 补上）。

### LN-6 live 委托的输入形状

- **承诺**：语音端每次委托记一条输入：`transcript` 块、`origin.principal = null`、`channelContext.live = true`、回复路由 = 发起 live 的路由；harness 自己开的 turn 交给 lane 当作当前 turn，turn 本身没有回复路由（决定 11）。
- **实现**：`lane.ts:923-947`、`:960-976`。
- **测试**：`live.test.ts`（session）"a delegation becomes an input from the far side and the harness-started turn runs as the lane turn #LN-6 #LN-2 #ID-1 #LN-4"；`daemon/test/live.test.ts` "a delegated turn (no reply route) sends to \"current\" = the chat that opened the live #LN-6"。
- **状态**：有测试。

---

## 7. 审批（RQ）

### RQ-1 一个请求只结算一次，资格在服务端复核

- **承诺**：`request.opened` 之后恰好一条 `request.resolved`，先到者为准；按钮点击和 resolve 命令都由 lane 重新检查资格；harness 侧的重复 resolve 被忽略。
- **实现**：`lane.ts:1187-1200`、`:1029`；`ingress.ts:276-295`（点击送到持有请求的 session）。
- **测试**：`lane.test.ts` "human: re-checks eligibility server side; first resolve wins #RQ-1"、"host: only a system origin may resolve #RQ-1"；`packages/session/test/e2e.test.ts` "approval by button click on the card, re-checked server side #RQ-1"；`ingress.test.ts` "turns an approval button click into a resolve command (eligibility re-checked by the lane) #RQ-1"；`harness/codex/test/unix.test.ts` "an approval answered while reconnecting is delivered when Codex replays it, and only then reported resolved #RQ-1"。
- **状态**：有测试。

### RQ-2 turn 结束时未答的请求被取消；人工超时为拒绝

- **承诺**：turn 结束时属于它的未答请求记 `runtime_cancelled`；空闲时开的请求不受下一轮结束影响；`human` 超时按拒绝；`policy.escalate` 抛错按拒绝。
- **实现**：`lane.ts:1053-1059`。
- **测试**：`lane.test.ts` "cancels open requests when the turn ends without answering them #RQ-2"、"a request opened while idle is not cancelled by the next turn ending #RQ-2"、"human: times out to deny #RQ-2"、"a throwing policy.escalate after a model escalation denies the request with a notice #RQ-2"、"a throwing policy.escalate without a reviewer denies the request and keeps the harness session #RQ-2"；`codex.test.ts` "passes native decisions through and cancels open requests when the turn ends #RQ-2"。
- **状态**：有测试。

### RQ-3 代人作答须显式开启，只给宿主连接，并记 by.via

- **承诺**：`resolve { onBehalfOf }` 只有宿主连接能用，且只在部署方开启 `policy.answerOnBehalf`（缺省 `false`）时可用，否则答 `on_behalf_not_allowed`、请求不变、`features` 不列 `resolve.onBehalfOf`；日志记 `by.via: "host:<name>"`（决定 9、决定 13）。决定 12 的 agent 代为审批共用这个开关。
- **实现**：`gateway.ts` `case 'resolve'`（先 `not_eligible`，再查 `config.policy.answerOnBehalf`）；`host.ts` `hello`（按开关过滤 `FEATURES`）；`config.ts` `policy.answerOnBehalf`；`lane.ts` `resolveCommand`（再查一次宿主 origin 与 principals）。
- **测试**：`lane.test.ts` "onBehalfOf: only a host connection (system origin through the host adapter) may relay #RQ-3"；`host-callouts.test.ts` "onBehalfOf is off by default (policy.answerOnBehalf): on_behalf_not_allowed, not advertised, the request stays open #RQ-3"、"the host picks the resolver (human) and answers on the principal's behalf; the log records the principal and the host #RQ-3"、"a host resolver answered on behalf of a principal records it with via #RQ-3"、"true is route only; a list names hooks, unknown ones ignored; the result lists what was granted; features advertise it #RQ-3"。
- **状态**：有测试。
- **注意**：开关只在网关一层（会话 lane 不知道配置）；lane 的 `resolveCommand` 只经网关调用。

### RQ-4 resolve 回调失败退回本地策略

- **承诺**：宿主未连接、没开 `resolve`、超时、出错、答复不合 schema，都按本地策略决定并记 notice，不因宿主挂掉而卡住（决定 9）。
- **实现**：`gateway.ts:296-308`；`host.ts:236`（默认 3 s）。
- **测试**：`host-callouts.test.ts` "timeout, error and a bad answer fall back to the local policy; a host without the hook is never asked #RQ-4"。
- **状态**：有测试。

### RQ-5 打开的人工审批立刻对每个层级、每个订阅者、每个通道可见

- **承诺**：交给人的请求（`resolver.kind = human` 的 `request.opened`）不被任何层级（含 `final`）或过滤器滤掉，每个订阅者都收到；不能编辑的通道与 `final` 层级为它单独发一条消息；能编辑的通道立刻刷新卡片（不等节流），流式编辑失败时重试，按钮不会因为一次失败的编辑而不出现。
- **实现**：`packages/session/src/tier.ts` `mustDeliver`、`passes`（必须送达的事件先于层级与过滤判断）；`packages/session/src/compositor.ts` `changed`（不能编辑时以 operationId `…:req:<requestId>` 经 outbox 单发一条）、流式编辑的重试（不经 outbox，在 compositor 里退避重试）、`renderTurn`（未答的人工请求总是显示）。
- **测试**：标签 `#RQ-5`；例：`packages/session/test/hub.test.ts` "filters by tier and never filters out human approvals #RQ-5"；`packages/session/test/e2e.test.ts` "final-tier channel without edit: one message per turn, plus one per human request #RQ-5"、"retries a failed streaming edit, so the approval buttons still appear #RQ-5"、"shows an approval at once even when a throttled edit is already scheduled #RQ-5"；`packages/daemon/test/gateway.test.ts` "human approval reaches a second subscriber at final tier and is resolved through it #RQ-5"。
- **状态**：有测试。

---

## 8. 失败即关闭（FC）

### FC-1 会话的 agent 不在了就拒绝，不退回默认 agent

- **承诺**：会话记录的 agent 被删或变成任务 agent 时，输入以 `agent_unavailable` 拒绝，在原路由回一条说明，explain 记下；绝不改用默认 agent。
- **实现**：`gateway.ts:762-771`（`pickAgent` 抛 `LaneUnavailableError`）；`ingress.ts:451-460`、`:362-370`；`gateway.ts:1088-1101`。
- **测试**：`runs.test.ts` "a session whose recorded agent is gone refuses input with agent_unavailable, never falling back to the default agent #FC-1 #IN-1"、"a session whose recorded agent is a task agent now refuses input with agent_unavailable #FC-1"、"a channel message to a session whose agent is gone: refused (no harness), a notice on the route, and explain says agent_unavailable #FC-1 #EX-1"；`packages/daemon/test/session-launch.test.ts` "a launched session whose agent was removed refuses input instead of falling back to the default agent #FC-1"。
- **状态**：有测试。

### FC-2 harness 起不来时明确拒绝

- **承诺**：开轮失败时本轮输入 `input.rejected start_failed: …`，context 留给下一轮。
- **实现**：`lane.ts` `pump`（`input.rejected start_failed: …`，带本批的 `replyRoute`）；`compositor.ts` `notifyRejected` / `rejectionNotice`（在路由上回"the agent could not start"，不带错误细节）。
- **测试**：`lane.test.ts` "opens the adapter the turn names, attributes events to it, and switches generations when the plan changes it #FC-2"（断言 `start_failed: no harness nope`）；`context.test.ts` "a turn that fails to start leaves the context pending for the next one #IN-1 #IN-6 #FC-2"；`e2e.test.ts` "start_failed is visible: the sender gets a notice instead of silence (no detail from the error) #FC-2 #IN-1"、"a rejection without a route (its turn's card tells the story, or the route is unknown) sends nothing #FC-2 #IN-1"。
- **状态**：有测试。

### FC-3 没有可用的交互 agent 时明确拒绝

- **承诺**：（隐含于 IN-1）找不到任何交互 agent 时，输入应被明确拒绝。
- **实现**：`gateway.ts:774` 抛普通 `Error`（不是 `LaneUnavailableError`），`ingress.ts:452-460` 原样抛出，`accept` 整个失败，不写 `input.rejected`、不回说明、explain 没有记录。
- **测试**：`it.fails` `packages/daemon/test/runs.test.ts` "no interactive agent at all (only task agents): a channel input is refused with agent_unavailable, recorded in the log and in explain; accept does not throw #FC-3 #IN-1"。
- **状态**：不成立（只有 `it.fails`）。
- **不成立**：如上。配置校验已拒绝"没有 agent 又没有默认 agent"的绑定，所以渠道输入只能经 watch trigger 走到这里（测试用的就是这条路）；agent 不能热改。本地输入在同样情况下答 `no_agent`。

### FC-4 launch 不在允许范围就拒绝

- **承诺**：agent 没有 `sessionParams` 时任何 launch 都是 `launch_not_allowed`；`cwd` / env 超出 `cwdRoots` / `envKeys` / `envPathRoots` 拒绝；`CLAUDE_CONFIG_DIR` / `CODEX_HOME` 列入 `envKeys` 必须配 `envPathRoots`（决定 7）。
- **实现**：`packages/daemon/src/launch.ts:36`；`packages/daemon/src/config.ts:497-498`、`:833`。
- **测试**：`session-launch.test.ts` "a callout launch for an agent without sessionParams goes to onFailure; session.prepare says launch_not_allowed #FC-4"；`packages/daemon/test/config.test.ts` "CLAUDE_CONFIG_DIR / CODEX_HOME in envKeys need envPathRoots #FC-4"。
- **状态**：有测试。

外发的 fail closed 见 DL-5，resolve 的退回本地见 RQ-4。

---

## 9. launch（LA）

### LA-1 launch 随会话键固定，先到者为准

- **承诺**：launch 随会话键持久化；相同的再来通过（`same`），不同的（包括无 launch 的已有会话收到 launch）一律 `launch_conflict`；被拒的 launch 走规则的 `onFailure`（默认进宿主队列）；重启后按记录重开并续接。
- **实现**：`gateway.ts:787-816`（`launchCheck`、`sessionExists`）、`:697-701`；`records.ts:135-145`（`pin` 用普通 INSERT，第二次写会抛）。
- **测试**：`session-launch.test.ts` "the same launch again passes; another one is launch_conflict and the input waits in the host queue; also with the lane live; an existing session without a launch conflicts #LA-1"、"session.prepare: idempotent with the same values, launch_conflict / agent_conflict otherwise; a log-only session conflicts, topic bookkeeping alone does not #LA-1"、"a restart reopens the session with its launch and resumes it #LA-1 #RS-1"、"agent and launch rows are written in one transaction #LA-1"。
- **状态**：有测试。

### LA-2 skipWhenPinned 只在每个键的首条输入回调

- **承诺**：开了 `skipWhenPinned` 的规则，本地能算出目标键且该键已有 launch 时不回调，explain 记 `skipped_pinned`（决定 7）。
- **实现**：`router.ts:535-538`、`:353`。
- **测试**：`router.test.ts` "skipWhenPinned: once the rule's own session is pinned the host is not asked; explain says skipped_pinned #LA-2 #EX-1"；`session-launch.test.ts` "skipWhenPinned: the host is asked for the first input of a session only; later ones route by the rule with the pinned launch #LA-2"。
- **状态**：有测试。
- **注意**：判断用的是规则自己的 agent 与会话范围（`router.ts:536`）；宿主答复改了 agent 或会话时，那个键永远不会被认作"已固定"，每条输入都会回调。

### LA-3 launch 的 cwd 与 env 就是实际运行的；同 agent 的其他会话不受影响

- **承诺**：通过检查（FC-4）的 launch，它的 `cwd` 与 env 就是 harness 实际用的：Claude Code 的每会话 env 进子进程环境；Codex stdio 有 env 时为这个会话单起一个 app-server（env 合并、`CODEX_HOME` 作为它的 home），随 lane 关闭；Codex unix 带 env 的 launch 答 `launch_unsupported`，只带 cwd 可以。同一 agent 的其他会话保持自己的 cwd 与 env；同一会话的轮次之间不重启 harness；按 plan 换实例时 launch 跟着走。
- **实现**：`packages/daemon/src/gateway.ts` 建 lane 处（`pinned?.cwd ?? …`；`harness` 与 `harnessFor` 都经 `launched.adapter`）、`launchAdapters`（按实例缓存同一个 adapter 对象，lane 按对象身份比较；Codex stdio 有 env 时单起 app-server 并由 lane 关闭时 `dispose`；unix 抛 `launch_unsupported`）、`withLaunch`；`packages/daemon/src/launch.ts` `checkLaunch`（unix 带 env 的预检）。
- **测试**：标签 `#LA-3`；例：`packages/daemon/test/session-launch.test.ts` "cwd and env reach the harness through harnessFor; another session of the agent keeps its cwd; no restart between turns; another instance chosen by plan keeps the launch #LA-3"、"stdio: a session with env gets its own app-server (env merged, CODEX_HOME as its home), disposed with the lane; cwd only shares the instance #LA-3"、"unix: a launch with env is launch_unsupported; cwd only is fine #LA-3"。
- **状态**：有测试。

---

## 10. 重启（RS）

原则 5 要求"守护进程重启或升级不丢对话、不丢正在跑的 turn（或确定地续上）"。下面如实写现状。

### RS-1 跨重启保留的状态

- **承诺**：以下状态在默认 SQLite 日志下跨重启保留。
- **实现与测试**：

| 状态 | 位置 | 测试 |
|---|---|---|
| 会话日志与快照 | `sqlite-log.ts:31-44` | `log.test.ts` "survives reopen: head, events and fold are restored #LN-1 #RS-1" |
| 原生会话 id（续接） | `gateway.ts:1360-1366`、`lane.ts:784-792` | `gateway.test.ts` "lanes open the instance the plan names (its cwd, options, id); a restart resumes per instance #RS-1"；`codex.test.ts` "resumes an existing thread #RS-1" |
| 话题表 | `packages/session/src/topics.ts:135` | `packages/session/test/topics.test.ts` "switches back, persists across reopen (same database as the log), and keeps native ids #TP-1 #RS-1"；`daemon/test/topics.test.ts` "chat commands answer with a system reply; switching back after a restart resumes the native session #RS-1 #TP-1" |
| 宿主入站队列与游标 | `host-queue.ts:76-87` | `host-queue.test.ts` "push: unacked items are redelivered after a reconnect (at least once), also across a restart #HQ-1 #RS-1" |
| launch 记录 | `records.ts:36` | `session-launch.test.ts` "a restart reopens the session with its launch and resumes it #LA-1 #RS-1" |
| outbox 结算与进行中记录 | `records.ts:35-36` | `host.test.ts` "deliver is idempotent per operationId, across a restart too; an unknown channel is an error #DL-2 #RS-1"、"a send in flight when the daemon died is settled unknown on the next start (logged in its session) and not sent again #DL-2 #RS-1" |
| 监听与 digest 缓冲 | `watch.ts:124-134` | `watch.test.ts` "buffered items and the watch survive a restart, and flush afterwards #RS-1"、"is idempotent per (watch, envelope), also across a restart #RS-1 #IN-5"；`daemon/test/watch.test.ts` "a digest buffered before a gateway restart is delivered after it; it replies to the target home route #RS-1 #CF-5" |
| 宿主表与路由解释 | `router.ts:223-247` | `router.test.ts` "persists: a restart keeps the last table, suspended until the host reconnects (unless keep) #HQ-5 #RS-1"、"are persisted: explain(inputId) works across a restart #EX-1 #RS-1" |
| 待交出的 context | `lane.ts:245`、`:725` | `context.test.ts` "context recorded but not handed before the restart goes to the next turn; handed context does not #IN-6 #RS-1" |
| 遗留卡片收尾 | compositor restore | `e2e.test.ts` "finalizes the card of a turn that was running when the previous host stopped #RS-1 #RS-5" |
| blob | `packages/session/src/blobs.ts:91-100`（文件系统） | `blobs.test.ts` "after a restart (a new store on the same directory) a reference reads back the same bytes, mime and name #RS-1" |

- **状态**：有测试。

### RS-2 Codex（unix socket）正在跑的 turn 由新进程接管

- **承诺**：停止时 Codex unix 实例的 lane detach，turn 留在日志里不结束；启动后重开会话，harness 发 `turn.adopted`，新 lane 把它当作当前 turn，排在它后面的输入继续排队；停机期间重放的审批照常处理。
- **实现**：`lane.ts:433-442`（`detach`）；`gateway.ts:1643-1655`（`adoptRunningTurns`）；`harness/codex/src/session.ts:215`、`:367-372`。
- **测试**：`unix.test.ts` "a restarted host adopts a running turn and its replayed approval #RS-2 #RQ-1"、"settles an adopted turn that finished while no host was attached #RS-2"、"keeps the adopted turn when Codex still runs it #RS-2"；`lane.test.ts` "detach leaves the running turn open in the log #RS-2"、"a new lane adopts the turn (turn.adopted), keeps it as the active turn and queues behind it #RS-2"、"an input that arrives before the harness reports its adoption waits for it instead of settling the turn as ambiguous #RS-2"；`harness/codex/test/codex.live.test.ts` "survives a host restart mid-turn over a unix socket (spawn: own) #RS-2"（需真 Codex，默认跳过）。
- **状态**：有测试。

### RS-3 Claude Code 正在跑的 turn 在重启时丢失

- **现状**：停止时 Claude Code 的 lane 被关闭，harness 打断当前 turn（`harness/claude-code/src/session.ts:307-313`），记 `interrupted`，未消费的输入被拒。turn 不续上。原生会话 id 保留，下一条输入会续接对话，但打断的那一轮的工作停在半路。
- **测试**：`packages/daemon/test/stop-inputs.test.ts` "Claude Code mid-turn at stop: the turn is interrupted, the queued input rejected (lane_closed); after a restart the next input resumes the same native session #RS-3 #IN-1 #RS-6"（假 harness 照真实 Claude Code 会话的 `close()` 先结束当前轮次）。真实 Claude Code 仍只在 E2E.md 手工清单里。
- **状态**：有测试（现状如实；与原则 5 不符的部分见下）。
- **与原则不符**：原则 5。已列入 ROADMAP §4 第 6 项（`docs/design/claude-persistence.md`）。

### RS-4 Codex（stdio）正在跑的 turn 在重启时丢失，且日志里不结束

- **现状**：停止时网关按 harness 类型挑出 Codex lane 一律 detach（`gateway.ts:1808-1816`），但 stdio 的 app-server 随守护进程退出（`harness/codex/src/harness.ts:415-427` 注释"over stdio it dies with us"）。turn 既没被接管也没被结束，留在日志里，直到 RS-5。
- **测试**：`it.fails` `packages/daemon/test/stop-inputs.test.ts` "Codex over stdio mid-turn at stop: after the next start, with no new input, the turn is settled (ambiguous host_restarted) and the snapshot no longer shows it running #RS-4 #RS-5"。
- **状态**：不成立（只有 `it.fails`）。
- **不成立**（决定 14 已复现：停止时所有 Codex lane 都 detach，`adoptRunningTurns` 只重开 unix 的）：与"确定地续上"相反，且比 Claude Code 更差：后者至少记了 `interrupted`。

### RS-5 遗留 turn 在下一条输入时记 ambiguous

- **承诺**：上一个进程留下的、没被接管的 turn，在下一轮开始前记 `turn.completed ambiguous host_restarted`。任务 run 在启动时就结算（exit 3）。
- **实现**：`lane.ts:801-833`；`packages/daemon/src/runs.ts:175-192`。
- **测试**：`runs.test.ts` "a run an earlier daemon left mid-turn is ambiguous (exit 3) after the restart #RS-5 #RN-1"。
- **测试（续）**：`lane.test.ts` "settles a turn nobody adopted as ambiguous before the next turn starts, rejecting its unconsumed inputs #IN-1 #RS-5"（结算时它没被消费的输入记 `input.rejected host_restarted`，不带路由：卡片收尾为 Outcome unknown）。
- **状态**：部分覆盖。
- **不成立**：交互 session 只在有新输入时才结算（`pump` 要求 `queue.length`），没有新输入的会话的 turn 一直开着（快照、`aio sessions` 显示运行中）。启动时不提前结算，是为了让 compositor 在 lane 打开时接管旧卡片再收尾（RS-1"遗留卡片收尾"）。测试：`it.fails` `packages/session/test/lane.test.ts` "a leftover turn nobody adopts is settled ambiguous once the lane opens, without waiting for a new input #RS-5"（修的时候要在 compositor 接管旧卡片之后再结算）。

### RS-6 排队未开始的输入在停止或重启时明确拒绝，不重放

- **承诺**：停止（含 Codex 的 detach）时排队的输入记 `input.rejected lane_closed: gateway stopping` 并在原路由上通知发送者；崩溃留下的在下次启动时记 `input.rejected host_restarted`；`snapshot.queued` 不留幽灵 id。不重放（决定 13，重放属于 claude-persistence）。
- **实现**：见 IN-1（`rejectQueue`、`settleLeftoverInputs`、`foldSnapshot`）；`gateway.ts` `stop` 调 `detach('gateway stopping')` / `close('gateway stopping')`，`start` 在接管之前调 `settleLeftoverInputs`。
- **测试**：`packages/daemon/test/stop-inputs.test.ts` 两条（见 IN-1）；`lane.test.ts` "detach rejects the inputs queued behind the running turn … #IN-1 #RS-6"、"crash leftovers: … #IN-1 #RS-6"；`e2e.test.ts` "stop with queued inputs: … #IN-1 #RS-6"。
- **状态**：有测试。
- **与原则不符**：原则 5"不丢对话"仍只做到"不静默丢"：发送者要自己重发。

### RS-7 不跨重启的状态（按设计或已知）

- **live**：不恢复（决定 11 明写）。测试：`packages/daemon/test/live.test.ts` "a live does not survive a restart: no live after it, live_say says there is none, and the log ended it #RS-7"。
- **待审批请求**：在内存里（`lane.ts:200-201`）。Claude Code 随打断记 `runtime_cancelled`；Codex unix 接管时重放（RS-2 有测试）；Codex stdio 或进程被杀时丢失，`snapshot.pendingRequests` 要等下一个 `turn.completed` 才清（`log.ts:138`），旧卡片上的按钮答 `unknown_request`。
- **入站去重、lane 的 `known`、Hub 的请求与 turn 索引**：在内存里。重启后点旧卡片上的审批或停止按钮答 `stale_turn` / `unknown_request`（`ingress.ts:280`）。
- **本轮来源摘要**：内存，最近 256 轮。
- **思维链气泡**：重启前没结束的一直转圈（CHANNELS.md §8）。
- **飞书"确认后再下载"**：确认事件之后、交给网关之前崩溃，这条消息丢失（CHANNELS.md §8）。
- **监听投递至多一次**：记"已投递"之后、写进目标 session 之前崩溃会丢；digest 相反，可能重复一次（CHANNELS.md §8；`watch.test.ts` "a flush begun before a crash is redone with the same input id"）。

### RS-8 守护进程停止时有界

- **承诺**：`stop()` 每一步都有上限（通道 3 s、lane 关闭 8 s、`whenIdle` 3 s、compositor 5 s 等），不会因为某个 harness 或通道卡住而挂住。
- **实现**：`gateway.ts:1785-1834`（`within(...)`）。
- **测试**：`gateway.test.ts` "socket is private, rejects bad frames, and tells subscribers when the gateway stops #RS-8 #SE-2"；`daemon/test/live.test.ts` "live_leave ends the live; the gateway stopping ends a running one #LN-4 #RS-8"；`packages/daemon/test/gateway.e2e.test.ts` "returns within its bounds when a harness close() and a channel close() never return #RS-8"（约 17 s，所以在 e2e 层）。
- **状态**：有测试（有界本身在 e2e 层；有界的代价是 LN-4；outbox 在关库前最多等 5 s，超出的留进行中记录，见 DL-1；超时没报完的 turn 留到下次启动按 RS-5 结算）。

### RS-9 持久化以 SQLite 日志为前提

- **现状**：宿主队列、`DaemonRecords`（outbox、launch、input.verify）、路由表都和日志共用一个 SQLite 库（`gateway.ts:266-270`）。嵌入方传入非 SQLite 的日志或 `logPath: ':memory:'` 时，它们全部在内存里，没有告警。`aio serve` 默认 `dataDir/log.sqlite`（`config.ts:736`），不受影响。
- **测试**：`it.fails` `packages/daemon/test/gateway.test.ts` "Gateway.start with a MemorySessionLog logs a "not persistent" warning #RS-9"。
- **状态**：不成立（只有 `it.fails`）。
- **不成立**：嵌入方用非 SQLite 日志时没有任何告警，宿主队列、outbox、launch 记录、路由表悄悄只在内存里。

---

## 11. 通道、配置与给模型的工具（CF）

### CF-1 bridge 首次连接失败不阻止启动

- **承诺**：bridge 通道首次 hello 失败时标 `failed` 并按退避重试，不让守护进程启动失败；命令本身无法执行（`ENOENT` / `EACCES`）仍让启动失败（决定 10）。
- **实现**：`gateway.ts:2040-2041`；`channel/jsonl-bridge/src/host.ts:222-227`。
- **测试**：`packages/daemon/test/bridge-startup.test.ts` "does not stop the daemon: status shows it failed with the reason, and it connects once the peer works #CF-1"、"a bridge whose command cannot be run still fails the start #CF-1"；`packages/daemon/test/live-channels.test.ts` "a bridge whose first connect fails is reported failed (not started) and the file not applied, until it connects #CF-1 #CF-2"。
- **状态**：有测试。

### CF-2 通道热生效只启停变化的通道

- **承诺**：`console.liveChannels: true` 时，经 `PUT /api/config` 的通道增删改只启停变化的那些；默认关闭时等重启（决定 10 原文没提这个开关，以设计文档为准）。
- **实现**：`gateway.ts:1499-1531`。
- **测试**：`live-channels.test.ts` "starts added channels, restarts changed ones, keeps unchanged ones, stops removed ones #CF-2"、"off (default): a channel added by PUT waits for a restart, as before #CF-2"、"a channel whose start rejects is reported failed, forgotten, and started again by the next apply #CF-2"、"a rotated secret in the env file counts as a change: the channel restarts with the same config document #CF-2"。
- **状态**：有测试。

### CF-3 多个飞书机器人的配置冲突在启动前报出

- **承诺**：两个兜底条目、重复应用（同 appId + domain）、重复账号、多条目时非法账号名都让守护进程启动失败，控制台写入前同样报出（决定 8）。
- **实现**：`config.ts`（多 lark 校验）。
- **测试**：`packages/daemon/test/multi-lark-config.test.ts` "${what}: validate and PUT answer 422, the file is unchanged"（参数化）、"two bots with their own references are accepted #CF-3"。
- **状态**：有测试。

### CF-4 模块 harness 配置错误使启动失败

- **承诺**：`use: 'module'` 的模块不存在、有未知键是配置错误；导出不是函数、工厂抛错、返回的不是 adapter 都使启动失败，错误里有实例名（决定 11 补记）。
- **实现**：`config.ts:1038-1039`、`:134-143`、`:997-998`；`gateway.ts:1999-2016`、`:478-480`。
- **测试**：`packages/daemon/test/module-channel.test.ts` "a missing module, a non-function export, a throwing factory and a value that is not an adapter each fail the start, naming the instance #CF-4"（模块不存在在解析配置时失败，其余三种让 `Gateway.start` 失败）。
- **状态**：有测试（决定 14 补上）。

### CF-5 监听开的轮次永远不回到被监听的会话

- **承诺**：trigger 与 digest 开的轮次回复到目标 session 的主路由，永远不回到被监听的那个会话（CHANNELS.md:275，`watch.ts:405-409` 注释）。
- **实现**：`gateway.ts:368`（`replyRoute: homeRoute(target)`）、`:1672-1675`。没有任何地方比较主路由与 `w.source`。
- **测试**：`watch.test.ts` "never delivers into the session the input already went to #CF-5"（只覆盖"输入本身已进目标 session"的情况）。
- **状态**：部分覆盖。
- **不成立**（决定 14 已复现）：群 G 的 @ 会话自己建一个监听 G 中非 @ 消息的 watch 时，目标的主路由就是 G，trigger 开的轮次会回到 G。`Policy.watch`（`policy.ts:135`）与 `add`（`watch.ts:485-486`）都不拒绝 source 与目标主路由相同。测试：`it.fails` `packages/session/test/watch.test.ts` "a watch whose source is the target session's home route is refused #CF-5"。

### CF-6 给模型的工具默认关闭，按 agent 开启

- **承诺**：给模型的工具默认关闭、按 agent 配置开启（ROADMAP §1 原则 2）。
- **实现**：`outputTools` 默认 `false`（`config.ts` `resolveConfig`，决定 13），是每个 agent `tools` 的缺省值（`resolveAgents`）；网关只在有 agent 开了 `tools` 时建 `HostTools` / MCP 服务（`gateway.ts` 构造函数），只给这些 agent 的 harness 挂（`mcp: … agent.tools`）。开启时 15 个工具全部注册（`packages/host-mcp/src/server.ts:20-131`），`live_*` 在没有任何通道能开 live 时也出现（`gateway.ts:382-399`）。
- **测试**：`packages/daemon/test/output-tools.test.ts` "off by default (decision 13): neither outputTools nor an agent turns them on, nothing is mounted #CF-6"、"agents.<name>.tools: true turns them on for that agent alone, with outputTools unset #CF-6"、"outputTools: false mounts nothing #CF-6"；`packages/daemon/test/topics.test.ts` "agents without the session_* tools get no topic hint #CF-6"（agent 的 `tools: false` 优先于顶层 `outputTools: true`）；`host-mcp.test.ts` "are listed over MCP only when the host provides watches #CF-6"；`packages/host-mcp/test/topic-tools.test.ts` "are listed over MCP only when the host provides topics #CF-6"。
- **状态**：有测试（按 agent 开关）。逐个工具的开关仍不存在：一个 agent 要么 15 个全有、要么全无，逐个工具的取舍留给 ROADMAP §4 第 11 项（工具负担复查）。测试：`it.fails` `packages/daemon/test/output-tools.test.ts` "enabling only send_message for an agent lists only that tool over MCP #CF-6"（按设想的 `agents.<name>.tools: ['send_message']` 写；今天配置只收布尔值）。
- **行为变化**：2026-10-11 之前缺省开启；没写 `outputTools` / `tools` 的部署升级后不再有输出工具（CHANNELS §输出工具）。

### CF-7 谁能建、改、删监听

- **承诺**：主人可以监听任何来源；agent 只能监听 `policy.watchAllowlist` 里的来源；其他人（陌生人）不能。agent 经输出工具建的监听总是投进调用它的会话（不能指定别的目标），`createdBy` 记它的 agent 身份；监听只能由创建者、或 `Policy.watch` 允许创建它的非 agent 删除或替换，agent 不能删、不能覆盖别人的监听。
- **实现**：`packages/session/src/policy.ts` `watch`（主人放行，agent 按 `watchAllowlist` 逐字段匹配）；`packages/session/src/watch.ts` `add`（`createdBy: creatorOf(by)`，已有同 id 时先 `mayRemove`）、`remove`、`mayRemove`；`packages/host-mcp/src/tools.ts` `watchTool`（目标固定为调用会话，`watch_remove` 只删 `createdBy` 等于自己的）。
- **测试**：标签 `#CF-7`；例：`packages/session/test/policy.test.ts` "owners may watch anything; agents only allowlisted sources; others never #CF-7"；`packages/session/test/watch.test.ts` "removing: the creator, or someone policy lets create it, never another agent; an agent cannot replace a watch it does not own #CF-7"；`packages/host-mcp/test/host-mcp.test.ts` "adds a watch pinned to the caller session, created by its agent identity #CF-7 #DL-4b"、"forbids a target argument #CF-7"、"removes only watches the agent created #CF-7"。
- **状态**：有测试。决定 14 之前这几条测试有四份重复（session watch、host-mcp、daemon watch 各一份），删掉了三份，留 policy 的一份（复查 §3.3）。

### CF-8 飞书适配器声明的平台需求与代码一致

- **承诺**：`channel/lark-bot/src/requirements.ts` 列出的事件与回调覆盖适配器实际注册的每一个（部署方照这份清单开通应用就能跑，create-lark-bot 也照它申请）；适配器注册了清单外的处理器即为错误。
- **实现**：`channel/lark-bot/src/requirements.ts` `APP_EVENTS`、`APP_CALLBACKS`、`REGISTERABLE_HANDLERS`；`channel/lark-bot/src/adapter.ts` 里的 `dispatcher.register`。
- **测试**：标签 `#CF-8`；`channel/lark-bot/test/requirements.test.ts` "lists every handler the adapter registers #CF-8"、"source scan: every key passed to dispatcher.register is declared #CF-8"。
- **状态**：部分覆盖（权限 scope 一栏只是文档，没有测试能核对代码调用的 API 与 `TENANT_SCOPES` 一致）。

---

## 12. 协议与一致性（PR、CN、HC）

别人写的宿主、通道与 harness 适配器依赖这几条；仓库里的适配器都要过同一套检查。

### PR-1 线上的每种值都有 schema，守护进程实际发出的值通过它

- **承诺**：每个线上帧（通道、harness、客户端、宿主）、会话事件、宿主请求的结果值、admin 端点的请求与答复都有 TypeBox schema；守护进程实际发出的值通过对应的 schema；admin 端点各列一次。
- **实现**：`packages/protocol/src/events.ts` `SessionEvent`；`packages/protocol/src/wire.ts` `ChannelHostFrame` / `ChannelAdapterFrame` / `HarnessHostFrame` / `HarnessAdapterFrame`；`packages/protocol/src/client.ts` `ClientFrame` / `ServerFrame`；`packages/protocol/src/host.ts` `HostRequestFrame` / `HostEventFrame` / `HOST_RESULT_VALUES`；`packages/protocol/src/admin.ts` `ADMIN_ENDPOINTS`；`packages/protocol/src/validate.ts` `check` / `errors`。收到的帧在入口校验（`packages/daemon/src/local-server.ts` 的 `check(HostRequestFrame, …)`、`channel/jsonl-bridge/src/host.ts` 的 `check(ChannelAdapterFrame, …)`）。
- **测试**：标签 `#PR-1`；例：`packages/protocol/test/protocol.test.ts` "validates session events #PR-1"、"validates a binding table and host frames #PR-1"；`packages/protocol/test/admin-topics.test.ts` "a result-value schema for every host request #PR-1"、"lists every endpoint once, with schemas #PR-1"；`packages/daemon/test/host-results.test.ts` "match the protocol schemas #PR-1"；`packages/daemon/test/console.test.ts` "match the protocol schemas and the daemon state #PR-1"；`packages/daemon/test/frames.test.ts` "server frames validate #PR-1"。
- **状态**：有测试。
- **注意**：守护进程运行时不校验自己发出的值，"发出的值通过 schema"只由上面的测试守着；新增结果字段或端点时要同时改 schema 与这些测试。

### PR-2 帧解码有界，坏行不打断连接；对端不读时不无限缓冲

- **承诺**：JSONL 解码逐行，超长行（默认 32 Mi 字符）丢弃并报告一次、从下一个换行继续；不是 JSON、类型未知、不合 schema 的帧丢弃并记日志，不让连接或进程崩溃；跨块的多字节字符不被拆坏；对端停止读取、写缓冲超过上限（默认 16 MiB）时拒绝再写，不无限缓冲。
- **实现**：`packages/protocol/src/wire.ts` `FrameDecoder`（`push`、`tooLong`、一个流式 `TextDecoder`）；`channel/jsonl-bridge/src/link.ts` `FrameLink`（`setEncoding('utf8')`、`congested`、`send`）；`channel/jsonl-bridge/src/host.ts` 收帧处（未知类型 debug、不合 schema warn 后丢弃，inbound 不合 schema 答 `invalid_frame`）；本地 socket 与 `/ws` 的订阅推送在写不进时等 drain（`packages/daemon/src/local-server.ts` `pump`、`packages/daemon/src/console.ts` `WS_HIGH_WATER`）。
- **测试**：标签 `#PR-2`；例：`packages/protocol/test/protocol.test.ts` "drops an oversized line, reports it once, and resumes at the next newline #PR-2"、"keeps lines at the limit and checks a complete long line too #PR-2"、"keeps multi-byte characters split across chunks #PR-2"；`channel/jsonl-bridge/test/bridge.test.ts` "drops malformed, unknown and invalid frames without crashing #PR-2"、"refuses to buffer without limit when the peer stops reading #PR-2"。
- **状态**：有测试（本地 socket 与 `/ws` 的 drain 等待没有单独的测试）。

### CN-1 每个仓库内通道适配器通过 `runChannelConformance`

- **承诺**：仓库里的每个通道适配器（jsonl-bridge、lark-bot、mail，以及测试用的 `FakeChannel`）都通过 `runChannelConformance`：caps 合 schema、`start` 不抛、inbound 信封合 schema 且通道 id / 账号 / 证据在声明范围内、按 operationId 幂等等；检查器自身能抓住违规。
- **实现**：`packages/testkit/src/channel-conformance.ts` `runChannelConformance`（驱动缺某个钩子时对应检查记为 `(skipped)`）；`packages/testkit/src/fakes.ts` `FakeChannel`。
- **测试**：标签 `#CN-1`；例：`channel/jsonl-bridge/test/bridge.test.ts` "passes channel conformance #CN-1"；`channel/lark-bot/test/conformance.test.ts` "passes runChannelConformance against a fake platform #CN-1"；`channel/mail/test/mail.test.ts` "passes runChannelConformance with fakes #CN-1"；`packages/testkit/test/testkit.test.ts` "FakeChannel passes #CN-1"。
- **状态**：部分覆盖（"检查器能抓住违规"没有测试：没有一个故意违规的通道被断言为失败；对照 `runHarnessEnvConformance` 有 "fails an adapter that puts the value on argv"）。

### HC-1 每个 harness 适配器的事件流通过 `checkEventStream`；不认识的版本明确拒绝

- **承诺**：每个 harness 适配器发出的事件流通过 `checkEventStream`：每个事件合 `HarnessEvent` schema；turn 只开始一次、只结束一次、互不重叠（`turn.adopted` 只许接管开着的那个）；`input.consumed` 只点名交给本轮的输入；完成的 turn 里开始的 item 都结束、打开的请求都结算；易失事件只限 delta、进度、headline、snapshot、native。`probe` 遇到没写过的主版本明确拒绝（Codex 可显式放开）。
- **实现**：`packages/testkit/src/event-stream.ts` `checkEventStream` / `assertConformingStream`；`harness/claude-code/src/adapter.ts` `assertSupported`（`SUPPORTED_SDK`、`SUPPORTED_CLI`）；`harness/codex/src/version.ts` `assertSupportedVersion`（`SUPPORTED_CODEX_LINES`、`allowUnknownVersion`）。
- **测试**：标签 `#HC-1`；例：`packages/testkit/test/testkit.test.ts` "flags overlap, unknown inputs and unfinished items #HC-1"、"accepts turn.adopted for the open turn (a log spanning a host restart), not for another one #HC-1"；`harness/claude-code/test/claude-code.test.ts` "maps a full turn and conforms #HC-1"、"refuses unknown major versions #HC-1"；`harness/codex/test/codex.test.ts` "maps a full turn to a conforming stream #HC-1 #ID-2"、"refuses unknown versions clearly, unless allowed #HC-1"。
- **状态**：有测试。
- **注意**：模块 harness（`use: 'module'`）不在仓库里，核心不检查它的事件流（另见 CF-4）。

### HC-2 每会话 env 只进子进程环境

- **承诺**：`open` 带的每会话 env 只进 harness 子进程的环境，不出现在 argv（含 SDK 转成命令行的选项）和发出的事件里；做不到的适配器（一个 app-server 服务所有会话的 Codex）明确拒绝非空的每会话 env。
- **实现**：`packages/testkit/src/harness-conformance.ts` `runHarnessEnvConformance`（`env.in_child_env`、`env.not_in_argv`、`env.not_in_events`）；`harness/claude-code/src/adapter.ts` `childEnv`、`open`（`args.env` 在最上层）；`harness/codex/src/harness.ts` `open`（非空 `args.env` 抛错）。
- **测试**：标签 `#HC-2`；例：`packages/testkit/test/testkit.test.ts` "passes an adapter that keeps env to the child environment #HC-2"、"fails an adapter that puts the value on argv #HC-2"；`harness/claude-code/test/claude-code.test.ts` "never reaches argv-bound options or events (conformance) #HC-2 #SE-1"；`harness/codex/test/codex.test.ts` "rejects a per-session env (one shared app-server), accepts an empty one #HC-2"。
- **状态**：有测试。

---

## 13. 机密与本地边界（SE）

### SE-1 机密不回显

- **承诺**：机密（配置里 `env:` 引用的值、通道凭据、launch env 的值、宿主 MCP token、任务运行的 env）不出现在错误信息、守护进程日志、explain、会话事件、`aio sessions`、控制台 `GET` 和任何子进程命令行里；只出现变量名或键名。
- **实现**：`packages/daemon/src/config.ts` `substituteEnv`、`ChildSecrets` 与 `claudeMcpViaEnv` / `claudeSettingsViaEnv` / `codexConfigViaEnv`（值进子进程 env，配置里只留 `${NAME}` 或 env-var 间接设置）、`noEnvRefs`；`packages/daemon/src/console-config.ts` `isCredential` / `redact` / `unredact`（`GET` 换成 `ADMIN_REDACTED`，`PUT` 拒绝凭据字段的字面值）；`packages/daemon/src/launch.ts` `launchView`（只给键）及其在 explain、日志里的使用；`harness/claude-code/src/adapter.ts` `open`（宿主 MCP token 走 `AGENTS_IO_MCP_TOKEN` 环境变量，`mcpServers` 里只写 `Bearer ${AGENTS_IO_MCP_TOKEN}`）；`harness/codex/src/harness.ts` `launchFlags` / `secretAt`（像机密的 `-c` 设置直接拒绝）。
- **测试**：标签 `#SE-1`；例：`packages/daemon/test/config.test.ts` "env:NAME secrets never reach a child command line" 组（"claude mcpServers: the value goes to the child env, the server config says ${NAME}" 等 5 条）、"named instances: clear errors that never echo values #SE-1"、"rejects unknown keys and bad values without echoing values #SE-1"、"errors name entries and variables, never values #CF-3 #SE-1"；`packages/daemon/test/console.test.ts` "GET never shows secret values: literals are redacted, env: references listed as set / unset #SE-1"、"GET of a real-world config (mail pass, env maps, headers, codex config, bridge args, lark config) shows no secret string anywhere #SE-1"、"PUT refuses literals in credential fields whatever their name, keeps stored values for the marker, and honours the marker only on credential fields #SE-1"；`packages/daemon/test/session-launch.test.ts` "env values never show in the event log, explain, sessions, the daemon log or the harness argv; keys do #SE-1"；`packages/daemon/test/runs.test.ts` "env goes into the run child only: the instance built for the run has it; the log, explain records and other instances do not #SE-1 #EX-3"；`harness/claude-code/test/claude-code.test.ts` "host MCP token is passed through the env, never in mcpServers (the SDK puts those on the CLI argv) #SE-1"；`harness/codex/test/unix.test.ts` "refuses secrets in -c values (argv is readable by other local users); env-var indirection is fine #SE-1"。
- **状态**：有测试。
- **路径型 launch 变量**（`envPathRoots` 管的，如 `CLAUDE_CONFIG_DIR`、`CODEX_HOME`）被拒时，`launch.ts` `underRoots` 的原因只说为什么（"must be absolute"、"does not exist"、"is outside the allowed roots"），不带值；`checkLaunch` 的 `bad_env` 只写键名（`launch.ts:56-58`）。`cwd` 不是 env，`bad_cwd` 仍带路径。测试：`packages/daemon/test/session-launch.test.ts` "a refused path-valued env names the key, never the value"（原 `it.fails`，已修）。
- **注意**：launch env 的值要跨重启续接，所以明文存在本地 SQLite（`records.ts`，0600，见 SE-2）。

### SE-2 本地文件与 socket 只有本人可读

- **承诺**：本地 socket、token 文件、会话日志库（含 `-wal` / `-shm`）、blob、控制台 URL 文件、provision 产物是 0600，所在目录 0700；socket 目录、token 文件或其目录、Codex unix socket 别人可达时拒绝使用；已有的 0755 数据目录只告警（文件仍是 0600）；`.env.live` 只从本人拥有、别人不可写的位置发现。
- **实现**：`packages/daemon/src/private.ts` `privateDir` / `privateFile` / `privateDb`（`gateway.ts` 打开日志库与 provision 目录时调用）；`packages/daemon/src/local-server.ts`（socket 目录 0700、socket 0600，目录别人可达即抛错）；`packages/daemon/src/token.ts`（token 与控制台 URL 文件）；`packages/session/src/blobs.ts`；`harness/codex/src/unix.ts`（状态目录 0700，socket 别人可达即抛错）；`packages/daemon/src/config.ts` `findEnvFile`。
- **测试**：标签 `#SE-2`；例：`packages/daemon/test/local-server.test.ts` "creates a missing socket directory 0700 and the socket 0600 #SE-2"、"does not chmod an existing directory it did not create; refuses one other users can reach #SE-2"、"the SQLite session log (and its -wal/-shm) is 0600 even in an existing 0755 directory; existing files are tightened #SE-2"；`packages/session/test/blobs.test.ts` "writes files 0600 under 0700 directories #SE-2"；`packages/daemon/test/console.test.ts` "aio serve writes the console URL next to the token file (0600) and removes it at stop #SE-2"；`harness/codex/test/unix.test.ts` "speaks JSON-RPC as WebSocket frames over the socket and refuses sockets others can reach #SE-2"；`packages/daemon/test/config.test.ts` `.env.live discovery` 组（"skips a .env.live in a world-writable ancestor (e.g. /tmp): another user could have planted it #SE-2" 等 4 条）；token 文件本身见 HQ-7。
- **状态**：有测试。

### SE-3 控制台与宿主 MCP 端点只给本机、要凭据

- **承诺**：控制台默认只听回环，非回环地址要 `console.allowRemote`（通配地址还要 `allowedHosts`）；核对 `Host`（防 DNS rebinding）与 `Origin`（只给配置的来源 CORS）；每个请求与 `/ws` 升级都要宿主 token、一次性登录换来的会话（cookie HttpOnly、SameSite=Strict、按守护进程区分名字、只在登录时的 Host 下有效）或 bearer 子协议。宿主 MCP 端点只许绑回环地址，每个请求要每次绑定签发的 bearer token。CLI 用错 token 以 77 退出。
- **实现**：`packages/daemon/src/console.ts` `ConsoleAuth`（`loginToken` 5 分钟一次性、`check` 用 `timingSafeEqual`）、`ConsoleServer` `hostOk` / `originKind` 与 `/ws` 升级处；`packages/daemon/src/config.ts` `console.allowRemote` / `allowedHosts` 的校验；`packages/host-mcp/src/server.ts` `listen`（非回环抛错）与 bearer 校验（401）；`packages/daemon/src/cli.ts` `exitCodeFor`。
- **测试**：标签 `#SE-3`；例：`packages/daemon/test/console.test.ts` "needs a token: missing / wrong → 401; the host token works #SE-3"、"login link → one-time token → session (cookie HttpOnly SameSite=Strict, and a bearer token); single use; sessions cannot make links #SE-3"、"expired one-time tokens and sessions are refused #SE-3"、"listens on 127.0.0.1 by default; a non-loopback host needs allowRemote #SE-3"、"refuses foreign Host headers (DNS rebinding) and Origins; CORS only for configured origins #SE-3"、"refuses the upgrade without a valid token, from a foreign origin, or on another path #SE-3"、"the cookie name is per daemon; a session works only through the Host it logged in with #SE-3"、"a wildcard bind with allowRemote needs console.allowedHosts, and accepts those Host values #SE-3"；`packages/host-mcp/test/host-mcp.test.ts` "listens on loopback only #SE-3"、"rejects requests without a valid token #SE-3"；`packages/daemon/test/cli.test.ts` "a wrong token is refused (exit 77) #SE-3"。
- **状态**：有测试。
- **注意**：登录 token 与控制台会话在内存里，重启后失效（按设计）。

### SE-4 受限轮次里输出工具读文件不越出 cwd

- **承诺**：不是 `bypass` 的轮次里，`send_file` 只能发会话 cwd 之内的文件；按 realpath 判断，符号链接与 `..` 都不能越出。
- **实现**：`packages/host-mcp/src/tools.ts` `sendFile`（先 `realpath` 文件与 cwd，再 `inside`；`bypass` 轮次不限）；嵌入方可经 `HostToolsOptions.fileAccess` 换掉默认判断。
- **测试**：标签 `#SE-4`；例：`packages/host-mcp/test/host-mcp.test.ts` "send_file refuses missing files, both/neither args, outside cwd in a restricted turn, and channels without media #SE-4"、"send_file in a restricted turn: symlinks and .. cannot escape the working directory #SE-4"。
- **状态**：有测试。

---

## 14. 控制、观察、路由表、任务运行、话题与媒体（CT、OB、RT、RN、TP、MD）

### CT-1 打断、清队列、话题命令只有主人和本轮发起者能用

- **承诺**：打断当前轮次（按钮、`interrupt` 命令、interrupt 模式的输入）只有主人和本轮发起者（turn owner）能做；清队列是单独的操作，非主人只清掉自己排的输入；话题命令（`/new`、`/topics`、`/switch`、`topic.switch` 帧）默认只有主人能用。都经 `Policy.control` 判断；宿主连接（token 认证）总是允许。
- **实现**：`packages/session/src/policy.ts` `control`（主人，或 principal 等于 `turn.owner`）；`packages/session/src/lane.ts` `interrupt`（先查 `interrupt`，再按 `cancel_queue` 决定清全部还是只清自己的）与 interrupt 模式输入的检查；`packages/session/src/ingress.ts` `topicCommand`（按 `reset` 检查）；`packages/daemon/src/gateway.ts` `topicSwitch`、构造函数里的 `control`（宿主 origin 直接允许）。
- **测试**：标签 `#CT-1`；例：`packages/session/test/lane.test.ts` "refuses interrupts from someone who is neither turn owner nor owner #CT-1"、"interrupt with cancelQueue is authorised as cancel_queue: a turn owner who is not an owner cancels only their own queued inputs #CT-1"；`packages/session/test/policy.test.ts` "control: owners and turn owners may interrupt #CT-1"；`packages/session/test/topics.test.ts` "Policy.control decides who may use them (owner by default) #CT-1"。
- **状态**：有测试。

### OB-1 "卡住了"可观察

- **承诺**：有未答的人工请求时，lane 状态与进度视图报 `requires_action`，不是 `running`；没有文字就结束的轮次（失败、打断……）在 `final` 层级也说明它怎么结束的，不留空白。
- **实现**：`packages/session/src/lane.ts` `setState`（等待审批时 `requires_action`）；`packages/session/src/compositor.ts` `progressOf`（`pending` 非空即 `requires_action`）、`renderTurn`（没有文字时写结束状态）。
- **测试**：标签 `#OB-1`；例：`packages/session/test/progress.test.ts` "reports requires_action while a human request is open, and bounds steps and text #OB-1"；`packages/session/test/e2e.test.ts` "final tier: a turn that ends without text still says how it ended #OB-1"。
- **状态**：有测试。

### RT-1 Binding 表语义

- **承诺**：规则按字段匹配（通道、账号、会话、会话类型、发送者、标签与主体、提及、关键词、`actionPrefix`、回流只在 `includeSelf`）；所有命中的规则都生效（fan-out），同一个目标 session 取最强的动作，平局时先到者胜（配置表先于宿主表先于 watch）；`host` 与 `drop` 与 session 投递互不影响；非法的表整张拒收，当前表不变。
- **实现**：`packages/session/src/router.ts` `matches`、`route`（`STRENGTH` 比较、`host ??=`）、`rules`（顺序）、`validate`、`setConfigTable` / `putHostTable`（先校验再替换）。
- **测试**：标签 `#RT-1`；例：`packages/session/test/router.test.ts` `binding match fields` 组（"channel, account, conversation, conversationKind, senders #RT-1" 等 6 条）、"fans out to every matching rule; per session the strongest action wins #RT-1 #EX-1"、"on a tie the earlier rule wins (config before host before watches) #RT-1"、"host and drop are independent of the session deliveries #RT-1"、"rejects tables that target task agents or unknown agents, and other invalid tables #RT-1"。
- **状态**：有测试。

### RN-1 任务运行的结局

- **承诺**：`run.start` 在新的 `run:<id>` session 里跑一轮任务 agent；退出码含义固定：0 完成、1 失败、3 ambiguous（含上一个进程留下的）、124 超时、130 取消；发起的连接离开后运行继续，`run.ended` 交给宿主；守护进程停止时运行被打断，告知仍连着的发起者；`aio run` 阻塞到 `run.ended` 并以它的退出码退出。
- **实现**：`packages/daemon/src/runs.ts` `exitCodeOf`、`end`（发给仍连着的发起者，否则发给宿主）、`peerGone`、`stop`（`daemon_stopping`）、启动时结算遗留（RS-5）；`packages/daemon/src/cli.ts` `aio run` 与 `exitCodeFor`。
- **测试**：标签 `#RN-1`；例：`packages/daemon/test/runs.test.ts` `run.start` 组："runs one turn of a task agent in a fresh session run:<id> with its run config and the given cwd; run.ended exit 0; the session is closed #RN-1"、"exit codes: a failing turn is 1, a cancel is 130, a timeout 124 #RN-1"、"agent instructions reach the harness; observe routes render the run on a channel; run.ended goes to the host when the asking connection left #RN-1"、"a run an earlier daemon left mid-turn is ambiguous (exit 3) after the restart #RS-5 #RN-1"、"daemon stop interrupts running runs and tells their connections #RN-1"；`packages/daemon/test/cli.test.ts` "maps errors to exit codes #RN-1"、"aio run blocks until run.ended, prints the answer, streams progress to stderr, exits with the run exit code #RN-1"。
- **状态**：有测试。
- **注意**：`run.ended` 不进宿主入站队列：结束时既没有发起者也没有宿主连着，这一帧就没人收到，只能从会话日志（`turn.completed`）和守护进程日志查。

### TP-1 话题切换不丢上下文、不来回转

- **承诺**：切回一个停放的话题时用它原来的原生会话续接，跨重启也一样（话题表记 native id）；停放话题的 lane 空闲关闭后切回时按 native id 重开；`session_rotate` / `session_switch` 交接的消息只移动一次，刚被交接过来的不会再被交走（no ping-pong），同一轮只交接一次；只能切到同一对话、同一 agent 的话题。
- **实现**：`packages/session/src/topics.ts` `TopicRegistry`（`setNativeId`，与日志同库）；`packages/daemon/src/gateway.ts` `session.bound` 时 `topics.setNativeId`、`handOver`、`switchTopicFor`（`target.conversation !== from.conversation || target.agent !== from.agent` 即拒）、`closeLane` 的停放空闲关闭、`topicSwitch`；`packages/host-mcp/src/tools.ts` `handover`（`handedFrom` 检查、每轮一次）。
- **测试**：标签 `#TP-1`；例：`packages/session/test/topics.test.ts` "switches back, persists across reopen (same database as the log), and keeps native ids #TP-1 #RS-1"；`packages/host-mcp/test/topic-tools.test.ts` "a message just handed over by a rotate or switch is not moved again (no ping-pong) #TP-1"、"session_switch resumes another topic of the same conversation only #TP-1"；`packages/daemon/test/topics.test.ts` "parked topics' lanes close after topics.parkedIdleMs and resume by native id when switched back #TP-1"。
- **状态**：有测试。

### MD-1 图片与文件作为内容块到达 harness；超限的明确拒绝

- **承诺**：入站的图片与文件以内容块交给 harness：Claude Code 收到 base64 图片块和文件路径，Codex 收到 `localImage` / `localAudio` 与文件路径行；超出内联上限（Claude 3.75 MB）、类型不支持或解析失败的图片被跳过并以 notice 事件说明，不让整轮失败。
- **实现**：`packages/daemon/src/media.ts` `blobResolvers`（`CLAUDE_IMAGE_MAX_BYTES`）；`packages/daemon/src/gateway.ts` 建 Claude Code / Codex 实例处挂上 resolver；`harness/claude-code/src/content.ts`（每种块的转换，跳过时记 `notices`）；`harness/codex/src/map.ts`（`resolveMedia`，解析不到写 "not available"）。
- **测试**：标签 `#MD-1`；例：`packages/daemon/test/media.test.ts` "Claude receives a real image block and a file path; Codex a localImage with the stored bytes #MD-1"、"refuses images over the inline limit with a reason instead of failing the turn #MD-1"；`harness/claude-code/test/claude-code.test.ts` "converts every content block kind #MD-1"、"skipped images surface as a notice event #MD-1"。
- **状态**：有测试（Codex 没有大小上限，交给 Codex 自己处理）。

---

## 15. 缺口

按风险从高到低。"不成立"指读代码确认、与文档承诺相反；"未测"指承诺可能成立但没有测试守着。

1. ~~**通道可以冒充别的通道与主人（ID-3）。**~~ 已修（channel-stamping，决定 13）：信封的 `channel/account`/回复路由按发出它的通道实例核对，不符拒收；一个通道 id 只属于一种适配器；证据按条目授予 ∩ caps 封顶。见 ID-3。
2. ~~**排队中的输入在停止或重启时静默丢失（IN-1 / RS-6）。**~~ 已修（决定 13）：停止时拒掉并在原路由通知，崩溃遗留在启动时拒掉，遗留 turn 结算时拒掉它的输入，开轮失败在通道上可见。剩下 IN-1 不成立第 1–5 条（策略钩子抛错、live 委托溢出、被接管输入、开轮途中 detach、关闭后到达）。
3. **`aio explain` 不能从副作用反查（EX-2，不成立）。** 只接受 inputId，返回路由记录；系统回复、宿主 `deliver`、`live_say` 连手工串的线索都没有。原则 4 与决定 4 都以它为"不拦截"的配套。
4. **重启丢 turn（RS-3 / RS-4，不成立于原则 5）。** Claude Code 的 turn 被打断；Codex stdio 的 turn 既不接管也不结束，挂到下一条输入才记 ambiguous（RS-5），没有新输入就一直显示运行中。三者都没有测试。
5. ~~outbox 结算前崩溃会重复发送；停止时投递可能既不结算也不记录（DL-1、DL-2）。~~ 已修（决定 13）：发送前写进行中记录，重启后结算为 `unknown` 不重发；`stop()` 有界等待 outbox；单次尝试有超时。
6. **多机器人退回仍会发生（DL-4，不成立）。** 机器人 b 停掉或启动失败后，`channelFor` 只看到 a，发给 b 的 `deliver` / `systemReply` / `live_join` 改写成 a 发出。决定 8 的本意是"不以别的机器人发出"。
7. ~~**宿主 `lease` 未实现（HQ-5，不成立）。**~~ 已删（决定 13）：只拉取的宿主用 `onHostDown: "keep"` + 定期重推刷新 `expiresAt`，HOSTS §4、§6 写明。
8. ~~**宿主 outbound 在宿主离线时退回本地策略（DL-5，不成立于"fail closed"）；`live_join` 目标不过 outbound 检查。**~~ 已修（2026-10-11）：离线期间只放行本轮回复路由；`live_join` 过 `Policy.outbound`。
9. **并发 `live_join` 停掉已有 live 并泄漏端点（LN-3，不成立）。** 需要在 `gateway.ts:1168` 检查后同步占位。
10. **入站去重只在内存，部分失败重试会重复进会话（IN-5，不成立）。**
11. **没有可用交互 agent 时 `accept` 直接抛错（FC-3，不成立）**。（harness 起不来时只在日志里拒绝的 FC-2 已修。）
12. **`closeLane` 窗口出现同一键两个 lane（LN-2）**；**监听回复会回到被监听的群（CF-5）**：决定 14 已用 `it.fails` 复现，未修。
13. ~~**未测的承诺**：live 传输拒绝与视频过滤（LN-5）、模块 harness 启动失败（CF-4）、Claude Code 停止时的行为（RS-3）、非 SQLite 持久化（RS-9）、模型输入里的 watch 标记（ID-2）。~~ 决定 14 都补了测试：LN-5、CF-4、RS-3、ID-2 的 watch 标记成立；RS-9 不成立（`it.fails`）。
14. **文档本身的出入**：~~决定 12 说 `onBehalfOf` "须显式开启"而它没有开关（RQ-3）~~ 已加 `policy.answerOnBehalf`（决定 13）；~~工具默认开启与原则 2 相反（CF-6）~~ 已改为默认关闭（决定 13）；`docs/E2E.md` 的"已知缺口"仍写 outbox 在内存、compositor 不接管旧卡片、没有宿主 MCP 工具，三条都已过时。
15. **A 组合并评审（2026-10-11）遗留**，按原则 4 记下，未修：
    - **启动时为每个会话折叠全量日志**（`settleLeftoverInputs` 调 `hub.snapshot`）：没有压缩时随日志线性增长；等日志压缩一起做。
    - **崩溃后同一输入两种结局（IN-1）**：digest flush 的 `input.admitted` 落盘后、`endFlush` 前崩溃，重启时 `settleLeftoverInputs` 拒掉该 id，watch 的 redo 又以同一 id 收下并消费（`watch.ts:450`、`:671`）。决定 14 已复现（`it.fails`，见 IN-1 不成立第 6 条）。
    - **同进程兄弟机器人的回流认不出 self（DL-4b）**：lark-bot 的 `declared` 只来自本适配器实例的发送记录，兄弟机器人各有一份，所以兄弟的消息回来不带 `declared`，仍要靠 `selfAccounts`。agent-messaging 提案的出站索引解决它。
    - **热更新时启动失败的模块通道**按 `type` 记为已配置（模块 id 加载后才知道），同 id 的另一账号仍可能被退回使用（DL-4）。bridge 写了 `id` 时已按 id 记。
    - 已修：bridge 类通道收不到停止提示（停止时先拒入站、最后才中止通道）；拒绝提示不再带 `as`；`startChannel` 同步 emit 读到未赋值的 `entry`；邮件 `config.account` 覆盖条目账号；停止期间完成的 `live_join` 未关闭。
16. **决定 14 新编号读代码时发现的（2026-10-11）**，未修：
    - **停止期间的入站被确认后丢失（IN-7，不成立）**：停止时 `Gateway.accept` 答 `accepted: false`（`gateway stopping`）而不抛错，飞书照常 ack 并保留去重键、邮件照常前移 checkpoint，消息不再交给下一个进程。
    - ~~**路径型 launch 变量被拒时错误带原值（SE-1，不成立，轻微）**~~：已修，`bad_env` 只写键名。
    - **未测**：`runChannelConformance` 抓违规（CN-1）、`emit` 返回 `accepted: false` 时的确认（IN-7）。
