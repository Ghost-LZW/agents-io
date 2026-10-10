# 宿主接入：以 agents-io 守护进程为 IO 层

> 状态：草案 r2（2026-10-07），按 `docs/design/locus/DECISIONS.md` 的四个决定修订。适用于任何想把输入输出和 agent harness 交给 agents-io、自己只保留业务状态的系统（下称"宿主"）。x-work-os 是第一个例子，但本文不为它特化。

## 1. 原则

- **宿主不依赖 agents-io 的包**，只通过进程边界交互：常驻的 aio 守护进程 + `packages/protocol` 的帧协议与 JSON Schema。宿主用任何语言实现。
- **agents-io 是唯一拉起 harness 的地方**；**哪些消息唤醒哪个 agent、哪个 agent 监听哪些消息，是一张确定性的 Binding 表**。路由里不调用模型；需要语义判断的消息交给宿主，宿主判断后再送回。
- **宿主保存业务状态**；agents-io 的 session 日志与宿主入站队列只是 IO 日志。
- **宿主不在线只会变慢，不会丢输入**：交给宿主的输入进入持久化队列，确认后才前移。

```
          ┌──────────────── 宿主（任意语言，权威状态 + 业务逻辑）────────────────┐
          └──┬───────────┬────────────┬─────────────┬──────────────┬───────────┘
        bindings.put  run.start    deliver     input/resolve   消费宿主入站队列
        (路由表+身份)  (执行一轮)  (推送给人)   (注入、回答)   (推送 ack / aio tail)
             ▼           ▼            ▼             ▼              ▲
   ┌──────────────────────────── aio 守护进程（常驻）───────────────┴───────────┐
   │ 通道 · Binding 表 · 宿主入站队列 · harness 实例 · session/lane · Hub · MCP │
   └────────────────────────────────────────────────────────────────────────────┘
```

## 2. Binding 表

一条输入进来后：通道收下 → 盖章身份（§3）→ 按 Binding 表匹配 → 命中的规则全部生效（扇出）。

```jsonc
{
  "id": "owner-dm",
  "match": {                       // 固定字段，全部满足才命中；不支持正则、OR、时间窗
    "channel": "lark-bot", "account": "default",
    "conversationKind": "dm",      // 或 conversation: "<id>"
    "labels": ["owner"],           // 发送者在身份映射里的标签
    "mentions": ["bot"], "keywords": ["报警"], "actionPrefix": "xwo:"
  },
  "on": "dispatch",                // dispatch | context | digest | host | drop
  "agent": "assistant",            // dispatch/context/digest 的目标 agent（命名的运行配置）
  "session": "main",               // main | per-conversation | per-thread | topic（决定 6：平铺对话的当前话题）
  "digest": { "everyMs": 3600000, "maxItems": 50 },
  "callout": { "timeoutMs": 1500, "onFailure": "host", "skipWhenPinned": true }   // 可选：显式开启同步回调（§2.2）
}
```

- **agents**：配置里命名的运行默认值（harness 实例、model、profile、cwd、工具），不含人设。部署方可以在 agent 上写 `sessionParams`，允许宿主按会话指定工作目录和环境变量（决定 7，§2.3）。`mode: "task"` 的 agent 只能由 `run.start` 启动，任何规则指向它都在加载时报错。
- **来源**：本地配置，以及宿主推送的整表 `bindings.put { version, bindings, identities, expiresAt?, onHostDown: "keep" | "suspend" }`（宿主推送的默认 `suspend`）。同一输入命中多条规则时全部生效；同一 (agent, session) 取最强的动作。
- **watch** 就是 agent 在运行时通过输出工具新增的一条规则，仍受 `Policy.watch` 约束。
- **可解释**：每条输入记下命中的规则 id、表版本、回调结果；`aio explain <inputId>` 列出来。

### 2.1 交给宿主（`on: "host"`）

输入写入**宿主入站队列**：按消费者记游标，至少投递一次，幂等键为渠道消息引用（`channel:<渠道>/<消息 id>`）。两种消费方式，语义相同：

