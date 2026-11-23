import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Type } from '@sinclair/typebox';
import type { HarnessAdapter, InputRecord, KernelContext, ModuleInstance, ModuleManifest, ModuleResolveContext, ModuleToolCall } from '@agents-io/protocol';
import { MemorySessionLog, TOPIC_KEY } from '@agents-io/session';
import { FakeChannel, FakeHarness, type FakeTurnScript } from '@agents-io/testkit';
import { TOOL_NAMES } from '@agents-io/host-mcp';
import { builtinHarnesses, builtinModules } from '../src/bundle.js';
import { LocalClient } from '../src/client.js';
import { ConfigError, ConfigFile, configFileSchema, resolveConfig, type Config } from '../src/config.js';
import { ConfigStore } from '../src/console-config.js';
import { Gateway } from '../src/gateway.js';
import { FEATURES } from '../src/host.js';
import { ModuleRegistry } from '../src/modules.js';
import { readTokenFile, tokenPath } from '../src/token.js';
import { cleanups, until } from './helpers.js';
import { mcpCall } from './output-tools-helpers.js';

/* Feature modules (core-slimming G6): the registry, the config sections, and the lifecycle in the daemon. */

interface Probe {
  greeting: string;
}

/**
 * A module named `id` with a config section, a feature, a tool, a command and a lifecycle; what it
 * sees goes to `seen`. `instance` adds to (or replaces) what its setup returns.
 */
function probe(
  id: string,
  seen: string[],
  o: {
    defaultEnabled?: boolean;
    aliases?: string[];
    aliasEnabled?: (value: unknown, alias: string) => boolean;
    needs?: string[];
    instance?: (k: KernelContext, cfg: Probe) => Partial<ModuleInstance>;
    resolved?: { raw: unknown; ctx: ModuleResolveContext }[];
  } = {},
): ModuleManifest<Probe> {
  return {
    id,
    kind: 'feature',
    ...(o.needs ? { needs: o.needs } : {}),
    config: {
      section: id,
      schema: { greeting: Type.Optional(Type.String()) },
      ...(o.aliases ? { aliases: o.aliases } : {}),
      ...(o.aliasEnabled ? { aliasEnabled: o.aliasEnabled } : {}),
      defaultEnabled: o.defaultEnabled ?? true,
      resolve: (raw, ctx) => {
        o.resolved?.push({ raw, ctx });
        const g = (raw as { greeting?: unknown } | undefined)?.greeting;
        if (g === 'bad') ctx.fail(`${ctx.where}.greeting: not that one`);
        return { greeting: typeof g === 'string' ? g : 'hello' };
      },
    },
    features: [`${id}.v1`],
    mcpTools: [{ name: `${id}_echo`, description: `Echo the text back with ${id}'s greeting.`, input: Type.Object({ text: Type.String() }) }],
    commands: [{ name: id, help: `/${id} — say ${id}'s greeting` }],
    setup: (k, cfg) => {
      seen.push(`setup ${id}`);
      // Late-bound: only id and log work during setup.
      expect(k.id).toBe(id);
      expect(() => k.events('x')).toThrow(`module ${id}: the kernel is not ready during setup (only id and log are)`);
      return {
        tools: { [`${id}_echo`]: async (c: ModuleToolCall) => ({ said: `${cfg.greeting}, ${String(c.args.text)}`, sessionKey: c.sessionKey, turnId: c.turn?.turnId, operationId: c.operationId }) },
        commands: { [id]: async (c) => (seen.push(`/${id} ${c.args}`), { ok: true, reply: `${cfg.greeting} from ${id}` }) },
        status: () => ({ greeting: cfg.greeting }),
        start: async () => void seen.push(`start ${id}`),
        stop: async () => void seen.push(`stop ${id}`),
        ...o.instance?.(k, cfg),
      };
    },
  };
}

const resolve = (raw: Record<string, unknown>, moduleRegistry?: ModuleRegistry) => resolveConfig(raw, { env: {}, baseDir: '/base', cwd: '/work', ...(moduleRegistry ? { moduleRegistry } : {}) });

