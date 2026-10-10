# @agents-io/daemon (`aio`)

The agents-io daemon and its CLI. `aio serve` runs everything in one long-lived
process: channels (Lark, mail, JSONL bridges, in-process plugin modules), the binding-table router, one lane
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
  `<agent>:main`). Each session remembers its agent. If that agent is later
  removed or renamed (or becomes a task agent), the session fails closed: every
  input is refused with `agent_unavailable` (a client command's error code, a
  `notice` and `input.rejected` in the session log, one short message on the
  channel route when the message was addressed to the agent — observe-only
  `context` deliveries stay silent there — and `rejected: { code }` on the rule in
  `explain`). Other client commands (interrupt, resolve, control) fail with the
  same code and write nothing. It never falls back to the agent its key's prefix
  names or to the default agent. The only way to continue such a session is to
  configure that agent again (as an interactive agent); there is no command yet
  to retire or re-pin it.
- **Channel entries** (`channels[]`): `lark-bot`, `mail`, `bridge` (out-of-process,
  JSONL stdio, any language, no blob store) and `module` (in-process plugin:
  `{ "type": "module", "module": "../my-channel", "export": "createChannel",
  "account": "lan", "config": { "token": "env:MY_TOKEN" } }`). `module` is a path
  relative to the config file (a package directory or a `.js` / `.mjs` file) or a bare
  specifier; the module exports a `ChannelFactory` (`@agents-io/protocol`) as
  `createChannel` (or `default`). It runs in the daemon's process with the blob
  store, so load only code you trust. Two channels with the same (id, account)
  fail the start. See `docs/CHANNELS.md` §5.
- **Live (realtime voice, decision 11)**: a Codex instance with `"live": true` opts
  its app-server connection into Codex's experimental realtime API. Agents on it
  (with `tools`) get `live_join { target, channel?, instructions?, voice? }`,
  `live_say { text }` and `live_leave`: a channel that implements
  `ChannelAdapter.openLive` (e.g. a meeting) provides the media peer, the session's
  Codex thread answers it with realtime v3 over WebRTC, and the audio flows between
  them, never through the daemon. What people say there is delegated by the voice
  into turns of the same session (same permissions as its text turns; inputs carry
  `live=true`, no principal). See `docs/CHANNELS.md` §7a.
- Interactive turns plan `{ harness, model, effort }` from the agent; the profile
  is the agent's `profile`, else the policy's (owners only → `bypass`). Task runs
  use the agent's `profile`, default `restricted`.
- Default `dataDir` is `~/.agents-io/aio`; the socket defaults to
  `<dataDir>/run/aio.sock` (directory 0700, socket 0600).

## Host connection

`aio serve` writes a fresh host token to `<socket>.token` (0600) at every start and
removes it at stop. For a token that stays the same across restarts, set
`host.tokenFile` in the config (relative to the config file) or pass
`aio serve --token-file <path>` (wins): the file is read when it exists (it must be a
regular file of this user, not accessible to group / others, in a directory others
cannot write, holding at least 16 characters without whitespace; otherwise the daemon
does not start), else a fresh token is generated and written there (0600, a missing
directory is created 0700). It is still copied to `<socket>.token` for the CLI; the
daemon never removes or rotates the operator's file. A connection sends `host.hello { token, name, consumer?, callouts? }`
before any host frame; after it, the connection's client frames carry the origin
`{ kind: "system", principal: "host:<name>" }`.

- Any number of authenticated connections may use the request frames (the CLI's
  host commands are such connections). A connection whose hello sets `consumer`
  (push-consume the inbound queue) or any callout hook (`callouts`) becomes **the host**: at most
  one at a time (`host_connected` otherwise; a hello with `takeover: true` and the
  valid token replaces the current host instead: its connection is closed, the
  takeover logged, its unacked pushes go to the new host, and the result carries
  `replaced: { name }`; feature `host.takeover`). While it is connected the router's
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
- `callouts` is `true` (= `["route"]`) or a list of hooks: `route`, `resolve`,
  `outbound` (unknown names are ignored; the hello result's `callouts` lists the
  granted ones). `policy { hook: "resolve", args: { request, ctx } }` is
  `Policy.resolve` (answer a `Resolver`); on timeout (`hostCallouts.resolve.timeoutMs`,
  default 3000), an error or a bad answer the local policy decides.
  `policy { hook: "outbound", args: { from, to } }` is `Policy.outbound` (answer
  `{ verdict }`); timeout (`hostCallouts.outbound.timeoutMs`, default 2000), error or
  a bad answer deny. Without a host that answers the hook, the local policy decides.
