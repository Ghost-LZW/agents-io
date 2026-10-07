# harness 子进程环境变量继承（inheritEnv）

> 状态：提案（2026-10-07，按维护者评审修订），待决定。决定后由维护者记入 `docs/design/locus/DECISIONS.md`；本文不改动该文件。

## 1. 一句话

**给每个 harness 实例加一个配置项 `inheritEnv: 'all' | 'none' | string[]`，决定守护进程自己的 `process.env` 有哪些变量传给 harness 子进程。** Claude Code 与 Codex 两个适配器都支持。第一版默认仍是 `'all'`，行为不变，但启动时点名列出 harness 子进程能看到的渠道密钥；下一版把默认改为 `'none'`（只保留一组最小基础变量），并记入 DECISIONS。

## 2. 问题

### 2.1 现状（代码）

两个适配器构造子进程环境时，最底层都是守护进程完整的 `process.env`：

| 位置 | 做法 |
|---|---|
| `harness/claude-code/src/adapter.ts:126-139`（`childEnv`） | `process.env` < `CLAUDE_AGENT_SDK_CLIENT_APP` < `config.env` < `CLAUDE_CONFIG_DIR` < 每次 open 的 `options.env`；值为 `undefined` 的键删除 |
| `harness/codex/src/harness.ts:114-118`（`codexEnv`） | `process.env` < `opts.env` < `CODEX_HOME`；同样删除 `undefined` |

守护进程把实例配置原样交给适配器：`gateway.ts:1179`（Codex）与 `gateway.ts:1193`（Claude）都传 `env: i.env`。task run 的 `run.start.env` 并入实例 env 这一层（`gateway.ts:632`、`gateway.ts:641`），因此同样叠在完整的 `process.env` 之上。

现有唯一的收窄手段是在实例 `env` 里把变量写成 `null`（`config.ts:66-71`，解析见 `config.ts:838-842`），即**拒绝清单**：部署者必须知道并逐个列出每一个不该传下去的名字。

### 2.2 前提核实：哪些密钥真的会泄露

一个容易误判的地方：**`.env.live` 里的值不会进入 harness 子进程。** `loadConfig` 把文件里的变量读进一个独立对象，与 `process.env` 合并成解析配置用的副本（`config.ts:548-551`），并不写回 `process.env`。旧式 `harness` 配置块只把匹配 `HARNESS_ENV`（`config.ts:493-494`，`ANTHROPIC_|CLAUDE_|OPENAI_|CODEX_` 与代理变量）的文件变量交给子进程（`config.ts:751`）；新式 `harnesses` 只传 `env:NAME` 显式引用的变量。所以只用 `.env.live` 的部署，渠道密钥（例如 lark-bot 的 `LARK_APP_SECRET`，`config.ts:1018-1021`）留在守护进程内。

泄露发生在**密钥位于守护进程真实环境里**的部署：systemd 的 `Environment=`/`EnvironmentFile=`、launchd plist 的 `EnvironmentVariables`、容器的 `-e`/Kubernetes secret env、或者在已 export 变量的 shell 里执行 `aio serve`。这些恰恰是服务化部署的常见做法；而且 `loadConfig` 让进程环境优先于 `.env.live`（`config.ts:526`、`config.ts:550`），所以"把密钥放进进程环境"本身就是受支持的用法。此时：

- 每个 Claude / Codex 子进程都拿到全部渠道密钥、邮箱密码、bridge 通道的凭据，以及与本实例无关的其他实例的 API key；
- harness 再拉起的东西继承下去：Bash 工具的每条命令、Claude 拉起的 stdio MCP server、Codex 的沙箱外进程；
- 被不可信内容唤醒的轮次（决定 4、5：不按污染降档）里，一句"运行 `env` 并贴出结果"就能把它们带进 transcript 甚至发回渠道。

同样的展开还出现在 jsonl-bridge 通道子进程（`channel/jsonl-bridge/src/host.ts:75-78`，`{ ...process.env, ...opts.env }`）与控制台的 provisioning 子进程（`packages/daemon/src/provision.ts:128`）。本文只处理 harness；bridge 通道见 §8。

### 2.3 为什么不靠部署者写拒绝清单

