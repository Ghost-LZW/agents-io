# 外部持有的会话：原生 TUI 与宿主自己拉起的 agent 接入 agents-io

> 状态：已采纳并实现 S1、S2（2026-10-13，决定 15：§9 四项按推荐；INVARIANTS LN-8、LN-9）。§5、§6 已按两次实测修订（§10）。S3 的状态机按实现简化：持有者 = lane 背后的 harness 适配器（Codex 终端是同一 thread 的另一个客户端，lane 不变；Claude 终端持有期间 lane 的该实例就是终端，退出即回到无头）；S4（宿主拉起）未做。
> 依据：`docs/POSITIONING.md` §3（"只要观察"用法）；`docs/design/locus/DECISIONS.md` 总体方向（"agents-io 是唯一拉起 harness 的地方"）、决定 12；`docs/ROADMAP.md` §0、原则 1、2；`docs/research/claude-code.md` §3、§5、§6；`docs/design/thin-bridge.md` §5（`codex --remote`）。

## 1. 一句话

**harness 进程可以不是 agents-io 拉起的。** 人在电脑前用原生 `claude` / `codex` TUI，或者宿主（如 x-work-os）用自己的调度拉起 agent，agents-io 挂到这个会话上，只做 IO：把各通道的消息和文件送进去，把回复投递出去，记录过程，转发审批。

## 2. 驱动场景

- **A 桌面**：在电脑前用 TUI，这是最习惯的方式。飞书、微信、邮件里别人发的消息和文件直接出现在 TUI 里，不用手动复制；TUI 里的 agent 回复会回到原来的会话；对方看到的是一条像人发的回复（`look: chat`），不是控制台。离开电脑后，再由机器人接着处理。
- **B 宿主调度**：x-work-os 这类调度系统自己决定什么时候、用什么参数拉起 agent。它不想为了 IO 而把启动权交给 agents-io，但需要 agents-io 的通道、身份盖章、投递义务、审批转发和 `aio explain`。

两者的共同点是：**会话的持有者（holder）不是 lane。**

## 3. 与现有决定的关系

- 总体方向写的是"agents-io 是唯一拉起 harness 的地方"。这里修订为：**一个会话同一时刻只有一个持有者，可以是 agents-io 的 lane，也可以是外部挂上来的进程；路由（Binding 表）、身份、投递、审批这些机制对两者完全相同。** Binding 表仍然是确定性的，持有者只决定 `dispatch` 送到哪里。
- POSITIONING §3 的"只要观察"已经包含"宿主用无头方式跑 harness、把事件流 tee 给 agents-io"；本提案补上"同时也能把输入送进去"。
- 不变量"一个 session 同一时刻只有一个写者 lane"扩展为"只有一个持有者"（§7）。
- ROADMAP §5 的"不做 PTY 刮屏"不变：所有进出都走 harness 的官方接口，不用 send-keys。

## 4. 持有者

```ts
type Holder =
  | { kind: 'lane' }                                            // 现在的唯一形态
  | { kind: 'external'; via: 'claude-tui' | 'codex-remote' | 'host'; id: string; since: number; nativeId?: string };
```

- **挂上**：`session.attach { sessionKey, via, nativeId? }`，走本地 socket（TUI 侧）或宿主协议（宿主）。会话正有 lane 在跑一轮时，先等这轮结束（或按 `--interrupt` 打断），再关掉 lane，然后交出。
- **持有期间**：lane 不打开 harness。路由到这个会话的输入按 §5 送给外部持有者，送达后记 `input.consumed`。送不进去时（对方没有可用的注入口）留在队列里，不丢（IN-1）。
- **释放**：`session.detach`，或者持有者消失（MCP 子进程退出、宿主连接断开、心跳超时）。之后按 `whenAway` 处理：
  - `queue`：输入排着，等下次挂上时一并送进去；
  - `lane`（默认）：lane 用持有者留下的 `nativeId` 续接（claude `--resume`、codex `thread/resume`）。两边是同一段对话，机器人接手时上下文不断。
- 持有者和交接都写进日志（`holder.changed`），`aio explain` 能看出某一轮当时是谁在持有。

## 5. 输入：消息怎么进到外部 harness

输入的格式和 lane 一样：前面一行说明发送者和来源（含 `ref=`），后面是内容块。附件放在 blob 存储，给出**本地路径**（新增 `BlobStore.pathOf(ref)`，只读，0600 文件），agent 直接读，不用人复制。哪些消息会送进来仍由 Binding 表决定（主人私聊、@、指定的人用 `dispatch`；群里其他消息用 `context` / `digest`），所以 TUI 不会被刷屏。

