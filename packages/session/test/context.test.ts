import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeHarness, fakeEnvelope } from '@agents-io/testkit';
import type { BodyOf, InputRecord, Origin, SteerResult } from '@agents-io/protocol';
import { Hub, Ingress, Lane, SqliteSessionLog, WatchDispatcher, WatchRegistry, defaultPolicy, type LaneOptions } from '../src/index.js';
import { ManualHarness, RUN, bodies, input, origin, policy, route, setup, until } from './helpers.js';
import { fakeHarnessCaps } from '@agents-io/testkit';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A context-only message from a stranger in group g1. */
function said(id: string, text: string, extra: Partial<InputRecord['channelContext']> = {}): InputRecord {
  return {
    inputId: id,
    origin: { ...origin(null), via: 'fake:default:g1' },
    content: [{ type: 'text', text }],
    replyRoute: route('g1'),
    channelContext: { conversationKind: 'group', senderName: 'Eve', ...extra },
  };
}

const ask = (id: string, text = 'what did they say?') => input(text, { id, route: route('g1') });

/** A lane on a ManualHarness: the test decides what the harness reports consumed. */
function manual(o: Partial<LaneOptions> = {}) {
  const h = new ManualHarness();
  const w = setup({ harness: h, ...o });
  const starts = () => h.session?.starts ?? [];
  const ids = (n: number) => starts()[n]!.inputs.map((i) => i.inputId);
  const texts = (n: number) => starts()[n]!.inputs.map((i) => (i.content[0] as { text: string }).text);
  const send = (i: InputRecord) => w.lane.command({ type: 'input', sessionKey: 's1', input: i, mode: 'queue' });
  return { ...w, h, starts, ids, texts, send };
}

