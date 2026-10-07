# 通道变更在线生效：`console.liveChannels`

> 状态：已实现（分支 `feat/ops-token-heartbeat-live-channels`），待合并时记入决定。显式开启：`console.liveChannels: true`，默认关闭（行为与以前相同）。
> 依据：`docs/POSITIONING.md` §2（机制而非策略）；决定 8（一个守护进程多个 Lark 机器人，按 (channel, account) 出站）。

## 1. 问题

- `PUT /api/config` 只写文件；`ConfigStore.put` 以"文件是否与启动时相同"给出 `applied`（`packages/daemon/src/console-config.ts:295`，改动前 `canonical(doc) === this.started ? 'live' : 'restart'`）。任何变更都要重启守护进程才生效。
- `POST /api/bots/lark` 成功后把新的 `lark-bot` 条目写进配置，但提示"restart the daemon to start the channel"（`packages/daemon/src/provision.ts:313`，改动前）。决定 8 之后一个守护进程跑多个机器人，新增一个机器人就要重启，会打断其他机器人与在跑的会话。
- 通道只在启动时一次性构建：`startChannels` 遍历 `this.o.config.channels`（`packages/daemon/src/gateway.ts:1088`，改动前），之后没有增删通道的入口；合成器（compositor）也只在会话打开时为当时存在的通道建立（`gateway.ts:628`、`847`）。

## 2. 选项

| 选项 | 说明 | 取舍 |
|---|---|---|
| A. 全量热加载配置 | 代理、绑定表、策略、harness 全部重建 | 牵涉面大（策略、路由、在跑的 lane），难以保证一致 |
| B. 只对 `channels` 做差量应用（采纳） | 比较解析后的条目，增/删/改的才启停 | 范围清楚；通道本来就有独立的启停生命周期；正好覆盖"新增一个机器人" |
| C. 单独的 `POST /api/channels/reload` | 显式触发 | 多一个端点；PUT 与开通任务仍各自要再调一次 |

## 3. 选择

- 配置 `console.liveChannels: boolean`，默认 `false`。关闭时一切同前。
- 开启后，`PUT /api/config` 写入成功、以及开通任务把通道写入配置后，守护进程调用 `Gateway.applyChannels()`（串行执行）：
  - 用与启动相同的解析（`resolveConfig`，env 文件重新读取）得到目标通道列表；解析失败则不应用（日志 `warn`），答复与以前一样。
  - 比较键是**解析后**条目的规范 JSON：env 引用替换后的值变了（例如轮换了密钥）也算变更。
  - 先停：配置里没有了或变了的通道——中止、等待其 `start` 返回、停掉渲染到它的合成器、`close()`、从列表移除。再启：新增或变了的条目，用启动时同一路径构建（bridge 同样带首次连接重试），并为已打开的会话补建合成器。未变的通道不动；进程内（`GatewayOptions.channels`）的通道从不参与。
  - `started` 的含义是"已启动且在答复时没有失败"：bridge 打开时已完成首次连接，结果当场可知；其他适配器（`lark-bot`、`mail`）等待一个宽限期（`GatewayOptions.channelStartGraceMs`，默认 1000 ms，各通道并行等待），期间 `start` reject 的算失败。未连接的 bridge（首次连接失败，之后仍按退避重试）与 `start` 已 reject 的通道列入 `failed`（带原因）；后者从运行列表中移除，下次应用会重新启动。仍处于 `failed` 的未变通道也列入 `failed`；`start` 已经结束的未变通道会被重启。
  - 有 `failed` 时文件不算已应用（`applied: "restart"`）；没有时 `ConfigStore` 记下"正在运行的 channels"；`applied` 改为"文件是否等于正在运行的状态"（启动时的文件，其中 `channels` 换成最近一次在线应用的）。因此只改了通道 → `live`；同时改了别的（如 `policy.owners`）→ 通道照样已经生效，但 `applied: "restart"` 表示其余部分仍待重启。
- 开通任务：开启时在标成 `succeeded` 之前先启动新通道，`result.channelStarted` 与 `started` 同义；启动当场失败时为 `false`，`message` 写明原因（"the channel did not start (…)"）。新增的 owner 仍需重启（策略与身份表不在线重建）。
- 局限：适配器自己吞掉并重试的失败不会让 `start` reject，因而仍报 `started`。`lark-bot` 凭据错误或被轮换时就是这样（`ws.start` 失败只记 `warn` 并重试），只能从日志看到，`GET /api/status` 仍显示 `running`。见 §7。

## 4. 协议 / Schema / 配置影响

- `AdminConfigPutResult.channels?: AdminChannelsApplied`（`{ started, stopped, failed? }`，元素 `{ type, account }`，`failed` 另带 `error`）；关闭时不出现。`applied` 语义扩展为"运行状态是否与文件一致"，取值不变。
- `AdminLarkBotJob.result.channelStarted?: boolean`。
- 新 schema `AdminChannelsApplied.json`；`AdminConfigPutResult.json`、`AdminLarkBotJob.json` 重新生成（`pnpm schema`）。
- 配置：`console.liveChannels`。
- 库：`GatewayOptions.channelAdapter?(ch)` 可替换配置通道的适配器构建（嵌入方、测试用）。

## 5. 测试

`packages/daemon/test/live-channels.test.ts`：关闭时新增通道仍为 `restart` 且不启动；开启后新增两个 bridge 即 `live` 并运行，相同文件再写入不做任何事，改一个、删一个时旧子进程退出、新子进程启动、进程内通道不受影响，全部删除后只剩进程内通道；同时有其他变更时通道照样生效而答复 `restart`，撤回其他变更后为 `live`；已打开会话为新通道补建合成器、移除时一并停掉；`POST /api/bots/lark` 开通的 `lark-bot`（`proj-a`）在任务成功前已运行，`channelStarted: true`。失败路径：首次连接失败的 bridge 列入 `failed`、`applied: "restart"`，连上后同一文件为 `live`；`start` 当场 reject 的通道列入 `failed`、从状态中移除，下次应用重新启动；开通的 `lark-bot` 启动失败时 `channelStarted: false` 且消息带原因；env 文件里轮换的密钥使同一份配置文档触发重启该通道。

## 6. 迁移

无需迁移。想要在线生效的部署在配置里加 `"console": { "liveChannels": true }`（需要一次重启让该开关本身生效）。UI 可以根据答复里有无 `channels` 判断守护进程是否支持并开启了此功能。

## 7. 后续

- 通道适配器报告连接状态：给 `ChannelAdapter` 一个可选的状态回调（与 bridge 的 `onState` 同形），`lark-bot` 在 `ws.start` 失败、凭据被拒时报告 `failed`，这样 `started` / `GET /api/status` 能反映凭据错误，而不是只在日志里。
