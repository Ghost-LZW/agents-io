# 运维与安全视角的对抗性评审（ops-security）

评审对象：`docs/design/event-sourced.md`（下称 ES）、`docs/design/thin-bridge.md`（TB）、`docs/design/human-ux.md`（HX）。
依据：三份设计原文、`docs/research/*.md`。没有源码佐证的判断标注【推测】。

先说结论：三份方案的 IO 形态（日志、订阅、单写者 lane）大体是对的，分歧主要在协议厚度。但三份都把安全问题收窄成了一件事：给审批按钮加门禁。几个真正会出事的地方，三份都写得不够或者没写：

1. 信任按单条输入标注，上下文和执行权限却是整个 session 共享的；
2. 身份断言可以伪造，包括私有适配器、邮件 From、语音；
3. runtime 或网关崩溃后的重放会造成副作用重复；
4. 所有 runtime 子进程都挂在网关进程下，一次部署就杀掉全部在跑的长任务。

---

## 1. Prompt injection：信任挂在输入上，但上下文和权限挂在 session 上（三份都有，致命）

### 1.1 进程级权限不等于 turn 级权限
- 三份都给输入打了 trust 标签（ES 的 `PrincipalRef.trust/permissionClass`，TB 的 `Trust = 'owner'|'member'|'guest'|'peer'`，HX 的 `TrustLevel`）。限制只作用在两件事上：能不能 steer、能不能审批。
- 实际的执行权限是 **runtime 进程或 thread 级**的。Claude 的 `--permission-mode` 和 `--permission-prompt-tool`、Codex 的 approvalPolicy/sandbox 都在启动或 thread 层设定。ES 的 `RuntimeBinding.permissionMode:'ask'|'auto'|'bypass'` 也按 binding 设，不按 turn 设。
- 结果是：guest（邮件陌生人、会议里任意发言者）的一条 `queue` 输入成为下一个 turn 后，这个 turn 以 session 的权限运行。TB 规定"guest 只能 queue"，但 queue 只决定排队位置，不限制这个 turn 能做什么。
- 三份都没有回答：guest 输入触发的 turn，`turn.owner` 是谁？这个 turn 的审批由谁批？如果 owner 默认是 session owner，那就是权限借用，而且正是三份都声称禁止的那种。
- 需要补的规则：turn 的有效权限 = 所有被合并输入的 trust 下界。低信任 turn 要么换到受限的 runtime 实例（另一个 sandbox/profile 的进程或 thread），要么每个 tool call 都强制走审批，且只能由 owner 审批。

### 1.2 上下文污染是持久的
- 注入文本一旦进入 Claude 的 transcript 或 Codex 的 rollout，之后所有 owner turn 都带着它。三份都说"runtime 拥有上下文"（ES 风险 2、TB 的"runtime 权威 transcript"），同一个原则也意味着网关**没法把 guest 内容撤回**。
- ES §6 和 HX §2.1 默认把私聊汇进 `agent:<id>:main` / `principal:<id>:main`，再加上 identityLinks 跨通道合并。邮件属于类私聊通道，一旦被链到同一个 principal，陌生人邮件就进入了 owner 的主 session 上下文。这是最危险的默认值。
- 建议：低信任来源（邮件、会议转写、群聊非 owner、`channel_event`、私有通道外部事件）**默认进隔离 session**。只允许通过摘要或 `ref` 指针把内容拉进主 session，而且拉取动作由 owner 触发（ES 的 `ContentPart.ref` 已经有指针形态，可以直接用）。

### 1.3 `trusted=false` 包裹只是提示，不是边界
- TB §9 用 botmux 的 `<botmux_external_event trusted="false">` 包裹 guest 内容，ES 的 `channel_event` 注释也写了"不可信，trusted=false"。这只是给模型的提示，挡不住注入（botmux 自己的安全也靠沙箱和 bypass 加 hook 兜底，见 research/botmux.md:196）。
- 要靠的是 1.1 里说的权限下界和隔离 session，不能靠标签。

