import { existsSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, parse } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ChannelAdapter, ChannelFactory } from '@agents-io/protocol';

/**
 * Channel plugins (`{ "type": "module" }` entries): an ES module outside this repo
 * exporting a ChannelFactory. Resolution is by hand, not require.resolve, so a
 * package whose exports map only has an `import` condition works too.
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
export function resolveChannelModule(spec: string, abs: string | undefined, baseDir: string): { file: string } | { error: string } {
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

export interface LoadedChannelOptions {
  /** The resolved module file (config resolution made it absolute). */
  file: string;
  /** Export name; default `createChannel`, falling back to `default`. */
  export?: string;
  index: number;
  account: string;
  config: unknown;
  log: (level: 'debug' | 'info' | 'warn' | 'error' | 'fatal', msg: string, data?: unknown) => void;
}

/** Import the module, run its factory, and check the adapter's shape. */
export async function loadChannelModule(o: LoadedChannelOptions): Promise<ChannelAdapter> {
  const where = `channels[${o.index}] (module ${o.file})`;
  const name = o.export ?? 'createChannel';
  const mod = (await import(pathToFileURL(o.file).href).catch((e: Error) => {
    throw new Error(`${where}: cannot import: ${e.message}`);
  })) as Record<string, unknown>;
  const factory = mod[name] ?? mod.default;
  if (typeof factory !== 'function') throw new Error(`${where}: export ${JSON.stringify(name)} (or default) is not a function`);
  let adapter: ChannelAdapter;
  try {
    adapter = await (factory as ChannelFactory)({ account: o.account, config: o.config, log: o.log });
  } catch (e) {
    throw new Error(`${where}: factory failed: ${(e as Error).message}`);
  }
  const a = adapter as unknown as Partial<Record<string, unknown>> | null;
  const bad = !a || typeof a.id !== 'string' || !a.id ? 'id (a non-empty string)' : (['caps', 'start', 'send'] as const).find((k) => typeof a[k] !== 'function');
  if (bad) throw new Error(`${where}: the factory did not return a ChannelAdapter (bad ${bad})`);
  return adapter;
}
