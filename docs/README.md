# agents-io docs 索引

agents-io 的 agent IO 层（多端输入 / 多端输出 / 过程可见 / 可扩展 gateway，runtime 直接用 Claude Code 与 Codex）调研、方案与评审。

**先读：[POSITIONING.md](POSITIONING.md)**：仓库定位与边界。agents-io 是输入输出基建，只提供机制；信任、审批、模型选择等策略通过钩子交给宿主（如 x-work-os）。

**动手跑：[E2E.md](E2E.md)**：`packages/daemon`（`aio`，`examples/dev-gateway` 的 `aio-dev` 是它的旧名包装）把全部包接进一个进程，本地两个终端、真实飞书、多端与重启的端到端测试。

**通道行为：[CHANNELS.md](CHANNELS.md)**：每个通道里 agent 能看到什么、它的输出怎么被渲染，以及和原生启动 harness 的区别。

**再读：[RECOMMENDATION.md](RECOMMENDATION.md)**：边界内的设计，包括对比表、问题解答、架构、核心类型、实时端处理、批评取舍和 MVP 路线（r1 已按定位修订）。

## research/：参考项目与原生协议调研

| 文件 | 内容 |
|---|---|
| [research/claude-code.md](research/claude-code.md) | Claude Code 嵌入面：`-p` stream-json、Agent SDK、Channels、Remote Control、cross-session、hooks、续接；priority/origin、`can_use_tool` |
| [research/codex.md](research/codex.md) | Codex app-server（Thread/Turn/Item、steer/expectedTurnId、多连接广播、审批 first-wins）、exec/SDK、ACP 对比 |
| [research/happyclaw.md](research/happyclaw.md) | happyclaw：Claude SDK runner、共享 `StreamEvent`、观察与投递分离、CardKit 流式卡、封闭的渠道集合 |
| [research/botmux.md](research/botmux.md) | botmux：飞书 ↔ 真实 CLI 进程桥、4 条输出通道、remote-runner 协议、MCP gateway、会议设计 |
| [research/openclaw-channels.md](research/openclaw-channels.md) | openclaw channel 侧：ChannelPlugin 契约、MsgContext、路由/session key、progress drafts、pairing/信任分级 |
| [research/openclaw-runtime.md](research/openclaw-runtime.md) | openclaw runtime 侧：harness、`AgentEventPayload`、Gateway WS 订阅、queue mode、实时语音 consult |
| [research/multica.md](research/multica.md) | multica：Task 统一输入、`agent.Message` 7 类事件、bus fan-out、IM Channel 注册表、supplement 注入 |
| [research/meeting.md](research/meeting.md) | 飞书会议：实时转写、视频（无官方接口）、会议文档、会中聊天、语音发声（需 realtime 权限，本租户未开放）；Codex realtime 接口与真机探测 |

## design/：三份候选方案

| 文件 | 视角 |
|---|---|
| [design/thin-bridge.md](design/thin-bridge.md) | 极简：最小信封 + `native` 透传，只自建带 seq 的日志和订阅 |
| [design/event-sourced.md](design/event-sourced.md) | 事件溯源：一切 IO 都是 session 日志上的读写，Sequencer 作为唯一写者 |
| [design/human-ux.md](design/human-ux.md) | 体验优先：从每个端的需求倒推，RenderProfile、headline、handoff |

## critique/：对抗性评审

| 文件 | 视角 |
|---|---|
| [critique/feasibility.md](critique/feasibility.md) | 可行性与事实核查：Claude 合批、音箱无音频通道、Codex TUI 不能只读、重启丢 turn |
| [critique/ops-security.md](critique/ops-security.md) | 运维与安全：trust 粒度、身份伪造、审批安全、崩溃重放、限流、成本 |