- **推送**：宿主连接守护进程并 `host.hello { inbound: true, consumer }`；守护进程推 `inbound` 帧，宿主回 `result { accepted }` 后前移；断线期间留在队列，重连后补推。
- **拉取**：`aio tail --consumer <name> [--from <cursor>]` 逐行输出 JSON（含 `cursor`）；宿主处理后 `aio ack --consumer <name> <cursor>`。

**补投（`inbound.redispatch { cursor, agent?, session?, launch? }`，feature `inbound.redispatch`）**：宿主可把队列里仍在的一条输入（已 ack 与否均可）投递到它指定的会话，作为这条输入到达时的样子：原始 origin（发送者、主体、证据、来路）、内容、回复路由与渠道上下文不变，只在 `channelContext.redispatchedBy` 记上宿主。会话按一条指向 `agent`（缺省默认 agent）、`session`（缺省 `per-conversation`，或 `{ key }`）的 `dispatch` 规则来定；`launch` 与回调答复同样校验。新输入 id 为 `<原 id>~r<cursor>`。按 cursor **至多一次**：投递前先记一条待定记录、投递后补全；再次请求答复第一次的结果并带 `duplicate: true`；若上一次投递被守护进程停止截断（记录仍是待定），答复带 `interrupted: true`，输入可能已到也可能未到会话，不会再发。失败的投递不记，可换会话重试。`session: { key: "run:…" }`（task run 会话）答 `invalid_frame`；指定的 `agent` 与该会话已有的 agent 不符答 `agent_conflict`，不指定时结果里的 `agent` 是会话自己的 agent。补投直接进会话，不经话题命令处理：条目文本是 `/new`、`/topics`、`/switch` 时作为普通输入送达。不 ack 原条目。`aio explain` 在新输入上显示 `redispatchOf`，在原输入上显示 `redispatched`。典型用途：宿主离线或回调超时期间进入队列的输入，事后补投给会话，不必请人重发。命令行：`aio redispatch <cursor> [--agent] [--session] [--cwd] [--env]`。方案见 `docs/design/inbound-redispatch`。

### 2.2 规则级同步回调（`callout`）

只在声明了 `callout` 的规则上，守护进程向宿主发 `policy { hook: "route", args: { rule, input } }`，宿主返回 `{ on, agent?, session?, launch? }` 覆盖本条规则。超时或出错按规则的 `onFailure` 处理（默认 `host`：进入入站队列）。宿主不在线时直接走 `onFailure`。

**`launch`（决定 7，feature `session.launch`）**：`launch: { cwd?, env? }` 作用于这条输入最终落到的会话键（无论 `session` 是 `per-conversation`、`topic` 还是 `{ key }`），让这个交互会话在自己的工作目录、带自己的子进程环境变量运行，范围由目标 agent 的 `sessionParams` 限定（§2.3）。

- 只能和指向会话的 `on`（`dispatch` / `context` / `digest`）一起出现；`host`、`drop` 带 `launch` 视为答复错误。
- launch 随会话键**固定**并持久化（先到者为准）：同一键再收到相同的 launch 通过（`same`），不同的（包括没有 launch 的已有会话收到 launch）一律 `launch_conflict`。被拒的 launch 按答复错误处理，走规则的 `onFailure`（默认 `host`，输入进入持久队列，不丢）。宿主遇到 `launch_conflict` 应**换会话键**，不要重试。
- 判断是否相同：cwd 比较 realpath，env 比较整张表。要换目录或环境，就换一个会话键（回调答复里给新的 `{ key }`，或对新键 `session.prepare`）。
- 宿主必须先确认 `host.hello` 结果的 `features` 含 `"session.launch"` 再依赖 launch：旧守护进程会静默忽略答复里的 `launch`，会话就落在 agent 的默认目录和环境里。
- 话题会话继承 launch：带 launch 的对话里 `/new`、`session_rotate` 新建的话题沿用上一话题的 launch，之后各自固定；切回旧话题用旧话题自己的记录。
- 守护进程重启、停放话题的 lane 关闭后重开，都按记录的 launch 重建，原生会话照常续接。

