# 宿主接口复查：按原则 7 划分控制面与环境面

> 状态：复查稿（2026-10-10），待 owner 拍板。

依据：`docs/ROADMAP.md` §1 第 6、7 条，`docs/design/locus/DECISIONS.md` 决定 1–12（尤其决定 12 的"宿主的两个面"），`docs/HOSTS.md`，`docs/POSITIONING.md`。范围：宿主能碰到的全部接口，即 `packages/protocol/src/host.ts` 的帧和字段、宿主连接可用的客户端帧、`aio` 的宿主命令、来源标记，以及控制台 admin API（`packages/protocol/src/admin.ts`，粗看）。本文只给结论和理由，不改代码，也不改其他文档。

## 0. 结论先说

- 现有宿主协议**大体都在控制面**。除了两处，每一项都对得上一个"需要通道、需要人或需要投递"的场景，没有哪一项是宿主借 agents-io 做业务。原则 7 要收窄的主要不是协议本身，而是**用法**：brief、任务细节、凭据内容这类东西不该塞进 `run.start.input`、launch env 或宿主发的 `input` 帧，而应放进工作区，由 agent 自己读，或者用 `x` 命令自己取。
- **该删的有两处**：
  1. `host.hello.lease`：只写进了协议和 HOSTS.md，守护进程**根本没实现**。宿主带上它会被静默忽略，宿主表照样按 `host_down` 挂起。
  2. 任务运行的 `AGENTS_IO_TURN_PROVENANCE`：值是常量，宿主自己发起的运行本来就知道这些。
- **最大的缺口在环境面那一侧**：决定 4 承诺"宿主写命令附带来源标记"。按原则 7，交互 agent 是在工作区里直接调 `x` 写的，这条调用根本不经过 agents-io，所以交互 session 现在**没有任何来源可附**。建议的替代：在给模型的发送者说明行里加上渠道引用（`ref=channel:<渠道>/<消息 id>`），agent 调 `x` 时把它当参数带上，x-work-os 再用 `input.verify` 自己去核验。这样来源是宿主能独立验证的事实，不是 agent 自己报的标记。
- `resolve` / `outbound` 两个同步钩子虽然是控制面，但 HOSTS §6 的 x-work-os 用法里一个都没用到，而且 `outbound` 在宿主离线时会放开限制。建议冻结，不再扩展。要不要改成随表推送的静态数据，列入待拍板。

## 1. 判断方法

对每个接口问三个问题：

1. **哪个面**：它是在告诉 agents-io 怎么做 IO（身份、路由、launch、入站队列、审批、出站、任务运行），还是在给 agent 的世界里放东西（brief、任务状态、凭据、宿主命令）？
2. **原则 7 的检验**：这件事需要碰通道、碰人，或者需要投递吗？加一条反向检验：**没有 agent 在跑的时候，它还需要存在吗？**入站队列、身份映射、投递在没有 agent 时照样要工作，这类就是真 IO。
3. **有没有具体场景**：HOSTS §6 的 x-work-os 用法、决定里写过的驱动场景（多租户宿主、宿主离线、半开连接），或者没有场景。

结论分四种：**保留**、**收窄**（保留机制，限制用法或字段）、**移到工作区**（agent 在工作区里自己做）、**删除**。

## 2. 逐项复查

### 2.1 连接、认证与在线

| 接口 | 做什么 | 面 | 结论 | 理由 |
|---|---|---|---|---|
| `host.hello { token, name }` | 宿主连接认证、命名 | 控制 | 保留 | 所有宿主帧的前提 |
| token 文件（`<socket>.token`、`--token-file` / `host.tokenFile`） | 跨重启不变的宿主令牌 | 控制 | 保留 | 决定 10：宿主和守护进程不在同一台机器时，重启后仍要能认证。约 22 行代码引用、91 行测试 |
| `host.hello.consumer`（推送消费） | 守护进程把入站队列推给宿主 | 控制 | 保留 | 决定 1：没有 agent 在跑时人的消息也得送到宿主 |
| `host.hello.callouts` + `features` | 声明回答哪些钩子；按能力名协商 | 控制 | 保留 | 体量小；按能力名协商避免宿主依赖旧守护进程没有的能力 |
| "至多一个宿主"、`host_connected` | 回调与推送只有一个接收方 | 控制 | 保留 | 回调答复必须唯一 |
| `takeover: true` | 顶替半开的旧宿主连接 | 控制 | 保留 | 决定 10：宿主断线重连而旧连接还半开。host.ts 约 20 行 |
| 控制台 `/ws` 心跳 | 及时清掉半开的远程连接 | 控制 | 保留 | 与 takeover 配套，属于传输层的维护 |
| **`host.hello.lease { ttlMs }`** | 只拉取的宿主声明自己在线 | 控制 | **删除** | **没有实现**：`packages/daemon/src/host.ts` 的 `hello()` 不读 `f.lease`，结果里也从不带 `lease`；只有 protocol 里的 schema、`admin-topics.test.ts` 的 3 行 schema 测试和 HOSTS.md §4 的一句话。它要解决的问题已经有现成解法：`onHostDown: "keep"` 加上宿主定期重推表、刷新 `expiresAt`（见 2.2）。删掉的东西：protocol 约 12 行、schema 里的一段、3 行测试、HOSTS.md 一句话。不会影响任何运行行为 |

