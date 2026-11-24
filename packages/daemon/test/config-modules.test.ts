import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Type } from '@sinclair/typebox';
import { ADMIN_REDACTED, type HarnessModule, type InputRecord, type KernelContext, type Origin } from '@agents-io/protocol';
import { FakeChannel, FakeHarness, type FakeTurnScript } from '@agents-io/testkit';
import { builtinChannels, builtinHarnesses, builtinModules } from '../src/bundle.js';
import { ConfigError, type HarnessInstance, HarnessRegistry, LocalClient, readTokenFile, tokenPath } from '@agents-io/kernel';
import { ConfigStore, Gateway, implicitEnv, importConfigModules, InstanceHarness, redact, resolveConfig } from '../src/defaults.js';
import { cleanups, tmp, until } from './helpers.js';
import { mcpCall, mcpTools } from './output-tools-helpers.js';

/*
 * The same contract for third parties (core-slimming §5): the bundled aio imports the module files
 * a config names before it resolves the config (`loadConfigModules` / `importConfigModules`, as
 * `aio serve` does), so a feature module of someone else's (`modules` entries, origin `module`), a
 * `type: "module"` channel file exporting a `ChannelModule` descriptor and a `use: "module"`
 * harness descriptor's `declares` and `cli` count as a built-in module's do.
 * Fixtures: fixtures/feature-module.mjs, chan-descriptor.mjs (chan-versioned.mjs: as a package's
 * version exports it), harness-descriptor-full.mjs.
 */

const here = dirname(fileURLToPath(import.meta.url));
const alice = { channelUserId: 'alice', evidence: 'platform_signed' as const };
const dm = { conversation: { id: 'c-alice', kind: 'dm' as const } };

type FeatureRec = { k: KernelContext; config: Record<string, unknown>; started: boolean; stopped: boolean };
const feature = (key: string) => (globalThis as { __feature?: Record<string, FeatureRec> }).__feature?.[key];
type ChanRec = { via: string; init: { account: string; config: unknown }; startConfig?: unknown; inject?: (p: object) => Promise<{ accepted: boolean }> };
const chanRec = (key: string) => (globalThis as { __chan?: Record<string, ChanRec> }).__chan?.[key];
type DescriptorSeen = { validated?: unknown[]; created?: Record<string, unknown>[]; stateDirs?: Record<string, string> };
const descriptorSeen = (): DescriptorSeen => (globalThis as { __chanDescriptor?: DescriptorSeen }).__chanDescriptor ?? {};

const greet = (config: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ use: 'module', module: './fixtures/feature-module.mjs', config, ...extra });

/** The file of a deployment in a fresh directory (module paths relative to this test's directory). */
function file(raw: Record<string, unknown>) {
  const dir = tmp('aio-cm-');
  mkdirSync(join(dir, 'work'), { recursive: true });
  return { dir, raw: { dataDir: dir, policy: { owners: ['fake:alice'] }, local: { principal: 'me' }, cwd: join(dir, 'work'), ...raw } };
}

/**
 * What `aio serve` does with a file: import its module files, resolve it with the registries that
 * gives, start a gateway on them (a FakeHarness behind every instance, a FakeChannel `fake` with
 * owner fake:alice, unless `loadHarnesses`: the gateway loads `use: "module"` instances itself).
 * `console` serves the console on the file (an object: more keys of its `console` section);
 * `harnessRegistry` is the daemon's harness kinds (default the built-in ones), to all three.
 */
