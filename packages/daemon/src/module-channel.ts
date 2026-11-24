import { createHash } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { Type, type TObject, type TSchema } from '@sinclair/typebox';
import { errors, type ChannelModule, type ChannelResolveContext } from '@agents-io/protocol';
import { ConfigError } from './config-error.js';
import { badChannelAdapter, loadChannelModule, resolveModuleFile } from './module-loader.js';
import { credentialMark } from './schema-marks.js';

/*
 * The `module` channel type: an in-process channel plugin, an ES module outside this repo
 * exporting a ChannelFactory, or a ChannelModule descriptor (`@agents-io/protocol`). The daemon's
 * own type (it needs the daemon's module loader), registered in its bundle next to the channel
 * packages' types. A descriptor is read only when the daemon imported the config's module files
 * before it resolved the config (`loadConfigModules`, which registers this type bound to what they
 * export: `moduleChannelType(files)`); the type registered in the bundle knows none, and imports a
 * factory when the channel is built, as before descriptors.
 */

/**
 * A `module` entry's own keys. `module` as written is a path (relative to the config file) to a
 * package directory or a .js/.mjs file, or a bare package specifier resolved from the config
 * file's directory; resolved, it is the file to import. `config` is env-substituted and handed to
 * the factory; with a descriptor, its `resolve` makes it what `create` gets.
 */
export type ModuleChannelEntry = { type: 'module'; module: string; export?: string; config?: unknown };

/** A module file and export, as one key (a resolved entry's: its owner, channel-stamping F4). */
const fileKey = (module: string, exp: string | undefined) => JSON.stringify([module, exp ?? null]);

/**
 * The state directory of a channel a descriptor builds: the host's for the `module` type and the
 * account (`<dataDir>/channels/module.<account>`, which every module file's channels on that
 * account would share), divided by the file and export (the first 16 hex digits of the SHA-256 of
 * the owner). The same after a restart while the file stays where it is; one descriptor's entries
 * on one account share it (its `validateAll` can refuse two such).
 */
function descriptorStateDir(typeDir: string, entry: { module: string; export?: string }): string {
  return join(typeDir, createHash('sha256').update(fileKey(entry.module, entry.export)).digest('hex').slice(0, 16));
}

/** What the module files of a config's `type: "module"` entries export (`loadConfigModules`): their descriptors, by the entry's `module` as written and as resolved. */
export class ChannelModuleFiles {
  private readonly written = new Map<string, ChannelModule>();
  private readonly resolved = new Map<string, ChannelModule>();

  /** A descriptor an entry's file exports: `spec` as the entry writes `module`, `file` as it resolved. */
  addDescriptor(spec: string, file: string, exp: string | undefined, d: ChannelModule): void {
    this.written.set(fileKey(spec, exp), d);
    this.resolved.set(fileKey(file, exp), d);
  }

  /** The descriptor of an entry as the document has it (`module` as written). */
  ofWritten(entry: { module?: unknown; export?: unknown }): ChannelModule | undefined {
    return typeof entry.module === 'string' ? this.written.get(fileKey(entry.module, typeof entry.export === 'string' ? entry.export : undefined)) : undefined;
  }

  /** The descriptor of a resolved entry (`module` the file). */
  ofFile(entry: { module: string; export?: string }): ChannelModule | undefined {
    return this.resolved.get(fileKey(entry.module, entry.export));
  }

  /** How many entries (as written) name a descriptor. */
  get size(): number {
    return this.written.size;
  }
}

/** The `module` types this file made (the loader replaces only one of these in a registry). */
const moduleTypes = new WeakSet<ChannelModule>();

/** Whether `m` is the daemon's `module` channel type (the bundle's, or one bound to a config's module files). */
export function isModuleChannelType(m: ChannelModule | undefined): boolean {
  return m !== undefined && moduleTypes.has(m);
}

const entrySchemas = new WeakMap<ChannelModule, TObject>();

/** A descriptor's `entry` as the closed object a `module` entry's `config` is checked against. */
function configSchema(d: ChannelModule): TObject {
  let s = entrySchemas.get(d);
  if (!s) entrySchemas.set(d, (s = Type.Object(d.entry as Record<string, TSchema>, { additionalProperties: false })));
  return s;
}

const asObject = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/**
 * The `module` channel type, reading the descriptors in `files` (none: the bundle's, which builds
 * from a factory only). For an entry whose file exports a descriptor: its `entry` checks the
 * entry's `config` (closed; absent is `{}`), its `resolve` resolves that `config` (`ctx.where` is
 * `channels[<i>].config`), its `validateAll` gets the entries naming the same file and export, its
 * `isCredential`, `credentialHint` and `implicitEnv` answer under `config`, and its `create` gets the
 * resolved `config` with the entry's `account`, and a `stateDir` of its file and export's
 * (`descriptorStateDir`). The entry's own keys (`type`, `account`, `evidence`, …) stay the host's
 * whatever it returns (`config.ts` `resolveChannels`).
 */
