# 北向投影：会话作为 ACP agent（`aio acp`）与 AG-UI 事件流

> 状态：已实现（2026-11-25，core-slimming G9 的北向一半，`docs/design/core-slimming/` §3）。两个内建功能模块，缺省关：ACP 服务端 `acp-server`（配置段 `acpServer`，CLI 命令 `aio acp`）与 AG-UI 端点 `ag-ui`（配置段 `agUi`）。用法见 HOSTS §4.11；承诺见 INVARIANTS PR-4（新），以及扩到这两个端点的 ID-10、SE-5、CF-10、IN-8、RQ-3、DL-7、CT-1。
> 依据：POSITIONING §9.3（"会话按标准协议对外投影：AG-UI 服务端让网页界面订阅任意会话，ACP 服务端让编辑器加入会话"）；core-slimming §7.1（和 t3code 互通走 ACP：agents-io 把会话暴露成 ACP agent，t3code 的通用 ACP provider 就能接上，Zed、JetBrains 也一样）；规范：ACP v1（agentclientprotocol.com，官方 TypeScript SDK `@agentclientprotocol/sdk` 2.9 的 v1 稳定入口与它的 `schema/v1/schema.json`），AG-UI 1.0（docs.ag-ui.com，`@ag-ui/core` 1.0.5 的类型与 zod schema，`@ag-ui/client` 的 `HttpAgent`）。

## 1. 一句话

**会话的日志对外投影成两个标准协议：编辑器把 `aio acp` 当一个 ACP agent 起，它经本地 socket 进守护进程；网页界面 POST 一个 AG-UI 的 `RunAgentInput`，得到一条 SSE 事件流。两边的客户端都是对外 MCP 端点那样的配置客户端：自己的令牌和 scope，守护进程以它的主体盖章（`peer`，永远不是人），宿主的 `external` 钩子决定每条输入，经 lane 的回环检查；映射是事件的纯函数，由与语言无关的 fixture 固定。**

## 2. 结构

| 部分 | 在哪 | 做什么 |
|---|---|---|
| 接缝（内核与协议） | `packages/protocol/src/module.ts`、`client.ts`、`host.ts`；`packages/kernel/src/modules.ts`、`local-server.ts`、`gateway.ts` | `KernelContext.subscribe`（会话事件按到来的顺序，tier `full`；从头时第一条是 `session.snapshot`）、`KernelContext.blobs.put`（客户端发来的图片）、`ModuleInstance.connect` 与客户端帧 `module.connect`（本地 socket 的一条连接交给模块，之后两边都是模块的 JSON 值）、`ModuleManifest.cli`（模块给 `aio` 加命令，`ModuleRegistry.cliCommand`）、`external` 回调的可选 `endpoint` |
| 客户端的规则 | `packages/daemon/src/peers.ts` | 配置客户端（schema、解析、主体规则、令牌、频率窗口）、盖章（`peerOrigin`）、会话归属（`mayRead`、`mayInput`、`sessionFor`、`newOwnSession`）、宿主的 `external` 钩子（`hostAllows`）、交给 lane 的输入（`peerInput`：路由记录、`cause`、`local` 回复路由） |
| U20 的门 | `packages/daemon/src/external-view.ts` | 外部读取面的流式版本：受检的一轮被遮的事件等它放行（之后的也等着，顺序照日志），扣下的丢掉；`replay`（日志里外部读者现在能读的：不含扣下的与 `internal` 的）给 `session/load` 和 AG-UI 续读接上开着的一轮用 |
| ACP | `acp-projection.ts`（映射，纯）、`acp-server.ts`（模块、每条连接一个 `AcpLink`、`aio acp` 与 `acpPipe`） | 见 §3 |
| AG-UI | `ag-ui-projection.ts`（映射，纯）、`ag-ui.ts`（模块、HTTP 服务器 `AgUiEndpoint`） | 见 §4 |
| fixture | `packages/testkit/conformance/projections/{acp,ag-ui}/`，读法 `packages/testkit/src/conformance/projection.ts` | `docs/design/conformance-fixtures/` §4a |

