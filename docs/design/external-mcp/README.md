# 对外 MCP 端点：不在本守护进程上的 agent 读会话、经这里输出

> 状态：已实现（2026-10-20），可选开启，不配置时行为不变。承诺与测试见 `docs/INVARIANTS.md` SE-5、ID-10、CF-10、DL-6、EX-8，IN-8 随之扩到 `peer` 输入。
> 依据：`docs/ROADMAP.md` §2 末段（"不在 agents-io 上的 agent 通过一个 MCP 端点使用同一组原语，进来时带外部来源"）、§4"之后"第 10 项；原则 2、4、6；`docs/design/agent-messaging/` §5 最后一行（本文与它的设想不同处见 §8）；`docs/HOSTS.md` §4.1（回调钩子）。

## 1. 一句话

**守护进程可以多开一个 MCP 端点（Streamable HTTP，只听回环，缺省关闭），给本守护进程之外的 agent 用：比如运维者机器上直接跑的 Claude Code / Codex，或宿主替自己的用户做的代理。每个客户端在配置里有自己的令牌和 scope，没写的都不许；它做的每件事都由守护进程以它自己的主体盖章（`kind: "peer"`、`external:<名字>`，永远不是人），写操作还要过宿主的 `external` 钩子；发出的消息与 agent 的发送走同一条外发检查和 outbox，`aio explain` 说得出是谁发的。**

## 2. 配置

```jsonc
"externalMcp": {
  "listen": "127.0.0.1:7465",                 // 缺省；只许回环地址（127.0.0.1 / ::1），端口 0 = 任选
  "clients": {
    "laptop": {
      "token": "env:AIO_MCP_LAPTOP_TOKEN",      // 只能是 env:NAME，字面量拒绝；或者：
      // "tokenFile": "mcp/laptop.token",       // 存在则读、不存在则生成（0600，规则同 host.tokenFile）
      "scopes": ["read", "send:lark-bot:default:*", "input:dev:*"],
      "principal": "external:laptop",           // 缺省 external:<名字>；必须以 external: 开头
      "labels": ["ops"],                        // 总带 external；owner 拒绝
      "declare": false                          // true：可用 X-Agents-IO-Declared 头说明替谁做
    }
  },
  "limits": { "maxBodyBytes": 262144, "maxTextChars": 16000, "requestsPerMinute": 120, "writesPerMinute": 20 }
}
```

- 没有这一节（或 `enabled: false`）就不监听，`host.hello` 的 `features` 不列 `external.mcp`。
- **scope**（`*` 匹配任意一串字符，含 `:` 与 `/`，其余照字面）：
  - `read`：读全部会话，以及守护进程级的状态（通道、宿主、agent）；`read:<会话模式>`：只读匹配的会话。
  - `send:<路由模式>`：可以往匹配的路由键（`channel:account:conversation[:thread]`）发消息。
  - `input:<会话模式>`：可以往匹配的会话排一条输入。
  - 一个 scope 都没有的客户端只能握手，列不出任何工具。
- 令牌：每个客户端一个，不得与宿主令牌相同，两个客户端不得相同；`tokenFile` 不得重复。令牌不进日志、错误信息、`GET /api/config`（`token` 只显示 `env:` 引用，`tokenFile` 是路径不是凭据）。
- 宿主的 `external` 回调超时：`hostCallouts.external.timeoutMs`（缺省 2000 ms）。

## 3. 工具

只列出、只允许调用者 scope 允许的工具（同 CF-6 的做法）：

| 工具 | scope | 做什么 |
|---|---|---|
| `sessions_list { agent? }` | `read*` | 可读的会话：键、agent 与地址 `<agent>/<sessionKey>`、状态、正在跑的轮次、排队数、待批请求、最后事件时间、所答的对话（路由键） |
| `session_events { session, from_seq?, tier?, limit? }` | `read*` | 一个会话的日志，按层级（`final` 缺省、`headline`、`card`、`full`）投影；不给 `from_seq` 取最新 `limit` 条，给了就往后翻页（`next_from_seq`）；单个超长字符串截断，一次答复约 200k 字符封顶 |
| `explain { id, chain? }` | `read*` | 与 `aio explain` 相同；`read:<模式>` 的客户端只能解释所涉会话全在模式内的 id |
| `channels_status {}` | `read` | 通道、宿主连接、agent |
| `send_message { route, text, operation_id?, reply_to_message_id? }` | `send:…` | 以守护进程的通道账号发一条文本 |
| `session_input { session, text }` | `input:…` | 往会话排一条输入；答复留在会话日志里，用 `session_events` 读 |

