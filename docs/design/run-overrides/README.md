# 任务运行：覆盖项生效、`run.ended` 带用量、宿主给的输入 id 与关联 id

> 状态：已实现并合入 main（2026-10-19）；同日复审后修正：每次运行的结局都写进日志、`run.ended` 由日志构建（§2.2），守护进程停止的运行记 `run_stopping`，preset 不改变运行的缺省 cwd（§2.1）。三项各有一个能力名（`run.overrides`、`run.ended.usage`、`run.correlation`），宿主按 `host.hello` 结果的 `features` 判断；不带新字段的请求行为不变。
> 依据：`docs/HOSTS.md` §4（`run.start` / `run.ended`）；`docs/POSITIONING.md` §2（模型选择是宿主的策略，agents-io 只提供机制）；`packages/protocol/src/run.ts`（agents-io 不解释模型名）；`docs/design/agent-messaging/`（cause 链与 `explain --chain`）。不变量 RN-2、RN-3、EX-7。

## 1. 问题

改动前（`c76e542`）任务运行有三处"协议里写了、守护进程没做"：

1. **`run.start.overrides` 被静默忽略。** `RunStart.overrides { model, effort, profile }` 在协议里，HOSTS §4 也说它"只覆盖本次运行的 agent 默认值"；但 `Runs.start` 不把它传给 `openRunLane`，运行配置只取自 agent。宿主照文档传了，什么也不发生，也不报错。按任务选模型、选力度的宿主只能每个模型配一个 task agent：模型一多配置就翻倍，加一个就要改配置、重启守护进程。
2. **`run.ended` 的 `durationMs`、`usage` 只有声明，从不填。** 只想知道"跑了多久、用了多少"的宿主不得不订阅整个 `run:<id>` 会话。`status` 里的 `timeout` 也只在协议里：超时实际报 `interrupted` 加 `error.code: "timeout"`；同一 runId 重发 `run.start` 时从日志重建的结局又只剩 `interrupted`（退出码 130，与第一次的 124 不一致）。开轮前就被取消的运行，重发时甚至答 `ambiguous`。
3. **宿主认不出自己的输入。** run 的输入 id 由守护进程生成，没有路由记录（`aio explain <id>` 答 `unknown_input`）。宿主要把这次运行、它产生的 cause 链对回自己的记录，只能靠会话键推断。

## 2. 选择

### 2.1 覆盖项（`run.overrides`）

- RunSpec 的算法（`Gateway.runSpec`）：
  1. 基础：agent 的实例、模型、力度（与交互会话相同的 `agentRun`）；
  2. `overrides.preset`：换成那个 preset 的实例、模型、力度。与聊天里的 `/preset` 相同，preset 整体替换，不与 agent 自己的模型合并。运行仍以这个 agent 的身份进行（cwd、指令文件），与换了 preset 的交互会话一致；
  3. `overrides.model` / `effort` 盖在上面，原样传给 harness；
  4. `profile = overrides.profile ?? agent.profile ?? "restricted"`。
- 校验，失败整个请求答 `bad_override`（不建会话、不起 harness）：
  - 每个值是一个普通记号（1–256 字，不含空白和控制字符）；
  - preset 必须已配置；
  - 带 `profile` 或 `preset` 时，最终的 profile 必须是**这次运行所在实例**的 `profiles` 里有的，或内置的（`bypass`、`restricted`）。preset 把运行挪到另一个实例时，agent 自己的 profile 在那里没有定义，同样拒绝。harness 对不认识的 profile 名会退回缺省设置，可能悄悄丢掉 `disallowedTools` 一类限制，所以这里拒绝，不退回。
  - 不带 `profile` / `preset` 时不校验 profile，行为与改动前相同。
