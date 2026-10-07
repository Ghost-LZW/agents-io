# 交互会话的启动参数（每会话 cwd/env）

> 状态：提案（2026-10-07，按维护者评审修订），待拍板。拍板结果由 owner 记入 `docs/design/locus/DECISIONS.md`，本文不改动它。本提案**需要修订决定 6 的一条**（§10 第 2 项），须 owner 明确同意。
> 依据：`docs/POSITIONING.md` §2（机制与策略的判据）、§6；`docs/design/locus/DECISIONS.md` 决定 1–6；`docs/HOSTS.md` §2–§5、§7；待定提案 `docs/design/harness-env`（`inheritEnv`）。代码以当前 `main`（e61a324）为准，下文引用的行号都已对照代码核实。

## 1. 一句话

**让宿主在部署方划定的范围内，为每个交互会话指定工作目录和子进程环境变量（`launch: { cwd?, env? }`）。** 这样一个"模板 agent"可以服务许多会话，每个会话落在自己的目录和配置目录里，不必为每个落地实例在配置里写一个 agent、改了再重启。task run 已经能逐 run 指定 `cwd`/`env`（`run.start`），本提案给交互会话补上对称的能力。

## 2. 问题

### 2.1 现状：一个 agent 的所有交互会话共用一个目录和一份环境

| 位置 | 代码 | 结果 |
|---|---|---|
| 建 lane | `packages/daemon/src/gateway.ts:558-560`：`agentFor` 选出 agent，`cwd = agent.cwd ?? 实例 cwd ?? 顶层 cwd` | cwd 只来自配置，按 agent 定，不按会话定 |
| agent 适配器 | `gateway.ts:598-606` `agentHarness`：按 agent 名缓存一个 `withAgent(...)` 适配器；lane 实际用的是 `harnessFor`（`gateway.ts:564`），它对 agent 自己的实例同样返回这个缓存 | 同一 agent 的所有会话共用一个适配器 |
| 实例环境 | `gateway.ts:1171-1206` `buildHarness`：`env`、`configDir`（Claude）、`codexHome`（Codex）在构造实例适配器时写死 | 同一实例的所有会话共用一份 env 和一个 `CLAUDE_CONFIG_DIR` / `CODEX_HOME` |
| 配置项 | `packages/daemon/src/config.ts:154-176` `AgentEntry`：`cwd` 是单值 | 想要 N 个目录，就要 N 个 agent 条目 |

对比 task run：`run.start` 带 `cwd`、`env`（`packages/protocol/src/host.ts:175-195`），`Runs` 校验 cwd 必须是存在的绝对目录、env 键必须是合法变量名（`packages/daemon/src/runs.ts:103-111`），`openRunLane` 为这一 run 单独构造适配器：`withAgent(own, agent, r.cwd)` 生成一个实例 cwd 就是 run cwd 的 `InstanceHarness`，env 放在实例 env 之上（`gateway.ts:627-645`），日志只记 env 的键（`runs.ts:144`）。交互会话没有对应的入口：路由回调的答复只有 `{ on, agent?, session? }`（`host.ts:419`、`packages/session/src/router.ts:104-109`）。

### 2.2 谁需要

不同部署对"这个对话在哪个目录、用哪个配置目录跑"有不同答案，下面都是同一个缺口：

- **按项目分的 bot**：一个"开发助手"模板，每个群或每个仓库对应一个工作目录。今天要么每个仓库一个 agent 条目，要么所有群挤在同一个目录里。
- **按话题分的 worktree**：同一仓库，每个对话（或每个话题）在自己的 git worktree 里改代码，互不踩踏。
- **多租户宿主**（举例）：宿主为每个用户（或每个"用户 × agent 定义"）维护一个 home：工作目录加独立的 `CLAUDE_CONFIG_DIR`，里面有该用户的 CLAUDE.md、设置、MCP 配置、对话记录。今天只能为每个落地实例生成一个 agent 和一个 harness 实例，新增就要改配置、重启守护进程。
- **有宿主的讨论会话**：例如 x-work-os 的讨论会话（0005 F）若希望 agent 在被讨论任务的工作目录里查看代码，也需要按会话给 cwd。这只是举例，本提案不为任何宿主特化。

## 3. 判据

