# 测试套件复查：测试应当回答"有没有打破某个承诺"

> 状态：复查稿（2026-10-11）。
> 依据：`docs/ROADMAP.md` §1 原则 4（承诺可检验）、原则 5（能自我升级）；`docs/INVARIANTS.md`（59 节，含 DL-4b）；`docs/E2E.md`；`docs/design/host-surface-review/`。
> 范围：仓库里全部 66 个 `*.test.ts`（`packages/*`、`harness/*`、`channel/*`），静态数出 745 个 `it`（`describe.each` / `it.each` 按一个算）。本文只给结论和理由，不改代码，也不改其他文档。没有跑全量套件；用 `--reporter=json` 单独计时了 23 个文件（覆盖全部重的文件），其余按体量估计。

## 0. 结论先说

- **测试不是太多，是没有索引。** 745 个测试里，按本文的读法，295 个守着 INVARIANTS 里已有的承诺（a），251 个守着真实但没写进清单的契约（b：协议 schema、通道与 harness 一致性、机密不外泄、控制台与 MCP 端点的认证、Binding 表语义、任务运行退出码等）。真正该删的只有 23 个（重复、钉实现、给要删的功能写的）。还有 139 个是功能路径上的便宜测试，没有对应的承诺，降为包内测试，坏了就删或重写，不再算作"信任"。
- **21 条不变量不成立而套件全绿，原因不在测试的数量，而在测试的写法。** 测试都是在功能旁边、照着实现写的主路径，"不成立"的那些路径从来没有对应的测试；INVARIANTS 里的"部分覆盖"把它们藏住了。办法是：每条"不成立"都写成一个带编号的 `it.fails`，修好时它会变红，逼人改状态；每条承诺至少有一个从承诺出发、而不是从代码出发写的反例测试。
- **"重测试"其实不慢。** 实测最重的是 `harness/codex/test/unix.test.ts`（5.0 s）、`channel/jsonl-bridge/test/bridge.test.ts`（4.2 s）、`packages/daemon/test/console.test.ts`（3.4 s）；进程内起守护进程的文件每个测试 50–150 ms。重的代价在维护和不确定性上：daemon 测试大量靠 `until()` 轮询（`topics.test.ts` 31 处、`gateway.test.ts` 20 处），失败时说不清是哪条承诺坏了。
- **建议的结构**：`core`（a+b，546 个，按不变量编号打标签，每次改动都跑，估计墙钟 4–6 s）、`local`（c2，139 个，包内功能测试，同一条命令里跑但单独报告）、`e2e`（d，31 个，起子进程或依赖真实计时，合并前跑）、`live`（6 个加 `aio e2e` 场景与 E2E.md 手工清单，手动）。测试名里带 `#IN-1` 这样的标签，`vitest -t '#IN-1\b'` 能选；加一个脚本从 INVARIANTS.md 和测试名生成对照表、检查漂移、按改动的文件给出要看的承诺。
- **效果**：删 23 个测试，约 480 行（测试共 15,237 行，约 3%）；31 个移到 `e2e` 文件。另外按清单新增约 16 个编号和约 30 个最小测试（大多先是 `it.fails`）。数量几乎不变，变的是每个红灯能说出它打破了哪条承诺。

## 1. 现状的几个事实

1. **INVARIANTS 点名的测试都还在。** 脚本把 INVARIANTS.md 里引用的测试名与测试文件逐个比对：引用了 209 个测试（占 28%），全部能对上，没有改名漂移。剩下 536 个测试没有在任何承诺下出现。
2. **59 节里 7 节没有任何测试**：EX-2、LN-5、FC-3、RS-3、RS-4、RS-9、CF-4；RS-7 的"live 不跨重启"也没有。见 §7。
3. **计时**（单文件 `endTime - startTime`，10 核机器）：

| 文件 | 测试 | 用时 | 最慢的测试 |
|---|---|---|---|
| `harness/codex/test/unix.test.ts` | 15 | 5045 ms | "closes requests that were answered elsewhere while disconnected" 2006 ms；"spawns a detached server…" 1684 ms；"gives up after the reconnect window…" 612 ms |
| `channel/jsonl-bridge/test/bridge.test.ts` | 29 | 4176 ms | lifecycle 组每个 430–480 ms（真的起子进程再杀掉） |
| `packages/daemon/test/console.test.ts` | 30 | 3378 ms | provisioning 组轮询假的 create-lark-bot 子进程 |
| `packages/daemon/test/live-channels.test.ts` | 9 | 1951 ms | "a bridge whose first connect fails…" 405 ms |
| `packages/daemon/test/host-liveness.test.ts` | 6 | 1918 ms | "over /ws: a takeover closes the old (half-open) connection…" 1080 ms（真实心跳计时） |
| `packages/daemon/test/host.test.ts` | 15 | 1794 ms | "stop waits for a send in flight…" 423 ms |
| `packages/daemon/test/session-launch.test.ts` | 16 | 1236 ms | 每个约 120 ms |
| `packages/daemon/test/runs.test.ts` | 12 | 1142 ms | 每个约 110–170 ms |
| `packages/daemon/test/topics.test.ts` | 8 | 785 ms | "parked topics' lanes close after topics.parkedIdleMs…" 222 ms |
| `packages/daemon/test/gateway.test.ts` | 8 | 597 ms | |
| `packages/daemon/test/bridge-startup.test.ts` | 3 | 530 ms | |
| `packages/daemon/test/multi-lark.test.ts` | 8 | 507 ms | |
| `harness/claude-code/test/claude-code.test.ts` | 42 | 470 ms | "probe runs the configured `claude`…" 439 ms（起一个 sh） |
| `packages/session/test/watch.test.ts` | 17 | 260 ms | |
| `channel/mail/test/mail.test.ts` | 22 | 259 ms | |
| `packages/daemon/test/stop-inputs.test.ts` | 3 | 239 ms | |
| `packages/session/test/lane.test.ts` | 35 | 225 ms | |
| `packages/daemon/test/cli.test.ts` | 11 | 223 ms | |
| `harness/codex/test/codex.test.ts` | 39 | 216 ms | |
| `packages/daemon/test/local-server.test.ts` | 5 | 147 ms | |
| `packages/session/test/e2e.test.ts` | 11 | 123 ms | |
| `packages/daemon/test/config.test.ts` | 27 | 22 ms | |
| `channel/lark-bot/test/process.test.ts` | 22 | 10 ms | |

   这 23 个文件串行合计约 31 s；其余 43 个文件都是纯内存单元测试或小的进程内网关测试，估计合计 6–8 s。全量串行约 37–39 s，10 个 worker 下墙钟大约由最长的文件（unix.test 5 s）决定。

