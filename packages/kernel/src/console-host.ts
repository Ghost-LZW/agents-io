import type {
  AdminBackends,
  AdminChannelsApplied,
  AdminConfigDocument,
  AdminConfigPutResult,
  AdminConfigValidation,
  AdminContext,
  AdminExplain,
  AdminQueue,
  AdminRoute,
  AdminSessions,
  AdminStatus,
  BackendAccess,
  ConfigAccess,
  Origin,
} from '@agents-io/protocol';
import type { ChannelRegistry } from './channel-registry.js';
import type { Config, ConsoleConfig } from './config.js';
import type { ImportConfigModules } from './config-modules.js';
import type { LogFn, Outcome } from './gateway.js';
import type { HarnessRegistry } from './harness-registry.js';
import type { LocalHost } from './local-server.js';
import type { ModuleRegistry } from './modules.js';

/*
 * The kernel's side of the console API (packages/protocol/src/admin.ts; core-slimming §4 P2 item 4):
 * what the gateway gives the console and what it takes of it. The console itself, its HTTP server
 * and the config file it edits, is its own package (`@agents-io/console`: `ConsoleServer`,
 * `ConfigStore`, `consoleFactory`), which depends on this one; the composition root hands it to
 * `Gateway.start` (`GatewayOptions.consoleFactory`: `@agents-io/daemon` gives that package's). The
 * kernel mounts the modules' admin contributions itself (`AdminContribution.mount`, one
 * `AdminContext` each) and hands the routes to the console with their contexts.
 */

/** A route a module contributed (`AdminContribution.routes`), with the context its handler gets. */
export interface ContributedRoute {
  route: AdminRoute;
  ctx: AdminContext;
}

/** What the console needs from the daemon. */
export interface ConsoleHost {
  /** For `/ws` connections (the same as the local socket's). */
  readonly local: LocalHost;
  /** The daemon's host token. */
  readonly token: string;
  /** The backend whose key this token is, and the key's level (PB-1, PB-7). Such a token opens `/ws` only: every `/api/*` answers 403. */
  backendOf?(token: string): { id: string; access: BackendAccess } | undefined;
  status(): AdminStatus;
  queue(): AdminQueue;
  sessions(): AdminSessions;
  /** Backend keys and state (PB-3). Absent: `/api/backends*` answer 404. */
  readonly backends?: {
    list(): AdminBackends;
    /** `access`: which of the backend's keys (default `readwrite`). */
    key(id: string, op: 'issue' | 'rotate' | 'revoke', access?: BackendAccess): Outcome;
    forget(id: string): Outcome;
  };
  explain(inputId: string): AdminExplain | undefined;
  /** Origin of a console connection's client frames. */
  consoleOrigin(sessionKey: string): Origin;
  /** Absent: the daemon was started without a config file path (`/api/config*` answer 404). */
  readonly configStore?: ConsoleConfigStore;
  /** What modules add (`AdminContribution.routes`), served after the core routes; a path both serve is the core's. */
  readonly routes?: readonly ContributedRoute[];
  /** `console.liveChannels`: apply the file's `channels` to the running daemon after a `PUT`. */
  applyChannels?(): Promise<{ applied: 'live' | 'restart'; channels: AdminChannelsApplied } | undefined>;
}

export interface ConsoleServerOptions {
  config: ConsoleConfig;
  host: ConsoleHost;
  log: LogFn;
  now?: () => number;
}

/** A console API server as the gateway runs it (`@agents-io/console`'s `ConsoleServer`). */
export interface ConsoleListener {
  /** `http://host:port` once listening. */
  readonly url: string;
  listen(): Promise<void>;
  close(reason: string): void;
}

export interface ConfigStoreOptions {
  /** The config file (may not exist yet). */
  path: string;
  /** The env file `env:` references resolve from (default: found next to the config, as at startup). */
  envFile?: string;
  /** Process environment (default process.env); wins over the env file, as at startup. */
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /** The harness kinds the file may name (default none; `@agents-io/daemon`'s: the built-in ones): the daemon's (`Gateway.harnessRegistry`). */
  harnessRegistry?: HarnessRegistry;
  /** The channel types the file may name, and what they mark as credentials (default none; `@agents-io/daemon`'s: the built-in ones): the daemon's (`Gateway.channelRegistry`). */
  channelRegistry?: ChannelRegistry;
  /** The feature modules whose config sections the file may have (default none; `@agents-io/daemon`'s: the built-in ones): the daemon's (`Gateway.moduleRegistry`). */
  moduleRegistry?: ModuleRegistry;
  /**
   * How the daemon imports the module files a config file names (`ConfigModules.importModules`):
   * a document is then validated, listed and applied live with the registries this gives for it
   * (what the next start would read it with; given `harnessRegistry`, whose admin contributions a
   * descriptor's are claimed against), not with the ones above; its credentials are what
   * either these or `channelRegistry` mark (a descriptor the daemon's start imported still marks its
   * entries when its file is gone or resolves elsewhere now). A file that does not import is an
   * issue of the document. Without it (a daemon that imports no module files), a `modules` entry
   * the registries above lack is an error: the start would refuse it.
   */
  importModules?: ImportConfigModules;
}

export type PutOutcome =
  | { status: 200; body: AdminConfigPutResult }
  | { status: 409; code: 'conflict'; message: string }
  | { status: 422; body: AdminConfigValidation };

/**
 * The config file as the console shows, checks and writes it (`GET/PUT /api/config`, `POST
 * /api/config/validate`; `@agents-io/console`'s `ConfigStore`), the `ConfigAccess` the modules'
 * admin contributions get (`AdminContext.config`), and what the gateway reads to apply its
 * `channels` live (`console.liveChannels`).
 */
export interface ConsoleConfigStore extends ConfigAccess {
  readonly path: string;
  /** The file: its bytes' revision and parsed content ({} when missing). */
  read(): { raw: unknown; revision: string; parseError?: string };
  /** The file as `GET /api/config` shows it. */
  document(): Promise<AdminConfigDocument>;
  /** Validate a document as `PUT` would. */
  validate(next: Record<string, unknown>): Promise<AdminConfigValidation>;
  put(next: Record<string, unknown>, ifRevision?: string): Promise<PutOutcome>;
  /**
   * The startup resolution of `raw` with the registries the next start would read it with, and the
   * channel registry among them: what a channel applied live is built with. Throws `ConfigError`.
   */
  resolveImported(raw: unknown): Promise<{ config: Config; channelRegistry: ChannelRegistry }>;
  /** The daemon now runs the `channels` of `doc`. */
  channelsApplied(doc: unknown): void;
  /** `live` when the running daemon matches `doc`, else `restart`. */
  appliedOf(doc: unknown): 'live' | 'restart';
}

/** What serves the console API for a gateway (`GatewayOptions.consoleFactory`): `@agents-io/console`'s `consoleFactory`. */
export interface ConsoleFactory {
  /** The config file as the console edits it (a gateway whose config came from a file, `Config.source`). */
  configStore(o: ConfigStoreOptions): ConsoleConfigStore;
  /** The console server over `o.host`, not listening yet. */
  server(o: ConsoleServerOptions): ConsoleListener;
}

/** `v` as JSON with every object's keys sorted: two values are the same document when these are equal. */
export function canonical(v: unknown): string {
  const sort = (x: unknown): unknown =>
    Array.isArray(x) ? x.map(sort) : x && typeof x === 'object' ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, y]) => [k, sort(y)])) : x;
  return JSON.stringify(sort(v));
}
