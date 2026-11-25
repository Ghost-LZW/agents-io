# 原生挂接：照常敲 `codex` / `claude`，agents-io 自己挂上去

> 状态：**搁置**（2026-11-24 当天）。owner 定了新的分工：persona 做控制面与 agent 后端，agents-io 只做消息收发与路由，见 `docs/design/persona-backend/`。本文 §3 的实测记录仍然有效，§4 之后的设计不再推进。
> 依据：`docs/design/external-holder/`（决定 15：外部持有的会话）；`docs/POSITIONING.md` §2、§9；`docs/ROADMAP.md` 原则 1、2、§5（不做 PTY 刮屏）；`docs/design/core-slimming/` §7（persona、t3code 的做法）。
> 出处：owner 2026-11-24：「我希望他一开始就可以运行不影响用户原始使用习惯」「`aio tui codex` / `aio tui claude` 而不是 codex/claude 已经（影响）用户使用习惯了，至少没法通过别的工具来调用了」「不要有唯一来源」「我需要发现后就能直接输入输出，和有一个 chat 界面，就和 persona 一样，这个是 persona 的核心卖点」。

## 1. 一句话

**装一次集成，之后任何人、任何工具照常拉起的 `codex` / `claude` 都自动成为 agents-io 的一个会话**：一被发现，主人就能在 chat 界面里看它的全部过程、直接对它说话、回答它的审批，不需要任何绑定动作。别人经通道发来的消息要不要进这个会话，才需要主人显式决定。`aio tui` 留作调试入口，不再是主路径。

## 2. 问题

决定 15 让"人在原生 TUI 里用、agents-io 旁挂 IO"成立，但入口是 `aio tui codex` / `aio tui claude`：

- 换了命令名，就是改了习惯。
- herdr、orca、persona、编辑器插件都按本名 `codex` / `claude` 拉起进程，它们拉起的会话 agents-io 看不见。
- agents-io-herdr 因此另走一条路：读窗格屏幕、发按键，另起一个没有 agent 的守护进程，和会话日志是两套。

要的是反过来：进程怎么起不归 agents-io 管，它只负责认出来并挂上去。herdr 自己就是这样做的（`herdr integration install` 往 `~/.codex/hooks.json` 写一个 `SessionStart` hook）。

## 3. 实测记录（2026-11-24）

环境：本机；codex-cli 0.171.0，共享 app-server 0.172.0（Codex 自管自升级），`CODEX_HOME=~/.config/codex`；Claude Code 2.1.322，临时 `CLAUDE_CONFIG_DIR`；TUI 跑在独立 socket 的 tmux 里；模型 `gpt-6-sol`（`gemini-3.8-flash-high` 当时 503）。探针是一个只说 app-server 协议的 WebSocket 客户端，和一个只登记环境、能写 inbox socket 的 stdio MCP server。

### 3.1 Codex

| # | 问题 | 结果 |
|---|---|---|
| C1 | 普通 `codex` 的 thread 在不在共享服务器上 | 在。`thread/loaded/list` 里有它，`cliVersion: 0.172.0`、`originator: codex-tui` |
| C2 | 哪些启动方式不在 | 命令行带 `-c`、`--enable`、`--disable`、`--search` 时 TUI 退回内嵌模式（TUI 警告原文："Running without the shared background server: command-line configuration overrides … requires embedded mode"）。`-m`、`-a on-request`、`-s read-only` 不影响 |
| C3 | 另一个客户端能否订阅并开一轮 | 能。`thread/resume` 后 `turn/start`，输入和回答实时出现在 TUI 里，上下文是同一段 |
| C4 | 能否在 TUI 自己敲的轮次里插话 | 能。`turn/steer { expectedTurnId }` 在工具调用后生效；TUI 的输入带它自己的 `clientId`，插进去的是 `clientId: null` |
| C5 | 审批 | 后加入的客户端 `thread/resume` 时收到挂起的 `item/commandExecution/requestApproval`；它答 `accept` 后服务端发 `serverRequest/resolved`，TUI 的对话框自动撤掉，命令执行 |
| C6 | 不订阅能知道什么 | `thread/started`、`thread/status/changed`（含 `waitingOnApproval`）、`thread/name/updated`、`thread/closed` 广播给所有连接。发现和状态不需要 hook，也不需要订阅 |
| C7 | 0.171 → 0.172 的协议差异 | `generate-ts --experimental`：968 个类型文件里 13 个有差异，新增 2 个，没有删除。没有逐行审，探针用到的方法都照常工作 |

