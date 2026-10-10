import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeHarness, fakeEnvelope } from '@agents-io/testkit';
import type { BodyOf } from '@agents-io/protocol';
import { Hub, Lane, SqliteSessionLog, WatchDispatcher, WatchRegistry, defaultPolicy, matchesSource, passesFilter, settleLeftoverInputs } from '../src/index.js';
import { RUN, until } from './helpers.js';
import { AGENT, OWNER, STRANGER_HUMAN, TARGET, alice, draft, eve, group, world } from './watch-helpers.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tempPath = () => {
  const dir = mkdtempSync(join(tmpdir(), 'aio-watch-'));
  dirs.push(dir);
  return join(dir, 'log.sqlite');
};

describe('watch matching', () => {
  const env = fakeEnvelope({ sender: eve, conversation: group, text: 'Deploy is BROKEN', mentions: [{ id: 'u9' }] });
  it('matches source fields #RT-1', () => {
    expect(matchesSource({ channel: 'fake' }, env)).toBe(true);
    expect(matchesSource({ channel: 'other' }, env)).toBe(false);
    expect(matchesSource({ channel: 'fake', account: 'default', conversation: 'g1' }, env)).toBe(true);
    expect(matchesSource({ channel: 'fake', account: 'x' }, env)).toBe(false);
    expect(matchesSource({ channel: 'fake', conversation: 'g2' }, env)).toBe(false);
    expect(matchesSource({ channel: 'fake', conversation: 'group' }, env)).toBe(true); // a kind
    expect(matchesSource({ channel: 'fake', conversationKind: 'dm' }, env)).toBe(false);
    expect(matchesSource({ channel: 'fake', senders: ['bob', 'eve'] }, env)).toBe(true);
    expect(matchesSource({ channel: 'fake', senders: ['bob'] }, env)).toBe(false);
  });
  it('applies filters: keywords case-insensitively, mentions, excludeSelf by default #RT-1 #ID-5', () => {
    expect(passesFilter({ keywords: ['broken'] }, env, STRANGER_HUMAN)).toBe(true);
    expect(passesFilter({ keywords: ['fine', 'deploy'] }, env, STRANGER_HUMAN)).toBe(true);
    expect(passesFilter({ keywords: ['fine'] }, env, STRANGER_HUMAN)).toBe(false);
    expect(passesFilter({ mentions: ['u9'] }, env, STRANGER_HUMAN)).toBe(true);
    expect(passesFilter({ mentions: ['u1'] }, env, STRANGER_HUMAN)).toBe(false);
    expect(passesFilter(undefined, env, { ...STRANGER_HUMAN, self: true })).toBe(false);
    expect(passesFilter({ excludeSelf: false }, env, { ...STRANGER_HUMAN, self: true })).toBe(true);
  });
});

