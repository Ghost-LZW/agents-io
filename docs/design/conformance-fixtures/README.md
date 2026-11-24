# 一致性 fixture：录下的 harness transcript 与内核场景，都是数据

> 状态：已落地（2026-11-25，core-slimming G8，`docs/design/core-slimming/` §3）。格式取自 t3code 的录制回放（core-slimming §7.1，scoping 见 t3orch 提案 3），输入和断言也写成数据；匹配按端保持顺序、端与端之间不排序。

## 1. 是什么

两层 fixture，都是 NDJSON（一行一个 JSON 对象），文件里没有 TS：

| 层 | 是什么 | 谁来用 |
|---|---|---|
| L1 harness transcript | 一个 harness 线上来回的帧：适配器写出的（`expect_outbound`）、harness 发来的（`emit_inbound`） | 回放它就是一个假的 harness 进程（stdio），适配器在它上面跑；任何语言的适配器或内核都能 spawn 它 |
| L2 内核场景 | 往内核各端送什么（通道、客户端、宿主、日志）、各端应当看到什么 | 一个运行器照行执行；TS 的运行器在 `packages/testkit`，别的语言的内核写自己的驱动或运行器 |

文件都在 `packages/testkit/conformance/`（随 testkit 发布，`package.json` 的 `files`）：

| 目录 | 内容 |
|---|---|
| `transcripts/codex/` | 真实 Codex 0.171 的录制（`codex.app-server`）：`plain-turn`、`steer`、`approval`、`interrupt` |
| `transcripts/jsonl-harness/` | 内核场景用的 harness（`aio.jsonl-harness`）：`approval`、`queue-behind-turn`，手写 |
| `transcripts/acp/` | 真实 ACP agent 的录制（`acp`；Claude Code 的 ACP agent 0.110.1）：`plain-turn`、`permission`、`cancel`、`load` |
| `scenarios/kernel/` | 内核场景，由 `packages/kernel/test/scenarios.test.ts` 在没有模块的内核上跑 |
| `scenarios/attention/` | G7 的 attention fixture，同一场景格式（§3.6），由 `packages/session/test/attention.test.ts` 跑 |

代码：`packages/testkit/src/conformance/`（`match.ts` 匹配，`transcript.ts` 格式、录制与去本机值，`replay.ts` 回放，`transcript-harness.ts` 进程内的 bridge harness，`scenario.ts` 场景格式与运行器），`packages/testkit/src/transcript-replay.ts`（stdio 回放程序，bin `aio-transcript-replay`）；录制的接头在适配器包里：`harness/codex/src/record.ts` `recordTransport`、`harness/jsonl-bridge` 的 `HarnessBridgeOptions.record`、`harness/acp/src/record.ts` `recordStream`（`AcpHarnessOptions.record`）。

## 2. L1：harness transcript

### 2.1 格式

第一行是头，之后每行是下面三种之一（字段与 t3code 的 `ProviderReplayNdjsonRecord` 相同，没有别的键）：

```json
{"type":"transcript_start","provider":"codex","protocol":"codex.app-server","version":"0.171.0","scenario":"plain-turn","metadata":{"description":"…","model":"gpt-6-sol"}}
{"type":"expect_outbound","label":"turn/start","frame":{"id":3,"method":"turn/start","params":{"threadId":"<$thread-1>","input":[…]}}}
{"type":"emit_inbound","label":"turn/started","frame":{"method":"turn/started","params":{…}},"afterMs":0}
{"type":"runtime_exit","status":"success"}
```