### 3.2 Claude Code

| # | 问题 | 结果 |
|---|---|---|
| K1 | 用户级安装的 MCP 子进程拿不拿得到消息令牌 | 拿得到：`CLAUDE_CODE_MESSAGING_SOCKET`（`/tmp/cc-socks/<pid>.sock`）与 `_TOKEN` 都在环境里 |
| K2 | hook 进程呢 | `SessionStart` 的 command hook 环境里同样有 socket、令牌、`CLAUDE_CODE_SESSION_ID`、`CLAUDE_PID`；输入里有 `session_id`、`cwd`、`model`、`transcript_path` |
| K3 | 注入 | 空闲时写一帧 `user`，TUI 立刻开一轮；`UserPromptSubmit` 触发且带原文，可按 `ref=` 当送达回执（与 external-holder §10.2 一致） |
| K4 | 两个 `PermissionRequest` hook 并存（一个一直挂着，一个 5 秒后答 allow） | 先答的立即生效（"Allowed by PermissionRequest hook"），不等另一个。落败的 hook 进程不会被杀，继续跑到自己结束 |
| K5 | 守护进程没开时的 http hook | 不拖慢，但每一轮都在 TUI 里打出 "hook error: connect ECONNREFUSED"。http hook 不能用作常驻集成 |

没有验证的见 §8。

## 4. 设计

### 4.1 会话与持有者

沿用决定 15 的模型，加一种来路：会话不是由谁 `attach` 出来的，是**被发现的**。

- 会话键：`native:codex:<threadId>`、`native:claude:<session_id>`。持有者 `external`，`via: 'codex-daemon' | 'claude-hooks'`。
- **发现即可对话（owner 2026-11-24 定）。** 新发现的会话立刻出现在 chat 界面里：历史补齐、过程实时、主人能输入、打断、回答审批。chat 界面是主人身份的一个端，主人点名对某个会话说话，不经过 Binding 表。
- **需要显式动作的只有一件事：让通道里的消息自动路由进来**（控制面里点，或宿主推 Binding）。没有 Binding 指向它时，别人在飞书、邮件里发的任何东西都进不了这个会话。
- **守护进程自己从不替主人回答审批。** 审批出现在 chat 界面和 TUI 两处，谁先答谁生效；缺省的 `auto` resolver 不用于被发现的会话。
- 运行配置（模型、沙箱、权限模式）是用户自己起进程时定的，agents-io 不设也不改。日志里的 `RunSpec` 记"发现时的样子"。
- 持有者消失后的处理仍是决定 15 的 `whenAway`，但被发现的会话默认 `queue`，不是 `lane`：没经主人同意，守护进程不应接手一个它没起过的对话。

### 4.2 Codex：做共享服务器的另一个客户端

- 每个 `CODEX_HOME` 一个共享服务器，agents-io 用现有的 `transport: unix` + `spawn: "daemon"` 连上去，不自己起。
- 发现靠 C6 的广播：`thread/started` 建会话记录，`thread/status/changed` 更新状态，`thread/closed` 结束。
- 发现后立即 `thread/resume` 订阅，并用 `thread/turns/list` 补齐之前的历史，这样日志从头完整，chat 界面打开就有内容、有逐字流式。之后的事件映射、`foreignTurn`、`turn/start` / `turn/steer`、审批先到为准，都是 `harness/codex` 已有的代码。
- 有哪些 `CODEX_HOME`：配置里列出；也可由一个 `SessionStart` hook 上报（Codex 的 `hooks.json`，herdr 用的同一个机制），顺带带回 `HERDR_PANE_ID`。

限制，照实写给用户：

- 带 `-c` / `--enable` / `--disable` / `--search` 启动的 TUI 是内嵌模式（C2），共享服务器上没有它。这类会话只能降到 §4.4 的屏幕级。常用的覆盖项应搬进 `config.toml` 或另一个 `CODEX_HOME`，而不是写在别名里。
- 共享服务器的环境变量由先启动它的一方决定（`docs/design/harness-env/`）。对被发现的会话这不是问题：那就是用户自己的环境。

