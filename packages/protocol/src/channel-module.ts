import type { TSchema } from '@sinclair/typebox';
import type { ChannelAdapter, ChannelFactoryInit } from './channel.js';

/*
 * A channel type as a module (core-slimming G2): what a config entry `{ "type": "<type>", … }`
 * means (its keys, how they resolve, the rules across its entries) and how its adapter is built,
 * registered by the host's composition root (the daemon's `bundle.ts` registers lark-bot, mail,
 * bridge and module). The host knows a type only through this; built-in types and a third
 * party's alike.
 */

/** What `ChannelModule.resolve` gets besides the entry. */
export interface ChannelResolveContext {
  /** The entry's position in `channels`. */
  index: number;
  /** Where the entry is, for messages: `channels[<index>]`. */
  where: string;
  /** The deployment's environment (the process's over `.env.live`), read-only. SECRET: never put a value in a message. */
  env: Readonly<Record<string, string | undefined>>;
  /**
   * `v` with every string `"env:NAME"` in it replaced by the variable's value. A variable that is
   * not set fails the config: `<where>…: environment variable NAME is not set` (`where` is the
   * prefix of that message, extended with the keys and indexes below it).
   */
  substitute(v: unknown, where: string): unknown;
  /** A path from the config: `~` is the home directory, a relative one is relative to the config file. */
  path(p: string): string;
  /** Fail the config with this message. Messages name keys and variables, never values. */
  fail(msg: string): never;
}

/** One entry of a type, for `ChannelModule.validateAll`. */
export interface ChannelValidateEntry<E, R> {
  /** The entry's position in `channels`. */
  index: number;
  /** As written (valid against the type's schema). */
  entry: E;
  /** As the host resolved it (`resolve`), with its `account`. */
  resolved: R & { account: string };
}

/** What `ChannelModule.validateAll` gets besides the entries. */
export interface ChannelValidateContext {
  /** Reserved channel ids: every registered type's `ids` and the host's own (`local`, `agent`). No entry of another type may use one (a bridge's `id`). */
  reservedIds: readonly string[];
  /** Fail the config with this message (same rules as `ChannelResolveContext.fail`). */
  fail(msg: string): never;
  /** Not fatal: logged when the daemon starts (same rules as messages). */
  warn(msg: string): void;
}

/** What `ChannelModule.create` gets besides the entry: the factory's init, with what the host gives every channel. */
export interface ChannelInit extends ChannelFactoryInit {
  /** The entry's position in `channels`. */
  index: number;
  /** The host's log, as is: a module prefixes its messages itself (the daemon's `module` type: `channel module <file>: `). */
  log(level: 'debug' | 'info' | 'warn' | 'error' | 'fatal', msg: string, data?: unknown): void;
  /**
   * A directory of this channel account's own under the host's data directory, for state kept
   * across restarts (the daemon's: `<dataDir>/channels/<type>.<account, URI-encoded>`); it may not
   * exist yet.
   */
  stateDir: string;
  /**
   * Asked before taking a channel id the adapter learns only once running (a bridge's `hello`):
   * a reason refuses it (that id belongs to another adapter here, or is reserved).
   */
  acceptId(id: string): string | undefined;
  /**
   * Report the connection state of an adapter that connects after it is built (a bridge's peer):
   * the host lists it `failed` with the reason until it reports connected. A channel that reports
   * before `create` returns has its `evidence` grant checked against its caps when it reports
   * connected (its caps are its peer's), not when it starts.
   */
  onState(s: { connected: boolean; error?: string }): void;
}

/** A channel `create` built (not started yet). */
export interface BuiltChannel {
  adapter: ChannelAdapter;
  /** `ChannelContext.config` at `start` (default none). */
  config?: unknown;
  /** Called when the host stops the channel, after the `start` signal aborted. */
  close?(): Promise<void>;
  /** Its channel id is settled (`adapter.id` is final); default true. False while a bridge without `id` waits for its peer's first `hello`. */
  idKnown?(): boolean;
}

