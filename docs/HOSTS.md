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
- **来源**：本地配置，以及宿主推送的整表 `bindings.put { version, bindings, identities, expiresAt?, onHostDown: "keep" | "suspend" }`（宿主推送的默认 `suspend`）。`version` 都是十进制整数（计数器、毫秒时间戳）时有先后：比当前表小的推送答 `stale_version`、不替换（迟到的旧推送不覆盖新表）；其他形式的版本是不透明标签，任何一个都替换。同一输入命中多条规则时全部生效；同一 (agent, session) 取最强的动作。
- **watch** 就是 agent 在运行时通过输出工具新增的一条规则，仍受 `Policy.watch` 约束。
- **可解释**：每条输入记下命中的规则 id、表版本、回调结果；`aio explain <inputId>` 列出来。

### 2.1 交给宿主（`on: "host"`）

输入写入**宿主入站队列**：按消费者记游标，至少投递一次，幂等键为渠道消息引用（`channel:<渠道>/<消息 id>`）。两种消费方式，语义相同：

- **推送**：宿主连接守护进程并 `host.hello { inbound: true, consumer }`；守护进程推 `inbound` 帧，宿主回 `result { accepted }` 后前移；断线期间留在队列，重连后补推。
- **拉取**：`aio tail --consumer <name> [--from <cursor>]` 逐行输出 JSON（含 `cursor`）；宿主处理后 `aio ack --consumer <name> <cursor>`。

条目里的 `input.channelContext` 与 `envelope`（路由回调的 `args.input` / `args.envelope` 也一样）在通道给得出时带回复链：`rootMessageId`（链或话题的第一条）、`parentMessageId`（这条回复的那一条），都是通道自己的消息 id（飞书 `root_id` / `parent_id`，私聊、群、话题都有）。宿主可据此判断一条回复是在回哪条消息（例如自己 `deliver` 过的通知）。模型的发送者说明行不显示这两项。

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
- **agent 的身份**（agent 通信地基，`docs/design/agent-messaging/`）：每个 agent 的地址是它的名字，每个会话是 `<agent>/<sessionKey>`（路由形式 `agent:<agent>:<sessionKey>`）。本部署 agent 产生的输入由守护进程盖章：`kind: "agent"`、主体默认 `agent:<agent>`（标签 `agent`）、证据 `daemon`（新的一档：守护进程自己产生的记录，适配器不能声明）、`via` 为发送会话的地址。宿主可以用身份映射把 `{ channel: "agent", channelUserId: "<agent>" }` 映射成自己的成员 id 与标签；**agent 主体不能带 `owner` 标签**，映射里出现即配置错误（本地表启动失败，`bindings.put` 被拒）。所以 agent 转话不会让默认 `plan`（全主人输入才 `bypass`）、默认 `control` 或审批资格升级。
- **cause 链**：agent 产生的输入带 `InputRecord.cause`（`peer`、`basis`、`hop`、`chain`、`from`、`rootPrincipal`、`carried`），只由守护进程得出，客户端与适配器都不能设置；同一条输入换地方（watch 转投、话题换手、`inbound.redispatch`）时不变。每轮的 `TurnProvenance` 多了可选的 `cause: { hop, chain, rootPrincipal }`，随宿主写请求与 `agents-io.output` 事件出去；`rootPrincipal` 只是来源标记，守护进程不用它决定权限，宿主要放行"主人开的链上的 agent 转话"时在自己的 `Policy.plan` 里决定。本部署发出的消息经通道回来（同部署的另一个飞书机器人、邮件回声）时由出站索引按平台消息 id 认出，标 `self`、主体为发出它的 agent，不需要再手写 `selfAccounts`。
- **防循环**：要开轮的 agent 输入在会话 lane 入口受两道上限（`policy.loopGuard`）：跳数超过 `maxHops`（默认 8），或同一对 agent 自上次有人说话以来在 15 分钟内来回超过 10 轮（`pair: { maxTurns, windowMs }`）。截停的输入记成上下文（下一次有人触发的轮次会看到，带 `loopGuard=`），接收与发送会话的日志各有一条 `notice { code: "loop_guard" }`，`aio explain` 带 `loopGuard`；通道上什么都不发。宿主经已有途径看到：会话事件、`inbound.redispatch` 的 `disposition: "observe_only"`。
- **对严格校验的宿主可见的协议变化**（2026-10-11）：`Origin.evidence` 多了 `daemon`；`InputRecord.cause`、`TurnProvenance.cause`、`RouteExplanation.cause` / `loopGuard` 是新的可选字段；`notice.code` 多了 `loop_guard`；`explain` 的结果可能是 `EffectExplanation` 或 `ChainExplanation`（JSON Schema 见 `packages/protocol/schema/ExplainResult.json`）；`policy` 帧多了 `hook: "contact"`（只发给 `callouts` 列了它的宿主）。
- **外部客户端的身份**（对外 MCP 端点，§4.2）：本守护进程之外的 agent 经端点排进会话的输入由守护进程盖章：`kind: "peer"`、主体 `external:<客户端名>`（标签 `external`，永远不带 `owner`、不是任何成员）、证据 `device_only`、`via: "external:<客户端名>"`；配置允许时 `origin.declared` 记它说替谁做。它带 `cause: { peer: "external:<名>", basis: "none" }`，过 lane 的同一对来回上限。宿主不能用身份映射改写它（它不经过通道与路由）；要按人限定，在 `external` 钩子里看 `declared`（§4.1）。
- `input.verify { channelRef }`：宿主可以查询某条渠道消息的平台作者与证据（例如 x-work-os 0010 §4.8 核验"确认消息的作者"）。记录的是**封顶后**的证据；宿主入站队列 `InboundItem.envelope` 同样。被拒收的信封查不到记录。

## 4. 宿主协议

