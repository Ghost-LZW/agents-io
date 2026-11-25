import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { BackendsKeyResult, BackendsListResult, HostHelloResult, errors, type ContentBlock, type InboundItem, type ReplyRoute } from '@agents-io/protocol';
import { fakeEnvelope } from '@agents-io/testkit';
import type { LocalClient } from '@agents-io/kernel';
import { BACKEND_KEY_PREFIX, BACKEND_READ_KEY_PREFIX, BackendKeys } from '../../kernel/src/backends.js';
import { daemon, until } from './helpers.js';

// The two levels of a backend's keys (INVARIANTS PB-7, PB-3; docs/design/persona-backend/ §3.2): the
// read-write key is the backend, the read key an observer of it. Ids are neutral (alpha, beta).

const alice = { channelUserId: 'alice', evidence: 'platform_signed' as const };
const KEY = /^aiob_[A-Za-z0-9_-]{43}$/;
const READ_KEY = /^aiobr_[A-Za-z0-9_-]{43}$/;
/** The one answer to everything a read key may not do. */
const READ_ONLY = { code: 'forbidden', message: 'this key is read-only' };
const sha = (key: string) => createHash('sha256').update(key).digest('hex');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

/** Every regular file under `dir`, with its bytes. */
function files(dir: string): { path: string; bytes: Buffer }[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return files(p);
    return statSync(p).isFile() ? [{ path: p, bytes: readFileSync(p) }] : [];
  });
}

/** Every row of every table of the SQLite file, as text. */
function dump(path: string): Record<string, string> {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((t) => t.name);
    return Object.fromEntries(tables.map((t) => [t, JSON.stringify(db.prepare(`SELECT * FROM "${t}"`).all(), (_k, v) => (typeof v === 'bigint' ? String(v) : v instanceof Uint8Array ? Buffer.from(v).toString('latin1') : v))]));
  } finally {
    db.close();
  }
}

const at = (conversationId: string): ReplyRoute => ({ channel: 'fake', account: 'default', conversationId });
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');
const refOf = (bytes: Uint8Array) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const image = (ref: string): ContentBlock => ({ type: 'image', ref, mime: 'image/png' });
const uploads = (w: { config: { blobs: { dir: string } } }, backend: string) => {
  const dir = join(w.config.blobs.dir, 'uploads', backend);
  return existsSync(dir) ? readdirSync(dir).sort() : [];
};

