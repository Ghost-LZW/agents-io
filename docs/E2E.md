# 端到端测试：aio 守护进程

> `packages/daemon`（`aio`）把所有包接进一个常驻进程：通道、Binding 表、lane、Hub、宿主入站队列、宿主协议（`docs/HOSTS.md`）。`examples/dev-gateway` 只剩一个同名 CLI 的包装（`aio-dev`，`aio-dev send` 对应 `aio input`）。出站 outbox 的结算记录在 SQLite 里（`deliver` 跨重启幂等）。
>
> 单元与集成测试（`pnpm test`、四层、`#编号` 标签、`pnpm invariants:affected`）见 [TESTING.md](TESTING.md)；本文是守护进程与真实平台的端到端与手工清单，属于 `live` 层。

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
alias aio-e2e="node $PWD/packages/daemon-e2e/dist/cli.js"   # §1.1 的自动场景（原来的 aio e2e）
```

- 配置文件：`--config <path>`、`$AIO_CONFIG` 或当前目录的 `aio.config.json`（不存在就全用默认值：claude-code + haiku、无通道）。相对路径按配置文件所在目录解析。
- 密钥只放环境变量或 `.env.live`（KEY=VALUE，已 gitignore）。查找顺序：`--env-file`、配置文件同目录、从当前目录向上最近的一个。自动找到的文件必须属于当前用户、别人不可写（否则报错，`chmod 600`），且所在目录不是所有人可写（`/tmp` 这类目录里的 `.env.live` 会被跳过：别的用户能放一个进去给自己加主人身份）；`--env-file` 指定的文件按原样使用。进程环境变量优先于文件。通道配置里的字符串 `"env:NAME"` 会替换成该变量。
- 会出现在子进程命令行上的设置（`ps` 对本机其他用户可见）不会拿到密钥本身：claude 的 `mcpServers` 里 `"env:NAME"` 写成 `${NAME}`、值放进子进程环境（CLI 自己展开）；内联 `settings` 只允许在 `settings.env` 里用 `"env:"`（移到子进程环境）；codex 的 `config` 里 `"env:"` 会改写成 Codex 按变量名取值的设置（`http_headers.H` → `env_http_headers.H`，`bearer_token` → `bearer_token_env_var`，`experimental_bearer_token` → `env_key`，`mcp_servers.<id>.env.VAR` → `env_vars`），其他位置的 `"env:"` 是配置错误。
- 会话日志（log.sqlite 及 -wal/-shm）是 0600，网关新建的数据目录是 0700；已有的宽松文件会被收紧，已有目录不会被 chmod，只在日志里警告。本地 socket 的目录若是已有目录，必须已属于当前用户且为 0700，否则拒绝启动；socket 路径上已有的非 socket 文件绝不删除。
- Harness 是**命名实例**（见下节）：每个实例的子进程只拿到网关自身的环境加上该实例 `env` 里写明的变量（`"env:NAME"` 从环境/`.env.live` 取值，`null` 表示从子进程环境里删掉）。旧的单 `harness` 块仍可用，此时沿用旧行为：`.env.live` 里 `ANTHROPIC_* / CLAUDE_* / OPENAI_* / CODEX_* / *_PROXY` 这些键传给 harness CLI。Lark、邮件密钥始终留在网关进程里。工具从不打印变量的值（`serve` 日志只列实例名和种类）。
- 第三方的模块（配置里指名的 ES 模块，与守护进程同进程、同权限，只写自己信任的代码）在 `aio serve` 启动时、解析配置之前导入：`modules` 条目（`{ "use": "module", "module": "./my-feature.mjs", "export": …, "config": { … } }`，导出一个功能模块清单 `ModuleManifest`，缺省导出名 `manifest`；`config` 是它的设置，`enabled: false` 关掉；注册在内建模块之后，`GET /api/status` 的 `modules` 里 `origin` 是 `module`）和 `type: "module"` 通道条目的文件（可以导出 `ChannelModule` 描述符代替工厂，`docs/CHANNELS.md` §5）。路径相对配置文件。条目写错（文件不存在、导出不是清单、与别的模块重复、`config` 不合它的设置）时 `aio serve` 以退出码 2 失败，错误说出条目。只读配置的客户端命令（`aio send`、`aio attach`）不导入它们。
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
- `use` 的取值是注册了的 harness 种类加上 `module`。`claude-code`、`codex`、`bridge`、`acp` 由守护进程的组合根 `packages/daemon/src/bundle.ts` 注册，各自是所在包里的一个 `HarnessModule`（`harness/claude-code/src/module.ts`、`harness/codex/src/module.ts`、`harness/jsonl-bridge/src/module.ts`、`harness/acp/src/module.ts`，类型在 `packages/protocol/src/harness-module.ts`）：下面这些专有字段、旧 `harness` 块里该种类的一节、缺省模型和 `AGENTS_IO_LIVE_*_MODEL`、配置目录变量（`CLAUDE_CONFIG_DIR` / `CODEX_HOME`，见 `sessionParams.envPathRoots`）、跨实例的规则（codex 的 `stateDir` 不得共用）和适配器怎么建，都由它说了算；守护进程的配置代码不认识具体种类。
- claude-code：`configDir` → `CLAUDE_CONFIG_DIR`（登录态、用户 settings、用户级 skills/agents/commands、会话记录都在这里；用户级 skills 从 `<configDir>/skills` 发现，且只在 `settingSources` 含 `user` 或缺省时加载——已用 system/init 的 skills 列表实测；e2e 用 `settingSources: []`，所以 e2e 里不加载用户 skills）；`executable`（`claude` 路径）；`settings`（settings.json 路径或内联对象，即 Agent SDK `settings` = CLI `--settings` 的 flag 层，`settingSources: []` 时也生效）；`settingSources`（`user`/`project`/`local`，`[]` 表示都不加载，缺省全加载）；`mcpServers`；`plugins`（本地插件目录，SDK `plugins: [{type:'local', path}]` → `--plugin-dir`，插件可带 skills/agents/commands/hooks）；`skills`（`"all"` 或名字列表，SDK `skills`）；`extraArgs`（额外 CLI 参数，`null` 为无值 flag）；`additionalDirectories`（与 profile 的合并）。
- codex：`home` → `CODEX_HOME`；`executable`；`config`（点分键 → 值，作为 `codex app-server -c key=<TOML>` 传入）；`enable` / `disable`（`--enable/--disable <feature>`）；`transport`（`stdio` | `unix` + `spawn: own/daemon/none`）。`config/enable/disable` 只对网关自己起的服务（stdio、unix own）有效，`daemon/none` 时报错。**没有 `profile`**：`codex app-server` 不接受 `--profile`（codex-cli 0.160 报错 "--profile only applies to runtime commands"，0.171 报 "unexpected argument '--profile' found"），`-c profile=…` 也已废弃，写了会报错，请用 `config` 或单独的 `home`。
- codex 的版本：已验证的是 codex-cli **0.160.x 与 0.171.x**（`harness/codex/src/version.ts` `SUPPORTED_CODEX_LINES`，类型由 0.171.0 生成；两条线由同一份代码驱动，见 `harness/codex/README.md`）。Codex 会自己升级，所以（决定 17，HC-1）：低于 0.160 的版本在第一次用到实例时报 `codex app-server <版本> is not supported …`；更新的、没验证过的版本（如 0.172）和读不出的版本照常运行，每个实例告警一次：守护进程日志一条 `harness <实例>: codex app-server <版本> has not been verified …` 的 warn（启动时 probe 默认实例就会出现），第一个会话的事件流里一条 detail 级 `notice`。协议里不认识的东西不会让一轮卡住（HC-9）：每个服务端请求都有答复，不认识的通知记成 `native`。较新的模型可能只在新版本上可用：ChatGPT 登录下 `gpt-6.2-sol` 在 0.160.1 上答 400 `model_not_found`，0.171.0 正常（2026-11-24）。`transport.spawn: "daemon"` 连的是 Codex 自己管理、自动升级的 app-server daemon，版本不由 `executable` 决定（本机 2026-11-24 已是 0.172.0：没验证过，照常运行并告警；2026-11-25 用它的执行文件以 stdio 跑过一轮真实的 `codex.live.test.ts`）。
- 换 codex 版本（改实例的 `executable`）：stdio 实例改完重启 `aio serve` 即可。unix `spawn: "own"` 的 app-server 比守护进程活得久，`server.json` 的启动指纹含二进制路径，所以先停掉 `aio serve`（正在跑的轮次最好先等它结束：旧 app-server 停掉后它不能被新的接管，下次启动时结算），再停旧 app-server（pid 在 `<stateDir>/server.json`，默认 `~/.agents-io/codex.<实例名>/`），改 `executable`，再启动；不先停旧的，启动时报 `codex app-server <pid> on <socket> was started with other settings …`。thread 存在 `CODEX_HOME` 里，0.160 写的 thread 在 0.171 上 `thread/resume` 后照常续聊，反过来也一样（2026-11-24 实测），所以会话不断、换回旧版本也行。
- bridge（`use: "bridge"`）：另一个进程里、任何语言写的 harness，经 stdio 说 JSONL harness 帧（HOSTS §4.8）。专有字段 `command`、`args`（原样上命令行，不放机密）、`config`（在 `probe` 里交给程序，`"env:NAME"` 替换）；`env` 是程序的环境，`cwd` 是它和它的会话的工作目录，`profiles` 随每次 `open` 交给程序。守护进程启动时就拉起程序、问它声明什么（`probe` 的回答：`caps`、`declares`、`methods`），声明与进程内的 harness 一样起作用（`/plan`、`/compact`、停止时 `detach` 与否、重启时 `adopts`），回答形状不对、声明 `attach: 'takeover'` 或程序起不来都让启动失败（退出码 2，错误里有实例名和成员）。程序退出后下一轮再拉起它。只答 `version` 和 `caps` 的旧程序什么都不声明。例子：`{ "use": "bridge", "command": "python3", "args": ["harness/jsonl-bridge/examples/echo_harness.py"] }`。
- acp（`use: "acp"`，core-slimming G9）：任何 Agent Client Protocol 的 agent（Claude Code 的 ACP agent、Gemini CLI `--experimental-acp`、codex-acp……），守护进程是 ACP 客户端，agent 是它的子进程，经 stdio 说 ACP v1 的 JSON-RPC（官方 SDK `@agentclientprotocol/sdk`）。只起配置好的命令，从不从 ACP registry 安装。专有字段 `command`、`args`（原样上命令行，不放机密，机密放 `env`）、`mcp`（宿主 MCP 端点怎么给 agent：`http` 或 `stdio-bridge`，缺省按 agent 是否声明 `mcpCapabilities.http`）、`flavor`（agent 的怪癖，`generic` / `claude`，缺省按 `initialize` 的 `agentInfo` 选）、`planMode`、`compact`、`displayName`、`elicitation`（缺省开）、`authMethod`；`env` 是 agent 进程的环境，`cwd` 是它和它的会话的工作目录；`profiles` 的每一档只能写 `mode`（这一档的轮次跑在 agent 的哪个 session mode 上，`session/set_mode`；写了别的键是配置错误；没写 `mode` 的 `bypass` 跑在会话打开时的 mode 上，其他各档、包括内置的 `restricted`，跑在 agent 动手前先问的 mode 上，generic flavor 取 `default`，agent 有 mode 却没有会问的就不开始这一轮）。能力来自 agent 的 `initialize` 和每个会话的 `session/new` / `session/load`：不能 steer（插话排到下一轮），打断是 `session/cancel`，审批是 `session/request_permission`，提问只在开了 `elicitation` 时，续接是 `session/load`（agent 重放的历史不进日志），Plan 模式看 `availableModes`，压缩看 agent 公布的命令，从不接管（`adopts` 不声明：停止时会话关闭、agent 进程退出，重启后下一条输入经 `session/load` 续上）。不声明 `fs`、`terminal` 客户端能力：读写文件、跑命令由 agent 按它自己的权限做。一个进程服务实例的所有会话，带 env 的 launch 会话和每个任务 run 各起一个（`sessionEnv: 'own-process'`）。细节与 ACP 相对原生适配器少了什么见 `harness/acp/README.md`。例子：`{ "use": "acp", "command": "/opt/acp/node_modules/.bin/claude-agent-acp", "profiles": { "bypass": { "mode": "bypassPermissions" } } }`。
- module（`use: "module"`，决定 11 补记）：`module`（同通道模块的解析）、`export`、`config`（`"env:NAME"` 替换）加上共有字段；模块导出一个 `HarnessFactory`（`@agents-io/protocol`），在守护进程里运行。也可以导出一个 `HarnessModule` 描述对象（有 `create` 函数的对象）：有 `schema` 时启动时用它检查 `config`（封闭，没写 `config` 按 `{}` 查，不对就启动失败，错误里有实例名，CF-4），`create` 拿到与工厂相同的 init，外加 `launch`（即这份 `config`）、实例的 `env` 和 `profiles`；它的 `declares` 是它的适配器自己不声明时的声明（逐个成员，适配器自己的优先；启动时与适配器的声明按同一套规则检查，类型不对、不是声明、与适配器合起来做不到都让启动失败），`cli` 给 CLI 加命令（见下面 `attach` 一条；名字不合规则、不是函数、与注册了的种类或另一个实例的模块重名都让启动失败）；它的其他成员在这里不用，实例的种类仍是 `module`。工厂返回的适配器由该实例的所有会话（包括任务 run）共用。它可以声明与内建适配器同一套生命周期成员（`packages/protocol/src/harness.ts` `HarnessAdapter`）。停止时每个加载了的 module 实例都拿到这些调用，不论有没有会话、任务 run 用过它；几个实例的工厂（或描述符的 `create`，包括两个 `declares` 不同的描述符）返回同一个适配器对象时，每种调用只调一次：
  - `detach()`：harness 比守护进程活得久时用。停止时这个实例的 lane 改为 detach（不打断、不关会话，正在跑的 turn 在日志里保持未结束），然后调一次 `detach()`，由适配器自己结束会话、关连接，不打断也不退订。没有它时停止就逐个关会话（`close`）。
  - `adopts: true`：静态声明，不起进程就能读：重启后 `open({ resume })` 能接管上个进程留下的 turn（发 `turn.adopted`）。守护进程启动时重开这些会话，harness 没接管的，在打开之后结算。不声明时，遗留 turn 在启动时直接结算为 ambiguous `host_restarted`，不打开 harness。
  - `dispose()`：立刻关掉自己的进程。没有 `detach` 的适配器在停止中、会话都关完之后调一次。因为适配器是共用的，一个任务 run 结束时不调。
  - 内建的对照：Codex 两种传输都有 `detach`，只有 unix 声明 `adopts`；Claude Code 三者都没有。
  - 同样是静态声明、聊天命令和 `session.compact` 只读它们而不看实例种类的还有：`compact: { command }`（一轮只有这条命令、作为原生命令原样交给 harness，就压缩上下文；`/compact` 和宿主的 `session.compact` 发的就是它，不声明时答不可用 / `unsupported`）、`modes: ['plan']`（`/plan` 和 `/status` 的 Plan 一行）、`ownerProfileSwitch: true`（`/bypass`：主人切换自己那几轮的权限档）、`displayName`（回复里怎么称呼它，例如 "/plan is available only on Codex"；不声明时用实例名）。没有一个已配置的实例声明 `modes` / `ownerProfileSwitch` 时，回复改说注册了的种类里声明它的（`HarnessModule.declares`），所以只配了 Claude Code 的部署照旧答 "/plan is available only on Codex (this session runs claude-code)."；种类也都不声明时说 `is not available on any harness configured here`。内建的对照：Claude Code 声明 `compact: { command: '/compact' }`；Codex 声明 `modes: ['plan']` 和 `ownerProfileSwitch`（Claude Code 原生也认 `bypass`，但不声明，`/bypass` 在它上面照旧不可用）。
  - `ephemeralOpen: true`：`open` 认 `options.ephemeral`、`preface: false`、作为 `instructions` 给的指令和只读的 `profiles`（Codex 形状），守护进程在声明了它的 harness 上替模块跑临时的一轮（`KernelLaneHarness.ephemeralTurn`）；话题标题模块（`topic-title`，G4；配置 `topicTitles: { enabled: false }` 可关）用它生成话题标题。只有 Codex 声明。
  - `sessionEnv`：launch 会话的 env 怎么到 harness。`'open'`（缺省）：在 open 参数的 `env` 里，`open` 自己用到这个会话的子进程。`'own-process'`：一个进程服务所有会话，launch 会话的 env 不经 `open`，带 env 的 launch 会话改用 `ownProcess({ env, cwd })` 返回的适配器（这个会话独占，lane 关闭时调它的 `dispose`），声明它就必须有 `ownProcess`，否则启动失败。`{ refused: "…" }`：都不行，带 env 的 launch 答 `launch_unsupported`（"harness instance <名> is <refused>; …"），只带 cwd 可以。实例暂时不可用（配置里 `env:` 引用的变量没设，工厂没有运行）时守护进程读不到它的声明，带 env 的 launch 同样答 `launch_unsupported`，文字是它不可用的原因（只写变量名），只带 cwd 可以；内建实例这时照它可用时的声明答。任务 run 只要适配器有 `ownProcess` 就独占一个（`ownProcess({ env: {} })`，run 的 env 仍在 open 参数里，盖在实例 env 上）。`sessionEnv` 只管 launch 会话的 env：不论声明什么，module 的每次 open（`ownProcess` 返回的适配器上的也一样）都在 `env` 里带实例的 env，任务 run 的 env 盖在上面，`open` 要收下。内建的对照：Claude Code `'open'`；Codex stdio `'own-process'`，unix `{ refused: 'a shared Codex app-server (unix transport)' }`，两种传输都有 `ownProcess`（stdio app-server，launch env 里的 `CODEX_HOME` 作为它的 home）。
  - open 参数的 `instructions` 是该 agent 的指令（内建的对照：Claude Code 追加到预设系统提示，Codex 作为 developer instructions）；过渡期 module harness 同时在 `options.developerInstructions` 里收到同样的值。
  - 工厂的 `init.blobs`（`stat(ref)` / `get(ref)`）读网关的 blob 存储：输入里图片、文件块的 `ref` 指向它，存储里没有的引用（`lark-file:` 之类）`stat` 答 `undefined`。它是只读的视图，只有这两个方法，拆下来单独调也行。内建适配器拿同一个视图解析媒体，open 选项里显式给的 resolver 优先。
  - `attach`：静态声明，原生终端（`aio tui`，`tui.attach`，决定 15）怎么到会话上。`'join'`（缺省）：作为同一原生会话的另一个客户端加入，会话仍由守护进程驱动，`nativeClient(nativeId)` 给出启动命令（LN-8）。`'takeover'`：终端接管会话，要有 `takeover(args)`。守护进程的流程对每个声明它的 harness 都一样（LN-9）：已有连着的终端就答 `conflict`；没连上的被新的 attach 替换（`end('replaced by a new attach')`）；等 lane 空闲后释放绑定（还有一轮在跑答 `busy`）；用该会话在这个实例上的原生 id（`resume: true`），没有就新建一个 UUID；拿到的 `harness` 在接管期间顶替这个实例（lane 的 `harnessFor`），守护进程先在它上面打开会话，再调 `launch()` 得到启动命令（`unsetEnv` 是调用方环境里先去掉的变量）；终端离开或守护进程调 `end(reason)`（打开失败 `attach failed`、停止时最先 `daemon stopping`；`end` 抛错或返回被拒的 promise，守护进程只记日志，照常往下走，RS-8）之后调 `services.onEnd(reason)`，会话回到这个适配器、续接同一原生 id；连着的时候 `/status` 有一行 `a terminal UI holds this session`。`services` 给出放本次启动文件的目录（`<dataDir>/tui`）、`aio` CLI 的路径（终端拉起的辅助进程用 `node <cli> <命令>`，命令由内建种类经 `HarnessModule.cli` 贡献，例如 Claude Code 的 `tui-bridge`；`use: "module"` 实例的模块导出的描述符也能贡献，CLI 经它拿到的配置找到它们（`--config`、`$AIO_CONFIG`、`./aio.config.json`；`services.config` 是守护进程的配置文件，辅助进程用 `node <cli> --config <config> <命令>`），排在 CLI 自己的和内建种类的命令之后）和 `fileOf(ref)`（存储里文件的本地路径）。内建的对照：Codex `'join'`（unix 传输才有 `nativeClient`）；Claude Code `'takeover'`（`harness/claude-code/src/takeover.ts`）。
  - 工厂返回时守护进程检查这些成员的类型：`displayName` 是非空字符串，`compact` 是带非空 `command` 的对象，`modes` 是只含 `'plan'` 的数组，`ownerProfileSwitch`、`ephemeralOpen`、`adopts` 是布尔值，`sessionEnv` 是 `'open'`、`'own-process'` 或带非空 `refused` 的对象，`attach` 是 `'join'` 或 `'takeover'`（声明 `'takeover'` 就必须有 `takeover`），`detach`、`dispose`、`ownProcess`、`nativeClient`、`takeover` 是函数（都可以不写）。不对的让启动失败，错误里有实例名和成员名（例如 `bad modes (an array of 'plan' when present)`，CF-4），而不是等到聊天命令、终端加入或停止时才出错。
- 每个 codex 实例有自己的 app-server：unix 状态目录默认 `~/.agents-io/codex.<实例名>`（socket、`server.json`、`turns/` 快照），两个实例写同一个 `stateDir` 是配置错误，重启接管不会跨实例。`server.json` 里记一个启动指纹（二进制、`CODEX_HOME`、`-c/--enable/--disable` 的哈希，不含值）：设置变了再连旧服务会被拒绝，提示先停掉旧进程。旧 `harness` 块的 codex 仍用 `~/.agents-io/codex`，正在跑的部署照常接管。
- 路径支持 `~`，相对路径按配置文件目录解析；`executable` 写裸名（`claude`、`codex`）时走 PATH。实例名限字母、数字、`.`、`_`、`-`。`env`、`settings`（对象）、`mcpServers`、`config` 里的 `"env:NAME"` 都会替换；变量缺失只让该实例不可用（用到时报错并给出变量名），不影响其他实例。校验错误只给键名、不给值。
- 主人：`policy.owners` 加上 `AGENTS_IO_OWNERS`（逗号分隔），键是 `<channel>:<channelUserId>`。
- 本地端（attach/send）以 `local.principal` 的身份说话，默认是第一个主人（没有主人时是 `local:owner`），labels 默认 `['owner']`。默认 session 是 `policy.ownerSessionKey`，否则 `local:main`。

### 预设（presets）

```jsonc
"harnesses": {
  "codex-aster":  { "use": "codex", "home": "~/.config/codex", "transport": { "kind": "unix", "spawn": "own" },
                    "profiles": { "bypass": { "approvalPolicy": "never", "sandbox": "danger-full-access" } } },
  "claude-aster": { "use": "claude-code", "configDir": "~/.config/claude", "settings": "~/.config/claude/setting.json" }
},
"presets": {
  "codex":      { "harness": "codex-aster", "model": "gpt-6-sol", "effort": "high", "description": "AsterGate GPT-6 Sol" },
  "codex-fast": { "harness": "codex-aster", "model": "gpt-6-sol", "effort": "low" },
  "claude":     { "harness": "claude-aster", "model": "opus", "effort": "xhigh" }
},
"agents": {
  "assistant": { "preset": "codex", "cwd": "~/repos", "tools": true },
  "aio-dev":   { "preset": "claude", "cwd": "~/repos/agents-io", "tools": true }
}
```

- 预设 = 一个 harness 实例 + `model` + `effort`（可选 `description`，`/preset` 列表里显示）。没写的 model / effort 用实例的 `run`（claude 默认 `haiku`；codex 不传，用 `CODEX_HOME` 里 config.toml 的设置）。上例的两个实例相当于 shell 里的 `codex-aster`（`CODEX_HOME=~/.config/codex codex --yolo`）和 `claude-aster`（`CLAUDE_CONFIG_DIR=~/.config/claude claude --settings … --dangerously-skip-permissions`）；权限由下面说的 profile 决定，主人的轮次默认就是 `bypass`。codex 内置的 `bypass` 是 `workspace-write` 沙箱，要和 `--yolo` 一样就像上例那样把它设成 `danger-full-access`。
- agent 写 `preset` 或 `harness`，二选一；写 `preset` 时 agent 自己的 `model` / `effort` 仍然优先于预设的。
- 对话里，主人发 `/preset` 列出全部预设和本会话当前用的；`/preset <名字>` 让本会话从下一轮起换成该预设，并清掉本会话 `/model`、`/effort` 设过的值；`/preset default` 回到 agent 自己的。只改这一个会话（话题），存在日志库里，重启后还在；新话题仍用 agent 的默认。
- 换到另一个实例时，lane 关掉旧绑定、在新实例上开会话（`notice runtime_restart`）。新实例看不到在旧实例上聊过的内容（回复里会提示，`/new` 开干净的话题）；以后换回来时，续接那个实例在本会话里的原生会话。cwd、`instructionsFile`、工具仍是 agent 的。权限不跟着预设走，仍由 agent 的 `profile`、策略（只有主人时是 `bypass`）和 `/bypass` 决定。
- 预设名的规则同实例名，`default` 保留。配置里删掉某个会话正在用的预设后，这个会话回到 agent 自己的设置（`/preset` 会说明）。
- 预设由内建功能模块 `presets` 提供（core-slimming，2026-11-25；`packages/daemon/src/presets.ts`），打包的 `aio` 里总是开着，上面的写法与行为都不变；不带这个模块的嵌入方没有预设，配置写了 `agents.<n>.preset` 加载即失败（`no registered module provides presets`）。

## Tier 1：本地（不需要任何外部账号）

### 1.1 自动场景

```sh
pnpm e2e                                   # 根目录：build 后跑 claude-code
pnpm e2e --harness codex                   # 实例名，或种类名（取该种类的第一个实例）
aio-e2e --harness claude-gateway --only a
aio-e2e --only a,d --verbose           # 只跑某几个；--verbose 打印过程
aio-e2e --only p,q --data-dir ~/.agents-io/e2e   # 场景目录放在短路径下（Unix socket 路径须 < 104 字节；默认系统临时目录）
```

场景运行器在 `packages/daemon-e2e`（`@agents-io/daemon-e2e`，私有包，bin `aio-e2e`），不在守护进程的生产包里：它在运行时要用 testkit 的 `FakeChannel` 和 Codex harness（瘦身 P0，`docs/design/core-slimming/` §4）。选项与输出同原来的 `aio e2e`；现在 `aio e2e` 只提示改用 `pnpm e2e` / `aio-e2e`，退出码 2。`pnpm e2e` 在 `packages/daemon-e2e` 目录里运行（原来是 `packages/daemon`），相对的 `--config`、`--env-file` 和默认的 `./aio.config.json` 按这个目录找；用 `$AIO_CONFIG` 或绝对路径就不受影响。

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
| r | task-run | 宿主协议：带 token 的连接 `run.start` 一个 `mode: task` agent（默认实例、`bypass`），`env` 里的值只进子进程：shell 里 `echo` 出来的值出现在回答里，日志里只出现在工具输出和回答中；`run.ended` 退出码 0，带宿主给的 `inputId` 与 `correlation`、`turnId`、`durationMs`（harness 报了用量就带 `usage`），session `run:<id>` 关闭；同一 runId 再 start 直接报告结果，与 `run.ended` 是同一帧；交互 agent 被拒（`not_task_agent`） |
| m | output-ask-choice | 输出工具：模型调 `ask_choice` → 通道上出现 red/blue 按钮（`choice:` action id），该轮结束；模拟点击 blue → 新一轮的输入是 `choice` 事件，回答含 blue；`delivery.settled` delivered；报告 harness 在 `_meta` 里带了哪些键 |
| n | output-send-file | 输出工具：工作目录里写 README.md，模型调 `send_file` → 通道收到附件，blob 字节与文件一致，delivery settled |
| o | output-terminal-choose | 输出工具：本地路由上 `ask_choice` 只写 `agents-io.output` 事件；`/choose <id> <n>` 等价的输入 → 新一轮回答含所选项；越界序号被拒（`bad_choice`） |
| p | topic-rotate | 话题（决定 6）：主人私聊先说 A（Rust GPX 工具、代号 BLUE-HERON-7），再问无关的 B（澳大利亚首都）→ agent 调 `session_rotate`，新话题 session（`<会话 key>#<topicId>`）以摘要为 context 接手这条消息并回答 Canberra；**重启守护进程**；再说"回到刚才 Rust GPX 命令行工具的话题：它的秘密代号是什么"→ B 里的 agent 调 `session_list` + `session_switch`，A 成为当前话题，A 的 session 用原生 id 续接并答出 BLUE-HERON-7；报告摘要里是否带了代号 |
| q | topic-command | 聊天命令：`/new Groceries` → 系统回复、新话题当前；下一条消息进新话题，卡片 `channelData["agents-io/topic"].title` 为 Groceries；`/topics` 列出两个（▶ 标当前）；`/switch 2` 回到第一个话题，回答记得第一个话题里的词（kiwi）而不是第二个的（mango）；命令本身不进 harness（共 3 个 turn） |

