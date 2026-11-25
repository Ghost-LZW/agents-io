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
  "callout": { "timeoutMs": 1500, "onFailure": "host", "skipWhenPinned": true },  // 可选：显式开启同步回调（§2.2）
  "to": "beta",                    // 可选，只对 on: "host" 或带 callout 的规则：交给哪个后端（§2.1、§4.12）
  "tag": "inbox"                   // 可选，在这两种规则上是管理员给条目的标签：原样抄到条目上，守护进程不解读（§2.1）
}
```

- **agents**：配置里命名的运行默认值（harness 实例、model、profile、cwd、工具），不含人设。部署方可以在 agent 上写 `sessionParams`，允许宿主按会话指定工作目录和环境变量（决定 7，§2.3）。`mode: "task"` 的 agent 只能由 `run.start` 启动，任何规则指向它都在加载时报错。
- **来源**：本地配置，以及宿主推送的整表 `bindings.put { version, bindings, identities, expiresAt?, onHostDown: "keep" | "suspend" }`（宿主推送的默认 `suspend`）。`version` 都是十进制整数（计数器、毫秒时间戳）时有先后：比当前表小的推送答 `stale_version`、不替换（迟到的旧推送不覆盖新表）；其他形式的版本是不透明标签，任何一个都替换。同一输入命中多条规则时全部生效；同一 (agent, session) 取最强的动作。唯一的例外是卡片点击：被点的消息是某个后端 `deliver` 的，只有 `to` 是它的规则接这次点击；带 `to` 的规则也只接它那个后端发的消息上的点击（§4.12）。
- **`to`（feature `backends`）**：规则把输入交给配置里的一个后端（`backends.<id>`）。只能写在 `on: "host"` 或带 `callout` 的规则上（别的规则到不了宿主队列），写在别处答 `invalid`；指向没有配置的后端，配置表加载失败，`bindings.put` 答 `unknown_backend`。推带 `to` 的表之前先看 `host.hello` 结果的 `features` 里有 `backends`：没有它的守护进程（旧版本，或没有配置任何后端）不认识这个字段或这个后端。宿主推送的表里带 `to` 的规则随宿主表一起挂起（`onHostDown`）；给后端的规则写在配置表里，或者推送时用 `onHostDown: "keep"`。
- **`tag`（feature `binding.tag`）**：规则给它入队的条目贴的标签，1 到 128 个字符，不含控制字符，内容随管理员定（例如 `inbox` / `chat` / `guest`，告诉后端这条条目该怎么处理）。它在 `on: "host"` 或带 `callout` 的规则上才是标签：在那里不是字符串、为空、超长或带控制字符都答 `invalid`，文字指出是哪条规则（配置表加载失败，`bindings.put` 不替换当前表；类型与长度也是 `invalid`，不是 `invalid_frame`）。写在别的规则上（`dispatch`、`context`、`digest`、`drop` 且不带 `callout`）的 `tag` 键不归守护进程管：写什么都不报错，不抄到条目，`explain` 里也不出现，与有这个功能之前一样，所以原来自己在规则上带着 `tag` 键的表照样能推、能加载。守护进程不解读标签：匹配、fan-out、按 `to` 去重、点击归属都不看。它原样出现在条目的 `tag` 上（§2.1）和 `aio explain` 里这两种规则的每条命中上。推带 `tag` 的表之前先看 `features` 里有 `binding.tag`：没有它的守护进程不校验、也不抄这个字段。
- **watch** 就是 agent 在运行时通过输出工具新增的一条规则，仍受 `Policy.watch` 约束。
- **可解释**：每条输入记下命中的规则 id、表版本、回调结果；`aio explain <inputId>` 列出来。

### 2.1 交给宿主（`on: "host"`）

输入写入**宿主入站队列**：按消费者记游标，至少投递一次，幂等键为渠道消息引用（`channel:<渠道>/<消息 id>`）。两种消费方式，语义相同：

- **推送**：宿主连接守护进程并 `host.hello { consumer }`；守护进程推 `inbound` 帧，宿主回 `result { accepted }` 后前移；断线期间留在队列，重连后补推。
- **拉取**：`aio tail --consumer <name> [--from <cursor>]` 逐行输出 JSON（含 `cursor`）；宿主处理后 `aio ack --consumer <name> <cursor>`。

**按后端分（规则带 `to`，§4.12）**：带 `to: "<id>"` 的规则命中的输入，条目带 `to`，只给消费者 `backend:<id>`（那个后端凭自己的钥匙连接时的游标）；不带 `to` 的规则照旧，条目只给不带后端的消费者。两边互相看不到。同一条输入命中指向两个后端的规则，是两条条目，各自去重（幂等键是账号、渠道消息引用加后端）；同时命中一条不带 `to` 的 `host` 规则时，宿主那边也有一条，写规则的人要自己避免两边都回复（`aio explain` 的每条命中规则带 `to`）。游标是全队列共用的序列，所以一个后端看到的游标不连续。清理也分开：不带 `to` 的条目在所有不带后端的消费者都 ack 之后删，一个后端的条目在它自己 ack 之后删；一个长期不 ack 的后端只积压它自己的条目。

**条目的 `tag`**：入队这条条目的那条规则带 `tag` 时，条目带同样的 `tag`（`InboundItem.tag`）；规则没有就没有这个键。每个队列视图（每个后端、以及不带后端的）的条目来自它第一条命中的规则，`tag` 也是那条规则的，不会借后面规则的。同一条消息被渠道重投时返回第一次的条目，`tag` 是第一次入队时的，之后改了表也不变。

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
- **env 的执行**：Claude Code 的 launch env 位于最上层（覆盖实例 `env` 和 `configDir`，所以 launch 的 `CLAUDE_CONFIG_DIR` 生效）；Codex `stdio` 实例上带 env 的会话单独起一个 app-server（launch 的 `CODEX_HOME` 替换实例的 `home`），会话关闭时进程退出；Codex `unix` 实例（共享、比守护进程活得久）带 env 的 launch 直接拒绝（`launch_unsupported`），只带 cwd 可以，实例因 `env:` 变量没设而暂时不可用时也一样；module harness 按它的适配器声明的 `sessionEnv` 处理（`packages/daemon/README.md`），暂时不可用的 module 实例说不出自己的声明，带 env 的 launch 同样拒绝。env 值只进子进程，存在 0600 的私有数据库里，不进事件流、`aio explain`、日志和 argv。
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

本地 unix socket（目录 0700、socket 0600），JSONL，请求带 `id`、同 `id` 的 `result` 应答。宿主连接先 `host.hello { token, name, consumer?, callouts? }`；token 由守护进程每次启动时重新生成，写入 socket 旁的 0600 文件 `<socket>.token`；运维可用 `aio serve --token-file <path>` 或配置 `host.tokenFile` 指定一个跨重启不变的令牌文件（存在则读、不存在则生成，见 `docs/design/host-token-file`）。带 token 的连接数量不限（`aio run`、`aio tail` 等命令都是这样的连接）；`hello` 里带 `consumer`（推送消费）或开启任一回调钩子（`callouts`）的连接才是**宿主**；凭宿主 token 的宿主同一时刻至多一个，后端另见 §4.12（每个后端凭自己的钥匙连接，不占宿主位）。宿主 token 就是管理凭据：它能读、ack、补投任何消费者的条目，签发和作废后端钥匙，不要发给后端。宿主在线时，`onHostDown: "suspend"` 的宿主表生效，回调发给它，发起连接已断开的 run 的 `run.ended` 也发给它。只拉取的宿主（`aio tail` / `inbound.read`）没有这样的常驻连接，守护进程始终视它为不在线：它的表要用 `onHostDown: "keep"`，并定期重推（`bindings.put`）、每次给一个新的 `expiresAt` 当租约（例如每隔 T 重推一次，`expiresAt = now + 2T`），宿主停止重推后表到点挂起；否则默认的 `suspend` 表一直不生效（§6）。协议里曾有的 `host.hello.lease` 守护进程从未实现，已删除（决定 13）；旧宿主仍带这个字段不会被拒，只是被忽略。已有宿主时再来一个带角色的 `hello` 默认得到 `host_connected`；带 `takeover: true`（且 token 正确）则顶替旧连接：守护进程关闭旧连接、记日志，旧连接未确认的推送改推给新连接，结果里带 `replaced: { name }`（宿主断线重连而旧连接半开时用）。控制台 `/ws` 有心跳（`console.heartbeat`，默认每 30 s ping，10 s 内无应答即断开），半开的远程宿主连接会被及时清掉（见 `docs/design/host-liveness`）。宿主连接也可以发送所有客户端帧（`subscribe`、`input`、`resolve` 等，见 `packages/protocol/src/client.ts`），`origin` 标记为 `kind: "system"`；会重发的客户端给 `input`、`interrupt`、`topic.switch`、`watch.add` 带上 `opId`，重发就不会做两次（§4.7）。

| 帧 | 方向 | 用途 |
|---|---|---|
| `bindings.put` / `bindings.get` | 宿主 → 守护进程 | 原子替换 / 读取 Binding 表与身份映射 |
| `run.start` / `run.cancel` | 宿主 → 守护进程 | 用 `mode: task` 的 agent 执行一轮：新的 session `run:<runId>`，结束即关闭；`env` 只进子进程环境；可带 `overrides`、`inputId`、`correlation`（见下） |
| `run.ended` | 守护进程 → 宿主 | `{ runId, status, exitCode, error?, durationMs?, usage?, turnId?, inputId?, correlation? }`；`status` 含 `timeout`（`timeoutMs` 到期） |
| `attention.changed` | 守护进程 → 宿主 | 一个会话现在有什么在等变了：`{ sessionKey, attention }`，不用应答；只发给 `hello` 写了 `optIn: ["attention"]` 的宿主（§4.9） |
| `deliver` | 宿主 → 守护进程 | 推送给人，按 `operationId` 幂等；按钮点击按 `actionPrefix` 规则回到宿主。由 `route` 的 `(channel, account)` 对应的通道发出；该账号没有通道时，只有当这个通道 id 恰好一个条目才用它发，否则 `unknown_channel`（多个飞书机器人时不会以别的机器人发出，决定 8）。结果（`DeliverResult`）带平台消息 id `providerMessageId`；通道报告消息落在哪个话题时还带 `providerThreadId`（飞书：发送接口返回的 `thread_id`，例如 `reply_in_thread` 开出的新话题），重复的 `deliver` 照样带回 |
| `deliver.update` | 宿主 → 守护进程 | 改一条 `deliver` 过的消息：`{ operationId, route, providerMessageId, message, sequence, final? }`，`sequence` 每次加一（不大于上一次的被丢掉）；`final: true` 收尾（通道的 finalize：进度卡片的最终样子、思考气泡结束、太长的回答接着发），按 `operationId` 只做一次，重复答 `duplicate: true`；中间的更新不记录，通道拒绝时答 `status: "rejected"`。通道不能改答 `unsupported`（不变量 DL-8） |
| `message.ack` | 宿主 → 守护进程 | 给一条渠道消息打上宿主处理到哪一步的标记：`{ route, messageId, state }`，`state` 为 `working` / `done` / `failed` / `none`（去掉），由通道的 `acknowledge` 做（飞书：表情）。只是外观，不记录；通道没有标记答 `unsupported`（DL-8） |
| `history.read` | 宿主 → 守护进程 | 宿主自己给 agent 交上下文时，要一条队列条目所在对话更早的消息：`{ cursor, scope: "thread" \| "chat", limit? }`，由通道的 `history` 取（CHANNELS §1c），只答同一通道、同一账号、早于它的条目，从旧到新，至多 `limit`（缺省 50）；通道取不到答空。`cursor` 不在队列里答 `unknown_cursor`（DL-8） |
| `schedule.put` / `schedule.remove` / `schedule.list` | 宿主 → 守护进程 | 定时任务（`docs/design/schedules`，不变量 SC-1–SC-3）：`schedule.put { schedule }` 设或替换一条（`id`、`when`：`{ cron, tz? }` / `{ at }` / `{ everyMinutes }`；`action`：`turn` 往 `target.sessionKey` 投一条输入开一轮、`message` 往 `route` 发 `text`、`host` 作为一条条目进宿主入站队列；`missed`、`until`、`note`），结果带下次时刻 `nextAt`；`schedule.remove { scheduleId }`；`schedule.list { sessionKey? }`。宿主设的记为 `host:<名>`。到点只触发一次、跨重启；停机期间错过的补一次或跳过。这次到点发不出去时：再试也没用的（没有运行中的通道、被出口检查扣下或拒绝、通道拒收、外部客户端的路由已不在它的 scope 里）这一次就此结束，不再试，记一条 `notice` 在 `schedule:<id>` 的会话日志里，排到下一次（一次性的删除，`schedule.list` 里不再有它；外部客户端设的、因为客户端不在配置里或对外 MCP 端点关着而没发出去的不删，`nextAt` 停在那个已过的时刻，下次启动按错过的处理，§4.2）；别的失败隔 10 s 起逐次加倍（至多 15 min）以同一个 operationId 再试，下次启动也重做（SC-1）。结果里的定时任务（`ScheduleView`）在最近一次到点最终失败时带 `lastFailure { scheduledAt, at, reason }`（为什么没发出去，跨重启；下一次投递成功、或用同一个 id 替换时清掉）；外部客户端设的带 `module`（经哪个功能模块设的，只经它、以客户端的身份触发，§4.2）。命令行 `aio schedule`（`list` 在有 `lastFailure` 的一行末尾加一列 `last firing (due …) not delivered: <原因>`） |
| `conversation.create` | 宿主 → 守护进程 | 由通道建一个会话（飞书：私有群，机器人为管理员）：`{ operationId, channel, account, name, description?, owner?, members? }`，成员是该通道的用户 id（与 `sender.channelUserId` 同一命名空间）；结果 `{ conversationId, duplicate }`，同一个 `operationId` 只建一个；通道不支持答 `unsupported`，平台报错答 `channel_error`（DL-8） |
| `inbound` | 守护进程 → 宿主 | §2.1 推送消费 |
| `policy` | 守护进程 → 宿主 | §2.2 回调（`hook: "route"`），以及按 `hello.callouts` 开启的 `resolve`、`review`、`outbound`、`contact`、`external` 钩子（§4.1，超时 fail closed） |
| `explain { inputId, chain? }` | 宿主 → 守护进程 | 一条输入的路由记录；`inputId` 不是输入而是某次投递的 operationId 时，答产生它的会话、轮次与该轮的触发输入；`chain: true` 时沿 cause 链走回根（§5 `aio explain`） |
| `input.verify` | 宿主 → 守护进程 | §3 |
| `session.prepare` | 宿主 → 守护进程 | 为不经渠道路由打开的会话键预先登记 agent 和 launch（§2.2、§2.3） |
| `inbound.redispatch` | 宿主 → 守护进程 | 把宿主入站队列里的一条输入按原始来源投递到指定会话（§2.1） |
| `session.compact` | 宿主 → 守护进程 | 让一个安静的、lane 打开着的会话的 harness 立刻压缩上下文（见下） |
| `session.prewarm` | 宿主 → 守护进程 | 不开轮，先把一个已知会话的 harness 拉起来，等快要到的输入（见下） |
| `backends.list` / `backends.key` / `backends.forget` | 宿主 → 守护进程 | 后端的状态与钥匙（§4.12；feature `backends`）：`backends.list` 列出每个后端的钥匙 id、连接数、积压与发送许可（没有钥匙本身）；`backends.key { backend, op: "issue" \| "rotate" \| "revoke" }` 签发、轮换、作废；`backends.forget { backend }` 清掉它的条目、游标与发送许可。只给宿主 token 的连接，后端钥匙答 `forbidden` |
| `blob.stat` / `blob.get` / `blob.put` | 宿主 → 守护进程 | 读写 blob（§4.13；feature `blobs`）：`blob.stat { ref }` 答 `{ size }` 或 `null`；`blob.get { ref, offset?, length? }` 答 `{ base64, size, offset }`，每帧至多 1 MiB；`blob.put { base64, part?, mime?, name? }` 上传，答 `{ ref, size }`，分片时中间的片答 `{ upload, received }`。宿主 token 读写共用的 blob 库；后端钥匙只读得到路由给它的条目里的媒体和它自己上传的 |
| `test.replay` / `test.fault` | 宿主 → 守护进程 | 测试入口：重投一条渠道消息 / 扔掉某通道接下来几次发送的响应（§4.3；缺省关闭，只在 `AIO_TEST_HOOKS=1` 时可用） |

**`deliver` 的结果没能记下时**（INVARIANTS DL-1 细节 5）：结算记录、出站索引与会话日志里的 `delivery.settled` 在一个事务里提交。消息发出之后这一步失败（磁盘满、I/O 错误）时，这次 `deliver` 答 `internal`（消息是原错误），消息可能已经发出，什么都还没记下（`explain <operationId>` 答 `unknown_input`）。同一个 operationId 再 `deliver` 不会再发：同一进程里答 `status: "unknown"`、`duplicate: false`、`error: "recording its outcome failed in this process (…); not resent"`；守护进程重启之后，启动时已把它记为 `unknown`（`error: "in flight when the previous process stopped; not resent"`），再 `deliver` 答 `duplicate: true`。按 `unknown` 处理（交给人或宿主自己的规则），不要换一个 operationId 重发：可能发两次。

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

**能力协商**：`host.hello` 的结果带 `features: string[]`，按能力名协商而不是按版本号。目前有 `"session.launch"`：回调答复可带 `launch`、可用 `session.prepare`、规则可用 `callout.skipWhenPinned`；`"callouts.resolve"`、`"callouts.outbound"`、`"resolve.onBehalfOf"`（§4.1，只在 `policy.answerOnBehalf` 开启时列出）；`"inbound.redispatch"`（§2.1）；`"host.takeover"`：`host.hello` 支持 `takeover: true`（§2）；`"callouts.contact"`（§4.1）；`"explain.chain"`：`explain` 接受 operationId 与 `chain: true`（§5）；`"run.overrides"`、`"run.ended.usage"`、`"run.correlation"`：任务运行的三个可选项（§4 表下）；`"callouts.external"`（§4.1）；`"callouts.review"`、`"resolve.native"`、`"resolver.human.extras"`（§4.1）；`"external.mcp"`：对外 MCP 端点开着（§4.2，只在配置了 `externalMcp` 且在监听时列出）；`"session.compact"`：宿主替空闲会话压缩上下文（§4 表下）；`"deliver.update"`、`"conversation.create"`、`"message.ack"`、`"schedules"`、`"history"`（§4 表）；`"session.prewarm"`：宿主提前拉起会话的 harness（§4 表下）。`"test.hooks"`：`test.replay`、`test.fault` 两个测试入口（§4.3，只在守护进程以 `AIO_TEST_HOOKS=1` 启动时列出）。`"host-mcp.send_file.blob_scoped"`：输出工具 `send_file` 的 `blob` 只发本 session 见过的引用（INVARIANTS SE-7）；没有它的旧守护进程会把 blob 存储里任何一个文件发到本轮路由，靠它挡住跨会话外发的宿主要先看到它。`"client.opId"`：客户端帧可以带 `opId`，重发答第一次的应答（§4.7，INVARIANTS PR-3）。`"binding.tag"`：规则的 `tag` 被校验并抄到条目上（§2、§2.1）。`"blobs"`：`blob.stat` / `blob.get` / `blob.put`（§4.13）。旧守护进程的 `callouts` 只接受布尔。推荐做法：直接发钩子列表，收到 `invalid_frame` 再用 `callouts: true` 重发（旧守护进程只有 `route`）。不要先用 `callouts: true` 握手探测 features：那次握手已让这条连接成为**唯一的**宿主、只开了 `route`，想换成列表必须断开重连，期间占着宿主位置。结果里没有某个 feature 时，宿主不得依赖它。

**`session.prepare { sessionKey, agent, launch }`**：用于不经渠道路由打开的会话（宿主连接发的客户端 `input` 帧、本地 `aio input` / `aio attach`、指向该键的 watch），也可以让宿主在键可预知时（如成员入驻时建群）提前登记，规则就不必开回调。它只登记（agent 行与 launch 行在同一事务里写入），不拉起 harness；第一条输入到达时按登记建 lane。结果 `{ sessionKey, agent, launch: { cwd?, envKeys }, created }`：同一键用相同的值再 prepare 幂等（`created: false`）。错误码：`unknown_agent`、`not_interactive_agent`、`launch_not_allowed`（agent 没有 `sessionParams`）、`bad_cwd`、`bad_env`、`launch_unsupported`（Codex `unix` 实例带 env）、`launch_conflict`（键已有不同的 launch，或已是无 launch 的会话）、`agent_conflict`（键已属于另一个 agent）、`invalid_frame`（含 `run:` 前缀的键，task run 用 `run.start`）。遇到 `launch_conflict` 换键，不要重试。每个请求的 `result.value` 都有 schema（`packages/protocol/src/host.ts` 末尾的 `HOST_RESULT_VALUES`，JSON Schema 见 `packages/protocol/schema/*Result.json`）。

**`session.compact { sessionKey, inputId? }`**（feature `session.compact`，不变量 CT-3）：宿主趁会话空闲时替它压缩上下文，人下一次说话时不用等。守护进程开一轮，唯一的输入是 harness 自己的压缩命令（Claude Code `/compact`），来源是宿主连接，`replyRoute` 为空：没有回复、进度卡片或通知到任何渠道；之前记下的 context 不交给这一轮，留给下一轮。结果 `{ sessionKey, inputId, turnId?, duplicate }`；这一轮的事件照常进会话日志：`compacting` 通知（Claude Code 的 `compact_boundary` 那一条写着 `context compacted (manual) <前> → <后> tokens`，`native` 里有 `compact_metadata`），`usage`（这次压缩的模型调用在 `modelUsage` 的累计里，`usage.iterations` 为空），`turn.completed`，没有回答文字。只在会话安静时做，否则答 `busy`、什么都不记：有一轮在跑或正在开始、有排队的输入、有未答的请求、有 live。没有打开的 lane 答 `not_live`（不为压缩拉起 harness）；harness 不声明压缩命令（`HarnessAdapter.compact`）答 `unsupported`（Codex；嵌入方交的、什么都不声明的适配器暂时取实例种类的声明，见 §4.5 2026-11-24 的补记）；`inputId` 的规则同 `run.start`（`bad_input_id`），同一个 id 再来答 `duplicate: true`、不开轮。这一轮在跑时到达的输入照常排队，结束后开自己的一轮。

**`session.prewarm { sessionKey }`**（feature `session.prewarm`）：宿主知道马上会有输入（提醒、例行快到点）时，先让守护进程把这个会话的 harness 拉起来（Claude Code：CLI 进程、MCP 服务、插件），那一轮就不用等启动。不开轮、不收输入、不调模型、日志里不记任何事件。结果 `{ sessionKey, opened }`：这次请求拉起的为 `true`，已经开着的为 `false`。只对守护进程跑过或登记过的会话（有日志、有 lane、钉过 agent 或 launch），否则答 `not_found`；任务运行（`run:`）答 `invalid_frame`。

**宿主写命令的来源标记**：守护进程为每一轮算出来源摘要（是否含 context/digest/外部/群聊输入），附在输出工具的每次调用上（`agents-io.output` 记录的 `provenance` 字段；宿主 MCP `onCall` 事件的 `provenance` 只在进程内嵌入时可用，远程宿主收不到），交互 session 与任务运行都是如此（见 CHANNELS.md §1a 的来源标记）。来源不进 harness 子进程的环境变量：任务运行只带 `AGENTS_IO_RUN_ID`（让工作区里的宿主命令能把调用对到这次运行）；原有的 `AGENTS_IO_TURN_PROVENANCE` 值恒定（`triggeredBy: ["host:<名>"]`，其余为 `false`），发起运行的宿主本来就知道，已删除（决定 13）。不拦截任何调用（决定 4）。

**交互 session 里的宿主写命令：带 `ref`，宿主自己核验**（决定 4 的兑现方式，决定 13）。按原则 7，agent 是在工作区里直接调宿主命令（如 `x`）写入的，这次调用不经过 agents-io，守护进程没法往上附来源。所以来源换成一个宿主能独立验证的事实：给模型的发送者说明行里，来自渠道消息的输入带 `ref=channel:<通道>/<消息 id>`（CHANNELS §1）；agent 调宿主写命令时把触发它的那条消息的 `ref` 当参数带上；宿主用 `aio verify <ref>`（`input.verify { channelRef }`）查到这条消息的平台作者、主体、标签与封顶后的证据，按自己的规则决定收不收（例如"确认"必须来自 `owner` 且证据为 `platform_signed`）。没有 `ref` 的写请求（agent 自发、本地输入、宿主自己发的 `input`）由宿主决定怎么对待。`ref` 证明的是"这个人确实发过这条消息"，不证明这条消息就是触发本次命令的那条：agent 可能拿会话里更早的一条消息的 `ref`。核验结果带 `conversation`、`receivedAt` 与 `inputId`，宿主可以据此再加约束（同一会话、足够新、一条消息只认一次确认）。

### 4.1a 出口检查：带内容的 `outbound`、声明了范围的 `outbound`（U20，feature `callouts.outbound.content`、`callouts.outbound.scope`、`reply.check`；INVARIANTS DL-8）

有了使用者（一个宿主的群对话出口检查）之后，按决定 13 的规则解冻 `outbound`，只加不改：不声明新名字的宿主、旧守护进程，行为都不变。

- **探测与声明**：先用不占位置的 hello（不带 `consumer`、`callouts` 为空）看 `features`；有 `callouts.outbound.scope` 再用正式的 hello 写 `callouts: [..., "outbound.scoped"]` 并带 `outboundScope: { routes: [{ channel, account, conversationId }] }`（覆盖这些会话的所有 thread）。**只认结果**：结果的 `callouts` 里有 `outbound.scoped`、另带 `outboundScope: { revision, routes }`（条数）才算声明了；旧守护进程忽略这个名字。`outbound` 与 `outbound.scoped` 同时写答 `invalid_frame`；写了 `outbound.scoped` 不带 `outboundScope` 也是。运行中用 `host.outboundScope { routes }` 整份替换，答 `{ revision }` 即生效（别的连接答 `not_scoped`）。范围记在 `DaemonRecords` 的新标记 `host.outbound.scope`，跨重启、宿主断开期间都在；只在一个占宿主位置、不写 `outbound.scoped` 的 hello 时清掉，不占位置的 hello 什么都不改。这条记录读不出来（损坏）时失败关闭：所有路由都算在范围里（受检、宿主不在时扣下），记 error，直到宿主重新声明或替换范围。
- **钩子**：`policy { hook: "outbound", args: { from, to, kind, content?, attachmentText?, turnId?, requestId? } }`；`kind` 是 `reply`（受检的本轮回答）、`tool`（输出工具，写 `agents-io.output` 之前；外部 MCP 的 `send_message` 也是；agent 的定时消息设的时候、到点发出时也是，见下面「定时消息」）、`question`（提问卡）、`request`（审批卡）、`title`（话题标题，见下面「话题标题」）；只出现在结算里的还有 `notice`（守护进程自己的提示：拒收、陌生人求入、话题命令等系统回复；主人设的定时消息）、`host`（宿主自己的 `deliver` 和它 `schedule.put` 的定时消息）和 `live`（`live_say` 说出去的话；范围里不开 live，所以只在范围外），它们不问钩子；`attachmentText` 是文字类附件（`text/*`、JSON、Markdown、CSV，单个不超过 64 KiB）按 blob ref 给的文字。答复 `{ verdict: "allow" | "deny" | "hold", reason? }`；`reason` 会给 agent 看，不要放内容。
- **范围外**：不问宿主，只过本地策略（DL-5 默认），宿主在不在都一样。**范围内**：先过本地策略，再问宿主；宿主不在（断开、重启后还没连上、超时、出错、答复不合 schema）时结算成 `held`（`reason: "host_unavailable"`），本轮自己的回复路由也一样。范围声明期间 `Policy.outbound` 只走本地策略，宿主的判断在发送时带内容问。实时语音（`live_join` / `live_say`）说出来之前没法检查：范围里的路由上不开（`live_join` 报错），`live_say` 时路由在范围里就离开这场 live 并报错，范围替换后落进范围的 live 也当场离开。
- **受检的一轮**：回复路由在这一轮开始时在范围里（路由回调派发、`inbound.redispatch`、`run.start` 的 `observe` 第一项都一样）。开轮时受检的，结算时照样检查：范围中途被替换、甚至被整个清掉（占位置但不写 `outbound.scoped` 的 hello），这一轮受检的回答和卡片仍要过检，没有声明范围的宿主可问就扣下（`host_unavailable`，失败关闭）。`turn.started.checked: true`，不受检的写 `false`；`turn.adopted` 照日志（跨重启保留；重启后接回的轮次不知道当初是哪条路由让它受检，它的所有路由都按受检发）、`turn.delivery_added`（`steer`、`approval`，以及 `run.start` 的 `observe` 多于一项时的 `mirror`）按加进来时的范围带 `checked`，`true` 时那条路由按受检发、这一轮从此受检。宿主 `input` 和外部 MCP 的 `session_input` 的回复路由是本地路由，永远 `checked: false`。受检的路由不流式、不显示过程（不给适配器 `progress`、不开预览），`turn.completed` 以后整条回答先问宿主再发一次；审批卡、提问卡在受检的路由上单独发并先问，请求在发卡之前已经结算就不发。同一会话的下一轮等这条回答结算（最多钩子超时加 5 s）。`hold` 以后，下一轮的输入前面有一条只给 agent 的系统上下文 `held:<operationId>`（「上一条回答没有发出。」加「原因：…」，宿主不在时是「宿主不在，没有发出。」；不带原文）。快照的 `turn.checked` 为真时不填 `partialText`。
- **结算**：`hold` 写一条 `delivery.settled { result: "held", reason }`，不调用适配器、不重试；钩子答 `deny` 写 `result: "rejected"` 加 `denied: true`（有 `reason` 就带上），同样不发，其余和 `hold` 一致：受检的回答在下一轮之前告诉 agent「上一条回答没有发出」，卡片按取消结算，外部读取面一直遮着；输出工具的 held 不写 `agents-io.output`，工具结果是「宿主拿走了这条，没有发出（reason）。不要再发。」；提问卡、审批卡 held 了，这个请求按取消结算（`request.resolved { by: "runtime_cancelled" }`，harness 收到带原因的 `deny`），这一轮不等答复。范围声明期间每个 `delivery.settled` 都带 `kind`（另有 `notice`：拒收提示和话题命令等系统回复）、`turnId`，卡片带 `requestId`；受检的一轮的结算即使范围中途撤了也带；重启时补结算的 `unknown` 也带。
- **外部读取面**：外部 MCP 的 `session_events` 对受检的一轮（从它受检的那条事件起），在回答在每条受检的路由上结算成 `delivered` / `rejected` / `unknown` 以前，事件带 `withheld: "checking"`，`held` 或 `denied` 了一直是 `withheld: "held"`（被拦下的原文不对外放；通道自己拒收的 `rejected` 已经过了检查，照常放开）；被遮的有 `text.delta` / `text.snapshot` 的文字、`reasoning` / `agent_message` 条目的标题和 `result.preview`、`headline`、这一轮所有事件的 `native`（例如 Claude Code `usage` 事件里的 SDK result）。卡片单算：`request.opened` 的 `title`、`inputPreview`、`questions`、`suggestions`，以及开出它的工具条目（同一 `itemId`，例如 Claude Code 的 `AskUserQuestion`）的标题、`inputSummary`、`result.preview`、进度文字，在这张卡在每条受检的路由上结算以前遮住（发到不受检的路由上的那份不算；没发卡的跟着回答走）。宿主连接自己订阅的事件不遮。
- **不带范围的内容钩子**（feature `callouts.outbound.content`）：`callouts` 写 `outbound` 再加 `outbound.content`（单写 `outbound.content` 不算，结果里没有它；和 `outbound.scoped` 一起写是多余的，照准）。DL-5 的语义逐字不变（宿主决定 agent 发往别处的消息；断开时只放行本轮自己的路由；本轮在原路由上的回答不问、不受检，事件里没有 `checked`），只多三样：输出工具的消息在写 `agents-io.output` 之前带 `content`、`attachmentText`、`turnId`、`kind: "tool"` 问一次（不再先问一次不带内容的）；外部 MCP 的 `send_message` 同样带内容；答复可以是 `hold`（结算 `held`，不发，输出工具不写 `agents-io.output`，外部客户端收到「宿主拿走了这条」）；每个 `delivery.settled` 都带 `kind`、`turnId`（卡片带 `requestId`），宿主断开期间、重启后也带（`DaemonRecords` 标记 `host.outbound.content`）。没有内容可问的检查（`live_join` 开在哪里）仍是 `{ from, to }`，这时答 `hold` 按 `deny`。只写 `outbound` 的宿主收到的还是 `{ from, to }`，答 `hold` 不合 schema，按 `deny`。
- **定时消息**（INVARIANTS DL-5、DL-7、SC-3）：agent 用 `schedule_add` 设的 `action: "message"` 定时任务（`createdBy` 是 `session:<key>`）是 agent 的消息，两次都按它的 `send_message` 查。**设的时候**：没有范围、声明了 `outbound` 加 `outbound.content` 的宿主被问一次，`kind: "tool"`、`content: { text }`、`turnId`，`from` 是设它的那一轮（和 `send_message` 发出时那一次一样，看不出是定时的：按"agent 要往这里发这段话"判断；宿主不在时只放行这一轮自己的路由）；`deny` 不设（工具报 `the host policy does not let you send to …`，带 `reason`），`hold` 也不设（`the host took this message; the schedule was not set`）。只写 `outbound` 的宿主照旧问 `{ from, to }`，范围声明期间照旧只过本地策略。**到点发出时**：照 agent 这时的 `send_message` 再查一次：范围里的路由问声明了范围的宿主，没有范围时问带内容的 `outbound` 宿主，`kind: "tool"`、`content` 是文字，`from` 是这次到点：`sessionKey` 是 agent 的会话，`turnId` 是 operationId `schedule:<id>:<scheduledAt>`，`inputs` 是一条系统输入（`origin.via: "schedule:<id>"`），`replyRoute: null`（带内容的宿主不在时不发：这次到点没有"本轮自己的回复路由"）。`hold` 结算 `held`、`deny` 结算 `rejected` 加 `denied: true`，都写在 `schedule:<id>` 的日志里，不发；消息带 agent 身份（`SendOp.as`，DL-4b）。主人配置的、本地主体的、宿主 `schedule.put` 的定时消息照旧不问，声明期间结算带 `kind: "notice"`（宿主的是 `"host"`）；外部客户端的照 §4.2（`tool`，以客户端身份、过它 `send_message` 的检查；客户端删掉了、模块关了就不发，从不作为 `notice` 发出）。
- **话题标题**：标题会在群里说出来（`/topics`、`/status` 的系统回复按 `notice` 免检发出），外部也读得到（`topic.changed`、本地 socket 的 `topic.list`、agent 的 `session_list` 工具的结果），所以在检查的范围里先过检再记下：话题所在的会话在范围里，或这个 session 有过受检的一轮（范围后来清掉也算，失败关闭）时，后台起标题先等这一轮受检的回答结算，只拿已经过检的内容（人说的话、放开了的回答；还在检查、`held`、`denied` 的回答不进提示词），起好的标题再以 `kind: "title"`、`content: { text: 标题 }`、`to` 为话题所在的会话问一次，`allow` 才记下。agent 用 `session_rotate` 起的标题和它写的摘要（存在离开的那个话题上，`topic.list`、`session_list` 里的 `summary`）一起问一次：`kind: "title"`、`content: { text: 标题, sections: [{ kind: "details", text: 摘要 }] }`（宿主要连 `sections` 一起查，和查回答一样）；`allow` 两样都记下，否则两样都不记：新话题不带标题（以后按上面的规则自动起），离开的话题没有摘要。**合成一问是有意的**：只有摘要该扣、标题本身干净时，标题也一起丢（新话题先不带标题，之后自动起），主线接受这个代价，不拆成两问；宿主不必、也没法只放行其中一样；`topic.changed` 带 `check: "allowed"` 或 `"held"`（没问的不带）。这次检查不发消息，没有结算。不记下的标题和摘要不写进 `topic.changed`、不存进话题，`/topics`、`/status`、`topic.list`、`session_list` 里都没有；agent 写下的原文还在两处：`session_rotate` 的工具条目（`title`、`inputSummary`、`result.preview`；Claude Code 的标题里带着输入）和交给新话题的那份摘要（新话题日志里的 `input.admitted`，`channelContext.topicSummary`；这是她自己的笔记，新话题照样拿到）。外部读取面（上一条）按每一次调用算，不按一轮：一条 `topic.changed.check` 只对应发出它时这一轮里正在跑的那个 `session_rotate` 条目（已开始、未完成；检查就在这次调用里问）。受检的一轮里先遮着这个工具条目（`withheld: "checking"`），它自己的 `check` 是 `allowed` 才放开；`held` 一直遮着（`"held"`），交给新话题的那份摘要同样遮着；没有自己的 `check` 的（问宿主之前就报错的，比如摘要为空；同一轮已经换过话题、被拒的第二次），这次调用结束（或这一轮结束）以后一直遮着（`"held"`），同一轮里另一次被放行也不放开它。同时在跑的两次（并行调用）分不清哪次被问：`held` 两个都遮，`allowed` 一个也不放。不受检的一轮（宿主 `input`）里 `check: "held"` 以后也遮；这样的一轮里有一次被问过，没问到的那几次也按上面遮。宿主连接自己订阅的事件不遮（宿主要看原文才能检查）。人自己在会话里写的标题（`/new 标题`、开话题的第一句）是在那里说过的话，不问。范围里的路由上，已经发出的回复卡改标题照旧再过一次检（`kind: "title"`，带整张卡）。

**按次关掉被 @ 时的历史**（U21，feature `callout.history`，INVARIANTS IN-9）：路由回调的答复和 `inbound.redispatch` 可带 `history: false`，这一次 dispatch 不取历史；不带时照旧。

### 4.2 对外 MCP 端点（`externalMcp`）

方案见 `docs/design/external-mcp/`，不变量 SE-5、ID-10、CF-10、DL-6、EX-8。

- 守护进程可以多开一个 MCP 端点（Streamable HTTP，无状态，只听回环，缺省 `127.0.0.1:7465`），给本守护进程之外的 agent 用：运维者机器上直接跑的 Claude Code / Codex，或宿主替自己用户做的代理。配置 `externalMcp: { listen?, clients: { <名>: { token: "env:NAME" | tokenFile, scopes, principal?, labels?, declare? } }, limits? }`；没有这一节就不监听。
- **缺省拒绝**：客户端只看得到、只能调用 scope 允许的工具。`schedule:<路由模式>` → `schedule_add` / `schedule_list` / `schedule_remove`：客户端设的定时消息只发往 scope 内的路由，每次触发都以它的身份、经 `send_message` 的同一套检查发出（触发时路由已不在 scope 里、被拒、被扣下、没有通道：这一次不发、不再试，下一次照常，SC-1）；`action: "wake"` 的定时任务到点交给宿主（宿主入站队列里一条条目，`channelContext` 带 `schedule.wake`（`resume` 或 `fresh`）、`schedule.client`、`schedule.declared` 与 `createdBy`），由运行这个 agent 的宿主决定怎么叫醒它，回答去 `route`（SC-3）。客户端的定时任务只在它还是配置里的客户端、这一段开着时触发：从 `externalMcp.clients` 删掉，或关掉这一段（`enabled: false`、删掉这一段）以后，它的 `message` 和 `wake` 到点什么都不发，不以守护进程的身份发、不交给宿主，这一次算最终失败（同上：`schedule:<id>` 里一条 `notice`，`schedule.list` 的 `lastFailure` 说出为什么）；定时任务留着：周期的排到下一次；一次性的（`at`，或过了 `until` 的最后一次）也不删，`nextAt` 停在没发出去的那个已过的时刻、带着 `lastFailure`，这次运行里不再触发（`schedule:<id>` 里的 `notice` 写 `… was not delivered, not tried again until the next start: …`），下次启动时按错过的处理（SC-2：已过一分钟以上的，`missed: "once"`（缺省）补一次，`skip` 丢掉；不到一分钟的照常触发）。客户端加回来、这一段再开以后（守护进程不重读配置：改了要重启），之后的到点和这样留着的一次性的照常以它的身份触发；客户端一直不回来，留着的一次性的每次启动失败一次（一条 `notice`），不要了用 `aio schedule remove` 或 `schedule.remove` 删。`wake` 到点时路由已不在它的 `schedule:` scope 里也不交给宿主（SC-1、SC-3）。`read`（全部会话与守护进程状态）或 `read:<会话模式>` → `sessions_list`、`session_events`（某会话从某个 seq 起、按层级）、`explain`、（只 `read`）`channels_status`；`send:<路由模式>` → `send_message`；`input:<会话模式>` → `session_input`（往已有会话排一条输入，答复留在日志里）。模式里 `*` 匹配任意一串字符。
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

### 4.5 类型与 schema 的位置变化

给直接用 TypeScript 包或 JSON Schema 文件的宿主（例如自己做控制台界面的）。线上的帧与 admin HTTP API 不变。

- **2026-11-23（core-slimming P0）**：飞书机器人开通的 admin 类型 `AdminLarkBotRequest`、`AdminLarkBotStarted`、`AdminLarkBotJob`、`AdminLarkBotJobState` 不再由 `@agents-io/protocol` 导出，`ADMIN_ENDPOINTS` 也只列核心端点；它们与 `LARK_BOT_ADMIN_ENDPOINTS`（`POST /api/bots/lark`、`GET /api/bots/lark/:job`）改由 `@agents-io/channel-lark-bot` 导出（`channel/lark-bot/src/admin.ts`）。三个 JSON Schema 从 `packages/protocol/schema/` 移到 `channel/lark-bot/schema/`，内容与 `$id`（`agents-io/v1/AdminLarkBot*`）不变。`@agents-io/daemon` 不再转出 `LarkBotJobs`、`larkEnvNames`（以及 `LarkBotJobsOptions`、`StartOutcome`），也从 `@agents-io/channel-lark-bot` 取；`LarkBotJobsOptions.config` 改为结构化的 `ProvisionConfig`（守护进程的 `ConfigStore` 满足它），另要 `envRefs`。照抄过这些类型的宿主，注释里的出处要跟着改。`@agents-io/daemon` 也不再导出 `runScenarios`、`SCENARIOS`、`e2eConfig`：真机场景（`aio e2e`）移到了私有包 `@agents-io/daemon-e2e`（`packages/daemon-e2e`），从那里导出。
- **2026-11-23（core-slimming G3，harness 种类注册）**：`@agents-io/daemon` 的 `HarnessInstance` 改为 `{ kind: string; launch }`：各种类的启动设置从 `claude` / `codex` / `module` 字段移到 `launch`，值不变。旧字段名再保留一个版本（已弃用）：`resolveConfig` / `loadConfig` 解析出的实例上，`claude`（Claude Code）、`codex`（Codex）、`module` 仍可读，是 `launch` 的别名，写它就是写 `launch`（所以在 `buildHarness` 前改 `inst.claude` 照旧生效）；别名不可枚举，展开（`{ ...inst }`）和 JSON 里只有 `launch`，自己拼出来的实例没有别名。请改读写 `launch`；`ClaudeLaunch`、`CodexLaunch` 改由 `@agents-io/harness-claude-code`、`@agents-io/harness-codex` 导出，`codexStateDir` 也移到 `@agents-io/harness-codex`，`HarnessKind` 成了 `string`。新增 `HarnessModule` 等类型（`@agents-io/protocol`，`harness-module.ts`）与 `HarnessRegistry`、`builtinHarnesses`、`configFileSchema`（`@agents-io/daemon`）；`resolveConfig` / `loadConfig` 与 `Gateway.start` 多了可选的 `harnessRegistry`。配置文件的形状、解析出的值和错误文字不变。
- **2026-11-23（core-slimming G2，通道类型注册：配置这一面）**：新增 `ChannelModule` 等类型（`@agents-io/protocol`，`channel-module.ts`）；`@agents-io/channel-lark-bot`、`@agents-io/channel-mail`、`@agents-io/channel-jsonl-bridge` 各导出自己的描述符（`larkBotChannelModule`、`mailChannelModule`、`bridgeChannelModule`）与条目类型；`@agents-io/daemon` 新增 `ChannelRegistry`、`builtinChannels`、`CORE_CHANNEL_IDS`，`configFileSchema` 多了可选的第二个参数（通道注册表），`resolveConfig` 多了可选的 `channelRegistry`（守护进程目前仍只会构造内建的四种通道，所以 `loadConfig` 与 `Gateway.start` 还不收它）。`LarkChannelConfig` 改由 `@agents-io/channel-lark-bot` 导出，`@agents-io/daemon` 再导出一个版本（已弃用）。`ChannelEntry`、`ResolvedChannel`、`RESERVED_CHANNEL_IDS` 的形状和值不变。配置文件的形状、解析出的值和错误文字不变。
- **2026-11-23（core-slimming G2，通道类型注册：构造、id 归属、证据与凭据）**：守护进程按通道注册表构造配置里的每个通道（`ChannelModule.create`，`init.stateDir` 是 `<dataDir>/channels/<type>.<账号，URI 编码>`，飞书的目录照旧是 `channels/lark-bot.<账号>`），`loadConfig` 与 `Gateway.start` 因此多了可选的 `channelRegistry`（两边给同一个；`Gateway.channelRegistry` 可读）。`GatewayOptions.channelAdapter` 照旧优先。不写 `evidence` 的条目给什么证据由注册时给定：`ChannelRegistry` 的第二个参数 `{ defaultEvidence: { <type>: 'caps' | 'ungranted' } }`，缺省 `ungranted`（只有 `device_only`）；`builtinChannels` 给 lark-bot、mail `caps`，bridge、module 不给，与原来一样。描述符上自己写的任何字段都不算数。条目通道 id 的归属是 `<type>:<ChannelModule.owner>`，没有 `owner` 时就是类型（`bridge:[…]`、`module:[…]`、`lark-bot` 的值与原来相同，错误文字不变）；`ChannelRegistry` 新增 `defaultEvidence()`、`owner()`、`idOf()`、`mayUse()`。控制台的凭据判断改读类型的声明：`entry` 里标 `x-credential` 的字符串（标在 map 或数组上就是其中每个字符串，bridge 的 `env`）和 `ChannelModule.isCredential`（bridge 跟在像机密的参数后面的那个，mail 的 `auth.pass` / `auth.accessToken`，飞书的 `appSecret` / `encryptKey` / `verificationToken`），结果与原来一致；`isCredential`、`redact`、`unredact` 多了可选的通道注册表参数，`ConfigStoreOptions` 多了 `harnessRegistry`、`channelRegistry`（守护进程给它自己的两个）。`Gateway` 不再有公开的 `larkBots` 字段（控制台的飞书开通改由 `bundle.ts` 的 `builtinConsoleParts` 构造，只在注册表里有内建 lark-bot 时提供），admin HTTP API 不变。
- **2026-11-23（core-slimming G2 的后续）**：`new ChannelRegistry(modules)` 检查每个模块：类型名只许 ASCII 字母、数字、`-`、`_`，以字母或数字开头（归属是 `<type>:<owner>`、状态目录是 `<type>.<账号>`，所以不许 `:`、`.`、`/`、空格），`entry` 是对象，`resolve`、`create` 是函数，可选的钩子写了就得是函数，`ids` 是非空字符串的数组；不对的抛错，说出类型和成员名。内建类型都通过。`Gateway.start` 建不出一个配置条目时（网关的注册表里没有它的类型，即配置是用另一个注册表解析的；或 `create` 返回的不是带 `ChannelAdapter` 的 `BuiltChannel`）抛 `ConfigError`（`aio` 退出码 2），说出条目位置和类型，不再是 `TypeError`；`create` 自己抛的错照旧原样抛出。查的只是 `create` 返回值的形状（适配器有字符串 `id` 和函数 `caps`、`start`、`send`，`close`、`idKnown` 写了就得是函数），适配器启动之后怎么做不查：`start` 不返回 promise、`caps` 抛错或返回的不是 caps，照旧是它自己的错（例如 `TypeError`），不是 `ConfigError`。`ChannelModule` 新增可选的 `credentialHint(path, entry)`：控制台对这个位置的字面凭据给的建议（bridge 用它说参数在命令行上别人看得见，文字不变）。`use: "module"` 的 harness 适配器的 `nativeClient` 写了却不是函数时，启动失败（CF-4）。
- **2026-11-23（core-slimming G5，模块贡献 admin 路由与控制台设置）**：新增 `AdminContribution`、`AdminRoute`、`AdminContext`、`ConfigAccess` 等类型（`@agents-io/protocol`，`admin-module.ts`）；`ChannelModule.admin` 的类型就是 `AdminContribution`（占位的 `ChannelAdminContribution` 删除）。`@agents-io/daemon` 删除过渡用的 `builtinConsoleParts`、`ConsoleParts`、`ConsolePartsInit`（`bundle.ts`）和控制台的 `BotProvisioning`、`ConsoleHost.larkBots`：自己构造 `ConsoleServer` 的宿主改给 `ConsoleHost.routes`（`ContributedRoute[]`：路由加它的 `AdminContext`），飞书机器人开通由 `@agents-io/channel-lark-bot` 的 `larkBotAdmin`（即 `larkBotChannelModule.admin`）的 `mount` 与 `routes` 提供；用 `Gateway` 的宿主不用改，网关为注册表里每个类型的贡献建上下文、挂载并在控制台之后分派它的路由。新增 `adminEndpoints(registry)`（核心端点加各类型贡献的端点，`ADMIN_ENDPOINTS` 仍只列核心的）、`consoleSettings`、`ChannelRegistry.adminContributions`；`new ChannelRegistry` 检查贡献的成员，并拒绝两个类型贡献同一个路由、控制台键或 schema 名，以及与核心端点重复的路由。`ConsoleConfig` 不再有 `larkBotCommand` 字段的类型，改为索引签名：各类型贡献的设置照旧在原来的位置（`config.console.larkBotCommand` 运行时照旧有值，类型是 `unknown`）；`CREATE_LARK_BOT` 改由 `@agents-io/channel-lark-bot` 导出，`@agents-io/daemon` 再导出一个版本（已弃用）。`ConfigStore` 实现 `ConfigAccess`（多了 `envRefs`），`ProvisionConfig` 成了 `ConfigAccess` 去掉 `envRefs`。注册表里没有 lark-bot 时，`/api/bots/lark` 答未知路由的 404（原来误答 `bot provisioning needs a config file`）。配置文件（`console.larkBotCommand` 的位置与缺省）、admin HTTP API（路径、状态、答复体）和 JSON Schema 文件不变。
- **2026-11-23（core-slimming G6，功能模块注册表）**：新增 `ModuleManifest`、`ModuleInstance`、`KernelContext` 等类型（`@agents-io/protocol`，`module.ts`），以及 `AdminModule` 和 `AdminStatus` 的可选字段 `modules`（`GET /api/status` 列出注册了的每个功能模块：`id`、`origin`（`builtin` / `module`）、`enabled`，运行中的模块可带 `status`；这一版注册表是空的，所以总是 `[]`）。`@agents-io/daemon` 新增 `ModuleRegistry`、`builtinModules`（空）、`ModuleHost`、`resolveModules`；`resolveConfig` / `loadConfig`、`Gateway.start`、`ConfigStoreOptions` 多了可选的 `moduleRegistry`（给同一个），`configFileSchema` 多了可选的第三个参数。`@agents-io/host-mcp` 新增 `toolCatalog`、`moduleToolInput`、`HostToolsOptions.modules`。给模型的工具列表、`/help`、`host.hello` 的 `features`（内核的在前，运行中的模块的接在后面）和错误文字都与原来逐字节相同；配置文件不变。
- **2026-11-24（core-slimming G6 第 1 步，对外 MCP 端点成为功能模块）**：对外 MCP 端点（§4.2）是第一个内建功能模块（id `external-mcp`，`@agents-io/daemon` 的 `bundle.ts` 注册）。配置段 `externalMcp` 的键、形状、缺省（关）、错误文字和 admin HTTP API 都不变。线上可见的只有：端点开着时 `host.hello` 的 `features` 里 `external.mcp` 排在内核的 feature 之后（原来在 `callouts.external` 与 `session.compact` 之间；按名字协商的宿主不受影响），`callouts.external` 照旧总是列出；`GET /api/status` 的 `modules` 多了 `{ id: "external-mcp", origin: "builtin", enabled }`（监听时带 `status: { url, clients }`），`externalMcp` 块照旧在原处；端点写的日志行多了 `module external-mcp: ` 前缀。嵌入方：`ExternalMcpConfig`、`ExternalMcpClient`、`DEFAULT_EXTERNAL_MCP_PORT` 改由 `bundle.ts` 导出（包的导出名不变）；`Config.externalMcp` 已弃用，保留一个版本（与 `Config.modules` 里的是同一个对象；在 `Gateway.start` 之前把它换成别的值或删掉，照旧开、改或关端点）；`builtinModules` 不再是空的，`resolveConfig` / `loadConfig` 解析出的配置总带 `modules`（用自己的 `moduleRegistry` 时两边给同一个）；完全不带 `modules` 的配置（自己拼的）照旧能启动，端点照 `Config.externalMcp` 开关；`ConfigFile` 包含内建模块的段，`configFileSchema(…, modules)` 给别的注册表时没有 `externalMcp`；`HostServiceDeps.externalMcp` 删除（`external.mcp` 由模块的 feature 给出）。`KernelContext` 新增 `head`、`appendNative`、`sessions`、`status`、`stopping`、`router.record`、`lanes.input`（只收 `kind: "peer"` 的输入）、`resolveRoute`、`send` 的 `external`、`settled`、`outbound`、`host.heldBy` / `host.external` / `host.isToken`；`ModuleInstance.features()`、`ModuleResolveContext.valueAt`、`ModuleRegistryOptions.fields` 是新的；模块的 `start` 抛 `ConfigError` / `TokenError` 时原样抛出。
- **2026-11-24（core-slimming G6 第 2 步，即 G4：模型生成的话题标题成为功能模块）**：话题标题（§4.6）是内建功能模块 `topic-title`（`@agents-io/daemon` 的 `bundle.ts` 注册，排在 `external-mcp` 之前），缺省开着，什么时候生成、生成什么、卡片怎么改都与原来一样。线上可见的只有：配置文件多了可选的段 `topicTitles`（只有 `enabled`；不写就是开着，所以已有配置不变）；`GET /api/status` 的 `modules` 第一项是 `{ id: "topic-title", origin: "builtin", enabled }`；`title update failed` 这条日志多了 `module topic-title: ` 前缀。嵌入方：模块钩子 `onTurnCompleted` 开始生效（一个会话的一轮结束后调用，任务 run 的不算）；`KernelContext` 新增 `topics.titleSource`、`topics.setAutoTitle`、`lanes.harness`（类型 `KernelLaneHarness`，`@agents-io/protocol`）；`bundle.ts` 导出 `TopicTitleSection`。自己拼的、完全不带 `modules` 的配置照旧能启动，内建模块按"文件里没有它们的段"处理（话题标题开着）。
- **2026-11-24（core-slimming G4 / G6 的后续）**：线上（帧、字段、配置文件、错误文字）不变。嵌入方：`KernelContext.lanes.harness(sessionKey)`（`KernelLaneHarness`）不再把 harness 适配器交给模块：`agent`、`instance`、`cwd`、`adapter(instance)`、`run(instance)` 删除，改为 `ephemeral(turnId)` 与 `ephemeralTurn({ turnId, prompt, instructions })`：内核在这一轮所用的实例上跑一个临时的一轮，会话（一次性的、在会话的工作目录、不带宿主的工具）、run（那一轮的，低 effort、缺省模式）、权限档（以模块 id 命名、只读、从不询问）和输入都由内核定，模块只给文字（原先模块拿到适配器，可以用任意 `run.profile`、`options.profiles` 开会话，绕过策略和部署的权限档）；话题标题照旧。`KernelBackend` 每一步都加了必填成员，自己实现它的嵌入方要跟着改（`packages/daemon/README.md` 列出了是哪些）。`new ChannelRegistry(modules)` 拒绝与已注册类型只差大小写的类型名（`Chat` 与 `chat`：状态目录 `<dataDir>/channels/<type>.<账号>` 在不分大小写的文件系统上是同一个，macOS 缺省如此）。bridge 的 inbound 帧等这条连接的 hello 生效之后才处理：对端答完 hello 紧接着发的 inbound（两帧在同一块里到达也一样）按这次 hello 的 id 与 caps 盖章，原先会按之前的（首连失败之后是离线 caps，授予了证据的主人被当成陌生人）；hello 失败或被拒的连接上发来的 inbound 不再收下（对端被杀掉，重投给下一个进程）。
- **2026-11-24（core-slimming G6 第 3 步：监听、live、话题三组模型工具成为功能模块）**：`watch_*`、`live_*`、`session_*` 三组工具是内建功能模块 `tools.watch`、`tools.live`、`tools.topics`（`@agents-io/daemon` 的 `bundle.ts` 按这个顺序注册，排在 `topic-title` 之后、`external-mcp` 之前），缺省开着：harness 看到的工具（名字、说明、输入 schema、注解、顺序）、它们的答复、话题提示行（`channelContext.topicTools`）和错误文字都与原来一样，`agents.<name>.tools` / `outputTools` 照旧按 agent 决定（CF-6），没有通道能开 live 时 `live_*` 照旧出现。线上可见的只有：配置文件多了三个可选的段 `watchTools`、`liveTools`、`topicTools`（只有 `enabled`；不写就是开着，`{ "enabled": false }` 整组关掉，关掉的那组工具不挂、`topicTools` 关掉时没有话题提示行；`agents.<name>.tools` 列了关掉那组的工具是配置错误，说出模块：`"watch_add" is a tool of module tools.watch, which is off`）；`GET /api/status` 的 `modules` 多了这三项。监听与汇总的路由、live 的协议与事件（LN 系列）、话题交接（TP-1）都留在内核。嵌入方：模块钩子 `inputHint` 开始生效；`KernelContext` 新增 `watches`（以会话的 agent 身份建、删、列监听，目标总是这个会话）、`live`（`join` / `say` / `leave`）、`agents.tools`、`topics.rotate` / `switch`（只对会话正在跑的那一轮，参数带 `operationId`；TP-1 的规则由内核对每个调用方查：每轮一次，同一 `operationId` 再来答同一结果，只从对话当前的话题交接，不交走刚交接过来的消息，不切到这一轮自己的话题；规则本身是 `@agents-io/session` 的 `handoverRefusal`）；`@agents-io/host-mcp` 新增 `KERNEL_TOOL_NAMES`、`TOOL_GROUPS`、`TOOL_GROUP_DEFS` 与三组工具的处理函数（`watchToolHandlers` 等），`HostToolsOptions.watches` / `topics` / `live` 照旧可用。给 `Gateway.start` 自己的 `ModuleRegistry` 的嵌入方要注册这三个模块（从 `builtinModules.modules` 开始），否则 agent 只有内核的 6 个工具。
- **2026-11-24（core-slimming G6 第 4 步：陌生人放行成为功能模块）**：陌生人放行（决定 16 的 host 级功能，INVARIANTS ID-9）是内建功能模块 `strangers`（`@agents-io/daemon` 的 `bundle.ts` 注册，排在 `tools.topics` 之后、`external-mcp` 之前）。`policy.strangers` 的位置、取值和缺省（`drop`，即关）都不变，卡片、按钮、放行、guest 身份（照旧排在配置与宿主身份映射之下）、访客的轮次问主人、所有回复文字都与原来一样；连着的宿主的 `resolve` 照旧先于它回答请求。线上可见的只有：配置文件多了可选的段 `strangers`（只有 `enabled`；`strangers: {}` 与 `policy.strangers: "ask"` 一样开启，两者都写时以段为准）；`GET /api/status` 的 `modules` 多了 `{ id: "strangers", origin: "builtin", enabled }`；放行的日志行多了 `module strangers: ` 前缀；`ChannelCaps` 多了可选字段 `openInbox`（JSON Schema `ChannelCaps`、`ChannelHello` 跟着多了它）：通道声明了它，陌生人放行就不问这个通道上的陌生人，邮件适配器声明了（原来按通道 id `mail` 判断）。bridge 对端在 hello 的 caps 里也可以声明。嵌入方：钩子 `onUndispatched`（参数多了 `addressed`）、`onAction`、`resolver`、`identities` 开始生效，`KernelContext.owner` 是新的，`KernelBackend` 多了必填的 `owner`；`Config.policy.strangers` 说的是模块开没开（弃用，保留一个版本），在 `Gateway.start` 之前改写、或自己拼的不带 `modules` 的配置里，照旧决定开关；自己写的、通道 id 也叫 `mail` 的适配器要声明 `openInbox` 才照旧不问（`packages/daemon/README.md`）。
- **2026-11-24（core-slimming G6 第 5 步：改运行配置的聊天命令成为功能模块）**：`/agent`、`/preset`、`/model`、`/effort`、`/plan`、`/bypass`、`/compact` 和 `/status` 的 Plan 一行（决定 16 的 host 级功能，INVARIANTS CT-2）是内建功能模块 `owner-commands`（`@agents-io/daemon` 的 `bundle.ts` 注册，排在 `strangers` 之后、`external-mcp` 之前），缺省开着：`/help`、`/status` 和每条回复的文字与顺序都与原来一样，会话上设过的值（日志库 records 里的 `run:<会话>`）照旧有效。会话上设的预设、模型、effort、Plan 模式、权限档由内核保存、并在 agent 的策略之上应用（`Policy.plan`），预设本身的配置（`presets`、`agents.<n>.preset`、`run.start` 的 `overrides.preset`）也留在内核，帧与字段都不变。线上可见的只有：配置文件多了可选的段 `ownerCommands`（只有 `enabled`；不写就是开着，`{ "enabled": false }` 关掉：这七个 `/名字` 成了普通消息，`/help` 只列内核的命令，`/status` 没有 Plan 一行，已经设过的值照旧应用）；`GET /api/status` 的 `modules` 多了 `{ id: "owner-commands", origin: "builtin", enabled }`。嵌入方：`ModuleCommandDef` 多了 `aliases`、`helpBefore`，`ModuleCommandCall` 多了 `compact()`，钩子 `statusLines` 开始生效，`KernelContext` 新增 `runConfig`、`agents.names`、`router.setConversationAgent`，`KernelBackend` 多了必填成员；给 `Gateway.start` 自己的 `ModuleRegistry` 的嵌入方要注册这个模块（从 `builtinModules.modules` 开始），否则这七个是普通消息（`packages/daemon/README.md`）。
- **2026-11-24（core-slimming G3 的原生终端接管，即 G6 第 6 步）**：`aio tui` / `tui.attach` 的帧、答复（`TuiAttach`）、错误码与文字、`/status` 的 "a terminal UI holds this session" 一行都不变；Claude Code 终端写进 MCP 配置的 bridge 照旧是 `aio tui-bridge`。终端是加入还是接管，由实例的适配器声明（`HarnessAdapter.attach`：缺省 `'join'`，`'takeover'` 时要有 `takeover`），不再看实例的种类：内建的 `ClaudeCodeHarness` 声明 `'takeover'`，`CodexHarness` 声明 `'join'`。嵌入方：`@agents-io/protocol` 新增 `HarnessAdapter.attach` / `takeover`、`HarnessTakeoverArgs`、`TakeoverServices`、`HarnessTakeover`、`TakeoverLaunch`，`HarnessDeclarations` 多了 `attach`，`HarnessModule` 多了可选的 `cli`（`HarnessCliCommand`：种类给 CLI 加的命令）；`@agents-io/daemon` 的 `HarnessRegistry` 多了 `cliCommand`；`@agents-io/harness-claude-code` 新导出 `claudeTuiTakeover`、`ClaudeTuiSettings`、`tuiBridge`、`TUI_BRIDGE_COMMAND`，`ClaudeCodeHarnessConfig` 多了 `tuiCommand`。给 `Gateway.start` 自己的 `harness` / `buildHarness` 的嵌入方，要 claude-code 实例照旧接管，它的适配器得同样声明（`packages/daemon/README.md`）；`use: "module"` 的 harness 声明了也走同一流程（`docs/E2E.md` §0）。
- **2026-11-24（core-slimming §4 P2 第 5 项：没有模块的内核）**：`@agents-io/daemon` 新增 `coreRegistries()`（`src/core.ts`：harness、通道、功能模块三个注册表都是空的；这个文件不 import 任何模块包，也不 import 组合根 `bundle.ts`）、`Registries`、`EMBEDDED_HARNESS`。同一组注册表交给 `resolveConfig` / `loadConfig` 和 `Gateway.start`，通道与 harness 由嵌入方给（`GatewayOptions.channels`、`harness` 或 `buildHarness`）：跑的只有内核，聊天命令、给模型的工具、`host.hello` 的 `features`、控制台端点都只是内核的（`/api/bots/lark` 答未知路由的 404）。用空的 harness 注册表解析、又没写 harness 的配置，唯一的实例是 `embedded`，代表嵌入方的适配器；`Gateway.start` 没拿到 `harness` 也没拿到 `buildHarness` 时抛 `ConfigError`，说出实例名（原先这样的配置加载即失败，错误是 ``no harness kind is registered: configure `harnesses` ``）。配置用到注册表里没有的通道类型、harness 种类、顶层的段或控制台设置时，`invalid config: …` 在 schema 的错误之后逐个说出它们（例如 `channels[0].type: no channel module "lark-bot" is registered (registered types: none)`；schema 的错误和顺序不变，内建注册表下写错的类型、种类、顶层键也多这一句）。线上（帧、字段、admin HTTP API、配置文件的形状与缺省）不变，打包的 `aio` 不受影响。用法见 `packages/daemon/README.md` "The kernel without modules"。
- **2026-11-24（core-slimming G3：压缩、Plan 模式与权限档切换按适配器声明，给嵌入方的补记）**：`/compact`、`/plan`、`/bypass`、`/status` 的 Plan 一行和 `session.compact` 看会话所在实例的适配器声明（`HarnessAdapter.compact`、`modes`、`ownerProfileSwitch`、`displayName`），不再看实例的种类。线上（帧、错误码与文字）不变：内建适配器声明的与原来按种类判断的一致（Claude Code 有 `/compact`，Codex 有 Plan 模式和权限档切换）；暂不可用的实例（`env:` 引用的变量没设）按它可用后会声明的回答，也与原来一样。嵌入方：经 `GatewayOptions.harness` 或 `buildHarness` 交的适配器（包不包 `InstanceHarness` 都算）这四项一项都不声明的，照旧取它实例种类的声明（`HarnessModule.declares`：claude-code 实例能压缩，codex 实例有 Plan 模式和 `/bypass`）。这是过渡，已弃用，保留一个版本：请让自己的适配器声明它代替的那个（代替 Claude Code 的写 `compact = { command: "/compact" }`，代替 Codex 的写 `modes = ["plan"]`、`ownerProfileSwitch = true`）；声明了其中任何一项，就只看它自己的声明。
- **2026-11-24（core-slimming 评审后：模块只以 peer 的身份进会话）**：线上不变。嵌入方的功能模块：`KernelContext.lanes.command(cmd, origin)` 不再接受 `kind` 不是 `"peer"` 的来源（原先什么来源都收）；它和 `lanes.input` 都拒绝带 `owner` 标签、或是 `policy.owners` 之一的主体（缺省策略给主人的轮次 `bypass`）；`lanes.input` 去掉 `channelContext` 里的 `nativeCommand` 和 `loopGuard`（只有内核设它们）。人、宿主和内核的来源由内核给。内建模块不受影响：唯一的调用方对外 MCP 端点给客户端盖的就是 peer，且从不是主人（ID-10）。
- **2026-11-24（core-slimming 评审后：通道条目的公共键只归宿主）**：线上与内建类型不变。自己注册 `ChannelModule` 的嵌入方：`resolve` 对 `type`、`tier`、`openDelayMs`、`previewDelayMs`、`ack`、`evidence` 返回什么都不算，这些键照配置里写的（原先返回值会盖过去，没写授予的类型能自己给自己 `platform_signed`）；`create` 拿到的是解析后条目的副本，改它不影响守护进程读的条目（ID-3、ID-4）。
- **2026-11-24（core-slimming 分支与 origin/main 合并）**：origin/main 的功能（§4.1a 的出口检查、`deliver.update`、`conversation.create`、`message.ack`、`history.read`、`session.prewarm`、`optIn` 与 `item.tool`、测试入口（§4.3）、定时任务、`send_file` 按 blob 的范围）在新结构里行为不变；它们的帧、字段、错误码与文字都与 origin/main 相同。线上可见的只有：`host.hello` 的 `features` 先列内核的（origin/main 的 `FEATURES` 去掉 `external.mcp`，同样过滤 `resolve.onBehalfOf`、`test.hooks`），对外 MCP 端点开着时 `external.mcp` 排在最后（G6 第 1 步起就是这样）；`GET /api/status` 的 `modules` 多一项 `{ id: "tools.schedules", origin: "builtin", enabled: true }`（排在 `tools.watch` 之后）；配置文件多了可选的段 `scheduleTools`（只有 `enabled`，不写就是开着；`{ enabled: false }` 时 agent 没有 `schedule_*` 工具，主人、宿主、外部客户端的定时任务照旧）；`ChannelCaps.pacing` 多了可选的 `openOnProcess`（飞书适配器声明它，不再声明 `requireAnswerToOpen`；通道条目上的 `openOnProcess` 盖过它，与 origin/main 的行为相同）；外部客户端被带内容的宿主扣下（`held`）的 `send_message`，出站记录（`explain <operationId>`）也写明是哪个客户端（`external: { client, principal, declared? }`，INVARIANTS EX-8；origin/main 上被扣下的出站记录没有 `external`）。harness 看到的工具（18 个，含 `schedule_*`）与 origin/main 逐字节相同。定时任务的机制（到点、跨重启、主人与宿主的定时、`schedule.*` 帧、feature `schedules`）留在内核，与监听同形；给 agent 的工具是内建工具模块。嵌入方的变化（`KernelContext.schedules`、`hold`、`outbound` 的 `content`、`send` 标出的种类、异步的 `topics.setAutoTitle`、钩子 `scheduledMessage`、`KernelBackend` 的新成员）见 `packages/daemon/README.md` 末尾。
- **2026-11-24（core-slimming 评审后：agent 的定时消息过出口检查）**：agent 用 `schedule_add` 设的定时消息不再绕过宿主的外发决定（origin/main 上同样绕过，INVARIANTS DL-5、DL-7、SC-3）。线上可见的：没有范围、带内容的 `outbound` 宿主在 agent 设定时消息时多收到一次 `kind: "tool"` 的 `outbound` 回调（原来放行、不问），到点发出时又一次（`from` 是这次到点）；声明了范围的宿主在范围里的路由上，到点时收到一次 `kind: "tool"`（原来不问）；这些定时消息带 `SendOp.as`；声明期间所有定时消息的 `delivery.settled` 带 `kind`（agent 的 `tool`，主人的 `notice`，宿主的 `host`；原来不带）。细节见 §4.1a「定时消息」。
- **2026-11-24（core-slimming 评审后：发不出去的定时任务到点不再忙着重试）**：原来一次到点发不出去，守护进程立刻、反复地重试（每秒数百次，每次一条 warn），再试也没用的（被扣下或拒绝、外部客户端的 scope 收窄、通道没了、拒收）一直转到守护进程停止（origin/main 上同样）。现在（INVARIANTS SC-1）：这类失败让这一次到点结束，`schedule:<id>` 的会话日志里一条 `notice`（`the firing due … was not delivered, not tried again: …`），定时任务排到下一次（一次性的删除）；别的失败隔 10 s、20 s、40 s……（至多 15 min）再试，operationId 不变。被扣下、被拒的定时消息原来有的悄悄结束、有的一直重试，现在都是结束加这条 `notice`。守护进程停止时先停定时任务（最多等 3 s），再停模块；启动时定时任务在模块启动之后才开始（原来在通道启动之前），刚到点的会晚这么一点。嵌入方：`ModuleHooks.scheduledMessage` 抛带 `final: true` 的错误表示这一次到点结束（`@agents-io/session` 的 `FinalFiringError`、`isFinalFiring`），别的错误退避再试；`ScheduleDispatcherOptions` 多了 `onFailed`、`retry`，`onError` 多一个参数 `retryInMs`，`ScheduleRegistry` 多了 `fail`、`nearest(except)`。
- **2026-11-24（core-slimming 评审后：删掉的外部客户端、关掉的对外 MCP 端点不再以守护进程的身份发定时任务）**：原来外部客户端从 `externalMcp.clients` 删掉、或对外 MCP 端点关掉（`enabled: false`、删掉这一段）以后，它设过的定时消息照样到点，由守护进程以自己的身份发出（声明期间结算 `kind: "notice"`，出口检查不问），`wake` 照样作为条目交给宿主（origin/main 上同样；INVARIANTS SC-3、ID-10、DL-7）。现在这些到点什么都不发、不进宿主入站队列：这一次是最终失败（`schedule:<id>` 里的 `notice`，原因是 `set by external:<名> through module external-mcp, which is off; not sent` 或 `… which does not act for external:<名> now; …`，`wake` 的结尾是 `not handed to the host`），定时任务留着（一次性的也不删：`nextAt` 停在没发出去的那个时刻，`notice` 写 `not tried again until the next start`，下次启动按错过的补一次或跳过，SC-2），客户端加回来（重启守护进程）以后照常以它的身份触发。`wake` 到点时路由已不在客户端的 `schedule:` scope 里，也是最终失败（原来照样交给宿主）。线上新增的字段：`ScheduleView` 的 `module`（外部客户端设的：`"external-mcp"`；之前设的没有这个字段，按 `createdBy` 的 `external:` 前缀认）与 `lastFailure { scheduledAt, at, reason }`（任何定时任务最近一次到点最终失败时；下一次投递成功或替换时清掉），`schedule.put` / `schedule.list` 的结果、对外端点的 `schedule_list` 和 agent 的 `schedule_list` 工具的答复里都有（工具本身的定义不变）；`aio schedule list` 在有 `lastFailure` 的一行末尾多一列。主人、agent、宿主的定时任务不变。嵌入方见 `packages/daemon/README.md` 末尾（`ModuleHooks.scheduledWake`、`ModuleFields.schedules`、`KernelBackend.addScheduleAs` 的模块 id、`Gateway.putSchedule` 的 `module`、`FinalFiringError` 与 `ScheduleRegistry.fail` 的 `keep`）。
- **2026-11-24（core-slimming G9 的缺口：进程外 harness）**：新的 harness 种类 `bridge`（§4.8，新包 `@agents-io/harness-jsonl-bridge`：`spawnHarness`、`serveHarness`、`bridgeHarnessModule`、`HarnessBridgeError`），配置文件的 `harnesses.<名>.use` 多了 `"bridge"`。JSONL harness 帧只加不改：`probe` 多了可选的 `features`、`instance`、`config`，`open.mcp` 多了可选的 `transport`，`nativeId` 多了可选的 `client`，新帧 `inject`、`detach`、`result`（主机到程序）与 `closed`、`blob.stat`、`blob.get`（程序到主机）；`ProbeResult` 多了可选的 `declares`、`methods`。`@agents-io/protocol` 新增 `HarnessDeclares`、`NativeClientSpec`、`OpenResult`、`BlobStat`、`BlobBytes`、`BLOB_GET_MAX_BYTES`、`HARNESS_BRIDGE_FEATURES` 和 `HarnessModule.probeAtStart`，`HARNESS_HOST_FRAME_TYPES` / `HARNESS_ADAPTER_FRAME_TYPES` 列出新帧；`packages/protocol/schema/` 多了 `ProbeResult`、`HarnessDeclares`、`OpenResult`、`NativeClientSpec`、`BlobStat`、`BlobBytes`，`HarnessHostFrame` / `HarnessAdapterFrame` 随之更新（`$id` 不变）。`@agents-io/testkit` 新增 `runHarnessConformance`、`conformanceInput`。嵌入方：`@agents-io/daemon` 的 `InstanceHarness` 的 `detach`、`dispose`、`ownProcess`、`takeover` 改成读取时才看内层适配器的访问器（原先在构造时取一次），值与原来一样；`builtinHarnesses.kinds` 是 `claude-code`、`codex`、`bridge`。
- **2026-11-24（core-slimming：`live_*` 只在有通道能开 live 时挂上）**：行为变化（ROADMAP §1 原则 2：模型用不了的工具是负担）。`live_join`、`live_say`、`live_leave` 只在至少一个运行中的通道能开 live（适配器实现了 `ChannelAdapter.openLive`）时出现在 harness 的 `tools/list` 里；没有这样的通道时三个都不列、也调不了（调用答 MCP 的 `Tool live_join not found`），只是还有某个会话的 live 在跑时（开它的通道被删、`start` 结束，端点没随之结束）`live_say`、`live_leave` 照旧列出、可调，live 能接着说话、能离开（INVARIANTS LN-4）。每次请求宿主 MCP 端点时判断（端点无状态，每个请求一个 MCP server），所以后来起来的通道（`console.liveChannels` 起的、模块通道）让它们出现在下一次 `tools/list` 里，通道停了或被删掉就从下一次里消失；重连中的通道照旧算。Claude Code、Codex 在会话开始时列一次工具，所以实际效果是下一个会话（或 harness 下一次重列）才看到变化。仓库里的公开 lark-bot、mail、bridge 都不能开 live：只配了它们的部署（如 owner 只配了公开 lark-bot 的部署）升级后不再有这三个工具，`liveTools` 段和 `agents.<name>.tools` 里列的 `live_*` 照旧合法，只是这时不列出（列表里只有 `live_*` 的 agent 端点照旧挂着，这时 `tools/list` 答空列表，不是错误）；工具的名字、说明、输入 schema、注解与顺序在出现时与原来逐字节相同。`get_channel_context` 的 `abilities.tools` 同样只列这次提供的工具。线上的帧、字段、配置文件不变。嵌入方：`ModuleInstance` 新增可选的 `offeredTools()`（模块现在提供它的哪些工具，每个请求问一次；不是函数时 setup 失败，抛错记日志、一个都不提供），`KernelContext.live` 新增 `channels()`（运行中能开 live 的通道，`id:account`）和 `running()`（有 live 在跑的会话），`KernelBackend` 多了必填的 `liveChannels`、`liveSessions`；`@agents-io/host-mcp` 的 `ModuleTools` 多了可选的 `offered()`、`HostTools` 多了 `withheld()`，`toolCatalog` 仍是可挂的全部。自己直接给 `HostToolsOptions.live` 的嵌入方不受影响（内核自己的 `live_*` 照旧总是列出）。
- **2026-11-24（core-slimming：第三方走同一条契约）**：线上的帧不变；配置文件多了顶层键 `modules`（§4.6），admin API 的 `GET /api/config` 的 `env` 每项多了可选的 `implicit: true`（不经 `env:` 引用、由通道条目的类型直接读的变量，`ChannelModule.implicitEnv`；JSON Schema `AdminConfigDocument.json` 随之更新，没有这样的变量时答复不变）。`@agents-io/daemon` 新增 `loadConfigModules(o)` / `importConfigModules(raw, { baseDir })`（`src/config-modules.ts`）：导入配置指名的模块文件（`modules` 条目的功能模块、`type: "module"` 通道文件），答回 `{ moduleRegistry, channelRegistry }`，交给 `loadConfig` / `resolveConfig` 和 `Gateway.start`（两边同一份；`aio serve` 就是这样做的）。随之新增 `Config.moduleEntries`（解析出的 `modules` 条目：文件与导出；`Gateway.start` 要求它们都在注册表里，否则 `ConfigError`）、`RegisteredModule.entry`、`ModuleRegistry.with` / `fromEntry`、`ChannelRegistry.with` 与 `ChannelRegistryOptions.admins`、`moduleChannelType` / `ChannelModuleFiles`、`readConfigFile`、`configPath`、`resolveModuleEntry`，`@agents-io/protocol` 的 `TakeoverServices.config`（守护进程的配置文件，`use: "module"` 种类的 CLI 命令经它找到）。嵌入方的功能模块：`KernelContext.policy` 改为冻结的视图（同样的钩子；原先给它的成员赋值会改掉 lane 用的策略，现在抛 `TypeError`）。自己构造配置又不导入模块文件的嵌入方不受影响，除非配置里有 `modules` 条目或导出描述符的通道文件（这时启动失败，错误说要先 `loadConfigModules`）。评审后的修复（2026-11-25）：admin API 的 `GET /api/config`、`PUT /api/config`、`POST /api/config/validate` 和 `console.liveChannels` 的热生效按下一次启动的读法看文档，先导入它指名的模块文件，所以经控制台写的 `modules` 条目、描述符通道写错时 `PUT` 答 422（原先答 200，下一次启动才失败），描述符标的凭据在 `GET` 里遮挡、`PUT` 拒收字面值，新加的描述符通道能热生效（贡献了启动时没挂上的 admin 路由的除外：记在 `failed`，等重启）；帧与字段不变。嵌入方：`ConfigModules` 多了 `importModules`，`GatewayOptions` / `ConfigStoreOptions` 多了可选的 `importModules`（`...r` 交给 `Gateway.start` 就带上了），`ConfigStore.document()` / `validate()` / `put()` 改为返回 promise，新增 `ConfigStore.resolveImported`；两个 `declares` 不同的 `use: "module"` 描述符的 `create` 返回同一个适配器时，停止时每种生命周期调用只调一次（原先两次）。第三轮评审的修复（2026-11-25）：`type: "module"` 通道条目的文件此刻找不到（删了、挪了）时，`GET /api/config` 原先按不认得它的描述符遮挡，描述符标的凭据会以明文出现；文件解析到了另一个（升级了包）时只按新描述符的标记。现在守护进程启动时导入的描述符照样标它的条目（与这次导入的标记取并集），`PUT` 的保留原值（写回 `ADMIN_REDACTED`）与拒收字面值也按并集；帧与字段不变。描述符通道的状态目录（`init.stateDir`）改按条目写的 `module` 取名：`<dataDir>/channels/module.<账号，URI 编码>/<h>`，`h` 是 `["<spec>", <export 或 null>]` 这段 JSON 的 SHA-256 的前 16 个十六进制位，`spec` 是写的 `module`，路径（以 `.` 或 `~` 开头、或绝对路径）按配置文件所在目录变成绝对路径并规范化，裸包名照写。原先按解析到的文件取名，裸包名在 pnpm 下解析到带版本号的真实路径，升级包就换到一个新的空目录。现在跨重启、升级包都不变；改了条目的 `module`（同一个文件换一种写法也算，如裸包名改成 `./node_modules/…` 的路径）、`export` 或 `account`，或者相对路径的条目所在的配置文件挪了目录，就换一个目录（旧目录留着，不搬）。直接指向一个文件的路径条目，目录名与原先相同。嵌入方：解析后的描述符条目多了 `spec`（类型 `ModuleChannelSettings`，`moduleSpec` 算它），`ChannelModuleFiles` 的构造多了可选的第二个参数（把条目写的 `module` 规范化，`importConfigModules` 给的是 `moduleSpec`），`redact` / `unredact` / `isCredential` 的注册表参数也可以是几个（`CredentialMarks`：任一个标了就算）。
- **2026-11-25（core-slimming：预设成为功能模块）**：预设（`presets`、`agents.<n>.preset`、`run.start` 的 `overrides.preset`、`/preset`）是内建功能模块 `presets`（`@agents-io/daemon` 的 `bundle.ts` 注册，排在 `strangers` 之后、`owner-commands` 之前），注册了就开着：配置段 `presets` 的键、形状、位置和错误文字，`run.start` 的 `overrides.preset`（§4、INVARIANTS RN-2，`bad_override` 的文字不变）、`/preset` 的列表与回复（CT-2）、会话上设过的预设都与原来一样；帧与字段不变。线上可见的只有：`GET /api/status` 的 `modules` 多了 `{ id: "presets", origin: "builtin", enabled: true }`。嵌入方：内核经新的接缝 `ModuleManifest.runDefaults`（`ModuleRunDefaults`、`NamedRunDefaults`，`@agents-io/protocol`）问提供预设的模块（至多一个），不读它的段；`ModuleConfig` 多了可选的 `entries`（段是名字到条目的映射，没有 `enabled`），`ModuleResolveContext` 多了 `harnesses`（配置了的实例名），`ModuleFields` 多了 `sectionAfter`；`@agents-io/daemon` 新增 `presetsModule` 所在的 `src/presets.ts`（`PresetConfig`、`PresetsConfig`、`PresetsSection`、`DEFAULT_PRESET` 改由 `bundle.ts` 导出，包的导出名不变）、`NamedRuns`（`src/run-defaults.ts`，`Gateway.namedRuns`）、`ModuleHost.runDefaults`；`resolveModules` 多了可选的第五个参数 `harnesses`。`Config.presets` 改为可选、已弃用（保留一个版本：与 `Config.modules` 里预设模块的设置是同一个对象，在 `Gateway.start` 之前改它照旧算数）。自己给 `Gateway.start` 注册表的嵌入方要注册 `presets` 才有预设：没有时配置写了 `agents.<n>.preset` 加载即失败（`agents.<n>.preset: unknown preset "<名>" (no registered module provides presets)`，INVARIANTS CF-4），`overrides.preset` 答 `bad_override`，`/preset` 说没有预设。
- **2026-11-25（core-slimming：内核成为自己的包）**：线上（帧、字段、配置文件、错误文字、admin HTTP API）不变，`packages/daemon/dist/index.js`、`dist/cli.js`、`aio` 和 JSON Schema 文件都在原处。嵌入方：内核是新包 `@agents-io/kernel`（`packages/kernel`：网关、配置解析、模块宿主与注册表、本地 socket、宿主与客户端协议、记录、控制台的核心部分；不依赖任何通道或 harness 包，也不依赖 `@agents-io/daemon`），`@agents-io/daemon` 是组合根：注册内建的通道类型、harness 种类和功能模块，再导出内核的全部 API，原有的名字、缺省值（不给注册表时是内建的）和类型都不变，另外多导出 `isModuleChannelType`、`moduleChannelModule`、`FIXED_SESSION`、`ephemeralTurn`、`EPHEMERAL_TURN_MS`、`harnessModuleCommands`、`testHooksFromEnv`、`TEST_HOOKS_ENV`。直接用 `@agents-io/kernel` 的嵌入方：不给注册表时是空的（同 `coreRegistries()`），没有 `ConfigFile` 值、`RESERVED_CHANNEL_IDS`、`CONFIG_DIR_KEYS`，`Config` 没有已弃用的 `presets`、`externalMcp` 字段，`ChannelEntry` / `ResolvedChannel` 不按内建类型细分；接管会话的终端（`HarnessAdapter.takeover`）要 `GatewayOptions.cli`（新的可选字段：终端的帮手用哪个 CLI 跑，`@agents-io/daemon` 给它自己的 `aio`），没有时 `tui.attach` 答 `unsupported`。见 `packages/daemon/README.md` 末尾与 `packages/kernel/README.md`。
- **2026-11-25（core-slimming：控制台成为自己的包，harness 种类也能贡献 admin）**：线上（帧、字段、配置文件、错误文字、admin HTTP API 的路径、状态、答复体与鉴权）不变，`packages/daemon/dist/index.js`、`dist/cli.js`、`aio` 和 JSON Schema 文件都在原处。嵌入方：控制台是新包 `@agents-io/console`（`packages/console`，只依赖 `@agents-io/protocol` 与 `@agents-io/kernel`）：`ConsoleServer`、`ConsoleAuth`、`consoleProof`、`CONSOLE_COOKIE_PREFIX`、`adminEndpoints`、`ConfigStore`、`isCredential`、`redact`、`unredact`、`implicitEnv`、`envRefs`、`writeFileAtomic`、`CredentialMarks` 从内核搬到这里，另有给网关用的 `consoleFactory`；`@agents-io/daemon` 照旧导出这些名字（也再导出控制台包），它的 `Gateway.start` 照旧服务控制台。直接用 `@agents-io/kernel` 的嵌入方：内核没有控制台的类与函数，只留接缝（`ConsoleHost`、`ContributedRoute`、`ConsoleServerOptions`、`ConfigStoreOptions`、`PutOutcome` 照旧，新增 `ConsoleConfigStore`、`ConsoleListener`、`ConsoleFactory`），要控制台就把控制台包的 `consoleFactory` 交给新的可选字段 `GatewayOptions.consoleFactory`；没有它时没有 `configStore`，`console: true` 启动即 `ConfigError`。`HarnessModule.admin`（`@agents-io/protocol`）是新的：harness 种类与通道类型一样贡献 `AdminContribution`（控制台设置、schema、路由、挂载），`HarnessRegistry` 注册时检查与认领，与通道类型的贡献互查；`console` 段里它们的键在通道类型的之后，控制台在通道类型的路由之后服务它们，`adminEndpoints(channels, harnesses)` 列在最后。内建的 harness 种类不贡献。见 `packages/daemon/README.md` 末尾与 `packages/console/README.md`。评审后的修复（2026-11-25）：`type: "module"` 通道文件的描述符贡献的 admin 路由或 schema 与注册了的 harness 种类的重复时，`PUT /api/config`、`POST /api/config/validate` 原先答 500 `internal`，现在与同通道类型重复时一样答 422（问题在 `/channels/<i>`，说出条目）；启动时是说出条目的配置错误（`aio serve` 退出码 2），原先是不说条目的普通错误。帧与字段不变。嵌入方：`importConfigModules`、`loadConfigModules`（经 `LoadOptions.harnessRegistry`）多了可选的 `harnessRegistry`（守护进程的 harness 种类，描述符的 admin 贡献与它们的一起认领；`@agents-io/daemon` 缺省是内建的），`ImportConfigModules` 的参数也多了可选的 `harnessRegistry`（控制台的 `ConfigStore` 交给它守护进程的）。
- **2026-11-25（core-slimming G9：ACP harness）**：新的 harness 种类 `acp`（§4.10，新包 `@agents-io/harness-acp`：`AcpHarness`、`acpHarnessModule`、`MCP_STDIO_BRIDGE`、各 flavor 与映射函数），配置文件的 `harnesses.<名>.use` 多了 `"acp"`，`@agents-io/daemon` 的 `builtinHarnesses.kinds` 是 `claude-code`、`codex`、`bridge`、`acp`。别的线上（帧、字段、错误文字、admin HTTP API）不变；没有配 `acp` 实例的部署什么都不变（`/plan`、`/bypass` 的回复照旧只点名 Codex：这个种类没有种类级的声明）。`@agents-io/testkit` 的 transcript 多了 `protocol: "acp"`（`TRANSCRIPT_PROTOCOLS`），`teardownAnswers("acp")` 的答复带 `jsonrpc: "2.0"`。
- **2026-11-25（core-slimming G9 北向：会话作为 ACP agent 与 AG-UI 事件流）**：两个新的内建功能模块 `acp-server`、`ag-ui`（§4.11，`@agents-io/daemon` 的 `bundle.ts` 注册，排在 `owner-commands` 之后、`external-mcp` 之前），都缺省关，没有它们的配置段时什么都不变；配置文件多了可选的顶层键 `acpServer`、`agUi`（文件 schema 里在 `externalMcp` 之前），`GET /api/status` 的 `modules` 多两项（`enabled: false`）。线上只加不改：客户端帧多了 `module.connect`（`ClientFrame.json`），`external` 回调的 `args` 多了可选的 `endpoint`（`HostEventFrame.json`），`features` 可能多 `acp.server`、`ag-ui`，`input.cancelled` 的 `reason` 可能是 `withdrawn`（ACP 客户端取消了还在排队的 prompt）。本地 socket 现在一行一行地解码收到的一块，坏行在它的位置答 `bad_json`（一块只有一行时与以前相同）。嵌入方：`KernelContext` 多了 `subscribe`、`blobs` 和 `lanes.withdraw`，`ModuleInstance` 多了 `connect`，`ModuleManifest` 多了 `cli`（`ModuleCliCommand`），`KernelBackend` 多了必需的 `subscribe`、`putBlob`、`laneWithdraw`（见 `packages/daemon/README.md` 末尾）；`@agents-io/session` 多了 `withholdingFold`。
- **2026-11-24（路由层与后端，§4.12）对严格校验的宿主可见的协议变化**：都是新增的可选字段、帧与错误码，没有配置 `backends` 的守护进程发出的帧不变。字段：`Binding.to`、`InboundItem.to`、`RouteExplanation.matched[].to`、`RouteExplanation.matched[].rejected.code` 多一个值 `click_sender`、`HostHelloResult.backend`、`EffectExplanation.backend`、`AdminQueueConsumer.backend`（`GET /api/queue`）。帧：`backends.list`、`backends.key`、`backends.forget` 与结果 `BackendsListResult`、`BackendsKeyResult`、`BackendsForgetResult`；admin 端点 `GET /api/backends`、`POST /api/backends/:id/key`、`POST /api/backends/:id/forget` 与 `AdminBackends`、`AdminBackendKeyRequest`、`AdminBackendKeyResult`、`AdminBackendForgetResult`（JSON Schema 都在 `packages/protocol/schema/`）。错误码：`forbidden`（后端钥匙用了白名单之外的帧，或开控制台 API）、`route_not_allowed`、`unknown_backend`、`key_exists`。配置了至少一个后端时 `features` 多一项 `backends`，并且宿主 token 的连接不能再自称 `backend:` 开头的名字、不能推送消费 `backend:<id>`（`invalid_frame`），用 `backend:` 开头、又不是哪个后端游标的消费者名（`host.hello` 的 `consumer`、`inbound.read`、`inbound.ack`）答 `unknown_backend`：之前拿 `backend:` 开头的字符串当普通消费者名的宿主，配置后端之前要改名。`Binding` 的 schema 是开放的（允许多余的键）：宿主若一直在规则上带着自己的 `to` 字段，升级后它会被当成后端名校验，整张表答 `unknown_backend` 或 `invalid`；升级前看一眼自己推的表。降级要小心：旧守护进程不认识条目的后端一列，队列里带 `to` 的条目会被宿主 token 的消费者读到，队列里有过带 `to` 的条目就不要降级。
- **2026-11-25（后端的媒体与规则标签，§4.13、§2）对严格校验的宿主可见的协议变化**：都是新增的可选字段、帧与错误码。字段：`Binding.tag`、`InboundItem.tag`、`RouteExplanation.matched[].tag`。帧：`blob.stat`、`blob.get`、`blob.put`（`HostRequestFrame` 多三种；结果 `HostBlobStatResult`、`HostBlobGetResult`、`HostBlobPutResult`；常量 `BLOB_FRAME_MAX_BYTES`），这三种 `type` 原来答 `invalid_frame`。错误码：`blob.*` 的 `not_found`、`too_large`、`bad_offset`、`busy`、`quota_exceeded`、`blob_error`、`unsupported`，后端的 `deliver` / `deliver.update` 多 `unknown_blob`、`too_many_attachments`。`host.hello` 的 `features` 多 `binding.tag` 与 `blobs`（宿主 token 的连接，排在 `attention` 之后）；后端钥匙的 `features` 多 `blobs`。行为变化只有两处：(1) `Binding` 的 schema 是开放的，原来表里自己带着 `tag` 键的宿主（守护进程以前忽略它）：键写在 `on: "host"` 或带 `callout` 的规则上时，现在它是标签，值是 1 到 128 个字符、不含控制字符的字符串就被抄到条目与 `explain` 上，不是的话整张表答 `invalid`（这样一张旧守护进程持久化的宿主表，升级后启动时被整张忽略并记一条 warn，直到宿主推一张合法的）；写在别的规则上的照旧忽略，不校验、不抄；(2) 后端钥匙的 `deliver` / `deliver.update` 的附件原来不检查，现在必须是它被给过的或它自己上传的引用，且一条消息至多 32 个（§4.13）。宿主 token 的 `deliver`、不带 `tag` 的表、不用这三个帧的宿主都不变。`@agents-io/protocol` 新导出 `mediaBlocks`、`MediaBlock`；`@agents-io/daemon` 的 `LocalClient` 多 `blobStat` / `blobGet` / `blobPut` / `readBlob` / `writeBlob`，`Peer` 多可选的 `flushed()`，`FrameTransport` 多可选的 `flushed()`，`GatewayOptions` 多 `hostBlobs`（测试用）；`@agents-io/session` 的 `FsBlobStore.put` 多第三个可选参数 `{ provisional }`。
- **2026-11-25（后端分支与 origin/main 合并）**：两边的帧、字段、错误码与文字都不变。本文里后端的两节是 §4.12（后端与钥匙）、§4.13（blob），§4.10、§4.11 是 ACP harness 与北向投影。线上可见的只有顺序：配置了后端时宿主 token 的 `host.hello` 的 `features` 里，`backends` 排在内核的之后、功能模块的（`external.mcp`、`acp.server`、`ag-ui`）之前。功能模块不能声明 feature `backends`（注册时拒绝，与内核别的 feature 一样）。凭后端钥匙的连接发客户端帧 `module.connect`（`aio acp` 用的那一帧）同别的客户端帧一样答 `forbidden`；后端钥匙开不了 ACP 服务端与 AG-UI 端点，它们各有自己的客户端令牌。嵌入方：`BackendKeys`、`HostBlobs` 随内核在 `@agents-io/kernel`（`packages/kernel/src/backends.ts`、`host-blobs.ts`），`ConsoleHost` 的 `backendOf`、`backends` 在它的 `console-host.ts`；`@agents-io/daemon` 照旧转出 `LocalClient`（`readBlob`、`writeBlob`、`backends*`）与 `Gateway`。

### 4.6 模型生成的话题标题（模块 `topic-title`）

模型生成话题标题属于宿主级的功能（决定 16，core-slimming §2）：agents-io 只留钩子，现有实现是内建功能模块 `topic-title`（`packages/daemon/src/topic-title.ts`），缺省开着。

- **它做什么**：话题（决定 6）的第一个标题取自开头那条消息。之后，已配置 agent（`agents` 里的）的话题会话里第 1 次完成的轮次、以及之后每第 3 次（第 4、7……次；失败、中断的轮次不算）完成时，它请内核在这一轮所用的 harness 实例上跑一个临时的一轮，让模型给一个短标题；只在实例声明了 `ephemeralOpen` 时这样做（内建的只有 Codex，Claude Code 上不生成），没有配置 `agents` 时的默认 agent 也不生成。话题的标题仍是生成的（`titleSource: "auto"`）、并且这期间没变过，才换上新标题，同时把这个会话最新一张卡片的标题改过来（飞书卡片的标题栏）。同一个话题同时只有一个生成在跑。声明了范围的宿主（§4.1a，U20）检查这个话题时（它的对话在范围里，或这个会话有过受检的一轮）：受检的一轮的回答结算之后才起标题，没过检的回答（还在检查、被扣下、被拒）不进提示词；标题记下之前先问宿主（`kind: "title"`），不 `allow` 不记。问宿主是内核做的（`setAutoTitle`），不管标题是哪个模块起的。
- **宿主现在能做的**，只有这几样：
  - 关掉这个模块：配置 `topicTitles: { enabled: false }`（段里只有 `enabled`；不写这一段就是开着）。关掉之后话题只有取自开头消息的标题，或者建话题时明确给的。
  - 建话题时给标题：客户端帧 `topic.switch { conversation, new: { title } }`（宿主连接也可以发，按 `Policy.control` 检查），聊天里的 `/new <标题>`，模型的 `session_rotate({ title, summary })`。这样给的标题是明确的（`explicit`），模块开着时也从不覆盖。
  - 读标题：`topic.list` 给出每个话题的 `title`，`topic.changed` 事件带新话题的标题。
  - 没有改名的帧，也没有别的 API：话题建好之后，宿主改不了它的标题，也给不了"生成的"标题。
- **嵌入守护进程的代码**（同一进程里自己调 `Gateway.start` 的，不是经协议连上来的宿主）可以不用内建模块（`topicTitles: { enabled: false }`），在传给 `Gateway.start` 的 `ModuleRegistry` 里注册自己的功能模块（`packages/daemon/README.md` "Feature modules"）：`hooks.onTurnCompleted` 得知一轮结束，`KernelContext.lanes.harness(sessionKey)` 的 `ephemeralTurn({ turnId, prompt, instructions })` 在这一轮所用的 harness 上跑一个临时的一轮、答回文字（会话、权限档、选项都由内核定，模块只给提示和指令），`KernelContext.topics.setAutoTitle(topicId, expected, title, turnId)` 换上标题并刷新卡片（只在标题仍是生成的、仍是 `expected` 时生效，答回一个 promise；受检的话题先问宿主）。内建模块就是这样做的。
- **用打包的 `aio` 的部署**（不嵌入守护进程，只写配置）也能这样做：配置的 `modules` 条目 `{ "use": "module", "module": "./my-titles.mjs", "export": …, "config": { … } }` 指向一个导出 `ModuleManifest` 的 ES 模块（`export` 缺省取 `manifest`，否则 `default`；写了 `export` 就不回落；路径的解析同 module 通道，相对配置文件），`aio serve` 启动时在解析配置之前导入它（`loadConfigModules`），注册在内建模块之后（origin `module`，`GET /api/status` 的 `modules` 里能看到）。条目的 `config` 就是它的设置：它的 `config.schema` 加上 `enabled`，封闭，经它的 `resolve`（`ctx.where` 是 `modules[<i>].config`）；`enabled: false` 关掉它，不写 `config` 就是开着（它的 `config.section` 与 `aliases` 不在文件里读）。它的工具可以列在 `agents.<名>.tools` 里，命令进 `/help`，feature 进 `host.hello`。它拿到的 `KernelContext` 与内建模块的相同，也受同样的限制：只能以 peer 的身份进会话（INVARIANTS ID-10），`policy` 是冻结的视图，说不了证据授予。它是与守护进程同进程、同权限的代码：只写自己信任的模块。条目写错（文件不存在、导出不是清单、与别的模块重复、`config` 不合它的设置）让 `aio serve` 以退出码 2 失败，错误说出条目（CF-4）；经控制台写的，`PUT /api/config` 先导入它、照样查，写错就答 422、不写文件。

### 4.7 客户端命令的操作 id（feature `client.opId`；INVARIANTS PR-3）

断线重连之后重发一条命令，原先可能做两次：`input` 不带 `inputId` 时多一条输入，带了答的是 `duplicate` 而不是第一次的结果；不带 `turnId` 的 `interrupt` 可能打断下一轮；`topic.switch { new }` 多建一个话题；不带 `id` 的 `watch.add` 多建一个监听。这几种帧可以带 `opId`：客户端为这一条命令取的 id（1–256 字，按主体唯一，用 UUID），放在帧上，与 `id` 并列：

```jsonc
{ "v": 1, "type": "command", "id": "7", "opId": "3f0c…", "command": { "type": "input", "sessionKey": "s", "mode": "queue", "input": { "content": [{ "type": "text", "text": "hi" }] } } }
{ "v": 1, "type": "topic.switch", "id": "8", "opId": "9a41…", "conversation": "lark-bot:default:oc_x", "new": { "title": "Plans" } }
{ "v": 1, "type": "watch.add", "id": "9", "opId": "c2d7…", "watch": { "source": { "channel": "lark-bot", "conversation": "oc_y" }, "target": { "sessionKey": "s" }, "mode": "context" } }
```

- **第一次**照常执行。应答（成功或拒绝都算）记进守护进程库里的 `client_ops`，和决定它的那条事件在同一个事务里提交（`input` 的 `input.admitted` 或 `input.rejected`，清队列的 `interrupt` 的 `input.cancelled`，`topic.switch` 的话题变化与 `topic.changed`，`watch.add` 存下的监听）；什么都没写的（重复、被拒）单独记。
- **应答**在结果帧上多几个字段（`ClientResultFrame`）：`opId`；`seq`：和应答一起提交的那条事件的 seq（`topic.switch` 的是 `value.topic` 那个会话里的 `topic.changed`），没写事件时没有；订阅（`subscribe`）收到的事件过了这个 seq，就能看到这条命令的结果，界面据此更新。
- **重发**同一个 `opId`（同一个主体：本机的客户端是本机的主人，宿主连接是 `host:<名>`，同名重连还是它）：原样答第一次的应答，加 `replayed: true`，什么都不再做；换一条连接、守护进程重启之后、日志压缩之后都一样。第一次还在执行时，重发等它的应答。被拒的也是这样：重发得到同一个拒绝，要再试就换一个新的 `opId`。
- **对不上**：同一个 `opId` 用在另一种帧（`command` 以里面的命令类型算：`input` / `interrupt`）或另一个会话上（`topic.switch` 以 `conversation` 算，`watch.add` 以监听的目标会话算），答 `op_id_conflict`，什么都不做。
- **`interrupt` 不带 `turnId`**：第一次解析出要打断的那一轮（或者没有在跑的），动手之前先记下；之后的重发只针对它：它已经结束就答 `stale_turn`，绝不打断后来开始的一轮。
- **没记下的**：守护进程正在停止（`stopped`），或者应答记下之前命令内部出错（`internal`）：重发照常执行。回执本身写不进库时命令答 `internal`，和它一起提交的事件随它回滚：输入没有被接纳，队列没有被清，话题和监听没有建，守护进程的内存里也没有（原来的话题仍是当前的，监听不路由消息）；重发照常执行一次，带着自己 `inputId` 的输入这时照常接纳，不答 `duplicate`。只有 `mode: "steer"` 的 `input` 例外：harness 已经收下这条输入，收不回来，它照样被接纳（这一轮照常结算它），命令仍答 `internal`。这时重发没有应答可答，照常执行：输入带着自己的 `inputId` 时，lane 认得它（重启之后也从日志认得），重发答 `duplicate`，不会再 steer 一次；不带的，重发另取一个 `inputId`，会再 steer 一次。所以 steer 的输入最好带上 `inputId`。
- 回执不删，不随日志压缩删除，也不随 30 天的保留期清理（同 outbox 的结算记录，INVARIANTS DL-2）。
- 不带 `opId` 的帧与以前完全一样，应答里也没有这几个字段。别的帧和命令（`resolve`、`subscribe`、`watch.remove`、`tui.attach` 等）重发本来就不会做两次，上面的 `opId` 当作未知字段忽略，应答不带 `opId`。
- **怎么知道守护进程支持**：`host.hello` 的 `features` 里有 `"client.opId"`。不说 `hello` 的本机客户端看应答：旧守护进程把 `opId` 当未知字段忽略，应答里没有 `opId`；应答带着 `opId` 的，守护进程认了这个 op id（是不是记下了见上面两条）。

### 4.8 进程外 harness（`use: "bridge"`，JSONL harness 帧）

harness 也可以是另一个进程里、任何语言写的程序：守护进程经 stdio 跟它说 JSONL 的 harness 帧（`packages/protocol/src/wire.ts` 的 `HarnessHostFrame` / `HarnessAdapterFrame`，JSON Schema 在 `packages/protocol/schema/`）。宿主端是 harness 种类 `bridge`（`harness/jsonl-bridge`，`@agents-io/harness-jsonl-bridge`，由 `packages/daemon/src/bundle.ts` 注册），和私有通道的 bridge（CHANNELS §5）同一个做法。它拿到的与进程内的 harness（内建的、`use: "module"` 的）一样：静态声明、停止与重启时的调用、blob 存储。

```jsonc
"harnesses": {
  "mine": { "use": "bridge", "command": "./bin/my-harness", "args": ["--quiet"],
            "env": { "MY_API_KEY": "env:MY_API_KEY" }, "cwd": "~/work",
            "config": { "endpoint": "https://…", "token": "env:MY_TOKEN" } }
}
```

- **配置**：`command`（路径按配置文件目录解析，裸名在 PATH 上找）、`args`（原样上命令行，本机其他用户用 `ps` 看得到，不放机密）、`config`（在 `probe` 里交给程序，`"env:NAME"` 替换，变量没设时这个实例暂不可用）；共有字段照旧：`env` 是程序的环境（盖在守护进程的上面，`null` 删掉一个变量），`cwd` 是它的会话的工作目录，也是程序自己的，`profiles` 在每次 `open` 的 `options.profiles` 里交给程序（由它映射成自己的设置）。
- **启动**：守护进程启动时就拉起每个可用的 bridge 实例的程序、发 `probe`（`HarnessModule.probeAtStart`），在读任何声明之前等它的回答。回答就是程序的 hello：`version`、`caps`，以及可选的 `declares`（`displayName`、`compact`、`modes`、`ownerProfileSwitch`、`ephemeralOpen`、`adopts`、`attach`、`sessionEnv`，形状同 `HarnessAdapter` 的静态声明，schema `HarnessDeclares`）和 `methods`（它实现的可选方法，现在只认 `detach`）。回答形状不对（例如 `modes` 里不是 `'plan'`、`sessionEnv` 是 `null`、`compact` 没有 `command`、`caps` 不合 schema）、声明了 `attach: 'takeover'`（bridge 带不了接管）、帧的 `v` 不是 1、程序起不来（命令不存在）或没在 10 s 内回答，都让启动失败，错误里有实例名和成员（`harnesses.mine (bridge): invalid probe answer: /declares/modes/0: …`，CF-4），程序被杀掉。暂不可用的实例（`env:` 引用的变量没设）不拉起，什么都不声明：带 env 的 launch 答 `launch_unsupported`，文字是它不可用的原因；上次留下的轮次在启动时按 ambiguous 结算（同没运行过工厂的 module 实例）。
- **旧程序**：只答 `version` 和 `caps` 的程序（这些字段加进来之前写的）什么都不声明、没有 `detach`，就是今天的缺省：`/plan`、`/bypass`、`/compact` 答不可用，停止时关会话。新帧和新字段都是加出来的（`v` 仍是 1）：守护进程在 `probe` 的 `features` 里列出它说的（`HARNESS_BRIDGE_FEATURES`：`declares`、`detach`、`inject`、`closed`、`nativeClient`、`blobs`），旧程序忽略不认识的帧和字段，新程序据此知道能不能发 `blob.stat`。
- **会话**：`open`（参数同 `HarnessOpenArgs`；指令在 `instructions`，launch 会话的 env 按 `sessionEnv` 在 `env` 里）、`startTurn`、`steer`（答 `SteerResult`）、`cancelQueued`（`caps.cancelQueued` 时）、`inject`（新帧，`caps.injectWithoutTurn` 时）、`interrupt`、`respond`、`close`。程序发 `event`（带 `generation`）、`nativeId`（可带 `client`：终端怎样加入这个原生会话，即 `attach: 'join'` 的 `nativeClient`，LN-8）和 `closed`（新帧：会话自己结束了）。`open` 的回答之前发出的事件先于回答处理：在打开时接管的轮次（`turn.adopted`，`adopts`）必须在回答之前发，否则守护进程把上次留下的轮次结算掉。程序退出时它的会话都结束（lane 记 `harness_closed`），下一次 `open` 再拉起它；重新拉起的程序必须声明与第一次相同的 `declares` / `methods`，否则按 `bad_hello` 拒绝。请求超时（60 s）连续 3 次、`log` 帧 `fatal`、程序不读输入都会被杀掉。
- **launch 会话的 env**：`sessionEnv: 'open'`（缺省）在这个会话的 `open` 的 `env` 里，程序自己用到这个会话的子进程；`'own-process'`：这个会话另起一份同样的程序，env 盖在实例 env 上、工作目录是 launch 的 cwd，lane 关闭时关掉它；`{ refused }`：带 env 的 launch 答 `launch_unsupported`。任务运行总是另起一份程序（运行的 env 并进实例的），运行结束时关掉。
- **停止**（RS-2、RS-4、RS-8）：程序在 `methods` 里有 `detach` 的，lane 改 detach，守护进程发 `detach`，程序不打断、不再发事件地结束每个会话、留下以后 `open { resume }` 要的东西，回答之后守护进程发 `shutdown`；声明了 `adopts` 的，下次启动时重开留下轮次的会话（带 `resume`），程序在回答 `open` 之前发 `turn.adopted`。没有 `detach` 的，守护进程先逐个 `close` 会话，再发 `shutdown`（`dispose`），程序停掉它跑的一切并退出；2 s 内不退出就被杀掉，停止照常有界。
- **媒体**（MD-1）：程序发 `blob.stat { ref }`（答 `{ path, mime, name?, size }`，存储里没有的引用如 `lark-file:…` 答 `null`）或 `blob.get { ref }`（答 `{ base64, mime, name? }`；大于 16 MiB 的答 `too_large`，改读 `blob.stat` 给的本地文件），读的是守护进程 blob 存储的只读视图，与进程内 harness 的 `HarnessFactoryInit.blobs` 是同一个、同样的范围。
- **写程序**：Node/TS 用 `serveHarness(adapter 或 (init) => adapter)`（同一个包）：把一个进程内的 `HarnessAdapter` 原样服务在 stdio 上，静态声明和 `detach` 自动进 hello，`init.blobs` 经连接读 blob；别的语言照帧自己写，`harness/jsonl-bridge/examples/echo_harness.py` 是一个只用标准库的 Python 例子。stdout 是协议通道，诊断写 stderr（守护进程按行记日志）或发 `log` 帧。`packages/testkit` 的 `runHarnessConformance` 对进程内的和 bridge 的适配器跑同一套检查（HC-1）。
- **带不了的**：原生终端接管（`attach: 'takeover'`，`takeover`）和实时语音（`HarnessSession.live`）只在进程内；`ephemeralOpen` 照常声明，内核替模块跑的临时一轮的 open 选项仍是 Codex 的形状。

### 4.9 会话的 attention：现在有什么在等（feature `attention`；INVARIANTS LN-11）

宿主要给人看"哪个会话在等你"（角标、推送、列表里的状态），原先要自己订阅每个会话、自己 fold 一遍。守护进程替它 fold 好，只说有什么在等，不说告诉谁、怎样告诉（推不推、推给谁、角标怎么算都归宿主）：

```jsonc
{ "state": "needs_you",            // needs_you | working | failed | idle
  "reasons": [                     // 依次：请求、失败、卡住、等着的输入
    { "kind": "request", "requestId": "r1", "requestKind": "tool_approval", "title": "Bash: rm -rf build", "since": 1764000000000 },
    { "kind": "queued", "inputIds": ["in_7"], "since": 1764000001000 } ],
  "since": 1764000000000,          // 进入这个 state 的时刻（那条事件的 ts）
  "seq": 42,                       // 最后一次改变这个值的事件的 seq
  "turnId": "t_3" }                // 在跑的一轮
```

- **`state`**：有解答者为 `human` 的请求开着（`resolve` 回调或本地策略交给人的，审核升级给人的也算）是 `needs_you`；否则有一轮在跑、有输入在等、或 harness 报了卡住（`session.state: "stalled"`）是 `working`；否则上一轮 `failed` 是 `failed`；都没有是 `idle`。`host` 解答者的请求不算（宿主自己答，已经知道）；`interrupted`、`ambiguous` 的一轮不算失败；被拒的输入（例如 `start_failed`）只是不再等着。
- **`reasons`**：`request`（`requestId`、`requestKind`、`title`、`since`：交给人的时刻；一轮结束时它开着的请求随之结束，与快照的 `pendingRequests` 同一规则）、`failed`（`turnId`、`code`：那一轮的 `error.code`，没给就没有；下一轮开始时结束）、`stalled`（`since`；下一个 `session.state` 或一轮开始、结束时结束）、`queued`（`inputIds`：已接纳、还没开始的输入，即快照的 `queued`；`since`：没有输入在等时来的第一条的时刻）。
- **`seq`**：不改变它的事件不动它：`seq` 大的新，相同的就是同一个值，宿主按它去重、排序。
- **在哪里读**：`sessions` 帧的答复（`SessionInfo.attention`，宿主连接也能发这个客户端帧）、控制台的 `GET /api/sessions`、订阅时拿到的快照（`SessionSnapshot.attention`）、`aio sessions` 每行的最后一列（`attention needs_you (request r1, 2 queued)`）。外部 MCP 的 `sessions_list` 也有，但请求不带 `title`（受检的一轮的卡片对外遮着，§4.1a）。
- **订阅变化**：在占宿主位置的 `host.hello` 里加 `optIn: ["attention"]`（**只认结果**：结果的 `optIn` 里有 `attention` 才算拿到；不占宿主位置的 hello 得到 `optIn: []`；旧守护进程不认，结果里没有 `optIn`，`features` 里也没有 `attention`）。之后每个会话的值每变一次，守护进程发一帧 `{ "v": 1, "type": "attention.changed", "sessionKey": "…", "attention": { … } }`（`AttentionChanged`，不用应答）：改变它的事件提交、发布之后才发，同一个值只发一次（一个事务里的几条事件只发一次，是它们之后的值；回滚的什么都不发），同一会话按 `seq` 递增。
- **断线**：宿主不在时不留，也不补发。重连（`hello` 带 `optIn`）之后列一次 `sessions` 取当前值，之后的帧按 `seq` 比较，旧的丢掉。
- **怎么算**：规则由 `packages/testkit/conformance/scenarios/attention/*.ndjson` 的 fixture 固定（每个是一段会话日志和它之后的值，一致性场景的格式，见 `docs/design/conformance-fixtures/` §3.6）；自己从事件 fold 的宿主或别的语言的实现可以拿它们自检。
- **对严格校验的宿主可见的协议变化**（2026-11-24）：`SessionInfo.attention`（`AdminSession` 随之有）是新的可选字段；`features` 多了 `attention`；`HostEventFrame` 多了 `attention.changed`，只在 `optIn` 之后才发；快照（`agents-io.snapshot` 的 `native`）多了 `attention`；`aio sessions` 每行末尾多一列。

### 4.10 任何 ACP agent 作为 harness（`use: "acp"`，Agent Client Protocol）

支持 [ACP](https://agentclientprotocol.com) 的 coding agent（Claude Code 的 ACP agent、Gemini CLI、codex-acp 等）不用写适配器：harness 种类 `acp`（`harness/acp`，`@agents-io/harness-acp`，由 `packages/daemon/src/bundle.ts` 注册）让守护进程做 ACP 的客户端，agent 是它的子进程，经 stdio 说 ACP v1 的 JSON-RPC（官方 SDK `@agentclientprotocol/sdk`）。只起配置好的命令，不从 ACP registry 装东西（供应链风险）。

```jsonc
"harnesses": {
  "claude-acp": { "use": "acp", "command": "/opt/acp/node_modules/.bin/claude-agent-acp",
                  "env": { "ANTHROPIC_API_KEY": "env:ANTHROPIC_API_KEY" },
                  "profiles": { "bypass": { "mode": "bypassPermissions" } } }
}
```

- **配置**：`command`、`args`（原样上命令行，不放机密）；`mcp`：宿主 MCP 端点怎么给 agent，`http`（agent 声明了 `mcpCapabilities.http`：一个 `http` MCP 服务器，token 在 `Authorization` 头里，经 stdin 交给 agent，不上命令行）或 `stdio-bridge`（一个 stdio MCP 服务器，这个包的 `bin/mcp-stdio-bridge.mjs`，每条消息转发到端点；URL 和 token 在它的环境里；所有 ACP agent 都接 stdio），缺省按 agent 声明的选；`profiles` 的每一档只写 `mode`：这一档的轮次跑在 agent 的哪个 session mode 上（每轮开始前不同就 `session/set_mode`，所以 agent 自己换了 mode 下一轮也会换回来）。没写 `mode` 的：`bypass` 跑在会话打开时的 mode 上；其他各档（内置的 `restricted`：客人、放行的陌生人、外部 peer、任务）跑在 agent 动手前先问的那个 mode 上，与 Claude Code 的 `default`、Codex 的 `on-request` 一样，由 flavor 的 `restrictedMode` 选，generic 是 agent 提供的 `default`（Claude Code 的 ACP agent 打开时在 `auto`，由它自己决定，`default` 才问）；agent 有 mode 但 flavor 认不出哪个会问时，这样的一轮不开始、说明原因，直到给这一档配上 `mode`；agent 没有 session mode 就照它的样子跑。`flavor`（agent 的怪癖，具名的钩子：`generic`、`claude`；缺省按 `initialize` 的 `agentInfo` 选）、`planMode`、`compact`、`displayName`、`elicitation`、`authMethod`。
- **能力来自 agent**（`initialize`、每个会话的 `session/new` / `session/load`）：`steer` 是 `none`（ACP 没有一轮里插话：插话排到下一轮）；打断是 `session/cancel`（agent 在等的请求先答 cancelled；15 s 内 prompt 不回答，这一轮照样以 `interrupted`、`cancel_timeout` 结束）；agent 之后还接着跑那个 prompt 时它占着会话：ACP 的更新不带 turn id，它流出的只记 `native`、不属于任何一轮，下一轮的 `session/prompt` 等它回答，至多再等 15 s，还不回答就关掉会话再打开（`session/close` 答了、agent 能 `session/load`，而且那个 prompt 随后也回答了（至多再等 15 s）才载入同一个会话：agent 可能把 close 也当作它不理的 cancel，prompt 还在跑时会流进同一个 id 的会话；否则开一个新会话、`session.bound` 给出新 id，之前的对话不在里面，旧会话还流出的到不了它），`continuity` 提示说明是哪种；会话关闭时（停放话题空闲关闭、`/preset` 切走、`release`，或一轮正跑着）agent 还没回答的 prompt 留给 agent 进程：回答之前它流出的不属于任何会话，同一个进程上续接这个会话时先等它回答，至多 15 s，回答了才 `session/load`，否则开新会话，`continuity` 提示说明（INVARIANTS LN-2、DL-3）；审批是 `session/request_permission`，映射成 `request.opened` / `request.resolved`，`allow_once` 只选 agent 给的一次性允许、绝不放宽，`allow_session` 选它的"总是"选项（没有就一次性的），`deny` 选拒绝，`native` 按 `{ optionId }` 选，"总是"的选项是请求的 `suggestions`；提问只在开了 `elicitation` 时（表单 `elicitation/create` 是 agent 问它的用户，映射成 `question` 请求，与 Codex 的 `requestUserInput` 一样：宿主问这一轮的人，对话里出问题卡片，主人的 bypass 轮次也不替人自动作答）；续接是 `session/load`（agent 重放的历史不写进日志）；Plan 模式看 `availableModes`；压缩看 agent 公布的命令（`/compact`）；从不接管：停止时会话关闭（正在跑的一轮记 `interrupted`）、agent 进程退出，重启后下一条输入经 `session/load` 续上（RS-1）。审批只在 agent 进程活着时有效。
- **不声明 `fs`、`terminal` 客户端能力**：读写文件、跑命令都由 agent 自己按它的权限做，守护进程不替它执行，也就不需要 t3code 那样的客户端权限层；权限的边界是 agent 的 session mode（由 profile 选）和它发来的审批请求（由宿主的 resolver 答）。
- **ACP 相对原生适配器少了的**：原生 steer、原生的 turn 与 item id、截断与 rollback、不开轮注入、跨重启接管、可续的审批、subagent 可见性（只有 flavor 认得出的）、稳定的用量统计；中途换模型只经 agent 不稳定的 config option。要这些的用原生的 `claude-code` / `codex`。
- **一致性**：真实 agent（claude-agent-acp 0.110.1）录下的 transcript 在 `packages/testkit/conformance/transcripts/acp/`（G8 的 L1，`protocol: "acp"`），别的语言的 ACP 客户端可以用 `aio-transcript-replay` 当 agent 自检。细节：`harness/acp/README.md`。

### 4.11 会话作为 ACP agent（`aio acp`）与 AG-UI 事件流（北向投影）

core-slimming G9 的北向（POSITIONING §9.3）：任何会话都可以被一个标准协议的前端打开，前端不用学宿主协议。两个内建功能模块，都缺省关，按自己的配置段打开；设计与安全评审见 `docs/design/north-projections/`，不变量 PR-4（映射表），ID-10、SE-5、CF-10、IN-8、RQ-3、DL-7 都扩到了它们的客户端。

**规则同对外 MCP 端点（§4.2）**：每个客户端在配置里有自己的令牌（`token: "env:NAME"` 或 `tokenFile`，存在则读、不存在则生成 0600；不得是宿主令牌，两个客户端不得相同）和 scope（只有 `read`、`read:<会话模式>`、`input:<会话模式>`）；客户端做的事由守护进程以它自己的主体盖章（`kind: "peer"`，主体缺省 `external:<名>`，永远不是人，所以它开的轮次缺省 `restricted`）；`origin.adapter` 与 `via` 是端点模块的 id（`acp-server` / `acp-server:<名>`，`ag-ui` / `ag-ui:<名>`）；声明了 `external` 钩子的宿主决定每条输入（`policy { hook: "external", args: { …, op: "input", endpoint } }`，`endpoint` 是 `acp-server` 或 `ag-ui`，新的可选字段）；输入经 lane 的回环检查（IN-8：一个客户端在一个会话里 15 分钟内开轮超过 `policy.loopGuard.pair.maxTurns`（缺省 10）次、其间没人写，之后的输入只记成上下文：ACP 的 prompt 答一个说明这一点的错误，AG-UI 的 run 以 `RUN_ERROR` `loop_guard` 结束；编辑器里聊得多的会话要调大这个上限）；答复留在会话日志里（回复路由是会话的 `local` 路由），不发到任何通道。客户端配了 `agent`（一个非任务 agent）就可以开它自己的会话（`<模块 id>:<名>:<id>`），它总能读写这些；别的会话要已存在、在它的 scope 里。受检的一轮（U20，§4.1a）的回答在放行之前不给这两个端点的客户端，扣下的永远不给（DL-7）。

**ACP 服务端**（模块 `acp-server`，配置段 `acpServer`）：会话是一个 Agent Client Protocol v1 的 agent。编辑器（Zed、JetBrains）或 t3code（它通用的 ACP provider）把 `aio acp` 当 agent 程序起：`aio acp` 连守护进程的本地 socket，以配置的客户端名和它的令牌说 `module.connect`（客户端帧，`packages/protocol/src/client.ts`），之后只在 stdio 与守护进程之间转发 ACP 的 JSON-RPC；ACP 本身由守护进程里的模块说（官方 SDK `@agentclientprotocol/sdk`）。

```jsonc
"agents": { "dev": { "harness": "claude-code" } },
"acpServer": {
  "clients": {
    "zed": { "tokenFile": "acp/zed.token", "scopes": ["read:dev:*", "input:dev:*"], "agent": "dev", "approvals": true }
  },
  "limits": { "maxTextChars": 16000, "promptsPerMinute": 20 }
}
```

```jsonc
// Zed 的 settings.json（t3code 的通用 ACP provider 同样：命令和参数）
"agent_servers": {
  "agents-io": { "command": "aio", "args": ["acp", "--client", "zed", "--token-file", "/path/to/acp/zed.token", "--socket", "/path/to/aio.sock"] }
}
```

- `aio acp --client <名> [--token-file <路径>] [--session <键>] [--socket <路径> | --config <aio.config.json>]`：令牌来自 `--token-file`（只有本人可读的文件；就是配置里这个客户端的 `tokenFile`），或 `$AIO_ACP_TOKEN`；`$AIO_ACP_CLIENT` 可代替 `--client`。socket 来自 `--socket`、`$AIO_SOCKET`，否则读配置的 `socketPath`。退出码：编辑器关掉 stdin 时 0，守护进程不在或关了连接 69，客户端名或令牌不对 77，守护进程没开 ACP 服务端 2。
- `initialize`：`loadSession: true`（会话的日志就是续接的来源），`promptCapabilities` 是文字、图片和内嵌的文本资源（`image: true`、`embeddedContext: true`，没有音频），`sessionCapabilities.list`；不要求认证。客户端的 `fs`、`terminal` 能力不用：agent 在守护进程那边按它自己的配置跑。
- `session/new`：给了 `--session <键>` 就绑定那个会话（要在客户端的读 scope 里）；否则开客户端自己的新会话（要有 `agent`）。`sessionId` 就是会话键。`cwd` 与 `mcpServers` 不用：会话的工作目录与工具是 agent 的配置（改工作目录要宿主的 `session.launch`，FC-4）。`session/load` 先把会话日志（最近 5000 条持久事件）作为 `session/update` 重放（与在线时一样，`internal` 的事件不给），再回答，然后照常往下；重放完还没结算、要问这个客户端的请求这时才问，日志里已结算的（答过的、随它的一轮结束取消的）不再问；`session/list` 列出客户端能读的会话（标题是话题标题）。
- `session/prompt`：文字、图片（存进 blob 库，作为图片块进这一轮）、链接与内嵌的文本资源；在会话里排一条输入（`queue`），等拿走它的那一轮结束才回答：`end_turn`、`cancelled`（被打断）、`refusal` / `max_tokens` / `max_turn_requests`，别的失败是一个错误（`data.code` 是这一轮的错误码）。别人在同一个会话里说的话、开的轮次也作为 `session/update` 推过来（用户消息前面带说话人的主体）。
- `session/update` 的映射（PR-4，fixture 在 `packages/testkit/conformance/projections/acp/`）：回答 → `agent_message_chunk`，推理 → `agent_thought_chunk`，工具类条目 → `tool_call` / `tool_call_update`（命令 `execute`、改文件 `edit`、搜索 `fetch`，其余 `other`），计划 → `plan`；每个请求是一个待定的工具调用（`request:<id>`），结算后 `completed` 或 `failed`。
- **审批与提问**：请求的 resolver 是 `human` 且点了这个客户端的主体时，才问编辑器（`session/request_permission`，选项是允许一次、本会话总是允许（请求允许时）、拒绝；提问在编辑器支持表单时是 `elicitation/create`）；答复以客户端自己的身份 `resolve`，lane 再查资格，先到者为准（RQ-1）；别人先答了，问编辑器的那个请求撤回（`$/cancel_request`），晚到的答复被拒。客户端从不代人作答（RQ-3）。客户端成为审批的 resolver 只有两条路：`approvals: true`（它独自开的、不是 `bypass` 的轮次的请求问它；缺省关：一个 peer 的 `restricted` 轮次里要审批的工具按缺省策略被拒），或宿主的 `resolve` 回调这样答。提问不同：缺省策略把提问交给这一轮的人，客户端自己开的轮次里就是它自己，所以不开 `approvals` 也问它（编辑器支持表单时）；它的答复是交给 agent 的文字，不放行任何工具，也不是一条输入（宿主的 `external` 钩子不问它）；不想这样，用自己的 `Policy.resolve` 或宿主的 `resolve` 回调另定 resolver。别人开的轮次里的提问不问它。
- `session/cancel`：打断客户端自己的那个 prompt 的轮次（带 `turnId`，CT-1：别人的轮次不动）；还在排队的撤出队列（日志里是 `input.cancelled`，`reason: "withdrawn"`，agent 读不到它），再答 `cancelled`，之后发的 prompt 自成一轮；撤回之前已被一轮拿走的（它的轮次恰好这时开始），那一轮只有被取消的 prompt 时一开始就被打断，否则照跑，只回答没取消的。编辑器断开不打断任何东西：这一轮照常跑完，答复在日志里，下次 `session/load` 看得到。
- 状态（`GET /api/status` 的 `modules[]`）：`{ clients, connections }`；feature `acp.server`。

**AG-UI 端点**（模块 `ag-ui`，配置段 `agUi`）：会话是一个 AG-UI agent（docs.ag-ui.com，`@ag-ui/core` 1.0），给网页界面用：CopilotKit 一类的界面（及其运行时）用 `@ag-ui/client` 的 `HttpAgent` 就能接。

```jsonc
"agUi": {
  "listen": "127.0.0.1:7466",                      // 缺省；只许回环地址
  "origins": ["http://localhost:3000"],            // 浏览器直接连时它的 origin（答 CORS）；不写则带 Origin 的请求一律 403
  "clients": { "web": { "tokenFile": "agui/web.token", "scopes": ["read:dev:*"], "agent": "dev" } },
  "limits": { "maxBodyBytes": 1048576, "maxTextChars": 16000, "requestsPerMinute": 120, "runsPerMinute": 20 }
}
```

```ts
import { HttpAgent } from '@ag-ui/client';
const agent = new HttpAgent({ url: 'http://127.0.0.1:7466/ag-ui', headers: { Authorization: `Bearer ${token}` }, threadId: 'my-thread' });
agent.addMessage({ id: 'm1', role: 'user', content: 'hello' });
await agent.runAgent({ runId: 'r1' }, { onEvent: ({ event }) => console.log(event.type) });
```

- `POST /ag-ui`，请求体是 `RunAgentInput`（按 `@ag-ui/core` 的 schema 校验，不合 400）：`threadId` 是客户端 scope 里一个已存在的会话键时就是那个会话，否则（客户端有 `agent`）是它自己的会话 `ag-ui:<名>:<threadId>`；`messages` 里最后一条 `user` 消息是这一轮的输入（文字；图片的 `data` 来源存进 blob 库，`url` 来源作为链接文字；别的部件 400）；`tools`、`context`、`state`、`forwardedProps` 不用。答复是 `text/event-stream`：`RUN_STARTED`，`STATE_SNAPSHOT`（会话现在的状态与 attention，请求不带标题；只给能读这个会话的客户端），然后只有拿走这条输入的那一轮的事件（一轮只收一个主体的输入，IN-3：只写不读的客户端看到的只是对它自己的输入的回答），最后 `RUN_FINISHED`（`outcome` 为 `success`，被打断的是 `cancelled`）或 `RUN_ERROR`（`code` 是这一轮的错误码；输入被拒是 `rejected`，回环检查截停是 `loop_guard`）。
- 映射（PR-4，fixture 在 `packages/testkit/conformance/projections/ag-ui/`）：回答 → `TEXT_MESSAGE_START` / `CONTENT` / `END`，推理 → `REASONING_START`、`REASONING_MESSAGE_*`、`REASONING_END`，工具类条目 → `TOOL_CALL_START`（名字是条目类型，MCP 工具是 `<server>.<tool>`）、`TOOL_CALL_ARGS`（`{ title, input }`）、`TOOL_CALL_END`、`TOOL_CALL_RESULT`（结果的预览），计划 → `ACTIVITY_SNAPSHOT`（`PLAN`），请求 → `CUSTOM`（`agents-io.request.opened` / `agents-io.request.resolved`：AG-UI 客户端不答请求，审批与提问由会话里的人或宿主答）。
- `GET /ag-ui/threads/<threadId>/events?fromSeq=<seq>`（或 `Last-Event-ID` 头）：从那个 seq 往后的每一轮各是一个 run（`runId` 是轮次 id），一直推到客户端断开；不给 seq 先一个 `STATE_SNAPSHOT`。每个 SSE 事件的 `id` 是它所示会话事件的 seq，一个流里不减，断了拿最后一个 `id` 续上：那个 seq 时还在跑的一轮（流断在一轮中间）是第一个 run，马上给它的 `RUN_STARTED`（`id` 就是这个 seq），再给这一轮剩下的；断在一条消息中间时，断之前流出的增量不在日志里，这条消息由它的 snapshot 整条给出（同一个 `messageId`，界面里已有的半条要换掉）。POST 的 `RUN_STARTED`、`STATE_SNAPSHOT` 的 `id` 是输入进会话之前的 seq：只收到了 `RUN_STARTED` 就断了的，从它续读拿得回这次 run（`runId` 是轮次 id）。要读 scope。
- 每个请求要 `Authorization: Bearer <令牌>`（401）；`Host` 不是回环名 403；有 `limits`（413、429 带 `Retry-After`）。客户端断开不打断这一轮（会话还有别的端），续读用上面的 GET。没有 `allowRemote`：远处的界面经宿主自己的代理（TLS、认证）。
- 状态：`{ url, clients }`；feature `ag-ui`（只在监听时）。

**对严格校验的宿主可见的协议变化**（2026-11-25）：客户端帧多了 `module.connect`（旧守护进程答 `invalid_frame`）；`external` 回调的 `args` 多了可选的 `endpoint`；`features` 可能多 `acp.server`、`ag-ui`；`input.cancelled` 的 `reason` 可能是 `withdrawn`；输入的 `origin.adapter` 可能是 `acp-server` 或 `ag-ui`；会话列表里可能出现 `acp-server:<名>:<id>`、`ag-ui:<名>:<id>` 这样的会话。

### 4.12 后端与后端钥匙（feature `backends`；INVARIANTS PB-1 到 PB-3、PB-6）

守护进程可以同时接几个**后端**：各自凭自己的钥匙连接，只收到路由给它的输入，只能往它收到过输入的会话和管理员为它登记的目的地发。方案见 `docs/design/persona-backend/`。没有配置 `backends` 时这一节的东西都不存在，行为与之前相同。

**配置**（配置文件的 `backends` 段；改这一段要重启）：

```jsonc
"backends": {
  "alpha": { "note": "我的助手", "routes": [{ "channel": "lark-bot", "account": "default", "conversationId": "oc_family" }] },
  "beta":  { "note": "另一个", "history": true }
},
"bindings": [
  { "id": "family-to-beta", "match": { "channel": "lark-bot", "conversation": "oc_family" }, "on": "host", "to": "beta", "tag": "chat" },
  { "id": "beta-clicks",    "match": { "actionPrefix": "beta:" }, "on": "host", "to": "beta" }
]
```

- id：小写字母、数字、`.`、`_`、`-`，以字母或数字开头，至多 64 个字符。它就是身份（见下面“id 就是身份”）。
- `routes`：管理员为这个后端登记的目的地（`channel`、`account`、`conversationId`，逐字段比较；放行该会话的所有话题）。后端不用先收到输入就能往这里发。
- `history`（缺省 `false`）：这个后端能不能用 `history.read`。
- `note`：给人看的说明。别的键（包括设计稿里的 `callback`）加载时报未知键。

**钥匙**。钥匙由守护进程生成（`aiob_` 开头），只在签发或轮换的应答里出现一次；守护进程只存它的 SHA-256，日志里只写 key id（摘要的前 12 位）。用宿主 token：

| 命令 | 控制台 | 作用 |
|---|---|---|
| `aio backend list` | `GET /api/backends` | 每个后端：是否还在配置里、钥匙 id 与签发时间、连接数、是否有推送连接、游标与积压、登记与获得的会话许可数 |
| `aio backend key <id>` | `POST /api/backends/:id/key`，体 `{ "op": "issue" }` | 第一把钥匙；已有答 `key_exists`（409） |
| `aio backend rotate <id>` | 同上，`{ "op": "rotate" }` | 换一把：旧的立即作废，凭它在线的连接被关 |
| `aio backend revoke <id>` | 同上，`{ "op": "revoke" }` | 作废：这个后端没有钥匙能用，在线的连接被关 |
| `aio backend forget <id>` | `POST /api/backends/:id/forget` | 清掉它的队列条目、游标、发送许可、媒体许可与暂存的上传（§4.13），关它的连接；不动钥匙 |

`aio backend key` / `rotate` 把钥匙单独一行打到 stdout，说明打到 stderr。没有配置的 id 答 `unknown_backend`（404，命令行退出码 2）。没有并存窗口：轮换之后、新钥匙部署到后端之前，这个后端不在线，条目留在队列里等它。从配置里删掉一个后端要重启才生效（下次启动删掉它的钥匙），要立即切断用 `revoke`。

**连接**。后端与宿主说同一套协议，`host.hello` 的 `token` 填钥匙。钥匙决定身份：连接的名字是 `backend:<id>`，帧里自报的 `name` 不起作用；`consumer` 可以不写（只拉取），写了必须是 `<id>` 或 `backend:<id>`，表示推送消费；`callouts`、`optIn` 一律不给。应答：

```jsonc
{ "name": "backend:beta", "protocol": 1, "host": false, "backend": { "id": "beta" },
  "bindings": { "version": null, "active": false },
  "inbound": { "consumer": "backend:beta", "acked": 12, "head": 15 },   // 写了 consumer 才有；head 是它自己条目的最大游标
  "features": ["backends", "deliver.update", "message.ack", "host.takeover", "binding.tag", "blobs", "history"],   // history 只在配置放开时有
  "callouts": [], "optIn": [] }                                          // 帧里写了才回，总是空的
```

几个后端可以同时在线，与凭宿主 token 的宿主互不影响：后端不占宿主位，不改变宿主表是否生效，每个后端至多一条推送连接（第二条答 `host_connected`，`takeover: true` 只顶替它自己的旧连接）。

**能用的帧**（白名单，缺省拒绝：以后新加的帧不列进来就不给后端）：

| 能 | 限制 |
|---|---|
| `host.hello` | 见上 |
| `inbound.read` / `inbound.ack` | 只限自己的游标（别的消费者名答 `forbidden`）；`head` 与 ack 的上限是自己条目的最大游标 |
| `deliver` | 会话在许可内；`route.replyToMessageId` 有值时是它收到过的或自己发的、同一会话的消息；附件至多 32 个（否则 `too_many_attachments`），每个 `ref` 是它被给过的或自己上传的（§4.13，否则 `unknown_blob`） |
| `deliver.update` | 同上，且 `providerMessageId` 是它自己 `deliver` 的、同一会话的消息 |
| `message.ack` | 会话在许可内，`messageId` 是它收到过的或自己发的、同一会话的消息 |
| `blob.stat` / `blob.get` | 只限路由给它的条目里的媒体，和它自己上传、还没过期的引用；别的引用答得和不存在的一样（§4.13） |
| `blob.put` | 进它自己的暂存区，有配额，24 小时过期（§4.13） |
| `history.read` | 只在 `backends.<id>.history: true` 时；只限 `to` 是自己的条目（别的游标答 `unknown_cursor`） |

其余的宿主帧（`bindings.put` / `bindings.get`、`explain`、`run.*`、`session.*`、`schedule.*`、`inbound.redispatch`、`conversation.create`、`input.verify`、`test.*`、`host.outboundScope`、`backends.*`）和全部客户端帧（`input`、`subscribe`、`sessions`、监听、话题、`tui.attach`）答 `forbidden`。钥匙被轮换或作废后，连接被关；万一还开着，下一帧答 `unauthorized`。

**队列视图**。后端的游标是消费者 `backend:<id>`，只走 `to` 是它的条目（§2.1）。管理员用宿主 token 看和清某个后端的积压：`aio tail --consumer backend:<id>`、`aio ack --consumer backend:<id> <cursor>`，补投（`inbound.redispatch`）也只有宿主 token 能做。id 打错时（`backend:` 开头、又不是哪个后端的游标）这两个命令和 `host.hello` 的 `consumer` 都答 `unknown_backend`，不会把它登记成一个读宿主自己积压的消费者；从配置里删掉、但还留着条目的后端照旧能读（`aio backend list` 列得出）。`history.read` 放开后读到的是那个会话更早的全部消息（通道给得出的），包括路由给别的后端或本地 agent 的：隔离的是队列条目，不是会话历史。同一个群分给两个后端时想清楚再开。

**发送范围**。后端的 `deliver` 只能发往 (a) 路由给过它的输入的回复路由所在的会话（按 `channel`、`account`、`conversationId`，任何话题；入队时记下，跨重启，不过期），(b) `backends.<id>.routes` 登记的目的地。回复目标（`replyToMessageId`）、被标记的消息（`message.ack` 的 `messageId`）必须是它收到过的输入的消息（记 30 天）或它自己发的消息，且在同一个会话；被改的消息（`deliver.update`）必须是它自己发的。不满足一律答 `route_not_allowed`，文字是固定的一句，通道或账号解析不到也答这个（不列出有哪些通道）；这次请求不发、不占用 operationId。回复一条 30 天前收到的消息会被拒，去掉 `replyToMessageId` 可以照发到那个会话。operationId 按后端分开（内部是 `backend:<id>:<operationId>`，与宿主的互不重叠），两个后端用同一个 id 互不影响；`aio explain backend:<id>:<operationId>` 查得到，结果带 `backend`。宿主的 `outbound` 回调与出口检查（§4.1、§4.1a）不看后端的发送，与宿主自己的 `deliver` 一样：靠出口检查把关所有外发的部署，加了后端以后要知道这条路不经过它。只检查会话和消息 id，不检查 `threadId`。附件另有检查（§4.13）：每个引用必须是路由给它的条目里的媒体或它自己上传的，否则答 `unknown_blob`；`channelData`（通道原生内容）不检查。

**卡片点击**。点击跟着发卡片的后端走：被点的消息是后端 X `deliver` 的，这次点击只可能由 `to: X` 的规则接、进 X 的队列（仍要有这样一条规则命中，通常按 `actionPrefix`），不按内核的审批、停止、提问按钮解析，也不交给模块；带 `to` 的规则只接它那个后端发的消息上的点击，所以别人（宿主、本地 agent）发的卡片上的点击到不了后端。条目的 `input.origin` 是点击者的盖章身份（§3），谁有资格点由后端自己核对。归属靠通道报回发出的消息 id 和点击事件里的 `messageId`；通道不给时点击归不了属，进不了任何后端的队列，按普通输入走不带 `to` 的规则。点击不授予会话许可（只记下点击和被点的消息，供回复用）：后端能回这次点击，是因为它本来就能往那个会话发；许可被收回以后（`aio backend forget`、登记的目的地被删），旧卡片上的点击照样进它的队列，但不把许可写回来。

**id 就是身份**。状态都记在 id 下：后端从配置里删掉再加回来（要重新签发钥匙），它的积压、游标、会话许可、operationId 的结果、消息的归属都延续。指向它的规则要一起删掉或改指，否则配置加载失败；宿主推送并持久化的表里有这样的规则时，启动时整张宿主表被忽略，直到宿主推一张不含它的表。`aio backend forget <id>` 清掉条目、游标与许可，连同媒体许可和暂存的上传（会话许可不过期，规则改道以后原来的后端仍能往那个会话发，直到 forget；没有按会话撤销的办法；forget 之后只有规则再路由给它一条输入才重新授予）；它不清 operationId 的结果和消息归属，所以同一个 id 交给另一方用，会继承旧的 operationId 结果、旧消息的编辑权和旧卡片的点击。换人就换 id。

**经 `/ws` 接入**。本地 unix socket 不是后端的隔离边界：能打开它的进程在 `hello` 之前就是主人。后端走控制台端口的 `/ws`：升级请求带 `Authorization: Bearer <钥匙>`（浏览器式的客户端不能设头：子协议列表里放 `agents-io.v1` 和 `agents-io.bearer.<钥匙>`），连上后发 `host.hello { token: <同一把钥匙>, name, consumer? }`。凭钥匙升级的连接在 `hello` 前后都不收客户端帧，`hello` 只认同一个后端的钥匙（宿主 token 或别的后端的钥匙答 `unauthorized`），钥匙被轮换、作废或后端被 forget 时连还没 `hello` 的连接一起关。钥匙只能开 `/ws`：控制台的 `/api/*` 对它一律答 403，换不到登录链接。远程后端要求控制台听非回环地址（`console.allowRemote`，通配地址还要 `console.allowedHosts`），同一个端口上也有管理 API；控制台只说 http，钥匙以明文 bearer 过网，前面要有 TLS 终结或只在可信网络里。

**这一轮没有的**：回调推送（守护进程主动把条目推到后端的地址）、轮换的并存窗口、后端用 `schedule.*` / `run.start` / `conversation.create` / `explain`、后端之间转信、不重启就增删后端、按会话撤销许可、按 HTTP 传很大的文件（媒体走 §4.13 的帧，一个 blob 至多 `blobs.maxBytes`）。

### 4.13 blob：取条目里的媒体，上传附件（feature `blobs`；INVARIANTS PB-6）

条目里的图片、文件、语音是内容块 `{ type: "image" | "file" | "audio", ref, mime, name? }`，`ref` 指向守护进程 blob 库里的字节（`sha256:<hex>`，字节的 SHA-256）；`deliver` 的附件是 `message.attachments[] { ref, mime, name? }`。这三个帧让不在同一台机器上的宿主或后端拿到字节、交上字节。本地 socket 与 `/ws` 上相同。

| 帧 | 请求 | 应答 |
|---|---|---|
| `blob.stat` | `{ ref }` | `{ size }`；读不到（没有，或不是你能读的）答 `null` |
| `blob.get` | `{ ref, offset?, length? }` | `{ base64, size, offset }`：`size` 是整个 blob 的字节数，`base64` 是从 `offset` 起的这一段 |
| `blob.put` | `{ base64, part?: { upload, offset, last? }, mime?, name? }` | 传完答 `{ ref, size }`；分片时不是最后一片答 `{ upload, received }` |

**每帧至多 1 MiB**（`BLOB_FRAME_MAX_BYTES`，base64 之前的字节数）。为什么是帧、不是 HTTP 端点，为什么不是一帧一个 blob：本地 socket 上没有 HTTP，帧无论如何要有；后端钥匙在控制台的 `/api/*` 上一律 403 是已有的承诺（PB-1、PB-3），不为媒体开口子；`/ws` 上一帧十几 MiB 会把心跳的 pong 堵在后面（缺省 30 秒一次 ping、10 秒没有回应就断），连接在传输中被掐掉，还占住推送条目的那条连接。分成小帧之后只多 base64 的三分之一。

- **读**。不带 `offset` / `length`：整个 blob 不超过 1 MiB 就整份给；更大答 `too_large`（不会悄悄只给前一段）。带了任一个就是按范围读：`offset` 缺省 0；`length` 至多 1 MiB（写得更大答 `invalid_frame`），不写就是到末尾、但一次至多给 1 MiB（看应答里 `base64` 的实际长度往前走）；`offset` 等于大小答空串，超过大小答 `bad_offset`。范围读不逐片校验：**读的一方自己核对整份字节的 SHA-256 等于 `ref`**。链路慢就把 `length` 取小：一帧要在心跳超时之内传完。`blob.get` 的应答按连接一个一个出，上一个写出去之后才读下一片（本地 socket 与 `/ws` 都是；你不读的时候守护进程为这条连接至多拿着一个应答），所以一口气发很多请求不会更快。
- **写**。不带 `part`：一帧一个 blob。带 `part`：`upload` 是调用方起的 id（1 到 64 个字符），`offset` 必须等于已经收到的字节数，否则答 `bad_offset`，文字是 `expected offset <n>`，已收的保留、可以从那里续传；`offset: 0` 开始或重新开始这个 `upload`；`last: true` 收尾。没传完的上传在内存里：守护进程重启、5 分钟没有新分片、钥匙轮换或作废之后，续传答 `bad_offset`（`expected offset 0`），从头再传。同时至多 2 个没传完的上传（第三个答 `busy`）。分片大小随你（最后一片之外不能为空）；守护进程把小分片并成 64 KiB 的块存，占的内存只随字节数走。
- **应答里没有 mime 与名字**：库里记的是这份字节第一次进来时的，可能是别的会话的文件名。条目的内容块、你自己的上传已经告诉你了。

**凭宿主 token**：`blob.stat` / `blob.get` 读共用 blob 库里的任何引用；`blob.put` 直接存进共用库（`mime` 缺省 `application/octet-stream`，决定存储的扩展名；同样的字节已经在库里时保留原来的 mime 与名字），没有配额、不过期。它的 `deliver` 不变：附件引用不检查。

**凭后端钥匙**（PB-6）：

- **读得到的只有两类引用**：(a) 路由给过它的条目（`to` 是它）里 `image` / `file` / `audio` 块的 `ref`，入队时记下，记 30 天，跨重启，`aio backend forget` 收回；(b) 它自己上传、还没过期的。别的一律答得和不存在的一样（`blob.stat` 答 `null`，`blob.get` 答 `not_found`、同一句话）：别的后端的条目或上传里的、只进了某个会话的、文字或 `quote` 或事件数据里提到的、凭内容哈希算出来的。`history.read` 放开后看得到更早消息的引用，但读不到字节；同一份字节后来出现在路由给它的条目里才读得到。条目里不是 `sha256:` 形式的平台引用（通道没有下载的）没有字节可读。30 天之后才打开的旧条目取不到媒体：要留就在收到时取。
- **上传进它自己的暂存区**（`<blobs.dir>/uploads/<后端>/`），不进共用库：引用是内容哈希，进了共用库别的后端就能凭哈希读到、或试出库里有没有某份字节。别的后端拿同一个引用读不到也发不出，除非它自己也上传了同样的字节。`mime` / `name` 不记，发的时候写在附件上。
- **上限**：一个 blob 至多 `blobs.maxBytes`（缺省 20 MiB；超过答 `too_large`，这个上传整个丢掉）；一个后端暂存的合计至多它的 8 倍、至多 256 个（超过答 `quota_exceeded`，什么都不留；同样的字节再传一次只算一份，并重新计 24 小时）；**上传 24 小时后文件被删、引用失效**，要发就在这之前发。
- **附件**：`deliver` / `deliver.update` 的 `message.attachments` 里每个 `ref` 必须是 (a) 或 (b)（条目里的平台引用也算 (a)，原样交给通道），否则整条答 `unknown_blob`，文字是固定的一句，与引用根本不存在时一字不差；不发、不占用 operationId。先过发送范围的检查（`route_not_allowed`），再查附件。**一条消息至多 32 个附件**，更多的整条答 `too_many_attachments`（宿主 token 的 `deliver` 没有这个上限）。通过的上传在发送前复制进共用库（通道从那里读，发出去的附件与别的外发附件一样留着，不随 24 小时删）；同一个上传只复制一次，一个后端一次复制一个，所以同时发很多条带同一个大附件的消息，后面的在排队、不重读文件。发不成的不复制：被拒的消息，以及通道不能编辑时的 `deliver.update`（答 `unsupported`，先于附件检查）。**附件总是写上 `name`**：没写的按 `file` 发，不回退到库里记的名字。你写的 `mime` 与 `name` 随这条消息交给通道；它们在共用库里只是临时的记法，同一份字节之后由通道收到或宿主存入时换成那一方的。已经结算的 operationId 重发照旧答 `duplicate: true`，不重新检查。`channelData`（通道原生内容）里的平台资源键不在这项检查之内。

错误码：`not_found`（读不到）、`too_large`（一帧超过 1 MiB、不带范围读一个大于 1 MiB 的 blob、blob 超过 `blobs.maxBytes`）、`bad_offset`、`busy`、`quota_exceeded`、`invalid_frame`（base64 不合法、内容为空、`length` 超过 1 MiB、`upload` 超过 64 个字符）、`blob_error`（读写失败，或暂存的字节与引用对不上）、`unknown_blob`（附件）、`too_many_attachments`（附件多于 32 个）、`unsupported`（嵌入方没有 blob 库；这时 `features` 里也没有 `blobs`）。

`@agents-io/daemon` 的 `LocalClient` 有现成的循环：`readBlob(ref, { chunk? })`（按范围读完并核对哈希）、`writeBlob(bytes, { mime?, name?, chunk? })`（一帧或分片）。

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
| `aio backend list` / `key <id>` / `rotate <id>` / `revoke <id>` / `forget <id>` | `backends.list` / `backends.key`（`issue`、`rotate`、`revoke`）/ `backends.forget`（§4.12）。钥匙单独一行打到 stdout，只出现这一次 |
| `aio replay --input <inputId> [--times N]` | `test.replay`（测试入口，§4.3；只在 `AIO_TEST_HOOKS=1` 时可用） |
| `aio fault [list] \| drop-response --channel <id> [--account <a>] [--conversation <c>] --next <N> \| clear` | `test.fault`（同上） |
| `aio acp --client <名> [--token-file <路径>] [--session <键>]` | 不是宿主命令：编辑器或 t3code 起它当 ACP agent（§4.11），以 `acpServer` 的一个客户端的身份经 `module.connect` 连 socket |

管理员看、清某个后端的积压：`aio tail --consumer backend:<id>`、`aio ack --consumer backend:<id> <cursor>`（用宿主 token；§4.12）。

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

- 宿主重连后对运行中 run 的恢复。多个接入方已由后端（§4.12）覆盖：各自的钥匙、队列视图与发送范围；仍只有一个凭宿主 token 的宿主（回调只问它），后端的回调推送、后端之间转信未做。
- 版本协商：已改为按能力名协商（`host.hello` 结果的 `features`，§4）；`PROTOCOL_VERSION` 只在不兼容的改动时变。
