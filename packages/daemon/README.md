# @agents-io/daemon (`aio`)

The agents-io daemon and its CLI. `aio serve` runs everything in one long-lived
process: channels (Lark, mail, JSONL bridges), the binding-table router, one lane
per session, the hub (SQLite session log), compositors + outbox, the host MCP
output tools, watches, the durable host inbound queue, and a local Unix socket
that speaks both the client frames (`packages/protocol/src/client.ts`) and the
host frames (`packages/protocol/src/host.ts`, spec in `docs/HOSTS.md`).

It grew out of `examples/dev-gateway`; that example is now a thin `aio-dev`
wrapper around this CLI.

## Configuration (`aio.config.json`)

`--config <path>`, `$AIO_CONFIG`, or `./aio.config.json`. Everything from the dev
gateway still applies (harness instances, channels, `policy`, `watches`, `local`;
see `docs/E2E.md` §0). New:

```jsonc
{
  "agents": {
    "assistant": { "harness": "claude" },                                   // interactive (default mode)
    "helper":    { "harness": "claude", "model": "opus", "cwd": "~/work", "instructionsFile": "helper.md" },
    "executor":  { "harness": "codex", "mode": "task", "profile": "bypass", "tools": false }
  },
  "defaultAgent": "assistant",          // default: the first interactive agent
  "bindings": [                         // the local binding table (docs/HOSTS.md §2)
    { "id": "owner-dm", "match": { "conversationKind": "dm", "labels": ["owner"] }, "on": "dispatch", "agent": "assistant", "session": "main" },
    { "id": "clicks",   "match": { "actionPrefix": "xwo:" }, "on": "host" }
  ],
  "identities": [                       // identity map entries next to policy.owners
    { "channel": "lark-bot", "channelUserId": "ou_x", "principal": "member-7", "labels": ["team"] }
  ]
}
```

- An **agent** is a named run configuration: harness instance, `model`, `effort`,
  `profile`, `cwd`, `tools` (mount the host MCP output tools; default top-level
  `outputTools`), `instructionsFile` (Claude: appended to the preset system
  prompt; Codex: developer instructions), `mode`.
- `mode: "task"` agents only run through `run.start` / `aio run`. A binding (config
  or host-pushed, including a callout's `onFailure`) that targets one is rejected
  when the config loads.
- Without `agents` there is one agent, `default`, on the default instance; without
  `bindings` the owners-based default table (`ownersTable`) routes to the default
  agent, as the dev gateway did. The default agent keeps bare route-key session
  keys; other agents' sessions are `<agent>:<channel>:<account>:<conversation>` (or
  `<agent>:main`). Each session remembers its agent.
- Interactive turns plan `{ harness, model, effort }` from the agent; the profile
  is the agent's `profile`, else the policy's (owners only → `bypass`). Task runs
  use the agent's `profile`, default `restricted`.
- Default `dataDir` is `~/.agents-io/aio`; the socket defaults to
  `<dataDir>/run/aio.sock` (directory 0700, socket 0600).

## Host connection

`aio serve` writes a fresh host token to `<socket>.token` (0600) at every start and
removes it at stop. A connection sends `host.hello { token, name, consumer?, callouts? }`
before any host frame; after it, the connection's client frames carry the origin
`{ kind: "system", principal: "host:<name>" }`.

- Any number of authenticated connections may use the request frames (the CLI's
  host commands are such connections). A connection whose hello sets `consumer`
  (push-consume the inbound queue) or `callouts: true` becomes **the host**: at most
  one at a time (`host_connected` otherwise). While it is connected the router's
  host table is active even with `onHostDown: "suspend"`, `route` callouts go to it,
  and runs whose own connection left report `run.ended` to it.
- `bindings.put` / `bindings.get`: the host table, persisted in the log's database
  (same version + content = no-op). `bindings.get` also returns the config table.
- `inbound` push: one item at a time; the consumer's cursor moves when the host
  answers `result { accepted: true }`; anything else (or no answer in 30 s) is
  retried; unacked items are pushed again after a reconnect.
- `inbound.read` / `inbound.ack`: pull (long-poll with `waitMs`, at most 5 min).
  Reads never move the cursor.
- `policy { hook: "route" }`: the callout of a rule with `callout`; the rule's
  `timeoutMs` and `onFailure` apply, and the outcome is in `explain`.
- `run.start`: only `mode: task` agents. A fresh session `run:<runId>`, its own
  harness adapter (Codex: its own app-server over stdio) with the request `env`
  over the instance's env, in the child process only (never logged, never on
  argv; the daemon also sets `AGENTS_IO_RUN_ID` and `AGENTS_IO_TURN_PROVENANCE`).
  The input is the turn's content; the turn ends → `run.ended { status, exitCode }`
  and the session closes. `runId` is an idempotency key: starting an ended run
  again answers `state: "ended"` with its outcome. `run.cancel` interrupts;
  `timeoutMs` interrupts with `error.code: "timeout"`; `observe.routes` renders
  the run on those routes through the compositors. A run left mid-turn by a
  previous daemon is settled `ambiguous` at start.
  Exit codes: 0 completed, 1 failed, 3 ambiguous, 124 timed out, 130 interrupted.
- `deliver`: through the outbox, idempotent per `operationId` (also across
  restarts: settled deliveries are in the database). Value: the delivery record
  plus `duplicate`.
- `input.verify { channelRef }`: what the channel reported about that message's
  author (channel user id, display name, bot flag), its evidence, and the
  principal / labels the identity map stamped, per receiving account; `found:
  false` when the daemon never received it. Never a guess.
- `explain { inputId }`: the persisted routing record.

## CLI

```
aio serve | e2e | attach | input | sessions | watch …           (as aio-dev; `aio-dev send` is `aio input`)
aio run --agent <task agent> [--run-id <id>] [--cwd <dir>] [--env K=V …] [--timeout 10m] [--observe <route json> …] -- <instruction>
aio send --route <route json> --operation-id <id> [--file message.json|-] [--text <text>]
aio tail --consumer <name> [--from <cursor>] [--once]
aio ack --consumer <name> <cursor>
aio bindings put [--file table.json|-] | get
aio explain <inputId>
aio verify <channelRef>
```

- Host commands find the socket from `--socket`, `$AIO_SOCKET`, or the config, and
  read the token next to it; `--name` sets the host name (default `aio-<command>`).
- `aio run` subscribes to `run:<runId>` first, starts the run, streams one short
  line per tool call / request / notice to stderr, prints the final answer to
  stdout, and exits with the run's exit code. Ctrl-C cancels the run (twice:
  stop waiting).
- `aio tail` prints one JSON `InboundItem` per line (with its `cursor`) and keeps
  long-polling; it never acks. `--once` prints what is pending and exits.
- Exit codes besides a run's: 1 failed, 2 usage / config error (also an unknown
  or interactive agent), 69 daemon not running (no socket or token file), 77 wrong
  token.

## Library

`import { Gateway /* = Daemon */, LocalClient, resolveConfig } from '@agents-io/daemon'`:
`Gateway.start({ config, … })` starts everything in-process (tests and e2e use
`harness` / `buildHarness` / `channels` to inject fakes); `LocalClient` speaks both
client and host frames (`hello`, `runStart`, `runEndedOf`, `inboundRead`, `onRequest('inbound' | 'policy', …)`, …).
