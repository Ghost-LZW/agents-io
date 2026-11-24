import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { builtinChannels, builtinModules } from '../src/bundle.js';
import { isModuleChannelType, moduleChannelModule } from '@agents-io/kernel';
import { loadConfig, loadConfigModules } from '../src/defaults.js';
import { cli } from './cli-helpers.js';
import { tmp } from './helpers.js';

/*
 * How the bundled aio finds the module files a config names (`loadConfigModules`), what reading a
 * config without them is for (clients), and the commands a `use: "module"` harness descriptor adds
 * to the CLI (`HarnessModule.cli`), found through the config.
 */

const fx = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

/** A config file in a fresh directory; module paths are absolute (the fixtures). */
function configFile(raw: Record<string, unknown>): string {
  const dir = tmp('aio-cml-');
  const path = join(dir, 'aio.config.json');
  writeFileSync(path, JSON.stringify({ dataDir: dir, ...raw }));
  return path;
}

describe('loading the modules a config names', () => {
  it('reads the file loadConfig reads; a file naming none gives the registries back as they are', async () => {
    const path = configFile({ modules: [{ use: 'module', module: join(fx, 'feature-module.mjs'), config: { key: 'l1' } }], channels: [{ type: 'module', module: join(fx, 'chan-descriptor.mjs'), config: { id: 'l1', token: 'x' } }] });
    const r = await loadConfigModules({ path, env: {} });
    expect(r.moduleRegistry.modules.map((m) => m.manifest.id)).toEqual([...builtinModules.modules.map((m) => m.manifest.id), 'acme.greet']);
    expect(r.moduleRegistry.fromEntry({ module: join(fx, 'feature-module.mjs') })).toMatchObject({ origin: 'module' });
    expect(r.channelRegistry.types).toEqual(builtinChannels.types);
    expect(isModuleChannelType(r.channelRegistry.get('module'))).toBe(true);
    expect(r.channelRegistry.get('module')).not.toBe(moduleChannelModule);
    expect(r.channelRegistry.adminContributions.map((c) => c.type)).toEqual([...builtinChannels.adminContributions.map((c) => c.type), 'module']);
    const c = loadConfig({ path, env: {}, ...r });
    expect(c.modules!.at(-1)).toMatchObject({ id: 'acme.greet', enabled: true });
    const none = await loadConfigModules({ path: configFile({ channels: [{ type: 'module', module: join(fx, 'chan-pkg') }] }), env: {} });
    expect([none.moduleRegistry, none.channelRegistry]).toEqual([builtinModules, builtinChannels]);
  });

  it("without them (a client reading the file) the config still loads: an agent may list a tool no loaded module has; an entry removed from the file drops its module from the config", async () => {
    const entry = { use: 'module', module: join(fx, 'feature-module.mjs'), config: { key: 'l2' } };
    const path = configFile({ modules: [entry], agents: { main: { harness: 'claude-code', tools: ['acme_greet', 'no_such_tool'] } } });
    expect(loadConfig({ path, env: {}, channels: false }).agents.main!.toolNames).toEqual(['acme_greet', 'no_such_tool']);
    // Loaded, a name no module has is an error again.
    const r = await loadConfigModules({ path, env: {} });
    expect(() => loadConfig({ path, env: {}, ...r })).toThrow('agents.main.tools: unknown tool "no_such_tool"');
    const without = loadConfig({ path: configFile({}), env: {}, ...r });
    expect(without.modules!.map((m) => m.id)).not.toContain('acme.greet');
    expect(without.moduleEntries).toBeUndefined();
  });
});

describe("a module harness descriptor's CLI commands", () => {
  it('run as aio <name> through the config; the CLI\'s own and the built-in kinds\' come first; an unknown name is still unknown, saying why when the config does not load', async () => {
    const path = configFile({ harnesses: { plug: { use: 'module', module: join(fx, 'harness-descriptor-full.mjs') } } });
    const r = await cli(['--config', path, 'acme-hello', 'one', 'two']);
    expect(r.code).toBe(7);
    expect((globalThis as { __acmeCli?: string[] }).__acmeCli).toEqual(['one', 'two']);
    const unknown = await cli(['--config', path, 'acme-nope']);
    expect(unknown.code).toBe(2);
    expect(unknown.err).toMatch(/^unknown command acme-nope\n/);
    const broken = configFile({ harnesses: 'nope' });
    const why = await cli(['--config', broken, 'acme-hello']);
    expect(why.code).toBe(2);
    expect(why.err).toMatch(/^unknown command acme-hello \(no harness module's either: the config does not load: invalid config: /);
    // Two instances' modules adding it differently: which one runs is not for the CLI to guess.
    const two = configFile({ harnesses: { plug: { use: 'module', module: join(fx, 'harness-descriptor-full.mjs') }, other: { use: 'module', module: join(fx, 'harness-descriptor-full.mjs'), export: 'otherHello' } } });
    const clash = await cli(['--config', two, 'acme-hello']).catch((e: Error) => e);
    expect((clash as Error).message).toBe('harnesses.other: cli "acme-hello": harnesses.plug adds it too');
  });
});