async function serve(raw: Record<string, unknown>, o: { env?: Record<string, string>; script?: FakeTurnScript; loadHarnesses?: boolean; console?: boolean | Record<string, unknown>; harnessRegistry?: HarnessRegistry } = {}) {
  const f = file(o.console ? { ...raw, console: { port: 0, ...(typeof o.console === 'object' ? o.console : {}) } } : raw);
  const harnessRegistry = o.harnessRegistry ?? builtinHarnesses;
  const registries = { ...(await importConfigModules(f.raw, { baseDir: here, harnessRegistry })), harnessRegistry };
  const configPath = join(f.dir, 'aio.config.json');
  if (o.console) writeFileSync(configPath, JSON.stringify(f.raw, null, 2) + '\n', { mode: 0o600 });
  const config = { ...resolveConfig(f.raw, { env: o.env ?? {}, baseDir: here, cwd: f.dir, ...registries }), socketPath: join(f.dir, 'run', 'aio.sock'), ...(o.console ? { source: { path: configPath } } : {}) };
  const harness = new FakeHarness(o.script);
  const chat = new FakeChannel('fake');
  const gw = await Gateway.start({
    config,
    ...registries,
    ...(o.loadHarnesses ? {} : { buildHarness: (i: HarnessInstance) => new InstanceHarness(i, harness) }),
    channels: [{ adapter: chat }],
    logger: () => {},
    ...(o.console ? { console: true, consoleEnv: o.env ?? {}, channelStartGraceMs: 100 } : {}),
  });
  cleanups.push(() => gw.stop());
  const replies = () => chat.sent.map((s) => s.edits.at(-1)?.text ?? s.msg.text);
  const say = async (text: string, match: (reply: string) => boolean = () => true) => {
    const before = replies().length;
    await chat.inject({ ...dm, sender: alice, text });
    return until(() => replies().slice(before).find((r) => r !== undefined && match(r)));
  };
  /** What `host.hello` lists. */
  const features = async () => {
    const c = await LocalClient.connect(config.socketPath);
    cleanups.push(() => c.close());
    return (await c.hello({ token: readTokenFile(tokenPath(config.socketPath)), name: 'probe' })).features;
  };
  /** A console request with the host token. */
  const api = async (path: string, init: { method?: string; json?: unknown } = {}) => {
    const r = await fetch(gw.console!.url + path, {
      method: init.method ?? 'GET',
      headers: { Authorization: `Bearer ${gw.token}`, ...(init.json !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      ...(init.json !== undefined ? { body: JSON.stringify(init.json) } : {}),
    });
    const text = await r.text();
    return { status: r.status, body: text ? JSON.parse(text) : undefined };
  };
  return { gw, chat, harness, config, registries, say, replies, features, api, file: f, configPath };
}

/** What the config's resolution with its modules imported first throws (or the import itself). */
async function loadFails(raw: Record<string, unknown>): Promise<string> {
  const f = file(raw);
  try {
    const registries = await importConfigModules(f.raw, { baseDir: here });
    resolveConfig(f.raw, { env: {}, baseDir: here, cwd: f.dir, ...registries });
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error('loaded');
}

describe('feature modules a config file names (modules entries)', () => {
  it("one is imported at the start and registered after the built-in ones, origin module: its settings are its entry's config, its tool is offered to an agent listing it, its command answers the owner, its feature and status are there #CF-6 #CT-2", async () => {
    const offered: string[][] = [];
    const calls: { isError: boolean; text: string }[] = [];
    const holder: { h?: FakeHarness } = {};
    const w = await serve(
      {
        modules: [greet({ key: 'g1', greeting: 'env:GREETING' })],
        agents: { main: { harness: 'claude-code', tools: ['send_message', 'acme_greet'] } },
      },
      {
        env: { GREETING: 'ahoy' },
        script: async (t) => {
          const mcp = holder.h!.sessions.at(-1)!.args.mcp;
          offered.push(await mcpTools(mcp));
          calls.push(await mcpCall(mcp, 'acme_greet', { to: 'alice' }, 'toolu_1'));
          t.emit({ t: 'text.snapshot', text: 'ok', final: true }, { audience: 'answer' });
        },
      },
    );
    holder.h = w.harness;
    // Its settings: what its resolve made of the entry's config (env substituted where it asked, `where` the entry's).
    const rec = feature('g1')!;
    expect(rec.config).toEqual({ key: 'g1', greeting: 'ahoy', where: 'modules[0].config', owners: ['fake:alice'] });
    expect(rec.started).toBe(true);
    expect(w.config.modules!.at(-1)).toEqual({ id: 'acme.greet', enabled: true, config: rec.config });
    expect(w.config.moduleEntries).toEqual([{ module: join(here, 'fixtures', 'feature-module.mjs') }]);
    // After every built-in module, someone else's.
    expect(w.gw.adminStatus().modules!.map((m) => m.id)).toEqual([...builtinModules.modules.map((r) => r.manifest.id), 'acme.greet']);
    expect(w.gw.adminStatus().modules!.at(-1)).toEqual({ id: 'acme.greet', origin: 'module', enabled: true, status: { greeting: 'ahoy' } });
    expect(await w.features()).toContain('acme.greet');

    // An agent's tools list may name its tool: offered, and it runs.
    await w.say('hi', (r) => r === 'ok');
    expect(offered[0]).toEqual(['acme_greet', 'send_message']);
    expect(calls[0]).toEqual({ isError: false, text: JSON.stringify({ said: 'ahoy, alice' }) });
    // Its command: the owner's /greet is answered, after the kernel's lines in /help; no turn.
    const turns = w.harness.sessions.length;
    expect(await w.say('/greet')).toBe('ahoy from acme');
    expect((await w.say('/help', (r) => r.startsWith('/help'))).split('\n').at(-1)).toBe('/greet — say the configured greeting');
    expect(w.harness.sessions).toHaveLength(turns);
    await w.gw.stop();
    expect(rec.stopped).toBe(true);
  });

  it("an entry whose config says enabled: false leaves its module off: never set up, no tool, listed off; a module without settings takes only enabled there #CF-6", async () => {
    const w = await serve({ modules: [greet({ key: 'g2', enabled: false }), { use: 'module', module: './fixtures/feature-module.mjs', export: 'bare' }] });
    expect(feature('g2')).toBeUndefined();
    expect(w.gw.adminStatus().modules!.slice(-2)).toEqual([
      { id: 'acme.greet', origin: 'module', enabled: false },
      { id: 'acme.bare', origin: 'module', enabled: true },
    ]);
    expect(await w.features()).not.toContain('acme.greet');
    // Its tool is a tool of a module that is off.
    expect(await loadFails({ modules: [greet({ key: 'g3', enabled: false })], agents: { main: { harness: 'claude-code', tools: ['acme_greet'] } } })).toBe('agents.main.tools: "acme_greet" is a tool of module acme.greet, which is off');
    expect(await loadFails({ modules: [{ use: 'module', module: './fixtures/feature-module.mjs', export: 'bare', config: { greeting: 'hi' } }] })).toMatch(/^invalid config: modules\[0\]\.config\/greeting: Unexpected property/);
  });

  it('a missing file, an export that is no manifest, a manifest the registry refuses (its shape, an id or a tool another module has), a config its schema or resolve refuses each fail the load, naming the entry; one not imported before the config resolved fails the start #CF-4', async () => {
    const at = (exp: string) => ({ use: 'module', module: './fixtures/feature-module.mjs', export: exp });
    expect(await loadFails({ modules: [{ use: 'module', module: './fixtures/no-such-module.mjs' }] })).toMatch(/^modules\[0\]\.module: .*no-such-module\.mjs does not exist$/);
    expect(await loadFails({ modules: [at('notManifest')] })).toMatch(/^modules\[0\] \(module .*feature-module\.mjs\): export "notManifest" is not a module manifest/);
    // A named export never falls back to default.
    expect(await loadFails({ modules: [at('nope')] })).toMatch(/^modules\[0\] \(module .*\): export "nope" is not a module manifest/);
    expect(await loadFails({ modules: [at('noSetup')] })).toMatch(/^modules\[0\] \(module .*\): module acme\.nosetup: setup must be a function$/);
    expect(await loadFails({ modules: [at('builtinId')] })).toMatch(/^modules\[0\] \(module .*\): module "topic-title" is registered twice$/);
    expect(await loadFails({ modules: [greet({ key: 'x' }), at('builtinTool')] })).toMatch(/^modules\[1\] \(module .*\): module acme\.tools: tool watch_add is also module tools\.watch's$/);
    // One file and export is one module.
    expect(await loadFails({ modules: [greet({ key: 'a' }), greet({ key: 'b' })] })).toMatch(/^modules\[1\] \(module .*\): module "acme\.greet" is registered twice$/);
    // Its settings: the entry's config against its schema (closed), then its resolve.
    expect(await loadFails({ modules: [greet({ key: 'c', extra: 1 })] })).toMatch(/^invalid config: modules\[0\]\.config\/extra: Unexpected property/);
    expect(await loadFails({ modules: [greet({})] })).toMatch(/^invalid config: modules\[0\]\.config\/key: Expected required property/);
    expect(await loadFails({ modules: [greet({ key: 'd', greeting: 'bad' })] })).toBe('modules[0].config.greeting: not that one');
    expect(await loadFails({ modules: [{ use: 'module', module: './fixtures/feature-module.mjs', path: 'x' }] })).toMatch(/^invalid config: \/modules\/0\/path: Unexpected property/);
    // Resolved without importing it first (a client reading the file): loads, but the daemon does not start on it.
    const f = file({ modules: [greet({ key: 'e' })], agents: { main: { harness: 'claude-code', tools: ['acme_greet'] } } });
    const config = { ...resolveConfig(f.raw, { env: {}, baseDir: here, cwd: f.dir }), socketPath: join(f.dir, 'run', 'aio.sock') };
    expect(config.moduleEntries).toEqual([{ module: join(here, 'fixtures', 'feature-module.mjs') }]);
    await expect(Gateway.start({ config, harness: new FakeHarness(), logger: () => {}, listen: false })).rejects.toThrow(/^modules\[0\] \(module .*feature-module\.mjs\) is not loaded: import the config's modules before resolving it \(loadConfigModules/);
  });

  it("one gets the kernel context a built-in module gets: it enters a session only as a peer (a person's or an owner's origin is refused) and cannot set the policy #ID-10 #ID-3", async () => {
    const w = await serve({ modules: [{ use: 'module', module: './fixtures/feature-module.mjs', export: 'bare' }] });
    const k = (globalThis as { __feature?: Record<string, { k: KernelContext }> }).__feature!.bare!.k;
    expect(k.id).toBe('acme.bare');
    const owner: Origin = { kind: 'human', principal: { id: 'fake:alice', labels: ['owner'] }, evidence: 'platform_signed', via: 'fake:default', adapter: 'fake' };
    const input = (inputId: string, origin: Origin): InputRecord => ({ inputId, origin, content: [{ type: 'text', text: 'hi' }], replyRoute: null, channelContext: {} });
    await expect(k.lanes.input('s1', input('i1', owner))).rejects.toThrow('module acme.bare: lanes.input takes a peer\'s input (origin.kind "peer", not "human")');
    await expect(k.lanes.input('s1', input('i2', { ...owner, kind: 'peer', evidence: 'device_only' }))).rejects.toThrow("module acme.bare: lanes.input takes a peer's input (a peer never carries the owner label)");
    await expect(k.lanes.command({ type: 'input', sessionKey: 's1', mode: 'queue', input: { content: [{ type: 'text', text: 'hi' }] } }, owner)).rejects.toThrow('lanes.command takes a peer\'s origin');
    expect(w.harness.sessions).toHaveLength(0);
    // The policy is asked, never set: a frozen view; what the lanes decide with is unchanged.
    const plan = w.gw.policy.plan;
    expect(Object.isFrozen(k.policy)).toBe(true);
    expect(() => {
      (k.policy as { plan: unknown }).plan = async () => ({ harness: 'claude-code', profile: 'bypass' });
    }).toThrow(TypeError);
    expect(w.gw.policy.plan).toBe(plan);
    expect(k.policy.plan).toBe(plan);
  });
});

describe('a type: "module" channel file exporting a ChannelModule descriptor', () => {
  const acme = (config: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ type: 'module', module: './fixtures/chan-descriptor.mjs', config, ...extra });

  it("checks and resolves its entries as the config resolves (its entry schema on config, its resolve, its validateAll over the entries of its file), and create builds each from the resolved config with the entry's account; a factory file still works #CF-4", async () => {
    const w = await serve({ channels: [acme({ id: 'acme1', token: 'env:ACME_SECRET' }, { account: 'lan' }), acme({ id: 'acme2' }), { type: 'module', module: './fixtures/chan-pkg', config: { id: 'plug9' } }] }, { env: { ACME_SECRET: 's3', ACME_TOKEN: 't4' } });
    const [a1, a2] = w.config.channels;
    expect(a1).toMatchObject({ type: 'module', account: 'lan', config: { id: 'acme1', token: 's3', region: 'eu', where: 'channels[0].config' } });
    expect(a2).toMatchObject({ account: 'default', config: { id: 'acme2', token: 't4' } });
    expect(descriptorSeen().validated).toEqual([
      { index: 0, id: 'acme1', account: 'lan', region: 'eu' },
      { index: 1, id: 'acme2', account: 'default', region: 'eu' },
    ]);
    expect(descriptorSeen().created).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'acme1', token: 's3', account: 'lan' })]));
    const r = await until(() => chanRec('acme1:lan')?.inject && chanRec('acme1:lan'));
    expect(r.via).toBe('descriptor');
    // What `create` said the channel's `ChannelContext.config` is.
    expect(r.startConfig).toEqual({ region: 'eu' });
    expect(chanRec('plug9:default')?.via).toBe('createChannel');
    expect(w.gw.adminStatus().channels.map((c) => c.id)).toEqual(expect.arrayContaining(['acme1', 'acme2', 'plug9']));

    const fails = (channels: unknown[]) => loadFails({ channels });
    expect(await fails([acme({ id: 'x', extra: true })])).toMatch(/^invalid config: channels\[0\]\.config\/extra: Unexpected property/);
    expect(await fails([acme({ token: 'a' })])).toMatch(/^invalid config: channels\[0\]\.config\/id: Expected required property/);
    expect(await fails([acme({ id: 'x' })])).toBe('channels[0].config: acme needs ACME_TOKEN or a token');
    expect(await fails([acme({ id: 'x', token: 'a' }), acme({ id: 'x', token: 'b' })])).toBe('channels[1]: acme x has account default twice');
    expect(await fails([acme({}, { export: 'noEntry' })])).toMatch(/^channels\[0\] \(module .*chan-descriptor\.mjs\): the export is not a ChannelModule descriptor \(bad entry \(an object of schemas\)\)$/);
    expect(await fails([acme({}, { export: 'withConsole' })])).toMatch(/^channels\[0\] \(module .*\): bad admin\.console \(a module file's descriptor adds no console settings/);
    await expect(serve({ channels: [acme({ id: 'x', token: 'a' }, { export: 'noAdapter' })] })).rejects.toThrow(/^channels\[0\] \(module .*chan-descriptor\.mjs\): create did not return a built channel with a ChannelAdapter \(bad adapter\.caps\)$/);
    // Built without its file imported before the config resolved: the start says so (a descriptor is read only then).
    const f = file({ channels: [acme({ id: 'x', token: 'a' })] });
    const config = { ...resolveConfig(f.raw, { env: {}, baseDir: here, cwd: f.dir }), socketPath: join(f.dir, 'run', 'aio.sock') };
    await expect(Gateway.start({ config, harness: new FakeHarness(), logger: () => {}, listen: false })).rejects.toThrow(/^channels\[0\] \(module .*chan-descriptor\.mjs\): export "createChannel" \(or default\) is a ChannelModule descriptor, which is read when the config's module files are imported before it is resolved/);
  });

  it("the channels it builds get a state directory of their entry's module and export, under the module type's for their account, the same after a restart #RS-1", async () => {
    // Two descriptors (one file, two exports) on the default account; the first on a second account too.
    const f = file({ channels: [acme({ id: 'sd1', token: 'x' }), acme({ id: 'sd2', token: 'x' }, { export: 'second' }), acme({ id: 'sd1', token: 'x' }, { account: 'lan' })] });
    const start = async () => {
      ((globalThis as { __chanDescriptor?: DescriptorSeen }).__chanDescriptor ??= {}).stateDirs = {};
      const registries = await importConfigModules(f.raw, { baseDir: here });
      const config = { ...resolveConfig(f.raw, { env: {}, baseDir: here, cwd: f.dir, ...registries }), socketPath: join(f.dir, 'run', 'aio.sock') };
      const gw = await Gateway.start({ config, ...registries, buildHarness: (i: HarnessInstance) => new InstanceHarness(i, new FakeHarness()), logger: () => {}, listen: false });
      cleanups.push(() => gw.stop());
      return { gw, dirs: { ...descriptorSeen().stateDirs } };
    };
    const first = await start();
    const typeDir = (account: string) => join(f.dir, 'channels', `module.${account}`);
    const [d1, d2, lan] = [first.dirs['sd1:default']!, first.dirs['sd2:default']!, first.dirs['sd1:lan']!];
    expect([dirname(d1), dirname(d2)]).toEqual([typeDir('default'), typeDir('default')]);
    expect([basename(d1), basename(d2)]).toEqual([expect.stringMatching(/^[0-9a-f]{16}$/), expect.stringMatching(/^[0-9a-f]{16}$/)]);
    expect(d2).not.toBe(d1);
    expect(lan).toBe(join(typeDir('lan'), basename(d1)));
    await first.gw.stop();
    expect((await start()).dirs).toEqual(first.dirs);
  });

  it("a package's channel keeps its state directory when an upgrade moves the file its entry resolves to: the directory is named by the entry's module as written and export, not by that file #RS-1", async () => {
    const f = file({ channels: [{ type: 'module', module: 'acme-chan', config: { id: 'up1', token: 'x' } }] });
    const pkg = join(f.dir, 'node_modules', 'acme-chan');
    const versioned = pathToFileURL(join(here, 'fixtures', 'chan-versioned.mjs')).href;
    // Each version's file is in a directory named by it, as pnpm's real path is (config-modules.e2e.test.ts installs one so);
    // an import-only exports map, read afresh at each start (require would answer this process's first resolution again).
    const install = (version: string) => {
      mkdirSync(join(pkg, version), { recursive: true });
      writeFileSync(join(pkg, version, 'index.mjs'), `import { versioned } from ${JSON.stringify(versioned)};\nexport const createChannel = versioned(${JSON.stringify(version)});\n`);
      writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'acme-chan', version, type: 'module', exports: { '.': { import: `./${version}/index.mjs` } } }));
    };
    const start = async () => {
      ((globalThis as { __chanDescriptor?: DescriptorSeen }).__chanDescriptor ??= {}).stateDirs = {};
      const registries = await importConfigModules(f.raw, { baseDir: f.dir });
      const config = { ...resolveConfig(f.raw, { env: {}, baseDir: f.dir, cwd: f.dir, ...registries }), socketPath: join(f.dir, 'run', 'aio.sock') };
      const gw = await Gateway.start({ config, ...registries, buildHarness: (i: HarnessInstance) => new InstanceHarness(i, new FakeHarness()), logger: () => {}, listen: false });
      cleanups.push(() => gw.stop());
      return { gw, file: (config.channels[0] as { module: string }).module, dir: descriptorSeen().stateDirs!['up1:default']! };
    };
    install('1.0.0');
    const first = await start();
    await first.gw.stop();
    install('1.1.0');
    const second = await start();
    expect([first.file, second.file]).toEqual([join(pkg, '1.0.0', 'index.mjs'), join(pkg, '1.1.0', 'index.mjs')]);
    expect(second.dir).toBe(first.dir);
    expect(first.dir).toBe(join(f.dir, 'channels', 'module.default', createHash('sha256').update(JSON.stringify(['acme-chan', null])).digest('hex').slice(0, 16)));
    // What the first version left there is the second's.
    expect(readFileSync(join(first.dir, 'starts'), 'utf8')).toBe('1.0.0\n1.1.0\n');
  });

  it("its resolve cannot grant evidence: what it returns is the entry's config, the entry's own keys stay as written, and without a grant its platform_signed is capped to none #ID-3 #ID-4", async () => {
    const w = await serve({ channels: [acme({ id: 'acme3', token: 'x' }, { account: 'cap' })] });
    const entry = w.config.channels[0]!;
    expect(entry).toMatchObject({ type: 'module', account: 'cap', config: { evidence: ['platform_signed'], type: 'lark-bot' } });
    expect(entry).not.toHaveProperty('evidence');
    const r = await until(() => chanRec('acme3:cap')?.inject && chanRec('acme3:cap'));
    expect(await r.inject!({ id: 'cap-1', sender: { channelUserId: 'alice', evidence: 'platform_signed' }, text: 'hi' })).toMatchObject({ accepted: true });
    expect(w.gw.records.verify('channel:acme3/cap-1').records).toEqual([expect.objectContaining({ evidence: 'none', principal: null })]);
    expect(w.gw.adminStatus().channels.find((c) => c.id === 'acme3')).toMatchObject({ evidenceCapped: 1 });
  });

  it("its credentials are the console's: x-credential marks and isCredential under config redact and refuse literals (with its hint); GET /api/config lists the variables its implicitEnv names, marked implicit #SE-1", async () => {
    const f = file({ channels: [acme({ id: 'a', token: 'literal-token', pin: '1234', region: 'us' }), acme({ id: 'b', pin: 'env:ACME_PIN' })] });
    const { channelRegistry } = await importConfigModules(f.raw, { baseDir: here });
    const shown = redact(f.raw, channelRegistry) as { channels: { config: Record<string, unknown> }[] };
    expect(shown.channels[0]!.config).toEqual({ id: 'a', token: ADMIN_REDACTED, pin: ADMIN_REDACTED, region: 'us' });
    // Without its file imported the console knows nothing of its keys: only secret-looking names.
    expect((redact(f.raw, builtinChannels) as typeof shown).channels[0]!.config).toEqual({ id: 'a', token: ADMIN_REDACTED, pin: '1234', region: 'us' });
    const path = join(f.dir, 'aio.config.json');
    writeFileSync(path, JSON.stringify({ ...f.raw, channels: [acme({ id: 'b', pin: 'env:ACME_PIN' })] }), { mode: 0o600 });
    const store = new ConfigStore({ path, env: { ACME_PIN: '9' }, cwd: f.dir, channelRegistry });
    expect((await store.document()).env).toEqual([
      { name: 'ACME_PIN', set: true },
      { name: 'ACME_TOKEN', set: false, implicit: true },
    ]);
    const v = await store.validate({ ...f.raw, channels: [acme({ id: 'b', token: 'env:ACME_TOKEN', pin: '5678' })] });
    expect(v.issues).toContainEqual({ path: '/channels/0/config/pin', code: 'inline_secret', severity: 'error', message: 'an acme pin goes into the env file: write "env:ACME_PIN"' });
  });

  it('its admin routes are served after the core ones, with the same auth #SE-3 #PR-1', async () => {
    const w = await serve({ channels: [acme({ id: 'acme4', token: 'x' })] }, { console: true });
    const url = w.gw.console!.url;
    expect((await fetch(`${url}/api/acme/ping`)).status).toBe(401);
    const res = await fetch(`${url}/api/acme/ping`, { headers: { Authorization: `Bearer ${w.gw.token}` } });
    expect([res.status, await res.json()]).toEqual([200, { pong: true }]);
  });
});