- **POSITIONING §2**：会话在哪个目录、带哪些环境变量跑，不同宿主答案不同，所以是策略；agents-io 只提供让宿主表达答案的钩子，并负责把答案正确执行（建 lane、续接、重启后恢复）。这与 `run.start{cwd, env}` 是同一种分工，不引入新概念。部署方划定范围，宿主在范围内选值，守护进程执行并校验。
- **决定 2**：Binding 表的本地匹配仍是主路径。但 launch 只能来自回调答复（或 `session.prepare`），这意味着需要 launch 的部署会在主规则上开回调；若每条输入都回调，回调就成了事实上的主路径。§5.6 给出避免这一点的办法（键一旦固定，后续输入跳过回调），列入 §10 待拍板。
- **决定 3**：aio 不因此认识任何成员或 owner。`launch` 是一组值，aio 不解释它属于谁。
- **决定 6**：最后一条写的是"工作区属于 agent 的运行配置；一个项目对应一个工作区"。宿主按会话选 cwd **改变了这一条**：工作区不再只由 agent 配置决定。本提案把"是否允许、允许到什么范围"留在部署方对 agent 的配置里，但这仍是对已接受文字的修订，不是"保持归属"。拟议的新措辞见 §10 第 2 项。决定 6 另规定长期记忆不在 agents-io，本提案**不**提供按会话的指令或事实注入（§4 方案 G）；记忆照常通过 harness 原生文件进入：cwd 里的 CLAUDE.md / AGENTS.md，或 `env` 指定的 `CLAUDE_CONFIG_DIR` / `CODEX_HOME`。

## 4. 方案比较

| 方案 | 做法 | 好处 | 代价 |
|---|---|---|---|
| **A 每会话 launch 参数（推荐）** | 回调答复加 `launch`，新增宿主帧 `session.prepare`；范围写在 agent 条目的 `sessionParams` 上；launch 随会话固定并持久化 | 与 `run.start` 对称；registry 不变；无需重启；没配范围时行为与今天完全相同 | 会话多了一份需要持久化的状态；Codex 走共享 app-server 时 env 无法按会话生效（§5.4）；需要修订决定 6 |
| B 运行时增删 agent（`agents.put`） | 宿主通过 socket 推送 agent 定义，aio 动态建实例 | 表达力最强，model、profile、实例参数都能逐个定制 | 需要可变且持久化的 registry、动态实例、适配器缓存淘汰、孤儿会话处理，还要一套描述模板、profile、目录范围、env 键的语言；"有哪些 agent"变成可从 socket 修改，租户风险大。A 加模板 agent 已覆盖需求，B 记为备选 |
| C 宿主重写配置后重启，或预生成槽位 agent | 不改 aio | 零上游改动 | 每次新增都要重启或扩槽位；重启打断所有在跑的轮次（Claude 轮次重启后记为 ambiguous，见 `docs/design/claude-persistence.md`） |
| D 交互一律改成 task run | 每条消息一个 `run.start` | 现成能力 | 失去多轮连续性、steer、审批卡片等 lane 能力；task agent 不能被规则指向（`config.ts:169`） |
| E 在 Binding 规则上写静态 `cwd` | 规则级 `launch` 随表推送 | 无回调也能用 | 每个落地实例都要一条规则，表随实例数膨胀；与 A 不冲突，可在 A 之后按需追加，本提案不做 |
| F 新的会话范围 `per-principal` | 按发送者分会话 | 解决"每人一个会话" | 只解决 key，不解决目录和环境隔离 |
| G 按会话追加指令 / 事实（`instructionsAppend`） | launch 里带一段系统提示，存进 aio | 宿主可注入个性化内容 | 把宿主记忆存进 aio 的 SQLite，违反决定 6；agent 的指令本就是它的配置；harness 原生文件（cwd 或配置目录里的 CLAUDE.md）已能覆盖 |

A 的子决定中另有两处已排除：

- **重启后回调宿主重新要 env**：引入一种不由输入触发的回调，还让会话恢复依赖宿主在线。改为把 launch 存进已有的 0600 私有数据库（§5.3）。该库本就保存对话记录和工具输出（`gateway.ts:213-218`），敏感程度相当。
- **launch 里带 model**：本提案不涉及 model。配置了的 agent 每轮的 model 来自 agent 自身的运行配置（`gateway.ts:609-620` `agentPolicy`），需要不同 model 时用不同的模板 agent。现有的 `control set_model` 也不能替代：它只存在于协议里，`Lane.command` 对 `control` 一律返回 `unsupported`（`packages/session/src/lane.ts:454-455`，`packages/protocol/src/client.ts:41`）。

