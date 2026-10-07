import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeHarness, fakeEnvelope } from '@agents-io/testkit';
import type { BodyOf, InputRecord, Origin, Watch, WatchDraft } from '@agents-io/protocol';
import {
  Hub,
  Ingress,
  Lane,
  SqliteSessionLog,
  WatchDispatcher,
  WatchRegistry,
  defaultPolicy,
  matchesSource,
  passesFilter,
  type SessionPolicy,
} from '../src/index.js';
import { RUN, until } from './helpers.js';

const OWNER: Origin = { kind: 'human', principal: { id: 'fake:alice', labels: ['owner'] }, evidence: 'device_only', via: 'local:local:main', adapter: 'local' };
const AGENT: Origin = { kind: 'agent', principal: { id: 'session:main', labels: ['agent'] }, evidence: 'none', via: 'mcp', adapter: 'mcp' };
const STRANGER_HUMAN: Origin = { kind: 'human', principal: null, evidence: 'platform_signed', via: 'fake:default:g1', adapter: 'fake' };

const alice = { channelUserId: 'alice', evidence: 'platform_signed' as const };
const eve = { channelUserId: 'eve', evidence: 'platform_signed' as const, displayName: 'Eve' };
const group = { id: 'g1', kind: 'group' as const };
const TARGET = 'main';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function world(o: { policy?: Partial<SessionPolicy>; path?: string; allow?: Parameters<typeof defaultPolicy>[0]['watchAllowlist'] } = {}) {
  const log = new SqliteSessionLog({ path: o.path ?? ':memory:' });
  const hub = new Hub(log);
  const policy: SessionPolicy = {
    ...defaultPolicy({ owners: ['fake:alice'], selfAccounts: ['fake:mybot'], run: RUN, ...(o.allow ? { watchAllowlist: o.allow } : {}) }),
    ...o.policy,
  };
  const lanes = new Map<string, Lane>();
  const turns: InputRecord[][] = [];
  const harness = new FakeHarness(async (t) => {
    turns.push(t.inputs);
    t.emit({ t: 'text.snapshot', text: 'ok', final: true }, { audience: 'answer' });
  });
  const lane = (sessionKey: string) => {
    let l = lanes.get(sessionKey);
    if (!l) lanes.set(sessionKey, (l = new Lane({ sessionKey, harness, hub, policy, thinkingHeadline: null })));
    return l;
  };
  const registry = new WatchRegistry({ db: log.db });
  const watches = new WatchDispatcher({ registry, policy, lanes: lane, replyRoute: () => ({ channel: 'fake', account: 'default', conversationId: 'owner-dm' }) });
  watches.start();
  const ingress = new Ingress({ policy, lanes: lane, watches });
  const events = (k = TARGET) => log.read(k, 0);
  const admitted = (k = TARGET) => events(k).filter((e) => e.body.t === 'input.admitted').map((e) => e.body as BodyOf<'input.admitted'>);
  const idle = async () => {
    await watches.idle();
    await Promise.all([...lanes.values()].map((l) => l.whenIdle()));
  };
  const close = async () => {
    watches.stop();
    await idle();
    log.close();
  };
  return { log, hub, ingress, watches, registry, lanes, turns, events, admitted, idle, close };
}

const draft = (d: Partial<WatchDraft> = {}): WatchDraft => ({ id: 'w1', source: { channel: 'fake', conversation: 'g1' }, target: { sessionKey: TARGET }, mode: 'context', ...d });