describe('watch fan-out', () => {
  it('records a watched group message as context in the target, keeping the original origin #ID-1', async () => {
    const w = world();
    expect((await w.watches.add(OWNER, draft())).ok).toBe(true);
    const r = await w.ingress.accept(fakeEnvelope({ id: 'm1', sender: eve, conversation: group, text: 'hello group' }));
    expect(r).toMatchObject({ action: 'observe', sessionKey: 'fake:default:g1', watched: [{ watchId: 'w1', sessionKey: TARGET, action: 'context' }] });
    const [a] = w.admitted();
    expect(a).toMatchObject({ disposition: 'observe_only' });
    expect(a!.input!.origin).toEqual(r.origin);
    expect(a!.input!.origin.principal).toBeNull();
    expect(a!.input!.channelContext).toMatchObject({ watch: 'w1', watchMode: 'context', watchSource: 'fake:default:g1', conversationId: 'g1' });
    expect(w.lanes.get(TARGET)!.observed().map((i) => i.content)).toEqual([[{ type: 'text', text: 'hello group' }]]);
    await w.close();
  });

  it('never delivers into the session the input already went to #CF-5', async () => {
    const w = world();
    await w.watches.add(OWNER, draft({ target: { sessionKey: 'fake:default:g1' } }));
    const r = await w.ingress.accept(fakeEnvelope({ sender: eve, conversation: group, text: 'x' }));
    expect(r.watched).toBeUndefined();
    expect(w.admitted('fake:default:g1').length).toBe(1);
    await w.close();
  });

  it('delivers inputs the target policy dropped (stranger DM) but not adapter drops or card clicks #RT-1', async () => {
    const w = world();
    await w.watches.add(OWNER, draft({ source: { channel: 'fake', conversationKind: 'dm' } }));
    const dm = await w.ingress.accept(fakeEnvelope({ sender: eve, text: 'mail for the owner' }));
    expect(dm).toMatchObject({ action: 'drop', watched: [{ action: 'context' }] });
    const bulk = await w.ingress.accept(fakeEnvelope({ sender: eve, text: 'newsletter', admission: 'drop' }));
    expect(bulk.watched).toBeUndefined();
    const click = await w.ingress.accept(fakeEnvelope({ sender: alice, content: [{ type: 'event', name: 'action', data: { actionId: 'req:r1:deny' } }] }));
    expect(click.watched).toBeUndefined();
    expect(w.admitted().length).toBe(1);
    await w.close();
  });

  it('own echoes: excluded by default; with excludeSelf false only ever context, never a turn (no loops) #ID-5', async () => {
    const w = world();
    const echo = (id: string) => fakeEnvelope({ id, sender: { channelUserId: 'mybot', evidence: 'platform_signed', isBot: true }, conversation: group, text: 'my own answer' });
    await w.watches.add(OWNER, draft({ mode: 'trigger' }));
    expect((await w.ingress.accept(echo('e1'))).watched).toBeUndefined();
    await w.watches.add(OWNER, draft({ mode: 'trigger', filter: { excludeSelf: false } }));
    expect((await w.ingress.accept(echo('e2'))).watched).toMatchObject([{ action: 'context' }]);
    await w.idle();
    expect(w.turns.length).toBe(0);
    await w.close();
  });

  it('is idempotent per (watch, envelope), also across a restart #RS-1 #IN-5', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aio-watch-'));
    dirs.push(dir);
    const path = join(dir, 'log.sqlite');
    const env = fakeEnvelope({ id: 'same', sender: eve, conversation: group, text: 'once' });
    const one = world({ path });
    await one.watches.add(OWNER, draft());
    await one.ingress.accept(env);
    expect((await one.ingress.accept({ ...env })).action).toBe('duplicate');
    await one.close();
    // A new process: Ingress's in-memory dedup is gone, the watch's delivery marker is not.
    const two = world({ path });
    const r = await two.ingress.accept({ ...env });
    expect(r.watched).toEqual([{ watchId: 'w1', sessionKey: TARGET, action: 'duplicate' }]);
    expect(two.admitted().length).toBe(1);
    await two.close();
  });

  it('triage decides drop / context / trigger #RT-1', async () => {
    const verdicts: ('drop' | 'context' | 'trigger')[] = ['drop', 'context', 'trigger'];
    const w = world({ policy: { triage: async () => verdicts.shift()! } });
    await w.watches.add(OWNER, draft());
    const r = [];
    for (const t of ['a', 'b', 'c']) r.push((await w.ingress.accept(fakeEnvelope({ sender: eve, conversation: group, text: t }))).watched![0]!.action);
    expect(r).toEqual(['drop', 'context', 'trigger']);
    await w.idle();
    expect(w.admitted().map((a) => a.disposition)).toEqual(['observe_only', 'new_turn']);
    expect(w.turns.length).toBe(1);
    await w.close();
  });

  it('a trigger turn keeps the original sender: restricted for a stranger, bypass for the owner #ID-6 #ID-1 #CF-5', async () => {
    const w = world();
    await w.watches.add(OWNER, draft({ mode: 'trigger' }));
    await w.ingress.accept(fakeEnvelope({ sender: eve, conversation: group, text: 'do something' }));
    await w.idle();
    // The owner's group message is dispatched to the group session (owner, @-less group: default dispatch) and fanned out too.
    await w.ingress.accept(fakeEnvelope({ sender: alice, conversation: group, text: 'mine' }));
    await w.idle();
    const started = w.events().filter((e) => e.body.t === 'turn.started').map((e) => e.body as BodyOf<'turn.started'>);
    expect(started.map((s) => s.run?.profile)).toEqual(['restricted', 'bypass']);
    expect(started[0]!.replyRoute).toEqual({ channel: 'fake', account: 'default', conversationId: 'owner-dm' });
    expect(w.turns[0]![0]!.origin).toMatchObject({ kind: 'human', principal: null, via: 'fake:default:g1' });
    expect(w.turns[0]![0]!.channelContext).toMatchObject({ watch: 'w1', watchMode: 'trigger' });
    await w.close();
  });
});

