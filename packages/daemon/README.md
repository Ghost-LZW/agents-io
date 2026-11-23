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
  "presets": {                          // harness instance + model + effort; `/preset <name>` switches a session
    "codex-high": { "harness": "codex", "model": "gpt-6-sol", "effort": "high" },
    "claude":     { "harness": "claude", "model": "opus", "description": "for reviews" }
  },
  "agents": {
    "assistant": { "harness": "claude" },                                   // interactive (default mode)
    "helper":    { "harness": "claude", "model": "opus", "cwd": "~/work", "instructionsFile": "helper.md" },
    "coder":     { "preset": "codex-high", "cwd": "~/repos" },               // harness, model, effort from the preset
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

- A **preset** names a harness instance with its `model` and `effort` (and a
  `description` for `/preset`); unset ones come from the instance's `run`. An agent
  gives either `harness` or `preset` (its own `model` / `effort` still win over the
  preset's). In a chat the owner lists them with `/preset` and switches the current
  session (topic) with `/preset <name>` from the next turn, dropping what `/model` and
  `/effort` set there; `/preset default` goes back to the agent's own. Another instance
  opens its own harness session (it has not seen what was said on the previous one;
  switching back resumes that one) with the agent's cwd, instructions and tools; the
  permission profile does not change with the preset. `default` is not a preset name.
  See `docs/E2E.md` (预设).
- An **agent** is a named run configuration: harness instance (or `preset`), `model`, `effort`,
  `profile`, `cwd`, `tools` (mount the host MCP output tools; default top-level
  `outputTools`, which defaults to **false** since 2026-10-11: turn tools on per
  agent with `"tools": true`, or for all agents with `"outputTools": true`; the watch, live and
  topic tools are built-in modules, each group on unless its section says so:
  `watchTools` / `liveTools` / `topicTools: { "enabled": false }`), `instructionsFile` (Claude: appended to the preset system
  prompt; Codex: developer instructions), `mode`. Without `instructionsFile` the
  harness keeps its own system prompt (Claude Code's preset, Codex's base instructions).
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
  fail the start. See `docs/CHANNELS.md` §5. The four are the channel types the
  composition root registers (`src/bundle.ts`): each is a `ChannelModule`
  (`@agents-io/protocol`, `channel-module.ts`) that owns its keys, how they resolve
  (`env:` substitution, paths, Lark's `LARK_APP_*` fallback), the rules across its
  entries (several Lark bots, one bridge program per channel id), which of its strings
  are credentials (`x-credential`, `isCredential`; the console's advice about a literal one,
  `credentialHint`), who owns its channel ids and how its
  adapter is built. `lark-bot`, `mail` and `bridge` are in their packages
  (`channel/*/src/module.ts`); `module` is the daemon's own (`src/module-channel.ts`).
  The bundle also says which types' adapters are trusted with their caps' evidence
  without an `evidence` grant (lark-bot, mail). The daemon's config code, its gateway and
  its console name no type: what a type adds to the console (lark-bot's `/api/bots/lark`
  and `console.larkBotCommand`) is its own `ChannelModule.admin` contribution.
- **Harness instances** (`harnesses.<name>`, `use`: `claude-code`, `codex` or `module`;
  see `docs/E2E.md` §0). `claude-code` and `codex` are the harness kinds the daemon's
  composition root registers (`src/bundle.ts`): each is a `HarnessModule`
  (`@agents-io/protocol`, `harness-module.ts`) in its own package (`harness/*/src/module.ts`)
  that owns its keys, its section of the older `harness` block, its default model and
  `AGENTS_IO_LIVE_*_MODEL` variable, its config-dir variable (`sessionParams.envPathRoots`),
  its rules across instances (Codex: no two share a `stateDir`) and how its adapter is built;
  the daemon's config code and its construction of adapters name no kind (only the native
  terminal takeover still knows Claude Code). A `module` entry's module exports a `HarnessFactory`
  (`@agents-io/protocol`), or a `HarnessModule` (its `schema` checks the entry's `config` at
  start, its `create` gets the factory's init plus `launch` = that config, the instance's `env`
  and `profiles`); the adapter it returns serves every session of the instance.
  Stop and restart follow what the adapter declares, built-in or module alike
  (`HarnessAdapter` in `packages/protocol/src/harness.ts`): with `detach()` its lanes are
  detached at stop (a running turn stays open in the log) and `detach()` is called once;
  without it its sessions are closed and then `dispose()` is called, when it has one.
  With `adopts: true` (static) a restarted daemon reopens the sessions left mid-turn so
  the harness can adopt the turn; otherwise such a turn is settled ambiguous
  (`host_restarted`) at start without opening the harness. Every loaded module instance
  gets these calls at stop, whether or not a session or task run used it; an adapter
  object that several instances share gets each call once. Codex declares `detach` on
  both transports and `adopts` on a Unix socket only; Claude Code declares none.
  Chat commands, `/status` and `session.compact` read the adapter's other static
  declarations, never the instance's kind: `compact: { command }` (a turn whose one input
  is that native command compacts the context: `/compact` and `session.compact` send it;
  Claude Code declares `/compact`), `modes: ['plan']` (`/plan`, the Plan line of `/status`;
  Codex), `ownerProfileSwitch: true` (`/bypass`; Codex only, although Claude Code maps
  `bypass` too) and `displayName` (how replies name the harness, e.g. "/plan is available
  only on Codex"; else the instance name). Without them those commands answer that they are
  unavailable; when no configured instance declares `modes` / `ownerProfileSwitch`, the reply
  names the registered kinds that do (`HarnessModule.declares`), so a deployment with only Claude
  Code configured still hears "/plan is available only on Codex". `ephemeralOpen: true` (Codex): the
  daemon runs a module's ephemeral turns on it (`KernelLaneHarness.ephemeralTurn`, "Feature
  modules" below; the topic titles module `topic-title` is one); the open options it sends are
  Codex's shape.
  A launched session's env (decision 7) reaches the harness as its adapter declares
  (`sessionEnv`): `'open'` (the default; Claude Code) puts it in the open args;
  `'own-process'` (Codex over stdio) runs the session on the adapter `ownProcess({ env, cwd })`
  returns, disposed when the session's lane closes; `{ refused }` (Codex on a Unix socket:
  "a shared Codex app-server (unix transport)") refuses a launch with env
  (`launch_unsupported`), a cwd alone is fine. `sessionEnv` governs a launched session's env
  only: a module harness's opens (also those on an adapter its `ownProcess` returned) always
  carry the instance's `env` in the open args, with a task run's env over it. An instance that
  is unavailable for now (an `env:` reference is not set) answers as it will once it is
  available; a module one, whose
  factory never ran, cannot say, so a launch with env is refused too (`launch_unsupported`,
  saying why it is unavailable). A task run always gets a process of its own
  when the adapter has `ownProcess` (the run's env joins the instance's, under its configured
  config dir). The agent's instructions arrive as `HarnessOpenArgs.instructions` (Claude Code
  appends them to its preset system prompt, Codex sends them as developer instructions); a
  module harness also gets them as `options.developerInstructions` for now. A module's factory
  gets a read-only view of the daemon's blob store (`init.blobs`: `stat` / `get` and nothing
  else, each usable detached), which the built-in adapters resolve media inputs with too
  (Claude Code's 3.75 MB inline image limit lives in its package); resolvers given in the open
  options win. What the factory returns is checked before the daemon starts: a static
  declaration or lifecycle member of the wrong type (`modes` that is not an array of `'plan'`,
  `sessionEnv` that is `null` or an unknown string, `compact` without a `command`, a `detach` or
  `nativeClient` that is not a function, …) fails the start, naming the instance and the member.
- **Live (realtime voice, decision 11)**: a Codex instance with `"live": true` opts
  its app-server connection into Codex's experimental realtime API. Agents on it
  (with `tools`) get `live_join { target, channel?, instructions?, voice? }`,
  `live_say { text }` and `live_leave`: a channel that implements
  `ChannelAdapter.openLive` (e.g. a meeting) provides the media peer, the session's
  Codex thread answers it with realtime v3 over WebRTC, and the audio flows between
  them, never through the daemon. What people say there is delegated by the voice
  into turns of the same session (same permissions as its text turns; inputs carry
  `live=true`, no principal). See `docs/CHANNELS.md` §7a.
- Interactive turns plan `{ harness, model, effort }` from the agent (or the preset
  `/preset` set for the session); the profile is the agent's `profile`, else the
  policy's (owners only → `bypass`). Task runs use the agent's `profile`, default
  `restricted`.
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
- `resolve { onBehalfOf }` (host connections only, and only with
  `policy.answerOnBehalf: true`, default false; otherwise `on_behalf_not_allowed`
  and the `resolve.onBehalfOf` feature is not advertised): answer a request as that
  principal. A `human` request still requires it among its `principals`; the log
  records `by: { kind, id: <principal>, via: "host:<name>" }`.
- `run.start`: only `mode: task` agents. A fresh session `run:<runId>`, its own
  harness adapter (Codex: its own app-server over stdio) with the request `env`
  over the instance's env, in the child process only (never logged, never on
  argv; the daemon also sets `AGENTS_IO_RUN_ID`).
  The input is the turn's content; the turn ends → `run.ended { status, exitCode,
  turnId, inputId, durationMs, usage }` (usage: the turn's `turn.completed.usage`)
  and the session closes. Every run's end is in its log (the daemon writes one when
  the harness left none), and `run.ended` is built from the log: `runId` is an
  idempotency key, and starting an ended run again answers `state: "ended"` with the
  same frame, also after a restart. `run.cancel` interrupts; `timeoutMs` interrupts
  and ends the run `timeout` (a `run_timeout` notice in its log); a stopping daemon
  interrupts it and it ends `interrupted` with `daemon_stopping` (a `run_stopping`
  notice); `observe.routes` renders the run on those routes through the compositors.
  A run left mid-turn by a previous daemon is settled `ambiguous` at start.
  `overrides { preset, model, effort, profile }` change this run's RunSpec only
  (the answer's `run`), or fail `bad_override`: a preset must be configured, and a
  `profile` / `preset` override needs a profile the run's instance defines or a
  built-in one (`bypass`, `restricted`). The default cwd stays the agent's (a preset
  does not move it). `inputId` names the run's input (unique:
  else `input_id_taken`); `correlation` is an opaque id kept on the input (never
  shown to the model) and echoed in `run.ended`; `explain <inputId>` shows the run.
  Features `run.overrides`, `run.ended.usage`, `run.correlation`.
  Exit codes: 0 completed, 1 failed, 3 ambiguous, 124 timed out, 130 interrupted.
- `deliver`: through the outbox, idempotent per `operationId` (also across
  restarts: settled deliveries are in the database). Value: the delivery record
  plus `duplicate`. When the outcome cannot be recorded after the send (the
  record, the outbound index and `delivery.settled` commit together; a full
  disk or an I/O error fails all three) the answer is `internal` with that
  error, the message may have gone out, and nothing is settled yet (`explain`
  of the operationId: `unknown_input`). The same `operationId` again is never
  sent: in the same process it settles `unknown` (`duplicate: false`, `error:
  "recording its outcome failed in this process (…); not resent"`); after a
  restart the start has settled it `unknown` (`duplicate: true`). Treat it as
  unknown; a new `operationId` may send it twice (INVARIANTS DL-1).
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
against the protocol alone. Channel types add to it (`ChannelModule.admin`, an
`AdminContribution` of `packages/protocol/src/admin-module.ts`): keys of the
`console` section, routes the console serves after its own with the same auth and
conventions, and what runs behind them (`mount`, with an `AdminContext`: the type's
console settings, the private directory `<dataDir>/provision`, the config file as a
`ConfigAccess`). `adminEndpoints(registry)` lists the core endpoints
(`ADMIN_ENDPOINTS`) and the registry's. Lark bot provisioning (`/api/bots/lark`,
`console.larkBotCommand`) is the lark-bot module's (`larkBotAdmin` in
`channel/lark-bot/src/provision-admin.ts`): its schemas are
`channel/lark-bot/src/admin.ts` (`LARK_BOT_ADMIN_ENDPOINTS`, JSON Schemas in
`channel/lark-bot/schema/`) and its jobs `LarkBotJobs`
(`channel/lark-bot/src/provision.ts`). A daemon whose channel registry lacks
lark-bot does not serve `/api/bots/lark` (404 `not_found`, as any unknown route).

Moved (2026-11-23, core-slimming P0): `AdminLarkBotRequest`,
`AdminLarkBotStarted`, `AdminLarkBotJob` and `AdminLarkBotJobState` are no
longer exported by `@agents-io/protocol`, and `ADMIN_ENDPOINTS` lists only the
core endpoints; import them and `LARK_BOT_ADMIN_ENDPOINTS` from
`@agents-io/channel-lark-bot`. Their JSON Schemas moved from
`packages/protocol/schema/` to `channel/lark-bot/schema/`, content and `$id`
(`agents-io/v1/AdminLarkBot*`) unchanged. This package no longer re-exports
`LarkBotJobs`, `larkEnvNames`, `LarkBotJobsOptions` or `StartOutcome`: they are
`@agents-io/channel-lark-bot`'s, and `LarkBotJobsOptions` now takes a
`ProvisionConfig` (the daemon's `ConfigStore` is one), `envRefs` and a plain
log function. The HTTP API is unchanged on the wire.

```jsonc
"console": {
  "enabled": true,            // default true for `aio serve`
  "host": "127.0.0.1",        // default; a non-loopback host is refused unless "allowRemote": true (then a warning at start)
  "port": 7464,               // 0: any free port; the URL is written to <socket>.console (0600) after a successful bind
  "allowedHosts": ["aio.lan"], // extra Host header names (LAN name/address); required with "host": "0.0.0.0" / "::" and allowRemote
  "origins": ["https://ui.example"],   // CORS for a separately hosted UI; none by default
  "uiUrl": "https://ui.example",       // where login links point (default: the console itself)
  "sessionTtlMs": 43200000,
  "larkBotCommand": ["npx", "-y", "github:Ghost-LZW/create-lark-bot#v0.2.4"],  // lark-bot's setting (its default)
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
  `GET /api/sessions`, and the channel types' (`POST /api/bots/lark`,
  `GET /api/bots/lark/:job` from lark-bot); `GET /` is a minimal page that completes
  a login link opened on the console itself.
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