**m、n、o、p 需要输出工具**：输出工具默认关闭（决定 13），e2e 的场景 agent 跟随配置里默认 agent 的 `tools`（或顶层 `outputTools`）。示例配置 `aio.config.example.json` 的 `assistant` 已写 `"tools": true`；自己的配置没开时这四个场景显示 `SKIP output tools are off`。

**p 依赖模型（不稳定）**：是否调 `session_rotate` / `session_switch` 是模型自己的决定，p 不是确定性测试。实测（2026-10，`--data-dir ~/.agents-io/e2e`）：codex 默认模型 3/3；claude-code haiku 4/5、sonnet 1/4。失败都是模型没调工具、无工具报错：多数是 B 里直接答出了代号（轮换摘要里带了 A 的代号，模型就不切回），一次是根本没轮换、在 A 里答了 Canberra。p 失败时先看原因里的 `tools …: none`；q 不依赖模型的选择，应当每次通过。

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
aio run --agent executor --model <另一个模型> --effort low -- "reply with exactly: pong"   # stderr 的 started 行是这个模型与力度
aio run --agent executor --profile nope -- x                            # bad_override，退出码 2，什么都不起
aio run --agent executor --input-id try-in-2 --correlation job-7 -- x && aio explain try-in-2   # explain 带 run: { runId, correlation: "job-7" }
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
   npx github:Ghost-LZW/create-lark-bot#v0.2.3 --name "<name>" --avatar ./avatar.png \
     --preset messaging,contact --write-env .env.live \
     --env-owner-var AGENTS_IO_OWNERS --owner-prefix lark-bot:
   npx github:Ghost-LZW/create-lark-bot#v0.2.3 verify --live
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
- [ ] Codex `requestUserInput` / Claude Code `AskUserQuestion`：提问时出现独立表单卡片；填写并提交后，同一轮继续运行。让非指定人员提交应无效；无表单通道用提示里的 `/answer <问题代码> <答案>`。
- [ ] `/interrupt` 后卡片 finalize 为 `Interrupted`。
- [ ] Ctrl-C 停 serve 再启动：之前的 session 用 `session.bound` 里的原生 id 续接（claude `--resume` / codex `thread/resume`）。
- [ ] 表情回应（INVARIANTS RT-2；先在开放平台订阅 `im.message.reaction.created_v1` / `deleted_v1`，开 `im:message.reactions:read`、`im:chat:readonly` 并发布）：对机器人的一条回答点 👍 → 不开轮、卡片不动；`aio tail main` 里有一条 `input.admitted observe_only`，内容 `[event reaction] {"emoji":"THUMBSUP","action":"added",…}`；再私聊一句，这一轮的输入里它排在前面（context）。取消 👍 → 又一条 `"action":"removed"`。对自己发的消息点表情、机器人自己的确认表情（`ack`）都不出现。重启 serve 后对重启前的回答点表情：仍然交出（`im.v1.chat.get` 认出私聊）。群里对机器人在群里的回答点表情：进那个群的会话，同样只记录。
- [ ] 两个机器人（同一守护进程，决定 8；`policy.selfAccounts` 里**不写**对方）进同一个群，主人 @ 机器人 a 说一句：先核实飞书是否把 a 的回复卡片推给 b（b 的 `lark-bot:b:<群>` 会话日志里有没有那条 `input.admitted`）。推的话，那条输入应是 `self`、主体 `agent:<agent>`、`aio explain <它的 inputId>` 里 `cause.basis: "recovered"`、`hop: 1`；`aio explain --chain <它>` 走回主人那条消息（`end: "root"`）；b 不开轮（agent-messaging，INVARIANTS ID-8）。不推的话，在 ROADMAP §4"被外部条件挡住"记下结论。

