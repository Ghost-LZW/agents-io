# 端到端测试：aio 守护进程

> `packages/daemon`（`aio`）把所有包接进一个常驻进程：通道、Binding 表、lane、Hub、宿主入站队列、宿主协议（`docs/HOSTS.md`）。`examples/dev-gateway` 只剩一个同名 CLI 的包装（`aio-dev`，`aio-dev send` 对应 `aio input`）。出站 outbox 的结算记录在 SQLite 里（`deliver` 跨重启幂等）。

```
channels(lark-bot / mail / bridge…) ─▶ Ingress ─▶ Lane(每 session 一条, harness 懒打开) ─▶ Hub(SQLite log)
                                                                          │
     Compositor + Outbox(每 session × channel，回到来源路由：lark=card，mail=final) ◀─┤
     本地 Unix socket（JSONL 客户端帧）：attach / send / e2e ◀──────────────────────┘
```

## 0. 准备

```sh
pnpm install && pnpm build
cp packages/daemon/aio.config.example.json aio.config.json   # 已 gitignore
alias aio="node $PWD/packages/daemon/dist/cli.js"        # examples/dev-gateway 的 aio-dev 是同一个 CLI
```

- 配置文件：`--config <path>`、`$AIO_CONFIG` 或当前目录的 `aio.config.json`（不存在就全用默认值：claude-code + haiku、无通道）。相对路径按配置文件所在目录解析。
- 密钥只放环境变量或 `.env.live`（KEY=VALUE，已 gitignore）。查找顺序：`--env-file`、配置文件同目录、从当前目录向上最近的一个。自动找到的文件必须属于当前用户、别人不可写（否则报错，`chmod 600`），且所在目录不是所有人可写（`/tmp` 这类目录里的 `.env.live` 会被跳过：别的用户能放一个进去给自己加主人身份）；`--env-file` 指定的文件按原样使用。进程环境变量优先于文件。通道配置里的字符串 `"env:NAME"` 会替换成该变量。
- 会出现在子进程命令行上的设置（`ps` 对本机其他用户可见）不会拿到密钥本身：claude 的 `mcpServers` 里 `"env:NAME"` 写成 `${NAME}`、值放进子进程环境（CLI 自己展开）；内联 `settings` 只允许在 `settings.env` 里用 `"env:"`（移到子进程环境）；codex 的 `config` 里 `"env:"` 会改写成 Codex 按变量名取值的设置（`http_headers.H` → `env_http_headers.H`，`bearer_token` → `bearer_token_env_var`，`experimental_bearer_token` → `env_key`，`mcp_servers.<id>.env.VAR` → `env_vars`），其他位置的 `"env:"` 是配置错误。
- 会话日志（log.sqlite 及 -wal/-shm）是 0600，网关新建的数据目录是 0700；已有的宽松文件会被收紧，已有目录不会被 chmod，只在日志里警告。本地 socket 的目录若是已有目录，必须已属于当前用户且为 0700，否则拒绝启动；socket 路径上已有的非 socket 文件绝不删除。
- Harness 是**命名实例**（见下节）：每个实例的子进程只拿到网关自身的环境加上该实例 `env` 里写明的变量（`"env:NAME"` 从环境/`.env.live` 取值，`null` 表示从子进程环境里删掉）。旧的单 `harness` 块仍可用，此时沿用旧行为：`.env.live` 里 `ANTHROPIC_* / CLAUDE_* / OPENAI_* / CODEX_* / *_PROXY` 这些键传给 harness CLI。Lark、邮件密钥始终留在网关进程里。工具从不打印变量的值（`serve` 日志只列实例名和种类）。
- 模型：实例的 `run.model`，环境变量 `AGENTS_IO_LIVE_CLAUDE_MODEL` / `AGENTS_IO_LIVE_CODEX_MODEL` 只覆盖**默认实例**（同种类的其他实例可能接的是别家模型）；默认 claude 用 `haiku`，codex 用它自己的默认模型。

### Harness 实例

```jsonc
"defaultHarness": "claude",
"harnesses": {
  "claude":         { "use": "claude-code", "run": { "model": "haiku" }, "profiles": { … } },
  "claude-gateway": { "use": "claude-code", "configDir": "~/.agents-io/claude-gateway",
                      "env": { "ANTHROPIC_BASE_URL": "env:GATEWAY_BASE_URL", "ANTHROPIC_AUTH_TOKEN": "env:GATEWAY_AUTH_TOKEN", "ANTHROPIC_API_KEY": null },
                      "run": { "model": "gemini-3.8-flash-high" } },
  "codex":          { "use": "codex", "home": "~/.agents-io/codex-home", "config": { "model_reasoning_summary": "concise" },
                      "transport": { "kind": "unix", "spawn": "own" } }
}
```

