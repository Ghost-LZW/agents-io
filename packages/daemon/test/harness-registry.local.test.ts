import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Type } from '@sinclair/typebox';
import { describe, expect, it } from 'vitest';
import type { HarnessModule, HarnessModuleInit } from '@agents-io/protocol';
import { FakeChannel, FakeHarness } from '@agents-io/testkit';
import { LocalClient } from '../src/client.js';
import { ConfigError, configFileSchema, ConfigFile, resolveConfig } from '../src/config.js';
import { builtinHarnesses } from '../src/bundle.js';
import { Gateway } from '../src/gateway.js';
import { HarnessRegistry } from '../src/harness-registry.js';
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
  it('the built-in registry is Claude Code then Codex, and ConfigFile is its schema', () => {
    expect(builtinHarnesses.kinds).toEqual(['claude-code', 'codex']);
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
});