4. **一个隐藏前提**：`bridge.test.ts` 的 fixture 从 `dist/` 导入，没先 `tsc -b channel/jsonl-bridge` 就整文件失败（文件里自己写了提示）。core 不应依赖构建产物。
5. 五个 live 文件都有门：`LARK_APP_ID`+`LARK_APP_SECRET`+`LARK_TEST_CHAT_ID`、`MAIL_LIVE_IMAP_HOST`、`AGENTS_IO_LIVE_CLAUDE=1`、`AGENTS_IO_LIVE_CODEX=1`；另有 `bridge.test.ts` 的 python 适配器组按有没有 `python3` 跳过。

## 2. 逐文件清单

运行类：**U** 纯内存（含临时目录里的 SQLite）；**G** 起进程内网关（unix socket、SQLite、`helpers.ts` 的 `daemon()` 或 `Gateway.start`）；**P** 起子进程或真实 socket 对端；**N** 真实平台或真实 harness，有门。
不变量一栏：INVARIANTS 已点名的写编号；按本文阅读补上的也写编号；`新：` 后面是 §3.2 建议新增的编号。
分类一栏：a / b / c1 / c2 / d / live 的个数（定义见 §3）。

| 文件 | 包 | 测试 | 行 | 用时 | 类 | 覆盖的不变量 | a/b/c1/c2/d/live |
|---|---|---|---|---|---|---|---|
| `protocol/test/protocol.test.ts` | protocol | 10 | 130 | 小 | U | 新：PR-1、PR-2 | 0/10/0/0/0/0 |
| `protocol/test/admin-topics.test.ts` | protocol | 6 | 172 | 小 | U | HQ-5（lease 的 schema）；新：PR-1 | 0/4/1/1/0/0 |
| `testkit/test/testkit.test.ts` | testkit | 9 | 127 | 小 | U | 新：CN-1、HC-1、HC-2（检查器自测） | 0/7/0/2/0/0 |
| `session/test/blobs.test.ts` | session | 3 | 48 | 小 | U | 新：SE-2 | 0/3/0/0/0/0 |
| `session/test/compositor-accounts.test.ts` | session | 3 | 73 | 小 | U | DL-3、DL-4、RS-1 | 3/0/0/0/0/0 |
| `session/test/context.test.ts` | session | 15 | 364 | 小 | U | IN-1、IN-4、IN-6、EX-3、FC-2、RS-1 | 14/0/0/1/0/0 |
| `session/test/e2e.test.ts` | session | 11 | 284 | 123 ms | U | IN-1、RS-6、FC-2、RQ-1、RS-1；新：RQ-5、OB-1 | 5/5/0/1/0/0 |
| `session/test/host-queue.test.ts` | session | 8 | 174 | 小 | U | HQ-1、HQ-2、RS-1 | 7/1/0/0/0/0 |
| `session/test/hub.test.ts` | session | 10 | 157 | 小 | U | LN-1；新：RQ-5 | 5/3/0/2/0/0 |
| `session/test/ingress.test.ts` | session | 16 | 278 | 小 | U | IN-5、ID-1、ID-3、ID-5、RQ-1 | 14/0/0/2/0/0 |
| `session/test/lane.test.ts` | session | 35 | 716 | 225 ms | U | IN-1–IN-5、LN-1、LN-2、RQ-1、RQ-2、RQ-3、ID-6、DL-3、FC-2、RS-2、RS-5、RS-6；新：CT-1 | 28/7/0/0/0/0 |
| `session/test/live.test.ts` | session | 2 | 94 | 小 | U | ID-1、LN-2、LN-3、LN-6 | 2/0/0/0/0/0 |
| `session/test/log.test.ts` | session | 7（4 个跑两种实现） | 126 | 小 | U | LN-1、RS-1 | 6/1/0/0/0/0 |
| `session/test/outbox.test.ts` | session | 10 | 176 | 小 | U | DL-1、DL-2、DL-5 | 10/0/0/0/0/0 |
| `session/test/policy.test.ts` | session | 13 | 131 | 小 | U | ID-4、ID-5、ID-6、DL-5；新：CT-1 | 9/2/1/1/0/0 |
| `session/test/progress.test.ts` | session | 7 | 233 | 小 | U | 新：OB-1、CT-1 | 0/2/0/5/0/0 |
| `session/test/router.test.ts` | session | 37 | 551 | 小 | U | EX-1、HQ-3、HQ-5、ID-4、ID-5、LA-2、RS-1；新：RT-1、SE-1 | 17/14/2/4/0/0 |
| `session/test/routing.test.ts` | session | 10 | 176 | 小 | U | EX-1、EX-3、HQ-2、ID-6；新：RT-1 | 6/2/2/0/0/0 |
| `session/test/topics.test.ts` | session | 21 | 396 | 小 | U | RS-1；新：TP-1、CT-1 | 1/8/3/9/0/0 |
| `session/test/watch.test.ts` | session | 17 | 315 | 260 ms | U | ID-1、ID-5、ID-6、CF-5、RS-1、RS-7 | 7/6/2/2/0/0 |
| `host-mcp/test/host-mcp.test.ts` | host-mcp | 27 | 424 | 小 | U（回环 HTTP） | DL-1、DL-2、DL-5、EX-3、CF-6；新：SE-3、SE-4 | 9/9/2/7/0/0 |
| `host-mcp/test/topic-tools.test.ts` | host-mcp | 7 | 119 | 小 | U | CF-6；新：TP-1 | 1/3/0/3/0/0 |
| `daemon/test/bridge-startup.test.ts` | daemon | 3 | 39 | 530 ms | G+P | CF-1 | 2/0/1/0/0/0 |
| `daemon/test/channel-stamping.test.ts` | daemon | 10 | 136 | 小 | G | ID-3、ID-4 | 10/0/0/0/0/0 |
| `daemon/test/cli.test.ts` | daemon | 11 | 192 | 223 ms | G | 新：RN-1、SE-3 | 0/6/0/4/1/0 |
| `daemon/test/config.test.ts` | daemon | 27 | 449 | 22 ms | U | FC-4、CF-3；新：SE-1 | 4/14/0/9/0/0 |
| `daemon/test/console.test.ts` | daemon | 30 | 775 | 3378 ms | G+P | CF-3；新：SE-1、SE-2、SE-3、PR-1 | 0/18/0/4/8/0 |
| `daemon/test/frame-conn-closed.test.ts` | daemon | 1 | 31 | 小 | U | HQ-6 | 1/0/0/0/0/0 |
| `daemon/test/frames.test.ts` | daemon | 7 | 109 | 小 | U | ID-3；新：PR-1 | 2/2/0/3/0/0 |
| `daemon/test/gateway.test.ts` | daemon | 8 | 269 | 597 ms | G | DL-3、LN-1、RS-1、RS-8；新：RQ-5、CT-1 | 4/3/0/1/0/0 |
| `daemon/test/host-callouts.test.ts` | daemon | 6 | 132 | 小 | G | DL-5、RQ-3、RQ-4 | 5/1/0/0/0/0 |
| `daemon/test/host-liveness.test.ts` | daemon | 6 | 133 | 1918 ms | G（真实计时） | HQ-1、HQ-6 | 3/0/0/1/2/0 |
| `daemon/test/host-results.test.ts` | daemon | 1 | 42 | 小 | G | 新：PR-1 | 0/1/0/0/0/0 |
| `daemon/test/host.test.ts` | daemon | 15 | 271 | 1794 ms | G | DL-1、DL-2、EX-1、HQ-1、HQ-3、HQ-5、HQ-6、HQ-7、RS-1、ID-1；新：SE-2 | 13/2/0/0/0/0 |
| `daemon/test/inbound-redispatch.test.ts` | daemon | 8 | 158 | 小 | G | HQ-4 | 5/2/0/1/0/0 |
| `daemon/test/lark-clicks.test.ts` | daemon | 2 | 136 | 小 | G | RQ-1 | 0/0/0/0/2/0 |
| `daemon/test/live-channels.test.ts` | daemon | 9 | 220 | 1951 ms | G | CF-1、CF-2 | 5/1/0/1/2/0 |
| `daemon/test/live.test.ts` | daemon | 4 | 234 | 小 | G | LN-3、LN-4、LN-6、RS-8 | 4/0/0/0/0/0 |
| `daemon/test/local-server.test.ts` | daemon | 5 | 89 | 147 ms | G | 新：SE-2 | 0/5/0/0/0/0 |
| `daemon/test/media.test.ts` | daemon | 4 | 117 | 小 | G | 新：MD-1 | 0/2/1/1/0/0 |
| `daemon/test/module-channel.test.ts` | daemon | 9 | 131 | 小 | G | ID-3；CF-4（通道侧） | 2/3/0/4/0/0 |
| `daemon/test/multi-lark-config.test.ts` | daemon | 2 | 51 | 小 | U | CF-3 | 2/0/0/0/0/0 |
| `daemon/test/multi-lark.test.ts` | daemon | 8 | 184 | 507 ms | G | DL-4、DL-4b、IN-5 | 8/0/0/0/0/0 |
| `daemon/test/output-tools.test.ts` | daemon | 3 | 109 | 小 | G | CF-6、DL-5 | 1/0/1/0/1/0 |
| `daemon/test/runs.test.ts` | daemon | 12 | 261 | 1142 ms | G | FC-1、IN-1、EX-1、RS-5；新：RN-1、SE-1 | 5/6/0/1/0/0 |
| `daemon/test/session-launch.test.ts` | daemon | 16 | 471 | 1236 ms | G | LA-1、LA-2、FC-1、FC-4、RS-1；新：LA-3、SE-1 | 10/5/1/0/0/0 |
| `daemon/test/stop-inputs.test.ts` | daemon | 3 | 72 | 239 ms | G | IN-1、RS-6 | 3/0/0/0/0/0 |
| `daemon/test/token-file.test.ts` | daemon | 6 | 91 | 小 | G | HQ-7 | 2/1/0/3/0/0 |
| `daemon/test/topics.test.ts` | daemon | 8 | 297 | 785 ms | G | IN-1、RS-1；新：TP-1 | 2/3/1/1/1/0 |
| `daemon/test/watch.test.ts` | daemon | 7 | 178 | 小 | G | RS-1、CF-5；新：PR-1 | 1/1/1/3/1/0 |
| `channel/jsonl-bridge/test/bridge.test.ts` | jsonl-bridge | 29 | 426 | 4176 ms | P（python 有门） | ID-3、CF-1、DL-1；新：CN-1、PR-2 | 6/13/1/1/8/0 |
| `channel/lark-bot/test/conformance.test.ts` | lark-bot | 1 | 28 | 小 | U | 新：CN-1 | 0/1/0/0/0/0 |
| `channel/lark-bot/test/enrich.test.ts` | lark-bot | 7 | 169 | 小 | U | DL-4b；新：MD-1、IN-7 | 0/4/0/3/0/0 |
| `channel/lark-bot/test/inbound.test.ts` | lark-bot | 16 | 318 | 小 | U | IN-5；新：IN-7 | 0/11/0/5/0/0 |
| `channel/lark-bot/test/live.test.ts` | lark-bot | 1 | 23 | — | N | — | 0/0/0/0/0/1 |
| `channel/lark-bot/test/outbound.test.ts` | lark-bot | 20 | 260 | 小 | U | DL-2、DL-4、DL-4b、ID-4 | 6/5/0/9/0/0 |
| `channel/lark-bot/test/output-tools.test.ts` | lark-bot | 6 | 132 | 小 | U | — | 0/2/0/4/0/0 |
| `channel/lark-bot/test/process.test.ts` | lark-bot | 22 | 457 | 10 ms | U | DL-2、RS-1 | 3/4/2/13/0/0 |
| `channel/lark-bot/test/requirements.test.ts` | lark-bot | 3 | 33 | 小 | U | （权限清单与代码一致） | 0/2/0/1/0/0 |
| `channel/lark-bot/test/topic-title.test.ts` | lark-bot | 3 | 46 | 小 | U | — | 0/0/0/3/0/0 |
| `channel/mail/test/mail.test.ts` | mail | 22 | 455 | 259 ms | U（live 组 N） | DL-2、DL-3、DL-4b、ID-4、ID-5；新：CN-1、IN-7、MD-1 | 10/4/0/7/0/1 |
| `harness/claude-code/test/claude-code.test.ts` | claude-code | 42 | 724 | 470 ms | U | ID-2、ID-6、IN-1、IN-4、RQ-1、RQ-2、RS-1、RS-3（现状）；新：HC-1、HC-2、SE-1 | 15/19/0/7/1/0 |
| `harness/claude-code/test/live.test.ts` | claude-code | 2 | 94 | — | N | HC-1 | 0/0/0/0/0/2 |
| `harness/codex/test/codex.test.ts` | codex | 39 | 899 | 216 ms | U（进程内假 app-server） | ID-2、ID-6、IN-1、IN-4、IN-6、RQ-1、RQ-2、RS-1、LN-4、LN-6；新：HC-1 | 12/20/1/6/0/0 |
| `harness/codex/test/live.test.ts` | codex | 2 | 105 | — | N | RS-2、HC-1 | 0/0/0/0/0/2 |
| `harness/codex/test/unix.test.ts` | codex | 15 | 427 | 5045 ms | P | RS-2、RQ-1；新：SE-1、SE-2 | 5/3/0/3/4/0 |
| **合计** | | **745** | **15,237** | | | | **295/251/23/139/31/6** |