const thrown = (f: () => unknown): string => {
  try {
    f();
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error('did not throw');
};

describe('the module registry', () => {
  it('the built-in ones are the topic titles, on by default, and the external MCP endpoint, off by default: their sections are in ConfigFile where externalMcp always was; an empty registry has no modules', () => {
    expect(builtinModules.modules.map((m) => [m.manifest.id, m.origin])).toEqual([['topic-title', 'builtin'], ['external-mcp', 'builtin']]);
    expect(configFileSchema(builtinHarnesses)).toBe(ConfigFile);
    expect(Object.keys(ConfigFile.properties).slice(-4)).toEqual(['host', 'topicTitles', 'externalMcp', 'local']);
    expect(resolve({}).modules).toEqual([{ id: 'topic-title', enabled: true, config: {} }, { id: 'external-mcp', enabled: false }]);
    expect(resolve({}).externalMcp).toBeUndefined();
    // On: its settings are the module's, and (deprecated) Config.externalMcp is the same object.
    const on = resolve({ externalMcp: { clients: {} } });
    expect(on.modules).toEqual([
      { id: 'topic-title', enabled: true, config: {} },
      { id: 'external-mcp', enabled: true, config: { host: '127.0.0.1', port: 7465, clients: [], limits: { maxBodyBytes: 262144, maxTextChars: 16000, requestsPerMinute: 120, writesPerMinute: 20 } } },
    ]);
    expect(on.externalMcp).toBe(on.modules![1]!.config);
    // Without the module, the section is an unknown key (as any other); an empty registry gives no modules.
    const none = new ModuleRegistry([]);
    expect(resolve({}, none).modules).toBeUndefined();
    expect(() => resolve({ externalMcp: { clients: {} } }, none)).toThrow('invalid config: /externalMcp: Unexpected property');
    expect(Object.keys(configFileSchema(builtinHarnesses, undefined, none).properties)).not.toContain('externalMcp');
  });

  it('checks each manifest and what they claim together; a bare manifest is someone else\'s (origin module)', () => {
    const seen: string[] = [];
    const p = probe('probe', seen);
    expect(new ModuleRegistry([p]).get('probe')).toEqual({ manifest: p, origin: 'module' });
    expect(new ModuleRegistry([p], { origin: 'builtin' }).get('probe')!.origin).toBe('builtin');
    expect(new ModuleRegistry([{ manifest: p, origin: 'builtin' }]).modules.map((m) => m.origin)).toEqual(['builtin']);
    const bad = (m: Partial<ModuleManifest<Probe>>, ...others: ModuleManifest<any>[]) => () => new ModuleRegistry([...others, { ...p, ...m } as ModuleManifest<Probe>]);
    expect(() => new ModuleRegistry([p, p])).toThrow('module "probe" is registered twice');
    expect(bad({ id: 'Probe' })).toThrow('module id "Probe" is not one');
    expect(bad({ kind: 'channel' as never })).toThrow('module probe: kind must be "feature" (got "channel")');
    expect(bad({ mcpTools: [{ name: 'send_message', description: 'x', input: Type.Object({}) }] })).toThrow('module probe: mcpTools: send_message is a kernel tool');
    expect(bad({ mcpTools: [{ name: 'probe_x', description: 'x', input: Type.String() }] })).toThrow('module probe: mcpTools: tool "probe_x": input must be a JSON Schema object (type "object")');
    expect(bad({ commands: [{ name: 'help', help: '/help' }] })).toThrow('module probe: commands: /help is a kernel command');
    expect(bad({ features: ['session.launch'] })).toThrow('module probe: feature "session.launch" is the kernel\'s');
    expect(bad({ needs: ['module:nope'] })).toThrow('module probe: needs module nope, which is not registered');
    expect(bad({ needs: ['kernel:nope'] })).toThrow('module probe: needs: "kernel:nope" is neither module:<id> nor kernel:<capability>');
    expect(bad({ admin: {} })).toThrow('module probe: admin (an AdminContribution) is not served for feature modules yet');
    expect(bad({ config: { ...p.config!, schema: { enabled: Type.Boolean() } } })).toThrow('module probe: config.schema: every section has "enabled"; its module cannot declare it');
    expect(bad({ config: { ...p.config!, aliases: ['outputTools'], aliasEnabled: true as never } })).toThrow('module probe: config.aliasEnabled must be a function');
    expect(bad({ config: { ...p.config!, aliasEnabled: () => true } })).toThrow('module probe: config.aliasEnabled is for a module with aliases');
    // Claims across modules: a tool, a command, a feature, a config key are one module's.
    const other = probe('other', seen);
    expect(bad({ mcpTools: other.mcpTools! }, other)).toThrow("module probe: tool other_echo is also module other's");
    expect(bad({ commands: other.commands! }, other)).toThrow("module probe: command /other is also module other's");
    expect(bad({ features: other.features! }, other)).toThrow("module probe: feature other.v1 is also module other's");
    expect(bad({ config: { ...p.config!, section: 'other' } }, other)).toThrow("module probe: config key other is also module other's");
    expect(bad({ config: { ...p.config!, aliases: ['other'] } }, other)).toThrow("module probe: config key other is also module other's");
    // A section is never one of the file's own keys (checked where the file schema is assembled).
    expect(() => configFileSchema(builtinHarnesses, undefined, new ModuleRegistry([{ ...p, config: { ...p.config!, section: 'policy' } }]))).toThrow('module probe: config section "policy" is one of the config file\'s own keys');
    // Fields that keep a module's settings and status where they were: a registered module's, each one module's, and none of the config's own.
    expect(() => new ModuleRegistry([p], { fields: { nope: { config: 'x' } } })).toThrow('fields: module nope is not registered');
    expect(() => new ModuleRegistry([p], { fields: { probe: { status: 'a.b' } } })).toThrow('fields.probe.status: "a.b" is not a field name');
    for (const taken of ['version', 'modules', 'probeStatus']) expect(() => new ModuleRegistry([p], { fields: { probe: { status: taken } } })).toThrow(`fields.probe.status: ${taken} is not an optional field of the status (AdminStatus) other than modules`);
    expect(() => new ModuleRegistry([p, other], { fields: { probe: { config: 'x' }, other: { config: 'x' } } })).toThrow("module other: config field x is also module probe's");
    const own = new ModuleRegistry([p], { fields: { probe: { config: 'dataDir' } } });
    expect(thrown(() => resolve({}, own))).toBe('module probe: Config.dataDir is one of the config\'s own fields');
    expect(thrown(() => resolve({}, new ModuleRegistry([p], { fields: { probe: { config: 'modules' } } })))).toBe('module probe: Config.modules is one of the config\'s own fields');
    const kept = new ModuleRegistry([p], { fields: { probe: { config: 'probeSettings' } } });
    expect((resolve({ probe: { greeting: 'hi' } }, kept) as unknown as Record<string, unknown>).probeSettings).toEqual({ greeting: 'hi' });
  });
});

describe('module config sections (lifecycle step 1)', () => {
  it('a section is checked against the module\'s schema (closed) and is on unless enabled: false; absent, its default or the first alias set', () => {
    const resolved: { raw: unknown; ctx: ModuleResolveContext }[] = [];
    const on = new ModuleRegistry([probe('probe', [], { resolved })]);
    expect(resolve({}, on).modules).toEqual([{ id: 'probe', enabled: true, config: { greeting: 'hello' } }]);
    expect(resolved.at(-1)).toMatchObject({ raw: {}, ctx: { where: 'probe' } });
    expect(resolve({ probe: { greeting: 'hi' } }, on).modules).toEqual([{ id: 'probe', enabled: true, config: { greeting: 'hi' } }]);
    expect(resolved.at(-1)!.raw).toEqual({ greeting: 'hi' });
    expect(resolve({ probe: { enabled: false, greeting: 'hi' } }, on).modules).toEqual([{ id: 'probe', enabled: false }]);
    expect(() => resolve({ probe: { nope: 1 } }, on)).toThrow(ConfigError);
    expect(() => resolve({ probe: { greeting: 'bad' } }, on)).toThrow('probe.greeting: not that one');
    // Without the module registered, its section is an unknown key (as any other).
    expect(() => resolve({ probe: {} })).toThrow(/invalid config/);

    const off = new ModuleRegistry([probe('probe', [], { defaultEnabled: false, aliases: ['outputTools'], resolved })]);
    expect(resolve({}, off).modules).toEqual([{ id: 'probe', enabled: false }]);
    expect(resolve({ probe: {} }, off).modules).toEqual([{ id: 'probe', enabled: true, config: { greeting: 'hello' } }]);
    // An alias set (the section absent) turns it on with the alias's value.
    expect(resolve({ outputTools: true }, off).modules).toEqual([{ id: 'probe', enabled: true, config: { greeting: 'hello' } }]);
    expect(resolved.at(-1)).toMatchObject({ raw: true, ctx: { where: 'outputTools', alias: 'outputTools' } });
  });

  it('an alias set to an off value leaves the module off: an object with enabled: false (as a section), or what aliasEnabled says (policy.strangers: "drop")', () => {
    const resolved: { raw: unknown; ctx: ModuleResolveContext }[] = [];
    // Default on, so off can only come from the alias's value. (`console` stands for an older object
    // section with its own `enabled`, as `externalMcp` was before it was the external MCP module's.)
    const r = new ModuleRegistry([
      probe('panel', [], { aliases: ['console'], resolved }),
      probe('guests', [], { aliases: ['policy.strangers'], aliasEnabled: (v) => v !== 'drop', resolved }),
    ]);
    const modules = (raw: Record<string, unknown>) => resolve(raw, r).modules;
    const off = resolve({ console: { enabled: false, port: 0 }, policy: { strangers: 'drop' } }, r);
    expect(off.modules).toEqual([{ id: 'panel', enabled: false }, { id: 'guests', enabled: false }]);
    expect(resolved).toEqual([]);
    // Any other value is on, handed to resolve as it is there.
    expect(modules({ console: { port: 0 }, policy: { strangers: 'ask' } })).toEqual([
      { id: 'panel', enabled: true, config: { greeting: 'hello' } },
      { id: 'guests', enabled: true, config: { greeting: 'hello' } },
    ]);
    expect(resolved).toMatchObject([
      { raw: { port: 0 }, ctx: { where: 'console', alias: 'console' } },
      { raw: 'ask', ctx: { where: 'policy.strangers', alias: 'policy.strangers' } },
    ]);
    expect(modules({ console: { enabled: true, port: 0 } })![0]).toEqual({ id: 'panel', enabled: true, config: { greeting: 'hello' } });
    expect(resolved.at(-2)!.raw).toEqual({ enabled: true, port: 0 });
    // aliasEnabled decides alone: an object with enabled: false is what it says.
    const own = new ModuleRegistry([probe('panel', [], { aliases: ['console'], aliasEnabled: () => true })]);
    expect(resolve({ console: { enabled: false, port: 0 } }, own).modules).toEqual([{ id: 'panel', enabled: true, config: { greeting: 'hello' } }]);
    // The section, when present, decides over an alias.
    expect(modules({ panel: {}, console: { enabled: false, port: 0 }, guests: { greeting: 'hi' }, policy: { strangers: 'drop' } })).toEqual([
      { id: 'panel', enabled: true, config: { greeting: 'hello' } },
      { id: 'guests', enabled: true, config: { greeting: 'hi' } },
    ]);
    // aliasEnabled answers a boolean; anything else fails the config.
    const sloppy = new ModuleRegistry([probe('guests', [], { aliases: ['policy.strangers'], aliasEnabled: () => 'yes' as never })]);
    expect(thrown(() => resolve({ policy: { strangers: 'ask' } }, sloppy))).toBe('module guests: config.aliasEnabled must return a boolean (got string for policy.strangers)');
  });

  it('a module that is on and needs one that is off fails the config', () => {
    const r = new ModuleRegistry([probe('probe', []), probe('probe2', [], { needs: ['module:probe'] })]);
    expect(resolve({}, r).modules!.map((m) => m.enabled)).toEqual([true, true]);
    expect(() => resolve({ probe: { enabled: false } }, r)).toThrow('module probe2 needs module probe, which is off');
    expect(resolve({ probe: { enabled: false }, probe2: { enabled: false } }, r).modules!.map((m) => m.enabled)).toEqual([false, false]);
  });

  it('agents.<name>.tools: an active module\'s tools are in the catalog; one of a module that is off is an error saying so', () => {
    const r = new ModuleRegistry([probe('probe', []), probe('probe2', [])]);
    const tools = (list: string[], raw: Record<string, unknown> = {}) => resolve({ ...raw, agents: { chat: { harness: 'claude-code', tools: list } }, defaultAgent: 'chat' }, r);
    expect(tools(['probe_echo', 'send_message']).agents.chat).toMatchObject({ tools: true, toolNames: ['probe_echo', 'send_message'] });
    expect(thrown(() => tools(['nope']))).toBe(`agents.chat.tools: unknown tool "nope" (tools: ${[...TOOL_NAMES, 'probe_echo', 'probe2_echo'].join(', ')})`);
    expect(thrown(() => tools(['probe2_echo'], { probe2: { enabled: false } }))).toBe('agents.chat.tools: "probe2_echo" is a tool of module probe2, which is off');
  });

  it('a change to a module section takes effect at the next start: the console answers applied: restart', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aio-mod-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, 'aio.config.json');
    writeFileSync(path, '{}');
    const store = new ConfigStore({ path, env: {}, moduleRegistry: new ModuleRegistry([probe('probe', [])]) });
    expect(store.put({ probe: { greeting: 'hi' } })).toMatchObject({ status: 200, body: { applied: 'restart' } });
    expect(store.put({ probe: { nope: 1 } })).toMatchObject({ status: 422, body: { valid: false, issues: [expect.objectContaining({ code: 'schema', path: '/probe/nope' })] } });
    // Without the module, the section is an unknown key.
    expect(new ConfigStore({ path, env: {} }).put({ probe: {} })).toMatchObject({ status: 422 });
  });
});

