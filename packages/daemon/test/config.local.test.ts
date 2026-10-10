import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { codexStateDir, defaultInstance, findEnvFile, loadConfig, resolveConfig, substituteEnv } from '../src/config.js';

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

  it('lark-bot takes credentials from the environment and names a missing one', () => {
    expect(() => resolve({ channels: [{ type: 'lark-bot' }] }, { LARK_APP_ID: 'id' })).toThrow('channel lark-bot needs LARK_APP_SECRET');
    const c = resolve({ channels: [{ type: 'lark-bot', tier: 'card' }] }, { LARK_APP_ID: 'id', LARK_APP_SECRET: 'secret', LARK_DOMAIN: 'lark' });
    expect(c.channels[0]).toMatchObject({ type: 'lark-bot', account: 'default', tier: 'card', config: { appId: 'id', appSecret: 'secret', domain: 'lark' } });
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

  describe('several lark-bot channels (decision 8)', () => {
    const bot = (account: string | undefined, config?: Record<string, unknown>) => ({ type: 'lark-bot', ...(account !== undefined ? { account } : {}), ...(config ? { config } : {}) });
    const ENV = { LARK_APP_ID: 'cli_d', LARK_APP_SECRET: 's0', A_ID: 'cli_a', A_SECRET: 'sa-secret', B_ID: 'cli_b', B_SECRET: 'sb-secret', ENC: 'enc-value' };

    it('explicit env: references per entry, the fallback for one, domain default feishu; encryptKey env: is substituted', () => {
      const c = resolve({ channels: [bot(undefined), bot('proj-a', { appId: 'env:A_ID', appSecret: 'env:A_SECRET', encryptKey: 'env:ENC' }), bot('intl', { appId: 'cli_lit', appSecret: 'env:B_SECRET', domain: 'lark' })] }, ENV);
      expect(c.channels.map((ch) => [ch.account, ch.config])).toEqual([
        ['default', { appId: 'cli_d', appSecret: 's0', domain: 'feishu' }],
        ['proj-a', { appId: 'cli_a', appSecret: 'sa-secret', encryptKey: 'enc-value', domain: 'feishu' }],
        ['intl', { appId: 'cli_lit', appSecret: 'sb-secret', domain: 'lark' }],
      ]);
      // A single entry with env: in its config (the console's credential rule) gets values too.
      expect(resolve({ channels: [bot(undefined, { encryptKey: 'env:ENC' })] }, ENV).channels[0]!.config).toMatchObject({ appId: 'cli_d', encryptKey: 'enc-value' });
    });
  });
});
