import { describe, expect, it } from 'vitest';
import { ServerFrame, check, type ClientResultFrame, type SessionEvent } from '@agents-io/protocol';
import { SqliteSessionLog } from '@agents-io/session';
import type { FakeTurnScript } from '@agents-io/testkit';
import type { OpReceipt } from '../src/client-ops.js';
import { FEATURES } from '../src/host.js';
import { daemon, until, type World } from './helpers.js';

/*
 * Client op receipts (feature client.opId, INVARIANTS PR-3): a frame with `opId` acts once per
 * (principal, opId); its answer is kept with the event that decided it, and a retry (another
 * connection, a restart) gets that answer back with `replayed: true`.
 */

const textOf = (inputs: { content: { type: string; text?: string }[] }[]) => inputs.flatMap((i) => i.content).map((c) => c.text ?? '').join('+');
/** Echoes; a turn whose text starts with "long" runs until it is interrupted. */
const script: FakeTurnScript = async (t) => {
  if (textOf(t.inputs).startsWith('long')) await new Promise((_, rej) => t.signal.addEventListener('abort', () => rej(new Error('stop')), { once: true }));
  t.emit({ t: 'text.snapshot', text: `echo: ${textOf(t.inputs)}`, final: true }, { audience: 'answer' });
};
const input = (sessionKey: string, text: string, opId?: string) => ({ type: 'command', ...(opId !== undefined ? { opId } : {}), command: { type: 'input', sessionKey, mode: 'queue', input: { content: [{ type: 'text', text }] } } });
const interrupt = (sessionKey: string, opId?: string) => ({ type: 'command', ...(opId !== undefined ? { opId } : {}), command: { type: 'interrupt', sessionKey } });
const log = (w: World, key: string) => w.gw.hub.log.read(key, 0);
const bodies = (evs: SessionEvent[], t: string) => evs.filter((e) => e.body.t === t).map((e) => e.body as never as Record<string, unknown>);
/** The answer without its frame id (a retry has its own). */
const answer = ({ id: _id, ...rest }: ClientResultFrame) => rest;
const turnOf = (w: World, key: string) => w.gw.sessions().find((s) => s.sessionKey === key)?.turnId;
const completed = (w: World, key: string, turnId: string) => bodies(log(w, key), 'turn.completed').find((b) => b.turnId === turnId);

