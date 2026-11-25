import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import type { RenderedMessage, ReplyRoute, SendOp, SendResult } from '@agents-io/protocol';
import { Hub, Outbox, SqliteSessionLog, type Delivery } from '@agents-io/session';
import { FakeChannel } from '@agents-io/testkit';
import { DaemonRecords, type OutboundRecord } from '@agents-io/kernel';
import { cleanups, daemon, tmp, until } from './helpers.js';

/*
 * The daemon's records inside the outbox's settlement transaction (INVARIANTS DL-1): a write that
 * fills the disk ends the whole SQLite transaction, savepoints included, so rolling back to the
 * savepoint fails too (`rollbackTo`); the write's own error is the one reported.
 */

const route = { channel: 'fake', account: 'default', conversationId: 'c1' };

/**
 * The daemon's arrangement: records on the SQLite log's connection, the outbox atomic, the outbound
 * index written in the settlement (with `agent` as the session's agent).
 */
function world(agent?: string) {
  const log = new SqliteSessionLog({ path: join(tmp('aio-rec-'), 'log.db') });
  const records = new DaemonRecords({ db: log.db });
  cleanups.push(() => log.db.close());
  const db = log.db;
  const ob = new Outbox({
    hub: new Hub(log),
    store: records,
    atomic: true,
    onSettled: (d, rec) =>
      records.putOutbound({ operationId: rec.operationId, channel: rec.route.channel, sessionKey: d.sessionKey, ...(agent !== undefined ? { agent } : {}), route: rec.route, result: rec.status, at: Date.now() }),
    sleep: async () => {},
  });
  const pages = () => (db.prepare('PRAGMA page_count').get() as { page_count: number }).page_count;
  let sends = 0;
  /** A send during which the disk fills up: the in-flight mark is written, the settlement no longer fits. */
  const filling = (result: SendResult) => async () => {
    sends++;
    db.exec(`PRAGMA max_page_count = ${pages() + 1}`);
    return result;
  };
  const events = () => (db.prepare('SELECT count(*) AS n FROM events').get() as { n: number }).n;
  return { log, records, db, ob, filling, events, sends: () => sends };
}

