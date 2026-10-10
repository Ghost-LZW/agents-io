# 决策记录：智能在哪、谁拉起、谁路由

日期：2026-10-07。方案比较见同目录 `README.md` 与 A–E 五份设计；本文只记用户的最终决定。

## 总体方向

以方案 C 为骨架：**agents-io 是唯一拉起 harness 的地方（机制）；哪些消息唤醒哪个 agent、哪个 agent 监听哪些消息，是一张确定性的 Binding 表（策略）**。路由里不调用模型；需要语义判断的消息交给宿主，宿主判断后再送回。智能来源是模型与宿主的权威状态；没有宿主时，默认 Binding 表让 agents-io 看起来像一个输入输出范围很广的 agent。

## 决定 1：宿主怎样接收输入

- aio 守护进程常驻（它持有通道连接与 harness 进程）。
- 交给宿主的输入（`on: host`）写进**持久化的宿主入站队列**：按消费者记游标，至少投递一次，以渠道消息引用为幂等键，宿主确认（ack）后才前移。
- 两种消费方式，语义相同：**推送**（宿主保持连接，aio 推送，断线期间留在队列里，重连后补推）与**拉取**（`aio tail --consumer <name>`，从游标处取，处理后 ack）。
- 丢记录的根因是"同步回调 + 超时丢弃 + 无持久队列"，与是否常驻无关；草稿中的同步 admit 回调删除。
- x-work-os 第一版用 `aio tail` 拉取（0008 允许部署长期运行的接收程序）。

## 决定 2：路由规则从哪里来 —— 选 (c)

- 主路径：本地配置 + 宿主推送整表（`bindings.put`，带版本号、可选有效期、`onHostDown: keep | suspend`，宿主推送的表默认 `suspend`）。数据路径上按表在本地匹配。
- 个别规则可以显式开启同步回调（类似 Envoy ext_authz）：`callout: { timeoutMs, onFailure }`，失败模式默认 `host`（进入决定 1 的持久队列），因此回调失败只变慢、不丢消息、不会在宿主不知情时拉起 agent。
- 回调与否、返回值、是否走失败模式，都记入 `aio explain`。

## 决定 3：成员身份放在哪 —— 选 (b) + 身份映射

- agents-io 只提供渠道身份与证据（平台签名、DKIM、内部投递、发送方表明的身份），不维护通用成员目录。
- 宿主推送 **渠道身份 → 宿主身份** 的映射（与 Binding 表同样带版本、可暂停）：`{channel, channelUserId} → { principal: "<宿主成员 id>", labels: [...] }`。盖章后 `Origin.principal` 就是宿主的成员 id，规则可按 labels 匹配。
- 证据要求不变：映射命中但证据不足，仍按外部来源处理。
- 一个渠道身份至多对应一个成员、多人共用账号不得绑定等约束，由宿主在生成映射时保证；agents-io 发现冲突时报错。
- 无宿主时，本地 `owners` 配置是该映射的最简形式。

## 决定 4：被不可信内容唤醒的交互 agent 能否调用宿主写命令 —— 选 (a) 能调

- 功能优先：不按轮次的污染程度拦截写命令。
- 不削减功能的配套：每个写请求附带本轮输入的**来源标记**（是否含监听、群聊、外部内容）；`aio explain` 能从任意写入追溯到触发它的轮次与输入。宿主可据此自行记录、事后核查，或对个别高风险命令加自己的规则。
- 本决定只关于宿主写命令。

## 决定 5：上下文被污染时，harness 权限 profile 是否降档 —— 不降档

