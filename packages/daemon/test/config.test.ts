import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { launchFlags } from '@agents-io/harness-codex';
import { ConfigError, defaultInstance, findEnvFile, loadConfig, resolveConfig } from '../src/config.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'aio-cfg-'));
  dirs.push(d);
  return d;
};
const resolve = (raw: unknown, env: Record<string, string> = {}, extra = {}) => resolveConfig(raw, { env, baseDir: '/base', cwd: '/work', ...extra });

describe('config', () => {
  it('named instances: clear errors that never echo values #SE-1', () => {
    const bad = (raw: unknown, env: Record<string, string> = {}) => {
      try {
        resolve(raw, env);
      } catch (e) {
        expect(e).toBeInstanceOf(ConfigError);
        expect((e as Error).message).not.toContain('SECRET-VALUE');
        return (e as Error).message;
      }
      throw new Error('no error');
    };
    expect(bad({ harnesses: { a: { use: 'claude-code', home: '/x' } } })).toMatch(/harnesses\.a.*home/);
    expect(bad({ harnesses: { a: { use: 'codex', configDir: '/x' } } })).toMatch(/harnesses\.a.*configDir/);
    expect(bad({ harnesses: { a: { use: 'gpt' } } })).toMatch(/invalid config/);
    // A missing env ref only makes that instance unavailable (the gateway refuses to build it), naming the variable.
    const m = resolve({ harnesses: { a: { use: 'claude-code' }, b: { use: 'claude-code', env: { K: 'env:MISSING' }, mcpServers: { x: { headers: { h: 'env:ALSO' } } } } } });
    expect(m.harnesses.a!.unavailable).toBeUndefined();
    expect(m.harnesses.b!.unavailable).toBe('harnesses.b.env.K: environment variable MISSING is not set');
    expect(bad({ harnesses: { a: { use: 'claude-code', env: { K: 3 } } } }, { X: 'SECRET-VALUE' })).toMatch(/harnesses\.a\/env\/K/);
    expect(bad({ harnesses: { 'a/b': { use: 'claude-code' } } })).toMatch(/instance names/);
    expect(bad({ harnesses: {} })).toMatch(/empty/);
    expect(bad({ harnesses: { a: { use: 'codex' } }, defaultHarness: 'z' })).toMatch(/defaultHarness "z" is not one of the harnesses \(a\)/);
    expect(bad({ harnesses: { a: { use: 'codex' } }, harness: { use: 'codex' } })).toMatch(/not both/);
    expect(bad({ harnesses: { a: { use: 'codex', profile: 'fast' } } })).toMatch(/does not accept --profile/);
    expect(bad({ harnesses: { a: { use: 'codex', home: '/h', env: { CODEX_HOME: '/h2' } } } })).toMatch(/not both/);
    expect(bad({ harnesses: { a: { use: 'claude-code', configDir: '/h', env: { CLAUDE_CONFIG_DIR: '/h2' } } } })).toMatch(/not both/);
    expect(bad({ harnesses: { a: { use: 'codex', config: { k: 1 }, transport: { kind: 'unix', spawn: 'daemon' } } } })).toMatch(/not spawn "daemon"/);
    expect(
      bad({
        harnesses: {
          a: { use: 'codex', transport: { kind: 'unix', spawn: 'own', stateDir: '/s' } },
          b: { use: 'codex', transport: { kind: 'unix', spawn: 'none', stateDir: '/s' } },
        },
      }),
    ).toBe('harnesses a and b use the same codex stateDir /s; give each its own');
  });

  it('rejects unknown keys and bad values without echoing values #SE-1', () => {
    expect(() => resolve({ harnes: {} })).toThrow(ConfigError);
    expect(() => resolve({ harness: { use: 'gpt' } })).toThrow(/invalid config/);
    expect(() => resolve({ channels: [{ type: 'bridge' }] })).toThrow(/invalid config/);
  });

  describe('several lark-bot channels (decision 8)', () => {
    const bot = (account: string | undefined, config?: Record<string, unknown>) => ({ type: 'lark-bot', ...(account !== undefined ? { account } : {}), ...(config ? { config } : {}) });
    const ENV = { LARK_APP_ID: 'cli_d', LARK_APP_SECRET: 's0', A_ID: 'cli_a', A_SECRET: 'sa-secret', B_ID: 'cli_b', B_SECRET: 'sb-secret', ENC: 'enc-value' };

    it('errors name entries and variables, never values #CF-3 #SE-1', () => {
      const msg = (raw: unknown, env: Record<string, string> = ENV) => {
        try {
          resolve(raw, env);
        } catch (e) {
          expect(e).toBeInstanceOf(ConfigError);
          const m = (e as Error).message;
          for (const v of ['s0', 'sa-secret', 'sb-secret', 'enc-value']) expect(m).not.toContain(v);
          return m;
        }
        throw new Error('no error');
      };
      expect(msg({ channels: [bot('a'), bot('b')] })).toMatch(/channels\[0\] \(account "a"\) and channels\[1\] \(account "b"\) both read LARK_APP_ID/);
      expect(msg({ channels: [bot('a', { appId: 'env:MISSING', appSecret: 'x' })] })).toBe('channels[0].config.appId: environment variable MISSING is not set');
      expect(msg({ channels: [bot('a', { appId: 'cli_a' })] })).toMatch(/give both appId and appSecret/);
      expect(msg({ channels: [bot('a', { appSecret: 'env:A_SECRET' })] })).toMatch(/give both appId and appSecret/);
      expect(msg({ channels: [bot('a', { appId: 'cli_a', appSecret: 'x', domain: 'larkk' })] })).toMatch(/domain .*'feishu' or 'lark'/);
      expect(msg({ channels: [bot('a', { appId: 'env:A_ID', appSecret: 'env:A_SECRET' }), bot('b', { appId: 'cli_a', appSecret: 'env:B_SECRET' })] })).toMatch(/channels\[0\] \(account "a"\) and channels\[1\] \(account "b"\) are the same app cli_a/);
      expect(msg({ channels: [bot(undefined), bot('x', { appId: 'cli_d', appSecret: 'env:B_SECRET' })] })).toMatch(/same app cli_d/);
      expect(msg({ channels: [bot('a', { appId: 'cli_a', appSecret: 'x' }), bot('a', { appId: 'cli_b', appSecret: 'y' })] })).toMatch(/same account/);
      expect(msg({ channels: [bot('a:b', { appId: 'cli_a', appSecret: 'x' }), bot('c', { appId: 'cli_b', appSecret: 'y' })] })).toMatch(/channels\[0\] \(account "a:b"\): with several lark-bot channels, accounts are/);
    });

    it('the same appId on feishu and lark are two apps; one entry with ":" in its account only warns #CF-3', () => {
      const c = resolve({ channels: [bot('f', { appId: 'cli_x', appSecret: 'x' }), bot('l', { appId: 'cli_x', appSecret: 'y', domain: 'lark' })] }, ENV);
      expect(c.channels).toHaveLength(2);
      expect(c.warnings).toBeUndefined();
      const one = resolve({ channels: [bot('team:1', { appId: 'cli_x', appSecret: 'x' })] }, ENV);
      expect(one.warnings).toEqual([expect.stringContaining('makes route and session keys ambiguous')]);
    });
  });

  it('loads the file and .env.live next to it; only harness-ish keys reach the harness #SE-1', () => {
    const d = tmp();
    writeFileSync(join(d, 'aio.config.json'), JSON.stringify({ channels: [{ type: 'lark-bot' }] }));
    writeFileSync(join(d, '.env.live'), 'LARK_APP_ID=a\nLARK_APP_SECRET=b\nANTHROPIC_BASE_URL=http://x\n');
    const c = loadConfig({ cwd: d, env: {} });
    expect(c.channels[0]).toMatchObject({ config: { appId: 'a', appSecret: 'b', domain: 'feishu' } });
    expect(defaultInstance(c).env).toEqual({ ANTHROPIC_BASE_URL: 'http://x' });
    // Process env wins over the file.
    expect(loadConfig({ cwd: d, env: { LARK_APP_ID: 'z' } }).channels[0]).toMatchObject({ config: { appId: 'z' } });
    // Named instances get only what their `env` names.
    writeFileSync(join(d, 'aio.config.json'), JSON.stringify({ harnesses: { a: { use: 'claude-code' }, g: { use: 'claude-code', env: { ANTHROPIC_BASE_URL: 'env:ANTHROPIC_BASE_URL' } } } }));
    const n = loadConfig({ cwd: d, env: {} });
    expect(n.harnesses.a!.env).toEqual({});
    expect(n.harnesses.g!.env).toEqual({ ANTHROPIC_BASE_URL: 'http://x' });
  });
  describe('.env.live discovery', () => {
    it('skips a .env.live in a world-writable ancestor (e.g. /tmp): another user could have planted it #SE-2', () => {
      const d = tmp();
      const up = join(d, 'up');
      mkdirSync(join(up, 'a', 'b'), { recursive: true });
      writeFileSync(join(up, '.env.live'), 'AGENTS_IO_OWNERS=lark-bot:attacker\n', { mode: 0o600 });
      chmodSync(up, 0o1777);
      expect(findEnvFile({ cwd: join(up, 'a', 'b') })).toBeUndefined();
      const c = loadConfig({ cwd: join(up, 'a', 'b'), env: {} });
      expect(c.policy.owners).toEqual([]);
      expect(c.local.principal.id).toBe('local:owner');
    });

    it('skips a .env.live owned by another user #SE-2', () => {
      const d = tmp();
      mkdirSync(join(d, 'a'));
      writeFileSync(join(d, '.env.live'), 'X=1\n', { mode: 0o600 });
      expect(findEnvFile({ cwd: join(d, 'a'), uid: (process.getuid?.() ?? 0) + 1 })).toBeUndefined();
      expect(findEnvFile({ configDir: d, uid: (process.getuid?.() ?? 0) + 1 })).toBeUndefined();
    });

    it('refuses our own .env.live when others can write it, naming the fix #SE-2', () => {
      const d = tmp();
      writeFileSync(join(d, '.env.live'), 'X=1\n');
      chmodSync(join(d, '.env.live'), 0o620);
      expect(() => findEnvFile({ configDir: d })).toThrow(ConfigError);
      expect(() => findEnvFile({ cwd: d })).toThrow(/writable by other users.*chmod 600/);
    });

    it('an explicit --env-file is used as given #SE-2', () => {
      const d = tmp();
      chmodSync(d, 0o1777);
      writeFileSync(join(d, 'x.env'), 'X=1\n');
      expect(findEnvFile({ envFile: join(d, 'x.env') })).toBe(join(d, 'x.env'));
    });
  });

  describe('env:NAME secrets never reach a child command line', () => {
    it('claude mcpServers: the value goes to the child env, the server config says ${NAME} #SE-1', () => {
      const c = resolve(
        {
          harnesses: {
            a: {
              use: 'claude-code',
              mcpServers: {
                docs: { type: 'http', url: 'https://docs', headers: { Authorization: 'env:GW_TOKEN' } },
                gh: { command: 'gh-mcp', env: { GITHUB_TOKEN: 'env:GH' } },
              },
            },
          },
        },
        { GW_TOKEN: 'tok-secret', GH: 'gh-secret' },
      );
      const a = c.harnesses.a!;
      expect(a.kind === 'claude-code' && a.claude.mcpServers).toEqual({
        docs: { type: 'http', url: 'https://docs', headers: { Authorization: '${GW_TOKEN}' } },
        gh: { command: 'gh-mcp', env: { GITHUB_TOKEN: '${GH}' } },
      });
      expect(a.env).toEqual({ GW_TOKEN: 'tok-secret', GH: 'gh-secret' });
      expect(JSON.stringify(a.kind === 'claude-code' && a.claude)).not.toMatch(/secret/);
    });

    it('claude inline settings: settings.env refs move to the child env; others are refused #SE-1', () => {
      const c = resolve({ harnesses: { a: { use: 'claude-code', settings: { model: 'x', env: { X: 'env:T' } } } } }, { T: 'tok-secret' });
      const a = c.harnesses.a!;
      expect(a.kind === 'claude-code' && a.claude.settings).toEqual({ model: 'x', env: {} });
      expect(a.env).toEqual({ X: 'tok-secret' });
      expect(() => resolve({ harnesses: { a: { use: 'claude-code', settings: { apiKeyHelper: 'env:T' } } } }, { T: 'tok-secret' })).toThrow(
        /harnesses\.a\.settings\.apiKeyHelper: .*command line/,
      );
    });

    it('a routed variable that disagrees with the instance env is an error #SE-1', () => {
      expect(() =>
        resolve({ harnesses: { a: { use: 'claude-code', env: { GH: 'other' }, mcpServers: { gh: { env: { T: 'env:GH' } } } } } }, { GH: 'gh-secret' }),
      ).toThrow(/harnesses\.a: env\.GH .*mcpServers/);
      // The same value is fine.
      expect(resolve({ harnesses: { a: { use: 'claude-code', env: { GH: 'env:GH' }, mcpServers: { gh: { env: { T: 'env:GH' } } } } } }, { GH: 'g' }).harnesses.a!.env).toEqual({ GH: 'g' });
    });

    it('codex config: env refs become env-var indirection settings with the value in the child env #SE-1', () => {
      const c = resolve(
        {
          harnesses: {
            cx: {
              use: 'codex',
              config: {
                'mcp_servers.x': { url: 'https://x', http_headers: { Authorization: 'env:GW_TOKEN', 'X-Plain': 'p' } },
                'mcp_servers.y.bearer_token': 'env:GW_TOKEN',
                'model_providers.p': { base_url: 'https://p', experimental_bearer_token: 'env:KEY' },
                'mcp_servers.gh.env.GITHUB_TOKEN': 'env:GH',
                mcp_servers: { s: { command: 's', env: { A: 'env:KEY', B: 'b' } } },
              },
            },
          },
        },
        { GW_TOKEN: 'tok-secret', KEY: 'key-secret', GH: 'gh-secret' },
      );
      const cx = c.harnesses.cx!;
      if (cx.kind !== 'codex') throw new Error('kind');
      expect(cx.codex.config).toEqual({
        'mcp_servers.x': { url: 'https://x', http_headers: { 'X-Plain': 'p' } },
        'model_providers.p': { base_url: 'https://p' },
        mcp_servers: { s: { command: 's', env: { B: 'b' } } },
        'mcp_servers.x.env_http_headers.Authorization': 'GW_TOKEN',
        'mcp_servers.y.bearer_token_env_var': 'GW_TOKEN',
        'model_providers.p.env_key': 'KEY',
        'mcp_servers.gh.env_vars': ['GITHUB_TOKEN'],
        'mcp_servers.s.env_vars': ['A'],
      });
      expect(cx.env).toEqual({ GW_TOKEN: 'tok-secret', KEY: 'key-secret', GITHUB_TOKEN: 'gh-secret', A: 'key-secret' });
      // What the adapter puts on argv: accepted, and no value in it.
      const flags = launchFlags(cx.codex).join(' ');
      expect(flags).not.toMatch(/secret/);
    });

    it('codex config: an env ref with no env-var setting is a clear error that names the key, not the value #SE-1', () => {
      expect(() => resolve({ harnesses: { cx: { use: 'codex', config: { 'mcp_servers.x.url': 'env:GW_URL' } } } }, { GW_URL: 'SECRET-VALUE' })).toThrow(
        /harnesses\.cx\.config\.mcp_servers\.x\.url: "env:" values would be on the codex app-server command line/,
      );
      // A missing variable still only makes the instance unavailable.
      expect(resolve({ harnesses: { cx: { use: 'codex', config: { 'mcp_servers.y.bearer_token': 'env:NOPE' } } } }).harnesses.cx!.unavailable).toMatch(/NOPE is not set/);
    });
  });

  describe('agents.<name>.sessionParams (decision 7)', () => {
    const bad = (sessionParams: unknown, extra: Record<string, unknown> = {}) => {
      try {
        resolve({ agents: { dev: { harness: 'claude-code', sessionParams, ...extra } } });
      } catch (e) {
        expect(e).toBeInstanceOf(ConfigError);
        return (e as Error).message;
      }
      return 'no error';
    };

    it('resolves roots against the config file; envPathRoots defaults to none #FC-4', () => {
      const c = resolve({ agents: { dev: { harness: 'claude-code', sessionParams: { cwdRoots: ['ws', '/abs'], envKeys: ['GIT_AUTHOR_NAME', 'CLAUDE_CONFIG_DIR'], envPathRoots: { CLAUDE_CONFIG_DIR: ['homes'] } } }, other: { harness: 'claude-code' } } });
      expect(c.agents.dev!.sessionParams).toEqual({ cwdRoots: ['/base/ws', '/abs'], envKeys: ['GIT_AUTHOR_NAME', 'CLAUDE_CONFIG_DIR'], envPathRoots: { CLAUDE_CONFIG_DIR: ['/base/homes'] } });
      expect(c.agents.other!.sessionParams).toBeUndefined();
      expect(resolve({ agents: { dev: { harness: 'claude-code', sessionParams: { cwdRoots: [], envKeys: [] } } } }).agents.dev!.sessionParams).toEqual({ cwdRoots: [], envKeys: [], envPathRoots: {} });
    });

    it('CLAUDE_CONFIG_DIR / CODEX_HOME in envKeys need envPathRoots #FC-4', () => {
      expect(bad({ cwdRoots: [], envKeys: ['CLAUDE_CONFIG_DIR'] })).toMatch(/CLAUDE_CONFIG_DIR is in envKeys.*envPathRoots\.CLAUDE_CONFIG_DIR/);
      expect(bad({ cwdRoots: [], envKeys: ['CODEX_HOME'] })).toMatch(/CODEX_HOME is in envKeys/);
      expect(bad({ cwdRoots: [], envKeys: ['CODEX_HOME'], envPathRoots: { CODEX_HOME: [] } })).toMatch(/envPathRoots\.CODEX_HOME: needs at least one root/);
    });

    it('refuses AGENTS_IO_* and malformed keys, envPathRoots keys not in envKeys, task agents, unknown fields #FC-4', () => {
      expect(bad({ cwdRoots: [], envKeys: ['AGENTS_IO_MCP_TOKEN'] })).toMatch(/AGENTS_IO_\* variables are the daemon's own/);
      expect(bad({ cwdRoots: [], envKeys: ['1BAD'] })).toMatch(/not a variable name/);
      expect(bad({ cwdRoots: [], envKeys: ['A'], envPathRoots: { HOME: ['/h'] } })).toMatch(/envPathRoots\.HOME: not in envKeys/);
      expect(bad({ cwdRoots: [], envKeys: [] }, { mode: 'task' })).toMatch(/task agents take their cwd and env per run/);
      expect(bad({ cwdRoots: [], envKeys: [], extra: 1 })).toMatch(/invalid config/);
      expect(bad({ envKeys: [] })).toMatch(/invalid config/);
    });
  });
});