describe('context hand-over', () => {
  it('hands context recorded since the previous turn first, in arrival order, marked and routed like the turn', async () => {
    const m = manual();
    await m.lane.observe(said('c1', 'the launch moved to Thursday'));
    await m.lane.observe(said('c2', 'bring the blue folder', { watch: 'wg', watchMode: 'context' }));
    await m.send(ask('q'));
    await until(() => m.starts().length === 1);
    expect(m.ids(0)).toEqual(['c1', 'c2', 'q']);
    const [c1, c2, q] = m.starts()[0]!.inputs;
    // Own origin kept (the per-input preface shows who said it), labelled as context.
    expect(c1!.origin.principal).toBeNull();
    expect(c1!.channelContext).toMatchObject({ context: true, senderName: 'Eve', conversationKind: 'group' });
    expect(c2!.channelContext).toMatchObject({ context: true, watch: 'wg' });
    expect(q!.channelContext.context).toBeUndefined();
    // The turn's reply route comes from its first input: context carries the turn's.
    expect(c1!.replyRoute).toEqual(q!.replyRoute);
    expect(bodies(m.events(), 'turn.started')[0]).toMatchObject({ inputIds: ['c1', 'c2', 'q'], replyRoute: route('g1') });
    // The lane's own view of the turn: only what triggered it.
    expect(m.lane.activeTurn()).toMatchObject({ inputIds: ['q'], owner: 'fake:alice' });
  });

  it('keeps the most recent maxItems and says how many older ones were left out', async () => {
    const m = manual({ context: { maxItems: 3 } });
    for (let i = 1; i <= 5; i++) await m.lane.observe(said(`c${i}`, `m${i}`));
    await m.send(ask('q'));
    await until(() => m.starts().length === 1);
    const t = m.starts()[0]!;
    expect(m.ids(0)).toEqual([`ctxo_${t.turnId}`, 'c3', 'c4', 'c5', 'q']);
    expect(m.texts(0)[0]).toBe('[2 older context messages omitted]');
    expect(t.inputs[0]!.channelContext).toEqual({ context: true, contextOmitted: 2 });
    expect(t.inputs[0]!.origin).toMatchObject({ kind: 'system', principal: null, adapter: 'session' });
  });

  it('keeps the most recent within maxChars; the newest alone over the limit is clipped', async () => {
    const m = manual({ context: { maxChars: 25 } });
    for (let i = 1; i <= 4; i++) await m.lane.observe(said(`c${i}`, `${i}`.repeat(10)));
    await m.send(ask('q1'));
    await until(() => m.starts().length === 1);
    expect(m.ids(0).slice(1)).toEqual(['c3', 'c4', 'q1']);
    expect(m.texts(0)[0]).toBe('[2 older context messages omitted]');
    m.h.session!.complete(m.starts()[0]!.turnId, ['q1']);
    await m.lane.whenIdle();

    await m.lane.observe(said('big', 'x'.repeat(100)));
    await m.send(ask('q2'));
    await until(() => m.starts().length === 2);
    expect(m.ids(1)).toEqual(['big', 'q2']);
    const big = m.starts()[1]!.inputs[0]!;
    expect((big.content[0] as { text: string }).text).toHaveLength(25);
    expect(big.channelContext).toMatchObject({ context: true, contextClipped: true });
  });

  it('revisions: only the latest version, in the first one’s place; a revision of one already handed is handed again under a new id', async () => {
    const m = manual();
    const seg = (text: string, stable: boolean) => ({ ...said('t1', ''), content: [{ type: 'transcript' as const, speaker: 'Eve', text, startMs: 0, endMs: 900, stable }] });
    await m.lane.observe(seg('helo wrld', false));
    await m.lane.observe(said('c2', 'next'));
    await m.lane.observe(seg('hello world', true));
    await m.send(ask('q1'));
    await until(() => m.starts().length === 1);
    expect(m.ids(0)).toEqual(['t1', 'c2', 'q1']);
    expect(m.starts()[0]!.inputs[0]!.content).toEqual([{ type: 'transcript', speaker: 'Eve', text: 'hello world', startMs: 0, endMs: 900, stable: true }]);
    m.h.session!.complete(m.starts()[0]!.turnId, ['q1']);
    await m.lane.whenIdle();

    await m.lane.observe(seg('hello, world', true));
    await m.send(ask('q2'));
    await until(() => m.starts().length === 2);
    const [rev] = m.starts()[1]!.inputs;
    expect(rev!.inputId).toMatch(/^t1@\d+$/);
    expect(rev!.channelContext).toMatchObject({ context: true, contextRevised: true });
    expect(m.ids(1).slice(1)).toEqual(['q2']);
  });

  it('never hands the same context twice', async () => {
    const m = manual();
    await m.lane.observe(said('c1', 'a'));
    await m.send(ask('q1'));
    await until(() => m.starts().length === 1);
    m.h.session!.complete(m.starts()[0]!.turnId, ['c1', 'q1']);
    await m.lane.whenIdle();
    await m.lane.observe(said('c2', 'b'));
    await m.send(ask('q2'));
    await until(() => m.starts().length === 2);
    expect(m.ids(1)).toEqual(['c2', 'q2']);
    m.h.session!.complete(m.starts()[1]!.turnId, ['q2']);
    await m.lane.whenIdle();
    await m.send(ask('q3'));
    await until(() => m.starts().length === 3);
    expect(m.ids(2)).toEqual(['q3']);
    expect(m.lane.pendingContext()).toEqual([]);
  });

  it('reconciliation: context reported consumed or not neither requeues it nor makes the turn ambiguous', async () => {
    const m = manual();
    await m.lane.observe(said('c1', 'a'));
    await m.lane.observe(said('c2', 'b'));
    await m.send(ask('q1'));
    await until(() => m.starts().length === 1);
    m.h.session!.complete(m.starts()[0]!.turnId, ['c1', 'q1']); // c2 not reported
    await m.lane.whenIdle();
    await m.send(ask('q2'));
    await until(() => m.starts().length === 2);
    m.h.session!.complete(m.starts()[1]!.turnId, ['q2']);
    await m.lane.whenIdle();
    const done = bodies(m.events(), 'turn.completed') as BodyOf<'turn.completed'>[];
    expect(done.map((d) => d.status)).toEqual(['completed', 'completed']);
    expect(bodies(m.events(), 'input.rejected')).toEqual([]);
    expect(m.ids(1)).toEqual(['q2']); // c2 not handed again, not requeued
    expect(bodies(m.events(), 'input.admitted').filter((b) => (b as BodyOf<'input.admitted'>).disposition === 'queued')).toEqual([]);
  });

  it('a requeued trigger does not bring the context it was handed with again', async () => {
    const m = manual();
    await m.lane.observe(said('c1', 'a'));
    await m.send(ask('q1'));
    await until(() => m.starts().length === 1);
    m.h.session!.complete(m.starts()[0]!.turnId, []); // nothing consumed: q1 is requeued once
    await until(() => m.starts().length === 2);
    expect(m.ids(1)).toEqual(['q1']);
  });

  it('a turn that fails to start leaves the context pending for the next one', async () => {
    let fail = true;
    const m = manual({ policy: policy({ plan: async () => (fail ? Promise.reject(new Error('no plan')) : { ...RUN, profile: 'restricted' }) }) });
    await m.lane.observe(said('c1', 'a'));
    await m.send(ask('q1'));
    await m.lane.whenIdle();
    expect(bodies(m.events(), 'input.rejected')).toEqual([{ t: 'input.rejected', inputIds: ['q1'], reason: 'start_failed: no plan', replyRoute: expect.objectContaining({ conversationId: 'g1' }) }]);
    fail = false;
    await m.send(ask('q2'));
    await until(() => m.starts().length === 1);
    expect(m.ids(0)).toEqual(['c1', 'q2']);
  });

  it('context recorded while a turn runs (also next to a steer) goes to the next turn, not into the running one', async () => {
    const h = new ManualHarness({ ...fakeHarnessCaps, steer: 'native' });
    const m = setup({ harness: h });
    await m.lane.command({ type: 'input', sessionKey: 's1', input: ask('q1'), mode: 'queue' });
    await until(() => h.session?.starts.length === 1);
    await until(() => bodies(m.events(), 'turn.started').length === 1);
    const steered: InputRecord[][] = [];
    (h.session as unknown as { steer: (inputs: InputRecord[]) => Promise<SteerResult> }).steer = async (inputs) => {
      steered.push(inputs);
      return 'steered';
    };
    await m.lane.observe(said('c1', 'during the turn'));
    expect(await m.lane.command({ type: 'input', sessionKey: 's1', input: ask('s1', 'also this'), mode: 'steer' })).toEqual({ ok: true, disposition: 'steer' });
    expect(steered.map((b) => b.map((i) => i.inputId))).toEqual([['s1']]);
    const first = h.session!.starts[0]!.turnId;
    expect(m.lane.provenance(first)).toMatchObject({ watched: false, external: false, group: false });
    h.session!.complete(first, ['q1', 's1']);
    await m.lane.whenIdle();
    await m.lane.command({ type: 'input', sessionKey: 's1', input: ask('q2'), mode: 'queue' });
    await until(() => h.session!.starts.length === 2);
    expect(h.session!.starts[1]!.inputs.map((i) => i.inputId)).toEqual(['c1', 'q2']);
    expect(m.lane.provenance(h.session!.starts[1]!.turnId)).toMatchObject({ triggeredBy: ['fake:alice'], watched: true, external: true, group: true });
  });

  it('provenance: flags come from the context actually handed, and stay for later turns', async () => {
    const m = manual();
    await m.send(ask('q0'));
    await until(() => m.starts().length === 1);
    expect(m.lane.provenance(m.starts()[0]!.turnId)).toMatchObject({ watched: false, external: false });
    m.h.session!.complete(m.starts()[0]!.turnId, ['q0']);
    await m.lane.whenIdle();
    // Recorded, not yet handed: the next turn is the one that sees it.
    await m.lane.observe(said('c1', 'a'));
    await m.send(ask('q1'));
    await until(() => m.starts().length === 2);
    expect(m.lane.provenance(m.starts()[1]!.turnId)).toMatchObject({ triggeredBy: ['fake:alice'], watched: true, external: true, group: true });
    m.h.session!.complete(m.starts()[1]!.turnId, ['q1']);
    await m.lane.whenIdle();
    await m.send(ask('q2'));
    await until(() => m.starts().length === 3);
    expect(m.ids(2)).toEqual(['q2']);
    expect(m.lane.provenance(m.starts()[2]!.turnId)).toMatchObject({ watched: true, external: true, group: true });
  });

  it('maxItems 0 turns the hand-over off (still recorded)', async () => {
    const m = manual({ context: { maxItems: 0 } });
    await m.lane.observe(said('c1', 'a'));
    await m.send(ask('q'));
    await until(() => m.starts().length === 1);
    expect(m.ids(0)).toEqual(['q']);
    expect(m.lane.observed().map((i) => i.inputId)).toEqual(['c1']);
  });
});