关于 `lease` 还要补一句：HOSTS §6 和决定 1 写的是"x-work-os 第一版用 `aio tail` 拉取"。`aio tail` 走的是 `inbound.read`，不会让连接成为宿主，所以宿主表在 `onHostDown` 缺省为 `suspend` 时会一直挂着（`aio bindings put` 已经打印提示）。x-work-os 第一版要么用 `onHostDown: "keep"` 加 `expiresAt`，要么让接收程序改成推送消费。不论最后选哪种，HOSTS §6 都应写明。

### 2.2 Binding 表与身份

| 接口 | 做什么 | 面 | 结论 | 理由 |
|---|---|---|---|---|
| `bindings.put` / `bindings.get`、Binding 表 | 宿主推整张路由表 | 控制 | 保留 | 决定 2 的主路径，"哪条消息唤醒谁"本身就是 IO |
| `onHostDown: keep \| suspend` | 宿主离线时表还生不生效 | 控制 | 保留 | 宿主离线后表就不再可信，要能挂起。router.ts 2 行 |
| `expiresAt` | 表到点挂起 | 控制 | 保留，并作为租约的正式做法 | 只拉取的宿主靠它防"宿主死了、表还在路由"。删掉 `lease` 后它就是唯一的租约机制：宿主每隔 T 重推一次表，`expiresAt = now + 2T` |
| 身份映射 `identities`（principal、labels、evidence） | 渠道身份对应到宿主成员 | 控制 | 保留 | 决定 3。宿主离线时路由仍要靠 labels 匹配，这件事只能由 agents-io 在收消息时完成 |
| `match.actionPrefix` | 按钮点击按前缀路由 | 控制 | 保留 | 见 2.6 |
| `on: "host"` | 输入进宿主入站队列 | 控制 | 保留 | 决定 1 |

### 2.3 回调钩子（`policy` 帧）

| 接口 | 做什么 | 面 | 结论 | 理由 |
|---|---|---|---|---|
| `route` 回调（`callout { timeoutMs, onFailure }`） | 个别规则同步问宿主怎么路由 | 控制 | 保留 | 两个场景：需要语义判断的路由；多租户宿主为每个键的首条消息选工作区（决定 7）。HOSTS §6 的 x-work-os 用法没用到它，但两个场景都要碰通道（消息到了、要立刻定去向） |
| `callout.skipWhenPinned` | 键已固定 launch 后不再回调 | 控制 | 保留 | 5 处代码引用，是 `route` 回调"每个键只开户一次"的必要配套 |
| `resolve` 回调 | 宿主决定某个审批/提问由谁答 | 控制 | **收窄（冻结）** | 审批属于控制面（"碰人"）。但目前没有具体用户：HOSTS §6 没用；x-work-os 的执行器"运行中不推消息"，不会产生请求。它能表达的东西，大多可以写成静态数据，比如"agent X 的请求交给成员 Y，经路由 Z"。超时或出错时退回本地策略，也就是放开。建议：不删，不再扩展；要不要改成随表推送的静态 resolver 规则，见待拍板 2 |
| `outbound` 回调 | 宿主决定 agent 能不能往某处发 | 控制 | **收窄（冻结）** | 出站检查属于控制面。但它有两个毛病：一是每次发送都要同步往返一次宿主；二是宿主离线时退回本地策略，宿主加的限制就失效了（HOSTS §4.1 写明了这一点）。没有具体用户。随表推送的静态出站白名单在离线时也能生效，更符合决定 2"稳态走本地匹配"的思路。见待拍板 2 |

