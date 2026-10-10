import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import {
  ADMIN_REDACTED,
  ADMIN_WS_BEARER_PREFIX,
  ADMIN_WS_SUBPROTOCOL,
  AdminConfigDocument,
  AdminQueue,
  AdminSessions,
  AdminStatus,
  PROTOCOL_VERSION,
  RouteExplanation,
  check,
  errors,
  type Binding,
} from '@agents-io/protocol';
import { main } from '../src/cli.js';
import { ConfigError, resolveConfig } from '../src/config.js';
import { ConsoleAuth } from '../src/console.js';
import { consoleUrlPath } from '../src/token.js';
import { consoleDaemon, rawGet } from './console-helpers.js';
import { tmp, until } from './helpers.js';

const alice = { channelUserId: 'alice', evidence: 'platform_signed' as const };

describe('console auth', () => {
  it('needs a token: missing / wrong → 401; the host token works #SE-3', async () => {
    const w = await consoleDaemon();
    expect(await w.api('/api/status', { token: null })).toMatchObject({ status: 401, body: { error: { code: 'unauthorized' } } });
    expect(await w.api('/api/status', { token: 'nope' })).toMatchObject({ status: 401, body: { error: { code: 'unauthorized', message: 'wrong token' } } });
    expect((await w.api('/api/status', { headers: { Authorization: 'Basic abc' }, token: null })).status).toBe(401);
    const r = await w.api('/api/status');
    expect(r.status).toBe(200);
    expect(check(AdminStatus, r.body)).toBe(true);
    expect(r.body).toMatchObject({ protocol: PROTOCOL_VERSION, pid: process.pid, socket: w.config.socketPath, host: { connected: false }, channels: [{ id: 'fake', account: 'default', state: 'running' }], agents: [{ name: 'default', default: true }] });
    expect(r.headers.get('cache-control')).toBe('no-store');
  });

  it('login link → one-time token → session (cookie HttpOnly SameSite=Strict, and a bearer token); single use; sessions cannot make links #SE-3', async () => {
    const w = await consoleDaemon();
    const link = await w.api('/api/login-link', { method: 'POST', json: {} });
    expect(link.status).toBe(200);
    expect(link.body.url).toMatch(new RegExp(`^${w.url}/#login=[\\w-]+$`));
    const loginToken = link.body.url.split('#login=')[1];
    // A login needs no credentials; a wrong one-time token is 401.
    expect((await w.api('/api/login', { method: 'POST', json: { loginToken: 'bogus' }, token: null })).status).toBe(401);
    const login = await w.api('/api/login', { method: 'POST', json: { loginToken }, token: null });
    expect(login.status).toBe(200);
    expect(login.body.expiresAt).toBeGreaterThan(Date.now());
    const cookie = login.headers.get('set-cookie')!;
    expect(cookie).toMatch(new RegExp(`^${w.gw.console!.cookieName}=${login.body.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=\\d+$`));
    // Used once.
    expect(await w.api('/api/login', { method: 'POST', json: { loginToken }, token: null })).toMatchObject({ status: 401, body: { error: { code: 'unauthorized' } } });
    // The session works as a bearer token and as the cookie.
    expect((await w.api('/api/queue', { token: login.body.token })).status).toBe(200);
    expect((await w.api('/api/queue', { token: null, headers: { Cookie: `${w.gw.console!.cookieName}=${login.body.token}` } })).status).toBe(200);
    expect((await w.api('/api/queue', { token: null, headers: { Cookie: `${w.gw.console!.cookieName}=nope` } })).status).toBe(401);
    expect(await w.api('/api/login-link', { method: 'POST', json: {}, token: login.body.token })).toMatchObject({ status: 403, body: { error: { code: 'forbidden' } } });
    // A malformed body is 400.
    expect(await w.api('/api/login', { method: 'POST', json: { nope: 1 }, token: null })).toMatchObject({ status: 400, body: { error: { code: 'invalid_request' } } });
  });

  it('expired one-time tokens and sessions are refused #SE-3', () => {
    let now = 1_000_000;
    const auth = new ConsoleAuth('host-token', 60_000, () => now);
    expect(auth.check('host-token')).toEqual({ ok: true, role: 'host' });
    const l1 = auth.loginToken();
    now += 5 * 60_000 + 1;
    expect(auth.login(l1.token)).toBeUndefined();
    const s = auth.login(auth.loginToken().token)!;
    expect(s.expiresAt).toBe(now + 60_000);
    expect(auth.check(s.token)).toEqual({ ok: true, role: 'session' });
    now += 60_001;
    expect(auth.check(s.token)).toMatchObject({ ok: false, why: expect.stringContaining('expired') });
    expect(auth.check(s.token)).toMatchObject({ ok: false, why: 'wrong token' });
    expect(auth.check(undefined)).toMatchObject({ ok: false, why: expect.stringContaining('missing') });
  });

  it('aio serve writes the console URL next to the token file (0600) and removes it at stop #SE-2', async () => {
    const w = await consoleDaemon();
    const f = consoleUrlPath(w.config.socketPath);
    expect(readFileSync(f, 'utf8').trim()).toBe(w.url);
    expect(statSync(f).mode & 0o777).toBe(0o600);
    await w.stop();
    expect(existsSync(f)).toBe(false);
  });
});

