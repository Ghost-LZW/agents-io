import { isAbsolute } from 'node:path';
import { Type } from '@sinclair/typebox';
import type { ChannelModule } from '@agents-io/protocol';
import { ConfigError } from './config-error.js';
import { loadChannelModule, resolveModuleFile } from './module-loader.js';

/*
 * The `module` channel type: an in-process channel plugin, an ES module outside this repo
 * exporting a ChannelFactory (`@agents-io/protocol`). The daemon's own type (it needs the
 * daemon's module loader), registered in its bundle next to the channel packages' types.
 */

/**
 * A `module` entry's own keys. `module` as written is a path (relative to the config file) to a
 * package directory or a .js/.mjs file, or a bare package specifier resolved from the config
 * file's directory; resolved, it is the file to import. `config` is env-substituted and handed to
 * the factory.
 */
export type ModuleChannelEntry = { type: 'module'; module: string; export?: string; config?: unknown };

export const moduleChannelModule: ChannelModule<ModuleChannelEntry> = {
  type: 'module',
  entry: {
    module: Type.String(),
    /** Export holding the factory (default `createChannel`, else `default`). */
    export: Type.Optional(Type.String()),
    config: Type.Optional(Type.Unknown()),
  },

  resolve(entry, ctx) {
    const spec = entry.module;
    const rel = spec.startsWith('.') || spec.startsWith('~') || isAbsolute(spec);
    const r = resolveModuleFile(spec, rel ? ctx.path(spec) : undefined, ctx.path('.'));
    if ('error' in r) return ctx.fail(`${ctx.where}.module: ${r.error}`);
    return { ...entry, module: r.file, ...(entry.config !== undefined ? { config: ctx.substitute(entry.config, `${ctx.where}.config`) } : {}) };
  },

  async create(entry, init) {
    // A plugin that fails to load is a config error (exit 2), like any other bad channel entry.
    const adapter = await loadChannelModule({
      file: entry.module,
      ...(entry.export ? { export: entry.export } : {}),
      index: init.index,
      account: entry.account,
      config: entry.config,
      log: (level, msg, data) => init.log(level, `channel module ${entry.module}: ${msg}`, data),
    }).catch((e: Error) => {
      throw new ConfigError(e.message);
    });
    return { adapter, config: entry.config, ...(adapter.close ? { close: () => adapter.close!() } : {}) };
  },
};
