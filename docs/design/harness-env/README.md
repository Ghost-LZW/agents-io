# harness 子进程环境变量继承（inheritEnv）

> 状态：提案（2026-10-07），待决定。决定后由维护者记入 `docs/design/locus/DECISIONS.md`；本文不改动该文件。

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

按 POSITIONING §2 的判据：**"一个子进程该看见哪些变量"不同部署有不同答案**（有的 harness 工具确实需要 `GITHUB_TOKEN`、`SSH_AUTH_SOCK`、云厂商凭据，有的绝不能有），所以具体名单是策略，写在部署者的配置里；agents-io 提供的是"按名单构造子进程环境"这个机制，以及一个安全的默认值。

它与已有决定的关系：

- **决定 3**：字段挂在 harness 实例上，与主体无关；agents-io 不因此认识任何用户。
- **决定 4、5**：不按轮次来源收紧或降档。名单是实例级的静态配置，不随上下文变化，所以不违反"不降档"。它补的是决定 5 承认的代价：既然被污染的轮次照常以原 profile 运行，进程边界上就不该再多给它一份与任务无关的密钥。
- **决定 6**："工作区属于 agent 的运行配置"。环境变量同理，属于实例（"怎么跑"）的配置，由部署者写，不由宿主推送，不经协议帧。
- **POSITIONING §3 分层**：harness 适配器可脱离守护进程单独使用，所以字段放在适配器选项里，守护进程只透传；库用户同样受益。

## 4. 方案比较

| 方案 | 做法 | 优点 | 缺点 |
|---|---|---|---|
| A. 维持现状 + 文档 | 文档建议用 `env:{X:null}` | 零代码 | 拒绝清单，失败方向开放（§2.3） |
| B. 内置密钥名启发式拒绝 | 按 `SECRET` 一类正则（参照 `harness/codex/src/harness.ts:142`）剔除 | 部署者无需配置 | 必然漏（`LARK_APP_SECRET` 能命中，`SMTP_PASS`、`DATABASE_URL` 不能）；误删也无从解释 |
| C. 拆分守护进程（渠道进程与 harness 进程分开） | 渠道密钥只在渠道进程 | 进程级隔离 | 大改架构；同一 uid 下仍可读文件，收益与 D 相同 |
| **D. 允许清单 `inheritEnv`（推荐）** | 实例选项，`'none'` 时只继承基础变量 + harness 必需变量 + 部署者列出的名字 | 失败方向关闭；一个字段；与 x-work-os 对检查命令采用的环境允许清单同构 | 默认翻转是破坏性变更，需要分两版（§7） |

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

### 5.2 优先级（只改最底层，其余不变）

```
process.env 经 inheritEnv 过滤  <  实例 env（含 run.start.env）  <  configDir / home（CLAUDE_CONFIG_DIR / CODEX_HOME）  <  每次 open 的 env（Claude options.env）
```

- `inheritEnv` **只过滤从 `process.env` 继承的那一层**。实例 `env` 里显式写的值（包括 `env:NAME` 引用）、`run.start.env`、`options.env`、适配器自己加的变量（`AGENTS_IO_MCP_TOKEN`，`adapter.ts:180`；`AGENTS_IO_RUN_ID` / `AGENTS_IO_TURN_PROVENANCE`，`gateway.ts:632`）都照常进入。显式即授权。
- 值为 `null` 的拒绝仍然有效，叠在最上面；`CLAUDE_CODE_RESUME_INTERRUPTED_TURN` 照旧总是删除（`adapter.ts:135-136`）。
- 说明：今天 `run.start.env` 并入实例 env 层，位于 `CLAUDE_CONFIG_DIR` / `CODEX_HOME` **之下**（`gateway.ts:641` 后再经 `adapter.ts:132` / `harness.ts:116` 覆盖），即 task run 不能改写实例的配置目录。本提案保持这一顺序，不借机改变。将来若引入按会话的 env（另案讨论），也属于显式层，不受 `inheritEnv` 过滤。

### 5.3 Codex 的服务器形态

Codex 的 app-server 未必由本次 open 拉起，`inheritEnv` 只在 agents-io 自己启动服务器时有意义：

| transport | 处理 |
|---|---|
| `stdio`（含 task run 专用的 stdio，`gateway.ts:637-643`） | 生效 |
| `unix` + `spawn: "own"` | 生效；**但必须进启动指纹**：今天的指纹只含二进制、`CODEX_HOME` 与 `-c` 参数（`harness/codex/src/harness.ts:206`），已在运行的服务器会被直接复用（`harness/codex/src/unix.ts:172-180`）。不改的话，改了 `inheritEnv` 后重启守护进程仍连回旧的、继承了全部环境的服务器。指纹加入 `inheritEnv` 取值与最终环境的**变量名**排序列表（不含值），不一致时按现有路径报错并提示 `kill <pid>`。顺带修好"改实例 env 不触发重启"的同类问题。 |
| `unix` + `spawn: "daemon"` / `"none"` | 服务器由他人启动、整机共享（`unix.ts:241-246` 的说明），agents-io 无法决定它的环境。`inheritEnv` 取 `'all'` 以外的值时配置报错，与 `config/enable/disable` 的现有检查同一处、同一措辞（`config.ts:869-872`）。 |

### 5.4 启动警告（第一版）

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

### 5.5 文档必须写明：这不是沙箱

`inheritEnv` 只消除**被动暴露**：环境被工具、子进程、崩溃报告、`env` 输出顺带带走。同一 uid 下，harness 仍然可以读到：

- `.env.live`（0600，但属主就是同一个用户）；
- `<socket>.token`（`packages/daemon/src/token.ts:9`），拿到它就能以宿主身份说话；
- SQLite 日志（transcript 与工具输出）以及磁盘上的其他文件。