本地 unix socket（目录 0700、socket 0600），JSONL，请求带 `id`、同 `id` 的 `result` 应答。宿主连接先 `host.hello { token, name, consumer?, callouts? }`；token 由守护进程每次启动时重新生成，写入 socket 旁的 0600 文件 `<socket>.token`；运维可用 `aio serve --token-file <path>` 或配置 `host.tokenFile` 指定一个跨重启不变的令牌文件（存在则读、不存在则生成，见 `docs/design/host-token-file`）。带 token 的连接数量不限（`aio run`、`aio tail` 等命令都是这样的连接）；`hello` 里带 `consumer`（推送消费）或开启任一回调钩子（`callouts`）的连接才是**宿主**，同一时刻至多一个。宿主在线时，`onHostDown: "suspend"` 的宿主表生效，回调发给它，发起连接已断开的 run 的 `run.ended` 也发给它。只拉取的宿主（`aio tail` / `inbound.read`）没有这样的常驻连接，守护进程始终视它为不在线：它的表要用 `onHostDown: "keep"`，并定期重推（`bindings.put`）、每次给一个新的 `expiresAt` 当租约（例如每隔 T 重推一次，`expiresAt = now + 2T`），宿主停止重推后表到点挂起；否则默认的 `suspend` 表一直不生效（§6）。协议里曾有的 `host.hello.lease` 守护进程从未实现，已删除（决定 13）；旧宿主仍带这个字段不会被拒，只是被忽略。已有宿主时再来一个带角色的 `hello` 默认得到 `host_connected`；带 `takeover: true`（且 token 正确）则顶替旧连接：守护进程关闭旧连接、记日志，旧连接未确认的推送改推给新连接，结果里带 `replaced: { name }`（宿主断线重连而旧连接半开时用）。控制台 `/ws` 有心跳（`console.heartbeat`，默认每 30 s ping，10 s 内无应答即断开），半开的远程宿主连接会被及时清掉（见 `docs/design/host-liveness`）。宿主连接也可以发送所有客户端帧（`subscribe`、`input`、`resolve` 等，见 `packages/protocol/src/client.ts`），`origin` 标记为 `kind: "system"`。

| 帧 | 方向 | 用途 |
|---|---|---|
| `bindings.put` / `bindings.get` | 宿主 → 守护进程 | 原子替换 / 读取 Binding 表与身份映射 |
| `run.start` / `run.cancel` | 宿主 → 守护进程 | 用 `mode: task` 的 agent 执行一轮：新的 session `run:<runId>`，结束即关闭；`env` 只进子进程环境；可带 `overrides`、`inputId`、`correlation`（见下） |
| `run.ended` | 守护进程 → 宿主 | `{ runId, status, exitCode, error?, durationMs?, usage?, turnId?, inputId?, correlation? }`；`status` 含 `timeout`（`timeoutMs` 到期） |
| `deliver` | 宿主 → 守护进程 | 推送给人，按 `operationId` 幂等；按钮点击按 `actionPrefix` 规则回到宿主。由 `route` 的 `(channel, account)` 对应的通道发出；该账号没有通道时，只有当这个通道 id 恰好一个条目才用它发，否则 `unknown_channel`（多个飞书机器人时不会以别的机器人发出，决定 8）。结果（`DeliverResult`）带平台消息 id `providerMessageId`；通道报告消息落在哪个话题时还带 `providerThreadId`（飞书：发送接口返回的 `thread_id`，例如 `reply_in_thread` 开出的新话题），重复的 `deliver` 照样带回 |
| `inbound` | 守护进程 → 宿主 | §2.1 推送消费 |
| `policy` | 守护进程 → 宿主 | §2.2 回调（`hook: "route"`），以及按 `hello.callouts` 开启的 `resolve`、`review`、`outbound`、`contact`、`external` 钩子（§4.1，超时 fail closed） |
| `explain { inputId, chain? }` | 宿主 → 守护进程 | 一条输入的路由记录；`inputId` 不是输入而是某次投递的 operationId 时，答产生它的会话、轮次与该轮的触发输入；`chain: true` 时沿 cause 链走回根（§5 `aio explain`） |
| `input.verify` | 宿主 → 守护进程 | §3 |
| `session.prepare` | 宿主 → 守护进程 | 为不经渠道路由打开的会话键预先登记 agent 和 launch（§2.2、§2.3） |
| `inbound.redispatch` | 宿主 → 守护进程 | 把宿主入站队列里的一条输入按原始来源投递到指定会话（§2.1） |
| `session.compact` | 宿主 → 守护进程 | 让一个安静的、lane 打开着的会话的 harness 立刻压缩上下文（见下） |
| `session.prewarm` | 宿主 → 守护进程 | 不开轮，先把一个已知会话的 harness 拉起来，等快要到的输入（见下） |
| `test.replay` / `test.fault` | 宿主 → 守护进程 | 测试入口：重投一条渠道消息 / 扔掉某通道接下来几次发送的响应（§4.3；缺省关闭，只在 `AIO_TEST_HOOKS=1` 时可用） |

**任务运行的三个可选项**（方案见 `docs/design/run-overrides`，不变量 RN-2、RN-3、EX-7；旧守护进程接受这些字段然后忽略，宿主必须先看 `features`）：