- **方向按适配器看**：`expect_outbound` 是适配器（或 bridge 的宿主端）写给 harness 程序的帧，`emit_inbound` 是程序发来的帧，`afterMs` 是它在上一行之后多久发（可省，缺省立刻）；`runtime_exit`（`success` / `error` / `cancelled`，可带 `error`）是程序自己退出了。
- **`protocol`** 说是哪种线：`codex.app-server`（Codex 的 JSON-RPC，即 Codex 适配器的 `Transport` 上走的那些行）、`aio.jsonl-harness`（`@agents-io/protocol` `wire.ts` 的 harness bridge 帧）、`acp`（Agent Client Protocol v1 的 JSON-RPC，即 ACP 适配器的连接上走的那些消息，带 `jsonrpc: "2.0"`）。`version` 是 harness 的版本（Codex 从 `initialize` 的 `userAgent` 读出，ACP 是 `initialize` 答的 `agentInfo.version`，`metadata.agent` 是它的 `agentInfo.name`）。
- **`metadata`** 随意，下面两个键有意义：`match` 为 `exact`（缺省，录下的就是这样）或 `subset`（手写的：outbound 帧只写要紧的字段，§3.4 的规则）；`description` 说它是什么。
- **`label`**：给人看，也给 gate 用（§2.3）。录制时自动给：JSON-RPC 是 method，应答是它所答请求的 method；bridge 帧是 `type`，`result` 是它所答请求的 `type`，`event` 是 `event:<body.t>`。手写时可以起自己的名字（如 `finish-first`）。
- **帧里的占位符**与场景的相同（§3.4）：`"<$name>"` 是绑定，`"<any>"` 是任意值；占位符可以嵌在字符串里（`"<$workspace>/a.txt"`）。

### 2.2 录制与去掉本机的值

- **Codex**：`harness/codex/src/record.ts` 的 `recordTransport(inner, tap)` 包住适配器的 `Transport`，两个方向的每一行（解析后）交给 `tap`，别的不变。`harness/codex/scripts/record-transcripts.ts` 用它录 `harness/codex/test/transcript-scenarios.ts` 的四个情形：每个起一个一次性的 stdio app-server（从不连共享的 daemon），经真实的 `CodexHarness` 跑一遍。跑法：

  ```sh
  CODEX_HOME=<有模型提供方的 Codex home> node --experimental-transform-types \
    --disable-warning=ExperimentalWarning --import ./scripts/source-loader.mjs \
    harness/codex/scripts/record-transcripts.ts [情形…]
  ```

  模型是情形自己的 `run.model`（`gpt-6-sol`）；`AIO_RECORD_OUT` 改输出目录，`CODEX_BIN` 改执行文件。录的是真模型，会花钱、结果每次不同，所以只在要换录制（Codex 升级、情形变了）时手动跑，CI 从不跑。
- **harness bridge**：`spawnHarness({ …, record })` 的 `record(direction, frame)` 收到宿主与程序之间的每一帧。
- **ACP**：`new AcpHarness({ …, record })` 的 `record(direction, frame)` 收到适配器与 agent 之间的每一条 JSON-RPC 消息（`harness/acp/src/record.ts` `recordStream` 包住 SDK 的 `Stream`）。`harness/acp/scripts/record-transcripts.ts` 用它录 `harness/acp/test/transcript-scenarios.ts` 的四个情形：每个起一个一次性的 agent 进程（`load` 先在另一个进程上建好要续的会话，那一段不录），经真实的 `AcpHarness` 跑一遍；agent 是 `AIO_ACP_COMMAND`，它的模型与凭据在环境里，装法和跑法见 `harness/acp/README.md`。去掉的值：agent 编出来的 `sessionId`、`toolCallId`、`messageId`（`<$session-1>` 等）、家目录、主机名、工作目录。
- **testkit 的 `TranscriptRecorder`** 收这些 `tap`，给每行 label，`transcript()` 得到一段 transcript；`exit(status)` 记下程序自己退出。
- **`scrubTranscript(t, o)`** 去掉本机与本次运行的值（照 t3code 的 `codexReplayRecordingOutputRecords`）：家目录换成 `/home/replay-user`；等于主机名的字符串换成 `replay-host`；工作目录换成绑定 `<$workspace>`（回放时由被测的一侧给，如 `thread/start` 的 `cwd`）；录制时编出来的 id（Codex 的 thread、turn、item id，由 `o.ids(key, value, path)` 认）每个换成 `<$前缀-N>`，在别的字符串里出现也换；outbound 里每次都不同、又不会被回显的值（`o.volatile`，如 token）换成 `<any>`。

