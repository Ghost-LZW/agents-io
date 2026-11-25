import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { fakeEnvelope } from '@agents-io/testkit';
import type { ContentBlock, InboundItem } from '@agents-io/protocol';
import { HostQueue, channelRefOf } from '../src/index.js';
import { until } from './helpers.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

let n = 0;
function item(id = `m${++n}`): Omit<InboundItem, 'cursor'> {
  const env = fakeEnvelope({ id, text: `text ${id}`, raw: { big: 'payload' } });
  return {
    channelRef: channelRefOf(env),
    account: env.account,
    bindingId: 'to-host',
    input: { inputId: `in_${id}`, origin: { kind: 'human', principal: null, evidence: 'platform_signed', via: 'fake:default:c1', adapter: 'fake' }, content: env.content, replyRoute: env.replyRoute, channelContext: {} },
    envelope: env,
    receivedAt: 1,
  };
}

/** An item routed to a backend (`to`), from conversation `conv`, optionally a reply to / click on `replyTo`. */
function targeted(to: string, id: string, conv = 'c1', replyTo?: string): Omit<InboundItem, 'cursor'> {
  const env = fakeEnvelope({ id, text: `text ${id}`, conversation: { id: conv, kind: 'group' }, replyRoute: { channel: 'fake', account: 'default', conversationId: conv, ...(replyTo ? { replyToMessageId: replyTo } : {}) } });
  return { ...item(id), channelRef: channelRefOf(env), envelope: env, input: { ...item(id).input, replyRoute: env.replyRoute }, to };
}

function tmpDb(): string {
  const dir = mkdtempSync(join(tmpdir(), 'aio-hq-'));
  dirs.push(dir);
  return join(dir, 'q.sqlite');
}

