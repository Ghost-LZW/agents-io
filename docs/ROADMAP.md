# agents-io 路线图

> 状态：2026-10-10 与 owner 讨论确定。核心原则与决定 12 一致（`docs/design/locus/DECISIONS.md`）；判断新功能是否跑偏，先对照 §1。

## 0. 要解决的问题

人和 agent、agent 和 agent 之间的交互，离开 TUI 就失真：看不到 agent 此刻的真实状态，因果断在多个窗口里，出问题无处可查，插不上手。TUI 让人信任它，不是因为细节最全，而是因为：看到的就是本体（没有转述层）、因果是一条线、随时能打断和批准、"卡住了"是可观察的。

agents-io 要在任何通道、任何模态上给出同样的可信度，健壮到可以交给 agent 自己维护（自举），同时不给模型增加负担，并让别的 agent 方便地和这里的 agent 沟通。

## 1. 核心原则

1. **日志是唯一真相。** 每个 session 一条带 seq 的日志；每个端（飞书卡片、邮件、终端、语音、控制台）都是它的投影。投影可以有损，但必须知道自己丢了什么，并给出升到全保真的入口（完整 trace、`aio attach`）。
2. **模型只看文本与来源。** 富渲染（卡片、按钮、流式、语音播报）归渲染层，模型不需要知道。给模型的工具默认关闭、按 agent 配置开启；新增工具要说明为什么不能由渲染层或宿主来做。
3. **全模态进核心，场景不进核心。** 核心的输入输出覆盖文本、图片、文件、音频、视频；媒体作为内容（日志里的块，blob 引用）和媒体作为实时流（会话 + 对端，决定 11）都是核心能力。平台特有的逻辑留在通道里，单个场景的逻辑交给宿主。
4. **承诺可检验。** agents-io 的不变量集中写成一张清单（§3），每条都有测试；`aio explain` 能从任何副作用追溯到触发它的输入。
5. **能自我升级。** 守护进程重启或升级不丢对话、不丢正在跑的 turn（或确定地续上）。这是让 agent 维护 agents-io 的门槛。
6. **只做 IO，不做真相。** 任务、分工、验收、记忆、成员目录的真相在宿主（x-work-os 等）。agents-io 负责送达、观察与因果记录（POSITIONING §2）。
7. **宿主的业务交互走工作区，不走 agents-io。** 宿主有两个面：控制面（告诉 agents-io 怎么做 IO：身份映射、Binding 表与回调、launch、入站队列、审批、出站、任务运行）经过 agents-io；环境面（agent 的工作目录、CLAUDE.md / AGENTS.md、`x` 命令行、凭据、brief）是 agent 自己的世界，agents-io 只在启动时设 cwd/env。判断方法：这件事需要碰通道、碰人或需要投递吗？不需要就不该经过 agents-io。

## 2. agent 之间的通信

两种形态都会有：**对话方**（A：像人一样发消息，回复回到发送方）和**调用方**（B：派一个任务，拿回结构化结果）。驱动场景：x-work-os 里多个 harness 的 agent 协作完成任务、互相监督。x-work-os 是协调的真相来源，agents-io 只提供下面的机制。

| # | 能力 | 内容 |
|---|---|---|
| 1 | 寻址与身份 | 每个 agent 和 session 有稳定地址（`<agent>/<sessionKey>`）；agent 发出的输入盖 `origin.kind: "agent"`，证据由守护进程签发（本机最强一档） |
| 2 | 发现 | 列出可联系的 agent 与 session 及其状态（空闲 / 运行中 / 等审批 / 阻塞 / 出错）、一句话现状、能力；可见范围由宿主或本地配置决定 |
| 3 | 消息（A） | 往另一个 session 的 lane 投一条输入，回复路由指回发送方 session；对方回复作为新输入回来；排队与插话照 lane 规则 |
| 4 | 任务（B） | 派一次 `mode: task` 运行，结果异步回来，可超时、可取消（复用 `run.start`） |
| 5 | 观察与控制 | 状态变化时推一条短通知（完成、阻塞、等审批、出错）；需要细节时主动查 `ProgressView`，不把对方日志灌进上下文；打断、插话；**代为审批**（新的 Resolver 种类，显式开启，见决定 12） |
| 6 | 因果链与防循环 | agent 发出的每条输入带 cause 链与跳数；超过上限或同一对 agent 来回过多时停下并告警，`aio explain` 可查 |

给模型的工具压到三四个，按 agent 配置开启：`agents_list`、`agent_send`、`agent_run`、`agent_status`（含控制）。不在 agents-io 上的 agent 通过一个 MCP 端点（之后可能加 A2A）使用同一组原语，进来时带外部来源。跨机器守护进程互联不做，等有需要再说。

## 3. 不变量清单

全文与测试对照见 `docs/INVARIANTS.md`。摘要：

- 每条输入要么被消费（`input.consumed`），要么被明确拒绝（`input.rejected`），不会静默消失。
- 每次投递都以 `delivery.settled` 结束（成功、失败或 `unknown`），按 operationId 幂等。
- 交给宿主的输入在 ack 之前不丢（持久队列，至少一次）；redispatch 至多一次。
- 每条输入都带来源（主体、来源类型、路由、是否经 watch、证据），模型可见。
- 任何副作用（发消息、写宿主命令、审批）都能由 `aio explain` 追溯到触发它的轮次与输入。
- 一个 session 同一时刻只有一个写者 lane、至多一个 live。

