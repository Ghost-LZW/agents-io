# Claude Code 跨守护进程重启的轮次接管（待实现）

> 状态：方案（2026-10-07），未实现。触发条件：aio 守护进程需要频繁升级，或长时间运行的 Claude 任务变多。

## 现状

| | Codex | Claude Code |
|---|---|---|
| 驱动方式 | `codex app-server --listen unix://…`，独立进程 | Agent SDK `query()` 拉起 `claude` CLI，作为守护进程的子进程（stdio） |
| 守护进程重启 | app-server 继续运行；新守护进程 `thread/resume` 接回，挂起的审批被重放，正在运行的轮次以 `turn.adopted` 接管（e2e 场景 h） | stdio 断开，CLI 退出，轮次中断；该轮记为 `ambiguous`，下一条输入按原 session id 续接上下文，是否继续由人决定 |

未采用的路径：

- `CLAUDE_CODE_RESUME_INTERRUPTED_TURN`：续接时自动重跑中断的轮次，可能重复执行已发生的副作用（git push、发信），默认关闭。
- Claude Code 自带的后台 session（`claude --bg`、`claude agents`、`attach`、`logs`、`stop`，由按需启动的后台服务托管）：对外只有终端界面与终端文本，SDK 没有公开"连接到 `--bg` session"的接口；接入只能读写终端，违背 agents-io 不驱动终端的原则。
- Remote Control：绑定 claude.ai，后端不公开。

## 方案：自建的 harness 宿主进程 + SDK 公开接口

Agent SDK 0.3.x 的两个公开接口足以实现：

1. **`spawnClaudeCodeProcess(options) => SpawnedProcess`**：宿主自行决定 CLI 进程在哪里、怎样运行，只要返回符合 `SpawnedProcess` 的对象（stdin/stdout/kill/exit 事件）。
2. **`query.reinitialize()`**（SDK 文档：用于"断线后重新连上 daemon"）：重新发送 `initialize`；CLI 的应答会带回仍在等待的 `can_use_tool` / `request_user_dialog`，SDK 重新交给回调（按 request_id 去重，回调需幂等）。

结构：

```
aio 守护进程 ──(unix socket, JSONL 帧)──▶ aio-hold（常驻小进程，几乎不需要升级）
  SDK query({ spawnClaudeCodeProcess })        持有 claude CLI 子进程的 stdio
                                               缓冲断线期间的 stdout 帧（有界环形缓冲）
```

- `aio-hold` 只做三件事：按请求拉起 `claude` CLI 并持有其 stdio；把 stdin/stdout 字节流转发给当前连接的客户端；客户端断开时继续持有进程并缓冲输出（有界，溢出则标记断档）。
- 守护进程侧实现 `SpawnedProcess`：把 stdin 写、stdout 读、kill、exit 映射到对 `aio-hold` 的帧。
- 守护进程重启：按持久化的 `(sessionKey, holdProcessId)` 重新连上 `aio-hold`，取回缓冲帧；若有断档，调用 `reinitialize()` 取回挂起的审批；正在运行的轮次以 `turn.adopted` 接管，与 Codex 一致。
- 协议可参考 `channel/jsonl-bridge` 与 botmux 的 remote-runner（`hello / start / reattach / detach / cancel` + generation 栅栏）。
- 安全：`aio-hold` 的 socket 0700/0600，与守护进程同一用户；环境变量只进子进程；不记录 stdout 内容到磁盘之外的地方。

## 验收

- e2e 场景 h 在 claude-code 上通过：轮次运行中停止守护进程，新守护进程接管并完成，日志里该轮只结束一次。
- 断线期间挂起的审批在重连后仍可回答。
- `aio-hold` 被杀时，轮次照旧记为 `ambiguous`，不自动重跑。