- `RunSpec.harness` 是实例名；`Policy.plan` 每轮选实例，默认策略用 `defaultHarness`（缺省为第一个）。会话事件的 `harness` 字段、续接用的原生 id（`session.bound`）都按实例名记，所以不同 `configDir` / `CODEX_HOME` 的会话不会互相 `--resume`。同一 session 的下一轮换了实例时，lane 关掉旧绑定、开新一代（`notice runtime_restart: switching harness a → b`）。适配器在第一次用到时才建。
- 共有字段：`use`、`env`、`cwd`（该实例会话的工作目录）、`run`、`profiles`（权限 profile → 原生设置，同以前）、`options`（原样作为 `HarnessOpenArgs.options`）。
- claude-code：`configDir` → `CLAUDE_CONFIG_DIR`（登录态、用户 settings、用户级 skills/agents/commands、会话记录都在这里；用户级 skills 从 `<configDir>/skills` 发现，且只在 `settingSources` 含 `user` 或缺省时加载——已用 system/init 的 skills 列表实测；e2e 用 `settingSources: []`，所以 e2e 里不加载用户 skills）；`executable`（`claude` 路径）；`settings`（settings.json 路径或内联对象，即 Agent SDK `settings` = CLI `--settings` 的 flag 层，`settingSources: []` 时也生效）；`settingSources`（`user`/`project`/`local`，`[]` 表示都不加载，缺省全加载）；`mcpServers`；`plugins`（本地插件目录，SDK `plugins: [{type:'local', path}]` → `--plugin-dir`，插件可带 skills/agents/commands/hooks）；`skills`（`"all"` 或名字列表，SDK `skills`）；`extraArgs`（额外 CLI 参数，`null` 为无值 flag）；`additionalDirectories`（与 profile 的合并）。
- codex：`home` → `CODEX_HOME`；`executable`；`config`（点分键 → 值，作为 `codex app-server -c key=<TOML>` 传入）；`enable` / `disable`（`--enable/--disable <feature>`）；`transport`（`stdio` | `unix` + `spawn: own/daemon/none`）。`config/enable/disable` 只对网关自己起的服务（stdio、unix own）有效，`daemon/none` 时报错。**没有 `profile`**：`codex app-server` 不接受 `--profile`（codex-cli 0.160 报错 "--profile only applies to runtime commands"），`-c profile=…` 也已废弃，写了会报错，请用 `config` 或单独的 `home`。
- 每个 codex 实例有自己的 app-server：unix 状态目录默认 `~/.agents-io/codex.<实例名>`（socket、`server.json`、`turns/` 快照），两个实例写同一个 `stateDir` 是配置错误，重启接管不会跨实例。`server.json` 里记一个启动指纹（二进制、`CODEX_HOME`、`-c/--enable/--disable` 的哈希，不含值）：设置变了再连旧服务会被拒绝，提示先停掉旧进程。旧 `harness` 块的 codex 仍用 `~/.agents-io/codex`，正在跑的部署照常接管。
- 路径支持 `~`，相对路径按配置文件目录解析；`executable` 写裸名（`claude`、`codex`）时走 PATH。实例名限字母、数字、`.`、`_`、`-`。`env`、`settings`（对象）、`mcpServers`、`config` 里的 `"env:NAME"` 都会替换；变量缺失只让该实例不可用（用到时报错并给出变量名），不影响其他实例。校验错误只给键名、不给值。
- 主人：`policy.owners` 加上 `AGENTS_IO_OWNERS`（逗号分隔），键是 `<channel>:<channelUserId>`。
- 本地端（attach/send）以 `local.principal` 的身份说话，默认是第一个主人（没有主人时是 `local:owner`），labels 默认 `['owner']`。默认 session 是 `policy.ownerSessionKey`，否则 `local:main`。

## Tier 1：本地（不需要任何外部账号）

### 1.1 自动场景

```sh
pnpm e2e                                   # 根目录：build 后跑 claude-code
pnpm e2e --harness codex                   # 实例名，或种类名（取该种类的第一个实例）
aio e2e --harness claude-gateway --only a
aio e2e --only a,d --verbose           # 只跑某几个；--verbose 打印过程
```