- **`overrides: { preset?, model?, effort?, profile? }`**（feature `run.overrides`）：只改这一次运行。`preset` 把 harness 实例、模型、力度换成那个 preset 的（运行仍以这个 agent 的身份：缺省 cwd 仍是 agent 自己的，不跟着 preset 的实例走；指令也是 agent 的）；`model` / `effort` 再盖在上面，原样传给 harness；`profile` 缺省取 agent 的、再缺省 `restricted`。值不是一个普通记号、preset 没有配置，或（带 `profile` 或 `preset` 时）profile 既不是运行所在实例的 `profiles` 里有的、也不是内置的（`bypass`、`restricted`），整个请求答 `bad_override`，什么都不起。`run.start` 的答复带 `run`：实际用的 RunSpec（与日志里 `turn.started.run` 相同）。守护进程不按 agent 限定宿主能选什么：`profile` 可以升到 `bypass`，`preset` 可以挪到任何已配置的实例（连同它的凭据与配置目录）。替别人发起运行的宿主（例如把工作委派给 task agent）要自己限定可选的 preset、模型与 profile，并总是给出 `cwd`。
- **`run.ended` 的事实**（feature `run.ended.usage`）：`inputId`；`turnId`（开了轮才有）；`durationMs`（日志里从输入被接纳到记下结局的那条记录）；`usage`（这一轮 `turn.completed.usage` 原样转出，harness 没报就没有）。`timeoutMs` 到期的运行 `status: "timeout"`、退出码 124（`error.code` 仍为 `timeout`），会话日志里有一条 `notice { code: "run_timeout" }`。守护进程停止时被打断的运行 `status: "interrupted"`、`error.code: "daemon_stopping"`，日志里有 `notice { code: "run_stopping" }`；harness 关会话时把这一轮记成 `ambiguous` 的照答 `ambiguous`（不要自动重试）。每次运行的结局都写在日志里（harness 没记的由守护进程补记），`run.ended` 由日志构建，所以同一 runId 再发 `run.start` 得到的 `ended` 与第一次的 `run.ended` 相同，重启后也一样；上一个进程留下、没有结局的运行答 `ambiguous`（`host_restarted`），没有 `durationMs`。
- **`inputId`、`correlation`**（feature `run.correlation`）：`inputId` 是这次运行的输入 id（1–256 个字母、数字、`.`、`_`、`:`、`-`，以字母或数字开头，否则 `bad_input_id`），也是这次运行产生的 cause 链的 chain id；别的输入已有这个 id 的路由记录答 `input_id_taken`，所以宿主应在自己的命名空间里取。`correlation` 是不透明字符串（≤ 256 字、无控制字符，否则 `bad_correlation`），记在 `InputRecord.correlation` 上（日志里有，宿主回调的 `ctx.inputs` 里有，模型看不到），`run.ended` 带回。run 的输入有路由记录：`aio explain <inputId>` 答 `matched[0].bindingId: "host:run"` 与 `run: { runId, correlation? }`，`explain --chain` 的根那一级也带 `run`。`run.start` 的答复带 `inputId`。
- **对严格校验的宿主可见的协议变化**（2026-10-19）：上面的字段都是新增的可选字段；`notice.code` 多了 `run_timeout`、`run_stopping`；超时的 `run.ended.status` 由 `interrupted` 改为协议里早有的 `timeout`。

### 4.1 回调钩子与代答

`host.hello.callouts` 是 `boolean | string[]`：`true` 等于 `["route"]`；列表可含 `route`、`resolve`、`review`、`outbound`、`contact`、`external`，未知名字忽略，结果的 `callouts` 列出实际开启的钩子。方案见 `docs/design/host-callouts`。

**`outbound` 钩子已冻结**（决定 13）：行为不变、照常可用，但不再增加参数，没有使用者之前也不为它做新设计。`resolve` 当时也冻结（理由是没有使用者）；有了使用者（蓝饼助手）之后按决定 13 补记 2026-10-21 解冻了下面三项：回调带 harness 的原始请求、`review` 钩子、`human` / `model` resolver 的几个可选字段。新宿主仍不应依赖它们去表达本可以随表推送的静态规则。

- **`resolve`**：`policy { hook: "resolve", args: { request, ctx, native? } }`（`request.opened` 的事件体与 `TurnContext`，与 `Policy.resolve` 参数相同；`native` 是 harness 自己的请求，即该事件在 full 档带的 `native`，Claude Code 是 `{ toolName, input, suggestions, … }`，feature `resolve.native`），答复一个 `Resolver`。超时（配置 `hostCallouts.resolve.timeoutMs`，默认 3000 ms）、出错、答复不合 schema 或宿主不在线时，按守护进程本地策略决定。`human` resolver 可带（feature `resolver.human.extras`）：`timeoutMs`（这条请求多久没人答就拒绝，记 `by: "timeout"`；harness 自己给了 `expiresAt` 时以它为准）、`note`（一行说明，卡片上跟在「Approval needed」之后）、`heading`（这一行在标题前的开头，用宿主的人读的语言，默认 `Approval needed: ` / `Answer needed: `，如 `需要批准：`；1–40 字）、`allowSessionAs: "allow_once"`（人选的 `allow_session` 以 `allow_once` 交给 harness，日志仍记 `allow_session`：「总是允许」由宿主自己记、能撤销，不落成 harness 的权限规则）。`model` resolver 可带 `escalate`（审查升级、出错、超时或没人审时由谁答；不写则 `Policy.escalate`）。
- **`review`**（feature `callouts.review`）：`resolve` 答 `{ kind: "model", model, prompt?, escalate? }` 时，守护进程把审查交给宿主：`policy { hook: "review", args: { request, ctx, model, prompt?, native? } }`，答复 `ReviewCalloutAnswer`：一个 `Decision`（日志记 `by: { kind: "model", id: model }`），或 `{ escalate: true, reason?, resolver? }`（交给 `resolver`，其次 `escalate`，再次 `Policy.escalate`；`resolver` 不能又是 `model`）。lane 不等它：请求挂着、不给任何人看（卡片只显示 `human` 请求），答复到了再结算或重新打开；超时（`hostCallouts.review.timeoutMs`，默认 15000 ms）、出错、答复不合 schema、宿主不在线或没声明这个钩子，都按升级处理。
- **`outbound`**：`policy { hook: "outbound", args: { from, to } }`，答复 `{ verdict: "allow" | "deny" }`。开启后超时（`hostCallouts.outbound.timeoutMs`，默认 2000 ms）、出错、答复不合 schema 一律 `deny`；没有开启的宿主时按本地策略。**宿主离线时也 fail closed**（2026-10-11，INVARIANTS DL-5）：开启过 `outbound` 的宿主断开后（守护进程重启后也一样，名字记在本地库里），只放行本轮自己的回复路由，本地策略额外允许的去向（预注册的 `routes`）一律拒绝，守护进程记一条 warn；直到它重新连上，或另一个宿主以不含 `outbound` 的 `callouts` 连上（把外发交还本地策略）。
- **`contact`**（agent 通信，`docs/design/agent-messaging/` §4.6）：`policy { hook: "contact", args: { from, to, op, turn } }`，`from` 是 `{ agent, sessionKey }`，`to` 是 `{ agent, sessionKey }` 或 `{ agent }`，`op` 为 `list` / `send` / `run` / `observe` / `control`；答复 `{ verdict: "allow" | "deny" }`。超时（2000 ms）、出错、答复不合 schema 时按本地策略：`policy.agentContacts: [{ from, to, ops? }]`（agent 名或 `*`），**不写就是全部拒绝**。钩子已定义，第一步还没有调用它的东西（`agents_list` / `agent_send` 等工具是第二步）。
- **`external`**（对外 MCP 端点，§4.2，feature `callouts.external`）：端点的客户端每做一次写（`send_message` 发消息、`session_input` 排输入）都问一次：`policy { hook: "external", args: { client, principal, declared?, op: "send" | "input", route?, sessionKey?, content, id } }`，答复 `{ verdict: "allow" | "deny", reason? }`（`reason` 原样给客户端）。超时（`hostCallouts.external.timeoutMs`，默认 2000 ms）、出错、答复不合 schema 一律拒绝；声明过它的宿主断开后（名字记在本地库里，重启后也一样）所有外部写都拒绝，直到它重连或另一个宿主以不含 `external` 的 `callouts` 连上。读不问。发送另外还过外发检查：声明了 `outbound` 的宿主照样收到 `outbound` 回调，`from` 是只含这条请求的一轮（会话键 `external:<名>`、`replyRoute: null`、输入的来源是客户端），宿主不必区分新旧形状就能拒绝；没有这样的宿主时，客户端的 `send:` scope 就是本地放行。
- **代答**：宿主连接（`origin.kind = "system"` 且 `origin.adapter = "host"`；网关与会话 lane 各查一次）发 `resolve` 时可带 `onBehalfOf: "<成员 id>"`。`human` 请求要求该成员在 `principals` 里；日志记 `request.resolved.by = { kind, id: <成员>, via: "host:<名字>" }`。非宿主连接带 `onBehalfOf` 答 `not_eligible`。**须部署方显式开启**（决定 13）：配置 `"policy": { "answerOnBehalf": true }`，缺省 `false`；未开启时宿主连接带 `onBehalfOf` 的 `resolve` 答 `on_behalf_not_allowed`（请求保持打开，宿主仍可不带 `onBehalfOf` 以自己的名义作答），`host.hello` 的 `features` 也不列 `"resolve.onBehalfOf"`。这是"以别人的名义作答"的唯一开关，决定 12 的 agent 代为审批以后也挂在它下面，不另设开关。**行为变化（2026-10-11）**：此前任何带 token 的宿主都能代答；依赖代答的部署升级后要加这一项。