### 2.3 回放

`TranscriptReplay`（`replay.ts`）只有一个游标，按行走：

1. `emit_inbound`：等 `afterMs`，代入绑定后发出。没绑定的 `<$name>` 就发字符串 `name` 并绑上（`"<$thread-1>"` 发成 `"thread-1"`，被测的一侧回显它时就对得上）。gate 里的 label（构造时的 `gates`）在 `release(label)` 之前停在这一行；之后的行都在它后面（只有一个游标）。
2. `expect_outbound`：取被测一侧写来的下一帧比较（`exact` 或 `subset`，§3.4 的规则），比较时绑定。先到的帧排队等它的那一行。
3. `runtime_exit`：结束。

不同的帧（`mismatch`）、最后一行之后又来的帧（`exhausted`）、代入不了的绑定（`emit`）都是错误：回放停下，错误说出第几行（头是第 1 行）、label 和哪里不同。最后一行之后的帧也可以按协议应答而不报错（`afterEnd`，`teardownAnswers`：请求一律答成功），这是给关机时的收尾用的。

**进程内的 bridge harness**：`TranscriptHarness`（`transcript-harness.ts`）是一个 `HarnessAdapter`，把 `aio.jsonl-harness` transcript 当程序：它写出的帧与 bridge 的宿主端（`harness/jsonl-bridge` 的 `spawnHarness`）写的一样（同样只 `probe` 一次、按程序的回答声明、有 `dispose`），回放发来的帧当程序的帧处理。`halt()` 停下回放，之后的请求都按程序不在了失败（运行器停内核前用，收尾不比对）。`harness/jsonl-bridge/test/transcript.test.ts` 查两者一样：同一段录下的 transcript，经真实宿主端加 stdio 回放程序、经 `TranscriptHarness`，宿主写出的帧和收到的事件都与录制时的程序相同。

### 2.4 stdio 回放程序

```sh
aio-transcript-replay <transcript.ndjson> [--bind name=value]... [--after-end error|answer]
```

放在真实程序的位置（Codex 适配器的 stdio 传输里的 `codex app-server`，一个 `bridge` 实例的 `command`），任何语言的适配器或内核都能 spawn 它。stdin 上读到的帧对照 `expect_outbound`，`emit_inbound` 写到 stdout。退出码：`runtime_exit` 的（success 0、error 1、cancelled 130）；最后一行之后 stdin 关了为 0；帧不同、或 `--after-end error`（缺省）时最后一行之后又来帧为 3；最后一行之前 stdin 就关了为 4；参数不对为 2。原因写到 stderr。`--after-end answer` 时最后一行之后的请求答成功，bridge 的 `shutdown` 让它退出。它没有 gate：一行一行照序放（gate 只在进程内，`TranscriptReplay.release`）。在仓库里从源码跑：`node --experimental-transform-types --import scripts/source-loader.mjs packages/testkit/src/transcript-replay.ts …`。

### 2.5 录下的 Codex 0.171 与 ACP agent

`harness/codex/test/transcripts.test.ts` 用 `aio-transcript-replay` 当 app-server，经真实 `CodexHarness` 把四段各回放一遍，会话做录制时做的事（`transcript-scenarios.ts`：输入固定，所以适配器写出的帧一字不差；每个动作等一个在 transcript 里先于它所产生的帧的事件）。回放程序以 0 退出（每行都放了、没有不同），事件流过 `checkEventStream`（HC-1），再查各自的结果：普通一轮的回答与录下的相同、0.171 不告警；steer 的输入由同一轮消费；审批的决定作为录下的那个答复回到 Codex（HC-9）；打断后这一轮是 `interrupted`。