（路径省略了前缀 `packages/`。）

## 3. 分类

### 3.1 判据

- **a 守着已有不变量**：断言的是 INVARIANTS 某一条的承诺本身（或它的一条边界），换一种实现也必须成立。进 `core`，名字里带编号。
- **b 守着清单外的真实契约**：别人依赖它（宿主、别人写的通道或 harness 适配器、部署方、安全边界），但 INVARIANTS 没写。进 `core`，同时在 INVARIANTS 补一条（§3.2）。不因为"没在清单里"就删：一致性套件保护的是我们写不到的适配器。
- **c1 删除或合并**：和另一个测试断言同一件事；或者钉的是内部表示、调用方式；或者给已决定删除的功能写的。
- **c2 降为包内测试**：功能路径上便宜、确定的测试（渲染、配置解析、命令行解析），没有对应的承诺。不进 `core`，单独报告；**它坏了时，如果行为是有意改的，就删掉或重写，不机械地改断言**。
- **d 只在合并前跑**：值得留，但起子进程、靠真实计时或真实轮询，单个超过约 300 ms，或者是跨很多层的冒烟。仍然带不变量编号。
- **live**：真实平台、真实 harness，有门，手动。

不保留"只是因为它通过了"的测试，也不删"只是因为它在 daemon 里起了网关"的测试：IN-1、RS-6、DL-4、ID-3 这些承诺只在网关接线里成立，只能在 G 类测试里检验。