**能力协商**：`host.hello` 的结果带 `features: string[]`，按能力名协商而不是按版本号。目前有 `"session.launch"`：回调答复可带 `launch`、可用 `session.prepare`、规则可用 `callout.skipWhenPinned`；`"callouts.resolve"`、`"callouts.outbound"`、`"resolve.onBehalfOf"`（§4.1，只在 `policy.answerOnBehalf` 开启时列出）；`"inbound.redispatch"`（§2.1）；`"host.takeover"`：`host.hello` 支持 `takeover: true`（§2）；`"callouts.contact"`（§4.1）；`"explain.chain"`：`explain` 接受 operationId 与 `chain: true`（§5）；`"run.overrides"`、`"run.ended.usage"`、`"run.correlation"`：任务运行的三个可选项（§4 表下）；`"callouts.external"`（§4.1）；`"callouts.review"`、`"resolve.native"`、`"resolver.human.extras"`（§4.1）；`"external.mcp"`：对外 MCP 端点开着（§4.2，只在配置了 `externalMcp` 且在监听时列出）；`"session.compact"`：宿主替空闲会话压缩上下文（§4 表下）；`"session.prewarm"`：宿主提前拉起会话的 harness（§4 表下）。`"test.hooks"`：`test.replay`、`test.fault` 两个测试入口（§4.3，只在守护进程以 `AIO_TEST_HOOKS=1` 启动时列出）。旧守护进程的 `callouts` 只接受布尔。推荐做法：直接发钩子列表，收到 `invalid_frame` 再用 `callouts: true` 重发（旧守护进程只有 `route`）。不要先用 `callouts: true` 握手探测 features：那次握手已让这条连接成为**唯一的**宿主、只开了 `route`，想换成列表必须断开重连，期间占着宿主位置。结果里没有某个 feature 时，宿主不得依赖它。

**`session.prepare { sessionKey, agent, launch }`**：用于不经渠道路由打开的会话（宿主连接发的客户端 `input` 帧、本地 `aio input` / `aio attach`、指向该键的 watch），也可以让宿主在键可预知时（如成员入驻时建群）提前登记，规则就不必开回调。它只登记（agent 行与 launch 行在同一事务里写入），不拉起 harness；第一条输入到达时按登记建 lane。结果 `{ sessionKey, agent, launch: { cwd?, envKeys }, created }`：同一键用相同的值再 prepare 幂等（`created: false`）。错误码：`unknown_agent`、`not_interactive_agent`、`launch_not_allowed`（agent 没有 `sessionParams`）、`bad_cwd`、`bad_env`、`launch_unsupported`（Codex `unix` 实例带 env）、`launch_conflict`（键已有不同的 launch，或已是无 launch 的会话）、`agent_conflict`（键已属于另一个 agent）、`invalid_frame`（含 `run:` 前缀的键，task run 用 `run.start`）。遇到 `launch_conflict` 换键，不要重试。每个请求的 `result.value` 都有 schema（`packages/protocol/src/host.ts` 末尾的 `HOST_RESULT_VALUES`，JSON Schema 见 `packages/protocol/schema/*Result.json`）。

**`session.compact { sessionKey, inputId? }`**（feature `session.compact`，不变量 CT-3）：宿主趁会话空闲时替它压缩上下文，人下一次说话时不用等。守护进程开一轮，唯一的输入是 harness 自己的压缩命令（Claude Code `/compact`），来源是宿主连接，`replyRoute` 为空：没有回复、进度卡片或通知到任何渠道；之前记下的 context 不交给这一轮，留给下一轮。结果 `{ sessionKey, inputId, turnId?, duplicate }`；这一轮的事件照常进会话日志：`compacting` 通知（Claude Code 的 `compact_boundary` 那一条写着 `context compacted (manual) <前> → <后> tokens`，`native` 里有 `compact_metadata`），`usage`（这次压缩的模型调用在 `modelUsage` 的累计里，`usage.iterations` 为空），`turn.completed`，没有回答文字。只在会话安静时做，否则答 `busy`、什么都不记：有一轮在跑或正在开始、有排队的输入、有未答的请求、有 live。没有打开的 lane 答 `not_live`（不为压缩拉起 harness）；harness 没有压缩命令答 `unsupported`（Codex）；`inputId` 的规则同 `run.start`（`bad_input_id`），同一个 id 再来答 `duplicate: true`、不开轮。这一轮在跑时到达的输入照常排队，结束后开自己的一轮。

