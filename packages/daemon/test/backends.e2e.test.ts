import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { ADMIN_WS_BEARER_PREFIX, ADMIN_WS_SUBPROTOCOL, BLOB_FRAME_MAX_BYTES, PROTOCOL_VERSION, type AdminBackends, type InboundItem, type ReplyRoute } from '@agents-io/protocol';
import { consoleDaemon } from './console-helpers.js';
import { until } from './helpers.js';

// Backends as they connect in a deployment: over the console's /ws, each with its own key, with the
// real close grace and reconnects (docs/design/persona-backend/, INVARIANTS §3a). Ids are neutral.

const alice = { channelUserId: 'alice', evidence: 'platform_signed' as const };

/** A backend's end of a /ws connection: answers pushed items (accepting them), sends requests. */
function backendEnd(ws: WebSocket) {
  const frames: any[] = [];
  const items: InboundItem[] = [];
  let close: { code: number } | undefined;
  ws.on('message', (d) => {
    const f = JSON.parse(d.toString());
    frames.push(f);
    if (f.type !== 'inbound') return;
    items.push(f.item as InboundItem);
    ws.send(JSON.stringify({ v: PROTOCOL_VERSION, type: 'result', id: f.id, ok: true, value: { accepted: true } }));
  });
  ws.on('close', (code) => (close = { code }));
  let n = 0;
  const ask = async (f: Record<string, unknown>) => {
    const id = `r${++n}`;
    ws.send(JSON.stringify({ v: PROTOCOL_VERSION, id, ...f }));
    return until(() => frames.find((x) => x.type === 'result' && x.id === id));
  };
  return { frames, items, ask, closed: () => close };
}

const opened = (ws: WebSocket) =>
  new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });

/** The HTTP status an upgrade attempt gets (101 when it is accepted). */
const upgrade = (url: string, key: string) =>
  new Promise<number>((resolve) => {
    const ws = new WebSocket(url, [ADMIN_WS_SUBPROTOCOL], { headers: { Authorization: `Bearer ${key}` } });
    ws.on('unexpected-response', (_req, res) => resolve(res.statusCode!));
    ws.on('open', () => {
      ws.close();
      resolve(101);
    });
    ws.on('error', () => undefined);
  });