### 3.2 b 类对应的新编号（建议写进 INVARIANTS）

| 编号 | 承诺（一句话） | 现在守着它的测试（举例） |
|---|---|---|
| PR-1 | 每个线上帧、会话事件、宿主请求的结果、admin 端点都有 schema，守护进程实际发出的值通过它 | `protocol.test.ts` "validates session events"、"validates a binding table and host frames"；`admin-topics.test.ts` "a result-value schema for every host request"、"lists every endpoint once, with schemas"；`host-results.test.ts` "match the protocol schemas"；`console.test.ts` "match the protocol schemas and the daemon state"；`frames.test.ts` "server frames validate" |
| PR-2 | 帧解码有界、能从垃圾和超长行恢复、不拆多字节字符；对端不读时不无限缓冲 | `protocol.test.ts` FrameDecoder 三条；`bridge.test.ts` "drops malformed, unknown and invalid frames without crashing"、"refuses to buffer without limit when the peer stops reading" |
| CN-1 | 每个仓库内通道适配器通过 `runChannelConformance`；检查器自身能抓住违规 | `bridge.test.ts` "passes channel conformance"；`lark-bot/test/conformance.test.ts`；`mail.test.ts` "passes runChannelConformance with fakes"；`testkit.test.ts` "FakeChannel passes" |
| HC-1 | 每个 harness 适配器的事件流通过 `checkEventStream`（turn 不重叠、只结束一次、`input.consumed` 只点名本轮输入） | `testkit.test.ts` "flags overlap, unknown inputs and unfinished items"、"accepts turn.adopted for the open turn…"；`claude-code.test.ts` "maps a full turn and conforms"；`codex.test.ts` "maps a full turn to a conforming stream"；probe 拒绝未知主版本的三条 |
| HC-2 | 每会话 env 只进子进程环境，不上 argv、不进事件（`runHarnessEnvConformance`） | `testkit.test.ts` runHarnessEnvConformance 两条；`claude-code.test.ts` "never reaches argv-bound options or events (conformance)"；`codex.test.ts` "rejects a per-session env (one shared app-server)…" |
| SE-1 | 机密（`env:` 引用的值、凭据、launch env 的值、MCP token）不回显到错误、日志、explain、事件、命令行 | `config.test.ts` "env:NAME secrets never reach a child command line" 组 5 条与"never echo values"三条；`console.test.ts` "GET never shows secret values…"、credentials by schema 两条；`session-launch.test.ts` "env values never show in the event log…"；`runs.test.ts` "env goes into the run child only…"；`claude-code.test.ts` "host MCP token is passed through the env, never in mcpServers…"；`unix.test.ts` "refuses secrets in -c values…" |
| SE-2 | 本地数据文件、socket、token、blob 是 0600 / 目录 0700，别人可达时拒绝 | `local-server.test.ts` 全部；`blobs.test.ts` "writes files 0600 under 0700 directories"；`console.test.ts` "aio serve writes the console URL next to the token file (0600)…"；`unix.test.ts` "…refuses sockets others can reach"；`config.test.ts` `.env.live discovery` 组 |
| SE-3 | 控制台与宿主 MCP 端点只听回环（除非显式放开），核 Host/Origin，要 token 或一次性登录 | `console.test.ts` auth、listening、/ws、cookie scope、allowed hosts 各组；`host-mcp.test.ts` "listens on loopback only"、"rejects requests without a valid token"；`cli.test.ts` "a wrong token is refused (exit 77)" |
| SE-4 | 受限轮次里输出工具读文件不越出 cwd（含符号链接、`..`） | `host-mcp.test.ts` "send_file refuses … outside cwd in a restricted turn…"、"send_file in a restricted turn: symlinks and .. cannot escape…" |
| CT-1 | 打断、清队列、话题命令只有主人和本轮发起者能用，清队列只清自己的 | `lane.test.ts` "refuses interrupts from someone who is neither turn owner nor owner"、"interrupt with cancelQueue is authorised as cancel_queue…"；`policy.test.ts` "control: owners and turn owners may interrupt"；`topics.test.ts`（session）"Policy.control decides who may use them" |
| RQ-5 | 打开的人工审批在每个层级、每个订阅者、每个通道上立刻可见 | `hub.test.ts` "filters by tier and never filters out human approvals"；`e2e.test.ts` "final-tier channel without edit: one message per turn, plus one per human request"、"retries a failed streaming edit, so the approval buttons still appear"、"shows an approval at once…"；`gateway.test.ts` "human approval reaches a second subscriber at final tier…" |
| OB-1 | "卡住了"可观察：等审批时进度视图报 `requires_action`；没有文字就结束的轮次也说明怎么结束的 | `progress.test.ts` "reports requires_action while a human request is open…"；`e2e.test.ts` "final tier: a turn that ends without text still says how it ended" |
| RT-1 | Binding 表语义：字段匹配、同 session 取最强动作、平局先到者胜、host/drop 与 session 投递独立、非法表整张拒收 | `router.test.ts` binding match fields 组、"fans out…"、"on a tie the earlier rule wins…"、"rejects tables that target task agents…" |
| RN-1 | 任务运行：退出码 0/1/3/124/130 的含义固定；`run.ended` 在发起连接离开后交给宿主；守护进程停止时运行被打断并告知 | `runs.test.ts` run.start 组；`cli.test.ts` "maps errors to exit codes"、"aio run blocks until run.ended…" |
| IN-7 | 通道只在网关接受之后才向平台确认；接受失败不留去重键，平台重投能进来 | `lark-bot/test/inbound.test.ts` "forgets the dedup key when emit fails…"、"a card click whose emit fails is not acked either" 等 5 条；`mail.test.ts` "persists a checkpoint after the host accepts each message"；`enrich.test.ts` "acks within ackTimeoutMs while a download hangs…" |
| TP-1 | 话题：切回时用原来的原生会话续接（跨重启）；交接的消息只移动一次；不能切到别的对话的话题 | `topics.test.ts`（session）"switches back, persists across reopen…"；`topic-tools.test.ts` "a message just handed over … is not moved again (no ping-pong)"、"session_switch resumes another topic of the same conversation only"；`topics.test.ts`（daemon）"parked topics' lanes close … resume by native id…" |
| MD-1 | 图片、文件作为内容块到达 harness；超限的明确拒绝并说明，不让整轮失败 | `media.test.ts` "Claude receives a real image block…"、"refuses images over the inline limit…"；`claude-code.test.ts` "converts every content block kind"、"skipped images surface as a notice event" |
| LA-3 | launch 的 cwd/env 就是实际运行的东西；同 agent 的其他会话不受影响 | `session-launch.test.ts` "cwd and env reach the harness through harnessFor…"、Codex §8.10 两条 |

