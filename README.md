# agents-io

Agent 的输入输出基建：把任何通道的输入变成统一信封，把任何 harness（Claude Code、Codex 本体）会话的过程变成可订阅、可续传的事件流，再把输出投递到任何通道。

agents-io 只提供机制。信任、审批、模型选择、任务与记忆都是宿主的事，通过 `Policy` 钩子接入。边界见 [docs/POSITIONING.md](docs/POSITIONING.md)。

```
飞书 / 邮件 / 私有通道(JSONL) / 终端 ─▶ InboundEnvelope ─▶ Ingress(Policy) ─▶ Lane(每 session 一条队列)
                                                                        │ startTurn / steer / interrupt / respond
                                                                        ▼
                                                     Claude Code / Codex（harness 本体）
                                                                        │ HarnessEvent
                                                                        ▼
                         多端订阅 ◀── Hub(subscribe fromSeq, tier) ◀── SessionLog(seq)
                         通道投递 ◀── Compositor + Outbox（流式卡片、幂等）
```

## 包

| 包 | 内容 |
|---|---|
| `packages/protocol` | 协议：入站信封、会话事件、命令、通道/harness 接口、Policy 钩子、进程外 JSONL 帧、客户端帧；`schema/` 下有 JSON Schema |
| `packages/testkit` | 事件流与通道一致性检查、`FakeChannel` / `FakeHarness` |
| `packages/session` | 带 seq 的日志（内存 / SQLite）、订阅与快照、Lane（合批、steer、对账、审批 resolver）、默认策略、Outbox、Compositor |
| `harness/claude-code` | 基于 Claude Agent SDK 驱动 Claude Code |
| `harness/codex` | 基于 `codex app-server`（stdio 或 unix socket，宿主重启不打断轮次） |
| `channel/lark-bot` | 官方飞书/Lark 机器人（长连接、流式卡片）；应用用 [create-lark-bot](https://github.com/Ghost-LZW/create-lark-bot) 创建 |
| `channel/mail` | IMAP 收、SMTP 发，DKIM/DMARC 作为身份证据 |
| `channel/jsonl-bridge` | 进程外通道：任何语言写的私有通道经 stdio/socket 接入 |
| `packages/daemon` | `aio`：守护进程与命令行（通道、Binding 表、宿主协议、task run、宿主入站队列、终端端点、端到端场景） |
| `examples/dev-gateway` | `aio-dev`：`aio` 的旧名包装 |

## 开始

需要 Node.js 24+ 和 pnpm。

```sh
pnpm install
pnpm build
pnpm test                 # 单元测试（真机测试默认跳过）
```

端到端测试（真实 Claude Code / Codex、真实飞书、多端与重启）见 [docs/E2E.md](docs/E2E.md)。设计与调研过程见 [docs/](docs/README.md)。

## 许可

MIT
