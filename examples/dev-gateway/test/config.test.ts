import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigError, findEnvFile, loadConfig, resolveConfig, substituteEnv } from '../src/config.js';

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
    expect(c.harness).toMatchObject({ kind: 'claude-code', run: { harness: 'claude-code', model: 'haiku' }, transport: { kind: 'stdio' } });
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
    expect(c.harness.run).toEqual({ harness: 'codex', model: 'env-model', effort: 'low' });
    expect(c.harness.transport).toMatchObject({ kind: 'unix', spawn: 'own' });
    expect((c.harness.transport as { stateDir: string }).stateDir).not.toContain('~');
    expect(c.policy.owners).toEqual(['lark-bot:u1', 'mail:a@b.c', 'lark-bot:u2']);
    // The local end is the owner by default, in the owner's session.
    expect(c.local).toEqual({ principal: { id: 'lark-bot:u1', labels: ['owner'] }, session: 'main' });
  });

  it('--harness overrides harness.use; codex defaults to the codex default model', () => {
    const c = resolve({ harness: { use: 'claude-code' } }, {}, { harness: 'codex' });
    expect(c.harness.run).toEqual({ harness: 'codex', model: '' });
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
    expect(c.harness.env).toEqual({ ANTHROPIC_BASE_URL: 'http://x' });
    // Process env wins over the file.
    expect(loadConfig({ cwd: d, env: { LARK_APP_ID: 'z' } }).channels[0]).toMatchObject({ lark: { appId: 'z' } });
  });

  it('an explicit missing config is an error; a missing default is all defaults', () => {
    const d = tmp();
    expect(() => loadConfig({ cwd: d, path: 'nope.json', env: {} })).toThrow(/not found/);
    expect(loadConfig({ cwd: d, env: {} }).harness.kind).toBe('claude-code');
  });

  it('finds .env.live up the tree', () => {
    const d = tmp();
    mkdirSync(join(d, 'a', 'b'), { recursive: true });
    writeFileSync(join(d, '.env.live'), 'X=1\n');
    expect(findEnvFile({ cwd: join(d, 'a', 'b') })).toBe(join(d, '.env.live'));
  });

  it('the committed example config is valid', () => {
    const raw = JSON.parse(readFileSync(new URL('../aio.config.example.json', import.meta.url), 'utf8'));
    const c = resolve(raw, { LARK_APP_ID: 'a', LARK_APP_SECRET: 'b' });
    expect(c.harness.kind).toBe('claude-code');
    expect(c.channels.map((ch) => ch.type)).toContain('lark-bot');
  });
});