describe('HostQueue', () => {
  it('dedups per account: the same message id on another bot account is a different message #HQ-2', () => {
    const q = new HostQueue();
    const a = item('same-id');
    expect(q.append(a)).toEqual({ cursor: 1, duplicate: false });
    expect(q.append({ ...a, account: 'second-bot' })).toEqual({ cursor: 2, duplicate: false });
    expect(q.append({ ...a })).toEqual({ cursor: 1, duplicate: true });
  });

  it('appends idempotently on the channel reference: a redelivery returns the first cursor #HQ-2', async () => {
    const q = new HostQueue();
    const a = item('same');
    expect(q.append(a)).toEqual({ cursor: 1, duplicate: false });
    expect(q.append(item('other'))).toEqual({ cursor: 2, duplicate: false });
    expect(q.append({ ...a, bindingId: 'again' })).toEqual({ cursor: 1, duplicate: true });
    const items = await q.read('xwo');
    expect(items.map((i) => [i.cursor, i.channelRef])).toEqual([
      [1, 'channel:fake/same'],
      [2, 'channel:fake/other'],
    ]);
    // The envelope is stored without `raw`.
    expect('raw' in items[0]!.envelope).toBe(false);
    q.close();
  });

  it('keeps one cursor per consumer; ack only moves forward; read after an explicit cursor #HQ-1', async () => {
    const q = new HostQueue();
    for (let i = 0; i < 4; i++) q.append(item());
    expect((await q.read('a', { limit: 2 })).map((i) => i.cursor)).toEqual([1, 2]);
    expect(q.ack('a', 2)).toBe(2);
    expect((await q.read('a')).map((i) => i.cursor)).toEqual([3, 4]);
    expect(q.ack('a', 1)).toBe(2); // never back
    expect((await q.read('b')).map((i) => i.cursor)).toEqual([1, 2, 3, 4]); // another consumer, its own cursor
    expect((await q.read('a', { after: 3 })).map((i) => i.cursor)).toEqual([4]);
    expect(q.ack('a', 99)).toBe(4); // clipped to the head
    q.close();
  });

  it('long-polls: read waits for the next append, or returns empty after waitMs #HQ-1', async () => {
    const q = new HostQueue();
    const t0 = Date.now();
    expect(await q.read('a', { waitMs: 40 })).toEqual([]);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(35);
    const pending = q.read('a', { waitMs: 5000 });
    setTimeout(() => q.append(item('late')), 20);
    const got = await pending;
    expect(got.map((i) => i.channelRef)).toEqual(['channel:fake/late']);
    q.close();
  });

  it('push: delivers in order and acks what the consumer accepts; retries a refusal #HQ-1', async () => {
    const q = new HostQueue();
    q.append(item('p1'));
    const got: string[] = [];
    let refuseOnce = true;
    const sub = q.subscribe(
      'xwo',
      async (i) => {
        got.push(i.channelRef);
        if (i.channelRef.endsWith('p2') && refuseOnce) {
          refuseOnce = false;
          return false;
        }
        return true;
      },
      { retryMs: 10 },
    );
    q.append(item('p2'));
    q.append(item('p3'));
    await until(() => q.cursor('xwo') === 3);
    expect(got).toEqual(['channel:fake/p1', 'channel:fake/p2', 'channel:fake/p2', 'channel:fake/p3']);
    sub.close();
    await sub.done;
    q.close();
  });

  it('push: unacked items are redelivered after a reconnect (at least once), also across a restart #HQ-1 #RS-1', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'aio-hq-')), 'q.sqlite');
    dirs.push(join(path, '..'));
    const one = new HostQueue({ path });
    one.append(item('r1'));
    one.append(item('r2'));
    // The first connection takes r1, then hangs on r2 and drops.
    let release!: () => void;
    const first: string[] = [];
    const s1 = one.subscribe('xwo', async (i) => {
      first.push(i.channelRef);
      if (i.channelRef.endsWith('r2')) await new Promise<void>((r) => (release = r));
      return i.channelRef.endsWith('r1');
    });
    await until(() => first.length === 2);
    s1.close();
    release();
    await s1.done;
    expect(one.cursor('xwo')).toBe(1);
    // Reconnect in the same process: r2 again.
    const again: string[] = [];
    const s2 = one.subscribe('xwo', (i) => void again.push(i.channelRef));
    await until(() => again.length === 1);
    s2.close();
    await s2.done;
    expect(again).toEqual(['channel:fake/r2']);
    one.append(item('r3'));
    one.close();
    // A restart: the cursor (2) and r3 are on disk.
    const two = new HostQueue({ path });
    const after: string[] = [];
    const s3 = two.subscribe('xwo', (i) => void after.push(i.channelRef));
    await until(() => after.length === 1);
    expect(after).toEqual(['channel:fake/r3']);
    // Still idempotent after the restart.
    expect(two.append(item('r1')).duplicate).toBe(true);
    s3.close();
    await s3.done;
    two.close();
  });

  it('a new subscription for the same consumer replaces the old one #HQ-1', async () => {
    const q = new HostQueue();
    const a = q.subscribe('xwo', () => new Promise(() => {}));
    const b = q.subscribe('xwo', () => true);
    await a.done; // closed by the replacement
    q.append(item());
    await until(() => q.cursor('xwo') === 1);
    b.close();
    await b.done;
    q.close();
  });

  it('retention: deletes only what every known consumer acked, after retainAckedMs #HQ-1', async () => {
    let now = 1_000;
    const q = new HostQueue({ now: () => now, retainAckedMs: 100 });
    for (let i = 0; i < 3; i++) q.append(item(`k${i}`));
    q.cursor('a');
    q.cursor('b');
    q.ack('a', 3);
    now += 1_000;
    expect(q.prune()).toBe(0); // b has acked nothing
    q.ack('b', 2);
    expect((await q.read('c', { after: 0 })).map((i) => i.cursor)).toEqual([3]); // 1 and 2 pruned by b's ack
    // An acked, deleted message is still a duplicate (refs outlive items).
    expect(q.append(item('k0'))).toEqual({ cursor: 1, duplicate: true });
    q.forget('c');
    expect(q.consumers().map((c) => c.name)).toEqual(['a', 'b']);
    q.close();
  });

  it("a targeted consumer sees only its target's items, an untargeted one only untargeted items; cursors are independent over the shared sequence; a targeted ack is clamped to its own head #PB-1 #HQ-1", async () => {
    const q = new HostQueue();
    q.register('backend:alpha', 'alpha');
    q.register('backend:beta', 'beta');
    q.append(targeted('alpha', 'a1')); // 1
    q.append(item('h1')); // 2
    q.append(targeted('beta', 'b1')); // 3
    q.append(targeted('alpha', 'a2')); // 4
    q.append(item('h2')); // 5
    const seen = async (c: string, o = {}) => (await q.read(c, o)).map((x) => [x.cursor, x.to]);
    expect(await seen('backend:alpha')).toEqual([[1, 'alpha'], [4, 'alpha']]);
    expect(await seen('backend:beta')).toEqual([[3, 'beta']]);
    expect(await seen('host')).toEqual([[2, undefined], [5, undefined]]);
    // An explicit cursor does not widen the view either.
    expect(await seen('backend:beta', { after: 0, limit: 100 })).toEqual([[3, 'beta']]);
    expect(await seen('host', { after: 0 })).toEqual([[2, undefined], [5, undefined]]);
    // One sequence, a cursor per consumer.
    expect(q.ack('backend:alpha', 1)).toBe(1);
    expect(await seen('backend:alpha')).toEqual([[4, 'alpha']]);
    expect(q.cursor('backend:beta')).toBe(0);
    expect(q.cursor('host')).toBe(0);
    // A targeted consumer's head is its own last item: it cannot ack past it.
    expect(q.headOf('backend:alpha')).toBe(4);
    expect(q.headOf('backend:beta')).toBe(3);
    expect(q.headOf('host')).toBe(5);
    expect(q.ack('backend:beta', 99)).toBe(3);
    expect(q.ack('backend:alpha', 99)).toBe(4);
    expect(q.ack('backend:alpha', 2)).toBe(4); // never back
    q.append(item('h3')); // 6
    expect(q.headOf('backend:alpha')).toBe(4);
    expect(q.head()).toBe(6);
    // Pending counts follow the same split.
    expect(q.pending(0, 'alpha').count).toBe(2);
    expect(q.pending(4, 'alpha').count).toBe(0);
    expect(q.pending(0).count).toBe(3);
    // Registering again keeps the cursor; `target` shows only where there is one.
    q.register('backend:alpha', 'alpha');
    expect(q.cursor('backend:alpha')).toBe(4);
    expect(q.consumerTarget('backend:alpha')).toBe('alpha');
    expect(q.consumerTarget('host')).toBeUndefined();
    expect(q.consumers().map(({ seen: _seen, ...c }) => c)).toEqual([
      { name: 'backend:alpha', acked: 4, target: 'alpha' },
      { name: 'backend:beta', acked: 3, target: 'beta' },
      { name: 'host', acked: 0 },
    ]);
    // A long-poll of one target is not answered by another's item.
    const waiting = q.read('backend:beta', { waitMs: 60 });
    q.append(targeted('alpha', 'a3'));
    expect(await waiting).toEqual([]);
    q.close();
  });

  it("the same message queued for two targets is one item each; a redelivery returns each target's first cursor #HQ-2 #PB-1", async () => {
    const q = new HostQueue();
    q.register('backend:alpha', 'alpha');
    q.register('backend:beta', 'beta');
    expect(q.append(targeted('alpha', 'same'))).toEqual({ cursor: 1, duplicate: false });
    expect(q.append(targeted('beta', 'same'))).toEqual({ cursor: 2, duplicate: false });
    // The untargeted copy of the same message is a third item, keyed as before.
    expect(q.append(item('same'))).toEqual({ cursor: 3, duplicate: false });
    expect(q.append(targeted('alpha', 'same'))).toEqual({ cursor: 1, duplicate: true });
    expect(q.append(targeted('beta', 'same'))).toEqual({ cursor: 2, duplicate: true });
    expect(q.append(item('same'))).toEqual({ cursor: 3, duplicate: true });
    // Per account, as without a target.
    expect(q.append({ ...targeted('alpha', 'same'), account: 'second-bot' })).toEqual({ cursor: 4, duplicate: false });
    expect((await q.read('backend:alpha')).map((x) => x.cursor)).toEqual([1, 4]);
    expect((await q.read('backend:beta')).map((x) => x.cursor)).toEqual([2]);
    expect((await q.read('host')).map((x) => x.cursor)).toEqual([3]);
    q.close();
  });

  it("push to a targeted consumer skips other targets' items and redelivers its own unacked ones after a restart #HQ-1 #PB-1 #RS-1", async () => {
    const path = tmpDb();
    const one = new HostQueue({ path });
    one.register('backend:alpha', 'alpha');
    one.register('backend:beta', 'beta');
    one.append(targeted('beta', 'b1')); // 1
    one.append(targeted('alpha', 'a1')); // 2
    one.append(item('h1')); // 3
    one.append(targeted('alpha', 'a2')); // 4
    const first: string[] = [];
    const s1 = one.subscribe('backend:alpha', (i) => {
      first.push(i.channelRef);
      return i.channelRef.endsWith('a1'); // a2 is refused: stays unacked
    }, { retryMs: 5 });
    await until(() => first.length >= 2);
    s1.close();
    await s1.done;
    expect(new Set(first)).toEqual(new Set(['channel:fake/a1', 'channel:fake/a2']));
    expect(one.cursor('backend:alpha')).toBe(2);
    expect(one.cursor('backend:beta')).toBe(0);
    one.append(targeted('beta', 'b2')); // 5
    one.close();
    // A restart: targets, cursors and items are on disk.
    const two = new HostQueue({ path });
    expect(two.consumerTarget('backend:alpha')).toBe('alpha');
    const again: string[] = [];
    const s2 = two.subscribe('backend:alpha', (i) => void again.push(i.channelRef));
    const others: string[] = [];
    const s3 = two.subscribe('backend:beta', (i) => void others.push(i.channelRef));
    const plain: string[] = [];
    const s4 = two.subscribe('host', (i) => void plain.push(i.channelRef));
    await until(() => again.length === 1 && others.length === 2 && plain.length === 1);
    two.append(targeted('alpha', 'a3'));
    await until(() => again.length === 2);
    expect(again).toEqual(['channel:fake/a2', 'channel:fake/a3']);
    expect(others).toEqual(['channel:fake/b1', 'channel:fake/b2']);
    expect(plain).toEqual(['channel:fake/h1']);
    for (const s of [s2, s3, s4]) {
      s.close();
      await s.done;
    }
    two.close();
  });

  it('retention: a targeted item goes once its own consumer acked it; untargeted items ignore targeted consumers #HQ-1', async () => {
    let now = 1_000;
    const q = new HostQueue({ now: () => now, retainAckedMs: 100 });
    q.register('backend:alpha', 'alpha');
    q.register('backend:beta', 'beta');
    q.append(targeted('alpha', 'a1')); // 1
    q.append(item('h1')); // 2
    q.append(targeted('beta', 'b1')); // 3
    q.append(item('h2')); // 4
    q.append(targeted('alpha', 'a2')); // 5
    now += 1_000;
    // Only targeted consumers are known: untargeted items stay, as with no consumer at all.
    q.ack('backend:alpha', 1);
    expect(q.get(1)).toBeUndefined(); // alpha acked its own item: gone, though beta and nobody else acked anything
    expect([2, 3, 4, 5].map((c) => q.get(c) !== undefined)).toEqual([true, true, true, true]);
    // The host acks its items: they go although the backends are behind.
    q.ack('host', 4);
    expect([2, 3, 4, 5].map((c) => q.get(c) !== undefined)).toEqual([false, true, false, true]);
    // beta's item waits for beta, not for alpha or the host.
    q.ack('backend:alpha', 5);
    expect([3, 5].map((c) => q.get(c) !== undefined)).toEqual([true, false]);
    q.ack('backend:beta', 3);
    expect(q.get(3)).toBeUndefined();
    // A deleted targeted item is still a duplicate for its target.
    expect(q.append(targeted('alpha', 'a1'))).toEqual({ cursor: 1, duplicate: true });
    // A target nobody consumes keeps its items.
    q.append(targeted('gamma', 'g1')); // 6
    now += 1_000;
    q.ack('host', 6);
    q.ack('backend:alpha', 6);
    expect(q.get(6)).toBeDefined();
    // Two consumers of one target: its items wait for the slower of the two, and for nobody else.
    q.register('backend:gamma', 'gamma');
    q.register('mirror:gamma', 'gamma');
    q.ack('backend:gamma', 6);
    expect(q.get(6)).toBeDefined();
    q.ack('mirror:gamma', 6);
    expect(q.get(6)).toBeUndefined();
    q.close();
  });

  it('a database from before gains the target columns; its items and cursors read as before #RS-1', async () => {
    const path = tmpDb();
    // The tables as they were before items and consumers could carry a target.
    const old = new DatabaseSync(path);
    old.exec(`
      CREATE TABLE host_inbound (cursor INTEGER PRIMARY KEY AUTOINCREMENT, channel_ref TEXT NOT NULL, at INTEGER NOT NULL, json TEXT NOT NULL);
      CREATE TABLE host_inbound_refs (channel_ref TEXT PRIMARY KEY, cursor INTEGER NOT NULL, at INTEGER NOT NULL) WITHOUT ROWID;
      CREATE TABLE host_consumers (name TEXT PRIMARY KEY, acked INTEGER NOT NULL, seen INTEGER NOT NULL);
      CREATE TABLE host_redispatch (cursor INTEGER PRIMARY KEY, at INTEGER NOT NULL, json TEXT NOT NULL);
    `);
    const put = old.prepare('INSERT INTO host_inbound (channel_ref, at, json) VALUES (?, ?, ?)');
    for (const id of ['o1', 'o2', 'o3']) {
      const { envelope: { raw: _raw, ...envelope }, ...rest } = item(id);
      const cursor = Number(put.run(rest.channelRef, 1, JSON.stringify({ ...rest, envelope })).lastInsertRowid);
      old.prepare('INSERT INTO host_inbound_refs (channel_ref, cursor, at) VALUES (?, ?, ?)').run(`${rest.account}\n${rest.channelRef}`, cursor, 1);
    }
    old.prepare('INSERT INTO host_consumers (name, acked, seen) VALUES (?, ?, ?)').run('xwo', 1, 1);
    old.close();

    const q = new HostQueue({ path });
    const cols = (t: string) => (q.db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);
    expect(cols('host_inbound')).toContain('target');
    expect(cols('host_consumers')).toContain('target');
    expect(q.consumers().map(({ seen: _seen, ...c }) => c)).toEqual([{ name: 'xwo', acked: 1 }]);
    expect(q.cursor('xwo')).toBe(1);
    expect(q.head()).toBe(3);
    expect((await q.read('xwo')).map((i) => [i.cursor, i.channelRef, i.to])).toEqual([
      [2, 'channel:fake/o2', undefined],
      [3, 'channel:fake/o3', undefined],
    ]);
    expect(q.append(item('o1'))).toEqual({ cursor: 1, duplicate: true });
    // The old items are nobody's target.
    q.register('backend:alpha', 'alpha');
    expect(await q.read('backend:alpha')).toEqual([]);
    expect(q.append(targeted('alpha', 'n1'))).toEqual({ cursor: 4, duplicate: false });
    expect(q.ack('xwo', 99)).toBe(4);
    q.close();
    // Opening it again changes nothing more.
    const again = new HostQueue({ path });
    expect(again.cursor('xwo')).toBe(4);
    expect((await again.read('backend:alpha')).map((i) => i.cursor)).toEqual([4]);
    again.close();
  });

  it("appending a targeted item records its reply route's conversation, its message id and the reply target for the target in the same transaction; untargeted items record none; a click on the target's own message grants no conversation; message grants lapse after their TTL, conversation grants do not, also across a restart #PB-2 #RS-1", () => {
    const DAY = 86_400_000;
    let now = 1_000;
    const path = tmpDb();
    const q = new HostQueue({ path, now: () => now });
    const at = (conversationId: string, account = 'default', channel = 'fake') => ({ channel, account, conversationId });
    q.register('backend:alpha', 'alpha');
    q.append(targeted('alpha', 'm1', 'room')); // a message
    q.append(targeted('alpha', 'card:9', 'room', 'om_card')); // a click: the reply target is the message
    q.append(item('plain')); // conversation c1, no target
    q.append(targeted('beta', 'm2', 'other'));
    // No reply route: nothing to grant, the item is queued all the same.
    expect(q.append({ ...targeted('alpha', 'm3', 'nowhere'), input: { ...targeted('alpha', 'm3', 'nowhere').input, replyRoute: null } }).duplicate).toBe(false);
    // A click on a message the target sent itself (`grantConversation: false`): its messages, not the conversation.
    expect(q.append(targeted('alpha', 'card:10', 'lobby', 'om_own'), { grantConversation: false }).duplicate).toBe(false);
    expect(q.granted('alpha', at('lobby'))).toBe(false);
    expect(q.grantedMessage('alpha', { ...at('lobby'), messageId: 'om_own' })).toBe(true);
    expect(q.grantedMessage('alpha', { ...at('lobby'), messageId: 'card:10' })).toBe(true);

    expect(q.granted('alpha', at('room'))).toBe(true);
    expect(q.granted('alpha', at('other'))).toBe(false); // beta's
    expect(q.granted('alpha', at('c1'))).toBe(false); // an untargeted item grants nobody
    expect(q.granted('alpha', at('nowhere'))).toBe(false);
    expect(q.granted('alpha', at('room', 'second-bot'))).toBe(false); // another account
    expect(q.granted('alpha', at('room', 'default', 'elsewhere'))).toBe(false); // another channel
    expect(q.granted('beta', at('room'))).toBe(false);
    expect(q.granted('beta', at('other'))).toBe(true);
    expect(q.grantCount('alpha')).toBe(1);
    expect(q.grantCount('beta')).toBe(1);
    expect(q.grantCount('gamma')).toBe(0);

    const msg = (target: string, messageId: string, conversationId = 'room') => q.grantedMessage(target, { ...at(conversationId), messageId });
    expect(msg('alpha', 'm1')).toBe(true);
    expect(msg('alpha', 'card:9')).toBe(true);
    expect(msg('alpha', 'om_card')).toBe(true);
    expect(msg('alpha', 'm1', 'other')).toBe(false); // the message is not in that conversation
    expect(msg('alpha', 'm2', 'other')).toBe(false); // beta received it
    expect(msg('alpha', 'plain', 'c1')).toBe(false);
    expect(msg('beta', 'm1')).toBe(false);
    expect(msg('beta', 'm2', 'other')).toBe(true);
    expect(q.grantedMessage('alpha', { ...at('room', 'second-bot'), messageId: 'm1' })).toBe(false);

    // The same transaction as the item: when the item's insert fails, no grant is left behind.
    q.db.exec("CREATE TRIGGER fail_msgs BEFORE INSERT ON host_route_msgs WHEN NEW.message_id = 'boom' BEGIN SELECT RAISE(ABORT, 'no'); END");
    const head = q.head();
    expect(() => q.append(targeted('alpha', 'boom', 'fresh'))).toThrow();
    expect(q.granted('alpha', at('fresh'))).toBe(false);
    expect(q.pending(head, 'alpha').count).toBe(0);
    q.db.exec('DROP TRIGGER fail_msgs');
    expect(q.append(targeted('alpha', 'boom', 'fresh')).duplicate).toBe(false); // nor an idempotency key

    // A redelivery adds nothing and changes nothing.
    expect(q.append(targeted('alpha', 'm1', 'room')).duplicate).toBe(true);
    expect(q.grantCount('alpha')).toBe(2);

    // 30 days on, the messages are no longer its to reply to; the conversations still are. Also after a restart.
    now += 29 * DAY;
    expect(msg('alpha', 'm1')).toBe(true);
    q.close();
    const two = new HostQueue({ path, now: () => now });
    expect(two.granted('alpha', at('room'))).toBe(true);
    expect(two.grantedMessage('alpha', { ...at('room'), messageId: 'om_card' })).toBe(true);
    now += 2 * DAY;
    expect(two.grantedMessage('alpha', { ...at('room'), messageId: 'm1' })).toBe(false);
    expect(two.grantedMessage('alpha', { ...at('room'), messageId: 'om_card' })).toBe(false);
    two.prune();
    expect((two.db.prepare('SELECT COUNT(*) AS n FROM host_route_msgs').get() as { n: number }).n).toBe(0);
    expect(two.granted('alpha', at('room'))).toBe(true);
    expect(two.granted('beta', at('other'))).toBe(true);
    // A message received again counts from then.
    two.append(targeted('alpha', 'm9', 'room', 'om_card'));
    expect(two.grantedMessage('alpha', { ...at('room'), messageId: 'om_card' })).toBe(true);
    two.close();

    // A shorter TTL is an option.
    const short = new HostQueue({ now: () => now, grantMsgTtlMs: 10 });
    short.append(targeted('alpha', 's1', 'room'));
    now += 11;
    expect(short.grantedMessage('alpha', { ...at('room'), messageId: 's1' })).toBe(false);
    expect(short.granted('alpha', at('room'))).toBe(true);
    short.close();
  });

  it("appending a targeted item grants its target the refs of the image, file and audio blocks of its input and envelope content, in the same transaction; an untargeted item grants none; a ref in text, in a quote, in an event's data, in a ref block's uri or as a stray field of another block grants none #PB-6", () => {
    const q = new HostQueue();
    q.register('backend:alpha', 'alpha');
    const R = (c: string) => `sha256:${c.repeat(64)}`;
    const base = targeted('alpha', 'm-media', 'room');
    // The envelope's content and the input's content may differ (the input's is what the turn would get): both count.
    const envelopeContent: ContentBlock[] = [
      { type: 'text', text: `see ${R('9')}` },
      { type: 'image', ref: R('1'), mime: 'image/png' },
      { type: 'file', ref: R('2'), mime: 'application/pdf', name: 'a.pdf' },
      { type: 'quote', text: `an older picture ${R('8')}`, fromMessageId: 'm0' },
      { type: 'event', name: 'action', data: { ref: R('7'), image: { type: 'image', ref: R('7') } } },
      { type: 'ref', uri: R('6'), mime: 'image/png' },
      // A stray top-level `ref` on a block that carries no blob (the schema does not forbid one).
      { type: 'text', text: 'x', ref: R('5') } as unknown as ContentBlock,
      { type: 'image', ref: 'platform-file:abc', mime: 'image/png' },
    ];
    const inputContent: ContentBlock[] = [{ type: 'audio', ref: R('3'), mime: 'audio/ogg' }, { type: 'image', ref: R('1'), mime: 'image/png' }];
    q.append({ ...base, envelope: { ...base.envelope, content: envelopeContent }, input: { ...base.input, content: inputContent } });
    for (const c of ['1', '2', '3']) expect(q.grantedBlob('alpha', R(c))).toBe(true);
    // A platform ref in a media block is the item's media too (it has no bytes here; it may be attached).
    expect(q.grantedBlob('alpha', 'platform-file:abc')).toBe(true);
    for (const c of ['5', '6', '7', '8', '9']) expect(q.grantedBlob('alpha', R(c))).toBe(false);
    expect((q.db.prepare('SELECT ref FROM host_blob_grants WHERE target = ? ORDER BY ref').all('alpha') as { ref: string }[]).map((r) => r.ref)).toEqual(['platform-file:abc', R('1'), R('2'), R('3')]);

    // An item without a reply route, and a click that grants no conversation, grant their media all the same.
    const lone = targeted('alpha', 'm-lone', 'nowhere');
    q.append({ ...lone, envelope: { ...lone.envelope, content: [{ type: 'file', ref: R('a'), mime: 'text/plain' }] }, input: { ...lone.input, replyRoute: null } });
    const click = targeted('alpha', 'card:1', 'lobby', 'om_own');
    q.append({ ...click, envelope: { ...click.envelope, content: [{ type: 'image', ref: R('b'), mime: 'image/png' }] } }, { grantConversation: false });
    expect(q.grantedBlob('alpha', R('a'))).toBe(true);
    expect(q.grantedBlob('alpha', R('b'))).toBe(true);
    expect(q.granted('alpha', { channel: 'fake', account: 'default', conversationId: 'lobby' })).toBe(false);

    // An item without a target grants nobody, whatever it carries.
    const plain = item('plain-media');
    q.append({ ...plain, envelope: { ...plain.envelope, content: [{ type: 'image', ref: R('c'), mime: 'image/png' }] }, input: { ...plain.input, content: [{ type: 'image', ref: R('c'), mime: 'image/png' }] } });
    expect(q.grantedBlob('alpha', R('c'))).toBe(false);
    expect(q.db.prepare('SELECT COUNT(*) AS n FROM host_blob_grants WHERE ref = ?').get(R('c'))).toEqual({ n: 0 });
    q.close();
  });

  it("a media grant is its target's alone: the same message queued for two targets grants each, another target has none; it lapses after the TTL, survives a restart and goes with forgetTarget; a failed append leaves none #PB-6 #RS-1", () => {
    const DAY = 86_400_000;
    let now = 1_000;
    const path = tmpDb();
    const q = new HostQueue({ path, now: () => now });
    const R = (c: string) => `sha256:${c.repeat(64)}`;
    const media = (to: string, id: string, ...refs: string[]) => {
      const t = targeted(to, id, 'room');
      const content: ContentBlock[] = refs.map((ref) => ({ type: 'image', ref, mime: 'image/png' }));
      return { ...t, envelope: { ...t.envelope, content }, input: { ...t.input, content } };
    };
    for (const id of ['alpha', 'beta', 'gamma']) q.register(`backend:${id}`, id);
    q.append(media('alpha', 'm1', R('1'), R('2')));
    q.append(media('beta', 'm1', R('1'))); // the same message, routed to beta as well, with one of the two
    q.append(media('beta', 'm2', R('3')));
    const view = (target: string) => ['1', '2', '3'].filter((c) => q.grantedBlob(target, R(c)));
    expect(view('alpha')).toEqual(['1', '2']);
    expect(view('beta')).toEqual(['1', '3']);
    expect(view('gamma')).toEqual([]);
    expect(q.grantedBlob('', R('1'))).toBe(false);

    // The same transaction as the item: when the append fails, no media grant is left behind.
    q.db.exec("CREATE TRIGGER fail_trefs BEFORE INSERT ON host_inbound_trefs WHEN NEW.channel_ref LIKE '%boom' BEGIN SELECT RAISE(ABORT, 'no'); END");
    const head = q.head();
    expect(() => q.append(media('gamma', 'boom', R('4')))).toThrow();
    q.db.exec('DROP TRIGGER fail_trefs');
    q.db.exec("CREATE TRIGGER fail_blobs BEFORE INSERT ON host_blob_grants WHEN NEW.ref = 'sha256:" + '5'.repeat(64) + "' BEGIN SELECT RAISE(ABORT, 'no'); END");
    expect(() => q.append(media('gamma', 'boom2', R('4'), R('5')))).toThrow();
    q.db.exec('DROP TRIGGER fail_blobs');
    expect(q.grantedBlob('gamma', R('4'))).toBe(false);
    expect(q.pending(0, 'gamma').count).toBe(0);
    expect(q.head()).toBe(head);

    // Across a restart.
    q.close();
    const again = new HostQueue({ path, now: () => now });
    const view2 = (target: string) => ['1', '2', '3'].filter((c) => again.grantedBlob(target, R(c)));
    expect(view2('alpha')).toEqual(['1', '2']);
    expect(view2('beta')).toEqual(['1', '3']);

    // 30 days: a grant lapses; the same bytes in a later item are granted again from then.
    now += 29 * DAY;
    again.append(media('alpha', 'm9', R('2')));
    now += 2 * DAY;
    expect(view2('alpha')).toEqual(['2']);
    expect(view2('beta')).toEqual([]);
    // The lapsed rows are deleted with the next prune (an ack).
    again.ack('backend:alpha', 0);
    expect((again.db.prepare('SELECT target, ref FROM host_blob_grants ORDER BY target, ref').all() as { target: string; ref: string }[]).map((r) => [r.target, r.ref])).toEqual([['alpha', R('2')]]);

    // forgetTarget takes a target's media grants and nobody else's.
    again.append(media('beta', 'm10', R('2')));
    again.forgetTarget('alpha');
    expect(again.grantedBlob('alpha', R('2'))).toBe(false);
    expect(again.grantedBlob('beta', R('2'))).toBe(true);
    again.close();
  });

  it("forgetTarget removes the target's items, cursor and grants and nothing of others #PB-2 #PB-1", async () => {
    const q = new HostQueue();
    q.register('backend:alpha', 'alpha');
    q.register('backend:beta', 'beta');
    q.append(targeted('alpha', 'a1', 'room')); // 1
    q.append(targeted('beta', 'b1', 'room')); // 2
    q.append(item('h1')); // 3
    q.append(targeted('alpha', 'a2', 'second')); // 4
    q.ack('backend:alpha', 1);
    q.ack('backend:beta', 2);
    q.ack('host', 3);
    // A push that holds an item when the target is forgotten is closed and does not bring the consumer back.
    let release!: () => void;
    let held = false;
    const sub = q.subscribe('backend:alpha', async () => {
      held = true;
      await new Promise<void>((r) => (release = r));
      return true;
    });
    await until(() => held);

    expect(q.forgetTarget('alpha')).toEqual({ items: 2, routes: 2 });
    release();
    await sub.done;
    expect(q.consumers().map(({ seen: _seen, ...c }) => c)).toEqual([
      { name: 'backend:beta', acked: 2, target: 'beta' },
      { name: 'host', acked: 3 },
    ]);
    expect(q.pending(0, 'alpha').count).toBe(0);
    expect(q.get(1)).toBeUndefined();
    expect(q.get(4)).toBeUndefined();
    expect(q.grantCount('alpha')).toBe(0);
    expect(q.granted('alpha', { channel: 'fake', account: 'default', conversationId: 'room' })).toBe(false);
    expect(q.grantedMessage('alpha', { channel: 'fake', account: 'default', conversationId: 'room', messageId: 'a1' })).toBe(false);
    // Others keep everything.
    expect(q.get(2)).toBeDefined();
    expect(q.get(3)).toBeDefined();
    expect(q.granted('beta', { channel: 'fake', account: 'default', conversationId: 'room' })).toBe(true);
    expect(q.grantedMessage('beta', { channel: 'fake', account: 'default', conversationId: 'room', messageId: 'b1' })).toBe(true);
    expect(q.append(targeted('beta', 'b1', 'room'))).toEqual({ cursor: 2, duplicate: true });
    expect(q.append(item('h1'))).toEqual({ cursor: 3, duplicate: true });
    // The id starts over: the same message is a new item, the cursor starts at 0.
    expect(q.append(targeted('alpha', 'a1', 'room'))).toEqual({ cursor: 5, duplicate: false });
    q.register('backend:alpha', 'alpha');
    expect(q.cursor('backend:alpha')).toBe(0);
    expect((await q.read('backend:alpha')).map((x) => x.cursor)).toEqual([5]);
    // Forgetting a target nothing was kept for is a no-op.
    expect(q.forgetTarget('gamma')).toEqual({ items: 0, routes: 0 });
    // A row under a target's consumer name that walks no target (from before targets) goes when asked for by name; nobody else's does.
    q.cursor('backend:gamma');
    expect(q.forgetTarget('gamma')).toEqual({ items: 0, routes: 0 });
    expect(q.consumers().map((c) => c.name)).toEqual(['backend:alpha', 'backend:beta', 'backend:gamma', 'host']);
    expect(q.forgetTarget('gamma', { consumer: 'backend:gamma' })).toEqual({ items: 0, routes: 0 });
    expect(q.consumers().map((c) => [c.name, c.target])).toEqual([['backend:alpha', 'alpha'], ['backend:beta', 'beta'], ['host', undefined]]);
    q.close();
  });

  it('peek shows a target\'s items after a cursor and long-polls like read, and writes nothing: no consumer is registered or touched, no cursor moves, and an acked item is pruned whether or not it was peeked; an empty target is refused #PB-7 #HQ-1', async () => {
    let now = 1_000;
    const q = new HostQueue({ now: () => now, retainAckedMs: 100 });
    q.register('backend:alpha', 'alpha');
    q.register('backend:beta', 'beta');
    q.register('host');
    q.append(targeted('alpha', 'a1')); // 1
    q.append(item('h1')); // 2
    q.append(targeted('beta', 'b1')); // 3
    q.append(targeted('alpha', 'a2')); // 4
    q.ack('backend:alpha', 1);
    const consumers = q.consumers();
    const rows = () => (q.db.prepare('SELECT COUNT(*) AS n FROM host_inbound').get() as { n: number }).n;
    const items = rows();
    // Later: a write to a consumer's row would show in `seen`.
    now += 50;

    // Only the target's items, after the cursor given; nothing of another target or of the host.
    expect((await q.peek('alpha', { after: 0 })).map((x) => [x.cursor, x.envelope.id, x.to])).toEqual([[1, 'a1', 'alpha'], [4, 'a2', 'alpha']]);
    expect((await q.peek('alpha', { after: 1 })).map((x) => x.cursor)).toEqual([4]);
    expect((await q.peek('alpha', { after: 0, limit: 1 })).map((x) => x.cursor)).toEqual([1]);
    expect(await q.peek('alpha', { after: 4 })).toEqual([]);
    // A target nobody consumes and one that has no items: empty, and still nobody is registered.
    expect(await q.peek('gamma', { after: 0 })).toEqual([]);
    expect([q.ackedOf('backend:alpha'), q.ackedOf('backend:beta'), q.ackedOf('nobody'), q.ackedOf('backend:gamma')]).toEqual([1, 0, 0, 0]);
    expect([q.targetHead('alpha'), q.targetHead('beta'), q.targetHead('gamma')]).toEqual([4, 3, 0]);
    // The long-poll: empty after waitMs, the next append of the target wakes it, an abort ends it.
    const real = Date.now;
    const live = new HostQueue();
    live.register('backend:alpha', 'alpha');
    const liveConsumers = live.consumers();
    const t0 = real();
    expect(await live.peek('alpha', { after: 0, waitMs: 40 })).toEqual([]);
    expect(real() - t0).toBeGreaterThanOrEqual(35);
    const waiting = live.peek('alpha', { after: 0, waitMs: 5000 });
    setTimeout(() => {
      live.append(targeted('beta', 'late-b'));
      live.append(targeted('alpha', 'late-a'));
    }, 20);
    expect((await waiting).map((x) => x.envelope.id)).toEqual(['late-a']);
    const ac = new AbortController();
    const aborted = live.peek('alpha', { after: 2, waitMs: 5000, signal: ac.signal });
    setTimeout(() => ac.abort(), 20);
    expect(await aborted).toEqual([]);
    await new Promise((r) => setTimeout(r, 5));
    expect(live.consumers()).toEqual(liveConsumers);
    live.close();

    // Nothing was written: the same consumers with the same cursors and the same `seen`, no row more, no item less.
    expect(q.consumers()).toEqual(consumers);
    expect(rows()).toBe(items);
    expect(q.cursor('backend:alpha')).toBe(1);

    // Retention does not know who peeked: what alpha acked goes after retainAckedMs, peeked (1) or not (4);
    // beta's item, which nobody acked, stays although alpha's observer never looked at it.
    now += 1_000;
    q.ack('backend:alpha', 4);
    expect([1, 3, 4].map((c) => q.get(c) !== undefined)).toEqual([false, true, false]);
    expect(await q.peek('alpha', { after: 0 })).toEqual([]);
    expect((await q.peek('beta', { after: 0 })).map((x) => x.cursor)).toEqual([3]);
    expect(q.targetHead('alpha')).toBe(0);

    // No target is not "the items without one" (the host's backlog): refused, and item 2 is never shown.
    await expect(q.peek('', { after: 0 })).rejects.toThrow('target is empty');
    await expect(q.peek(undefined as never, { after: 0 })).rejects.toThrow('target is empty');
    expect(q.consumers().map((c) => c.name)).toEqual(['backend:alpha', 'backend:beta', 'host']);
    q.close();
  });
});