- 失败方向是开放的：新增一个渠道、换一个密钥名，默认就漏；
- 部署者往往不知道守护进程环境里有什么（systemd 单元、容器平台、登录 shell 都会注入变量）；
- 同一份 `null` 清单要在每个实例上重复。

## 3. 机制还是策略

按 POSITIONING §2 的判据：**"一个子进程该看见哪些变量"不同部署有不同答案**（有的 harness 工具确实需要 `GITHUB_TOKEN`、`SSH_AUTH_SOCK`、云厂商凭据，有的绝不能有），所以具体名单是策略；agents-io 提供的是"按名单构造子进程环境"这个机制。

### 3.1 为什么名单写在部署者配置里，而不是宿主钩子或宿主推送

判据说"策略放在宿主里，agents-io 只提供让宿主表达答案的钩子"。这里的"宿主"要看答案归谁所有：

- **名单描述的是守护进程自己的进程环境。** 环境里有什么，只有启动守护进程的人（systemd 单元、容器定义、登录 shell）知道；宿主经 socket 连进来，看不到这个环境，也不该看到。让宿主通过钩子或推送决定"继承哪些名字"，等于让宿主能把守护进程环境里的任意密钥拉进子进程，这是在扩大宿主的能力，而不是表达宿主的答案。
- **宿主已有表达自己答案的通道。** 宿主要给某次运行额外的变量，用 `run.start.env`（显式层，§5.3），值由宿主自己提供，不依赖守护进程环境。本提案不改它，`inheritEnv` 也不过滤它。
- **与现有的划分一致。** 权限 profile 的内容（`profiles`：名字 → harness 原生设置，`config.ts:46`、`:76`）、harness 实例的 `env`、`configDir` / `home` 都是部署者写在配置里的"怎么跑"；宿主只在 `plan` / `run.start.overrides` 里选用其中之一。`owners` 也是同样处理：无宿主时由本地配置给出最简形式，有宿主时宿主推送映射（决定 3）。`inheritEnv` 属于前一类：它是实例怎么启动的一部分，宿主选实例，不改实例。

### 3.2 内置集合是默认值，不是 agents-io 替宿主做的决定

§5.1 的基础集与 harness 必需集，地位与 POSITIONING §4 的默认 `Policy`（"只认配置里列出的主人"、"主人的轮次用 `bypass`"）相同：只覆盖"一个人自己用"能跑起来所需的最小集合，部署者可以用 `'all'` 或 `string[]` 完全改写。必需集只回答"这个 harness 本体启动、登录、走代理需要什么"，这是适配器对它所驱动的程序的知识（与 `HARNESS_ENV`，`config.ts:493-494`，同一性质），不涉及"某个工具该不该拿到某个凭据"。后者永远由部署者列出。

### 3.3 与已有决定的关系

- **决定 3**：字段挂在 harness 实例上，与主体无关；agents-io 不因此认识任何用户。
- **决定 4、5**：不按轮次来源收紧或降档。名单是实例级的静态配置，不随上下文变化，所以不违反"不降档"。它补的是决定 5 承认的代价：既然被污染的轮次照常以原 profile 运行，进程边界上就不该再多给它一份与任务无关的密钥。
- **决定 6**："工作区属于 agent 的运行配置"。环境变量同理，属于实例（"怎么跑"）的配置，由部署者写，不由宿主推送，不经协议帧。
- **POSITIONING §3 分层**：harness 适配器可脱离守护进程单独使用，所以字段与过滤逻辑都放在适配器里，守护进程只透传；库用户同样受益。

## 4. 方案比较

