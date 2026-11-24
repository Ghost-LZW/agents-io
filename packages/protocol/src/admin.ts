import { Type, type Static, type TSchema } from '@sinclair/typebox';
import { SessionInfo } from './client.js';
import { RouteExplanation } from './host.js';
import { Topic } from './topic.js';

/*
 * Console / admin API: HTTP + WebSocket served by the daemon for web UIs. A UI
 * (a separate repo) depends on these schemas only, never on daemon internals.
 * Every body is JSON (`application/json; charset=utf-8`).
 *
 * Auth. Every `/api/*` request except `POST /api/login`, and the `/ws` upgrade,
 * needs one of:
 *   - `Authorization: Bearer <token>`, where `<token>` is the daemon's host token
 *     (the 0600 file `<socket>.token`, regenerated at every daemon start), or a
 *     console session token from `POST /api/login`;
 *   - for `/ws` from a browser (which cannot set headers): the subprotocol list
 *     `[ADMIN_WS_SUBPROTOCOL, ADMIN_WS_BEARER_PREFIX + token]`; the server selects
 *     `ADMIN_WS_SUBPROTOCOL`.
 * A login link (`aio console` prints `<console url>/#login=<one-time token>`)
 * carries a one-time token: valid for a few minutes, single use. The UI posts
 * it to `POST /api/login` and gets a session token back. Missing or wrong
 * credentials → 401 `unauthorized`. The daemon listens on loopback only unless
 * configured otherwise, and rejects requests whose `Origin` is not its own or
 * one the config allows (403 `forbidden`).
 *
 * Errors: a non-2xx status with an `AdminError` body. Statuses: 400
 * `invalid_request`, 401 `unauthorized`, 403 `forbidden`, 404 `not_found` /
 * `unknown_input` / `unknown_job`, 409 `conflict` (stale config revision, or a
 * provisioning job already running), 422 `invalid_config`, 500 `internal`.
 *
 * Secrets never leave the daemon: the config document shows `env:NAME`
 * references as written; a literal secret in the file is shown as
 * `ADMIN_REDACTED`. Writing `ADMIN_REDACTED` back keeps the stored value; any
 * other literal secret in a `PUT` is refused (issue code `inline_secret`), so
 * secrets go into the environment / env file and the config names them.
 *
 * WebSocket `/ws` (subprotocol `ADMIN_WS_SUBPROTOCOL`): one JSON frame per text
 * message, exactly the local socket's frames — client frames (`client.ts`)
 * with the connection's console principal as origin, and after `host.hello`
 * (with the daemon's host token) the host frames (`host.ts`). Nothing else.
 *
 * Modules add endpoints of their own under the same rules, with their schemas in
 * their package, not here: the routes of their `AdminContribution`
 * (`admin-module.ts`). Lark bot provisioning (`POST /api/bots/lark`,
 * `GET /api/bots/lark/:job`, the `unknown_job` and job `conflict` answers above) is
 * the lark-bot module's (`LARK_BOT_ADMIN_ENDPOINTS` in `channel/lark-bot/src/admin.ts`,
 * its JSON Schemas in `channel/lark-bot/schema/`). `ADMIN_ENDPOINTS` lists the core
 * ones; the daemon's `adminEndpoints(registry)` lists them with its modules'.
 */

export const ADMIN_WS_PATH = '/ws';
/** WebSocket subprotocol of `/ws`: protocol frames of PROTOCOL_VERSION 1, one per text message. */
export const ADMIN_WS_SUBPROTOCOL = 'agents-io.v1';
/** Prefix of the second subprotocol entry that carries a bearer token from browsers. */
export const ADMIN_WS_BEARER_PREFIX = 'agents-io.bearer.';
/** Placeholder for a literal secret in the config document. */
export const ADMIN_REDACTED = '<redacted>';

export const AdminError = Type.Object({
  error: Type.Object({ code: Type.String(), message: Type.String() }),
});
export type AdminError = Static<typeof AdminError>;

// ---- auth -----------------------------------------------------------------