模块住在组合根（`packages/daemon`）里，与对外 MCP 端点一样：它们要用 session（`withholding`）、kernel（`loadOrCreateTokenFile`）和两个协议的官方包，不是只依赖 protocol 的模块包。守卫（§6）的 vendor 字面量里有 `acp`（harness 种类），所以端点的名字是它的模块 id：`origin.adapter` 是 `acp-server`，客户端的会话是 `acp-server:<名>:<id>`。

## 3. ACP 服务端

- **连接**：`aio acp` 连 socket，发 `module.connect { module: "acp-server", hello: { client, token, session? } }`。模块按令牌认出客户端（摘要比较，不提前退出），名字对不上答 `unauthorized`。接受之后这条连接上的每一行都是 ACP 的 JSON-RPC 消息，`aio acp` 只在 stdio 与 socket 之间转发；ACP 由模块用官方 SDK 的 agent 一侧（`agent()`）说，每条连接一个应用实例。
- **能力**：`loadSession`（日志即续接）、`promptCapabilities` 文字 + 图片 + 内嵌文本资源、`sessionCapabilities.list`；不要认证（令牌已经在 `module.connect` 里）；不用客户端的 `fs` / `terminal`。
- **会话**：`session/new` 开客户端自己的会话（要 `agent`），或绑定 `--session` 给的那个；`session/load` 读日志（最近 5000 条）、经 U20 的门重放成 `session/update`（`internal` 的事件不给，与在线时的订阅一样），再从日志头往后订阅；重放时遇到要问客户端的请求先记下，日志里随后结算了的（答过的、取消的）和它的一轮已经结束的（RQ-2；停掉的守护进程留下的一轮在下次启动时结算，不写它的请求的结算）划掉，重放完还剩的再问。`cwd`、`mcpServers` 不用（§6）。
- **prompt**：转成输入的内容（图片进 blob 库），先登记"等哪条输入"，再交给 lane（`peerInput`）；`turn.started` 里有它的输入就记下轮次，那一轮 `turn.completed` 时按映射表回答 stop reason；输入被拒是错误、被取消是 `cancelled`；回环检查截停（`observe_only`）是一个说明它的错误。prompt 的回答在这一轮的所有 `session/update` 之后发出（同一个 pump 依次处理）。
- **映射**（`AcpProjection`，PR-4）：见 `acp-projection.ts` 文件头的表。文字：增量照流（同一条消息一个 `messageId`：`<轮次>:<n>`），`text.snapshot` 只补还没流出的部分并结束这条消息，最终回答重复已经说过的（最后一条，或全部连起来）不再说；只有 snapshot 时（重放）每条消息说一次。别人的输入作为 `user_message_chunk`，前面带 `[<主体>] `；客户端自己这条连接发的不再推（编辑器已经显示）。
- **请求**：每个请求都是一个待定的工具调用 `request:<id>`（谁在等、等什么，编辑器看得到），结算后 `completed` / `failed`。只有 resolver 是 `human`、`principals` 里有客户端主体的，才 `session/request_permission`（选项 id 就是决定的种类：`allow_once`、`allow_session`（请求 `allowAlways` 时）、`deny`）或在客户端支持表单时 `elicitation/create`；答复经 `KernelContext.lanes.command` 以客户端的 peer 身份 `resolve`。请求先在别处结算了，用 SDK 的 `cancellationSignal` 撤回（`$/cancel_request`）。resolver 由谁定：审批要 `approvals: true`（模块的 `resolver` 钩子）或宿主的 `resolve` 回调；提问照缺省策略交给这一轮的人（`TurnContext.owner`），客户端自己开的轮次里就是它，所以不开 `approvals` 也问它（§5）。
- **取消**：`session/cancel` 只对客户端自己的 prompt：轮次已开始就带 `turnId` 打断（CT-1，别人的轮次不动）；还在排队的立即答 `cancelled`，它的轮次一开始就被打断（lane 没有单独撤回一条排队输入的命令）。

## 4. AG-UI 端点