**`callout.skipWhenPinned: true`**：规则自身的 `on` 指向会话、且它算出的会话键已有 launch 记录时，不再回调，按规则本身投递。这样回调只出现在每个键的第一条输入（相当于一次"开户"），稳态输入只走本地匹配（决定 2）。代价：键固定以后，宿主不能再逐条把这条规则的输入改判为 `host` 或 `drop`。只能用在 `on` 为 `dispatch` / `context` / `digest` 的规则上，否则加载时报错。

**`aio explain`**：`matched[].callout.outcome` 多了 `skipped_pinned`；答复被判为错误时 `callout.reason` 给出原因（如 `launch_conflict`、`bad_launch`）；答复带了 launch 时 `matched[].launch` 记 `{ cwd?, envKeys, outcome }`：`outcome` 为 `applied`（新会话）、`same`（已固定为同一 launch）或拒绝码。env 只记键，从不记值。

### 2.3 agent 的 `sessionParams`：宿主可以为会话选什么

```jsonc
"agents": {
  "dev": {
    "harness": "claude",
    "cwd": "/srv/aio/dev-default",
    "sessionParams": {
      "cwdRoots": ["/srv/aio/workspaces"],                          // launch.cwd 必须在其中某个根之下
      "envKeys": ["CLAUDE_CONFIG_DIR", "GIT_AUTHOR_NAME"],          // launch.env 只能出现这些键
      "envPathRoots": { "CLAUDE_CONFIG_DIR": ["/srv/aio/homes"] }   // 这些键的值是路径，按 cwd 的规则限定在根内
    }
  }
}
```

- **缺省拒绝**：没写 `sessionParams` 的 agent 拒绝任何 launch（`launch_not_allowed`），行为与没有这项功能时完全相同。未配置 `agents` 时合成的 `default` agent 不能用 launch；`mode: "task"` 的 agent 写 `sessionParams` 加载时报错（它们用 `run.start` 的 `cwd` / `env`）。相对路径相对于配置文件。
- **cwd**：绝对路径、存在、是目录，取 realpath 后仍在某个 `cwdRoots`（同样取 realpath）之下，防止符号链接逃逸。
- **env**：键必须是合法变量名且在 `envKeys` 中；`AGENTS_IO_*` 一律拒绝（守护进程自用）。列在 `envPathRoots` 里的键，值按 cwd 的同一规则校验。
- **配置目录键强制配根**：`CLAUDE_CONFIG_DIR`、`CODEX_HOME` 列进 `envKeys` 却没有对应的 `envPathRoots`，加载配置时报错。
- **其余路径型变量要自己配根**：把一个值是路径的变量（例如 `HOME`、`XDG_CONFIG_HOME`、`GIT_DIR`）只列进 `envKeys` 而不配 `envPathRoots`，**等于允许宿主为会话指定任意路径**。守护进程无法穷举所有路径型变量，只对已知的配置目录键强制。
- **env 的执行**：Claude Code 的 launch env 位于最上层（覆盖实例 `env` 和 `configDir`，所以 launch 的 `CLAUDE_CONFIG_DIR` 生效）；Codex `stdio` 实例上带 env 的会话单独起一个 app-server（launch 的 `CODEX_HOME` 替换实例的 `home`），会话关闭时进程退出；Codex `unix` 实例（共享、比守护进程活得久）带 env 的 launch 直接拒绝（`launch_unsupported`），只带 cwd 可以。env 值只进子进程，存在 0600 的私有数据库里，不进事件流、`aio explain`、日志和 argv。
- **先到者固定这个键**：任何先于 launch 投递到同一会话键、却不带 launch 的规则（例如群里的 `context` / 只记录规则，在回调规则之前命中），都会把这个键固定为"无 launch"，之后带 launch 的答复只会得到 `launch_conflict`。需要 launch 的部署，应让指向这些键的所有规则都经过回调，或者由宿主在任何输入之前对键 `session.prepare`。
- **这不是隔离边界**：同一 OS 用户下的 harness 子进程仍可读到彼此可读的文件。需要真正隔离的部署要靠 OS sandbox 或独立用户。范围是部署方给宿主划的上限，不替代宿主自己的检查。