/** `POST /api/login`: exchange a login link's one-time token for a session token. */
export const AdminLoginRequest = Type.Object({ loginToken: Type.String() });
export type AdminLoginRequest = Static<typeof AdminLoginRequest>;

export const AdminLoginResult = Type.Object({
  /** Use as `Authorization: Bearer <token>`. Dropped at daemon restart. */
  token: Type.String(),
  /** Unix ms. */
  expiresAt: Type.Number(),
});
export type AdminLoginResult = Static<typeof AdminLoginResult>;

// ---- status ---------------------------------------------------------------

/** Who the host is, as far as routing is concerned. */
export const AdminHostState = Type.Object({
  /** A host connection (consumer / callouts) is open. */
  connected: Type.Boolean(),
  name: Type.Optional(Type.String()),
  consumer: Type.Optional(Type.String()),
  callouts: Type.Optional(Type.Boolean()),
  /** The host-pushed binding table, if any. */
  table: Type.Optional(Type.Object({ version: Type.String(), active: Type.Boolean(), suspended: Type.Optional(Type.Union([Type.Literal('expired'), Type.Literal('host_down')])) })),
});
export type AdminHostState = Static<typeof AdminHostState>;

export const AdminChannel = Type.Object({
  /** Adapter id (`lark-bot`, `mail`, …). */
  id: Type.String(),
  account: Type.String(),
  state: Type.Union([Type.Literal('starting'), Type.Literal('running'), Type.Literal('failed'), Type.Literal('stopped')]),
  error: Type.Optional(Type.String()),
  /** Envelopes refused because they claimed another channel, account or reply route than this channel instance (since start). */
  rejected: Type.Optional(Type.Number()),
  /** Envelopes whose sender evidence was beyond this channel's evidence cap and became `none` (since start). */
  evidenceCapped: Type.Optional(Type.Number()),
});
export type AdminChannel = Static<typeof AdminChannel>;

export const AdminAgent = Type.Object({
  name: Type.String(),
  /** Harness instance id. */
  harness: Type.String(),
  mode: Type.Union([Type.Literal('interactive'), Type.Literal('task')]),
  /** The preset its harness, model and effort come from (config `presets`). */
  preset: Type.Optional(Type.String()),
  model: Type.Optional(Type.String()),
  effort: Type.Optional(Type.String()),
  profile: Type.Optional(Type.String()),
  cwd: Type.Optional(Type.String()),
  default: Type.Optional(Type.Boolean()),
});
export type AdminAgent = Static<typeof AdminAgent>;

/** A registered feature module (`ModuleManifest`, core-slimming G6). */
export const AdminModule = Type.Object({
  id: Type.String(),
  /** Shipped with the daemon (`builtin`), or someone else's (`module`). */
  origin: Type.Union([Type.Literal('builtin'), Type.Literal('module')]),
  /** On for this run (its config section, an alias, or its default); a module that is off has no tools, commands or features. */
  enabled: Type.Boolean(),
  /** What the module shows of itself (`ModuleInstance.status`), while it runs. */
  status: Type.Optional(Type.Unknown()),
});
export type AdminModule = Static<typeof AdminModule>;

/** `GET /api/status`. */
export const AdminStatus = Type.Object({
  /** Daemon package version. */
  version: Type.String(),
  protocol: Type.Number(),
  pid: Type.Number(),
  /** Unix ms. */
  startedAt: Type.Number(),
  /** Unix ms on the daemon's clock, to show uptime and skew. */
  now: Type.Number(),
  dataDir: Type.String(),
  socket: Type.String(),
  /** Path of the config file in use. */
  configPath: Type.Optional(Type.String()),
  host: AdminHostState,
  channels: Type.Array(AdminChannel),
  agents: Type.Array(AdminAgent),
  sessions: Type.Object({ total: Type.Number(), live: Type.Number(), running: Type.Number() }),
  runs: Type.Object({ running: Type.Array(Type.String()) }),
  queue: Type.Object({ head: Type.Number() }),
  /** The external MCP endpoint (config `externalMcp`), when it is listening: its URL and client names (never tokens). */
  externalMcp: Type.Optional(Type.Object({ url: Type.String(), clients: Type.Array(Type.String()) })),
  /** The registered feature modules, in registration order (daemons before core-slimming G6 do not send it). */
  modules: Type.Optional(Type.Array(AdminModule)),
});
export type AdminStatus = Static<typeof AdminStatus>;

