# 各通道里 agent 看到什么、输出怎么被处理

本文描述的是当前代码的实际行为（`examples/dev-gateway` 默认配置），不是规划。"已知缺口"一节列出还没做到的地方。

## 0. 和原生启动 harness 的共同点与差别

agents-io 启动的就是 harness 本体：Claude Code 通过 Agent SDK 拉起本机 `claude` CLI，Codex 拉起 `codex app-server`。模型、工具、CLAUDE.md / AGENTS.md、会话记录都和你在终端里直接运行时一样。差别只在 harness 外面三处：

1. **输入被包装、排队**：每条输入前加一行发送者说明（见 §1）。同一个人连发的几条由网关合成一轮，运行中插话走 steer。只有映射过的几个命令（`/steer`、`/interrupt`、`/approve`、`/deny`），TUI 的其他斜杠命令和交互不可用。
2. **权限和运行环境由配置决定**：宿主的 `Policy.plan` 为每轮选 harness 实例、模型和权限 profile。默认策略是主人放行、外部来源受限。harness 原本在终端里弹出的确认，改由策略自动处理，或推给人点按钮。
3. **输出由各通道重新渲染**：harness 产生的事件写进 session 日志，每个端按自己的档位重新画出来。harness 自己的 TUI 不参与。卡片上的状态、面板、图标都是渲染器加的，不是模型写的。

```
harness 事件 ──▶ SessionLog（seq）──▶ Compositor（读全量，按通道档位折叠成 RenderedMessage + ProgressView）──▶ 通道适配器
                       └──────────▶ Hub.subscribe(tier)：终端 attach 等订阅端直接看事件流
```

**回复只回到来源**：一轮的正式回复只投递到发起它的那个路由。在飞书里发起的轮次，回复只出现在飞书；在终端发起的轮次，飞书不会收到。其他端想看，可以订阅同一个 session 的事件流。

## 1. agent 实际收到的输入长什么样

每条输入在发给 harness 前，前面加一行发送者说明，后面是转换过的内容块：

```
[agents-io input from=lark-bot:on_bc38… kind=human via=lark-bot:default:oc_7a1… channel=lark-bot conversationKind=dm conversationId=oc_7a1… senderName=张三 sentAt=1791… reply=card markdown=basic maxChars=4000 buttons=yes media=image,file,audio]
列出当前目录下的文件，然后用一句话总结
```

（Codex 上这一行以 `[sender …]` 开头，字段相同。）

- `from`：宿主策略认定的主体。认不出的发送者是 `unknown`。
- `kind`：`human`、`agent`、`channel_event` 等。
- `via`：来源路由，格式为 `通道:账号:会话[:线程]`。
- `declared`：只有发送账号可信、且通过适配器控制的元数据表明身份时才出现，消息正文里的自称不算。
- 后面的 `key=value` 来自适配器提供的上下文（如邮件主题、发送者名字），网关自己的字段同名时以网关为准。
- `senderName`：适配器给出的发送者显示名（飞书经通讯录解析，邮件取 From 里的名字），拿不到就没有这一项。
- `reply`：这一轮的回复会怎么显示，由网关按渲染该路由的通道能力和档位生成，适配器不能伪造。格式固定为
  `reply=<档位> markdown=<none|basic|full> maxChars=<数字> buttons=<yes|no> media=<可发送的媒体类型，逗号分隔|none>`，
  例如飞书 `reply=card markdown=basic maxChars=4000 buttons=yes media=image,file,audio`，邮件 `reply=final markdown=none maxChars=100000 buttons=no media=none`。
  档位含义：`card` 是一张边做边更新的卡片（含过程），`final` 是一轮结束后只发最终答案。`media` 只说明通道能发什么，不代表 agent 已经有发送工具。没有回复路由（只记录）的输入不带这一项。

网关有一个按内容寻址的 blob 存储（默认 `<dataDir>/blobs`，目录 0700、文件 0600，单个默认上限 20MB，配置项 `blobs.dir` / `blobs.maxBytes`），所有通道都能往里存附件，引用形如 `sha256:<hex>`。两个 harness 都通过它读图片和文件。

内容块的转换方式：