**`session.prewarm { sessionKey }`**（feature `session.prewarm`）：宿主知道马上会有输入（提醒、例行快到点）时，先让守护进程把这个会话的 harness 拉起来（Claude Code：CLI 进程、MCP 服务、插件），那一轮就不用等启动。不开轮、不收输入、不调模型、日志里不记任何事件。结果 `{ sessionKey, opened }`：这次请求拉起的为 `true`，已经开着的为 `false`。只对守护进程跑过或登记过的会话（有日志、有 lane、钉过 agent 或 launch），否则答 `not_found`；任务运行（`run:`）答 `invalid_frame`。

**宿主写命令的来源标记**：守护进程为每一轮算出来源摘要（是否含 context/digest/外部/群聊输入），附在输出工具的每次调用上（`agents-io.output` 记录的 `provenance` 字段；宿主 MCP `onCall` 事件的 `provenance` 只在进程内嵌入时可用，远程宿主收不到），交互 session 与任务运行都是如此（见 CHANNELS.md §1a 的来源标记）。来源不进 harness 子进程的环境变量：任务运行只带 `AGENTS_IO_RUN_ID`（让工作区里的宿主命令能把调用对到这次运行）；原有的 `AGENTS_IO_TURN_PROVENANCE` 值恒定（`triggeredBy: ["host:<名>"]`，其余为 `false`），发起运行的宿主本来就知道，已删除（决定 13）。不拦截任何调用（决定 4）。

**交互 session 里的宿主写命令：带 `ref`，宿主自己核验**（决定 4 的兑现方式，决定 13）。按原则 7，agent 是在工作区里直接调宿主命令（如 `x`）写入的，这次调用不经过 agents-io，守护进程没法往上附来源。所以来源换成一个宿主能独立验证的事实：给模型的发送者说明行里，来自渠道消息的输入带 `ref=channel:<通道>/<消息 id>`（CHANNELS §1）；agent 调宿主写命令时把触发它的那条消息的 `ref` 当参数带上；宿主用 `aio verify <ref>`（`input.verify { channelRef }`）查到这条消息的平台作者、主体、标签与封顶后的证据，按自己的规则决定收不收（例如"确认"必须来自 `owner` 且证据为 `platform_signed`）。没有 `ref` 的写请求（agent 自发、本地输入、宿主自己发的 `input`）由宿主决定怎么对待。`ref` 证明的是"这个人确实发过这条消息"，不证明这条消息就是触发本次命令的那条：agent 可能拿会话里更早的一条消息的 `ref`。核验结果带 `conversation`、`receivedAt` 与 `inputId`，宿主可以据此再加约束（同一会话、足够新、一条消息只认一次确认）。

### 4.1a 出口检查：带内容的 `outbound`、声明了范围的 `outbound`（U20，feature `callouts.outbound.content`、`callouts.outbound.scope`、`reply.check`；INVARIANTS DL-7）

有了使用者（一个宿主的群对话出口检查）之后，按决定 13 的规则解冻 `outbound`，只加不改：不声明新名字的宿主、旧守护进程，行为都不变。

