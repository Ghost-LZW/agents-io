import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { HostEventFrame, check, type InputRecord, type SessionEvent } from '@agents-io/protocol';
import { globMatch } from '@agents-io/host-mcp';
import { ConfigError, resolveConfig } from '../src/config.js';
import { EXTERNAL_EVENT } from '../src/external-mcp.js';
import { cleanups, daemon, tmp, until, type World } from './helpers.js';

/*
 * The external MCP endpoint (docs/design/external-mcp): agents outside the daemon read
 * sessions and write through it, each as a configured client. Driven end to end with the
 * MCP SDK's own client over Streamable HTTP.
 */

const TOKENS = { reader: 'reader-token-0123456789', ops: 'ops-token-0123456789abc', narrow: 'narrow-token-0123456789' };

/** Token files for the clients (0600 in a 0700 directory, as the daemon requires). */
function tokenFiles(dir: string): Record<keyof typeof TOKENS, string> {
  const d = join(dir, 'ext');
  mkdirSync(d, { recursive: true, mode: 0o700 });
  const out = {} as Record<keyof typeof TOKENS, string>;
  for (const [k, v] of Object.entries(TOKENS)) {
    const f = join(d, `${k}.token`);
    writeFileSync(f, v + '\n', { mode: 0o600 });
    out[k as keyof typeof TOKENS] = f;
  }
  return out;
}

async function world(o: { clients?: Record<string, unknown>; raw?: Record<string, unknown>; limits?: Record<string, unknown> } = {}) {
  const dir = tmp();
  const f = tokenFiles(dir);
  const clients = o.clients ?? {
    reader: { tokenFile: f.reader, scopes: ['read'] },
    ops: { tokenFile: f.ops, scopes: ['read', 'send:fake:default:*', 'send:nochan:*', 'input:S*'], declare: true },
    narrow: { tokenFile: f.narrow, scopes: ['read:S1', 'input:S1'] },
  };
  const w = await daemon({
    dir,
    raw: { externalMcp: { listen: '127.0.0.1:0', clients, ...(o.limits ? { limits: o.limits } : {}) }, ...(o.raw ?? {}) },
  });
  const url = w.gw.adminStatus().externalMcp!.url;
  return { w, url, dir };
}

async function mcp(url: string, token: string, headers: Record<string, string> = {}): Promise<Client> {
  const c = new Client({ name: 'outside', version: '0.0.1' });
  await c.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { authorization: `Bearer ${token}`, ...headers } } }));
  cleanups.push(() => c.close());
  return c;
}

async function call(c: Client, name: string, args: Record<string, unknown> = {}): Promise<{ isError: boolean; text: string; value: any }> {
  const r = (await c.callTool({ name, arguments: args })) as { isError?: boolean; content: { type: string; text: string }[] };
  const text = r.content[0]?.text ?? '';
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    value = undefined;
  }
  return { isError: r.isError === true, text, value };
}

const post = (url: string, init: { token?: string; headers?: Record<string, string>; body?: string } = {}) =>
  fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(init.token ? { authorization: `Bearer ${init.token}` } : {}), ...(init.headers ?? {}) },
    body: init.body ?? JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });

