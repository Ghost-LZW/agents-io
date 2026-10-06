import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultPolicy } from '@agents-io/session';
import { LarkBotAdapter } from '../src/index.js';
import { createLarkBot, LarkSetupError, updateLarkBot, type RegisterAppFn, type RegisterAppOptionsLike } from '../src/setup/create.js';
import { main } from '../src/setup/cli.js';
import { defaultCredentialsPath, readCredentials, updateEnvFile, writeCredentials } from '../src/setup/files.js';
import { resolveOwner } from '../src/setup/owner.js';
import { APP_CALLBACKS, APP_EVENTS, REGISTERABLE_HANDLERS, TENANT_SCOPES, larkAddons, scopesJson } from '../src/setup/requirements.js';
import { verifyLarkBot } from '../src/setup/verify.js';
import type { LarkClientLike, LarkDeps, LarkWsLike } from '../src/types.js';
import { FakeLark, startAdapter, tick } from './fake-lark.js';

const SECRET = 'sekret_0123456789abcdef0123456789abcdef';
const tmp = () => mkdtempSync(join(tmpdir(), 'lark-setup-'));
const mode = (p: string) => statSync(p).mode & 0o777;

describe('requirements', () => {
  it('lists every handler the adapter registers', async () => {
    const lark = new FakeLark();
    const adapter = new LarkBotAdapter({ appId: 'cli_x', appSecret: 's', domain: 'feishu' }, { deps: lark.deps });
    const run = startAdapter(adapter);
    await tick();
    const registered = [...lark.handlers.keys()];
    expect(registered.length).toBeGreaterThan(0);
    for (const k of registered) expect(REGISTERABLE_HANDLERS, `adapter registers ${k}`).toContain(k);
    run.ctl.abort();
    await run.done;
  });

  it('source scan: every key passed to dispatcher.register is declared', () => {
    const src = readFileSync(new URL('../src/adapter.ts', import.meta.url), 'utf8');
    const block = /dispatcher\.register\(\{([\s\S]*?)\}\);/.exec(src)?.[1] ?? '';
    const keys = [...block.matchAll(/'([^']+)'\s*:/g)].map((m) => m[1]!);
    expect(keys.length).toBeGreaterThan(0);
    for (const k of keys) expect(REGISTERABLE_HANDLERS).toContain(k);
  });

  it('builds addons and a batch-import json from the same list', () => {
    const a = larkAddons();
    expect(a.scopes.tenant).toEqual(TENANT_SCOPES.map((s) => s.name));
    expect(a.events.items.tenant).toEqual([...APP_EVENTS]);
    expect(a.callbacks.items).toEqual([...APP_CALLBACKS]);
    expect(scopesJson().scopes.tenant).toEqual(a.scopes.tenant);
    expect(APP_EVENTS).toContain('im.message.receive_v1');
    expect(APP_CALLBACKS).toContain('card.action.trigger');
  });
});

