import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Type } from '@sinclair/typebox';
import { describe, expect, it } from 'vitest';
import type { HarnessModule, HarnessModuleInit } from '@agents-io/protocol';
import { FakeChannel, FakeHarness } from '@agents-io/testkit';
import { ConfigError, type HarnessInstance, HarnessRegistry, LocalClient } from '@agents-io/kernel';
import { buildHarness, ConfigFile, configFileSchema, Gateway, resolveConfig } from '../src/defaults.js';
import { builtinHarnesses } from '../src/bundle.js';
import { cleanups, tmp, until } from './helpers.js';

/*
 * Harness kinds come from a registry (`HarnessModule`s; bundle.ts registers Claude Code and Codex):
 * the config's `use`, the kind's keys, defaults and cross-instance rules, and how the gateway builds
 * an instance's adapter. A deployment may register its own kinds; then the built-in ones are unknown.
 */

const here = dirname(fileURLToPath(import.meta.url));
type EchoLaunch = { greeting: string };
const created: HarnessModuleInit<EchoLaunch>[] = [];
const fakes: FakeHarness[] = [];

const echo: HarnessModule<EchoLaunch> = {
  kind: 'echo',
  schema: Type.Object({ greeting: Type.Optional(Type.String()), home: Type.Optional(Type.String()) }),
  defaults: { model: 'echo-1', modelEnv: 'ECHO_MODEL', configDirEnv: ['ECHO_HOME'] },
  declares: { displayName: 'Echo' },
  legacy: { schema: Type.Object({ greeting: Type.Optional(Type.String()) }), envPrefixes: ['ECHO_'], resolve: (s) => ({ greeting: (s.greeting as string | undefined) ?? 'hello' }) },
  resolve: (entry, ctx) => {
    if (entry.home !== undefined && 'ECHO_HOME' in ctx.env) ctx.fail(`${ctx.where}: set \`home\` or env.ECHO_HOME, not both`);
    return { launch: { greeting: (entry.greeting as string | undefined) ?? 'hello' } };
  },
  checkAll: (all) => {
    const seen = new Map<string, string>();
    for (const i of all) {
      const other = seen.get(i.launch.greeting);
      if (other) return `harnesses ${other} and ${i.name} greet alike`;
      seen.set(i.launch.greeting, i.name);
    }
    return undefined;
  },
  create: (init) => {
    created.push(init);
    const fake = new FakeHarness(async (t) => t.emit({ t: 'text.snapshot', text: init.launch.greeting, final: true }, { audience: 'answer' }), `echo-${init.name}`);
    fakes.push(fake);
    return fake;
  },
};
const registry = new HarnessRegistry([echo]);
const resolve = (raw: unknown, extra: Record<string, unknown> = {}, env: Record<string, string> = {}) => resolveConfig(raw, { env, baseDir: '/base', cwd: '/work', harnessRegistry: registry, ...extra });
const message = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    expect(e).toBeInstanceOf(ConfigError);
    return (e as Error).message;
  }
  throw new Error('no error');
};