`harness/acp/test/transcripts.test.ts` 同样用 `aio-transcript-replay` 当 agent，经真实 `AcpHarness` 回放四段（Claude Code 的 ACP agent `@agentclientprotocol/claude-agent-acp` 0.110.1，模型 `gpt-6-sol`，2026-11-25）：普通一轮写出的帧与录下的一字不差（`initialize` 里没有 `fs`、`terminal`）、回答相同；审批先按 profile 设 session mode（`session/set_mode`），`allow_once` 作为 agent 给的那个选项回去；取消后这一轮 `interrupted`、输入记消费；`session/load` 时 agent 先重放对话再回答，重放的不成为事件，下一轮照常（HC-1、RQ-1、IN-1、RS-1）。

录下的 steer 查出 HC-1 的一条不成立：Codex 0.171 在 steer 时放弃正在写的回答（`agentMessage` 有 `item/started`，没有 `item/completed`），适配器把这个 item 一直开着。由同一文件的 `it.fails` 复现，没修（INVARIANTS HC-1 不成立 1）。

## 3. L2：内核场景

### 3.1 文件

第一行是头：

```json
{"scenario":"channel-message-once","description":"A channel message is admitted, …","invariants":["IN-1","IN-5"],"config":{…},"timeoutMs":5000}
```

`scenario` 是名字，`description` 说它表明什么，`invariants` 是它守着的 INVARIANTS 编号（至少一个；`scripts/invariants.mjs` 把这个文件算作这些编号的一条 core 测试，§4）；可选的 `config` 按顶层键盖在参考配置上（§3.2），`timeoutMs` 是每条期望缺省等多久（缺省 5000）。没有别的键。

之后每行是只有一个键的对象：`emit`、`clock`、`fault`、`harness`（输入）、`expect`（期望），或 `note`（给人看的一句话，运行器跳过）。按文件顺序执行；`expect` 等到满足才往下走，所以后面的输入发生在它之后。

### 3.2 端

| 端 | 送进去的（`emit`） | 看到的（`expect`） |
|---|---|---|
| `channel` | `{"type":"inbound","envelope":{…}}`：参考通道收到一条平台消息 | 内核对通道适配器的调用，形状同 channel bridge 的帧（没有 `v`、`id`）：`send {route,msg,op}`、`edit {route,providerMessageId,msg,op}`、`finalize {route,providerMessageId,msg}`、`acknowledge {route,messageId,state}`、`history`、`createConversation`；以及每条 `emit` 的答复 `{"type":"result","ok":true,"value":{"accepted",…,"inputId"}}`（出错是 `ok:false` 和 `error`） |
| `client` | 本地 socket 上的客户端帧（`protocol/src/client.ts` 的 `ClientFrame`，原样；没写 `v` 时补 1） | 这个连接收到的每一帧：`result`、`event`、`closed` |
| `host` | 同一个 socket 上的宿主帧（`protocol/src/host.ts`） | 同上，加上内核发给宿主的请求（`policy`、`inbound`）和 `attention.changed`；场景可以用 `result` 帧答内核的请求 |
| `log` | 一条事件直接写进会话日志（只给只有日志的驱动用，§3.6） | 会话的持久事件，按 seq，从头读 |
| `attention` | – | 会话现在的 attention 投影 |