describe('daemon records in an atomic settlement', () => {
  it('a real SQLITE_FULL in the settlement (the outcome or the outbound index) reports its own error; nothing commits, the in-flight mark stays, and the next settle is unknown, saying so #DL-1 #DL-2', async () => {
    const big = 'x'.repeat(200_000);
    const cases: { what: string; d: Delivery; result: SendResult; agent?: string }[] = [
      // The outcome (`put`, savepoint outbox_settle) holds the platform message id.
      { what: 'outcome', d: { operationId: 'op-put', sessionKey: 's', route }, result: { providerMessageId: big } },
      // The outcome fits; the outbound index (`putOutbound`, savepoint outbound_put) does not.
      { what: 'index', d: { operationId: 'op-index', sessionKey: 's', route }, result: { providerMessageId: 'm1' }, agent: big },
    ];
    for (const c of cases) {
      const w = world(c.agent);
      const op = c.d.operationId;
      await expect(w.ob.deliver(c.d, w.filling(c.result)), c.what).rejects.toThrow(/^database or disk is full$/);
      expect(w.sends(), c.what).toBe(1);
      // The connection is usable: the failed write ended the transaction, nothing is left open.
      expect(w.db.isTransaction, c.what).toBe(false);
      expect(w.records.get(op), c.what).toBeUndefined();
      expect(w.records.outboundByOperation(op), c.what).toBeUndefined();
      expect(w.events(), c.what).toBe(0);
      expect(w.log.head('s'), c.what).toBe(0);
      expect(w.records.inFlight(op), c.what).toMatchObject({ operationId: op, attempts: 1 });

      // Room again: the same operationId settles its mark unknown, saying why, and is not sent again.
      w.db.exec('PRAGMA max_page_count = 1073741823');
      const unknown = { status: 'unknown', attempts: 1, error: 'recording its outcome failed in this process (database or disk is full); not resent' };
      expect(await w.ob.deliver(c.d, w.filling(c.result)), c.what).toMatchObject({ operationId: op, ...unknown });
      expect(w.sends(), c.what).toBe(1);
      expect(w.records.get(op), c.what).toMatchObject(unknown);
      expect(w.records.inFlight(op), c.what).toBeUndefined();
      expect(w.records.outboundByOperation(op), c.what).toMatchObject({ result: 'unknown' });
      expect(w.log.read('s', 0).map((e) => e.body), c.what).toEqual([{ t: 'delivery.settled', operationId: op, route, result: 'unknown' }]);
    }
  });

  it("outbound rows of a backend's deliveries name the backend, also when settled after a restart, and are kept past the retention; other rows are pruned as before #PB-2 #EX-2 #RS-1", async () => {
    // A send that does not come back until released: its in-flight mark can be looked at.
    class Slow extends FakeChannel {
      release: (() => void) | undefined;
      hold = false;
      override async send(r: ReplyRoute, msg: RenderedMessage, op: SendOp) {
        if (this.hold) await new Promise<void>((resolve) => (this.release = resolve));
        return super.send(r, msg, op);
      }
    }
    const raw = { backends: { alpha: {} }, bindings: [{ id: 'to-alpha', match: { channel: 'fake', keywords: ['alpha'] }, on: 'host', to: 'alpha' }] };
    const chat = new Slow('fake');
    const w = await daemon({ raw, chat });
    await chat.inject({ id: 'in-1', sender: { channelUserId: 'alice', evidence: 'platform_signed' }, text: 'for alpha' });
    await until(() => w.gw.hostQueue.head() === 1);
    const a = await w.backend('alpha');
    const h = await w.host({ name: 'admin' });
    const sent = await a.c.deliver({ operationId: 'n1', route, message: { text: 'hi' } });
    await h.deliver({ operationId: 'n1', route, message: { text: 'hi' } });
    const rows = () => (w.gw.records.db.prepare('SELECT operation_id AS id, backend FROM daemon_outbound ORDER BY operation_id').all() as { id: string; backend: string | null }[]).map((x) => [x.id, x.backend]);
    expect(rows()).toEqual([['backend:alpha:n1', 'alpha'], ['host:n1', null]]);
    expect(w.gw.records.outboundByOperation('backend:alpha:n1')).toMatchObject({ backend: 'alpha', sessionKey: 'host:backend:alpha', result: 'delivered', providerMessageId: sent.providerMessageId });
    expect('backend' in w.gw.records.outboundByOperation('host:n1')!).toBe(false);
    expect(w.gw.records.backendSent('fake', sent.providerMessageId!)).toEqual([{ backend: 'alpha', route }]);
    // The host's message is nobody's.
    expect(w.gw.records.backendSent('fake', chat.sent[1]!.providerMessageId)).toEqual([]);
    expect(w.gw.records.backendSent('other', sent.providerMessageId!)).toEqual([]);

    // While a backend's send is on its way, its mark already says whose it is; the host's mark says nothing more than before.
    chat.hold = true;
    const going = a.c.deliver({ operationId: 'n2', route, message: { text: 'slow' } });
    const mark = await until(() => w.gw.records.inFlight('backend:alpha:n2'));
    expect(mark.atSend).toEqual({ backend: 'alpha' });
    chat.release!();
    await going;
    const hostGoing = h.deliver({ operationId: 'n2', route, message: { text: 'slow' } });
    const hostMark = await until(() => w.gw.records.inFlight('host:n2'));
    expect(hostMark.atSend).toBeUndefined();
    chat.release!();
    await hostGoing;
    chat.hold = false;
    // The process dies with such a send in flight: the same mark, under an id that never settled.
    w.gw.records.begin({ ...mark, operationId: 'backend:alpha:lost' });
    await w.stop();
    const again = await daemon({ raw, dir: w.dir });
    expect(again.gw.records.outboundByOperation('backend:alpha:lost')).toMatchObject({ backend: 'alpha', sessionKey: 'host:backend:alpha', result: 'unknown' });
    expect(again.gw.explain('backend:alpha:lost')).toMatchObject({ ok: true, value: { backend: 'alpha', result: 'unknown' } });
    expect(again.gw.records.backendSent('fake', sent.providerMessageId!)).toEqual([{ backend: 'alpha', route }]);

    // Retention (30 days): a backend's rows and the parts of its split sends stay, the others go as before.
    const r = world();
    const old = Date.now() - 40 * 86_400_000;
    const row = (operationId: string, ids: string[], at: number, backend?: string): OutboundRecord =>
      ({ operationId, channel: 'fake', providerMessageId: ids[0]!, providerMessageIds: ids, sessionKey: backend ? `host:backend:${backend}` : 'host:admin', route, result: 'delivered', ...(backend ? { backend } : {}), at });
    r.records.putOutbound(row('backend:alpha:old', ['a1', 'a2'], old, 'alpha'));
    r.records.putOutbound(row('host:old', ['h1', 'h2'], old));
    r.records.putOutbound(row('host:new', ['h3', 'h4'], Date.now()));
    expect(r.records.backendSent('fake', 'a2')).toEqual([{ backend: 'alpha', route }]);
    // The next start prunes.
    const next = new DaemonRecords({ db: r.db });
    expect(next.outboundByOperation('backend:alpha:old')).toMatchObject({ backend: 'alpha' });
    expect(['a1', 'a2'].map((id) => next.backendSent('fake', id))).toEqual([[{ backend: 'alpha', route }], [{ backend: 'alpha', route }]]);
    expect(['a1', 'a2'].map((id) => next.sentByUs('fake', id))).toEqual([true, true]);
    expect(next.outboundByOperation('host:old')).toBeUndefined();
    expect(['h1', 'h2', 'h3', 'h4'].map((id) => next.sentByUs('fake', id))).toEqual([false, false, true, true]);
    expect(next.outboundByOperation('host:new')).toMatchObject({ result: 'delivered' });
    // A final update of the same message is one more row of the backend's: both are found.
    next.putOutbound(row('backend:alpha:fin', ['a1'], Date.now(), 'alpha'));
    next.putOutbound(row('host:fin', ['a1'], Date.now()));
    expect(next.backendSent('fake', 'a1').map((x) => x.backend)).toEqual(['alpha', 'alpha']);
  });

  it('a database from before backends gains the outbound backend column at open: its rows read as before and are nobody\'s, old ones are pruned as before, and rows with and without a backend can be written #RS-1 #PB-2', () => {
    const path = join(tmp('aio-rec-old-'), 'log.db');
    // The outbound tables as they were before a row could name a backend (and nothing else of the daemon's).
    const old = new DatabaseSync(path);
    cleanups.push(() => {
      if (old.isOpen) old.close();
    });
    old.exec(`
      CREATE TABLE daemon_outbound (operation_id TEXT PRIMARY KEY, channel TEXT NOT NULL, provider_message_id TEXT, sent_message_id TEXT, at INTEGER NOT NULL, json TEXT NOT NULL) WITHOUT ROWID;
      CREATE INDEX daemon_outbound_msg ON daemon_outbound (channel, provider_message_id);
      CREATE INDEX daemon_outbound_sent ON daemon_outbound(channel, sent_message_id);
      CREATE TABLE daemon_outbound_parts (channel TEXT NOT NULL, provider_message_id TEXT NOT NULL, operation_id TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (channel, provider_message_id, operation_id)) WITHOUT ROWID;
    `);
    const now = Date.now();
    const stale = now - 40 * 86_400_000;
    const before = (operationId: string, ids: string[], at: number): OutboundRecord =>
      ({ operationId, channel: 'fake', providerMessageId: ids[0]!, providerMessageIds: ids, sessionKey: 'host:admin', route, result: 'delivered', at });
    const put = old.prepare('INSERT INTO daemon_outbound (operation_id, channel, provider_message_id, sent_message_id, at, json) VALUES (?, ?, ?, ?, ?, ?)');
    const part = old.prepare('INSERT INTO daemon_outbound_parts (channel, provider_message_id, operation_id, at) VALUES (?, ?, ?, ?)');
    // A host's deliver (no turn: only `sent_message_id` names its message), recent and past the retention, each split in two.
    for (const r of [before('host:recent', ['h1', 'h2'], now), before('host:stale', ['h3', 'h4'], stale)]) {
      put.run(r.operationId, r.channel, null, r.providerMessageId!, r.at, JSON.stringify(r));
      part.run(r.channel, r.providerMessageIds![1]!, r.operationId, r.at);
    }
    const cols = (db: DatabaseSync) => (db.prepare('PRAGMA table_info(daemon_outbound)').all() as { name: string }[]).map((c) => c.name);
    expect(cols(old)).not.toContain('backend');
    old.close();

    // Opening it is what an upgraded daemon does at its first start: it must not fail on the missing column.
    const db = new DatabaseSync(path);
    cleanups.push(() => {
      if (db.isOpen) db.close();
    });
    const records = new DaemonRecords({ db });
    expect(cols(db)).toContain('backend');
    // What was there reads as it did; no row is a backend's.
    expect(records.outboundByOperation('host:recent')).toEqual(before('host:recent', ['h1', 'h2'], now));
    expect(['h1', 'h2'].map((id) => records.sentByUs('fake', id))).toEqual([true, true]);
    expect(['h1', 'h2', 'h3'].map((id) => records.backendSent('fake', id))).toEqual([[], [], []]);
    expect((db.prepare('SELECT operation_id AS id, backend FROM daemon_outbound ORDER BY operation_id').all() as { id: string; backend: string | null }[]).map((x) => [x.id, x.backend])).toEqual([['host:recent', null]]);
    // The row past the retention went at open, with its part, as before the column existed.
    expect(records.outboundByOperation('host:stale')).toBeUndefined();
    expect(['h3', 'h4'].map((id) => records.sentByUs('fake', id))).toEqual([false, false]);
    // Both kinds of row can be written and read; replacing a row keeps working (the upsert names the new column).
    records.putOutbound(before('host:next', ['h5'], now));
    records.putOutbound({ ...before('backend:alpha:n1', ['a1', 'a2'], now), sessionKey: 'host:backend:alpha', backend: 'alpha' });
    records.putOutbound({ ...before('host:recent', ['h1', 'h2'], now), result: 'delivered', agent: 'main' });
    expect(records.outboundByOperation('host:next')).toEqual(before('host:next', ['h5'], now));
    expect('backend' in records.outboundByOperation('host:recent')!).toBe(false);
    expect(records.outboundByOperation('host:recent')).toMatchObject({ agent: 'main' });
    expect(['a1', 'a2', 'h5'].map((id) => records.backendSent('fake', id))).toEqual([[{ backend: 'alpha', route }], [{ backend: 'alpha', route }], []]);
    db.close();
    // Opening it again changes nothing more.
    const again = new DatabaseSync(path);
    cleanups.push(() => {
      if (again.isOpen) again.close();
    });
    const second = new DaemonRecords({ db: again });
    expect(cols(again).filter((c) => c === 'backend')).toHaveLength(1);
    expect(second.backendSent('fake', 'a2')).toEqual([{ backend: 'alpha', route }]);
    expect(second.outboundByOperation('host:recent')).toMatchObject({ result: 'delivered' });
  });

  it('a database from before read keys opens as it is: its stored key is a read-write key; a read key is kept in a table of its own, so the older table never holds one and reads back unchanged once the read key is removed #RS-1 #PB-3 #PB-7', () => {
    const path = join(tmp('aio-rec-keys-'), 'log.db');
    // The key table as it was when a backend had one key (and nothing else of the daemon's).
    const old = new DatabaseSync(path);
    cleanups.push(() => {
      if (old.isOpen) old.close();
    });
    const OLD_TABLE = 'CREATE TABLE daemon_backend_keys (backend TEXT PRIMARY KEY, hash TEXT NOT NULL, created_at INTEGER NOT NULL) WITHOUT ROWID';
    // What a daemon from before read keys runs against the table (it prepares these when it opens the database).
    const OLD_SELECT = 'SELECT backend, hash, created_at FROM daemon_backend_keys ORDER BY backend';
    const OLD_UPSERT = 'INSERT INTO daemon_backend_keys (backend, hash, created_at) VALUES (?, ?, ?) ON CONFLICT(backend) DO UPDATE SET hash = excluded.hash, created_at = excluded.created_at';
    const OLD_DELETE = 'DELETE FROM daemon_backend_keys WHERE backend = ?';
    old.exec(OLD_TABLE);
    const [rw, rd, rd2, betaRead] = ['a', 'b', 'c', 'd'].map((x) => x.repeat(64));
    old.prepare(OLD_UPSERT).run('alpha', rw, 111);
    old.close();

    const db = new DatabaseSync(path);
    cleanups.push(() => {
      if (db.isOpen) db.close();
    });
    const schema = () => (db.prepare("SELECT sql FROM sqlite_master WHERE name = 'daemon_backend_keys'").get() as { sql: string }).sql;
    const olderTable = () => db.prepare(OLD_SELECT).all() as { backend: string; hash: string; created_at: number }[];
    const records = new DaemonRecords({ db });
    // Opened as it is: the table is not rebuilt and gains no column, and its key is a read-write key.
    expect(schema()).toBe(OLD_TABLE);
    const before = olderTable();
    expect(before).toEqual([{ backend: 'alpha', hash: rw, created_at: 111 }]);
    expect(records.backendKeys()).toEqual([{ backend: 'alpha', access: 'readwrite', hash: rw, createdAt: 111 }]);

    // A read key, replaced once, and one of a backend that has no read-write key: none of them is a row of the older table.
    records.putBackendKey('alpha', rd, 222, 'read');
    records.putBackendKey('alpha', rd2, 333, 'read');
    records.putBackendKey('beta', betaRead, 444, 'read');
    expect(records.backendKeys()).toEqual([
      { backend: 'alpha', access: 'read', hash: rd2, createdAt: 333 },
      { backend: 'alpha', access: 'readwrite', hash: rw, createdAt: 111 },
      { backend: 'beta', access: 'read', hash: betaRead, createdAt: 444 },
    ]);
    expect(olderTable()).toEqual(before);
    expect(JSON.stringify(olderTable())).not.toContain(rd2);
    expect(db.prepare('SELECT backend, access, hash, created_at FROM daemon_backend_access_keys ORDER BY backend').all()).toEqual([
      { backend: 'alpha', access: 'read', hash: rd2, created_at: 333 },
      { backend: 'beta', access: 'read', hash: betaRead, created_at: 444 },
    ]);
    // A level this version does not know, written by whatever: not a key at all.
    db.prepare('INSERT INTO daemon_backend_access_keys (backend, access, hash, created_at) VALUES (?, ?, ?, ?)').run('alpha', 'admin', 'e'.repeat(64), 555);
    expect(records.backendKeys().map((k) => [k.backend, k.access])).toEqual([['alpha', 'read'], ['alpha', 'readwrite'], ['beta', 'read']]);

    // Each level is removed on its own; the older table reads back as it was once the read keys are gone.
    expect(records.delBackendKey('alpha', 'read')).toBe(true);
    expect(records.delBackendKey('alpha', 'read')).toBe(false);
    expect(records.backendKeys().map((k) => [k.backend, k.access])).toEqual([['alpha', 'readwrite'], ['beta', 'read']]);
    expect(olderTable()).toEqual(before);
    expect(schema()).toBe(OLD_TABLE);
    // The default level is the read-write key, in the older table, as before.
    records.putBackendKey('beta', 'f'.repeat(64), 666);
    expect(olderTable()).toEqual([...before, { backend: 'beta', hash: 'f'.repeat(64), created_at: 666 }]);
    expect(records.delBackendKey('beta', 'readwrite')).toBe(true);
    expect(records.backendKeys().map((k) => [k.backend, k.access])).toEqual([['alpha', 'readwrite'], ['beta', 'read']]);
    // Without a level: both.
    records.putBackendKey('alpha', rd, 777, 'read');
    expect(records.delBackendKey('alpha')).toBe(true);
    expect(records.backendKeys().map((k) => [k.backend, k.access])).toEqual([['beta', 'read']]);
    expect(records.delBackendKey('beta')).toBe(true);
    expect(records.delBackendKey('beta')).toBe(false);
    expect(records.backendKeys()).toEqual([]);

    // What an older daemon does with this database still works: its statements prepare and run against the table.
    db.prepare(OLD_UPSERT).run('alpha', rw, 111);
    db.prepare(OLD_UPSERT).run('alpha', rw, 112);
    expect(db.prepare(OLD_SELECT).all()).toEqual([{ backend: 'alpha', hash: rw, created_at: 112 }]);
    expect(Number(db.prepare(OLD_DELETE).run('alpha').changes)).toBe(1);
  });
});