/** A gateway over `registry` with a fake chat (owner fake:alice) and harness; every agent has the tools. */
async function daemon(
  registry: ModuleRegistry,
  raw: Record<string, unknown> = {},
  script?: FakeTurnScript,
  dir = mkdtempSync(join(tmpdir(), 'aio-mod-')),
  logger: (level: string, msg: string) => void = () => {},
  edit: (c: Config) => Config = (c) => c,
  declares: Partial<HarnessAdapter> = {},
) {
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const base = resolveConfig({ policy: { owners: ['fake:alice'] }, local: { principal: 'me' }, outputTools: true, ...raw }, { env: {}, baseDir: dir, cwd: dir, moduleRegistry: registry });
  const config = edit({ ...base, socketPath: join(dir, 'run', 'aio.sock') });
  const chat = new FakeChannel('fake');
  const harness = Object.assign(new FakeHarness(script), declares);
  const gw = await Gateway.start({ config, harness, log: new MemorySessionLog(), channels: [{ adapter: chat }], moduleRegistry: registry, logger });
  cleanups.push(() => gw.stop());
  return { gw, chat, harness, socketPath: config.socketPath };
}

/** The tool names a harness binding is offered, in the endpoint's order. */
async function listed(mcp: { url: string; token: string } | undefined): Promise<string[]> {
  const res = await fetch(mcp!.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${mcp!.token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });
  return ((await res.json()) as { result: { tools: { name: string }[] } }).result.tools.map((t) => t.name);
}

