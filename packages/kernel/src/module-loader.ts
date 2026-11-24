import { existsSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, parse } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Type, type TSchema } from '@sinclair/typebox';
import {
  HARNESS_DECLARATION_KEYS,
  errors,
  type BlobAccess,
  type ChannelAdapter,
  type ChannelFactory,
  type ChannelModule,
  type HarnessAdapter,
  type HarnessCaps,
  type HarnessCliCommand,
  type HarnessDeclarations,
  type HarnessFactory,
  type HarnessFactoryInit,
  type HarnessModule,
  type HarnessOpenArgs,
  type HarnessSession,
  type HarnessTakeover,
  type HarnessTakeoverArgs,
  type ModuleManifest,
  type NativeClient,
  type SessionEnvSupport,
} from '@agents-io/protocol';
import type { ModuleLaunch } from './config.js';

/*
 * Plugin modules from outside this repo: a `{ "type": "module" }` channel entry's (exporting a
 * ChannelFactory, or a ChannelModule descriptor), a `{ "use": "module" }` harness instance's (a
 * HarnessFactory, or a HarnessModule descriptor) and a `modules` entry's (a ModuleManifest, a
 * feature module). One resolution of the file (at config time) and one import (a harness module's
 * at start; a feature module's and a channel module file's before the config is resolved, when
 * the daemon imports the config's modules, else a channel module's at start), each kind with its
 * own export rule (`loadExport`). Resolution is by hand, not require.resolve, so a package whose
 * exports map only has an `import` condition works too.
 */

const CONDITIONS = ['import', 'node', 'default', 'require'];

/** The entry of an `exports` target: a string, or the first matching condition (nested). */
function target(t: unknown): string | undefined {
  if (typeof t === 'string') return t;
  if (Array.isArray(t)) return t.map(target).find((x) => x !== undefined);
  if (t && typeof t === 'object') {
    for (const c of CONDITIONS) if (c in t) return target((t as Record<string, unknown>)[c]);
  }
  return undefined;
}

/** The file a package directory's `exports["."]` / `main` names (else `index.js`). */
function packageEntry(dir: string): string | undefined {
  const pj = join(dir, 'package.json');
  if (existsSync(pj)) {
    let j: { exports?: unknown; main?: unknown };
    try {
      j = JSON.parse(readFileSync(pj, 'utf8'));
    } catch (e) {
      throw new Error(`cannot read ${pj}: ${(e as Error).message}`);
    }
    const ex = j.exports;
    const dot = ex && typeof ex === 'object' && !Array.isArray(ex) && Object.keys(ex).some((k) => k.startsWith('.')) ? (ex as Record<string, unknown>)['.'] : ex;
    const t = target(dot) ?? (typeof j.main === 'string' ? j.main : undefined);
    if (t) return join(dir, t);
  }
  return existsSync(join(dir, 'index.js')) ? join(dir, 'index.js') : undefined;
}

/**
 * The file to import for a module specifier. `abs` is the specifier made absolute
 * when it is a path; a bare specifier is looked up from `baseDir`. Returns an error
 * message instead of a file when nothing is there.
 */
export function resolveModuleFile(spec: string, abs: string | undefined, baseDir: string): { file: string } | { error: string } {
  const fromDir = (p: string): { file: string } | { error: string } => {
    if (!existsSync(p)) return { error: `${p} does not exist` };
    let file: string | undefined = p;
    if (statSync(p).isDirectory()) {
      try {
        file = packageEntry(p);
      } catch (e) {
        return { error: (e as Error).message };
      }
      if (!file) return { error: `${p} has no package.json exports["."] / main / index.js` };
    }
    return existsSync(file) ? { file } : { error: `${file} does not exist` };
  };
  if (abs !== undefined) return fromDir(abs);
  try {
    return { file: createRequire(join(baseDir, 'noop.js')).resolve(spec) };
  } catch {
    // An `import`-only exports map is not resolvable by require: find the package directory ourselves.
    const parts = spec.split('/');
    const name = spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!;
    if (name === spec) {
      for (let d = baseDir; ; d = dirname(d)) {
        const p = join(d, 'node_modules', name);
        if (existsSync(p)) return fromDir(p);
        if (parse(d).root === d) break;
      }
    }
    return { error: `cannot resolve ${JSON.stringify(spec)} from ${baseDir}` };
  }
}

/**
 * Import a resolved module file and take the export the entry names. `where` starts every
 * message. Without a named export it is `defaultName`, else `default`; a named one falls back to
 * `default` only when `namedFallsBack` (channel modules do, harness modules do not). `what`
 * describes the export looked for, for a message about it (`export "x" (or default)`).
 */
