# agents-io

[English](README.md) | **简体中文**

**Agent 的输入输出基建。** 将不同通道的输入变成统一信封，将 Claude Code 和 Codex 会话的过程变成可订阅、可续传的事件流，再把输出投递到各个通道。

agents-io 提供底层机制。信任、审批、模型选择、任务和记忆由宿主管理，通过 `Policy` 钩子接入。项目边界见 [定位文档](docs/POSITIONING.md)。

## 工作原理

```text
飞书 / 邮件 / 私有通道 (JSONL) / 终端
                 │
                 ▼
          InboundEnvelope ─▶ Ingress (Policy) ─▶ Lane (每个 session 一条队列)
                                                        │ startTurn / steer / interrupt / respond
                                                        ▼
                                               Claude Code / Codex harness
                                                        │ HarnessEvent
                                                        ▼
                       多端订阅 ◀── Hub (fromSeq, tier) ◀── SessionLog (seq)
                       通道投递 ◀── Compositor + Outbox (流式卡片、幂等)
```

## 包

| 包 | 用途 |
| --- | --- |
| `packages/protocol` | 入站信封、会话事件、命令、通道与 harness 接口、`Policy` 钩子、进程外 JSONL 帧及客户端帧；`schema/` 下有 JSON Schema。 |
| `packages/testkit` | 事件流与通道一致性检查；`FakeChannel` 和 `FakeHarness`。 |
| `packages/session` | 带序号的内存或 SQLite 日志、订阅与快照、Lane 的合批、steer、对账与审批处理，以及默认策略、Outbox 和 Compositor。 |
| `harness/claude-code` | 通过 Claude Agent SDK 驱动 Claude Code。 |
| `harness/codex` | 通过 stdio 或 Unix socket 使用 `codex app-server`；宿主重启不会打断进行中的轮次。 |
| `channel/lark-bot` | 官方飞书/Lark 机器人，支持长连接和流式卡片；可用 [create-lark-bot](https://github.com/Ghost-LZW/create-lark-bot) 创建应用。 |
| `channel/mail` | 通过 IMAP 收信、SMTP 发信，以 DKIM/DMARC 作为身份证据。 |
| `channel/jsonl-bridge` | 通过 stdio 或 socket 接入用任何语言编写的私有通道。 |
| `packages/daemon` | `aio` 守护进程与命令行：通道、Binding 表、宿主协议、task run、宿主入站队列、终端端点和端到端场景。 |
| `examples/dev-gateway` | `aio-dev`，兼容 `aio` 旧名称的包装。 |

## 快速开始

需要 **Node.js 24+** 和 **pnpm**。

```sh
pnpm install
pnpm build
pnpm test                 # 单元测试；真机测试默认跳过
```

真实 Claude Code、Codex 和飞书的完整配置及端到端测试见 [E2E 指南](docs/E2E.md)。设计与调研资料见 [文档目录](docs/README.md)。

## 许可证

[MIT](LICENSE)