const alice = { channelUserId: 'alice', evidence: 'platform_signed' as const };
const replies = (chat: FakeChannel) => chat.sent.map((s) => s.edits.at(-1)?.text ?? s.msg.text);

/** What `host.hello` lists on a daemon over `socketPath`. */
async function features(socketPath: string): Promise<string[]> {
  const c = await LocalClient.connect(socketPath);
  cleanups.push(() => c.close());
  return (await c.hello({ token: readTokenFile(tokenPath(socketPath)), name: 'probe' })).features;
}

/** The kernel's features as `host.hello` listed them before the registry, without `resolve.onBehalfOf` (off) and `external.mcp` (the endpoint off). */
const KERNEL_HELLO = [
  'session.launch', 'callouts.resolve', 'callouts.review', 'resolve.native', 'resolver.human.extras', 'callouts.outbound', 'callouts.contact',
  'inbound.redispatch', 'host.takeover', 'explain.chain', 'run.overrides', 'run.ended.usage', 'run.correlation', 'callouts.external', 'session.compact',
];

describe('modules in the daemon (lifecycle steps 2-4)', () => {
  it('the kernel\'s features, in order, as before the registry (external.mcp is the external MCP module\'s); hello lists them (filtered as before) with no module, and with the external MCP endpoint off', async () => {
    expect(FEATURES).toEqual([
      'session.launch', 'callouts.resolve', 'callouts.review', 'resolve.native', 'resolver.human.extras', 'callouts.outbound', 'callouts.contact', 'resolve.onBehalfOf',
      'inbound.redispatch', 'host.takeover', 'explain.chain', 'run.overrides', 'run.ended.usage', 'run.correlation', 'callouts.external', 'session.compact',
    ]);
    const w = await daemon(new ModuleRegistry([]));
    expect(await features(w.socketPath)).toEqual(KERNEL_HELLO);
    expect(w.gw.adminStatus().modules).toEqual([]);
    const b = await daemon(builtinModules);
    expect(await features(b.socketPath)).toEqual(KERNEL_HELLO);
    expect(b.gw.adminStatus().modules).toEqual([{ id: 'topic-title', origin: 'builtin', enabled: true }, { id: 'external-mcp', origin: 'builtin', enabled: false }]);
    expect(b.gw.adminStatus()).not.toHaveProperty('externalMcp');
  });

  it('the external MCP endpoint on: external.mcp after the kernel\'s features, its status block where it always was and in modules; a port that is taken is logged, not fatal: no feature, no status', async () => {
    const w = await daemon(builtinModules, { externalMcp: { listen: '127.0.0.1:0', clients: {} } });
    expect(await features(w.socketPath)).toEqual([...KERNEL_HELLO, 'external.mcp']);
    const st = w.gw.adminStatus();
    expect(st.externalMcp).toEqual({ url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\//), clients: [] });
    expect(Object.keys(st).slice(-2)).toEqual(['externalMcp', 'modules']);
    expect(st.modules).toEqual([{ id: 'topic-title', origin: 'builtin', enabled: true }, { id: 'external-mcp', origin: 'builtin', enabled: true, status: st.externalMcp }]);
    // Stopping closes it first: nothing listens there afterwards.
    await w.gw.stop();
    await expect(fetch(st.externalMcp!.url, { method: 'POST' })).rejects.toThrow();

    const taken = createServer();
    await new Promise<void>((done) => taken.listen(0, '127.0.0.1', done));
    cleanups.push(() => new Promise<void>((done) => taken.close(() => done())));
    const port = (taken.address() as { port: number }).port;
    const logs: string[] = [];
    const busy = await daemon(builtinModules, { externalMcp: { listen: `127.0.0.1:${port}`, clients: {} } }, undefined, undefined, (level, msg) => logs.push(`${level}: ${msg}`));
    expect(await features(busy.socketPath)).toEqual(KERNEL_HELLO);
    expect(busy.gw.adminStatus()).not.toHaveProperty('externalMcp');
    expect(busy.gw.adminStatus().modules).toEqual([{ id: 'topic-title', origin: 'builtin', enabled: true }, { id: 'external-mcp', origin: 'builtin', enabled: true }]);
    expect(logs).toContainEqual(expect.stringMatching(new RegExp(`^error: module external-mcp: external MCP endpoint not started: cannot listen on 127\\.0\\.0\\.1:${port}: `)));
  });

  it('Config.externalMcp (deprecated) given another value or removed before the start still decides, as before the module', async () => {
    const settings = resolveConfig({ externalMcp: { listen: '127.0.0.1:0', clients: {} } }, { env: {}, baseDir: '/base', cwd: '/work' }).externalMcp!;
    const on = await daemon(builtinModules, {}, undefined, undefined, undefined, (c) => ({ ...c, externalMcp: settings }));
    expect(await features(on.socketPath)).toEqual([...KERNEL_HELLO, 'external.mcp']);
    expect(on.gw.adminStatus().modules).toEqual([{ id: 'topic-title', origin: 'builtin', enabled: true }, { id: 'external-mcp', origin: 'builtin', enabled: true, status: { url: expect.any(String), clients: [] } }]);
    const off = await daemon(builtinModules, { externalMcp: { listen: '127.0.0.1:0', clients: {} } }, undefined, undefined, undefined, ({ externalMcp: _, ...c }) => c);
    expect(await features(off.socketPath)).toEqual(KERNEL_HELLO);
    expect(off.gw.adminStatus().modules).toEqual([{ id: 'topic-title', origin: 'builtin', enabled: true }, { id: 'external-mcp', origin: 'builtin', enabled: false }]);
    // A config without modules at all (built by hand, as before modules): the field still decides; a built-in module
    // without one is as a file without its section makes it (the topic titles, on as before); any other module is still an error.
    const dir = mkdtempSync(join(tmpdir(), 'aio-mod-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const bare = { ...resolveConfig({}, { env: {}, baseDir: dir, cwd: dir, moduleRegistry: new ModuleRegistry([]) }), socketPath: join(dir, 'run', 'aio.sock'), externalMcp: settings };
    expect(bare.modules).toBeUndefined();
    const gw = await Gateway.start({ config: bare, harness: new FakeHarness(), log: new MemorySessionLog(), logger: () => {} });
    cleanups.push(() => gw.stop());
    expect(await features(bare.socketPath)).toEqual([...KERNEL_HELLO, 'external.mcp']);
    expect(gw.adminStatus().modules).toEqual([{ id: 'topic-title', origin: 'builtin', enabled: true }, { id: 'external-mcp', origin: 'builtin', enabled: true, status: { url: expect.any(String), clients: [] } }]);
    await gw.stop();
    const withProbe = new ModuleRegistry([...builtinModules.modules, { manifest: probe('probe', []), origin: 'module' as const }], { fields: { 'external-mcp': { config: 'externalMcp' } } });
    await expect(Gateway.start({ config: bare, harness: new FakeHarness(), log: new MemorySessionLog(), listen: false, moduleRegistry: withProbe, logger: () => {} })).rejects.toThrow('module probe is registered but the config was resolved without it');
  });

  it('an active module adds its tools after the kernel\'s, its command after the kernel\'s in /help, its feature after the kernel\'s, its status; one that is off adds nothing', async () => {
    const seen: string[] = [];
    const calls: { isError: boolean; text: string }[] = [];
    const offered: string[][] = [];
    const holder: { h?: FakeHarness } = {};
    const dir = mkdtempSync(join(tmpdir(), 'aio-mod-'));
    // It starts once the channels and the local socket run: the kernel reaches the running channel.
    const registry = new ModuleRegistry([
      probe('probe', seen, { instance: (k) => ({ start: async () => void seen.push(`start probe; socket ${existsSync(join(dir, 'run', 'aio.sock'))}; channel ${k.channelFor({ channel: 'fake', account: 'default' })?.id}`) }) }),
      probe('probe2', seen),
    ]);
    const w = await daemon(registry, { probe: { greeting: 'hi' }, probe2: { enabled: false } }, async (t) => {
      const mcp = holder.h!.sessions.at(-1)!.args.mcp;
      offered.push(await listed(mcp));
      calls.push(await mcpCall(mcp, 'probe_echo', { text: 'there' }, 'toolu_1'));
      t.emit({ t: 'text.snapshot', text: 'ok', final: true }, { audience: 'answer' });
    }, dir);
    holder.h = w.harness;
    expect(seen).toEqual(['setup probe', 'start probe; socket true; channel fake']);
    expect(w.gw.adminStatus().modules).toEqual([
      { id: 'probe', origin: 'module', enabled: true, status: { greeting: 'hi' } },
      { id: 'probe2', origin: 'module', enabled: false },
    ]);

    expect(await features(w.socketPath)).toEqual([...KERNEL_HELLO, 'probe.v1']);

    // Tools: the kernel's in order, then the module's; it runs with the turn and the call's operationId.
    await w.chat.inject({ sender: alice, text: 'hi' });
    await until(() => calls.length === 1);
    expect(offered[0]).toEqual([...TOOL_NAMES, 'probe_echo']);
    const r = JSON.parse(calls[0]!.text) as Record<string, unknown>;
    expect(calls[0]!.isError).toBe(false);
    const sessionKey = w.harness.sessions[0]!.args.sessionKey;
    expect(r).toEqual({ said: 'hi, there', sessionKey, turnId: expect.any(String), operationId: `tool:${sessionKey}:toolu_1` });

    // Commands: /help ends with the module's line; the owner's /probe is answered, nothing reaches the session.
    const turnsBefore = w.harness.sessions.length;
    await w.chat.inject({ sender: alice, text: '/help' });
    const help = await until(() => replies(w.chat).find((t) => t.startsWith('/help — this list')));
    expect(help.split('\n').at(-1)).toBe("/probe — say probe's greeting");
    expect(help).not.toContain('/probe2');
    await w.chat.inject({ sender: alice, text: '/probe now' });
    await until(() => replies(w.chat).includes('hi from probe'));
    expect(seen).toContain('/probe now');
    expect(w.harness.sessions).toHaveLength(turnsBefore);
    // Someone else's /probe is an ordinary message: the handler never runs.
    await w.chat.inject({ conversation: { id: 'c-eve', kind: 'dm' }, sender: { channelUserId: 'eve', evidence: 'platform_signed' }, text: '/probe' });
    await new Promise((res) => setTimeout(res, 30));
    expect(seen.filter((s) => s.startsWith('/probe'))).toEqual(['/probe now']);

    // Stop: the started module stops; the one that is off was never set up.
    await w.gw.stop();
    expect(seen).toEqual(['setup probe', 'start probe; socket true; channel fake', '/probe now', 'stop probe']);
  });

  it('a module that is off: its /name is an ordinary message (a turn), its tool is not offered', async () => {
    const seen: string[] = [];
    const offered: string[][] = [];
    const inputs: unknown[] = [];
    const holder: { h?: FakeHarness } = {};
    const w = await daemon(new ModuleRegistry([probe('probe', seen, { defaultEnabled: false })]), {}, async (t) => {
      offered.push(await listed(holder.h!.sessions.at(-1)!.args.mcp));
      inputs.push(t.inputs[0]!.content);
      t.emit({ t: 'text.snapshot', text: 'ok', final: true }, { audience: 'answer' });
    });
    holder.h = w.harness;
    await w.chat.inject({ sender: alice, text: '/probe' });
    await until(() => offered.length === 1);
    expect(offered[0]).toEqual(TOOL_NAMES);
    expect(inputs).toEqual([[{ type: 'text', text: '/probe' }]]);
    expect(seen).toEqual([]);
    expect(w.gw.adminStatus().modules).toEqual([{ id: 'probe', origin: 'module', enabled: false }]);
  });

  it('a module an alias turns off (console: { enabled: false }, policy.strangers: "drop") is never set up: no features, no status of its own', async () => {
    const seen: string[] = [];
    const registry = new ModuleRegistry([probe('panel', seen, { aliases: ['console'] }), probe('guests', seen, { aliases: ['policy.strangers'], aliasEnabled: (v) => v !== 'drop' })]);
    const w = await daemon(registry, { console: { enabled: false, port: 0 }, policy: { owners: ['fake:alice'], strangers: 'drop' } });
    expect(seen).toEqual([]);
    expect(w.gw.adminStatus().modules).toEqual([
      { id: 'panel', origin: 'module', enabled: false },
      { id: 'guests', origin: 'module', enabled: false },
    ]);
    expect(await features(w.socketPath)).toEqual(KERNEL_HELLO);
  });

  it('onTurnCompleted: every module hears each turn of a session end (any status), in registration order, until the daemon stops its modules; a hook that throws or rejects is logged, the others still run', async () => {
    const heard: string[] = [];
    const logs: string[] = [];
    const kernels: KernelContext[] = [];
    const registry = new ModuleRegistry([
      probe('first', [], {
        instance: (k) => {
          kernels.push(k);
          return { hooks: { onTurnCompleted: (a) => { heard.push(`first ${a.status} ${a.sessionKey} ${a.turnId}`); throw new Error('boom'); } } };
        },
      }),
      probe('second', [], { instance: () => ({ hooks: { onTurnCompleted: (a) => (heard.push(`second ${a.status}`), Promise.reject(new Error('later')) as never) } }) }),
    ]);
    const w = await daemon(registry, { agents: { helper: { harness: 'claude-code' } } }, async (t) => {
      if (t.inputs[0]!.content.some((c) => c.type === 'text' && c.text === 'fail')) throw new Error('the turn fails');
      t.emit({ t: 'text.snapshot', text: 'ok', final: true }, { audience: 'answer' });
    }, undefined, (level, msg) => logs.push(`${level}: ${msg}`));
    await w.chat.inject({ sender: alice, text: 'hi' });
    await until(() => heard.length === 2);
    await w.chat.inject({ sender: alice, text: 'fail' });
    await until(() => heard.length === 4);
    const sessionKey = w.harness.sessions[0]!.args.sessionKey;
    const ended = w.gw.hub.log.read(sessionKey, 0).flatMap((e) => (e.body.t === 'turn.completed' ? [`${e.body.status} ${sessionKey} ${e.body.turnId}`] : []));
    expect(heard).toEqual([`first ${ended[0]}`, 'second completed', `first ${ended[1]}`, 'second failed']);
    expect(ended.map((x) => x.split(' ')[0])).toEqual(['completed', 'failed']);
    expect(logs).toContain('warn: module first: onTurnCompleted failed: boom');
    await until(() => logs.includes('warn: module second: onTurnCompleted failed: later'));

    // What a hook reaches of the kernel: what it may run beside the lane (a configured agent's), the topic and its generated title.
    const k = kernels[0]!;
    const lane = k.lanes.harness(sessionKey)!;
    // An ephemeral turn, never the adapter; this harness (an embedder's single one, for every instance) declares no ephemeralOpen.
    expect(Object.keys(lane).sort()).toEqual(['ephemeral', 'ephemeralTurn']);
    const turnId = ended[0]!.split(' ')[2]!;
    expect(lane.ephemeral(turnId)).toBe(false);
    expect(lane.ephemeral('t_nope')).toBe(false);
    await expect(lane.ephemeralTurn({ turnId, prompt: 'x', instructions: 'y' })).rejects.toThrow(`${sessionKey}: turn ${turnId} ran on no harness that runs ephemeral turns (ephemeralOpen)`);
    expect(w.harness.sessions).toHaveLength(1);
    expect(k.lanes.harness('fake:default:nobody')).toBeUndefined();
    const topic = k.topics.bySession(sessionKey)!;
    expect(k.topics.titleSource(topic.id)).toBe('auto');
    expect(k.topics.titleSource('tp_nope')).toBeUndefined();
    expect(k.topics.setAutoTitle(topic.id, 'not its title', 'Named')).toBe(false);
    expect(k.topics.setAutoTitle(topic.id, topic.title, 'Named')).toBe(true);
    expect(k.topics.bySession(sessionKey)).toMatchObject({ title: 'Named' });
    expect(k.topics.setAutoTitle(topic.id, 'Named', 'Named')).toBe(false);
    // The latest card is edited to carry it.
    await until(() => w.chat.sent.some((x) => x.edits.some((m) => ((m.channelData as Record<string, unknown> | undefined)?.[TOPIC_KEY] as { title?: string } | undefined)?.title === 'Named')));

    // Once the daemon stops its modules, no hook is called.
    await w.gw.stop();
    w.gw.modules.turnCompleted({ sessionKey, turnId: 't_after', status: 'completed' });
    expect(heard).toHaveLength(4);

    // The default agent of a deployment without agents is not a configured one: no lane harness.
    const kernels2: KernelContext[] = [];
    const v = await daemon(new ModuleRegistry([probe('first', [], { instance: (k2) => (kernels2.push(k2), {}) })]));
    await v.chat.inject({ sender: alice, text: 'hi' });
    await until(() => v.harness.sessions.length === 1);
    expect(kernels2[0]!.lanes.harness(v.harness.sessions[0]!.args.sessionKey)).toBeUndefined();
  });

  it("lanes.harness: an ephemeral turn on the harness a turn ran on, set by the kernel (a throwaway session in the session's cwd, that turn's run at low effort under a read-only profile named after the module, no tools, the kernel's input); nothing else the module passes reaches the harness", async () => {
    const kernels: KernelContext[] = [];
    const turns: string[] = [];
    const asked: InputRecord[][] = [];
    const registry = new ModuleRegistry([probe('probe', [], { instance: (k) => (kernels.push(k), { hooks: { onTurnCompleted: (a) => void turns.push(a.turnId) } }) })]);
    const w = await daemon(registry, { agents: { helper: { harness: 'claude-code' } } }, async (t) => {
      if (t.inputs[0]!.origin.via !== 'probe') return t.emit({ t: 'text.snapshot', text: 'ok', final: true }, { audience: 'answer' });
      asked.push(t.inputs);
      if (t.inputs[0]!.content.some((c) => c.type === 'text' && c.text === 'fail')) throw new Error('the ephemeral turn fails');
      t.emit({ t: 'text.delta', stream: 'answer', delta: 'A ' }, { audience: 'answer' });
      t.emit({ t: 'text.delta', stream: 'answer', delta: 'title' }, { audience: 'answer' });
    }, undefined, undefined, undefined, { ephemeralOpen: true });
    await w.chat.inject({ sender: alice, text: 'hi' });
    await until(() => turns.length === 1);
    const sessionKey = w.harness.sessions[0]!.args.sessionKey;
    const lane = kernels[0]!.lanes.harness(sessionKey)!;
    expect(lane.ephemeral(turns[0]!)).toBe(true);
    // A module's untyped code may pass more (a run, options, tools): none of it is passed on.
    const more = { turnId: turns[0]!, prompt: 'Name it', instructions: 'Only a title.', run: { profile: 'bypass' }, options: { sandbox: 'danger-full-access' }, mcp: { url: 'http://x' } };
    expect(await lane.ephemeralTurn(more as never)).toBe('A title');
    const started = w.gw.hub.log.read(sessionKey, 0).find((e) => e.body.t === 'turn.started')!.body;
    if (started.t !== 'turn.started') throw new Error('no turn.started');
    expect(started.run).toMatchObject({ harness: 'claude-code' });
    const opened = w.harness.sessions.filter((s) => s.args.sessionKey !== sessionKey);
    expect(opened.map((s) => s.args)).toEqual([{
      sessionKey: expect.stringMatching(/^probe:/), generation: 1, cwd: w.gw.config.cwd,
      run: { ...started.run, profile: 'probe', effort: 'low', mode: 'default' },
      instructions: 'Only a title.',
      options: { ephemeral: true, preface: false, profiles: { probe: { approvalPolicy: 'never', sandbox: 'read-only' } } },
    }]);
    expect(asked).toEqual([[{ inputId: expect.stringMatching(/^probe:/), origin: { kind: 'system', principal: null, evidence: 'daemon', via: 'probe', adapter: 'session' }, content: [{ type: 'text', text: 'Name it' }], replyRoute: null, channelContext: {} }]]);
    // Kept out of the daemon's sessions and logs.
    expect(w.gw.sessions().map((s) => s.sessionKey)).toEqual([sessionKey]);
    expect(w.gw.hub.log.read(opened[0]!.args.sessionKey, 0)).toEqual([]);
    // A turn that does not complete answers nothing; what the module gives is text, or it is refused.
    expect(await lane.ephemeralTurn({ turnId: turns[0]!, prompt: 'fail', instructions: 'x' })).toBeUndefined();
    await expect(lane.ephemeralTurn({ turnId: turns[0]!, prompt: 1, instructions: 'x' } as never)).rejects.toThrow('module probe: lanes.harness(…).ephemeralTurn: prompt must be a string');
    expect(w.harness.sessions).toHaveLength(3);
  });

  it("a task run's turns never reach onTurnCompleted, and lanes.harness has nothing for its lane while it runs", async () => {
    const kernels: KernelContext[] = [];
    const heard: string[] = [];
    const during: unknown[] = [];
    const registry = new ModuleRegistry([probe('probe', [], { instance: (k) => (kernels.push(k), { hooks: { onTurnCompleted: (a) => void heard.push(a.sessionKey) } }) })]);
    const w = await daemon(registry, { agents: { helper: { harness: 'claude-code' }, exec: { harness: 'claude-code', mode: 'task' } } }, async (t) => {
      if (t.inputs[0]!.content.some((c) => c.type === 'text' && c.text === 'go')) during.push({ open: kernels[0]!.lanes.has('run:r1'), harness: kernels[0]!.lanes.harness('run:r1') });
      t.emit({ t: 'text.snapshot', text: 'ok', final: true }, { audience: 'answer' });
    }, undefined, undefined, undefined, { ephemeralOpen: true });
    const h = await LocalClient.connect(w.socketPath);
    cleanups.push(() => h.close());
    await h.hello({ token: readTokenFile(tokenPath(w.socketPath)), name: 'host' });
    await h.runStart({ runId: 'r1', agent: 'exec', input: [{ type: 'text', text: 'go' }] });
    expect(await h.runEndedOf('r1')).toMatchObject({ status: 'completed' });
    expect(during).toEqual([{ open: true, harness: undefined }]);
    expect(w.gw.hub.log.read('run:r1', 0).some((e) => e.body.t === 'turn.completed' && e.body.status === 'completed')).toBe(true);
    // A session's turn after it is heard; the run's never was.
    await w.chat.inject({ sender: alice, text: 'hi' });
    await until(() => heard.length === 1);
    expect(heard).toEqual([w.harness.sessions.find((s) => !s.args.sessionKey.startsWith('run:'))!.args.sessionKey]);
  });

  it('setup and start failures fail the start naming the module; a hook not served yet, a missing handler, a config resolved without the registry too', async () => {
    const seen: string[] = [];
    const start = (m: ModuleManifest<any>[], raw: Record<string, unknown> = {}) => daemon(new ModuleRegistry(m), raw);
    await expect(start([probe('probe', seen, { instance: () => { throw new Error('boom'); } })])).rejects.toThrow(new ConfigError('module probe: setup failed: boom'));
    await expect(start([probe('probe', seen, { instance: () => ({ hooks: { onUndispatched: async () => {} } }) })])).rejects.toThrow(new ConfigError('module probe: hooks.onUndispatched is not served yet'));
    await expect(start([probe('probe', seen, { instance: () => ({ hooks: { onTurnCompleted: 1 as never } }) })])).rejects.toThrow(new ConfigError('module probe: hooks.onTurnCompleted must be a function'));
    await expect(start([probe('probe', seen, { instance: () => ({ localFrames: { 'tui.attach': async () => ({ ok: true, value: null }) } }) })])).rejects.toThrow('module probe: localFrames are not served yet');
    await expect(start([probe('probe', seen, { instance: () => ({ tools: {} }) })])).rejects.toThrow('module probe: tools.probe_echo: no handler for its tool probe_echo');
    // A start that throws fails the daemon's start; those started before it stop.
    seen.length = 0;
    await expect(start([probe('probe', seen), probe('probe2', seen, { instance: () => ({ start: async () => { throw new Error('no port'); } }) })])).rejects.toThrow('module probe2: start failed: no port');
    expect(seen).toEqual(['setup probe', 'setup probe2', 'start probe', 'stop probe']);
    // A config error (or a token file's) names its setting itself: thrown as it is, so `aio serve` exits 2.
    const bad = new ConfigError('probe.greeting: the token file is not ours');
    await expect(start([probe('probe', seen, { instance: () => ({ start: async () => { throw bad; } }) })])).rejects.toBe(bad);
    // A module stamps only peers' inputs; features is a function.
    const stamp = (k: KernelContext) => ({ start: () => k.lanes.input('S1', { inputId: 'i1', origin: { kind: 'human', principal: null, evidence: 'none' }, content: [], replyRoute: null } as never).then(() => undefined) });
    await expect(start([probe('probe', seen, { instance: stamp })])).rejects.toThrow('module probe: start failed: module probe: lanes.input takes a peer\'s input (origin.kind "peer", not "human")');
    await expect(start([probe('probe', seen, { instance: () => ({ features: ['probe.v1'] as never }) })])).rejects.toThrow(new ConfigError('module probe: features must be a function'));
    // The config and the gateway must have the same registry.
    const dir = mkdtempSync(join(tmpdir(), 'aio-mod-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const config = { ...resolveConfig({}, { env: {}, baseDir: dir, cwd: dir, moduleRegistry: new ModuleRegistry([]) }), socketPath: join(dir, 'aio.sock') };
    await expect(Gateway.start({ config, harness: new FakeHarness(), log: new MemorySessionLog(), listen: false, moduleRegistry: new ModuleRegistry([probe('probe', [])]), logger: () => {} })).rejects.toThrow(
      'module probe is registered but the config was resolved without it: give loadConfig and Gateway.start the same moduleRegistry',
    );
  });
});