e2e 跑的是默认实例（`--harness` 可换），保留它的 `env`、`configDir`/`home`、`settings` 等启动设置，但会话放在场景临时目录里。每个场景起一个独立的进程内网关（临时目录、SQLite log、本地 socket），一个脚本化通道 `e2e`（主人 `e2e:alice`、`e2e:bob`），对**真实** harness 发便宜且确定的提示，在订阅流上断言，逐个打印 `PASS/FAIL/SKIP` 和原因：

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
| j | context-listen | 陌生人在群里不 @ 机器人发两句话 → 只记录（`observe_only`，带整条记录），不开轮；主人随后 @ 机器人问"他们说了什么" → 一个 turn，`inputIds` 依次是两条 context 和提问（`docs/CHANNELS.md` §1b）；turn completed、无 rejected；回答提到两句话的内容（Friday、ORCHID-77） |
| r | task-run | 宿主协议：带 token 的连接 `run.start` 一个 `mode: task` agent（默认实例、`bypass`），`env` 里的值只进子进程：shell 里 `echo` 出来的值出现在回答里，日志里只出现在工具输出和回答中；`run.ended` 退出码 0，session `run:<id>` 关闭；同一 runId 再 start 直接报告结果；交互 agent 被拒（`not_task_agent`） |
| m | output-ask-choice | 输出工具：模型调 `ask_choice` → 通道上出现 red/blue 按钮（`choice:` action id），该轮结束；模拟点击 blue → 新一轮的输入是 `choice` 事件，回答含 blue；`delivery.settled` delivered；报告 harness 在 `_meta` 里带了哪些键 |
| n | output-send-file | 输出工具：工作目录里写 README.md，模型调 `send_file` → 通道收到附件，blob 字节与文件一致，delivery settled |
| o | output-terminal-choose | 输出工具：本地路由上 `ask_choice` 只写 `agents-io.output` 事件；`/choose <id> <n>` 等价的输入 → 新一轮回答含所选项；越界序号被拒（`bad_choice`） |

e2e 会忽略配置里的通道（不需要通道密钥），claude-code 下不加载用户/项目 settings（否则用户的权限规则会替人回答审批），codex 下 `restricted` 未配置时用 `approvalPolicy: untrusted`、effort 默认 `low`。

### 1.2 手动：宿主命令（`aio run` / `send` / `tail`）

配置里加一个 task agent（示例配置里有 `executor`、`executor-codex`），然后在 `aio serve` 运行时：

```sh
aio run --agent executor --run-id try-1 -- "reply with exactly: pong"   # stdout: pong，退出码 0
aio run --agent executor-codex -- "reply with exactly: pong"
aio run --agent executor --env PROBE=hi -- 'Run: echo $PROBE and reply with only its output.'   # env 只进子进程
aio run --agent executor --timeout 5s -- 'Run: sleep 60'                # 退出码 124
aio run --agent assistant -- x                                          # 交互 agent：not_task_agent，退出码 2
aio run --agent executor --run-id try-1 -- x                            # 同一 runId：直接报告上次的结果
aio send --route '{"channel":"lark-bot","account":"default","conversationId":"oc_…"}' --operation-id op-1 --text hi
aio bindings put --file table.json && aio bindings get
aio tail --consumer xwo --once     # 命中 on: host 规则的输入，一行一条 JSON（带 cursor）
aio ack --consumer xwo <cursor>
aio explain <inputId>; aio verify channel:lark-bot/<message id>
```

- [ ] `~/.agents-io/aio/run/aio.sock.token` 是 0600，每次 `aio serve` 启动都换新，停止时删除；`aio serve` 没在运行时上面的命令报 `no host token …`（退出码 69）。
- [ ] `aio run` 的 stderr 每个工具调用一行，结束一行 `run <id> <status> (exit N)`；Ctrl-C 取消（退出码 130）。

### 1.3 手动：一个 serve + 两个 attach

```sh
aio serve                               # 终端 1
aio attach                              # 终端 2：full tier
aio attach --tier card                  # 终端 3：同一 session 的第二个端
aio input --wait "Reply with exactly: pong"   # 脚本一次性输入，等结果
aio sessions
```

attach 里直接输入文字就是 queue 输入；`/steer <text>`、`/interrupt [--clear]`、`/approve <id> [always]`、`/deny <id> [reason]`、`/sessions`、`/quit`，`//text` 发送以 `/` 开头的文本。`--from <seq>` 从某个 seq 之后续看，不带则先给一份快照。

检查清单：

