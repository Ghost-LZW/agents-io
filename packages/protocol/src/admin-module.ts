import type { TSchema } from '@sinclair/typebox';
import type { AdminChannelsApplied, AdminEndpoint, ConfigIssue } from './admin.js';

/*
 * What a module adds to the host's admin API and console (core-slimming G5, persona's
 * `settings_section`): keys of the console section of the config file, JSON Schemas of its own
 * wire types, HTTP routes, and what it runs while the console serves them. A channel module
 * declares it as `ChannelModule.admin`; the host knows a contribution only through this, a
 * built-in module's (lark-bot's bot provisioning) and a third party's alike.
 */

/** What an `AdminRoute`'s handler gets of the request. */
export interface AdminRouteRequest {
  /** The path's `:name` segments, URL-decoded (a bad encoding is the host's 400 before the handler runs). */
  params: Record<string, string>;
  /** The JSON body, valid against the route's `body` schema (the host answers 400 otherwise); undefined for a route without one. */
  body: unknown;
}

/** What an `AdminRoute`'s handler answers: the HTTP status and the JSON body (an error is an `AdminError` body with a non-2xx status). */
export interface AdminRouteResponse {
  status: number;
  body: unknown;
}

/**
 * A module's admin HTTP endpoint and its handler. The host serves it under the console's rules
 * (credentials, `Host` and `Origin` checks, `application/json` bodies, `AdminError` on errors)
 * after its own endpoints: a path one of these already serves never reaches the handler. It
 * always needs credentials (`public` is the core's only). `path` starts with `/api/`; a `:name`
 * segment matches one path segment, and one that ends the path takes the rest of it, `/`
 * included (as the core's `/api/explain/:inputId` does). A handler that throws is answered 500
 * `internal`.
 */
export interface AdminRoute extends AdminEndpoint {
  handle(req: AdminRouteRequest, ctx: AdminContext): AdminRouteResponse | Promise<AdminRouteResponse>;
}

/**
 * The deployment's config file, as a module reads and changes it (the daemon's `ConfigStore` is
 * one). Values of variables stay in the host: only `lookup` returns one, for comparisons.
 */
export interface ConfigAccess {
  /** The file's parsed content ({} when missing). */
  read(): { raw: unknown };
  /** Which of `names` the env file or the environment sets (names only; values never leave). */
  defined(names: string[]): string[];
  /** The env file the deployment reads its variables from (where a module's child may write credentials). */
  envFilePath(): string;
  /** The value of one variable (same lookup as `defined`). SECRET: compare it, never show or log it. */
  lookup(name: string): string | undefined;
  /** Every variable `value` references as `"env:NAME"`, at any depth (names only). */
  envRefs(value: unknown): string[];
  /**
   * Write `fn`'s result if it passes the checks `PUT /api/config` runs; otherwise nothing is
   * written and the issues come back. Errors thrown by `fn` propagate (nothing written).
   */
  updateValidated(fn: (raw: Record<string, unknown>) => Record<string, unknown>): { ok: true; revision: string } | { ok: false; issues: ConfigIssue[] };
}

/**
 * What a contribution's `mount` and its routes' handlers get. The host makes one per contribution
 * and hands the same object to `mount` and to every `handle` of its routes while it serves them,
 * so a module keeps what it mounted per host by it (e.g. in a `WeakMap` keyed by the context).
 */
export interface AdminContext {
  /**
   * The module's console settings: each key of its `AdminContribution.console`, as the config
   * file's `console` section has it, else that key's schema `default` (left out without either).
   */
  readonly console: Readonly<Record<string, unknown>>;
  /**
   * A private work directory (0700), made before `mount` (the daemon's: `<dataDir>/provision`),
   * for files such as QR codes. Every contribution of the host gets the same one: keep yours in
   * entries named after your module (lark-bot's jobs: `lark_<uuid>`).
   */
  readonly dir: string;
  /** The host's log, as is: prefix messages yourself. Messages never carry secrets. */
  log(level: 'debug' | 'info' | 'warn' | 'error' | 'fatal', msg: string, data?: unknown): void;
  /** The environment of children a module runs. SECRET: never put a value in a message. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The deployment's config file; absent when the host has none (the daemon started without a config file path). */
  readonly config?: ConfigAccess;
  /**
   * With `console.liveChannels` (and a config file): apply the file's `channels` to the running
   * host, as after a `PUT /api/config`; undefined when nothing was applied.
   */
  applyChannels?(): Promise<{ channels: AdminChannelsApplied } | undefined>;
}

/** What a contribution mounted, ended when the host stops serving its routes. */
export interface AdminMount {
  close?(): void;
}

/**
 * A module's part of the admin API and console. Every member is optional. The host checks the
 * contributions of the modules it registers against one another and its own: a console key, a
 * schema name or a route (method and path) belongs to one of them.
 */
export interface AdminContribution {
  /**
   * Keys of the config file's `console` section (`console.<key>`; the section is closed, so a
   * key nobody declares is a config error), with their schemas. Each is optional; a schema's
   * `default` is the value when the file leaves the key out. The resolved values reach `mount`
   * and the handlers as `AdminContext.console`.
   */
  readonly console?: Readonly<Record<string, TSchema>>;
  /**
   * JSON Schemas of the module's own wire types (its routes' bodies and answers), by name: the
   * repository writes them as `<name>.json` with `$id` `agents-io/v<PROTOCOL_VERSION>/<name>`
   * into the module's package (`pnpm schema`), for clients that do not read TypeScript.
   */
  readonly schemas?: Readonly<Record<string, TSchema>>;
  /** Its admin HTTP endpoints. */
  readonly routes?: readonly AdminRoute[];
  /**
   * Called once when the host starts its console, before any request reaches the routes; the
   * result's `close` when the console is gone (the daemon stops, or the console could not
   * listen). A throw fails the daemon's start.
   */
  mount?(ctx: AdminContext): AdminMount | void;
}