## 5. 推荐设计（方案 A）

### 5.1 协议

```ts
// packages/protocol/src/host.ts
export const SessionLaunch = Type.Object({
  /** 绝对路径；必须落在 agent 的 sessionParams.cwdRoots 之内。 */
  cwd: Type.Optional(Type.String()),
  /** 只进 harness 子进程环境；从不写日志、不上 argv。键必须在 sessionParams.envKeys 内。 */
  env: Type.Optional(Type.Record(Type.String(), Type.String())),
});

// 路由回调的答复：多一个可选字段
RouteCalloutAnswer = { on, agent?, session?, launch?: SessionLaunch }

// 新的宿主帧：为不经渠道输入打开的会话键预先登记 agent 和 launch
SessionPrepare = { ...Req('session.prepare'), sessionKey: string, agent: string, launch: SessionLaunch }
SessionPrepareResult = { sessionKey, agent, launch: { cwd?: string, envKeys: string[] }, created: boolean }
```

- **回调答复里的 `launch`**：作用于这条输入最终落到的会话键（无论 `session` 是 `per-conversation`、`topic` 还是 `{ key }`）。没有 `targets(on)`（`router.ts:587`）的动作（`host`、`drop`）带 `launch` 视为答复错误。
- **`session.prepare`**：用于不经渠道路由打开的会话：宿主连接发来的客户端 `input` 帧（`docs/HOSTS.md` §3，`gateway.ts:990-997` 在没有 lane 时直接 `this.lane(cmd.sessionKey)`）、本地 `aio input`（`packages/daemon/src/cli.ts:219`）与 `aio attach`、指向该键的 watch。（`aio send` 是 `deliver`，向人发出站消息，HOSTS §5，不打开会话，不在此列。）它只登记，不拉起 harness；第一条输入到达时按登记建 lane。同一键重复 prepare、值相同则幂等（`created: false`）。`run:` 前缀的键拒绝（task run 用 `run.start`）。
- **能力协商**：`host.hello` 的结果加 `features: string[]`，含 `"session.launch"` 表示支持本提案。必须有这一项：POSITIONING §6 要求未知字段原样保留，旧守护进程会**静默忽略**答复里的 `launch`，会话就落在 agent 的默认目录和环境里，在多租户场景下等于落进别人的 home。宿主看不到这个 feature 时不得依赖 launch。`features` 同时部分回答了 HOSTS §7 的待定项"版本协商"（按能力名协商，不按版本号），HOSTS §7 应相应更新。
- 宿主请求帧从 10 种变为 11 种（`host.ts:216`、`HOST_REQUEST_FRAME_TYPES`），`HOST_RESULT_VALUES`（`host.ts:422-434`）同步加 `'session.prepare': SessionPrepareResult`，属于 semver-minor；`PROTOCOL_VERSION`（`packages/protocol/src/common.ts:4`）不变。

### 5.2 配置：范围写在 agent 条目上，缺省拒绝

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

- 范围是**该 agent 的属性**，不放在全局块里：agent 是命名的运行配置，它能不能被按会话特化、特化到什么程度，属于部署方对这份运行配置的决定。
- **没写 `sessionParams` 就拒绝任何 launch**（fail closed）。所以不写这一项的部署，行为与今天逐字节相同。未配置 `agents` 时合成的 `default` agent（`config.ts:630-632`）不能用 launch。
- 校验（守护进程在接受 launch 时做，失败不建会话）：
  - `cwd`：绝对路径、存在、是目录（与 `runs.ts:103-108` 相同），**取 realpath 后**仍在某个 `cwdRoots`（同样取 realpath）之下，防止符号链接逃逸；
  - `env`：键匹配 `runs.ts:68` 的 `VAR_NAME` 且在 `envKeys` 中；`AGENTS_IO_` 开头的键一律拒绝（守护进程自用，如 `AGENTS_IO_MCP_TOKEN`，`harness/claude-code/src/adapter.ts:233`）；
  - **路径型的 env 键**：出现在 `envPathRoots` 里的键，值按 `cwd` 的同一规则校验（绝对、存在、是目录、realpath 在该键的根之下）。守护进程认识的配置目录键 `CLAUDE_CONFIG_DIR`、`CODEX_HOME` 若列进 `envKeys` 却没有对应的 `envPathRoots`，**加载配置时报错**，避免部署方无意中把任意配置目录交给宿主。
  - 其余列进 `envKeys` 的键，值不受任何检查。文档须写明：**把一个路径型变量（例如 `HOME`、`XDG_CONFIG_HOME`、`GIT_DIR`）只列进 `envKeys` 而不配 `envPathRoots`，等于允许宿主为会话指定任意路径。** 守护进程无法穷举所有路径型变量，只对已知的配置目录键强制。
