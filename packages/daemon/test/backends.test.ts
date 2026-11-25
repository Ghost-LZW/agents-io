import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { BLOB_FRAME_MAX_BYTES, type ContentBlock, type EffectExplanation, type InboundItem, type InputRecord, type RenderedMessage, type ReplyRoute, type SendOp } from '@agents-io/protocol';
import { FakeChannel, FakeHarness, fakeEnvelope, type FakeTurnScript } from '@agents-io/testkit';
import { LocalClient, type HarnessInstance } from '@agents-io/kernel';
import { Gateway, InstanceHarness, resolveConfig } from '../src/defaults.js';
import { cleanups, daemon, tmp, until } from './helpers.js';

const alice = { channelUserId: 'alice', evidence: 'platform_signed' as const };

/** Two backends and a rule for each, plus a rule to the host queue's untargeted view. */
const two = (o: { alpha?: Record<string, unknown>; beta?: Record<string, unknown> } = {}) => ({
  backends: { alpha: o.alpha ?? {}, beta: o.beta ?? {} },
  bindings: [
    { id: 'to-alpha', match: { channel: 'fake', keywords: ['alpha'] }, on: 'host', to: 'alpha' },
    { id: 'to-beta', match: { channel: 'fake', keywords: ['beta'] }, on: 'host', to: 'beta' },
    { id: 'to-host', match: { channel: 'fake', keywords: ['plain'] }, on: 'host' },
  ],
});

/** Collect what is pushed to `c`; `answer` false leaves every push unanswered (a half-open consumer). */
function pushed(c: LocalClient, answer = true): InboundItem[] {
  const got: InboundItem[] = [];
  c.onRequest('inbound', (f) => {
    got.push(f.item as InboundItem);
    return answer ? { accepted: true } : new Promise(() => {});
  });
  return got;
}

const closed = (c: LocalClient) => {
  let reason: string | undefined;
  c.onClose((r) => (reason = r));
  return () => reason;
};