describe('console listening and origins', () => {
  it('listens on 127.0.0.1 by default; a non-loopback host needs allowRemote #SE-3', async () => {
    const w = await consoleDaemon();
    expect(w.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const base = { env: {}, baseDir: w.dir, cwd: w.dir };
    expect(resolveConfig({}, base).console).toMatchObject({ enabled: true, host: '127.0.0.1', port: 7464, allowRemote: false, origins: [] });
    expect(() => resolveConfig({ console: { host: '0.0.0.0' } }, base)).toThrow(ConfigError);
    expect(() => resolveConfig({ console: { host: '192.168.1.5' } }, base)).toThrow(/not a loopback address/);
    expect(resolveConfig({ console: { host: '0.0.0.0', allowRemote: true, allowedHosts: ['aio.lan'] } }, base).console.host).toBe('0.0.0.0');
    expect(resolveConfig({ console: { host: '::1' } }, base).console.host).toBe('::1');
    expect(() => resolveConfig({ console: { origins: ['https://ui.example/path'] } }, base)).toThrow(/not an origin/);
  });

  it('refuses foreign Host headers (DNS rebinding) and Origins; CORS only for configured origins #SE-3', async () => {
    const w = await consoleDaemon({ raw: { console: { origins: ['https://ui.example'] } } });
    const auth = `Bearer ${w.gw.token}`;
    const port = new URL(w.url).port;
    expect((await rawGet(w.url, '/api/status', { Host: `evil.example:${port}`, Authorization: auth })).status).toBe(403);
    expect((await rawGet(w.url, '/api/status', { Host: `localhost:${port}`, Authorization: auth })).status).toBe(200);
    expect((await w.api('/api/status', { headers: { Origin: 'https://evil.example' } })).status).toBe(403);
    // Same origin is fine; no CORS headers needed.
    const same = await w.api('/api/status', { headers: { Origin: w.url } });
    expect(same.status).toBe(200);
    expect(same.headers.get('access-control-allow-origin')).toBeNull();
    const ok = await w.api('/api/status', { headers: { Origin: 'https://ui.example' } });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('access-control-allow-origin')).toBe('https://ui.example');
    expect(ok.headers.get('access-control-allow-credentials')).toBeNull();
    const pre = await rawGet(w.url, '/api/config', { method: 'OPTIONS', Host: `127.0.0.1:${port}`, Origin: 'https://ui.example', 'Access-Control-Request-Method': 'PUT' });
    expect(pre.status).toBe(204);
    expect(pre.headers['access-control-allow-headers']).toContain('Authorization');
    expect((await rawGet(w.url, '/api/config', { method: 'OPTIONS', Host: `127.0.0.1:${port}`, Origin: 'https://evil.example' })).status).toBe(403);
  });
});