### 3.3 c1：建议删除或合并的 23 个

| 文件 | 测试 | 理由 |
|---|---|---|
| `session/test/watch.test.ts` | "owners anything; agents only allowlisted sources; strangers nothing" | 与 `policy.test.ts` "owners may watch anything; agents only allowlisted sources; others never" 同一条，留 policy 的 |
| `host-mcp/test/host-mcp.test.ts` | "denies sources off the owner allowlist with a clear error" | 同上（第三份） |
| `daemon/test/watch.test.ts` | "agents may watch allowlisted sources (policy.watchAllowlist from config)" | 同上（第四份）；配置接线由 "validates watches and the agent allowlist" 覆盖 |
| `session/test/watch.test.ts` | "applies filters before delivering" | 与同文件 "applies filters: keywords case-insensitively, mentions, excludeSelf by default" 重复 |
| `session/test/policy.test.ts` | "auto allows for bypass, auto denies for restricted" | 与 `lane.test.ts` "auto: answers immediately per policy (bypass → allow)"、"auto deny for a restricted turn" 重复 |
| `session/test/routing.test.ts` | "card clicks: request/turn ids go to the owning session via the Hub; other action ids route by actionPrefix" | 前半与 `ingress.test.ts` "routes approval and stop clicks to the session that owns the request or turn" 重复，后半并进 `router.test.ts` "actionPrefix matches card clicks…" |
| `session/test/routing.test.ts` | "passes the target agent to the lane factory" | 钉内部调用；行为由 `runs.test.ts` "a binding to a named agent opens its session with that agent…" 覆盖 |
| `session/test/router.test.ts` | "is a plain table: every rule targets the agent and names its session scope" | 钉默认表的内部表示；行为由 "owner DM → dispatch; …" 覆盖 |
| `session/test/router.test.ts` | "source + filter become the match, mode the action, target the session" | 钉 watch 转规则的内部形状；行为由 "are matched with the tables and explained with source watch" 覆盖 |
| `session/test/topics.test.ts` | "resolves to the current topic, creating the first one (with the conversation key) on first use" | 与 "creates the first topic lazily…" 重复 |
| `session/test/topics.test.ts` | "the default owner-DM rule uses topics; groups stay per thread" | 与 "a threaded conversation keeps one session per thread…" 重复 |
| `session/test/topics.test.ts` | "parses /new [title], /topics, /switch <n\|id>; anything else is a message" | 并进 "/new starts a topic the next message goes to; /topics lists; /switch goes back" |
| `daemon/test/topics.test.ts` | "agents without the session_* tools get no topic hint" | 与 `session/test/topics.test.ts` "the hint is chosen per target agent…" 重复 |
| `daemon/test/output-tools.test.ts` | "attach parses /choose" | 与 `host-mcp.test.ts` "local /choose input is normalized; bad answers are refused" 重复 |
| `host-mcp/test/host-mcp.test.ts` | "parses choice action ids" | 被 "a button click and a numbered reply come back as a choice event for the asking session" 覆盖 |
| `daemon/test/bridge-startup.test.ts` | "a bridge that connects at once is running, as before" | 其他每个起 bridge 的测试都隐含它 |
| `channel/jsonl-bridge/test/bridge.test.ts` | "round-trips inbound, send, edit and finalize" | 是 "passes channel conformance" 的子集 |
| `daemon/test/session-launch.test.ts` | "host.hello advertises session.launch" | 被 `host-callouts.test.ts` "… features advertise it" 覆盖 |
| `daemon/test/media.test.ts` | "buildHarness hands the resolvers to both kinds; explicit config options win" | 钉接线；行为由同文件 "Claude receives a real image block…" 覆盖 |
| `harness/codex/test/codex.test.ts` | "sends per-turn overrides only when the RunSpec changes" | 钉线上优化（少发字段），不是承诺；会挡住合理的重构 |
| `protocol/test/admin-topics.test.ts` | "hello lease, run.start overrides, run.ended timeout/duration/usage" | `lease` 已建议删除（host-surface-review §5 第 1 项）；run 部分并进 PR-1 的 schema 全量检查 |
| `channel/lark-bot/test/process.test.ts` | "emoji (default) decorates status, panels and tool lines"、"plain uses words only; the header colour still carries status" | 纯呈现风格；改一次文案就要改测试 |

