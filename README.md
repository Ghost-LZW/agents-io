# agents-io

**English** | [简体中文](README.zh-CN.md)

**Input and output infrastructure for agents.** Turn messages from different channels into a common envelope, expose Claude Code and Codex sessions as subscribable, resumable event streams, and deliver responses back to channels.

agents-io provides the plumbing. The host owns trust, approvals, model selection, tasks, and memory, and connects them through `Policy` hooks. See [Project scope](docs/POSITIONING.md) for the boundary.

## How it works

```text
Lark / email / private channel (JSONL) / terminal
                       │
                       ▼
                InboundEnvelope ─▶ Ingress (Policy) ─▶ Lane (one queue per session)
                                                              │ startTurn / steer / interrupt / respond
                                                              ▼
                                                   Claude Code / Codex harness
                                                              │ HarnessEvent
                                                              ▼
                          Multi-client subscriptions ◀── Hub (fromSeq, tier) ◀── SessionLog (seq)
                          Channel delivery           ◀── Compositor + Outbox (streaming cards, idempotency)
```

## Packages

| Package | Purpose |
| --- | --- |
| `packages/protocol` | Inbound envelopes, session events, commands, channel and harness interfaces, `Policy` hooks, out-of-process JSONL frames, and client frames. JSON Schemas live in `schema/`. |
| `packages/testkit` | Event stream and channel conformance checks; `FakeChannel` and `FakeHarness`. |
| `packages/session` | In-memory or SQLite sequenced logs, subscriptions and snapshots, Lane batching, steering, reconciliation, and approval resolution, plus default policy, Outbox, and Compositor. |
| `harness/claude-code` | Runs Claude Code through the Claude Agent SDK. |
| `harness/codex` | Uses `codex app-server` over stdio or a Unix socket; a host restart does not interrupt an active turn. |
| `channel/lark-bot` | Official Lark/Feishu bot with a long-lived connection and streaming cards. Create an app with [create-lark-bot](https://github.com/Ghost-LZW/create-lark-bot). |
| `channel/mail` | Receives via IMAP and sends via SMTP, using DKIM/DMARC as identity evidence. |
| `channel/jsonl-bridge` | Connects private channels written in any language over stdio or a socket. |
| `packages/daemon` | The `aio` daemon and CLI: channels, bindings, host protocol, task runs, host inbound queue, terminal endpoints, an optional external MCP endpoint for agents outside the daemon, and end-to-end scenarios. |
| `examples/dev-gateway` | `aio-dev`, a compatibility wrapper for the former name of `aio`. |

## Getting started

Requires **Node.js 24+** and **pnpm**.

```sh
pnpm install
pnpm build
pnpm test                 # Unit tests; live tests are skipped by default
```

For a full setup and end-to-end tests with real Claude Code, Codex, and Lark, see the [E2E guide](docs/E2E.md). The [documentation index](docs/README.md) covers the design and research. These detailed guides are currently in Chinese.

## License

[MIT](LICENSE)