| 方案 | 做法 | 优点 | 缺点 |
|---|---|---|---|
| A. 维持现状 + 文档 | 文档建议用 `env:{X:null}` | 零代码 | 拒绝清单，失败方向开放（§2.3） |
| B. 内置密钥名启发式拒绝 | 按 `SECRET` 一类正则（参照 `harness/codex/src/harness.ts:142`）剔除 | 部署者无需配置 | 必然漏（`LARK_APP_SECRET` 能命中，`SMTP_PASS`、`DATABASE_URL` 不能）；误删也无从解释 |
| C. 拆分守护进程（渠道进程与 harness 进程分开） | 渠道密钥只在渠道进程 | 进程级隔离 | 大改架构；同一 uid 下仍可读文件，收益与 D 相同 |
| **D. 允许清单 `inheritEnv`（推荐）** | 实例选项，`'none'` 时只继承基础变量 + harness 必需变量 + 部署者列出的名字 | 失败方向关闭；一个字段；与通行做法一致（systemd 只传 `PassEnvironment=` 列出的变量、sudo 的 `env_reset` + `env_keep`、GitHub Actions 的 secret 只在步骤显式写进 `env:` 时才可见） | 默认翻转是破坏性变更，需要分两版（§7） |

推荐 D，B 的正则只用于启动警告里的"可能还有"提示，不做过滤。

## 5. 设计

### 5.1 字段

```jsonc
"harnesses": {
  "claude": { "use": "claude-code", "inheritEnv": ["GITHUB_TOKEN", "SSH_AUTH_SOCK"], "env": { "ANTHROPIC_API_KEY": "env:ANTHROPIC_API_KEY" } },
  "codex":  { "use": "codex", "inheritEnv": "none" }
}
```

- `'all'`：继承全部 `process.env`（今天的行为）。
- `'none'`：只继承**最小基础集** + **该 harness 的必需集**。
- `string[]`：`'none'` 的集合再加上列出的名字；以 `*` 结尾的项按前缀匹配（如 `"AWS_*"`）。
- 放在 `InstanceCommon`（`config.ts:66-80`），两种实例都有；旧式 `harness` 块也接受同名字段。
- 适配器层：`ClaudeCodeHarnessConfig.inheritEnv`、`CodexHarnessOptions.inheritEnv`，语义相同；守护进程透传。

最小基础集（两种 harness 共用）：`PATH HOME USER LOGNAME SHELL LANG LC_* TZ TMPDIR TERM`。`SHELL` 是 Bash 工具需要的，`TZ` 影响时间显示，其余是进程正常运行的常规变量。

harness 必需集：

| harness | 变量 |
|---|---|
| claude-code | `ANTHROPIC_*`、`CLAUDE_*`、`HTTP_PROXY HTTPS_PROXY NO_PROXY ALL_PROXY`（含小写）、`NODE_EXTRA_CA_CERTS SSL_CERT_FILE SSL_CERT_DIR` |
| codex | `OPENAI_*`、`CODEX_*`、上述代理与证书变量 |

这与 `HARNESS_ENV`（`config.ts:494`）的取向一致，只是按 harness 分开。走 Bedrock / Vertex 的部署需要的 `AWS_*`、`GOOGLE_APPLICATION_CREDENTIALS` 不在必需集里，由部署者显式列出。基础集与必需集以常量导出，写进文档，变更算破坏性变更。

### 5.2 配置里点名的变量自动继承

有些设置不带值，而是**写一个变量名，让子进程从自己的环境里读**。`'none'` 下这些变量若不在名单里，就会静默缺失（认证失败或 MCP server 起不来），而部署者未必意识到两者有关。这类设置有：

| harness | 设置 |
|---|---|
| codex（`config`，即 `-c`） | `model_providers.<id>.env_key`、`mcp_servers.<id>.bearer_token_env_var`、`mcp_servers.<id>.env_vars`、`…env_http_headers.<H>` 的值 |
| claude-code（`mcpServers`） | 字符串里的 `${VAR}` / `${VAR:-默认}`（CLI 在 command、args、env、url、headers 里展开，`config.ts:910`） |

处理：**适配器把自己的启动设置里点名的变量自动并入继承集。** 这是机制而非猜测：名字是部署者自己写进配置的，显式即授权（与 §5.3 同一原则）。