describe('backends over /ws', () => {
  it('over /ws a read key observes its backend\'s items next to the backend\'s push connection with the heartbeat on; deliver and inbound.ack are forbidden; revoking the read key closes its socket and refuses its reconnect while the backend keeps consuming #PB-7 #PB-1 #PB-3', async () => {
    const w = await consoleDaemon({
      raw: {
        console: { port: 0, heartbeat: { intervalMs: 50, timeoutMs: 500 } },
        backends: { alpha: {}, beta: {} },
        bindings: [
          { id: 'to-alpha', match: { channel: 'fake', keywords: ['alpha'] }, on: 'host', to: 'alpha' },
          { id: 'to-beta', match: { channel: 'fake', keywords: ['beta'] }, on: 'host', to: 'beta' },
        ],
      },
    });
    const url = `${w.url.replace('http', 'ws')}/ws`;
    const key = async (id: string, op: 'issue' | 'rotate' | 'revoke', access?: 'read') => (await w.api(`/api/backends/${id}/key`, { method: 'POST', json: { op, ...(access ? { access } : {}) } })).body as { key: string; closed: number; access: string };
    const alphaKey = (await key('alpha', 'issue')).key;
    const readKey = (await key('alpha', 'issue', 'read')).key;
    expect(readKey).toMatch(/^aiobr_[\w-]{43}$/);

    // The backend consumes by push; an observer connects next to it with the read key.
    const aWs = new WebSocket(url, [ADMIN_WS_SUBPROTOCOL], { headers: { Authorization: `Bearer ${alphaKey}` } });
    const rWs = new WebSocket(url, [ADMIN_WS_SUBPROTOCOL, ADMIN_WS_BEARER_PREFIX + readKey]);
    await Promise.all([opened(aWs), opened(rWs)]);
    const [a, r] = [backendEnd(aWs), backendEnd(rWs)];
    expect(await a.ask({ type: 'host.hello', token: alphaKey, name: 'alpha', consumer: 'alpha' })).toMatchObject({ ok: true, value: { name: 'backend:alpha', backend: { id: 'alpha', access: 'readwrite' }, inbound: { consumer: 'backend:alpha', acked: 0, head: 0 } } });
    // Asking to consume with the read key is refused and leaves the backend's push connection alone.
    expect(await r.ask({ type: 'host.hello', token: readKey, name: 'watcher', consumer: 'alpha', takeover: true })).toMatchObject({ ok: false, error: { code: 'forbidden', message: 'this key is read-only' } });
    const hello = await r.ask({ type: 'host.hello', token: readKey, name: 'watcher' });
    expect(hello).toMatchObject({ ok: true, value: { name: 'backend:alpha', host: false, backend: { id: 'alpha', access: 'read' }, features: ['backends', 'binding.tag', 'blobs.read'] } });
    expect(hello.value.inbound).toBeUndefined();
    expect(aWs.readyState).toBe(WebSocket.OPEN);

    // The observer long-polls; what arrives for alpha is pushed to the backend and shown to the observer.
    const waiting = r.ask({ type: 'inbound.read', consumer: 'alpha', after: 0, waitMs: 2000 });
    await new Promise((x) => setTimeout(x, 100));
    await w.chat.inject({ id: 'm1', sender: alice, text: 'for beta', conversation: { id: 'c-b', kind: 'group' } });
    await w.chat.inject({ id: 'm2', sender: alice, text: 'for alpha', conversation: { id: 'c-a', kind: 'group' } });
    expect(await waiting).toMatchObject({ ok: true, value: { items: [{ cursor: 2, to: 'alpha', envelope: { id: 'm2' } }] } });
    await until(() => a.items.length === 1);
    expect((await waiting).value.items).toHaveLength(1);
    const backends = async () => ((await w.api('/api/backends')).body as AdminBackends).backends.map((x) => [x.id, x.connections, x.push, x.read?.connections, x.acked, x.pending]);
    await until(async () => (await backends())[0]![4] === 2);
    expect(await backends()).toEqual([['alpha', 1, true, 1, 2, 0], ['beta', 0, false, undefined, 0, 1]]);
    // Nothing was pushed to the observer, and it changes nothing: no send, no ack.
    expect(r.items).toEqual([]);
    const READ_ONLY = { ok: false, error: { code: 'forbidden', message: 'this key is read-only' } };
    expect(await r.ask({ type: 'deliver', operationId: 'op1', route: { channel: 'fake', account: 'default', conversationId: 'c-a' }, message: { text: 'from the observer' } })).toMatchObject(READ_ONLY);
    expect(await r.ask({ type: 'inbound.ack', consumer: 'alpha', cursor: 0 })).toMatchObject(READ_ONLY);
    expect(await r.ask({ type: 'inbound.read', consumer: 'beta' })).toMatchObject({ ok: false, error: { code: 'forbidden' } });
    expect(w.chat.sent).toEqual([]);
    // The backend may: the same deliver with its key goes out.
    expect(await a.ask({ type: 'deliver', operationId: 'op1', route: { channel: 'fake', account: 'default', conversationId: 'c-a' }, message: { text: 'from alpha' } })).toMatchObject({ ok: true, value: { status: 'delivered' } });
    // The heartbeat ran several times meanwhile: both stay connected.
    await new Promise((x) => setTimeout(x, 300));
    expect([aWs.readyState, rWs.readyState]).toEqual([WebSocket.OPEN, WebSocket.OPEN]);

    // The read key is revoked: the observer's socket is closed by the daemon, the backend's is not.
    expect(await key('alpha', 'revoke', 'read')).toMatchObject({ access: 'read', closed: 1 });
    await until(() => r.closed() !== undefined, 3000);
    expect(aWs.readyState).toBe(WebSocket.OPEN);
    expect(await upgrade(url, readKey)).toBe(401);
    expect(await upgrade(url, alphaKey)).toBe(101);
    // The backend keeps consuming.
    await w.chat.inject({ id: 'm3', sender: alice, text: 'for alpha, later', conversation: { id: 'c-a', kind: 'group' } });
    await until(() => a.items.length === 2);
    expect(a.items.map((x) => [x.envelope.id, x.to])).toEqual([['m2', 'alpha'], ['m3', 'alpha']]);
    await until(async () => (await backends())[0]![4] === 3);
    expect((await backends())[0]).toEqual(['alpha', 1, true, undefined, 3, 0]);
    aWs.close();
  });

  it("over /ws two backends consume their own items and deliver into their conversations; a rotated key's socket is closed and its reconnect refused #PB-1 #PB-2 #PB-3", async () => {
    const w = await consoleDaemon({
      raw: {
        console: { port: 0, heartbeat: { intervalMs: 50, timeoutMs: 500 } },
        backends: { alpha: {}, beta: {} },
        bindings: [
          { id: 'to-alpha', match: { channel: 'fake', keywords: ['alpha'] }, on: 'host', to: 'alpha' },
          { id: 'to-beta', match: { channel: 'fake', keywords: ['beta'] }, on: 'host', to: 'beta' },
        ],
      },
    });
    const url = `${w.url.replace('http', 'ws')}/ws`;
    const key = async (id: string, op: 'issue' | 'rotate') => (await w.api(`/api/backends/${id}/key`, { method: 'POST', json: { op } })).body as { key: string; closed: number };
    const alphaKey = (await key('alpha', 'issue')).key;
    const betaKey = (await key('beta', 'issue')).key;
    const at = (conversationId: string): ReplyRoute => ({ channel: 'fake', account: 'default', conversationId });
    const say = (c: ReturnType<typeof backendEnd>, operationId: string, route: ReplyRoute, text: string) => c.ask({ type: 'deliver', operationId, route, message: { text } });

    // Each backend connects with its own key (a header; a browser-like client puts it in the subprotocol list).
    const aWs = new WebSocket(url, [ADMIN_WS_SUBPROTOCOL], { headers: { Authorization: `Bearer ${alphaKey}` } });
    const bWs = new WebSocket(url, [ADMIN_WS_SUBPROTOCOL, ADMIN_WS_BEARER_PREFIX + betaKey]);
    await Promise.all([opened(aWs), opened(bWs)]);
    const [a, b] = [backendEnd(aWs), backendEnd(bWs)];
    expect(await a.ask({ type: 'host.hello', token: alphaKey, name: 'alpha', consumer: 'alpha' })).toMatchObject({ ok: true, value: { name: 'backend:alpha', host: false, backend: { id: 'alpha' }, inbound: { consumer: 'backend:alpha', acked: 0, head: 0 } } });
    expect(await b.ask({ type: 'host.hello', token: betaKey, name: 'beta', consumer: 'beta' })).toMatchObject({ ok: true, value: { name: 'backend:beta', host: false, backend: { id: 'beta' } } });

    // Each is pushed its own items only; a message for both is one item each.
    await w.chat.inject({ id: 'm1', sender: alice, text: 'for alpha', conversation: { id: 'c-a', kind: 'group' } });
    await w.chat.inject({ id: 'm2', sender: alice, text: 'for beta', conversation: { id: 'c-b', kind: 'group' } });
    await w.chat.inject({ id: 'm3', sender: alice, text: 'for alpha and beta', conversation: { id: 'c-both', kind: 'group' } });
    await until(() => a.items.length === 2 && b.items.length === 2);
    const seen = (xs: InboundItem[]) => xs.map((x) => [x.envelope.id, x.to]);
    expect(seen(a.items)).toEqual([['m1', 'alpha'], ['m3', 'alpha']]);
    expect(seen(b.items)).toEqual([['m2', 'beta'], ['m3', 'beta']]);
    const backends = async () => ((await w.api('/api/backends')).body as AdminBackends).backends.map((x) => [x.id, x.connections, x.push, x.pending]);
    await until(async () => (await backends()).every((x) => x[3] === 0));
    expect(await backends()).toEqual([['alpha', 1, true, 0], ['beta', 1, true, 0]]);

    // Each answers into the conversations it received from, and not into the other's.
    expect(await say(a, 'op1', at('c-a'), 'alpha here')).toMatchObject({ ok: true, value: { status: 'delivered', duplicate: false } });
    expect(await say(b, 'op1', at('c-b'), 'beta here')).toMatchObject({ ok: true, value: { status: 'delivered', duplicate: false } });
    expect(await say(a, 'op2', at('c-both'), 'alpha, to both')).toMatchObject({ ok: true, value: { status: 'delivered' } });
    expect(await say(a, 'op3', at('c-b'), 'alpha in beta\'s place')).toMatchObject({ ok: false, error: { code: 'route_not_allowed' } });
    expect(await say(b, 'op3', at('c-a'), 'beta in alpha\'s place')).toMatchObject({ ok: false, error: { code: 'route_not_allowed' } });
    expect(w.chat.sent.map((x) => [x.route.conversationId, x.msg.text])).toEqual([['c-a', 'alpha here'], ['c-b', 'beta here'], ['c-both', 'alpha, to both']]);
    // Neither can read the routing table or act as a client.
    expect(await a.ask({ type: 'bindings.get' })).toMatchObject({ ok: false, error: { code: 'forbidden' } });
    expect(await b.ask({ type: 'sessions' })).toMatchObject({ ok: false, error: { code: 'forbidden' } });
    // The heartbeat ran several times meanwhile: both stay connected.
    await new Promise((r) => setTimeout(r, 300));
    expect([aWs.readyState, bWs.readyState]).toEqual([WebSocket.OPEN, WebSocket.OPEN]);

    // alpha's key is rotated: its socket is closed by the daemon, beta's is not.
    const rotated = await key('alpha', 'rotate');
    expect(rotated.closed).toBe(1);
    await until(() => a.closed() !== undefined, 3000);
    expect(bWs.readyState).toBe(WebSocket.OPEN);
    // What arrives while alpha is away waits for it.
    await w.chat.inject({ id: 'm4', sender: alice, text: 'alpha, while away', conversation: { id: 'c-a', kind: 'group' } });
    await until(async () => (await backends())[0]![3] === 1);
    expect(await backends()).toEqual([['alpha', 0, false, 1], ['beta', 1, true, 0]]);
    expect(a.items).toHaveLength(2);

    // Reconnecting with the old key: the upgrade itself is refused.
    expect(await upgrade(url, alphaKey)).toBe(401);
    // A connection that did get in (with the new key) cannot say hello with the old one.
    const a2Ws = new WebSocket(url, [ADMIN_WS_SUBPROTOCOL], { headers: { Authorization: `Bearer ${rotated.key}` } });
    await opened(a2Ws);
    const a2 = backendEnd(a2Ws);
    expect(await a2.ask({ type: 'host.hello', token: alphaKey, name: 'alpha', consumer: 'alpha' })).toMatchObject({ ok: false, error: { code: 'unauthorized' } });
    // With the new key it is alpha again: where it stood, what waited, and its grants.
    const hello = await a2.ask({ type: 'host.hello', token: rotated.key, name: 'alpha', consumer: 'alpha' });
    expect(hello).toMatchObject({ ok: true, value: { name: 'backend:alpha', inbound: { consumer: 'backend:alpha', acked: a.items[1]!.cursor } } });
    await until(() => a2.items.length === 1);
    expect(seen(a2.items)).toEqual([['m4', 'alpha']]);
    expect(await say(a2, 'op4', at('c-a'), 'alpha is back')).toMatchObject({ ok: true, value: { status: 'delivered', duplicate: false } });
    // Its operation ids went on with it: the one it used before the rotation is its own duplicate.
    expect(await say(a2, 'op1', at('c-a'), 'alpha here')).toMatchObject({ ok: true, value: { status: 'delivered', duplicate: true } });
    expect(w.chat.sent).toHaveLength(4);
    a2Ws.close();
    bWs.close();
  });
  it("over /ws, with the heartbeat on, a backend fetches an item's image in ranges and delivers a file it uploaded in parts; the other backend's key gets not_found for both refs and unknown_blob when it attaches them; a key rotated mid-upload has its socket closed and the new key starts the upload again #PB-6 #PB-3", async () => {
    const w = await consoleDaemon({
      raw: {
        console: { port: 0, heartbeat: { intervalMs: 50, timeoutMs: 500 } },
        backends: { alpha: {}, beta: {} },
        bindings: [
          { id: 'to-alpha', match: { channel: 'fake', keywords: ['alpha'] }, on: 'host', to: 'alpha', tag: 'inbox' },
          { id: 'to-beta', match: { channel: 'fake', keywords: ['beta'] }, on: 'host', to: 'beta' },
        ],
      },
    });
    const url = `${w.url.replace('http', 'ws')}/ws`;
    const key = async (id: string, op: 'issue' | 'rotate') => (await w.api(`/api/backends/${id}/key`, { method: 'POST', json: { op } })).body as { key: string; closed: number };
    const connect = async (id: string, k: string) => {
      const ws = new WebSocket(url, [ADMIN_WS_SUBPROTOCOL], { headers: { Authorization: `Bearer ${k}` } });
      await opened(ws);
      const end = backendEnd(ws);
      expect(await end.ask({ type: 'host.hello', token: k, name: id, consumer: id })).toMatchObject({ ok: true, value: { name: `backend:${id}`, features: expect.arrayContaining(['blobs']) } });
      return { ws, ...end };
    };
    const refOf = (bytes: Uint8Array) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    const at = (conversationId: string): ReplyRoute => ({ channel: 'fake', account: 'default', conversationId });
    const alphaKey = (await key('alpha', 'issue')).key;
    const betaKey = (await key('beta', 'issue')).key;
    let a = await connect('alpha', alphaKey);
    const b = await connect('beta', betaKey);

    // An image arrives for alpha (the channel stored it), in a conversation both backends have input from.
    const picture = randomBytes(3 * BLOB_FRAME_MAX_BYTES + 4321);
    const pictureRef = await w.gw.blobs.put(picture, { mime: 'image/png', name: 'photo.png' });
    await w.chat.inject({ id: 'm1', sender: alice, conversation: { id: 'c1', kind: 'group' }, content: [{ type: 'text', text: 'for alpha' }, { type: 'image', ref: pictureRef, mime: 'image/png', name: 'photo.png' }] });
    await w.chat.inject({ id: 'm2', sender: alice, conversation: { id: 'c1', kind: 'group' }, text: 'for beta' });
    await until(() => a.items.length === 1 && b.items.length === 1);
    expect(a.items[0]).toMatchObject({ to: 'alpha', tag: 'inbox' });
    const block = a.items[0]!.envelope.content.find((c) => c.type === 'image') as { ref: string };
    expect(block.ref).toBe(pictureRef);

    // alpha fetches it in ranges of at most a frame's worth and checks the hash itself.
    const stat = await a.ask({ type: 'blob.stat', ref: block.ref });
    expect(stat).toMatchObject({ ok: true, value: { size: picture.byteLength } });
    expect(await a.ask({ type: 'blob.get', ref: block.ref })).toMatchObject({ ok: false, error: { code: 'too_large' } });
    const got: Buffer[] = [];
    for (let offset = 0; offset < picture.byteLength; ) {
      const r = await a.ask({ type: 'blob.get', ref: block.ref, offset, length: BLOB_FRAME_MAX_BYTES });
      expect(r).toMatchObject({ ok: true, value: { size: picture.byteLength, offset } });
      const chunk = Buffer.from(r.value.base64, 'base64');
      expect(chunk.byteLength).toBeLessThanOrEqual(BLOB_FRAME_MAX_BYTES);
      got.push(chunk);
      offset += chunk.byteLength;
    }
    expect(got.length).toBe(4);
    expect(refOf(Buffer.concat(got))).toBe(pictureRef);

    // alpha uploads a file in parts and delivers it; the channel is handed the attachment and the store has the bytes.
    const file = randomBytes(2 * BLOB_FRAME_MAX_BYTES + 99);
    const upload = async (c: Awaited<ReturnType<typeof connect>>, id: string, bytes: Buffer, o: { stopAfter?: number } = {}) => {
      let last: any;
      let sent = 0;
      for (let offset = 0; offset < bytes.byteLength; offset += BLOB_FRAME_MAX_BYTES) {
        if (o.stopAfter !== undefined && sent >= o.stopAfter) return last;
        const end = offset + BLOB_FRAME_MAX_BYTES >= bytes.byteLength;
        last = await c.ask({ type: 'blob.put', base64: bytes.subarray(offset, offset + BLOB_FRAME_MAX_BYTES).toString('base64'), part: { upload: id, offset, ...(end ? { last: true } : {}) } });
        sent++;
      }
      return last;
    };
    expect(await upload(a, 'file-1', file)).toMatchObject({ ok: true, value: { ref: refOf(file), size: file.byteLength } });
    const message = (ref: string) => ({ text: 'here it is', attachments: [{ ref, mime: 'application/pdf', name: 'report.pdf' }] });
    expect(await a.ask({ type: 'deliver', operationId: 'd1', route: at('c1'), message: message(refOf(file)) })).toMatchObject({ ok: true, value: { status: 'delivered', duplicate: false } });
    expect(w.chat.sent.map((x) => x.msg)).toEqual([message(refOf(file))]);
    expect(Buffer.from((await w.gw.blobs.get(refOf(file))).bytes).equals(file)).toBe(true);

    // beta's key: neither ref gives bytes (it knows both hashes), and neither can be attached, in a conversation it may send to.
    for (const ref of [pictureRef, refOf(file)]) {
      expect(await b.ask({ type: 'blob.stat', ref })).toMatchObject({ ok: true, value: null });
      expect(await b.ask({ type: 'blob.get', ref, offset: 0, length: 16 })).toMatchObject({ ok: false, error: { code: 'not_found', message: 'no such blob' } });
      expect(await b.ask({ type: 'deliver', operationId: `x-${ref.slice(7, 15)}`, route: at('c1'), message: message(ref) })).toMatchObject({ ok: false, error: { code: 'unknown_blob' } });
    }
    expect(await b.ask({ type: 'deliver', operationId: 'ok', route: at('c1'), message: { text: 'beta, plain' } })).toMatchObject({ ok: true, value: { status: 'delivered' } });
    expect(w.chat.sent).toHaveLength(2);
    // The transfers took several heartbeats: nobody was cut off.
    expect([a.ws.readyState, b.ws.readyState]).toEqual([WebSocket.OPEN, WebSocket.OPEN]);

    // alpha's key is rotated in the middle of an upload: the socket is closed, and the new key cannot continue it.
    const second = randomBytes(BLOB_FRAME_MAX_BYTES + 500);
    expect(await upload(a, 'file-2', second, { stopAfter: 1 })).toMatchObject({ ok: true, value: { upload: 'file-2', received: BLOB_FRAME_MAX_BYTES } });
    const rotated = await key('alpha', 'rotate');
    expect(rotated.closed).toBe(1);
    await until(() => a.closed() !== undefined, 3000);
    expect(b.ws.readyState).toBe(WebSocket.OPEN);
    a = await connect('alpha', rotated.key);
    const resumed = await a.ask({ type: 'blob.put', base64: second.subarray(BLOB_FRAME_MAX_BYTES).toString('base64'), part: { upload: 'file-2', offset: BLOB_FRAME_MAX_BYTES, last: true } });
    expect(resumed).toMatchObject({ ok: false, error: { code: 'bad_offset', message: 'expected offset 0' } });
    expect(await a.ask({ type: 'blob.stat', ref: refOf(second) })).toMatchObject({ ok: true, value: null });
    // From the start it goes through; what the backend had staged and was granted before is still its own.
    expect(await upload(a, 'file-2', second)).toMatchObject({ ok: true, value: { ref: refOf(second), size: second.byteLength } });
    expect(await a.ask({ type: 'blob.stat', ref: refOf(file) })).toMatchObject({ ok: true, value: { size: file.byteLength } });
    expect(await a.ask({ type: 'blob.stat', ref: pictureRef })).toMatchObject({ ok: true, value: { size: picture.byteLength } });
    expect(await a.ask({ type: 'deliver', operationId: 'd2', route: at('c1'), message: message(refOf(second)) })).toMatchObject({ ok: true, value: { status: 'delivered', duplicate: false } });
    expect(w.chat.sent).toHaveLength(3);
    a.ws.close();
    b.ws.close();
  });

  it("over /ws a backend that asks for forty ranges without reading is handed one answer at a time: the daemon reads the next range only once the socket took the answer before, so it holds about one answer for that connection, not the megabytes the push watermark allows; when the backend reads again every answer arrives, in the order asked #PR-2 #PB-6", async () => {
    const w = await consoleDaemon({
      raw: { console: { port: 0 }, backends: { alpha: {} }, bindings: [{ id: 'to-alpha', match: { channel: 'fake', keywords: ['alpha'] }, on: 'host', to: 'alpha' }] },
    });
    const url = `${w.url.replace('http', 'ws')}/ws`;
    const alphaKey = ((await w.api('/api/backends/alpha/key', { method: 'POST', json: { op: 'issue' } })).body as { key: string }).key;
    const ws = new WebSocket(url, [ADMIN_WS_SUBPROTOCOL], { headers: { Authorization: `Bearer ${alphaKey}` } });
    await opened(ws);
    const a = backendEnd(ws);
    expect(await a.ask({ type: 'host.hello', token: alphaKey, name: 'alpha', consumer: 'alpha' })).toMatchObject({ ok: true });
    const picture = randomBytes(BLOB_FRAME_MAX_BYTES);
    const ref = await w.gw.blobs.put(picture, { mime: 'image/png' });
    await w.chat.inject({ id: 'm1', sender: alice, conversation: { id: 'c1', kind: 'group' }, content: [{ type: 'text', text: 'for alpha' }, { type: 'image', ref, mime: 'image/png' }] });
    await until(() => a.items.length === 1);

    // The daemon's end of this connection (the only one), and every range it reads.
    const server = [...(w.gw as unknown as { console: { wss: { clients: Set<WebSocket> } } }).console.wss.clients];
    expect(server).toHaveLength(1);
    let reads = 0;
    const get = w.gw.hostBlobs.get.bind(w.gw.hostBlobs);
    w.gw.hostBlobs.get = (f, backend) => {
      reads++;
      return get(f, backend);
    };
    const settled = async () => {
      for (let last = -1; last !== reads; ) {
        last = reads;
        await new Promise((r) => setTimeout(r, 400));
      }
    };

    // The backend stops reading, then asks for the megabyte forty times over (some 56 MB of answers).
    const N = 40;
    const socket = (ws as unknown as { _socket: { pause(): void; resume(): void } })._socket;
    socket.pause();
    for (let i = 0; i < N; i++) ws.send(JSON.stringify({ v: PROTOCOL_VERSION, id: `g${i}`, type: 'blob.get', ref, offset: 0, length: BLOB_FRAME_MAX_BYTES }));
    await settled();
    // The operating system took some answers into its socket buffers; after those, one is waiting and no further range was read.
    expect(reads).toBeGreaterThan(0);
    expect(reads).toBeLessThan(N);
    const answer = Math.ceil(BLOB_FRAME_MAX_BYTES / 3) * 4;
    expect(server[0]!.bufferedAmount).toBeGreaterThan(0);
    expect(server[0]!.bufferedAmount).toBeLessThan(answer + 64 * 1024);
    expect(server[0]!.readyState).toBe(WebSocket.OPEN);

    // It reads again: the rest follow, each read only after the one before left, all in the order asked.
    socket.resume();
    await until(() => a.frames.filter((f) => f.type === 'result' && String(f.id).startsWith('g')).length === N, 20_000);
    const got = a.frames.filter((f) => f.type === 'result' && String(f.id).startsWith('g'));
    expect(got.map((f) => f.id)).toEqual(Array.from({ length: N }, (_, i) => `g${i}`));
    expect(got.every((f) => f.ok && f.value.size === BLOB_FRAME_MAX_BYTES && f.value.base64.length === answer)).toBe(true);
    expect(createHash('sha256').update(Buffer.from(got[N - 1].value.base64, 'base64')).digest('hex')).toBe(ref.slice(7));
    expect(reads).toBe(N);
    ws.close();
  }, 40_000);
});