// ---- config ---------------------------------------------------------------

/** One validation problem of a config document. */
export const ConfigIssue = Type.Object({
  /** JSON pointer into the document (`/agents/helper/cwd`); `` for the whole document. */
  path: Type.String(),
  message: Type.String(),
  /** Stable code where there is one (`inline_secret`, `unknown_agent`, `task_agent_binding`, `schema`, …). */
  code: Type.Optional(Type.String()),
  severity: Type.Optional(Type.Union([Type.Literal('error'), Type.Literal('warning')])),
});
export type ConfigIssue = Static<typeof ConfigIssue>;

/** The config file (`aio.config.json`) as a JSON object, secrets redacted. The daemon's config reference documents its fields. */
export const AdminConfigBody = Type.Record(Type.String(), Type.Unknown());
export type AdminConfigBody = Static<typeof AdminConfigBody>;

/** `GET /api/config`. */
export const AdminConfigDocument = Type.Object({
  path: Type.String(),
  /** Opaque; changes whenever the file does. Pass it back as `ifRevision`. */
  revision: Type.String(),
  config: AdminConfigBody,
  /** Problems of the document as it is on disk (the running daemon may be on an older, valid one). */
  issues: Type.Array(ConfigIssue),
  /**
   * Every `env:NAME` the document references, then every variable a channel entry reads without
   * naming it (`ChannelModule.implicitEnv`, marked `implicit`), and whether the daemon's
   * environment / env file sets it. Values are never shown.
   */
  env: Type.Array(Type.Object({ name: Type.String(), set: Type.Boolean(), implicit: Type.Optional(Type.Boolean()) })),
});
export type AdminConfigDocument = Static<typeof AdminConfigDocument>;

/** `PUT /api/config`: replace the file. Refused (422, nothing written) when an issue has severity `error`. */
export const AdminConfigPut = Type.Object({
  config: AdminConfigBody,
  /** Optimistic concurrency: 409 `conflict` unless the file is still at this revision. */
  ifRevision: Type.Optional(Type.String()),
});
export type AdminConfigPut = Static<typeof AdminConfigPut>;

/** A configured channel, by its config entry `type` and `account`. */
export const AdminChannelRef = Type.Object({ type: Type.String(), account: Type.String() });
export type AdminChannelRef = Static<typeof AdminChannelRef>;

/**
 * What applying the config file's `channels` to the running daemon did (`console.liveChannels`):
 * entries that are new or changed are started, entries that are gone or changed are stopped;
 * unchanged entries keep running. `started`: launched and not failed when the answer was made
 * (a failure later, or one an adapter only logs while retrying internally, shows in
 * `GET /api/status` only). `failed`: entries that could not be built, whose `start` failed at
 * once, or that are not connected (a bridge whose first connect failed; it keeps retrying), new or
 * unchanged; the file is then not counted as applied.
 */
export const AdminChannelsApplied = Type.Object({
  started: Type.Array(AdminChannelRef),
  stopped: Type.Array(AdminChannelRef),
  failed: Type.Optional(Type.Array(Type.Object({ type: Type.String(), account: Type.String(), error: Type.String() }))),
});
export type AdminChannelsApplied = Static<typeof AdminChannelsApplied>;

export const AdminConfigPutResult = Type.Object({
  revision: Type.String(),
  /** Warnings (errors refuse the write; they come back in a 422 body as `AdminConfigValidation`). */
  issues: Type.Array(ConfigIssue),
  /**
   * live: the running daemon matches the file; restart: saved, (the rest) takes effect at the
   * next start. With `console.liveChannels` channel changes are applied at once (see `channels`)
   * even when another change still needs a restart.
   */
  applied: Type.Union([Type.Literal('live'), Type.Literal('restart')]),
  /** What applying the channels did (`console.liveChannels`); absent when it is off. */
  channels: Type.Optional(AdminChannelsApplied),
});
export type AdminConfigPutResult = Static<typeof AdminConfigPutResult>;

