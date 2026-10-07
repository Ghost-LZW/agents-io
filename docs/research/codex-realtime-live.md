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
| 语音端委托 Codex 干活（V3 delegation） | **真人语音可以，`appendText` 不行**。`appendText(role: user)` 两次请求执行命令，100 s 内没有任何委托。真人在会里说话时（见下节），每句话都委托 |
| 关闭 | `thread/realtime/stop` → `thread/realtime/closed { reason: "requested" }` |

注意：ephemeral thread 不支持 `thread/read { includeTurns }`。

## 真人语音实测（2026-10-08 00:00，一人进会说话约 3 分钟）

时间线（秒，自脚本启动）：

```
 55.6  user  听见吗                          → 语音直接答（不委托）
 70.4  thread/realtime/itemAdded { type: handoff_request, input_transcript: "帮我用工具看看当前目录有什么文件,再告诉我现在几点", active_transcript: [...] }
 70.4  turn/started（不是客户端发起的 turn）
 74.0  assistant 好的,我这就看一下。          ← 语音先垫一句
 80.5  commandExecution ls -la；date
 82.3  agentMessage(final_answer) 当前目录是空的，没有文件。现在是北京时间 23 点 58 分。
 89.6  assistant …当前目录下有个文件叫 test.txt,现在是北京时间二十三点五十八分。   ← 转述错了
106.0  handoff_request "你跟我介绍一下我自己" → turn → 语音转述（这次准确）
141.4  handoff_request "可以喷吗" → turn
186.2  handoff_request "…要涂几次呀" → turn
192.2  handoff_request "你先闭嘴,GPT,你挂了吧"   ← 上一个 turn 还在跑：没有新 turn，并进了同一个 turn（相当于 steer）
202.4  Codex 想离会：读 lark-vc-agent skill、调 lark-cli，失败 → "没能替你退出会议；请手动挂断"
```

- 委托通知是 `thread/realtime/itemAdded`，`item.type = handoff_request`，带 `input_transcript`（这一句）和 `active_transcript`（语音端最近的对话）。随后 app-server 自己在 thread 上开 turn，客户端只会收到 `turn/started`。
- 几乎每句实质性的话都委托（连"可以喷吗"也是），从说完到听到答案约 10–20 s；语音端会先说"稍等我看一下"。
- **转述不可靠**：Codex 的答案是"目录是空的"，语音说成"有个文件叫 test.txt"。要紧的结果应该另外落成文字（发到会中聊天或 IM），不能只靠语音。
- 委托出来的 turn 带着 Codex 的全部工具：会里任何人都能让它在这台机器上跑命令（这次是只读沙箱、空目录）。
- 会控要给工具：Codex 收到"挂了吧"时没有离会的办法，只能去找别的 CLI。

## 对 agents-io 的含义

- live（实时语音）是 **harness 的能力**（目前只有 Codex），通道只提供"媒体对端"（一段 offer、一个收 answer 的地方、一个关闭信号）。网关在两者之间转 SDP，不碰音频。
- 语音挂在 **session 的 Codex thread** 上：语音端带着这个 session 的历史进会，文本 turn 和语音可以并行，会后同一个 thread 继续用文字聊。
- 要进 session 日志的：live 开始/结束、双方转写（`transcript` 块）、语音端委托出来的 Codex turn（不是网关发起的 turn，harness 适配器要能接住"外来 turn"）。
- 委托出来的 turn 是外来 turn：Codex harness 要把它们记成 session 的 turn，来源是 live（发起人是会中说话的人，没有主体），按 handoff 的 `input_transcript` 记输入。
- 会中要有 `live_leave` 之类的工具（agents-io 的宿主 MCP 工具对委托 turn 一样可用）。
- 待定：语音会话中途 daemon 重启怎么办（音频连接在 app-server 进程里，unix transport 的 app-server 若存活理论上不断）。