- 由适配器计算（导出纯函数 `namedVariables`：Claude 扫 `mcpServers`，Codex 扫 `config`），库用户同样适用；守护进程不另算。
- 只影响 `'none'` / `string[]`；`'all'` 本来就全部继承。
- 只取 `process.env` 里已有的；值从不读取或记录。
- 守护进程把 `"env:NAME"` 改写成点名设置时（`codexConfigViaEnv`，`config.ts:961`；`claudeMcpViaEnv`，`config.ts:911`），值已经经 `toChild` 放进显式层（`config.ts:853-856`），不依赖本节；本节补的是部署者**直接写字面变量名**的情形。
- `${AGENTS_IO_MCP_TOKEN}` 由适配器自己写入 env（`adapter.ts:180`），本来就在显式层。
- 控制台已经把这些键识别为"点名变量、本身不是密钥"（`console-config.ts:31-32` 的 `NAMES_A_VARIABLE`），两处的键表应保持一致；实现时把 Codex 一侧的键表与 `harness.ts:144` 的 `ENV_REF` 放在同一处维护。
- **看不到的地方**：`CODEX_HOME/config.toml`、`CLAUDE_CONFIG_DIR` 下的 settings、项目里的 `.mcp.json` 不经 aio 配置，适配器不去解析。这些点名的变量需要部署者列进 `string[]`；§7 与 N+1 的 info 行都写明这一点。

### 5.3 优先级（只改最底层，其余不变）

```
process.env 经 inheritEnv 过滤  <  实例 env（含 run.start.env）  <  configDir / home（CLAUDE_CONFIG_DIR / CODEX_HOME）  <  每次 open 的 env（Claude options.env）
```

- `inheritEnv` **只过滤从 `process.env` 继承的那一层**。实例 `env` 里显式写的值（包括 `env:NAME` 引用）、`run.start.env`、`options.env`、适配器自己加的变量（`AGENTS_IO_MCP_TOKEN`，`adapter.ts:180`；`AGENTS_IO_RUN_ID` / `AGENTS_IO_TURN_PROVENANCE`，`gateway.ts:632`）都照常进入。显式即授权。
- 值为 `null` 的拒绝位置不变：它在实例 env 这一层（`config.ts:841` 把 `null` 解析为 `undefined`），不在最上层。它能删掉被继承的变量，但其上的层可以把它放回：Claude 侧的 `CLAUDE_CONFIG_DIR` 与每次 open 的 `options.env`（`adapter.ts:128-134`），Codex 侧的 `CODEX_HOME`（`harness.ts:116`）；task run 的 `run.start.env` 并入同一层且在实例 env 之后（`gateway.ts:641`），同样能覆盖。本提案不改这一点；有了 `inheritEnv` 之后，`null` 主要用于删掉基础集或必需集里的个别名字。`CLAUDE_CODE_RESUME_INTERRUPTED_TURN` 照旧在所有层合并之后删除（`adapter.ts:135-136`）。
- 说明：今天 `run.start.env` 位于 `CLAUDE_CONFIG_DIR` / `CODEX_HOME` **之下**（`gateway.ts:641` 后再经 `adapter.ts:132` / `harness.ts:116` 覆盖），即 task run 不能改写实例的配置目录。本提案保持这一顺序。将来若引入按会话的 env（另案讨论），也属于显式层，不受 `inheritEnv` 过滤。
- **依赖替换语义**：过滤有效的前提是 harness 把收到的 env 当作子进程的完整环境，而不是叠在自己的 `process.env` 上。Claude Agent SDK 给了 `env` 就用它替代 `process.env`（sdk 0.3.291 中 `env ? {...env} : {...process.env}`）；Codex 的 `spawnTransport` 直接把 env 传给 `spawn`。SDK 若改成合并语义，过滤会静默失效，所以 §9 的 e2e 哨兵测试是必需项，不是可选项。

### 5.4 Codex 的服务器形态

Codex 的 app-server 未必由本次 open 拉起，`inheritEnv` 只在 agents-io 自己启动服务器时有意义：