resolve 和 outbound 两个钩子的代码量：守护进程 host.ts 约 40 行、gateway.ts 约 25 行、protocol 约 35 行，测试 `host-callouts.test.ts` 132 行。量不大，所以现在不建议删，只建议冻结。

### 2.4 宿主入站队列与补投

| 接口 | 做什么 | 面 | 结论 | 理由 |
|---|---|---|---|---|
| `inbound` 推送 / `inbound.read` / `inbound.ack` | 至少一次的持久队列 | 控制 | 保留 | 决定 1，是最典型的"没有 agent 在跑也要工作" |
| `inbound.redispatch` | 把队列里的一条输入按原 origin 投进某个会话 | 控制 | 保留，不再扩展 | 反向检验：宿主自己发 `input` 帧也能把内容送进会话，但 origin 会变成 `system/host`，发送者、证据、回复路由都丢了，agent 回复不到那个人，来源标记也错了（决定 5 要求来源可见）。保住原发送者和回复路由只能由 agents-io 做，所以这是 IO。场景：宿主离线或回调超时、走 `onFailure: host` 进了队列的消息，事后补投，不用请人重发（决定 9）。代码量不小：gateway.ts 约 90 行、ingress.ts 约 60、router.ts 约 40、host-queue.ts 约 35、CLI 约 30、protocol 约 50，测试 158 行，合计源码约 300 行。但它的语义（至多一次、中断可查）已经测过；删掉的话唯一的退路就是请人重发 |

### 2.5 会话启动参数（决定 7）

| 接口 | 做什么 | 面 | 结论 | 理由 |
|---|---|---|---|---|
| 回调答复里的 `launch { cwd, env }` | 为新会话键定工作目录与环境 | 控制（原则 7 明文："agents-io 只在启动时设 cwd/env"） | 保留，**收窄用法** | 这正是控制面通向环境面的那一个口。要收窄的是 env 里放什么：只放**指针**（`CLAUDE_CONFIG_DIR`、`CODEX_HOME`、凭据文件路径、`GIT_AUTHOR_NAME` 一类），不放 brief、任务内容或凭据本身。决定 7 已经要求可轮换的凭据放在配置目录里；本文把这个要求推广到所有业务数据 |
| `session.prepare` | 不经路由打开的会话预先登记 agent 与 launch | 控制 | 保留 | 场景：宿主发的 `input`、`aio attach`、watch 打开的键，以及成员入驻时预建。第一条输入到来之前，没有别的办法给这些键定 launch |
| agent 的 `sessionParams`（`cwdRoots`、`envKeys`、`envPathRoots`） | 部署方给宿主划定可选的范围 | 控制（部署配置） | 保留 | 缺省拒绝，是上面两项的安全边界 |

旁注（不属于本次删改，但和"launch cwd/env"有关）：`run.start` 的 `cwd` 只检查是不是存在的绝对目录（`runs.ts:103`），`env` 不限键。交互会话的 launch 却要受 `sessionParams` 约束。两边不对称，列入待拍板 4。

### 2.6 任务运行与投递

| 接口 | 做什么 | 面 | 结论 | 理由 |
|---|---|---|---|---|
| `run.start { runId, agent, cwd, input, env, timeoutMs }` | 用 task agent 跑一轮无头运行 | 控制（原则 7 列为"任务运行"） | 保留，**收窄用法** | 反向检验：x-work-os 自己执行 `claude -p` 也能跑起来，那 agents-io 多提供了什么？统一的 harness 抽象、session 日志（原则 1）、`observe` 把过程渲染到 IM（属于投递）、取消、超时、`ambiguous` 判定，以及路线图 §2 第 4 项 `agent_run` 要复用它。所以保留。要收窄的是 `input`：它应当只是一句指令（"执行 `x task show <id>` 里的任务"），brief 和任务细节由 x-work-os 写进 `cwd` 下的文件或交给 `x` 命令去取，不要拼进 `input` |
| `run.start.overrides { model, effort, profile }` | 只对这次运行覆盖默认值 | 控制 | 保留 | POSITIONING §5：模型选择是宿主策略（`plan`），这是宿主能表达它的唯一入口。4 处代码引用 |
| `run.start.observe.routes` | 把运行过程渲染到这些路由 | 控制（投递） | 保留 | 原则 1：让人看到 agent 的真实状态 |
| `run.cancel` / `run.ended`（含 `usage`、`durationMs`） | 取消；结束通知 | 控制 | 保留 | `run.ended` 会发给已断开的发起方或宿主，保证宿主不在线也不丢结果 |
| `deliver { operationId, route, message }` | 把消息推给人，幂等 | 控制（投递） | 保留 | 这就是 IO 的定义；x-work-os 的 to-human 适配器 |
| 按钮回流（`actionPrefix`） | 卡片按钮点击按前缀进宿主队列 | 控制 | 保留 | 人点了按钮，没有 agent 在跑也得送到宿主。实现只有 5 处代码引用 |