## 3. 身份

- 通道提供渠道身份和证据（平台签名、DKIM、内部投递、发送方表明的身份）。
- 宿主随 `bindings.put` 推送**身份映射**：`{ channel, channelUserId } → { principal: "<宿主成员 id>", labels: [...] }`。盖章后 `Origin.principal` 就是宿主的成员 id；规则的 `labels` 按它匹配。
- 证据不足（如没有 DKIM 的邮件）时，即使映射命中也按外部来源处理。
- 一个渠道身份至多对应一个成员、多人共用账号不得绑定，由宿主保证；冲突时守护进程报错。
- 无宿主时，本地 `owners` 配置是映射的最简形式。
- 渠道与证据由守护进程盖章（channel-stamping，决定 13）：信封的 `channel/account` 必须是发出它的通道实例，否则拒收；证据以该通道条目的 `evidence` ∩ 适配器 caps 为上限（bridge、module 默认只有 `device_only`），超出的降为 `none`。宿主看到的身份证据因此只可能来自有资格给出它的通道，见 `docs/CHANNELS.md` §5"通道盖章"。
- `input.verify { channelRef }`：宿主可以查询某条渠道消息的平台作者与证据（例如 x-work-os 0010 §4.8 核验"确认消息的作者"）。记录的是**封顶后**的证据；宿主入站队列 `InboundItem.envelope` 同样。被拒收的信封查不到记录。

## 4. 宿主协议

本地 unix socket（目录 0700、socket 0600），JSONL，请求带 `id`、同 `id` 的 `result` 应答。宿主连接先 `host.hello { token, name, consumer?, callouts? }`；token 由守护进程每次启动时重新生成，写入 socket 旁的 0600 文件 `<socket>.token`；运维可用 `aio serve --token-file <path>` 或配置 `host.tokenFile` 指定一个跨重启不变的令牌文件（存在则读、不存在则生成，见 `docs/design/host-token-file`）。带 token 的连接数量不限（`aio run`、`aio tail` 等命令都是这样的连接）；`hello` 里带 `consumer`（推送消费）或开启任一回调钩子（`callouts`）的连接才是**宿主**，同一时刻至多一个。宿主在线时，`onHostDown: "suspend"` 的宿主表生效，回调发给它，发起连接已断开的 run 的 `run.ended` 也发给它。只拉取的宿主（`aio tail` / `inbound.read`）没有这样的常驻连接，守护进程始终视它为不在线：它的表要用 `onHostDown: "keep"`，并定期重推（`bindings.put`）、每次给一个新的 `expiresAt` 当租约（例如每隔 T 重推一次，`expiresAt = now + 2T`），宿主停止重推后表到点挂起；否则默认的 `suspend` 表一直不生效（§6）。协议里曾有的 `host.hello.lease` 守护进程从未实现，已删除（决定 13）；旧宿主仍带这个字段不会被拒，只是被忽略。已有宿主时再来一个带角色的 `hello` 默认得到 `host_connected`；带 `takeover: true`（且 token 正确）则顶替旧连接：守护进程关闭旧连接、记日志，旧连接未确认的推送改推给新连接，结果里带 `replaced: { name }`（宿主断线重连而旧连接半开时用）。控制台 `/ws` 有心跳（`console.heartbeat`，默认每 30 s ping，10 s 内无应答即断开），半开的远程宿主连接会被及时清掉（见 `docs/design/host-liveness`）。宿主连接也可以发送所有客户端帧（`subscribe`、`input`、`resolve` 等，见 `packages/protocol/src/client.ts`），`origin` 标记为 `kind: "system"`。

