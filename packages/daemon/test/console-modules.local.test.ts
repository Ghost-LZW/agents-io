import { join } from 'node:path';
import { Type, type TObject } from '@sinclair/typebox';
import { describe, expect, it } from 'vitest';
import type { AdminContribution, AdminRoute, ChannelModule, HarnessModule } from '@agents-io/protocol';
import { bridgeChannelModule } from '@agents-io/channel-jsonl-bridge';
import { CREATE_LARK_BOT, larkBotChannelModule } from '@agents-io/channel-lark-bot';
import { mailChannelModule } from '@agents-io/channel-mail';
import { FakeChannel, FakeHarness } from '@agents-io/testkit';
import { builtinChannels, builtinHarnesses, CREATE_LARK_BOT as DEPRECATED_CREATE_LARK_BOT } from '../src/bundle.js';
import { ChannelRegistry, ConfigError, consoleSettings, type HarnessInstance, HarnessRegistry } from '@agents-io/kernel';
import { ConfigFile, configFileSchema, Gateway, InstanceHarness, resolveConfig } from '../src/defaults.js';
import { cleanups, tmp } from './helpers.js';

/*
 * What channel types and harness kinds contribute to the console (`ChannelModule.admin`,
 * `HarnessModule.admin`): the registries check it, config.ts merges the settings into the closed
 * `console` section, the gateway mounts it.
 */

const route = (over: Partial<AdminRoute> = {}): AdminRoute => ({ method: 'GET', path: '/api/notes/:id', status: 200, response: Type.Object({}), handle: () => ({ status: 200, body: {} }), ...over });
const notes = (admin: AdminContribution, type = 'notes'): ChannelModule => ({ type, entry: {}, resolve: (e) => e, create: () => ({ adapter: new FakeChannel(type) }), admin });
const notebook = (admin: AdminContribution, kind = 'notebook'): HarnessModule => ({ kind, schema: Type.Object({}), create: () => new FakeHarness(), admin });

describe('the registry checks admin contributions', () => {
  it('refuses members that are not an AdminContribution\'s, naming the type and the member', () => {
    const cases: [unknown, string][] = [
      ['routes', 'admin (an object when present)'],
      [{ console: { limit: 3 } }, 'admin.console (an object of schemas when present)'],
      [{ schemas: [] }, 'admin.schemas (an object of schemas when present)'],
      [{ mount: true }, 'admin.mount (a function when present)'],
      [{ routes: route() }, 'admin.routes (an array when present)'],
      [{ routes: [route(), 'x'] }, 'admin.routes[1] (an object)'],
      [{ routes: [route({ method: 'DELETE' as 'GET' })] }, 'admin.routes[0].method (GET, PUT or POST)'],
      [{ routes: [route({ path: '/notes/:id' })] }, 'admin.routes[0].path (a path under /api/)'],
      [{ routes: [route({ status: 201 as 200 })] }, 'admin.routes[0].status (200 or 202)'],
      [{ routes: [route({ response: undefined as never })] }, 'admin.routes[0].response (a schema)'],
      [{ routes: [route({ body: 'json' as never })] }, 'admin.routes[0].body (a schema when present)'],
      [{ routes: [route({ public: true })] }, 'admin.routes[0].public (a module route always needs credentials)'],
      [{ routes: [route({ handle: undefined as never })] }, 'admin.routes[0].handle (a function)'],
    ];
    for (const [admin, what] of cases) expect(() => new ChannelRegistry([notes(admin as AdminContribution)]), what).toThrow(`channel type "notes": bad ${what}`);
    expect(new ChannelRegistry([notes({ routes: [route()], console: {}, schemas: {} })]).adminContributions).toHaveLength(1);
  });

  it('a route, a console setting or a schema belongs to one type; a core endpoint or console key to the console', () => {
    expect(() => new ChannelRegistry([notes({ routes: [route({ path: '/api/status' })] })])).toThrow('channel type "notes": admin route GET /api/status is the console\'s own');
    // Parameter names do not make another route.
    expect(() => new ChannelRegistry([notes({ routes: [route({ path: '/api/explain/:id' })] })])).toThrow('channel type "notes": admin route GET /api/explain/:id is the console\'s own');
    expect(() => new ChannelRegistry([notes({ routes: [route()] }), notes({ routes: [route({ path: '/api/notes/:key' })] }, 'more')])).toThrow('channel types "notes" and "more" both contribute admin route GET /api/notes/:key');
    expect(() => new ChannelRegistry([larkBotChannelModule, notes({ console: { larkBotCommand: Type.String() } })])).toThrow('channel types "lark-bot" and "notes" both contribute admin setting console.larkBotCommand');
    expect(() => new ChannelRegistry([larkBotChannelModule, notes({ schemas: { AdminLarkBotJob: Type.Object({}) } })])).toThrow('channel types "lark-bot" and "notes" both contribute admin schema AdminLarkBotJob');
    // Another method on the same path is another route.
    expect(new ChannelRegistry([notes({ routes: [route(), route({ method: 'POST' })] })]).adminContributions[0]!.admin.routes).toHaveLength(2);
    // The console's own keys are config.ts's to check, when it builds the section.
    const own = new ChannelRegistry([notes({ console: { port: Type.Integer() } })]);
    expect(() => configFileSchema(builtinHarnesses, own)).toThrow('channel type "notes": admin setting console.port is the console\'s own');
    expect(builtinChannels.adminContributions.map((c) => c.type)).toEqual(['lark-bot']);
  });
});