/**
 * What a channel module adds to the host's admin API and console: routes, console settings,
 * schemas (core-slimming G5). Reserved: the host reads none of it yet.
 */
export interface ChannelAdminContribution {}

/**
 * A channel type: what a config entry `{ "type": "<type>", … }` means. The host owns `type`, the
 * keys every entry has (`account`, default `default`; `tier`, `openDelayMs`, `previewDelayMs`,
 * `ack`, `evidence`) and the `"env:NAME"` substitution (`ChannelResolveContext.substitute`); the
 * type owns the rest of the entry. `E` is the entry as written, `R` what it resolves to; both are
 * the type's own keys with `type` (the common ones are there too, untyped).
 *
 * The evidence an entry gives without its own `evidence` grant is not the module's to say: the
 * composition root grants it when it registers the type (the daemon's `bundle.ts`: lark-bot and
 * mail their caps; every other type, bridge and module included, `device_only` only).
 *
 * In progress (core-slimming G2): the daemon reads all of it except `implicitEnv` and `admin`.
 */
export interface ChannelModule<E = Record<string, unknown>, R = E> {
  /** The `type` that selects it. */
  readonly type: string;
  /**
   * The channel ids (`ChannelAdapter.id`) its adapters use, when fixed (`lark-bot`, `mail`):
   * reserved, so no entry of another type (a bridge's `id`, a module's adapter) may use them.
   */
  readonly ids?: readonly string[];
  /**
   * The entry's own keys beside `type` and the common ones, in the order the schema lists them;
   * the host closes the object (an unknown key is a config error). A string that holds a
   * credential is marked `{ 'x-credential': true }` (e.g. `Type.String({ 'x-credential': true })`),
   * so the console redacts it and refuses a literal there; a mark on a map or an array marks every
   * string in it. `isCredential` says what a schema cannot.
   */
  readonly entry: Readonly<Record<string, TSchema>>;
  /**
   * Whether the string at `path` (from the entry, e.g. `['args', '3']`) is a credential where the
   * schema cannot say so: a bridge's argument after `--token`, a key in a free-form `config`. True
   * marks it; false leaves it to the host's rule for free-form parts (a secret-looking key). `entry`
   * is the entry as the document has it (the console asks about documents that may not validate).
   */
  isCredential?(path: readonly string[], entry: E): boolean;
  /** Variables the entry reads without naming them as `"env:NAME"` (a lark-bot entry without its own app: `LARK_APP_*`). */
  implicitEnv?(entry: E): string[];
  /**
   * The entry as its adapter will use it: `"env:NAME"` values substituted (`ctx.substitute`),
   * paths resolved (`ctx.path`), defaults filled; violations reported with `ctx.fail`. The host
   * keeps the keys it leaves out and sets `account`.
   */
  resolve(entry: E, ctx: ChannelResolveContext): R;
  /** Rules across this type's entries (all of them, in config order), after every entry resolved: `ctx.fail` on the first one broken. */
  validateAll?(entries: ReadonlyArray<ChannelValidateEntry<E, R>>, ctx: ChannelValidateContext): void;
  /**
   * Who an entry's channel id belongs to (channel-stamping F4), among this type's entries: entries
   * sharing an id must share an owner, only their accounts differ. The host names it
   * `<type>:<owner>` (a bridge: `bridge:["node",["peer.js"]]`), so no type can claim another's;
   * without it, the type (one adapter per type).
   */
  owner?(entry: R): string;
  /**
   * The entry's channel id when it is known before the adapter is built (a bridge's `id`). Default
   * the type's one declared id (`ids` with a single id), else unknown.
   */
  idOf?(entry: R): string | undefined;
  /** The adapter of one entry. Starts nothing: the host's `start` does. A throw fails the daemon's start (or that entry's live apply). */
  create(entry: R & { account: string }, init: ChannelInit): BuiltChannel | Promise<BuiltChannel>;
  /** Reserved (core-slimming G5). */
  readonly admin?: ChannelAdminContribution;
}
