# 端到端测试：dev gateway

> `examples/dev-gateway`（`aio-dev`）把所有包接进一个进程，用来在本机跑通完整链路。它是示例，不是产品：配置简单、出站 outbox 只在内存、没有 Web 端。

```
channels(lark-bot / mail / bridge…) ─▶ Ingress ─▶ Lane(每 session 一条, harness 懒打开) ─▶ Hub(SQLite log)
                                                                          │
     Compositor + Outbox(每 session × channel，回到来源路由：lark=card，mail=final) ◀─┤
     本地 Unix socket（JSONL 客户端帧）：attach / send / e2e ◀──────────────────────┘
```

## 0. 准备

```sh
pnpm install && pnpm build
cp examples/dev-gateway/aio.config.example.json examples/dev-gateway/aio.config.json   # 已 gitignore
alias aio-dev="node $PWD/examples/dev-gateway/dist/cli.js"
```

- 配置文件：`--config <path>`、`$AIO_CONFIG` 或当前目录的 `aio.config.json`（不存在就全用默认值：claude-code + haiku、无通道）。相对路径按配置文件所在目录解析。
- 密钥只放环境变量或 `.env.live`（KEY=VALUE，已 gitignore）。查找顺序：`--env-file`、配置文件同目录、从当前目录向上最近的一个。进程环境变量优先于文件。通道配置里的字符串 `"env:NAME"` 会替换成该变量。
- 只有 `ANTHROPIC_* / CLAUDE_* / OPENAI_* / CODEX_* / *_PROXY` 这些键会传给 harness CLI，Lark、邮件密钥留在网关进程里。工具从不打印变量的值。
- 模型：`harness.<kind>.run.model`，环境变量 `AGENTS_IO_LIVE_CLAUDE_MODEL` / `AGENTS_IO_LIVE_CODEX_MODEL` 优先；默认 claude 用 `haiku`，codex 用它自己的默认模型。
- 主人：`policy.owners` 加上 `AGENTS_IO_OWNERS`（逗号分隔），键是 `<channel>:<channelUserId>`。
- 本地端（attach/send）以 `local.principal` 的身份说话，默认是第一个主人（没有主人时是 `local:owner`），labels 默认 `['owner']`。默认 session 是 `policy.ownerSessionKey`，否则 `local:main`。

## Tier 1：本地（不需要任何外部账号）

### 1.1 自动场景

```sh
pnpm e2e                                   # 根目录：build 后跑 claude-code
pnpm e2e --harness codex
aio-dev e2e --only a,d --verbose           # 只跑某几个；--verbose 打印过程
```

每个场景起一个独立的进程内网关（临时目录、SQLite log、本地 socket），一个脚本化通道 `e2e`（主人 `e2e:alice`、`e2e:bob`），对**真实** harness 发便宜且确定的提示，在订阅流上断言，逐个打印 `PASS/FAIL/SKIP` 和原因：

| id | 场景 | 断言 |
|---|---|---|
| a | one-input | 通道输入 → turn completed；harness 原始流过 `checkEventStream`；log seq 1..N 无空洞，订阅端拿到 tier 允许的全部 durable 事件；通道卡片 finalize 且含答案 |
| b | batch-same-principal | 同一主体在一轮运行时快速发 3 条 → 排队后合成**一个** turn，三条都被 harness 报告 consumed（lane 只合并排队中的连续同主体同路由输入，空闲时第一条立即开轮） |
| c | principals-not-merged | alice、bob、alice 在同一群 → 三个 turn，每个 turn 只含一个主体 |
| d | steer | 长工具调用中 `/steer` → 折进当前 turn 并在该 turn consumed；caps 不允许时降级为 queue 且有 `steer degraded` notice |
| e | interrupt | 长 `sleep` 中 interrupt → turn `interrupted` |
| f | human-approval | 策略改为 restricted + `human` resolver → `request.opened` 到达第二个（final tier）订阅者，经它 resolve，turn completed，目录确实被创建 |
| g | reconnect-from-seq | 订阅者断开，带 `fromSeq` 重连 → durable 事件一个不少，没有多余快照 |
| h | codex-restart-adopt | 仅 codex：unix own app-server；turn 中途停网关（detach），新网关启动后 `turn.adopted` 并 completed，log 里该 turn 只结束一次 |

e2e 会忽略配置里的通道（不需要通道密钥），claude-code 下不加载用户/项目 settings（否则用户的权限规则会替人回答审批），codex 下 `restricted` 未配置时用 `approvalPolicy: untrusted`、effort 默认 `low`。

### 1.2 手动：一个 serve + 两个 attach

```sh
aio-dev serve                               # 终端 1
aio-dev attach                              # 终端 2：full tier
aio-dev attach --tier card                  # 终端 3：同一 session 的第二个端
aio-dev send --wait "Reply with exactly: pong"   # 脚本一次性输入，等结果
aio-dev sessions
```

attach 里直接输入文字就是 queue 输入；`/steer <text>`、`/interrupt [--clear]`、`/approve <id> [always]`、`/deny <id> [reason]`、`/sessions`、`/quit`，`//text` 发送以 `/` 开头的文本。`--from <seq>` 从某个 seq 之后续看，不带则先给一份快照。

检查清单：