describe('the harness registry checks admin contributions too', () => {
  it('refuses members that are not an AdminContribution\'s, naming the kind and the member', () => {
    expect(() => new HarnessRegistry([notebook('routes' as never)])).toThrow('harness kind "notebook": bad admin (an object when present)');
    expect(() => new HarnessRegistry([notebook({ routes: [route({ public: true })] })])).toThrow('harness kind "notebook": bad admin.routes[0].public (a module route always needs credentials)');
    expect(() => new HarnessRegistry([notebook({ mount: true as never })])).toThrow('harness kind "notebook": bad admin.mount (a function when present)');
    expect(new HarnessRegistry([notebook({ routes: [route()] }), notebook({}, 'other')]).adminContributions.map((c) => c.kind)).toEqual(['notebook', 'other']);
    expect(builtinHarnesses.adminContributions).toEqual([]);
  });

  it('a route, a console setting or a schema belongs to one kind or type, across the two registries; a core endpoint or console key to the console', () => {
    expect(() => new HarnessRegistry([notebook({ routes: [route({ path: '/api/status' })] })])).toThrow('harness kind "notebook": admin route GET /api/status is the console\'s own');
    expect(() => new HarnessRegistry([notebook({ routes: [route()] }), notebook({ routes: [route({ path: '/api/notes/:key' })] }, 'more')])).toThrow('harness kinds "notebook" and "more" both contribute admin route GET /api/notes/:key');
    // Against the channel types' where both registries meet: the config file schema (and the gateway's console).
    const lark = (admin: AdminContribution) => () => configFileSchema(new HarnessRegistry([notebook(admin)]), builtinChannels);
    expect(lark({ console: { larkBotCommand: Type.String() } })).toThrow('channel type "lark-bot" and harness kind "notebook" both contribute admin setting console.larkBotCommand');
    expect(lark({ routes: [route({ method: 'POST', path: '/api/bots/lark' })] })).toThrow('channel type "lark-bot" and harness kind "notebook" both contribute admin route POST /api/bots/lark');
    expect(lark({ schemas: { AdminLarkBotJob: Type.Object({}) } })).toThrow('channel type "lark-bot" and harness kind "notebook" both contribute admin schema AdminLarkBotJob');
    expect(() => configFileSchema(new HarnessRegistry([notebook({ console: { port: Type.Integer() } })]))).toThrow('harness kind "notebook": admin setting console.port is the console\'s own');
  });

  it('its settings join the console section after the channel types\'', () => {
    const base = { env: {}, baseDir: '/base', cwd: '/work' };
    const harnesses = new HarnessRegistry([notebook({ console: { notebookPages: Type.Integer({ default: 10 }) } })]);
    const keys = Object.keys(((configFileSchema(harnesses, builtinChannels).properties.console as TObject).properties));
    expect(keys.slice(-3)).toEqual(['larkBotCommand', 'notebookPages', 'liveChannels']);
    expect(resolveConfig({}, { ...base, harnessRegistry: harnesses }).console).toMatchObject({ notebookPages: 10 });
    expect(resolveConfig({ console: { notebookPages: 3 } }, { ...base, harnessRegistry: harnesses }).console).toMatchObject({ notebookPages: 3 });
    expect(() => resolveConfig({ console: { notebookPages: 'x' } }, { ...base, harnessRegistry: harnesses })).toThrow(/invalid config: .*console/);
  });
});