async function loadExport(o: { file: string; where: string; export: string | undefined; defaultName: string; namedFallsBack: boolean }): Promise<{ value: unknown; what: string }> {
  const name = o.export ?? o.defaultName;
  const mod = (await import(pathToFileURL(o.file).href).catch((e: Error) => {
    throw new Error(`${o.where}: cannot import: ${e.message}`);
  })) as Record<string, unknown>;
  const orDefault = o.export === undefined || o.namedFallsBack;
  return { value: orDefault ? (mod[name] ?? mod.default) : mod[name], what: `export ${JSON.stringify(name)}${orDefault ? ' (or default)' : ''}` };
}

export interface LoadedChannelOptions {
  /** The resolved module file (config resolution made it absolute). */
  file: string;
  /** Export name; default `createChannel`. Named or not, it falls back to `default`. */
  export?: string;
  index: number;
  account: string;
  config: unknown;
  log: (level: 'debug' | 'info' | 'warn' | 'error' | 'fatal', msg: string, data?: unknown) => void;
}

/** Import a channel module, run its factory, and check the adapter's shape. */
export async function loadChannelModule(o: LoadedChannelOptions): Promise<ChannelAdapter> {
  const where = `channels[${o.index}] (module ${o.file})`;
  const { value: factory, what } = await loadExport({ file: o.file, where, export: o.export, defaultName: 'createChannel', namedFallsBack: true });
  if (channelDescriptor(factory))
    throw new Error(`${where}: ${what} is a ChannelModule descriptor, which is read when the config's module files are imported before it is resolved (loadConfigModules, as aio serve does)`);
  if (typeof factory !== 'function') throw new Error(`${where}: ${what} is not a function`);
  let adapter: ChannelAdapter;
  try {
    adapter = await (factory as ChannelFactory)({ account: o.account, config: o.config, log: o.log });
  } catch (e) {
    throw new Error(`${where}: factory failed: ${(e as Error).message}`);
  }
  const bad = badChannelAdapter(adapter);
  if (bad) throw new Error(`${where}: the factory did not return a ChannelAdapter (bad ${bad})`);
  return adapter;
}

/** The first member of a value that a `ChannelAdapter` must have and it lacks (`id`, `caps`, `start`, `send`); none when it has them. */
export function badChannelAdapter(v: unknown): string | undefined {
  const a = typeof v === 'object' && v !== null ? (v as Partial<Record<string, unknown>>) : undefined;
  if (!a || typeof a.id !== 'string' || !a.id) return 'id (a non-empty string)';
  return (['caps', 'start', 'send'] as const).find((k) => typeof a[k] !== 'function');
}

/**
 * Import a harness module, run its factory (or its descriptor's `create`, `HarnessModule`), and check
 * the adapter's shape. A named export (`ModuleLaunch.export`) never falls back to `default`.
 */
