import { describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { ADMIN_WS_SUBPROTOCOL, PROTOCOL_VERSION } from '@agents-io/protocol';
import { daemon, until } from './helpers.js';

// Real heartbeat and close-grace timers (hundreds of ms each); with a fake clock these could move back to core.

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
  it('keeps a connection that answers #HQ-6', async () => {
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
});

describe('host.hello takeover', () => {
  it('over /ws: a takeover closes the old (half-open) connection, which goes away even though it never answers #HQ-6', async () => {
    const w = await daemon({ console: true, raw: { console: { heartbeat: { intervalMs: 0 } } } });
    const url = `${w.gw.console!.url.replace('http', 'ws')}/ws`;
    const headers = { Authorization: `Bearer ${w.gw.token}` };
    const oldWs = new WebSocket(url, [ADMIN_WS_SUBPROTOCOL], { headers });
    await opened(oldWs);
    const old = wsClient(oldWs);
    expect(await old.ask({ type: 'host.hello', token: w.gw.token, name: 'old', consumer: 'remote' })).toMatchObject({ ok: true, value: { host: true } });
    // Half-open: the old peer's socket stops reading, so it never answers the close frame.
    (oldWs as unknown as { _socket: { pause(): void } })._socket.pause();
    const closed = new Promise<void>((r) => oldWs.once('close', () => r()));
    const newWs = new WebSocket(url, [ADMIN_WS_SUBPROTOCOL], { headers });
    await opened(newWs);
    const neu = wsClient(newWs);
    expect(await neu.ask({ type: 'host.hello', token: w.gw.token, name: 'new', consumer: 'remote', takeover: true })).toMatchObject({ ok: true, value: { host: true, replaced: { name: 'old' } } });
    expect(w.gw.host.info()?.name).toBe('new');
    // The daemon drops the old socket after the close grace (not ws's 30 s close timeout), while the peer still does not read.
    const wss = (w.gw.console as unknown as { wss: { clients: Set<unknown> } }).wss;
    await until(() => wss.clients.size === 1, 3000);
    (oldWs as unknown as { _socket: { resume(): void } })._socket.resume();
    await closed;
    newWs.close();
  });
});