| transport | 处理 |
|---|---|
| `stdio`（含 task run 专用的 stdio，`gateway.ts:637-643`） | 生效 |
| `unix` + `spawn: "own"` | 生效；**但必须进启动指纹**：今天的指纹只含二进制、`CODEX_HOME` 与 `-c` 参数（`harness/codex/src/harness.ts:206`），已在运行的服务器会被直接复用（`harness/codex/src/unix.ts:172-180`）。不改的话，改了 `inheritEnv` 后重启守护进程仍连回旧的、继承了全部环境的服务器。见下文"指纹"。 |
| `unix` + `spawn: "daemon"` / `"none"` | 服务器整机共享（`unix.ts:241-246` 的说明）。`spawn: "daemon"` 时 `startDaemon(bin, env)`（`harness.ts:208`、`unix.ts:246`）确实会把 aio 构造的环境传给 `codex app-server daemon start`，但该命令是幂等的：**谁先启动共享服务器，谁的环境生效；已在运行的共享服务器忽略我们的环境**。`"none"` 则完全不由 aio 启动。所以 aio 无法保证它的环境。`inheritEnv` 取 `'all'` 以外的值时配置报错，与 `config/enable/disable` 的现有检查同一处、同一措辞（`config.ts:869-872`）。 |

**指纹。** 只加入**配置决定的、跨重启稳定的**东西，绝不加入继承来的变量名：

- 加入：`inheritEnv` 的规范化取值（`'all'` / `'none'` / 排序去重后的名单），以及显式层的**变量名**排序列表（实例 env 的键与 `CODEX_HOME`；不含值）。§5.2 的点名变量来自 `-c` 参数，已在指纹里，不另加。
- 不加入：从 `process.env` 继承来的名字。`'all'` 下最终环境就是守护进程的整个 `process.env`，它的名字集合在两次启动之间本来就会变（`SHLVL`、`OLDPWD`、`TERM_SESSION_ID`，systemd 启动与交互启动的差异）；而 `ensureOwnServer` 在指纹不一致时直接报错而不是重启（`unix.ts:172-176`），把它们放进指纹会让一个配置未变的 `spawn: own` 部署在普通重启后就开始报"`kill <pid>`"。`'none'` 下的 `LC_*`、`TERM` 同理。
- 错误文本（`unix.ts:175`）今天只列"binary, CODEX_HOME or -c/--enable/--disable"，改为同时列出 `inheritEnv` 与实例 env 的变量名。
- 这同时修好"在实例 env 里增删变量不触发重启"的同类问题；只改值不触发，与今天一致。

### 5.5 启动警告（第一版）

守护进程知道自己的配置引用了哪些变量：lark-bot 的 `LARK_APP_ID` / `LARK_APP_SECRET`、mail 与 bridge 配置里的 `env:NAME`、每个实例 env 里的 `env:NAME`。`resolveConfig` 把这些名字（只有名字）记进解析后的配置；网关构造时（`gateway.ts:208-217` 已有的启动检查处），对每个 `inheritEnv` 为 `'all'` 的实例，计算"在 `process.env` 中存在、且被渠道或**其他**实例引用"的名字，输出一条 warn：

```
[aio] warn: harness instance claude inherits the daemon environment (inheritEnv 'all', the current default);
            it can read channel secrets LARK_APP_SECRET, MAIL_PASS and instance codex's OPENAI_API_KEY.
            Set inheritEnv: 'none' (or list the names it needs). The default becomes 'none' in the next release.
```

- 只列名字，从不打印值（与 `config.ts` 的"错误信息只点名、不带值"一致）；
- 只来自 `.env.live` 的变量不列（它们本来就不会传下去，§2.2）；
- 另起一行给出启发式计数："另有 N 个名字形似密钥的变量（如 `GITHUB_TOKEN`）"，只列名字，不做过滤；
- 显式写了 `inheritEnv: 'all'` 的实例只保留密钥清单，不再提示默认值将变。

### 5.6 文档必须写明：这不是沙箱

`inheritEnv` 只消除**被动暴露**：环境被工具、子进程、崩溃报告、`env` 输出顺带带走。同一 uid 下，harness 仍然可以读到：

- `.env.live`（0600，但属主就是同一个用户）；
- `<socket>.token`（`packages/daemon/src/token.ts:9`），拿到它就能以宿主身份说话；
- SQLite 日志（transcript 与工具输出）以及磁盘上的其他文件。

真正的隔离（另一个 uid、容器、macOS sandbox-exec、bubblewrap 等）是部署者的事。HOSTS.md 与配置参考里都写这一段。

## 6. 对协议、schema 与配置的影响