describe('watch matching', () => {
  const env = fakeEnvelope({ sender: eve, conversation: group, text: 'Deploy is BROKEN', mentions: [{ id: 'u9' }] });
  it('matches source fields', () => {
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
  it('applies filters: keywords case-insensitively, mentions, excludeSelf by default', () => {
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
  it('records a watched group message as context in the target, keeping the original origin', async () => {
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

  it('applies filters before delivering', async () => {
    const w = world();
    await w.watches.add(OWNER, draft({ filter: { keywords: ['URGENT'] } }));
    await w.ingress.accept(fakeEnvelope({ sender: eve, conversation: group, text: 'just chatting' }));
    await w.ingress.accept(fakeEnvelope({ sender: eve, conversation: group, text: 'this is urgent!' }));
    expect(w.admitted().length).toBe(1);
    await w.close();
  });

  it('never delivers into the session the input already went to', async () => {
    const w = world();
    await w.watches.add(OWNER, draft({ target: { sessionKey: 'fake:default:g1' } }));
    const r = await w.ingress.accept(fakeEnvelope({ sender: eve, conversation: group, text: 'x' }));
    expect(r.watched).toBeUndefined();
    expect(w.admitted('fake:default:g1').length).toBe(1);
    await w.close();
  });

  it('delivers inputs the target policy dropped (stranger DM) but not adapter drops or card clicks', async () => {
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

  it('own echoes: excluded by default; with excludeSelf false only ever context, never a turn (no loops)', async () => {
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

  it('is idempotent per (watch, envelope), also across a restart', async () => {
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

  it('triage decides drop / context / trigger', async () => {
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

  it('a trigger turn keeps the original sender: restricted for a stranger, bypass for the owner', async () => {
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
  it('buffers context and starts one system turn per period', async () => {
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

  it('flushes as soon as maxItems is reached', async () => {
    const w = world();
    await w.watches.add(OWNER, draft({ mode: 'digest', digest: { everyMs: 3_600_000, maxItems: 2 } }));
    await w.ingress.accept(fakeEnvelope({ sender: eve, conversation: group, text: 'a' }));
    expect(w.turns.length).toBe(0);
    await w.ingress.accept(fakeEnvelope({ sender: eve, conversation: group, text: 'b' }));
    await w.idle();
    expect(w.turns.length).toBe(1);
    expect((w.turns[0]![0]!.content[0] as { text: string }).text).toMatch(/2 new items/);
    await w.close();
  });

  it('buffered items and the watch survive a restart, and flush afterwards', async () => {
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

  it('a flush begun before a crash is redone with the same input id', async () => {
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
});

describe('who may watch', () => {
  it('owners anything; agents only allowlisted sources; strangers nothing', async () => {
    const w = world({ allow: [{ channel: 'fake', conversationKind: 'group' }] });
    expect(await w.watches.add(OWNER, draft({ id: 'o', source: { channel: 'mail' } }))).toMatchObject({ ok: true, watch: { createdBy: 'fake:alice' } });
    expect(await w.watches.add(AGENT, draft({ id: 'a1', source: { channel: 'fake', conversationKind: 'group' } }))).toMatchObject({ ok: true, watch: { createdBy: 'session:main' } });
    expect(await w.watches.add(AGENT, draft({ id: 'a2', source: { channel: 'fake', conversationKind: 'dm' } }))).toMatchObject({ ok: false, code: 'forbidden' });
    expect(await w.watches.add(AGENT, draft({ id: 'a3', source: { channel: 'mail' } }))).toMatchObject({ ok: false, code: 'forbidden' });
    expect(await w.watches.add(STRANGER_HUMAN, draft({ id: 's' }))).toMatchObject({ ok: false, code: 'forbidden' });
    // Removing: the creator, or someone policy lets create it (not another agent).
    expect(await w.watches.remove(AGENT, 'o')).toMatchObject({ ok: false, code: 'forbidden' });
    expect(await w.watches.add(AGENT, draft({ id: 'o', source: { channel: 'fake', conversationKind: 'group' } }))).toMatchObject({ ok: false, code: 'forbidden' });
    expect(await w.watches.remove(OWNER, 'a1')).toEqual({ ok: true, removed: true });
    expect(await w.watches.remove(OWNER, 'nope')).toEqual({ ok: true, removed: false });
    expect(w.watches.list().map((x: Watch) => x.id)).toEqual(['o']);
    await w.close();
  });

  it('validates watches', async () => {
    const w = world();
    expect(await w.watches.add(OWNER, draft({ mode: 'digest' }))).toMatchObject({ ok: false, code: 'invalid' });
    expect(await w.watches.add(OWNER, { ...draft(), mode: 'loud' } as never)).toMatchObject({ ok: false, code: 'invalid' });
    const r = await w.watches.add(OWNER, { ...draft(), id: undefined } as never);
    expect(r).toMatchObject({ ok: true });
    await w.close();
  });

  it('expired watches stop matching and are removed', async () => {
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