## External MCP endpoint (agents outside the daemon)

Off unless configured. Agents that do not run in this daemon (a Claude Code or Codex
on the operator's machine, a host's proxy for its users) read sessions and write
through it, each as a configured client. Design: `docs/design/external-mcp/`;
host side: `docs/HOSTS.md` §4.2.

```jsonc
"externalMcp": {
  "listen": "127.0.0.1:7465",   // default; loopback only (127.0.0.1 or [::1]); port 0: any free port
  "clients": {
    "laptop": {
      "token": "env:AIO_MCP_LAPTOP_TOKEN",          // env:NAME only; or "tokenFile": "mcp/laptop.token" (read, or generated 0600)
      "scopes": ["read", "send:lark-bot:default:*", "input:assistant:*"],
      "declare": false                              // true: may send X-Agents-IO-Declared: <whom it acts for>
    }
  },
  "limits": { "maxBodyBytes": 262144, "maxTextChars": 16000, "requestsPerMinute": 120, "writesPerMinute": 20 }
}
```

- Streamable HTTP, stateless, JSON answers; `Authorization: Bearer <client token>`.
  Requests with an `Origin` header or a non-loopback `Host` are refused (403).
- Deny by default: a client lists and may call only what its scopes allow:
  `read` / `read:<session pattern>` → `sessions_list`, `session_events`, `explain`
  (and, with plain `read`, `channels_status`); `send:<route pattern>` → `send_message`;
  `input:<session pattern>` → `session_input`. `*` matches any run of characters.