describe('console config', () => {
  const secretRaw = (dir: string) => ({
    dataDir: dir,
    policy: { owners: ['fake:alice'] },
    local: { principal: 'me' },
    cwd: join(dir, 'work'),
    console: { port: 0 },
    channels: [{ type: 'mail', config: { user: 'me@example.com', password: 'hunter2', imap: { host: 'imap.example.com', pass: 'env:MAIL_IMAP_PASS' }, token: 'env:MAIL_TOKEN' } }],
  });

  async function withSecrets() {
    const w = await consoleDaemon({ consoleEnv: { MAIL_TOKEN: 'tok-value' } });
    const path = join(w.dir, 'aio.config.json');
    writeFileSync(path, JSON.stringify(secretRaw(w.dir), null, 2), { mode: 0o600 });
    return { w, path };
  }

  it('GET never shows secret values: literals are redacted, env: references listed as set / unset #SE-1', async () => {
    const { w, path } = await withSecrets();
    const r = await w.api('/api/config');
    expect(r.status).toBe(200);
    expect(check(AdminConfigDocument, r.body)).toBe(true);
    const doc = r.body as AdminConfigDocument;
    expect(doc.path).toBe(path);
    expect(JSON.stringify(doc)).not.toContain('hunter2');
    expect(JSON.stringify(doc)).not.toContain('tok-value');
    expect((doc.config.channels as any)[0].config).toEqual({ user: 'me@example.com', password: ADMIN_REDACTED, imap: { host: 'imap.example.com', pass: 'env:MAIL_IMAP_PASS' }, token: 'env:MAIL_TOKEN' });
    expect(doc.env).toEqual([
      { name: 'MAIL_IMAP_PASS', set: false },
      { name: 'MAIL_TOKEN', set: true },
    ]);
    expect(doc.issues).toContainEqual(expect.objectContaining({ path: '/channels/0/config/password', code: 'inline_secret', severity: 'warning' }));
  });

  it('PUT: redacted values keep the stored ones, new literal secrets are refused (422, nothing written), stale revisions 409; writes are atomic and 0600 #SE-1 #SE-2', async () => {
    const { w, path } = await withSecrets();
    const doc = (await w.api('/api/config')).body as AdminConfigDocument;
    const before = readFileSync(path, 'utf8');

    // A new literal secret: refused, file untouched.
    const leak = structuredClone(doc.config) as any;
    leak.channels[0].config.token = 'new-literal';
    const bad = await w.api('/api/config', { method: 'PUT', json: { config: leak, ifRevision: doc.revision } });
    expect(bad.status).toBe(422);
    expect(bad.body).toMatchObject({ valid: false, issues: expect.arrayContaining([expect.objectContaining({ path: '/channels/0/config/token', code: 'inline_secret', severity: 'error' })]) });
    expect(JSON.stringify(bad.body)).not.toContain('hunter2');
    expect(readFileSync(path, 'utf8')).toBe(before);

    // Schema errors carry a JSON pointer.
    const schema = await w.api('/api/config/validate', { method: 'POST', json: { config: { ...doc.config, outputTools: 'yes' } } });
    expect(schema.body).toMatchObject({ valid: false, issues: expect.arrayContaining([expect.objectContaining({ path: '/outputTools', code: 'schema', severity: 'error' })]) });
    // Startup checks too (an unknown default agent).
    const sem = await w.api('/api/config/validate', { method: 'POST', json: { config: { ...doc.config, defaultAgent: 'ghost' } } });
    expect(sem.body.valid).toBe(false);
    expect(sem.body.issues).toContainEqual(expect.objectContaining({ code: 'invalid', path: '/defaultAgent' }));

    // Startup would fail while MAIL_IMAP_PASS is unset; the env file is read afresh for every check.
    expect((await w.api('/api/config/validate', { method: 'POST', json: { config: doc.config } })).body.issues).toContainEqual(expect.objectContaining({ code: 'invalid', severity: 'error', message: expect.stringContaining('MAIL_IMAP_PASS is not set') }));
    writeFileSync(join(w.dir, '.env.live'), 'MAIL_IMAP_PASS=imap-secret\n', { mode: 0o600 });
    expect((await w.api('/api/config')).body.env).toContainEqual({ name: 'MAIL_IMAP_PASS', set: true });

    // A real change: the redacted password is kept, the file is rewritten 0600, a restart is needed.
    const next = structuredClone(doc.config) as any;
    next.outputTools = false;
    const ok = await w.api('/api/config', { method: 'PUT', json: { config: next, ifRevision: doc.revision } });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ applied: 'restart' });
    expect(ok.body.revision).not.toBe(doc.revision);
    const written = JSON.parse(readFileSync(path, 'utf8'));
    expect(written.channels[0].config.password).toBe('hunter2');
    expect(written.outputTools).toBe(false);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readdirSync(w.dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    expect((await w.api('/api/config')).body.revision).toBe(ok.body.revision);

    // The old revision is stale now.
    expect(await w.api('/api/config', { method: 'PUT', json: { config: next, ifRevision: doc.revision } })).toMatchObject({ status: 409, body: { error: { code: 'conflict' } } });
    // REDACTED where nothing is stored is an error.
    const ghost = structuredClone(next);
    ghost.channels[0].config.secret = ADMIN_REDACTED;
    expect((await w.api('/api/config', { method: 'PUT', json: { config: ghost } })).body.issues).toContainEqual(expect.objectContaining({ code: 'redacted_without_value' }));
  });
});