- 保持现状：`Policy.plan` 按触发本轮的输入决定 profile（默认策略下，主人触发的轮次走放行 profile），不因上下文里混入监听、群聊或外部内容而降档。
- 已知代价：被监听的内容进入上下文后，主人在群里 @ 一句，这一轮就带着其他人写的文字以放行权限运行。用户接受这一代价，功能优先。
- 理由（用户）：相信模型能自己判断哪些内容不可信。因此机制上的责任是**让来源清楚可见**：每条输入都带发送者说明（主体、来源类型、经由的路由、是否经 watch、证据），被监听与外部内容明确标注；不做硬拦截。
- 宿主仍可通过自己的 `Policy.plan`（或 Binding 规则指定的 agent 的 profile）对特定来源收紧。

## 决定 6：对话、话题与记忆

- 一个对话可以有多个**话题**，每个话题对应一个 session；对话有一个"当前话题"指针。有线程的平台（飞书话题、邮件线程）照常按线程分 session（`per-thread`）；平铺的对话用新的 session 范围 `topic`。
- agents-io **只提供机制**：持久化的话题表（标题、摘要、session、harness 原生会话 id、最后活跃时间；旧话题存档不删），输出工具 `session_rotate`（开新话题，把触发本轮的输入连同上一话题的摘要转投过去）、`session_list`、`session_switch`（切回旧话题，用 harness 原生续接恢复完整上下文），以及命令 `/new`、`/topics`、`/switch`。何时切换由 agent 自己判断。
- **长期记忆不在 agents-io**：有宿主时由宿主负责（x-work-os 的经验与 brief）；无宿主时依靠 harness 原生的项目记忆（工作区里的 CLAUDE.md、AGENTS.md、自动记忆）。agents-io 不写任何记忆文件。
- 工作区（工作目录与项目级配置）默认属于 agent 的运行配置；部署方可在 agent 配置里声明允许按会话指定工作区的范围（`sessionParams`），宿主在范围内为会话选定工作区，选定后随会话固定。项目配置仍写在工作区目录里，由 harness 自行读取。
  - 修订记录（2026-10-07，见决定 7）：原文为"工作区（工作目录与项目级配置）属于 agent 的运行配置；一个项目对应一个工作区，项目配置写在该目录里，由 harness 自行读取。"

## 决定 7：交互会话的启动参数（每会话 cwd/env）—— 采纳方案 A

日期：2026-10-07。方案见 `docs/design/session-launch/README.md`。驱动场景：多租户宿主（每个用户一个工作目录与配置目录）。

- **总体形态**：路由回调的答复可带 `launch: { cwd?, env? }`；新增宿主帧 `session.prepare` 为不经渠道路由打开的会话预先登记；允许的范围写在 agent 条目的 `sessionParams`（`cwdRoots`、`envKeys`、`envPathRoots`）上，未配置即拒绝；`CLAUDE_CONFIG_DIR` / `CODEX_HOME` 列入 `envKeys` 时必须配 `envPathRoots`。`host.hello` 以 `features` 声明 `session.launch`。
- **修订决定 6 最后一条**：同意，按提案 §10 第 2 项的拟改文（已更新于决定 6）。
- **launch 整体不可变**：随会话键固定并持久化，先到者为准；同一键收到不同 launch（含无 launch 的老会话收到 launch）一律 `launch_conflict`，要换就换会话键。需要轮换的凭据放在配置目录里由 harness 自己读取，不放进 env 值。
- **加 `callout.skipWhenPinned`**：按规则开启；规则本地可算出目标键且该键已有 launch 记录时跳过回调，`aio explain` 记 `skipped_pinned`。与决定 2 一致：回调只在每个键的首条输入发生，稳态走本地匹配。

## 决定 8：一个守护进程跑多个飞书机器人 —— 采纳第一阶段

日期：2026-10-07。方案见 `docs/design/multi-lark-bot/README.md`。owner 指示"按设计文档实现"，§11 阻塞项均按推荐：

