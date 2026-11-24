import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SendResult } from '@agents-io/protocol';
import { Hub, Outbox, SqliteSessionLog, type Delivery } from '@agents-io/session';
import { DaemonRecords } from '../src/records.js';
import { cleanups, tmp } from './helpers.js';

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
});