| 帧 | 方向 | 用途 |
|---|---|---|
| `bindings.put` / `bindings.get` | 宿主 → 守护进程 | 原子替换 / 读取 Binding 表与身份映射 |
| `run.start` / `run.cancel` | 宿主 → 守护进程 | 用 `mode: task` 的 agent 执行一轮：新的 session `run:<runId>`，结束即关闭；`env` 只进子进程环境 |
| `run.ended` | 守护进程 → 宿主 | `{ runId, status, exitCode, durationMs?, usage? }`；`status` 含 `timeout`（`timeoutMs` 到期） |
| `deliver` | 宿主 → 守护进程 | 推送给人，按 `operationId` 幂等；按钮点击按 `actionPrefix` 规则回到宿主。由 `route` 的 `(channel, account)` 对应的通道发出；该账号没有通道时，只有当这个通道 id 恰好一个条目才用它发，否则 `unknown_channel`（多个飞书机器人时不会以别的机器人发出，决定 8） |
| `inbound` | 守护进程 → 宿主 | §2.1 推送消费 |
| `policy` | 守护进程 → 宿主 | §2.2 回调（`hook: "route"`），以及按 `hello.callouts` 开启的 `resolve`、`outbound` 同步钩子（§4.1，超时 fail closed） |
| `input.verify` | 宿主 → 守护进程 | §3 |
| `session.prepare` | 宿主 → 守护进程 | 为不经渠道路由打开的会话键预先登记 agent 和 launch（§2.2、§2.3） |
| `inbound.redispatch` | 宿主 → 守护进程 | 把宿主入站队列里的一条输入按原始来源投递到指定会话（§2.1） |

`run.start` 可带 `overrides: { model?, effort?, profile? }`，只覆盖本次运行的 agent 默认值。

### 4.1 回调钩子与代答

`host.hello.callouts` 是 `boolean | string[]`：`true` 等于 `["route"]`；列表可含 `route`、`resolve`、`outbound`，未知名字忽略，结果的 `callouts` 列出实际开启的钩子。方案见 `docs/design/host-callouts`。

**`resolve` 与 `outbound` 两个钩子已冻结**（决定 13）：行为不变、照常可用，但不再增加钩子种类或参数，没有使用者之前也不为它们做新设计；新宿主不应依赖它们去表达本可以随表推送的静态规则。

- **`resolve`**：`policy { hook: "resolve", args: { request, ctx } }`（`request.opened` 的事件体与 `TurnContext`，与 `Policy.resolve` 参数相同），答复一个 `Resolver`。超时（配置 `hostCallouts.resolve.timeoutMs`，默认 3000 ms）、出错、答复不合 schema 或宿主不在线时，按守护进程本地策略决定。
- **`outbound`**：`policy { hook: "outbound", args: { from, to } }`，答复 `{ verdict: "allow" | "deny" }`。开启后超时（`hostCallouts.outbound.timeoutMs`，默认 2000 ms）、出错、答复不合 schema 一律 `deny`；没有开启的宿主时按本地策略。**宿主离线时也 fail closed**（2026-10-11，INVARIANTS DL-5）：开启过 `outbound` 的宿主断开后（守护进程重启后也一样，名字记在本地库里），只放行本轮自己的回复路由，本地策略额外允许的去向（预注册的 `routes`）一律拒绝，守护进程记一条 warn；直到它重新连上，或另一个宿主以不含 `outbound` 的 `callouts` 连上（把外发交还本地策略）。
- **代答**：宿主连接（`origin.kind = "system"` 且 `origin.adapter = "host"`；网关与会话 lane 各查一次）发 `resolve` 时可带 `onBehalfOf: "<成员 id>"`。`human` 请求要求该成员在 `principals` 里；日志记 `request.resolved.by = { kind, id: <成员>, via: "host:<名字>" }`。非宿主连接带 `onBehalfOf` 答 `not_eligible`。**须部署方显式开启**（决定 13）：配置 `"policy": { "answerOnBehalf": true }`，缺省 `false`；未开启时宿主连接带 `onBehalfOf` 的 `resolve` 答 `on_behalf_not_allowed`（请求保持打开，宿主仍可不带 `onBehalfOf` 以自己的名义作答），`host.hello` 的 `features` 也不列 `"resolve.onBehalfOf"`。这是"以别人的名义作答"的唯一开关，决定 12 的 agent 代为审批以后也挂在它下面，不另设开关。**行为变化（2026-10-11）**：此前任何带 token 的宿主都能代答；依赖代答的部署升级后要加这一项。