### 1.4 宿主工具是外泄通道
- 三份都提供 agent 主动跨端输出的工具：ES 的 `send_to`，TB 的 `send`，HX 的 `send_card/send_email/speak/handoff`。三份都说"路由由宿主推导"，但都只解决了 **runtime 不能伪造 route**，没有解决**被注入的 agent 合法地把数据发到合法但错误的目的地**。
- HX 的 `send_email` 如果收件人可以任填，就是现成的外泄通道。`handoff({to})` 由 agent 主动发起（HX §2.2 第 1 条），被注入后可以把 session 订阅到一个群里。
- 规则应该是：外发目的地只能是 turn 的 replyRoute 或 owner 预先登记的路由；跨 principal、新地址都必须经 owner 审批；工具调用要带 `trustedCaller`，并剥离模型自己写入的同名键（botmux 已有做法，research/botmux.md:160）。

### 1.5 审批 preview 本身就是注入面
- ES 只做字符层的消毒：剥离不可见字符和 bidi、首尾截断、遮蔽凭据（来自 Claude Channels relay）。preview 来自模型生成的 tool input，被注入的 agent 可以构造一个**语义上无害、实际有害**的命令。例如 preview 截断后只剩开头的 `git status && ...`，后面的内容被截掉。
- 首尾截断在 IM 卡片上恰好会藏掉中间的危险部分。卡片应显示完整命令的风险摘要（是否写文件、是否联网、是否用 sudo），并给出全文链接。

---

## 2. 身份映射：谁在断言身份（致命）

- **私有通道适配器可以伪造 Origin。** ES 的 `ChannelContext.submit(cmd: InputCommand)` 接收的 `InputCommand` 自带 `origin: Origin`，其中 `{kind:'human'; principal: PrincipalRef; via}` 由适配器填写。进程外私有适配器就能断言自己是"飞书上的 owner"。
  - 必须由网关盖章：适配器只能提交本命名空间内的 channelUserId（`acme-im:*`），principal 解析和 trust 由 Ingress 按配置计算，并为每个适配器设 trust 上限（私有适配器的 `verified` 需要单独授权）。
  - TB 的 `Inbound.sender.trust` 和 HX 的 `sender.trust` 同样写在适配器发出的信封里，问题相同。
  - openclaw 明确规定"插件不要自己预先算 allowlist，交给 core 统一计算"（research/openclaw-channels.md:378），三份设计都没有把这条写成硬规则。
- **邮件 From 可以伪造。** 三份都没提 DKIM/SPF/DMARC 校验。HX 计划把"邮箱"写进 identity link（§2.1），ES 的邮件审批用签名链接。未校验的 From 加上 identity link，就是冒充 owner。
  - 校验通过的邮件最多算 `asserted`，永远不能算 `verified`，也不能 steer 或审批。
- **语音没有说话人身份。** 小米音箱只能确认设备，确认不了是谁在说。电视、孩子、访客都能对它下指令。
  - ES 的 narration tier 包含 `request.*`（"语音可答"），TB 允许"口头只允许 allow once 或 deny"，HX 让语音的默认 queue mode 为 steer。这意味着屋里任何人都能 steer 一个正在跑的编码 turn，还能口头批准一次工具调用。
  - 声纹或口令都不可靠【推测】。建议语音默认只能 queue、interrupt 和查询；审批一律转到已认证的端（推送飞书卡片），语音只负责念出"请到飞书上确认"。
- **会议唤醒词由谁说都行。** ES 和 HX 都设计成"被点名或唤醒词就 dispatch"，ASR 不带认证，会议里任何参会者（包括外部嘉宾）都能触发 dispatch。dispatch 的权限应绑定会议发起人或白名单里的说话人（飞书能否把转写的 speaker 映射到 open_id，调研没覆盖，这一点【推测】），否则只能以 guest 身份进入隔离 session。
- **飞书 ID 有作用域。** open_id 按应用区分，跨应用要用 union_id（botmux 的 trustedCaller 同时注入了 `requestUserOpenId` 和 `requestUserUnionId`，research/botmux.md:160）。如果部署多个 bot 应用，identityLinks 必须以 union_id 为键，否则同一个人会被识别成两个 principal，或者被错误合并。三份都没提。
- **合并错误必须可撤销。** HX 风险 4 承认"身份合并错了就是越权"，但没给出撤销流程。合并之后，同一 principal 名下已经汇聚的 session 历史无法拆开（见 1.2）。