## 4. 路线

### 现在

1. **不变量清单**（§3，已汇总为 `docs/INVARIANTS.md`：58 条，29 有测试 / 19 部分 / 9 没有，21 条代码路径不成立）。先修最危险的缺口：
   - ~~通道可冒充别的通道与主人（ID-3）~~ → 已落地 channel-stamping（决定 13）；
   - lane 关闭或重启时排队输入静默丢失（IN-1 / RS-6）；
   - ~~`aio explain` 不能从副作用反查（EX-2）~~ → 已按 operationId 反查到轮次与输入（系统回复、宿主 `deliver` 也有记录）；剩 `live_say` 无痕；
   - outbox 只在结算时落记录，崩溃后重发（Lark 上传、邮件真的会发两次）；多机器人时停掉的账号被改写成另一个账号发出；
   - 守护进程从不设 `SendOp.as`（agent 身份未随附）。
   宿主接口复查见 `docs/design/host-surface-review/`（删 `lease`、删 `AGENTS_IO_TURN_PROVENANCE`、冻结 resolve/outbound 回调、来源行加 `ref=`）。
2. ~~**agent 通信第一步：寻址、身份、因果链**（§2 第 1、6 项）~~ → 已实现（决定 13，提案 `docs/design/agent-messaging/` §12 记偏差）：地址 `<agent>/<sessionKey>`、`daemon` 证据、`InputRecord.cause`、出站索引（兄弟机器人自动 `self`）、`Lane.input` 处的跳数与成对上限、前言 `hop=`、`aio explain <operationId>` / `--chain`、`Policy.contact` 钩子（默认拒绝）、邮件 `X-Agents-IO-Hop`。不增加模型工具。
3. **飞书会议通道 v1（文本）**：`docs/research/meeting.md`，在 `channel/lark-bot` 里做；先在真实会议里做 go/no-go（灰度，可能 20017）。
4. **飞书手工检查清单**：图片 / 文件、`ask_choice` 按钮、@、`send_file`，待 owner 确认。

### 接着

5. **agent 通信第二步**：`agents_list` / `agent_send` / `agent_status`（§2 第 2、3、5 项），aio-dev 里加两 agent 对话、一 agent 监督另一个的 e2e 场景；然后 `agent_run`（第 4 项）、代为审批。
6. **Claude Code 跨重启接管**（`docs/design/claude-persistence.md`）：原则 5 的门槛，从"等需要时再做"提前。
7. **视频**：实时侧已有 frames 传输（静态视频帧，决定 11 补记）、`MediaKind` 已含 `video`；内容侧 `ContentBlock` 目前有 text / image / file / audio / transcript / quote / event，缺 `video` 块。
8. **live 录音挂点**：音频不经过 agents-io，日志只有转写；加可选挂点让通道或 harness 把音轨落成 blob 挂到 `live.*` 事件上，默认关闭。
9. **lane `control` 命令**：`set_model`、切换 harness 实例（现返回 `unsupported`）。

### 之后

10. **对外 MCP 端点**：外部 agent 用同一组通信原语。
11. **工具负担复查**：host-mcp 现有约 14 个工具，按原则 2 复查哪些应默认关闭或并入渲染层。

### 待拍板

- **harness-env / inheritEnv**（`docs/design/harness-env/`）：session-launch §8.11 在等它。

### 被外部条件挡住

| 事项 | 挡在哪 |
|---|---|
| 多 lark-bot 第二阶段（识别同部署的其他机器人） | 需 live 核实飞书是否把一个机器人的群消息推给同群其他机器人；不推则取消 |
| 公开 lark-bot 的会议语音（`openLive`） | 租户缺 `vc:meeting.bot.realtime:write`（灰度白名单，owner 申请）；目前只有私有 open-lark 通道实现了 `openLive` |
| 会议视频 | 飞书无官方 API，只能会后录像帧或 IM 截图 |
| Codex realtime 走 WebSocket | 需要 OpenAI API key；ChatGPT 登录只能走 WebRTC v3（现行做法） |

### 有触发条件再做

- 多宿主，宿主重连后对运行中 run 的恢复（HOSTS §7）。
- 宿主选定的会话键也能有话题；Binding 规则上写静态 `cwd`（session-launch §6）。
- 通道条目上直接写 `agent`（决定 8 §11 第 4 项）。
- x-work-os 规范的 4 个缺口（0004 退出码 3、0008 无法捕获的输入、0010 外来 runner、0006 至多一次）：等用到再说。

## 5. 明确不做

- 长期记忆（宿主或 harness 原生项目记忆，决定 6）。
- 协调与任务的真相（宿主，决定 12）。
- 持久化的通道 / 宿主状态：只提供 store 接口和内存实现。
- Web 控制台 UI：另一个仓库；这里只提供 admin HTTP/WS API。
- 为 open-lark、x-work-os 做专门适配。
- 按上下文污染程度降权限或硬拦截（决定 4、5），只标来源。
- PTY 刮屏。