**能力协商**：`host.hello` 的结果带 `features: string[]`，按能力名协商而不是按版本号。目前有 `"session.launch"`：回调答复可带 `launch`、可用 `session.prepare`、规则可用 `callout.skipWhenPinned`；`"callouts.resolve"`、`"callouts.outbound"`、`"resolve.onBehalfOf"`（§4.1，只在 `policy.answerOnBehalf` 开启时列出）；`"inbound.redispatch"`（§2.1）；`"host.takeover"`：`host.hello` 支持 `takeover: true`（§2）。旧守护进程的 `callouts` 只接受布尔。推荐做法：直接发钩子列表，收到 `invalid_frame` 再用 `callouts: true` 重发（旧守护进程只有 `route`）。不要先用 `callouts: true` 握手探测 features：那次握手已让这条连接成为**唯一的**宿主、只开了 `route`，想换成列表必须断开重连，期间占着宿主位置。结果里没有某个 feature 时，宿主不得依赖它。

**`session.prepare { sessionKey, agent, launch }`**：用于不经渠道路由打开的会话（宿主连接发的客户端 `input` 帧、本地 `aio input` / `aio attach`、指向该键的 watch），也可以让宿主在键可预知时（如成员入驻时建群）提前登记，规则就不必开回调。它只登记（agent 行与 launch 行在同一事务里写入），不拉起 harness；第一条输入到达时按登记建 lane。结果 `{ sessionKey, agent, launch: { cwd?, envKeys }, created }`：同一键用相同的值再 prepare 幂等（`created: false`）。错误码：`unknown_agent`、`not_interactive_agent`、`launch_not_allowed`（agent 没有 `sessionParams`）、`bad_cwd`、`bad_env`、`launch_unsupported`（Codex `unix` 实例带 env）、`launch_conflict`（键已有不同的 launch，或已是无 launch 的会话）、`agent_conflict`（键已属于另一个 agent）、`invalid_frame`（含 `run:` 前缀的键，task run 用 `run.start`）。遇到 `launch_conflict` 换键，不要重试。每个请求的 `result.value` 都有 schema（`packages/protocol/src/host.ts` 末尾的 `HOST_RESULT_VALUES`，JSON Schema 见 `packages/protocol/schema/*Result.json`）。

**宿主写命令的来源标记**：守护进程为每一轮算出来源摘要（是否含 context/digest/外部/群聊输入），附在输出工具的每次调用上（`agents-io.output` 记录的 `provenance` 字段；宿主 MCP `onCall` 事件的 `provenance` 只在进程内嵌入时可用，远程宿主收不到），交互 session 与任务运行都是如此（见 CHANNELS.md §1a 的来源标记）。来源不进 harness 子进程的环境变量：任务运行只带 `AGENTS_IO_RUN_ID`（让工作区里的宿主命令能把调用对到这次运行）；原有的 `AGENTS_IO_TURN_PROVENANCE` 值恒定（`triggeredBy: ["host:<名>"]`，其余为 `false`），发起运行的宿主本来就知道，已删除（决定 13）。不拦截任何调用（决定 4）。