- 模型名不校验：`HarnessCaps.models` 是可选的，网关与第三方模型也不在其中。harness 起不来或模型不存在时，这一轮照常以 `failed` 结束。
- 运行的缺省 cwd 是 agent 自己的：`agent.cwd ?? agent 所在实例的 cwd ?? 顶层 cwd`。preset 把运行挪到别的实例，缺省 cwd 也不变：与换了 preset 的交互会话一致（它的 cwd 在建 lane 时按 agent 自己的实例定下）。否则没有写 `agent.cwd` 的 agent，换个 preset 就会落进另一个实例的工作目录。
- `run.start` 的答复带 `run`（实际用的 RunSpec），日志里的 `turn.started.run` 与 harness 打开会话时收到的是同一个值。同一 runId 在运行中重发，答第一次的 spec：runId 是幂等键，第一次请求的输入、覆盖项、关联 id 有效。
- 权限：`overrides.profile` 可以把一次运行升到 `bypass`，`overrides.preset` 可以把它挪到任何一个已配置的实例（连同那个实例的凭据与配置目录）。宿主本来就能给运行指定任意 cwd 和子进程环境变量，这两项没有超出它已有的权力。不另设开关（RN-2 注意）。替别人发起运行的宿主（例如把工作委派给 task agent）要自己把关：按自己的规则限定可选的 preset、模型与 profile，不把 `bypass` 或权限更大的实例上的 preset 交给委派出去的工作，并总是给出 `cwd`。
- 命令行：`aio run --preset <名> --model <m> --effort <e> --profile <p>`。

### 2.2 `run.ended` 带上这一次运行的事实（`run.ended.usage`）

| 字段 | 取值 |
|---|---|
| `inputId` | 这次运行的输入 |
| `turnId` | 这次运行的轮次；没开轮（开轮失败、开轮前被取消）就没有 |
| `durationMs` | 从这次运行日志里的第一条记录（输入被接纳）到记下结局的那一条（`turn.completed`，或开轮前的 `input.rejected` / `input.cancelled`） |
| `usage` | 这一轮 `turn.completed.usage` 原样转出；harness 没报就没有 |
| `correlation` | 宿主在 `run.start` 给的（§2.3） |

- **每次运行的结局都在日志里，`run.ended` 由日志构建。** 运行结束（看到结局、被取消、超时、守护进程停止、开轮失败）时，先关 lane：关 lane 会关 harness 会话，harness 在这时把还没结束的一轮记下来（打断成功记 `interrupted`，等不到就记 `ambiguous`）。关完日志里仍没有结局的（harness 没报，或 lane 没留记录就拒了输入），守护进程补记一条：开了轮的记 `turn.completed`，没开轮的记 `input.rejected`（开轮失败）或 `input.cancelled`（其余）。然后从日志构建 `run.ended`（`Runs.read` + `frame`）。重答（`run.start` 答 `state: "ended"`，`Runs.outcome`）走同一个函数，所以与第一次发出的帧相同，重启之后也一样。复审前第一帧取自内存：守护进程停止、`lane.command` 直接失败这两条路径上它与重答不同（重启后甚至变成 `ambiguous`）。
- 读日志的规则：`input.admitted` 给 `inputId` 与 `correlation`（日志里有完整的 `InputRecord`）；lane 没接纳就拒掉的输入只有 `input.rejected`，`inputId` 取它的第一个 id，`correlation` 取这个输入的路由记录（§2.3），路由记录过期（7 天）后重答不再带它。`turn.started` 给 `turnId`。结局是这一轮的第一条 `turn.completed`，或开轮前的第一条 `input.rejected`（读作 `failed`、`start_failed`）/ `input.cancelled`（读作 `interrupted`、`cancelled`）。`turn.completed` 给 `usage`；结局那一条的时间减去第一条记录的时间是 `durationMs`。
- `durationMs` 取日志里的两个时间戳，而不是 `run.start` 受理与发出 `run.ended` 的时刻：两者只差建 lane 的几毫秒，以及关闭 lane（最多数秒）这段不算运行本身的时间。只有守护进程补记的结局在关 lane 之后，那时 harness 已经没有回音，这段时间算进去。
- 打断的原因记在日志里，以最先的一条为准，只改以 `interrupted` 结束的结局（被打断的轮，开轮前被取消的输入）：
  - 超时：计时器到期时先记 `notice { code: "run_timeout" }`（`level: detail`、只给运维看），再打断。结局为 `status: "timeout"`，退出码 124；`error.code` 仍是 `timeout`，只看错误码的宿主不受影响。
  - 守护进程停止：先记 `notice { code: "run_stopping" }`，再打断、关 lane。结局为 `interrupted`、`error.code: "daemon_stopping"`（退出码 130）。harness 没能按打断结束这一轮、关会话时记成 `ambiguous`（`harness_closed`）的，答 `ambiguous`：这一轮做到哪一步不知道，宿主不该自动重试。
  - 到期或停止时这一轮已经自己完成或失败的，按它自己的结局。