// Backends (docs/design/persona-backend/, INVARIANTS §3a). Backend ids here are neutral (alpha, beta).
describe('backends', () => {
  it('with backends configured a legacy consumer gets every untargeted item and none of a backend\'s; the backend\'s item waits under backend:<id> across a restart #PB-1 #HQ-1 #RS-1', async () => {
    const raw = {
      backends: { alpha: {} },
      bindings: [
        { id: 'to-alpha', match: { channel: 'fake', keywords: ['alpha'] }, on: 'host', to: 'alpha' },
        { id: 'to-host', match: { channel: 'fake', keywords: ['plain'] }, on: 'host' },
      ],
    };
    const w = await daemon({ raw });
    // The backend's consumer is known from the start, with nothing acked; nobody else is.
    expect(w.gw.hostQueue.consumers()).toEqual([{ name: 'backend:alpha', acked: 0, seen: expect.any(Number), target: 'alpha' }]);
    await w.chat.inject({ id: 'm1', sender: alice, text: 'a plain one' });
    await w.chat.inject({ id: 'm2', sender: alice, text: 'this is for alpha' });
    await w.chat.inject({ id: 'm3', sender: alice, text: 'plain again' });
    await until(() => w.gw.hostQueue.head() === 3);

    // A consumer as before backends existed: every item routed to no backend, in order, and none of alpha's.
    const h = await w.host({ name: 'legacy' });
    const mine = await h.inboundRead({ consumer: 'legacy', waitMs: 0 });
    expect(mine.items.map((x) => [x.cursor, x.bindingId, x.envelope.id, x.to])).toEqual([[1, 'to-host', 'm1', undefined], [3, 'to-host', 'm3', undefined]]);
    expect(mine.items.some((x) => 'to' in x)).toBe(false);
    // alpha's item is in alpha's view only.
    const alphas = async (gw = w.gw) => (await gw.hostQueue.read('backend:alpha')).map((x) => [x.cursor, x.bindingId, x.envelope.id, x.to]);
    expect(await alphas()).toEqual([[2, 'to-alpha', 'm2', 'alpha']]);
    // The legacy consumer acking everything it can reach does not release alpha's item.
    expect(await h.inboundAck('legacy', 3)).toEqual({ consumer: 'legacy', acked: 3 });
    expect((await h.inboundRead({ consumer: 'legacy', waitMs: 0 })).items).toEqual([]);
    expect(await alphas()).toEqual([[2, 'to-alpha', 'm2', 'alpha']]);
    await w.stop();

    // After a restart it still waits there, under the same consumer, unacked; the legacy cursor is kept too.
    const again = await daemon({ raw, dir: w.dir });
    expect(again.gw.hostQueue.consumers()).toEqual([
      { name: 'backend:alpha', acked: 0, seen: expect.any(Number), target: 'alpha' },
      { name: 'legacy', acked: 3, seen: expect.any(Number) },
    ]);
    expect(await alphas(again.gw)).toEqual([[2, 'to-alpha', 'm2', 'alpha']]);
    const h2 = await again.host({ name: 'legacy' });
    expect((await h2.inboundRead({ consumer: 'legacy', waitMs: 0 })).items).toEqual([]);
    // New input keeps going where its rule says.
    await again.chat.inject({ id: 'm4', sender: alice, text: 'alpha once more' });
    await again.chat.inject({ id: 'm5', sender: alice, text: 'and a plain one' });
    await until(() => again.gw.hostQueue.head() === 5);
    expect((await alphas(again.gw)).map((x) => x[2])).toEqual(['m2', 'm4']);
    expect((await h2.inboundRead({ consumer: 'legacy', waitMs: 0 })).items.map((x) => x.envelope.id)).toEqual(['m5']);
  });

  it("a backend key's hello is that backend whatever name it claims; it gets no callouts, no opt-ins and not the host role; router.hostConnected and the host slot are untouched #PB-1 #ID-3 #HQ-6", async () => {
    const w = await daemon({ raw: two() });
    // A name, callouts and opt-ins as a host would claim them: none of them counts.
    const a = await w.backend('alpha', { name: 'the-host', callouts: ['route', 'outbound', 'external'], optIn: ['attention', 'item.tool'] });
    expect(a.hello).toEqual({ name: 'backend:alpha', protocol: 1, host: false, backend: { id: 'alpha', access: 'readwrite' }, bindings: { version: null, active: false }, features: ['backends', 'deliver.update', 'message.ack', 'host.takeover', 'binding.tag', 'blobs'], callouts: [], optIn: [] });
    expect(w.gw.host.info()).toBeUndefined();
    expect(w.gw.router.hostConnected).toBe(false);
    expect(w.gw.host.outboundHeldBy()).toBeUndefined();
    expect(w.gw.host.externalHeldBy()).toBeUndefined();
    expect(w.gw.host.itemToolDeclared()).toBe(false);
    // Saying hello again does not change who it is.
    await expect(a.c.hello({ token: w.gw.token, name: 'admin' })).rejects.toMatchObject({ code: 'already_authenticated' });
    // A cursor that is not its own is refused at hello; its own may be written either way.
    const stray = await w.client();
    await expect(stray.hello({ token: a.key, name: 'x', consumer: 'backend:beta' })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(stray.hello({ token: a.key, name: 'x', consumer: 'legacy' })).rejects.toMatchObject({ code: 'forbidden' });
    // Still not authenticated after the refusals.
    await expect(stray.inboundRead({ consumer: 'alpha', waitMs: 0 })).rejects.toMatchObject({ code: 'unauthorized' });

    // A host holds the slot: a backend's push hello, even with takeover, leaves it alone.
    const h = await w.host({ name: 'legacy', consumer: 'legacy', callouts: ['outbound'] });
    pushed(h);
    expect(w.gw.router.hostConnected).toBe(true);
    const b = await w.backend('beta', { name: 'legacy', consumer: 'beta', takeover: true, callouts: true });
    expect(b.hello).toEqual({
      name: 'backend:beta', protocol: 1, host: false, backend: { id: 'beta', access: 'readwrite' }, bindings: { version: null, active: false },
      inbound: { consumer: 'backend:beta', acked: 0, head: 0 }, features: ['backends', 'deliver.update', 'message.ack', 'host.takeover', 'binding.tag', 'blobs'], callouts: [],
    });
    expect(w.gw.host.info()).toEqual({ name: 'legacy', consumer: 'legacy', callouts: true, hooks: ['outbound'] });
    expect(await h.bindingsGet()).toMatchObject({ hostConnected: true });
    // The backends leaving does not make the host look gone either.
    b.c.close();
    a.c.close();
    await until(() => w.gw.host.backendConnections('alpha').connections + w.gw.host.backendConnections('beta').connections === 0);
    expect(w.gw.host.info()?.name).toBe('legacy');
    expect(w.gw.router.hostConnected).toBe(true);
    expect(w.gw.host.outboundHeldBy()).toBeUndefined();

    // The host token's hello says backends are on, after everything it said before.
    const admin = await w.client();
    const withBackends = (await admin.hello({ token: w.gw.token, name: 'admin' })).features;
    // (`backends.access`, PB-7: this daemon knows the two key levels.)
    expect(withBackends.slice(-2)).toEqual(['backends', 'backends.access']);
    const plain = await daemon();
    const before = (await (await plain.client()).hello({ token: plain.gw.token, name: 'admin' })).features;
    expect(before).toEqual(withBackends.slice(0, -2));
    expect(before).not.toContain('backends');
  });

  it('two backends and a legacy host are online at once; each backend is pushed only its own items; one leaving does not disturb the others #PB-1 #HQ-1', async () => {
    const w = await daemon({ raw: two() });
    const h = await w.host({ name: 'legacy', consumer: 'legacy' });
    const a = await w.backend('alpha', { consumer: 'alpha' });
    const b = await w.backend('beta', { consumer: 'backend:beta' });
    const [toHost, toAlpha, toBeta] = [pushed(h), pushed(a.c), pushed(b.c)];
    expect(w.gw.host.backendConnections('alpha')).toEqual({ connections: 1, push: true });
    expect(w.gw.adminQueue().consumers.map((x) => [x.consumer, x.push])).toEqual([['backend:alpha', true], ['backend:beta', true], ['legacy', true]]);
    expect((await h.backendsList()).backends.map((x) => [x.id, x.connections, x.push])).toEqual([['alpha', 1, true], ['beta', 1, true]]);

    await w.chat.inject({ id: 'm1', sender: alice, text: 'a plain one' });
    await w.chat.inject({ id: 'm2', sender: alice, text: 'for alpha' });
    await w.chat.inject({ id: 'm3', sender: alice, text: 'for beta' });
    await w.chat.inject({ id: 'm4', sender: alice, text: 'for alpha and beta' });
    await until(() => toHost.length === 1 && toAlpha.length === 2 && toBeta.length === 2);
    const seen = (xs: InboundItem[]) => xs.map((x) => [x.envelope.id, x.to]);
    expect(seen(toHost)).toEqual([['m1', undefined]]);
    expect(seen(toAlpha)).toEqual([['m2', 'alpha'], ['m4', 'alpha']]);
    expect(seen(toBeta)).toEqual([['m3', 'beta'], ['m4', 'beta']]);
    await until(() => w.gw.adminQueue().consumers.every((x) => x.pending === 0));

    // alpha leaves: its next item waits for it; beta and the host go on as before.
    a.c.close();
    await until(() => !w.gw.host.backendPushing('alpha'));
    expect(w.gw.host.backendConnections('alpha')).toEqual({ connections: 0, push: false });
    expect(w.gw.host.info()?.name).toBe('legacy');
    await w.chat.inject({ id: 'm5', sender: alice, text: 'alpha again' });
    await w.chat.inject({ id: 'm6', sender: alice, text: 'beta again' });
    await w.chat.inject({ id: 'm7', sender: alice, text: 'plain again' });
    await until(() => toHost.length === 2 && toBeta.length === 3);
    expect(seen(toHost)[1]).toEqual(['m7', undefined]);
    expect(seen(toBeta)[2]).toEqual(['m6', 'beta']);
    expect(toAlpha).toHaveLength(2);
    expect(w.gw.adminQueue().consumers.find((x) => x.consumer === 'backend:alpha')).toMatchObject({ pending: 1, push: false });
    // The host leaving does not close beta; alpha coming back (same key) gets what waited.
    h.close();
    await until(() => w.gw.host.info() === undefined);
    expect(w.gw.host.backendPushing('beta')).toBe(true);
    const a2 = await w.backend('alpha', { key: a.key, consumer: 'alpha' });
    const again = pushed(a2.c);
    await until(() => again.length === 1);
    expect(seen(again)).toEqual([['m5', 'alpha']]);
    // Its hello said where it stood: the last item it accepted, and the one that waited as its head.
    expect(a2.hello.inbound).toEqual({ consumer: 'backend:alpha', acked: toAlpha[1]!.cursor, head: again[0]!.cursor });
  });

  it("a second push connection of the same backend is refused (host_connected) unless takeover, which replaces only that backend's connection; its unacked item is pushed again #HQ-6 #HQ-1 #PB-1", async () => {
    const w = await daemon({ raw: two() });
    const h = await w.host({ name: 'legacy', consumer: 'legacy' });
    pushed(h);
    const b = await w.backend('beta', { consumer: 'beta' });
    const toBeta = pushed(b.c);
    // alpha's first connection is half-open: it never answers the push.
    const a = await w.backend('alpha', { consumer: 'alpha' });
    const stuck = pushed(a.c, false);
    const aGone = closed(a.c);
    await w.chat.inject({ id: 'm1', sender: alice, text: 'for alpha' });
    await until(() => stuck.length === 1);

    const second = await w.client();
    await expect(second.hello({ token: a.key, name: 'alpha', consumer: 'alpha' })).rejects.toMatchObject({ code: 'host_connected' });
    // Without a consumer it is one more connection of the backend, pulling: allowed next to the push one.
    expect(await second.hello({ token: a.key, name: 'alpha' })).toMatchObject({ name: 'backend:alpha', host: false });
    expect(w.gw.host.backendConnections('alpha')).toEqual({ connections: 2, push: true });

    const third = await w.client();
    const got = pushed(third);
    const r = await third.hello({ token: a.key, name: 'alpha', consumer: 'alpha', takeover: true });
    expect(r).toMatchObject({ name: 'backend:alpha', host: false, replaced: { name: 'backend:alpha' }, inbound: { consumer: 'backend:alpha', acked: 0, head: stuck[0]!.cursor } });
    await until(() => got.length === 1);
    expect(got[0]!.cursor).toBe(stuck[0]!.cursor);
    await until(() => w.gw.hostQueue.cursor('backend:alpha') === got[0]!.cursor);
    // Only alpha's old push connection was closed: its pulling connection, beta and the host are where they were.
    await until(() => aGone() !== undefined);
    expect(w.gw.host.backendConnections('alpha')).toEqual({ connections: 2, push: true });
    expect((await second.inboundRead({ consumer: 'alpha', waitMs: 0 })).items).toEqual([]);
    expect(w.gw.host.backendConnections('beta')).toEqual({ connections: 1, push: true });
    expect(w.gw.host.info()?.name).toBe('legacy');
    expect(w.gw.router.hostConnected).toBe(true);
    await w.chat.inject({ id: 'm2', sender: alice, text: 'for beta' });
    await until(() => toBeta.length === 1);
  });

  it("pull with a key reads and acks only the backend's own cursor: another consumer name is forbidden, an explicit after shows nothing of others, head and a huge ack stop at its own last item #PB-1", async () => {
    const w = await daemon({ raw: two() });
    for (const [id, text] of [['m1', 'plain'], ['m2', 'for alpha'], ['m3', 'for beta'], ['m4', 'alpha again'], ['m5', 'plain again']] as const) await w.chat.inject({ id, sender: alice, text });
    await until(() => w.gw.hostQueue.head() === 5);
    const { c } = await w.backend('alpha');
    const mine = await c.inboundRead({ consumer: 'alpha', waitMs: 0 });
    expect(mine.items.map((x) => [x.cursor, x.envelope.id, x.to])).toEqual([[2, 'm2', 'alpha'], [4, 'm4', 'alpha']]);
    // The head is the last item of its own, not the queue's (5).
    expect(mine).toMatchObject({ acked: 0, head: 4 });
    // Any other consumer name: the untargeted ones, another backend's, a new one.
    for (const consumer of ['legacy', 'backend:beta', 'beta', 'backend:alpha2', 'Alpha']) {
      await expect(c.inboundRead({ consumer, waitMs: 0 })).rejects.toMatchObject({ code: 'forbidden' });
      await expect(c.inboundAck(consumer, 5)).rejects.toMatchObject({ code: 'forbidden' });
    }
    // Nobody was registered by the refused names.
    expect(w.gw.hostQueue.consumers().map((x) => x.name)).toEqual(['backend:alpha', 'backend:beta']);
    // An explicit `after` walks its own items only, from any cursor.
    expect((await c.inboundRead({ consumer: 'backend:alpha', after: 0, waitMs: 0 })).items.map((x) => x.cursor)).toEqual([2, 4]);
    expect((await c.inboundRead({ consumer: 'alpha', after: 2, waitMs: 0 })).items.map((x) => x.cursor)).toEqual([4]);
    expect((await c.inboundRead({ consumer: 'alpha', after: 4, waitMs: 0 })).items).toEqual([]);
    // An ack far ahead stops at its own last item, so a later item of its own is not skipped.
    expect(await c.inboundAck('alpha', 1_000_000)).toEqual({ consumer: 'backend:alpha', acked: 4 });
    await w.chat.inject({ id: 'm6', sender: alice, text: 'plain once more' });
    await w.chat.inject({ id: 'm7', sender: alice, text: 'alpha once more' });
    await until(() => w.gw.hostQueue.head() === 7);
    expect(await c.inboundRead({ consumer: 'alpha', waitMs: 0 })).toMatchObject({ items: [{ cursor: 7, to: 'alpha' }], acked: 4, head: 7 });
    // beta's and the untargeted items were not touched by alpha's ack.
    expect((await w.gw.hostQueue.read('backend:beta')).map((x) => x.cursor)).toEqual([3]);
    const h = await w.host({ name: 'legacy' });
    expect((await h.inboundRead({ consumer: 'legacy', waitMs: 0 })).items.map((x) => x.cursor)).toEqual([1, 5, 6]);
  });

  it("history.read with a key is forbidden unless backends.<id>.history is on; then it answers for the backend's own items (earlier messages of that conversation, whoever they were routed to) and unknown_cursor for another backend's cursor #PB-1 #DL-8", async () => {
    const w = await daemon({ raw: two({ beta: { history: true } }) });
    const base = Date.now();
    await w.chat.inject({ id: 'm1', sender: alice, text: 'for alpha', sentAt: base - 1000 });
    await w.chat.inject({ id: 'm2', sender: alice, text: 'plain', sentAt: base - 500 });
    await w.chat.inject({ id: 'm3', sender: alice, text: 'for beta', sentAt: base });
    await until(() => w.gw.hostQueue.head() === 3);
    // What the channel tells of the conversation: messages that were routed to alpha and to the host among them.
    w.chat.historyAnswer = [
      fakeEnvelope({ id: 'm1', channel: 'fake', account: 'default', text: 'for alpha', sentAt: base - 1000 }),
      fakeEnvelope({ id: 'm2', channel: 'fake', account: 'default', text: 'plain', sentAt: base - 500 }),
    ];
    const a = await w.backend('alpha');
    const b = await w.backend('beta');
    expect(a.hello.features).toEqual(['backends', 'deliver.update', 'message.ack', 'host.takeover', 'binding.tag', 'blobs']);
    expect(b.hello.features).toEqual(['backends', 'deliver.update', 'message.ack', 'host.takeover', 'binding.tag', 'blobs', 'history']);
    // Off (the default): forbidden, for its own item too, and the channel is not asked.
    await expect(a.c.historyRead({ cursor: 1, scope: 'chat' })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(a.c.historyRead({ cursor: 3, scope: 'chat' })).rejects.toMatchObject({ code: 'forbidden' });
    expect(w.chat.historyCalls).toEqual([]);
    // On: its own item answers with the conversation's earlier messages, whoever got them.
    expect((await b.c.historyRead({ cursor: 3, scope: 'chat' })).messages.map((m) => m.id)).toEqual(['m1', 'm2']);
    expect(w.chat.historyCalls).toEqual([{ id: 'm3', scope: 'chat' }]);
    // Another backend's cursor and an untargeted one answer exactly as one that does not exist.
    const missing = await b.c.exchange({ type: 'history.read', cursor: 99_999, scope: 'chat' });
    expect(missing).toMatchObject({ ok: false, error: { code: 'unknown_cursor' } });
    for (const cursor of [1, 2]) {
      const r = await b.c.exchange({ type: 'history.read', cursor, scope: 'chat' });
      expect(r).toMatchObject({ ok: false, error: { code: 'unknown_cursor', message: missing.error!.message.replace('99999', String(cursor)) } });
    }
    expect(w.chat.historyCalls).toHaveLength(1);
    // The host token reads around any item, as before.
    const h = await w.host({ name: 'legacy' });
    expect((await h.historyRead({ cursor: 2, scope: 'chat' })).messages.map((m) => m.id)).toEqual(['m1']);
  });

  it('every other host frame and every client frame answers forbidden on a backend connection (bindings.put, bindings.get, explain, run.start, session.prepare, schedule.put, inbound.redispatch, conversation.create, input.verify, test.replay, backends.key, backends.forget; input, subscribe, sessions) #PB-1 #SE-6', async () => {
    const w = await daemon({ raw: two({ alpha: { history: true } }), gateway: { testHooks: true } });
    await w.chat.inject({ id: 'm1', sender: alice, text: 'for alpha' });
    await until(() => w.gw.hostQueue.head() === 1);
    const { c, key } = await w.backend('alpha', { consumer: 'alpha' });
    pushed(c, false);
    const before = { table: w.gw.router.hostTable(), sessions: w.gw.sessions().length, keys: w.gw.backends.list(), flags: w.gw.host.outboundScope() };
    const route = { channel: 'fake', account: 'default', conversationId: 'c1' };
    const hostFrames: Record<string, unknown>[] = [
      { type: 'bindings.put', table: { version: 'v1', bindings: [{ id: 'all', match: {}, on: 'host', to: 'alpha' }], identities: [] } },
      { type: 'bindings.get' },
      { type: 'explain', inputId: 'm1' },
      { type: 'run.start', runId: 'r1', agent: 'main', input: [{ type: 'text', text: 'hi' }] },
      { type: 'run.cancel', runId: 'r1' },
      { type: 'session.prepare', sessionKey: 's1', agent: 'main', launch: {} },
      { type: 'session.compact', sessionKey: 's1' },
      { type: 'session.prewarm', sessionKey: 's1' },
      { type: 'schedule.put', schedule: { id: 'x', when: { at: Date.now() + 60_000 }, action: 'message', route, text: 'hi' } },
      { type: 'schedule.remove', scheduleId: 'x' },
      { type: 'schedule.list' },
      { type: 'inbound.redispatch', cursor: 1 },
      { type: 'conversation.create', operationId: 'op1', channel: 'fake', account: 'default', name: 'a group' },
      { type: 'input.verify', channelRef: 'fake:default:m1' },
      { type: 'test.replay', inputId: 'm1' },
      { type: 'test.fault', action: 'list' },
      { type: 'host.outboundScope', routes: [route] },
      { type: 'backends.list' },
      { type: 'backends.key', backend: 'beta', op: 'issue' },
      { type: 'backends.key', backend: 'alpha', op: 'rotate' },
      { type: 'backends.forget', backend: 'beta' },
    ];
    for (const f of hostFrames) expect([f.type, (await c.exchange(f)).error?.code]).toEqual([f.type, 'forbidden']);
    const clientFrames: Record<string, unknown>[] = [
      { type: 'command', command: { type: 'input', sessionKey: 's1', mode: 'queue', input: { content: [{ type: 'text', text: 'hi' }] } } },
      { type: 'command', command: { type: 'subscribe', sessionKey: 's1', tier: 'summary' } },
      { type: 'command', command: { type: 'interrupt', sessionKey: 's1' } },
      { type: 'sessions' },
      { type: 'watch.list' },
      { type: 'topic.list', conversation: 'fake:default:c1' },
      { type: 'tui.attach' },
      // A feature module's connection (the ACP server's `aio acp`) is a client frame too.
      { type: 'module.connect', module: 'acp-server' },
      // Not a frame at all: still nothing but forbidden.
      { type: 'no.such.frame' },
    ];
    for (const f of clientFrames) expect([f.type, (await c.exchange(f)).error?.code]).toEqual([f.type, 'forbidden']);
    // Nothing happened: no table, no session, no key for beta, alpha's key unchanged and its connection still up.
    expect({ table: w.gw.router.hostTable(), sessions: w.gw.sessions().length, keys: w.gw.backends.list(), flags: w.gw.host.outboundScope() }).toEqual(before);
    expect(w.gw.backends.verify(key)).toMatchObject({ id: 'alpha' });
    expect(w.gw.host.backendConnections('alpha')).toEqual({ connections: 1, push: true });
    // What it may do still works on the same connection.
    expect((await c.inboundRead({ consumer: 'alpha', waitMs: 0 })).items.map((x) => x.envelope.id)).toEqual(['m1']);
    expect((await c.historyRead({ cursor: 1, scope: 'chat' })).messages).toEqual([]);
    // The same frames are the host token's: one of them, to show the list above is not refused for its shape.
    const h = await w.host({ name: 'admin' });
    expect((await h.exchange({ type: 'bindings.get' })).ok).toBe(true);
    expect((await h.exchange({ type: 'backends.list' })).ok).toBe(true);
  });

  it("rotation and revocation close the backend's live connections; the old key cannot hello again, the new one gets the unacked items #PB-3 #HQ-1", async () => {
    const w = await daemon({ raw: two() });
    const h = await w.host({ name: 'admin' });
    const a = await w.backend('alpha', { consumer: 'alpha' });
    const stuck = pushed(a.c, false);
    const pull = await w.backend('alpha', { key: a.key });
    const b = await w.backend('beta', { consumer: 'beta' });
    pushed(b.c);
    const [pushGone, pullGone] = [closed(a.c), closed(pull.c)];
    await w.chat.inject({ id: 'm1', sender: alice, text: 'for alpha' });
    await until(() => stuck.length === 1);

    const rotated = await h.backendsKey('alpha', 'rotate');
    expect(rotated).toMatchObject({ backend: 'alpha', op: 'rotate', closed: 2 });
    await until(() => pushGone() !== undefined && pullGone() !== undefined);
    expect(w.gw.host.backendConnections('alpha')).toEqual({ connections: 0, push: false });
    // beta was not rotated: still there.
    expect(w.gw.host.backendConnections('beta')).toEqual({ connections: 1, push: true });
    const old = await w.client();
    await expect(old.hello({ token: a.key, name: 'alpha', consumer: 'alpha', takeover: true })).rejects.toMatchObject({ code: 'unauthorized' });
    // The item nobody accepted is still alpha's: the new key gets it.
    const next = await w.client();
    const got = pushed(next);
    expect(await next.hello({ token: rotated.key!, name: 'alpha', consumer: 'alpha' })).toMatchObject({ name: 'backend:alpha', inbound: { acked: 0, head: stuck[0]!.cursor } });
    await until(() => got.length === 1);
    expect(got[0]).toMatchObject({ cursor: stuck[0]!.cursor, to: 'alpha' });
    await until(() => w.gw.hostQueue.cursor('backend:alpha') === got[0]!.cursor);

    // Revocation: the connection is closed, and no key of alpha says hello any more.
    const nextGone = closed(next);
    expect(await h.backendsKey('alpha', 'revoke')).toEqual({ backend: 'alpha', op: 'revoke', access: 'readwrite', closed: 1 });
    await until(() => nextGone() !== undefined);
    for (const token of [a.key, rotated.key!]) await expect((await w.client()).hello({ token, name: 'alpha' })).rejects.toMatchObject({ code: 'unauthorized' });
    expect((await h.backendsList()).backends.find((x) => x.id === 'alpha')).toMatchObject({ connections: 0, push: false });
    // Forgetting a backend closes its connections too.
    const bGone = closed(b.c);
    expect(await h.backendsForget('beta')).toMatchObject({ backend: 'beta', closed: 1 });
    await until(() => bGone() !== undefined);

    // The second lock: a key that stopped being the backend's without its connections being closed
    // (here its row removed underneath) is refused on the next frame, and the connection is closed.
    const again = await w.backend('alpha', { consumer: 'alpha' });
    const againGone = closed(again.c);
    w.gw.records.delBackendKey('alpha');
    await expect(again.c.inboundRead({ consumer: 'alpha', waitMs: 0 })).rejects.toMatchObject({ code: 'unauthorized' });
    await until(() => againGone() !== undefined);
    expect(w.gw.host.backendConnections('alpha')).toEqual({ connections: 0, push: false });
  });

  it("with the host token: a name starting backend: or a push on a backend's cursor is refused once backends are configured; inbound.read / inbound.ack as backend:<id> show and clear that backend's backlog; a backend: consumer that is no backend's cursor is unknown_backend and registers nothing #PB-1 #ID-3", async () => {
    const w = await daemon({ raw: two() });
    for (const [id, text] of [['m1', 'for alpha'], ['m2', 'plain'], ['m3', 'for beta'], ['m4', 'alpha again']] as const) await w.chat.inject({ id, sender: alice, text });
    await until(() => w.gw.hostQueue.head() === 4);
    const token = w.gw.token;
    for (const hello of [{ name: 'backend:alpha' }, { name: ' backend:gamma' }, { name: 'admin', consumer: 'backend:alpha' }, { name: 'admin', consumer: 'backend:beta', takeover: true }]) {
      await expect((await w.client()).hello({ token, ...hello })).rejects.toMatchObject({ code: 'invalid_frame' });
    }
    expect(w.gw.host.info()).toBeUndefined();
    expect(w.gw.host.backendPushing('alpha')).toBe(false);
    // The admin credential works a backend's backlog by pulling: it sees that backend's items only.
    const h = await w.host({ name: 'admin' });
    const r = await h.inboundRead({ consumer: 'backend:alpha', waitMs: 0 });
    expect(r.items.map((x) => [x.cursor, x.envelope.id, x.to])).toEqual([[1, 'm1', 'alpha'], [4, 'm4', 'alpha']]);
    expect(r).toMatchObject({ acked: 0, head: 4 });
    expect(await h.inboundAck('backend:alpha', 1)).toEqual({ consumer: 'backend:alpha', acked: 1 });
    expect((await h.backendsList()).backends.map((x) => [x.id, x.acked, x.pending])).toEqual([['alpha', 1, 1], ['beta', 0, 1]]);
    expect(await h.inboundAck('backend:alpha', 99)).toEqual({ consumer: 'backend:alpha', acked: 4 });
    expect((await h.inboundRead({ consumer: 'backend:alpha', waitMs: 0 })).items).toEqual([]);
    // beta's and the untargeted items are where they were; an untargeted consumer's head is the queue's.
    expect((await h.backendsList()).backends.map((x) => [x.id, x.acked, x.pending])).toEqual([['alpha', 4, 0], ['beta', 0, 1]]);
    expect(await h.inboundRead({ consumer: 'legacy', waitMs: 0 })).toMatchObject({ items: [{ cursor: 2 }], acked: 0, head: 4 });

    // A mistyped id (no backend's cursor): not a consumer of the untargeted items under a backend's name.
    // It is refused, shows nothing of the host's own backlog and is not registered (it would hold back pruning).
    const names = () => w.gw.hostQueue.consumers().map((x) => [x.name, x.target]);
    const known = names();
    expect(known).toEqual([['backend:alpha', 'alpha'], ['backend:beta', 'beta'], ['legacy', undefined]]);
    for (const consumer of ['backend:gamma', 'backend:', 'backend:alpha ']) {
      expect([consumer, (await h.exchange({ type: 'inbound.read', consumer, waitMs: 0 })).error?.code]).toEqual([consumer, 'unknown_backend']);
      expect([consumer, (await h.exchange({ type: 'inbound.read', consumer, after: 0, waitMs: 0 })).error?.code]).toEqual([consumer, 'unknown_backend']);
      expect([consumer, (await h.exchange({ type: 'inbound.ack', consumer, cursor: 4 })).error?.code]).toEqual([consumer, 'unknown_backend']);
      await expect((await w.client()).hello({ token, name: 'admin', consumer })).rejects.toMatchObject({ code: 'unknown_backend' });
    }
    expect(names()).toEqual(known);
    expect(w.gw.host.info()).toBeUndefined();
    // A row like that from before (made when no backend was configured) is removed by forgetting the id.
    w.gw.hostQueue.cursor('backend:gamma');
    expect(names()).toEqual([['backend:alpha', 'alpha'], ['backend:beta', 'beta'], ['backend:gamma', undefined], ['legacy', undefined]]);
    expect((await h.exchange({ type: 'inbound.read', consumer: 'backend:gamma', waitMs: 0 })).error?.code).toBe('unknown_backend');
    expect(await h.backendsForget('gamma')).toEqual({ backend: 'gamma', items: 0, routes: 0, closed: 0 });
    expect(names()).toEqual(known);
    // Forgetting a configured backend still leaves its cursor registered (at 0).
    expect(await h.backendsForget('beta')).toMatchObject({ backend: 'beta', items: 1 });
    expect(names()).toEqual(known);

    // Without backends nothing of this applies: the name and the consumer are plain strings, as before.
    const plain = await daemon();
    const p = await plain.client();
    expect(await p.hello({ token: plain.gw.token, name: 'backend:alpha', consumer: 'backend:alpha' })).toMatchObject({ name: 'backend:alpha', host: true, inbound: { consumer: 'backend:alpha', acked: 0, head: 0 } });
    expect(plain.gw.hostQueue.consumers()).toEqual([{ name: 'backend:alpha', acked: 0, seen: expect.any(Number) }]);
    expect(await p.inboundRead({ consumer: 'backend:gamma', waitMs: 0 })).toEqual({ items: [], acked: 0, head: 0 });
    expect(await p.inboundAck('backend:gamma', 0)).toEqual({ consumer: 'backend:gamma', acked: 0 });
    expect(plain.gw.hostQueue.consumers().map((x) => x.name)).toEqual(['backend:alpha', 'backend:gamma']);
  });

  // ---- what a backend may send (PB-2) ---------------------------------------

  const at = (conversationId: string, more: Partial<ReplyRoute> = {}): ReplyRoute => ({ channel: 'fake', account: 'default', conversationId, ...more });
  const say = (c: LocalClient, operationId: string, route: ReplyRoute, message: RenderedMessage = { text: 'hi' }) => c.exchange({ type: 'deliver', operationId, route, message });
  const REFUSED = { ok: false, error: { code: 'route_not_allowed', message: 'this backend may not send to that route or message' } };

  it('deliver with a key goes only to conversations the backend received input from (any thread) or the admin registered; anything else, and an unknown channel or account, is route_not_allowed with no list of channels, not sent, and the operationId stays free #PB-2', async () => {
    const w = await daemon({ raw: two({ alpha: { routes: [{ channel: 'fake', account: 'default', conversationId: 'c-registered' }] } }) });
    await w.chat.inject({ id: 'm1', sender: alice, text: 'for alpha', conversation: { id: 'c1', kind: 'group' }, replyRoute: at('c1', { threadId: 't1' }) });
    await w.chat.inject({ id: 'm2', sender: alice, text: 'for beta', conversation: { id: 'c2', kind: 'group' } });
    await w.chat.inject({ id: 'm3', sender: alice, text: 'a plain one', conversation: { id: 'c3', kind: 'group' } });
    await until(() => w.gw.hostQueue.head() === 3);
    const a = await w.backend('alpha');
    const b = await w.backend('beta');
    expect(a.hello.features).toEqual(['backends', 'deliver.update', 'message.ack', 'host.takeover', 'binding.tag', 'blobs']);

    // Outside: beta's conversation, the host's, one nobody wrote in, a channel that does not exist.
    const outside = [at('c2'), at('c3'), at('c-new'), at('c1', { channel: 'nope' }), at('c-registered', { channel: 'nope' })];
    for (const [i, route] of outside.entries()) {
      const r = await say(a.c, `x${i}`, route);
      // One answer for all of them: it names no channel, account or conversation.
      expect(r).toMatchObject(REFUSED);
      expect(r.error!.message).not.toMatch(/fake|default|nope|c\d/);
    }
    expect(w.chat.sent).toEqual([]);
    for (const i of outside.keys()) expect(w.gw.outbox.get(`backend:alpha:x${i}`)).toBeUndefined();

    // Inside: the conversation of its input (its thread, another thread, none), and the registered one.
    const inside = [at('c1', { threadId: 't1' }), at('c1', { threadId: 't-other' }), at('c1'), at('c-registered'), at('c-registered', { threadId: 't9' })];
    for (const [i, route] of inside.entries()) {
      // The ids refused above are free: the same id sends now, not answered as a duplicate.
      expect((await say(a.c, `x${i}`, route)).value).toMatchObject({ operationId: `x${i}`, status: 'delivered', duplicate: false });
    }
    expect(w.chat.sent.map((x) => [x.route.conversationId, x.route.threadId])).toEqual([['c1', 't1'], ['c1', 't-other'], ['c1', undefined], ['c-registered', undefined], ['c-registered', 't9']]);
    // The registration is alpha's: beta has its own conversation only.
    expect(await say(b.c, 'y1', at('c-registered'))).toMatchObject(REFUSED);
    expect(await say(b.c, 'y1', at('c1'))).toMatchObject(REFUSED);
    expect((await say(b.c, 'y1', at('c2'))).value).toMatchObject({ status: 'delivered', duplicate: false });
    expect(w.chat.sent).toHaveLength(6);
    // The settlement is the backend's own log, as a host's deliver is the host's.
    expect(w.gw.outbox.get('backend:alpha:x0')).toMatchObject({ sessionKey: 'host:backend:alpha', status: 'delivered' });
  });

  it("a reply target must be a message the backend received or sent in that conversation: with a channel that addresses a reply by replyToMessageId alone, a reply to another conversation's message is refused; message.ack of such a message too #PB-2 #DL-8", async () => {
    /** Like a chat platform's reply API: a reply goes wherever the message it answers is, whatever the route's conversation says. */
    class RepliesByMessage extends FakeChannel {
      readonly home = new Map<string, string>();
      override async send(route: ReplyRoute, msg: RenderedMessage, op: SendOp) {
        const to = route.replyToMessageId !== undefined ? this.home.get(route.replyToMessageId) : undefined;
        const r = await super.send(to !== undefined ? { ...route, conversationId: to } : route, msg, op);
        this.home.set(r.providerMessageId, to ?? route.conversationId);
        return r;
      }
    }
    const chat = new RepliesByMessage('fake');
    const w = await daemon({ raw: two(), chat });
    const inject = async (id: string, text: string, conversationId: string, replyRoute?: ReplyRoute) => {
      chat.home.set(id, conversationId);
      await w.chat.inject({ id, sender: alice, text, conversation: { id: conversationId, kind: 'group' }, ...(replyRoute ? { replyRoute } : {}) });
    };
    await inject('in-a1', 'for alpha', 'c1');
    await inject('in-b1', 'for beta', 'c2');
    await inject('in-h1', 'a plain one', 'c1');
    await inject('in-ab', 'for alpha and beta', 'c3');
    // An input whose reply route answers an earlier message: that message is one alpha may answer too.
    chat.home.set('root-1', 'c1');
    await inject('in-a2', 'alpha again', 'c1', at('c1', { replyToMessageId: 'root-1' }));
    await until(() => w.gw.hostQueue.head() === 6);
    const a = await w.backend('alpha');
    const b = await w.backend('beta');
    const mine = (await say(a.c, 'own', at('c1'))).value as { providerMessageId: string };
    const betas = (await say(b.c, 'own', at('c3'))).value as { providerMessageId: string };
    expect(chat.sent).toHaveLength(2);

    // The route says c1 (alpha's), the reply target is elsewhere or not alpha's: without the check the
    // channel would post into beta's conversation, or under a message alpha never saw.
    const strays = ['in-b1', 'in-h1', betas.providerMessageId, 'never-seen', ''];
    for (const [i, replyToMessageId] of strays.entries()) expect([replyToMessageId, await say(a.c, `r${i}`, at('c1', { replyToMessageId }))]).toEqual([replyToMessageId, expect.objectContaining(REFUSED)]);
    // A message alpha did receive, but in another conversation than the route names.
    expect(await say(a.c, 'r9', at('c1', { replyToMessageId: 'in-ab' }))).toMatchObject(REFUSED);
    expect(chat.sent).toHaveLength(2);
    // What it received (the message, the message its reply route answers) and what it sent itself.
    for (const [i, replyToMessageId] of ['in-a1', 'root-1', 'in-a2', mine.providerMessageId].entries()) {
      expect((await say(a.c, `ok${i}`, at('c1', { replyToMessageId }))).value).toMatchObject({ status: 'delivered', duplicate: false });
    }
    expect((await say(a.c, 'ok9', at('c3', { replyToMessageId: 'in-ab' }))).value).toMatchObject({ status: 'delivered' });
    expect(chat.sent.slice(2).map((x) => x.route.conversationId)).toEqual(['c1', 'c1', 'c1', 'c1', 'c3']);

    // message.ack: the same rule for the message it marks.
    const mark = (c: LocalClient, route: ReplyRoute, messageId: string) => c.exchange({ type: 'message.ack', route, messageId, state: 'working' });
    for (const [route, messageId] of [[at('c1'), 'in-b1'], [at('c1'), 'in-h1'], [at('c1'), betas.providerMessageId], [at('c1'), 'in-ab'], [at('c2'), 'in-b1'], [at('c2'), 'in-a1'], [at('c1', { channel: 'nope' }), 'in-a1']] as const) {
      expect([messageId, await mark(a.c, route, messageId)]).toEqual([messageId, expect.objectContaining(REFUSED)]);
    }
    expect(chat.acks).toEqual([]);
    for (const messageId of ['in-a1', 'root-1', mine.providerMessageId]) expect((await mark(a.c, at('c1'), messageId)).value).toEqual({ messageId, state: 'working' });
    expect(chat.acks.map((x) => x.messageId)).toEqual(['in-a1', 'root-1', mine.providerMessageId]);

    // The host token is the admin's: unchecked, as before.
    const h = await w.host({ name: 'admin' });
    expect(await h.deliver({ operationId: 'h1', route: at('c1', { replyToMessageId: 'in-b1' }), message: { text: 'hi' } })).toMatchObject({ status: 'delivered' });
    expect(chat.sent.at(-1)!.route.conversationId).toBe('c2');
    expect(await h.messageAck({ route: at('c1'), messageId: 'in-b1', state: 'done' })).toEqual({ messageId: 'in-b1', state: 'done' });
  });

  it('the grant is per account: with two accounts of a channel a backend cannot send as the other one #PB-2 #DL-4', async () => {
    const dir = tmp('aio-be-');
    mkdirSync(join(dir, 'work'), { recursive: true });
    const raw = { dataDir: dir, policy: { owners: ['fake:alice'] }, local: { principal: 'me' }, cwd: join(dir, 'work'), ...two({ alpha: { routes: [{ channel: 'fake', account: 'one', conversationId: 'c-registered' }] } }) };
    const config = { ...resolveConfig(raw, { env: {}, baseDir: dir, cwd: dir }), socketPath: join(dir, 'run', 'aio.sock') };
    const harness = new FakeHarness();
    const chans = { one: new FakeChannel('fake'), two: new FakeChannel('fake') };
    const gw = await Gateway.start({ config, buildHarness: (i: HarnessInstance) => new InstanceHarness(i, harness), channels: [{ adapter: chans.one, account: 'one' }, { adapter: chans.two, account: 'two' }], logger: () => {} });
    cleanups.push(() => gw.stop());
    const connect = async (token: string, name: string) => {
      const c = await LocalClient.connect(config.socketPath);
      cleanups.push(() => c.close());
      await c.hello({ token, name });
      return c;
    };
    // The same conversation id on both accounts; alpha's input came in on account one.
    await chans.one.inject({ id: 'm1', sender: alice, text: 'for alpha', conversation: { id: 'c1', kind: 'group' } });
    await chans.two.inject({ id: 'm2', sender: alice, text: 'for beta', conversation: { id: 'c1', kind: 'group' } });
    await until(() => gw.hostQueue.head() === 2);
    const key = (gw.backendKey('alpha', 'issue') as { ok: true; value: { key: string } }).value.key;
    const a = await connect(key, 'alpha');
    const route = (account: string, more: Partial<ReplyRoute> = {}): ReplyRoute => ({ channel: 'fake', account, conversationId: 'c1', ...more });

    expect(await say(a, 'x1', route('two'))).toMatchObject(REFUSED);
    // Its own message id does not carry it over to the other account either.
    expect(await say(a, 'x1', route('two', { replyToMessageId: 'm1' }))).toMatchObject(REFUSED);
    // An account nobody runs: with two of them there is no guess, and the answer is the same.
    expect(await say(a, 'x1', route('three'))).toMatchObject(REFUSED);
    expect(await a.exchange({ type: 'message.ack', route: route('two'), messageId: 'm1', state: 'working' })).toMatchObject(REFUSED);
    expect([chans.one.sent.length, chans.two.sent.length, chans.two.acks.length]).toEqual([0, 0, 0]);
    expect((await say(a, 'x1', route('one', { replyToMessageId: 'm1' }))).value).toMatchObject({ status: 'delivered', duplicate: false });
    expect([chans.one.sent.length, chans.two.sent.length]).toEqual([1, 0]);
    expect(chans.one.sent[0]!.route.account).toBe('one');
    // A registered destination names its account too.
    expect(await say(a, 'x2', { ...route('two'), conversationId: 'c-registered' })).toMatchObject(REFUSED);
    expect((await say(a, 'x2', { ...route('one'), conversationId: 'c-registered' })).value).toMatchObject({ status: 'delivered', duplicate: false });
    expect([chans.one.sent.length, chans.two.sent.length]).toEqual([2, 0]);
    // A message it sent as account one is not its own on account two.
    const sent = chans.one.sent[0]!.providerMessageId;
    expect(await a.exchange({ type: 'deliver.update', operationId: 'u1', route: route('two'), providerMessageId: sent, message: { text: 'edited' }, sequence: 1 })).toMatchObject(REFUSED);
    // The host token sends as either bot, as before.
    const h = await connect(gw.token, 'admin');
    expect(await h.deliver({ operationId: 'h1', route: route('two'), message: { text: 'hi' } })).toMatchObject({ status: 'delivered' });
    expect(chans.two.sent).toHaveLength(1);
  });

  it("operationIds are per backend: two backends reusing one id both send, a retry is the backend's own duplicate, a host-token deliver with operationId backend:<id>:<x> does not collide; explain names the backend; the host token's namespace is unchanged, also across a restart #PB-2 #DL-2 #EX-2 #RS-1", async () => {
    const w = await daemon({ raw: two() });
    await w.chat.inject({ id: 'm1', sender: alice, text: 'for alpha and beta' });
    await until(() => w.gw.hostQueue.head() === 2);
    const a = await w.backend('alpha');
    const b = await w.backend('beta');
    const h = await w.host({ name: 'admin' });
    const first = (await say(a.c, 'x', at('c1'), { text: 'from alpha' })).value as { providerMessageId: string };
    expect(first).toMatchObject({ operationId: 'x', status: 'delivered', duplicate: false });
    expect((await say(b.c, 'x', at('c1'), { text: 'from beta' })).value).toMatchObject({ operationId: 'x', status: 'delivered', duplicate: false });
    // The host token using the same id, and one that spells out alpha's namespace: neither is alpha's.
    expect(await h.deliver({ operationId: 'x', route: at('c1'), message: { text: 'from the host' } })).toMatchObject({ operationId: 'x', duplicate: false });
    expect(await h.deliver({ operationId: 'backend:alpha:x', route: at('c1'), message: { text: 'host, odd id' } })).toMatchObject({ operationId: 'backend:alpha:x', duplicate: false });
    expect(w.chat.sent.map((x) => x.msg.text)).toEqual(['from alpha', 'from beta', 'from the host', 'host, odd id']);
    // A retry is the backend's own: answered from its record, nothing sent.
    expect((await say(a.c, 'x', at('c1'), { text: 'again' })).value).toMatchObject({ operationId: 'x', duplicate: true, providerMessageId: first.providerMessageId });
    expect(w.chat.sent).toHaveLength(4);
    expect(w.chat.sent.map((x) => x.op.operationId)).toEqual(['backend:alpha:x', 'backend:beta:x', 'host:x', 'host:backend:alpha:x']);

    const explained = async (c: LocalClient, id: string) => {
      const e = (await c.explain(id)) as unknown as EffectExplanation;
      return [e.sessionKey, e.backend, e.result, e.providerMessageId];
    };
    const sent = w.chat.sent.map((x) => x.providerMessageId);
    const expected = [
      ['backend:alpha:x', ['host:backend:alpha', 'alpha', 'delivered', sent[0]]],
      ['backend:beta:x', ['host:backend:beta', 'beta', 'delivered', sent[1]]],
      // The host's rows are as before: no backend, the namespace `host:`.
      ['host:x', ['host:admin', undefined, 'delivered', sent[2]]],
      ['host:backend:alpha:x', ['host:admin', undefined, 'delivered', sent[3]]],
    ] as const;
    for (const [id, e] of expected) expect([id, await explained(h, id)]).toEqual([id, e]);
    expect('backend' in ((await h.explain('host:x')) as object)).toBe(false);
    await w.stop();

    // After a restart every one of them is still settled, and still whose it was.
    const again = await daemon({ raw: two(), dir: w.dir });
    const a2 = await again.backend('alpha');
    const b2 = await again.backend('beta');
    const h2 = await again.host({ name: 'admin' });
    expect((await say(a2.c, 'x', at('c1'))).value).toMatchObject({ duplicate: true, providerMessageId: sent[0] });
    expect((await say(b2.c, 'x', at('c1'))).value).toMatchObject({ duplicate: true, providerMessageId: sent[1] });
    expect(await h2.deliver({ operationId: 'x', route: at('c1'), message: { text: 'hi' } })).toMatchObject({ duplicate: true, providerMessageId: sent[2] });
    expect(await h2.deliver({ operationId: 'backend:alpha:x', route: at('c1'), message: { text: 'hi' } })).toMatchObject({ duplicate: true, providerMessageId: sent[3] });
    expect(again.chat.sent).toEqual([]);
    for (const [id, e] of expected) expect([id, await explained(h2, id)]).toEqual([id, e]);
    // A new id of alpha still sends.
    expect((await say(a2.c, 'x2', at('c1'))).value).toMatchObject({ status: 'delivered', duplicate: false });
    expect(again.chat.sent.map((x) => x.op.operationId)).toEqual(['backend:alpha:x2']);
  });

  it('deliver.update edits only a message the backend itself delivered, in its conversation; a message another backend or the host delivered is route_not_allowed #PB-2 #DL-8', async () => {
    const w = await daemon({ raw: two() });
    // (The fake channel numbers what it sends m1, m2, …: the inputs here are named apart from those.)
    await w.chat.inject({ id: 'in-1', sender: alice, text: 'for alpha and beta', conversation: { id: 'c1', kind: 'group' } });
    await w.chat.inject({ id: 'in-2', sender: alice, text: 'for alpha', conversation: { id: 'c2', kind: 'group' } });
    await until(() => w.gw.hostQueue.head() === 3);
    const a = await w.backend('alpha');
    const b = await w.backend('beta');
    const h = await w.host({ name: 'admin' });
    const id = (r: { value?: unknown }) => (r.value as { providerMessageId: string }).providerMessageId;
    const mine = id(await say(a.c, 'n1', at('c1')));
    const betas = id(await say(b.c, 'n1', at('c1')));
    const hosts = (await h.deliver({ operationId: 'n1', route: at('c1'), message: { text: 'hi' } })).providerMessageId!;
    const update = (c: LocalClient, operationId: string, route: ReplyRoute, providerMessageId: string, final = false) =>
      c.exchange({ type: 'deliver.update', operationId, route, providerMessageId, message: { text: `edit ${operationId}` }, sequence: 1, ...(final ? { final } : {}) });
    const edits = (m: string) => w.chat.sent.find((x) => x.providerMessageId === m)!.edits.map((x) => x.text);

    // Not its own: beta's, the host's, the input it received, one that does not exist; final or not.
    for (const [i, m] of [betas, hosts, 'in-1', 'nope'].entries()) {
      expect([m, await update(a.c, `e${i}`, at('c1'), m)]).toEqual([m, expect.objectContaining(REFUSED)]);
      expect([m, await update(a.c, `e${i}`, at('c1'), m, true)]).toEqual([m, expect.objectContaining(REFUSED)]);
      expect(w.gw.outbox.get(`backend:alpha:e${i}`)).toBeUndefined();
    }
    // Its own message, named with a conversation it may send to but did not send it in; and with one it may not send to.
    expect(await update(a.c, 'e8', at('c2'), mine)).toMatchObject(REFUSED);
    expect(await update(a.c, 'e9', at('c-new'), mine)).toMatchObject(REFUSED);
    expect(await update(a.c, 'e9', at('c1', { channel: 'nope' }), mine)).toMatchObject(REFUSED);
    expect([edits(mine), edits(betas), edits(hosts)]).toEqual([[], [], []]);

    // Its own, where it sent it: edited, finalized once per operationId (DL-8), in alpha's namespace.
    expect((await update(a.c, 'u1', at('c1'), mine)).value).toMatchObject({ status: 'delivered', duplicate: false, providerMessageId: mine });
    expect((await update(a.c, 'u2', at('c1'), mine, true)).value).toMatchObject({ status: 'delivered', duplicate: false });
    expect((await update(a.c, 'u2', at('c1'), mine, true)).value).toMatchObject({ status: 'delivered', duplicate: true });
    expect(edits(mine)).toEqual(['edit u1', 'edit u2']);
    expect(w.gw.outbox.get('backend:alpha:u2')).toMatchObject({ sessionKey: 'host:backend:alpha', status: 'delivered' });
    expect(w.gw.outbox.get('host:u2')).toBeUndefined();
    expect((await h.explain('backend:alpha:u2')) as unknown as EffectExplanation).toMatchObject({ sessionKey: 'host:backend:alpha', backend: 'alpha', providerMessageId: mine });
    // beta reusing alpha's final id edits its own message, and still not alpha's.
    expect((await update(b.c, 'u2', at('c1'), betas, true)).value).toMatchObject({ status: 'delivered', duplicate: false });
    expect(await update(b.c, 'u3', at('c1'), mine)).toMatchObject(REFUSED);
    // The host token edits anything, as before; alpha's message stays alpha's after that.
    expect(await h.deliverUpdate({ operationId: 'hu', route: at('c1'), providerMessageId: mine, message: { text: 'by the host' }, sequence: 2, final: true })).toMatchObject({ status: 'delivered', duplicate: false });
    expect((await update(a.c, 'u4', at('c1'), mine)).value).toMatchObject({ status: 'delivered' });
    expect(await update(b.c, 'u4', at('c1'), mine)).toMatchObject(REFUSED);
    expect(edits(mine)).toEqual(['edit u1', 'edit u2', 'by the host', 'edit u4']);
  });

  it("a click on a card backend alpha delivered reaches alpha only, with the clicker's stamped identity: a rule to beta matching its action prefix, an untargeted host rule and a dispatch rule do not get it, and a kernel-format action id on it resolves nothing; a click on a card the host delivered reaches no backend #PB-1 #PB-2 #RQ-1", async () => {
    let decided: string | undefined;
    const asks: FakeTurnScript = async (t) => {
      t.emit({ t: 'request.opened', requestId: 'r1', kind: 'tool_approval', title: 'a tool', risk: { writes: true }, allowedDecisions: ['allow_once', 'deny'], allowAlways: false, defaultDeny: true });
      decided = (await t.waitDecision('r1')).kind;
    };
    const raw = {
      backends: { alpha: {}, beta: {} },
      bindings: [
        { id: 'to-alpha', match: { channel: 'fake', keywords: ['alpha'] }, on: 'host', to: 'alpha' },
        // Every click, for each of them: only the sender of the clicked message decides who gets it.
        { id: 'alpha-clicks', match: { actionPrefix: '' }, on: 'host', to: 'alpha' },
        { id: 'beta-clicks', match: { actionPrefix: '' }, on: 'host', to: 'beta' },
        { id: 'host-clicks', match: { actionPrefix: 'pick:' }, on: 'host' },
        { id: 'agent-clicks', match: { actionPrefix: 'pick:' }, on: 'dispatch' },
      ],
    };
    const w = await daemon({ raw, script: asks, policy: { resolve: async () => ({ kind: 'human', principals: ['fake:alice'], routes: [] }) } });
    await w.chat.inject({ id: 'm1', sender: alice, text: 'for alpha' });
    await until(() => w.gw.hostQueue.head() === 1);
    const a = await w.backend('alpha');
    const h = await w.host({ name: 'admin' });
    const card: RenderedMessage = { text: 'pick one', actions: [{ id: 'pick:yes', label: 'Yes' }] };
    const alphas = ((await say(a.c, 'card', at('c1'), card)).value as { providerMessageId: string }).providerMessageId;
    const hosts = (await h.deliver({ operationId: 'card', route: at('c1'), message: card })).providerMessageId!;
    // A turn waits for an approval: its button's action id is the kernel's.
    const local = await w.client();
    await local.input('s', 'go');
    await until(() => w.gw.hub.locate({ requestId: 'r1' }) !== undefined);

    const view = async (consumer: string) => (await w.gw.hostQueue.read(consumer)).map((x) => [x.bindingId, x.to, x.envelope.id, x.input.origin.principal?.id]);
    const click = (id: string, actionId: string, messageId?: string) =>
      w.chat.inject({ id, sender: alice, content: [{ type: 'event', name: 'action', data: { actionId, ...(messageId !== undefined ? { messageId } : {}) } }] });
    const sessions = () => w.gw.sessions().map((x) => x.sessionKey).sort();
    const before = sessions();

    // On alpha's card: alpha's rule only, as the person who clicked.
    const k1 = await click('k1', 'pick:yes', alphas);
    expect(k1).toMatchObject({ accepted: true });
    expect(await view('backend:alpha')).toEqual([['to-alpha', 'alpha', 'm1', 'fake:alice'], ['alpha-clicks', 'alpha', 'k1', 'fake:alice']]);
    expect(await view('backend:beta')).toEqual([]);
    expect(await view('legacy')).toEqual([]);
    expect(sessions()).toEqual(before);
    const e = (await h.explain(k1.inputId!)) as unknown as { matched: { bindingId: string; rejected?: { code: string } }[] };
    expect(e.matched.map((m) => [m.bindingId, m.rejected?.code])).toEqual([['alpha-clicks', undefined], ['beta-clicks', 'click_sender'], ['host-clicks', 'click_sender'], ['agent-clicks', 'click_sender']]);

    // The approval's own action id on alpha's card: an input for alpha, not a decision.
    await click('k2', 'req:r1:allow_once', alphas);
    expect((await view('backend:alpha')).at(-1)).toEqual(['alpha-clicks', 'alpha', 'k2', 'fake:alice']);
    expect(decided).toBeUndefined();
    expect(w.gw.hub.locate({ requestId: 'r1' })).toBe('s');

    // On the host's card: no backend gets it, though both have a rule for every click; the rules without `to` do.
    await click('k3', 'pick:yes', hosts);
    await until(async () => (await view('legacy')).length === 1);
    expect(await view('legacy')).toEqual([['host-clicks', undefined, 'k3', 'fake:alice']]);
    expect(await view('backend:alpha')).toHaveLength(3);
    expect(await view('backend:beta')).toEqual([]);
    await until(() => sessions().length === before.length + 1);
    // And the same approval id off alpha's card is the kernel's button again.
    await click('k4', 'req:r1:allow_once', hosts);
    await until(() => decided !== undefined);
    expect(decided).toBe('allow_once');
    expect(await view('backend:alpha')).toHaveLength(3);
  });

  it('the send grant of a received input survives a restart; a backend removed and added back gets its backlog with a new key and may answer it; after backends.forget it starts empty and the old conversation is route_not_allowed; a host-token deliver is unchecked as before with backends configured #PB-2 #PB-3 #RS-1', async () => {
    const w = await daemon({ raw: two() });
    await w.chat.inject({ id: 'in-1', sender: alice, text: 'for alpha', conversation: { id: 'c1', kind: 'group' } });
    await until(() => w.gw.hostQueue.head() === 1);
    const first = await w.backend('alpha');
    await w.stop();

    // A restart: the key and the grant are both still there, the item still unacked.
    const second = await daemon({ raw: two(), dir: w.dir });
    const a2 = await second.backend('alpha', { key: first.key });
    expect((await a2.c.inboundRead({ consumer: 'alpha', waitMs: 0 })).items.map((x) => x.envelope.id)).toEqual(['in-1']);
    expect((await say(a2.c, 'r1', at('c1', { replyToMessageId: 'in-1' }))).value).toMatchObject({ status: 'delivered', duplicate: false });
    expect(await say(a2.c, 'r2', at('c2'))).toMatchObject(REFUSED);
    await second.stop();

    // alpha leaves the config: its key is deleted at start. Its items and grants are not.
    const without = { backends: { beta: {} }, bindings: two().bindings.filter((x) => x.to !== 'alpha') };
    const third = await daemon({ raw: without, dir: w.dir });
    await expect((await third.client()).hello({ token: first.key, name: 'alpha' })).rejects.toMatchObject({ code: 'unauthorized' });
    await third.stop();

    // Back under the same id: the old key is gone for good, a new one finds the backlog and may answer it.
    const fourth = await daemon({ raw: two(), dir: w.dir });
    await expect((await fourth.client()).hello({ token: first.key, name: 'alpha' })).rejects.toMatchObject({ code: 'unauthorized' });
    const a4 = await fourth.backend('alpha');
    expect(a4.key).not.toBe(first.key);
    expect((await a4.c.inboundRead({ consumer: 'alpha', waitMs: 0 })).items.map((x) => x.envelope.id)).toEqual(['in-1']);
    expect((await say(a4.c, 'r3', at('c1', { replyToMessageId: 'in-1' }))).value).toMatchObject({ status: 'delivered', duplicate: false });
    // Its operationIds followed the id too.
    expect((await say(a4.c, 'r1', at('c1'))).value).toMatchObject({ duplicate: true });
    expect(fourth.chat.sent).toHaveLength(1);

    // forget: the items, the cursor and the grants go; the key stays.
    const h = await fourth.host({ name: 'admin' });
    expect(await h.backendsForget('alpha')).toMatchObject({ backend: 'alpha', items: 1, routes: 1, closed: 1 });
    const a5 = await fourth.backend('alpha', { key: a4.key });
    expect(await a5.c.inboundRead({ consumer: 'alpha', waitMs: 0 })).toMatchObject({ items: [], acked: 0, head: 0 });
    expect(await say(a5.c, 'r4', at('c1'))).toMatchObject(REFUSED);
    expect(await say(a5.c, 'r4', at('c1', { replyToMessageId: 'in-1' }))).toMatchObject(REFUSED);
    expect(fourth.chat.sent).toHaveLength(1);
    // A new input grants it again.
    await fourth.chat.inject({ id: 'in-9', sender: alice, text: 'alpha once more', conversation: { id: 'c1', kind: 'group' } });
    await until(async () => (await a5.c.inboundRead({ consumer: 'alpha', waitMs: 0 })).items.length === 1);
    expect((await say(a5.c, 'r4', at('c1', { replyToMessageId: 'in-9' }))).value).toMatchObject({ status: 'delivered', duplicate: false });

    // The host token, with backends configured: any conversation, any reply target, its own namespace.
    expect(await h.deliver({ operationId: 'h1', route: at('c-anywhere', { replyToMessageId: 'whatever' }), message: { text: 'hi' } })).toMatchObject({ status: 'delivered', duplicate: false });
    expect(fourth.chat.sent.at(-1)).toMatchObject({ route: { conversationId: 'c-anywhere' }, op: { operationId: 'host:h1' } });
    expect((await h.explain('host:h1')) as unknown as EffectExplanation).toMatchObject({ sessionKey: 'host:admin' });
  });

  it("a click on a backend's own card is queued for it and grants no conversation: once the admin took the conversation away (its registered route removed, backends.forget) a click on an old card does not give it back; a message routed to it does #PB-2 #PB-1", async () => {
    const raw = (routes: ReplyRoute[]) => ({
      backends: { alpha: { routes } },
      bindings: [
        { id: 'to-alpha', match: { channel: 'fake', keywords: ['alpha'] }, on: 'host', to: 'alpha' },
        { id: 'alpha-clicks', match: { actionPrefix: 'pick:' }, on: 'host', to: 'alpha' },
      ],
    });
    const card: RenderedMessage = { text: 'pick one', actions: [{ id: 'pick:yes', label: 'Yes' }] };
    const sendCard = async (c: LocalClient, operationId: string, conversationId: string) => ((await say(c, operationId, at(conversationId), card)).value as { providerMessageId: string }).providerMessageId;
    const click = (w: { chat: FakeChannel }, id: string, conversationId: string, messageId: string) =>
      w.chat.inject({ id, sender: alice, conversation: { id: conversationId, kind: 'group' }, content: [{ type: 'event', name: 'action', data: { actionId: 'pick:yes', messageId } }] });
    const mine = async (c: LocalClient) => (await c.inboundRead({ consumer: 'alpha', after: 0, waitMs: 0 })).items.map((x) => [x.bindingId, x.envelope.id]);

    // Registered only: alpha never received anything from there. It sends a card; somebody clicks.
    const w = await daemon({ raw: raw([at('c-reg')]) });
    const a = await w.backend('alpha');
    const regCard = await sendCard(a.c, 'card-reg', 'c-reg');
    await click(w, 'k1', 'c-reg', regCard);
    expect(await mine(a.c)).toEqual([['alpha-clicks', 'k1']]);
    // The click is its input, and it may answer it while the registration stands; no grant was written for it.
    expect((await say(a.c, 'r1', at('c-reg', { replyToMessageId: regCard }))).value).toMatchObject({ status: 'delivered', duplicate: false });
    expect(w.gw.hostQueue.grantCount('alpha')).toBe(0);
    expect(w.gw.hostQueue.granted('alpha', at('c-reg'))).toBe(false);
    await w.stop();

    // The admin removes the registration. The card is still in the chat.
    const second = await daemon({ raw: raw([]), dir: w.dir });
    const a2 = await second.backend('alpha', { key: a.key });
    expect(await say(a2.c, 'r2', at('c-reg'))).toMatchObject(REFUSED);
    await click(second, 'k2', 'c-reg', regCard);
    expect(await mine(a2.c)).toEqual([['alpha-clicks', 'k1'], ['alpha-clicks', 'k2']]);
    expect(await say(a2.c, 'r2', at('c-reg'))).toMatchObject(REFUSED);
    expect(await say(a2.c, 'r2', at('c-reg', { replyToMessageId: regCard }))).toMatchObject(REFUSED);
    expect(second.gw.hostQueue.grantCount('alpha')).toBe(0);
    expect(second.chat.sent).toEqual([]);

    // A conversation it got by an input routed to it: taken away with backends.forget, a click on its old card there gives nothing back.
    // (Named apart from what the fake channel numbered alpha's sends, m1 and m2: an input carrying one of those ids would be that message's echo, PB-8.)
    await second.chat.inject({ id: 'in-1', sender: alice, text: 'for alpha', conversation: { id: 'c1', kind: 'group' } });
    await until(async () => (await mine(a2.c)).length === 3);
    const oldCard = await sendCard(a2.c, 'card-c1', 'c1');
    expect(second.gw.hostQueue.grantCount('alpha')).toBe(1);
    const h = await second.host({ name: 'admin' });
    expect(await h.backendsForget('alpha')).toMatchObject({ backend: 'alpha', items: 3, routes: 1 });
    const a3 = await second.backend('alpha', { key: a.key });
    expect(await say(a3.c, 'r3', at('c1'))).toMatchObject(REFUSED);
    await click(second, 'k3', 'c1', oldCard);
    expect(await mine(a3.c)).toEqual([['alpha-clicks', 'k3']]);
    expect(await say(a3.c, 'r3', at('c1'))).toMatchObject(REFUSED);
    expect(await say(a3.c, 'r3', at('c1', { replyToMessageId: oldCard }))).toMatchObject(REFUSED);
    expect(second.gw.hostQueue.grantCount('alpha')).toBe(0);
    expect(second.chat.sent).toHaveLength(1);
    // What gives a conversation is an input a rule routed to it: after one, the click's card is its to answer again.
    await second.chat.inject({ id: 'in-2', sender: alice, text: 'alpha once more', conversation: { id: 'c1', kind: 'group' } });
    await until(async () => (await mine(a3.c)).length === 2);
    expect((await say(a3.c, 'r3', at('c1', { replyToMessageId: oldCard }))).value).toMatchObject({ status: 'delivered', duplicate: false });
    expect(second.gw.hostQueue.grantCount('alpha')).toBe(1);
  });

  it("the host token redispatches a backend's item by its cursor, with the origin it arrived with and once per cursor; the backend's cursor and item are untouched #HQ-4 #PB-1", async () => {
    const inputs: InputRecord[] = [];
    const w = await daemon({ raw: two(), script: async (t) => void inputs.push(...t.inputs) });
    // Not an owner: only the rule to alpha takes it.
    const bob = { channelUserId: 'bob', evidence: 'platform_signed' as const };
    await w.chat.inject({ id: 'm1', sender: bob, text: 'a plain one' });
    const sent = await w.chat.inject({ id: 'm2', sender: bob, text: 'for alpha', conversation: { id: 'g1', kind: 'group' } });
    await until(() => w.gw.hostQueue.head() === 2);
    const a = await w.backend('alpha');
    const [item] = (await a.c.inboundRead({ consumer: 'alpha', waitMs: 0 })).items;
    expect(item).toMatchObject({ cursor: 2, to: 'alpha', bindingId: 'to-alpha', channelRef: 'channel:fake/m2' });
    expect(inputs).toEqual([]);

    const h = await w.host({ name: 'admin' });
    const r = await h.inboundRedispatch({ cursor: 2, session: { key: 'R1' } });
    expect(r).toMatchObject({ cursor: 2, of: sent.inputId, inputId: `${sent.inputId}~r2`, sessionKey: 'R1', on: 'dispatch', by: 'host:admin', duplicate: false });
    await until(() => inputs.length === 1);
    // The person who wrote it, not the host and not the backend.
    expect(inputs[0]!.origin).toEqual(item!.input.origin);
    expect(inputs[0]!.origin).toMatchObject({ kind: 'human', evidence: 'platform_signed', adapter: 'fake', via: 'fake:default:g1' });
    expect(inputs[0]!.content).toEqual(item!.input.content);
    // Once per cursor, whoever's item it is.
    expect(await h.inboundRedispatch({ cursor: 2, session: { key: 'R2' } })).toMatchObject({ sessionKey: 'R1', duplicate: true });
    await new Promise((res) => setTimeout(res, 30));
    expect(inputs).toHaveLength(1);
    // alpha's view is as it was: the item still unacked under its own cursor, and still not its to redispatch.
    expect(await a.c.inboundRead({ consumer: 'alpha', waitMs: 0 })).toMatchObject({ items: [{ cursor: 2, to: 'alpha' }], acked: 0, head: 2 });
    expect(w.gw.hostQueue.get(2)).toMatchObject({ to: 'alpha', bindingId: 'to-alpha' });
    expect((await a.c.exchange({ type: 'inbound.redispatch', cursor: 2 })).error?.code).toBe('forbidden');
  });

  it("a backend's deliver is not put to the host: with a host that declared outbound.scoped over the conversation away, and with it back, the message is delivered and no outbound callout is asked #PB-2 #DL-7 #DL-5", async () => {
    const w = await daemon({ raw: two() });
    await w.chat.inject({ id: 'm1', sender: alice, text: 'for alpha', conversation: { id: 'c1', kind: 'group' } });
    await until(() => w.gw.hostQueue.head() === 1);
    const a = await w.backend('alpha');
    const asked: unknown[] = [];
    const scoped = async () => {
      const h = await w.client();
      // Every callout it could be asked (only `outbound`, with the content, is declared): it would hold.
      h.onRequest('policy', (f) => {
        asked.push(f);
        return { verdict: 'hold' };
      });
      await h.hello({ token: w.gw.token, name: 'checker', callouts: ['outbound.scoped'], outboundScope: { routes: [at('c1')] } } as never);
      return h;
    };
    // The host that checks c1 is away: what it checks is held (DL-7). A backend's deliver is not among that.
    const h1 = await scoped();
    expect(w.gw.host.outboundScope()).toMatchObject({ host: 'checker' });
    h1.close();
    await until(() => w.gw.host.hostPeer() === undefined);
    expect(w.gw.host.outboundScope()).toMatchObject({ host: 'checker' });
    expect((await say(a.c, 'away', at('c1'))).value).toMatchObject({ status: 'delivered', duplicate: false });
    // Back, and it would hold everything it is asked: it is not asked.
    await scoped();
    expect((await say(a.c, 'back', at('c1', { replyToMessageId: 'm1' }))).value).toMatchObject({ status: 'delivered', duplicate: false });
    expect(w.chat.sent.map((x) => x.op.operationId)).toEqual(['backend:alpha:away', 'backend:alpha:back']);
    expect(asked).toEqual([]);
    // Settled as the host's own messages are: kind host, in the backend's log.
    expect(w.gw.hub.log.read('host:backend:alpha', 0).filter((e) => e.body.t === 'delivery.settled').map((e) => e.body)).toMatchObject([
      { operationId: 'backend:alpha:away', result: 'delivered', kind: 'host' },
      { operationId: 'backend:alpha:back', result: 'delivered', kind: 'host' },
    ]);
  });

  // ---- rule tags (RT-1) --------------------------------------------------------

  it("a backend's pushed item carries the tag of the rule that routed it, and explain shows the tag on the matched rule #RT-1 #EX-1 #PB-1", async () => {
    const raw = {
      backends: { alpha: {}, beta: {} },
      bindings: [
        { id: 'alpha-inbox', match: { channel: 'fake', keywords: ['alpha'] }, on: 'host', to: 'alpha', tag: 'inbox' },
        { id: 'beta-guest', match: { channel: 'fake', keywords: ['beta'] }, on: 'host', to: 'beta', tag: 'guest' },
        { id: 'beta-plain', match: { channel: 'fake', keywords: ['untagged'] }, on: 'host', to: 'beta' },
      ],
    };
    const w = await daemon({ raw });
    const a = await w.backend('alpha', { consumer: 'alpha' });
    const b = await w.backend('beta', { consumer: 'beta' });
    const [toAlpha, toBeta] = [pushed(a.c), pushed(b.c)];
    const both = await w.chat.inject({ id: 'm1', sender: alice, text: 'for alpha and beta' });
    await w.chat.inject({ id: 'm2', sender: alice, text: 'untagged' });
    await until(() => toAlpha.length === 1 && toBeta.length === 2);
    expect(toAlpha.map((x) => [x.envelope.id, x.bindingId, x.to, x.tag])).toEqual([['m1', 'alpha-inbox', 'alpha', 'inbox']]);
    expect(toBeta.map((x) => [x.envelope.id, x.bindingId, x.to, x.tag])).toEqual([['m1', 'beta-guest', 'beta', 'guest'], ['m2', 'beta-plain', 'beta', undefined]]);
    expect('tag' in toBeta[1]!).toBe(false);
    // Pulled, the same.
    expect((await a.c.inboundRead({ consumer: 'alpha', after: 0, waitMs: 0 })).items.map((x) => x.tag)).toEqual(['inbox']);
    const h = await w.host({ name: 'admin' });
    const ex = await h.explain(both.inputId!);
    expect((ex as { matched: { bindingId: string; to?: string; tag?: string }[] }).matched.map((m) => [m.bindingId, m.to, m.tag])).toEqual([['alpha-inbox', 'alpha', 'inbox'], ['beta-guest', 'beta', 'guest']]);
  });

  // ---- media (PB-6) -------------------------------------------------------------

  const refOf = (bytes: Uint8Array) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');
  const image = (ref: string, name?: string): ContentBlock => ({ type: 'image', ref, mime: 'image/png', ...(name !== undefined ? { name } : {}) });
  /** A message with media, routed by its text. */
  const withMedia = (w: { chat: FakeChannel }, id: string, text: string, conversation: string, ...media: ContentBlock[]) =>
    w.chat.inject({ id, sender: alice, conversation: { id: conversation, kind: 'group' }, content: [{ type: 'text', text }, ...media] });
  const uploads = (w: { config: { blobs: { dir: string } } }, backend: string) => {
    const dir = join(w.config.blobs.dir, 'uploads', backend);
    return existsSync(dir) ? readdirSync(dir).sort() : [];
  };
  const NOT_FOUND = { ok: false, error: { code: 'not_found', message: 'no such blob' } };
  const UNKNOWN_BLOB = { ok: false, error: { code: 'unknown_blob', message: 'an attachment is not a blob this backend uploaded or was given' } };
  const DAY = 24 * 3_600_000;

  it("a backend reads the media of the items routed to it, whole or in ranges, and nothing else: a ref of another backend's item, of a message that went to a session only, of a history.read answer, a hash of bytes the store holds and a ref nothing holds all answer alike (stat null, get not_found, one text); the answers carry no stored name or mime #PB-6 #PB-1", async () => {
    const raw = { ...two({ beta: { history: true } }) };
    raw.bindings.push({ id: 'to-session', match: { channel: 'fake', keywords: ['session'] }, on: 'dispatch' } as never);
    const w = await daemon({ raw });
    const big = randomBytes(2 * BLOB_FRAME_MAX_BYTES + 12_345);
    const small = Buffer.from('a small picture');
    const put = (bytes: Uint8Array, name: string) => w.gw.blobs.put(bytes, { mime: 'image/png', name });
    const [refBig, refSmall] = [await put(big, 'secret-big.png'), await put(small, 'secret-small.png')];
    const refBeta = await put(Buffer.from('only in an item of beta'), 'secret-beta.png');
    const refSession = await put(Buffer.from('only in a session'), 'secret-session.png');
    const refHistory = await put(Buffer.from('only in an earlier message'), 'secret-history.png');
    const refStored = await put(Buffer.from('stored, in no message at all'), 'secret-stored.png');
    await withMedia(w, 'in-a', 'for alpha', 'c1', image(refBig, 'big.png'), { type: 'file', ref: refSmall, mime: 'image/png', name: 'small.png' });
    await withMedia(w, 'in-b', 'for beta', 'c2', image(refBeta));
    await withMedia(w, 'in-s', 'a session one', 'c3', image(refSession));
    await until(() => w.gw.hostQueue.head() === 2);
    w.chat.historyAnswer = [fakeEnvelope({ id: 'h1', conversation: { id: 'c2', kind: 'group' }, content: [image(refHistory)] })];
    const a = await w.backend('alpha');
    const b = await w.backend('beta');

    // Whole: a blob that fits a frame. Size only from stat; bytes, the whole size and the offset from get.
    expect(await a.c.blobStat(refSmall)).toEqual({ size: small.byteLength });
    expect(await a.c.blobGet({ ref: refSmall })).toEqual({ base64: b64(small), size: small.byteLength, offset: 0 });
    // A larger one: not silently cut short without a range; in ranges, at most a frame's worth each.
    expect(await a.c.blobStat(refBig)).toEqual({ size: big.byteLength });
    await expect(a.c.blobGet({ ref: refBig })).rejects.toMatchObject({ code: 'too_large' });
    expect(await a.c.blobGet({ ref: refBig, offset: 1000, length: 10 })).toEqual({ base64: b64(big.subarray(1000, 1010)), size: big.byteLength, offset: 1000 });
    const rest = await a.c.blobGet({ ref: refBig, offset: 5 });
    expect(Buffer.from(rest.base64, 'base64').equals(big.subarray(5, 5 + BLOB_FRAME_MAX_BYTES))).toBe(true);
    const tail = await a.c.blobGet({ ref: refBig, offset: big.byteLength - 3, length: 100 });
    expect(tail).toEqual({ base64: b64(big.subarray(big.byteLength - 3)), size: big.byteLength, offset: big.byteLength - 3 });
    expect(await a.c.blobGet({ ref: refBig, offset: big.byteLength })).toEqual({ base64: '', size: big.byteLength, offset: big.byteLength });
    await expect(a.c.blobGet({ ref: refBig, offset: big.byteLength + 1 })).rejects.toMatchObject({ code: 'bad_offset' });
    expect(Buffer.from(await a.c.readBlob(refBig)).equals(big)).toBe(true);
    expect(Buffer.from(await a.c.readBlob(refBig, { chunk: 300_000 })).equals(big)).toBe(true);
    // The schema bounds a range before the daemon reads anything.
    expect(await a.c.exchange({ type: 'blob.get', ref: refBig, length: BLOB_FRAME_MAX_BYTES + 1 })).toMatchObject({ ok: false, error: { code: 'invalid_frame' } });

    // beta sees a ref in a history.read answer; that gives it no bytes.
    const cursorB = (await b.c.inboundRead({ consumer: 'beta', waitMs: 0 })).items[0]!.cursor;
    expect((await b.c.historyRead({ cursor: cursorB, scope: 'chat' })).messages.map((m) => m.content)).toEqual([[image(refHistory)]]);

    // Everything else answers as a ref nothing holds, and the shared store is not even asked.
    const stat = vi.spyOn(w.gw.blobs, 'stat');
    const get = vi.spyOn(w.gw.blobs, 'get');
    const nothing = `sha256:${'0'.repeat(64)}`;
    const denied: [LocalClient, string][] = [
      [a.c, refBeta], [a.c, refSession], [a.c, refHistory], [a.c, refStored], [a.c, nothing], [a.c, 'platform-file:abc'], [a.c, ''],
      [b.c, refBig], [b.c, refSmall], [b.c, refSession], [b.c, refHistory], [b.c, refStored], [b.c, nothing],
    ];
    const answers = new Set<string>();
    for (const [c, ref] of denied) {
      expect(await c.blobStat(ref)).toBeNull();
      for (const range of [{}, { offset: 0, length: 1 }, { offset: 10 ** 9 }]) {
        const r = await c.exchange({ type: 'blob.get', ref, ...range });
        expect(r).toMatchObject(NOT_FOUND);
        answers.add(JSON.stringify({ ok: r.ok, error: r.error }));
      }
    }
    expect([...answers]).toEqual([JSON.stringify(NOT_FOUND)]);
    expect(stat).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
    stat.mockRestore();
    get.mockRestore();
    // beta's own item's media is beta's.
    expect(await b.c.blobStat(refBeta)).toEqual({ size: 23 });

    // No stored name or mime in any answer.
    const seen = JSON.stringify([await a.c.blobStat(refSmall), await a.c.blobGet({ ref: refSmall }), await a.c.blobGet({ ref: refBig, offset: 0, length: 16 })]);
    expect(seen).not.toMatch(/secret|png|mime|name|path/);
    expect(Object.keys((await a.c.blobStat(refSmall))!)).toEqual(['size']);
  });

  it('a backend uploads bytes in one frame or in parts and reads them back; another backend gets not_found for that ref even with the hash, until it uploads the same bytes itself; a wrong offset says the offset expected and a restarted upload replaces the old one #PB-6', async () => {
    const w = await daemon({ raw: two() });
    const a = await w.backend('alpha');
    const b = await w.backend('beta');
    // One frame.
    const one = Buffer.from('one frame of bytes');
    const up = await a.c.blobPut({ base64: b64(one), mime: 'text/plain', name: 'note.txt' });
    expect(up).toEqual({ ref: refOf(one), size: one.byteLength });
    expect(await a.c.blobStat(refOf(one))).toEqual({ size: one.byteLength });
    expect(Buffer.from(await a.c.readBlob(refOf(one))).equals(one)).toBe(true);
    // Staged for alpha alone (0700 / 0600), not in the shared content-addressed store.
    expect(await w.gw.blobs.stat(refOf(one))).toBeUndefined();
    expect(uploads(w, 'alpha')).toEqual([refOf(one).slice(7)]);
    const dir = join(w.config.blobs.dir, 'uploads', 'alpha');
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, refOf(one).slice(7))).mode & 0o777).toBe(0o600);

    // In parts: more than a frame holds.
    const big = randomBytes(2 * BLOB_FRAME_MAX_BYTES + 777);
    expect(await a.c.writeBlob(big)).toEqual({ ref: refOf(big), size: big.byteLength });
    expect(Buffer.from(await a.c.readBlob(refOf(big))).equals(big)).toBe(true);
    expect(await w.gw.blobs.stat(refOf(big))).toBeUndefined();

    // beta has the hash (the ref is the SHA-256 of the bytes) and gets nothing for it.
    for (const ref of [refOf(one), refOf(big)]) {
      expect(await b.c.blobStat(ref)).toBeNull();
      expect(await b.c.exchange({ type: 'blob.get', ref })).toMatchObject(NOT_FOUND);
      expect(await b.c.exchange({ type: 'blob.get', ref, offset: 0, length: 4 })).toMatchObject(NOT_FOUND);
    }
    expect(uploads(w, 'beta')).toEqual([]);
    // Once it uploaded the same bytes itself it reads its own copy; alpha's is another file.
    expect(await b.c.blobPut({ base64: b64(one) })).toEqual({ ref: refOf(one), size: one.byteLength });
    expect(Buffer.from(await b.c.readBlob(refOf(one))).equals(one)).toBe(true);
    expect(uploads(w, 'beta')).toEqual([refOf(one).slice(7)]);
    expect(await b.c.blobStat(refOf(big))).toBeNull();

    // A part must start where the upload stands: the answer says where, and what arrived is kept.
    const part = (c: LocalClient, upload: string, offset: number, bytes: string, last = false) => c.exchange({ type: 'blob.put', base64: b64(Buffer.from(bytes)), part: { upload, offset, ...(last ? { last } : {}) } });
    expect((await part(a.c, 'u1', 0, '0123456789')).value).toEqual({ upload: 'u1', received: 10 });
    expect(await part(a.c, 'u1', 5, 'xxxxx')).toMatchObject({ ok: false, error: { code: 'bad_offset', message: 'expected offset 10' } });
    expect(await part(a.c, 'u1', 11, 'x')).toMatchObject({ ok: false, error: { code: 'bad_offset', message: 'expected offset 10' } });
    expect((await part(a.c, 'u1', 10, 'abc', true)).value).toEqual({ ref: refOf(Buffer.from('0123456789abc')), size: 13 });
    // Finished: the upload id is free again, and continuing it finds nothing.
    expect(await part(a.c, 'u1', 13, 'x')).toMatchObject({ ok: false, error: { code: 'bad_offset', message: 'expected offset 0' } });
    expect(await part(a.c, 'never-started', 4, 'x')).toMatchObject({ ok: false, error: { code: 'bad_offset', message: 'expected offset 0' } });
    // An upload is its backend's: beta cannot continue alpha's under the same id.
    expect((await part(a.c, 'shared-id', 0, 'AAAA')).value).toEqual({ upload: 'shared-id', received: 4 });
    expect(await part(b.c, 'shared-id', 4, 'BBBB', true)).toMatchObject({ ok: false, error: { code: 'bad_offset', message: 'expected offset 0' } });
    // Offset 0 again starts it over: the old bytes are gone.
    expect((await part(a.c, 'shared-id', 0, 'CC')).value).toEqual({ upload: 'shared-id', received: 2 });
    expect((await part(a.c, 'shared-id', 2, 'DD', true)).value).toEqual({ ref: refOf(Buffer.from('CCDD')), size: 4 });
    expect(await a.c.blobStat(refOf(Buffer.from('AAAADD')))).toBeNull();
    // Not base64, and nothing at all, are not uploads.
    for (const base64 of ['***=', 'abc', 'ab=c', 'YQ==YQ==', '']) expect(await a.c.exchange({ type: 'blob.put', base64 })).toMatchObject({ ok: false, error: { code: 'invalid_frame' } });
    expect(await part(a.c, 'empty', 0, '', true)).toMatchObject({ ok: false, error: { code: 'invalid_frame' } });
    expect(await part(a.c, 'empty', 0, '')).toMatchObject({ ok: false, error: { code: 'invalid_frame' } });
    expect(uploads(w, 'alpha').filter((n) => !/^[0-9a-f]{64}$/.test(n))).toEqual([]);
  });

  it('uploads are bounded and cleaned up: a frame over 1 MiB, a blob over blobs.maxBytes, more staged bytes or files than the quota, a third unfinished upload are refused and leave nothing; a staged upload is gone after 24 h (its file deleted, not readable); an unfinished one after 5 idle minutes; rotation drops unfinished ones; staged uploads and media grants survive a restart #PB-6 #RS-1', async () => {
    const skew = { ms: 0 };
    const MAX = 2_000_000;
    const raw = { ...two(), blobs: { maxBytes: MAX } };
    const gateway = { hostBlobs: { now: () => Date.now() + skew.ms, quotaBytes: 5000, maxFiles: 4 } };
    const w = await daemon({ raw, gateway });
    let a = await w.backend('alpha');
    const put = (c: LocalClient, bytes: Uint8Array) => c.exchange({ type: 'blob.put', base64: b64(bytes) });
    const part = (c: LocalClient, upload: string, offset: number, bytes: Uint8Array, last = false) => c.exchange({ type: 'blob.put', base64: b64(bytes), part: { upload, offset, ...(last ? { last } : {}) } });
    const fill = (n: number, seed: number) => Buffer.alloc(n, seed);

    // A frame carries at most 1 MiB, alone or as a part.
    const over = fill(BLOB_FRAME_MAX_BYTES + 1, 1);
    expect(await put(a.c, over)).toMatchObject({ ok: false, error: { code: 'too_large' } });
    expect(await part(a.c, 'p0', 0, over)).toMatchObject({ ok: false, error: { code: 'too_large' } });
    // A blob is at most blobs.maxBytes, however it is cut: the upload that went over is dropped whole.
    const mib = fill(BLOB_FRAME_MAX_BYTES, 2);
    expect((await part(a.c, 'p1', 0, mib)).value).toEqual({ upload: 'p1', received: BLOB_FRAME_MAX_BYTES });
    expect(await part(a.c, 'p1', BLOB_FRAME_MAX_BYTES, mib)).toMatchObject({ ok: false, error: { code: 'too_large' } });
    expect(await part(a.c, 'p1', BLOB_FRAME_MAX_BYTES, fill(1, 2), true)).toMatchObject({ ok: false, error: { code: 'bad_offset', message: 'expected offset 0' } });
    expect(uploads(w, 'alpha')).toEqual([]);

    // The quota: bytes (5000 here), then files (4 here). What is refused leaves nothing, not even a temporary file.
    const [x1, x2, x3] = [fill(2000, 11), fill(2000, 12), fill(2000, 13)];
    expect((await put(a.c, x1)).value).toEqual({ ref: refOf(x1), size: 2000 });
    expect((await put(a.c, x2)).value).toEqual({ ref: refOf(x2), size: 2000 });
    expect(await put(a.c, x3)).toMatchObject({ ok: false, error: { code: 'quota_exceeded' } });
    expect(await a.c.blobStat(refOf(x3))).toBeNull();
    // The same bytes again count once.
    expect((await put(a.c, x1)).value).toEqual({ ref: refOf(x1), size: 2000 });
    expect((await put(a.c, fill(1, 21))).ok).toBe(true);
    expect((await put(a.c, fill(1, 22))).ok).toBe(true);
    expect(await put(a.c, fill(1, 23))).toMatchObject({ ok: false, error: { code: 'quota_exceeded' } });
    expect(uploads(w, 'alpha')).toEqual([refOf(x1), refOf(x2), refOf(fill(1, 21)), refOf(fill(1, 22))].map((r) => r.slice(7)).sort());
    // The quota is per backend: beta's is untouched by alpha's being full.
    const b = await w.backend('beta');
    expect((await put(b.c, x3)).value).toEqual({ ref: refOf(x3), size: 2000 });
    expect(await a.c.blobStat(refOf(x3))).toBeNull();

    // At most two unfinished uploads; finishing (or restarting) one of them is not a third.
    expect((await part(b.c, 'u1', 0, fill(3, 1))).ok).toBe(true);
    expect((await part(b.c, 'u2', 0, fill(3, 2))).ok).toBe(true);
    expect(await part(b.c, 'u3', 0, fill(3, 3))).toMatchObject({ ok: false, error: { code: 'busy' } });
    expect((await part(b.c, 'u2', 0, fill(3, 4))).value).toEqual({ upload: 'u2', received: 3 });
    expect((await part(b.c, 'u1', 3, fill(1, 1), true)).value).toMatchObject({ size: 4 });
    expect((await part(b.c, 'u3', 0, fill(3, 3))).value).toEqual({ upload: 'u3', received: 3 });
    // Unfinished uploads are per backend too: alpha's two are its own.
    expect((await part(a.c, 'u1', 0, fill(3, 1))).ok).toBe(true);

    // Rotation: an upload the old key left unfinished is not the new key's to continue.
    a = await w.backend('alpha');
    expect(await part(a.c, 'u1', 3, fill(1, 1), true)).toMatchObject({ ok: false, error: { code: 'bad_offset', message: 'expected offset 0' } });
    // What was staged is still the backend's (state goes with the id).
    expect(await a.c.blobStat(refOf(x1))).toEqual({ size: 2000 });

    // An unfinished upload is dropped after 5 idle minutes; one that got a part in time is not.
    expect((await part(a.c, 'idle', 0, fill(3, 5))).ok).toBe(true);
    skew.ms += 4 * 60_000;
    expect((await part(a.c, 'idle', 3, fill(3, 5))).value).toEqual({ upload: 'idle', received: 6 });
    skew.ms += 4 * 60_000;
    expect((await part(a.c, 'idle', 6, fill(3, 5))).value).toEqual({ upload: 'idle', received: 9 });
    skew.ms += 5 * 60_000 + 1000;
    expect(await part(a.c, 'idle', 9, fill(1, 5), true)).toMatchObject({ ok: false, error: { code: 'bad_offset', message: 'expected offset 0' } });

    // A restart keeps staged uploads and the media grants of queued items.
    const granted = await w.gw.blobs.put(Buffer.from('a picture for alpha'), { mime: 'image/png' });
    await withMedia(w, 'in-a', 'for alpha', 'c1', image(granted));
    await until(() => w.gw.hostQueue.head() === 1);
    expect(await a.c.blobStat(granted)).toEqual({ size: 19 });
    await w.stop();
    const again = await daemon({ raw, gateway, dir: w.dir });
    const a2 = await again.backend('alpha', { key: a.key });
    expect(await a2.c.blobStat(refOf(x1))).toEqual({ size: 2000 });
    expect(Buffer.from(await a2.c.readBlob(refOf(x2))).equals(x2)).toBe(true);
    expect(Buffer.from(await a2.c.readBlob(granted)).toString()).toBe('a picture for alpha');
    // Unfinished uploads were in memory.
    const b2 = await again.backend('beta');
    expect(await part(b2.c, 'u2', 3, fill(1, 4), true)).toMatchObject({ ok: false, error: { code: 'bad_offset', message: 'expected offset 0' } });

    // 24 h after the upload: not readable, and the file is deleted (on the read, or by the sweep).
    skew.ms += DAY - 20 * 60_000;
    expect(await a2.c.blobStat(refOf(x1))).toEqual({ size: 2000 });
    skew.ms += 30 * 60_000;
    expect(await a2.c.blobStat(refOf(x1))).toBeNull();
    expect(await a2.c.exchange({ type: 'blob.get', ref: refOf(x1) })).toMatchObject(NOT_FOUND);
    expect(uploads(again, 'alpha')).not.toContain(refOf(x1).slice(7));
    expect(uploads(again, 'alpha')).toContain(refOf(x2).slice(7));
    expect(uploads(again, 'beta').length).toBeGreaterThan(0);
    await again.gw.hostBlobs.sweep();
    expect(uploads(again, 'alpha')).toEqual([]);
    expect(uploads(again, 'beta')).toEqual([]);
    expect(await a2.c.blobStat(refOf(x2))).toBeNull();
    // The quota is free again; a grant (30 days) is not an upload and is still there.
    expect((await put(a2.c, x3)).value).toEqual({ ref: refOf(x3), size: 2000 });
    expect(await a2.c.blobStat(granted)).toEqual({ size: 19 });
  });

  it('with the host token blob.stat and blob.get read any stored blob and blob.put stores one in the shared store; hello advertises blobs; a deployment without backends answers the same #PB-6', async () => {
    const run = async (raw: Record<string, unknown> | undefined) => {
      const w = await daemon(raw ? { raw } : {});
      const h = await w.client();
      const hello = await h.hello({ token: w.gw.token, name: 'admin' });
      const bytes = Buffer.from('a stored picture');
      const ref = await w.gw.blobs.put(bytes, { mime: 'image/png', name: 'kept-name.png' });
      const big = Buffer.alloc(2 * BLOB_FRAME_MAX_BYTES + 5, 7);
      const out: unknown[] = [hello.features.filter((f) => f === 'blobs' || f === 'binding.tag')];
      // Any blob of the shared store, in no item at all; bytes and sizes only.
      out.push(await h.blobStat(ref), await h.blobGet({ ref }), await h.blobGet({ ref, offset: 2, length: 6 }));
      out.push(await h.blobStat(`sha256:${'0'.repeat(64)}`), await h.blobStat('not-a-ref'));
      out.push((await h.exchange({ type: 'blob.get', ref: `sha256:${'0'.repeat(64)}` })).error);
      // Uploads go to the shared store, with the mime and name given (or the default mime); nothing is staged.
      const text = Buffer.from('a note from the host');
      out.push(await h.blobPut({ base64: b64(text), mime: 'text/plain', name: 'note.txt' }));
      const stored = await w.gw.blobs.get(refOf(text));
      out.push([Buffer.from(stored.bytes).toString(), stored.mime, stored.name]);
      out.push(await h.blobPut({ base64: b64(Buffer.from('untyped')) }));
      out.push((await w.gw.blobs.get(refOf(Buffer.from('untyped')))).mime);
      out.push(await h.writeBlob(big, { mime: 'application/pdf', name: 'big.pdf' }));
      out.push(Buffer.from(await h.readBlob(refOf(big))).equals(big), (await w.gw.blobs.stat(refOf(big)))?.mime);
      out.push((await h.exchange({ type: 'blob.get', ref: refOf(big) })).error?.code);
      out.push((await h.exchange({ type: 'blob.put', base64: b64(Buffer.alloc(BLOB_FRAME_MAX_BYTES + 1)) })).error?.code);
      out.push(existsSync(join(w.config.blobs.dir, 'uploads')));
      return { w, h, out };
    };
    const plain = await run(undefined);
    const bytes = Buffer.from('a stored picture');
    const big = Buffer.alloc(2 * BLOB_FRAME_MAX_BYTES + 5, 7);
    expect(plain.out).toEqual([
      ['binding.tag', 'blobs'],
      { size: bytes.byteLength },
      { base64: b64(bytes), size: bytes.byteLength, offset: 0 },
      { base64: b64(bytes.subarray(2, 8)), size: bytes.byteLength, offset: 2 },
      null,
      null,
      { code: 'not_found', message: 'no such blob' },
      { ref: refOf(Buffer.from('a note from the host')), size: 20 },
      ['a note from the host', 'text/plain', 'note.txt'],
      { ref: refOf(Buffer.from('untyped')), size: 7 },
      'application/octet-stream',
      { ref: refOf(big), size: big.byteLength },
      true,
      'application/pdf',
      'too_large',
      'too_large',
      false,
    ]);
    // With backends configured the host token's answers are the same.
    const withBackends = await run(two());
    expect(withBackends.out).toEqual(plain.out);
    // A backend's staged upload is not in the shared store: the host token reads the store, not the staging area.
    const a = await withBackends.w.backend('alpha');
    const mine = Buffer.from('staged by alpha');
    await a.c.blobPut({ base64: b64(mine) });
    expect(await withBackends.h.blobStat(refOf(mine))).toBeNull();
    // And what the host token stored is no backend's to read.
    expect(await a.c.blobStat(refOf(Buffer.from('a note from the host')))).toBeNull();
  });

  /** A channel that reads each attachment from the daemon's blob store when it sends, as a real adapter does. */
  class ReadsAttachments extends FakeChannel {
    store?: { get(ref: string): Promise<{ bytes: Uint8Array; mime: string; name?: string }> };
    readonly read: { ref: string; bytes: string; name?: string }[] = [];
    private async load(msg: RenderedMessage): Promise<void> {
      for (const a of msg.attachments ?? []) {
        // A platform ref is not in the store: the platform has it.
        if (!a.ref.startsWith('sha256:')) continue;
        const b = await this.store!.get(a.ref);
        this.read.push({ ref: a.ref, bytes: Buffer.from(b.bytes).toString(), ...(b.name !== undefined ? { name: b.name } : {}) });
      }
    }
    override async send(route: ReplyRoute, msg: RenderedMessage, op: SendOp) {
      await this.load(msg);
      return super.send(route, msg, op);
    }
    override async edit(route: ReplyRoute, id: string, msg: RenderedMessage) {
      await this.load(msg);
      return super.edit(route, id, msg);
    }
  }
  const reading = async (o: Parameters<typeof daemon>[0] = {}) => {
    const chat = new ReadsAttachments('fake');
    const w = await daemon({ ...o, chat });
    chat.store = w.gw.blobs;
    return { w, chat };
  };

  it("a backend attaches its own upload, or the media of an item routed to it, to deliver and deliver.update: the channel gets the attachment and the bytes are in the shared store; an attachment without a name goes out as file, never under the store's name #PB-6 #PB-2", async () => {
    const { w, chat } = await reading({ raw: two() });
    const given = await w.gw.blobs.put(Buffer.from('a picture someone sent'), { mime: 'image/png', name: 'secret-name.png' });
    await withMedia(w, 'in-a', 'for alpha', 'c1', image(given, 'theirs.png'));
    await until(() => w.gw.hostQueue.head() === 1);
    const a = await w.backend('alpha');

    // Its own upload: copied to the shared store before the channel sends, under the name the attachment gives.
    const report = Buffer.from('the report');
    const up = await a.c.writeBlob(report);
    expect(await w.gw.blobs.stat(up.ref)).toBeUndefined();
    const sent1 = await say(a.c, 'd1', at('c1'), { text: 'here', attachments: [{ ref: up.ref, mime: 'application/pdf', name: 'report.pdf' }] });
    expect(sent1.value).toMatchObject({ status: 'delivered', duplicate: false });
    expect(chat.sent[0]!.msg).toEqual({ text: 'here', attachments: [{ ref: up.ref, mime: 'application/pdf', name: 'report.pdf' }] });
    expect(chat.read).toEqual([{ ref: up.ref, bytes: 'the report', name: 'report.pdf' }]);
    expect(await w.gw.blobs.stat(up.ref)).toMatchObject({ mime: 'application/pdf', name: 'report.pdf', size: report.byteLength });

    // The media of its item, forwarded without a name: it goes out as `file`, not under the name the store has.
    expect((await say(a.c, 'd2', at('c1'), { text: 'back to you', attachments: [{ ref: given, mime: 'image/png' }] })).value).toMatchObject({ status: 'delivered' });
    expect(chat.sent[1]!.msg.attachments).toEqual([{ ref: given, mime: 'image/png', name: 'file' }]);
    // An upload without a name: the same, and the store keeps no name for it.
    const anon = await a.c.writeBlob(Buffer.from('no name given'));
    expect((await say(a.c, 'd3', at('c1'), { text: 'x', attachments: [{ ref: anon.ref, mime: 'text/plain' }, { ref: up.ref, mime: 'application/pdf', name: 'again.pdf' }] })).value).toMatchObject({ status: 'delivered' });
    expect(chat.sent[2]!.msg.attachments).toEqual([{ ref: anon.ref, mime: 'text/plain', name: 'file' }, { ref: up.ref, mime: 'application/pdf', name: 'again.pdf' }]);
    expect((await w.gw.blobs.get(anon.ref)).name).toBeUndefined();
    expect(JSON.stringify(chat.sent.map((x) => x.msg))).not.toContain('secret-name');

    // deliver.update: the same rule, for an edit and for the final one.
    const id = (sent1.value as { providerMessageId: string }).providerMessageId;
    const chart = await a.c.writeBlob(Buffer.from('a chart'));
    const update = (operationId: string, message: RenderedMessage, final = false) => a.c.exchange({ type: 'deliver.update', operationId, route: at('c1'), providerMessageId: id, message, sequence: 1, ...(final ? { final } : {}) });
    expect((await update('e1', { text: 'edited', attachments: [{ ref: chart.ref, mime: 'image/png' }] })).value).toMatchObject({ status: 'delivered' });
    expect((await update('e2', { text: 'final', attachments: [{ ref: given, mime: 'image/png', name: 'theirs.png' }] }, true)).value).toMatchObject({ status: 'delivered', duplicate: false });
    expect(chat.sent[0]!.edits).toEqual([
      { text: 'edited', attachments: [{ ref: chart.ref, mime: 'image/png', name: 'file' }] },
      { text: 'final', attachments: [{ ref: given, mime: 'image/png', name: 'theirs.png' }] },
    ]);
    expect(chat.read.at(-1)).toMatchObject({ ref: chart.ref, bytes: 'a chart' });
    // A message without attachments is untouched.
    expect((await say(a.c, 'd4', at('c1'), { text: 'plain' })).value).toMatchObject({ status: 'delivered' });
    expect(chat.sent[3]!.msg).toEqual({ text: 'plain' });
  });

  it("an attachment that is not the backend's is unknown_blob, the same answer as for a ref nothing holds: another backend's upload (also by its hash), another backend's item's media, a ref from history.read, a platform ref it was not given; nothing is sent and the operationId stays free; a host-token deliver with any ref is unchecked as before #PB-6 #PB-2", async () => {
    const { w, chat } = await reading({ raw: two({ alpha: { history: true } }) });
    const put = (text: string) => w.gw.blobs.put(Buffer.from(text), { mime: 'image/png', name: 'secret-name.png' });
    const [refA, refB, refHistory, refStored] = [await put('in an item of alpha'), await put('in an item of beta'), await put('in an earlier message'), await put('stored only')];
    // Both backends may send to c1; each got its own picture there.
    await withMedia(w, 'in-a', 'for alpha', 'c1', image(refA), image('platform-file:given'));
    await withMedia(w, 'in-b', 'for beta', 'c1', image(refB), image('platform-file:betas'));
    await until(() => w.gw.hostQueue.head() === 2);
    chat.historyAnswer = [fakeEnvelope({ id: 'h1', conversation: { id: 'c1', kind: 'group' }, content: [image(refHistory)] })];
    const a = await w.backend('alpha');
    const b = await w.backend('beta');
    const betas = Buffer.from('uploaded by beta');
    await b.c.writeBlob(betas);
    // alpha learns a ref from history.read.
    const cursorA = (await a.c.inboundRead({ consumer: 'alpha', waitMs: 0 })).items[0]!.cursor;
    expect((await a.c.historyRead({ cursor: cursorA, scope: 'chat' })).messages[0]!.content).toEqual([image(refHistory)]);
    const base = (await say(a.c, 'base', at('c1'))).value as { providerMessageId: string };
    const own = await a.c.writeBlob(Buffer.from('uploaded by alpha'));

    const nothing = `sha256:${'0'.repeat(64)}`;
    const notMine = [refOf(betas), refB, refHistory, refStored, 'platform-file:betas', 'platform-file:never', nothing, ''];
    const answers = new Set<string>();
    for (const [i, ref] of notMine.entries()) {
      const tries = [
        await say(a.c, `x${i}`, at('c1'), { text: 'hi', attachments: [{ ref, mime: 'image/png', name: 'n.png' }] }),
        // Among attachments that are its own: the whole message is refused.
        await say(a.c, `y${i}`, at('c1'), { text: 'hi', attachments: [{ ref: own.ref, mime: 'text/plain' }, { ref, mime: 'image/png' }, { ref: refA, mime: 'image/png' }] }),
        await a.c.exchange({ type: 'deliver.update', operationId: `u${i}`, route: at('c1'), providerMessageId: base.providerMessageId, message: { text: 'e', attachments: [{ ref, mime: 'image/png' }] }, sequence: 1 }),
        await a.c.exchange({ type: 'deliver.update', operationId: `f${i}`, route: at('c1'), providerMessageId: base.providerMessageId, message: { text: 'e', attachments: [{ ref, mime: 'image/png' }] }, sequence: 2, final: true }),
      ];
      for (const r of tries) {
        expect(r).toMatchObject(UNKNOWN_BLOB);
        answers.add(JSON.stringify({ ok: r.ok, error: r.error }));
      }
    }
    // One answer whether the blob exists somewhere or not; it names no ref.
    expect([...answers]).toEqual([JSON.stringify(UNKNOWN_BLOB)]);
    // Nothing went out, nothing was read for it, no operation id was used up, and its own upload was not copied for a refused message.
    expect(chat.sent.map((x) => x.op.operationId)).toEqual(['backend:alpha:base']);
    expect(chat.sent[0]!.edits).toEqual([]);
    expect(chat.read).toEqual([]);
    for (const i of notMine.keys()) for (const p of ['x', 'y', 'u', 'f']) expect(w.gw.outbox.get(`backend:alpha:${p}${i}`)).toBeUndefined();
    expect(await w.gw.blobs.stat(own.ref)).toBeUndefined();
    expect(await w.gw.blobs.stat(refOf(betas))).toBeUndefined();
    // The same ids send once the attachments are its own: a platform ref of its own item too.
    expect((await say(a.c, 'x0', at('c1'), { text: 'mine', attachments: [{ ref: own.ref, mime: 'text/plain', name: 'a.txt' }, { ref: refA, mime: 'image/png', name: 'a.png' }, { ref: 'platform-file:given', mime: 'image/png', name: 'p.png' }] })).value).toMatchObject({ status: 'delivered', duplicate: false });
    expect(chat.read.map((x) => x.bytes)).toEqual(['uploaded by alpha', 'in an item of alpha']);
    // The route check comes first: outside its conversations the answer is the route's, whatever is attached.
    expect(await say(a.c, 'z1', at('c-elsewhere'), { text: 'hi', attachments: [{ ref: own.ref, mime: 'text/plain' }] })).toMatchObject(REFUSED);
    expect(await say(a.c, 'z2', at('c-elsewhere'), { text: 'hi', attachments: [{ ref: nothing, mime: 'text/plain' }] })).toMatchObject(REFUSED);
    // beta may attach what alpha may not, and the other way round.
    expect((await say(b.c, 'b1', at('c1'), { text: 'beta', attachments: [{ ref: refOf(betas), mime: 'text/plain', name: 'b.txt' }, { ref: refB, mime: 'image/png', name: 'b.png' }] })).value).toMatchObject({ status: 'delivered' });
    expect(await say(b.c, 'b2', at('c1'), { text: 'beta', attachments: [{ ref: own.ref, mime: 'text/plain' }] })).toMatchObject(UNKNOWN_BLOB);
    expect(await say(b.c, 'b3', at('c1'), { text: 'beta', attachments: [{ ref: refA, mime: 'image/png' }] })).toMatchObject(UNKNOWN_BLOB);

    // The host token's deliver is as it was: any ref, no name added, no check.
    const plain = new FakeChannel('fake');
    const w2 = await daemon({ raw: two(), chat: plain });
    const h = await w2.host({ name: 'admin' });
    const msg = { text: 'from the host', attachments: [{ ref: nothing, mime: 'image/png' }, { ref: 'platform-file:any', mime: 'image/png' }] };
    expect(await h.deliver({ operationId: 'h1', route: at('c-any'), message: msg })).toMatchObject({ status: 'delivered', duplicate: false });
    expect(plain.sent[0]!.msg).toEqual(msg);
  });

  it('an upload delivered before its TTL stays deliverable by the outbox after the staged copy is gone; after the TTL the ref is unknown_blob for a new deliver #PB-6', async () => {
    const skew = { ms: 0 };
    const { w, chat } = await reading({ raw: two(), gateway: { hostBlobs: { now: () => Date.now() + skew.ms } } });
    await w.chat.inject({ id: 'in-a', sender: alice, text: 'for alpha', conversation: { id: 'c1', kind: 'group' } });
    await until(() => w.gw.hostQueue.head() === 1);
    const a = await w.backend('alpha');
    const bytes = Buffer.from('sent in time');
    const up = await a.c.writeBlob(bytes);
    const later = await a.c.writeBlob(Buffer.from('never sent'));
    const message = { text: 'here', attachments: [{ ref: up.ref, mime: 'text/plain', name: 'a.txt' }] };
    const first = await say(a.c, 'd1', at('c1'), message);
    expect(first.value).toMatchObject({ status: 'delivered', duplicate: false });
    const id = (first.value as { providerMessageId: string }).providerMessageId;
    const fin = () => a.c.exchange({ type: 'deliver.update', operationId: 'f1', route: at('c1'), providerMessageId: id, message, sequence: 1, final: true });
    expect((await fin()).value).toMatchObject({ status: 'delivered', duplicate: false });

    skew.ms += DAY + 60_000;
    await w.gw.hostBlobs.sweep();
    expect(uploads(w, 'alpha')).toEqual([]);
    // What was sent is in the shared store, where the outbox's channel reads it (a retry, a restart): still there.
    expect(Buffer.from((await w.gw.blobs.get(up.ref)).bytes).toString()).toBe('sent in time');
    // The same operations again are answered as the first time, not judged again.
    expect((await say(a.c, 'd1', at('c1'), message)).value).toMatchObject({ status: 'delivered', duplicate: true });
    expect((await fin()).value).toMatchObject({ status: 'delivered', duplicate: true });
    // A new deliver: the upload expired, so the ref is no longer its own, sent before or not.
    expect(await say(a.c, 'd2', at('c1'), message)).toMatchObject(UNKNOWN_BLOB);
    expect(await say(a.c, 'd3', at('c1'), { text: 'x', attachments: [{ ref: later.ref, mime: 'text/plain' }] })).toMatchObject(UNKNOWN_BLOB);
    expect(await a.c.blobStat(up.ref)).toBeNull();
    expect(await w.gw.blobs.stat(later.ref)).toBeUndefined();
    expect(chat.sent).toHaveLength(1);
    // Uploaded again, it is its own again.
    await a.c.writeBlob(bytes);
    expect((await say(a.c, 'd2', at('c1'), message)).value).toMatchObject({ status: 'delivered', duplicate: false });
  });

  it("a send that is refused or cannot be made copies nothing to the shared store: a deliver.update on a channel that cannot edit answers unsupported and the backend's upload stays staged only; a message with more than 32 attachments is too_many_attachments after the route check, nothing sent, the operationId free; one upload named 32 times goes out as 32 attachments #PB-6 #PB-2 #DL-8", async () => {
    const { w, chat } = await reading({ raw: two() });
    await w.chat.inject({ id: 'in-a', sender: alice, text: 'for alpha', conversation: { id: 'c1', kind: 'group' } });
    await until(() => w.gw.hostQueue.head() === 1);
    const a = await w.backend('alpha');
    const base = (await say(a.c, 'base', at('c1'))).value as { providerMessageId: string };
    const own = await a.c.writeBlob(Buffer.from('never shown to anyone'));
    const attached = { text: 'e', attachments: [{ ref: own.ref, mime: 'text/plain', name: 'a.txt' }] };
    const update = (operationId: string, final = false) => a.c.exchange({ type: 'deliver.update', operationId, route: at('c1'), providerMessageId: base.providerMessageId, message: attached, sequence: 1, ...(final ? { final } : {}) });

    // This channel cannot edit: nothing can come of the update, so nothing is copied for it.
    const edit = chat.edit;
    (chat as { edit?: unknown }).edit = undefined;
    expect(await update('u1')).toMatchObject({ ok: false, error: { code: 'unsupported' } });
    expect(await update('u2', true)).toMatchObject({ ok: false, error: { code: 'unsupported' } });
    expect(await w.gw.blobs.stat(own.ref)).toBeUndefined();
    expect(chat.read).toEqual([]);
    // An attachment that is not its own is answered the same there: the channel's answer comes first.
    expect(await a.c.exchange({ type: 'deliver.update', operationId: 'u3', route: at('c1'), providerMessageId: base.providerMessageId, message: { text: 'e', attachments: [{ ref: `sha256:${'0'.repeat(64)}`, mime: 'text/plain' }] }, sequence: 1 })).toMatchObject({ ok: false, error: { code: 'unsupported' } });
    // With a channel that edits, the same update goes through and only then are the bytes in the shared store.
    chat.edit = edit;
    expect((await update('u1')).value).toMatchObject({ status: 'delivered' });
    expect(await w.gw.blobs.stat(own.ref)).toMatchObject({ size: 21 });

    // More attachments than a message may carry: refused whole, before any is looked at.
    const other = await a.c.writeBlob(Buffer.from('named many times'));
    const many = (n: number, ref: string) => ({ text: 'many', attachments: Array.from({ length: n }, (_, i) => ({ ref, mime: 'text/plain', name: `${i}.txt` })) });
    const TOO_MANY = { ok: false, error: { code: 'too_many_attachments', message: 'a message carries at most 32 attachments' } };
    expect(await say(a.c, 'm1', at('c1'), many(33, other.ref))).toMatchObject(TOO_MANY);
    expect(await say(a.c, 'm2', at('c1'), many(5000, 'not-a-ref'))).toMatchObject(TOO_MANY);
    expect(await a.c.exchange({ type: 'deliver.update', operationId: 'm3', route: at('c1'), providerMessageId: base.providerMessageId, message: many(33, other.ref), sequence: 2 })).toMatchObject(TOO_MANY);
    expect(await w.gw.blobs.stat(other.ref)).toBeUndefined();
    expect(chat.sent.map((x) => x.op.operationId)).toEqual(['backend:alpha:base']);
    for (const id of ['m1', 'm2', 'm3']) expect(w.gw.outbox.get(`backend:alpha:${id}`)).toBeUndefined();
    // The route check still comes first.
    expect(await say(a.c, 'm4', at('c-elsewhere'), many(33, other.ref))).toMatchObject(REFUSED);
    // At the limit it goes out, every entry as written; the upload was copied for it.
    expect((await say(a.c, 'm1', at('c1'), many(32, other.ref))).value).toMatchObject({ status: 'delivered', duplicate: false });
    expect(chat.sent[1]!.msg.attachments).toEqual(many(32, other.ref).attachments);
    expect(await w.gw.blobs.stat(other.ref)).toMatchObject({ size: 16 });
    // The host token's deliver has no such limit, as before.
    const h = await w.host({ name: 'admin' });
    expect(await h.deliver({ operationId: 'h1', route: at('c1'), message: many(40, 'platform-file:any') })).toMatchObject({ status: 'delivered' });
    expect(chat.sent[2]!.msg.attachments).toHaveLength(40);
  });

  it("the mime and name a backend gives an upload it attaches are provisional in the shared store: when the same bytes later arrive from a channel, or the host token stores them, the store has that writer's mime, name and extension; bytes the store already had keep theirs whatever the backend calls them #PB-6 #MD-1", async () => {
    const { w } = await reading({ raw: two() });
    await w.chat.inject({ id: 'in-a', sender: alice, text: 'for alpha', conversation: { id: 'c1', kind: 'group' } });
    await until(() => w.gw.hostQueue.head() === 1);
    const a = await w.backend('alpha');
    // alpha guesses the bytes of a picture others will handle, and sends them as a nameless binary.
    const logo = Buffer.from('the bytes of a well-known logo');
    const template = Buffer.from('the bytes of a standard template');
    for (const bytes of [logo, template]) {
      const up = await a.c.writeBlob(bytes);
      expect((await say(a.c, `d-${up.ref.slice(7, 15)}`, at('c1'), { text: 'x', attachments: [{ ref: up.ref, mime: 'application/octet-stream', name: 'invoice.exe' }] })).value).toMatchObject({ status: 'delivered' });
      expect(await w.gw.blobs.stat(up.ref)).toMatchObject({ mime: 'application/octet-stream', name: 'invoice.exe' });
    }
    // The picture arrives on a channel (the adapter stores inbound media with what the platform said).
    expect(await w.gw.blobs.put(logo, { mime: 'image/png', name: 'logo.png' })).toBe(refOf(logo));
    const stored = (await w.gw.blobs.stat(refOf(logo)))!;
    expect(stored).toMatchObject({ mime: 'image/png', name: 'logo.png', size: logo.byteLength });
    expect(stored.path.endsWith('.png')).toBe(true);
    // The host token stores the template: the same.
    const h = await w.host({ name: 'admin' });
    await h.blobPut({ base64: b64(template), mime: 'application/pdf', name: 'template.pdf' });
    expect(await w.gw.blobs.stat(refOf(template))).toMatchObject({ mime: 'application/pdf', name: 'template.pdf' });
    // alpha attaching them again changes nothing, and neither does it for bytes a channel stored first.
    const first = Buffer.from('stored by a channel first');
    await w.gw.blobs.put(first, { mime: 'image/jpeg', name: 'photo.jpg' });
    for (const bytes of [logo, template, first]) {
      const up = await a.c.writeBlob(bytes);
      expect((await say(a.c, `again-${up.ref.slice(7, 15)}`, at('c1'), { text: 'x', attachments: [{ ref: up.ref, mime: 'text/plain', name: 'mine.txt' }] })).value).toMatchObject({ status: 'delivered' });
    }
    expect(await w.gw.blobs.stat(refOf(logo))).toMatchObject({ mime: 'image/png', name: 'logo.png' });
    expect(await w.gw.blobs.stat(refOf(template))).toMatchObject({ mime: 'application/pdf', name: 'template.pdf' });
    expect(await w.gw.blobs.stat(refOf(first))).toMatchObject({ mime: 'image/jpeg', name: 'photo.jpg' });
  });

  it("what a backend chose reaches the log bounded and escaped: an attachment ref or a conversation id with line breaks, terminal escapes or a megabyte of text is one line with no control character; an ordinary ref and route are logged as they are #PB-6 #PB-2", async () => {
    const lines: string[] = [];
    const w = await daemon({ raw: two(), gateway: { logger: (level, msg) => void lines.push(`${level} ${msg}`) } });
    await w.chat.inject({ id: 'in-a', sender: alice, text: 'for alpha', conversation: { id: 'c1', kind: 'group' } });
    await until(() => w.gw.hostQueue.head() === 1);
    const a = await w.backend('alpha');
    const evil = 'x\n[aio] error: host token leaked\u001b[2J\u009b31m\u2028\u202e';
    const nothing = `sha256:${'0'.repeat(64)}`;
    const attach = (ref: string) => ({ text: 'hi', attachments: [{ ref, mime: 'a/b' }] });
    expect(await say(a.c, 'e1', at('c1'), attach(evil))).toMatchObject(UNKNOWN_BLOB);
    expect(await say(a.c, 'e2', at('c1'), attach('r'.repeat(1_000_000)))).toMatchObject(UNKNOWN_BLOB);
    expect(await say(a.c, 'e3', at(evil), { text: 'hi' })).toMatchObject(REFUSED);
    expect(await say(a.c, 'e4', at('c'.repeat(1_000_000)), { text: 'hi' })).toMatchObject(REFUSED);
    expect(await say(a.c, 'e5', at('c1'), attach(nothing))).toMatchObject(UNKNOWN_BLOB);
    expect(await say(a.c, 'e6', at('c-elsewhere'), { text: 'hi' })).toMatchObject(REFUSED);
    const refusals = lines.filter((l) => l.includes(' refused ('));
    expect(refusals).toHaveLength(6);
    for (const l of refusals) {
      expect(l).not.toMatch(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
      expect(l.length).toBeLessThan(700);
    }
    const escaped = '"x\\n[aio] error: host token leaked\\u001b[2J\\u{9b}31m\\u{2028}\\u{202e}"';
    expect(refusals[0]).toBe(`warn backend alpha: deliver to fake:default:c1 refused (attachment ${escaped}: neither its upload nor the media of an item routed to it)`);
    expect(refusals[1]).toContain(`refused (attachment "${'r'.repeat(200)}… (1000000 characters)": neither`);
    expect(refusals[2]).toContain(`deliver to "fake:default:${escaped.slice(1)} refused (`);
    expect(refusals[3]).toContain('… (1000013 characters)" refused (');
    // Plain text is not touched.
    expect(refusals[4]).toBe(`warn backend alpha: deliver to fake:default:c1 refused (attachment ${nothing}: neither its upload nor the media of an item routed to it)`);
    expect(refusals[5]).toBe('warn backend alpha: deliver to fake:default:c-elsewhere refused (the conversation is neither one it received input from nor registered for it)');
  });

  it("the default limits of a backend's staged uploads are 8 times blobs.maxBytes and 256 uploads; revoking its key drops its unfinished uploads at once, and a key issued afterwards starts them again #PB-6 #PB-3", async () => {
    // No override of the limits here: what the configuration alone gives.
    const w = await daemon({ raw: { ...two(), blobs: { maxBytes: 1000 } } });
    const a = await w.backend('alpha');
    const put = (c: LocalClient, bytes: Uint8Array) => c.exchange({ type: 'blob.put', base64: b64(bytes) });
    for (let i = 0; i < 8; i++) expect((await put(a.c, Buffer.alloc(1000, i))).value).toEqual({ ref: refOf(Buffer.alloc(1000, i)), size: 1000 });
    const full = { ok: false, error: { code: 'quota_exceeded', message: 'this backend has 8 upload(s) of 8000 bytes staged (at most 256 and 8000 bytes); they expire 24 h after their upload' } };
    expect(await put(a.c, Buffer.alloc(1000, 8))).toMatchObject(full);
    expect(await put(a.c, Buffer.from([1]))).toMatchObject(full);
    expect(uploads(w, 'alpha')).toHaveLength(8);
    // 256 uploads, of a byte each; the next one, whatever its size, is one too many.
    const b = await w.backend('beta');
    for (let i = 0; i < 256; i++) expect((await put(b.c, Buffer.from([i]))).ok).toBe(true);
    expect(await put(b.c, Buffer.from([0, 0]))).toMatchObject({ ok: false, error: { code: 'quota_exceeded', message: expect.stringContaining('this backend has 256 upload(s) of 256 bytes staged (at most 256 and 8000 bytes)') } });
    expect(uploads(w, 'beta')).toHaveLength(256);

    // Revocation: what the revoked key left unfinished is dropped with it, not after five idle minutes.
    const part = (c: LocalClient, upload: string, offset: number, bytes: Uint8Array, last = false) => c.exchange({ type: 'blob.put', base64: b64(bytes), part: { upload, offset, ...(last ? { last } : {}) } });
    expect((await part(b.c, 'u1', 0, Buffer.alloc(400, 1))).value).toEqual({ upload: 'u1', received: 400 });
    expect((await part(b.c, 'u2', 0, Buffer.alloc(300, 2))).value).toEqual({ upload: 'u2', received: 300 });
    expect((await part(a.c, 'u1', 0, Buffer.alloc(10, 3))).value).toEqual({ upload: 'u1', received: 10 });
    expect(w.gw.hostBlobs.pending('beta')).toEqual({ uploads: 2, bytes: 700, buffers: 2 });
    expect(w.gw.backendKey('beta', 'revoke')).toMatchObject({ ok: true, value: { op: 'revoke', closed: 1 } });
    expect(w.gw.hostBlobs.pending('beta')).toEqual({ uploads: 0, bytes: 0, buffers: 0 });
    // alpha's are untouched.
    expect(w.gw.hostBlobs.pending('alpha')).toEqual({ uploads: 1, bytes: 10, buffers: 1 });
    const issued = w.gw.backendKey('beta', 'issue');
    if (!issued.ok) throw new Error(issued.code);
    const b2 = await w.backend('beta', { key: (issued.value as { key: string }).key });
    expect(await part(b2.c, 'u1', 400, Buffer.alloc(1, 1), true)).toMatchObject({ ok: false, error: { code: 'bad_offset', message: 'expected offset 0' } });
    // What it had staged is still its own (state goes with the id): its quota is as full as before.
    expect(await put(b2.c, Buffer.from([0, 0]))).toMatchObject({ ok: false, error: { code: 'quota_exceeded' } });
  });

  // Keys themselves (stored hashed, issue / rotate / revoke, forget): backend-keys.test.ts.
});