export function moduleChannelType(files?: ChannelModuleFiles): ChannelModule<ModuleChannelEntry> {
  const m: ChannelModule<ModuleChannelEntry> = {
    type: 'module',
    entry: {
      module: Type.String(),
      /** Export holding the factory or descriptor (default `createChannel`, else `default`). */
      export: Type.Optional(Type.String()),
      config: Type.Optional(Type.Unknown()),
    },

    // One module file and export is one adapter (channel-stamping F4).
    owner: (entry) => fileKey(entry.module, entry.export),

    isCredential(path, entry) {
      const d = files?.ofWritten(entry);
      if (!d || path[0] !== 'config' || path.length < 2) return false;
      const [key, ...below] = path.slice(1);
      const own = Object.hasOwn(d.entry, key!) ? d.entry[key!] : undefined;
      return credentialMark(own, below) || d.isCredential?.(path.slice(1), asObject(entry.config)) === true;
    },

    credentialHint(path, entry) {
      const d = files?.ofWritten(entry);
      return d && path[0] === 'config' ? d.credentialHint?.(path.slice(1), asObject(entry.config)) : undefined;
    },

    implicitEnv(entry) {
      const names = files?.ofWritten(entry)?.implicitEnv?.(asObject(entry.config));
      return Array.isArray(names) ? names.filter((n): n is string => typeof n === 'string') : [];
    },

    resolve(entry, ctx) {
      const spec = entry.module;
      const rel = spec.startsWith('.') || spec.startsWith('~') || isAbsolute(spec);
      const r = resolveModuleFile(spec, rel ? ctx.path(spec) : undefined, ctx.path('.'));
      if ('error' in r) return ctx.fail(`${ctx.where}.module: ${r.error}`);
      const d = files?.ofFile({ module: r.file, ...(entry.export !== undefined ? { export: entry.export } : {}) });
      if (!d) return { ...entry, module: r.file, ...(entry.config !== undefined ? { config: ctx.substitute(entry.config, `${ctx.where}.config`) } : {}) };
      const where = `${ctx.where}.config`;
      const config = entry.config ?? {};
      const errs = errors(configSchema(d), config);
      if (errs.length) return ctx.fail(`invalid config: ${errs.slice(0, 5).map((e) => `${where}${e}`).join('; ')}`);
      const dctx: ChannelResolveContext = { ...ctx, where };
      return { ...entry, module: r.file, config: d.resolve(config as Record<string, unknown>, dctx) };
    },

    validateAll(entries, ctx) {
      if (!files) return;
      // Each descriptor's rules, over the entries naming its file and export (in config order).
      const groups = new Map<ChannelModule, { index: number; entry: Record<string, unknown>; resolved: Record<string, unknown> & { account: string } }[]>();
      for (const e of entries) {
        const d = files.ofFile(e.resolved);
        if (!d?.validateAll) continue;
        if (!groups.has(d)) groups.set(d, []);
        groups.get(d)!.push({ index: e.index, entry: asObject(e.entry.config), resolved: { ...asObject(e.resolved.config), account: e.resolved.account } });
      }
      for (const [d, group] of groups) d.validateAll!(group, ctx);
    },

    async create(entry, init) {
      const log = (level: 'debug' | 'info' | 'warn' | 'error' | 'fatal', msg: string, data?: unknown) => init.log(level, `channel module ${entry.module}: ${msg}`, data);
      const d = files?.ofFile(entry);
      if (d) {
        const where = `channels[${init.index}] (module ${entry.module})`;
        const built = await Promise.resolve()
          // The host's stateDir is the `module` type's on this account (every module file's): its own is below it.
          .then(() => d.create({ ...asObject(entry.config), account: entry.account }, { ...init, log, stateDir: descriptorStateDir(init.stateDir, entry) }))
          .catch((e: Error) => {
            throw new ConfigError(`${where}: create failed: ${e.message}`);
          });
        const bad = badChannelAdapter(built?.adapter);
        if (bad) throw new ConfigError(`${where}: create did not return a built channel with a ChannelAdapter (bad adapter.${bad})`);
        return built;
      }
      // A plugin that fails to load is a config error (exit 2), like any other bad channel entry.
      const adapter = await loadChannelModule({
        file: entry.module,
        ...(entry.export ? { export: entry.export } : {}),
        index: init.index,
        account: entry.account,
        config: entry.config,
        log,
      }).catch((e: Error) => {
        throw new ConfigError(e.message);
      });
      return { adapter, config: entry.config, ...(adapter.close ? { close: () => adapter.close!() } : {}) };
    },
  };
  moduleTypes.add(m);
  return m;
}

/** The bundle's `module` type: a factory, imported when the channel is built (no module files read before the config). */
export const moduleChannelModule: ChannelModule<ModuleChannelEntry> = moduleChannelType();
