import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { homedir } from 'node:os';
import { launchFlags } from '@agents-io/harness-codex';
import { ConfigError, codexStateDir, defaultInstance, findEnvFile, loadConfig, resolveConfig, substituteEnv } from '../src/config.js';

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
  it('fills defaults from an empty file', () => {
    const c = resolve({});
    expect(c.defaultHarness).toBe('claude-code');
    expect(Object.keys(c.harnesses)).toEqual(['claude-code']);
    expect(defaultInstance(c)).toMatchObject({ name: 'claude-code', kind: 'claude-code', run: { harness: 'claude-code', model: 'haiku' }, claude: {} });
    expect(c.logPath).toBe(join(c.dataDir, 'log.sqlite'));
    expect(c.socketPath).toBe(join(c.dataDir, 'run', 'aio.sock'));
    expect(c.cwd).toBe('/work');
    expect(c.channels).toEqual([]);
    expect(c.local).toEqual({ principal: { id: 'local:owner', labels: ['owner'] }, session: 'local:main' });
  });

  it('resolves paths against the config dir, ~ against home; env overrides the model; owners merge env', () => {
    const c = resolve(
      {
        dataDir: 'state',
        harness: { use: 'codex', codex: { run: { model: 'cfg-model', effort: 'low' }, transport: { kind: 'unix', spawn: 'own', stateDir: '~/cx' } } },
        policy: { owners: ['lark-bot:u1'], ownerSessionKey: 'main' },
      },
      { AGENTS_IO_LIVE_CODEX_MODEL: 'env-model', AGENTS_IO_OWNERS: 'mail:a@b.c, lark-bot:u2' },
    );
    expect(c.dataDir).toBe('/base/state');
    const cx = defaultInstance(c);
    expect(cx.run).toEqual({ harness: 'codex', model: 'env-model', effort: 'low' });
    if (cx.kind !== 'codex') throw new Error('codex');
    expect(cx.codex.transport).toMatchObject({ kind: 'unix', spawn: 'own', stateDir: join(homedir(), 'cx') });
    expect(c.policy.owners).toEqual(['lark-bot:u1', 'mail:a@b.c', 'lark-bot:u2']);
    // The local end is the owner by default, in the owner's session.
    expect(c.local).toEqual({ principal: { id: 'lark-bot:u1', labels: ['owner'] }, session: 'main' });
  });

  it('--harness overrides harness.use; codex defaults to the codex default model', () => {
    const c = resolve({ harness: { use: 'claude-code' } }, {}, { harness: 'codex' });
    expect(c.defaultHarness).toBe('codex');
    expect(defaultInstance(c).run).toEqual({ harness: 'codex', model: '' });
    // The older form keeps the adapter's default stateDir so a running deployment still adopts its turns.
    const u = defaultInstance(resolve({ harness: { use: 'codex', codex: { transport: { kind: 'unix', spawn: 'own' } } } }));
    expect(u.kind === 'codex' && u.codex.transport).toEqual({ kind: 'unix', spawn: 'own' });
  });

  it('named instances: per-kind launch settings, env refs, paths, default and --harness by name', () => {
    const c = resolve(
      {
        harnesses: {
          claude: { use: 'claude-code' },
          'claude-gateway': {
            use: 'claude-code',
            env: { ANTHROPIC_BASE_URL: 'env:GW_URL', ANTHROPIC_AUTH_TOKEN: 'env:GW_TOKEN', ANTHROPIC_API_KEY: null, FIXED: 'v' },
            run: { model: 'gemini-3.8-flash-high' },
            configDir: '~/.claude-gw',
            executable: 'bin/claude',
            settings: { permissions: { allow: ['Read'] }, env: { X: 'env:GW_TOKEN' } },
            settingSources: ['user'],
            mcpServers: { docs: { type: 'http', url: 'https://docs', headers: { Authorization: 'env:GW_TOKEN' } } },
            plugins: ['plugins/one'],
            skills: 'all',
            extraArgs: { 'debug-to-stderr': null },
            additionalDirectories: ['shared'],
            cwd: 'work',
            profiles: { bypass: { permissionMode: 'bypassPermissions' } },
          },
          codex: {
            use: 'codex',
            home: '~/.codex-aio',
            executable: 'codex',
            config: { model_reasoning_summary: 'concise', 'mcp_servers.x.url': 'https://x', 'mcp_servers.x.bearer_token': 'env:GW_TOKEN' },
            enable: ['web_search'],
            disable: ['undo'],
            transport: { kind: 'unix', spawn: 'own' },
          },
        },
        defaultHarness: 'claude-gateway',
      },
      { GW_URL: 'https://gw.example', GW_TOKEN: 'tok-secret', AGENTS_IO_LIVE_CLAUDE_MODEL: 'env-model' },
    );
    expect(c.defaultHarness).toBe('claude-gateway');
    const gw = c.harnesses['claude-gateway']!;
    expect(gw).toMatchObject({
      name: 'claude-gateway',
      kind: 'claude-code',
      // The env model override only touches the default instance.
      run: { harness: 'claude-gateway', model: 'env-model' },
      // Secrets for argv-bound settings (inline settings, mcpServers) ride in the child env.
      env: { ANTHROPIC_BASE_URL: 'https://gw.example', ANTHROPIC_AUTH_TOKEN: 'tok-secret', ANTHROPIC_API_KEY: undefined, FIXED: 'v', X: 'tok-secret', GW_TOKEN: 'tok-secret' },
      cwd: '/base/work',
      claude: {
        claudePath: '/base/bin/claude',
        configDir: join(homedir(), '.claude-gw'),
        settings: { permissions: { allow: ['Read'] }, env: {} },
        settingSources: ['user'],
        mcpServers: { docs: { headers: { Authorization: '${GW_TOKEN}' } } },
        plugins: ['/base/plugins/one'],
        skills: 'all',
        extraArgs: { 'debug-to-stderr': null },
        additionalDirectories: ['/base/shared'],
      },
    });
    expect('ANTHROPIC_API_KEY' in gw.env).toBe(true); // null → removed from the child's environment
    expect(c.harnesses.claude).toMatchObject({ run: { harness: 'claude', model: 'haiku' }, env: {}, claude: {} });
    const cx = c.harnesses.codex!;
    expect(cx).toMatchObject({
      kind: 'codex',
      run: { harness: 'codex', model: '' },
      codex: {
        bin: 'codex',
        codexHome: join(homedir(), '.codex-aio'),
        config: { model_reasoning_summary: 'concise', 'mcp_servers.x.url': 'https://x', 'mcp_servers.x.bearer_token_env_var': 'GW_TOKEN' },
        enable: ['web_search'],
        disable: ['undo'],
        // Namespaced per instance: restart adoption never crosses instances.
        transport: { kind: 'unix', spawn: 'own', stateDir: codexStateDir('codex') },
      },
    });
    expect(codexStateDir('codex')).toBe(join(homedir(), '.agents-io', 'codex.codex'));

    // --harness picks an instance by name, or a kind's first instance.
    const raw = { harnesses: { a: { use: 'claude-code' }, b: { use: 'codex' } } };
    expect(resolve(raw).defaultHarness).toBe('a');
    expect(resolve(raw, {}, { harness: 'b' }).defaultHarness).toBe('b');
    expect(resolve(raw, {}, { harness: 'codex' }).defaultHarness).toBe('b');
    expect(() => resolve(raw, {}, { harness: 'nope' })).toThrow('unknown harness instance "nope" (configured: a, b)');
  });

  it('named instances: clear errors that never echo values', () => {
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

  it('rejects unknown keys and bad values without echoing values', () => {
    expect(() => resolve({ harnes: {} })).toThrow(ConfigError);
    expect(() => resolve({ harness: { use: 'gpt' } })).toThrow(/invalid config/);
    expect(() => resolve({ channels: [{ type: 'bridge' }] })).toThrow(/invalid config/);
  });

  it('lark-bot takes credentials from the environment and names a missing one', () => {
    expect(() => resolve({ channels: [{ type: 'lark-bot' }] }, { LARK_APP_ID: 'id' })).toThrow('channel lark-bot needs LARK_APP_SECRET');
    const c = resolve({ channels: [{ type: 'lark-bot', tier: 'card' }] }, { LARK_APP_ID: 'id', LARK_APP_SECRET: 'secret', LARK_DOMAIN: 'lark' });
    expect(c.channels[0]).toMatchObject({ type: 'lark-bot', account: 'default', tier: 'card', lark: { appId: 'id', appSecret: 'secret', domain: 'lark' } });
    // Clients skip channels, so they need no channel secrets.
    expect(resolve({ channels: [{ type: 'lark-bot' }] }, {}, { channels: false }).channels).toEqual([]);
  });

  it('substitutes env:NAME in mail and bridge config', () => {
    const c = resolve(
      { channels: [{ type: 'mail', config: { imap: { auth: { user: 'me', pass: 'env:MAIL_PASS' } } } }, { type: 'bridge', command: 'python3', args: ['x.py'], env: { TOKEN: 'env:TOK' }, cwd: 'ch' }] },
      { MAIL_PASS: 'p', TOK: 't' },
    );
    expect(c.channels[0]).toMatchObject({ config: { imap: { auth: { user: 'me', pass: 'p' } } } });
    expect(c.channels[1]).toMatchObject({ env: { TOKEN: 't' }, cwd: '/base/ch' });
    expect(() => substituteEnv({ a: ['env:NOPE'] }, {}, 'x')).toThrow('x.a[0]: environment variable NOPE is not set');
  });

  it('loads the file and .env.live next to it; only harness-ish keys reach the harness', () => {
    const d = tmp();
    writeFileSync(join(d, 'aio.config.json'), JSON.stringify({ channels: [{ type: 'lark-bot' }] }));
    writeFileSync(join(d, '.env.live'), 'LARK_APP_ID=a\nLARK_APP_SECRET=b\nANTHROPIC_BASE_URL=http://x\n');
    const c = loadConfig({ cwd: d, env: {} });
    expect(c.channels[0]).toMatchObject({ lark: { appId: 'a', appSecret: 'b', domain: 'feishu' } });
    expect(defaultInstance(c).env).toEqual({ ANTHROPIC_BASE_URL: 'http://x' });
    // Process env wins over the file.
    expect(loadConfig({ cwd: d, env: { LARK_APP_ID: 'z' } }).channels[0]).toMatchObject({ lark: { appId: 'z' } });
    // Named instances get only what their `env` names.
    writeFileSync(join(d, 'aio.config.json'), JSON.stringify({ harnesses: { a: { use: 'claude-code' }, g: { use: 'claude-code', env: { ANTHROPIC_BASE_URL: 'env:ANTHROPIC_BASE_URL' } } } }));
    const n = loadConfig({ cwd: d, env: {} });
    expect(n.harnesses.a!.env).toEqual({});
    expect(n.harnesses.g!.env).toEqual({ ANTHROPIC_BASE_URL: 'http://x' });
  });

  it('an explicit missing config is an error; a missing default is all defaults', () => {
    const d = tmp();
    expect(() => loadConfig({ cwd: d, path: 'nope.json', env: {} })).toThrow(/not found/);
    expect(defaultInstance(loadConfig({ cwd: d, env: {} })).kind).toBe('claude-code');
  });

  it('finds .env.live up the tree', () => {
    const d = tmp();
    mkdirSync(join(d, 'a', 'b'), { recursive: true });
    writeFileSync(join(d, '.env.live'), 'X=1\n');
    expect(findEnvFile({ cwd: join(d, 'a', 'b') })).toBe(join(d, '.env.live'));
  });

  it('the committed example config is valid', () => {
    const raw = JSON.parse(readFileSync(new URL('../aio.config.example.json', import.meta.url), 'utf8'));
    const c = resolve(raw, { LARK_APP_ID: 'a', LARK_APP_SECRET: 'b', GATEWAY_BASE_URL: 'u', GATEWAY_AUTH_TOKEN: 't' });
    expect(Object.values(c.harnesses).filter((i) => i.unavailable)).toEqual([]);
    // Without the gateway's variables only that instance is unavailable.
    expect(Object.values(resolve(raw, { LARK_APP_ID: 'a', LARK_APP_SECRET: 'b' }).harnesses).filter((i) => i.unavailable).map((i) => i.name)).toEqual(['claude-gateway']);
    expect(defaultInstance(c).kind).toBe('claude-code');
    expect(Object.values(c.harnesses).map((i) => `${i.name}:${i.kind}`)).toEqual(['claude:claude-code', 'claude-gateway:claude-code', 'codex:codex']);
    expect(c.channels.map((ch) => ch.type)).toContain('lark-bot');
  });
  describe('.env.live discovery', () => {
    it('skips a .env.live in a world-writable ancestor (e.g. /tmp): another user could have planted it', () => {
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

    it('skips a .env.live owned by another user', () => {
      const d = tmp();
      mkdirSync(join(d, 'a'));
      writeFileSync(join(d, '.env.live'), 'X=1\n', { mode: 0o600 });
      expect(findEnvFile({ cwd: join(d, 'a'), uid: (process.getuid?.() ?? 0) + 1 })).toBeUndefined();
      expect(findEnvFile({ configDir: d, uid: (process.getuid?.() ?? 0) + 1 })).toBeUndefined();
    });

    it('refuses our own .env.live when others can write it, naming the fix', () => {
      const d = tmp();
      writeFileSync(join(d, '.env.live'), 'X=1\n');
      chmodSync(join(d, '.env.live'), 0o620);
      expect(() => findEnvFile({ configDir: d })).toThrow(ConfigError);
      expect(() => findEnvFile({ cwd: d })).toThrow(/writable by other users.*chmod 600/);
    });

    it('an explicit --env-file is used as given', () => {
      const d = tmp();
      chmodSync(d, 0o1777);
      writeFileSync(join(d, 'x.env'), 'X=1\n');
      expect(findEnvFile({ envFile: join(d, 'x.env') })).toBe(join(d, 'x.env'));
    });
  });

  describe('env:NAME secrets never reach a child command line', () => {
    it('claude mcpServers: the value goes to the child env, the server config says ${NAME}', () => {
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

    it('claude inline settings: settings.env refs move to the child env; others are refused', () => {
      const c = resolve({ harnesses: { a: { use: 'claude-code', settings: { model: 'x', env: { X: 'env:T' } } } } }, { T: 'tok-secret' });
      const a = c.harnesses.a!;
      expect(a.kind === 'claude-code' && a.claude.settings).toEqual({ model: 'x', env: {} });
      expect(a.env).toEqual({ X: 'tok-secret' });
      expect(() => resolve({ harnesses: { a: { use: 'claude-code', settings: { apiKeyHelper: 'env:T' } } } }, { T: 'tok-secret' })).toThrow(
        /harnesses\.a\.settings\.apiKeyHelper: .*command line/,
      );
    });

    it('a routed variable that disagrees with the instance env is an error', () => {
      expect(() =>
        resolve({ harnesses: { a: { use: 'claude-code', env: { GH: 'other' }, mcpServers: { gh: { env: { T: 'env:GH' } } } } } }, { GH: 'gh-secret' }),
      ).toThrow(/harnesses\.a: env\.GH .*mcpServers/);
      // The same value is fine.
      expect(resolve({ harnesses: { a: { use: 'claude-code', env: { GH: 'env:GH' }, mcpServers: { gh: { env: { T: 'env:GH' } } } } } }, { GH: 'g' }).harnesses.a!.env).toEqual({ GH: 'g' });
    });

    it('codex config: env refs become env-var indirection settings with the value in the child env', () => {
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

    it('codex config: an env ref with no env-var setting is a clear error that names the key, not the value', () => {
      expect(() => resolve({ harnesses: { cx: { use: 'codex', config: { 'mcp_servers.x.url': 'env:GW_URL' } } } }, { GW_URL: 'SECRET-VALUE' })).toThrow(
        /harnesses\.cx\.config\.mcp_servers\.x\.url: "env:" values would be on the codex app-server command line/,
      );
      // A missing variable still only makes the instance unavailable.
      expect(resolve({ harnesses: { cx: { use: 'codex', config: { 'mcp_servers.y.bearer_token': 'env:NOPE' } } } }).harnesses.cx!.unavailable).toMatch(/NOPE is not set/);
    });
  });
});