| 内容块 | agent 看到的 |
|---|---|
| text | 原文 |
| quote | 每行加 `> ` 的引用（飞书里是被回复消息的原文，见 §2） |
| transcript | `[说话人 mm:ss-mm:ss] 文本` |
| image | `sha256:` 引用（已存进网关的 blob 存储）：Claude 收到真正的图片块（超过 3.75MB 的不内联，给出原因）；Codex 收到 `localImage`（本地文件路径）。平台引用（如下载失败时的 `lark-file:`）显示为一行"未显示"的说明 |
| file / audio | `sha256:` 引用：Claude 收到 `[file 名称 类型 at 本地路径]`，Codex 收到 `[file 名称 (类型) at 本地路径]`（语音给 Codex 的是 `localAudio`），agent 可以用自己的工具读这个文件。平台引用只显示 `[file 名称 类型 引用]`，内容不读取 |
| ref | `[ref "标题"] 链接` |
| event（卡片点击、会议邀请等） | `[event 名称] JSON`，超过 4000 字符截断 |

## 2. 飞书 / Lark 机器人（`channel/lark-bot`，档位 `card`）

### agent 能看到什么

| 场景 | 处理 |
|---|---|
| 私聊机器人 | 主人：触发一轮。默认配置 `ownerSessionKey: "main"`，主人的私聊都进 session `main`。陌生人：丢弃 |
| 群里 @ 机器人 | 主人：触发一轮。非主人：只记录，不开轮 |
| 群里不 @ 机器人 | 只记录（observe），不开轮。需要 `im:message.group_msg` 权限才收得到 |
| 文本 | 原文。@机器人 被去掉，@其他人 变成 `@名字` |
| 富文本（post） | 拍平成文字，里面的图片、文件变成引用 |
| 图片 / 文件 / 语音 / 视频（含富文本里的图片） | 用 `im.v1.messageResource.get` 下载进 blob 存储，变成带真实类型和文件名的 `sha256:` 引用（类型取响应头，没有就按文件头识别；语音默认 `audio/opus`，视频 `video/mp4`）。单个上限 20MB（`mediaMaxBytes`），30 秒超时（`mediaTimeoutMs`）。下载失败、超限或没有 blob 存储时保留 `lark-file:` 引用，并在后面加一行 `[image 键 not downloaded: 原因]` 说明 |
| 回复某条消息 | 前面加一个引用块：用 `im.v1.message.get` 取回被回复的消息，拍平成文字（卡片取它显示的文字，图片文件变成 `[image]`、`[file 名称]`），最多 500 字（`quoteMaxChars`），按消息 id 缓存。被回复的是本机器人发出、且记录过发送身份的消息时，引用块带 `declared`。取不到时退回只有消息 id 的空引用块 |
| 卡片按钮 | 审批按钮变成 resolve 命令，"停止"按钮变成 interrupt 命令，都不会作为文字发给 agent；其他按钮变成 `[event action] …` |
| 其他消息类型（表情包、分享卡片等） | `[unsupported 类型 message]` |

飞书事件不带发送者名字，适配器用 `contact.v3.user.get` 按 union_id / open_id 查显示名（需要 `contact:user.base:readonly`，`messaging,contact` 预设已包含），缓存 6 小时，查不到的 10 分钟内不再查。查询失败时说明行里没有 `senderName`，agent 只知道身份 id。机器人发送者不查。

下载、取引用原文、查名字都要走网络。它们在事件确认的时限内进行：超过 `ackTimeoutMs`（默认 2.5 秒）先向飞书确认事件，处理在后台继续，完成后再交给网关。同一个会话的消息排队处理，所以慢的下载不会让后面的消息先到；代价是后面的消息要等前面的下载结束（最多 `mediaTimeoutMs`）。选择"确认后再下载"而不是"先存平台引用、用到时再取"，是为了让会话日志里只出现网关自己的 `sha256:` 引用，harness 不需要知道飞书的接口。

### agent 的输出怎么处理

- **回复卡片（CardKit 流式卡片）**：一轮开始就出现，依次是：
  - 状态行；
  - 答案，用打字机效果流式写出，约 600ms 刷新一次；
  - 计划，以及过程面板（只在思维链气泡不可用时出现），约 1.5s 刷新一次；
  - 运行中的"停止"按钮，以及需要人批准时的"允许 / 拒绝"按钮；
  - 结束后底部显示耗时和工具调用次数，标题颜色表示状态（绿：完成，红：失败，灰：中断）。
- **思维链气泡**（`process: auto` 时，可用就用）：在回复卡片上方，用飞书原生的思考界面展示思考过程（Claude 的 thinking、Codex 的 reasoning 摘要，摘要的每一段之间空一行）和每次工具调用的标题，结束后停止转圈。气泡可用时，回复卡片不再重复展示过程面板。
- **Markdown**：按飞书卡片支持的子集渲染，不支持的写法会退化成普通文字。
- **超长答案**：结束后拆成后续卡片继续发，不会切断代码块。
- **展示时被截断或省略的内容**：
  - 面板只保留最近 8 条，每个面板不超过 3000 字；
  - 工具输出只显示预览，出错时才显示；
  - 不显示 diff 和 token 用量。
