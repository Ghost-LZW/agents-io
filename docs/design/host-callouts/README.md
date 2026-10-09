# 宿主同步钩子：`resolve` 与 `outbound` 回调，宿主代答

> 状态：已采纳并合入 main（2026-10-07，决定 9）。
> 依据：`docs/POSITIONING.md` §2（机制与策略的判据）、§4（`Policy` 钩子）；`docs/HOSTS.md` §4（"`resolve`、`outbound` 等可选的同步钩子（超时 fail closed）"）；`docs/design/locus/DECISIONS.md` 决定 1–8。

## 1. 一句话

**让连接中的宿主通过同一个 `policy` 帧回答 `Policy.resolve`（某个请求由谁来答）和 `Policy.outbound`（主动外发是否放行），并允许宿主以它指名的成员身份回答审批与提问。** 全部按 `host.hello` 声明开启，不声明的宿主与旧守护进程行为不变。

## 2. 问题

| 位置（`origin/main`） | 现状 | 结果 |
|---|---|---|
| `docs/HOSTS.md` §4 帧表 `policy` 行 | 写着 "§2.2 回调，以及 `resolve`、`outbound` 等可选的同步钩子（超时 fail closed）" | 文档承诺了，代码里没有 |
| `packages/protocol/src/host.ts:206-207` | `HostHello.callouts` 只是布尔，含义是"回答 `route` 回调" | 宿主无法声明更多钩子 |
| `packages/daemon/src/host.ts:168-176` | `routeCallout` 是唯一发给宿主的 `policy` 帧 | `resolve` / `outbound` 只能由进程内 `GatewayOptions.policy` 替换，进程外宿主（任意语言）做不到 |
| `packages/daemon/src/gateway.ts:256-271` | `this.policy = { ...defaultPolicy, identify, control, ...o.policy }` | 审批由谁答、能否外发只取决于本地配置 |
| `packages/session/src/lane.ts:1078-1093` `resolveCommand` | `human` 请求只认 `origin.principal.id` 在 `principals` 里；宿主连接的 origin 是 `host:<name>` | 宿主在自己的界面（或别的渠道）收到成员的答复后，没有办法把答复记为该成员作出的；只能把 resolver 设为 `host`，日志里只有 `host:<name>` |

POSITIONING §2 的判据：某个请求交给谁答、某个目的地能不能发，不同宿主答案不同，属于策略；agents-io 只提供钩子。§4 已把 `resolve`、`outbound` 列为钩子，但只有进程内实现。

## 3. 方案

| 方案 | 做法 | 取舍 |
|---|---|---|
| **A 扩展 `host.hello.callouts`（采用）** | `callouts: boolean \| string[]`，`true` 等于 `["route"]`；新增钩子 `resolve`、`outbound`，沿用 `policy` 帧 | 一个机制覆盖全部钩子；不声明就不发；旧宿主不变 |
| B 每个钩子一个新帧类型 | `resolve.callout`、`outbound.callout` | 帧类型变多，宿主侧分发逻辑重复；与 HOSTS §4 "`policy` 帧承载可选钩子" 不一致 |
| C 宿主推送静态规则（如 resolver 表） | 像 Binding 表一样推送 | 规则语言要能表达请求种类、风险、会话、主体……等于发明策略语言；与"判断留在宿主"冲突 |

代答（on behalf of）：

| 方案 | 做法 | 取舍 |
|---|---|---|
| **a `resolve` 帧加 `onBehalfOf`（采用）** | 只接受宿主连接（`origin.kind = system` 且 `origin.adapter = host`；网关和 lane 都查，其它系统来源如 watch、run 不可代答）；`human` 请求仍按 `principals` 校验资格 | 资格仍由守护进程复核；日志里记成员与经由的宿主 |
| b 宿主伪造成员 origin 发帧 | 允许宿主连接改写 origin | 破坏 origin 只由守护进程盖章的原则 |

## 4. 设计

### 4.1 `host.hello`

```jsonc
{ "type": "host.hello", "token": "…", "name": "h", "callouts": ["route", "resolve", "outbound"] }
```

- `callouts: true` 等于 `["route"]`（旧语义）；`false`、`[]`、缺省：不回答任何回调。
- 数组里未知的钩子名被忽略（向前兼容）；结果 `HostHelloResult.callouts` 列出实际开启的钩子。
- 任一钩子开启（或带 `consumer`）都使连接成为**宿主**（至多一个），与原规则一致。
- `features` 新增 `callouts.resolve`、`callouts.outbound`、`resolve.onBehalfOf`。旧守护进程的 `callouts` 只认布尔：宿主应直接发列表，收到 `invalid_frame` 时改用 `callouts: true` 重发。不要先用 `callouts: true` 握手探测：那次握手已让连接成为唯一的宿主、只开 `route`，换列表需断开重连，期间占着宿主位置。

