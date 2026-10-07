# 运维设定的宿主令牌（`aio serve --token-file` / `host.tokenFile`）

> 状态：已实现（分支 `feat/ops-token-heartbeat-live-channels`），待合并时记入决定。可选开启，不配置时行为不变。
> 依据：`docs/POSITIONING.md` §2（机制不是策略）；`docs/HOSTS.md` §4（`host.hello`）；`packages/daemon/README.md`「Host connection」。

## 1. 问题

- 守护进程每次启动都生成新的宿主令牌：`Gateway` 构造函数里 `this.token = o.token ?? randomBytes(32).toString('hex')`（`packages/daemon/src/gateway.ts:232`，改动前），监听后写到 `<socket>.token`（`gateway.ts:384-386`），停止时删掉（`gateway.ts:1293`）。
- 宿主和 CLI 只能从 socket 旁的文件读令牌（`packages/daemon/src/token.ts:36-47` `readTokenFile`）。这要求宿主与守护进程同机、同用户、能读那个目录。宿主若跑在容器里、另一个服务账号下、或通过控制台 `/ws` 从别处连接，每次守护进程重启都要重新取令牌，部署脚本里没有稳定的值可以下发。
- 这是机制缺口：令牌放在哪、多久换一次，是运维（宿主）的选择；agents-io 只需要允许运维指定一个令牌文件。

## 2. 选项

| 选项 | 说明 | 取舍 |
|---|---|---|
| A. 环境变量 `AIO_HOST_TOKEN` | 直接给值 | 值出现在进程环境里（`/proc/<pid>/environ`、子进程继承），harness 子进程也会继承，泄露面大 |
| B. 令牌文件路径（采纳） | 文件存在就读，不存在就生成并写入 | 值只在 0600 文件里；可由运维预先写入，也可由守护进程第一次启动时生成，之后稳定 |
| C. 配置文件里写字面量 | 最简单 | 与"凭据不进配置文件"的规则冲突（控制台会报 `inline_secret`） |

## 3. 选择

采纳 B：

- CLI：`aio serve --token-file <path>`（相对当前目录）；配置：`host.tokenFile`（相对配置文件）。CLI 优先。库：`GatewayOptions.tokenFile`；`GatewayOptions.token` 仍然最优先（测试用）。
- 文件存在：按 `.env.live` 同样的思路做权限检查后读取——文件必须是普通文件、属于当前用户、组和其他人不可访问（`mode & 0o077 == 0`）；所在目录属于当前用户（或 root）且组和其他人不可写（带粘滞位的共享目录如 `/tmp` 同样拒绝：别人可以在里面预先放置文件名或符号链接）；令牌至少 16 个字符、不含空白。任何一项不满足，守护进程拒绝启动（`aio serve` 退出码 2，配置错误）。
- 文件不存在：目录不存在时以 0700 创建；生成 32 字节随机令牌，原子写入（随机名临时文件以 `wx` 独占创建、不跟随已存在的文件或符号链接，0600，再 rename）。
- 运维文件不能就是 `<socket>.token`（守护进程的副本，监听时改写、停止时删除）：路径相同时拒绝启动。
- 令牌仍然复制到 `<socket>.token`，CLI 的宿主命令照旧从那里读；停止时只删 socket 旁的副本，运维的文件保留。
- 守护进程从不轮换这个文件；要换令牌，运维删掉或改写文件后重启。
- 控制台可以经 `PUT /api/config` 改 `host.tokenFile`（重启后生效）。这意味着控制台管理员能让守护进程读取守护进程用户在私有目录里的任一 0600 文件当作宿主令牌，或在其可写的路径上创建一个令牌文件。接受此风险：控制台本身就以宿主令牌认证，控制台管理员已经持有宿主令牌并能改 harness 命令（可执行任意程序），这里没有新增权限。

## 4. 协议 / Schema / 配置影响

- 协议帧不变（`host.hello.token` 语义不变）。
- 配置新增 `host: { tokenFile?: string }`（`ConfigFile`，封闭对象）；`Config.host` 解析为绝对路径。控制台把 `host.tokenFile` 视为路径而不是凭据（`console-config.ts` `isCredential`），不会报 `inline_secret`。
- 不涉及 JSON Schema 再生成（`ConfigFile` 不在 `scripts/emit-schema.mjs` 列表里）。

## 5. 测试

`packages/daemon/test/token-file.test.ts`：文件缺失时生成（0600、目录 0700）、`<socket>.token` 内容一致、重启后令牌不变、停止后运维文件保留；运维预写令牌被采用；他人可读的文件、过短/空令牌、他人可写目录（含带粘滞位的共享目录）被拒绝且守护进程不启动；以 `<socket>.token` 作运维文件被拒绝；配置路径相对配置文件解析、不算凭据；`GatewayOptions.tokenFile` 优先于配置。

## 6. 迁移

无需迁移。不配置时每次启动仍生成新令牌。开启后，第一次启动生成的令牌即为之后的稳定令牌；宿主改为从运维下发的位置读取即可。