describe('a use: "module" harness descriptor\'s declares and cli', () => {
  const full = (exp?: string, config?: Record<string, unknown>) => ({ use: 'module', module: './fixtures/harness-descriptor-full.mjs', ...(exp ? { export: exp } : {}), ...(config ? { config } : {}) });

  it("what it declares counts for its adapters where they say nothing themselves: /plan, /bypass and /compact work on it, its adapter's own display name wins #CT-2", async () => {
    const w = await serve({ harnesses: { plug: full() } }, { loadHarnesses: true });
    const plug = w.gw.harness('plug');
    expect([plug.displayName, plug.modes, plug.ownerProfileSwitch, plug.compact]).toEqual(['Own', ['plan'], true, { command: '/squash' }]);
    await w.say('hi', (r) => r === 'ok');
    expect(await w.say('/plan on')).toBe('Plan mode on from the next turn.');
    expect(await w.say('/bypass off')).toBe('Bypass off for owner turns from the next turn.');
    expect(await w.say('/compact', (r) => r.startsWith('Compacting'))).toBe('Compacting (queued behind anything running).');
    // Its adapter's own declaration wins over the descriptor's.
    const w2 = await serve({ harnesses: { plug: full(undefined, { members: { modes: [] } }) } }, { loadHarnesses: true });
    expect(w2.gw.harness('plug').modes).toEqual([]);
  });

  it('declarations of the wrong type, one that is none, one its adapter cannot honour, and commands the CLI cannot have (a bad name, not a function, a registered kind\'s, another instance\'s) fail the start, naming the instance and the member #CF-4', async () => {
    const start = (harnesses: Record<string, unknown>) => serve({ harnesses }, { loadHarnesses: true });
    const at = /^harnesses\.plug \(module .*harness-descriptor-full\.mjs\): /;
    await expect(start({ plug: full('badModes') })).rejects.toThrow(at);
    await expect(start({ plug: full('badModes') })).rejects.toThrow(/: bad declares\.modes \(an array of 'plan' when present\)$/);
    await expect(start({ plug: full('unknownDeclaration') })).rejects.toThrow(/: bad declares\.detach \(not a declaration: displayName, compact, modes, ownerProfileSwitch, ephemeralOpen, adopts, attach, sessionEnv\)$/);
    await expect(start({ plug: full('ownProcess') })).rejects.toThrow(/: create did not return a HarnessAdapter \(bad sessionEnv \('own-process' needs ownProcess\)\)$/);
    await expect(start({ plug: full('badCliName') })).rejects.toThrow(/: bad cli "Hello" \(a command name is lowercase letters, digits and -, starting with a letter\)$/);
    await expect(start({ plug: full('cliNotFn') })).rejects.toThrow(/: bad cli "acme-hello" \(a function\)$/);
    await expect(start({ plug: full('builtinCli') })).rejects.toThrow(/^harnesses\.plug \(module .*\): cli "tui-bridge": a registered harness kind adds it too$/);
    await expect(start({ plug: full(), other: full('otherHello') })).rejects.toThrow(/^harnesses\.other \(module .*\): cli "acme-hello": harnesses\.plug adds it too$/);
    // Two instances of one descriptor add one command.
    await start({ plug: full(), again: full() });
  });

  it("two descriptors declaring differently whose create returns one adapter: each instance reads as its own descriptor declares, and at stop that adapter gets each lifecycle call once #RS-2", async () => {
    const calls = (share: string) => (globalThis as { __sharedCalls?: Record<string, string[]> }).__sharedCalls?.[share];
    const w = await serve(
      {
        harnesses: {
          a: full('sharedPlan', { share: 'detaching', detach: true }),
          b: full('sharedCompact', { share: 'detaching', detach: true }),
          c: full('sharedPlan', { share: 'disposing' }),
          d: full('sharedCompact', { share: 'disposing' }),
        },
      },
      { loadHarnesses: true },
    );
    expect([w.gw.harness('a').modes, w.gw.harness('a').compact]).toEqual([['plan'], undefined]);
    expect([w.gw.harness('b').modes, w.gw.harness('b').compact]).toEqual([undefined, { command: '/squash' }]);
    await w.gw.stop();
    expect(calls('detaching')).toEqual(['detach']);
    expect(calls('disposing')).toEqual(['dispose']);
  });
});