### 1.4 手动：每会话 launch（决定 7，多租户）

自动 e2e 还没有这个场景（脚本化通道之外还要宿主回调或 `session.prepare`、两个已登录的配置目录），按下面手动跑。单元与集成测试覆盖了校验、固定、续接与泄漏检查（`packages/daemon/test/`）。

1. 准备两个租户：`/srv/t/ws/a`、`/srv/t/ws/b` 两个工作目录，各放一份内容不同的 `CLAUDE.md`（例如"你的口令是 APPLE-1" / "你的口令是 BANANA-2"）；`/srv/t/homes/a`、`/srv/t/homes/b` 两个 `CLAUDE_CONFIG_DIR`，各自登录一次（新配置目录是空的登录态，见"已知缺口"最后一条）。
2. 配置一个模板 agent：`sessionParams: { cwdRoots: ["/srv/t/ws"], envKeys: ["CLAUDE_CONFIG_DIR"], envPathRoots: { CLAUDE_CONFIG_DIR: ["/srv/t/homes"] } }`。
3. `aio serve`；用宿主连接（`host.hello` 带 token）确认结果的 `features` 含 `session.launch`，再对两个键 `session.prepare`：`tenant:a` → `{ cwd: "/srv/t/ws/a", env: { CLAUDE_CONFIG_DIR: "/srv/t/homes/a" } }`，`tenant:b` 同理。
   - [ ] 两次都 `created: true`；同值再 prepare 为 `created: false`；对 `tenant:a` 换 cwd 再 prepare → `launch_conflict`。