- 根检查限定的是部署方划给这个 agent 的区域；在区域内选哪个租户的目录是宿主的策略（宿主本就持有 socket token，可信程度与 `run.start` 相同）。回调答复来自宿主，不来自渠道发送者。
- `mode: "task"` 的 agent 不接受 `sessionParams`（它们走 `run.start`，加载时报错）。

### 5.3 生效与固定

- **新表**：`daemon_session_launch(session_key PRIMARY KEY, cwd, env_json, at)`，与 `daemon_session_agents`（`packages/daemon/src/records.ts:32`、`98-101`）同库，数据库已是 0600（`gateway.ts:213-218`）。
- **agent 与 launch 原子写入。** 今天 agent 的固定只在建 lane 时由 `agentFor` 写入（`gateway.ts:593`）。带 launch 时，agent 行与 launch 行必须在**同一个 SQLite 事务**里写：`session.prepare` 在应答前写入两行；回调路径在建 lane 时由 `agentFor` 的同一处写入两行。不允许只有 agent 行没有 launch 行的中间状态，否则崩溃后这个键会被当成"无 launch 的老会话"。
- **"已有会话"的定义**：一个键满足以下任一条件即为已有会话：有 `daemon_session_agents` 行；有 `daemon_session_launch` 行；**会话日志里有该键的条目**（`hub.log`，与 `nativeIdOf` 读的是同一份，`gateway.ts:855-861`）。最后一条是必需的：未配置的 `default` agent 的会话从不写 agent 行（`agentFor` 只在 `agent.configured` 时写，`gateway.ts:593`），只看表会漏掉它们。"无 launch 的老会话"即已有会话中没有 launch 行的那些。
- **先到者为准，之后冲突的 launch 拒绝。** 已有会话收到不同的 launch（包括无 launch 的老会话收到 launch）一律视为冲突：
  - 回调答复：按答复错误处理，走规则的 `onFailure`（默认 `host`，输入进入持久队列，不丢，决定 1），`aio explain` 记 `callout.outcome: "error"` 并附原因 `launch_conflict`；
  - `session.prepare`：返回错误 `launch_conflict`（agent 不同则 `agent_conflict`）。
  - 相同的判定：cwd 比较 realpath，env 比较整张表。
  - **冲突检查在 `lane()` 的已有 lane 快速路径之前做。** 今天 lane 已存在时 `lane()` 直接返回，agent 不一致只记一条 warn（`gateway.ts:551-555`）；带 launch 的调用若走到那里，冲突会被静默吞掉。所以 `lane(sessionKey, agentName, launch)` 先查表判冲突，再看内存里有没有 lane。
- **为什么 cwd 必须持久化**：Claude 按原生 session id 续接，对话记录按项目目录存放在配置目录下；重启后若换了 cwd 或 `CLAUDE_CONFIG_DIR`，`resume` 找不到原会话。今天的续接靠 `nativeIdOf` 从日志取 id（`gateway.ts:855-861`），并默认目录不变。所以守护进程重启、停放的话题 lane 被 `idleOut` 关闭后再打开（`gateway.ts:795-809`）时，都必须从表里取回同一份 launch。
- **怎样换 launch**：换一个会话键（宿主在回调里给新的 `{ key }`，或对新键 `session.prepare`）。本提案不依赖 `control reset`（同样返回 `unsupported`，`lane.ts:454-455`）；将来 reset 落地时，应同时清掉该键的 launch 记录。
- **agent 不可解析时**：今天 `agentFor` 在记录的 agent 失效时会静默回退到前缀匹配或默认 agent（`gateway.ts:585-595`）。带 launch 的会话绝不能这样回退（那会让一个按租户特化的会话换成另一个 agent 的配置继续跑），必须拒绝输入并发 notice。

### 5.4 harness 侧怎么执行