- **凭据写法**：`lark-bot` 条目在 `config` 里显式写 `appId` / `appSecret` / `domain`（值或 `env:NAME`，整份 `config` 做 `env:` 替换，修好 `encryptKey` 等字段的 `env:` 不生效）；`LARK_APP_*` 只作为至多一个条目的兜底。两个兜底条目、重复应用（同 appId + domain）、重复账号、多条目时非法账号名，都让守护进程启动失败（控制台写入前同样报出）。
- **出站退路**：多账号时 `deliver` / `systemReply` / `replyCaps` 不再按通道 id 退回，只有该 id 恰好一个运行中账号时才退回；compositor、输出工具按 `(channel, account)` 选实例；lark-bot 适配器拒绝发往别的账号的路由。单账号时是否取消退路留给 channel-stamping §10 第 5 项。
- **create-lark-bot**：G1，上游加 `--env-prefix`，控制台对非 `default` 账号传 `--env-prefix LARK_<ACCOUNT>_`；开通写入前复查同账号、变量名冲突、appId 重复、启动校验。
- **通道条目上的 `agent`**（§11 第 4 项）：暂不做。
- **第二阶段**（兄弟机器人识别）：不做，等 live 核实飞书是否把机器人的群消息推给同群其他机器人（§11 第 5 项）。

## 决定 9：宿主的 resolve / outbound 回调与代人作答；宿主队列按原 origin 重新派发 —— 采纳

日期：2026-10-07。owner 在对话中同意推进这两项上游事项。方案见 `docs/design/host-callouts/README.md`、`docs/design/inbound-redispatch/README.md`：

- `host.hello.callouts` 接受 `true`（即 `["route"]`）或 hook 列表 `route` / `resolve` / `outbound`；`resolve` 超时或出错时退回本地策略，`outbound` 任何失败都拒绝。宿主连接可用 `resolve { onBehalfOf }` 代被问的人作答，日志记 `by.via: "host:<name>"`。
- `inbound.redispatch { cursor, agent?, session?, launch? }`：把宿主队列里的条目以原 origin、内容与回复路由派发到指定会话，同一 cursor 至多派发一次，`aio explain` 双向可查。用于宿主离线或回调超时期间进队的输入在之后自动送达，不必请人重发。

## 决定 10：宿主 token 文件、/ws 心跳与接管、bridge 首次握手失败重试、通道变更热生效 —— 采纳

日期：2026-10-07。owner 在对话中同意推进。方案见 `docs/design/host-token-file/`、`docs/design/host-liveness/`、`docs/design/bridge-first-connect/`、`docs/design/live-channels/`：

- `aio serve --token-file` / `host.tokenFile`：存在则读，不存在则生成（0600，权限检查同 `.env.live`），使不与守护进程同机的宿主在重启后仍能认证。
- `/ws` 服务端心跳；`host.hello { takeover: true }` 在 token 正确时替换半开的旧宿主连接并告警。
- bridge 通道首次 hello 失败时标为 `failed` 并按退避重试，不再阻止守护进程启动。
- 经 `PUT /api/config` 的通道增删热生效（`applied: "live"`），只启停变化的通道。

## 决定 11：实时语音会话（live）—— harness 出语音，通道出媒体对端

日期：2026-10-08。调研见 `docs/research/codex-realtime-live.md`（真人语音实测）。owner 指示：入会必须是 Codex realtime v3 这类语音原生能力，不是文本 agent 转语音；会中委托出来的 Codex 工作与文字会话**同权限**。