条件删除（等拍板）：若 host-surface-review 待拍板第 2 项决定把 `resolve` / `outbound` 回调改为静态数据，`host-callouts.test.ts` 的 5 个测试（132 行）随功能删除，换成静态表的测试。

### 3.4 c2：降为包内测试的 139 个（按组）

- **渲染与文案**（约 45）：`lark-bot/test/process.test.ts` 的 CardKit 流式、降级、思维链气泡（13；其中平台错误码 300309、300500 等是 live 里学到的，留着，坏了再判断）；`outbound.test.ts` 的文本、post、卡片 schema 2.0、编辑节奏（9）；`topic-title.test.ts`（3）；`output-tools.test.ts`（lark，4）；`session/test/topics.test.ts` 的话题卡片、列表、标题、提示（9）；`progress.test.ts` 的折叠与卡片进度（5）；`frames.test.ts` 的 attach 解析、help、EventRenderer（3）；`e2e.test.ts` "renders headline and final tiers"。
- **配置与命令行解析**（约 30）：`config.test.ts` 的默认值、路径、`--harness`、命名实例、env 替换（9）；`cli.test.ts` 的配置与参数（4）；`module-channel.test.ts` 的路径与 exports 解析（4）；`token-file.test.ts`（3）；`daemon/test/watch.test.ts` 的 spec 与 attach（3）；`host-liveness.test.ts` "config: defaults 30 s / 10 s…"；`inbound-redispatch.test.ts` "aio redispatch parses its arguments"；`console.test.ts` 4 条（console-link 打印、端口被占、PUT 生效、过期 URL 文件）。
- **适配器内部映射**（约 30）：`claude-code.test.ts` 的 SDK 选项映射、`AskUserQuestion`、风险推断（7）；`codex.test.ts` 的 RunSpec 映射、推理显示、amendments、shell 解包、diff 统计（6）；`unix.test.ts` 的 TOML、启动参数（3）；`mail.test.ts` 的线程头、引用剥离、附件块（7）；`lark-bot/test/inbound.test.ts` 的富文本、提及占位、话题与引用（5）；`enrich.test.ts`（3）。
- **其余功能路径**（约 34）：`host-mcp.test.ts` 的 `reply_to`、`send_file` 上传、`ask_choice` 渲染、mention、`get_channel_context`、校验（7）；`topic-tools.test.ts`（3）；`hub.test.ts` 两条内部索引；`ingress.test.ts` 两条（channelContext、回复摘要）；`router.test.ts` 四条（含遗留 `Policy.admit`，遗留接口删除时一起删）；`watch.test.ts` 两条；等等。

### 3.5 d：只在合并前跑的 31 个

- `bridge.test.ts`："restarts a crashed child with backoff and keeps delivering"、lifecycle 组 6 条、python 适配器（共 8，起子进程、杀进程）。
- `unix.test.ts`："reconnects after a dropped connection…"、"closes requests that were answered elsewhere while disconnected"、"gives up after the reconnect window…"、"spawns a detached server…"（4，带 RS-2 / RQ-1 标签；真实重连窗口）。
- `console.test.ts` provisioning 组 8 条（起假 create-lark-bot 子进程并轮询；其中 "credentials only in the env file"、"addChannel:false does not overwrite the credentials…"、"duplicate_app"、"config_invalid" 带 SE-1 / CF-3 标签）。
- `host-liveness.test.ts`："over /ws: a takeover closes the old (half-open) connection…"、"keeps a connection that answers"（2，真实心跳计时；改用假时钟后可回到 core）。
- `lark-clicks.test.ts` 2 条、`live-channels.test.ts` 两条 provisioning、`cli.test.ts` "aio tail --once / ack / send / bindings / explain / verify"、`claude-code.test.ts` "probe runs the configured `claude`…"、`daemon/test/output-tools.test.ts` "mounts a per-binding token; …"、`daemon/test/topics.test.ts` "session_rotate starts a topic…"、`daemon/test/watch.test.ts` "loads config watches; …"（跨多层的冒烟，核心断言在 core 里已有单元版本）。