- What a client does is stamped by the daemon: `kind: "peer"`, principal
  `external:<name>` (never a person), evidence `device_only`; inputs carry a cause
  and pass the loop guard; sends go through the outbound check and the outbox
  (operationId `external:<name>:<operation_id>`, sent at most once) and
  `aio explain <operationId>` names the client.
- A host whose hello lists the `external` callout decides every write (fail closed).
- It is a built-in feature module (id `external-mcp`, `src/external-mcp.ts`, registered last in
  `bundle.ts`: it starts after everything else and stops first). `host.hello` lists `external.mcp`
  while it listens (after the kernel's features); `callouts.external` is always listed.
  `GET /api/status` shows `externalMcp: { url, clients }` while it listens, and its `modules` entry.
  A bad client token or token file fails the start; a port that is taken is logged, not fatal.

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
  current topic and when the target agent is offered a topic tool, `topicTools`: one line on when to call `session_rotate` / `session_switch`
  (without it, small models never rotate). A message handed over by a rotate or
  switch carries `handedFrom` and a line saying to answer it there; the handover
  refuses to move it again, so topics cannot ping-pong.
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
- A topic's first title is made from its opening message. The built-in module `topic-title`
  (on unless `topicTitles: { enabled: false }`) then asks the model for a short one: after the
  1st completed turn of a configured agent's topic and every 3rd after, in an ephemeral turn
  on the instance the turn ran on, when that instance declares `ephemeralOpen` (Codex). A title
  given explicitly (`/new <title>`, `topic.switch` with `new.title`, `session_rotate`) is never
  replaced, nor one given while a title was being made; the latest card is edited to carry a
  new title. There is no frame that renames an existing topic.

## CLI

```
aio serve | attach | input | sessions | watch …                 (as aio-dev; `aio-dev send` is `aio input`)
aio run --agent <task agent> [--run-id <id>] [--cwd <dir>] [--env K=V …] [--timeout 10m] [--observe <route json> …]
        [--preset <name>] [--model <m>] [--effort <e>] [--profile <p>] [--input-id <id>] [--correlation <id>] -- <instruction>
aio send --route <route json> --operation-id <id> [--file message.json|-] [--text <text>]
aio tail --consumer <name> [--from <cursor>] [--once]
aio ack --consumer <name> <cursor>
aio bindings put [--file table.json|-] | get
aio explain <inputId>
aio verify <channelRef>
aio console-link                                              (one-time console login URL)
```

- The end-to-end scenarios against the real harness are not in this package: they are
  `aio-e2e` in `packages/daemon-e2e` (`pnpm e2e` from the repo root, `docs/E2E.md` §1.1),
  with the options `aio e2e` had. `aio e2e` only says so and exits 2.
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

## Feature modules (core-slimming G6)

A feature of the daemon can be a module: a `ModuleManifest` (`@agents-io/protocol`,
`module.ts`) registered in a `ModuleRegistry` by the composition root (`bundle.ts`
`builtinModules`, origin `builtin`; so far the topic titles, `topic-title`, the watch, live and
topic tools, `tools.watch`, `tools.live`, `tools.topics`, the stranger approval, `strangers`, and
the external MCP endpoint, `external-mcp`). A third
party's module has the same shape (origin `module`). The manifest says, without running anything:

- `id` (`tools.watch`), `kind: 'feature'`, `needs` (`module:<id>`: another registered module,
  on whenever this one is; `kernel:<capability>`: a member of `KernelContext`);
- `config`: its section of the config file, a top-level key holding the module's own keys
  (`schema`) and `enabled`, which the daemon adds and closes. Present, the module is on unless
  `enabled: false`; absent, the first of its `aliases` (older dotted paths such as
  `policy.strangers`) that is set decides: the module's `aliasEnabled(value, alias)` says on or
  off (`policy.strangers: "drop"` is off), or, without one, an object with `enabled: false` is
  off (as a section) and any other value is on; with neither, `defaultEnabled`. (The external MCP
  endpoint kept its key: its section is `externalMcp`.) `resolve(raw, ctx)` turns the value (an alias's as it is
  there) into the module's settings (`ctx` gives `where`, `alias`, `env`, `substitute`, `path`,
  `valueAt` (a copy of another value of the file, `policy.owners`), `fail`). The settings resolve
  after the rest of the config. Without the module registered its section is an unknown key, as
  any other; the sections come before `local` in the file schema;