4. `aio attach tenant:a`、`aio attach tenant:b`，各问"你的口令是什么"。
   - [ ] a 答 APPLE-1，b 答 BANANA-2；问 a "BANANA 开头的口令是什么" 答不出。
   - [ ] 对话记录分别出现在 `/srv/t/homes/a/projects/…`、`/srv/t/homes/b/projects/…` 下，互不出现。
   - [ ] `aio sessions` 显示两个会话的 cwd 和 env 键 `CLAUDE_CONFIG_DIR`，不显示值；守护进程日志、`ps` 的 argv 里也没有值。
5. Ctrl-C 停 serve 再启动，两个会话各发一句"刚才的口令是什么"。
   - [ ] 各自用原生 id 续接（同一 cwd 与配置目录下），答出自己的口令。
6. （可选）在租户 a 的对话里 `/new` → 新话题仍在 `/srv/t/ws/a`、仍用 `/srv/t/homes/a`。

### 1.5 手动：进程外 harness（`use: "bridge"`）

自动测试（`harness/jsonl-bridge/test/`、`packages/daemon/test/harness-bridge.test.ts`；Python 例子在 e2e 层）用的是假程序；下面在真的守护进程上核对一遍，不需要外部账号。

1. 配置一个 bridge 实例并设为默认：`"harnesses": { "py": { "use": "bridge", "command": "python3", "args": ["<仓库>/harness/jsonl-bridge/examples/echo_harness.py"] } }, "defaultHarness": "py"`，`aio serve`。
   - [ ] 启动日志里没有错误；`ps` 里有 `echo_harness.py` 进程（启动时就拉起，问它声明什么）。