export async function loadHarnessModule(o: {
  name: string;
  module: ModuleLaunch;
  log: (level: 'debug' | 'info' | 'warn' | 'error' | 'fatal', msg: string, data?: unknown) => void;
  harness: (name: string) => HarnessAdapter;
  blobs: BlobAccess;
  env: Record<string, string | undefined>;
  profiles: Record<string, Record<string, unknown>>;
  /** Given the CLI commands a descriptor adds (`HarnessModule.cli`, checked), when it adds any. */
  commands?: (cli: Readonly<Record<string, HarnessCliCommand>>) => void;
}): Promise<HarnessAdapter> {
  const where = `harnesses.${o.name} (module ${o.module.file})`;
  const { value: factory, what } = await loadExport({ file: o.module.file, where, export: o.module.export, defaultName: 'createHarness', namedFallsBack: false });
  const descriptor = harnessDescriptor(factory);
  if (typeof factory !== 'function' && !descriptor) throw new Error(`${where}: ${what} is not a function`);
  const init: HarnessFactoryInit = { name: o.name, config: o.module.config, log: o.log, harness: o.harness, blobs: o.blobs };
  let adapter: HarnessAdapter;
  let declares: HarnessDeclarations | undefined;
  if (descriptor) {
    // What it declares for its adapters, and the commands it adds to the CLI: checked before anything is built.
    if (descriptor.declares !== undefined) {
      const bad = badDeclarations(descriptor.declares);
      if (bad) throw new Error(`${where}: bad declares.${bad}`);
      declares = descriptor.declares as HarnessDeclarations;
    }
    const cli = descriptorCli(descriptor, where);
    if (cli && o.commands) o.commands(cli);
    // A descriptor: its `schema` checks the entry's `config` (closed; an absent one is `{}`), which is its `launch`.
    const launch = o.module.config ?? {};
    const schema: unknown = descriptor.schema;
    if (schema !== undefined) {
      let errs: string[];
      try {
        const properties = (schema as { properties?: unknown } | null)?.properties;
        if (typeof properties !== 'object' || properties === null) throw new Error('not a TypeBox object schema');
        errs = errors(Type.Object(properties as Record<string, TSchema>, { additionalProperties: false }), launch);
      } catch (e) {
        throw new Error(`${where}: the descriptor's schema cannot be checked: ${(e as Error).message}`);
      }
      if (errs.length) throw new Error(`${where}: invalid config: ${errs.slice(0, 5).map((e) => `config${e}`).join('; ')}`);
    }
    try {
      adapter = await descriptor.create({ ...init, launch, env: o.env, profiles: o.profiles });
    } catch (e) {
      throw new Error(`${where}: create failed: ${(e as Error).message}`);
    }
  } else {
    try {
      adapter = await (factory as HarnessFactory)(init);
    } catch (e) {
      throw new Error(`${where}: factory failed: ${(e as Error).message}`);
    }
  }
  const check = (a: HarnessAdapter) => {
    const bad = badHarnessAdapter(a as unknown as Partial<Record<string, unknown>> | null);
    if (bad) throw new Error(`${where}: ${descriptor ? 'create' : 'the factory'} did not return a HarnessAdapter (bad ${bad})`);
  };
  check(adapter);
  if (!declares) return adapter;
  // The descriptor's declarations stand in for the ones its adapter does not make itself: checked again together.
  const declared = declaredHarness(descriptor!, adapter, declares);
  check(declared);
  return declared;
}

/**
 * The commands a `use: "module"` instance's module adds to the CLI (`HarnessModule.cli` of the
 * descriptor it exports), checked; none for a factory. For the CLI, which finds them through its
 * config: the module is imported, nothing is built.
 */
export async function harnessModuleCommands(o: { name: string; module: ModuleLaunch }): Promise<Readonly<Record<string, HarnessCliCommand>> | undefined> {
  const where = `harnesses.${o.name} (module ${o.module.file})`;
  const { value } = await loadExport({ file: o.module.file, where, export: o.module.export, defaultName: 'createHarness', namedFallsBack: false });
  const descriptor = harnessDescriptor(value);
  return descriptor ? descriptorCli(descriptor, where) : undefined;
}

/** A name `HarnessModule.cli` may give a command (the harness registry's rule). */
const CLI_NAME = /^[a-z][a-z0-9-]*$/;

/** A descriptor's `cli`, checked (`<where>: bad cli…` otherwise); undefined when it adds none. */
function descriptorCli(d: HarnessDescriptor, where: string): Readonly<Record<string, HarnessCliCommand>> | undefined {
  if (d.cli === undefined) return undefined;
  if (typeof d.cli !== 'object' || d.cli === null || Array.isArray(d.cli)) throw new Error(`${where}: bad cli (an object of commands when present)`);
  for (const [name, run] of Object.entries(d.cli)) {
    if (!CLI_NAME.test(name)) throw new Error(`${where}: bad cli ${JSON.stringify(name)} (a command name is lowercase letters, digits and -, starting with a letter)`);
    if (typeof run !== 'function') throw new Error(`${where}: bad cli ${JSON.stringify(name)} (a function)`);
  }
  return d.cli as Readonly<Record<string, HarnessCliCommand>>;
}

/** What a module's harness kind descriptor is read for. */
type HarnessDescriptor = Pick<HarnessModule, 'create'> & { schema?: unknown; declares?: unknown; cli?: unknown };

/** A module's export as a harness kind descriptor (`HarnessModule`: an object with a `create` function), if it is one. */
function harnessDescriptor(v: unknown): HarnessDescriptor | undefined {
  return typeof v === 'object' && v !== null && typeof (v as { create?: unknown }).create === 'function' ? (v as HarnessDescriptor) : undefined;
}

/** The first member of a descriptor's `declares` that is not a declaration of the right type, described; none when all are. */
function badDeclarations(d: unknown): string | undefined {
  if (typeof d !== 'object' || d === null || Array.isArray(d)) return '(an object of declarations when present)';
  const unknown = Object.keys(d).find((k) => !(HARNESS_DECLARATION_KEYS as readonly string[]).includes(k));
  if (unknown !== undefined) return `${unknown} (not a declaration: ${HARNESS_DECLARATION_KEYS.join(', ')})`;
  return badStatic(d as Partial<Record<string, unknown>>);
}