- **探测与声明**：先用不占位置的 hello（不带 `consumer`、`callouts` 为空）看 `features`；有 `callouts.outbound.scope` 再用正式的 hello 写 `callouts: [..., "outbound.scoped"]` 并带 `outboundScope: { routes: [{ channel, account, conversationId }] }`（覆盖这些会话的所有 thread）。**只认结果**：结果的 `callouts` 里有 `outbound.scoped`、另带 `outboundScope: { revision, routes }`（条数）才算声明了；旧守护进程忽略这个名字。`outbound` 与 `outbound.scoped` 同时写答 `invalid_frame`；写了 `outbound.scoped` 不带 `outboundScope` 也是。运行中用 `host.outboundScope { routes }` 整份替换，答 `{ revision }` 即生效（别的连接答 `not_scoped`）。范围记在 `DaemonRecords` 的新标记 `host.outbound.scope`，跨重启、宿主断开期间都在；只在一个占宿主位置、不写 `outbound.scoped` 的 hello 时清掉，不占位置的 hello 什么都不改。这条记录读不出来（损坏）时失败关闭：所有路由都算在范围里（受检、宿主不在时扣下），记 error，直到宿主重新声明或替换范围。
- **钩子**：`policy { hook: "outbound", args: { from, to, kind, content?, attachmentText?, turnId?, requestId? } }`；`kind` 是 `reply`（受检的本轮回答）、`tool`（输出工具，写 `agents-io.output` 之前；外部 MCP 的 `send_message` 也是）、`question`（提问卡）、`request`（审批卡）、`title`（话题标题，见下面「话题标题」）；只出现在结算里的还有 `notice`（守护进程自己的提示：拒收、陌生人求入、话题命令等系统回复）、`host`（宿主自己的 `deliver`）和 `live`（`live_say` 说出去的话；范围里不开 live，所以只在范围外），它们不问钩子；`attachmentText` 是文字类附件（`text/*`、JSON、Markdown、CSV，单个不超过 64 KiB）按 blob ref 给的文字。答复 `{ verdict: "allow" | "deny" | "hold", reason? }`；`reason` 会给 agent 看，不要放内容。
- **范围外**：不问宿主，只过本地策略（DL-5 默认），宿主在不在都一样。**范围内**：先过本地策略，再问宿主；宿主不在（断开、重启后还没连上、超时、出错、答复不合 schema）时结算成 `held`（`reason: "host_unavailable"`），本轮自己的回复路由也一样。范围声明期间 `Policy.outbound` 只走本地策略，宿主的判断在发送时带内容问。实时语音（`live_join` / `live_say`）说出来之前没法检查：范围里的路由上不开（`live_join` 报错），`live_say` 时路由在范围里就离开这场 live 并报错，范围替换后落进范围的 live 也当场离开。
- **受检的一轮**：回复路由在这一轮开始时在范围里（路由回调派发、`inbound.redispatch`、`run.start` 的 `observe` 第一项都一样）。开轮时受检的，结算时照样检查：范围中途被替换、甚至被整个清掉（占位置但不写 `outbound.scoped` 的 hello），这一轮受检的回答和卡片仍要过检，没有声明范围的宿主可问就扣下（`host_unavailable`，失败关闭）。`turn.started.checked: true`，不受检的写 `false`；`turn.adopted` 照日志（跨重启保留；重启后接回的轮次不知道当初是哪条路由让它受检，它的所有路由都按受检发）、`turn.delivery_added`（`steer`、`approval`，以及 `run.start` 的 `observe` 多于一项时的 `mirror`）按加进来时的范围带 `checked`，`true` 时那条路由按受检发、这一轮从此受检。宿主 `input` 和外部 MCP 的 `session_input` 的回复路由是本地路由，永远 `checked: false`。受检的路由不流式、不显示过程（不给适配器 `progress`、不开预览），`turn.completed` 以后整条回答先问宿主再发一次；审批卡、提问卡在受检的路由上单独发并先问，请求在发卡之前已经结算就不发。同一会话的下一轮等这条回答结算（最多钩子超时加 5 s）。`hold` 以后，下一轮的输入前面有一条只给 agent 的系统上下文 `held:<operationId>`（「上一条回答没有发出。」加「原因：…」，宿主不在时是「宿主不在，没有发出。」；不带原文）。快照的 `turn.checked` 为真时不填 `partialText`。
- **结算**：`hold` 写一条 `delivery.settled { result: "held", reason }`，不调用适配器、不重试；钩子答 `deny` 写 `result: "rejected"` 加 `denied: true`（有 `reason` 就带上），同样不发，其余和 `hold` 一致：受检的回答在下一轮之前告诉 agent「上一条回答没有发出」，卡片按取消结算，外部读取面一直遮着；输出工具的 held 不写 `agents-io.output`，工具结果是「宿主拿走了这条，没有发出（reason）。不要再发。」；提问卡、审批卡 held 了，这个请求按取消结算（`request.resolved { by: "runtime_cancelled" }`，harness 收到带原因的 `deny`），这一轮不等答复。范围声明期间每个 `delivery.settled` 都带 `kind`（另有 `notice`：拒收提示和话题命令等系统回复）、`turnId`，卡片带 `requestId`；受检的一轮的结算即使范围中途撤了也带；重启时补结算的 `unknown` 也带。
- **外部读取面**：外部 MCP 的 `session_events` 对受检的一轮（从它受检的那条事件起），在回答在每条受检的路由上结算成 `delivered` / `rejected` / `unknown` 以前，事件带 `withheld: "checking"`，`held` 或 `denied` 了一直是 `withheld: "held"`（被拦下的原文不对外放；通道自己拒收的 `rejected` 已经过了检查，照常放开）；被遮的有 `text.delta` / `text.snapshot` 的文字、`reasoning` / `agent_message` 条目的标题和 `result.preview`、`headline`、这一轮所有事件的 `native`（例如 Claude Code `usage` 事件里的 SDK result）。卡片单算：`request.opened` 的 `title`、`inputPreview`、`questions`、`suggestions`，以及开出它的工具条目（同一 `itemId`，例如 Claude Code 的 `AskUserQuestion`）的标题、`inputSummary`、`result.preview`、进度文字，在这张卡在每条受检的路由上结算以前遮住（发到不受检的路由上的那份不算；没发卡的跟着回答走）。宿主连接自己订阅的事件不遮。
- **不带范围的内容钩子**（feature `callouts.outbound.content`）：`callouts` 写 `outbound` 再加 `outbound.content`（单写 `outbound.content` 不算，结果里没有它；和 `outbound.scoped` 一起写是多余的，照准）。DL-5 的语义逐字不变（宿主决定 agent 发往别处的消息；断开时只放行本轮自己的路由；本轮在原路由上的回答不问、不受检，事件里没有 `checked`），只多三样：输出工具的消息在写 `agents-io.output` 之前带 `content`、`attachmentText`、`turnId`、`kind: "tool"` 问一次（不再先问一次不带内容的）；外部 MCP 的 `send_message` 同样带内容；答复可以是 `hold`（结算 `held`，不发，输出工具不写 `agents-io.output`，外部客户端收到「宿主拿走了这条」）；每个 `delivery.settled` 都带 `kind`、`turnId`（卡片带 `requestId`），宿主断开期间、重启后也带（`DaemonRecords` 标记 `host.outbound.content`）。没有内容可问的检查（`live_join` 开在哪里）仍是 `{ from, to }`，这时答 `hold` 按 `deny`。只写 `outbound` 的宿主收到的还是 `{ from, to }`，答 `hold` 不合 schema，按 `deny`。
- **话题标题**：标题会在群里说出来（`/topics`、`/status` 的系统回复按 `notice` 免检发出），外部也读得到（`topic.changed`、本地 socket 的 `topic.list`、agent 的 `session_list` 工具的结果），所以在检查的范围里先过检再记下：话题所在的会话在范围里，或这个 session 有过受检的一轮（范围后来清掉也算，失败关闭）时，后台起标题先等这一轮受检的回答结算，只拿已经过检的内容（人说的话、放开了的回答；还在检查、`held`、`denied` 的回答不进提示词），起好的标题再以 `kind: "title"`、`content: { text: 标题 }`、`to` 为话题所在的会话问一次，`allow` 才记下。agent 用 `session_rotate` 起的标题和它写的摘要（存在离开的那个话题上，`topic.list`、`session_list` 里的 `summary`）一起问一次：`kind: "title"`、`content: { text: 标题, sections: [{ kind: "details", text: 摘要 }] }`（宿主要连 `sections` 一起查，和查回答一样）；`allow` 两样都记下，否则两样都不记：新话题不带标题（以后按上面的规则自动起），离开的话题没有摘要。**合成一问是有意的**：只有摘要该扣、标题本身干净时，标题也一起丢（新话题先不带标题，之后自动起），主线接受这个代价，不拆成两问；宿主不必、也没法只放行其中一样；`topic.changed` 带 `check: "allowed"` 或 `"held"`（没问的不带）。这次检查不发消息，没有结算。不记下的标题和摘要不写进 `topic.changed`、不存进话题，`/topics`、`/status`、`topic.list`、`session_list` 里都没有；agent 写下的原文还在两处：`session_rotate` 的工具条目（`title`、`inputSummary`、`result.preview`；Claude Code 的标题里带着输入）和交给新话题的那份摘要（新话题日志里的 `input.admitted`，`channelContext.topicSummary`；这是她自己的笔记，新话题照样拿到）。外部读取面（上一条）按每一次调用算，不按一轮：一条 `topic.changed.check` 只对应发出它时这一轮里正在跑的那个 `session_rotate` 条目（已开始、未完成；检查就在这次调用里问）。受检的一轮里先遮着这个工具条目（`withheld: "checking"`），它自己的 `check` 是 `allowed` 才放开；`held` 一直遮着（`"held"`），交给新话题的那份摘要同样遮着；没有自己的 `check` 的（问宿主之前就报错的，比如摘要为空；同一轮已经换过话题、被拒的第二次），这次调用结束（或这一轮结束）以后一直遮着（`"held"`），同一轮里另一次被放行也不放开它。同时在跑的两次（并行调用）分不清哪次被问：`held` 两个都遮，`allowed` 一个也不放。不受检的一轮（宿主 `input`）里 `check: "held"` 以后也遮；这样的一轮里有一次被问过，没问到的那几次也按上面遮。宿主连接自己订阅的事件不遮（宿主要看原文才能检查）。人自己在会话里写的标题（`/new 标题`、开话题的第一句）是在那里说过的话，不问。范围里的路由上，已经发出的回复卡改标题照旧再过一次检（`kind: "title"`，带整张卡）。