describe('createLarkBot', () => {
  const ok: RegisterAppFn = async (o) => {
    o.onQRCodeReady({ url: 'https://accounts.feishu.cn/qr?x=1', expireIn: 600 });
    return { client_id: 'cli_new', client_secret: SECRET, user_info: { open_id: 'ou_scan', tenant_brand: 'lark' } };
  };

  it('passes preset, addons, createOnly and returns credentials', async () => {
    let seen: RegisterAppOptionsLike | undefined;
    const qrs: string[] = [];
    const r = await createLarkBot(
      { signal: new AbortController().signal, onQRCode: (i) => qrs.push(i.url) },
      { registerApp: async (o) => ((seen = o), ok(o)) },
    );
    expect(r).toEqual({ appId: 'cli_new', appSecret: SECRET, brand: 'lark', ownerOpenId: 'ou_scan' });
    expect(qrs).toEqual(['https://accounts.feishu.cn/qr?x=1']);
    expect(seen?.createOnly).toBe(true);
    expect(seen?.appPreset?.name).toBe('agents-io · {user}');
    expect(seen?.addons).toEqual(larkAddons());
    expect(seen?.appId).toBeUndefined();
  });

  it('starts on the lark accounts host when brand is lark', async () => {
    let seen: RegisterAppOptionsLike | undefined;
    await createLarkBot({ brand: 'lark', onQRCode: () => {} }, { registerApp: async (o) => ((seen = o), ok(o)) });
    expect(seen?.domain).toBe('accounts.larksuite.com');
  });

  it.each([
    ['expired_token', 'expired'],
    ['access_denied', 'denied'],
    ['abort', 'aborted'],
  ])('maps %s to %s', async (code, reason) => {
    const fail: RegisterAppFn = async () => {
      throw Object.assign(new Error('x'), { code });
    };
    await expect(createLarkBot({ onQRCode: () => {} }, { registerApp: fail })).rejects.toMatchObject({ name: 'LarkSetupError', reason });
  });

  it('classifies network errors and redacts long tokens from messages', async () => {
    const fail: RegisterAppFn = async () => {
      throw new Error(`ECONNRESET talking with ${SECRET}`);
    };
    const e = await createLarkBot({ onQRCode: () => {} }, { registerApp: fail }).catch((x) => x);
    expect(e).toBeInstanceOf(LarkSetupError);
    expect(e.reason).toBe('network');
    expect(e.message).not.toContain(SECRET);
  });

  it('rejects a result without credentials', async () => {
    await expect(createLarkBot({ onQRCode: () => {} }, { registerApp: async () => ({ client_id: '', client_secret: '' }) })).rejects.toMatchObject({ reason: 'unknown' });
  });

  it('updateLarkBot passes appId and not createOnly', async () => {
    let seen: RegisterAppOptionsLike | undefined;
    await updateLarkBot({ appId: 'cli_old', onQRCode: () => {} }, { registerApp: async (o) => ((seen = o), ok(o)) });
    expect(seen?.appId).toBe('cli_old');
    expect(seen?.createOnly).toBeUndefined();
  });
});

describe('resolveOwner', () => {
  const clientReturning = (res: unknown | Error): Pick<LarkClientLike, 'request'> => ({
    request: async () => {
      if (res instanceof Error) throw res;
      return res;
    },
  });

  it('returns the key defaultPolicy owners match', async () => {
    const r = await resolveOwner(clientReturning({ code: 0, data: { user: { union_id: 'on_alice', open_id: 'ou_scan' } } }), 'ou_scan');
    expect(r).toEqual({ ok: true, key: 'lark-bot:on_alice', unionId: 'on_alice' });
    const policy = defaultPolicy({ owners: [(r as { key: string }).key] });
    const id = await policy.identify({ channel: 'lark-bot', channelUserId: 'on_alice' } as never);
    expect(id.principal?.id).toBe('lark-bot:on_alice');
  });

  it('never falls back to the open_id', async () => {
    for (const res of [
      { code: 0, data: { user: { open_id: 'ou_scan' } } },
      { code: 99991672, msg: 'denied' },
      { code: 0, data: {} },
      new Error('boom'),
    ]) {
      const r = await resolveOwner(clientReturning(res), 'ou_scan');
      expect(r.ok).toBe(false);
      expect(JSON.stringify(r)).not.toContain('lark-bot:ou_scan');
    }
    expect((await resolveOwner(clientReturning({}), 'not-an-open-id')).ok).toBe(false);
  });
});

function fakes(over: { scopes?: unknown; botCode?: number; token?: unknown; wsState?: string } = {}) {
  const urls: string[] = [];
  const client: Pick<LarkClientLike, 'request'> = {
    request: async ({ url }) => {
      urls.push(url);
      if (url.includes('bot/v3/info')) return over.botCode ? { code: over.botCode } : { code: 0, bot: { open_id: 'ou_bot' } };
      return over.scopes ?? { code: 0, data: { app: { scopes: TENANT_SCOPES.map((s) => ({ scope: s.name })) } } };
    },
  };
  const ws: LarkWsLike = {
    start: async () => {},
    close: () => {},
    getConnectionStatus: () => ({ state: (over.wsState ?? 'connected') as 'connected' }),
  };
  const deps: Partial<LarkDeps> & { fetch: typeof fetch } = {
    createClient: () => client as LarkClientLike,
    createWs: () => ws,
    createDispatcher: () => ({ register: () => undefined }),
    fetch: (async () => ({ json: async () => over.token ?? { code: 0, tenant_access_token: 't-abc' } })) as unknown as typeof fetch,
  };
  return { deps, urls };
}