describe('console: explain, queue, sessions', () => {
  it('match the protocol schemas and the daemon state #PR-1', async () => {
    const w = await consoleDaemon();
    const h = await w.host({ name: 'xwo', consumer: 'xwo' });
    h.onRequest('inbound', () => new Promise(() => {})); // never accepts: the item stays pending
    const rule: Binding = { id: 'to-host', match: { channel: 'fake', keywords: ['xwo'] }, on: 'host' };
    await h.bindingsPut({ version: 't1', bindings: [rule], identities: [], onHostDown: 'keep' });
    const dm = await w.chat.inject({ id: 'm1', sender: alice, text: 'hello' });
    await w.chat.inject({ id: 'm2', sender: alice, conversation: { id: 'g1', kind: 'group' }, text: 'xwo please' });
    await until(() => w.gw.hostQueue.head() === 1);
    await until(() => w.gw.sessions().find((s) => s.sessionKey === 'fake:default:c1' && s.head > 3 && !s.turnId));

    const e = await w.api(`/api/explain/${encodeURIComponent(dm.inputId!)}`);
    expect(e.status).toBe(200);
    expect(check(RouteExplanation, e.body)).toBe(true);
    expect(e.body).toMatchObject({ inputId: dm.inputId, principal: 'fake:alice', matched: [expect.objectContaining({ on: 'dispatch' })] });
    expect(await w.api('/api/explain/in_nope')).toMatchObject({ status: 404, body: { error: { code: 'unknown_input' } } });

    const q = await w.api('/api/queue');
    expect(check(AdminQueue, q.body)).toBe(true);
    expect(q.body).toMatchObject({ head: 1, consumers: [{ consumer: 'xwo', acked: 0, pending: 1, push: true, oldestPendingAt: expect.any(Number) }] });

    const s = await w.api('/api/sessions');
    expect(check(AdminSessions, s.body)).toBe(true);
    const mine = (s.body as AdminSessions).sessions.find((x) => x.sessionKey === 'fake:default:c1')!;
    expect(mine).toMatchObject({ agent: 'default', conversation: 'fake:default:c1', live: true, lastEventAt: expect.any(Number) });

    const st = (await w.api('/api/status')).body as AdminStatus;
    expect(st.host).toMatchObject({ connected: true, name: 'xwo', consumer: 'xwo', callouts: false, table: { version: 't1', active: true } });
    expect(st.queue.head).toBe(1);
    expect(st.sessions.total).toBeGreaterThanOrEqual(1);
    expect(errors(AdminStatus, st)).toEqual([]);
  });
});