- `resolve { onBehalfOf }` (host connections only): answer a request as that
  principal. A `human` request still requires it among its `principals`; the log
  records `by: { kind, id: <principal>, via: "host:<name>" }`.
- `run.start`: only `mode: task` agents. A fresh session `run:<runId>`, its own
  harness adapter (Codex: its own app-server over stdio) with the request `env`
  over the instance's env, in the child process only (never logged, never on
  argv; the daemon also sets `AGENTS_IO_RUN_ID`).
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
- `inbound.redispatch { cursor, agent?, session?, launch? }`: deliver a queued
  host-inbound item (one still in the queue, acked or not) to the session a
  `dispatch` rule for `agent` (default agent) with `session` (default
  `per-conversation`, or `{ key }`) would pick, as the input it was when it
  arrived: original origin (sender, principal, evidence, route), content, reply
  route and channel context, plus `channelContext.redispatchedBy`. The new input id
  is `<original>~r<cursor>`. `launch` is checked as in a callout answer. Idempotent
  per cursor: a second request answers the first outcome with `duplicate: true`
  (a failed delivery is not recorded, so another session may be tried). It does
  not ack the item. `explain` shows `redispatchOf` on the new input and
  `redispatched` on the original. Errors: `unknown_cursor`, `unknown_agent`,
  `not_interactive_agent`, `invalid_frame`, launch codes (`launch_conflict`, …),
  `agent_unavailable`.
- `explain { inputId }`: the persisted routing record.

## Console API (for web UIs)

`aio serve` also serves the console API of `packages/protocol/src/admin.ts`
(HTTP under `/api`, WebSocket `/ws`), so a web UI in another repo can be built
against the protocol alone.

```jsonc
"console": {
  "enabled": true,            // default true for `aio serve`
  "host": "127.0.0.1",        // default; a non-loopback host is refused unless "allowRemote": true (then a warning at start)
  "port": 7464,               // 0: any free port; the URL is written to <socket>.console (0600) after a successful bind
  "allowedHosts": ["aio.lan"], // extra Host header names (LAN name/address); required with "host": "0.0.0.0" / "::" and allowRemote
  "origins": ["https://ui.example"],   // CORS for a separately hosted UI; none by default
  "uiUrl": "https://ui.example",       // where login links point (default: the console itself)
  "sessionTtlMs": 43200000,
  "larkBotCommand": ["npx", "-y", "github:Ghost-LZW/create-lark-bot#v0.2.4"],
  "heartbeat": { "intervalMs": 30000, "timeoutMs": 10000 },  // /ws ping; no answer in timeoutMs → closed (0 interval: off)
  "liveChannels": false       // true: channel changes written through the console start/stop channels at once
}
```

- **Auth**: `Authorization: Bearer <token>` with the host token (`<socket>.token`)
  or a console session token; for `/ws` from a browser the subprotocols
  `["agents-io.v1", "agents-io.bearer.<token>"]`; the session cookie
  (`aio_console_<instance id>`, random per daemon start, HttpOnly,
  SameSite=Strict, Path=/). Explicit credentials (header, then subprotocol) win
  over the cookie. Cookies are not port-scoped: the browser sends it to every
  server on that host name, whatever the port, and any of them could replay it.
  A session only works through the `Host` it logged in with, but non-browser
  clients and separately hosted UIs should keep the session token and send it
  as a bearer token or the subprotocol. `aio console-link` prints a
  one-time login URL (`<uiUrl>/#login=<token>`, 5 minutes, single use);
  `POST /api/login { loginToken }` exchanges it for a session (cookie + token).
  Missing, wrong or expired credentials → 401. Sessions live in memory (gone at
  restart). Login links are made with the host token only
  (`POST /api/login-link`); `aio console-link` first has the console answer
  `POST /api/console-proof { challenge }` with an HMAC keyed by the host token,
  so a stale `<socket>.console` pointing at someone else's listener never gets
  the token. The daemon removes that file at start, writes it only once bound,
  and removes it at stop.