**按次关掉被 @ 时的历史**（U21，feature `callout.history`，INVARIANTS IN-9）：路由回调的答复和 `inbound.redispatch` 可带 `history: false`，这一次 dispatch 不取历史；不带时照旧。

### 4.2 对外 MCP 端点（`externalMcp`）

方案见 `docs/design/external-mcp/`，不变量 SE-5、ID-10、CF-10、DL-6、EX-8。

- 守护进程可以多开一个 MCP 端点（Streamable HTTP，无状态，只听回环，缺省 `127.0.0.1:7465`），给本守护进程之外的 agent 用：运维者机器上直接跑的 Claude Code / Codex，或宿主替自己用户做的代理。配置 `externalMcp: { listen?, clients: { <名>: { token: "env:NAME" | tokenFile, scopes, principal?, labels?, declare? } }, limits? }`；没有这一节就不监听。
- **缺省拒绝**：客户端只看得到、只能调用 scope 允许的工具。`read`（全部会话与守护进程状态）或 `read:<会话模式>` → `sessions_list`、`session_events`（某会话从某个 seq 起、按层级）、`explain`、（只 `read`）`channels_status`；`send:<路由模式>` → `send_message`；`input:<会话模式>` → `session_input`（往已有会话排一条输入，答复留在日志里）。模式里 `*` 匹配任意一串字符。
- **凭据**：每个客户端自己的令牌（`env:NAME` 或 `tokenFile`：存在则读、不存在则生成 0600，规则同 `host.tokenFile`），按摘要常量时间比较，不得是宿主令牌。请求要 `Authorization: Bearer <令牌>`；带 `Origin` 或非回环 `Host` 的请求 403；有请求体、请求频率与写频率上限（`limits`）。
- **身份**：客户端做的事由守护进程盖章（§3"外部客户端的身份"），永远不是人；`declare: true` 的客户端可以用 `X-Agents-IO-Declared: <id>` 头说明替谁做，记为 `origin.declared`，并出现在 `external` 回调、发送记录与 explain 里。宿主做代理时这样传递自己的成员 id。
- **记录**：发送记在客户端的日志 `external:<名>`（`native` 事件 `agents-io.external` 与 `delivery.settled`，同宿主 `deliver` 的 `host:<名>`），operationId 为 `external:<名>:<operation_id>`、同一个只发一次；`aio explain <operationId>` 的 `external` 说出客户端、主体与 `declared`。输入有路由记录，`aio explain <inputId>` 可查。
- **宿主怎样再收紧**：`external` 钩子决定每一次写，`outbound` 钩子照样决定发送（§4.1）；读由 scope 决定，宿主的代理可以自己再过滤。
- **对严格校验的宿主可见的协议变化**（2026-10-20）：`policy` 帧多了 `hook: "external"`；`features` 多了 `callouts.external`、`external.mcp`；`EffectExplanation.external`、`AdminStatus.externalMcp` 是新的可选字段；输入的 `origin.kind` 可能是 `peer`（schema 里早有）；会话列表里可能出现 `external:<名>`（与 `host:<名>` 一样是投递日志）。

### 4.3 测试入口（故障注入；缺省关闭）

宿主一侧的故障注入（平台重投、响应丢失）要两个传输层原语：判定在宿主那边，原语放在这里。不变量 SE-6。

- **开关**：只有 `aio serve` 的进程环境里 `AIO_TEST_HOOKS=1`（恰好是 `1`）才开，配置文件开不了；部署方只在测试环境（staging）的守护进程上设，线上不设。开着时启动日志有一行 warn，`host.hello` 的 `features` 多一个 `test.hooks`；关着时两个帧都答 `test_hooks_off`，通道发送不经任何包装，接纳过的信封也不留存。
- **鉴权**：同其他宿主请求，先 `host.hello` 带宿主 token（任何带 token 的连接都可以，不必是「那个宿主」）；没有 hello 或 token 不对答 `unauthorized`。每次使用记 warn 日志（谁、哪条输入或哪个通道、几次）。
- **`test.replay { inputId, times? }` → `{ inputId, channelRef, channel, account, results: [{ action: "accepted" | "duplicate" | "refused", inputId?, error? }] }`**：把本进程开着测试入口时接纳过的那条渠道消息（`inputId` 是它成为的输入，即会话日志与宿主看到的 input id）的原始信封再交给网关 `times` 次（缺省 1，最多 10），按它的 `(channel, account)` 正在运行的通道实例盖章，就像平台重投：去重按 IN-5，正常结果是每份都 `duplicate`。信封只在内存里留（最多 256 条、2 小时，重启即清空），找不到答 `not_found`；通道没在运行答 `channel_not_running`。结果里的 `channelRef` 就是 `input.verify` 要的那个键，宿主手里只有 input id 时可以从这里拿。
- **`test.fault { action: "drop-response", channel, account?, conversation?, next }`**：接下来 `next` 次（1–100）经这个通道（给了 `account` 时只限该账号；给了 `conversation` 时只限回复路由的 `conversationId` 是它的发送，如飞书的 chat_id）的发送，平台调用照常发出，适配器的响应被扔掉、这次尝试不再应答，outbox 按单次尝试超时（`attemptTimeoutMs`，缺省 60 s）结算为 `unknown`、不重试（DL-1）。只数 `send`：`edit`、`finalize`、`previewProgress` 不扔也不占次数。不给 `conversation` 时按通道计数、不分会话，别的会话的发送也算；要扔的是某一轮的回答时给 `conversation`，并且用过程显示关着的会话（开着时这一轮的第一次发送是过程卡片，回答是后来对它的编辑）。没有这个 `(channel, account)` 答 `unknown_channel`。**`{ action: "clear" }`** 清掉全部注入，**`{ action: "list" }`** 只列出。三者都答 `{ faults: [{ kind, channel, account?, remaining, at }] }`（动作之后仍生效的）。只在内存里，重启即清空。
- **命令行**：`aio replay --input <inputId> [--times N]`、`aio fault [list]`、`aio fault drop-response --channel <id> [--account <a>] [--conversation <c>] --next <N>`、`aio fault clear`（§5）。脚本判断能不能用时跑 `aio fault`（只读）看退出码：旧守护进程答 `unknown command`（2），关着答 `test_hooks_off`（1）。