describe('context hand-over across a host restart', () => {
  function sqliteHub() {
    const dir = mkdtempSync(join(tmpdir(), 'aio-ctx-'));
    dirs.push(dir);
    return join(dir, 'log.sqlite');
  }

  it('context recorded but not handed before the restart goes to the next turn; handed context does not', async () => {
    const path = sqliteHub();
    const log1 = new SqliteSessionLog({ path });
    const h1 = new ManualHarness();
    const lane1 = new Lane({ sessionKey: 's1', harness: h1, hub: new Hub(log1), policy: policy(), thinkingHeadline: null });
    await lane1.observe(said('c1', 'handed before'));
    await lane1.command({ type: 'input', sessionKey: 's1', input: ask('q1'), mode: 'queue' });
    await until(() => log1.read('s1', 0).some((e) => e.body.t === 'turn.started'));
    h1.session!.complete(h1.session!.starts[0]!.turnId, ['q1']);
    await lane1.whenIdle();
    await until(() => log1.read('s1', 0).some((e) => e.body.t === 'turn.completed'));
    await lane1.observe(said('c2', 'after the turn'));
    await lane1.observe(said('c3', 'also after'));
    log1.close();

    const log2 = new SqliteSessionLog({ path });
    const h2 = new ManualHarness();
    const lane2 = new Lane({ sessionKey: 's1', harness: h2, hub: new Hub(log2), policy: policy(), thinkingHeadline: null });
    expect(lane2.pendingContext().map((i) => i.inputId)).toEqual(['c2', 'c3']);
    await lane2.command({ type: 'input', sessionKey: 's1', input: ask('q2'), mode: 'queue' });
    await until(() => h2.session?.starts.length === 1);
    const t = h2.session!.starts[0]!;
    expect(t.inputs.map((i) => i.inputId)).toEqual(['c2', 'c3', 'q2']);
    expect(t.inputs[0]).toMatchObject({ origin: { principal: null }, channelContext: { context: true, senderName: 'Eve' } });
    // Context handed before the restart still flags later turns.
    expect(lane2.provenance(t.turnId)).toMatchObject({ watched: true, external: true, group: true });
    log2.close();
  });

  it('what a turn left out as older is not handed after the restart either', async () => {
    const path = sqliteHub();
    const log1 = new SqliteSessionLog({ path });
    const h1 = new ManualHarness();
    const lane1 = new Lane({ sessionKey: 's1', harness: h1, hub: new Hub(log1), policy: policy(), thinkingHeadline: null, context: { maxItems: 2 } });
    for (let i = 1; i <= 4; i++) await lane1.observe(said(`c${i}`, `m${i}`));
    await lane1.command({ type: 'input', sessionKey: 's1', input: ask('q1'), mode: 'queue' });
    await until(() => log1.read('s1', 0).some((e) => e.body.t === 'turn.started'));
    expect(h1.session!.starts[0]!.inputs.map((i) => i.inputId).slice(1)).toEqual(['c3', 'c4', 'q1']);
    h1.session!.complete(h1.session!.starts[0]!.turnId, ['q1']);
    await lane1.whenIdle();
    await until(() => log1.read('s1', 0).some((e) => e.body.t === 'turn.completed'));
    await lane1.observe(said('c5', 'm5'));
    log1.close();

    const log2 = new SqliteSessionLog({ path });
    const lane2 = new Lane({ sessionKey: 's1', harness: new ManualHarness(), hub: new Hub(log2), policy: policy(), thinkingHeadline: null, context: { maxItems: 2 } });
    expect(lane2.pendingContext().map((i) => i.inputId)).toEqual(['c5']);
    log2.close();
  });
});