describe('console /ws', () => {
  /** A ws client that collects frames; `ask` sends a request and waits for its result. */
  function wsClient(ws: WebSocket) {
    const frames: any[] = [];
    ws.on('message', (d) => frames.push(JSON.parse(d.toString())));
    let n = 0;
    const ask = async (f: Record<string, unknown>) => {
      const id = `r${++n}`;
      ws.send(JSON.stringify({ v: PROTOCOL_VERSION, id, ...f }));
      return until(() => frames.find((x) => x.type === 'result' && x.id === id));
    };
    return { frames, ask };
  }
  const opened = (ws: WebSocket) =>
    new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });

  it('speaks the client frames: sessions, subscribe + input round-trip, as the console principal #ID-3 #SE-3', async () => {
    const origins: unknown[] = [];
    const w = await consoleDaemon({
      script: async (t) => {
        origins.push(...t.inputs.map((i) => i.origin));
        t.emit({ t: 'text.snapshot', text: `echo: ${t.inputs.flatMap((i) => i.content).map((c) => (c.type === 'text' ? c.text : '')).join(' ')}`, final: true }, { audience: 'answer' });
      },
    });
    const ws = new WebSocket(`${w.url.replace('http', 'ws')}/ws`, [ADMIN_WS_SUBPROTOCOL], { headers: { Authorization: `Bearer ${w.gw.token}` } });
    await opened(ws);
    expect(ws.protocol).toBe(ADMIN_WS_SUBPROTOCOL);
    const c = wsClient(ws);
    expect(await c.ask({ type: 'sessions' })).toMatchObject({ ok: true, value: [] });
    const sub = await c.ask({ type: 'command', command: { type: 'subscribe', sessionKey: 'local:main', tier: 'full' } });
    expect(sub).toMatchObject({ ok: true, value: { head: 0 } });
    const inp = await c.ask({ type: 'command', command: { type: 'input', sessionKey: 'local:main', mode: 'queue', input: { content: [{ type: 'text', text: 'hi there' }] } } });
    expect(inp).toMatchObject({ ok: true, value: { disposition: expect.any(String) } });
    const answer = await until(() => c.frames.find((f) => f.type === 'event' && f.event.body.t === 'text.snapshot' && f.event.body.final));
    expect(answer.event.body.text).toBe('echo: hi there');
    await until(() => c.frames.find((f) => f.type === 'event' && f.event.body.t === 'turn.completed'));
    // The console principal: the local owner, marked as coming via the console.
    expect(origins).toEqual([expect.objectContaining({ kind: 'human', principal: { id: 'me', labels: ['owner'] }, adapter: 'console', via: 'console' })]);
    // Bad JSON and unknown frames are answered, not fatal.
    ws.send('not json');
    await until(() => c.frames.find((f) => f.type === 'result' && f.error?.code === 'bad_json'));
    expect(await c.ask({ type: 'nope' })).toMatchObject({ ok: false, error: { code: 'invalid_frame' } });
    expect(await c.ask({ type: 'bindings.get' })).toMatchObject({ ok: false, error: { code: 'unauthorized' } });
    ws.close();
  });

  it('host frames after host.hello with the host token; browsers authenticate with the bearer subprotocol #SE-3', async () => {
    const w = await consoleDaemon();
    // The global (browser-like) WebSocket cannot set headers: the token rides in the subprotocol list.
    const g = new globalThis.WebSocket(`${w.url.replace('http', 'ws')}/ws`, [ADMIN_WS_SUBPROTOCOL, ADMIN_WS_BEARER_PREFIX + w.gw.token]);
    const frames: any[] = [];
    g.onmessage = (m) => frames.push(JSON.parse(String(m.data)));
    await new Promise<void>((resolve, reject) => {
      g.onopen = () => resolve();
      g.onerror = () => reject(new Error('ws error'));
    });
    expect(g.protocol).toBe(ADMIN_WS_SUBPROTOCOL);
    g.send(JSON.stringify({ v: PROTOCOL_VERSION, type: 'host.hello', id: 'h1', token: w.gw.token, name: 'web' }));
    expect(await until(() => frames.find((f) => f.id === 'h1'))).toMatchObject({ ok: true, value: { name: 'web', host: false } });
    g.send(JSON.stringify({ v: PROTOCOL_VERSION, type: 'bindings.get', id: 'b1' }));
    expect(await until(() => frames.find((f) => f.id === 'b1'))).toMatchObject({ ok: true, value: { host: null } });
    g.close();
  });

  it('refuses the upgrade without a valid token, from a foreign origin, or on another path #SE-3', async () => {
    const w = await consoleDaemon();
    const status = (url: string, protocols: string[], headers: Record<string, string> = {}) =>
      new Promise<number>((resolve) => {
        const ws = new WebSocket(url, protocols, { headers });
        ws.on('unexpected-response', (_req, res) => resolve(res.statusCode!));
        ws.on('open', () => {
          ws.close();
          resolve(101);
        });
        ws.on('error', () => undefined);
      });
    const base = w.url.replace('http', 'ws');
    expect(await status(`${base}/ws`, [ADMIN_WS_SUBPROTOCOL])).toBe(401);
    expect(await status(`${base}/ws`, [ADMIN_WS_SUBPROTOCOL, `${ADMIN_WS_BEARER_PREFIX}wrong`])).toBe(401);
    expect(await status(`${base}/ws`, [ADMIN_WS_SUBPROTOCOL], { Authorization: `Bearer ${w.gw.token}`, Origin: 'https://evil.example' })).toBe(403);
    expect(await status(`${base}/other`, [ADMIN_WS_SUBPROTOCOL], { Authorization: `Bearer ${w.gw.token}` })).toBe(404);
    expect(await status(`${base}/ws`, [ADMIN_WS_SUBPROTOCOL], { Authorization: `Bearer ${w.gw.token}` })).toBe(101);
  });
});