- `features` (`host.hello` features, advertised after the kernel's while the module runs),
  `mcpTools` (model tools: name, description, a JSON Schema object `input`, `readOnly`,
  `needsTurn`), `commands` (chat commands: name, `/help` line, `ownerOnly`, default true);
- `setup(kernel, config)`, which returns the `ModuleInstance`: a handler per tool and per
  command, `features()` (which of its features it advertises now; default all while it runs),
  `status()`, `start()`, `stop()`, and the hooks `onTurnCompleted({ sessionKey, turnId, status })`:
  called for every turn of a session (not a task run's) right after its `turn.completed` is
  logged, whatever its status, for each module in registration order, from when the gateway is
  built until step 4; it returns at once (a throw or a rejected promise is logged as
  `module <id>: onTurnCompleted failed: …`); and `inputHint(agent)`: the line an input routed to a
  conversation's current topic carries for the agent it goes to (`channelContext.topicTools`;
  the modules' lines in registration order, joined by a newline; none, no line), asked from when
  the gateway is built to the end (a throw is logged as `module <id>: inputHint failed: …`);
  `onUndispatched({ env, origin, input, addressed })`: an input no rule dispatched and no host took,
  for each module in registration order (each awaited; a throw is logged as
  `module <id>: onUndispatched failed: …` and the next still hears it), `addressed` saying whether it
  addresses the deployment (a DM, an @ of one of its accounts; not an adapter's `observe`);
  `onAction: { prefix, handle }`: clicks whose action id starts with the prefix (no two modules'
  prefixes overlap: setup fails), before they are routed; a result (`{ ok: true }` or
  `{ ok: false, reason }`) is the click's and nothing is routed, undefined routes it as usual;
  `resolver(ctx)`: who answers a turn's request before the built-in policy's resolver (the first
  module that gives one; a connected host's `resolve` callout still comes first, an embedder's
  `Policy.resolve` replaces both; a throw or something that is no `Resolver` is the policy's error,
  so the request is denied); and `identities()`: the module's identity entries, asked once right
  after the gateway is built and before its channels run (a throw or anything but identity entries
  fails the start), below the configured identities and a host's map, replaced later by its
  `router.setExtraIdentities`. All four are served from when the gateway is built to the end.

The registry checks every manifest and what they claim together (ids; config sections and
aliases; tools, commands and features are each one module's and never the kernel's). Its option
`fields` keeps a module's settings and status where they were before it was a module
(`bundle.ts`: `{ 'external-mcp': { config: 'externalMcp', status: 'externalMcp' } }`):
`Config.<config>` is the same object as its settings in `Config.modules` (deprecated, one
release; given another value or removed before `Gateway.start`, it still decides), and
`GET /api/status` has `<status>` holding what its `status()` returns while it runs. A `switch`
(`bundle.ts`: `{ strangers: { switch: { path: 'policy.strangers', on: 'ask', off: 'drop' } } }`)
is an old on/off field of the resolved `Config` at a dotted path: `resolveConfig` writes `on` or
`off` there as the module is on or off (deprecated, one release); given another value before
`Gateway.start`, or set in a config without `modules`, it decides, the module being what a file
with that value at the path makes it (the path is one of the module's aliases, its `aliasEnabled`
must say on for `on` and off for `off`, and the module needs no other module). The
lifecycle has five steps:

1. **resolve** in `resolveConfig` / `loadConfig`: `Config.modules` lists every registered module
   on or off with its settings (absent when the registry is empty). A module that is on and
   needs one that is off is a config error.
2. **setup** in `Gateway.start`, before the gateway builds its ingress: every module that is on
   builds its instance; what it returns must match its manifest (a handler for exactly its tools
   and commands). A `setup` that throws or returns something else fails the start with a
   `ConfigError` naming the module. The `KernelContext` is late-bound: only `id` and `log` work
   during `setup`.
3. **start** after the channels, the local socket and the console run, in registration order.
   One that throws fails the start; those started before it are stopped. The error names the
   module (`module <id>: start failed: …`), unless it is a `ConfigError` or `TokenError`: those
   name the setting themselves and are thrown as they are (`aio serve` exits 2).
4. **stop** first when the daemon stops, in reverse order, each bounded (2 s); failures are
   logged.
5. A change to a module's section takes effect at the next start: the console answers
   `applied: "restart"`.

The daemon assembles from the kernel's entries and the active modules' (a module that is off is
not there at all): the model tool catalog (`toolCatalog`: the kernel's six tools,
`KERNEL_TOOL_NAMES`, in `TOOL_DEFS` order, then the modules'; `agents.<name>.tools` may list a
module's tool while it is on, and naming one of a module that is off is a config error saying
which module, `"watch_add" is a tool of module tools.watch, which is off`), the chat command
table (`/help` lists the kernel's commands, then the modules'; the `/name` of a module that is
off is an ordinary message), the `host.hello` features, and `GET /api/status` `modules`
(`[{ id, origin, enabled, status? }]`, every registered module). With no module the tool list,
`/help`, the features and the error texts are byte for byte what they were before.

`KernelContext` gives a module narrow views of the daemon, each one of the gateway's own
capabilities: `log` (prefixed `module <id>: `), `events` and `head` (a session's log),
`appendNative` (a durable native event in a log of the module's own, such as
`external:<client>`), `sessions` (`list`, `known`, `agentOf`), `status`, `stopping`, `policy`,
`records` (values under `module:<id>:`), `db` (the log's database; tables `module_<id>_…`),
`topics` (`bySession`, `siblings`, `titleSource`, `setAutoTitle`: a generated title, set only
while the topic's title is still generated and still the one the module read, then the latest
card edited to carry it; `rotate(sessionKey, turnId, { title, summary, operationId })` and
`switch(sessionKey, turnId, { topicId, operationId })`: the kernel's handover of the turn running
in the session, refused for any other turn, under TP-1 whoever calls: once per turn, the same
`operationId` again answering what that one did, only from the conversation's current topic,
never a message just handed here, never to the turn's own topic), `watches` (`add`, `remove`, `list`: as the session's agent,
`agentOrigin`, a watch always delivering into the session; `Policy.watch` decides), `live`
(`join(sessionKey, turnId, a)`, `say`, `leave`: the kernel's live mechanism, decision 16; a join
only for the turn running in the session), `agents` (`tools(agent)`: the tools an agent's
sessions are offered, its list or for `tools: true` the endpoint's whole catalog), `router` (`identify`, its own `setExtraIdentities`, `newTopic`,
`conversationAgent`, `record`: an input's routing record), `lanes` (`has`, `open`, `command`,
`input`: a peer's input the module stamped, any other origin kind is refused; `harness`: what the
module may run beside a configured agent's open lane, `{ ephemeral(turnId), ephemeralTurn({ turnId,
prompt, instructions }) }`, undefined for a task run's or the unconfigured default agent's: one
ephemeral turn on the instance a turn of the session ran on, when it declares `ephemeralOpen`,
answering the text of its answer (undefined when it does not complete within 30 s). A module never
gets the harness adapter: the kernel sets the turn's session (a throwaway one, in the session's
working directory, none of the host's tools), its run (that turn's, at low effort in the default
mode, under a read-only profile named after the module that never asks) and its one input (the
kernel's, `via` the module's id); the module gives only the prompt and the instructions, and
anything else it passes is dropped), `channelFor`, `resolveRoute`, `send`
(through the outbox; `external` names the client outside the daemon it sends for, kept in the
in-flight mark, EX-8), `settled`, `outbound` (the outbound check of a send that is no turn's
reply, DL-6), `owner` (the owner's principals, `policy.owners` and `AGENTS_IO_OWNERS`, and the
fixed `policy.ownerSessionKey`, if any), `ownerRoute`, `redispatch`, `explain` and `host`
(`connected`, `answers`, `heldBy`, `external`: the `external` callout, `isToken`: a module never
gets the host token).

The watch, live and topic tools (`src/tool-modules.ts`) are such modules over host-mcp's library:
each declares its group of `TOOL_GROUP_DEFS` (`@agents-io/host-mcp`; a module tool that is one of
these definition objects is listed and checked exactly as `TOOL_DEFS` has it, so the tools a
harness is offered are byte for byte what the kernel offered) and runs it with
`watchToolHandlers(k.watches)`, `liveToolHandlers(…)` over `k.live`, `topicToolHandlers(…)` over
`k.topics`; the topic tools add the hint (`inputHint`) for an agent offered one of them. The
watches and their routing, the live mechanism (its protocol, events and LN invariants) and the
topic handover with its rules (TP-1: the kernel checks them for every caller; the tools check the
same ones first, `handoverRefusal` from `@agents-io/session`) stay the kernel's. The live tools are offered also when no channel can open a
live, as before (dropping them then would change the tool list: a later change).

The stranger approval (`src/strangers.ts`, `strangersModule`) is such a module over those four
hooks: off unless `policy.strangers: "ask"` (its alias, where the setting always was; `drop` or
nothing leaves it off) or its section `strangers` (only `enabled`) is in the file. A stranger's
message addressed to the deployment becomes a card in the owner's chat (`ownerRoute`, the
kernel's), its buttons (`aio:stranger:`) let the messages in through `redispatch`, its guests are
its identities, and a guest's turn asks the owner (`resolver`). Its tables keep their names
(`daemon_stranger_asks`, `daemon_guests`), so guests and open asks carry over. A channel whose
adapter declares `ChannelCaps.openInbox` (mail: anyone may write to it) is never asked about.

Not served yet: `ModuleManifest.admin` (registering a module with it fails), and of the
instance the other `hooks` (`onTopicChanged`, `planRun`, `harnessFor`, `statusLines`) and
`localFrames` (setting one fails the setup, naming it; a hook that is not a function too). They
are the seams the features that move into modules next need (owner commands and presets, the
Claude Code terminal); each is served with the move that needs it. A module
section's strings are redacted by the console's general rule (a secret-looking key); `x-credential`
marks in a module's schema are not read yet.

## Library

`import { Gateway /* = Daemon */, LocalClient, resolveConfig } from '@agents-io/daemon'`:
`Gateway.start({ config, … })` starts everything in-process (tests and e2e use
`harness` / `buildHarness` / `channels` to inject fakes); `LocalClient` speaks both
client and host frames (`hello`, `runStart`, `runEndedOf`, `inboundRead`, `onRequest('inbound' | 'policy', …)`, …).

What changed for embedders with core-slimming G3:

- Harness kinds come from a `HarnessRegistry` (exported, with `builtinHarnesses`: Claude Code,
  then Codex). `resolveConfig` / `loadConfig` and `Gateway.start` take `harnessRegistry` (default
  the built-in one; give both the same); `configFileSchema(registry)` is the file schema over it
  (`ConfigFile` is the built-in one's). A `HarnessInstance` is `{ kind: string, launch }`: the
  kind's settings moved from `claude` / `codex` / `module` to `launch` (same values; their types
  are `ClaudeLaunch` from `@agents-io/harness-claude-code`, `CodexLaunch` from
  `@agents-io/harness-codex`, `ModuleLaunch` here). Deprecated, kept for one release: an
  instance `resolveConfig` / `loadConfig` returns still has the old field (`claude`, `codex`,
  `module`; `HarnessRegistryOptions.launchAliases`, which `builtinHarnesses` sets) as an accessor
  of `launch`: reading it reads `launch`, writing it (e.g. `inst.claude = { ...inst.claude, claudePath }`
  before `buildHarness`) writes `launch`. It is not enumerable, so a spread or JSON copy has only
  `launch`. Move to `launch`. `codexStateDir` moved to
  `@agents-io/harness-codex`; `HarnessKind` is a `string`. `buildHarness(instance, blobs?, { registry, log, harness })`
  builds through the kind's `create`. `InstanceHarness` puts the instance's `profiles` into the
  open options of a `module` instance and of a kind that declares `profilesInOpen` (Claude Code),
  as before.
- `GatewayOptions.buildHarness` is called with each instance as configured, and for a task run
  with that instance carrying the run's cwd and env. It is no longer called with a rewritten
  instance (env merged, stdio transport, `CODEX_HOME` as its home) for a launched session with
  env on a Codex instance: the daemon reads the `sessionEnv` of the adapter `buildHarness`
  returned for the instance and calls its `ownProcess({ env, cwd })` (`CodexHarness` does the
  rewrite itself). An adapter that declares nothing (a test fake) takes the session's env in its
  open args (`'open'`). It is also called, for a launch with env on an instance that is
  unavailable for now, with that instance and `unavailable` cleared: only to read the returned
  adapter's `sessionEnv` (nothing is opened on it). Both copies (this one and a task run's) are
  spreads of the instance, so they carry `launch` but not the deprecated `claude` / `codex`
  alias.
- A `use: "module"` instance whose adapter cannot be built because it is unavailable for now (an
  `env:` reference in its config is not set, so its factory never ran) refuses a launch with env
  (`launch_unsupported`, saying why it is unavailable); before, such a launch was accepted and
  pinned. A cwd alone is fine.

What changed for embedders with core-slimming G2 (channel types):

- Channel types come from a `ChannelRegistry` (exported, with `builtinChannels`: lark-bot, mail,
  bridge, module, and `CORE_CHANNEL_IDS`). `resolveConfig` / `loadConfig` and `Gateway.start`
  take `channelRegistry` (default the built-in one; give both the same), and
  `configFileSchema(registry, channels?)` is the file schema over both registries (`ConfigFile`
  is still the built-in ones'). `ChannelEntry` and `ResolvedChannel` keep their shape;
  `RESERVED_CHANNEL_IDS` is `builtinChannels.reservedIds` (same value). `LarkChannelConfig` moved
  to `@agents-io/channel-lark-bot` (still re-exported here, deprecated, one release).
- The gateway builds every configured channel through its type's `ChannelModule.create`
  (`GatewayOptions.channelAdapter` still wins when it returns an adapter); `init.stateDir` is
  `<dataDir>/channels/<type>.<account, URI-encoded>`, so a Lark bot's stays
  `channels/lark-bot.<account>`. The gateway imports no channel package. An entry it cannot
  build fails `Gateway.start` with a `ConfigError` (exit 2) naming the entry and its type: a type
  the gateway's registry lacks (the config was resolved with another one), or a `create` that
  returns no `BuiltChannel` (no `adapter` with `id`, `caps`, `start` and `send`; a `close` or
  `idKnown` that is not a function). A `create` that throws fails it with its own error. Only the
  shape of what `create` returns is checked: what its adapter does once started is not (a `start`
  that returns no promise, a `caps` that throws or returns no caps fail as their own error, such
  as a `TypeError`, not as a `ConfigError`).
- `new ChannelRegistry(modules)` checks each module: its type name is ASCII letters, digits, `-`
  and `_`, starting with a letter or digit (owners are `<type>:<owner>` and state directories
  `<type>.<account>`, so no `:`, `.` or `/`), `entry` is an object, `resolve` and `create` are
  functions, the optional hooks are functions when present and `ids` is an array of non-empty
  strings. A wrong one throws, naming the type and the member, so a type an entry passes
  `resolveConfig` with has a `create` to build it. The built-in types pass.
- The evidence an entry gives without an `evidence` grant is the registration's, never the
  module's: `new ChannelRegistry(modules, { defaultEvidence: { <type>: 'caps' | 'ungranted' } })`,
  default `ungranted` (`device_only` only). `builtinChannels` gives lark-bot and mail `caps`,
  bridge and module nothing, as before. An entry's channel id belongs to
  `<type>:<ChannelModule.owner>` (the type alone without `owner`): `bridge:[command, args]`,
  `module:[file, export]`, `lark-bot`, the same strings as before. The registry also has
  `owner()`, `idOf()` and `mayUse()`.
- The console's credentials in a channel entry are what its type marks: strings at or under a
  schema marked `x-credential` (a bridge's `env`) and `ChannelModule.isCredential` (a bridge
  argument after a secret-looking flag, mail `auth.pass` / `auth.accessToken`, a Lark app's
  `appSecret` / `encryptKey` / `verificationToken`): the same fields as before. What the
  console says of a literal one there is the type's too when it has advice of its own
  (`ChannelModule.credentialHint`: a bridge argument is visible to other local users, the same
  text as before), else the general one. `isCredential`,
  `redact` and `unredact` take an optional channel registry; `ConfigStoreOptions` takes
  `harnessRegistry` and `channelRegistry` (the gateway gives its own).
- `Gateway.larkBots` is gone: the console's Lark bot provisioning is built by `bundle.ts`
  (`builtinConsoleParts`, only when the registry has the built-in lark-bot type) until G5 makes
  it a route the lark-bot module contributes. The HTTP API is unchanged.

What changed for embedders with core-slimming G5 (admin contributions):

- Modules contribute to the console: `AdminContribution`, `AdminRoute`, `AdminContext`,
  `ConfigAccess` (`@agents-io/protocol`, `admin-module.ts`) are new, and `ChannelModule.admin`
  is an `AdminContribution`. The gateway builds one `AdminContext` per contribution of its
  channel registry when the console starts, calls `mount`, serves `routes` after the core ones
  and calls the mount's `close` when the console is gone (a `mount` that throws fails
  `Gateway.start`). `new ChannelRegistry` checks the contributions (routes: GET / PUT / POST,
  under `/api/`, status 200 or 202, a `response` schema and a `handle`, never `public`) and
  refuses a route, a console key or a schema name two types contribute, and a route that is a
  core endpoint; `ChannelRegistry.adminContributions` lists them. `adminEndpoints(registry)`
  is the endpoint table (`ADMIN_ENDPOINTS` still lists the core endpoints only).
- `builtinConsoleParts`, `ConsoleParts` and `ConsolePartsInit` (`bundle.ts`) are gone, and so
  are `BotProvisioning` and `ConsoleHost.larkBots`: a host that builds a `ConsoleServer` itself
  gives `ConsoleHost.routes` (`ContributedRoute[]`, each route with its `AdminContext`); Lark
  bot provisioning is `larkBotAdmin`'s `mount` and `routes` (`@agents-io/channel-lark-bot`,
  `larkBotChannelModule.admin`). A host that uses `Gateway` changes nothing.
- The `console` section takes the registered types' keys (`AdminContribution.console`) between
  the console server's keys and `liveChannels`, so `console.larkBotCommand` stays where it was,
  with the same default. `ConsoleConfig` has no typed `larkBotCommand` any more: the types'
  settings are an index signature (`config.console.larkBotCommand` still holds the value at
  run time, typed `unknown`); `consoleSettings(section, keys)` resolves one contribution's.
  `CREATE_LARK_BOT` moved to `@agents-io/channel-lark-bot` (still re-exported here, deprecated,
  one release). With a registry without lark-bot, `console.larkBotCommand` is an unknown key.
- `ConfigStore` implements `ConfigAccess` (it gained `envRefs`); lark-bot's `ProvisionConfig` is
  `ConfigAccess` without `envRefs`.
- A daemon whose registry lacks lark-bot answers `/api/bots/lark` with the 404 of an unknown
  route (`no POST /api/bots/lark`), no longer `bot provisioning needs a config file`. A daemon
  without a config file that serves the console makes an empty private `<dataDir>/provision`,
  and its `POST /api/bots/lark` checks the body (400) before answering 404. The HTTP API, the
  config file and the JSON Schema files are otherwise unchanged.

What changed for embedders with core-slimming G6 (feature modules):

- New: `ModuleManifest`, `ModuleInstance`, `KernelContext` and their parts (`@agents-io/protocol`,
  `module.ts`); `ModuleRegistry`, `builtinModules` (empty), `ModuleHost`, `resolveModules`,
  `KERNEL_CAPABILITIES` (`@agents-io/daemon`); `toolCatalog`, `moduleToolInput`,
  `HostToolsOptions.modules` (`@agents-io/host-mcp`); `AdminModule` and the optional
  `AdminStatus.modules` (`@agents-io/protocol`).
- `resolveConfig` / `loadConfig`, `Gateway.start` and `ConfigStoreOptions` take an optional
  `moduleRegistry` (default `builtinModules`; give all of them the same: `Gateway.start` fails with
  a `ConfigError` when `Config.modules` does not name exactly its registry's modules).
  `configFileSchema(harnesses, channels?, modules?)` adds the modules' sections (`ConfigFile` is
  still the built-in registries'). `Gateway.moduleRegistry` and `Gateway.modules` are readable.
- `GET /api/status` has `modules` (an empty array here). Nothing else changes: the config file, the
  tools a harness is offered, `/help`, the `host.hello` features and every error text are as
  before.

What changed for embedders with core-slimming G6 step 1 (the external MCP endpoint is a module):

- `builtinModules` registers `external-mcp` (`externalMcpModule`, `src/external-mcp.ts`), so
  `Config.modules` is always there from `resolveConfig` / `loadConfig` (give them and
  `Gateway.start` the same `moduleRegistry`). A config without `modules` at all (built by hand)
  still starts: the endpoint follows `Config.externalMcp`, as before. `ConfigFile` includes the built-in modules' sections
  (`externalMcp`, before `local` as always); `configFileSchema(…, modules)` over another registry
  has only that registry's. `ExternalMcpConfig`, `ExternalMcpClient` and
  `DEFAULT_EXTERNAL_MCP_PORT` are exported from `bundle.ts` now (the same names from the package);
  `Config.externalMcp` is deprecated (one release). `HostServiceDeps.externalMcp` is gone.
- New: `ModuleInstance.features()`, `ModuleResolveContext.valueAt`, `ModuleRegistryOptions.fields`
  (`ModuleFields`), `ModuleHost.report()`, the `KernelContext` members above (`head`,
  `appendNative`, `sessions`, `status`, `stopping`, `router.record`, `lanes.input`, `resolveRoute`,
  `send`'s `external`, `settled`, `outbound`, `host.heldBy`, `host.external`, `host.isToken`).
- The config file, the defaults and every error text are as before. With the endpoint on,
  `host.hello` lists `external.mcp` after the kernel's features (it was between
  `callouts.external` and `session.compact`); `GET /api/status` `modules` lists `external-mcp`;
  the endpoint's log lines carry the `module external-mcp: ` prefix.

What changed for embedders with core-slimming G6 step 2 (topic titles are a module, G4):

- `builtinModules` registers `topic-title` (`topicTitleModule`, `src/topic-title.ts`) first, before
  `external-mcp`. Its section is `topicTitles` (only `enabled`; absent means on, so existing
  configs title topics as before; `topicTitles: { enabled: false }` turns it off). It titles a
  configured agent's topic after its 1st completed turn and every 3rd after, on the instance that
  turn ran on when it declares `ephemeralOpen` (Codex), while the title is still generated; the
  gateway no longer does. `ConfigFile` has `topicTitles` before `externalMcp`; `GET /api/status`
  `modules` lists `topic-title` first.
- New: the hook `onTurnCompleted` (served), `KernelContext.topics.titleSource` /
  `setAutoTitle`, `KernelContext.lanes.harness` (`KernelLaneHarness`), `ModuleHost.turnCompleted`,
  `ModuleHostOptions.defaults`; `TopicTitleSection` from `bundle.ts`. A config without `modules` at
  all (built by hand) still starts and titles topics: `Gateway.start` gives the built-in modules
  without a field what a file without their sections makes them (`resolveModules({}, …)`); a
  third party's module still fails such a config.
- The topic titles, their trigger, the card edit and every error text are as before. Its log line
  `title update failed` carries the `module topic-title: ` prefix; a turn that completes after the
  daemon began stopping its modules no longer starts a title (its result was dropped before).

What changed for embedders with the follow-ups to core-slimming G4 / G6:

- `KernelContext.lanes.harness(sessionKey)` (`KernelLaneHarness`) no longer hands a module the
  harness adapter: `agent`, `instance`, `cwd`, `adapter(instance)` and `run(instance)` are gone,
  `ephemeral(turnId)` and `ephemeralTurn({ turnId, prompt, instructions })` are new. A module could
  open a session on that adapter with any `run.profile` and `options.profiles`, past the policy's
  plan and the deployment's profiles; now the kernel runs one ephemeral turn for it and sets
  everything but the text ("Feature modules" above). The topic titles are as before (the same
  session options, profile, run, prompt and instructions); only the title turn's input id is
  `topic-title:<uuid>` now (it was `title:<uuid>`; it stays inside the throwaway session).
- `KernelBackend` (the gateway's side of `kernelContext`, exported for an embedder that builds
  `KernelContext`s over a kernel of its own) has only required members, so each step that adds
  one breaks such an embedder: G6 step 1 added `head`, `appendNative`, `sessions`,
  `knownSession`, `agentOf`, `status`, `stopping`, `record`, `laneInput`, `resolveRoute`,
  `settled`, `outbound`, `hostHeldBy`, `hostExternal` and `isHostToken`; step 2 added
  `titleSource`, `setAutoTitle` and `laneHarness`; now `laneHarness(sessionKey, module)` takes the
  module's id and returns the narrow `KernelLaneHarness`. An embedder that only uses `Gateway`
  changes nothing.
- `new ChannelRegistry(modules)` refuses a type whose name differs from a registered one's only in
  letter case (`Chat` next to `chat`): their state directories (`<dataDir>/channels/<type>.<account>`)
  are one on a case-insensitive file system (macOS's default). The built-in types are unaffected.
- A bridge (`@agents-io/channel-jsonl-bridge`) handles an inbound frame once the hello of its
  connection is applied, so a frame the peer sends right after answering hello is stamped with
  that hello's channel id and caps even when both arrive in one chunk (it went out with the ones
  before that hello: the offline caps after a failed first connect, so a granted owner was taken
  as a stranger); an inbound frame of a connection whose hello failed or was refused is never
  emitted (the peer is killed and redelivers to the next one). Frames are unchanged.

What changed for embedders with core-slimming G6 step 3 (the watch, live and topic tools are modules):

- `builtinModules` registers `tools.watch`, `tools.live` and `tools.topics` (`watchToolsModule`,
  `liveToolsModule`, `topicToolsModule`, `src/tool-modules.ts`) after `topic-title` and before
  `external-mcp`, so their tools come after the kernel's six in the order they always had. Their
  sections are `watchTools`, `liveTools`, `topicTools` (only `enabled`; absent means on, so
  existing configs offer the same tools; `{ "enabled": false }` turns a group off). `ConfigFile`
  has them after `topicTitles`, before `externalMcp`; `GET /api/status` `modules` lists them.
  The gateway no longer passes `HostToolsOptions.watches` / `topics` / `live` (or `agentOf`) to
  its `HostTools`, and no longer computes the topic hint itself: the inputs of a current topic
  carry what the modules' `inputHint` gives.
- An embedder that gives `Gateway.start` a `ModuleRegistry` of its own gets these tools only when
  it registers the modules (start from `builtinModules.modules`, as for the topic titles); with a
  registry without them the agents are offered the kernel's six tools and no topic hint. A config
  without `modules` at all (built by hand) still has them: `Gateway.start` gives the built-in
  modules without a field their defaults (on).
- New: the hook `inputHint` (served), `ModuleHost.inputHint`, `KernelContext.watches`,
  `KernelContext.live`, `KernelContext.agents`, `KernelContext.topics.rotate` / `switch`,
  `ModuleTopicHandover`, `KernelWatchResult`, `KernelUnwatchResult` (`@agents-io/protocol`);
  `KERNEL_CAPABILITIES` has `watches`, `live`, `agents`; `ToolModuleSection` from `bundle.ts`.
  `KernelBackend` gains `addWatch`, `removeWatch`, `listWatches`, `rotateTopic`, `switchTopic`,
  `joinLive`, `sayLive`, `leaveLive` and `agentTools` (required, so this breaks an embedder that
  implements it; one that only uses `Gateway` changes nothing).
- `@agents-io/host-mcp`: `TOOL_DEFS` / `TOOL_NAMES` / `ToolName` live in `src/defs.ts` (the same
  exports), next to the new `KERNEL_TOOL_NAMES`, `TOOL_GROUPS` and `ToolGroup`; new
  `TOOL_GROUP_DEFS`, `watchToolHandlers`, `liveToolHandlers`, `topicToolHandlers`,
  `SessionWatches`, `sessionWatches`. `HostToolsOptions.watches` / `topics` / `live` work as
  before (their tools are then the kernel's, and a module offering the same group clashes); a
  module may now offer a tool named like one of the groups' when the host passes no control for it
  (it was refused as a kernel tool). `ModuleToolEntry.input` may be a zod shape (for one of
  `TOOL_GROUP_DEFS`).
- The tools a harness is offered (names, descriptions, input schemas, annotations, order), what
  they answer and every error text are as before; the config error for a tool of a group that is
  off names its module (`agents.<name>.tools: "watch_add" is a tool of module tools.watch, which
  is off`).
- Follow-up: TP-1 is the kernel's for every caller. `KernelContext.topics.rotate` /
  `switch` (`KernelBackend.rotateTopic` / `switchTopic`) checked only that `turnId` is the turn
  running there, and the rules lived in the topic tools' handler: another module with
  `kernel:topics` could hand one turn to two topics, or a message just handed over on again. Now
  the gateway hands a turn over once (claimed before its first await, so a concurrent second call
  finds it; the same `operationId` again answers what that one did; a failed one is not kept),
  never from a topic no longer current, never a turn with no message of its own or whose messages
  were all just handed here, never to the turn's own topic. `rotate` takes `{ title, summary,
  operationId }`, `switch` `{ topicId, operationId }` (it took the topic id); `TopicControl.rotate`
  / `switch` (`@agents-io/host-mcp`) are given the call's `operationId` too. `@agents-io/session`
  exports the rules: `handoverRefusal`, `TOPIC_HANDED_ALREADY`, `TOPIC_ALREADY_HERE`. The tools
  check the same rules before their arguments, so what a model reads is as before.

What changed for embedders with core-slimming G6 step 4 (the stranger approval is a module):

- `builtinModules` registers `strangers` (`strangersModule`, `src/strangers.ts`) after
  `tools.topics` and before `external-mcp`. `policy.strangers` keeps its place, values and
  default (`drop`: off); the new section `strangers` (only `enabled`) turns it on as well and
  decides over `policy.strangers` when both are there. `ConfigFile` has `strangers` after
  `topicTools`; `GET /api/status` `modules` lists `strangers`. `Config.policy.strangers` says
  whether the module is on (`ask` / `drop`, deprecated, one release) and, given the other value
  before `Gateway.start` or set in a config without `modules`, still turns it on or off
  (`ModuleFields.switch`). The gateway no longer builds `Strangers` itself and has no `askOwner`.
- The hooks `onUndispatched` (its argument has `addressed`), `onAction`, `resolver` and
  `identities` are served; new `KernelContext.owner`, `ModuleHost.hooked`, `undispatched`,
  `action`, `resolver`, `identities`, `ModuleHostOptions.switched`, `ModuleFields.switch`
  (`ModuleSwitchField`), `KERNEL_CAPABILITIES` has `owner`; `StrangersSection` from `bundle.ts`.
  `KernelBackend` gains `owner` (required, so this breaks an embedder that implements it).
- `ChannelCaps.openInbox` (`@agents-io/protocol`, optional, additive: the JSON Schemas
  `ChannelCaps` and `ChannelHello` have it) is new and the mail adapter declares it. The stranger
  approval leaves out the messages of a channel that declares it, where it left out the channel
  id `mail` before: the same for the bundled mail adapter, but an adapter of an embedder's own
  under the id `mail` is asked about unless it declares `openInbox`, and any channel (a bridge
  peer's hello too) that declares it is left out.
- The cards, the guests, the held messages, who is asked and every reply text are as before. Its
  log lines carry the `module strangers: ` prefix, and a failure while handling a stranger's
  message is logged as `module strangers: onUndispatched failed: …` (it was
  `topic command reply failed: …`).