| 持有者 | 注入口 | 运行中 | 空闲时 | 需要核实 |
|---|---|---|---|---|
| Codex TUI | agents-io 作为同一 app-server thread 的另一个客户端（Codex 原生多客户端） | `turn/steer { expectedTurnId }` | `turn/start` | 已实测（§10.1） |
| Claude TUI | cross-session inbox socket，由 TUI 拉起的 agents-io stdio MCP 子进程用继承的 `CLAUDE_CODE_MESSAGING_TOKEN` 写入 | 在工具调用之间读到（同一轮） | 新开一轮 | 已实测（§10.2）；Channels 在本机登录方式下不可用，不用 |
| 宿主拉起 | 宿主自己决定 | — | — | — |

- Codex 侧的大部分机制已经有了：`harness/codex` 会把别的客户端开的轮次映射成 `turn.started{initiator:'foreign'}`（`harness/codex/src/session.ts` `foreignTurn`），过程、审批、结束都正常进日志。缺的是"agents-io 不开 lane、只当一个客户端"的启动方式，以及给人用的入口 `aio tui codex [session]`：确保 app-server 和 thread 存在，然后 exec `codex --remote … resume <threadId>`。
- Claude 侧：`aio tui claude [session]` 包一层，启动交互式 `claude`，带上 agents-io 的 MCP server（stdio，随 TUI 一起退出，所以退出就是可靠的释放信号）和 hooks 配置。注入口优先用 ①（不需要 dev flag）；核实不可行时用 ②。
- 宿主拉起：宿主把会话键、MCP 配置交给它拉起的进程（约定见 §8 S4）。按 x-work-os 的执行器形态（一轮一个无头进程、运行中不推消息），输入不往进程里注入，而是走 `on: "host"` 进宿主入站队列，由宿主决定下一轮怎么带上这些输入。agents-io 不替宿主决定。

## 6. 输出与过程

- **回复**：外部 harness 里的 agent 调 host-mcp 现有的 `reply_to` / `send_message` / `send_file`。这些调用照常经过 outbox（幂等、`delivery.settled`）、`Policy.outbound`、身份随附（`as`），`aio explain` 能从发出的消息追溯到触发它的输入。默认目的地是最近一条渠道输入的回复路由，和 lane 里"回到来源"一致。
- **过程（给飞书上的对方看的卡片 / CoT）**：
  - Codex：agents-io 本来就是 thread 上的客户端，事件流完整，渲染方式和 lane 一样。人在 TUI 里自己敲的轮次没有回复路由，所以不会出现在任何渠道上，只留在日志里。
  - Claude：交互式 TUI 不对外给事件流。v1 用 http hooks（`UserPromptSubmit`、`PreToolUse`、`PostToolUse`、`Stop`，发给守护进程的本机端口）得到工具时间线和轮次边界；`Stop` 带 `last_assistant_message`，就是这一轮的回答。可选 v2：读 transcript JSONL（hooks 输入里带 `transcript_path`）补上 thinking 和文字。日志里用 `session.bound{ fidelity: 'hooks' | 'transcript' | 'native' }` 记下这一路过程的完整程度，投影据此知道自己缺了什么（ROADMAP 原则 1）。
  - 配合 `look: chat` 和 `cotOn: tool`，对方通常只看到回答；有工具调用时，才出现一个折叠的 CoT。
- **审批**：
  - Codex：app-server 把请求广播给所有客户端，TUI 和飞书按钮都能答，先到的生效（`serverRequest/resolved`）。这和现有的 RQ-1 一致。
  - Claude：`PermissionRequest` hook（http）挂住不答，守护进程开一个 `request.opened`，飞书按钮或 TUI 对话框先答者生效：TUI 先答时 hook 的迟到答复被忽略（已实测）。不需要 Channels。

## 7. 不变量增补（草案）

- **HD-1** 一个会话同一时刻只有一个持有者；外部持有期间，lane 不打开 harness。
- **HD-2** 持有者消失后，路由到这个会话的输入不丢：要么排队，要么按 `whenAway` 交给 lane，都会写 `input.consumed` 或 `input.rejected`。
- **HD-3** 外部持有者发出的每条渠道消息都经过 outbox 和 `Policy.outbound`，可以 `aio explain`。
- **HD-4** 交接时 lane 续接的是持有者留下的原生会话 id，不会另起一个对话。

## 8. 分步

| 步 | 内容 | 依赖与核实 |
|---|---|---|
| S1 | Codex 桌面模式：`aio tui codex`、持有者只当客户端、渠道输入用 steer/start、foreign 轮次的渲染、审批先到为准 | 实测 `codex --remote` 挂同一 thread |
| S2 | Claude 桌面模式：`aio tui claude`、stdio MCP server（现有输出工具 + 注入）、hooks 观察、`BlobStore.pathOf` | 实测 inbox socket 帧格式；Channels 现状 |
| S3 | 持有者状态机、`whenAway`、`holder.changed`、HD-1..4 的测试；`aio explain` 显示持有者 | S1 或 S2 任一 |
| S4 | 宿主拉起：宿主协议 `session.attach{via:'host'}`、拉起约定（环境变量 `AGENTS_IO_SESSION`、MCP 配置怎么拿）、HOSTS.md 修订 | S3 |

