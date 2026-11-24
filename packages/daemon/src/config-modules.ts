import { dirname, isAbsolute } from 'node:path';
import type { AdminContribution } from '@agents-io/protocol';
import { builtinChannels, builtinModules } from './bundle.js';
import { badChannelModule, type ChannelAdminContribution, type ChannelRegistry } from './channel-registry.js';
import { ConfigError, configPath, readConfigFile, resolveModuleEntry, type LoadOptions, type ModuleFileEntry } from './config.js';
import { ChannelModuleFiles, isModuleChannelType, moduleChannelType } from './module-channel.js';
import { loadChannelFile, loadFeatureModule, resolveModuleFile } from './module-loader.js';
import type { ModuleRegistry, RegisteredModule } from './modules.js';

/*
 * Third parties' modules named in a config file (core-slimming §5 "the same contract"): the bundled
 * `aio serve` imports them when it starts, before it resolves the config, so that what they say
 * about the config is read as a built-in module's is:
 *   - `modules` entries: feature modules (`ModuleManifest`, origin `module`), registered after the
 *     registry's own, in file order; each one's settings are its entry's `config`;
 *   - `type: "module"` channel entries: their files, so a `ChannelModule` descriptor one exports
 *     checks, resolves and builds its entries (`moduleChannelType`), and its admin routes are served.
 * Their code is in-process code the deployment's config names, as trusted as the daemon's own
 * (INVARIANTS ID-3 boundary 2), and gets what a built-in module gets; what it may stamp or grant
 * stays the kernel's to say (ID-3, ID-10). A `use: "module"` harness module is imported at the
 * gateway's start, as before (its descriptor's `declares` and `cli` are read then).
 */

/** The registries a config is resolved with and a gateway runs, with what a config file's modules add. */
export interface ConfigModules {
  /** The given feature modules (default the built-in ones), then those of the file's `modules` entries (origin `module`). */
  moduleRegistry: ModuleRegistry;
  /** The given channel types (default the built-in ones); their `module` type reads the descriptors the file's module channel entries export. */
  channelRegistry: ChannelRegistry;
  /**
   * The same import of another version of the file, over the registries this one was given (not
   * the ones it answered): what the next start would read it with. For the console
   * (`GatewayOptions.importModules`), which validates, shows and applies a document so.
   */
  importModules: ImportConfigModules;
}

/** `importConfigModules` of a parsed config file in `baseDir`, over registries fixed beforehand (`ConfigModules.importModules`). */
export type ImportConfigModules = (raw: unknown, o: { baseDir: string }) => Promise<ConfigModules>;

/**
 * `importConfigModules` of the file `loadConfig` would read (`o.path`, `$AIO_CONFIG`,
 * `./aio.config.json`): give the registries it returns to `loadConfig` and to `Gateway.start`.
 */
export async function loadConfigModules(o: LoadOptions = {}): Promise<ConfigModules> {
  const { path, raw } = readConfigFile(o);
  return importConfigModules(raw, { baseDir: dirname(path), ...(o.moduleRegistry ? { moduleRegistry: o.moduleRegistry } : {}), ...(o.channelRegistry ? { channelRegistry: o.channelRegistry } : {}) });
}

/**
 * Import the module files a parsed config file names that its resolution reads, and answer the
 * registries to resolve it with and run it on (the same to both: `resolveConfig` / `loadConfig`
 * and `Gateway.start`). An entry that does not have the shape the file schema wants is left to
 * the config's resolution, which says what is wrong with it. A `modules` entry whose file is
 * missing, cannot be imported, exports no manifest, or whose manifest its registry refuses (its
 * shape; an id, config section, tool, command or feature another module has) fails with a
 * `ConfigError` naming the entry (`modules[<i>] (module <file>): …`); so does a module channel file
 * that cannot be imported or exports a descriptor of the wrong shape (`channels[<i>] (module <file>): …`).
 * A file naming no module files gives the registries back as they are. `importModules` in the
 * answer imports another version of the file over the same given registries.
 */