- **HTTP**：自己监听（缺省 `127.0.0.1:7466`，只许回环），路径 `/ag-ui`。先查 `Host`（回环名，防 DNS rebinding），再查 `Origin`（只有 `agUi.origins` 里的，答 CORS 与预检），再认令牌（`Authorization: Bearer`），再按客户端限频；请求体有上限。
- **run**（`POST /ag-ui`）：`RunAgentInput` 由 `@ag-ui/core` 的 `RunAgentInputSchema` 校验；最后一条 `user` 消息是输入；`threadId` 是 scope 里已存在的会话键时就是它，否则是客户端自己的 `ag-ui:<名>:<threadId>`（要 `agent`）。先订阅（从头：第一条是快照），再交给 lane，拒绝在写下 200 之前以 HTTP 错误答出；然后 `RUN_STARTED`、`STATE_SNAPSHOT`，只投影拿走这条输入的那一轮，`RUN_FINISHED` / `RUN_ERROR` 收尾。每个事件的 SSE `id` 是它所示会话事件的 seq，一个流里不减：`RUN_STARTED` 与 `STATE_SNAPSHOT` 的是订阅时的日志头（输入进会话之前；那时这一轮可能还没开始、要排队，所以不用这一轮开始的 seq），这次 run 的事件都在它之后，从它续读拿得回这次 run；空闲时每 15 s 一行注释。
- **续读**（`GET /ag-ui/threads/<threadId>/events?fromSeq=`，或 `Last-Event-ID`）：AG-UI 的 `HttpAgent.connect` 没有约定 HTTP 形状，这是我们自己的：从 seq 往后每一轮一个 run（`runId` 是轮次 id）。流常常断在一轮中间：订阅之前读到 seq 为止的日志，那时还开着的一轮从它的开始交给投影的 `resume`（读者已经有了，没有输出），于是它是第一个 run，`RUN_STARTED`（`id` 是这个 seq）马上给出，之后照常；消息编号接得上，最终回答重复断之前说过的不再说。AG-UI 的客户端按流校验（第一条必须是 `RUN_STARTED`，一条消息的 `CONTENT` 之前要有它的 `START`），所以不从断点接着给半个 run；断之前流出的文字增量不在日志里，断在一条消息中间时，这条消息由它的 snapshot 整条给出。
- **映射**（`AgUiProjection`，PR-4）：见 `ag-ui-projection.ts` 文件头的表。工具调用的名字是条目类型或 `<server>.<tool>`，带点或下划线，不会撞上界面声明的前端工具名（AG-UI 的前端工具由界面执行，撞名会被当成要它执行）；这些都是后端已经跑完的调用，所以紧跟 `TOOL_CALL_RESULT`。
- **不做**：请求的作答（AG-UI 1.0 的 interrupt / resume 是一条完整的人在回路流程：`RUN_FINISHED` 带 `interrupts`，下一次 run 带 `resume`，以后需要时按它做）；`MESSAGES_SNAPSHOT`；`STATE_DELTA`；前端工具（`RunAgentInput.tools` 不交给 agent）。客户端断开不打断这一轮。

## 5. 安全评审（ID-10、SE-5、RQ-3，及 CF-10、IN-8、DL-7、CT-1）