describe('the console reads a document as the next start would: the module files it names imported first', () => {
  const fx = join(here, 'fixtures');
  const desc = join(fx, 'chan-descriptor.mjs');
  const feature = join(fx, 'feature-module.mjs');
  const acmeAt = (config: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ type: 'module', module: desc, config, ...extra });
  /** A console on a daemon started with `raw`, and a PUT of its file with `more` over it. */
  async function consoleOn(raw: Record<string, unknown>, o: { env?: Record<string, string>; live?: boolean; harnessRegistry?: HarnessRegistry } = {}) {
    const w = await serve(raw, { console: o.live ? { liveChannels: true } : true, env: o.env ?? {}, ...(o.harnessRegistry ? { harnessRegistry: o.harnessRegistry } : {}) });
    const put = async (more: Record<string, unknown>) => w.api('/api/config', { method: 'PUT', json: { config: { ...JSON.parse(readFileSync(w.configPath, 'utf8')), ...more } } });
    return { ...w, put };
  }

  it("a descriptor channel the daemon did not import at its start: PUT refuses a literal its descriptor marks (with its advice), GET redacts one in the file and lists the variables its implicitEnv names; a file the daemon did import, spelled another way, has the same marks #SE-1", async () => {
    const w = await consoleOn({});
    const r = await w.put({ channels: [acmeAt({ id: 'acme1', pin: 'p-secret' })] });
    expect(r.status).toBe(422);
    expect(r.body.issues).toContainEqual({ path: '/channels/0/config/pin', code: 'inline_secret', severity: 'error', message: 'an acme pin goes into the env file: write "env:ACME_PIN"' });
    // In the file (written by hand): GET shows its marks redacted, and what it reads without a reference.
    writeFileSync(w.configPath, JSON.stringify({ ...w.file.raw, console: { port: 0 }, channels: [acmeAt({ id: 'acme1', pin: 'p-secret' })] }), { mode: 0o600 });
    const shown = (await w.api('/api/config')).body;
    expect(shown.config.channels).toEqual([acmeAt({ id: 'acme1', pin: ADMIN_REDACTED })]);
    expect(JSON.stringify(shown)).not.toContain('p-secret');
    expect(shown.env).toContainEqual({ name: 'ACME_TOKEN', set: false, implicit: true });
    // The registries of a start that imported it: another spelling of its file is the same file.
    const started = await serve({ channels: [acmeAt({ id: 'acme2', token: 'x' })] });
    const other = { channels: [acmeAt({ id: 'acme3', pin: 'p-secret' }, { module: `${fx}/../fixtures/chan-descriptor.mjs` })] };
    expect((redact(other, started.registries.channelRegistry) as typeof other).channels[0]!.config).toEqual({ id: 'acme3', pin: ADMIN_REDACTED });
    expect(implicitEnv(other, started.registries.channelRegistry)).toEqual(['ACME_TOKEN']);
  });

  it("a descriptor file gone or resolving to another file since the start: GET still redacts what the start's descriptor marks in its entries (and what the new file's marks), and PUT of what GET shows keeps the stored values #SE-1", async () => {
    const d = tmp('aio-cm-marks-');
    const url = JSON.stringify(pathToFileURL(desc).href);
    // A file re-exporting the acme descriptor, removed after the start.
    const gone = join(d, 'gone.mjs');
    writeFileSync(gone, `export { createChannel } from ${url};\n`);
    // A package directory whose entry file becomes, after the start, one whose descriptor marks no pin.
    const pkg = join(d, 'acme-pkg');
    mkdirSync(pkg);
    writeFileSync(join(pkg, 'v1.mjs'), `export { createChannel } from ${url};\n`);
    writeFileSync(join(pkg, 'v2.mjs'), `import { createChannel as c } from ${url};\nexport const createChannel = { ...c, isCredential: undefined, credentialHint: undefined };\n`);
    const main = (v: string) => writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'acme-pkg', type: 'module', main: `${v}.mjs` }));
    main('v1');
    const w = await consoleOn({ channels: [acmeAt({ id: 'gone1', token: 'x', pin: 'p-gone' }, { module: gone }), acmeAt({ id: 'up1', token: 'x', pin: 'p-up' }, { module: pkg })] });
    rmSync(gone);
    main('v2');
    const shown = (await w.api('/api/config')).body;
    expect(shown.config.channels.map((c: { config: unknown }) => c.config)).toEqual([
      { id: 'gone1', token: ADMIN_REDACTED, pin: ADMIN_REDACTED },
      { id: 'up1', token: ADMIN_REDACTED, pin: ADMIN_REDACTED },
    ]);
    expect(JSON.stringify(shown)).not.toMatch(/p-gone|p-up/);
    // The next start would not find the first file: that is an issue of the document, not a reason to show what it marked.
    expect(shown.issues).toContainEqual(expect.objectContaining({ path: '/channels/0/module', severity: 'error' }));
    // The document as GET shows it written back, the missing file's entry pointed at a file that is there: the stored values stay.
    const [first, second] = shown.config.channels;
    const r = await w.api('/api/config', { method: 'PUT', json: { config: { ...shown.config, channels: [{ ...first, module: desc }, second] } } });
    expect(r.status).toBe(200);
    expect(JSON.parse(readFileSync(w.configPath, 'utf8')).channels).toEqual([acmeAt({ id: 'gone1', token: 'x', pin: 'p-gone' }), acmeAt({ id: 'up1', token: 'x', pin: 'p-up' }, { module: pkg })]);
  });

  it("PUT and validate refuse what the next start would refuse in module files the daemon did not import (a config a descriptor's or a manifest's schema refuses, an export that is no manifest), leaving the file; a right one is written, applied at the restart; a daemon importing no module files refuses a modules entry it lacks #CF-4", async () => {
    const w = await consoleOn({}, { env: { ACME_SECRET: 's' } });
    const before = readFileSync(w.configPath, 'utf8');
    const refused = async (more: Record<string, unknown>) => {
      const r = await w.put(more);
      expect(r.status).toBe(422);
      return r.body.issues as { path: string; code: string; message: string }[];
    };
    expect(await refused({ channels: [acmeAt({ id: 'acme1', token: 'env:ACME_SECRET', regoin: 'us' })] })).toContainEqual(
      expect.objectContaining({ code: 'invalid', message: expect.stringMatching(/^invalid config: channels\[0\]\.config\/regoin: Unexpected property/) }),
    );
    expect(await refused({ modules: [{ use: 'module', module: feature, config: { key: 'k', greting: 'typo' } }] })).toContainEqual(
      expect.objectContaining({ code: 'invalid', message: expect.stringMatching(/^invalid config: modules\[0\]\.config\/greting: Unexpected property/) }),
    );
    expect(await refused({ modules: [{ use: 'module', module: feature, export: 'notManifest' }] })).toContainEqual(
      expect.objectContaining({ path: '/modules/0', code: 'invalid', message: expect.stringMatching(/^modules\[0\] \(module .*feature-module\.mjs\): export "notManifest" is not a module manifest/) }),
    );
    expect(readFileSync(w.configPath, 'utf8')).toBe(before);
    const ok = await w.put({ modules: [{ use: 'module', module: feature, config: { key: 'k' } }], channels: [acmeAt({ id: 'acme1', token: 'env:ACME_SECRET' })] });
    expect([ok.status, ok.body.applied]).toEqual([200, 'restart']);
    // Without the import (a daemon given registries only): the start would refuse the entry, so does the console.
    const store = new ConfigStore({ path: w.configPath, env: { ACME_SECRET: 's' }, cwd: w.file.dir });
    expect((await store.validate(JSON.parse(readFileSync(w.configPath, 'utf8')))).issues).toContainEqual({
      path: '/modules/0',
      code: 'invalid',
      severity: 'error',
      message: expect.stringMatching(/^modules\[0\] \(module .*feature-module\.mjs\) is not loaded: this daemon imports no module files of its config, so it would not start on this file$/),
    });
  });

  it("PUT and validate refuse a descriptor whose admin route a harness kind of the daemon contributes too, naming the entry (422, the file left), as the next start's import would (a ConfigError); one adding no admin route is written #CF-4", async () => {
    // A harness kind of the daemon's contributing the descriptor's route (GET /api/acme/ping): the console serves the routes of both.
    const ping: HarnessModule = {
      kind: 'pinger',
      schema: Type.Object({}),
      create: () => new FakeHarness(),
      admin: { routes: [{ method: 'GET', path: '/api/acme/ping', status: 200, response: Type.Object({ pong: Type.Boolean() }), handle: () => ({ status: 200, body: { pong: false } }) }] },
    };
    const harnessRegistry = new HarnessRegistry([...builtinHarnesses.modules, ping]);
    const w = await consoleOn({}, { env: { ACME_SECRET: 's' }, harnessRegistry });
    const before = readFileSync(w.configPath, 'utf8');
    const clash = /^channels\[0\] \(module .*chan-descriptor\.mjs\): channel type "module" and harness kind "pinger" both contribute admin route GET \/api\/acme\/ping$/;
    const issue = { path: '/channels/0', code: 'invalid', severity: 'error', message: expect.stringMatching(clash) };
    const doc = { ...JSON.parse(before), channels: [acmeAt({ id: 'acme1', token: 'env:ACME_SECRET' })] };
    const r = await w.put({ channels: doc.channels });
    expect(r.status).toBe(422);
    expect(r.body).toEqual({ valid: false, issues: [issue] });
    expect(await w.api('/api/config/validate', { method: 'POST', json: { config: doc } })).toEqual({ status: 200, body: { valid: false, issues: [issue] } });
    expect(readFileSync(w.configPath, 'utf8')).toBe(before);
    // Against the harness kinds the store reads the file with, whichever ones its import was made over.
    const store = new ConfigStore({ path: w.configPath, env: { ACME_SECRET: 's' }, cwd: w.file.dir, harnessRegistry, importModules: (await importConfigModules({}, { baseDir: here })).importModules });
    expect(await store.validate(doc)).toEqual({ valid: false, issues: [issue] });
    // The next start's import refuses it the same way: a config error naming the entry (aio serve: exit 2).
    const failed = await importConfigModules(doc, { baseDir: here, harnessRegistry }).catch((e: Error) => e);
    expect(failed).toBeInstanceOf(ConfigError);
    expect((failed as Error).message).toMatch(clash);
    // The same descriptor without its admin route (export `second`) is fine.
    const ok = await w.put({ channels: [acmeAt({ id: 'acme1', token: 'env:ACME_SECRET' }, { export: 'second' })] });
    expect([ok.status, ok.body.applied]).toEqual([200, 'restart']);
  });

  it("with liveChannels, descriptor channels added through the console are imported and started at once; one whose descriptor adds admin routes the console did not mount at the start fails until a restart, and the file does not count as applied #CF-2", async () => {
    const acme0 = acmeAt({ id: 'acme0', token: 'env:ACME_SECRET' });
    const w = await consoleOn({ channels: [acme0] }, { env: { ACME_SECRET: 's' }, live: true });
    const added = [acmeAt({ id: 'live1', token: 'env:ACME_SECRET' }, { export: 'second' }), acmeAt({ id: 'live2', token: 'env:ACME_SECRET' }, { account: 'lan' })];
    const r = await w.put({ channels: [acme0, ...added] });
    expect([r.status, r.body.applied, r.body.channels]).toEqual([200, 'live', { started: [{ type: 'module', account: 'default' }, { type: 'module', account: 'lan' }], stopped: [] }]);
    expect((await until(() => chanRec('live1:default')?.inject && chanRec('live1:default'))).via).toBe('descriptor');
    expect((await until(() => chanRec('live2:lan')?.inject && chanRec('live2:lan'))).via).toBe('descriptor');
    // Another admin route than the start's: not served until a restart, so not started.
    const r2 = await w.put({ channels: [acme0, ...added, acmeAt({ id: 'live3', token: 'env:ACME_SECRET' }, { export: 'otherAdmin' })] });
    expect([r2.status, r2.body.applied, r2.body.channels]).toEqual([
      200,
      'restart',
      { started: [], stopped: [], failed: [{ type: 'module', account: 'default', error: "channels[3]: its module file's descriptor adds admin routes, which the console mounts when the daemon starts: restart the daemon to run it" }] },
    ]);
    expect(chanRec('live3:default')).toBeUndefined();
    expect((await w.api('/api/acme/pong')).status).toBe(404);
  });
});