export async function importConfigModules(raw: unknown, o: { baseDir: string; moduleRegistry?: ModuleRegistry; channelRegistry?: ChannelRegistry }): Promise<ConfigModules> {
  const base = { moduleRegistry: o.moduleRegistry ?? builtinModules, channelRegistry: o.channelRegistry ?? builtinChannels };
  const importModules: ImportConfigModules = (next, at) => importConfigModules(next, { baseDir: at.baseDir, ...base });
  let { moduleRegistry, channelRegistry } = base;
  const file = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const path = configPath(o.baseDir);
  // A module channel entry's file, as the config's resolution finds it (`moduleChannelType` `resolve`).
  const fileOf = (spec: string): { file: string } | { error: string } => {
    const rel = spec.startsWith('.') || spec.startsWith('~') || isAbsolute(spec);
    return resolveModuleFile(spec, rel ? path(spec) : undefined, path('.'));
  };

  const entries = Array.isArray(file.modules) ? file.modules : [];
  for (const [index, e] of entries.entries()) {
    if (!isEntry(e)) continue;
    const ref = resolveModuleEntry(e, index, path);
    const where = `modules[${index}] (module ${ref.module})`;
    const manifest = await loadFeatureModule({ file: ref.module, ...(ref.export !== undefined ? { export: ref.export } : {}), where }).catch((err: Error) => {
      throw new ConfigError(err.message);
    });
    const r: RegisteredModule = { manifest, origin: 'module', entry: ref };
    try {
      moduleRegistry = moduleRegistry.with([r]);
    } catch (err) {
      throw new ConfigError(`${where}: ${(err as Error).message}`);
    }
  }

  const moduleType = channelRegistry.get('module');
  const channels = Array.isArray(file.channels) ? file.channels : [];
  if (isModuleChannelType(moduleType)) {
    const files = new ChannelModuleFiles((spec) => {
      const r = fileOf(spec);
      return 'file' in r ? r.file : undefined;
    });
    const admins: ChannelAdminContribution[] = [];
    // Each descriptor's contribution once, whichever entries (and spellings of its file) name it.
    const seen = new Set<AdminContribution>();
    for (const [index, e] of channels.entries()) {
      if (!isModuleChannel(e)) continue;
      const spec = e.module;
      const r = fileOf(spec);
      // A missing file is the config's resolution's to report (`channels[<i>].module: …`).
      if ('error' in r) continue;
      const where = `channels[${index}] (module ${r.file})`;
      const loaded = await loadChannelFile({ file: r.file, ...(e.export !== undefined ? { export: e.export } : {}), where }).catch((err: Error) => {
        throw new ConfigError(err.message);
      });
      if (!('descriptor' in loaded)) continue;
      const d = loaded.descriptor;
      const bad = badChannelModule(d as unknown as Partial<Record<string, unknown>>);
      if (bad) throw new ConfigError(`${where}: the export is not a ChannelModule descriptor (bad ${bad})`);
      if (d.admin?.console !== undefined)
        throw new ConfigError(`${where}: bad admin.console (a module file's descriptor adds no console settings: the config's console section is checked before its module files are imported)`);
      files.addDescriptor(spec, r.file, e.export, d);
      if (d.admin && !seen.has(d.admin)) {
        const admin: AdminContribution = d.admin;
        seen.add(admin);
        try {
          channelRegistry.with({ admins: [...admins, { type: 'module', admin }] });
        } catch (err) {
          throw new ConfigError(`${where}: ${(err as Error).message}`);
        }
        admins.push({ type: 'module', admin });
      }
    }
    if (files.size) channelRegistry = channelRegistry.with({ replace: moduleChannelType(files), admins });
  }
  return { moduleRegistry, channelRegistry, importModules };
}

/** A `modules` entry of the file schema's shape (anything else is the resolution's to report). */
function isEntry(e: unknown): e is ModuleFileEntry {
  if (!e || typeof e !== 'object' || Array.isArray(e)) return false;
  const x = e as Record<string, unknown>;
  return x.use === 'module' && typeof x.module === 'string' && (x.export === undefined || typeof x.export === 'string') && Object.keys(x).every((k) => ['use', 'module', 'export', 'config'].includes(k));
}

/** A `type: "module"` channel entry naming a file (and an export). */
function isModuleChannel(e: unknown): e is { type: 'module'; module: string; export?: string } {
  if (!e || typeof e !== 'object' || Array.isArray(e)) return false;
  const x = e as Record<string, unknown>;
  return x.type === 'module' && typeof x.module === 'string' && (x.export === undefined || typeof x.export === 'string');
}