describe('digest watches', () => {
  it('buffers context and starts one system turn per period #ID-1 #ID-6', async () => {
    const w = world();
    await w.watches.add(OWNER, draft({ mode: 'digest', digest: { everyMs: 80 }, note: 'summarise' }));
    for (const t of ['one', 'two', 'three']) await w.ingress.accept(fakeEnvelope({ sender: eve, conversation: group, text: t }));
    expect(w.turns.length).toBe(0);
    expect(w.registry.bufferedCount('w1')).toBe(3);
    await until(() => w.turns.length === 1, 2000);
    await w.idle();
    const [input] = w.turns[0]!;
    expect(input!.origin).toMatchObject({ kind: 'system', principal: null, via: 'watch:w1' });
    const text = (input!.content[0] as { text: string }).text;
    expect(text).toMatch(/^\[watch w1 digest\] 3 new items from fake:\*:g1 since /);
    expect(text).toContain('note: summarise');
    for (const t of ['Eve (fake:default:g1): one', ': two', ': three']) expect(text).toContain(t);
    expect(w.events().some((e) => e.body.t === 'notice' && e.body.message.startsWith('watch w1: digest of 3 items'))).toBe(true);
    const started = w.events().find((e) => e.body.t === 'turn.started')!.body as BodyOf<'turn.started'>;
    expect(started.run?.profile).toBe('restricted');
    expect(w.registry.bufferedCount('w1')).toBe(0);
    await w.close();
  });

  it('buffered items and the watch survive a restart, and flush afterwards #RS-1', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aio-watch-'));
    dirs.push(dir);
    const path = join(dir, 'log.sqlite');
    const one = world({ path });
    await one.watches.add(OWNER, draft({ mode: 'digest', digest: { everyMs: 150 } }));
    await one.ingress.accept(fakeEnvelope({ sender: eve, conversation: group, text: 'before restart' }));
    await one.close(); // stopped before the timer fired
    expect(one.turns.length).toBe(0);
    const two = world({ path });
    expect(two.watches.list().map((x) => x.id)).toEqual(['w1']);
    await until(() => two.turns.length === 1, 2000);
    expect((two.turns[0]![0]!.content[0] as { text: string }).text).toContain('before restart');
    await two.close();
  });

  it('a flush begun before a crash is redone with the same input id #RS-7 #RS-1', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aio-watch-'));
    dirs.push(dir);
    const path = join(dir, 'log.sqlite');
    const one = world({ path });
    await one.watches.add(OWNER, draft({ mode: 'digest', digest: { everyMs: 3_600_000 } }));
    await one.ingress.accept(fakeEnvelope({ sender: eve, conversation: group, text: 'x' }));
    one.registry.beginFlush('w1', 'dg_crashed');
    await one.close();
    const two = world({ path });
    await until(() => two.turns.length === 1, 2000);
    expect(two.turns[0]![0]!.inputId).toBe('dg_crashed');
    await two.close();
  });

  // INVARIANTS IN-1 (§12 item 15, reproduced): settleLeftoverInputs rejects the digest id (host_restarted), then the watch's redo admits the same id again and it is consumed — two outcomes; turns red when fixed — make it `it` and update INVARIANTS.
  it.fails('a flush that crashed after input.admitted and before endFlush: after the restart its input has exactly one outcome #IN-1', async () => {
    const path = tempPath();
    const one = world({ path });
    await one.watches.add(OWNER, draft({ mode: 'digest', digest: { everyMs: 3_600_000 } }));
    await one.ingress.accept(fakeEnvelope({ sender: eve, conversation: group, text: 'x' }));
    // The crash: the flush was begun and its input admitted (queued) in the target; endFlush never ran.
    one.registry.beginFlush('w1', 'dg_crashed');
    one.hub.append(TARGET, { ts: Date.now(), level: 'primary', audience: 'status', durability: 'durable', body: { t: 'input.admitted', inputId: 'dg_crashed', disposition: 'queued' } });
    await one.close();
    // Startup in the gateway's order: watches start (their redo is async), then leftovers are settled before any lane opens.
    const two = world({ path });
    settleLeftoverInputs(two.hub, TARGET);
    await until(() => two.turns.length === 1, 2000);
    await two.idle();
    const outcomes = two
      .events()
      .filter((e) => (e.body.t === 'input.consumed' || e.body.t === 'input.rejected' || e.body.t === 'input.cancelled') && e.body.inputIds.includes('dg_crashed'))
      .map((e) => e.body.t);
    expect(outcomes).toHaveLength(1);
    await two.close();
  });
});