describe('console config: credentials by schema', () => {
  // Every value below is a credential; none may come back from GET /api/config.
  const SECRETS = ['imap-pw-1', 'smtp-pw-2', 'oauth-tok-3', 'ghp_pat4', 'sk-openai5', 'xoxb-slack6', 'mcp-env7', 'Bearer mcp-hdr8', 'settings-env9', 'codex-hdr10', 'codex-bearer11', 'codex-mcp12', 'bridge-env13', 'ARGTOK14', 'lark-secret15', 'lark-enc16', 'hdr-anywhere17', 'env-file-secret18'];
  /** The repo's example config, plus the shapes real configs carry secrets in (all literal). */
  const realWorld = (dir: string) => {
    const ex = JSON.parse(readFileSync(fileURLToPath(new URL('../aio.config.example.json', import.meta.url)), 'utf8'));
    ex.dataDir = dir;
    ex.cwd = join(dir, 'work');
    ex.console = { port: 0 };
    ex.harnesses.claude.env = { GH_PAT: 'ghp_pat4', OPENAI_KEY: 'sk-openai5', SLACK_BOT: 'xoxb-slack6' };
    ex.harnesses.claude.mcpServers = { gh: { command: 'gh-mcp', env: { GH: 'mcp-env7' } }, web: { type: 'http', url: 'https://mcp.example', headers: { Authorization: 'Bearer mcp-hdr8' } } };
    ex.harnesses.claude.settings = { env: { SOME_VAR: 'settings-env9' } };
    ex.harnesses.codex.config = { 'model_providers.p.http_headers': { 'X-Key': 'codex-hdr10' }, 'mcp_servers.m.bearer_token': 'codex-bearer11', 'mcp_servers.s.env': { TOK: 'codex-mcp12' } };
    ex.harnesses.codex.options = { client: { headers: { 'X-Api': 'hdr-anywhere17' } } };
    ex.channels[0].config = { appId: 'cli_example', appSecret: 'lark-secret15', encryptKey: 'lark-enc16', maxChars: 4000 };
    ex.channels[1].env.API = 'bridge-env13';
    ex.channels[1].args = ['echo_channel.py', '--token', 'ARGTOK14'];
    ex.channels.push({
      type: 'mail',
      account: 'work',
      config: {
        account: 'work',
        from: 'me@example.com',
        imap: { host: 'imap.example.com', port: 993, secure: true, auth: { user: 'me@example.com', pass: 'imap-pw-1', accessToken: 'oauth-tok-3' } },
        smtp: { host: 'smtp.example.com', port: 465, secure: true, auth: { user: 'me@example.com', pass: 'smtp-pw-2' } },
      },
    });
    return ex;
  };

  async function realWorldDaemon() {
    const w = await consoleDaemon();
    const path = join(w.dir, 'aio.config.json');
    writeFileSync(path, JSON.stringify(realWorld(w.dir), null, 2), { mode: 0o600 });
    writeFileSync(join(w.dir, '.env.live'), 'LARK_APP_ID=cli_x\nLARK_APP_SECRET=env-file-secret18\n', { mode: 0o600 });
    return { w, path };
  }

  it('GET of a real-world config (mail pass, env maps, headers, codex config, bridge args, lark config) shows no secret string anywhere #SE-1', async () => {
    const { w } = await realWorldDaemon();
    const r = await w.api('/api/config');
    expect(r.status).toBe(200);
    expect(check(AdminConfigDocument, r.body)).toBe(true);
    const text = JSON.stringify(r.body);
    for (const s of SECRETS) expect(text, s).not.toContain(s);
    const cfg = r.body.config as any;
    expect(cfg.channels[2].config.imap.auth).toEqual({ user: 'me@example.com', pass: ADMIN_REDACTED, accessToken: ADMIN_REDACTED });
    expect(cfg.channels[2].config.smtp.auth.pass).toBe(ADMIN_REDACTED);
    expect(cfg.harnesses.claude.env).toEqual({ GH_PAT: ADMIN_REDACTED, OPENAI_KEY: ADMIN_REDACTED, SLACK_BOT: ADMIN_REDACTED });
    // Non-secret settings stay readable; env: references are shown as written.
    expect(cfg.channels[2].config.imap.host).toBe('imap.example.com');
    expect(cfg.channels[0].config.maxChars).toBe(4000);
    expect(cfg.channels[1].args.slice(0, 2)).toEqual(['echo_channel.py', '--token']);
    expect(cfg.harnesses['claude-gateway'].env.ANTHROPIC_BASE_URL).toBe('env:GATEWAY_BASE_URL');
    expect(r.body.issues).toContainEqual(expect.objectContaining({ path: '/channels/2/config/imap/auth/pass', code: 'inline_secret', severity: 'warning' }));
  });

  it('PUT refuses literals in credential fields whatever their name, keeps stored values for the marker, and honours the marker only on credential fields #SE-1', async () => {
    const { w, path } = await realWorldDaemon();
    const doc = (await w.api('/api/config')).body as AdminConfigDocument;
    const before = readFileSync(path, 'utf8');
    for (const [where, set] of [
      ['/channels/2/config/smtp/auth/pass', (c: any) => (c.channels[2].config.smtp.auth.pass = 'new-pw')],
      ['/harnesses/claude/env/GH_PAT', (c: any) => (c.harnesses.claude.env.GH_PAT = 'ghp_new')],
      ['/channels/1/env/OTHER', (c: any) => (c.channels[1].env.OTHER = 'plain')],
      ['/harnesses/claude/mcpServers/web/headers/X-Extra', (c: any) => (c.harnesses.claude.mcpServers.web.headers['X-Extra'] = 'v')],
    ] as const) {
      const next = structuredClone(doc.config) as any;
      set(next);
      const r = await w.api('/api/config', { method: 'PUT', json: { config: next, ifRevision: doc.revision } });
      expect(r.status, where).toBe(422);
      expect(r.body.issues).toContainEqual(expect.objectContaining({ path: where, code: 'inline_secret', severity: 'error' }));
      for (const s of SECRETS) expect(JSON.stringify(r.body)).not.toContain(s);
    }
    expect(readFileSync(path, 'utf8')).toBe(before);
    // The marker is not a way to copy a stored secret into a field GET would show.
    const moved = structuredClone(doc.config) as any;
    moved.channels[2].config.imap.host = ADMIN_REDACTED;
    expect((await w.api('/api/config/validate', { method: 'POST', json: { config: moved } })).body.issues).toContainEqual(expect.objectContaining({ path: '/channels/2/config/imap/host', code: 'redacted_without_value' }));
    // Sent back unchanged (markers everywhere), every stored value is kept.
    const same = structuredClone(doc.config) as any;
    same.outputTools = false;
    const ok = await w.api('/api/config', { method: 'PUT', json: { config: same, ifRevision: doc.revision } });
    expect(ok.body.issues?.filter((i: any) => i.severity === 'error')).toEqual([]);
    expect(ok.status).toBe(200);
    const written = JSON.parse(readFileSync(path, 'utf8'));
    expect(written.channels[2].config.imap.auth.pass).toBe('imap-pw-1');
    expect(written.harnesses.claude.env.GH_PAT).toBe('ghp_pat4');
    expect(written.channels[1].args[2]).toBe('ARGTOK14');
  });
});