**daemon 侧：一个机制，即每会话的 `withAgent`。** 不改 `InstanceHarness.open` 的优先级（`gateway.ts:1160-1164`）。`withAgent(adapter, agent, cwd)`（`gateway.ts:1123-1135`）已经会构造一个实例 cwd 就是传入 cwd 的新 `InstanceHarness`，`openRunLane` 正是这样应用 run 的 cwd（`gateway.ts:640`、`645`）；交互会话照做即可，现有 agent lane 和 run lane 的行为都不变。

- **适配器必须同时经 `harness` 和 `harnessFor` 交给 lane。** lane 只要设置了 `harnessFor` 就用它（`packages/session/src/lane.ts:705`），而 `gateway.ts:564` 的 `harnessFor` 对 agent 自己的实例返回缓存的 `agentHarness(agent)`。只换 `harness:` 的话每会话适配器永远不会被用到，launch 会话会静默跑在 agent 的默认 cwd 和 env 里。所以带 launch 的 lane：
  - 建 lane 时为每个实例名惰性构造并**缓存在该 lane 上**一个 launch 适配器：`withAgent(this.harness(name), agent, launch.cwd ?? agent.cwd)`，env 见下表；`harness:` 与 `harnessFor(name)` 返回同一个对象。同一个对象很重要：`ensureSession` 用对象相等判断是否换了 harness（`lane.ts:706`），每次新建会导致每轮 `runtime_restart`。
  - `Policy.plan` 为某一轮选了 agent 实例以外的实例时，同样经 `harnessFor` 拿到套了 launch 的适配器，不回落到不带 launch 的 `this.harness(name)`；该实例无法执行这份 launch（下表的 `launch_unsupported`）时，这一轮拒绝并发 notice。
  - 不进按 agent 名的缓存 `agentAdapters`。lane 关闭时，自带进程的适配器（Codex stdio）随之关闭，与 `openRunLane` 的 `dispose` 相同。
  - **续接**：`resumeFor` 按适配器 id 从日志取原生 id（`lane.ts:716`、`gateway.ts:855-861`）。launch 适配器的 id 仍是实例名（`InstanceHarness` 的 id 取 `instance.name`），所以续接路径不变；重启后按表里的 launch 重建同一个适配器，原生 id 落在同一 cwd 和配置目录下，`resume` 能找到。
  - 单适配器注入（测试用的 `o.harness`）时，launch 通过 `HarnessOpenArgs` 传入，供测试断言。
- `laneInfo` 记下 launch 的 cwd（`gateway.ts:577`），输出工具按会话解析相对路径时用的就是它（`gateway.ts:298`）。
- `HarnessOpenArgs`（`packages/protocol/src/harness.ts:6-17`）加可选的 `env`，由适配器自行决定如何生效。进程外 JSONL harness 适配器随之多一个可选字段。

| harness | cwd | env |
|---|---|---|
| Claude Code | 每会话的 `withAgent` 给出 | 映射到已有的每次 open 的 `options.env`（`harness/claude-code/src/types.ts:52-53`），位于最上层（`adapter.ts:126-133`），所以 launch 里的 `CLAUDE_CONFIG_DIR` 覆盖实例的 `configDir` |
| Codex，`stdio` 传输 | 每个 thread 自带 cwd（`harness/codex/src/harness.ts:450-451`），只带 cwd 的 launch 共享 app-server | 一个 `CodexHarness` 的所有会话共用一个 app-server 进程（`harness.ts:242-244`），env 只能在进程启动时给。带 env 的会话像 task run 一样单独起一个 stdio app-server（`gateway.ts:637-643`）：launch env 并入该进程的实例 env，launch 的 `CODEX_HOME` 替换实例的 `home` 设置（使它与 Claude 一侧同样位于配置目录层之上）。代价是每个这样的会话多一个进程 |
| Codex，`unix` 传输 | 同上 | 服务进程比守护进程活得久、被多个会话共享，env 无法按会话生效：**带 env 的 launch 直接拒绝**（`launch_unsupported`）；只带 cwd 的可以 |

**与 `inheritEnv` 提案（`docs/design/harness-env`，待定）的叠放**。最终子进程环境自下而上：

```
process.env 经 inheritEnv 过滤  <  实例 env（含 run.start.env）  <  configDir / home  <  launch env
```

