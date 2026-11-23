import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Type } from '@sinclair/typebox';
import type { KernelContext, ModuleInstance, ModuleManifest, ModuleResolveContext, ModuleToolCall } from '@agents-io/protocol';
import { MemorySessionLog } from '@agents-io/session';
import { FakeChannel, FakeHarness, type FakeTurnScript } from '@agents-io/testkit';
import { TOOL_NAMES } from '@agents-io/host-mcp';
import { builtinHarnesses, builtinModules } from '../src/bundle.js';
import { LocalClient } from '../src/client.js';
import { ConfigError, ConfigFile, configFileSchema, resolveConfig } from '../src/config.js';
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
  it('the built-in one has no module yet: the config schema is ConfigFile and the config has no modules', () => {
    expect(builtinModules.size).toBe(0);
    expect(configFileSchema(builtinHarnesses)).toBe(ConfigFile);
    expect(resolve({}).modules).toBeUndefined();
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
    // Default on, so off can only come from the alias's value.
    const r = new ModuleRegistry([
      probe('ext', [], { aliases: ['externalMcp'], resolved }),
      probe('guests', [], { aliases: ['policy.strangers'], aliasEnabled: (v) => v !== 'drop', resolved }),
    ]);
    const modules = (raw: Record<string, unknown>) => resolve(raw, r).modules;
    const off = resolve({ externalMcp: { enabled: false, clients: {} }, policy: { strangers: 'drop' } }, r);
    expect(off.modules).toEqual([{ id: 'ext', enabled: false }, { id: 'guests', enabled: false }]);
    expect(off.externalMcp).toBeUndefined();
    expect(resolved).toEqual([]);
    // Any other value is on, handed to resolve as it is there.
    expect(modules({ externalMcp: { clients: {} }, policy: { strangers: 'ask' } })).toEqual([
      { id: 'ext', enabled: true, config: { greeting: 'hello' } },
      { id: 'guests', enabled: true, config: { greeting: 'hello' } },
    ]);
    expect(resolved).toMatchObject([
      { raw: { clients: {} }, ctx: { where: 'externalMcp', alias: 'externalMcp' } },
      { raw: 'ask', ctx: { where: 'policy.strangers', alias: 'policy.strangers' } },
    ]);
    expect(modules({ externalMcp: { enabled: true, clients: {} } })![0]).toEqual({ id: 'ext', enabled: true, config: { greeting: 'hello' } });
    expect(resolved.at(-2)!.raw).toEqual({ enabled: true, clients: {} });
    // aliasEnabled decides alone: an object with enabled: false is what it says.
    const own = new ModuleRegistry([probe('ext', [], { aliases: ['externalMcp'], aliasEnabled: () => true })]);
    expect(resolve({ externalMcp: { enabled: false, clients: {} } }, own).modules).toEqual([{ id: 'ext', enabled: true, config: { greeting: 'hello' } }]);
    // The section, when present, decides over an alias.
    expect(modules({ ext: {}, externalMcp: { enabled: false, clients: {} }, guests: { greeting: 'hi' }, policy: { strangers: 'drop' } })).toEqual([
      { id: 'ext', enabled: true, config: { greeting: 'hello' } },
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
async function daemon(registry: ModuleRegistry, raw: Record<string, unknown> = {}, script?: FakeTurnScript, dir = mkdtempSync(join(tmpdir(), 'aio-mod-'))) {
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const base = resolveConfig({ policy: { owners: ['fake:alice'] }, local: { principal: 'me' }, outputTools: true, ...raw }, { env: {}, baseDir: dir, cwd: dir, moduleRegistry: registry });
  const config = { ...base, socketPath: join(dir, 'run', 'aio.sock') };
  const chat = new FakeChannel('fake');
  const harness = new FakeHarness(script);
  const gw = await Gateway.start({ config, harness, log: new MemorySessionLog(), channels: [{ adapter: chat }], moduleRegistry: registry, logger: () => {} });
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

describe('modules in the daemon (lifecycle steps 2-4)', () => {
  it('the kernel\'s features, in order, as before the registry; hello lists them (filtered as before) with no module', async () => {
    expect(FEATURES).toEqual([
      'session.launch', 'callouts.resolve', 'callouts.review', 'resolve.native', 'resolver.human.extras', 'callouts.outbound', 'callouts.contact', 'resolve.onBehalfOf',
      'inbound.redispatch', 'host.takeover', 'explain.chain', 'run.overrides', 'run.ended.usage', 'run.correlation', 'callouts.external', 'external.mcp', 'session.compact',
    ]);
    const w = await daemon(builtinModules);
    const c = await LocalClient.connect(w.socketPath);
    cleanups.push(() => c.close());
    const hello = await c.hello({ token: readTokenFile(tokenPath(w.socketPath)), name: 'probe' });
    expect(hello.features).toEqual(FEATURES.filter((f) => f !== 'resolve.onBehalfOf' && f !== 'external.mcp'));
    expect(w.gw.adminStatus().modules).toEqual([]);
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

    const c = await LocalClient.connect(w.socketPath);
    cleanups.push(() => c.close());
    const hello = await c.hello({ token: readTokenFile(tokenPath(w.socketPath)), name: 'probe' });
    expect(hello.features).toEqual([...FEATURES.filter((f) => f !== 'resolve.onBehalfOf' && f !== 'external.mcp'), 'probe.v1']);

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

  it('a module an alias turns off (externalMcp: { enabled: false }, policy.strangers: "drop") is never set up: no features, no status of its own', async () => {
    const seen: string[] = [];
    const registry = new ModuleRegistry([probe('ext', seen, { aliases: ['externalMcp'] }), probe('guests', seen, { aliases: ['policy.strangers'], aliasEnabled: (v) => v !== 'drop' })]);
    const w = await daemon(registry, { externalMcp: { enabled: false, listen: '127.0.0.1:0', clients: {} }, policy: { owners: ['fake:alice'], strangers: 'drop' } });
    expect(seen).toEqual([]);
    expect(w.gw.adminStatus().externalMcp).toBeUndefined();
    expect(w.gw.adminStatus().modules).toEqual([
      { id: 'ext', origin: 'module', enabled: false },
      { id: 'guests', origin: 'module', enabled: false },
    ]);
    const c = await LocalClient.connect(w.socketPath);
    cleanups.push(() => c.close());
    const hello = await c.hello({ token: readTokenFile(tokenPath(w.socketPath)), name: 'probe' });
    expect(hello.features).toEqual(FEATURES.filter((f) => f !== 'resolve.onBehalfOf' && f !== 'external.mcp'));
  });

  it('setup and start failures fail the start naming the module; a hook not served yet, a missing handler, a config resolved without the registry too', async () => {
    const seen: string[] = [];
    const start = (m: ModuleManifest<any>[], raw: Record<string, unknown> = {}) => daemon(new ModuleRegistry(m), raw);
    await expect(start([probe('probe', seen, { instance: () => { throw new Error('boom'); } })])).rejects.toThrow(new ConfigError('module probe: setup failed: boom'));
    await expect(start([probe('probe', seen, { instance: () => ({ hooks: { onUndispatched: async () => {} } }) })])).rejects.toThrow(new ConfigError('module probe: hooks.onUndispatched is not served yet'));
    await expect(start([probe('probe', seen, { instance: () => ({ localFrames: { 'tui.attach': async () => ({ ok: true, value: null }) } }) })])).rejects.toThrow('module probe: localFrames are not served yet');
    await expect(start([probe('probe', seen, { instance: () => ({ tools: {} }) })])).rejects.toThrow('module probe: tools.probe_echo: no handler for its tool probe_echo');
    // A start that throws fails the daemon's start; those started before it stop.
    seen.length = 0;
    await expect(start([probe('probe', seen), probe('probe2', seen, { instance: () => ({ start: async () => { throw new Error('no port'); } }) })])).rejects.toThrow('module probe2: start failed: no port');
    expect(seen).toEqual(['setup probe', 'setup probe2', 'start probe', 'stop probe']);
    // The config and the gateway must have the same registry.
    const dir = mkdtempSync(join(tmpdir(), 'aio-mod-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const config = { ...resolveConfig({}, { env: {}, baseDir: dir, cwd: dir }), socketPath: join(dir, 'aio.sock') };
    await expect(Gateway.start({ config, harness: new FakeHarness(), log: new MemorySessionLog(), listen: false, moduleRegistry: new ModuleRegistry([probe('probe', [])]), logger: () => {} })).rejects.toThrow(
      'module probe is registered but the config was resolved without it: give loadConfig and Gateway.start the same moduleRegistry',
    );
  });
});