describe('console URL file and console-link', () => {
  it('aio console-link never sends the host token to a listener that is not this daemon #SE-3', async () => {
    const w = await consoleDaemon();
    const { createServer } = await import('node:http');
    const seen: (string | undefined)[] = [];
    const foreign = createServer((req, res) => {
      seen.push(req.headers.authorization);
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ url: 'http://evil/#login=x', proof: 'x' }));
    });
    await new Promise<void>((r) => foreign.listen(0, '127.0.0.1', () => r()));
    try {
      const port = (foreign.address() as { port: number }).port;
      writeFileSync(consoleUrlPath(w.config.socketPath), `http://127.0.0.1:${port}\n`, { mode: 0o600 });
      const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      try {
        await expect(main(['console-link', '--socket', w.config.socketPath])).rejects.toThrow(/not this daemon's console; the host token was not sent/);
      } finally {
        err.mockRestore();
        log.mockRestore();
      }
      expect(seen.some((a) => a?.includes(w.gw.token))).toBe(false);
    } finally {
      foreign.close();
    }
  });
});

describe('console cookie scope', () => {
  it('the cookie name is per daemon; a session works only through the Host it logged in with #SE-3', async () => {
    const a = await consoleDaemon();
    const b = await consoleDaemon();
    expect(a.gw.console!.cookieName).toMatch(/^aio_console_[0-9a-f]{12,}$/);
    expect(a.gw.console!.cookieName).not.toBe(b.gw.console!.cookieName);
    const link = await a.api('/api/login-link', { method: 'POST', json: {} });
    const login = await a.api('/api/login', { method: 'POST', json: { loginToken: link.body.url.split('#login=')[1] }, token: null });
    expect(login.headers.get('set-cookie')).toMatch(new RegExp(`^${a.gw.console!.cookieName}=[\\w-]+; HttpOnly; SameSite=Strict; Path=/; Max-Age=\\d+$`));
    const port = new URL(a.url).port;
    expect((await rawGet(a.url, '/api/queue', { Host: `127.0.0.1:${port}`, Authorization: `Bearer ${login.body.token}` })).status).toBe(200);
    expect((await rawGet(a.url, '/api/queue', { Host: `localhost:${port}`, Authorization: `Bearer ${login.body.token}` })).status).toBe(401);
    expect((await rawGet(a.url, '/api/queue', { Host: `127.0.0.1:${port}`, Cookie: `aio_console=${login.body.token}` })).status).toBe(401);
  });

  it('/ws: a valid bearer subprotocol wins over a stale cookie #SE-3', async () => {
    const w = await consoleDaemon();
    const code = await new Promise<number>((resolve) => {
      const ws = new WebSocket(`${w.url.replace('http', 'ws')}/ws`, [ADMIN_WS_SUBPROTOCOL, ADMIN_WS_BEARER_PREFIX + w.gw.token], { headers: { Cookie: `aio_console=stale; ${w.gw.console!.cookieName ?? "aio_console"}=stale` } });
      ws.on('unexpected-response', (_q, res) => resolve(res.statusCode!));
      ws.on('open', () => {
        ws.close();
        resolve(101);
      });
      ws.on('error', () => undefined);
    });
    expect(code).toBe(101);
  });
});