没有订阅、没有流：外部客户端轮询 `session_events`（原则 1：日志是唯一真相，这里只是它的又一个投影）。没有审批、打断、控制。

## 4. 身份：守护进程盖章

```ts
origin = {
  kind: 'peer',                                            // 本守护进程之外的 agent（协议里早有、此前无人产生）
  principal: { id: 'external:<name>', labels: ['external', ...] },
  evidence: 'device_only',                                 // 回环连接 + 自己的令牌
  declared?: '<替谁做>',                                    // 只有 declare: true 的客户端，经 X-Agents-IO-Declared
  via: 'external:<name>',
  adapter: 'external-mcp',
}
```

- 主体永远不是人：配置里 `principal` 必须以 `external:` 开头、不能是 owners 之一，`labels` 不能有 `owner`。所以默认 `plan` 给 `restricted`，默认 `control` 与审批资格都不会因它升级。
- `declared` 只是记录（宿主做代理时说明它替哪位用户做），守护进程不据此授予任何东西；宿主可以在 `external` 钩子里按它决定。
- 输入带 `cause: { peer: "external:<name>", basis: "none" }`：它在一条 agent 链上的位置不可知（链断）。跳数上限对它无效，同一对来回上限照算（IN-8）：一个外部客户端在一个会话里 15 分钟内开轮超过 10 次、其间没人写，之后的输入只记成上下文。
- 输入有路由记录（`matched[0].bindingId = "external:<name>"`、`source: "config"`），`aio explain <inputId>` 可查；回复路由是会话自己的 `local` 路由，答复只在日志里，不发到任何通道。

## 5. 写：发送与输入

**发送**（`send_message`），按顺序：

1. scope：路由键匹配某个 `send:` 模式；
2. 通道：路由的 `(channel, account)` 有运行中的通道（与宿主 `deliver` 同一规则，决定 8）；
3. 宿主的 `external` 钩子（§6）；
4. 外发检查：声明了 `outbound` 的宿主决定，回调的 `from` 是一个只有一条输入的"轮次"（会话键 `external:<name>`、`replyRoute: null`，输入就是这次请求：来源、正文）；这个宿主离线（含重启后）一律拒绝（外部发送永远不是某一轮自己的回复路由，DL-5）；嵌入方自带的 `Policy.outbound` 照样问；都没有时，客户端的 `send:` scope 就是本地放行（相当于一轮的预登记路由）。
5. 经 outbox 发出：operationId `external:<name>:<operation_id>`，同一个永远只发一次（跨重启，DL-2）；不随附 agent 身份（`SendOp.as`），因为不是 agent 写的。
6. 记录：客户端自己的日志 `external:<name>`（与宿主 `deliver` 的 `host:<name>` 同样的伪会话）里一条 `native` 事件 `agents-io.external`（客户端、主体、`declared`、路由、正文）和 outbox 的 `delivery.settled`；出站记录带 `external: { client, principal, declared? }`，`aio explain <operationId>` 的 `EffectExplanation.external` 说出是谁。

**输入**（`session_input`）：scope；会话必须是本守护进程跑过或登记过的（不能借此新开会话）；`run:` 会话、`host:` / `external:` 投递日志不收；宿主的 `external` 钩子；然后像本地输入一样进 lane（`queue`），过 lane 入口的检查点（IN-8）。

## 6. 宿主怎样再收紧

- **`external` 钩子**（feature `callouts.external`）：`host.hello { callouts: [..., "external"] }` 的宿主对每一次写都会收到 `policy { hook: "external", args: { client, principal, declared?, op: "send" | "input", route?, sessionKey?, content, id } }`，答 `{ verdict: "allow" | "deny", reason? }`（`reason` 原样给客户端看）。超时、出错、答复不合 schema 一律拒绝；声明过这个钩子的宿主断开后（名字记在本地库里，重启后也一样）所有外部写都拒绝，直到它回来，或另一个宿主以不含 `external` 的 `callouts` 连上（交还给 scope）。读不问宿主：scope 决定。
- **`outbound` 钩子**：发送另外还过外发检查（§5 第 4 步），宿主可以像对 agent 的发送一样拒绝，并从 `from.inputs[0].origin` 看出是哪个外部客户端。
- 宿主做自己用户的代理时，常见做法：给代理一个 `declare: true` 的客户端，每个请求带 `X-Agents-IO-Declared: <宿主的成员 id>`；在 `external` 钩子里按成员 id 与目标决定；需要按人限定读时，代理自己过滤，或为不同的读范围配不同的 `read:<模式>` 客户端。