微信不在本提案范围：它要先有通道（`jsonl-bridge` 或模块通道）。

## 9. 待拍板

1. **总体方向的修订**（§3）：允许外部持有者。推荐采纳。
2. **`whenAway` 默认值**：推荐 `lane`（离开电脑后由机器人接着处理，上下文连续）；`queue` 适合"我不在时谁也别动这个对话"。
3. **"离开"怎么判定**：推荐只看 TUI 进程是否退出（可靠、可解释）。按空闲时长判定先不做：TUI 开着但人走开时，Claude 的会话只能有一个写者，lane 没法接手。
4. **S1 和 S2 的先后**：推荐先做 S1（Codex 原生多客户端，代码里大部分已经有了），再做 S2。

## 10. 实测记录（2026-10-13）

### 10.1 Codex（codex-cli 0.160.1）

- `codex app-server --listen unix:///abs.sock`；TUI：`codex -c check_for_update_on_startup=false --remote unix:///abs.sock resume <threadId>`（不关更新检查时，更新对话框会挡住挂接）。unix socket 没有 token，只靠文件权限（`harness/codex/src/unix.ts` `assertPrivateSocket`）。
- **空 thread 不能 resume**：`thread/start` 之后 rollout 文件并未写出，`thread/resume` 与 TUI 都报 `no rollout found`。`thread/inject_items`（一条 developer 消息，不调模型）写出 rollout，之后 TUI 能挂上。最后一个订阅者断开约 60 秒后 thread 卸载，没有 rollout 的 thread 就丢了。所以 agents-io 在交出前要先 inject，并在持有期间一直订阅。
- 双向可见：agents-io 的 `turn/start` 在 TUI 里显示为用户输入加回答；TUI 里敲的轮次以 `turn/started`、`item/*`、`turn/completed` 到 agents-io，`clientId` 不是我们的，走 `foreignTurn`。`turn/steer` 在 TUI 的轮次里生效（工具调用后插入），必须带 `expectedTurnId`。
- 未核实：审批在两个客户端之间先到为准（只有假服务器测试）；TUI 自己的 `thread/resume` 是否用它的配置覆盖 thread 的审批、沙箱、模型设置（决定 11 的档位依赖它）。

### 10.2 Claude Code（2.1.296）

- **inbox socket**：交互模式与 `-p` 默认都有（`--bare` 除外），路径默认 `/tmp/cc-socks/<pid>.sock`；隐藏参数 `--messaging-socket-path <abs>` 可固定（目录须 0700）。帧：每行一个 JSON，`{"type":"auth","token":…}`（可选）后接 `{"type":"user","message":{"role":"user","content":"…"},"from":"agents-io","session_id":"<uuid>"}`；`session_id` 不符则丢弃。**没有回执**。
- **谁能送进去**：TUI 的子进程（我们的 stdio MCP server，继承 `CLAUDE_CODE_MESSAGING_SOCKET` / `_TOKEN`）带 token 写入，任何权限模式都直接送达，transcript 记 `origin.kind: "peer"`。外部进程不带 token 时，bypass 模式下会被挂起等 TUI 里确认。
- **模型看到的**：`Another Claude session sent a message:` 加正文，再加一段提示（不是用户本人、不能批准、不能改配置）；`from` 不显示；斜杠命令不执行。所以注入的文字要自带来源行（与 lane 相同的前言）。
- **hooks**：33 种事件；`type: "http"` 可用（`SessionStart` 只能用 command / mcp_tool）。所有输入带 `session_id`、`transcript_path`、`cwd`、`prompt_id`、`permission_mode`。`Stop` 带 `last_assistant_message`。`UserPromptSubmit` 对注入的消息也触发（无来源字段，按正文里的 `ref=` 对上，作为送达回执）。`PermissionRequest` 可挂住答复，与终端对话框先到为准；中断后 `Stop` 不触发。
- **只对这一次启动生效**：`--settings <file>`（hooks 与用户自己的合并）加 `--mcp-config <file> --strict-mcp-config`，不改用户设置。`--session-id <uuid>` 预先指定会话 id，之后 `--resume <uuid>` 可用。
- Channels：仍是 research preview，自研 server 要 `--dangerously-load-development-channels`；本机（经 `ANTHROPIC_BASE_URL` 登录）提示 "Channels are not currently available"。不用。