describe('console allowed hosts', () => {
  it('a wildcard bind with allowRemote needs console.allowedHosts, and accepts those Host values #SE-3', async () => {
    const base = { env: {}, baseDir: tmp(), cwd: tmp() };
    expect(() => resolveConfig({ console: { host: '0.0.0.0', allowRemote: true } }, base)).toThrow(/allowedHosts/);
    expect(resolveConfig({ console: { host: '0.0.0.0', allowRemote: true, allowedHosts: ['aio.lan', '192.168.1.5'] } }, base).console.allowedHosts).toEqual(['aio.lan', '192.168.1.5']);
    const w = await consoleDaemon({ raw: { console: { host: '0.0.0.0', allowRemote: true, allowedHosts: ['aio.lan', '192.168.1.5'] } } });
    // The URL (and default login links) never name the wildcard address.
    expect(w.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const port = new URL(w.url).port;
    const auth = `Bearer ${w.gw.token}`;
    expect((await rawGet(w.url, '/api/status', { Host: `aio.lan:${port}`, Authorization: auth })).status).toBe(200);
    expect((await rawGet(w.url, '/api/status', { Host: `192.168.1.5:${port}`, Authorization: auth })).status).toBe(200);
    expect((await rawGet(w.url, '/api/status', { Host: `evil.example:${port}`, Authorization: auth })).status).toBe(403);
    expect((await rawGet(w.url, '/api/status', { Host: `0.0.0.0:${port}`, Authorization: auth })).status).toBe(403);
  });
});