- launch env 属于显式层，**不受 `inheritEnv` 过滤**（与那份提案对"按会话的 env"的预留一致）。所以 `envKeys` 可以列出 `inheritEnv` 会剥掉的名字：值由宿主提供，不来自守护进程自己的环境，不会把守护进程环境里的密钥带下去；授权来自部署方把它列进 `envKeys`。
- 与 `run.start.env` 不同，launch env 位于配置目录层**之上**：launch 的目的之一就是按会话换配置目录，而 task run 至今不能改实例的配置目录（那份提案 §5.3 保持这一点）。两者的差别由 `envPathRoots`（§5.2）兜住。
- 若 `inheritEnv` 先落地，本提案不需要改动；若本提案先落地，叠放顺序就是上式去掉 `inheritEnv` 过滤。

与 `docs/design/claude-persistence.md` 的自建宿主进程方案兼容：那时 env 交给宿主进程拉起的 CLI，规则不变。

### 5.5 话题会话继承 launch

话题按 `(conversation, agent)` 分组（`packages/session/src/topics.ts:133-146`），后续话题的会话键是 `<前缀><conversation>#<topicId>`（`router.ts:536-539`），由 `/new`、`session_rotate` 经 `router.newTopic`（`router.ts:545`）→ `TopicStore.create`（`topics.ts:212`）新建，`handOver` 随即经 `this.lane(to.sessionKey, to.agent)` 打开新 lane（`gateway.ts:718`）。这些新键没有经过回调，若不处理就会落回 agent 的默认目录：同一对话换个话题就换了工作区和配置目录。

- **规则**：新建话题时，把它所替换的话题会话（`from`）记录的 launch 复制到新会话键，之后各自固定。切回旧话题时用旧话题自己的记录。
- **挂在哪里**：话题在 session 包里创建，launch 表在 daemon 里。复制放在 gateway 的话题变更回调 `topicChanged`（`gateway.ts:788`，由 `TopicRegistry` 的 `onChange` 接入，`gateway.ts:226`）。`TopicStore.create` 在提交事务后**同步**调用 `changed` → `onChange`（`topics.ts:244`、`309`），早于调用方 `handOver` 打开新 lane，所以复制只要在回调里同步写库（与 agent 行同一事务），就保证在新话题的 lane 打开前完成。实现时须保持这个同步顺序，并在代码里注明。
- 为区分"新建"与"切换"，`TopicChange` 加 `created?: true`（`topics.ts:31-39`，由 `create` 置上）。只在 `created` 且 `from` 有 launch 行时复制。

宿主自选的 `{ key }` 会话目前没有话题层（`router.ts:509` 直接返回该键），这是话题层自身的缺口，与 launch 正交，另案处理（§6）。

### 5.6 让回调只在首次输入时发生

需要 launch 的部署必须在主规则上开 `callout`，而回调按规则触发，每条输入都会同步问一次宿主。按决定 2，本地表匹配是主路径，回调用于个别规则；launch 不应让回调成为常态。

- **提议**：`callout` 加可选的 `skipWhenPinned: true`。只对本地就能算出目标键的规则有效（规则自身的 `on` 指向 agent，`session` 不由回调决定）：路由先按规则算出键，若该键已有 launch 行（已固定），跳过回调，按规则本身投递；否则照常回调。`aio explain` 记 `callout.outcome: "skipped_pinned"`。这样稳态下的输入只走本地匹配，回调只出现在每个键的第一条输入，相当于一次"开户"。
- **备选**：宿主在已知键的情况下提前 `session.prepare`（键的格式是前缀加渠道对话的 route key，`router.ts:583-585`），规则不开回调。适合宿主能预知对话的部署（例如成员入驻时建群）。
- 不做任何一项也能用，代价是每条输入一次同步回调。列入 §10 第 4 项。

### 5.7 可见性

- `aio sessions` / admin 会话列表：显示 launch 的 `cwd` 和 env 的**键**，从不显示值。
- `aio explain`：回调答复带了 launch 时记录"带 launch（cwd、env 键）"及结果（`applied` / `same` / `launch_conflict` / 校验失败原因）。
- 日志与 `run` 一致，只记键（参照 `runs.ts:144`）。

### 5.8 安全