- **装饰**：`config.style` 可选 `emoji`（默认，带状态和面板图标）或 `plain`（只用文字，状态由标题颜色表示）。
- **降级**：流式更新失败时退到整卡替换，再失败退到普通消息编辑。失败记录按会话保留 30 分钟，权限类错误对整个应用生效。

## 3. 邮件（`channel/mail`，档位 `final`）

### agent 能看到什么

- 正文第一行是 `Subject: 主题`，下面是正文。
- 引用的历史邮件（`>` 行、"某某写道："之后的部分、Outlook 头部块）被剥离成一个截断的引用块，只保留新写的内容作为正文。
- 附件存进网关的 blob 存储，变成 `file`（图片类型是 `image`）块，带 `sha256:` 引用、类型和文件名，agent 按 §1 的方式拿到。超过 blob 上限或存储失败的附件保留 `mail-attachment:<uid>/<序号>` 引用，后面加一行 `[attachment 名称 (类型, 字节数) not stored: 原因]`。HTML 正文里内嵌的图片不算附件。
- 自动回复、退信、群发（`Auto-Submitted`、`Precedence: bulk`、`MAILER-DAEMON`）直接丢弃。
- 身份证据：只有发件域的 DKIM/DMARC 对齐通过才算 `dkim_pass`，否则是 `none`。认不认这个人，由宿主策略决定。
- 自己发出的邮件回流时只记录不触发，`declared` 只在 Message-ID 是我们发出的那封时才采信。

### agent 的输出怎么处理

- 一轮结束后才发一封回复邮件，只包含最终答案，看不到任何过程。
- 回复带正确的 `In-Reply-To` / `References` 和 `Re:` 主题，留在原邮件线程里。
- 正文同时发纯文本和简单 HTML。
- 需要人批准时，只用文字列出待批事项，没有按钮，也还没有审批链接。
- 发信按 operationId 幂等：同一次投递重试不会发出两封。

## 4. 终端（`aio-dev attach`，本地 socket，档位任选）

### agent 能看到什么

- 你输入的每一行都是一条文本输入。
- 身份是配置里的本地主体，默认就是主人，所以和飞书私聊进的是同一个主体、同一个 session（`main`）。
- 可用命令：`/steer`、`/interrupt`、`/approve <id>`、`/deny <id>`、`/sessions`。

### 输出怎么处理

- 终端不是渲染器，是订阅端：它直接按所选档位显示事件流。
- `full` 档能看到全部事件：文字增量、每次工具调用的输入摘要和结果预览、计划、审批请求及其 id。
- 断线后用 `--from <seq>` 重连，持久事件一条不丢。
- 在终端发起的轮次，回复路由是本地，不会推到飞书。

## 5. 私有通道（`channel/jsonl-bridge`）

- **agent 看到什么**：完全取决于私有适配器发出的入站信封，经过 §1 的同样转换。
- **输出怎么处理**：适配器收到 `RenderedMessage`，其中包含 `progress`（结构化过程视图），以及它在 hello 里声明过的方法（edit、finalize 等）。能渲染到什么程度，由适配器自己决定。
- **档位**：由配置决定。

## 6. 已知缺口

| 缺口 | 影响 |
|---|---|
| 还没有输出工具 | agent 不能主动发文件、发选项按钮、@人，也不能发到别的会话（规划中：宿主 MCP 输出工具）。`reply` 里的 `media` 只是通道能力 |
| blob 存储不清理 | 存进去的附件一直留在 `<dataDir>/blobs`，没有过期和容量回收 |
| 确认后才下载 | 飞书事件确认后、交给网关前进程崩溃，这条消息会丢（飞书不会重发已确认的事件） |
| 有些飞书资源取不到 | 合并转发里的子消息、卡片里的图片、表情包，平台接口不支持下载，agent 只看到引用和说明 |
| 引用卡片时带着过程文字 | 回复机器人的卡片时，引用里除了答案还有状态行和过程面板的文字（在 500 字内截断） |
| Claude 收到的文件只是路径 | PDF、文档不会作为文档块内联，agent 要自己用工具读；大于 3.75MB 的图片不内联 |
| 邮件审批没有链接 | 邮件端无法完成审批 |
| 网关重启时的思维链气泡 | 重启前没结束的气泡会一直转圈 |
