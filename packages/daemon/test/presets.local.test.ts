import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Type } from '@sinclair/typebox';
import type { ModuleManifest, NamedRunDefaults, SessionEvent } from '@agents-io/protocol';
import { builtinHarnesses, builtinModules } from '../src/bundle.js';
import { ConfigError, ConfigFile, configFileSchema, resolveConfig } from '../src/config.js';
import { Gateway } from '../src/gateway.js';
import { ModuleRegistry } from '../src/modules.js';
import { ownerCommandsModule } from '../src/owner-commands.js';
import { presetsModule } from '../src/presets.js';
import { daemon, tmp, until } from './helpers.js';

/*
 * The presets are a module's (core-slimming §4): the built-in `presets` module gives them through
 * the run-defaults seam (`ModuleManifest.runDefaults`), which the kernel asks for an agent's
 * `preset`, a task run's `overrides.preset` and a session's preset; someone else's module may give
 * them instead, through the same seam. The replies, errors and what runs are pinned by the CT-2,
 * RN-2 and CF-4 tests; these are the seam's details.
 */

const harnesses = { cc: { use: 'claude-code' }, cx: { use: 'codex' } };
const resolve = (raw: Record<string, unknown>, moduleRegistry?: ModuleRegistry) => resolveConfig({ harnesses, ...raw }, { env: {}, baseDir: '/base', cwd: '/work', ...(moduleRegistry ? { moduleRegistry } : {}) });
const thrown = (f: () => unknown): string => {
  try {
    f();
  } catch (e) {
    expect(e).toBeInstanceOf(ConfigError);
    return (e as Error).message;
  }
  throw new Error('did not throw');
};

/**
 * Someone else's named run defaults: the section `plans: { <name>: <instance> }` (a map of names),
 * each that instance with the model `<name>-model`; `answer` replaces what a name gives.
 */
function plans(o: { answer?: (c: Record<string, string>, name: string) => NamedRunDefaults | undefined; names?: (c: Record<string, string>) => string[] } = {}): ModuleManifest<Record<string, string>> {
  return {
    id: 'acme.plans',
    kind: 'feature',
    config: { section: 'plans', schema: {}, entries: Type.String(), defaultEnabled: true, resolve: (raw) => raw as Record<string, string> },
    runDefaults: {
      names: o.names ?? ((c) => Object.keys(c)),
      resolve: o.answer ?? ((c, name) => (Object.hasOwn(c, name) ? { harness: c[name]!, model: `${name}-model` } : undefined)),
    },
    setup: () => ({}),
  };
}

const alice = { channelUserId: 'alice', evidence: 'platform_signed' as const };
const dm = { conversation: { id: 'c-alice', kind: 'dm' as const } };