- **分工**：实时语音是 harness 的能力（`HarnessSession.live`，目前只有 Codex：`thread/realtime/start`，v3，WebRTC）；通道只提供"媒体对端"（`ChannelAdapter.openLive(account, target)` → `LiveEndpoint`：一段 WebRTC offer、`answer(sdp)`、`close()`、`ended`）。网关在两者之间转交 SDP，**音频不经过 agents-io**。
- **挂在会话的 thread 上**：live 打开在调用者所在 session 的 harness 会话上，语音端带着这个 session 的历史入会；文字 turn 与语音并行；会后同一个 session 用文字接着聊。一个 session 同时至多一个 live。
- **委托 turn 归 lane 管**：语音端每次委托（Codex `handoff_request`）记成一条输入（`transcript` 块，`origin.principal = null`，`channelContext.live = true`，回复路由 = 发起 live 的那个路由），随后 Codex 自己开的 turn 以 `turn.started{initiator: 'harness'}` 交给 lane，lane 把它当作当前 turn（排队、工具、来源标记照常），turn 本身没有回复路由：答案由语音说出，不自动发到 IM。委托时已有 turn 在跑，则记成该 turn 的输入（Codex 合并进去）。
- **权限**：委托 turn 用 thread 当时的设置，即与文字会话相同（owner 指示）。来源照决定 4/5 只标记（`external`），不降档。
- **日志**：`live.started` / `live.transcript`（双方，每句一条）/ `live.handoff` / `live.ended`，都进 session 日志。
- **工具**（宿主 MCP）：`live_join { target, instructions?, voice? }`（在当前 turn 的通道上打开对端，target 由通道解释，例如会议号）、`live_say { text }`（让语音端说一段话）、`live_leave`。委托 turn 里同样可用，所以会里说"挂了吧"能离会。语音转述不可靠：要紧的结果应另用 `send_message` 落成文字（工具说明里写明）。
- **结束**：任一端结束（对端离会、harness 关闭、`live_leave`、守护进程停止）都关闭另一端并记 `live.ended`。守护进程重启不恢复 live。

### 决定 11 补记：模块 harness 与 frames 传输

- **模块 harness**：`harnesses.<name>` 可写 `{ use: 'module', module, export?, config?, env?, cwd?, run?, profiles?, options? }`（封闭 schema）。`module` 的解析同通道模块（相对配置文件、绝对路径、包目录或裸说明符），`config` 做 `env:NAME` 替换；模块不存在或有未知键是配置错误。模块导出一个 `HarnessFactory`（默认 `createHarness`，否则 `default`，或 `export` 指定的名字），收到 `HarnessFactoryInit = { name, config, log, harness(name) }`；`harness(name)` 给出另一个已配置实例的 adapter，语音 harness 可以把委派回合交给文本 harness。网关在启动时导入模块、运行工厂；导出不是函数、工厂抛错或返回的不是 adapter 都使启动失败，错误里有实例名。实例仍包在 `InstanceHarness` 里。
- **frames 传输**：`LiveEndpoint.offer` 与 `LiveStartArgs.transport` 都是 webrtc 或 frames 的联合；frames 带 `audio: { encoding: 'pcm16', rate }`、可选 `video: { encodings }` 和 `media: LiveMedia`（`frames` 为对端采集的 `LiveFrame`，`send` 播给对端）。`HarnessLive` 增加 `transports?`（缺省 `['webrtc']`）和 `video?`，`start` 返回 `{ answerSdp? }`，只有 webrtc 需要答复。`live_join` 在 `start` 之前拒绝 live 不支持的传输（错误里有传输名），并关闭端点、不留登记；frames 端点的 `media` 直接交给 harness，live 未声明 `video` 时滤掉视频帧，只对 webrtc 调 `endpoint.answer`。其余流程（`live.started` / `live.transcript` / `live.handoff` / `live.ended`，对端结束即结束语音，`live_leave` 与网关停止两头都结束）不变。`MediaKind` 增加 `video`。
- 视频按静态帧传，因为 WebSocket 类实时服务收的是图片输入；以后需要时可以再扩展。

## 决定 12：核心原则；全模态进核心；agent 之间的通信只做 IO

日期：2026-10-10。讨论记录见 `docs/ROADMAP.md`。