### 2.7 核验、来源与代答

| 接口 | 做什么 | 面 | 结论 | 理由 |
|---|---|---|---|---|
| `input.verify { channelRef }` / `aio verify` | 查某条渠道消息的平台作者与证据 | 控制（只读的 IO 事实） | 保留，**并补全入口** | 场景：0005 F 的讨论会话里，agent 调 `x` 确认决定，x-work-os 要独立核验"确认的人是谁"，不能信 agent 的转述（0010 §4.8）。宿主队列里的条目本身已带证据，用不着核验；只有消息进的是 agent 会话、而不是宿主队列时，才需要这一步。**缺口**：给模型的发送者说明行（CHANNELS §1）没有消息 id 或渠道引用，agent 拿不到 `channelRef`，也就没法交给 `x`。见建议 3 |
| `resolve { onBehalfOf }` | 宿主代被问的人作答 | 控制（碰人） | 保留 | 请求挂在 agents-io 的 lane 里，阻塞着 harness；人在宿主的界面（x-work-os inbox）里答，必须经 agents-io 交回去。lane.ts 约 15 行。决定 12 的"代为审批"会复用同一形状 |
| 输出工具记录上的 `provenance`（`agents-io.output`） | 每次经 agents-io 发出的消息带本轮来源 | 控制（投递记录） | 保留 | 这些写入走的就是 agents-io，来源标在自己的日志里，`aio explain` 可查 |
| `onToolCall` 的 `provenance`（进程内钩子） | 嵌入式使用时把来源交给宿主代码 | 控制 | 保留 | 只对进程内嵌入有用，远程宿主收不到。HOSTS §4 把它写成宿主写命令的来源，容易误导，应改写 |
| **`AGENTS_IO_TURN_PROVENANCE`**（任务运行的环境变量） | 把来源写进 harness 子进程环境 | 环境 | **删除** | 值是常量：`triggeredBy: ["host:<名>"]`，其余全是 `false`（`gateway.ts:1013`）。发起运行的宿主早就知道这些，没有信息量；交互会话又根本没有这个变量。删掉的东西：gateway 1 行、测试 1 行、HOSTS/CHANNELS/harness-env 三处文字。`AGENTS_IO_RUN_ID` 保留，它让工作区里的 `x` 能把调用对到某次运行 |

**决定 4 的承诺在原则 7 下要换一种兑现方式。**决定 4 说"每个写请求附带本轮输入的来源标记"，当时默认宿主写命令可能经 agents-io 发出。按原则 7，`x` 命令属于环境面，agent 在工作区里直接调，agents-io 看不见这次调用，没法往上附东西。可选的兑现方式有三种：

- (a) **可验证的引用**（推荐）：发送者说明行加 `ref=channel:<渠道>/<消息 id>`；x-work-os 要求敏感命令（确认、作答）带上这个引用，自己调 `input.verify` 核验作者与证据。来源成了宿主可以独立验证的事实，agent 伪造不了。agents-io 这边的改动只是说明行多一个字段。
- (b) **会话级查询**：交互会话启动时设 `AGENTS_IO_SESSION_KEY`，新增只读帧 `turn.provenance { sessionKey }`，由 `x` 去查当前轮的来源。问题：Codex `unix` 共享实例不能按会话设 env；同一会话的轮次并发或交替时，"当前轮"有歧义；而且又加了一个协议面。
- (c) 什么都不做，承认交互 session 的宿主写命令没有来源标记，只靠 `aio explain` 事后从 IM 侧追查。

### 2.8 宿主连接可用的客户端帧