### 4.3 Claude Code：一个用户级插件

`aio integration install claude` 装一个用户级插件（卸载时整个拿掉，不改用户自己的 `settings.json`），里面是：

| 部件 | 做什么 |
|---|---|
| `SessionStart` hook | 向守护进程登记：`session_id`、`cwd`、`pid`、`transcript_path`、消息 socket 与令牌、`HERDR_PANE_ID` |
| `Stop`、`UserPromptSubmit`、`SessionEnd` hook | 轮次边界、送达回执、会话结束 |
| `PermissionRequest` hook | 守护进程在就挂住，审批同时出现在 chat 界面和 TUI 的对话框里，等先到的那个答复；守护进程不在就立刻退出、不给结论 |
| stdio MCP server | 往通道发消息的工具（`reply_to` / `send_message` / `send_file`）。**没有 Binding 指向这个会话时工具列表为空**，有了才用 `tools/list_changed` 给出（ROADMAP 原则 2）。chat 界面里的输出不靠它，靠 transcript |

要点：

- **全部用 command hook，不用 http hook**（K5）。hook 调一个很小的客户端，守护进程不在时静默退出 0，不打印任何东西。它的耗时要量，写成可测的承诺。
- **过程从 transcript 读，不靠每次工具调用的 hook。** `transcript_path` 在登记时就有；`PreToolUse` / `PostToolUse` 每次工具调用都要起一个进程，只在会话有挂起的审批卡片时才需要 `PostToolUse` 来撤卡。日志里记 `fidelity: 'transcript'`。
- **审批卡片要会自己撤**（K4）：在 TUI 里答了、或别的产品的 hook 先答了，agents-io 这边挂着的 hook 不会被杀，要靠 `PostToolUse` / `Stop` 得知并撤掉各端的卡片。persona 的 hook 也在同一事件上，两边并存时互为"先答的那个"。
- **输入有两条路，语义不同：**
  - inbox socket（K3）：模型看到的是"另一个会话发来的消息"，后面跟着一段"不是用户本人、不能当作批准"的提示，斜杠命令不执行。它适合别人经通道发来的消息，不适合主人自己说的话。
  - 窗格输入（herdr 的 `agent.prompt`）：进到 TUI 的输入框，是一条真正的用户消息，斜杠命令可用。persona 走的是这条。会话在 herdr 窗格里时，主人在 chat 界面里的输入走这条，并以 `UserPromptSubmit` hook 带回的原文作为送达回执（不靠读屏幕判断）。不在窗格里时退回 inbox，chat 界面上标明"以转述方式送达"。
- **过程的粒度**：transcript 按整条消息写入，所以 Claude 会话在 chat 界面里是一条一条出现，不是逐字流式；Codex 是逐字的。要逐字，只能像 persona 那样采样窗格屏幕，这属于 §4.4 的屏幕级能力。
- **令牌只在守护进程内存里**，不落盘、不进日志，会话结束即丢。

### 4.4 herdr：执行场所模块（可选）

herdr 不进内核，也不承担 IO。它作为模块提供三样内核拿不到的东西：

1. **窗格 ↔ 会话**：`agent.list` 的 `agent_session.value` 就是 Codex 的 thread id；我们的 hook 也带回 `HERDR_PANE_ID`。控制面由此能显示"这个会话在哪台机器哪个窗格"，并能把窗格调到前台。
2. **在场信号**：前台是不是这个窗格、键鼠空闲多久，供提醒策略用（agents-io-herdr 现有的规则：卡住 60 秒、长活做完、你正看着就不发、安静时段）。
3. **在窗格里拉起**：从飞书或控制面新开会话时，模块让 herdr 在窗格里起普通的 `codex` / `claude`，之后走的就是 §4.2、§4.3 的发现路径，没有第二套代码。人走到电脑前可以直接接手。

兜底：没装集成的 agent、内嵌模式的 Codex，模块按现在 agents-io-herdr 的做法给屏幕级的状态、输出末尾和按键，日志里记 `fidelity: 'screen'`。内核仍然不刮屏（§9 第 1 项）。

