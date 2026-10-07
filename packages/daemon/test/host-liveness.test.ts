import { describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { ADMIN_WS_SUBPROTOCOL, PROTOCOL_VERSION, type InboundItem } from '@agents-io/protocol';
import { resolveConfig } from '../src/config.js';
import { daemon, tmp, until } from './helpers.js';

const alice = { channelUserId: 'alice', evidence: 'platform_signed' as const };

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

describe('/ws heartbeat (console.heartbeat)', () => {
  it('closes a connection that stops answering pings, which frees the host role', async () => {
    const w = await daemon({ console: true, raw: { console: { heartbeat: { intervalMs: 50, timeoutMs: 100 } } } });
    // autoPong: false plays a peer whose network went away without a FIN.
    const ws = new WebSocket(`${w.gw.console!.url.replace('http', 'ws')}/ws`, [ADMIN_WS_SUBPROTOCOL], { headers: { Authorization: `Bearer ${w.gw.token}` }, autoPong: false });
    await opened(ws);
    const c = wsClient(ws);
    expect(await c.ask({ type: 'host.hello', token: w.gw.token, name: 'remote', consumer: 'remote' })).toMatchObject({ ok: true, value: { host: true } });
    expect(w.gw.host.info()?.name).toBe('remote');
    await until(() => w.gw.host.hostPeer() === undefined, 3000);
    expect(w.gw.router.hostConnected).toBe(false);
    // The slot is free: a new host connects without takeover.
    const h = await w.host({ consumer: 'remote' });
    expect(w.gw.host.info()?.name).toBe('xwo');
    h.close();
  });

  it('keeps a connection that answers', async () => {
    const w = await daemon({ console: true, raw: { console: { heartbeat: { intervalMs: 30, timeoutMs: 100 } } } });
    const ws = new WebSocket(`${w.gw.console!.url.replace('http', 'ws')}/ws`, [ADMIN_WS_SUBPROTOCOL], { headers: { Authorization: `Bearer ${w.gw.token}` } });
    await opened(ws);
    const c = wsClient(ws);
    await c.ask({ type: 'host.hello', token: w.gw.token, name: 'remote', consumer: 'remote' });
    await new Promise((r) => setTimeout(r, 400));
    expect(ws.readyState).toBe(WebSocket.OPEN);
    expect(w.gw.host.info()?.name).toBe('remote');
    ws.close();
  });

  it('config: defaults 30 s / 10 s; intervalMs 0 turns it off', () => {
    const dir = tmp();
    expect(resolveConfig({}, { env: {}, baseDir: dir }).console.heartbeat).toEqual({ intervalMs: 30_000, timeoutMs: 10_000 });
    expect(resolveConfig({ console: { heartbeat: { intervalMs: 0 } } }, { env: {}, baseDir: dir }).console.heartbeat.intervalMs).toBe(0);
    expect(() => resolveConfig({ console: { heartbeat: { timeoutMs: 5 } } }, { env: {}, baseDir: dir })).toThrow();
  });
});

describe('host.hello takeover', () => {
  it('without takeover a second host is refused; with it the old connection is closed and its unacked push goes to the new host', async () => {
    const w = await daemon();
    const a = await w.host({ name: 'a', consumer: 'xwo' });
    const seenByA: InboundItem[] = [];
    // A is half-open: it never answers the push.
    a.onRequest('inbound', (f) => {
      seenByA.push(f.item as InboundItem);
      return new Promise(() => {});
    });
    await a.bindingsPut({ version: 'v1', bindings: [{ id: 'to-host', match: { channel: 'fake', keywords: ['xwo'] }, on: 'host' }], identities: [] });
    await w.chat.inject({ sender: alice, conversation: { id: 'g1', kind: 'group' }, text: 'xwo please' });
    await until(() => seenByA.length === 1);

    const b = await w.client();
    await expect(b.hello({ token: w.gw.token, name: 'b', consumer: 'xwo' })).rejects.toMatchObject({ code: 'host_connected' });
    const c = await w.client();
    await expect(c.hello({ token: 'wrong', name: 'c', consumer: 'xwo', takeover: true })).rejects.toMatchObject({ code: 'unauthorized' });
    expect(w.gw.host.info()?.name).toBe('a');

    const d = await w.client();
    const got: InboundItem[] = [];
    d.onRequest('inbound', (f) => {
      got.push(f.item as InboundItem);
      return { accepted: true };
    });
    const r = await d.hello({ token: w.gw.token, name: 'd', consumer: 'xwo', takeover: true });
    expect(r).toMatchObject({ host: true, replaced: { name: 'a' } });
    expect(r.features).toContain('host.takeover');
    expect(w.gw.host.info()?.name).toBe('d');
    expect(w.gw.router.hostConnected).toBe(true);
    await until(() => got.length === 1);
    expect(got[0]!.cursor).toBe(seenByA[0]!.cursor);
    await until(() => w.gw.hostQueue.cursor('xwo') === got[0]!.cursor);
    // The old connection is gone: its requests fail.
    await expect(a.bindingsGet()).rejects.toThrow();
  });

  it('takeover with no host connected is a plain hello', async () => {
    const w = await daemon();
    const c = await w.client();
    const r = await c.hello({ token: w.gw.token, name: 'x', callouts: true, takeover: true });
    expect(r.host).toBe(true);
    expect(r.replaced).toBeUndefined();
  });
});