describe('the presets module and the run-defaults seam', () => {
  it('the built-in presets module: its section is a map of names (a preset may be called enabled), where it always was in the schema, on whenever registered; Config.presets (deprecated) is its settings, the same object', () => {
    const c = resolve({ presets: { enabled: { harness: 'cx', model: 'm' } }, agents: { a: { preset: 'enabled', effort: 'low' } } });
    const mine = c.modules!.find((m) => m.id === 'presets')!;
    expect(mine).toEqual({ id: 'presets', enabled: true, config: { enabled: { name: 'enabled', harness: 'cx', model: 'm' } } });
    expect(c.presets).toBe(mine.config);
    expect(c.agents.a).toMatchObject({ harness: 'cx', preset: 'enabled', model: 'm', effort: 'low' });
    expect(resolve({}).presets).toEqual({});
    // A file with several mistakes lists them in the order it always did: presets before agents.
    expect(thrown(() => resolve({ agents: { a: { nope: 1 } }, presets: { p: { harness: 1 } } }))).toMatch(/^invalid config: \/presets\/p\/harness: .*; \/agents\/a/);
    const keys = Object.keys(ConfigFile.properties);
    expect(keys.indexOf('presets')).toBe(keys.indexOf('harness') + 1);
    // The module's own checks, with the configured instances it is told (`ModuleResolveContext.harnesses`).
    expect(thrown(() => resolve({ presets: { p: { harness: 'nope' } } }))).toBe('presets.p.harness: unknown harness instance "nope" (configured: cc, cx)');
    // It is the composition root's: a registry may hold it as someone else's, or leave it out.
    expect(resolve({ presets: { p: { harness: 'cc' } } }, new ModuleRegistry([presetsModule])).modules).toEqual([{ id: 'presets', enabled: true, config: { p: { name: 'p', harness: 'cc' } } }]);
    expect(thrown(() => resolve({ agents: { a: { preset: 'p' } } }, new ModuleRegistry([])))).toBe('agents.a.preset: unknown preset "p" (no registered module provides presets)');
  });

  it("someone else's module may provide them instead: an agent's preset, a task run's overrides.preset and /preset ask it; none configured names its section", async () => {
    const registry = new ModuleRegistry([plans(), ownerCommandsModule]);
    const c = resolve({ plans: { fast: 'cx' }, agents: { a: { preset: 'fast' } } }, registry);
    expect(c.agents.a).toMatchObject({ harness: 'cx', preset: 'fast', model: 'fast-model' });
    expect(thrown(() => resolve({ plans: { fast: 'cx' }, agents: { a: { preset: 'slow' } } }, registry))).toBe('agents.a.preset: unknown preset "slow" (configured: fast)');
    expect(thrown(() => resolve({ agents: { a: { preset: 'slow' } } }, registry))).toBe('agents.a.preset: unknown preset "slow" (no `plans` configured)');

    const w = await daemon({
      raw: { harnesses, plans: { fast: 'cx', deep: 'cc' }, agents: { helper: { harness: 'cc' }, exec: { harness: 'cc', mode: 'task' } } },
      moduleRegistry: registry,
    });
    const say = async (text: string) => {
      const before = w.chat.sent.length;
      await w.chat.inject({ ...dm, sender: alice, text });
      const s = await until(() => w.chat.sent[before]);
      return s.edits.at(-1)?.text ?? s.msg.text;
    };
    expect(await say('/preset')).toBe(
      [
        'This session: cc (claude-code) · model haiku',
        '- fast: cx (codex) · model fast-model',
        '- deep: cc (claude-code) · model deep-model',
        '/preset <name> switches this session from the next turn; /preset default goes back to the agent’s own.',
      ].join('\n'),
    );
    expect(await say('/preset fast')).toMatch(/^Preset fast from the next turn: cx \(codex\) · model fast-model\./);
    await w.chat.inject({ ...dm, sender: alice, text: 'hi' });
    const runs = () => w.gw.sessions().flatMap((x) => w.gw.hub.log.read(x.sessionKey, 0).flatMap((e: SessionEvent) => (e.body.t === 'turn.started' ? [e.body.run] : [])));
    await until(() => runs().length === 1);
    expect(runs()[0]).toMatchObject({ harness: 'cx', model: 'fast-model' });
    const h = await w.host();
    expect((await h.runStart({ runId: 'd', agent: 'exec', input: [{ type: 'text', text: 'go' }], overrides: { preset: 'deep' } })).run).toMatchObject({ harness: 'cc', model: 'deep-model' });
    await expect(h.runStart({ runId: 'e', agent: 'exec', input: [{ type: 'text', text: 'go' }], overrides: { preset: 'slow' } })).rejects.toMatchObject({
      code: 'bad_override',
      message: expect.stringMatching(/unknown preset "slow" \(configured: fast, deep\)$/),
    });
    // The CLI's startup line lists what it gives.
    expect(w.gw.namedRuns.names()).toEqual(['fast', 'deep']);
  });

  it('a provider that is off gives none, saying so; an answer naming no configured instance, or a name it lists and does not give, fails the config and the start, naming the module; one module provides them', async () => {
    const off: ModuleManifest<Record<string, string>> = { ...plans(), config: { section: 'plans', schema: { fast: Type.Optional(Type.String()) }, defaultEnabled: false, resolve: (raw) => raw as Record<string, string> } };
    expect(thrown(() => resolve({ agents: { a: { preset: 'fast' } } }, new ModuleRegistry([off])))).toBe('agents.a.preset: unknown preset "fast" (module acme.plans, which provides presets, is off)');
    expect(resolve({ plans: { fast: 'cx' }, agents: { a: { preset: 'fast' } } }, new ModuleRegistry([off])).agents.a).toMatchObject({ harness: 'cx' });

    // Checked while the config resolves, also with no agent naming one.
    const nowhere = new ModuleRegistry([plans({ answer: () => ({ harness: 'nowhere' }) })]);
    expect(thrown(() => resolve({ plans: { fast: 'cx' } }, nowhere))).toBe('module acme.plans: runDefaults.resolve("fast"): harness instance "nowhere" is not configured');
    const ghost = new ModuleRegistry([plans({ names: (c) => [...Object.keys(c), 'ghost'] })]);
    expect(thrown(() => resolve({ plans: { fast: 'cx' } }, ghost))).toBe('module acme.plans: runDefaults.names lists "ghost", which runDefaults.resolve does not give');
    const throws = new ModuleRegistry([plans({ answer: () => { throw new Error('boom'); } })]);
    expect(thrown(() => resolve({ plans: { fast: 'cx' } }, throws))).toBe('module acme.plans: runDefaults.resolve("fast") failed: boom');

    // And when the daemon starts: Config.presets (deprecated) written since the config resolved decides, checked as the config was.
    const dir = tmp();
    const base = resolveConfig({ harnesses, dataDir: dir }, { env: {}, baseDir: dir, cwd: dir });
    const start = (presets: unknown) => Gateway.start({ config: { ...base, socketPath: join(dir, 'run', 'aio.sock'), presets } as never, listen: false, logger: () => {} });
    await expect(start({ p: { name: 'p', harness: 'nope' } })).rejects.toThrow('module presets: runDefaults.resolve("p"): harness instance "nope" is not configured');
    const gw = await start({ p: { name: 'p', harness: 'cx', model: 'x' } });
    expect(gw.namedRuns.names()).toEqual(['p']);
    expect(gw.namedRuns.get('p')).toEqual({ name: 'p', harness: 'cx', model: 'x' });
    await gw.stop();

    // The registry: one module's, the shape, a section of named entries has no keys of its own, where its section goes.
    expect(() => new ModuleRegistry([presetsModule, plans()])).toThrow("module acme.plans: the named run defaults (runDefaults) is also module presets's");
    expect(() => builtinModules.with([{ manifest: plans(), origin: 'module', entry: { module: '/acme/plans.js' } }])).toThrow("module acme.plans: the named run defaults (runDefaults) is also module presets's");
    expect(() => new ModuleRegistry([{ ...plans(), runDefaults: { names: () => [] } as never }])).toThrow('module acme.plans: runDefaults must be { names, resolve }, both functions');
    expect(() => new ModuleRegistry([{ ...plans(), config: { ...plans().config!, schema: { x: Type.String() } } }])).toThrow('module acme.plans: config.entries: a section of named entries has no keys of its own (config.schema must be empty)');
    const after = new ModuleRegistry([plans()], { fields: { 'acme.plans': { sectionAfter: 'agents' } } });
    const keys = Object.keys(configFileSchema(builtinHarnesses, undefined, after).properties);
    expect(keys.indexOf('plans')).toBe(keys.indexOf('agents') + 1);
    expect(() => configFileSchema(builtinHarnesses, undefined, new ModuleRegistry([plans()], { fields: { 'acme.plans': { sectionAfter: 'local' } } }))).toThrow('module acme.plans: sectionAfter "local" is not one of the config file\'s own keys before local');
    expect(() => new ModuleRegistry([{ ...plans(), config: undefined }], { fields: { 'acme.plans': { sectionAfter: 'agents' } } })).toThrow('fields.acme.plans.sectionAfter: the module has no section in the config file');
  });
});