- **Origins**: requests with an `Origin` that is neither the console's own nor in
  `origins` → 403; requests whose `Host` is not loopback, the configured
  (concrete) host or in `allowedHosts` → 403 (DNS rebinding). A wildcard bind is
  advertised as `http://127.0.0.1:<port>`. Bodies must be `application/json`.
- **Endpoints**: `GET /api/status`, `GET|PUT /api/config`,
  `POST /api/config/validate`, `GET /api/explain/:inputId`, `GET /api/queue`,
  `GET /api/sessions`, `POST /api/bots/lark`, `GET /api/bots/lark/:job`; `GET /`
  is a minimal page that completes a login link opened on the console itself.
- **Config**: credential fields follow the config schema: every value of an
  `env` map (harness instance, `mcpServers.<id>.env`, `settings.env`, bridge
  channel, codex `mcp_servers.<id>.env`), every header (`headers`,
  `http_headers`), codex `bearer_token`s, mail `imap|smtp.auth.pass` /
  `accessToken`, lark-bot `appSecret` / `encryptKey` / `verificationToken`, a
  bridge argument after a secret-looking flag, and in free-form parts any string
  under a secret-looking key. `GET` shows them only as `env:NAME` references or
  `<redacted>`, plus each referenced variable as set / unset (never its value).
  `PUT` (and `validate`) run the startup validation (`resolveConfig`, with the
  env file read afresh), keep stored values where a credential field says
  `<redacted>` (elsewhere the marker is an error), refuse new literals in
  credential fields (`inline_secret`, 422),
  honor `ifRevision` (409), and write atomically (temp + fsync + rename, 0600).
  The daemon does not reload: `applied: "restart"` unless the file is back to
  what it runs. With `liveChannels: true` the `channels` part is applied at once:
  entries new or changed (compared after env substitution) start, entries gone or
  changed stop (stops first), the rest keep running, and sessions already open
  render to the new ones; the answer's `channels` lists `started` / `stopped` /
  `failed`, and `applied` is `"live"` when nothing else differs (otherwise the
  rest still needs a restart). `started` means launched and not failed within a
  short grace (1 s); a bridge not connected, or a start that failed at once, is in
  `failed` (and `applied` stays `"restart"`); a failure an adapter only logs while
  retrying (lark-bot with bad credentials) shows in `GET /api/status` / the log
  only. Off by default (docs/design/live-channels).
- **`/ws`**: exactly the local socket's frames. The server pings every
  `heartbeat.intervalMs`; a connection that answers neither with a pong nor any
  message within `heartbeat.timeoutMs` is terminated (logged), which frees the host
  role a half-open remote host held. Client frames carry the local
  principal with `via: "console"`, `adapter: "console"`; host frames work after
  `host.hello` with the host token.
