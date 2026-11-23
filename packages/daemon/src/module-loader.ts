import { existsSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, parse } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Type, type TSchema } from '@sinclair/typebox';
import { errors, type BlobAccess, type ChannelAdapter, type ChannelFactory, type HarnessAdapter, type HarnessFactory, type HarnessFactoryInit, type HarnessModule } from '@agents-io/protocol';
import type { ModuleLaunch } from './config.js';

/*
 * Plugin modules from outside this repo: a `{ "type": "module" }` channel entry's (exporting a
 * ChannelFactory) and a `{ "use": "module" }` harness instance's (a HarnessFactory, or a
 * HarnessModule descriptor). One resolution of the file (at config time) and one import (at
 * start), each kind with its own export rule (`loadExport`). Resolution is by hand, not
 * require.resolve, so a package whose exports map only has an `import` condition works too.
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
}): Promise<HarnessAdapter> {
  const where = `harnesses.${o.name} (module ${o.module.file})`;
  const { value: factory, what } = await loadExport({ file: o.module.file, where, export: o.module.export, defaultName: 'createHarness', namedFallsBack: false });
  const descriptor = harnessDescriptor(factory);
  if (typeof factory !== 'function' && !descriptor) throw new Error(`${where}: ${what} is not a function`);
  const init: HarnessFactoryInit = { name: o.name, config: o.module.config, log: o.log, harness: o.harness, blobs: o.blobs };
  let adapter: HarnessAdapter;
  if (descriptor) {
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
  const bad = badHarnessAdapter(adapter as unknown as Partial<Record<string, unknown>> | null);
  if (bad) throw new Error(`${where}: ${descriptor ? 'create' : 'the factory'} did not return a HarnessAdapter (bad ${bad})`);
  return adapter;
}

/** A module's export as a harness kind descriptor (`HarnessModule`: an object with a `create` function), if it is one. */
function harnessDescriptor(v: unknown): Pick<HarnessModule, 'create'> & { schema?: unknown } | undefined {
  return typeof v === 'object' && v !== null && typeof (v as { create?: unknown }).create === 'function' ? (v as Pick<HarnessModule, 'create'>) : undefined;
}

/**
 * The first member of a module's adapter that is not what `HarnessAdapter` says, described; none when
 * all are. A module is untyped code: what the host reads later (the static declarations, the
 * lifecycle calls, `nativeClient` for a terminal joining a session) is checked once here, so a
 * wrong shape fails the start (CF-4) instead of a command, an attach or a stop.
 */
function badHarnessAdapter(a: Partial<Record<string, unknown>> | null): string | undefined {
  if (!a || typeof a.id !== 'string' || !a.id) return 'id (a non-empty string)';
  const required = (['probe', 'open'] as const).find((k) => typeof a[k] !== 'function');
  if (required) return required;
  const method = (['detach', 'dispose', 'ownProcess', 'nativeClient'] as const).find((k) => a[k] !== undefined && typeof a[k] !== 'function');
  if (method) return `${method} (a function when present)`;
  const flag = (['adopts', 'ownerProfileSwitch', 'ephemeralOpen'] as const).find((k) => a[k] !== undefined && typeof a[k] !== 'boolean');
  if (flag) return `${flag} (true or false when present)`;
  const nonEmpty = (v: unknown) => typeof v === 'string' && v.length > 0;
  const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
  if (a.displayName !== undefined && !nonEmpty(a.displayName)) return 'displayName (a non-empty string when present)';
  if (a.compact !== undefined && !(record(a.compact) && nonEmpty(a.compact.command))) return 'compact ({ command } with a non-empty string, when present)';
  if (a.modes !== undefined && !(Array.isArray(a.modes) && a.modes.every((m) => m === 'plan'))) return "modes (an array of 'plan' when present)";
  const env = a.sessionEnv;
  if (env !== undefined && env !== 'open' && env !== 'own-process' && !(record(env) && nonEmpty(env.refused))) return "sessionEnv ('open', 'own-process' or { refused } with a non-empty string, when present)";
  if (env === 'own-process' && typeof a.ownProcess !== 'function') return "sessionEnv ('own-process' needs ownProcess)";
  return undefined;
}
