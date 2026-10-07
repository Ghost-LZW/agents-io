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
  /** A host connection (consumer / callouts) is open, or a lease is live. */
  connected: Type.Boolean(),
  name: Type.Optional(Type.String()),
  consumer: Type.Optional(Type.String()),
  callouts: Type.Optional(Type.Boolean()),
  /** Unix ms a pull-only host's presence lease runs out. */
  leaseExpiresAt: Type.Optional(Type.Number()),
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
});
export type AdminChannel = Static<typeof AdminChannel>;

export const AdminAgent = Type.Object({
  name: Type.String(),
  /** Harness instance id. */
  harness: Type.String(),
  mode: Type.Union([Type.Literal('interactive'), Type.Literal('task')]),
  model: Type.Optional(Type.String()),
  effort: Type.Optional(Type.String()),
  profile: Type.Optional(Type.String()),
  cwd: Type.Optional(Type.String()),
  default: Type.Optional(Type.Boolean()),
});
export type AdminAgent = Static<typeof AdminAgent>;

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
  /** Every `env:NAME` the document references, and whether the daemon's environment / env file sets it. Values are never shown. */
  env: Type.Array(Type.Object({ name: Type.String(), set: Type.Boolean() })),
});
export type AdminConfigDocument = Static<typeof AdminConfigDocument>;

/** `PUT /api/config`: replace the file. Refused (422, nothing written) when an issue has severity `error`. */
export const AdminConfigPut = Type.Object({
  config: AdminConfigBody,
  /** Optimistic concurrency: 409 `conflict` unless the file is still at this revision. */
  ifRevision: Type.Optional(Type.String()),
});
export type AdminConfigPut = Static<typeof AdminConfigPut>;

export const AdminConfigPutResult = Type.Object({
  revision: Type.String(),
  /** Warnings (errors refuse the write; they come back in a 422 body as `AdminConfigValidation`). */
  issues: Type.Array(ConfigIssue),
  /** live: applied to the running daemon; restart: saved, takes effect at the next start. */
  applied: Type.Union([Type.Literal('live'), Type.Literal('restart')]),
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

// ---- Lark bot provisioning -------------------------------------------------

/**
 * `POST /api/bots/lark`: start creating a Feishu / Lark app the way
 * create-lark-bot does (the user scans a QR code to authorize; the app gets the
 * scopes, events and callbacks channel/lark-bot needs). Answer 202
 * `AdminLarkBotStarted`; 409 `conflict` while another job waits for a scan.
 */
export const AdminLarkBotRequest = Type.Object({
  /** App / bot display name. */
  name: Type.String(),
  /** `data:` URI of the avatar image. */
  avatar: Type.Optional(Type.String()),
  /** Default `feishu`. */
  domain: Type.Optional(Type.Union([Type.Literal('feishu'), Type.Literal('lark')])),
  /** create-lark-bot presets; default `messaging`, `contact`. */
  presets: Type.Optional(Type.Array(Type.String())),
  /** Channel account name to add the bot as (default `default`). */
  account: Type.Optional(Type.String()),
  /** Add a `lark-bot` channel for it to the config (default true). */
  addChannel: Type.Optional(Type.Boolean()),
  /** Make the authorizing user an owner (default true). */
  owner: Type.Optional(Type.Boolean()),
});
export type AdminLarkBotRequest = Static<typeof AdminLarkBotRequest>;

export const AdminLarkBotStarted = Type.Object({ job: Type.String() });
export type AdminLarkBotStarted = Static<typeof AdminLarkBotStarted>;

export const AdminLarkBotJobState = Type.Union([
  Type.Literal('starting'),
  /** Show `qr`; the user scans it with the Feishu / Lark app. */
  Type.Literal('waiting_scan'),
  /** Scanned; creating and configuring the app. */
  Type.Literal('configuring'),
  Type.Literal('succeeded'),
  Type.Literal('failed'),
  /** The QR code expired before a scan. */
  Type.Literal('expired'),
]);
export type AdminLarkBotJobState = Static<typeof AdminLarkBotJobState>;

/** `GET /api/bots/lark/:job` (404 `unknown_job`). Poll until a final state. */
export const AdminLarkBotJob = Type.Object({
  job: Type.String(),
  state: AdminLarkBotJobState,
  /** While `waiting_scan`: the payload to render as a QR code (a URL), and when it stops working (Unix ms). */
  qr: Type.Optional(Type.Object({ payload: Type.String(), expiresAt: Type.Optional(Type.Number()) })),
  /** Progress line for the UI. */
  message: Type.Optional(Type.String()),
  /** On `succeeded`. Credentials went to the daemon's env file; only their `env:NAME` references are here. */
  result: Type.Optional(
    Type.Object({
      appId: Type.String(),
      domain: Type.Union([Type.Literal('feishu'), Type.Literal('lark')]),
      botName: Type.Optional(Type.String()),
      account: Type.String(),
      /** `env:NAME` references the config uses: `{ appId: "env:LARK_APP_ID", appSecret: "env:LARK_APP_SECRET", … }`. */
      env: Type.Record(Type.String(), Type.String()),
      /** The owner key added (`lark-bot:<union_id>`), when `owner`. */
      owner: Type.Optional(Type.String()),
      /** A channel was added to the config (the daemon starts it when the config applies live). */
      channelAdded: Type.Boolean(),
      /** Console URL to finish what could not be automated (e.g. publishing the app version). */
      consoleUrl: Type.Optional(Type.String()),
    }),
  ),
  error: Type.Optional(Type.Object({ code: Type.String(), message: Type.String() })),
  /** Unix ms. */
  createdAt: Type.Number(),
  updatedAt: Type.Number(),
});
export type AdminLarkBotJob = Static<typeof AdminLarkBotJob>;

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

/** Every admin HTTP endpoint, for clients and route tables. */
export const ADMIN_ENDPOINTS = [
  { method: 'POST', path: '/api/login', body: AdminLoginRequest, status: 200, response: AdminLoginResult, public: true },
  { method: 'GET', path: '/api/status', status: 200, response: AdminStatus },
  { method: 'GET', path: '/api/config', status: 200, response: AdminConfigDocument },
  { method: 'PUT', path: '/api/config', body: AdminConfigPut, status: 200, response: AdminConfigPutResult },
  { method: 'POST', path: '/api/config/validate', body: AdminConfigValidateRequest, status: 200, response: AdminConfigValidation },
  { method: 'GET', path: '/api/explain/:inputId', status: 200, response: AdminExplain },
  { method: 'GET', path: '/api/queue', status: 200, response: AdminQueue },
  { method: 'GET', path: '/api/sessions', status: 200, response: AdminSessions },
  { method: 'POST', path: '/api/bots/lark', body: AdminLarkBotRequest, status: 202, response: AdminLarkBotStarted },
  { method: 'GET', path: '/api/bots/lark/:job', status: 200, response: AdminLarkBotJob },
] as const satisfies readonly AdminEndpoint[];