describe('context through Ingress and watches', () => {
  const OWNER: Origin = { kind: 'human', principal: { id: 'fake:alice', labels: ['owner'] }, evidence: 'device_only', via: 'local:local:main', adapter: 'local' };
  const alice = { channelUserId: 'alice', evidence: 'platform_signed' as const };
  const eve = { channelUserId: 'eve', evidence: 'platform_signed' as const, displayName: 'Eve' };
  const group = { id: 'g1', kind: 'group' as const };

  function world() {
    const log = new SqliteSessionLog();
    const hub = new Hub(log);
    const pol = defaultPolicy({ owners: ['fake:alice'], selfAccounts: ['fake:mybot'], run: RUN });
    const lanes = new Map<string, Lane>();
    const turns: { key: string; inputs: InputRecord[] }[] = [];
    const lane = (key: string) => {
      let l = lanes.get(key);
      if (!l) {
        const harness = new FakeHarness(async (t) => {
          turns.push({ key, inputs: t.inputs });
        });
        lanes.set(key, (l = new Lane({ sessionKey: key, harness, hub, policy: pol, thinkingHeadline: null })));
      }
      return l;
    };
    const registry = new WatchRegistry({ db: log.db });
    const watches = new WatchDispatcher({ registry, policy: pol, lanes: lane, replyRoute: () => ({ channel: 'fake', account: 'default', conversationId: 'owner-dm' }) });
    watches.start();
    const ingress = new Ingress({ policy: pol, lanes: lane, watches });
    const idle = async () => {
      await watches.idle();
      await Promise.all([...lanes.values()].map((l) => l.whenIdle()));
    };
    const close = async () => {
      watches.stop();
      await idle();
      log.close();
    };
    return { log, ingress, watches, lanes, turns, idle, close };
  }

  it('strangers talking in a group without an @ reach the owner’s next @ turn', async () => {
    const w = world();
    await w.ingress.accept(fakeEnvelope({ sender: eve, conversation: group, text: 'the launch moved to Thursday' }));
    await w.ingress.accept(fakeEnvelope({ sender: eve, conversation: group, text: 'budget approved at 42k' }));
    expect(w.turns).toEqual([]);
    await w.ingress.accept(fakeEnvelope({ sender: alice, conversation: group, text: '@bot what did they say?' }));
    await w.idle();
    expect(w.turns).toHaveLength(1);
    const texts = w.turns[0]!.inputs.map((i) => [(i.content[0] as { text: string }).text, i.channelContext.context === true]);
    expect(texts).toEqual([
      ['the launch moved to Thursday', true],
      ['budget approved at 42k', true],
      ['@bot what did they say?', false],
    ]);
    await w.close();
  });

  it('digest items are handed only in their digest turn, not again as context', async () => {
    const w = world();
    await w.watches.add(OWNER, { id: 'wd', source: { channel: 'fake', conversation: 'g1' }, target: { sessionKey: 'main' }, mode: 'digest', digest: { everyMs: 3_600_000, maxItems: 2 } });
    await w.watches.add(OWNER, { id: 'wc', source: { channel: 'fake', conversation: 'g2' }, target: { sessionKey: 'main' }, mode: 'context' });
    await w.ingress.accept(fakeEnvelope({ sender: eve, conversation: { id: 'g2', kind: 'group' }, text: 'from the context watch' }));
    await w.ingress.accept(fakeEnvelope({ sender: eve, conversation: group, text: 'one' }));
    await w.ingress.accept(fakeEnvelope({ sender: eve, conversation: group, text: 'two' }));
    await w.idle();
    const main = () => w.turns.filter((t) => t.key === 'main');
    expect(main()).toHaveLength(1);
    const digestTurn = main()[0]!.inputs;
    // The context watch's message comes first; the digest items only inside the digest.
    expect(digestTurn.map((i) => i.channelContext.watch)).toEqual(['wc', 'wd']);
    expect(digestTurn[0]!.channelContext).toMatchObject({ context: true, watchMode: 'context' });
    expect((digestTurn[1]!.content[0] as { text: string }).text).toMatch(/2 new items/);
    expect(w.lanes.get('main')!.pendingContext()).toEqual([]);
    // The owner's next turn in main: nothing handed again.
    await w.lanes.get('main')!.command({ type: 'input', sessionKey: 'main', input: { ...input('next'), origin: OWNER }, mode: 'queue' });
    await w.idle();
    expect(main()[1]!.inputs.map((i) => i.channelContext.context)).toEqual([undefined]);
    await w.close();
  });
});