const declaredHarnesses = new WeakMap<object, WeakMap<HarnessAdapter, HarnessAdapter>>();

/**
 * `adapter` with what `declares` says where it says nothing itself (`HarnessModule.declares` of a
 * module's descriptor): one wrapper per descriptor and adapter object, so instances of one
 * descriptor whose `create` returns the same adapter share one; under two descriptors the adapter
 * has two, and `declaredInner` gives it back (each lifecycle call once).
 */
function declaredHarness(descriptor: object, adapter: HarnessAdapter, declares: HarnessDeclarations): HarnessAdapter {
  let byAdapter = declaredHarnesses.get(descriptor);
  if (!byAdapter) declaredHarnesses.set(descriptor, (byAdapter = new WeakMap()));
  let a = byAdapter.get(adapter);
  if (!a) byAdapter.set(adapter, (a = new DeclaredHarness(adapter, declares)));
  return a;
}

/**
 * The adapter a module's `create` returned, under the `declares` of its descriptor (`a` itself when
 * it is not wrapped so). Two descriptors declaring differently wrap one adapter twice: whoever gives
 * an adapter its lifecycle calls once (the gateway's stop) counts it by this.
 */
export function declaredInner(a: HarnessAdapter): HarnessAdapter {
  return a instanceof DeclaredHarness ? a.inner : a;
}

/** A module's adapter under its descriptor's `declares`: its own members first; methods present only when it has them. */
class DeclaredHarness implements HarnessAdapter {
  constructor(
    readonly inner: HarnessAdapter,
    private readonly declares: HarnessDeclarations,
  ) {}

  get id(): string {
    return this.inner.id;
  }

  get displayName(): string | undefined {
    return this.inner.displayName ?? this.declares.displayName;
  }

  get compact(): { readonly command: string } | undefined {
    return this.inner.compact ?? this.declares.compact;
  }

  get modes(): readonly 'plan'[] | undefined {
    return this.inner.modes ?? this.declares.modes;
  }

  get ownerProfileSwitch(): boolean | undefined {
    return this.inner.ownerProfileSwitch ?? this.declares.ownerProfileSwitch;
  }

  get ephemeralOpen(): boolean | undefined {
    return this.inner.ephemeralOpen ?? this.declares.ephemeralOpen;
  }

  get adopts(): boolean | undefined {
    return this.inner.adopts ?? this.declares.adopts;
  }

  get sessionEnv(): SessionEnvSupport | undefined {
    return this.inner.sessionEnv ?? this.declares.sessionEnv;
  }

  get attach(): 'join' | 'takeover' | undefined {
    return this.inner.attach ?? this.declares.attach;
  }

  // The optional methods: bound to the adapter when it has them (anything else as it is, for the shape check).
  get detach(): (() => Promise<void>) | undefined {
    return this.method('detach');
  }

  get dispose(): (() => Promise<void>) | undefined {
    return this.method('dispose');
  }

  get nativeClient(): ((nativeId: string) => NativeClient | undefined) | undefined {
    return this.method('nativeClient');
  }

  get takeover(): ((a: HarnessTakeoverArgs) => Promise<HarnessTakeover>) | undefined {
    return this.method('takeover');
  }

  /** Its own process's adapter declares what this one's kind declares too. */
  get ownProcess(): ((o: { env: Record<string, string>; cwd?: string }) => HarnessAdapter) | undefined {
    const f = this.inner.ownProcess;
    if (typeof f !== 'function') return f;
    return (o) => new DeclaredHarness(f.call(this.inner, o), this.declares);
  }

  probe(): Promise<{ version: string; caps: HarnessCaps }> {
    return this.inner.probe();
  }

  open(args: HarnessOpenArgs): Promise<HarnessSession> {
    return this.inner.open(args);
  }

  private method<K extends 'detach' | 'dispose' | 'nativeClient' | 'takeover'>(k: K): HarnessAdapter[K] {
    const f = this.inner[k] as unknown;
    if (typeof f !== 'function') return f as HarnessAdapter[K];
    return ((...args: unknown[]) => (f as (...a: unknown[]) => unknown).apply(this.inner, args)) as HarnessAdapter[K];
  }
}