- [ ] 两个 attach 都看到同一组事件（turn、工具、审批、答案）；任一端输入都进同一 lane，忙时显示 `queued`。
- [ ] 终端 2 运行中 `/steer`，终端 3 也看到 `input … steer`，答案体现 steer。
- [ ] `/interrupt` 后两端都看到 `turn … interrupted`。
- [ ] 关掉终端 3 再 `aio-dev attach --tier card --from <最后看到的 seq>`，中间的事件补齐。
- [ ] socket 文件是 `0600`、目录 `0700`（默认 `~/.agents-io/dev-gateway/run/aio.sock`）。

示例配置还挂了一个进程外通道（`channel/jsonl-bridge/examples/echo_channel.py`，经 `spawnChannel`）：把 `echo-py:python-user` 加进 owners，它在握手后发的那条消息会开一轮，回复写进 `ECHO_RECORD` 文件。私有通道就是这样接入的。

## Tier 2：真实飞书 / Lark

1. 创建机器人（[create-lark-bot](https://github.com/Ghost-LZW/create-lark-bot) v0.2.1，GitHub 预发布版，不在 npm）。在仓库根目录执行，凭证和主人键写进 `.env.live`：

   ```sh
   npx github:Ghost-LZW/create-lark-bot#v0.2.1 --name "<name>" --avatar ./avatar.png \
     --preset messaging,contact --write-env .env.live \
     --env-owner-var AGENTS_IO_OWNERS --owner-prefix lark-bot:
   npx github:Ghost-LZW/create-lark-bot#v0.2.1 verify --live
   ```

   它写入 `LARK_APP_ID`、`LARK_APP_SECRET`、`LARK_DOMAIN`，以及经过验证的主人键 `lark-bot:<union_id>` 到 `AGENTS_IO_OWNERS`（逗号列表）。
2. 配置里保留 `{ "type": "lark-bot", "tier": "card" }`。示例配置设了 `"ownerSessionKey": "main"`：主人的私聊都进 `main`，本地端默认身份就是这个主人、默认 session 也是 `main`，所以终端和飞书是同一主体、同一 session。
3. `aio-dev serve`，日志里应有 `channel lark-bot (default) started`。

检查清单：

- [ ] 私聊机器人一句话 → 立刻出现一张卡片，随后节流编辑（工具名、计划），结束时 finalize 成答案和 `Done`。
- [ ] `aio-dev attach`（session `main`）同时看到这一轮的完整过程。
- [ ] 飞书里连发三条 → 一轮处理完再开下一轮，排队的合在一起（卡片只有一张/轮）。
- [ ] 运行中在终端 `/steer …`：同一主体，折进飞书发起的这一轮（终端 steer 走 local 路由，会出现 `turn.delivery_added`，但 local 没有渲染器，回复仍只在飞书卡片上）。
- [ ] 终端发起的一轮，在飞书里发消息 → 排队；飞书侧不会收到终端那轮的卡片（回复路由是 local）。
- [ ] 非主人私聊机器人 → 无响应（默认策略 drop）；群里非主人发言 → 只 observe，不开轮。
- [ ] 审批：把 `policy` 换成 restricted + human（可参考 e2e 场景 f 的写法在代码里覆盖），卡片出现"Allow / Deny"按钮；别人点无效，主人点有效，卡片按钮消失。
- [ ] `/interrupt` 后卡片 finalize 为 `Interrupted`。
- [ ] Ctrl-C 停 serve 再启动：之前的 session 用 `session.bound` 里的原生 id 续接（claude `--resume` / codex `thread/resume`）。

## Tier 3：多端 + 重启

1. 配置 `harness.use: "codex"` 且 `codex.transport: { kind: "unix", spawn: "own" }`（app-server 独立于网关进程运行，状态在 `~/.agents-io/codex`）。
2. 终端 A `aio-dev serve`，终端 B、C 各 `aio-dev attach`，飞书里也开着同一 session。
3. 发一个长任务（"Use the shell to run `sleep 30`, then reply with exactly: done"），看到 `▶ command` 后在 A 里 Ctrl-C。
   - [ ] B、C 打印 `[subscription ended]`；log 里这一轮**没有**结束事件（codex 是 detach，不是 close）。
4. 再 `aio-dev serve`；B、C 用 `aio-dev attach --from <最后的 seq>` 重连。
   - [ ] 日志 `reopened to adopt turn …`；终端看到 `── turn … adopted after restart`，随后 `completed`，答案 `done`。
   - [ ] 飞书卡片：重启后 compositor 不接管旧卡片（见缺口），答案只在终端/日志里。
5. claude-code 下重复第 3 步：停网关会 interrupt 当前轮，应记为 `interrupted`（e2e 未自动覆盖）；重启后下一次输入续接同一 claude 会话。若进程被 kill -9，log 里残留的未结束 turn 在下一轮开始前被记为 `ambiguous`（`host_restarted`）。

## 已知缺口

- Outbox 存储在内存：重启后不记得已投递的 operationId，compositor 也不 `reconcile` 旧卡片、不接管被 adopt 的 turn 的卡片。
- 邮件通道的 `MailStore`（IMAP 检查点）在内存：重启后从当前位置重新建基线。
- 本地 socket 上所有连接都是同一个本地主体；没有每连接鉴权。
- `control` 命令（set_model 等）lane 尚未实现，返回 `unsupported`。
- 没有 host MCP 工具（reply/send_file），agent 只能通过本轮回复路由输出。