## 4. 分层方案

### 4.1 四层

| 层 | 内容 | 何时跑 | 预算 |
|---|---|---|---|
| `core` | a + b（546）；每个测试名带编号 | 每次改动；`pnpm test` | 墙钟 < 10 s，单测 < 300 ms，不依赖构建产物，不起真实子进程（fixture 子进程可以，但要快） |
| `local` | c2（139） | 与 core 同一条命令，单独报告 | 随 core |
| `e2e` | d（31）+ 以后的跨重启场景 | 合并到 `main` 前；`pnpm test:e2e` | < 60 s |
| `live` | 5 个有门的 live 文件、`aio e2e` 场景 a–r、E2E.md 手工清单 | 改动通道或 harness 适配器、发布前，手动 | 记结果，不进 CI |

实现：

1. 文件按层命名：`*.test.ts`（core）、`*.local.test.ts`、`*.e2e.test.ts`、`*.live.test.ts`。d 类从原文件挪到同目录的 `*.e2e.test.ts`，c2 挪到 `*.local.test.ts`。
2. `vitest.config.ts` 用 `test.projects` 定义 `core`、`local`、`e2e`、`live` 四个项目（按上面的 glob）；`pnpm test` = `vitest run --project core --project local`，`pnpm test:e2e`、`pnpm test:live` 各一条。
3. `bridge.test.ts` 的 fixture 改为不依赖 `dist/`（fixture 直接用 node 跑 `.mjs` 或从源码导入），否则 core 要先构建。

### 4.2 按不变量选测试：名字里的标签

- 格式：测试名末尾加 `#编号`，可以多个：`it('close rejects queued inputs (lane_closed) … #IN-1 #RS-6', …)`。失败报告里直接看到打破了哪条。
- 选择：`vitest run --project core -t '#IN-1\b'`（`\b` 让 `#IN-1` 不命中 `#IN-10`）。跨层：`vitest run -t '#RS-2\b'` 会同时跑 core 和 e2e 里的 RS-2。
- 已知不成立的路径写成 `it.fails('… #IN-1', …)`：现在"按预期失败"所以是绿的；有人修好它，它变红，提示把它改成 `it` 并改 INVARIANTS 的状态。没有测试的承诺先写 `it.todo('… #EX-2')`，让缺口在报告里可见。
- INVARIANTS.md 的"测试"一栏从逐条列测试名改为写标签（例如"测试：`#IN-1`，12 条，其中 `it.fails` 3 条"），由脚本生成，免得两边同步改名。现在已点名的 209 个测试名与文件完全对得上，第一批标签可以由脚本自动加。

### 4.3 对照脚本 `scripts/invariants.mjs`

不跑测试，只读文本：

- `check`：从 INVARIANTS.md 取 `### XX-n` 编号；从测试文件的 `it(` / `it.fails(` / `it.todo(` 名字里取 `#XX-n`。报错：标签指向不存在的编号；状态为"有测试"或"部分覆盖"的编号一个标签都没有；`core` 文件里的测试没有标签（c2 必须在 `*.local.test.ts`）。警告：一条"不成立"没有对应的 `it.fails`。放进 `pnpm test` 前面，几十毫秒。
- `affected [base]`：`git diff --name-only <base>`（默认 `main`）→ 找出"实现"一栏里提到这些文件的编号（INVARIANTS 已经按文件和函数名写了实现位置）→ 打印编号、每个编号在各层的测试数，和要跑的命令。没有命中任何编号的源文件也列出来：要么它不承担承诺，要么清单漏了一条。

### 4.4 维护 agents-io 的 agent 怎么决定跑什么

1. 改之前：`node scripts/invariants.mjs affected`，看会碰到哪些承诺，读那几节 INVARIANTS。
2. 改完：总是跑 `pnpm test`（core + local，几秒）。不按改动挑 core 的子集：它够快，挑子集只会漏。
3. **core 红了 = 可能打破了承诺。** 先读那条不变量。行为是对的、测试错了的情况要能说清为什么；有意改变承诺的，先改 INVARIANTS（和相关决定），再改测试。不允许只改断言让它变绿。
4. **local 红了 = 细节变了。** 确认是有意改的，就重写或删掉这个测试；它不是信任的来源。
5. `affected` 命中的编号在 e2e 里有测试，或改动碰了 `packages/daemon/src/gateway.ts`、`channel/jsonl-bridge/src`、`harness/*/src` 的传输与生命周期代码：跑 `pnpm test:e2e`。合并到 `main` 前无论如何跑一次。
6. 改了通道或 harness 适配器：列出对应的 live 项（`aio e2e --only …`、E2E.md 的手工步骤）交给人，写明没跑。
7. 新承诺：先在 INVARIANTS 写一节、给编号，再写带标签的测试；新功能没有承诺的，测试放 `*.local.test.ts`。
8. 发现一条不成立的路径：先写 `it.fails`，在 INVARIANTS 的"不成立"里记一条，再决定修不修。

## 5. 为什么旧套件会在 21 条不成立时全绿

- 测试和功能一起写，照着实现写主路径：`IN-1` 有 12 个测试，但"策略钩子抛错丢输入"这一条反例没有人写，因为写测试的人看着的是 `finishTurn`，不是承诺。
- "部分覆盖"没有强制力：主路径有测试就算覆盖，反向路径的缺失只写在文字里。
- 没有任何东西把测试和编号连起来，所以"套件全绿"无法翻译成"哪些承诺成立"。

§4 的三件事分别对着这三点：`it.fails` 让反例必须存在；`check` 让"部分覆盖"的缺口在报告里可见；标签让红灯能说出编号。

## 6. 效果估计