---

## 3. 审批 UX 与审批安全

- **resolve 时必须在服务端重新校验 eligible。** 飞书卡片按钮的回调携带点击者的 open_id。群里的审批卡对所有群成员可见，也都能点。ES 有 `eligible: PrincipalSelector`，但没写清楚 resolve 时要在服务端重新校验 `by` 是否属于 eligible。
  - TB 的 `ClientCmd.resolve` 根本**没有 by 或 origin 字段**，`interrupt` 也没有，只能靠连接身份。私有适配器调用 `ctx.resolve(sessionId, requestId, choice)` 时，无法证明是谁点的按钮。
- **签名链接会被扫描器自动点击。** ES 的邮件审批用签名链接。Outlook Safe Links 这类企业邮件网关会预取链接（按我的理解它们会发 GET 请求，但未在调研中核实）。链接上的 GET 必须是幂等且只读的，审批必须登录 Web 后 POST 确认。ES 写的"signed links that complete on Web"方向对，但要明确 GET 不能产生任何副作用。
- **`allow_session` 不该出现在低信任端。** ES 和 HX 的 Decision 都有 `allow_session`。IM 卡片上一个按钮就能授予整个 session 的持久权限，而群卡片可能被别人点到。`allow_session` 应限定在 Web 或私聊端，并且只给 owner。TB 只在语音端禁止了 always，IM 端没有限制。
- **挂起的审批会卡住 lane。** Codex 的 requestApproval 和 Claude 的 `can_use_tool` 都会阻塞当前 turn。turn 卡住，lane 就卡住，所有端排队的输入都等着它。ES 引用 openclaw 的"超时即 deny"，但没给超时数值，也没说超时后队列怎么处理。TB 和 HX 都没写超时。
  - 夜里发起的长任务停在一个审批上，第二天早上所有通道都没有响应。需要两样东西：可配置的 `expiresAt`（默认短一些，比如 10 分钟，超时 deny），以及"审批挂起期间允许 interrupt 并清空队列"。
- **Codex 原生客户端会绕过网关的审批门禁。** research/codex.md:119 写明 `replay_requests_to_connection_for_thread`：新连接会收到挂起请求的重放。
  - ES 和 TB 都让 `codex --remote` TUI 挂在同一个 thread 上，TUI 就能直接批准请求，完全绕开 eligible selector。ES 的 `--ws-auth` 只解决了"哪个本机进程能连"，解决不了"谁能批"。
  - TB 还允许 TUI 直接写入（"sender native-tui"），这是一条绕过 lane、trust 和审批的写路径。HX 要求 TUI 只读，这是对的，但 Codex 协议层面能否强制只读，三份都没有核实【推测：大概率不能，只能靠不给 TUI 凭证】。
- **first-wins 的竞态反馈。** 迟到的点击必须给点击者明确反馈（"已由 X 在 Y 端批准"），否则用户会以为自己批的生效了。ES 有 `retractRequest`，但飞书卡片的撤卡也受限流约束（见第 5 节），撤卡失败时旧按钮还在。

---

## 4. 多端并发输入

- **Claude 的 priority 默认值就是 steer。** research/claude-code.md:40 写明 `next` 是**默认值**。适配器在 turn 运行中写入 SDKUserMessage 时，如果漏设 priority，消息就被当作 steer 并入当前 turn，"权限不借用"随即失效。
  - 规则：适配器每次写入都必须显式设置 priority，queue 一律用 `'later'`，或者等 `result` 之后再写。TB 写了 queue 用 `'later'`，但没有写成"必须显式设置"。