### 4.2 `resolve` 钩子

守护进程向宿主发 `policy { hook: "resolve", args: { request, ctx } }`：`request` 是 `request.opened` 的事件体，`ctx` 是 `TurnContext`（与进程内 `Policy.resolve(req, ctx)` 参数一一对应）。宿主答复一个 `Resolver`（`auto` / `model` / `human` / `host`）。

- **fail closed = 退回内建行为**：宿主未连接、没开启 `resolve`、超时、出错、答复不合 schema，都按本地策略（配置或进程内 `policy.resolve`）决定，并记一条 `notice`（`host resolve callout failed: …`），不会因为宿主挂掉而放行或卡住。
- 超时：配置 `hostCallouts.resolve.timeoutMs`，默认 3000 ms。

### 4.3 `outbound` 钩子

`policy { hook: "outbound", args: { from, to } }`（`from: TurnContext | null`，`to: ReplyRoute`），宿主答复 `{ verdict: "allow" | "deny" }`。

- 宿主未连接或没开启 `outbound`：沿用本地 `policy.outbound`（行为不变）。注意：开启过 `outbound` 的宿主断开后同样回到本地策略，本地允许的去向（如预注册 `routes`）照常放行；宿主施加的限制离线期间不生效（见 §8）。
- **fail closed = 拒绝**：已开启时超时、出错、答复不合 schema，一律 `deny`。
- 超时：`hostCallouts.outbound.timeoutMs`，默认 2000 ms。

### 4.4 代答：`resolve { onBehalfOf }`

客户端帧 `resolve` 增加可选 `onBehalfOf: string`（宿主成员 id）：

- 只有宿主连接（`origin.kind === "system"` 且 `origin.adapter === "host"`）可带；其它连接带了答 `not_eligible`。网关（`ClientCommand`）与 lane（`resolveCommand`）各查一次：以后新增的内部系统来源（watch、run 等）也不能代答。
- 请求 resolver 为 `human`：`onBehalfOf` 必须在 `principals` 里，否则 `not_eligible`；记 `request.resolved.by = { kind: "human", id: <成员>, via: "host:<name>" }`。
- resolver 为 `host`：记 `by = { kind: "host", id: <成员>, via: "host:<name>" }`。
- 不带 `onBehalfOf` 与今天完全相同。`ResolvedBy` 新增可选 `via`：`id` 始终是答复所算作的主体，`via` 是转达它的宿主连接。

### 4.5 配置

```jsonc
"hostCallouts": { "resolve": { "timeoutMs": 3000 }, "outbound": { "timeoutMs": 2000 } }
```

可选；`route` 仍用规则自己的 `callout.timeoutMs`。

## 5. 协议 / Schema 影响

- `HostHello.callouts`：`boolean | string[]`；`HostHelloResult.callouts?: string[]`。
- 新增 `ResolveCallout`、`OutboundCallout`（`HostEventFrame` 成员），答复 schema `ResolveCalloutAnswer`（= `Resolver`）、`OutboundCalloutAnswer`。
- `ClientCommand` / `Command` 的 `resolve` 加 `onBehalfOf?`；`ResolvedBy` 加 `via?`。
- 全部为可选字段或新增成员；`PROTOCOL_VERSION` 不变。重新生成 `packages/protocol/schema/*.json`。

## 6. 测试

`packages/daemon/test/host-callouts.test.ts`（全部通过）：
- `callouts: true` 仍只开 `route`；数组开 `resolve` / `outbound`，未知钩子忽略，结果列出开启的钩子。
- `resolve`：宿主答 `human` → 请求等人；宿主超时 / 出错 / 答错 → 本地策略（含 notice）；未开启时不发帧。
- `outbound`：宿主 `deny` 拦下输出工具的外发；超时 → 拒绝；未开启 → 本地策略。
- 代答：宿主以 `principals` 内成员答复，日志 `by` 带 `id` 与 `via`；不在名单 → `not_eligible`；非宿主连接带 `onBehalfOf` → `not_eligible`。

## 7. 迁移

无需迁移。已有宿主（`callouts: true`）行为不变；不握手声明新钩子就不会收到新帧。

## 8. 后续

- **离线时的 `outbound`**：可加配置（如 `hostCallouts.outbound.whenOffline: "deny"`），让开启过 `outbound` 的宿主断开期间一律拒绝外发，而不是回到本地策略。当前只在文档中说明。
- **Schema 去重**：`HostEventFrame.json` 内联了完整的 `request.opened` 事件体与 `TurnContextView`（约 1300 行），与 `TurnContextView.json`、`ResolveCalloutAnswer.json` 重复。可在 `emit-schema` 中用 `$id` / `$ref` 共享定义；不影响正确性。