/**
 * Import a `modules` entry's feature module and take its manifest: the export the entry names
 * (never falling back), else `manifest`, else `default`. Only its shape as a value is checked here
 * (an object with an `id`); the registry it joins checks the rest (`ModuleRegistry`), naming it.
 */
export async function loadFeatureModule(o: { file: string; export?: string; where: string }): Promise<ModuleManifest<unknown>> {
  const { value, what } = await loadExport({ file: o.file, where: o.where, export: o.export, defaultName: 'manifest', namedFallsBack: false });
  if (typeof value !== 'object' || value === null || Array.isArray(value) || typeof (value as { id?: unknown }).id !== 'string')
    throw new Error(`${o.where}: ${what} is not a module manifest (an object with an id, kind "feature" and setup)`);
  return value as ModuleManifest<unknown>;
}

/** What a `type: "module"` channel entry's file exports: a factory, a `ChannelModule` descriptor, or something else (the start says what). */
export type ChannelFileExport = { factory: ChannelFactory } | { descriptor: ChannelModule } | { other: unknown };

/** Import a `type: "module"` channel entry's file and take the export it names (as the channel rule does: `createChannel`, else `default`). */
export async function loadChannelFile(o: { file: string; export?: string; where: string }): Promise<ChannelFileExport> {
  const { value } = await loadExport({ file: o.file, where: o.where, export: o.export, defaultName: 'createChannel', namedFallsBack: true });
  if (typeof value === 'function') return { factory: value as ChannelFactory };
  if (channelDescriptor(value)) return { descriptor: value as ChannelModule };
  return { other: value };
}

/** A module file's export as a channel type descriptor (`ChannelModule`: an object with a `create` function), if it is one. */
export function channelDescriptor(v: unknown): boolean {
  return typeof v === 'object' && v !== null && typeof (v as { create?: unknown }).create === 'function';
}

/**
 * The first member of a module's adapter that is not what `HarnessAdapter` says, described; none when
 * all are. A module is untyped code: what the host reads later (the static declarations, the
 * lifecycle calls, `nativeClient` / `takeover` for a terminal joining or taking a session) is
 * checked once here, so a wrong shape fails the start (CF-4) instead of a command, an attach or a stop.
 */
function badHarnessAdapter(a: Partial<Record<string, unknown>> | null): string | undefined {
  if (!a || typeof a.id !== 'string' || !a.id) return 'id (a non-empty string)';
  const required = (['probe', 'open'] as const).find((k) => typeof a[k] !== 'function');
  if (required) return required;
  const method = (['detach', 'dispose', 'ownProcess', 'nativeClient', 'takeover'] as const).find((k) => a[k] !== undefined && typeof a[k] !== 'function');
  if (method) return `${method} (a function when present)`;
  return badStatic(a, true);
}

/**
 * The first static declaration (`HarnessDeclarations`) of `a` that is of the wrong type, described;
 * none when all are (or absent). `adapter`: `a` is an adapter, so `'own-process'` needs its
 * `ownProcess` and `'takeover'` its `takeover` (a descriptor's `declares` has no methods).
 */
function badStatic(a: Partial<Record<string, unknown>>, adapter = false): string | undefined {
  const flag = (['adopts', 'ownerProfileSwitch', 'ephemeralOpen'] as const).find((k) => a[k] !== undefined && typeof a[k] !== 'boolean');
  if (flag) return `${flag} (true or false when present)`;
  const nonEmpty = (v: unknown) => typeof v === 'string' && v.length > 0;
  const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
  if (a.displayName !== undefined && !nonEmpty(a.displayName)) return 'displayName (a non-empty string when present)';
  if (a.compact !== undefined && !(record(a.compact) && nonEmpty(a.compact.command))) return 'compact ({ command } with a non-empty string, when present)';
  if (a.modes !== undefined && !(Array.isArray(a.modes) && a.modes.every((m) => m === 'plan'))) return "modes (an array of 'plan' when present)";
  const env = a.sessionEnv;
  if (env !== undefined && env !== 'open' && env !== 'own-process' && !(record(env) && nonEmpty(env.refused))) return "sessionEnv ('open', 'own-process' or { refused } with a non-empty string, when present)";
  if (adapter && env === 'own-process' && typeof a.ownProcess !== 'function') return "sessionEnv ('own-process' needs ownProcess)";
  if (a.attach !== undefined && a.attach !== 'join' && a.attach !== 'takeover') return "attach ('join' or 'takeover' when present)";
  if (adapter && a.attach === 'takeover' && typeof a.takeover !== 'function') return "attach ('takeover' needs takeover)";
  return undefined;
}