### 4.4 工具条目的标题与 `tool`（feature `item.tool`；INVARIANTS HC-7）

宿主常要认出一轮里的某一步调的是哪个工具（例如宿主认出「读私聊」是哪一步，好在网页上只遮那一步）。约定：

- **类型**：harness 通过 MCP 服务调的工具，`item.started` / `item.completed` 的 `item.type` 是 `mcp_tool`。
- **标题**：`item.title` 以 `<server>.<tool>` 开头。Codex 正好是这个；Claude Code 在后面接 `: <输入摘要>`（摘要不超过 80 字，可能以 `…` 截断）。`<server>` 是 harness 报的服务名：Claude Code 是工具名 `mcp__<server>__<tool>` 里的那一段（Claude Code 自己规范化过的服务名），Codex 是配置里的服务名。
- **结构化字段**：`item.tool: { server, name }`，和标题开头的那一对相同，`item.started` 和 `item.completed` 都带。**宿主读这个字段，不要解析标题**：服务名、工具名里可能有 `.` 或 `_`，标题后面还可能接输入。
- **什么时候有 `tool`**：守护进程记着的宿主声明里有下面任一样时，`tool` 写进日志（宿主不在时也算，在占宿主位置、三样都没有的 hello 时清掉）：`callouts` 里的 `outbound.scoped`；`outbound` 加 `outbound.content`；或者 hello 的 `optIn` 里有 `item.tool`。前两样还会改出口行为（§4.1a：受检的轮次、结算带 `kind` 等），第三样只多 `tool` 这一个字段。都没有的宿主看到的条目和以前逐字相同，没有 `tool`。声明以前记下的条目没有 `tool`，要认就按标题开头 `<server>.<tool>`，后面是结尾或 `: `。
- **只要 `tool`、不动出口的最小声明**（给先要认出工具、出口检查另行上线的宿主）：在它原来那条占宿主位置的 hello 里加一个字段，别的都不变，例如 `host.hello { token, name: "my-host", consumer: "my-host", callouts: ["route", "outbound"], optIn: ["item.tool"] }`。**只认结果**：结果的 `optIn` 里有 `item.tool` 才算拿到（不占宿主位置的 hello 得到 `optIn: []`，未知名字不列；旧守护进程不认这个字段，结果里没有 `optIn`，照旧按标题认）。拿到以后，除了 MCP 工具条目多了 `tool`，事件、结算、回调和不写 `optIn` 时逐字相同：没有 `checked`，结算不带 `kind`，`outbound` 回调仍是 `{ from, to }`。每次重连都要带上它：一个占宿主位置、不带 `optIn: ["item.tool"]` 的 hello 会把它清掉（和 `outbound.content` 一样记在 `DaemonRecords`，标记 `host.item.tool`）。
- **没有 `tool` 的**：内置工具（`Bash`、`Read`、`WebFetch`…，`type` 是 `command`、`tool` 等）、Codex 的 `dynamicToolCall`（`type: "tool"`，标题 `<namespace>.<tool>`）、Claude Code 的服务端工具。
- **被遮的条目**：外部读取面（§4.1a）清空标题时 `tool` 照旧留着：它说的是调了什么，不是内容。
- **对严格校验的宿主可见的协议变化**（2026-10-24）：`ItemSummary.tool`、`topic.changed.check`、`host.hello.optIn` 和它的结果里的 `optIn` 是新的可选字段；`features` 多了 `item.tool`；`kind: "title"` 的那一问可能带 `content.sections`（`session_rotate` 的摘要）。

## 5. 命令行（给不想写 socket 客户端的宿主）

| 命令 | 等价于 |
|---|---|
| `aio run --agent <name> --run-id <id> --cwd <dir> [--env K=V…] [--preset/--model/--effort/--profile …] [--input-id <id>] [--correlation <id>] -- <指令>` | `run.start`，阻塞到 `run.ended`，以 `exitCode` 退出 |
| `aio send --route <json> --operation-id <id> < message.json` | `deliver` |
| `aio tail --consumer <name>` / `aio ack --consumer <name> <cursor>` | §2.1 拉取 |
| `aio bindings put < table.json` | `bindings.put` |
| `aio explain <inputId>` | 路由解释（agent 输入另有 `cause`，被截停的有 `loopGuard`） |
| `aio explain <operationId>` | 某次投递（`delivery.settled` 里的 operationId）：会话、轮次与该轮的触发输入；系统回复给出它回应的输入，宿主 `deliver` 给出宿主 |
| `aio explain --chain <inputId>` | 一条 agent 输入沿 cause 链走回根：每一级的 inputId、跳数、会话地址、主体、触发的轮次、是否截停；链断（另一部署、不认识的机器人）处注明 |
| `aio verify <channelRef>` | `input.verify` |
| `aio replay --input <inputId> [--times N]` | `test.replay`（测试入口，§4.3；只在 `AIO_TEST_HOOKS=1` 时可用） |
| `aio fault [list] \| drop-response --channel <id> [--account <a>] [--conversation <c>] --next <N> \| clear` | `test.fault`（同上） |

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