真正的隔离（另一个 uid、容器、macOS sandbox-exec、bubblewrap 等）是部署者的事。HOSTS.md 与配置参考里都写这一段。

## 6. 对协议、schema 与配置的影响

- **协议（`@agents-io/protocol`）**：无新帧、无新字段。`run.start.env` 语义不变（本来就"只进子进程环境"，HOSTS.md 的 `run.start` 一行）。
- **配置 schema**：`InstanceCommon` 加可选 `inheritEnv`；旧式 `harness` 块的 `claude-code` / `codex` 段同样加。新增校验：`inheritEnv` 的名字须满足 `VAR_NAME` 或"`VAR_NAME` 前缀 + `*`"；Codex `spawn` 为 `daemon` / `none` 时只允许 `'all'`。
- **适配器 API**：`ClaudeCodeHarnessConfig`、`CodexHarnessOptions` 加 `inheritEnv`；导出两个常量（基础集、各 harness 必需集）与一个纯函数 `inheritedEnv(source, inheritEnv, required)`，`childEnv` / `codexEnv` 用它代替 `...process.env`。适配器默认值与守护进程默认值同步翻转。
- **控制台**：`console-config.ts` 的配置编辑若有字段白名单，加上 `inheritEnv`（不是密钥，不需脱敏）。
- **不涉及**：Binding 表、宿主身份映射、Policy 钩子、session 日志格式。

## 7. 迁移

1. **版本 N**：加字段，默认 `'all'`；§5.4 的启动警告；Codex 指纹扩展（会让一部分 `spawn: own` 的服务器在升级后报"启动设置不同"，提示一次 `kill` 即可，在变更说明里写明）。
2. **版本 N+1**：默认改为 `'none'`，记入 DECISIONS。启动时若检测到旧行为可能被依赖（实例未显式写 `inheritEnv`，而 `process.env` 中存在基础集与必需集之外的变量），输出一次 info，列出被丢弃的名字，便于部署者补进 `string[]`。
3. 需要旧行为的部署只需写 `"inheritEnv": "all"`，不必等版本。

受影响最大的是依赖环境里现成凭据的工具用法（`gh` 读 `GITHUB_TOKEN`、`git` 走 `SSH_AUTH_SOCK`、云 CLI 读 `AWS_*`）。这些都应当显式列出，这正是本提案的目的。

## 8. 范围外与后续

- **jsonl-bridge 通道子进程**（`channel/jsonl-bridge/src/host.ts:75-78`）同样继承全部环境，会拿到 harness 的 API key 与其他渠道的密钥。可以在 `channels[]` 的 bridge 项上加同形字段；建议另起一项，在 harness 这一项落地、默认值翻转之后跟进，基础集复用。
- **provisioning 子进程**（`provision.ts:128`）运行的是部署者配置的受信任工具，且本来就要写凭据文件，不处理。
- **按会话的 env**（若另案引入）：属于显式层（§5.2），不受本项影响；对共享一个 app-server 的 Codex 形态，那一项需要单独声明不支持。

## 9. 测试

单元（不需真实 harness）：

- `harness/claude-code/test/claude-code.test.ts`：用伪 `query`（`fake-query.ts`）捕获传给 SDK 的 env，覆盖：`'all'` 与今天逐键相同；`'none'` 只含基础集 + 必需集 + 显式层；`string[]` 精确名与前缀名；实例 env、`options.env`、`CLAUDE_CONFIG_DIR`、`AGENTS_IO_MCP_TOKEN` 不被过滤；`null` 仍删除；`probe()` 用同一过滤后的环境。
- `harness/codex/test/codex.test.ts`：`codexEnv` 同一组用例；`CODEX_HOME` 仍胜过 `env.CODEX_HOME`。
- `harness/codex/test/unix.test.ts`：`spawn: own` 下改 `inheritEnv` 或实例 env 的变量名，指纹不同 → 报现有的"启动设置不同"错误；只改值不改名 → 指纹相同（值不进指纹）。
- `packages/daemon/test/config.test.ts`：schema 接受三种取值与旧式块；拒绝非法名字；`spawn: daemon/none` + `'none'` 报错且措辞点名实例；解析结果记录被引用的变量名而不含值。
- `packages/daemon/test/gateway.test.ts`：给定 `process.env` 含 `LARK_APP_SECRET`（来自进程环境）与另一个只在 `.env.live` 的密钥，启动警告只列前者、不含任何值；显式 `'all'` 不出现"默认将变"字样。
- `packages/daemon/test/runs.test.ts`：`'none'` 实例上的 task run，`run.start.env` 与 `AGENTS_IO_RUN_ID` 仍到达子进程（Codex 走 per-run stdio）。

e2e（`aio e2e`）：在 `'none'` 下跑一遍默认场景，确认登录、代理与 MCP 输出工具都正常；再加一个场景让 agent 执行 `env`，断言输出里没有守护进程环境中预置的哨兵变量。

## 10. 待定

1. `'none'` 这个名字其实带基础集，是否改叫 `'minimal'`？本文沿用 `'none'`，在文档里写清；若改名，在 N 版就定下来，避免两次迁移。
2. 基础集是否加入 `XDG_*`（部分 CLI 依赖它定位配置）与 `AIO_SOCKET` / `AIO_CONFIG`（agent 在 Bash 里调用 `aio` CLI 时需要）。倾向不加：前者由 `configDir` / `home` 覆盖，后者由部署者按需列出。
3. 启发式"形似密钥"计数是否值得保留，还是只给精确清单。倾向保留一行，因为守护进程环境里最常见的泄露（`GITHUB_TOKEN` 一类）并不被任何配置引用。