## 7. 安全

- 只听回环（`listen` 非回环在加载配置时报错，没有 `allowRemote`）；拒绝带 `Origin` 头的请求（浏览器）和 `Host` 不是回环名的请求（DNS rebinding）。
- 令牌按 SHA-256 摘要用 `timingSafeEqual` 与每个客户端比较，不提前退出。错误令牌 401（日志每 10 s 至多一行）。
- 请求体上限（缺省 256 KiB，超出 413）；每个客户端每分钟请求数（缺省 120，超出 429 带 `Retry-After`）与写次数（缺省 20，超出工具报错）；`text` 上限 16000 字符。
- 无状态：每个请求新建一个 MCP server 实例，绑定该请求的客户端；GET / DELETE 答 405（规范允许，没有独立 SSE 流）。HTTP 层与宿主 MCP 端点共用 `packages/host-mcp/src/http.ts` 的 `McpHttpEndpoint`。

## 8. 与 agent-messaging §5 设想的不同

| 设想 | 实现 | 依据 |
|---|---|---|
| 外部 agent 进来时 `kind: "agent"` | `kind: "peer"` | `agent` 是本部署 agent 的盖章（ID-7：主体 `agent:<名字>`、证据 `daemon`、可被身份映射改写）；外部客户端不是本部署运行的，用协议里早已有、意为"其他 agent"的 `peer`，免得宿主把两者混为一谈。环路检查把两者都算作 agent 输入（`countsAsAgent`） |
| 证据为端点的认证方式 | `device_only` | 已有的档里最贴切（本机连接 + 凭据），不为它新加一档 |
| cause 由对方声明时 `basis: declared` | 一律 `basis: none` | 没有对方声明跳数的途径（工具不收 hop），不许客户端自填 cause（ID-7 的规则）；成对上限兜底 |
| 同一组通信原语（`agents_list` / `agent_send` …） | 读会话、发消息、排输入 | 第二步的 agent 原语还没做；做了以后在这里加对应工具，地址与 `Policy.contact` 照用 |

## 9. 不做

- 跨机器：端点只听回环，远处的客户端经宿主自己的代理（宿主负责认证、限定与审计）。
- 订阅与推送、审批与代答、打断与控制、`run.start`。
- A2A。
- 让外部客户端开新会话。

## 10. 对严格校验的宿主可见的协议变化

- `policy` 帧多了 `hook: "external"`（只发给 `callouts` 列了它的宿主）；`features` 多了 `callouts.external` 与（端点开着时）`external.mcp`。
- `EffectExplanation.external`、`AdminStatus.externalMcp` 是新的可选字段。
- 输入的 `origin.kind` 可能是 `peer`（schema 里早有），`origin.adapter` 可能是 `external-mcp`。
- `aio sessions` / `GET /api/sessions` 里可能出现 `external:<name>`（客户端的发送日志），与已有的 `host:<name>` 一样。

## 11. 测试

`packages/daemon/test/external-mcp.test.ts`，用 MCP SDK 自己的客户端经 Streamable HTTP 驱动：缺省关闭、只听回环、令牌（文件生成 0600、不得是宿主令牌、字面量与过短拒绝且不回显）、401/403/405/413/429、`declare`；scope（工具清单、`read:<模式>` 的列表/日志/explain、`send:` / `input:` 的目标）；`external` 钩子（拒绝、超时、出错、坏答复、宿主离开与交还）；盖章（`peer`、主体、证据、`declared`、cause、路由记录、`restricted`）；成对上限截停与有人写后解除；发送的幂等、记录与 explain；外发检查（宿主 `outbound` 看到的 `from`、宿主离线拒绝）；端到端一遍。`packages/host-mcp` 的既有测试覆盖 `McpHttpEndpoint` 抽出后的宿主 MCP 端点。