describe('harness registry', () => {
  it('the built-in registry is Claude Code then Codex, the bridge and ACP, and ConfigFile is its schema', () => {
    expect(builtinHarnesses.kinds).toEqual(['claude-code', 'codex', 'bridge', 'acp']);
    expect(builtinHarnesses.defaultKind).toBe('claude-code');
    expect(builtinHarnesses.configDirKeys()).toEqual(['CLAUDE_CONFIG_DIR', 'CODEX_HOME']);
    expect(configFileSchema(builtinHarnesses)).toBe(ConfigFile);
    expect(configFileSchema(registry)).toBe(configFileSchema(registry));
    expect(() => new HarnessRegistry([{ ...echo, kind: 'module' }])).toThrow(/"module" is the host's own/);
    expect(() => new HarnessRegistry([echo, echo])).toThrow('harness kind "echo" is registered twice');
  });

  it("a registered kind's entries: its keys, defaults, model env, legacy section and cross-instance rules; other kinds are unknown", () => {
    const c = resolve({ harnesses: { a: { use: 'echo', greeting: 'hi', profiles: { p: { x: 1 } } }, b: { use: 'echo' } } }, {}, { ECHO_MODEL: 'echo-env' });
    expect(c.harnesses.a).toMatchObject({ kind: 'echo', launch: { greeting: 'hi' }, run: { harness: 'a', model: 'echo-env' }, profiles: { p: { x: 1 } } });
    expect(c.harnesses.b).toMatchObject({ kind: 'echo', launch: { greeting: 'hello' }, run: { harness: 'b', model: 'echo-1' } });
    expect(message(() => resolve({ harnesses: { a: { use: 'echo', colour: 'red' } } }))).toMatch(/^invalid config: harnesses\.a\/colour: Unexpected property/);
    expect(message(() => resolve({ harnesses: { a: { use: 'codex' } } }))).toMatch(/^invalid config: \/harnesses\/a\/use/);
    expect(message(() => resolve({ harnesses: { a: { use: 'echo', home: '/h', env: { ECHO_HOME: '/h2' } } } }))).toBe('harnesses.a: set `home` or env.ECHO_HOME, not both');
    expect(message(() => resolve({ harnesses: { a: { use: 'echo', greeting: 'x' }, b: { use: 'echo', greeting: 'x' } } }))).toBe('harnesses a and b greet alike');
    // The older block and an empty config: the first registered kind, its legacy env prefixes.
    const legacy = resolve({ harness: { echo: { greeting: 'yo' } } }, { fileEnv: { ECHO_X: '1', HTTP_PROXY: 'p', ANTHROPIC_BASE_URL: 'no' } });
    expect(legacy.harnesses.echo).toMatchObject({ kind: 'echo', launch: { greeting: 'yo' }, env: { ECHO_X: '1', HTTP_PROXY: 'p' } });
    expect(Object.keys(legacy.harnesses.echo!.env)).toEqual(['ECHO_X', 'HTTP_PROXY']);
    expect(resolve({}).defaultHarness).toBe('echo');
    expect(message(() => resolve({ harness: { 'claude-code': {} } }))).toMatch(/^invalid config: \/harness\/claude-code: Unexpected property/);
    // --harness by kind, and the kind's config-dir variables in sessionParams.
    expect(resolve({ harnesses: { x: { use: 'module', module: './fixtures/harness-caps.mjs' } } }, { harness: 'echo', baseDir: here }).harnesses.echo).toMatchObject({ kind: 'echo', launch: { greeting: 'hello' }, env: {} });
    expect(message(() => resolve({ agents: { d: { harness: 'echo', sessionParams: { cwdRoots: [], envKeys: ['ECHO_HOME'] } } } }))).toMatch(/ECHO_HOME is in envKeys, so envPathRoots\.ECHO_HOME/);
    expect(resolve({ agents: { d: { harness: 'echo', sessionParams: { cwdRoots: [], envKeys: ['CODEX_HOME'] } } } }).agents.d!.sessionParams!.envKeys).toEqual(['CODEX_HOME']);
  });

  it("the gateway builds a registered kind's instances with its module: create gets the launch, env and profiles; replies name the kind", async () => {
    const dir = tmp();
    mkdirSync(join(dir, 'work'), { recursive: true });
    const raw = { dataDir: dir, policy: { owners: ['fake:alice'] }, local: { principal: 'fake:alice' }, cwd: join(dir, 'work'), harnesses: { e: { use: 'echo', greeting: 'hey', env: { E: '1' }, profiles: { p: { x: 1 } } } } };
    const config = { ...resolveConfig(raw, { env: {}, baseDir: dir, cwd: dir, harnessRegistry: registry }), socketPath: join(dir, 'run', 'aio.sock') };
    const chat = new FakeChannel('fake');
    const gw = await Gateway.start({ config, harnessRegistry: registry, channels: [{ adapter: chat }], logger: () => {} });
    cleanups.push(() => gw.stop());
    const init = created.at(-1)!;
    expect(init).toMatchObject({ name: 'e', config: undefined, launch: { greeting: 'hey' }, env: { E: '1' }, profiles: { p: { x: 1 } } });
    expect(typeof init.blobs?.stat).toBe('function');
    const c = await LocalClient.connect(config.socketPath);
    cleanups.push(() => c.close());
    await c.input('s', 'hi');
    await until(() => gw.hub.log.read('s', 0).some((e) => e.body.t === 'turn.completed'));
    expect(fakes.at(-1)!.sessions[0]!.args.run).toMatchObject({ harness: 'e', model: 'echo-1' });
    // Not profilesInOpen: the kind took the profiles at create.
    expect(fakes.at(-1)!.sessions[0]!.args.options).not.toHaveProperty('profiles');
    // No configured instance and no registered kind declares the owner's profile switch.
    const say = async (text: string) => {
      const before = chat.sent.length;
      await chat.inject({ conversation: { id: 'c', kind: 'dm' }, sender: { channelUserId: 'alice', evidence: 'platform_signed' }, text });
      return until(() => chat.sent.slice(before).map((x) => x.edits.at(-1)?.text ?? x.msg.text).find((t) => t !== undefined));
    };
    expect(await say('/bypass')).toBe('/bypass is not available on any harness configured here (this session runs echo).');
  });

  it('deprecated, for one release: a resolved instance keeps its launch under the old field (`claude`, `codex`, `module`), read and written through to `launch`, not enumerable', () => {
    type Aliased = HarnessInstance & Record<string, unknown>;
    expect([builtinHarnesses.launchAlias('claude-code'), builtinHarnesses.launchAlias('codex')]).toEqual(['claude', 'codex']);
    const c = resolveConfig(
      { harnesses: { cc: { use: 'claude-code', executable: '/opt/claude' }, cx: { use: 'codex' }, m: { use: 'module', module: './fixtures/harness-caps.mjs' } } },
      { env: {}, baseDir: here, cwd: '/work' },
    );
    const cc = c.harnesses.cc as Aliased;
    expect(cc.claude).toBe(cc.launch);
    expect((c.harnesses.cx as Aliased).codex).toBe(c.harnesses.cx!.launch);
    expect((c.harnesses.m as Aliased).module).toBe(c.harnesses.m!.launch);
    expect(Object.keys(cc)).not.toContain('claude');
    expect(JSON.parse(JSON.stringify(cc))).not.toHaveProperty('claude');
    expect({ ...cc }).not.toHaveProperty('claude');
    cc.claude = { ...(cc.claude as object), claudePath: '/x/claude' };
    expect(cc.launch).toEqual({ claudePath: '/x/claude' });
    // The older block's instances and one --harness made for its kind have it too.
    const legacy = resolveConfig({ harness: { 'claude-code': { claudePath: '/opt/c' } } }, { env: {}, baseDir: '/base', cwd: '/work', harness: 'codex' });
    expect((legacy.harnesses['claude-code'] as Aliased).claude).toEqual({ claudePath: '/opt/c' });
    expect((legacy.harnesses.codex as Aliased).codex).toBe(legacy.harnesses.codex!.launch);
    // A write through the alias is what buildHarness builds with.
    const aliased = new HarnessRegistry([echo], { launchAliases: { echo: 'say' } });
    const e = resolveConfig({ harnesses: { e: { use: 'echo', greeting: 'hi' } } }, { env: {}, baseDir: '/base', cwd: '/work', harnessRegistry: aliased }).harnesses.e as Aliased;
    expect(e.say).toEqual({ greeting: 'hi' });
    e.say = { greeting: 'set' };
    buildHarness(e, undefined, { registry: aliased });
    expect(created.at(-1)!.launch).toEqual({ greeting: 'set' });
    // A kind's alias is never another field, nor for an unregistered kind; other registries have none.
    expect(registry.launchAlias('echo')).toBeUndefined();
    expect(() => new HarnessRegistry([echo], { launchAliases: { other: 'x' } })).toThrow('launchAliases: harness kind "other" is not registered');
    expect(() => new HarnessRegistry([echo], { launchAliases: { echo: 'env' } })).toThrow('launchAliases: "env" is a HarnessInstance field');
  });

  it('a kind may add commands to the CLI (`HarnessModule.cli`, Claude Code: `tui-bridge`), looked up by name; a bad name, a value that is not a function and a name two kinds add are refused', () => {
    expect(builtinHarnesses.cliCommand('tui-bridge')).toBeTypeOf('function');
    expect(builtinHarnesses.cliCommand('serve')).toBeUndefined();
    const run = async () => 0;
    const r = new HarnessRegistry([{ ...echo, cli: { 'echo-helper': run } }]);
    expect(r.cliCommand('echo-helper')).toBe(run);
    expect(r.cliCommand('tui-bridge')).toBeUndefined();
    expect(() => new HarnessRegistry([{ ...echo, cli: { Echo: run } }])).toThrow('harness kind "echo": cli "Echo": a command name is lowercase letters, digits and -, starting with a letter');
    expect(() => new HarnessRegistry([{ ...echo, cli: { 'echo-helper': 'run' as never } }])).toThrow('harness kind "echo": cli "echo-helper" is not a function');
    expect(() => new HarnessRegistry([{ ...echo, cli: { 'echo-helper': run } }, { ...echo, kind: 'echo2', cli: { 'echo-helper': run } }])).toThrow('harness kind "echo2": cli "echo-helper": harness kind "echo" adds it too');
  });
});