- **核心原则**：日志是唯一真相，各端是可升级到全保真的投影；模型只看文本与来源，工具按需开启；承诺写成可检验的不变量；守护进程升级不丢对话与 turn；只做 IO，不做真相。全文见 `docs/ROADMAP.md` §1。
- **全模态进核心**（owner）：输入输出覆盖文本、图片、文件、音频、视频；实时语音是核心能力，不是通道插件。修订 `docs/design/thin-bridge.md` 的"不统一语音、不进核心"。
- **agent 之间的通信**：对话方（消息）与调用方（任务）两种形态都做，另有发现、观察与控制、因果链与防循环（`docs/ROADMAP.md` §2）。**x-work-os 是协调的真相来源，agents-io 只负责 IO**（owner）：不记任务状态、分工、验收。
- **宿主的两个面**（owner 认可，2026-10-10）：宿主的业务交互走 agent 的工作区（环境面），agents-io 只承载宿主对 IO 的控制（控制面）。现有宿主协议按此复查，能改成 agent 在工作区里直接调宿主命令的，收窄。见 `docs/ROADMAP.md` §1 第 7 条。
- **代为审批**（owner）：agent 可以代另一个 agent 的请求作答，作为新的 Resolver 种类提供；与 `onBehalfOf` 一样须显式开启，日志记 `by.via`。

## 决定 13：按原则自决的一批事项

日期：2026-10-10。owner 指示：能由 `docs/ROADMAP.md` §1 原则推出的细节由维护者（agent）自行决定并在此记录依据；只有改原则、原则冲突、只有 owner 能做的事、仓库外不可逆的动作才上报。依据见 `docs/INVARIANTS.md`、`docs/design/host-surface-review/`、`docs/design/agent-messaging/`。

| 事项 | 决定 | 依据 |
|---|---|---|
| 通道冒充（INVARIANTS ID-3） | 采纳 `docs/design/channel-stamping/` 推荐方案（C 校验拒收、F4 一个 id 一种适配器、E3 证据 = 配置 ∩ caps） | 原则 4：`Origin` "客户端不能设置"的承诺必须成立 |
| 排队输入在停止 / 重启时丢失（IN-1、RS-6） | 停止时把排队与悬挂轮次的输入明确记 `input.rejected` 并通知渠道；重放留给 claude-persistence | 原则 1、§3 第一条不变量 |
| outbox 崩溃后重发 | 发送前落"进行中"记录；重启后遇到即结算为 `unknown`，不自动重发 | 原则 1、4 |
| 多机器人时停掉的账号被改写为另一账号发出 | 拒绝（`unknown_channel`），不退回 | 决定 8 |
| `SendOp.as` 未接线；`live_join` 并发泄漏端点 | 接线；并发 `live_join` 第二个拒绝 | 原则 4（POSITIONING §2 身份表明）；决定 11"同时至多一个 live" |
| `aio explain` 不能从副作用反查（EX-2） | 增加按 operationId / 事件反查到轮次与输入；系统回复、`deliver`、`live_say` 记痕 | 原则 4 |
| `host.hello.lease` | 删除；HOSTS §6 改为 `onHostDown: "keep"` + 定期刷新 `expiresAt` | 原则 4（未实现的承诺不留） |
| `AGENTS_IO_TURN_PROVENANCE` | 删除，保留 `AGENTS_IO_RUN_ID` | 原则 2、7（值恒定，无信息） |
| `resolve` / `outbound` 回调 | 冻结，不再扩展 | 原则 6、7（无使用者） |
| 来源行加 `ref=channel:<通道>/<消息 id>` | 加；决定 4 的"写命令来源标记"改为宿主经 `aio verify` 核验引用 | 原则 2、7 |
| 输出工具默认开启（`config.ts:727`） | 改为默认关闭，按 agent 配置开启；dev-gateway 配置同步 | 原则 2 |
| `onBehalfOf` 与 agent 代批 | 共用一个显式开关，默认关 | 决定 12 |
| agent 通信地基（agent-messaging 提案 §待拍板 1–8） | 全部按提案推荐；默认跳数 8、同一对 15 分钟 10 轮，属可调参数 | 原则 1、4、6；决定 4/5/12 |