describe('verifyLarkBot', () => {
  const base = { appId: 'cli_x', appSecret: SECRET, brand: 'feishu' as const };

  it('passes when everything is granted; events are honestly unknown', async () => {
    const r = await verifyLarkBot(base, fakes().deps);
    expect(r.ok).toBe(true);
    const by = Object.fromEntries(r.checks.map((c) => [c.id, c.status]));
    expect(by).toMatchObject({ credentials: 'ok', bot: 'ok', scopes: 'ok', events: 'unknown', ws: 'skipped' });
    expect(r.missingScopes).toEqual([]);
  });

  it('reports missing scopes with console link and importable json', async () => {
    const granted = { code: 0, data: { app: { scopes: [{ scope: 'im:message' }] } } };
    const r = await verifyLarkBot({ ...base, brand: 'lark' }, fakes({ scopes: granted }).deps);
    expect(r.ok).toBe(false);
    const sc = r.checks.find((c) => c.id === 'scopes')!;
    expect(sc.status).toBe('fail');
    expect(sc.link).toBe('https://open.larksuite.com/app/cli_x/auth');
    expect(r.missingScopes.map((s) => s.name)).toContain('im:message:send_as_bot');
    expect(r.scopesJson.scopes.tenant).toContain('im:message:send_as_bot');
    expect(r.missingScopes.map((s) => s.name)).not.toContain('im:message');
  });

  it('missing optional scopes do not fail the report', async () => {
    const runtime = TENANT_SCOPES.filter((s) => s.tier === 'runtime').map((s) => ({ scope: s.name }));
    const r = await verifyLarkBot(base, fakes({ scopes: { code: 0, data: { app: { scopes: runtime } } } }).deps);
    expect(r.ok).toBe(true);
    expect(r.missingScopes.length).toBeGreaterThan(0);
  });

  it('reports unknown (not a guess) when the scope readback is not permitted', async () => {
    const r = await verifyLarkBot(base, fakes({ scopes: { code: 99991672, msg: 'no' } }).deps);
    expect(r.checks.find((c) => c.id === 'scopes')?.status).toBe('unknown');
    expect(r.missingScopes).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it('fails on bad credentials and bot capability off, without leaking the secret', async () => {
    const bad = await verifyLarkBot(base, fakes({ token: { code: 10003, msg: 'invalid' } }).deps);
    expect(bad.ok).toBe(false);
    expect(JSON.stringify(bad)).not.toContain(SECRET);
    const nobot = await verifyLarkBot(base, fakes({ botCode: 10001 }).deps);
    expect(nobot.checks.find((c) => c.id === 'bot')).toMatchObject({ status: 'fail', link: 'https://open.feishu.cn/app/cli_x' });
  });

  it('live probe: connected ok, stuck connecting fails after timeout', async () => {
    expect((await verifyLarkBot({ ...base, live: true }, fakes().deps)).checks.find((c) => c.id === 'ws')?.status).toBe('ok');
    const r = await verifyLarkBot({ ...base, live: true, timeoutMs: 150 }, fakes({ wsState: 'connecting' }).deps);
    expect(r.checks.find((c) => c.id === 'ws')?.status).toBe('fail');
  });
});

describe('files', () => {
  it('writes credentials 0600 in a 0700 directory', () => {
    const dir = join(tmp(), 'a', 'b');
    const p = join(dir, 'cli_x.json');
    writeCredentials(p, { appId: 'cli_x', appSecret: SECRET, brand: 'lark', owner: 'lark-bot:on_a' });
    expect(mode(p)).toBe(0o600);
    expect(mode(dir)).toBe(0o700);
    expect(readCredentials(p)).toMatchObject({ appId: 'cli_x', brand: 'lark', owner: 'lark-bot:on_a' });
    writeCredentials(p, { appId: 'cli_x', appSecret: SECRET, brand: 'lark' }); // rewrite keeps mode
    expect(mode(p)).toBe(0o600);
    expect(defaultCredentialsPath('cli_x', '/h')).toBe('/h/.config/agents-io/lark/cli_x.json');
  });

  it('updates an env file in place and merges owners', () => {
    const p = join(tmp(), '.env.live');
    writeFileSync(p, 'FOO=1\nLARK_APP_ID=old\nAGENTS_IO_OWNERS=lark-bot:on_x\n');
    updateEnvFile(p, { LARK_APP_ID: 'cli_x', LARK_APP_SECRET: SECRET, LARK_DOMAIN: 'feishu', AGENTS_IO_OWNERS: 'lark-bot:on_a' });
    expect(readFileSync(p, 'utf8')).toBe(
      `FOO=1\nLARK_APP_ID=cli_x\nAGENTS_IO_OWNERS=lark-bot:on_x,lark-bot:on_a\nLARK_APP_SECRET=${SECRET}\nLARK_DOMAIN=feishu\n`,
    );
    expect(mode(p)).toBe(0o600);
  });
});

describe('cli', () => {
  function run(argv: string[], extra: Parameters<typeof main>[1]['deps'] = {}) {
    const out: string[] = [];
    const err: string[] = [];
    const registerApp: RegisterAppFn = async (o) => {
      o.onQRCodeReady({ url: 'https://qr.example/x', expireIn: 600 });
      return { client_id: 'cli_new', client_secret: SECRET, user_info: { open_id: 'ou_scan', tenant_brand: 'feishu' } };
    };
    const client = { request: async () => ({ code: 0, data: { user: { union_id: 'on_alice' } } }) } as unknown as LarkClientLike;
    const code = main(argv, {
      out: (s) => out.push(s),
      err: (s) => err.push(s),
      env: {},
      qr: () => err.push('[qr]'),
      deps: { registerApp, createClient: () => client, ...extra },
    });
    return { code, out, err };
  }

  it('create --write-env stores values without printing the secret', async () => {
    const p = join(tmp(), '.env.live');
    const { code, out, err } = run(['create', '--write-env', p]);
    expect(await code).toBe(0);
    const text = readFileSync(p, 'utf8');
    expect(text).toContain(`LARK_APP_SECRET=${SECRET}`);
    expect(text).toContain('AGENTS_IO_OWNERS=lark-bot:on_alice');
    expect([...out, ...err].join('\n')).not.toContain(SECRET);
    expect(err.join('\n')).toContain('https://qr.example/x');
    expect(mode(p)).toBe(0o600);
  });

  it('create --write-credentials writes the file and leaves owner unset when unverifiable', async () => {
    const p = join(tmp(), 'sub', 'c.json');
    const failing = { request: async () => ({ code: 99991672 }) } as unknown as LarkClientLike;
    const { code, out, err } = run(['create', '--write-credentials', p], { createClient: () => failing });
    expect(await code).toBe(0);
    expect(readCredentials(p).owner).toBeUndefined();
    expect(mode(p)).toBe(0o600);
    expect([...out, ...err].join('\n')).not.toContain(SECRET);
    expect(err.join('\n')).toContain('owner not resolved');
  });

  it('reports a failed create with a non-zero exit', async () => {
    const { code, err } = run(['create'], {
      registerApp: async () => {
        throw Object.assign(new Error('x'), { code: 'expired_token' });
      },
    });
    expect(await code).toBe(1);
    expect(err.join('\n')).toContain('expired');
  });

  it('verify exits 1 on a failing report', async () => {
    const out: string[] = [];
    const f = fakes({ token: { code: 10003 } });
    const code = await main(['verify'], { out: (s) => out.push(s), err: () => {}, env: { LARK_APP_ID: 'cli_x', LARK_APP_SECRET: SECRET }, deps: f.deps });
    expect(code).toBe(1);
    expect(out.join('\n')).not.toContain(SECRET);
  });
});
