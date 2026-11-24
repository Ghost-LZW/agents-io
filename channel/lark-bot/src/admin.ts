import { Type, type Static } from '@sinclair/typebox';
import type { AdminEndpoint } from '@agents-io/protocol';

/*
 * The console (admin HTTP) endpoints of Lark bot provisioning: the lark-bot module
 * contributes them as routes (`larkBotAdmin`, provision-admin.ts), which the daemon
 * serves after the core ones (`ADMIN_ENDPOINTS` in @agents-io/protocol), with the
 * same auth, error body (`AdminError`) and conventions; the jobs are `LarkBotJobs`
 * (provision.ts). JSON Schemas: `channel/lark-bot/schema/` (`$id`
 * `agents-io/v1/AdminLarkBot*`, the contribution's `schemas`, written by `pnpm schema`).
 */

/**
 * `POST /api/bots/lark`: start creating a Feishu / Lark app the way
 * create-lark-bot does (the user scans a QR code to authorize; the app gets the
 * scopes, events and callbacks channel/lark-bot needs). Answer 202
 * `AdminLarkBotStarted`; 409 `conflict` while another job waits for a scan, when
 * the account already has a lark-bot channel, or when the variables its
 * credentials go to are set or read by another channel; 400 for a bad account.
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
  /**
   * Channel account name to add the bot as (default `default`): letters, digits,
   * `.`, `_`, `-`, starting with a letter or digit, at most 64. One daemon runs one
   * bot per account. Its credentials go to LARK_APP_ID / LARK_APP_SECRET /
   * LARK_DOMAIN for `default`, else LARK_<ACCOUNT>_APP_ID / … (upper case, other
   * characters as `_`; `proj-a` → LARK_PROJ_A_APP_ID).
   */
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
      /** The `env:NAME` references of this account's credentials, as the channel entry uses them: `{ appId: "env:LARK_PROJ_A_APP_ID", … }`. */
      env: Type.Record(Type.String(), Type.String()),
      /** The owner key added (`lark-bot:<union_id>`), when `owner`. */
      owner: Type.Optional(Type.String()),
      /** A channel was added to the config (the daemon starts it when the config applies live). */
      channelAdded: Type.Boolean(),
      /**
       * The added channel was started at once and had not failed (`console.liveChannels`, as
       * `AdminChannelsApplied.started`); false when it failed to start (the message says why);
       * absent when it starts at the next start.
       */
      channelStarted: Type.Optional(Type.Boolean()),
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

/** The admin endpoints of this module, for clients and route tables (none of them is in `ADMIN_ENDPOINTS`); its routes are these with their handlers. */
export const LARK_BOT_ADMIN_ENDPOINTS = [
  { method: 'POST', path: '/api/bots/lark', body: AdminLarkBotRequest, status: 202, response: AdminLarkBotStarted },
  { method: 'GET', path: '/api/bots/lark/:job', status: 200, response: AdminLarkBotJob },
] as const satisfies readonly AdminEndpoint[];