describe('backend read keys', () => {
  it('a backend holds a read-write key and a read key at once, each shown once and stored only as its SHA-256 with its level: no table, file or log line holds either; each verifies as its own level, also after a restart; issue refuses a second key of the same level only; the answers match their schemas #PB-3 #PB-7 #RS-1 #PR-1', async () => {
    const lines: string[] = [];
    const logger = (level: string, msg: string, data?: unknown) => void lines.push(`${level} ${msg} ${data === undefined ? '' : JSON.stringify(data)}`);
    const raw = { backends: { alpha: { note: 'first' }, beta: {} } };
    const w = await daemon({ raw, gateway: { logger } });
    const h = await w.host({ name: 'admin' });
    const rw = await h.backendsKey('alpha', 'issue');
    const rd = await h.backendsKey('alpha', 'issue', 'read');
    for (const r of [rw, rd]) expect(errors(BackendsKeyResult, r)).toEqual([]);
    expect(rw).toEqual({ backend: 'alpha', op: 'issue', access: 'readwrite', key: expect.stringMatching(KEY), keyId: sha(rw.key!).slice(0, 12), createdAt: expect.any(Number), closed: 0 });
    expect(rd).toEqual({ backend: 'alpha', op: 'issue', access: 'read', key: expect.stringMatching(READ_KEY), keyId: sha(rd.key!).slice(0, 12), createdAt: expect.any(Number), closed: 0 });
    const [wk, rk] = [rw.key!, rd.key!];
    // Told apart by eye, and not one key under two prefixes.
    expect([wk.startsWith(BACKEND_KEY_PREFIX), wk.startsWith(BACKEND_READ_KEY_PREFIX), rk.startsWith(BACKEND_READ_KEY_PREFIX)]).toEqual([true, false, true]);
    expect(rk.slice(BACKEND_READ_KEY_PREFIX.length)).not.toBe(wk.slice(BACKEND_KEY_PREFIX.length));

    // What is stored: each digest with its level, the read key's in a table of its own. No table holds a key.
    expect(w.gw.records.backendKeys()).toEqual([
      { backend: 'alpha', access: 'read', hash: sha(rk), createdAt: rd.createdAt },
      { backend: 'alpha', access: 'readwrite', hash: sha(wk), createdAt: rw.createdAt },
    ]);
    const tables = dump(w.config.logPath);
    expect([tables.daemon_backend_keys!.includes(sha(wk)), tables.daemon_backend_keys!.includes(sha(rk))]).toEqual([true, false]);
    expect([tables.daemon_backend_access_keys!.includes(sha(rk)), tables.daemon_backend_access_keys!.includes(sha(wk))]).toEqual([true, false]);
    for (const key of [wk, rk]) {
      for (const [name, rows] of Object.entries(tables)) expect(rows.includes(key), `table ${name}`).toBe(false);
      // Nor does any file of the daemon (the database and its WAL, the token file next to the socket, …).
      for (const f of files(w.dir)) expect(f.bytes.includes(key), f.path).toBe(false);
    }
    // The log names each key by its id and says which is the read key; never a key or its random part.
    expect(lines.some((l) => l.includes('backend alpha: key issued') && l.includes(rw.keyId!))).toBe(true);
    expect(lines.some((l) => l.includes('backend alpha: read key issued') && l.includes(rd.keyId!))).toBe(true);
    expect(lines.some((l) => [wk, rk, wk.slice(BACKEND_KEY_PREFIX.length), rk.slice(BACKEND_READ_KEY_PREFIX.length)].some((x) => l.includes(x)))).toBe(false);

    // Listing: per level whether there is a key (id, age) and how many connections; never a key. No read key, no `read`.
    const list = await h.backendsList();
    expect(errors(BackendsListResult, list)).toEqual([]);
    expect(list.backends).toEqual([
      { id: 'alpha', configured: true, note: 'first', history: false, key: { id: rw.keyId, createdAt: rw.createdAt }, connections: 0, push: false, read: { key: { id: rd.keyId, createdAt: rd.createdAt }, connections: 0 }, consumer: 'backend:alpha', acked: 0, pending: 0, routes: { registered: 0, granted: 0 } },
      { id: 'beta', configured: true, history: false, connections: 0, push: false, consumer: 'backend:beta', acked: 0, pending: 0, routes: { registered: 0, granted: 0 } },
    ]);
    expect('read' in list.backends[1]!).toBe(false);
    expect([JSON.stringify(list).includes(wk), JSON.stringify(list).includes(rk)]).toEqual([false, false]);

    // Each verifies as its own level. The level is the stored one: the other prefix on a key's random part is no key.
    const levels = (g: typeof w.gw) => [g.backends.verify(wk), g.backends.verify(rk)];
    const both = [{ id: 'alpha', keyId: rw.keyId, access: 'readwrite' }, { id: 'alpha', keyId: rd.keyId, access: 'read' }];
    expect(levels(w.gw)).toEqual(both);
    expect([w.gw.backends.has(wk), w.gw.backends.has(rk)]).toEqual([true, true]);
    expect([w.gw.backends.current('alpha', rd.keyId!, 'read'), w.gw.backends.current('alpha', rd.keyId!, 'readwrite'), w.gw.backends.current('alpha', rw.keyId!, 'readwrite'), w.gw.backends.current('alpha', rw.keyId!, 'read'), w.gw.backends.current('beta', rd.keyId!, 'read')]).toEqual([true, false, true, false, false]);
    for (const bad of [BACKEND_KEY_PREFIX + rk.slice(BACKEND_READ_KEY_PREFIX.length), BACKEND_READ_KEY_PREFIX + wk.slice(BACKEND_KEY_PREFIX.length), rk.slice(0, -1), `${rk}x`, sha(rk), BACKEND_READ_KEY_PREFIX]) expect(w.gw.backends.verify(bad), bad.slice(0, 8)).toBeUndefined();

    // issue refuses a second key of the same level, and only that: the other level and the other backend are free.
    await expect(h.backendsKey('alpha', 'issue', 'read')).rejects.toMatchObject({ code: 'key_exists', message: expect.stringContaining('already has a read key') });
    await expect(h.backendsKey('alpha', 'issue')).rejects.toMatchObject({ code: 'key_exists' });
    await expect(h.backendsKey('alpha', 'issue', 'readwrite')).rejects.toMatchObject({ code: 'key_exists' });
    expect(levels(w.gw)).toEqual(both);
    // A backend may have a read key and no read-write key.
    const betaRead = await h.backendsKey('beta', 'issue', 'read');
    expect(betaRead).toMatchObject({ backend: 'beta', op: 'issue', access: 'read', key: expect.stringMatching(READ_KEY) });
    expect(w.gw.backends.verify(betaRead.key!)).toEqual({ id: 'beta', keyId: betaRead.keyId, access: 'read' });
    expect((await h.backendsList()).backends.map((b) => [b.id, b.key?.id, b.read?.key.id])).toEqual([['alpha', rw.keyId, rd.keyId], ['beta', undefined, betaRead.keyId]]);
    // A level that is not one is refused as a frame; it never falls back to the read-write key.
    for (const access of ['admin', 'write', '', 1, null]) expect((await h.exchange({ type: 'backends.key', backend: 'alpha', op: 'rotate', access })).error?.code).toBe('invalid_frame');
    await expect(h.backendsKey('gamma', 'issue', 'read')).rejects.toMatchObject({ code: 'unknown_backend' });
    expect(levels(w.gw)).toEqual(both);
    await w.stop();

    // Across a restart: still only the digests, and each key is what it was.
    const again = await daemon({ raw, dir: w.dir, gateway: { logger } });
    expect(levels(again.gw)).toEqual(both);
    expect(again.gw.backends.verify(betaRead.key!)).toMatchObject({ id: 'beta', access: 'read' });
    for (const key of [wk, rk]) for (const f of files(w.dir)) expect(f.bytes.includes(key), f.path).toBe(false);
    expect(lines.some((l) => l.includes(wk) || l.includes(rk))).toBe(false);
  });

  it('verify compares the digests of both levels without stopping at a match; a digest stored under both levels verifies as read; current is per level #PB-3 #PB-7', () => {
    const token = 'aiobr_test_key_not_real';
    const other = 'aiob_test_key_not_real';
    type Row = { backend: string; access: 'read' | 'readwrite'; hash: string; createdAt: number };
    /** Records over fixed rows that note which rows' digests were looked at. */
    const over = (rows: Row[]) => {
      const looked: number[] = [];
      const records = {
        backendKeys: () =>
          rows.map((r, i) => ({
            backend: r.backend,
            access: r.access,
            createdAt: r.createdAt,
            get hash() {
              looked.push(i);
              return r.hash;
            },
          })),
        putBackendKey: () => undefined,
        delBackendKey: () => false,
      };
      return { keys: new BackendKeys(records, () => ['alpha', 'beta'], () => 1), looked };
    };
    const row = (backend: string, access: Row['access'], key: string): Row => ({ backend, access, hash: sha(key), createdAt: 1 });
    const id = sha(token).slice(0, 12);

    // The match is the first row: every later row's digest is still compared (both levels, every backend).
    const first = over([row('alpha', 'read', token), row('alpha', 'readwrite', other), row('beta', 'read', 'aiobr_another_not_real'), row('beta', 'readwrite', 'aiob_another_not_real')]);
    expect(first.keys.verify(token)).toEqual({ id: 'alpha', keyId: id, access: 'read' });
    expect([...new Set(first.looked)]).toEqual([0, 1, 2, 3]);
    // No match at all: the same rows are compared.
    first.looked.length = 0;
    expect(first.keys.verify('aiobr_no_such_key_not_real')).toBeUndefined();
    expect([...new Set(first.looked)]).toEqual([0, 1, 2, 3]);

    // One digest under both levels (it should never happen): the lesser level, whichever row comes first.
    expect(over([row('alpha', 'readwrite', token), row('alpha', 'read', token)]).keys.verify(token)).toEqual({ id: 'alpha', keyId: id, access: 'read' });
    expect(over([row('alpha', 'read', token), row('alpha', 'readwrite', token)]).keys.verify(token)).toEqual({ id: 'alpha', keyId: id, access: 'read' });
    expect(over([row('beta', 'readwrite', token), row('alpha', 'read', token)]).keys.verify(token)).toEqual({ id: 'alpha', keyId: id, access: 'read' });
    // A backend that is not configured has no key, of either level.
    expect(over([row('gamma', 'read', token), row('gamma', 'readwrite', token)]).keys.verify(token)).toBeUndefined();

    // current is per level: a key id that is the read key's does not stand for the read-write key, nor the reverse.
    const read = over([row('alpha', 'read', token)]).keys;
    expect([read.current('alpha', id, 'read'), read.current('alpha', id, 'readwrite'), read.current('beta', id, 'read'), read.current('gamma', id, 'read')]).toEqual([true, false, false, false]);
    const write = over([row('alpha', 'readwrite', token)]).keys;
    expect([write.current('alpha', id, 'readwrite'), write.current('alpha', id, 'read')]).toEqual([true, false]);
    expect(read.list()).toEqual([{ backend: 'alpha', access: 'read', keyId: id, createdAt: 1 }]);
  });

  it('a read key\'s hello is its backend with access read and only the features it can use; asking to consume, with or without takeover, is forbidden and the read-write push connection stays and is still pushed; a read-write key\'s hello says access readwrite #PB-7 #PB-1 #HQ-6', async () => {
    const w = await daemon({ raw: two({ beta: { history: true } }) });
    const a = await w.backend('alpha', { consumer: 'alpha' });
    const got = pushed(a.c);
    const aGone = closed(a.c);
    expect(a.hello).toEqual({
      name: 'backend:alpha', protocol: 1, host: false, backend: { id: 'alpha', access: 'readwrite' }, bindings: { version: null, active: false },
      inbound: { consumer: 'backend:alpha', acked: 0, head: 0 }, features: ['backends', 'deliver.update', 'message.ack', 'host.takeover', 'binding.tag', 'blobs'],
    });
    const consumers = w.gw.hostQueue.consumers();
    await sleep(5);

    // The read key: the same backend whatever it claims, told its level, and offered only what it can use.
    const r = await w.backend('alpha', { access: 'read', name: 'the-host', callouts: ['route', 'outbound', 'external'], optIn: ['attention', 'item.tool'] });
    expect(r.key).toMatch(READ_KEY);
    expect(errors(HostHelloResult, r.hello)).toEqual([]);
    expect(r.hello).toEqual({ name: 'backend:alpha', protocol: 1, host: false, backend: { id: 'alpha', access: 'read' }, bindings: { version: null, active: false }, features: ['backends', 'binding.tag', 'blobs.read'], callouts: [], optIn: [] });
    const plain = await w.backend('alpha', { key: r.key });
    expect(plain.hello).toEqual({ name: 'backend:alpha', protocol: 1, host: false, backend: { id: 'alpha', access: 'read' }, bindings: { version: null, active: false }, features: ['backends', 'binding.tag', 'blobs.read'] });
    // `history` only where the backend may read it.
    expect((await w.backend('beta', { access: 'read' })).hello.features).toEqual(['backends', 'binding.tag', 'blobs.read', 'history']);
    await expect(r.c.hello({ token: w.gw.token, name: 'admin' })).rejects.toMatchObject({ code: 'already_authenticated' });

    // Asking to consume: forbidden, whatever the cursor named and with or without takeover.
    const asks = [{ consumer: 'alpha' }, { consumer: 'backend:alpha' }, { consumer: 'alpha', takeover: true }, { consumer: 'backend:alpha', takeover: true }, { consumer: 'backend:beta', takeover: true }, { consumer: 'legacy' }, { consumer: '' }];
    for (const ask of asks) {
      const c = await w.client();
      const res = await c.exchange({ type: 'host.hello', token: r.key, name: 'x', ...ask });
      expect([ask, res.ok, res.error]).toEqual([ask, false, READ_ONLY]);
      // The refused connection is nobody.
      expect((await c.exchange({ type: 'inbound.read', consumer: 'alpha' })).error?.code).toBe('unauthorized');
      c.close();
    }
    // The push connection was not weighed against any of them: it is there, it alone, and nothing was registered or touched.
    expect(aGone()).toBeUndefined();
    expect(w.gw.host.backendConnections('alpha')).toEqual({ connections: 1, push: true });
    expect(w.gw.host.backendReadConnections('alpha')).toBe(2);
    expect(w.gw.host.backendReadConnections('beta')).toBe(1);
    expect(w.gw.host.backendConnections('beta')).toEqual({ connections: 0, push: false });
    expect(w.gw.hostQueue.consumers()).toEqual(consumers);
    // Not the host either.
    expect(w.gw.host.info()).toBeUndefined();
    expect(w.gw.router.hostConnected).toBe(false);
    // And it is still pushed what arrives.
    await w.chat.inject({ id: 'm1', sender: alice, text: 'for alpha' });
    await until(() => got.length === 1 && w.gw.hostQueue.ackedOf('backend:alpha') === 1);
    expect(got.map((x) => x.envelope.id)).toEqual(['m1']);
    expect(aGone()).toBeUndefined();
  });

  it('a read key reads its backend\'s items by cursor and consumes nothing: the cursor, the consumer row and the retention are as they were, the read-write connection is pushed every item once, several read connections long-poll next to it; another consumer name is forbidden and nothing of another backend or the host is shown #PB-7 #PB-1 #HQ-1', async () => {
    const w = await daemon({ raw: two() });
    await w.chat.inject({ id: 'm1', sender: alice, text: 'for alpha' });
    await w.chat.inject({ id: 'm2', sender: alice, text: 'for beta' });
    await w.chat.inject({ id: 'm3', sender: alice, text: 'a plain one' });
    await w.chat.inject({ id: 'm4', sender: alice, text: 'for alpha again' });
    await until(() => w.gw.hostQueue.head() === 4);
    // A read-write connection that takes nothing (it never answers a push): m1 stays the first unacked item.
    const stuck = await w.backend('alpha', { consumer: 'alpha' });
    const refused = pushed(stuck.c, false);
    await until(() => refused.length >= 1);
    const consumers = w.gw.hostQueue.consumers();
    const rowsOf = () => (w.gw.hostQueue.db.prepare('SELECT COUNT(*) AS n FROM host_inbound').get() as { n: number }).n;
    // Later, so that any write to a consumer's row shows in `seen`.
    await sleep(5);

    const r1 = await w.backend('alpha', { access: 'read' });
    const r2 = await w.backend('alpha', { key: r1.key });
    const seen = new Set<string>();
    const ids = (x: { items: InboundItem[] }) => x.items.map((i) => (seen.add(i.envelope.id), [i.cursor, i.envelope.id, i.to]));
    // By default from what the backend acked: what it has not handled yet. Its own items only.
    const all = await r1.c.inboundRead({ consumer: 'alpha', waitMs: 0 });
    expect(ids(all)).toEqual([[1, 'm1', 'alpha'], [4, 'm4', 'alpha']]);
    expect([all.acked, all.head]).toEqual([0, 4]);
    // From wherever the observer says: it keeps its own place.
    expect(ids(await r2.c.inboundRead({ consumer: 'backend:alpha', after: 1, waitMs: 0 }))).toEqual([[4, 'm4', 'alpha']]);
    expect(ids(await r1.c.inboundRead({ consumer: 'alpha', after: 0, limit: 1, waitMs: 0 }))).toEqual([[1, 'm1', 'alpha']]);
    expect(await r1.c.inboundRead({ consumer: 'alpha', after: 4, waitMs: 0 })).toEqual({ items: [], acked: 0, head: 4 });
    // An explicit cursor between another backend's and the host's items shows neither.
    expect(ids(await r1.c.inboundRead({ consumer: 'alpha', after: 1, waitMs: 0 }))).toEqual([[4, 'm4', 'alpha']]);
    // No other cursor, a backend's or a plain one; an empty name is no name.
    for (const consumer of ['legacy', 'beta', 'backend:beta', 'host']) expect([consumer, (await r1.c.exchange({ type: 'inbound.read', consumer })).error]).toEqual([consumer, { code: 'forbidden', message: 'a backend key reads only its own cursor' }]);
    expect((await r1.c.exchange({ type: 'inbound.read', consumer: '' })).error?.code).toBe('invalid_frame');

    // Nothing was consumed, registered or touched: the consumers are the rows they were, `seen` included,
    // every item is still queued, and the read-write connection is still being offered m1.
    expect(w.gw.hostQueue.consumers()).toEqual(consumers);
    expect(w.gw.hostQueue.consumers().map((c) => c.name)).toEqual(['backend:alpha', 'backend:beta']);
    expect(rowsOf()).toBe(4);
    expect(w.gw.hostQueue.ackedOf('backend:alpha')).toBe(0);
    expect(refused.every((x) => x.cursor === 1)).toBe(true);
    expect(w.gw.host.backendConnections('alpha')).toEqual({ connections: 1, push: true });
    stuck.c.close();
    await until(() => w.gw.host.backendConnections('alpha').connections === 0);

    // Both observers long-poll past the last item while a read-write connection consumes.
    const waits = [r1.c.inboundRead({ consumer: 'alpha', after: 4, waitMs: 5000 }), r2.c.inboundRead({ consumer: 'alpha', after: 4, waitMs: 5000 })];
    const a = await w.backend('alpha', { key: stuck.key, consumer: 'alpha' });
    const got = pushed(a.c);
    const aGone = closed(a.c);
    await until(() => w.gw.hostQueue.ackedOf('backend:alpha') === 4);
    await w.chat.inject({ id: 'm5', sender: alice, text: 'for beta, meanwhile' });
    await w.chat.inject({ id: 'm6', sender: alice, text: 'for alpha, live' });
    for (const x of await Promise.all(waits)) expect(ids(x)).toEqual([[6, 'm6', 'alpha']]);
    await until(() => w.gw.hostQueue.ackedOf('backend:alpha') === 6);
    // The read-write connection was pushed every item once, in order, whoever looked at them meanwhile.
    expect(got.map((x) => [x.cursor, x.envelope.id])).toEqual([[1, 'm1'], [4, 'm4'], [6, 'm6']]);
    // The cursor moved with what the read-write connection accepted, and only then.
    const after = w.gw.hostQueue.consumers();
    expect(after.map((c) => [c.name, c.acked, c.target])).toEqual([['backend:alpha', 6, 'alpha'], ['backend:beta', 0, 'beta']]);
    expect(after[1]).toEqual(consumers[1]);
    await sleep(5);
    // Now nothing is pending for the backend; what it handled is still there to look at until retention takes it.
    expect(await r1.c.inboundRead({ consumer: 'alpha', waitMs: 0 })).toEqual({ items: [], acked: 6, head: 6 });
    expect(ids(await r2.c.inboundRead({ consumer: 'alpha', after: 0, waitMs: 0 }))).toEqual([[1, 'm1', 'alpha'], [4, 'm4', 'alpha'], [6, 'm6', 'alpha']]);
    expect(await r2.c.inboundRead({ consumer: 'alpha', after: 6, waitMs: 30 })).toEqual({ items: [], acked: 6, head: 6 });
    expect(w.gw.hostQueue.consumers()).toEqual(after);
    // Retention is the consumers' matter alone: nothing was held back or dropped on the observers' account.
    expect(w.gw.hostQueue.prune()).toBe(0);
    expect(rowsOf()).toBe(6);
    // Nothing of beta or of the host was ever shown.
    expect([...seen].sort()).toEqual(['m1', 'm4', 'm6']);
    // The listing counts each level's connections on its own.
    const row = (await (await w.host({ name: 'admin' })).backendsList()).backends.find((b) => b.id === 'alpha')!;
    expect([row.connections, row.push, row.read?.connections, row.acked, row.pending]).toEqual([1, true, 2, 6, 0]);
    expect(aGone()).toBeUndefined();
  });

  it('a read key cannot pile up waiters: one read connection has at most 4 inbound.read waiting and a backend at most 32 read connections that said hello, a further one is busy; an append wakes that many and no more, the read-write connection is pushed as before, and a place is free again once a long-poll answers or a connection closes #PB-7 #HQ-1', async () => {
    const w = await daemon({ raw: two() });
    const a = await w.backend('alpha', { consumer: 'alpha' });
    const got = pushed(a.c);
    const aGone = closed(a.c);
    /** Who is woken, and reads the queue again, on every append. */
    const waiters = () => (w.gw.hostQueue as unknown as { waiters: Set<unknown> }).waiters.size;
    // The push connection waits once.
    await until(() => waiters() === 1);
    const WAITING = { code: 'busy', message: 'at most 4 inbound.read may wait on one read-only connection: wait for one to answer' };
    const FULL = { code: 'busy', message: 'at most 32 read-only connections per backend: close one first' };
    type Answer = Awaited<ReturnType<LocalClient['exchange']>>;
    const ask = (c: LocalClient, n: number, after: number) => {
      const done: Answer[] = [];
      for (let i = 0; i < n; i++) void c.exchange({ type: 'inbound.read', consumer: 'alpha', after, waitMs: 300_000 }).then((x) => done.push(x));
      return done;
    };
    const idsOf = (x: Answer[]) => x.filter((r) => r.ok).map((r) => (r.value as { items: InboundItem[] }).items.map((i) => i.envelope.id));

    // Two hundred long-polls at once on one connection: four wait, the rest are told so at once.
    const r = await w.backend('alpha', { access: 'read' });
    const first = ask(r.c, 200, 0);
    await until(() => first.length === 196);
    expect(first.map((x) => x.error)).toEqual(Array.from({ length: 196 }, () => WAITING));
    expect(waiters()).toBe(1 + 4);
    // A read that does not wait is no waiter: it is answered whatever is waiting.
    expect(await r.c.inboundRead({ consumer: 'alpha', waitMs: 0 })).toEqual({ items: [], acked: 0, head: 0 });
    // Another backend's item wakes the four and they wait on: nothing answers, nothing piles up.
    await w.chat.inject({ id: 'm1', sender: alice, text: 'for beta' });
    await until(() => w.gw.hostQueue.head() === 1);
    await sleep(20);
    expect(first.length).toBe(196);
    expect(waiters()).toBe(1 + 4);
    // The backend's item answers the four, and the read-write connection is pushed it as before.
    await w.chat.inject({ id: 'm2', sender: alice, text: 'for alpha' });
    await until(() => first.length === 200);
    expect(idsOf(first)).toEqual([['m2'], ['m2'], ['m2'], ['m2']]);
    await until(() => got.length === 1 && w.gw.hostQueue.ackedOf('backend:alpha') === 2);
    await until(() => waiters() === 1);
    // The four places are free again; a fifth is busy again.
    const second = ask(r.c, 5, 2);
    await until(() => second.length === 1);
    expect(second.map((x) => x.error)).toEqual([WAITING]);
    expect(waiters()).toBe(1 + 4);

    // The places are per connection, the connections per backend: 32 that said hello with the read key.
    const readers = [r.c];
    for (let i = 1; i < 32; i++) readers.push((await w.backend('alpha', { key: r.key })).c);
    expect(w.gw.host.backendReadConnections('alpha')).toBe(32);
    const extra = await w.client();
    const refused = await extra.exchange({ type: 'host.hello', token: r.key, name: 'one-more' });
    expect([refused.ok, refused.error]).toEqual([false, FULL]);
    // The refused connection is nobody.
    expect((await extra.exchange({ type: 'inbound.read', consumer: 'alpha' })).error?.code).toBe('unauthorized');
    expect(w.gw.host.backendReadConnections('alpha')).toBe(32);
    // Each backend counts its own, and each level: beta's read key and another connection of alpha's read-write key say hello.
    expect((await w.backend('beta', { access: 'read' })).hello.backend).toEqual({ id: 'beta', access: 'read' });
    expect((await w.backend('alpha', { key: a.key })).hello.backend).toEqual({ id: 'alpha', access: 'readwrite' });
    // Every connection asking for more than it may: the waiters stay at four each.
    const rest = readers.slice(1).map((c) => ask(c, 10, 2));
    await until(() => rest.every((x) => x.length === 6));
    expect(waiters()).toBe(1 + 32 * 4);
    await w.chat.inject({ id: 'm3', sender: alice, text: 'for alpha, to all of them' });
    await until(() => second.length === 5 && rest.every((x) => x.length === 10));
    expect([second, ...rest].map(idsOf)).toEqual(Array.from({ length: 32 }, () => [['m3'], ['m3'], ['m3'], ['m3']]));
    await until(() => got.length === 2 && w.gw.hostQueue.ackedOf('backend:alpha') === 3);
    expect(got.map((x) => x.envelope.id)).toEqual(['m2', 'm3']);
    await until(() => waiters() === 1);
    // A closed read connection gives its place to the next hello.
    readers[31]!.close();
    await until(() => w.gw.host.backendReadConnections('alpha') === 31);
    expect((await extra.hello({ token: r.key, name: 'one-more' })).backend).toEqual({ id: 'alpha', access: 'read' });
    expect(aGone()).toBeUndefined();
  });

  it('on a read connection every frame that changes something is forbidden with one fixed text: inbound.ack, deliver, deliver.update, message.ack, blob.put whole or in parts, history.read while it is off, every other host frame; client frames are forbidden; nothing was acked, sent, marked, staged or registered #PB-7 #PB-2 #PB-6', async () => {
    const w = await daemon({ raw: two(), gateway: { testHooks: true } });
    await w.chat.inject({ id: 'm1', sender: alice, text: 'for alpha' });
    await until(() => w.gw.hostQueue.head() === 1);
    // The backend itself sent a message: there is something a read key could try to edit.
    const a = await w.backend('alpha');
    const said = await a.c.exchange({ type: 'deliver', operationId: 'o1', route: at('c1'), message: { text: 'from alpha' } });
    expect(said).toMatchObject({ ok: true, value: { status: 'delivered' } });
    const mine = w.chat.sent[0]!.providerMessageId;
    const r = await w.backend('alpha', { access: 'read' });
    const state = () => ({
      consumers: w.gw.hostQueue.consumers(),
      sent: w.chat.sent.map((x) => [x.op.operationId, x.msg.text, x.edits.length, x.finalized]),
      marks: [...w.chat.acks],
      history: [...w.chat.historyCalls],
      staged: uploads(w, 'alpha'),
      parts: w.gw.hostBlobs.pending('alpha'),
      keys: w.gw.backends.list(),
      table: w.gw.router.hostTable(),
      sessions: w.gw.sessions().length,
      scope: w.gw.host.outboundScope(),
      created: [...w.chat.created],
    });
    const before = state();
    await sleep(5);
    const bytes = Buffer.from('bytes a read key tries to stage');
    const route = at('c1');
    const frames: Record<string, unknown>[] = [
      { type: 'inbound.ack', consumer: 'alpha', cursor: 1 },
      { type: 'inbound.ack', consumer: 'backend:alpha', cursor: 1 },
      { type: 'inbound.ack', consumer: 'legacy', cursor: 1 },
      { type: 'deliver', operationId: 'o2', route, message: { text: 'from an observer' } },
      { type: 'deliver', operationId: 'o1', route, message: { text: 'from alpha' } },
      { type: 'deliver.update', operationId: 'o3', route, providerMessageId: mine, message: { text: 'edited' }, sequence: 1 },
      { type: 'deliver.update', operationId: 'o4', route, providerMessageId: mine, message: { text: 'final' }, sequence: 2, final: true },
      { type: 'message.ack', route, messageId: 'm1', state: 'done' },
      { type: 'blob.put', base64: b64(bytes) },
      { type: 'blob.put', base64: b64(bytes), part: { upload: 'u1', offset: 0 } },
      { type: 'blob.put', base64: b64(bytes), part: { upload: 'u1', offset: 0, last: true } },
      // Off for alpha (the default): the same answer as everything else, not the read-write key's.
      { type: 'history.read', cursor: 1, scope: 'chat' },
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
      { type: 'backends.key', backend: 'alpha', op: 'rotate' },
      { type: 'backends.key', backend: 'alpha', op: 'rotate', access: 'read' },
      { type: 'backends.key', backend: 'beta', op: 'issue', access: 'read' },
      { type: 'backends.forget', backend: 'alpha' },
    ];
    // One code and one text for all of them: nothing in the answer tells what the frame would have met.
    for (const f of frames) {
      const res = await r.c.exchange(f);
      expect([f.type, res.ok, res.error]).toEqual([f.type, false, READ_ONLY]);
    }
    const clientFrames: Record<string, unknown>[] = [
      { type: 'command', command: { type: 'input', sessionKey: 's1', mode: 'queue', input: { content: [{ type: 'text', text: 'hi' }] } } },
      { type: 'command', command: { type: 'subscribe', sessionKey: 's1', tier: 'summary' } },
      { type: 'command', command: { type: 'interrupt', sessionKey: 's1' } },
      { type: 'sessions' },
      { type: 'watch.list' },
      { type: 'topic.list', conversation: 'fake:default:c1' },
      { type: 'tui.attach' },
      { type: 'module.connect', module: 'acp-server' },
      { type: 'no.such.frame' },
    ];
    for (const f of clientFrames) expect([f.type, (await r.c.exchange(f)).error?.code]).toEqual([f.type, 'forbidden']);

    // Nothing was acked, sent, edited, marked, asked of the channel, staged or registered; no key changed.
    expect(state()).toEqual(before);
    expect(w.gw.hostQueue.ackedOf('backend:alpha')).toBe(0);
    expect(w.gw.backends.verify(r.key)).toMatchObject({ id: 'alpha', access: 'read' });
    expect(w.gw.backends.verify(a.key)).toMatchObject({ id: 'alpha', access: 'readwrite' });
    // The refusals closed nothing: the observer still observes.
    expect((await r.c.inboundRead({ consumer: 'alpha', waitMs: 0 })).items.map((x) => x.envelope.id)).toEqual(['m1']);
    expect(w.gw.host.backendReadConnections('alpha')).toBe(1);
    // The same frames are the read-write key's: it is the key's level that refused them, not their shape.
    expect(await a.c.exchange({ type: 'message.ack', route, messageId: 'm1', state: 'done' })).toMatchObject({ ok: true });
    expect(await a.c.exchange({ type: 'deliver.update', operationId: 'o3', route, providerMessageId: mine, message: { text: 'edited' }, sequence: 1 })).toMatchObject({ ok: true });
    expect(await a.c.exchange({ type: 'blob.put', base64: b64(bytes) })).toMatchObject({ ok: true, value: { ref: refOf(bytes) } });
    expect(await a.c.exchange({ type: 'blob.put', base64: b64(bytes), part: { upload: 'u1', offset: 0 } })).toMatchObject({ ok: true, value: { upload: 'u1' } });
    expect(await a.c.inboundAck('alpha', 1)).toEqual({ consumer: 'backend:alpha', acked: 1 });
    expect((await a.c.exchange({ type: 'history.read', cursor: 1, scope: 'chat' })).error).toMatchObject({ code: 'forbidden', message: 'history.read is not open to a backend key' });
  });

  it('a read key reads the blobs its backend may read (the media of its items, the backend\'s own upload) and no other backend\'s; history.read answers for the backend\'s own items when backends.<id>.history is on #PB-7 #PB-6 #PB-1', async () => {
    const w = await daemon({ raw: two({ alpha: { history: true } }) });
    const picture = randomBytes(3000);
    const [refAlpha, refBeta, refStored] = [
      await w.gw.blobs.put(picture, { mime: 'image/png', name: 'for-alpha.png' }),
      await w.gw.blobs.put(Buffer.from('only in an item of beta'), { mime: 'image/png', name: 'for-beta.png' }),
      await w.gw.blobs.put(Buffer.from('stored, in no message at all'), { mime: 'image/png', name: 'stored.png' }),
    ];
    const base = Date.now();
    await w.chat.inject({ id: 'in-a', sender: alice, conversation: { id: 'c1', kind: 'group' }, content: [{ type: 'text', text: 'for alpha' }, image(refAlpha)], sentAt: base });
    await w.chat.inject({ id: 'in-b', sender: alice, conversation: { id: 'c2', kind: 'group' }, content: [{ type: 'text', text: 'for beta' }, image(refBeta)], sentAt: base });
    await until(() => w.gw.hostQueue.head() === 2);
    const a = await w.backend('alpha');
    const b = await w.backend('beta');
    const [own, betaOwn] = [Buffer.from('what alpha itself uploaded'), Buffer.from('what beta itself uploaded')];
    expect(await a.c.exchange({ type: 'blob.put', base64: b64(own) })).toMatchObject({ ok: true, value: { ref: refOf(own) } });
    expect(await b.c.exchange({ type: 'blob.put', base64: b64(betaOwn) })).toMatchObject({ ok: true, value: { ref: refOf(betaOwn) } });

    const r = await w.backend('alpha', { access: 'read' });
    expect(r.hello.features).toEqual(['backends', 'binding.tag', 'blobs.read', 'history']);
    // What its backend may read: the media of the backend's items, and the backend's own upload.
    expect(await r.c.blobStat(refAlpha)).toEqual({ size: picture.byteLength });
    expect(Buffer.from(await r.c.readBlob(refAlpha, { chunk: 1024 })).equals(picture)).toBe(true);
    expect(await r.c.blobGet({ ref: refAlpha, offset: 10, length: 5 })).toEqual({ base64: b64(picture.subarray(10, 15)), size: picture.byteLength, offset: 10 });
    expect(await r.c.blobStat(refOf(own))).toEqual({ size: own.byteLength });
    expect(Buffer.from(await r.c.readBlob(refOf(own))).equals(own)).toBe(true);
    // Exactly what the read-write key gets, no more: another backend's item's media, its upload, a stored blob in no item.
    const NOT_FOUND = { ok: false, error: { code: 'not_found', message: 'no such blob' } };
    for (const ref of [refBeta, refOf(betaOwn), refStored, `sha256:${'0'.repeat(64)}`]) {
      expect([await r.c.blobStat(ref), await a.c.blobStat(ref)]).toEqual([null, null]);
      expect(await r.c.exchange({ type: 'blob.get', ref })).toMatchObject(NOT_FOUND);
    }
    // And the other backend's observer sees the other backend's, not these.
    const rb = await w.backend('beta', { access: 'read' });
    expect(rb.hello.features).toEqual(['backends', 'binding.tag', 'blobs.read']);
    expect([await rb.c.blobStat(refBeta), await rb.c.blobStat(refOf(betaOwn)), await rb.c.blobStat(refAlpha), await rb.c.blobStat(refOf(own))]).toEqual([{ size: 23 }, { size: betaOwn.byteLength }, null, null]);
    // Reading staged nothing and took nothing away.
    expect([uploads(w, 'alpha'), uploads(w, 'beta')]).toEqual([[refOf(own).slice(7)], [refOf(betaOwn).slice(7)]]);

    // history.read: as for the backend. On for alpha, for its own item; another backend's cursor does not exist.
    w.chat.historyAnswer = [fakeEnvelope({ id: 'h0', channel: 'fake', account: 'default', conversation: { id: 'c1', kind: 'group' }, text: 'earlier', sentAt: base - 1000 })];
    expect((await r.c.historyRead({ cursor: 1, scope: 'chat' })).messages.map((m) => m.id)).toEqual(['h0']);
    expect(w.chat.historyCalls).toEqual([{ id: 'in-a', scope: 'chat' }]);
    expect((await r.c.exchange({ type: 'history.read', cursor: 2, scope: 'chat' })).error?.code).toBe('unknown_cursor');
    expect((await r.c.exchange({ type: 'history.read', cursor: 99, scope: 'chat' })).error?.code).toBe('unknown_cursor');
    // Off for beta: its observer is told what every refusal tells it, and the channel is not asked.
    expect((await rb.c.exchange({ type: 'history.read', cursor: 2, scope: 'chat' })).error).toEqual(READ_ONLY);
    expect(w.chat.historyCalls).toHaveLength(1);
  });

  it('rotating or revoking the read key closes read connections only: the read-write key, its push connection and its unfinished upload go on; rotating or revoking the read-write key closes read-write connections only and the read key keeps observing; forget closes both and keeps both keys; a backend removed from the config loses both keys at the next start #PB-3 #PB-7 #PB-6', async () => {
    const raw = two();
    const w = await daemon({ raw });
    const h = await w.host({ name: 'admin' });
    const part = (c: LocalClient, upload: string, offset: number, bytes: Uint8Array, last = false) => c.exchange({ type: 'blob.put', base64: b64(bytes), part: { upload, offset, ...(last ? { last } : {}) } });
    const file = randomBytes(500);
    const a = await w.backend('alpha', { consumer: 'alpha' });
    const got = pushed(a.c);
    const aGone = closed(a.c);
    // The backend is in the middle of an upload.
    expect((await part(a.c, 'u1', 0, file.subarray(0, 400))).value).toEqual({ upload: 'u1', received: 400 });
    const r1 = await w.backend('alpha', { access: 'read' });
    const r2 = await w.backend('alpha', { key: r1.key });
    const rb = await w.backend('beta', { access: 'read' });
    const [r1Gone, r2Gone, rbGone] = [closed(r1.c), closed(r2.c), closed(rb.c)];
    const conns = () => [w.gw.host.backendConnections('alpha'), w.gw.host.backendReadConnections('alpha'), w.gw.host.backendReadConnections('beta')];
    expect(conns()).toEqual([{ connections: 1, push: true }, 2, 1]);

    // The read key is rotated: its connections are closed, and nothing of the read-write level is.
    const rotated = await h.backendsKey('alpha', 'rotate', 'read');
    expect(rotated).toEqual({ backend: 'alpha', op: 'rotate', access: 'read', key: expect.stringMatching(READ_KEY), keyId: expect.any(String), createdAt: expect.any(Number), closed: 2 });
    await until(() => r1Gone() !== undefined && r2Gone() !== undefined);
    expect(conns()).toEqual([{ connections: 1, push: true }, 0, 1]);
    expect([aGone(), rbGone()]).toEqual([undefined, undefined]);
    expect(w.gw.backends.verify(a.key)).toMatchObject({ id: 'alpha', access: 'readwrite' });
    expect(w.gw.backends.verify(r1.key)).toBeUndefined();
    await expect((await w.client()).hello({ token: r1.key, name: 'x' })).rejects.toMatchObject({ code: 'unauthorized' });
    // The backend's unfinished upload goes on from where it was, and it is still pushed its items.
    expect(w.gw.hostBlobs.pending('alpha')).toMatchObject({ uploads: 1, bytes: 400 });
    expect((await part(a.c, 'u1', 400, file.subarray(400), true)).value).toEqual({ ref: refOf(file), size: 500 });
    await w.chat.inject({ id: 'm1', sender: alice, text: 'for alpha' });
    await until(() => got.length === 1 && w.gw.hostQueue.ackedOf('backend:alpha') === 1);

    // Revoked: the same, and the backend has no read key any more.
    const r3 = await w.backend('alpha', { key: rotated.key! });
    expect(r3.hello.backend).toEqual({ id: 'alpha', access: 'read' });
    const r3Gone = closed(r3.c);
    expect((await part(a.c, 'u2', 0, file.subarray(0, 300))).value).toEqual({ upload: 'u2', received: 300 });
    expect(await h.backendsKey('alpha', 'revoke', 'read')).toEqual({ backend: 'alpha', op: 'revoke', access: 'read', closed: 1 });
    await until(() => r3Gone() !== undefined);
    expect(conns()).toEqual([{ connections: 1, push: true }, 0, 1]);
    expect([aGone(), rbGone()]).toEqual([undefined, undefined]);
    expect(w.gw.backends.verify(rotated.key!)).toBeUndefined();
    expect(w.gw.backends.verify(a.key)).toMatchObject({ id: 'alpha', access: 'readwrite' });
    expect((await part(a.c, 'u2', 300, file.subarray(300), true)).value).toEqual({ ref: refOf(file), size: 500 });
    const listed = async () => (await h.backendsList()).backends.map((b) => [b.id, b.key !== undefined, b.connections, b.read !== undefined, b.read?.connections]);
    expect(await listed()).toEqual([['alpha', true, 1, false, undefined], ['beta', false, 0, true, 1]]);
    expect(await h.backendsKey('alpha', 'revoke', 'read')).toEqual({ backend: 'alpha', op: 'revoke', access: 'read', closed: 0 });
    expect(aGone()).toBeUndefined();

    // The other way round: the read-write key is rotated, then revoked. The observer goes on observing.
    const read = await h.backendsKey('alpha', 'issue', 'read');
    const r4 = await w.backend('alpha', { key: read.key! });
    const r4Gone = closed(r4.c);
    expect((await part(a.c, 'u3', 0, file.subarray(0, 100))).value).toEqual({ upload: 'u3', received: 100 });
    const rotatedWrite = await h.backendsKey('alpha', 'rotate');
    expect(rotatedWrite).toMatchObject({ backend: 'alpha', op: 'rotate', access: 'readwrite', key: expect.stringMatching(KEY), closed: 1 });
    await until(() => aGone() !== undefined);
    expect(conns()).toEqual([{ connections: 0, push: false }, 1, 1]);
    expect(r4Gone()).toBeUndefined();
    expect(w.gw.backends.verify(read.key!)).toEqual({ id: 'alpha', keyId: read.keyId, access: 'read' });
    expect(w.gw.backends.verify(a.key)).toBeUndefined();
    // (That did drop the read-write key's unfinished upload, as before: PB-6.)
    expect(w.gw.hostBlobs.pending('alpha')).toEqual({ uploads: 0, bytes: 0, buffers: 0 });
    await w.chat.inject({ id: 'm2', sender: alice, text: 'for alpha, nobody home' });
    expect((await r4.c.inboundRead({ consumer: 'alpha', waitMs: 2000 })).items.map((x) => x.envelope.id)).toEqual(['m2']);
    const a2 = await w.backend('alpha', { key: rotatedWrite.key!, consumer: 'alpha' });
    pushed(a2.c);
    const a2Gone = closed(a2.c);
    await until(() => w.gw.hostQueue.ackedOf('backend:alpha') === 2);
    expect(await h.backendsKey('alpha', 'revoke')).toEqual({ backend: 'alpha', op: 'revoke', access: 'readwrite', closed: 1 });
    await until(() => a2Gone() !== undefined);
    expect(r4Gone()).toBeUndefined();
    expect(await listed()).toEqual([['alpha', false, 0, true, 1], ['beta', false, 0, true, 1]]);
    expect((await r4.c.inboundRead({ consumer: 'alpha', after: 0, waitMs: 0 })).items.map((x) => x.envelope.id)).toEqual(['m1', 'm2']);
    expect(w.gw.backends.verify(read.key!)).toMatchObject({ id: 'alpha', access: 'read' });

    // forget is about the backend: both levels' connections are closed, both keys stay.
    const again = await h.backendsKey('alpha', 'issue');
    const a3 = await w.backend('alpha', { key: again.key!, consumer: 'alpha' });
    const a3Gone = closed(a3.c);
    expect(await h.backendsForget('alpha')).toMatchObject({ backend: 'alpha', closed: 2 });
    await until(() => a3Gone() !== undefined && r4Gone() !== undefined);
    expect(conns()).toEqual([{ connections: 0, push: false }, 0, 1]);
    expect([w.gw.backends.verify(again.key!)?.access, w.gw.backends.verify(read.key!)?.access, w.gw.backends.verify(rb.key)?.access]).toEqual(['readwrite', 'read', 'read']);
    expect(rbGone()).toBeUndefined();
    await w.stop();

    // Removed from the config: at the next start it has no key of either level. The other backend's read key stays.
    const without = await daemon({ raw: { ...raw, backends: { beta: {} }, bindings: raw.bindings.filter((x) => x.to !== 'alpha') }, dir: w.dir });
    expect(without.gw.records.backendKeys().map((k) => [k.backend, k.access])).toEqual([['beta', 'read']]);
    expect([without.gw.backends.verify(again.key!), without.gw.backends.verify(read.key!)]).toEqual([undefined, undefined]);
    expect(without.gw.backends.verify(rb.key)).toMatchObject({ id: 'beta', access: 'read' });
    await without.stop();
    // Added back: still none; each level is issued anew.
    const back = await daemon({ raw, dir: w.dir });
    expect([back.gw.backends.verify(again.key!), back.gw.backends.verify(read.key!)]).toEqual([undefined, undefined]);
    expect((await (await back.host({ name: 'admin' })).backendsList()).backends.map((b) => [b.id, b.key !== undefined, b.read !== undefined])).toEqual([['alpha', false, false], ['beta', false, true]]);
  });

  it('a read connection whose key record is gone is unauthorized on its next frame and closed while the read-write connection goes on, and the other way round #PB-3 #PB-7', async () => {
    const w = await daemon({ raw: two() });
    await w.chat.inject({ id: 'm1', sender: alice, text: 'for alpha' });
    await until(() => w.gw.hostQueue.head() === 1);
    const a = await w.backend('alpha');
    const r = await w.backend('alpha', { access: 'read' });
    const [aGone, rGone] = [closed(a.c), closed(r.c)];
    const read = (c: LocalClient) => c.inboundRead({ consumer: 'alpha', after: 0, waitMs: 0 }).then((x) => x.items.map((i) => i.envelope.id));
    expect([await read(a.c), await read(r.c)]).toEqual([['m1'], ['m1']]);

    // The read key's record goes away underneath (no rotate, no revoke: nobody closed the connection).
    expect(w.gw.records.delBackendKey('alpha', 'read')).toBe(true);
    await expect(read(r.c)).rejects.toMatchObject({ code: 'unauthorized', message: expect.stringContaining('this key is no longer valid') });
    await until(() => rGone() !== undefined);
    expect(await read(a.c)).toEqual(['m1']);
    expect(aGone()).toBeUndefined();
    expect([w.gw.host.backendConnections('alpha').connections, w.gw.host.backendReadConnections('alpha')]).toEqual([1, 0]);

    // The other way round.
    const r2 = await w.backend('alpha', { access: 'read' });
    const r2Gone = closed(r2.c);
    expect(aGone()).toBeUndefined();
    expect(w.gw.records.delBackendKey('alpha', 'readwrite')).toBe(true);
    await expect(read(a.c)).rejects.toMatchObject({ code: 'unauthorized' });
    await until(() => aGone() !== undefined);
    expect(await read(r2.c)).toEqual(['m1']);
    expect(r2Gone()).toBeUndefined();

    // A connection is its key at its level: the same digest stored as the read-write key does not keep an
    // observer's connection alive (nor would it make it the backend).
    w.gw.records.delBackendKey('alpha', 'read');
    w.gw.records.putBackendKey('alpha', sha(r2.key), 1, 'readwrite');
    expect(w.gw.backends.current('alpha', sha(r2.key).slice(0, 12), 'readwrite')).toBe(true);
    await expect(read(r2.c)).rejects.toMatchObject({ code: 'unauthorized' });
    await until(() => r2Gone() !== undefined);
    expect(w.gw.host.backendReadConnections('alpha')).toBe(0);
  });
});