- 开轮前被取消的运行答 `interrupted`，不再答 `ambiguous`。
- 上一个进程留下、没有结局的运行，结束时刻不知道，没有 `durationMs`：开了轮的在启动时结算为 `ambiguous`（`host_restarted`），`turnId` 照常给出；接纳了输入、还没开轮就停了的，重答 `ambiguous`（`host_restarted`），带日志里的 `inputId` 与 `correlation`。守护进程在发出第一帧之前就被杀掉的，宿主没有第一帧可比，重启后按这一条答。

### 2.3 宿主给的输入 id 与关联 id（`run.correlation`）

- `RunStart.inputId?`：这次运行的输入 id，原样使用，这次运行产生的 cause 链以它为 chain id。格式：1–256 个字母、数字、`.`、`_`、`:`、`-`，以字母或数字开头；不能是守护进程自用的 `ctxo_…`。派生 id 用到的字符（`@`、`>`、`~`、`/`）一律不收，否则答 `bad_input_id`。
- 唯一性：路由记录（`explain`）与 cause 索引都以输入 id 为键，所以这个 id 在部署里必须唯一。已经有路由记录的 id 答 `input_id_taken`（同一 runId 重发不算，那是它自己的记录）。查重与写记录都在第一个 `await` 之前，并发的两个同 id 请求只有一个成功。只能查到路由记录还在（7 天）的 id；宿主应在自己的命名空间里取 id。
- `RunStart.correlation?`：不透明字符串，1–256 字，不含控制字符（否则 `bad_correlation`）。记在 `InputRecord.correlation` 上：这是守护进程盖的字段，客户端与适配器都设不了。它进日志（`input.admitted.input`）和宿主回调的 `ctx.inputs`；**不进 `channelContext`**，因为 `channelContext` 会进 harness 给模型的来源行，两个 harness 都只取固定的来源字段，不会把它给模型看。`run.ended` 带回。
- 路由记录：run 的输入现在像渠道输入一样有一条，`matched` 是 `{ bindingId: "host:run", source: "host", on: "dispatch", agent, sessionKey: "run:<runId>" }`（与 `inbound.redispatch` 的 `host:redispatch` 同一种写法），另有 `run: { runId, correlation? }`；开轮失败时这一条带 `rejected: { code: "start_failed" }`。`explain --chain` 走到这样的根时，根那一级同样带 `run`。
- `run.start` 的答复带 `inputId`，没给 id 的宿主也能拿到守护进程生成的那个。
- 命令行：`aio run --input-id <id> --correlation <id>`。

## 3. 协议 / Schema 影响

都是新增的可选字段，或已声明字段第一次被填上：