describe('client op ids (client.opId)', () => {
  it('an input with an op id acts once: its answer carries the seq of its admission; a retry, on another connection and while the first still acts, gets that answer back replayed, and nothing is admitted again #PR-3 #PR-1', async () => {
    const w = await daemon({ script });
    const [a, b] = [await w.client(), await w.client()];
    const both = await Promise.all([a.exchange(input('s', 'hi', 'op-1')), b.exchange(input('s', 'hi', 'op-1'))]);
    expect(both.filter((r) => r.replayed === true)).toHaveLength(1);
    const first = both.find((r) => r.replayed === undefined)!;
    const other = both.find((r) => r.replayed === true)!;
    expect(first).toMatchObject({ ok: true, opId: 'op-1', value: { disposition: 'new_turn' } });
    const { inputId } = first.value as { inputId: string };
    const admitted = log(w, 's').filter((e) => e.body.t === 'input.admitted');
    expect(admitted.map((e) => (e.body as { inputId: string }).inputId)).toEqual([inputId]);
    // The seq is the admission's: a subscription that has passed it shows the input.
    expect(first.seq).toBe(admitted[0]!.seq);
    expect(answer(other)).toEqual({ ...answer(first), replayed: true });
    for (const r of both) expect(check(ServerFrame, r)).toBe(true);

    await until(() => bodies(log(w, 's'), 'turn.completed').length === 1);
    const later = await b.exchange(input('s', 'hi', 'op-1'));
    expect(answer(later)).toEqual({ ...answer(first), replayed: true });
    expect(bodies(log(w, 's'), 'input.admitted')).toHaveLength(1);
    expect(bodies(log(w, 's'), 'turn.started')).toHaveLength(1);

    // Without an op id, as before: a plain answer, acted on every time.
    const plain = await a.exchange(input('s', 'again'));
    expect(Object.keys(plain).sort()).toEqual(['id', 'ok', 'type', 'v', 'value']);
    await until(() => bodies(log(w, 's'), 'turn.completed').length === 2);
    expect(bodies(log(w, 's'), 'input.admitted')).toHaveLength(2);

    expect(FEATURES).toContain('client.opId');
    expect((await (await w.client()).hello({ token: w.gw.token, name: 'probe' })).features).toContain('client.opId');
  });

  it('the answer commits with the event that decides it: when it cannot be kept the input is not admitted either, and the retry acts once #PR-3', async () => {
    const w = await daemon({ script });
    const c = await w.client();
    const records = w.gw.records;
    const put = records.putOp.bind(records);
    const inTransaction: boolean[] = [];
    let failing = true;
    records.putOp = (r: OpReceipt) => {
      inTransaction.push(records.db.isTransaction);
      if (failing) {
        failing = false;
        throw new Error('disk I/O error');
      }
      put(r);
    };
    const lost = await c.exchange(input('s', 'hi', 'op-a'));
    expect(lost).toMatchObject({ ok: false, error: { code: 'internal', message: 'disk I/O error' }, opId: 'op-a' });
    // Rolled back with the receipt: no admission, no turn.
    expect(bodies(log(w, 's'), 'input.admitted')).toEqual([]);
    expect(records.getOp('me', 'op-a')).toBeUndefined();

    const again = await c.exchange(input('s', 'hi', 'op-a'));
    expect(again).toMatchObject({ ok: true, opId: 'op-a', value: { disposition: 'new_turn' } });
    expect(again.replayed).toBeUndefined();
    expect(inTransaction).toEqual([true, true]);
    await until(() => bodies(log(w, 's'), 'turn.completed').length === 1);
    expect(bodies(log(w, 's'), 'input.admitted').map((b) => b.inputId)).toEqual([(again.value as { inputId: string }).inputId]);
    expect(bodies(log(w, 's'), 'turn.started').map((b) => b.inputIds)).toEqual([[(again.value as { inputId: string }).inputId]]);
    expect(answer(await c.exchange(input('s', 'hi', 'op-a')))).toEqual({ ...answer(again), replayed: true });

    // An observed input too (its own inputId): not recorded, and the retry records it once, not as a duplicate.
    failing = true;
    const observe = { type: 'command', opId: 'op-o', command: { type: 'input', sessionKey: 's', mode: 'observe', input: { inputId: 'in-o', content: [{ type: 'text', text: 'fyi' }] } } };
    expect(await c.exchange(observe)).toMatchObject({ ok: false, error: { code: 'internal', message: 'disk I/O error' }, opId: 'op-o' });
    expect(bodies(log(w, 's'), 'input.admitted').filter((b) => b.inputId === 'in-o')).toEqual([]);
    const seen = await c.exchange(observe);
    expect(seen).toMatchObject({ ok: true, opId: 'op-o', value: { inputId: 'in-o', disposition: 'observe_only' } });
    expect(seen.replayed).toBeUndefined();
    expect(bodies(log(w, 's'), 'input.admitted').filter((b) => b.inputId === 'in-o').map((b) => b.disposition)).toEqual(['observe_only']);
    expect(answer(await c.exchange(observe))).toEqual({ ...answer(seen), replayed: true });
    expect(inTransaction).toEqual([true, true, true, true]);
  });

  it('a steer whose answer cannot be kept is admitted all the same, since the harness has it: its turn consumes it, nothing rejects it, the command fails internal, and a retry with its inputId steers nothing more #PR-3 #IN-1', async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const steered: string[] = [];
    const w = await daemon({
      script: async (t) => {
        await held;
        if (steered.length) t.emit({ t: 'input.consumed', inputIds: steered, turnId: t.turnId });
        t.emit({ t: 'text.snapshot', text: 'done', final: true }, { audience: 'answer' });
      },
    });
    // A harness that steers.
    const fake = w.harness as unknown as { probe(): Promise<{ version: string; caps: Record<string, unknown> }>; open(a: unknown): Promise<{ steer: unknown }> };
    const probe = fake.probe.bind(fake);
    fake.probe = async () => {
      const p = await probe();
      return { ...p, caps: { ...p.caps, steer: 'native' } };
    };
    const open = fake.open.bind(fake);
    fake.open = async (a) =>
      Object.assign(await open(a), {
        steer: async (inputs: { inputId: string }[]) => {
          steered.push(...inputs.map((i) => i.inputId));
          return 'steered';
        },
      });
    const c = await w.client();
    expect(await c.exchange(input('s', 'first'))).toMatchObject({ ok: true, value: { disposition: 'new_turn' } });
    const records = w.gw.records;
    const put = records.putOp.bind(records);
    let failing = true;
    records.putOp = (r: OpReceipt) => {
      if (failing) {
        failing = false;
        throw new Error('disk I/O error');
      }
      put(r);
    };
    const steer = { type: 'command', opId: 'op-s', command: { type: 'input', sessionKey: 's', mode: 'steer', input: { inputId: 'in-s', content: [{ type: 'text', text: 'also this' }] } } };
    const lost = await c.exchange(steer);
    expect(lost).toMatchObject({ ok: false, error: { code: 'internal', message: 'disk I/O error' }, opId: 'op-s' });
    expect(steered).toEqual(['in-s']);
    expect(bodies(log(w, 's'), 'input.admitted').filter((b) => b.inputId === 'in-s').map((b) => b.disposition)).toEqual(['steer']);
    expect(records.getOp('me', 'op-s')).toBeUndefined();

    // No answer was kept to give back; the lane has the input already: a duplicate (kept now), nothing steered again.
    const again = await c.exchange(steer);
    expect(again).toMatchObject({ ok: true, opId: 'op-s', value: { inputId: 'in-s', disposition: 'duplicate' } });
    expect(again.replayed).toBeUndefined();
    expect(answer(await c.exchange(steer))).toEqual({ ...answer(again), replayed: true });
    expect(steered).toEqual(['in-s']);

    release();
    await until(() => bodies(log(w, 's'), 'turn.completed').length === 1);
    const settled = log(w, 's').filter((e) => ['input.consumed', 'input.rejected', 'input.cancelled'].includes(e.body.t) && (e.body as { inputIds: string[] }).inputIds.includes('in-s'));
    expect(settled.map((e) => e.body.t)).toEqual(['input.consumed']);
    expect(bodies(log(w, 's'), 'turn.started')).toHaveLength(1);
  });

  it('a rejection is kept too: an interrupt answered no_active_turn, and one that stopped a turn, are answered the same when retried while the next turn runs, which goes on #PR-3', async () => {
    const w = await daemon({ script });
    const c = await w.client();
    const idle = await c.exchange(interrupt('s', 'op-idle'));
    expect(idle).toMatchObject({ ok: false, error: { code: 'no_active_turn' }, opId: 'op-idle' });
    expect(idle.seq).toBeUndefined();

    await c.exchange(input('s', 'long one'));
    const t1 = await until(() => turnOf(w, 's'));
    const stop = await c.exchange(interrupt('s', 'op-stop'));
    expect(stop).toMatchObject({ ok: true, value: {}, opId: 'op-stop' });
    await until(() => completed(w, 's', t1));
    expect(completed(w, 's', t1)).toMatchObject({ status: 'interrupted' });

    await c.exchange(input('s', 'long two'));
    const t2 = await until(() => turnOf(w, 's') !== t1 && turnOf(w, 's'));
    expect(answer(await c.exchange(interrupt('s', 'op-idle')))).toEqual({ ...answer(idle), replayed: true });
    expect(answer(await c.exchange(interrupt('s', 'op-stop')))).toEqual({ ...answer(stop), replayed: true });
    await new Promise((r) => setTimeout(r, 30));
    expect(turnOf(w, 's')).toBe(t2);
    expect(completed(w, 's', t2)).toBeUndefined();
  });

  it('an interrupt that cancels the queue keeps its answer with its input.cancelled, whose seq it answers; the retry cancels nothing more #PR-3', async () => {
    const w = await daemon({ script });
    const c = await w.client();
    await c.exchange(input('s', 'long one'));
    const t1 = await until(() => turnOf(w, 's'));
    const queued = await c.exchange(input('s', 'later'));
    expect(queued).toMatchObject({ ok: true, value: { disposition: 'queued' } });
    const stop = { type: 'command', opId: 'op-clear', command: { type: 'interrupt', sessionKey: 's', cancelQueue: true } };
    const first = await c.exchange(stop);
    expect(first).toMatchObject({ ok: true, value: {}, opId: 'op-clear' });
    const cancelled = log(w, 's').filter((e) => e.body.t === 'input.cancelled');
    expect(cancelled.map((e) => (e.body as { inputIds: string[] }).inputIds)).toEqual([[(queued.value as { inputId: string }).inputId]]);
    expect(first.seq).toBe(cancelled[0]!.seq);
    await until(() => completed(w, 's', t1));

    await c.exchange(input('s', 'long two'));
    const t2 = await until(() => turnOf(w, 's') !== t1 && turnOf(w, 's'));
    expect(await c.exchange(input('s', 'later again'))).toMatchObject({ ok: true, value: { disposition: 'queued' } });
    expect(answer(await c.exchange(stop))).toEqual({ ...answer(first), replayed: true });
    expect(bodies(log(w, 's'), 'input.cancelled')).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 30));
    expect(turnOf(w, 's')).toBe(t2);
    expect(w.gw.sessions().find((x) => x.sessionKey === 's')?.queued).toBe(1);
  });

  it('an input refused because its session\'s agent is gone keeps that refusal with its input.rejected #PR-3', async () => {
    const w = await daemon({ script });
    w.gw.records.setAgent('gone', 'ghost');
    const c = await w.client();
    const refused = await c.exchange(input('gone', 'hi', 'op-gone'));
    expect(refused).toMatchObject({ ok: false, opId: 'op-gone', error: { code: 'agent_unavailable', message: expect.stringContaining('belongs to agent "ghost"') } });
    const rejected = log(w, 'gone').filter((e) => e.body.t === 'input.rejected');
    expect(rejected).toHaveLength(1);
    expect(refused.seq).toBe(rejected[0]!.seq);
    expect(answer(await c.exchange(input('gone', 'hi', 'op-gone')))).toEqual({ ...answer(refused), replayed: true });
    expect(bodies(log(w, 'gone'), 'input.rejected')).toHaveLength(1);
  });

  it('an interrupt without turnId acts on the turn it resolved the first time: retried after a restart, when its answer was never kept, it does not stop the next turn #PR-3 #RS-1', async () => {
    const w = await daemon({ script });
    const c = await w.client();
    await c.exchange(input('s', 'long first'));
    const t1 = await until(() => turnOf(w, 's'));
    // The interrupt resolves its turn and keeps it before it acts; its answer cannot be kept (a failed write, as if the process died there).
    const records = w.gw.records;
    const put = records.putOp.bind(records);
    records.putOp = (r: OpReceipt) => {
      if (r.status !== 'pending') throw new Error('disk I/O error');
      put(r);
    };
    const lost = await c.exchange(interrupt('s', 'op-stop'));
    expect(lost).toMatchObject({ ok: false, error: { code: 'internal', message: 'disk I/O error' }, opId: 'op-stop' });
    await until(() => completed(w, 's', t1));
    expect(completed(w, 's', t1)).toMatchObject({ status: 'interrupted' });
    expect(records.getOp('me', 'op-stop')).toMatchObject({ frameType: 'interrupt', sessionKey: 's', status: 'pending', turnId: t1 });
    await w.stop();

    const w2 = await daemon({ dir: w.dir, script });
    const c2 = await w2.client();
    await c2.exchange(input('s', 'long second'));
    const t2 = await until(() => turnOf(w2, 's'));
    expect(t2).not.toBe(t1);
    const again = await c2.exchange(interrupt('s', 'op-stop'));
    expect(again).toMatchObject({ ok: false, error: { code: 'stale_turn' }, opId: 'op-stop' });
    expect(again.replayed).toBeUndefined();
    expect(answer(await c2.exchange(interrupt('s', 'op-stop')))).toEqual({ ...answer(again), replayed: true });
    await new Promise((r) => setTimeout(r, 30));
    expect(turnOf(w2, 's')).toBe(t2);
    expect(completed(w2, 's', t2)).toBeUndefined();
    // Another op id is another command: it stops the turn running now.
    expect(await c2.exchange(interrupt('s', 'op-stop-2'))).toMatchObject({ ok: true, value: {} });
    await until(() => completed(w2, 's', t2));
  });

  it('kept answers outlive a restart and the log\'s compaction: the same op id after them is answered as the first time and acts on nothing #PR-3 #RS-1', async () => {
    const w = await daemon({ script });
    const c = await w.client();
    const watch = { source: { channel: 'fake', conversation: 'g1' }, target: { sessionKey: 's' }, mode: 'context' };
    const frames = [input('s', 'hi', 'op-in'), interrupt('s', 'op-int'), { type: 'watch.add', opId: 'op-w', watch }];
    const first: ClientResultFrame[] = [];
    first.push(await c.exchange(frames[0]!));
    await until(() => bodies(log(w, 's'), 'turn.completed').length === 1);
    first.push(await c.exchange(frames[1]!));
    first.push(await c.exchange(frames[2]!));
    expect(first.map((r) => r.ok)).toEqual([true, false, true]);
    expect(first[1]).toMatchObject({ error: { code: 'no_active_turn' } });
    const head = w.gw.hub.log.head('s');
    await w.stop();

    const w2 = await daemon({ dir: w.dir, script });
    (w2.gw.hub.log as SqliteSessionLog).compact('s');
    expect(w2.gw.hub.log.floor('s')).toBe(head);
    const c2 = await w2.client();
    await c2.exchange(input('s', 'long now'));
    const running = await until(() => turnOf(w2, 's'));
    for (const [i, f] of frames.entries()) expect(answer(await c2.exchange(f))).toEqual({ ...answer(first[i]!), replayed: true });
    // Nothing acted again: no second "hi", the running turn goes on, one watch.
    expect(bodies(log(w2, 's'), 'input.admitted').map((b) => textOf([b.input as never]))).toEqual(['long now']);
    await new Promise((r) => setTimeout(r, 30));
    expect(turnOf(w2, 's')).toBe(running);
    expect(await c2.watchList('s')).toEqual([first[2]!.value]);
    await c2.command({ type: 'interrupt', sessionKey: 's' });
  });

  it('an op id used again for another frame type or another session is op_id_conflict and acts on nothing; op ids are per principal #PR-3', async () => {
    const w = await daemon({ script });
    const c = await w.client();
    const first = await c.exchange(input('s', 'hi', 'op-x'));
    expect(first).toMatchObject({ ok: true, opId: 'op-x' });
    await until(() => bodies(log(w, 's'), 'turn.completed').length === 1);
    const conflicts = [
      await c.exchange(interrupt('s', 'op-x')),
      await c.exchange(input('t', 'hi', 'op-x')),
      await c.exchange({ type: 'topic.switch', opId: 'op-x', conversation: 'fake:default:c1', new: {} }),
      await c.exchange({ type: 'watch.add', opId: 'op-x', watch: { source: { channel: 'fake' }, target: { sessionKey: 's' }, mode: 'context' } }),
    ];
    for (const r of conflicts) {
      expect(r).toMatchObject({ ok: false, opId: 'op-x', error: { code: 'op_id_conflict', message: expect.stringContaining('op id op-x is input on s, not ') } });
      expect(r.replayed).toBeUndefined();
    }
    expect(log(w, 't')).toEqual([]);
    expect(await c.watchList()).toEqual([]);
    expect(answer(await c.exchange(input('s', 'hi', 'op-x')))).toEqual({ ...answer(first), replayed: true });

    // A host connection is another principal: its op-x is its own command.
    const h = await w.host();
    const theirs = await h.exchange(input('s', 'hi', 'op-x'));
    expect(theirs).toMatchObject({ ok: true, opId: 'op-x' });
    expect(theirs.replayed).toBeUndefined();
    expect((theirs.value as { inputId: string }).inputId).not.toBe((first.value as { inputId: string }).inputId);
    await until(() => bodies(log(w, 's'), 'turn.completed').length === 2);
  });

  it('topic.switch and watch.add with an op id act once: a retry makes no second topic and no second watch; the switch answers the seq of its topic.changed in the topic now current #PR-3', async () => {
    const w = await daemon({ script });
    const conv = 'fake:default:c1';
    await w.chat.inject({ sender: { channelUserId: 'alice', evidence: 'platform_signed' }, text: 'hello' });
    await until(() => bodies(log(w, conv), 'turn.completed').length === 1);
    const c = await w.client();
    const made = await c.exchange({ type: 'topic.switch', opId: 'op-new', conversation: conv, new: { title: 'Plans' } });
    expect(made).toMatchObject({ ok: true, opId: 'op-new', value: { created: true, topic: { title: 'Plans', state: 'current' } } });
    const key = (made.value as { topic: { sessionKey: string } }).topic.sessionKey;
    const changed = log(w, key).find((e) => e.seq === made.seq);
    expect(changed?.body).toMatchObject({ t: 'topic.changed', to: (made.value as { topic: { id: string } }).topic.id, reason: 'user' });
    expect(answer(await c.exchange({ type: 'topic.switch', opId: 'op-new', conversation: conv, new: { title: 'Plans' } }))).toEqual({ ...answer(made), replayed: true });
    expect(await c.topicList({ conversation: conv })).toHaveLength(2);

    // Switching to the topic already current writes nothing: no seq.
    const here = await c.exchange({ type: 'topic.switch', opId: 'op-here', conversation: conv, topicId: (made.value as { topic: { id: string } }).topic.id });
    expect(here).toMatchObject({ ok: true, value: { created: false } });
    expect(here.seq).toBeUndefined();
    const unknown = await c.exchange({ type: 'topic.switch', opId: 'op-nope', conversation: conv, topicId: 'tp_nope' });
    expect(unknown).toMatchObject({ ok: false, error: { code: 'unknown_topic' } });
    expect(answer(await c.exchange({ type: 'topic.switch', opId: 'op-nope', conversation: conv, topicId: 'tp_nope' }))).toEqual({ ...answer(unknown), replayed: true });
    expect(bodies(log(w, key), 'topic.changed')).toHaveLength(1);

    // A watch without an id gets a fresh one each time it acts: the retry gets the first one back.
    const draft = { source: { channel: 'fake', conversation: 'g1' }, target: { sessionKey: 's' }, mode: 'context' };
    const added = await c.exchange({ type: 'watch.add', opId: 'op-w', watch: draft });
    expect(added).toMatchObject({ ok: true, opId: 'op-w', value: { id: expect.any(String), createdBy: 'me' } });
    expect(added.seq).toBeUndefined();
    expect(answer(await c.exchange({ type: 'watch.add', opId: 'op-w', watch: draft }))).toEqual({ ...answer(added), replayed: true });
    expect(await c.watchList('s')).toEqual([added.value]);
  });
});