- **ES 把 `'now'` 当成 interrupt 是错的。** ES 写的是 "'now' for interrupt-and-read"，但 research 原文说 `now` 是"把当前工作挪到**后台**、立刻读"。当前工作并没有停止，副作用会继续发生。用户说"停"时，必须走 `control_request interrupt` 或 `turn/interrupt`，不能用 `'now'`。
- **HX 的版本号用错了地方。** HX 写"Claude 在 v2.1.286 以上可以用 priority='next'"，research 里 v2.1.286 是 `'now'` 的门槛，`'next'` 是默认行为。ES 也承认这个版本号未核对。
- **interrupt 没有授权。** 三份都没规定谁能 interrupt。群里任意成员 `/break`，或者语音里一句"停"，就能打断 owner 的长任务，一条消息就能完成一次 DoS。interrupt 应与 steer 同级授权，跨 principal 的 interrupt 只给 owner 或 turn.owner。
- **ES 的 collect 有放大风险。** 500ms 防抖、上限 20 条。群里刷屏能把 20 条低信任消息合并成一个 turn。合并后的 trust 下界规则（见 1.1）是必须的。TB 去掉 collect 是对的。
- **两端同时输入时的可见性。** 三份都有 `input.accepted` 或 `input.admitted` 广播，这点不错。ES 区分了 admitted 和 consumed，这对于"我的插话到底生效没有"是必要的，TB 和 HX 缺这一步。

---

## 5. 背压、限流与飞书配额

- **只限单卡速率不够。** 三份都提到 CardKit 单卡 10 QPS、30KB、10 分钟，只有 HX 风险 1 提到"全局限流"。飞书还有应用级和单群级的 API 速率限制（我记得发消息大约是单群每秒几条，确切数值【推测】，需要查开放平台文档）。
  - 一个群里同时跑 3 个 turn，加上续卡、撤卡和审批卡，会一起撞上群级上限。需要网关级的 token bucket，按租户、应用、群、卡片分层，并且要有优先级：审批卡和撤卡 > final > progress。被限流时先丢 progress。
- **origin 订阅不能丢帧。** ES 的 `obligation: origin` 不能 dropIfSlow，但 progress 帧在其中应该能合并。要明确：有义务的只是 final 和 request，progress 是可合并的累积全量。botmux CotEntry 的累积全量思路正好适用，ES 提到了，TB 也采用了。
- **TB 的日志写入会反压到 runtime。** TB 把 `text.delta` 写进 SQLite，等 turn 结束再压缩。每个 token 一次 INSERT（加上 fsync），而 runtime 的 stdout 必须持续读走（multica 的死锁记录，三份都引用了）。SQLite 写入一旦变慢，就会反压到读循环，最后导致 Claude 进程阻塞。
  - ES 把 delta 放进内存环、标记为 ephemeral，这个处理更对。TB 应该照做。读循环和持久化之间要有有界队列，满了就合并 delta，不能阻塞读循环。
- **慢订阅者与输出体积。** Web 的 full tier 包含 `command_output` delta。`npm install` 这类命令的输出很大，Hub 必须按订阅者设字节预算，超出就截断并带上 `resultTruncated` 标记。

---

## 6. 崩溃、恢复与重放（致命）

- **网关部署会杀掉所有 turn。** 三份都让网关直接 spawn `claude -p` 和 `codex app-server` 子进程。网关重启（部署、OOM、panic）时子进程也跟着死，所有在跑的长任务中断。
  - research/claude-code.md:170 写明：SIGTERM 会留下未完成的 turn，而 `CLAUDE_CODE_RESUME_INTERRUPTED_TURN=1` 会在续接时**重跑**这个 turn。重跑一个已经 `git push` 或发过邮件的 turn，副作用就会重复。
  - 需要把 runtime 宿主拆成一个独立的、可以重连的 daemon（botmux remote-runner 的 `reattach` 思路），网关重启不能波及 runtime 进程。如果坚持单进程 MVP，就必须明确禁止自动重跑，并把 `turn.completed{status:'ambiguous'}` 当作一等结果。ES 和 HX 有 ambiguous 状态，TB 的 `result.status` 里**没有 ambiguous**。
- **input 已提交、consumed 未写时崩溃。** 网关把输入写进 runtime 的 stdin 后、写下 `input.consumed` 之前崩溃。重启后如果按日志重新提交，就会重复输入。
  - 需要用 runtime 侧的幂等键对账：Claude 的 `SDKUserMessage.uuid` 配合 `--replay-user-messages` 回显；Codex 的 `clientUserMessageId`（TB 提到了，ES 和 HX 没有）。恢复流程是：先读 transcript 或 rollout，确认最后一个被消费的 inputId，再决定哪些需要重放。三份都没写这个恢复流程。