/** A POST with a Host header of our choosing (fetch does not let one set it). */
function postWithHost(url: string, token: string, host: string): Promise<number> {
  const u = new URL(url);
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
  return new Promise((resolve, reject) => {
    const req = request({ host: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers: { host, authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'content-length': Buffer.byteLength(body) } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end(body);
  });
}

const admitted = (w: World, key: string): InputRecord[] =>
  w.gw.hub.log
    .read(key, 0)
    .filter((e) => e.body.t === 'input.admitted')
    .map((e) => (e.body as { input: InputRecord }).input);

async function session(w: World, key: string, text = 'hello'): Promise<void> {
  const c = await w.client();
  await c.input(key, text);
  await until(() => w.gw.hub.log.read(key, 0).some((e) => e.body.t === 'turn.completed'));
}

describe('external MCP endpoint: off by default, loopback, tokens, limits', () => {
  it('is off without externalMcp (and with enabled: false): nothing listens, external.mcp is not advertised #SE-5', async () => {
    const w = await daemon();
    expect(w.gw.adminStatus().externalMcp).toBeUndefined();
    const c = await w.client();
    const hello = await c.hello({ token: w.gw.token, name: 'probe' });
    expect(hello.features).toContain('callouts.external');
    expect(hello.features).not.toContain('external.mcp');
    const off = resolveConfig({ externalMcp: { enabled: false, clients: { a: { token: 'env:T', scopes: ['read'] } } } }, { env: {}, baseDir: tmp(), cwd: tmp() });
    expect(off.externalMcp).toBeUndefined();
  });

  it('listens on loopback only; a literal token, a short one, a missing variable are config errors that never echo the value #SE-5 #SE-1', () => {
    const r = (x: Record<string, unknown>, env: Record<string, string> = {}) => () => resolveConfig({ externalMcp: x }, { env, baseDir: tmp(), cwd: tmp() });
    const client = { a: { token: 'env:T', scopes: ['read'] } };
    for (const listen of ['0.0.0.0:7465', '192.168.1.5:7465', 'localhost:7465', 'example.org:1']) expect(r({ listen, clients: client }, { T: 'x'.repeat(20) })).toThrow(/loopback/);
    expect(r({ clients: { a: { token: 'literal-secret-0123456789', scopes: ['read'] } } })).toThrow(ConfigError);
    expect(r({ clients: { a: { token: 'literal-secret-0123456789', scopes: ['read'] } } })).not.toThrow(/literal-secret/);
    expect(r({ clients: client }, { T: 'short' })).toThrow(/at least 16/);
    expect(r({ clients: client }, { T: 'short' })).not.toThrow(/short'/);
    expect(r({ clients: client })).toThrow(/T is not set/);
    expect(r({ clients: { a: { scopes: ['read'] } } })).toThrow(/exactly one of token/);
    const ok = resolveConfig({ externalMcp: { listen: '[::1]:0', clients: client } }, { env: { T: 'x'.repeat(20) }, baseDir: tmp(), cwd: tmp() });
    expect(ok.externalMcp).toMatchObject({ host: '::1', port: 0, clients: [{ name: 'a', principal: { id: 'external:a', labels: ['external'] } }] });
  });

  it('needs the bearer token of a configured client (401 otherwise), refuses browsers and foreign Host headers (403), bounds the body (413) #SE-5', async () => {
    const { url } = await world();
    expect((await post(url)).status).toBe(401);
    expect((await post(url, { token: 'not-a-client-token-0000' })).status).toBe(401);
    expect((await post(url, { token: TOKENS.reader })).status).toBe(200);
    expect((await post(url, { token: TOKENS.reader, headers: { origin: 'http://evil.example' } })).status).toBe(403);
    expect(await postWithHost(url, TOKENS.reader, 'evil.example')).toBe(403);
    expect(await postWithHost(url, TOKENS.reader, `localhost:${new URL(url).port}`)).toBe(200);
    expect((await fetch(url, { headers: { authorization: `Bearer ${TOKENS.reader}` } })).status).toBe(405);
    const big = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { pad: 'x'.repeat(300 * 1024) } });
    expect((await post(url, { token: TOKENS.reader, body: big })).status).toBe(413);
  });

  it('tokens: a token file is generated 0600 when missing; a client may not use the host token #SE-5 #HQ-7', async () => {
    const dir = tmp();
    const file = join(dir, 'gen', 'c.token');
    const w = await daemon({ dir, raw: { externalMcp: { listen: '127.0.0.1:0', clients: { c: { tokenFile: file, scopes: ['read'] } } } } });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(w.gw.adminStatus().externalMcp).toMatchObject({ clients: ['c'] });
    const hostTokenFile = join(tmp(), 'host.token');
    writeFileSync(hostTokenFile, 'host-token-0123456789abcdef\n', { mode: 0o600 });
    await expect(daemon({ raw: { host: { tokenFile: hostTokenFile }, externalMcp: { listen: '127.0.0.1:0', clients: { c: { tokenFile: hostTokenFile, scopes: ['read'] } } } } })).rejects.toThrow(/host token/);
  });

  it('rate-limits requests (429 with Retry-After) and writes per client #SE-5', async () => {
    const a = await world({ limits: { requestsPerMinute: 3 } });
    for (let i = 0; i < 3; i++) expect((await post(a.url, { token: TOKENS.reader })).status).toBe(200);
    const r = await post(a.url, { token: TOKENS.reader });
    expect(r.status).toBe(429);
    expect(Number(r.headers.get('retry-after'))).toBeGreaterThan(0);
    // Another client has its own budget.
    expect((await post(a.url, { token: TOKENS.ops })).status).toBe(200);
    const { w, url } = await world({ limits: { writesPerMinute: 1 } });
    const ops = await mcp(url, TOKENS.ops);
    expect((await call(ops, 'send_message', { route: 'fake:default:c1', text: 'one' })).isError).toBe(false);
    const second = await call(ops, 'send_message', { route: 'fake:default:c1', text: 'two' });
    expect(second).toMatchObject({ isError: true });
    expect(second.text).toMatch(/rate limited/);
    expect(w.chat.sent.filter((s) => s.msg.text === 'two')).toHaveLength(0);
  });

  it('only a client allowed to declare may say whom it acts for (X-Agents-IO-Declared) #SE-5 #ID-10', async () => {
    const { url } = await world();
    expect((await post(url, { token: TOKENS.reader, headers: { 'x-agents-io-declared': 'member-7' } })).status).toBe(403);
    expect((await post(url, { token: TOKENS.ops, headers: { 'x-agents-io-declared': 'has space' } })).status).toBe(403);
    expect((await post(url, { token: TOKENS.ops, headers: { 'x-agents-io-declared': 'member-7' } })).status).toBe(200);
  });
});

describe('external MCP endpoint: scopes', () => {
  it('denies by default: a client lists and may call only the tools its scopes allow #CF-10', async () => {
    const { url } = await world();
    const names = async (token: string) => (await (await mcp(url, token)).listTools()).tools.map((t) => t.name).sort();
    expect(await names(TOKENS.reader)).toEqual(['channels_status', 'explain', 'session_events', 'sessions_list']);
    expect(await names(TOKENS.ops)).toEqual(['channels_status', 'explain', 'send_message', 'session_events', 'session_input', 'sessions_list']);
    expect(await names(TOKENS.narrow)).toEqual(['explain', 'session_events', 'session_input', 'sessions_list']);
    const reader = await mcp(url, TOKENS.reader);
    const r = await call(reader, 'send_message', { route: 'fake:default:c1', text: 'x' });
    expect(r.isError).toBe(true);
    const none = resolveConfig({ externalMcp: { clients: { a: { token: 'env:T', scopes: [] } } } }, { env: { T: 'x'.repeat(20) }, baseDir: tmp(), cwd: tmp() });
    expect(none.externalMcp!.clients[0]!.scopes).toEqual({ read: [], readAll: false, send: [], input: [] });
    expect(() => resolveConfig({ externalMcp: { clients: { a: { token: 'env:T', scopes: ['write:*'] } } } }, { env: { T: 'x'.repeat(20) }, baseDir: tmp(), cwd: tmp() })).toThrow(/not a scope/);
  });

  it('read:<pattern> sees only matching sessions: list, events and explain; send:<pattern> and input:<pattern> bound the targets #CF-10', async () => {
    const { w, url } = await world();
    await session(w, 'S1');
    await session(w, 'T9');
    const narrow = await mcp(url, TOKENS.narrow);
    const list = await call(narrow, 'sessions_list');
    expect(list.value.sessions.map((s: { sessionKey: string }) => s.sessionKey)).toEqual(['S1']);
    expect((await call(narrow, 'session_events', { session: 'S1' })).isError).toBe(false);
    expect((await call(narrow, 'session_events', { session: 'T9' })).text).toMatch(/not in your read scope/);
    const ops0 = await mcp(url, TOKENS.ops);
    await session(w, 'S2');
    const other = await call(ops0, 'session_input', { session: 'S2', text: 'x' });
    expect((await call(narrow, 'explain', { id: other.value.inputId })).text).toMatch(/outside your read scope/);
    expect((await call(narrow, 'session_input', { session: 'T9', text: 'x' })).text).toMatch(/not in your input scope/);
    const ops = await mcp(url, TOKENS.ops);
    expect((await call(ops, 'send_message', { route: 'other:default:c1', text: 'x' })).text).toMatch(/not in your send scope/);
    expect(w.chat.sent).toHaveLength(0);
    expect(globMatch('fake:default:*', 'fake:default:c1:th')).toBe(true);
    expect(globMatch('lb:a1:*', 'lb:a10:x')).toBe(false);
    expect(globMatch('S1', 'S10')).toBe(false);
  });

  it('a host listing the external hook decides every write; deny, timeout, error, bad answers and the host being away deny #CF-10 #DL-6 #PR-1', async () => {
    const { w, url } = await world({ raw: { hostCallouts: { external: { timeoutMs: 100 } } } });
    await session(w, 'S1');
    const h = await w.host({ callouts: ['external'] });
    const asked: Record<string, any>[] = [];
    let answer: 'allow' | 'deny' | 'bad' | 'error' | 'slow' = 'deny';
    h.onRequest('policy', async (f) => {
      asked.push(f);
      if (answer === 'error') throw new Error('boom');
      if (answer === 'slow') await new Promise((r) => setTimeout(r, 400));
      return answer === 'bad' ? { verdict: 'maybe' } : { verdict: answer, ...(answer === 'deny' ? { reason: 'not for you' } : {}) };
    });
    const ops = await mcp(url, TOKENS.ops, { 'x-agents-io-declared': 'member-7' });
    const denied = await call(ops, 'send_message', { route: 'fake:default:c1', text: 'nope' });
    expect(denied.text).toMatch(/denied by the host: not for you/);
    expect(asked[0]).toMatchObject({ hook: 'external', args: { client: 'ops', principal: 'external:ops', declared: 'member-7', op: 'send', route: { channel: 'fake', account: 'default', conversationId: 'c1' }, content: [{ type: 'text', text: 'nope' }] } });
    // The frame is what the protocol says (PR-1).
    expect(check(HostEventFrame, asked[0])).toBe(true);
    expect((await call(ops, 'session_input', { session: 'S1', text: 'nope' })).text).toMatch(/denied by the host/);
    expect(asked[1]).toMatchObject({ hook: 'external', args: { op: 'input', sessionKey: 'S1' } });
    for (const a of ['bad', 'error', 'slow'] as const) {
      answer = a;
      expect((await call(ops, 'send_message', { route: 'fake:default:c1', text: a })).text).toMatch(/denied/);
    }
    expect(w.chat.sent).toHaveLength(0);
    answer = 'allow';
    expect((await call(ops, 'send_message', { route: 'fake:default:c1', text: 'yes' })).isError).toBe(false);
    expect(w.chat.sent.map((s) => s.msg.text)).toEqual(['yes']);
    // The host goes away (also across a restart, like outbound): every external write is denied until it is back.
    h.close();
    await until(() => !w.gw.host.answers('external'));
    expect((await call(ops, 'send_message', { route: 'fake:default:c1', text: 'away' })).text).toMatch(/not connected/);
    expect((await call(ops, 'session_input', { session: 'S1', text: 'away' })).text).toMatch(/not connected/);
    expect(w.chat.sent.map((s) => s.msg.text)).toEqual(['yes']);
    // A host without the hook hands writes back to the scopes.
    await w.host({ callouts: ['route'] });
    expect((await call(ops, 'send_message', { route: 'fake:default:c1', text: 'back' })).isError).toBe(false);
  });
});

describe('external MCP endpoint: stamping, loop guard, sends, explain', () => {
  it('an input is stamped by the daemon: kind peer, the client principal (never a person), evidence device_only, a cause, a routing record; the turn runs restricted #ID-10', async () => {
    const { w, url } = await world();
    await session(w, 'S1');
    const ops = await mcp(url, TOKENS.ops, { 'x-agents-io-declared': 'member-7' });
    const r = await call(ops, 'session_input', { session: 'S1', text: 'status please' });
    expect(r.value).toMatchObject({ ok: true, session: 'S1', inputId: expect.stringMatching(/^ext_/) });
    await until(() => w.gw.hub.log.read('S1', 0).filter((e) => e.body.t === 'turn.completed').length === 2);
    const input = admitted(w, 'S1').find((i) => i.inputId === r.value.inputId)!;
    expect(input.origin).toEqual({ kind: 'peer', principal: { id: 'external:ops', labels: ['external'] }, evidence: 'device_only', declared: 'member-7', via: 'external:ops', adapter: 'external-mcp' });
    expect(input.cause).toEqual({ peer: 'external:ops', basis: 'none' });
    expect(input.channelContext).toMatchObject({ channel: 'external-mcp', client: 'ops' });
    const started = w.gw.hub.log.read('S1', 0).filter((e) => e.body.t === 'turn.started').at(-1)!.body as { run: { profile: string } };
    expect(started.run.profile).toBe('restricted');
    const ex = await call(ops, 'explain', { id: input.inputId });
    expect(ex.value).toMatchObject({ inputId: input.inputId, principal: 'external:ops', evidence: 'device_only', matched: [{ bindingId: 'external:ops', on: 'dispatch', sessionKey: 'S1' }], cause: { peer: 'external:ops', basis: 'none' } });
    // The answer is in the log, read through the endpoint.
    const ev = await call(ops, 'session_events', { session: 'S1', tier: 'final' });
    expect(ev.value.events.map((e: SessionEvent) => e.body).filter((b: { t: string }) => b.t === 'text.snapshot').at(-1)).toMatchObject({ text: 'echo: status please' });
    // Unknown sessions, task runs and delivery logs take no input.
    for (const key of ['S-new', 'run:r1', 'external:ops', 'host:xwo']) expect((await call(ops, 'session_input', { session: key, text: 'x' })).isError).toBe(true);
  });

  it('an external principal is never a person: owner labels, owner ids and non-external principals are config errors #ID-10', () => {
    const r = (c: Record<string, unknown>) => () => resolveConfig({ policy: { owners: ['fake:alice'] }, externalMcp: { clients: { a: { token: 'env:T', scopes: ['read'], ...c } } } }, { env: { T: 'x'.repeat(20) }, baseDir: tmp(), cwd: tmp() });
    expect(r({ labels: ['owner'] })).toThrow(/owner/);
    expect(r({ principal: 'fake:alice' })).toThrow(/external:/);
    expect(r({ principal: 'agent:dev' })).toThrow(/external:/);
    expect(r({ principal: 'external:laptop', labels: ['ops'] })()).toMatchObject({ externalMcp: { clients: [{ principal: { id: 'external:laptop', labels: ['external', 'ops'] } }] } });
  });

  it('inputs from outside pass the lane checkpoint: past pair.maxTurns they are kept as context, with a loop_guard notice #IN-8 #ID-10', async () => {
    const { w, url } = await world({ raw: { policy: { owners: ['fake:alice'], loopGuard: { pair: { maxTurns: 2 } } } } });
    await session(w, 'S1');
    const ops = await mcp(url, TOKENS.ops);
    const results = [];
    for (let i = 0; i < 3; i++) {
      results.push(await call(ops, 'session_input', { session: 'S1', text: `again ${i}` }));
      await until(() => w.gw.hub.log.read('S1', 0).filter((e) => e.body.t === 'turn.completed').length >= Math.min(i + 2, 3));
    }
    expect(results[2]!.value).toMatchObject({ disposition: 'observe_only' });
    const notices = w.gw.hub.log.read('S1', 0).filter((e) => e.body.t === 'notice' && (e.body as { code: string }).code === 'loop_guard');
    expect(notices).toHaveLength(1);
    expect(admitted(w, 'S1').find((i) => i.inputId === results[2]!.value.inputId)!.channelContext.loopGuard).toBe('pair');
    // A person writing there lifts it.
    const c = await w.client();
    await c.input('S1', 'me again');
    await until(() => w.gw.hub.log.read('S1', 0).filter((e) => e.body.t === 'turn.completed').length === 4);
    expect((await call(ops, 'session_input', { session: 'S1', text: 'after' })).value.disposition).not.toBe('observe_only');
  });

  it('a send goes through the outbox once per operation_id, is recorded in the client log and the outbound records #DL-6 #DL-2', async () => {
    const { w, url } = await world();
    const ops = await mcp(url, TOKENS.ops, { 'x-agents-io-declared': 'member-7' });
    const r = await call(ops, 'send_message', { route: 'fake:default:c1', text: 'from outside', operation_id: 'op-1' });
    expect(r.value).toMatchObject({ ok: true, delivered: 'fake:default:c1', operationId: 'external:ops:op-1' });
    const again = await call(ops, 'send_message', { route: 'fake:default:c1', text: 'from outside', operation_id: 'op-1' });
    expect(again.value).toMatchObject({ ok: true, duplicate: true, operationId: 'external:ops:op-1' });
    expect(w.chat.sent.map((s) => s.msg.text)).toEqual(['from outside']);
    // Not agent-authored: no agent identity on it.
    expect(w.chat.sent[0]!.op?.as).toBeUndefined();
    const log = w.gw.hub.log.read('external:ops', 0);
    expect(log.find((e) => e.body.t === 'native' && (e.body as { name: string }).name === EXTERNAL_EVENT)?.native).toMatchObject({ client: 'ops', principal: 'external:ops', declared: 'member-7', operationId: 'external:ops:op-1', text: 'from outside' });
    expect(log.find((e) => e.body.t === 'delivery.settled')?.body).toMatchObject({ operationId: 'external:ops:op-1', result: 'delivered' });
    expect(w.gw.records.outboundByOperation('external:ops:op-1')).toMatchObject({ sessionKey: 'external:ops', external: { client: 'ops', principal: 'external:ops', declared: 'member-7' }, result: 'delivered' });
    // A channel the daemon does not run: refused, nothing sent.
    const none = await call(ops, 'send_message', { route: 'nochan:default:c1', text: 'x' });
    expect(none.isError).toBe(true);
    expect(none.text).toMatch(/nochan/);
    expect(w.chat.sent).toHaveLength(1);
  });

  it('a send passes the outbound check: a host answering outbound decides with the request as a one-input turn; a host that declared it and is away denies #DL-6 #DL-5', async () => {
    const { w, url } = await world();
    const h = await w.host({ callouts: ['outbound'] });
    const asked: Record<string, any>[] = [];
    h.onRequest('policy', (f) => {
      asked.push(f);
      return { verdict: 'deny' };
    });
    const ops = await mcp(url, TOKENS.ops);
    expect((await call(ops, 'send_message', { route: 'fake:default:c1', text: 'blocked' })).text).toMatch(/not allowed by the outbound policy/);
    expect(asked[0]).toMatchObject({ hook: 'outbound', args: { to: { conversationId: 'c1' }, from: { sessionKey: 'external:ops', replyRoute: null, inputs: [{ origin: { kind: 'peer', principal: { id: 'external:ops' } }, content: [{ type: 'text', text: 'blocked' }] }] } } });
    h.close();
    await until(() => !w.gw.host.answers('outbound'));
    expect((await call(ops, 'send_message', { route: 'fake:default:c1', text: 'away' })).text).toMatch(/not allowed by the outbound policy/);
    expect(w.chat.sent).toHaveLength(0);
  });

  it('explain of an external send names the client, its principal and whom it declared #EX-8 #EX-2', async () => {
    const { w, url } = await world();
    const ops = await mcp(url, TOKENS.ops, { 'x-agents-io-declared': 'member-7' });
    const r = await call(ops, 'send_message', { route: 'fake:default:c1', text: 'hi', operation_id: 'op-x' });
    const local = w.gw.explain(r.value.operationId, false);
    expect(local).toMatchObject({ ok: true, value: { operationId: 'external:ops:op-x', sessionKey: 'external:ops', inputIds: [], external: { client: 'ops', principal: 'external:ops', declared: 'member-7' } } });
    const viaMcp = await call(ops, 'explain', { id: 'external:ops:op-x' });
    expect(viaMcp.value).toMatchObject({ external: { client: 'ops', declared: 'member-7' } });
    // A send by the daemon's own turn has no `external`.
    const h = await w.host();
    const d = await h.deliver({ route: { channel: 'fake', account: 'default', conversationId: 'c2' }, operationId: 'hd1', message: { text: 'host' } });
    expect(d).toMatchObject({ status: 'delivered' });
    expect((w.gw.explain('host:hd1', false) as { value: Record<string, unknown> }).value.external).toBeUndefined();
  });
});

describe('external MCP endpoint end to end', () => {
  it('an MCP client lists its tools, reads status, sessions and events, queues an input and sends #SE-5 #CF-10 #ID-10 #DL-6', async () => {
    const { w, url } = await world();
    await session(w, 'S1', 'first');
    const c = await mcp(url, TOKENS.ops, { 'x-agents-io-declared': 'member-7' });
    expect(c.getServerVersion()).toMatchObject({ name: 'agents_io' });
    const st = await call(c, 'channels_status');
    expect(st.value.channels).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'fake', account: 'default' })]));
    const list = await call(c, 'sessions_list');
    expect(list.value.sessions.find((s: { sessionKey: string }) => s.sessionKey === 'S1')).toMatchObject({ sessionKey: 'S1', state: expect.any(String) });
    const page1 = await call(c, 'session_events', { session: 'S1', tier: 'full', from_seq: 0, limit: 2 });
    expect(page1.value.events).toHaveLength(2);
    const page2 = await call(c, 'session_events', { session: 'S1', tier: 'full', from_seq: page1.value.next_from_seq, limit: 200 });
    expect(page2.value.events[0].seq).toBeGreaterThan(page1.value.events[1].seq);
    const q = await call(c, 'session_input', { session: 'S1', text: 'second' });
    expect(q.isError).toBe(false);
    await until(() => w.gw.hub.log.read('S1', 0).filter((e) => e.body.t === 'turn.completed').length === 2);
    const fin = await call(c, 'session_events', { session: 'S1' });
    expect(fin.value.events.map((e: SessionEvent) => e.body).filter((b: { t: string }) => b.t === 'text.snapshot').map((b: { text: string }) => b.text)).toEqual(['echo: first', 'echo: second']);
    const s = await call(c, 'send_message', { route: 'fake:default:c7', text: 'done', operation_id: 'e2e-1' });
    expect(s.value).toMatchObject({ ok: true, operationId: 'external:ops:e2e-1' });
    expect(w.chat.sent.map((x) => x.msg.text)).toEqual(['done']);
  });
});