- 宿主本就持有 socket token，能 `run.start` 任意绝对目录。交互会话之所以要加 `cwdRoots` / `envKeys` / `envPathRoots` 范围，是因为它们由渠道输入触发、长期存在、会被续接，部署方需要一道与宿主实现无关的上限。范围与宿主的判断叠加，不替代宿主自己的检查。
- 路径型 env 是这道上限最容易漏的地方：多租户场景的关键变量正是 `CLAUDE_CONFIG_DIR` / `CODEX_HOME`。所以已知配置目录键强制配根（§5.2），其余路径型变量在文档里写明风险。
- env 值等同于凭据处理：只进子进程，持久化在 0600 库里，不进事件流、不进 `aio explain`、不上 argv。
- 这不是隔离边界：同一 OS 用户下的 harness 子进程仍可读到彼此可读的文件。需要真正隔离的部署仍要靠 OS sandbox 或独立用户。

## 6. 不做

- 按会话的 model、effort、profile：用不同的模板 agent；profile 的选择仍由 `Policy.plan` 和 agent 配置决定（决定 5 不变）。
- 按会话的系统指令或事实注入（方案 G）。
- `agents.put`（方案 B），记为 A 不够用时的备选。
- 规则级静态 launch（方案 E），需要时再加，复用同一套校验。
- 实现 `control reset`：独立的缺口（§5.3），本提案只规定它落地时要清掉 launch 记录。
- 后续另案：宿主选定的会话键（`session: { key }`）也能有话题（例如 `SessionScope` 的 `{ key, topics: true }`）；届时沿用 §5.5 的继承规则。

## 7. 对协议、schema、配置的影响

| 层 | 改动 | 兼容性 |
|---|---|---|
| protocol `host.ts` | `SessionLaunch`；`RouteCalloutAnswer.launch?`；新帧 `session.prepare` 及其结果（`HOST_REQUEST_FRAME_TYPES`、`HOST_RESULT_VALUES`）；`HostHelloResult.features?`；`RouteExplanation` 的 `matched[].launch?: { cwd?, envKeys, outcome }`；Binding 规则 `callout.skipWhenPinned?`（若 §10 第 4 项同意） | 新增可选字段和一个帧，semver-minor；旧守护进程会忽略 `launch`，所以必须用 `features` 协商 |
| protocol `harness.ts` | `HarnessOpenArgs.env?` | 可选字段；不认识它的适配器按 §5.4 的能力表处理，守护进程不对它们传 env |
| protocol `schema/` | 重新生成：新增 `SessionPrepareResult.json`；变更 `HostRequestFrame.json`、`HostHelloResult.json`、`RouteCalloutAnswer.json`、`RouteExplanation.json`、`BindingTable.json`（若加 `skipWhenPinned`）、`HarnessHostFrame.json` | 生成物 |
| testkit | POSITIONING §6.2 的一致性套件为 harness 加一项：`HarnessOpenArgs.env` 的值出现在子进程环境里、不出现在 argv 和事件里。`packages/testkit/src` 目前只有通道一致性（`channel-conformance.ts`），这一项作为 harness 一致性的首批用例 | — |
| daemon 配置 `AgentEntry` | `sessionParams?: { cwdRoots: string[], envKeys: string[], envPathRoots?: Record<string, string[]> }` | 可选；`Closed` schema 下旧配置不受影响 |
| daemon SQLite | 新表 `daemon_session_launch` | 新表，`CREATE TABLE IF NOT EXISTS`，无迁移 |
| session 包 | `TopicChange.created?` | 可选字段 |
| 文档 | `docs/HOSTS.md` §2.2 回调答复（含 `skipWhenPinned`）、§4 帧表加 `session.prepare`、§7 待定项"版本协商"改为按 `features` 协商；`docs/CHANNELS.md` 若描述 agent 配置则同步；决定 6 的修订由 owner 记入 DECISIONS | — |

## 8. 测试

单元与集成（`packages/daemon/test/`、`packages/session/test/`）：