| 项 | 现在 | 之后 |
|---|---|---|
| 测试数 | 745 | 删 23；新增约 30（多数是 `it.fails` / `it.todo`）；约 750 |
| 测试行数 | 15,237 | 删约 480 行；新增约 600 行；挪动（不删）d 类约 900 行、c2 类约 2,500 行 |
| 带编号的测试 | 0（INVARIANTS 文字里点名 209） | core 全部 546 + e2e 31 |
| `pnpm test` 墙钟 | 估计由 unix.test 5 s 决定 | core + local 估计 4–6 s（串行合计约 20 s，10 个 worker；最长文件 `host.test.ts` 约 1.8 s，console 去掉 provisioning 后约 1.5 s） |
| `pnpm test:e2e` | 无 | 估计串行 12–15 s，墙钟约 6 s |

估计的依据是 §1 的 23 个实测文件；其余 43 个文件没计时，按每个单元测试 5–10 ms、每个网关测试 60–150 ms 估。删除的收益小，这是有意的结论：问题不在测试太多。

## 7. 没有测试的不变量与最小测试

完全没有测试的（每条一个最小测试；现在不成立的先写 `it.fails`）：

| 编号 | 最小测试 |
|---|---|
| EX-2 | `it.fails`：一轮里输出工具发一条消息后，`explain({ operationId })` 返回它的 turnId 和该轮的 inputIds；系统回复、宿主 `deliver`、`live_say` 各一条同样断言 |
| LN-5 | harness 只支持 webrtc 时，用 frames 端点 `live_join` 在 `start` 之前报 `LiveTransportError`（含传输名），端点被关闭、没有登记；没声明 video 的 live 收不到视频帧 |
| FC-3 | `it.fails`：配置里只有任务 agent（或默认 agent 被热改删掉）时，一条渠道输入得到 `input.rejected agent_unavailable`、原路由一句说明、explain 有记录，`accept` 不抛 |
| RS-3 | 假 Claude Code 适配器跑到一半时 `gw.stop()`：该轮 `interrupted`，未消费输入 `input.rejected lane_closed`；重启后下一条输入用同一原生 id 续接 |
| RS-4 | `it.fails`：Codex stdio 跑到一半时停机再启动，不等新输入，该轮在启动后被结算（`ambiguous host_restarted`），快照不再显示运行中 |
| RS-9 | `it.fails`：`Gateway.start` 用 `MemorySessionLog` 或 `logPath: ':memory:'` 时 logger 收到一条"不持久"的告警 |
| CF-4 | `use: 'module'` 的 harness：模块不存在、导出不是函数、工厂抛错、返回值不是 adapter，四种都让 `Gateway.start` 失败，错误里有实例名 |
| RS-7（live） | 有 live 时停机再启动：快照里没有 live，`live_say` 答"没有 live"，日志里那个 live 有 `live.ended` |

部分覆盖、但某个子承诺没有测试的（一行一个；"不成立"的写 `it.fails`）：

- IN-1：`it.fails` `policy.control` 抛错时输入有终态（`rejected`），同 id 重试不答 `duplicate`。
- IN-1：`it.fails` 第 33 个 live 委托挤掉最早的那个时，被挤掉的有 `input.rejected`。
- IN-1：`it.fails` 被接管的 turn 结束时，harness 没报 consumed 的被接管输入有终态。
- IN-5：`it.fails` 重启后同一 `(channel, account, id)` 再到达，不进会话第二次。
- IN-5：`it.fails` 投给两个会话、第二个抛错时，平台重投不让第一个会话收到两次。
- DL-2：`it.fails` 结算记录被 30 天清理后，同一 operationId 不再发（或者把承诺改成"30 天内"）。
- DL-3：终端（local）发起的轮次，FakeChannel 收不到任何 send。
- DL-5：`it.fails` 宿主声明过 `outbound` 后断线，输出工具发往非本轮路由被拒。
- DL-5：`it.fails` `live_join` 的目标过 outbound 检查。
- HQ-1：网关层：未 ack 的入站项在守护进程重启后重推给同一 consumer。
- HQ-5：`it.fails` 只拉取的宿主带 `lease` 的表生效（或随 lease 删除，改成断言 `lease` 被拒）；迟到的旧版本不覆盖新表（若承诺单调）。
- ID-2：harness 收到的被监听输入说明行里有 `watch=` 标记（Claude、Codex 各一条）；`it.fails` 说明行含 `origin.evidence`。
- ID-6：context 里混了陌生人消息时，`plan` 的结果与没有 context 时相同；会改变 profile 的 steer 被改为排队。
- LN-1：同一 `(session_key, seq)` 写两次被主键拒绝。
- LN-2：`it.fails` `closeLane` 等待期间到达的输入不为同一键建第二个 lane。
- LN-4：守护进程停止时日志里有 `live.ended`（不只断言端点关闭）；harness 先关时端点也关。
- RS-5：`it.fails` 没有新输入的交互 session，遗留 turn 在启动后（compositor 接管卡片之后）被结算。
- RS-8：一个 `close()` 永不返回的假 harness 和一个 `close()` 永不返回的通道，`gw.stop()` 在上限内返回。
- RS-1（blob）：重启后按引用读回同一字节。
- CF-5：`it.fails` source 与目标主路由相同的 watch 被拒绝。
- CF-6：`it.fails` 按 agent 只开 `send_message` 时，MCP 只列出它（原则 2）。
- 第 12 节第 15 项：`it.fails` digest flush 在 `input.admitted` 落盘后、`endFlush` 前崩溃，重启后该 id 只有一种结局。

## 8. 待拍板

1. 是否采用四层与 `#编号` 标签（§4）。采用的话，第一步只做三件不改行为的事：加 `projects` 配置、给已点名的 209 个测试自动加标签、加 `check` 脚本（先只警告）。
2. §3.2 的 16 个新编号是否写进 INVARIANTS。尤其 SE-1 到 SE-4：安全边界现在散在 config、console、host-mcp 的测试里，没有一条承诺统领。
3. c2 的规则（"坏了就删或重写，不机械改断言"）是否接受。若更倾向于删，第一批可以是纯呈现的约 25 个（话题卡片与标题、EventRenderer、进度折叠、lark 文本与卡片格式）。
4. `it.fails` 是否作为"不成立"条目的硬要求（`check` 由警告改为报错）。