| 风险 | 对策 | 承诺与测试 |
|---|---|---|
| 客户端冒充主人或某个人，拿到 `bypass` 或审批资格 | 主体只由令牌决定，`hello`、HTTP 请求里没有能改它的字段；配置的主体必须是 `external:…`、不是 owners 之一、不带 `owner` 标签（加载时报错）；盖章 `kind: "peer"`、证据 `device_only`；模块经 `KernelContext.lanes.input` 交输入，内核另外只收 peer、去掉 `nativeCommand` 与 `loopGuard`（ID-10 的模块规则） | ID-10：`acp-server.test.ts` 的真实 `aio acp` 进程、主体规则；`ag-ui.test.ts` 的 run |
| 端点默认对外开放、或被同机的别人或网页够到 | 两个模块缺省关；ACP 不监听端口，只经本地 socket（SE-2：目录 0700、socket 0600），再加客户端令牌；AG-UI 只许回环地址、`Host` 必须是回环名、浏览器只有配置的 origin、令牌按摘要比较、401 日志限频、请求体与频率上限；令牌不得是宿主令牌、两个客户端不得相同，`tokenFile` 0600 | SE-5：两个端点的缺省关、令牌、`Origin` / `Host`、413、429 |
| 客户端越出它的范围读写会话、借此开新会话 | 只有 `read` / `read:` / `input:` 三种 scope；读与写分开查；不在读 scope 里的会话与不存在的一样；只有配了 `agent` 的客户端能开会话，开的是它自己前缀下的；`run:`、`host:`、`external:` 永远不收；宿主的 `external` 钩子决定每条输入，宿主不在时拒绝 | CF-10 |
| 代人作答、绕过 RQ-3 的显式开关 | ACP 客户端只答 resolver 点了它主体的请求，答复以它自己的身份、不带 `onBehalfOf`（`onBehalfOf` 只给宿主连接，网关先拒绝）；成为审批的 resolver 只能经宿主的 `resolve` 回调或部署方显式的 `approvals: true`（只对它独自开、不是 `bypass` 的轮次）；提问不经这个开关：缺省策略把提问交给这一轮的人，客户端自己开的轮次里就是它自己，答的是自己的问题，不是代人作答；答复是交给 agent 的文字、不放行任何工具，与它本来就能发的 prompt 一样（只是宿主的 `external` 钩子不问答复，不想这样的部署方用 `Policy.resolve` 或宿主的 `resolve` 回调另定 resolver）；别人开的轮次里的提问点的是那个人；lane 再查资格、先到者为准；`session/load` 不再问日志里已结算的；AG-UI 不答任何请求 | RQ-3、RQ-1：`acp-server.test.ts` 的四条请求测试 |
| 两个 agent 经编辑器或界面互相触发、无限来回 | 输入是 `peer`，过 lane 的同一个回环检查（成对计数按 `<模块 id>:<名>`） | IN-8 |
| 受检的一轮（U20）的回答从外部读取面漏出去 | `ExternalView` 让被遮的事件（及其后的）等到放行，扣下的丢掉；重放同样；快照只给状态，attention 不带请求标题 | DL-7：`north-withhold.test.ts`（把门去掉这条测试就红） |
| `internal` 的事件（harness 只给守护进程自己看的条目）经重放漏出去 | 在线的订阅缺省不给 `internal`；`replay`（`session/load`、AG-UI 续读接上开着的一轮）照同样的可见性（`passes(e, 'full')`）过滤 | PR-4：`acp-server.test.ts` 的 internal 条目测试 |
| 打断别人的轮次 | `session/cancel` 只带客户端自己 prompt 的 `turnId` 打断；lane 按 `Policy.control` 再查（主人或本轮发起者） | CT-1 |
| 令牌出现在命令行、日志或状态里 | `aio acp` 的令牌来自 0600 文件或环境变量，不上命令行；日志与状态只有客户端名；配置错误只说键名 | SE-1 的规则（`acp-server.test.ts` 查状态里没有令牌） |

还留着的（不是这一步的缺口，写在这里以免遗忘）：一个客户端可以往它能写的会话里一直排输入（每分钟的 prompt / run 有上限，回环检查兜住无人值守的来回）；同一个令牌的持有者就是这个客户端（与对外 MCP 端点一样，没有更细的会话级凭据；远处的端经宿主的代理）。

## 6. 与 t3code、Zed 的差异与取舍

- **`cwd` 与 `mcpServers` 不用**：会话的工作目录、指令与工具是 agent 的配置，不由端口另一侧的客户端决定（要按项目开会话，用宿主的 `session.launch`，FC-4 限定可选的目录）。t3code 每个项目开一个 ACP 会话时，可以给每个项目配一个 agent，或用 `--session` 固定。
- **没有 session mode、模型切换**：ACP 的 `session/set_mode`、config option 不提供（改运行配置是主人的聊天命令或宿主的事，决定 16）。
- **共享映射包没有抽**：core-slimming 原先计划北向投影时把 `harness/acp/src/map.ts` 抽成共享的 `acp-map` 包。两个方向的函数不同（南向从 ACP 读进来，北向写出去），共享的只是表；抽包要多一个包分类、构建和守卫的例外（组合根之外的文件 import 不了模块包）。改为：北向的表在 `acp-projection.ts`，`packages/daemon/test/north.local.test.ts` 查两张表反过来读一致（条目类型、状态、stop reason、权限选项与决定）。