1. 没有 `sessionParams` 的 agent：回调答复带 launch → 走 `onFailure`，explain 记原因；`session.prepare` 返回 `launch_not_allowed`。
2. cwd 校验：相对路径、不存在、是文件、在根外、经符号链接逃出根，全部拒绝；根内的真实目录接受。
3. env 校验：不在 `envKeys` 内的键、`AGENTS_IO_*`、非法变量名，拒绝。
4. 路径型 env：`CLAUDE_CONFIG_DIR` 的值在 `envPathRoots` 根外、经符号链接逃出、不存在，拒绝；根内接受。`envKeys` 列了 `CLAUDE_CONFIG_DIR` / `CODEX_HOME` 却没配 `envPathRoots` → 加载配置报错。
5. **launch 适配器确实被用到**：在 `harnessFor` 生效的正常配置下（不是单适配器注入），harness 收到的 `cwd` 是 launch 的 cwd，Claude 子进程 env 含 launch 的值、`CLAUDE_CONFIG_DIR` 以 launch 为准；同一 agent 的另一个无 launch 会话仍用 agent 默认 cwd；连续两轮不出现 `runtime_restart`（同一适配器对象）；`Policy.plan` 换到另一实例时仍带 launch。
6. 固定：同一键第二次相同 launch → 通过；不同 launch → `launch_conflict`，输入进入宿主队列不丢；lane 已在内存中时同样判冲突（不被快速路径吞掉）；无 launch 的老会话（包括只有日志、没有 agent 行的 `default` agent 会话）收到 launch → 冲突。
7. 原子性：`session.prepare` 后两张表同时有行；在两次写之间注入失败，两张表都没有行。
8. 持久化与续接：重启守护进程后，同一键的 lane 用记录的 cwd/env 重建，并按原生 id 续接；停放话题被 `idleOut` 关闭后重开同样如此。
9. 话题继承：带 launch 的对话里 `/new`、`session_rotate` 产生的新话题会话用同一 launch，且在 `handOver` 打开新 lane 时表里已有记录；`/switch` 回旧话题用旧话题的记录。
10. Codex：stdio 实例带 env 的会话有独立 app-server，会话关闭后进程退出；unix 实例带 env → `launch_unsupported`，只带 cwd → 正常。
11. `inheritEnv` 叠放（若已落地）：`inheritEnv: 'none'` 下 launch env 里的名字仍进入子进程。
12. 泄漏检查：env 值不出现在事件日志、`aio explain`、`aio sessions`、守护进程日志、子进程 argv 中。
13. `features` 协商：`host.hello` 结果含 `session.launch`。
14. agent 失效：带 launch 的会话记录的 agent 被删除后，输入被拒绝并发 notice，不回退到默认 agent。
15. `skipWhenPinned`（若同意）：键已固定时不发回调，explain 记 `skipped_pinned`；未固定时照常回调。
16. testkit：harness 一致性用例覆盖 `HarnessOpenArgs.env`（§7）。

e2e（`docs/E2E.md`）：加一个场景：同一模板 agent 的两个会话分别落在两个目录、两个 `CLAUDE_CONFIG_DIR`，各自读到自己目录下的 CLAUDE.md，互不可见对方的记录；重启守护进程后各自续接。

## 9. 迁移

- 默认关闭：不写 `sessionParams` 的部署没有任何行为变化，也没有数据迁移。
- 已经为每个落地实例生成一个 agent（或预生成槽位）的部署，可以逐步改成"少量模板 agent + 每会话 launch"：新会话用新键并带 launch；老会话保持原 agent 和原目录直到自然结束（老键收到 launch 会冲突，这是有意的，避免续接时目录变化）。
- 宿主侧：先检查 `host.hello` 结果的 `features`，再在回调答复里带 launch；对 `launch_conflict` 的处理是换键，而不是重试。

## 10. 待拍板

1. 是否接受方案 A 的总体形态（回调答复 + `session.prepare` + agent 条目上的范围，缺省拒绝，路径型 env 强制配根）。
2. **修订决定 6 的最后一条**（本提案成立的前提）。现文："工作区（工作目录与项目级配置）属于 agent 的运行配置；一个项目对应一个工作区，项目配置写在该目录里，由 harness 自行读取。" 拟改为："工作区（工作目录与项目级配置）默认属于 agent 的运行配置；部署方可在 agent 配置里声明允许按会话指定工作区的范围（`sessionParams`），宿主在范围内为会话选定工作区，选定后随会话固定。项目配置仍写在工作区目录里，由 harness 自行读取。" 不同意则本提案只能退回方案 C 或 E。
3. launch 是否整体不可变。另一种做法是只固定 cwd 和 `CLAUDE_CONFIG_DIR` / `CODEX_HOME` 这类决定续接位置的键，其余 env（例如会轮换的令牌）允许在下一次打开 harness 时更新。本文推荐整体不可变，规则简单；需要轮换的凭据建议放在配置目录里由 harness 自己读取（例如 `apiKeyHelper`），而不是放进 env 值。
4. 与决定 2 的关系：是否加 `callout.skipWhenPinned`（§5.6），让回调只出现在每个键的首条输入；或者只依靠 `session.prepare`，接受"不能预知键的部署每条输入一次回调"。本文推荐加。