- **协议（`@agents-io/protocol`）**：无新帧、无新字段。`run.start.env` 语义不变（本来就"只进子进程环境"，HOSTS.md 的 `run.start` 一行）。
- **配置 schema**：`InstanceCommon` 加可选 `inheritEnv`；旧式 `harness` 块的 `claude-code` / `codex` 段同样加。新增校验：`inheritEnv` 的名字须满足 `VAR_NAME` 或"`VAR_NAME` 前缀 + `*`"；Codex `spawn` 为 `daemon` / `none` 时只允许 `'all'`。
- **适配器 API**：`ClaudeCodeHarnessConfig`、`CodexHarnessOptions` 加 `inheritEnv`；导出两个常量（基础集、各 harness 必需集）与一个纯函数 `inheritedEnv(source, inheritEnv, required)`，`childEnv` / `codexEnv` 用它代替 `...process.env`。适配器默认值与守护进程默认值同步翻转。
- **控制台**：不需要改。`console-config.ts` 没有逐字段白名单：哪些字段是凭据由 `isCredential` 按路径判断（`console-config.ts:10-26` 的说明，实现见 `:50-85`），形状由 TypeBox schema 校验，所以 `InstanceCommon` 加上 `inheritEnv` 即可编辑。已核对 `inheritEnv: ["GITHUB_TOKEN", …]` 不会被当成凭据：路径 `harnesses.<id>.inheritEnv.<i>` 不命中 `env` / `mcpServers.*.env` / `settings.env` / `config` / `headers` 任何一支；落到兜底的"密钥形键名"时取的是最近的字符串键 `inheritEnv`，不匹配 `SECRET_KEY`（`console-config.ts:29`）。数组里的值是名字，不是值，不会被替换成 `ADMIN_REDACTED`。`console.test.ts` 加一个往返用例（§9）。
- **代码注释**：`InstanceCommon.env` 的说明（`config.ts:67`，"over the gateway's own"）落地时改为"over the inherited environment (see inheritEnv)"。
- **不涉及**：Binding 表、宿主身份映射、Policy 钩子、session 日志格式。

## 7. 迁移

1. **版本 N**：加字段，默认 `'all'`；§5.5 的启动警告；§5.2 的点名变量自动继承；Codex 指纹扩展。指纹的输入变了，所以升级后第一次启动时已在运行的 `spawn: own` 服务器会报一次"启动设置不同"，`kill` 一次即可，在变更说明里写明；此后配置不变就不会再报（指纹不含继承来的名字，§5.4）。
2. **版本 N+1**：默认改为 `'none'`，记入 DECISIONS。启动时若检测到旧行为可能被依赖（实例未显式写 `inheritEnv`，而 `process.env` 中存在基础集与必需集之外的变量），输出一次 info，列出被丢弃的名字，便于部署者补进 `string[]`。名单最多列 20 个，其余只给计数（systemd 或登录 shell 下这一行会很长），密钥形的名字排在前面。info 行另外提醒：`CODEX_HOME/config.toml`、`CLAUDE_CONFIG_DIR` 下的 settings 与项目 `.mcp.json` 里点名的变量 aio 看不到（§5.2），需要手动列出。
3. 需要旧行为的部署只需写 `"inheritEnv": "all"`，不必等版本。

受影响最大的是依赖环境里现成凭据的工具用法（`gh` 读 `GITHUB_TOKEN`、`git` 走 `SSH_AUTH_SOCK`、云 CLI 读 `AWS_*`）。这些都应当显式列出，这正是本提案的目的。aio 配置里直接写了变量名的 `env_key`、`bearer_token_env_var`、`env_vars`、`${VAR}` 不受影响（§5.2）；aio 配置之外的 harness 配置文件里点名的变量需要部署者列出。

## 8. 范围外与后续

- **jsonl-bridge 通道子进程**（`channel/jsonl-bridge/src/host.ts:75-78`）同样继承全部环境，会拿到 harness 的 API key 与其他渠道的密钥。可以在 `channels[]` 的 bridge 项上加同形字段；建议另起一项，在 harness 这一项落地、默认值翻转之后跟进，基础集复用。
- **provisioning 子进程**（`provision.ts:128`）运行的是部署者配置的受信任工具，且本来就要写凭据文件，不处理。
- **按会话的 env**（若另案引入）：属于显式层（§5.3），不受本项影响；对共享一个 app-server 的 Codex 形态，那一项需要单独声明不支持。