- **参考通道** `fake`：testkit 的 `FakeChannel`（caps 是 `defaultChannelCaps`：`card` 档、能改消息、有按钮）。`envelope` 只写要的字段，其余取缺省：账号 `default`、对话 `{ "id": "c1", "kind": "dm" }`、发送者 `{ "channelUserId": "u1", "evidence": "platform_signed" }`、回复路由指回这个对话、`id` 是 `env-<n>`；`text` 是 `content: [{ "type": "text", "text": … }]` 的简写。`send` 答 `providerMessageId: "m<n>"`（每个进程从 1 数起）。会话键是 `fake:default:<对话 id>`。
- **参考 harness**：没有 `harness` 行时是 testkit 的 `FakeHarness`：caps 是 `fakeHarnessCaps`（不能 steer，能打断、审批、提问），每一轮发 `turn.started`、一条 `text.snapshot { text: "echo: <各输入的文字以空格相连>", final: true }`（`audience: "answer"`）、`input.consumed`、`turn.completed { status: "completed" }`。
- **参考配置**（`REFERENCE_CONFIG`）：`{ "policy": { "owners": ["fake:alice"] }, "local": { "principal": "me" } }`，驱动再加数据目录、工作目录与 socket 的位置。所以 `fake` 通道上的 `alice`（`platform_signed`）是主人，本地客户端的主体是 `me`。
- **连接**：`client` 与 `host` 端的 `conn` 给连接起名（缺省 `client`、`host`），第一次用时连上。宿主连接在它的第一帧之前自动说 `host.hello`（`name` 是连接名，带守护进程的 token）；场景自己写 `host.hello`（要 `callouts`、`optIn` 时）就不再自动说，没写 `token` 时补上。
- **重启**（`fault`）之后：连接都断了，下次用到时重连（宿主再自动 hello）；同名连接的帧接在原来的后面（同一个端）。通道与 harness 都换成新的实例；日志照旧（SQLite，同一个数据目录）。

### 3.3 输入行

- `{"emit":{"end":"channel","frame":{"type":"inbound","envelope":{…}}}}`；`{"emit":{"end":"client","conn":"a","frame":{…}}}`；`{"emit":{"end":"host","conn":"xwo","frame":{…}}}`；`{"emit":{"end":"log","session":"s","event":{…}}}`。帧里的 `<$name>` 代入已经绑定的值，没绑定是错误。
- `{"clock":{"advanceMs":n}}`：内核的时钟往前走 n 毫秒。驱动有 `advanceClock` 时由它走；TS 运行器的内核驱动没有，就真的等 n 毫秒（网关没有可换的时钟）。
- `{"fault":{"restart":true}}`：停下内核，在同一个数据目录上再起一个。
- `{"harness":{"transcript":"<路径>","gate":["label",…]}}`：之后起的 harness（场景开头那一个，或下一次重启的）是这段 `aio.jsonl-harness` transcript 的回放（路径相对场景文件）；`gate` 里的 label 的行先扣住。内核已经起了时它从下一次重启起作用。`{"harness":{"release":"label"}}`：放开正在跑的 harness 的这个 gate。每个起来的 harness 都从 transcript 的开头放。

### 3.4 期望行与匹配

```json
{"expect":{"end":"log","session":"fake:default:c1","match":{"body":{"t":"input.admitted","inputId":"<$in1>"}},"label":"admitted-1"}}
```

- **`match`**：这个端上、上一次在这里匹配到的那一项之后，第一个匹配的项。等到有为止（`timeoutMs`）。`next: true` 时只看紧接着的那一项。`exact: true` 时按精确匹配。`label` 给这次匹配起名；`after: "<label>"` 要求这一项是在那次匹配到的项之后才观察到的（任何端）。
- **`none`**：从这里（这个端上次匹配的位置之后）起，直到 `until` 指名的那次匹配到的项（任何端，按观察的先后），或者到场景结束，这个端上没有匹配的项。在场景结束时查（先等一小会儿，缺省 150 ms）。`none` 不绑定：里面已绑定的占位符按值比，没绑定的匹配任意值。
- **`gapless: true`**：`log` 端是这个会话的 seq 从头读是 1、2、3……没有缺口；`client` / `host` 端要写 `session`，是这个连接收到的这个会话的持久 `event` 帧的 seq 一个接一个（不缺、不重），从哪里开始都行。
- **匹配规则**（`match.ts`，L1 的 outbound 也用它）：对象按子集匹配：模式的每个键都在、都匹配；`exact` 时不能有别的键（任何深度）。数组逐个元素匹配，长度要相同。其余的值相等。`"<any>"` 匹配任何在的值。`"<$name>"` 第一次匹配时绑定那个值，之后只匹配与它（按 JSON）相等的值；一个场景里所有行共用一套绑定（transcript 的绑定各自一套）。带占位符的字符串是模板：字面的部分要在，占位符代表一段子串（已绑定的就是它的值的文字）。匹配失败时不绑定任何东西。
- **顺序**：同一个端内保持顺序（游标只往前走）；端与端之间不排序，除非写了 `after`。`after` 与 `until` 说的"先后"是运行器观察到的先后：连接与通道上的项按到达的先后；场景里任何一行指名的日志（`log` 端的 `expect` 与 `emit`）从内核起来起就读，在任何端观察到一项之前、每次等一条期望时、每条 `log` 端的 `emit` 之后各读一遍，新写进去的事件算在那时观察到。所以日志里的事件排在它写下之后才观察到的项前面，与哪一行先指名这个日志无关。内核起来的过程中（驱动的 `start` 返回之前）还读不到日志：这段时间写进日志的事件算在 `start` 返回之后观察到。通道端里，`emit` 的答复单独成一列：按 `emit` 的顺序，但与内核对通道的调用之间不排序（在一条线上它们的先后看时机：参考 harness 可能在 `emit` 返回之前就答完了）。