2. `aio attach`，说一句 hello。
   - [ ] 回答 `echo: hello`；`aio tail` 的 `turn.started` 里 `harness` 是 `py`。
3. 主人在对话里发 `/plan on`、`/compact`。
   - [ ] `/plan on` 答 `/plan is available only on Codex (this session runs bridge).`（例子没声明 Plan 模式）；`/compact` 答 `Compacting (queued behind anything running).`，随后一轮的回答是 `compacted`（例子声明了 `compact: { command: "/compact" }`）。
4. Ctrl-C 停 serve。
   - [ ] `echo_harness.py` 进程退出（例子没有 `detach`：先关会话，再 `shutdown`）。
5. 把 `command` 改成不存在的路径再 `aio serve`。
   - [ ] 启动失败，退出码 2，错误是 `harnesses.py (bridge): spawn … ENOENT`。

### 1.6 手动与 live：ACP agent（`use: "acp"`）

自动测试（`harness/acp/test/`：假 ACP agent `fake-agent.ts`，加上真实 agent 录下的 transcript 的回放；`packages/daemon/test/harness-acp.test.ts`）不连真模型。真实 agent 用 Claude Code 的 ACP agent，**装进一个一次性的目录，不全局安装**；配置目录用一个新的空目录，自己的 settings、skills、会话记录不会被读到或写进录制：