- **runtime 崩溃后的审批卡。** control_request 随进程消失，飞书卡片上的按钮却还在。点击后 resolve 找不到对应的请求。需要 `request.resolved{by:'runtime_cancelled'}`（ES 有这个枚举）并且主动撤卡。TB 和 HX 没写这个流程。
- **工具执行一半时崩溃。** 文件改了一半、命令进程变成孤儿。需要清理进程组（multica 踩过这个坑，TB 提到了），并且下一个 turn 开头要注入一条"上次中断、状态未知"的说明（ES 的 multica ResumeContinuityNotice）。
- **outbox 里的 unknown 状态。** 三份都写"unknown 不自动重放"，于是用户可能永远收不到答复。
  - 飞书的发消息接口支持请求级 `uuid` 去重（openclaw 的 CardKit 更新带 `uuid` 幂等，research/openclaw-channels.md:282；发消息接口的 `uuid` 去重窗口约 1 小时，这一点【推测】）。可以在窗口内用同一个 uuid 安全重试，用 provider 侧的幂等把 unknown 收敛成确定结果，而不是放弃。
- **通道掉线。** 飞书长连接断开时：ingress 有 dedup（ES 写了 20 分钟 TTL），但断线期间丢失的事件需要补拉（飞书事件推送有重试机制，【推测】），outbox 要能暂停并恢复。三份都只有 supervisor 退避重连，没有"通道掉线期间的 final 怎么补投、要不要切换到备用端"的设计。

---

## 7. 长任务

- 飞书卡片 10 分钟流式上限需要续卡，三份都有。但一个 2 小时的任务会续出十几张卡把群刷屏。应该在长任务时降级：只保留一张 headline 卡定期编辑，细节放进 Web 链接。
- Codex 的 thread 在 30 分钟没有订阅者时会卸载，ES 和 TB 都让 adapter 一直保持订阅，这意味着每个活跃 thread 都长期占用一个 app-server 进程。Claude 的常驻进程也一样。没有任何一份写空闲回收策略：每个 session 一个 Node 进程，加上 MCP 子进程，内存会线性增长。需要 LRU 回收，回收后靠 `--resume` 或 `thread/resume` 恢复。
- 长任务期间，Web trace 深链的有效期、权限和撤销没有设计（见第 8 节）。

---

## 8. 数据安全与可见性

- **群卡片的可见性按群算，不按成员算。** 群卡片里的工具时间线、命令和输出预览，所有群成员都能看到，包括外部成员。订阅 ACL 管的是"哪个端能订阅"，管不了"端内谁能看到"。群端默认应该用 final 或只显示 headline，工具细节只放进需要登录的 Web 页面。
- **深链必须鉴权。** 卡片里的 `/s/<key>?turn=<id>&trace=1` 必须登录并校验 principal 是否属于该 session，否则卡片被转发后链接就是一个泄露口。
- **日志里存着工具输出。** 文件内容、env 里的密钥、`cat .env` 的结果都会写进日志。三份都靠"源头脱敏"，而基于正则的脱敏一定会漏。日志需要静态加密、设置保留期，raw blob 也要设 TTL（ES 和 HX 写了 TTL）。HX 的"用小模型改写 headline"会把内容发给另一个模型服务，属于额外的数据出境点。
- **ES 的 `visibility: internal` 方向对，但要强制。** 在 Hub 出口做白名单，不能依赖各 projector 自觉标注。

---

## 9. 成本

- **会议 observe_only 会让上下文膨胀。** Claude 没有"注入但不开 turn"的接口（Codex 有 `thread/inject_items`，ES 自己标了推测）。Claude 侧的 observe_only 要么不进上下文，要么每个转写块开一个 turn。前者让"会议上下文"失效，后者会让成本爆炸。HX 风险 8 说"先摘要再注入，策略待定"，但这是会议功能能不能成立的前提，不应该留到 M6 再定。
- **实时语音前台按时长计费。** gpt-realtime 按音频时长计费，音箱前台如果常开或者等待时间长（等后台 turn 时还在播报 narration），成本不低。需要空闲挂断，等待期间只用 TTS 模板，不让 realtime 模型持续生成。
- **HX 的 headline 小模型每 2 秒改写一次**，每个 narration 订阅都会额外产生一次 LLM 调用，应该只在有新 activity 时触发。
- **没有跨 session 的配额调度。** Claude 的订阅或 API 速率限制（`rate_limit_event`）和 Codex 的 `account/rateLimits/updated` 都是账号级的。多个 session 并发时会互相挤占，三份都只在 session 内串行，没有账号级的并发上限和公平调度，也没有预算熔断（比如单 turn 的 `total_cost_usd` 超过阈值就 interrupt）。