| 接口 | 做什么 | 面 | 结论 | 理由 |
|---|---|---|---|---|
| `subscribe` | 宿主订阅会话日志 | 控制（观察） | 保留 | 原则 1 的投影之一 |
| `input`（origin `system/host`） | 宿主往会话里投一条输入 | 控制（投递给 agent） | 保留，**收窄用法** | 合理用法是唤醒或通知（"任务 T 指派给你了"），因为要把消息投给一个在跑或该醒来的 agent。不合理的用法是推 brief、任务全文、成员资料。这些属于环境面，应写进工作区，或者让 agent 用 `x` 去取。代码不用改，HOSTS §4 加一条用法说明 |
| `resolve`、`control`（interrupt / cancel） | 宿主作答、打断 | 控制 | 保留 | 碰人或控制 lane |

### 2.9 命令行（HOSTS §5）

`aio run` / `send` / `tail` / `ack` / `redispatch` / `bindings` / `explain` / `verify` 都只是对应帧的薄包装（`cli.ts` 共 626 行，宿主命令约占一半），结论跟着各自的帧走，全部**保留**。唯一的改动跟着 2.7 走：如果采纳 (a)，`aio verify` 就是 x-work-os 在工作区里核验来源的入口，HOSTS §6 应把它写进"讨论会话"那一行。

### 2.10 控制台 admin API（粗看）

`/api/login`、`/api/status`、`/api/config`（读、写、校验，通道热生效）、`/api/explain/:inputId`、`/api/queue`、`/api/sessions`、`/api/bots/lark`（开通飞书机器人）。这些都是运维看的 IO 状态和部署配置，没有宿主业务。`/api/bots/lark` 是开通通道账号，属于 IO。结论：**保留**，不在本次复查范围内细拆。只提一点：`AdminHostState` 有 `leaseExpiresAt` 字段，注释也写着"or a lease is live"（admin.ts:74–80），和 `host.hello.lease` 一样没有实现，删 `lease` 时一起删。

## 3. 对照 HOSTS §6 的 x-work-os 用法

| x-work-os 的位置 | 用的接口 | 面 | 复查意见 |
|---|---|---|---|
| start-executor（0003） | `aio run`，`--cwd <workdir> --env XWO_CREDENTIAL_FILE=…` | 控制 | 正确：env 传的是凭据文件路径（指针）。brief 应放进 workdir，`--` 后面的指令保持简短 |
| to-human（0003 / 0006） | `aio send`，按钮 id 以 `xwo:` 开头 | 控制 | 正确 |
| 接收程序（0008）与经渠道回答（0010） | `aio tail --consumer xwo` 加 `aio ack`，每条记录转成 `x input add` / `x answer` | 控制 | 正确。但要配合 `onHostDown: "keep"` 加 `expiresAt` 刷新，否则表一直挂起（2.1） |
| 身份 | 随 `bindings.put` 推身份映射 | 控制 | 正确 |
| 讨论会话（0005 F） | `dispatch` 规则加 agent 在工作区里调 `x`，`input.verify` 核验确认人 | 环境 + 控制 | 方向符合原则 7。但"附来源标记"这一步现在落空了，agent 也拿不到 `channelRef`（2.7）。这是本次复查最需要补的地方 |

x-work-os 目前没有用到的：`route` / `resolve` / `outbound` 回调、`session.prepare`、launch、`inbound.redispatch`、`onBehalfOf`、`takeover`。其中 launch 与 `session.prepare` 服务的是多租户宿主（决定 7 的驱动场景），`takeover` 与心跳服务远程宿主，`redispatch` 服务回调失败后的补投。前三者服务的是"通用宿主"，不是 x-work-os；这不违反"不为 x-work-os 特化"，但它们都还没有一个真实的使用方。

## 4. 代码量（候选项）

按 `grep` 粗估，只算源码；测试另计。

| 候选 | 结论 | 涉及源码 | 测试 | 文档 |
|---|---|---|---|---|
| `host.hello.lease` | 删除 | protocol 约 12 行 + `AdminHostState.leaseExpiresAt` 3 行 + schema 一段（守护进程 0 行） | 3 行 | HOSTS §4 一句 |
| `AGENTS_IO_TURN_PROVENANCE` | 删除 | gateway 2 行（保留 `AGENTS_IO_RUN_ID`） | 1 行 | HOSTS §4.1、CHANNELS §1a、harness-env 各一处 |
| `resolve` / `outbound` 回调 | 冻结；待拍板是否改为静态数据 | 约 100 行（host.ts 40、gateway 25、protocol 35） | 132 行 | HOSTS §4.1、host-callouts |
| `inbound.redispatch` | 保留，不扩展 | 约 300 行 | 158 行 | HOSTS §2.1、inbound-redispatch |
| 发送者说明行加 `ref=` | 新增（建议 3） | 估计 10–20 行（lane/harness 适配器的说明行） | 每个 harness 1 条断言 | CHANNELS §1、HOSTS §6 |

