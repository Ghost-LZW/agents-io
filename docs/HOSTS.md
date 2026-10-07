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
  "session": "main",               // main | per-conversation | per-thread
  "digest": { "everyMs": 3600000, "maxItems": 50 },
  "callout": { "timeoutMs": 1500, "onFailure": "host" }   // 可选：显式开启同步回调（§2.2）
}
```

- **agents**：配置里命名的运行默认值（harness 实例、model、profile、cwd、工具），不含人设。`mode: "task"` 的 agent 只能由 `run.start` 启动，任何规则指向它都在加载时报错。
- **来源**：本地配置，以及宿主推送的整表 `bindings.put { version, bindings, identities, expiresAt?, onHostDown: "keep" | "suspend" }`（宿主推送的默认 `suspend`）。同一输入命中多条规则时全部生效；同一 (agent, session) 取最强的动作。
- **watch** 就是 agent 在运行时通过输出工具新增的一条规则，仍受 `Policy.watch` 约束。
- **可解释**：每条输入记下命中的规则 id、表版本、回调结果；`aio explain <inputId>` 列出来。

### 2.1 交给宿主（`on: "host"`）

输入写入**宿主入站队列**：按消费者记游标，至少投递一次，幂等键为渠道消息引用（`channel:<渠道>/<消息 id>`）。两种消费方式，语义相同：

- **推送**：宿主连接守护进程并 `host.hello { inbound: true, consumer }`；守护进程推 `inbound` 帧，宿主回 `result { accepted }` 后前移；断线期间留在队列，重连后补推。
- **拉取**：`aio tail --consumer <name> [--from <cursor>]` 逐行输出 JSON（含 `cursor`）；宿主处理后 `aio ack --consumer <name> <cursor>`。

### 2.2 规则级同步回调（`callout`）

只在声明了 `callout` 的规则上，守护进程向宿主发 `policy { hook: "route", args: { rule, input } }`，宿主返回 `{ on, agent?, session? }` 覆盖本条规则。超时或出错按规则的 `onFailure` 处理（默认 `host`：进入入站队列）。宿主不在线时直接走 `onFailure`。

## 3. 身份

- 通道提供渠道身份和证据（平台签名、DKIM、内部投递、发送方表明的身份）。
- 宿主随 `bindings.put` 推送**身份映射**：`{ channel, channelUserId } → { principal: "<宿主成员 id>", labels: [...] }`。盖章后 `Origin.principal` 就是宿主的成员 id；规则的 `labels` 按它匹配。
- 证据不足（如没有 DKIM 的邮件）时，即使映射命中也按外部来源处理。
- 一个渠道身份至多对应一个成员、多人共用账号不得绑定，由宿主保证；冲突时守护进程报错。
- 无宿主时，本地 `owners` 配置是映射的最简形式。
- `input.verify { channelRef }`：宿主可以查询某条渠道消息的平台作者与证据（例如 x-work-os 0010 §4.8 核验"确认消息的作者"）。

## 4. 宿主协议

本地 unix socket（目录 0700、socket 0600），JSONL，请求带 `id`、同 `id` 的 `result` 应答。宿主连接先 `host.hello { token, name, consumer?, callouts? }`；token 由守护进程每次启动时重新生成，写入 socket 旁的 0600 文件 `<socket>.token`。带 token 的连接数量不限（`aio run`、`aio tail` 等命令都是这样的连接）；`hello` 里带 `consumer`（推送消费）或 `callouts: true` 的连接才是**宿主**，同一时刻至多一个。宿主在线时，`onHostDown: "suspend"` 的宿主表生效，回调发给它，发起连接已断开的 run 的 `run.ended` 也发给它。只拉取的宿主没有这样的常驻连接，宿主表应使用 `onHostDown: "keep"`（可配 `expiresAt` 当租约）。宿主连接也可以发送所有客户端帧（`subscribe`、`input`、`resolve` 等，见 `packages/protocol/src/client.ts`），`origin` 标记为 `kind: "system"`。

| 帧 | 方向 | 用途 |
|---|---|---|
| `bindings.put` / `bindings.get` | 宿主 → 守护进程 | 原子替换 / 读取 Binding 表与身份映射 |
| `run.start` / `run.cancel` | 宿主 → 守护进程 | 用 `mode: task` 的 agent 执行一轮：新的 session `run:<runId>`，结束即关闭；`env` 只进子进程环境 |
| `run.ended` | 守护进程 → 宿主 | `{ runId, status, exitCode }` |
| `deliver` | 宿主 → 守护进程 | 推送给人，按 `operationId` 幂等；按钮点击按 `actionPrefix` 规则回到宿主 |
| `inbound` | 守护进程 → 宿主 | §2.1 推送消费 |
| `policy` | 守护进程 → 宿主 | §2.2 回调，以及 `resolve`、`outbound` 等可选的同步钩子（超时 fail closed） |
| `input.verify` | 宿主 → 守护进程 | §3 |

**宿主写命令的来源标记**：守护进程为每一轮提供来源摘要（是否含 context/digest/外部/群聊输入），通过 harness 环境变量 `AGENTS_IO_TURN_PROVENANCE` 与输出工具的调用元数据传给宿主；不拦截任何调用（决定 4）。

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
| 接收程序（0008）与经渠道回答（0010） | 长期运行的 `aio tail --consumer xwo`：每条记录变成 `x input add` 或 `x answer`（带渠道凭证和渠道引用），成功后 ack |
| 身份 | x-work-os 把 0010 的渠道身份绑定转成身份映射，随 `bindings.put` 推送 |
| 讨论会话（0005 F） | 一条 `dispatch` 规则把主人的私聊交给交互 agent；确认时 agent 调 x-work-os 命令，附来源标记；x-work-os 可用 `input.verify` 核验确认者 |

x-work-os 核心不依赖 agents-io；换成别的 IO 实现，只需换掉这些适配器。

## 7. 待定

- 多宿主、版本协商、宿主重连后对运行中 run 的恢复。