---

## 10. 各方案的专属问题

### TB（thin-bridge）
- MVP 第 3 步写着"先用 bypassPermissions 跑通"，第 5 步接飞书。如果顺序按此执行，飞书群消息就能在宿主机上执行任意命令。审批或者 `--permission-prompts none`（v2.1.259 以上，无人值守时直接拒绝，research/claude-code.md:59）必须在任何外部通道上线前到位。
- `ClientCmd.resolve` 和 `interrupt` 没有 origin；`result.status` 没有 ambiguous；`text.delta` 写进 SQLite；允许 TUI 直接写入。这四点都是本评审里的硬伤。
- 优点：没有 collect、guest 只能 queue、口头不授予 always、显式绑定否则沉默（"未绑定的群一律沉默"）。这四个默认值是三份里最保守的。

### ES（event-sourced）
- `ChannelContext.submit` 接受适配器自填的 `Origin`，是身份伪造入口，必须改成网关盖章。
- 默认合并私聊到 `agent:<id>:main`，配合 identityLinks 和邮件，是上下文污染的最大入口。
- 把 `'now'` 当成 interrupt 是语义错误。
- 优点：admitted/consumed 分离、eligible selector、超时即 deny、`runtime_cancelled`、delta 不落盘、`visibility: internal`、ambiguous 状态。运维语义最完整。
- 缺点：组件多（Sequencer、Hub、outbox、compositor、snapshot、epoch），单人维护时容易变成 openclaw 那样的复杂度（ES 自己列为风险 9）。

### HX（human-ux）
- 语音和 IM 默认用 steer，加上语音没有说话人认证，是最激进的默认值。
- `handoff` 可以由 agent 主动发起，`send_email` 是宿主工具，外泄面最大。
- "审批不能被任何 profile 吞掉、广播给所有能审批的端"，加上群卡片，会放大被误批的面。
- priority 的版本号写错。
- 优点：M0 阶段审批默认 deny 但在事件流里可见；identity link 默认不自动合并、用配对码；TUI 只读；把 CardKit 限额列为第一风险并要求全局限流。

---

## 11. 推荐（与订阅加单写者 lane 的形态兼容）

1. 骨架用 ES，默认值用 TB，协议面以 TB 为起点逐步加厚。保留 ES 的 consumed、ambiguous、runtime_cancelled、ephemeral delta、eligible 和 visibility。
2. 新增硬规则：
   - (a) 网关给 Origin 和 trust 盖章，适配器只提交本命名空间内的 channelUserId；
   - (b) turn 的有效权限取输入 trust 的下界，低信任来源进隔离 session 或受限的 runtime profile；
   - (c) 所有 resolve 和 interrupt 都带 origin，并在服务端重新校验；
   - (d) `allow_session` 只在 Web 或私聊端、只给 owner；
   - (e) 语音和会议不能审批，默认只能 queue、interrupt 和查询；
   - (f) 外发目的地只能是 replyRoute 或 owner 已登记的路由；
   - (g) 适配器每次写入都显式设置 Claude priority。
3. 运维：
   - runtime 宿主做成独立的、可重连的 daemon，禁止自动重跑 turn；
   - 恢复时用 uuid 或 clientUserMessageId 对账；
   - 飞书分层 token bucket，按优先级出队；
   - 进程 LRU 回收；
   - 审批默认短超时，超时 deny；
   - 账号级并发上限和预算熔断。
4. 第一个外部通道上线前的门槛：审批流跑通（或 `--permission-prompts none`）、显式绑定、群聊默认 final 或 headline、深链鉴权。