## 5. 建议

按优先级排序：

1. **删除 `host.hello.lease`**：删 protocol 字段、`HostHelloResult.lease`、`AdminHostState.leaseExpiresAt`、schema 和 3 行测试；HOSTS §4 改成"只拉取的宿主用 `onHostDown: "keep"`，并定期重推表刷新 `expiresAt`"。理由：协议承诺了守护进程没有的行为，宿主会以为自己在线，实际表一直挂起。
2. **HOSTS §6 写明 x-work-os 第一版的表用 `onHostDown: "keep"` 加 `expiresAt` 刷新**（或者让接收程序改成推送消费），否则 `aio tail` 方案下宿主表一直不生效。
3. **在给模型的发送者说明行里加 `ref=channel:<渠道>/<消息 id>`**（Claude 与 Codex 两种头都加），并在 HOSTS §4.1 / §6 把"宿主写命令的来源"改写为：agent 调 `x` 时带上触发它的消息引用，宿主用 `input.verify` / `aio verify` 自己核验。这是原则 7 下兑现决定 4 的方式（2.7 的 (a)）。
4. **删除 `AGENTS_IO_TURN_PROVENANCE`**，保留 `AGENTS_IO_RUN_ID`；同步改 HOSTS §4.1、CHANNELS §1a、harness-env 的引用。HOSTS §4.1 里 `onCall` 的说明改成"仅进程内嵌入可用"。
5. **在 HOSTS 加一节"控制面与环境面的用法"**，写四条约束：
   - `run.start.input` 只放一句指令；brief 与任务细节放进 `cwd` 或交给 `x`；
   - launch / `run.start` 的 env 只放指针（配置目录、凭据文件路径），不放凭据内容和业务数据；
   - 宿主的 `input` 帧只用于唤醒和通知，不推 brief；
   - agent 对宿主的写操作走工作区里的 `x` 命令，不经 agents-io。
6. **冻结 `resolve` / `outbound` 回调**：不加新的钩子种类，不扩展参数；决定 12 的"代为审批"走 Resolver 新种类加 `onBehalfOf` 的形状，不走同步钩子。
7. `inbound.redispatch`、`session.prepare`、launch、`skipWhenPinned`、`takeover`、心跳、token 文件**维持现状**，不再加字段。哪一项出现第二个真实使用方之前，不再为它做新的设计稿。

## 6. 待拍板

1. **决定 4 在原则 7 下的兑现方式**：选 (a) 可验证的引用（推荐）、(b) 会话级 `turn.provenance` 查询，还是 (c) 不兑现、承认缺口？选 (a) 意味着修订决定 4 的措辞：从"每个写请求附带来源标记"改为"每个写请求可以带上触发它的渠道引用，由宿主核验"。
2. **`resolve` / `outbound` 回调是否改成随表推送的静态数据**：例如 `bindings.put` 增加 `resolvers` 规则（按 agent / labels 指定 Resolver）和 `outbound` 白名单（按 agent 列出允许的路由），离线时照样生效，再删掉两个同步钩子（约 100 行源码、132 行测试）。代价：失去逐条动态判断；已经依赖这两个钩子的宿主（目前没有）需要迁移。也可以维持现状，只冻结。
3. **`outbound` 在宿主离线时的方向**：现在离线时放开（回到本地策略）。如果不按第 2 项改成静态数据，是否至少加一个"宿主离线时一律拒绝"的选项（host-callouts §8 已列为后续工作）？
4. **`run.start` 的 `cwd` / `env` 是否也受部署配置约束**：比如给 task agent 也加 `cwdRoots` / `envKeys`，与交互会话的 `sessionParams` 对齐。现在宿主可以让任务运行跑在任意目录、带任意变量；原则 7 说 agents-io 只在启动时设 cwd/env，但没说不加约束。
5. **当前没有真实使用方的通用宿主接口**（`route` 回调与 launch、`session.prepare`、`inbound.redispatch`）：是继续作为"通用宿主"能力保留，还是标成实验性、等第一个真实宿主（多租户场景）落地后再定稿？本文倾向保留：它们都通过了"需要通道或投递"的检验，代码也已有测试覆盖。