describe('who may watch', () => {
  it('removing: the creator, or someone policy lets create it, never another agent; an agent cannot replace a watch it does not own #CF-7', async () => {
    const w = world({ allow: [{ channel: 'fake', conversationKind: 'group' }] });
    expect(await w.watches.add(OWNER, draft({ id: 'o', source: { channel: 'mail' } }))).toMatchObject({ ok: true, watch: { createdBy: 'fake:alice' } });
    expect(await w.watches.add(AGENT, draft({ id: 'a1', source: { channel: 'fake', conversationKind: 'group' } }))).toMatchObject({ ok: true, watch: { createdBy: 'session:main' } });
    expect(await w.watches.add(STRANGER_HUMAN, draft({ id: 's' }))).toMatchObject({ ok: false, code: 'forbidden' });
    expect(await w.watches.remove(AGENT, 'o')).toMatchObject({ ok: false, code: 'forbidden' });
    expect(await w.watches.add(AGENT, draft({ id: 'o', source: { channel: 'fake', conversationKind: 'group' } }))).toMatchObject({ ok: false, code: 'forbidden' });
    expect(await w.watches.remove(OWNER, 'a1')).toEqual({ ok: true, removed: true });
    expect(await w.watches.remove(OWNER, 'nope')).toEqual({ ok: true, removed: false });
    expect(w.watches.list().map((x) => x.id)).toEqual(['o']);
    await w.close();
  });

  it("a watch whose source is the target session's home route is refused #CF-5", async () => {
    // A group's @-session watching the same group: its trigger turns would answer in the group it watches.
    const w = world({ home: { channel: 'fake', account: 'default', conversationId: 'g1' } });
    const r = await w.watches.add(OWNER, draft({ mode: 'trigger', source: { channel: 'fake', conversation: 'g1' } }));
    await w.close();
    expect(r).toMatchObject({ ok: false });
  });

  it("a broader trigger watch covering the target's home conversation records that conversation's messages as context, never a turn there #CF-5", async () => {
    const w = world({ home: { channel: 'fake', account: 'default', conversationId: 'g1' } });
    expect((await w.watches.add(OWNER, draft({ mode: 'trigger', source: { channel: 'fake', conversationKind: 'group' } }))).ok).toBe(true);
    // A context watch of the home conversation starts no turn: allowed.
    expect((await w.watches.add(OWNER, draft({ id: 'w2', source: { channel: 'fake', conversation: 'g1' } }))).ok).toBe(true);
    const home = await w.ingress.accept(fakeEnvelope({ id: 'h1', sender: eve, conversation: group, text: 'in the home group' }));
    expect(home.watched?.find((x) => x.watchId === 'w1')).toMatchObject({ action: 'context' });
    const other = await w.ingress.accept(fakeEnvelope({ id: 'o1', sender: eve, conversation: { id: 'g2', kind: 'group' }, text: 'elsewhere' }));
    expect(other.watched?.find((x) => x.watchId === 'w1')).toMatchObject({ action: 'trigger' });
    await w.idle();
    // One turn, started by the other group; the home group's message only rides along as context (IN-6).
    expect(w.turns).toHaveLength(1);
    expect(w.turns[0]!.at(-1)!.content).toEqual([{ type: 'text', text: 'elsewhere' }]);
    await w.close();
  });

  it('expired watches stop matching and are removed #RT-1', async () => {
    let now = 1_000;
    const log = new SqliteSessionLog();
    const registry = new WatchRegistry({ db: log.db, now: () => now });
    const lanes = new Map<string, Lane>();
    const hub = new Hub(log);
    const watches = new WatchDispatcher({
      registry,
      now: () => now,
      policy: defaultPolicy({ owners: ['fake:alice'], run: RUN }),
      lanes: (k) => lanes.get(k) ?? lanes.set(k, new Lane({ sessionKey: k, harness: new FakeHarness(), hub })).get(k)!,
    });
    await watches.add(OWNER, draft({ expiresAt: 2_000 }));
    const env = (id: string) => fakeEnvelope({ id, sender: eve, conversation: group });
    expect((await watches.fanout(env('a'), STRANGER_HUMAN, undefined, {})).length).toBe(1);
    now = 2_000;
    expect((await watches.fanout(env('b'), STRANGER_HUMAN, undefined, {})).length).toBe(0);
    expect(registry.list({ includeExpired: true })).toEqual([]);
    log.close();
  });
});
