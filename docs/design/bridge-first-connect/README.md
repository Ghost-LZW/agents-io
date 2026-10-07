# bridge 通道首次 `hello` 失败：标记 failed 并重试，而不是让守护进程启动失败

> 状态：已实现（分支 `feat/ops-token-heartbeat-live-channels`），待合并时记入决定。对守护进程配置里的 `bridge` 通道生效；库调用方经 `retryFirstConnect` 显式开启。
> 依据：`docs/POSITIONING.md` §2（机制而非策略）；决定 1（宿主/对端不在线只变慢、不丢输入）。

## 1. 问题

- `Bridge.open` 先 `await b.connect()`（`channel/jsonl-bridge/src/host.ts:176`，改动前），首次 spawn + `hello` 失败就 reject。
- 守护进程启动时顺序构建通道：`for (const ch of this.o.config.channels) all.push(await buildChannel(ch))`（`packages/daemon/src/gateway.ts:1088`，改动前）。任一 bridge 的对端暂时起不来（依赖的服务未就绪、凭据还没写好、二进制正在更新），整个 `aio serve` 就失败退出，其他通道、宿主连接全部不可用。
- 而 bridge 一旦连上过，之后对端退出时 `start` 已经会按重启退避（`backoff`）重连；"首次"和"之后"的行为不一致。
- `hello.adapterId` 在首次 hello 之前未知（`private hello!: ChannelHello`，`host.ts:136`），所以无法在未连接时列出这个通道。

## 2. 选项

| 选项 | 说明 | 取舍 |
|---|---|---|
| A. 维持现状 | 首次失败即启动失败 | 一个可选通道拖垮整个守护进程 |
| B. 守护进程跳过失败通道 | 记错误，不再重试 | 需要人工重启才能恢复，和"之后断开会重连"不一致 |
| C. bridge 支持"未连接地打开"，`start` 按现有退避重试（采纳） | `open` 返回未连接的适配器，`start` 的重连循环同时负责首次连接 | 行为统一；状态可见；不引入新的重试策略 |

## 3. 选择

- `BridgeOptions.retryFirstConnect?: boolean`（默认 false，库行为不变）。开启后首次连接失败时 `open` 仍然 resolve；`start` 先等一个退避步长再拨，之后与断线重连共用同一循环与 `backoff`。
- 未连接期间：`id` 用 `BridgeOptions.id`（默认 `bridge`），`caps()` 返回 `OFFLINE_CHANNEL_CAPS`（纯文本、`final` 档），可选方法（edit/finalize/…）不挂；`send` 等请求以 `unavailable`（retryable）失败，出站照常进投递重试。连上后按该次 `hello` 的 `methods` 重新挂载可选方法（每次重连都会刷新）。
- `BridgedChannel.state(): { connected, error? }` 与 `onState` 回调：连上、对端离开、某次连接失败时通知。
- 守护进程对配置里的 `bridge` 通道总是开启 `retryFirstConnect`：未连接时通道条目为 `state: "failed"`、`error: "<原因>; retrying"`，`GET /api/status`（与 `aio status`）可见；连上后回到 `running`，日志记一条 `connected`。之后对端离开同样显示 `failed` + 原因，直到重连。
- 配置错误（缺字段、env 未解析等）仍在 `resolveConfig` 阶段让启动失败；只有"对端起不来"属于运行时状态。命令本身无法执行（spawn 报 `ENOENT` / `EACCES` / `ENOTDIR`，例如 `command` 写错）也算配置错误：即使开启 `retryFirstConnect`，`open` 仍然 reject，`aio serve` 照旧启动失败，在线应用时列入 `failed`。
- 兼容性变化（已知、接受）：曾经连上过的 bridge 在对端离开、重连期间，状态从以前的 `running` 变为 `failed` + 原因（`GET /api/status` 对现有 UI 可见的变化）。这是更准确的状态；依赖"`running` 即配置存在"的 UI 应改看 `error`。

## 4. 协议 / Schema / 配置影响

- 协议帧不变；`AdminStatus.channels[].state/error` 已有，无需重新生成 schema。
- 配置：`bridge` 通道新增可选 `id`（对端 `hello` 会声明的 adapter id），只用于未连接时的显示与路由；不填时为 `bridge`。建议与对端声明的一致。
- 库：`retryFirstConnect`、`id`、`onState`、`BridgedChannel.state()`、`OFFLINE_CHANNEL_CAPS`（`@agents-io/channel-jsonl-bridge`）。

## 5. 测试

- `channel/jsonl-bridge/test/bridge.test.ts`（`retryFirstConnect`）：首次 hello 失败时 open 仍成功、状态为未连接、离线 caps、请求 `unavailable`；`start` 后按退避多次重试，对端恢复后连接并切到对端声明的 id 与方法；未开启时 open 仍 reject；连上后对端退出会报告。
- `packages/daemon/test/bridge-startup.test.ts`：守护进程照常启动，`adminStatus` 与 `GET /api/status` 显示 `failed` 与原因，其他通道 `running`；对端恢复后变 `running`；首次即连上的 bridge 行为不变；命令不存在时守护进程仍启动失败（`ENOENT`）。`channel/jsonl-bridge/test/bridge.test.ts` 另测命令不存在时即使开启 `retryFirstConnect` 也 reject。

## 6. 迁移

无需迁移。以前因 bridge 起不来而启动失败的部署，现在会启动并在状态里显示该通道 `failed`。依赖"启动失败"做探活的脚本应改查 `GET /api/status` 的通道状态。

## 7. 后续

- 逐条目关闭首次连接重试（例如 bridge 通道配置里 `retryFirstConnect: false`），给希望"对端起不来就启动失败"的部署；目前只有命令无法执行时保持快速失败。