describe('external schedules', () => {
  it('a client with a schedule scope sets message schedules to routes its scope allows; each firing is its send #SC-3 #DL-6', async () => {
    const dir = tmp();
    const f = tokenFiles(dir);
    const { w, url } = await world({
      clients: {
        timer: { tokenFile: f.ops, scopes: ['schedule:fake:default:*'] },
        reader: { tokenFile: f.reader, scopes: ['read'] },
      },
    });
    const timer = await mcp(url, TOKENS.ops);
    const names = (await timer.listTools()).tools.map((t) => t.name);
    expect(names.sort()).toEqual(['schedule_add', 'schedule_list', 'schedule_remove']);
    // Nobody without the scope sees the tools.
    expect((await (await mcp(url, TOKENS.reader)).listTools()).tools.map((t) => t.name)).not.toContain('schedule_add');
    const refused = await call(timer, 'schedule_add', { when: { at: Date.now() + 300 }, route: 'other:default:x', text: 'no' });
    expect(refused).toMatchObject({ isError: true, text: expect.stringMatching(/not in your schedule scope/) });
    const added = await call(timer, 'schedule_add', { id: 'hello', when: { at: Date.now() + 300 }, route: 'fake:default:dm-alice', text: 'good morning' });
    expect(added.isError).toBe(false);
    expect(added.value.schedule).toMatchObject({ id: 'timer:hello', action: 'message', createdBy: 'external:timer' });
    expect((await call(timer, 'schedule_list')).value.schedules.map((s: { id: string }) => s.id)).toEqual(['timer:hello']);
    // At its time it goes out as the client's send (recorded in its log, like send_message).
    await until(() => w.chat.sent.some((s) => s.msg.text === 'good morning'), 5000);
    const sent = w.chat.sent.find((s) => s.msg.text === 'good morning')!;
    expect(sent.route.conversationId).toBe('dm-alice');
    expect(w.gw.schedules.registry.get('timer:hello')).toBeUndefined();
  });
});
