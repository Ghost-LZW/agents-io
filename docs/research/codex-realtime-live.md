# Codex realtime v3 挂在 thread 上：live 会话探测

> 2026-10-07，codex-cli 0.160.1（ChatGPT 登录，pro），只探测，不实现。
> 对端：一个私有通道提供的 WebRTC 会议参与者（只有音频；它给 SDP offer，收 answer；下行是会场混音，上行就是会议麦克风）。
> 脚本：一次性脚本，不进库。时间线摘自运行日志。

## 结论

| 问题 | 结果 |
|---|---|
| WebRTC 对端是谁 | **codex app-server 本身**。`thread/realtime/start { transport: { type: "webrtc", sdp: <offer> }, version: "v3" }` 后，`thread/realtime/sdp` 通知给出 answer（ice-lite，opus 111）。网关只转交两段 SDP，**音频不经过 agents-io** |
| 能否挂在已有 thread 上 | 能。先在 thread 上跑一轮文本（"记住暗号蓝色企鹅"），再起 realtime，语音端被问"暗号是什么"时答出"蓝色企鹅。"（默认 `includeStartupContext` 带上 thread 历史） |
| 连通 | 约 6 秒后对端状态 `connected`，`remoteAudioTracks: 2` |
| realtime 期间能否跑文本 turn | 能。`turn/start` 正常 started/completed（"文字收到"），语音不断 |
| 文本 → 语音 | `thread/realtime/appendSpeech { text }`：让语音端把一段文字说出来（未实测，按 schema） |
| 往语音会话里注入上下文 | `thread/realtime/appendText { role: user\|developer\|assistant, text }`。user 角色的文本被当成一句话来回答 |
| 输出转写 | `thread/realtime/transcript/delta|done { role, text }`，assistant 一句一条 |
| 语音端委托 Codex 干活（V3 delegation） | **未观察到**。两次用 `appendText(role: user)` 请求"用工具执行 pwd / ls、date"，语音答"好的，我这就帮你跑一下"，但 40 s / 100 s 内没有任何 `turn/started`、`thread/realtime/itemAdded` 或 `item/*`。待用真人语音再测（可能只有音频输入才走委托，也可能要等更久或要 `codexResponseHandoffMode` 等参数） |
| 关闭 | `thread/realtime/stop` → `thread/realtime/closed { reason: "requested" }` |

注意：ephemeral thread 不支持 `thread/read { includeTurns }`。

## 对 agents-io 的含义

- live（实时语音）是 **harness 的能力**（目前只有 Codex），通道只提供"媒体对端"（一段 offer、一个收 answer 的地方、一个关闭信号）。网关在两者之间转 SDP，不碰音频。
- 语音挂在 **session 的 Codex thread** 上：语音端带着这个 session 的历史进会，文本 turn 和语音可以并行，会后同一个 thread 继续用文字聊。
- 要进 session 日志的：live 开始/结束、双方转写（`transcript` 块）、语音端委托出来的 Codex turn（不是网关发起的 turn，harness 适配器要能接住"外来 turn"）。
- 待定：委托是否可用（决定会中能不能让它"去查一下"）；语音会话中途 daemon 重启怎么办（音频连接在 app-server 进程里，unix transport 的 app-server 若存活理论上不断）。
