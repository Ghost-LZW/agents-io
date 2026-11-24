import type { TObject } from '@sinclair/typebox';
import type { HarnessAdapter, HarnessFactoryInit } from './harness.js';

/*
 * A harness kind as a module (core-slimming G3): its config shape, defaults and construction,
 * registered by the host's composition root (the daemon's `bundle.ts` registers Claude Code and
 * Codex). The host knows a kind only through this; built-in kinds and a third party's alike.
 */

/**
 * The static members of `HarnessAdapter` (`displayName`, `compact`, `modes`, `ownerProfileSwitch`,
 * `ephemeralOpen`, `adopts`, `sessionEnv`, `attach`): what an adapter declares without starting anything.
 */
export type HarnessDeclarations = Pick<HarnessAdapter, 'displayName' | 'compact' | 'modes' | 'ownerProfileSwitch' | 'ephemeralOpen' | 'adopts' | 'sessionEnv' | 'attach'>;

/** `HarnessDeclarations`' members, in one order (as a bridged harness's program declares them in its hello, `ProbeResult.declares`). */
export const HARNESS_DECLARATION_KEYS = ['displayName', 'compact', 'modes', 'ownerProfileSwitch', 'ephemeralOpen', 'adopts', 'attach', 'sessionEnv'] as const satisfies readonly (keyof HarnessDeclarations)[];

/**
 * A command a harness kind adds to the host's CLI (`HarnessModule.cli`): `argv` is what follows
 * its name, `env` the process's environment; it answers the exit code. Such commands are for the
 * kind's own processes to start (a terminal's helper, `TakeoverServices.cli`), not for people: the
 * CLI's help does not list them.
 */
export type HarnessCliCommand = (o: { argv: readonly string[]; env: Readonly<Record<string, string | undefined>> }) => Promise<number>;

/**
 * How an instance hands `"env:NAME"` values to its harness's child process: a setting that ends
 * up on the child's command line (readable by other local users via `ps`) never gets the value
 * itself; the value goes into the child's environment and the setting names the variable.
 */
export interface HarnessChildSecrets {
  /** The variable's value; `undefined` when it is not set (the instance is then unavailable, naming it). `at` is where it was named. */
  value(name: string, at: string): string | undefined;
  /** Put `k=v` into the child's environment (a config error when the instance's `env` sets `k` differently). */
  toChild(k: string, v: string, at: string): void;
}

/** What `HarnessModule.resolve` gets besides the entry. */
export interface HarnessResolveContext {
  /** The instance name (`harnesses.<name>`; for the older `harness` block, the kind). */
  name: string;
  /** Where the entry is, for messages (`harnesses.<name>`). */
  where: string;
  /**
   * The instance's environment so far (its `env`, `"env:NAME"` substituted; `undefined` removes a
   * variable), read-only: `secrets.toChild` adds to it. SECRET: never put a value in a message.
   */
  env: Readonly<Record<string, string | undefined>>;
  /** A path from the config: `~` is the home directory, a relative one is relative to the config file. */
  path(p: string): string;
  secrets: HarnessChildSecrets;
  /** Fail the config with this message. Messages name keys and variables, never values. */
  fail(msg: string): never;
}

/** What `HarnessModule.legacy.resolve` gets: the older block has no `env` and no `"env:NAME"` values. */
export type HarnessLegacyContext = Pick<HarnessResolveContext, 'name' | 'where' | 'path' | 'fail'>;

/**
 * What `HarnessModule.create` gets: the factory's init (`HarnessFactoryInit`), with what the host
 * resolved for the instance. `config` is a `use: "module"` entry's; a registered kind's instance
 * gets `undefined` there (its settings are `launch`).
 */
export interface HarnessModuleInit<L = unknown> extends HarnessFactoryInit {
  /** What `resolve` made of the instance's entry (a `use: "module"` entry's descriptor: its `config`). */
  launch: L;
  /** The instance's environment over the host's (`undefined` removes a variable). SECRET: never log values. */
  env: Readonly<Record<string, string | undefined>>;
  /** The instance's `profiles`: profile name → harness-native settings. */
  profiles: Readonly<Record<string, Record<string, unknown>>>;
}