describe('the console section takes the registered types\' settings', () => {
  const base = { env: {}, baseDir: '/base', cwd: '/work' };
  const section = (s: TObject) => Object.keys((s.properties.console as TObject).properties);

  it('lark-bot\'s larkBotCommand: where it always was, default the pinned create-lark-bot; another registry\'s section has its own types\' settings only', () => {
    const own = ['enabled', 'host', 'port', 'allowRemote', 'allowedHosts', 'origins', 'uiUrl', 'sessionTtlMs', 'heartbeat'];
    expect(section(ConfigFile)).toEqual([...own, 'larkBotCommand', 'liveChannels']);
    expect(resolveConfig({}, base).console.larkBotCommand).toEqual(['npx', '-y', 'github:Ghost-LZW/create-lark-bot#v0.2.4']);
    expect(resolveConfig({}, base).console.larkBotCommand).not.toBe(CREATE_LARK_BOT);
    expect(DEPRECATED_CREATE_LARK_BOT).toBe(CREATE_LARK_BOT);
    expect(Object.keys(resolveConfig({ console: { uiUrl: 'http://ui' } }, base).console)).toEqual(['enabled', 'host', 'port', 'allowRemote', 'allowedHosts', 'origins', 'uiUrl', 'sessionTtlMs', 'larkBotCommand', 'heartbeat', 'liveChannels']);
    expect(resolveConfig({ console: { larkBotCommand: ['node', 'clb.js'] } }, base).console.larkBotCommand).toEqual(['node', 'clb.js']);
    expect(() => resolveConfig({ console: { larkBotCommand: [] } }, base)).toThrow(ConfigError);

    const plain = new ChannelRegistry([mailChannelModule, bridgeChannelModule]);
    expect(section(configFileSchema(builtinHarnesses, plain))).toEqual([...own, 'liveChannels']);
    expect(() => resolveConfig({ console: { larkBotCommand: ['x'] } }, { ...base, channelRegistry: plain })).toThrow(/invalid config: .*console/);
    expect(resolveConfig({}, { ...base, channelRegistry: plain }).console.larkBotCommand).toBeUndefined();
    const mine = new ChannelRegistry([notes({ console: { notesLimit: Type.Integer({ default: 3 }), notesTitle: Type.String() } })]);
    expect(section(configFileSchema(builtinHarnesses, mine))).toEqual([...own, 'notesLimit', 'notesTitle', 'liveChannels']);
    expect(resolveConfig({ console: { notesTitle: 'N' } }, { ...base, channelRegistry: mine }).console).toMatchObject({ notesLimit: 3, notesTitle: 'N' });
  });

  it('consoleSettings: the value written, else a copy of the schema default, else left out', () => {
    const keys = { a: Type.Array(Type.String(), { default: ['x'] }), b: Type.String(), c: Type.Number() };
    const got = consoleSettings({ b: 'y', other: 1 }, keys);
    expect(got).toEqual({ a: ['x'], b: 'y' });
    expect(got.a).not.toBe(keys.a.default);
    expect(consoleSettings(undefined, undefined)).toEqual({});
  });
});

describe('lark-bot\'s console part', () => {
  it('without a config file there is nothing to add a bot to: 404 as before, and no jobs', async () => {
    const dir = tmp('aio-cmod-');
    const config = resolveConfig({ dataDir: dir, local: { principal: 'me' }, cwd: dir, console: { port: 0 } }, { env: {}, baseDir: dir, cwd: dir });
    const gw = await Gateway.start({ config: { ...config, socketPath: join(dir, 'run', 'aio.sock') }, buildHarness: (i: HarnessInstance) => new InstanceHarness(i, new FakeHarness()), logger: () => {}, console: true, consoleEnv: {} });
    cleanups.push(() => gw.stop());
    const api = async (path: string, init: RequestInit = {}) => {
      const r = await fetch(gw.console!.url + path, { ...init, headers: { Authorization: `Bearer ${gw.token}`, 'Content-Type': 'application/json' } });
      return { status: r.status, body: await r.json() };
    };
    expect(await api('/api/bots/lark', { method: 'POST', body: JSON.stringify({ name: 'Bot' }) })).toEqual({ status: 404, body: { error: { code: 'not_found', message: 'bot provisioning needs a config file' } } });
    expect(await api('/api/bots/lark/lark_x')).toEqual({ status: 404, body: { error: { code: 'not_found', message: 'bot provisioning needs a config file' } } });
    expect(await api('/api/config')).toMatchObject({ status: 404, body: { error: { message: 'this daemon was started without a config file' } } });
  });
});
