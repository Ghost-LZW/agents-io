import { mkdirSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HttpAgent } from '@ag-ui/client';
import type { BaseEvent } from '@ag-ui/core';
import { EventSchema } from '@ag-ui/core/schemas';
import type { InputRecord } from '@agents-io/protocol';
import { resolveConfig } from '../src/defaults.js';
import { cleanups, daemon, tmp, until, type World } from './helpers.js';

/*
 * The AG-UI endpoint (core-slimming G9, north): a web UI runs a session as an AG-UI agent over
 * HTTP and SSE. Driven with the official client (`HttpAgent` from `@ag-ui/client`, which checks the
 * event sequence as CopilotKit-style UIs read it); every event also passes `@ag-ui/core`'s schema.
 */

const TOKENS = { web: 'web-token-0123456789abcdef', reader: 'reader-token-0123456789ab' };

function tokenFiles(dir: string): Record<keyof typeof TOKENS, string> {
  const d = join(dir, 'agui');
  mkdirSync(d, { recursive: true, mode: 0o700 });
  const out = {} as Record<keyof typeof TOKENS, string>;
  for (const [k, v] of Object.entries(TOKENS)) {
    const f = join(d, `${k}.token`);
    writeFileSync(f, v + '\n', { mode: 0o600 });
    out[k as keyof typeof TOKENS] = f;
  }
  return out;
}

async function world(o: { raw?: Record<string, unknown>; agUi?: Record<string, unknown> } = {}) {
  const dir = tmp();
  const f = tokenFiles(dir);
  const w = await daemon({
    dir,
    raw: {
      agents: { dev: { harness: 'claude-code' } },
      agUi: { listen: '127.0.0.1:0', clients: { web: { tokenFile: f.web, scopes: ['read:S*', 'input:S1'], agent: 'dev' }, reader: { tokenFile: f.reader, scopes: ['read:S1'] } }, ...(o.agUi ?? {}) },
      ...(o.raw ?? {}),
    },
  });
  const url = (w.gw.adminStatus().modules!.find((m) => m.id === 'ag-ui')!.status as { url: string }).url;
  return { w, url };
}

/** One run through the official client: the events it saw (each checked against the schema). */
async function run(url: string, token: string, threadId: string, text: string): Promise<BaseEvent[]> {
  const agent = new HttpAgent({ url, headers: { authorization: `Bearer ${token}` }, threadId, initialMessages: [{ id: 'm1', role: 'user', content: text }] });
  const events: BaseEvent[] = [];
  await agent.runAgent({ runId: `run-${threadId}` }, { onEvent: ({ event }) => void events.push(event) });
  for (const e of events) expect(EventSchema.safeParse(e).success, JSON.stringify(e)).toBe(true);
  return events;
}

const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'text/event-stream', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });

const input = (threadId: string, text = 'hi') => ({ threadId, runId: 'r', messages: [{ id: 'm', role: 'user', content: text }], tools: [], context: [] });

const admitted = (w: World, key: string): InputRecord[] => w.gw.hub.log.read(key, 0).flatMap((e) => (e.body.t === 'input.admitted' && e.body.input ? [e.body.input] : []));

/** Read an SSE response until `n` data events came, then stop. */
async function sse(res: Response, n: number): Promise<{ id: string; data: Record<string, unknown> }[]> {
  const out: { id: string; data: Record<string, unknown> }[] = [];
  const reader = res.body!.getReader();
  let buf = '';
  while (out.length < n) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += new TextDecoder().decode(value);
    const blocks = buf.split('\n\n');
    buf = blocks.pop()!;
    for (const b of blocks) {
      const id = /^id: (.*)$/m.exec(b)?.[1];
      const data = /^data: (.*)$/m.exec(b)?.[1];
      if (data) out.push({ id: id ?? '', data: JSON.parse(data) });
    }
  }
  await reader.cancel();
  return out;
}