## 9. 测试

单元（不需真实 harness）：

- `harness/claude-code/test/claude-code.test.ts`：用伪 `query`（`fake-query.ts`）捕获传给 SDK 的 env，覆盖：`'all'` 与今天逐键相同；`'none'` 只含基础集 + 必需集 + 显式层；`string[]` 精确名与前缀名；实例 env、`options.env`、`CLAUDE_CONFIG_DIR`、`AGENTS_IO_MCP_TOKEN` 不被过滤；`null` 仍删除，且 `options.env` 能放回被 `null` 删除的变量（§5.3 所述位置）；`probe()` 用同一过滤后的环境；`'none'` 下 `mcpServers` 里字面写的 `${MY_MCP_KEY}` 使 `MY_MCP_KEY` 被继承，未被点名的不继承。
- `harness/codex/test/codex.test.ts`：`codexEnv` 同一组用例；`CODEX_HOME` 仍胜过 `env.CODEX_HOME`；`'none'` 下 `config` 里字面写的 `model_providers.x.env_key`、`mcp_servers.y.bearer_token_env_var`、`mcp_servers.y.env_vars` 所点名的变量被继承。
- `harness/codex/test/unix.test.ts`：`spawn: own` 下改 `inheritEnv` 或实例 env 的变量名，指纹不同 → 报"启动设置不同"错误，文本点名 `inheritEnv` 与实例 env；只改值不改名 → 指纹相同（值不进指纹）；**`'all'` 下 `process.env` 的名字集合不同（多一个 `SHLVL`、少一个 `OLDPWD`）→ 指纹相同**，`'none'` 下同理。
- `packages/daemon/test/config.test.ts`：schema 接受三种取值与旧式块；拒绝非法名字；`spawn: daemon/none` + `'none'` 报错且措辞点名实例；解析结果记录被引用的变量名而不含值；`env:NAME` 写在 `bearer_token` 上时 `NAME` 仍经显式层到达子进程（不依赖 §5.2）。
- `packages/daemon/test/console.test.ts`：含 `inheritEnv: ["GITHUB_TOKEN", "AWS_*"]` 的配置 GET 后原样显示（不出现 `ADMIN_REDACTED`），PUT 回去不报 `inline_secret`，文件内容不变。
- `packages/daemon/test/gateway.test.ts`：给定 `process.env` 含 `LARK_APP_SECRET`（来自进程环境）与另一个只在 `.env.live` 的密钥，启动警告只列前者、不含任何值；显式 `'all'` 不出现"默认将变"字样。
- `packages/daemon/test/runs.test.ts`：`'none'` 实例上的 task run，`run.start.env` 与 `AGENTS_IO_RUN_ID` 仍到达子进程（Codex 走 per-run stdio）。

e2e（`aio e2e`）：在 `'none'` 下跑一遍默认场景，确认登录、代理与 MCP 输出工具都正常；再加一个场景让 agent 执行 `env`，断言输出里没有守护进程环境中预置的哨兵变量。后者同时守住 §5.3 的替换语义前提，SDK 升级时必须通过。

## 10. 待定

1. `'none'` 这个名字其实带基础集，是否改叫 `'minimal'`？本文沿用 `'none'`，在文档里写清；若改名，在 N 版就定下来，避免两次迁移。
2. 基础集是否加入 `XDG_*`（部分 CLI 依赖它定位配置）与 `AIO_SOCKET` / `AIO_CONFIG`（agent 在 Bash 里调用 `aio` CLI 时需要）。倾向不加：前者由 `configDir` / `home` 覆盖，后者由部署者按需列出。
3. 启发式"形似密钥"计数是否值得保留，还是只给精确清单。倾向保留一行，因为守护进程环境里最常见的泄露（`GITHUB_TOKEN` 一类）并不被任何配置引用。
4. Windows：若支持 Windows，基础集需要加 `SystemRoot PATHEXT USERPROFILE APPDATA LOCALAPPDATA COMSPEC TEMP TMP`（名字大小写不敏感，匹配也要不敏感）。目前未声明支持 Windows，第一版不加，支持时一并定下。