### 3.5 跑法

`runScenario(scenario, driver, options)`（testkit）。驱动只管起内核：

```ts
interface ScenarioDriver {
  start(o: { dir; config; harness: HarnessAdapter; channel: ChannelAdapter; restart: number }): Promise<{
    socketPath?; token?; log(sessionKey): unknown[]; attention?(sessionKey): unknown; append?(sessionKey, event): void; stop(): Promise<void>;
  }>;
  advanceClock?(ms: number): Promise<void>;
}
```

运行器建参考通道、参考 harness 或 `TranscriptHarness`，连 socket，读日志，做所有的匹配。场景结束时它查：每条 `none`；每段 transcript 的回放没有出错，且（除了被重启停下的）放到了最后一行。失败时 `ScenarioError` 说出文件和行，以及从上次匹配之后这个端上有过的最后几项、每项为什么不匹配。`trace` 选项把每一项打出来（`AIO_SCENARIO_TRACE=1 npx vitest run packages/kernel/test/scenarios.test.ts`）。

`packages/kernel/test/scenarios.test.ts` 是 TS 内核的驱动：`coreRegistries()`、`resolveConfig`，参考通道与 harness 作为嵌入方给的（同 `core-only.test.ts`），测试名带头部的编号，所以 `-t '#IN-1\b'` 选得到。驱动也可以自己放 transcript（`playsTranscripts`：运行器不建 `TranscriptHarness`，把路径交给驱动，有 gate 的场景就失败）：`packages/daemon/test/scenarios-bridge.test.ts` 把没有 gate、harness 是 transcript 的内核场景再跑一遍，transcript 由 `aio-transcript-replay` 作真实 bridge 宿主端（`spawnHarness`）的程序来放，回放程序的 stderr 必须是空的；这就是别的语言的内核会做的。

### 3.6 attention 场景

G7 的 fixture 用的是同一格式：每行一条 `emit` 到 `log` 端（`event` 是一条 `SessionEvent` 去掉日志盖的字段：`body`、`ts` 必填，可选 `visibility`、`durability`、`audience`、`level`、`turnId`、`itemId`），最后一行是 `attention` 端的一条精确 `expect`，会话是缺省的 `s`，头部只有 `scenario`、`description`、`invariants: ["LN-11"]`。`packages/session/test/attention.test.ts` 先查这个形状，再用纯 fold、内存日志、SQLite 日志（重开、一步步压缩）各算一遍，都要严格等于期望值，最后用 `runScenario` 在一个只有日志的驱动上跑一遍。内容与原来的 `{ description, input, expected }` 一样，只是换了格式。

### 3.7 现有的内核场景

