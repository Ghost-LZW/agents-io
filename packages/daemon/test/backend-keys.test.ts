import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { BackendsKeyResult, BackendsListResult, errors } from '@agents-io/protocol';
import { tokenPath } from '@agents-io/kernel';
import { BACKEND_KEY_PREFIX } from '../../kernel/src/backends.js';
import { daemon, until } from './helpers.js';

const alice = { channelUserId: 'alice', evidence: 'platform_signed' as const };
const KEY = /^aiob_[A-Za-z0-9_-]{43}$/;

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

const rules = (...ids: string[]) => ids.map((id) => ({ id: `to-${id}`, match: { channel: 'fake', keywords: [id] }, on: 'host', to: id }));
const row = (list: BackendsListResult, id: string) => list.backends.find((b) => b.id === id);

describe('backend keys', () => {
  it('a key is shown once and only its SHA-256 is stored: no table, log line, config or token file holds it; it verifies after a restart; the answers of backends.key and backends.list match their schemas #PB-3 #RS-1 #PR-1', async () => {
    const lines: string[] = [];
    const logger = (level: string, msg: string, data?: unknown) => void lines.push(`${level} ${msg} ${data === undefined ? '' : JSON.stringify(data)}`);
    const raw = { backends: { alpha: { note: 'first' }, beta: {} } };
    const w = await daemon({ raw, gateway: { logger } });
    const h = await w.host({ name: 'admin' });
    const r = await h.backendsKey('alpha', 'issue');
    expect(errors(BackendsKeyResult, r)).toEqual([]);
    expect(r).toEqual({ backend: 'alpha', op: 'issue', access: 'readwrite', key: expect.stringMatching(KEY), keyId: expect.stringMatching(/^[0-9a-f]{12}$/), createdAt: expect.any(Number), closed: 0 });
    const key = r.key!;
    expect(key.startsWith(BACKEND_KEY_PREFIX)).toBe(true);
    const sha = createHash('sha256').update(key).digest('hex');
    expect(r.keyId).toBe(sha.slice(0, 12));

    // What is stored is the digest, in the session log's database; no table holds the key.
    expect(w.gw.records.backendKeys()).toEqual([{ backend: 'alpha', access: 'readwrite', hash: sha, createdAt: r.createdAt }]);
    const tables = dump(w.config.logPath);
    expect(Object.keys(tables)).toContain('daemon_backend_keys');
    expect(tables.daemon_backend_keys).toContain(sha);
    for (const [name, rows] of Object.entries(tables)) expect(rows.includes(key), `table ${name}`).toBe(false);
    // Nor does any file of the daemon (the database and its WAL, the token file next to the socket, …).
    const all = files(w.dir);
    expect(all.map((f) => f.path)).toContain(tokenPath(w.config.socketPath));
    expect(all.map((f) => f.path)).toContain(w.config.logPath);
    for (const f of all) expect(f.bytes.includes(key), f.path).toBe(false);
    // The log names the key by its id only.
    expect(lines.some((l) => l.includes('backend alpha') && l.includes(r.keyId!))).toBe(true);
    expect(lines.some((l) => l.includes(key) || l.includes(key.slice(BACKEND_KEY_PREFIX.length)))).toBe(false);
    // Listing shows the key id, never the key; it is not shown a second time by anything.
    const list = await h.backendsList();
    expect(errors(BackendsListResult, list)).toEqual([]);
    expect(list.backends).toEqual([
      { id: 'alpha', configured: true, note: 'first', history: false, key: { id: r.keyId, createdAt: r.createdAt }, connections: 0, push: false, consumer: 'backend:alpha', acked: 0, pending: 0, routes: { registered: 0, granted: 0 } },
      { id: 'beta', configured: true, history: false, connections: 0, push: false, consumer: 'backend:beta', acked: 0, pending: 0, routes: { registered: 0, granted: 0 } },
    ]);
    expect(JSON.stringify(list)).not.toContain(key);

    // The key verifies as alpha; anything else, the host token included, does not.
    expect(w.gw.backends.verify(key)).toEqual({ id: 'alpha', keyId: r.keyId, access: 'readwrite' });
    expect(w.gw.backends.current('alpha', r.keyId!, 'readwrite')).toBe(true);
    expect(w.gw.backends.current('beta', r.keyId!, 'readwrite')).toBe(false);
    for (const bad of [key.slice(0, -1), `${key}x`, key.toUpperCase(), sha, w.gw.token, '', BACKEND_KEY_PREFIX]) expect(w.gw.backends.verify(bad), JSON.stringify(bad.slice(0, 8))).toBeUndefined();
    await w.stop();

    // Across a restart: still only the digest, and the same key still verifies.
    const again = await daemon({ raw, dir: w.dir, gateway: { logger } });
    expect(again.gw.backends.verify(key)).toEqual({ id: 'alpha', keyId: r.keyId, access: 'readwrite' });
    expect(again.gw.backends.has(key)).toBe(true);
    for (const f of files(w.dir)) expect(f.bytes.includes(key), f.path).toBe(false);
    expect(lines.some((l) => l.includes(key))).toBe(false);
  });

  it('issue refuses a second key (key_exists); rotate replaces it and the old key no longer verifies; revoke leaves none #PB-3', async () => {
    const w = await daemon({ raw: { backends: { alpha: {}, beta: {} } } });
    const h = await w.host({ name: 'admin' });
    const k = w.gw.backends;
    const first = await h.backendsKey('alpha', 'issue');
    await expect(h.backendsKey('alpha', 'issue')).rejects.toMatchObject({ code: 'key_exists' });
    // The refused issue changed nothing.
    expect(k.verify(first.key!)).toEqual({ id: 'alpha', keyId: first.keyId, access: 'readwrite' });
    expect(k.list()).toEqual([{ backend: 'alpha', access: 'readwrite', keyId: first.keyId, createdAt: first.createdAt }]);

    const second = await h.backendsKey('alpha', 'rotate');
    expect(second).toMatchObject({ backend: 'alpha', op: 'rotate', key: expect.stringMatching(KEY), closed: 0 });
    expect(second.key).not.toBe(first.key);
    expect(second.keyId).not.toBe(first.keyId);
    expect(k.verify(first.key!)).toBeUndefined();
    expect(k.current('alpha', first.keyId!, 'readwrite')).toBe(false);
    expect(k.verify(second.key!)).toEqual({ id: 'alpha', keyId: second.keyId, access: 'readwrite' });
    expect(k.list().map((x) => x.keyId)).toEqual([second.keyId]);

    // Each backend has its own key; one backend's operations leave the other's alone.
    const beta = await h.backendsKey('beta', 'rotate'); // no old key: the same as issue
    expect(beta).toMatchObject({ backend: 'beta', op: 'rotate', key: expect.stringMatching(KEY) });
    expect(k.verify(beta.key!)).toEqual({ id: 'beta', keyId: beta.keyId, access: 'readwrite' });

    expect(await h.backendsKey('alpha', 'revoke')).toEqual({ backend: 'alpha', op: 'revoke', access: 'readwrite', closed: 0 });
    expect(k.verify(second.key!)).toBeUndefined();
    expect(k.verify(first.key!)).toBeUndefined();
    expect(k.verify(beta.key!)).toEqual({ id: 'beta', keyId: beta.keyId, access: 'readwrite' });
    expect(row(await h.backendsList(), 'alpha')).not.toHaveProperty('key');
    expect(row(await h.backendsList(), 'beta')).toMatchObject({ key: { id: beta.keyId } });
    // Revoking again is harmless; a key can be issued again afterwards.
    expect(await h.backendsKey('alpha', 'revoke')).toEqual({ backend: 'alpha', op: 'revoke', access: 'readwrite', closed: 0 });
    const third = await h.backendsKey('alpha', 'issue');
    expect(k.verify(third.key!)).toEqual({ id: 'alpha', keyId: third.keyId, access: 'readwrite' });

    // A backend that is not configured has no key operations.
    for (const op of ['issue', 'rotate', 'revoke'] as const) await expect(h.backendsKey('gamma', op)).rejects.toMatchObject({ code: 'unknown_backend' });
    expect(k.list().map((x) => x.backend)).toEqual(['alpha', 'beta']);
  });

  it('a backend removed from the config loses its key at the next start; added back it needs a new key, and its unacked items, cursor and send grants are still under the id #PB-3 #PB-2 #HQ-1 #RS-1', async () => {
    const lines: string[] = [];
    const logger = (level: string, msg: string) => void lines.push(`${level} ${msg}`);
    const withAlpha = { backends: { alpha: {} }, bindings: rules('alpha') };
    const w = await daemon({ raw: withAlpha, gateway: { logger } });
    await w.chat.inject({ id: 'm1', sender: alice, text: 'alpha one' });
    await w.chat.inject({ id: 'm2', sender: alice, text: 'alpha two' });
    await until(() => w.gw.hostQueue.head() === 2);
    expect(w.gw.hostQueue.ack('backend:alpha', 1)).toBe(1);
    const route = w.gw.hostQueue.get(2)!.envelope.replyRoute!;
    const grant = { channel: route.channel, account: route.account, conversationId: route.conversationId };
    expect(w.gw.hostQueue.granted('alpha', grant)).toBe(true);
    const issued = (await (await w.host({ name: 'admin' })).backendsKey('alpha', 'issue')) as BackendsKeyResult;
    expect(w.gw.backends.verify(issued.key!)).toMatchObject({ id: 'alpha' });
    await w.stop();

    // Started without it: the key is deleted (and the log says whose), the rest stays under the id.
    const without = await daemon({ raw: {}, dir: w.dir, gateway: { logger } });
    expect(lines.filter((l) => /backend alpha is no longer in the config/.test(l))).toHaveLength(1);
    expect(lines.some((l) => l.includes(issued.key!))).toBe(false);
    expect(without.gw.records.backendKeys()).toEqual([]);
    expect(without.gw.backends.verify(issued.key!)).toBeUndefined();
    const h0 = await without.host({ name: 'admin' });
    expect((await h0.backendsList()).backends).toEqual([
      { id: 'alpha', configured: false, history: false, connections: 0, push: false, consumer: 'backend:alpha', acked: 1, pending: 1, oldestPendingAt: expect.any(Number), routes: { registered: 0, granted: 1 } },
    ]);
    await expect(h0.backendsKey('alpha', 'issue')).rejects.toMatchObject({ code: 'unknown_backend' });
    await without.stop();

    // Added back: the old key is gone for good, a new one must be issued (issue, not rotate, is enough).
    const back = await daemon({ raw: withAlpha, dir: w.dir, gateway: { logger } });
    expect(back.gw.backends.verify(issued.key!)).toBeUndefined();
    const h = await back.host({ name: 'admin' });
    expect(row(await h.backendsList(), 'alpha')).toEqual({ id: 'alpha', configured: true, history: false, connections: 0, push: false, consumer: 'backend:alpha', acked: 1, pending: 1, oldestPendingAt: expect.any(Number), routes: { registered: 0, granted: 1 } });
    const fresh = await h.backendsKey('alpha', 'issue');
    expect(fresh.key).not.toBe(issued.key);
    expect(back.gw.backends.verify(fresh.key!)).toEqual({ id: 'alpha', keyId: fresh.keyId, access: 'readwrite' });
    expect(back.gw.backends.verify(issued.key!)).toBeUndefined();
    // Its backlog, cursor and grant are the ones it had.
    expect(back.gw.hostQueue.cursor('backend:alpha')).toBe(1);
    expect((await back.gw.hostQueue.read('backend:alpha')).map((x) => [x.cursor, x.envelope.id, x.to])).toEqual([[2, 'm2', 'alpha']]);
    expect(back.gw.hostQueue.granted('alpha', grant)).toBe(true);
  });

  it('backends.forget removes a backend\'s items, cursor and grants (also for an id no longer configured) and leaves its key and other backends alone; list shows unconfigured ids that still hold state #PB-2 #PB-3', async () => {
    const both = { backends: { alpha: {}, beta: {} }, bindings: rules('alpha', 'beta') };
    const w = await daemon({ raw: both });
    for (const [id, text] of [['m1', 'alpha one'], ['m2', 'beta one'], ['m3', 'alpha two'], ['m4', 'beta two'], ['m5', 'alpha three']] as const) await w.chat.inject({ id, sender: alice, text });
    await until(() => w.gw.hostQueue.head() === 5);
    w.gw.hostQueue.ack('backend:alpha', 1);
    w.gw.hostQueue.ack('backend:beta', 2);
    const h = await w.host({ name: 'admin' });
    const ka = await h.backendsKey('alpha', 'issue');
    const kb = await h.backendsKey('beta', 'issue');
    const route = w.gw.hostQueue.get(1)!.envelope.replyRoute!;
    const grant = { channel: route.channel, account: route.account, conversationId: route.conversationId };
    const state = async (gw = w.gw, c = h) => (await c.backendsList()).backends.map((b) => [b.id, b.configured, b.acked, b.pending, b.routes.granted, b.key?.id, gw.hostQueue.granted(b.id, grant)]);
    expect(await state()).toEqual([['alpha', true, 1, 2, 1, ka.keyId, true], ['beta', true, 2, 1, 1, kb.keyId, true]]);

    // Forget alpha: its items, cursor and grants go; its key stays and still verifies; beta is as it was.
    expect(await h.backendsForget('alpha')).toEqual({ backend: 'alpha', items: 3, routes: 1, closed: 0 });
    expect(await state()).toEqual([['alpha', true, 0, 0, 0, ka.keyId, false], ['beta', true, 2, 1, 1, kb.keyId, true]]);
    expect(w.gw.backends.verify(ka.key!)).toEqual({ id: 'alpha', keyId: ka.keyId, access: 'readwrite' });
    expect(await w.gw.hostQueue.read('backend:alpha')).toEqual([]);
    expect((await w.gw.hostQueue.read('backend:beta')).map((x) => x.envelope.id)).toEqual(['m4']);
    expect(w.gw.hostQueue.grantedMessage('alpha', { ...grant, messageId: 'm1' })).toBe(false);
    expect(w.gw.hostQueue.grantedMessage('beta', { ...grant, messageId: 'm4' })).toBe(true);
    // It is still a known consumer walking its own items: new input for it waits in its view only.
    expect(w.gw.hostQueue.consumers().map((c) => [c.name, c.target, c.acked])).toEqual([['backend:alpha', 'alpha', 0], ['backend:beta', 'beta', 2]]);
    await w.chat.inject({ id: 'm6', sender: alice, text: 'alpha again' });
    await until(() => w.gw.hostQueue.head() === 6);
    expect((await w.gw.hostQueue.read('backend:alpha')).map((x) => x.envelope.id)).toEqual(['m6']);
    expect((await w.gw.hostQueue.read('backend:beta')).map((x) => x.envelope.id)).toEqual(['m4']);
    // Forgetting is idempotent, also for an id nothing was ever kept for; a malformed id is refused.
    expect(await h.backendsForget('alpha')).toEqual({ backend: 'alpha', items: 1, routes: 1, closed: 0 });
    expect(await h.backendsForget('alpha')).toEqual({ backend: 'alpha', items: 0, routes: 0, closed: 0 });
    expect(await h.backendsForget('gamma')).toEqual({ backend: 'gamma', items: 0, routes: 0, closed: 0 });
    await expect(h.backendsForget('Not An Id')).rejects.toMatchObject({ code: 'invalid_frame' });
    expect((await h.backendsList()).backends.map((b) => b.id)).toEqual(['alpha', 'beta']);
    await w.stop();

    // beta leaves the config: it is still listed (not configured, no key) while state remains under its id.
    const onlyAlpha = await daemon({ raw: { backends: { alpha: {} }, bindings: rules('alpha') }, dir: w.dir });
    const h2 = await onlyAlpha.host({ name: 'admin' });
    expect(await state(onlyAlpha.gw, h2)).toEqual([['alpha', true, 0, 0, 0, ka.keyId, false], ['beta', false, 2, 1, 1, undefined, true]]);
    // (`items` counts what was still stored for it: the unacked m4 and the acked m2 that retention had not removed yet.)
    expect(await h2.backendsForget('beta')).toEqual({ backend: 'beta', items: 2, routes: 1, closed: 0 });
    // Nothing is left under it, so it is no longer listed, and it is not a consumer any more.
    expect(await state(onlyAlpha.gw, h2)).toEqual([['alpha', true, 0, 0, 0, ka.keyId, false]]);
    expect(onlyAlpha.gw.hostQueue.consumers().map((c) => c.name)).toEqual(['backend:alpha']);
    expect(onlyAlpha.gw.hostQueue.granted('beta', grant)).toBe(false);
    expect(onlyAlpha.gw.backends.verify(ka.key!)).toEqual({ id: 'alpha', keyId: ka.keyId, access: 'readwrite' });
  });
  it("backends.forget removes a backend's staged uploads and media grants and nothing of another backend's #PB-6 #PB-2", async () => {
    const w = await daemon({ raw: { backends: { alpha: {}, beta: {} }, bindings: rules('alpha', 'beta') } });
    const picture = await w.gw.blobs.put(Buffer.from('a picture for both'), { mime: 'image/png' });
    await w.chat.inject({ id: 'm1', sender: alice, content: [{ type: 'text', text: 'alpha and beta' }, { type: 'image', ref: picture, mime: 'image/png' }] });
    await until(() => w.gw.hostQueue.head() === 2);
    const a = await w.backend('alpha');
    const b = await w.backend('beta');
    const staged = (id: string) => {
      const dir = join(w.config.blobs.dir, 'uploads', id);
      return existsSync(dir) ? readdirSync(dir) : undefined;
    };
    const [ua, ub] = [await a.c.writeBlob(Buffer.from('uploaded by alpha')), await b.c.writeBlob(Buffer.from('uploaded by beta'))];
    // An upload in parts that alpha has not finished.
    await a.c.blobPut({ base64: Buffer.from('half').toString('base64'), part: { upload: 'u1', offset: 0 } });
    expect([await a.c.blobStat(picture), await a.c.blobStat(ua.ref), await b.c.blobStat(picture), await b.c.blobStat(ub.ref)]).toEqual([{ size: 18 }, { size: 17 }, { size: 18 }, { size: 16 }]);
    expect(staged('alpha')).toHaveLength(1);

    const h = await w.host({ name: 'admin' });
    expect(await h.backendsForget('alpha')).toEqual({ backend: 'alpha', items: 1, routes: 1, closed: 1 });
    // Its staging directory is gone, its media grant too; the bytes of the shared store stay (they are the channel's).
    expect(staged('alpha')).toBeUndefined();
    expect(w.gw.hostQueue.grantedBlob('alpha', picture)).toBe(false);
    expect(await w.gw.blobs.stat(picture)).toMatchObject({ size: 18 });
    // With the same key (forget leaves it) alpha starts empty: neither ref is readable or attachable, the upload is not continued.
    const a2 = await w.backend('alpha', { key: a.key });
    expect([await a2.c.blobStat(picture), await a2.c.blobStat(ua.ref)]).toEqual([null, null]);
    expect(await a2.c.exchange({ type: 'blob.put', base64: Buffer.from('rest').toString('base64'), part: { upload: 'u1', offset: 4, last: true } })).toMatchObject({ ok: false, error: { code: 'bad_offset', message: 'expected offset 0' } });
    // beta is as it was.
    expect([await b.c.blobStat(picture), await b.c.blobStat(ub.ref)]).toEqual([{ size: 18 }, { size: 16 }]);
    expect(staged('beta')).toHaveLength(1);
    expect(w.gw.hostQueue.grantedBlob('beta', picture)).toBe(true);
    // An id that is no path segment is refused before anything is touched.
    await expect(h.backendsForget('../beta')).rejects.toMatchObject({ code: 'invalid_frame' });
    expect(staged('beta')).toHaveLength(1);
  });
});