- **Lark bot provisioning**: `POST /api/bots/lark` runs `larkBotCommand` with
  `--qr-out <file> --json --write-env <env file> --name … --brand … --preset …`
  (`--avatar` from a `data:` URI, `--no-owner`, and `--env-prefix LARK_<ACCOUNT>_`
  for an `account` other than `default`; create-lark-bot ≥ 0.2.4); the job goes
  `starting` → `waiting_scan` (the QR file's content as `qr.payload`) →
  `configuring` → `succeeded` / `failed` / `expired`. A daemon runs one bot per
  channel account (decision 8). Credentials go only to the env file, under the
  account's names: `LARK_APP_ID` / `LARK_APP_SECRET` / `LARK_DOMAIN` for
  `default`, `LARK_PROJ_A_APP_ID` / … for `proj-a`; the job shows their `env:`
  references. On success the config gets a `lark-bot` channel for the account
  whose `config` references those names explicitly (unless `addChannel: false`)
  and the verified owner `lark-bot:<union_id>` in `policy.owners`; restart to
  start it, or, with `console.liveChannels`, the channel is started before the job
  turns `succeeded` (`result.channelStarted`, false with the reason in the message
  when its start failed at once; a new owner still needs the restart). One job at a time. Refused at start (409, also with `addChannel:
  false`, since the env file would be overwritten): a lark-bot channel with the
  same account, the target variables already set (env file or environment), or
  another channel reading them (`proj-a` and `proj_a` share names); a bad
  account name is 400. The scan may take minutes, so before writing, the config
  is checked again as it is then: the same account added meanwhile (`conflict`),
  the new app already run by a configured channel (`duplicate_app`), or a config
  that would not load (`config_invalid`, the `PUT` validation) fail the job and
  write nothing; the credentials stay in the env file, unreferenced, and the
  message names them (remove them by hand).

## Topics (decision 6)

A flat conversation (no platform threads) can hold several **topics**, each its
own session, with one current topic. A binding with `session: "topic"` routes to
the conversation's current topic; the first one is created on first use and keeps
the conversation's own session key (so a session from before topics carries on),
later ones are `<that key>#<topicId>`. A threaded message stays per thread. The
default owner-DM rule (`default:owner-dm`) uses `topic`; group rules are unchanged
(`per-thread`). Context (and digest items) of a flat conversation that keeps topics
goes to its current topic, also from `per-thread` rules such as the default
`observe-<kind>`.

- The table (`topics`, in the log's SQLite database): title, summary, session key,
  the harness's native session id (from `session.bound`), current / parked, created
  and last-active times. Parked topics are never deleted.
- Every change appends `topic.changed { conversation, from?, to, title?, reason }`
  to the session left and the one now current.
- Inputs routed to a topic carry `channelContext.topic` / `topicTitle` (the model
  sees them in its input preface; an input rewritten into another topic's session,
  e.g. an answer to a question a parked topic asked, carries that topic) and, in the
  current topic and when the target agent has the output tools, `topicTools`: one line on when to call `session_rotate` / `session_switch`
  (without it, small models never rotate). A message handed over by a rotate or
  switch carries `handedFrom` and a line saying to answer it there; the tools
  refuse to move it again, so topics cannot ping-pong.
- When to switch is the agent's call, with the host output tools:
  `session_rotate({ title, summary })` starts a new topic and hands the turn's
  triggering inputs to it (new input ids `<id>><topicId>`), the summary first as a
  labelled context item; the summary is saved on the topic it describes (the one
  parked), so `session_list` shows it on that row; `session_list()`; `session_switch({ topicId })` makes a
  parked topic current again and hands the inputs to it: its lane carries on in
  memory, or after a restart opens the harness with the native id its log recorded
  (`--resume` / thread resume). The tool result tells the model to end the turn
  without answering; the answer comes from the topic now current. Messages of the
  conversation still queued behind that turn follow it (`input.cancelled` reason
  `moved_to_topic` in the old topic, re-queued as `<id>><topicId>`). If the handover
  fails, the conversation switches back (reason `system`) and the tool tells the
  model to answer where it is. The old topic's card for that turn ends as one line,
  `→ Moved to topic "<title>"` (channels that only get final messages get none).
- A parked topic's lane, and its harness session, closes once it has been parked
  and idle for `topics.parkedIdleMs` (default 30 min; `0` keeps it open); switching
  back opens it again, resuming by the native id.
- Or the user's, with chat commands on a topic route: `/new [title]`, `/topics`,
  `/switch <n|id>` (`n` as `/topics` numbers them). They are checked by
  `Policy.control` as a `reset` of the session they were sent to (owner by default),
  never reach the harness, and are answered with one short plain message on the
  route.
- Client frames `topic.list { conversation?, sessionKey? }` and `topic.switch
  { conversation, topicId | new: { title? } }` (`Policy.control` against the
  connection's origin; errors `unknown_conversation`, `unknown_topic`,
  `invalid_frame` when both or neither are given).
- Cards of a topic session carry `channelData["agents-io/topic"] = { title }`; the
  Lark adapter shows it as the card header title (the status moves to the subtitle).

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
aio console-link                                              (one-time console login URL)
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