```sh
mkdir -p /tmp/acp-agents && cd /tmp/acp-agents && echo '{"private":true}' > package.json \
  && npm install --ignore-scripts @agentclientprotocol/claude-agent-acp@0.110.1
mkdir -p /tmp/acp-claude-config
export AIO_ACP_COMMAND=/tmp/acp-agents/node_modules/.bin/claude-agent-acp CLAUDE_CONFIG_DIR=/tmp/acp-claude-config \
  ANTHROPIC_BASE_URL=<模型网关> ANTHROPIC_AUTH_TOKEN=<key> ANTHROPIC_MODEL=<测试模型> ANTHROPIC_SMALL_FAST_MODEL=<测试模型> DISABLE_TELEMETRY=1
```

1. live 测试（要真模型，花钱，手动）：`AGENTS_IO_LIVE_ACP=1 npx vitest run --project live harness/acp`。
   - [ ] 一致性套件在真实 agent 上全部通过（一轮、steer 答 `unsupported`、`session/cancel` 后这一轮 `interrupted`、`close` 结束事件流、事件流合规，#HC-1）。
   - [ ] 第二条：同一会话在新的 agent 进程上经 `session/load` 续上，第二轮答得出第一轮让它记住的词（#RS-1），重放的历史不在事件流里。
2. 在真的守护进程上：配置 `"harnesses": { "acp": { "use": "acp", "command": "<上面的 claude-agent-acp>", "env": { "CLAUDE_CONFIG_DIR": "/tmp/acp-claude-config", "ANTHROPIC_BASE_URL": "…", "ANTHROPIC_AUTH_TOKEN": "env:MODEL_GATEWAY_KEY", "ANTHROPIC_MODEL": "…" }, "profiles": { "bypass": { "mode": "bypassPermissions" } } } }, "defaultHarness": "acp"`，`aio serve`，`aio attach`。
   - [ ] 说一句 hello：有回答；`aio tail` 的 `turn.started` 里 `harness` 是 `acp`；`ps` 里有 `claude-agent-acp`（第一次用到时才拉起）。
   - [ ] 第一轮之后主人发 `/plan on`：答 `Plan mode on from the next turn.`（会话的 `availableModes` 里有 `plan`，第一个会话打开之后才可用），下一轮 agent 只做计划、不改文件；`/compact` 答 `Compacting (queued behind anything running).`（agent 公布了 `compact` 命令），随后一轮的输入是 `/compact`。
   - [ ] 非主人（restricted，没配 `mode`：agent 打开时在 `auto`，这一轮之前 `session/set_mode` 到 `default`）让它跑一条命令：卡片上出现审批（Allow once / Deny），允许后命令执行。
   - [ ] 让它跑一条长命令（`sleep 30` 之后再回答）时主人发 `/stop`，随即再发一句别的：第一轮记 `interrupted`，第二轮的回答只有它自己的内容（#LN-2、#DL-3）。agent 15 s 内没停时，第一轮是 `cancel_timeout`，`aio tail` 里第二轮之前它还流出的只是 `native`，第二轮等它回答，至多再 15 s，还不回答就有一条 `continuity` 提示（关掉会话再打开）。
   - [ ] 同样让它跑长命令、`/stop`，它 15 s 内没停（第一轮 `cancel_timeout`）之后，主人发 `/preset <用另一个 harness 的预设>`、说一句（切走：ACP 会话关闭），再发 `/preset default`（或等停放话题空闲关闭，`topics.parkedIdleMs`），再说一句：这一轮的回答只有它自己的内容；agent 那时还没回答旧的 prompt 时，续接等它至多 15 s，还不回答就开新会话、有一条 `continuity` 提示（#LN-2、#DL-3）。
   - [ ] Ctrl-C 停 serve：`claude-agent-acp` 进程退出；再 `aio serve` 后发一条，回答接得上前面的对话（`session/load`），`aio tail` 里没有重放的旧消息。