做完之后 agents-io-herdr 不再需要独立的守护进程，它的规则成为这个模块的缺省提醒策略。

### 4.5 版本门

`SUPPORTED_CODEX_LINES` 是白名单，因为 app-server 仍标着 experimental，小版本之间改过字段。对 agents-io 自己拉起的 app-server 这是对的：版本由 `executable` 钉住。

对共享服务器不成立：它自己升级，白名单会让挂接在某天早上突然全断（现在就是：0.172 被拒）。建议只对这一种连接方式改规则：

- 已知不兼容的版本拒绝；
- 比已核对的更新的版本照常连接，会话日志里记一条 `notice`，控制面上标"未核对的版本"；
- 发现新版本时自动跑一遍 `gen-types.sh` 加类型 diff，有删除或改名才报警。

### 4.6 控制面

第一个产品，形态对标 persona：会话表加每个会话一个 chat 界面。会话表包含被发现的和 agents-io 自己拉起的：

- 每行：在哪（机器、目录、窗格）、哪个 harness、状态（在跑 / 等你 / 做完未读 / 空闲）、持续多久、一句话现状。
- 点进去是 chat 界面：完整过程（消息、工具、计划、diff）、输入框（排队 / 插话 / 打断）、审批卡片、"等你"计数。发现即可用。
- 其他动作：接到通道（Binding）、调到前台。
- web 端用 assistant-ui 的 `ExternalStoreRuntime` 接 `/ws` 的带 seq 日志（快照加续传）；手机用 PWA 加 web push，不做原生 app。
- 三个面用同一份数据：飞书工作台（沿用 agents-io-herdr 的话题与卡片）、web（`/api` + `/ws`）、`aio` 命令行。

没有成员目录，没有中心宿主：谁是主人、哪些会话接哪个通道，是这个部署自己的配置。任务套件各带各的。

### 4.7 TUI 关掉之后（owner 2026-11-24 讨论中）

会话的进程不在了，又有输入要给它：

| 输入来自 | 做法 |
|---|---|
| 主人本人（chat 界面） | 接手：按关闭前的样子把它起回来，处理这条输入 |
| 命中 Binding 的通道消息 | 排队，等会话下次被打开时送进去 |

"按关闭前的样子"靠登记时和每次 hook 记下的事实，不靠猜：

- Codex：对话还在共享服务器上，设置存在 thread 里（external-holder §10.1 实测 `thread/resume` 不覆盖），直接 `turn/start`，不起新进程。
- Claude：`SessionStart` hook 记下启动命令行（`CLAUDE_PID` 的 argv）、`cwd`、`CLAUDE_CONFIG_DIR`、`model`；之后每个 hook 的输入都带当时的 `permission_mode`，取最后一次。接手时用同一条命令行加 `--resume <session_id>`，有 herdr 时起在窗格里，没有才无头。
- 还原不了的，接手时在 chat 界面上说明：会话内临时授予的"总是允许"；启动时只存在于那个 shell 里的环境变量（例如别名里设的网关地址与密钥）。后者 hook 进程读得到，但含密钥，是否记、记在哪要单独定（§9 第 7 项）。

## 5. 不变量增补（草案）

- **NA-1** 进入被发现的会话的输入只有两种来源：主人在自己的端上点名发给它的，以及命中了指向它的 Binding 的。守护进程不替主人回答它的审批。
- **NA-2** 守护进程不在时，装了集成的 `codex` / `claude` 的行为、输出和启动耗时与没装时相同（耗时给出上限）。
- **NA-3** 一个挂起的审批在别处被答了，各端的卡片在限定时间内撤掉。
- **NA-4** 会话的保真度（`native` / `transcript` / `screen`）记在日志里，投影据此说明自己缺什么。
- **NA-5** 消息令牌不落盘、不进日志。

## 6. 分步

