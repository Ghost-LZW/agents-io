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
| `packages/testkit` | Event stream, channel and harness conformance checks; `FakeChannel` and `FakeHarness`. |
| `packages/session` | In-memory or SQLite sequenced logs, subscriptions and snapshots, Lane batching, steering, reconciliation, and approval resolution, plus default policy, Outbox, and Compositor. |
| `packages/host-mcp` | The tools the model is offered: the kernel's channel-neutral output tools (`send_message`, `send_file`, `ask_choice`, `mention`, `reply_to`, `get_channel_context`) and the modules' tool groups, served over MCP; also the external MCP endpoint's server. |
| `harness/claude-code` | Runs Claude Code through the Claude Agent SDK; also the `aio tui` terminal takeover and its `aio tui-bridge`. |
| `harness/codex` | Uses `codex app-server` over stdio or a Unix socket; a host restart does not interrupt an active turn. |
| `harness/jsonl-bridge` | Connects harnesses written in any language over stdio (`use: "bridge"`), with the same declarations, stop and restart, and blob access as in-process ones; `serveHarness` serves an adapter as such a program. |
| `channel/lark-bot` | Official Lark/Feishu bot with a long-lived connection and streaming cards. Create an app with [create-lark-bot](https://github.com/Ghost-LZW/create-lark-bot), or from the console (`POST /api/bots/lark`, whose schemas live in this package's `schema/`). |
| `channel/mail` | Receives via IMAP and sends via SMTP, using DKIM/DMARC as identity evidence. |
| `channel/jsonl-bridge` | Connects private channels written in any language over stdio or a socket. |
| `packages/kernel` | The daemon kernel with no module in it: the gateway, config resolution, the module host and registries, the local socket, host and client protocol services, records, and the console core. Depends on no channel or harness package; a registry not given is an empty one (`coreRegistries`), so it runs with only the channels and harnesses an embedder passes. |
| `packages/daemon` | The `aio` daemon and CLI: the composition root that registers the built-in channels, harnesses and feature modules (topic titles, model tool groups, owner commands, presets, stranger approval, and an optional external MCP endpoint for agents outside the daemon) on the kernel, and re-exports the kernel's API with them as the defaults. |
| `packages/daemon-e2e` | `aio-e2e` (`pnpm e2e`): end-to-end scenarios against the real Claude Code or Codex from the config, each in its own in-process daemon. Private; not part of the daemon package. |
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