3. 重新录 transcript（适配器写出的帧有意变了时；同样要真模型）：`node --experimental-transform-types --disable-warning=ExperimentalWarning --import ./scripts/source-loader.mjs harness/acp/scripts/record-transcripts.ts`，写进 `packages/testkit/conformance/transcripts/acp/`，再跑 `harness/acp/test/transcripts.test.ts`。2026-11-25 的录制：claude-agent-acp 0.110.1、模型 `gpt-6-sol`（AsterGate 的 Gemini Flash 当时答 503）。

## Tier 3：多端 + 重启

1. 默认实例是 codex 且 `transport: { kind: "unix", spawn: "own" }`（`aio serve --harness codex`；app-server 独立于网关进程运行，状态在 `~/.agents-io/codex.<实例名>`，旧 `harness` 块为 `~/.agents-io/codex`）。
2. 终端 A `aio serve`，终端 B、C 各 `aio attach`，飞书里也开着同一 session。
3. 发一个长任务（"Use the shell to run `sleep 30`, then reply with exactly: done"），看到 `▶ command` 后在 A 里 Ctrl-C。
   - [ ] B、C 打印 `[subscription ended]`；log 里这一轮**没有**结束事件（codex 是 detach，不是 close）。
4. 再 `aio serve`；B、C 用 `aio attach --from <最后的 seq>` 重连。
   - [ ] 日志 `reopened to adopt turn …`；终端看到 `── turn … adopted after restart`，随后 `completed`，答案 `done`。
   - [ ] 飞书卡片：重启后 compositor 不接管旧卡片（见缺口），答案只在终端/日志里。
   - [ ] 第 3 步 Ctrl-C 之前在飞书里再发一条（排在长任务后面）：停机时它记 `input.rejected lane_closed: gateway stopping`，飞书里收到 "This message was not processed: the agent stopped or restarted…"；被接管的那一轮的输入不受影响；重启后 `aio sessions` 的排队数为 0。