describe('AG-UI endpoint: off by default, loopback, tokens, origins', () => {
  it('is off without agUi: nothing listens and hello does not advertise ag-ui; it listens on a loopback address only #SE-5', async () => {
    const off = await daemon();
    expect(off.gw.adminStatus().modules!.find((m) => m.id === 'ag-ui')).toEqual({ id: 'ag-ui', origin: 'builtin', enabled: false });
    const c = await off.client();
    expect((await c.hello({ token: off.gw.token, name: 'probe' })).features).not.toContain('ag-ui');
    expect(() => resolveConfig({ agUi: { listen: '0.0.0.0:7466', clients: {} } }, { env: {}, baseDir: tmp(), cwd: tmp() })).toThrow(/agUi\.listen "0\.0\.0\.0:7466": the endpoint listens on a loopback address only/);
    const { w } = await world();
    const h = await w.client();
    expect((await h.hello({ token: w.gw.token, name: 'probe' })).features).toContain('ag-ui');
  });

  it('every request needs a client\'s own token; a browser only from agUi.origins (with CORS); a Host that is not loopback is refused; limits answer 413 and 429 #SE-5', async () => {
    const { url } = await world({ agUi: { origins: ['http://localhost:3000'], limits: { requestsPerMinute: 3, maxBodyBytes: 2048 } } });
    expect((await post(url, input('S1'))).status).toBe(401);
    expect((await post(url, input('S1'), { authorization: 'Bearer not-a-token-0123456789' })).status).toBe(401);
    expect((await post(url, input('S1'), { authorization: `Bearer ${TOKENS.web}`, origin: 'http://evil.example' })).status).toBe(403);
    const pre = await fetch(url, { method: 'OPTIONS', headers: { origin: 'http://localhost:3000', 'access-control-request-method': 'POST' } });
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-origin')).toBe('http://localhost:3000');
    expect((await post(url, 'x'.repeat(4096), { authorization: `Bearer ${TOKENS.web}` })).status).toBe(413);
    const u = new URL(url);
    const status = await new Promise<number>((resolve, reject) => {
      const req = request({ host: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers: { host: 'rebind.example:80', authorization: `Bearer ${TOKENS.web}`, 'content-type': 'application/json' } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', reject);
      req.end(JSON.stringify(input('S1')));
    });
    expect(status).toBe(403);
    // A client's requests count once it is known (the 413 above, these two): 3 a minute, the next is 429 with Retry-After.
    const bad = await post(url, '{}', { authorization: `Bearer ${TOKENS.web}` });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toMatch(/^not a RunAgentInput: /);
    expect((await post(url, '{}', { authorization: `Bearer ${TOKENS.web}` })).status).toBe(400);
    const limited = await post(url, '{}', { authorization: `Bearer ${TOKENS.web}` });
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toMatch(/^\d+$/);
  });
});

describe('AG-UI endpoint: runs and resumes', () => {
  it('a run: the last user message is an input stamped as the client, the answer streams as AG-UI events the official client accepts (RUN_STARTED, STATE_SNAPSHOT, TEXT_MESSAGE_*, RUN_FINISHED) #ID-10', async () => {
    const { w, url } = await world();
    const events = await run(url, TOKENS.web, 'thread-1', 'hello web');
    expect(events.map((e) => e.type)).toEqual(['RUN_STARTED', 'STATE_SNAPSHOT', 'TEXT_MESSAGE_START', 'TEXT_MESSAGE_CONTENT', 'TEXT_MESSAGE_END', 'RUN_FINISHED']);
    expect(events[0]).toMatchObject({ threadId: 'thread-1', runId: 'run-thread-1' });
    expect(events.find((e) => e.type === 'TEXT_MESSAGE_CONTENT')).toMatchObject({ delta: 'echo: hello web' });
    expect(events.at(-1)).toMatchObject({ outcome: { type: 'success' } });
    // A new thread of a client with an agent: a session of its own.
    const key = 'ag-ui:web:thread-1';
    const [i] = admitted(w, key);
    expect(i!.origin).toEqual({ kind: 'peer', principal: { id: 'external:web', labels: ['external'] }, evidence: 'device_only', via: 'ag-ui:web', adapter: 'ag-ui' });
    expect(i!.cause).toEqual({ peer: 'ag-ui:web', basis: 'none' });
    // The same thread again: the same session.
    await run(url, TOKENS.web, 'thread-1', 'second');
    expect(admitted(w, key)).toHaveLength(2);
  });

  it('a thread that is a session key in the client\'s scopes is that session; outside its input scope, or for a client without an agent, it is refused #CF-10', async () => {
    const { w, url } = await world();
    const local = await w.client();
    await local.input('S2', 'there');
    await until(() => w.gw.hub.log.read('S2', 0).some((e) => e.body.t === 'turn.completed'));
    // S1 is in web's input scope (an unknown key is not a session to open): it opens one of its own instead.
    const own = await run(url, TOKENS.web, 'S2', 'into S2?');
    expect(own.at(-1)!.type).toBe('RUN_FINISHED');
    expect(admitted(w, 'S2')).toHaveLength(1);
    expect(admitted(w, 'ag-ui:web:S2')).toHaveLength(1);
    // reader has no agent and no input scope: refused before any stream.
    const r = await post(url, input('S1'), { authorization: `Bearer ${TOKENS.reader}` });
    expect(r.status).toBe(404);
    await local.input('S1', 'here');
    await until(() => w.gw.hub.log.read('S1', 0).some((e) => e.body.t === 'turn.completed'));
    expect((await post(url, input('S1'), { authorization: `Bearer ${TOKENS.reader}` })).status).toBe(403);
    const ok = await run(url, TOKENS.web, 'S1', 'into S1');
    expect(ok.at(-1)!.type).toBe('RUN_FINISHED');
    expect(admitted(w, 'S1').at(-1)!.origin.principal!.id).toBe('external:web');
  });

  it('GET …/threads/<id>/events resumes from a seq: each later turn a run, every event with its session seq as the SSE id; reading needs a read scope #CF-10', async () => {
    const { w, url } = await world();
    const local = await w.client();
    await local.input('S1', 'one');
    await until(() => w.gw.hub.log.read('S1', 0).filter((e) => e.body.t === 'turn.completed').length === 1);
    const head = w.gw.hub.log.head('S1');
    await local.input('S1', 'two');
    await until(() => w.gw.hub.log.read('S1', 0).filter((e) => e.body.t === 'turn.completed').length === 2);
    const res = await fetch(`${url}/threads/S1/events?fromSeq=${head}`, { headers: { authorization: `Bearer ${TOKENS.reader}` } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    const got = await sse(res, 5);
    expect(got.map((e) => e.data.type)).toEqual(['RUN_STARTED', 'TEXT_MESSAGE_START', 'TEXT_MESSAGE_CONTENT', 'TEXT_MESSAGE_END', 'RUN_FINISHED']);
    expect(got[2]!.data).toMatchObject({ delta: 'echo: two' });
    for (const e of got) expect(Number(e.id)).toBeGreaterThan(head);
    for (const e of got) expect(EventSchema.safeParse(e.data).success).toBe(true);
    expect((await fetch(`${url}/threads/S2/events`, { headers: { authorization: `Bearer ${TOKENS.reader}` } })).status).toBe(404);
    // One that exists outside its read scope is as if there were none.
    await local.input('S2', 'elsewhere');
    await until(() => w.gw.hub.log.read('S2', 0).some((e) => e.body.t === 'turn.completed'));
    expect((await fetch(`${url}/threads/S2/events`, { headers: { authorization: `Bearer ${TOKENS.reader}` } })).status).toBe(404);
    expect((await post(url, input('S2'), { authorization: `Bearer ${TOKENS.reader}` })).status).toBe(404);
  });

  it('runs go through the lane\'s loop guard: past pair.maxTurns the run ends RUN_ERROR loop_guard and the input is kept as context #IN-8', async () => {
    const { w, url } = await world({ raw: { policy: { owners: ['fake:alice'], loopGuard: { pair: { maxTurns: 1 } } } } });
    expect((await run(url, TOKENS.web, 'lg', 'first')).at(-1)!.type).toBe('RUN_FINISHED');
    const res = await post(url, { ...input('lg', 'second'), runId: 'r2' }, { authorization: `Bearer ${TOKENS.web}` });
    const got = await sse(res, 2);
    expect(got.map((e) => e.data.type)).toEqual(['RUN_STARTED', 'RUN_ERROR']);
    expect(got[1]!.data).toMatchObject({ code: 'loop_guard' });
    expect(admitted(w, 'ag-ui:web:lg').at(-1)!.channelContext.loopGuard).toBe('pair');
  });

  it('the host that declared the external hook decides every run (endpoint ag-ui): denied, the request answers 403 and nothing goes in #CF-10', async () => {
    const { w, url } = await world();
    const host = await w.host({ name: 'xwo', callouts: ['external'] });
    const asked: Record<string, unknown>[] = [];
    host.onRequest('policy', async (f) => {
      asked.push(f as Record<string, unknown>);
      return { verdict: 'deny', reason: 'no' };
    });
    const r = await post(url, input('S1'), { authorization: `Bearer ${TOKENS.web}` });
    expect(r.status).toBe(403);
    expect(await r.json()).toEqual({ error: 'denied by the host: no' });
    expect(asked[0]).toMatchObject({ hook: 'external', args: { client: 'web', principal: 'external:web', op: 'input', sessionKey: 'ag-ui:web:S1', endpoint: 'ag-ui' } });
    expect(admitted(w, 'ag-ui:web:S1')).toHaveLength(0);
    cleanups.push(() => host.close());
  });
});