**交互 session 里的宿主写命令：带 `ref`，宿主自己核验**（决定 4 的兑现方式，决定 13）。按原则 7，agent 是在工作区里直接调宿主命令（如 `x`）写入的，这次调用不经过 agents-io，守护进程没法往上附来源。所以来源换成一个宿主能独立验证的事实：给模型的发送者说明行里，来自渠道消息的输入带 `ref=channel:<通道>/<消息 id>`（CHANNELS §1）；agent 调宿主写命令时把触发它的那条消息的 `ref` 当参数带上；宿主用 `aio verify <ref>`（`input.verify { channelRef }`）查到这条消息的平台作者、主体、标签与封顶后的证据，按自己的规则决定收不收（例如"确认"必须来自 `owner` 且证据为 `platform_signed`）。没有 `ref` 的写请求（agent 自发、本地输入、宿主自己发的 `input`）由宿主决定怎么对待。`ref` 证明的是"这个人确实发过这条消息"，不证明这条消息就是触发本次命令的那条：agent 可能拿会话里更早的一条消息的 `ref`。核验结果带 `conversation`、`receivedAt` 与 `inputId`，宿主可以据此再加约束（同一会话、足够新、一条消息只认一次确认）。

## 5. 命令行（给不想写 socket 客户端的宿主）

| 命令 | 等价于 |
|---|---|
| `aio run --agent <name> --run-id <id> --cwd <dir> [--env K=V…] -- <指令>` | `run.start`，阻塞到 `run.ended`，以 `exitCode` 退出 |
| `aio send --route <json> --operation-id <id> < message.json` | `deliver` |
| `aio tail --consumer <name>` / `aio ack --consumer <name> <cursor>` | §2.1 拉取 |
| `aio bindings put < table.json` | `bindings.put` |
| `aio explain <inputId>` | 路由解释 |
| `aio verify <channelRef>` | `input.verify` |

`aio run` 的退出码：0 完成、1 失败、3 结果不明（ambiguous）、124 超时、130 被取消；其余命令：2 用法/配置错误，69 守护进程未运行，77 token 错误。

## 6. x-work-os 怎样用（例子）

| x-work-os 的位置 | 实现 |
|---|---|
| start-executor 适配器（0003） | Go 薄客户端或直接 `aio run`：`StartRequest` → `aio run --agent executor --run-id <run 引用> --cwd <workdir> --env XWO_CREDENTIAL_FILE=…`，退出码即 `exit_code` |
| to-human 适配器（0003 / 0006） | `aio send`：按 0010 的绑定把成员映射成路由；提问、审批渲染为带按钮的卡片，按钮 id 以 `xwo:` 开头 |
| 接收程序（0008）与经渠道回答（0010） | 长期运行的 `aio tail --consumer xwo`：每条记录变成 `x input add` 或 `x answer`（带渠道凭证和渠道引用），成功后 ack。`aio tail` 只拉取，不让连接成为宿主，所以 x-work-os 推的表必须用 `onHostDown: "keep"`，并定期重推、每次带新的 `expiresAt`（如每 5 分钟重推，`expiresAt = now + 10 min`）；不这样做，表一直按 `host_down` 挂起，规则不生效（§4）。改用推送消费（`host.hello { consumer }`）则可用默认的 `suspend` |
| 身份 | x-work-os 把 0010 的渠道身份绑定转成身份映射，随 `bindings.put` 推送 |
| 讨论会话（0005 F） | 一条 `dispatch` 规则把主人的私聊交给交互 agent；确认时 agent 在工作区里调 x-work-os 命令，带上触发它的那条消息的 `ref=channel:<通道>/<消息 id>`（发送者说明行里有）；x-work-os 用 `aio verify <ref>` 核验确认者与证据，不信 agent 的转述（§4.1） |

x-work-os 核心不依赖 agents-io；换成别的 IO 实现，只需换掉这些适配器。

## 7. 待定

- 多宿主、宿主重连后对运行中 run 的恢复。
- 版本协商：已改为按能力名协商（`host.hello` 结果的 `features`，§4）；`PROTOCOL_VERSION` 只在不兼容的改动时变。