| 文件 | 编号 | 移自（原测试留着） |
|---|---|---|
| `channel-message-once.ndjson` | IN-1、IN-5 | `core-only.test.ts` "a channel message is admitted, consumed by a turn …" |
| `log-resume.ndjson` | LN-1、LN-10 | `core-only.test.ts` "the session log is gapless and only grows, across a restart …" |
| `delivery-once.ndjson` | DL-1、DL-2、EX-2 | `core-only.test.ts` "every delivery settles once …" |
| `request-resolved-once.ndjson` | RQ-1 | `core-only.test.ts` "a request is opened once and resolved once …"（harness 是 `approval.ndjson`；由谁作答改由宿主经 `resolve` 回调说，原来是嵌入方的 `Policy.resolve`，场景里写不了 TS） |
| `host-queue-ack.ndjson` | HQ-1 | `core-only.test.ts` "the host inbound queue keeps what the host has not acked …" |
| `one-turn-at-a-time.ndjson` | LN-2 | `core-only.test.ts` "one writer lane per session and at most one turn at a time …"（harness 是 `queue-behind-turn.ndjson`，第一轮的回答由 gate 扣住） |

## 4. 与不变量的对接

`scripts/invariants.mjs` 只算运行器跑的场景：它的 `SCENARIO_DIRS` 列出场景目录和跑它的 core 测试（`scenarios/kernel/` 由 `packages/kernel/test/scenarios.test.ts`，`scenarios/attention/` 由 `packages/session/test/attention.test.ts`），运行器用 `scenarioFiles(dir)` 跑目录顶层的 `*.ndjson`（不含子目录），脚本读的也正是这些文件的第一行：是场景的头（有 `scenario` 和 `invariants`）就算一条 core 测试，标签是 `invariants` 里的编号，名字是 `<scenario>: <description> #编号…`（INVARIANTS 里可以引用它）。`check` 因此把它算作这些编号的测试（编号不存在同样报错），`list` 列出它，`affected` 给一个改动的场景文件找出它的编号。transcript 的第一行是 `transcript_start`，不算。

别的都是漂移，`check` 报错（退出码 1）：`packages`、`harness`、`channel`、`examples` 下任何别处（场景目录的子目录、别的目录）带场景头的 `.ndjson`，因为没有运行器跑它；运行器要跑、第一行却不是场景头的文件；`SCENARIO_DIRS` 里运行器不存在、不是 core 测试或不调 `scenarioFiles` 的目录。所以新的目录要先有跑它的测试，再写进 `SCENARIO_DIRS`。`packages/testkit/test/conformance.local.test.ts` 查每个场景和 transcript 都读得通、场景指名的 transcript 都在，并查 `scenarios/` 下（任意深度）的每个场景都在 `kernel/` 或 `attention/` 的顶层，且 `invariants.mjs list --json` 算的场景正是这些。

## 5. 给别的语言的实现

- **适配器**：拿 `transcripts/` 里对应协议的 transcript，spawn `aio-transcript-replay` 当 harness，做 transcript 里的那些事（Codex 的做法写在 `harness/codex/test/transcript-scenarios.ts`）；或者照 §2.3 在自己的语言里回放。
- **内核**：照 §3 写一个运行器或一个驱动：参考通道、参考 harness、参考配置照 §3.2 实现，`aio.jsonl-harness` 的 transcript 用 `aio-transcript-replay` 当 bridge 程序（没有 gate），或照 §2.3 在进程内回放（有 gate）。场景说的是线上的帧和日志里的事件，与实现语言无关；参考通道与参考 harness 的行为写在 §3.2，不需要读 TS。
- **宿主**：fold 自己的投影（如 attention）的宿主照 `scenarios/attention/` 自检。

## 6. 还没有的

- 别的 harness 的录制：Claude Code（t3code 在 Agent SDK 的消息层录，不是 stream-json 的线）。ACP agent 已录（`transcripts/acp/`，§2.5），只录了一个 agent（Claude Code 的 ACP agent）。
- 通道一侧的 transcript（channel bridge 的帧）和真实平台的录制。
- 内核场景只移了六条 TS 测试（十个编号）；其余承诺仍只有 TS 测试。
- TS 运行器的 `clock` 是真的等：网关没有可换的时钟。
- stdio 回放程序没有 gate。