- `RunStart`：`overrides.preset`、`inputId`、`correlation`。
- `RunStartResult`：`inputId`、`run`（RunSpec）。
- `RunEnded`：`durationMs`、`usage` 开始填；新增 `turnId`、`inputId`、`correlation`；`status: "timeout"` 开始使用。
- `InputRecord.correlation`；`RouteExplanation.run`、`ChainLink.run`（`RunOfInput`）。
- `notice.code` 多了 `run_timeout`、`run_stopping`。对严格校验事件的宿主，这是两个新的枚举值。
- 新错误码：`bad_override`、`bad_input_id`、`bad_correlation`、`input_id_taken`。`aio run` 遇到它们按用法错误退出（2）。
- `features`：`run.overrides`、`run.ended.usage`、`run.correlation`。旧守护进程会接受这些字段然后忽略（`RunStart` 不是封闭对象），所以宿主必须先看 `features`。
- `packages/protocol/schema/*.json` 已重新生成；这次也补上了此前漏生成的 `RunSpec.mode`。

## 4. 测试

- `packages/daemon/test/runs.test.ts`：
  - `run.start overrides` 组（RN-2）：model / effort / profile / preset 生效，答复、harness 与日志三处一致；不带覆盖项的运行和 agent 配置不变；不能生效的值（未知 profile、未知 preset、带空白的模型、空的力度、preset 挪走后 agent 的 profile 不存在）答 `bad_override`，且什么都没起。
  - `run.ended` 组（RN-3）：完成的运行带 `turnId`、`inputId`、`usage`、`durationMs`；失败的运行没有 `usage`；超时为 `timeout`，日志里有 `run_timeout`；重发与重启后重发的答复与第一次相同；上一个进程留下的运行没有 `durationMs`。
  - `run.ended: every end is in the log` 组（RN-3、RN-1）：守护进程停止时运行答 `interrupted` / `daemon_stopping`，日志里有 `run_stopping`，harness 不按打断结束的那一轮答 `ambiguous` / `harness_closed`，两者重启后重答都与第一帧相同；手写日志测开轮前取消（`interrupted`）、开轮前超时（`timeout`）、接纳后没开轮就停了（`ambiguous`，带 `inputId` 与 `correlation`，没有 `durationMs`）三条重答；用桩 lane 测守护进程补记的结局：关 lane 后仍开着的轮（补记 `turn.completed`），lane 不留记录就拒掉的输入（补记 `input.rejected`，`correlation` 取自路由记录），`run.ended` 都与 `outcome` 相同。
  - `run.start overrides: cwd`（RN-2）：没写 `agent.cwd` 的 agent 换 preset 运行，缺省 cwd 是它自己实例的，不是 preset 实例的。
  - `run.start inputId and correlation` 组（EX-7）：宿主的 id 与关联 id 进记录、不进 `channelContext`，由 `run.ended` 带回；`explain` 与 `explain --chain` 都显示 `run`；各种不合法的 id 与关联 id 被拒；已被占用的 id（包括渠道输入的）答 `input_id_taken`。
  - 原有的超时用例改为期待 `status: "timeout"`（RN-1）。
- `harness/claude-code`、`harness/codex`："a task run's correlation id never reaches the model"（EX-7）。
- `packages/daemon/test/host-results.test.ts`（PR-1）：带新字段的 `run.start` 答复、`run.ended`、run 输入的 `explain` 与 `explain --chain` 都通过 schema。
- `packages/daemon/test/cli.local.test.ts`：`aio run` 的新参数。
- `packages/testkit` 的 `FakeTurnApi.usage(report)`：假 harness 的 `turn.completed` 带上用量。

## 5. 没有做

- `agent_run`（agent 自己发起任务运行）还没有。到时同一套字段照用：`correlation` 放发起的那一轮；`contact` 钩子（`op: run`）的答复除了 `allow` / `deny`，最好还能带这一次运行的 `overrides` 与 `timeoutMs`，宿主就能在 agent 自己派活时照样执行选模型与预算的规则。
- 按 agent 限定宿主可选的模型、profile（类似 `sessionParams`）：等有部署需要时再加。
- `run.ended` 仍然不进宿主入站队列：结束时既没有发起者也没有宿主连着，这一帧就没人收到；宿主回来后用同一 runId 重发 `run.start` 取结局（RN-1 注意）。