| 步 | 内容 | 依赖 |
|---|---|---|
| N1 | Codex 发现与状态：连共享服务器、`thread/started` / `status/changed` → 会话表；§4.5 的版本门 | 无 |
| N2 | Claude 集成安装：登记、轮次边界、transcript 过程；hook 客户端与 NA-2 的耗时测试 | 无 |
| N3 | 主人直接输入（Codex `turn/start` / `steer`；Claude 窗格输入加回执，或 inbox）、打断、审批（两边）与撤卡 | N1、N2 |
| N4 | web chat 界面：会话表、chat、审批、"等你"、PWA 推送 | N1–N3 |
| N5 | herdr 模块的其余部分：在场信号、在窗格里拉起、提醒规则、屏幕级兜底；agents-io-herdr 并进来 | N3 |
| N6 | 通道 Binding 到被发现的会话；宿主 SDK 与第一个任务套件 | N3 |

N1–N4 做完就是"装上就能用、习惯不变、打开网页就能和任何一个正在跑的会话对话"。Claude 的主人输入依赖窗格，所以 herdr 模块里"窗格 ↔ 会话"和 `agent.prompt` 这两样要提前到 N3。

## 7. 与现有决定的关系

- 决定 15：扩展。持有者多一种来路（被发现），`whenAway` 的默认值对这类会话改为 `queue`。
- 总体方向"agents-io 是唯一拉起 harness 的地方"：决定 15 已修订为"一个会话一个持有者"；本文再进一步，拉起可以完全在 agents-io 之外。
- ROADMAP §5"不做 PTY 刮屏"：内核不变；屏幕级兜底只在 herdr 模块里（§9 第 1 项）。
- 决定 16：herdr 是模块，不进内核；守卫照旧。

## 8. 没有验证的

- 守护进程（不是 TUI 的子进程）拿着令牌直接写 Claude 的 inbox socket。实测的是 MCP 子进程写。不行的话注入仍由 MCP 子进程做。
- 用户级安装下 Claude 运行中的注入（按次传配置时测过，external-holder §10.2）。
- 插件形式的打包：实测用的是临时配置目录里的 `settings.json` 和用户级 MCP 配置，不是插件。
- herdr `agent.prompt` 送进 Claude TUI 后，`UserPromptSubmit` hook 能否稳定对上原文当回执（agents-io-herdr 线上在用 `agent.prompt`，回执这一半没测）。
- Codex 的 `--yolo`、`--profile` 会不会触发内嵌模式。
- agents-io 订阅着的 thread，在 TUI 退出后是否一直保持加载；`thread/closed` 之后要不要主动退订。
- `harness/codex` 整体在 0.172 上跑（实测只用了裸探针，用到 `initialize`、`thread/list`、`thread/loaded/list`、`thread/read`、`thread/resume`、`turn/start`、`turn/steer`、命令审批）。

## 9. 待拍板

1. **屏幕级兜底放在 herdr 模块里。** 推荐采纳：只作兜底，标明保真度，内核不碰。不采纳的话，内嵌模式的 Codex 和没装集成的 agent 在控制面里就不存在。
2. **共享服务器的版本门从白名单改为"已知不兼容才拒"**（§4.5）。推荐采纳；否则这条路每次 Codex 自动升级都会断。
3. **Claude 集成用用户级插件，不直接改用户的 `settings.json`。** 推荐插件：卸载干净。herdr 是直接写文件的。
4. ~~被发现的会话默认只观察~~ → owner 2026-11-24 否决：发现后即可在 chat 界面输入输出（§4.1）。仍待定的只剩 `whenAway` 默认 `queue`（TUI 退出后守护进程不自动接手），推荐采纳。
owner 2026-11-24：第 1、2、3、5、6 项按推荐采纳。

6. **Claude 会话里主人的输入走窗格（`agent.prompt`）并以 hook 回执确认**（§4.3）。推荐采纳：这是唯一能让模型把它当作用户本人的话的途径；代价是这一条依赖 herdr，且是经终端输入而不是官方接口。
5. **不做 PATH 垫片。** 内嵌模式的 Codex 不用一个假的 `codex` 去兜，接受这个限制并在文档里写明。推荐采纳：垫片要原样透传别的工具传来的参数，容易坏，而且正是"换了命令"的另一种形式。
7. **接手时还原启动环境里的密钥类变量**（§4.7）。选项：只记变量名、接手时从主人的 shell 环境取（别名里临时设的会取不到）；或记值，0600 存在守护进程的状态目录里。推荐前者，取不到就在 chat 界面上说明并让主人自己重开。