5. claude-code 下重复第 3 步：停网关会 interrupt 当前轮，应记为 `interrupted`，它的输入记 `input.rejected interrupted`（卡片显示 Interrupted，不另发提示）；排队中的消息同第 4 步收到提示。重启后下一次输入续接同一 claude 会话。若进程被 kill -9，log 里残留的未结束 turn 在下一轮开始前被记为 `ambiguous`（`host_restarted`），它没被消费的输入记 `input.rejected host_restarted`；排队中的输入在启动时即记 `input.rejected host_restarted`（不发提示，日志里没有路由）。
6. 把默认实例的命令改成不存在的路径后发一条消息：飞书里收到 "This message was not processed: the agent could not start…"（`start_failed`），不是一片沉默。

## 已知缺口

- Outbox 存储在内存：重启后不记得已投递的 operationId，compositor 也不 `reconcile` 旧卡片、不接管被 adopt 的 turn 的卡片。
- 邮件通道的 `MailStore`（IMAP 检查点）在内存：重启后从当前位置重新建基线。
- 本地 socket 上所有连接都是同一个本地主体；没有每连接鉴权。
- `control` 命令（set_model 等）lane 尚未实现，返回 `unsupported`。
- 没有 host MCP 工具（reply/send_file），agent 只能通过本轮回复路由输出。
- 默认策略每轮都选 `defaultHarness`；按输入换实例要自己写 `Policy.plan`（本地端/通道还没有"切实例"命令，`control set_model` 也未实现）。
- 新 `configDir` / `CODEX_HOME` 是空的登录态：claude 报 `Not logged in · Please run /login`，codex 报 401，需要在该目录里各自登录一次（`CLAUDE_CONFIG_DIR=… claude` 后 `/login`；`CODEX_HOME=… codex login`），或给实例配 API key / 网关的 `env`。