- [ ] 两个 attach 都看到同一组事件（turn、工具、审批、答案）；任一端输入都进同一 lane，忙时显示 `queued`。
- [ ] 终端 2 运行中 `/steer`，终端 3 也看到 `input … steer`，答案体现 steer。
- [ ] `/interrupt` 后两端都看到 `turn … interrupted`。
- [ ] 关掉终端 3 再 `aio attach --tier card --from <最后看到的 seq>`，中间的事件补齐。
- [ ] socket 文件是 `0600`、目录 `0700`（默认 `~/.agents-io/aio/run/aio.sock`）。

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
3. `aio serve`，日志里应有 `channel lark-bot (default) started`。

检查清单：

- [ ] 私聊机器人一句话 → 立刻出现一张卡片，随后节流编辑（工具名、计划），结束时 finalize 成答案和 `Done`。
- [ ] `aio attach`（session `main`）同时看到这一轮的完整过程。
- [ ] 飞书里连发三条 → 一轮处理完再开下一轮，排队的合在一起（卡片只有一张/轮）。
- [ ] 运行中在终端 `/steer …`：同一主体，折进飞书发起的这一轮（终端 steer 走 local 路由，会出现 `turn.delivery_added`，但 local 没有渲染器，回复仍只在飞书卡片上）。
- [ ] 终端发起的一轮，在飞书里发消息 → 排队；飞书侧不会收到终端那轮的卡片（回复路由是 local）。
- [ ] 非主人私聊机器人 → 无响应（默认策略 drop）；群里非主人发言 → 只 observe，不开轮。
- [ ] 审批：把 `policy` 换成 restricted + human（可参考 e2e 场景 f 的写法在代码里覆盖），卡片出现"Allow / Deny"按钮；别人点无效，主人点有效，卡片按钮消失。
- [ ] `/interrupt` 后卡片 finalize 为 `Interrupted`。
- [ ] Ctrl-C 停 serve 再启动：之前的 session 用 `session.bound` 里的原生 id 续接（claude `--resume` / codex `thread/resume`）。

## Tier 3：多端 + 重启

1. 默认实例是 codex 且 `transport: { kind: "unix", spawn: "own" }`（`aio serve --harness codex`；app-server 独立于网关进程运行，状态在 `~/.agents-io/codex.<实例名>`，旧 `harness` 块为 `~/.agents-io/codex`）。
2. 终端 A `aio serve`，终端 B、C 各 `aio attach`，飞书里也开着同一 session。
3. 发一个长任务（"Use the shell to run `sleep 30`, then reply with exactly: done"），看到 `▶ command` 后在 A 里 Ctrl-C。
   - [ ] B、C 打印 `[subscription ended]`；log 里这一轮**没有**结束事件（codex 是 detach，不是 close）。
4. 再 `aio serve`；B、C 用 `aio attach --from <最后的 seq>` 重连。
   - [ ] 日志 `reopened to adopt turn …`；终端看到 `── turn … adopted after restart`，随后 `completed`，答案 `done`。
   - [ ] 飞书卡片：重启后 compositor 不接管旧卡片（见缺口），答案只在终端/日志里。
5. claude-code 下重复第 3 步：停网关会 interrupt 当前轮，应记为 `interrupted`（e2e 未自动覆盖）；重启后下一次输入续接同一 claude 会话。若进程被 kill -9，log 里残留的未结束 turn 在下一轮开始前被记为 `ambiguous`（`host_restarted`）。

## 已知缺口

- Outbox 存储在内存：重启后不记得已投递的 operationId，compositor 也不 `reconcile` 旧卡片、不接管被 adopt 的 turn 的卡片。
- 邮件通道的 `MailStore`（IMAP 检查点）在内存：重启后从当前位置重新建基线。
- 本地 socket 上所有连接都是同一个本地主体；没有每连接鉴权。
- `control` 命令（set_model 等）lane 尚未实现，返回 `unsupported`。
- 没有 host MCP 工具（reply/send_file），agent 只能通过本轮回复路由输出。
- 默认策略每轮都选 `defaultHarness`；按输入换实例要自己写 `Policy.plan`（本地端/通道还没有"切实例"命令，`control set_model` 也未实现）。
- 新 `configDir` / `CODEX_HOME` 是空的登录态：claude 报 `Not logged in · Please run /login`，codex 报 401，需要在该目录里各自登录一次（`CLAUDE_CONFIG_DIR=… claude` 后 `/login`；`CODEX_HOME=… codex login`），或给实例配 API key / 网关的 `env`。