/** `POST /api/config/validate`: check a document without writing it. */
export const AdminConfigValidateRequest = Type.Object({ config: AdminConfigBody });
export type AdminConfigValidateRequest = Static<typeof AdminConfigValidateRequest>;

/** Answer of `POST /api/config/validate`, and the body of a 422 from `PUT /api/config`. */
export const AdminConfigValidation = Type.Object({
  /** No issue has severity `error`. */
  valid: Type.Boolean(),
  issues: Type.Array(ConfigIssue),
});
export type AdminConfigValidation = Static<typeof AdminConfigValidation>;

// ---- routing, queue, sessions ----------------------------------------------

/** `GET /api/explain/:inputId` (404 `unknown_input`). */
export const AdminExplain = RouteExplanation;
export type AdminExplain = RouteExplanation;

export const AdminQueueConsumer = Type.Object({
  consumer: Type.String(),
  acked: Type.Number(),
  /** Items after `acked` up to the head. */
  pending: Type.Number(),
  /** Pushed to a connected host right now. */
  push: Type.Boolean(),
  /** Unix ms the oldest pending item was received. */
  oldestPendingAt: Type.Optional(Type.Number()),
  /** Unix ms of the last ack. */
  lastAckAt: Type.Optional(Type.Number()),
});
export type AdminQueueConsumer = Static<typeof AdminQueueConsumer>;

/** `GET /api/queue`: the durable host inbound queue, per consumer. */
export const AdminQueue = Type.Object({
  head: Type.Number(),
  consumers: Type.Array(AdminQueueConsumer),
});
export type AdminQueue = Static<typeof AdminQueue>;

/** One session for the console: `SessionInfo` plus what it belongs to. */
export const AdminSession = Type.Composite([
  SessionInfo,
  Type.Object({
    /** The agent the session runs (absent for sessions without one, e.g. host-created). */
    agent: Type.Optional(Type.String()),
    /** Route key of the conversation it serves. */
    conversation: Type.Optional(Type.String()),
    /** The topic it is, for `session: "topic"` sessions. */
    topic: Type.Optional(Topic),
    /** `run:<runId>` sessions. */
    runId: Type.Optional(Type.String()),
    /** Unix ms of the last durable event. */
    lastEventAt: Type.Optional(Type.Number()),
  }),
]);
export type AdminSession = Static<typeof AdminSession>;

/** `GET /api/sessions`. Live events of one: `subscribe` over `/ws`. */
export const AdminSessions = Type.Object({ sessions: Type.Array(AdminSession) });
export type AdminSessions = Static<typeof AdminSessions>;

// ---- endpoint table --------------------------------------------------------

export interface AdminEndpoint {
  method: 'GET' | 'PUT' | 'POST';
  /** Express-style path; `:name` segments are URL-encoded parameters. */
  path: string;
  /** Request body schema (none for GET). */
  body?: TSchema;
  /** Success status and body schema. */
  status: 200 | 202;
  response: TSchema;
  /** Needs no credentials. */
  public?: boolean;
}

/** Every core admin HTTP endpoint, for clients and route tables (modules list theirs, see the header). */
export const ADMIN_ENDPOINTS = [
  { method: 'POST', path: '/api/login', body: AdminLoginRequest, status: 200, response: AdminLoginResult, public: true },
  { method: 'GET', path: '/api/status', status: 200, response: AdminStatus },
  { method: 'GET', path: '/api/config', status: 200, response: AdminConfigDocument },
  { method: 'PUT', path: '/api/config', body: AdminConfigPut, status: 200, response: AdminConfigPutResult },
  { method: 'POST', path: '/api/config/validate', body: AdminConfigValidateRequest, status: 200, response: AdminConfigValidation },
  { method: 'GET', path: '/api/explain/:inputId', status: 200, response: AdminExplain },
  { method: 'GET', path: '/api/queue', status: 200, response: AdminQueue },
  { method: 'GET', path: '/api/sessions', status: 200, response: AdminSessions },
] as const satisfies readonly AdminEndpoint[];