/**
 * A harness kind: what a config entry `{ "use": "<kind>", … }` means. The host owns the keys every
 * instance has (`use`, `env`, `cwd`, `run`, `profiles`, `options`), the instance names and the
 * `"env:NAME"` substitution of `env`; the kind owns the rest of the entry.
 *
 * A `use: "module"` entry's module may export one of these instead of a `HarnessFactory` (as
 * `createHarness`, or the entry's `export`, or default): `schema`, when given, checks the entry's
 * `config` (an absent one as `{}`; unknown keys are errors) when the module loads, and `create`
 * gets the factory's init with `launch` = that `config`, plus the instance's `env` and `profiles`.
 * Its other members are not used there: the instance's kind stays `module`, and what its adapter
 * declares is read from the adapter.
 */
export interface HarnessModule<L = unknown> {
  /** The `use` that selects it, and `HarnessInstance.kind`. Never `module`. */
  readonly kind: string;
  /** The entry's own keys, beside the common ones; the host closes the object (an unknown key is a config error). */
  readonly schema: TObject;
  /**
   * The instance's launch settings from its entry (valid against `schema` and the common keys):
   * paths resolved with `ctx.path`, `"env:NAME"` values bound for argv routed through `ctx.secrets`,
   * violations reported with `ctx.fail`. `unavailable`: why the instance cannot be built for now
   * (names variables, never values); a variable `ctx.secrets.value` did not find already makes it so.
   * Without `resolve` the launch is the entry itself.
   */
  resolve?(entry: Record<string, unknown>, ctx: HarnessResolveContext): { launch: L; unavailable?: string };
  /** Rules across this kind's instances (in config order); the message of the first one broken. */
  checkAll?(instances: ReadonlyArray<{ readonly name: string; readonly launch: L }>): string | undefined;
  readonly defaults?: {
    /** `run.model` of an instance that sets none (default `''`). */
    readonly model?: string;
    /** A variable whose value overrides the default instance's model (only the default instance's). */
    readonly modelEnv?: string;
    /** Variables naming this harness's config dir: a session launch may set them only under roots (`sessionParams.envPathRoots`). */
    readonly configDirEnv?: readonly string[];
  };
  /**
   * Its section of the older single `harness` block (`harness.<kind>`), which becomes an instance
   * named after the kind. `schema`: the section's own keys beside `run`, `profiles`, `options`.
   * `envPrefixes`: the `.env.live` keys that block's instances get (with the proxy variables).
   */
  readonly legacy?: {
    readonly schema: TObject;
    readonly envPrefixes?: readonly string[];
    resolve(section: Record<string, unknown>, ctx: HarnessLegacyContext): L;
  };
  /**
   * What every adapter of the kind declares statically, answered without building one (e.g. the
   * kinds the owner's `/plan` reply names when no configured instance has Plan mode). Members that
   * depend on an instance's settings (Codex `adopts`, `sessionEnv`) are read from its adapter.
   */
  readonly declares?: HarnessDeclarations;
  /**
   * Its adapters take the instance's `profiles` in every open's `options.profiles` (over any the
   * instance's `options` set), besides `create`'s `profiles`. Claude Code; the bridge.
   */
  readonly profilesInOpen?: boolean;
  /**
   * Its adapters learn what they declare (`HarnessDeclarations`, and which of the optional methods
   * `detach` / `ownProcess` they have) from the harness itself, in the answer to their first
   * `probe`: an out-of-process harness, whose program says it in its hello (the bridge kind,
   * `@agents-io/harness-jsonl-bridge`). The host builds each available instance's adapter at start
   * and awaits its `probe` before it reads any of them, as it runs a `use: "module"` factory at
   * start; a rejection fails the start, naming the instance (CF-4). An adapter of the kind built
   * later (a task run's) is probed when its lane opens, as any other.
   */
  readonly probeAtStart?: boolean;
  /**
   * Commands it adds to the host's CLI, by name (lowercase letters, digits and `-`, starting with a
   * letter): `aio <name> …` runs it. Only the kinds of the CLI's own bundle are reachable there (it
   * loads no config to find others); two of them adding the same name is refused when the registry
   * is built, and the CLI's own commands keep their names. Claude Code: `tui-bridge`, which its
   * terminal UI starts.
   */
  readonly cli?: Readonly<Record<string, HarnessCliCommand>>;
  /** The adapter of one instance (or of a task run on it, its env joined to the instance's). Starts nothing: its first `probe` or `open` does. */
  create(init: HarnessModuleInit<L>): HarnessAdapter;
}
