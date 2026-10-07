# 宿主连接存活：`/ws` 心跳与 `host.hello { takeover }`

> 状态：已实现（分支 `feat/ops-token-heartbeat-live-channels`），待合并时记入决定。`takeover` 由宿主显式开启；心跳默认开启（见 §3.1 的理由），可配置关闭。
> 依据：`docs/POSITIONING.md` §2；`docs/HOSTS.md` §4；决定 1（宿主不在线只变慢、不丢输入）。

## 1. 问题

- 同一时刻至多一个宿主（带 `consumer` 或 `callouts` 的连接）。第二个带角色的 `hello` 在旧连接的 `signal` 未中止时被拒绝：`packages/daemon/src/host.ts:125`（改动前）`if (role && this.host && !this.host.peer.signal.aborted) return fail('host_connected', …)`。
- 旧连接只有在传输层报告关闭时才会被清掉：`/ws` 上是 `ws.on('close')` / `ws.on('error')`（`packages/daemon/src/console.ts:408-409`，改动前），本地 socket 上是 `socket.on('close')`（`packages/daemon/src/local-server.ts:85-86`）。
- 远程宿主经控制台 `/ws` 连接时，网络中断（NAT 超时、笔记本休眠、对端崩溃而没有 FIN）会留下**半开连接**：服务器端看不到关闭，TCP keepalive 默认两小时以上。结果是宿主重连时一直得到 `host_connected`，推送仍发给死连接、等到 30 s 超时再重试，回调全部失败走 `onFailure`。今天 `ConsoleServer` 不发任何 ping（`console.ts` 全文没有 ping/pong）。
- 本地 unix socket 不存在半开问题（内核在进程退出时关闭），所以心跳只加在 `/ws`。

## 2. 选项

| 选项 | 说明 | 取舍 |
|---|---|---|
| A. 只加服务端心跳 | ping/pong，超时断开 | 能清掉半开连接，但要等到超时；宿主重连那一刻仍可能被拒 |
| B. 只加 `takeover` | 带有效 token 的 hello 顶替旧宿主 | 宿主立刻恢复；但没有重连的宿主（例如永久离线）其连接仍占着槽位、推送仍发往死连接 |
| C. A + B（采纳） | 心跳兜底，takeover 让重连立即生效 | 两者都是机制：断开判据（间隔/超时）和是否顶替都由运维、宿主选择 |
| D. 应用层心跳帧（`ping` 帧） | 协议里加新帧 | 需要所有宿主实现；WebSocket 本身的 ping/pong 是 RFC 6455 强制的，所有客户端自动应答，不必新帧 |

## 3. 选择

### 3.1 `/ws` 心跳

- 配置 `console.heartbeat: { intervalMs?: 30000, timeoutMs?: 10000 }`；`intervalMs: 0` 关闭。
- 每个 `/ws` 连接每 `intervalMs` 发一次 WebSocket ping；ping 发出后 `timeoutMs` 内没有 pong、也没有任何消息，就 `terminate()` 并记 `warn` 日志。连接被清理后（`FrameConn.drop` → `HostService.gone`），宿主槽位释放，未确认的推送留在队列里，等下一个宿主。
- 默认开启的理由：pong 由每个合规的 WebSocket 实现自动回复（浏览器、`ws`、各语言库），对现有客户端完全透明，不改变任何帧；关闭它反而会让"宿主重连被拒"这个问题默认存在。需要旧行为的部署设 `intervalMs: 0`。

### 3.2 `host.hello { takeover: true }`

- 只有在 token 校验通过之后才考虑 takeover（错误 token 仍是 `unauthorized`）。
- `/ws` 上旧连接的 `end()` 先发关闭帧（1001），1 s 内对方没有完成关闭握手就 `terminate()`：半开的旧连接不会挂到 `ws` 自带的 30 s 关闭超时。守护进程侧的状态在 `end()` 时已经清理，这只影响底层 socket 何时释放。
- 已有宿主且 hello 带 `takeover: true`：记 `warn` 日志（新旧名字、旧连接 id），调用旧连接的 `end()`（发 `closed`、关闭传输、`drop`），`HostService.gone` 清理推送订阅与 `hostConnected`，然后按普通 hello 继续。旧连接上的在途推送以 `disconnected` 结束、不前移游标，改推给新宿主（至少一次）。
- 不要求新旧名字相同：token 证明的是同一权限；名字只用于日志与 `explain`。
- 结果 `HostHelloResult.replaced: { name }`；`features` 增加 `"host.takeover"`。旧守护进程会忽略未知字段（TypeBox 对象非封闭），所以宿主应先看 `features`。
- 无宿主时 `takeover: true` 等同普通 hello。

## 4. 协议 / Schema / 配置影响

- `HostHello.takeover?: boolean`，`HostHelloResult.replaced?: { name }`（`packages/protocol/src/host.ts`）；已运行 `pnpm schema`，`HostRequestFrame.json`、`HostHelloResult.json` 更新。
- `Peer.end?(reason)`（`local-server.ts`），`FrameConn` 已实现。
- 配置 `console.heartbeat`（`ConfigFile` 与 `ConsoleConfig`）。
- `LocalClient.hello` 接受 `takeover`。

## 5. 测试

`packages/daemon/test/host-liveness.test.ts`：不回 pong 的 `/ws` 宿主在超时后被断开、槽位释放、新宿主可直接连接；回 pong 的连接跨多个周期保持；配置默认值与关闭；无 takeover 的第二宿主被拒、错误 token 的 takeover 被拒、带 takeover 的宿主顶替旧连接并收到旧连接未确认的推送（同一游标）、旧连接已关闭；经 `/ws` 的 takeover：旧连接不读数据（半开）时，新宿主接管，守护进程在关闭宽限后丢弃旧 socket；无宿主时 takeover 等同普通 hello。

## 6. 迁移

无需迁移。宿主若要利用 takeover，检查 `features` 含 `"host.takeover"` 后在重连的 hello 里加 `takeover: true`。
