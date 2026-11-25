import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeHarness, fakeEnvelope } from '@agents-io/testkit';
import { HostQueue, Hub, Ingress, Lane, MemorySessionLog, Router, SOURCE_MISMATCH, SqliteSessionLog, actionId, defaultPolicy, interruptActionId, mayBeEcho, ownersTable, parseActionId, questionActionId, type EmitSource, type IngressResult, type SessionPolicy } from '../src/index.js';
import type { InputRecord } from '@agents-io/protocol';
import { RUN, bodies, until } from './helpers.js';

function world(extra: Partial<SessionPolicy> = {}) {
  const hub = new Hub(new MemorySessionLog());
  const policy: SessionPolicy = {
    ...defaultPolicy({ owners: ['fake:alice'], selfAccounts: ['fake:mybot'], agentAccounts: ['fake:peer'], run: RUN }),
    ...extra,
  };
  const lanes = new Map<string, Lane>();
  const seen: InputRecord[][] = [];
  const harness = new FakeHarness(async (t) => {
    seen.push(t.inputs);
  });
  const ingress = new Ingress({
    policy,
    lanes: (sessionKey) => {
      let l = lanes.get(sessionKey);
      if (!l) lanes.set(sessionKey, (l = new Lane({ sessionKey, harness, hub, policy, thinkingHeadline: null })));
      return l;
    },
  });
  return { hub, ingress, lanes, seen };
}

const alice = { channelUserId: 'alice', evidence: 'platform_signed' as const };
const stranger = { channelUserId: 'eve', evidence: 'platform_signed' as const };
const group = { id: 'g1', kind: 'group' as const };

describe('Ingress', () => {
  it('stamps origin from Policy.identify and dispatches owner input to a lane #ID-1 #ID-3', async () => {
    const { ingress, hub } = world();
    const r = await ingress.accept(fakeEnvelope({ id: 'm1', sender: { ...alice, declared: 'someone-else' }, text: 'hi' }));
    expect(r).toMatchObject({ accepted: true, action: 'dispatch', sessionKey: 'fake:default:c1', result: { ok: true, disposition: 'new_turn' } });
    // The declaration from a non-agent account is dropped: identity comes from policy only.
    expect(r.origin).toEqual({ kind: 'human', principal: { id: 'fake:alice', labels: ['owner'] }, evidence: 'platform_signed', via: 'fake:default:c1', adapter: 'fake' });
    await until(() => bodies(hub.log.read('fake:default:c1', 0), 'turn.completed').length === 1);
  });

  it('dedups by (channel, id) #IN-5', async () => {
    const { ingress, lanes } = world();
    const env = fakeEnvelope({ id: 'same', sender: alice });
    const a = await ingress.accept(env);
    const b = await ingress.accept({ ...env });
    expect(b).toMatchObject({ action: 'duplicate', inputId: a.inputId });
    const other = await ingress.accept({ ...env, channel: 'other' });
    expect(other.action).not.toBe('duplicate');
    await lanes.get('fake:default:c1')!.whenIdle();
  });

  it('dedups a duplicate that arrives while the first copy is still being processed #IN-5', async () => {
    const { ingress, lanes, seen } = world();
    const env = fakeEnvelope({ id: 'twice', sender: alice });
    const rs = await Promise.all([ingress.accept(env), ingress.accept({ ...env })]);
    expect(rs.map((r) => r.action).sort()).toEqual(['dispatch', 'duplicate']);
    expect(rs[1]!.inputId).toBe(rs[0]!.inputId);
    await lanes.get('fake:default:c1')!.whenIdle();
    expect(seen).toHaveLength(1);
  });

  it('dedups per account: the same platform message id reaching two accounts is two envelopes #IN-5', async () => {
    const { ingress, lanes } = world();
    const a = await ingress.accept(fakeEnvelope({ id: 'om_1', account: 'a', sender: alice }));
    const b = await ingress.accept(fakeEnvelope({ id: 'om_1', account: 'b', sender: alice }));
    expect([a.action, b.action]).toEqual(['dispatch', 'dispatch']);
    expect(b.sessionKey).toBe('fake:b:c1');
    await lanes.get('fake:a:c1')!.whenIdle();
    await lanes.get('fake:b:c1')!.whenIdle();
  });

  it('routes approval and stop clicks to the session that owns the request or turn #RQ-1 #CT-1', async () => {
    const hub = new Hub(new MemorySessionLog());
    const policy = defaultPolicy({ owners: ['fake:alice'], run: RUN });
    const asked = new FakeHarness(async (t) => {
      t.emit({ t: 'request.opened', requestId: 'r1', kind: 'tool_approval', title: 'push', risk: {}, allowedDecisions: ['allow_once', 'deny'], allowAlways: false, defaultDeny: true });
      await t.waitDecision('r1');
      await new Promise((_, reject) => t.signal.addEventListener('abort', () => reject(new Error('aborted'))));
    });
    const lanes = new Map<string, Lane>();
    const humanPolicy: SessionPolicy = { ...policy, resolve: async () => ({ kind: 'human', principals: ['fake:alice'], routes: [] }) };
    // Owner DMs merged into `main`: a rule of the default table now, no longer a policy option.
    const router = new Router({ agents: [{ name: 'default', sessionPrefix: '' }], config: ownersTable({ owners: ['fake:alice'], agent: 'default', ownerSessionKey: 'main' }) });
    const ingress = new Ingress({
      policy: humanPolicy,
      router,
      hub,
      lanes: (k) => {
        let l = lanes.get(k);
        if (!l) lanes.set(k, (l = new Lane({ sessionKey: k, harness: asked, hub, policy: humanPolicy, thinkingHeadline: null })));
        return l;
      },
    });
    await ingress.accept(fakeEnvelope({ sender: alice, text: 'ship it' }));
    const main = () => hub.log.read('main', 0);
    await until(() => bodies(main(), 'request.opened').length === 1);
    const turnId = (bodies(main(), 'turn.started')[0] as { turnId: string }).turnId;
    // Card callbacks carry no DM kind (or thread): the click conversation is not where the turn runs.
    const click = (aid: string) =>
      ingress.accept(fakeEnvelope({ sender: alice, conversation: { id: 'c1', kind: 'other' }, content: [{ type: 'event', name: 'action', data: { actionId: aid } }] }));
    expect(await click(actionId('r1', 'allow_once'))).toMatchObject({ action: 'resolve', sessionKey: 'main', result: { ok: true } });
    expect(await click(interruptActionId(turnId))).toMatchObject({ action: 'interrupt', sessionKey: 'main', result: { ok: true } });
    await until(() => bodies(main(), 'turn.completed').length === 1);
    // An id no session knows is answered without creating a lane for the click's conversation.
    expect(await click(actionId('nope', 'deny'))).toMatchObject({ action: 'resolve', result: { ok: false, reason: 'unknown_request' } });
    expect([...lanes.keys()]).toEqual(['main']);
  });

  it('drops self echoes and unknown DMs; observes strangers in groups #ID-5 #ID-1', async () => {
    const { ingress, hub } = world();
    expect(await ingress.accept(fakeEnvelope({ sender: { channelUserId: 'mybot', evidence: 'platform_signed', isBot: true, declared: 'runner:me/run:1' } }))).toMatchObject({
      accepted: true,
      action: 'drop',
      origin: { kind: 'agent', self: true, declared: 'runner:me/run:1' },
    });
    expect(await ingress.accept(fakeEnvelope({ sender: stranger }))).toMatchObject({ action: 'drop' });
    const r = await ingress.accept(fakeEnvelope({ sender: stranger, conversation: group }));
    expect(r).toMatchObject({ action: 'observe', sessionKey: 'fake:default:g1' });
    expect(bodies(hub.log.read('fake:default:g1', 0))).toEqual([{ t: 'input.admitted', inputId: r.inputId, disposition: 'observe_only', input: expect.objectContaining({ inputId: r.inputId, origin: expect.objectContaining({ principal: null }) }) }]);
  });

  it('applies revisionOf latest-wins for observe-only transcripts #IN-5', async () => {
    const { ingress, lanes } = world();
    const seg = (text: string, stable: boolean) => [{ type: 'transcript' as const, speaker: 'eve', text, startMs: 0, endMs: 900, stable }];
    const first = await ingress.accept(fakeEnvelope({ id: 's1', sender: stranger, conversation: group, content: seg('helo wrld', false) }));
    const second = await ingress.accept(fakeEnvelope({ id: 's1-r1', revisionOf: 's1', sender: stranger, conversation: group, content: seg('hello world', true) }));
    const third = await ingress.accept(fakeEnvelope({ id: 's1-r2', revisionOf: 's1-r1', sender: stranger, conversation: group, content: seg('hello, world', true) }));
    expect(second.inputId).toBe(first.inputId);
    expect(third.inputId).toBe(first.inputId);
    const observed = lanes.get('fake:default:g1')!.observed();
    expect(observed).toHaveLength(1);
    expect(observed[0]!.content).toEqual(seg('hello, world', true));
  });

  it('rejects invalid envelopes without remembering them #IN-5', async () => {
    const { ingress } = world();
    const bad = { ...fakeEnvelope({ id: 'bad' }), v: 2 } as unknown as Parameters<Ingress['accept']>[0];
    expect(await ingress.accept(bad)).toMatchObject({ accepted: false, action: 'invalid' });
  });

  it('turns an approval button click into a resolve command (eligibility re-checked by the lane) #RQ-1', async () => {
    const { ingress } = world();
    const click = (sender: typeof alice, aid: string) =>
      ingress.accept(fakeEnvelope({ sender, content: [{ type: 'event', name: 'action', data: { actionId: aid, messageId: 'm1' } }] }));
    expect(await click(alice, actionId('nope', 'allow_once'))).toMatchObject({ action: 'resolve', result: { ok: false, reason: 'unknown_request' } });
    expect(parseActionId('req:a:b:deny')).toEqual({ requestId: 'a:b', kind: 'deny' });
    expect(parseActionId('req:a:answer')).toBeUndefined();
  });
});

describe('Ingress: clicks on a backend\'s message (PB-1)', () => {
  it('a click on a backend\'s message is never parsed as an approval, stop or question button and never handed to onAction, whatever its action id #PB-1 #RQ-1', async () => {
    const hub = new Hub(new MemorySessionLog());
    const policy: SessionPolicy = { ...defaultPolicy({ owners: ['fake:alice'], run: RUN }), resolve: async () => ({ kind: 'human', principals: ['fake:alice'], routes: [] }) };
    const asked = new FakeHarness(async (t) => {
      t.emit({ t: 'request.opened', requestId: 'r1', kind: 'tool_approval', title: 'push', risk: {}, allowedDecisions: ['allow_once', 'deny'], allowAlways: false, defaultDeny: true });
      await t.waitDecision('r1');
      await new Promise((_, reject) => t.signal.addEventListener('abort', () => reject(new Error('aborted'))));
    });
    const lanes = new Map<string, Lane>();
    const config = ownersTable({ owners: ['fake:alice'], agent: 'default', ownerSessionKey: 'main' });
    // Backend alpha takes every click on its own messages; beta has no rule.
    config.bindings.unshift({ id: 'alpha-clicks', match: { actionPrefix: '' }, on: 'host', to: 'alpha' });
    const router = new Router({ agents: [{ name: 'default', sessionPrefix: '' }], config, backends: ['alpha', 'beta'] });
    const queue = new HostQueue();
    queue.register('backend:alpha', 'alpha');
    const actions: string[] = [];
    const undispatched: string[] = [];
    const ingress = new Ingress({
      policy,
      router,
      hub,
      hostQueue: queue,
      lanes: (k) => {
        let l = lanes.get(k);
        if (!l) lanes.set(k, (l = new Lane({ sessionKey: k, harness: asked, hub, policy, thinkingHeadline: null })));
        return l;
      },
      onAction: (a): IngressResult => {
        actions.push(a.actionId);
        return { accepted: true, action: 'command', origin: a.origin, result: { ok: true } as never };
      },
      onUndispatched: (a) => void undispatched.push(a.env.id),
      // The daemon knows who sent which message (S6); here: by the clicked message's id.
      clickOwner: (env) => {
        const b = env.content[0];
        const id = b?.type === 'event' ? b.data.messageId : undefined;
        return id === 'om_alpha' ? 'alpha' : id === 'om_beta' ? 'beta' : undefined;
      },
    });
    await ingress.accept(fakeEnvelope({ id: 'm0', sender: alice, text: 'ship it' }));
    const main = () => hub.log.read('main', 0);
    await until(() => bodies(main(), 'request.opened').length === 1);
    const turnId = (bodies(main(), 'turn.started')[0] as { turnId: string }).turnId;
    let n = 0;
    const click = (aid: string, messageId: string) =>
      ingress.accept(fakeEnvelope({ id: `click-${++n}`, sender: alice, conversation: { id: 'c1', kind: 'other' }, content: [{ type: 'event', name: 'action', data: { actionId: aid, messageId } }] }));

    // Kernel button ids and an embedder's, on a message alpha sent: all four are alpha's inputs, nothing else.
    const ids = [actionId('r1', 'allow_once'), interruptActionId(turnId), questionActionId('main', 'r1'), 'mod:anything'];
    for (const [i, aid] of ids.entries()) {
      const r = await click(aid, 'om_alpha');
      expect(r).toMatchObject({ accepted: true, action: 'host', host: { cursor: i + 1, duplicate: false, bindingId: 'alpha-clicks' }, hosts: [{ cursor: i + 1, duplicate: false, bindingId: 'alpha-clicks', to: 'alpha' }] });
      expect(r.result).toBeUndefined();
      expect(r.deliveries).toEqual([]);
    }
    expect(actions).toEqual([]);
    expect(undispatched).toEqual([]);
    // The request is still open and the turn still running.
    expect(hub.snapshot('main').pendingRequests.map((x) => x.requestId)).toEqual(['r1']);
    expect(bodies(main(), 'turn.completed')).toHaveLength(0);
    expect((await queue.read('backend:alpha')).map((x) => [x.to, x.envelope.content[0]])).toEqual(ids.map((aid) => ['alpha', { type: 'event', name: 'action', data: { actionId: aid, messageId: 'om_alpha' } }]));
    // The explanation says which rule took it, and which were skipped.
    const e = router.explain((await click('mod:again', 'om_alpha')).inputId!)!;
    expect(e.matched[0]).toEqual({ bindingId: 'alpha-clicks', source: 'config', on: 'host', to: 'alpha' });
    expect(e.matched.slice(1).every((m) => m.rejected?.code === 'click_sender')).toBe(true);

    // A click on a message of beta, which has no rule for it: dropped, and still nobody else's.
    const b = await click(actionId('r1', 'deny'), 'om_beta');
    expect(b).toMatchObject({ accepted: true, action: 'drop', deliveries: [], explanation: { dropped: 'no_match' } });
    expect(b.host).toBeUndefined();
    expect(b.hosts).toBeUndefined();
    expect(actions).toEqual([]);
    expect(undispatched).toEqual([]);
    expect(hub.snapshot('main').pendingRequests).toHaveLength(1);
    expect(queue.head()).toBe(5);

    // The same ids on a message no backend sent act as before: the embedder's click, then the approval.
    expect(await click('mod:anything', 'om_other')).toMatchObject({ action: 'command' });
    expect(actions).toEqual(['mod:anything']);
    expect(await click(actionId('r1', 'allow_once'), 'om_other')).toMatchObject({ action: 'resolve', sessionKey: 'main', result: { ok: true } });
    expect(await click(interruptActionId(turnId), 'om_other')).toMatchObject({ action: 'interrupt', sessionKey: 'main', result: { ok: true } });
    await until(() => bodies(main(), 'turn.completed').length === 1);
    expect(queue.head()).toBe(5);
  });

  it("a click that comes with other blocks is still its message's sender's: taken only by the rule to that backend, never by a rule without to or onUndispatched; a click queued for its backend grants no conversation, a message routed to it does #PB-1 #PB-2", async () => {
    const hub = new Hub(new MemorySessionLog());
    const policy: SessionPolicy = defaultPolicy({ owners: ['fake:alice'], run: RUN });
    const lanes = new Map<string, Lane>();
    const harness = new FakeHarness(async () => {});
    const config = ownersTable({ owners: ['fake:alice'], agent: 'default', ownerSessionKey: 'main' });
    config.bindings.unshift(
      { id: 'to-alpha', match: { keywords: ['alpha'] }, on: 'host', to: 'alpha' },
      { id: 'alpha-clicks', match: { actionPrefix: 'pick:' }, on: 'host', to: 'alpha' },
      // Every click, for the untargeted queue and for a session: neither is for a click on a backend's message.
      { id: 'host-clicks', match: { actionPrefix: '' }, on: 'host' },
      { id: 'agent-clicks', match: { actionPrefix: '' }, on: 'dispatch', agent: 'default', session: { key: 'clicks' } },
    );
    const router = new Router({ agents: [{ name: 'default', sessionPrefix: '' }], config, backends: ['alpha', 'beta'] });
    const queue = new HostQueue();
    queue.register('backend:alpha', 'alpha');
    const actions: string[] = [];
    const undispatched: string[] = [];
    const ingress = new Ingress({
      policy,
      router,
      hub,
      hostQueue: queue,
      lanes: (k) => {
        let l = lanes.get(k);
        if (!l) lanes.set(k, (l = new Lane({ sessionKey: k, harness, hub, policy, thinkingHeadline: null })));
        return l;
      },
      onAction: (a): IngressResult => {
        actions.push(a.actionId);
        return { accepted: true, action: 'command', origin: a.origin, result: { ok: true } as never };
      },
      onUndispatched: (a) => void undispatched.push(a.env.id),
      // As the daemon does: the clicked message's id, in whichever block the action event is.
      clickOwner: (env) => {
        for (const b of env.content) {
          if (b.type !== 'event' || b.name !== 'action') continue;
          if (b.data.messageId === 'om_alpha') return 'alpha';
          if (b.data.messageId === 'om_beta') return 'beta';
        }
        return undefined;
      },
    });
    const room = { id: 'room', kind: 'group' as const };
    const grant = { channel: 'fake', account: 'default', conversationId: 'room' };
    const click = (id: string, actionId: string, messageId: string) =>
      ingress.accept(fakeEnvelope({ id, sender: alice, conversation: room, content: [{ type: 'text', text: 'Yes' }, { type: 'event', name: 'action', data: { actionId, messageId } }] }));

    // A text block before the action event (a bridge may send both): alpha's rule, and only alpha's.
    const r = await click('k1', 'pick:yes', 'om_alpha');
    expect(r).toMatchObject({ accepted: true, action: 'host', hosts: [{ cursor: 1, duplicate: false, bindingId: 'alpha-clicks', to: 'alpha' }] });
    expect(r.hosts).toHaveLength(1);
    expect(r.deliveries).toEqual([]);
    expect(router.explain(r.inputId!)!.matched.map((m) => [m.bindingId, m.rejected?.code]).slice(0, 3)).toEqual([['alpha-clicks', undefined], ['host-clicks', 'click_sender'], ['agent-clicks', 'click_sender']]);
    // On a message of beta, which has no rule for it: nobody's, and not handed on.
    const b = await click('k2', 'pick:yes', 'om_beta');
    expect(b).toMatchObject({ accepted: true, action: 'drop', deliveries: [] });
    expect(b.hosts).toBeUndefined();
    expect((await queue.read('host')).map((x) => x.envelope.id)).toEqual([]);
    expect((await queue.read('backend:alpha')).map((x) => [x.to, x.envelope.id])).toEqual([['alpha', 'k1']]);
    expect(lanes.has('clicks')).toBe(false);
    expect(actions).toEqual([]);
    expect(undispatched).toEqual([]);

    // PB-2: the click gave alpha its messages (it may answer them where it may send), not the conversation.
    expect(queue.grantedMessage('alpha', { ...grant, messageId: 'k1' })).toBe(true);
    expect(queue.granted('alpha', grant)).toBe(false);
    expect(queue.grantCount('alpha')).toBe(0);
    // An input a rule routes to it does.
    expect(await ingress.accept(fakeEnvelope({ id: 'm1', sender: alice, conversation: room, text: 'for alpha' }))).toMatchObject({ hosts: [{ bindingId: 'to-alpha', to: 'alpha' }] });
    expect(queue.granted('alpha', grant)).toBe(true);
    expect(queue.grantCount('alpha')).toBe(1);

    // A click on nobody's message, in the same shape, goes where clicks went before.
    const plain = await click('k3', 'pick:yes', 'om_other');
    expect(plain.hosts).toEqual([{ cursor: 3, duplicate: false, bindingId: 'host-clicks' }]);
    expect(plain.deliveries?.map((d) => d.sessionKey)).toContain('clicks');
    queue.close();
  });
});

describe("Ingress: the echo of a backend's own deliver (PB-8)", () => {
  it("an envelope whose id, or whose revisionOf, is a message a backend delivered is stamped self without a principal, even the owner's, and is not queued for that backend; the same id without platform evidence, a click, another message with the same text and a message a turn sent are stamped as before #PB-8 #ID-5 #ID-8", async () => {
    const hub = new Hub(new MemorySessionLog());
    const policy: SessionPolicy = defaultPolicy({ owners: ['fake:alice'], run: RUN });
    const lanes = new Map<string, Lane>();
    const turns: string[] = [];
    const harness = new FakeHarness(async (t) => void turns.push(...t.inputs.map((i) => i.inputId)));
    const config = ownersTable({ owners: ['fake:alice'], agent: 'default', ownerSessionKey: 'main' });
    config.bindings.unshift(
      { id: 'to-alpha', match: { conversation: 'room' }, on: 'host', to: 'alpha' },
      // beta asks for what the deployment's own account says in the room.
      { id: 'beta-sees', match: { conversation: 'room', includeSelf: true }, on: 'host', to: 'beta' },
    );
    const router = new Router({ agents: [{ name: 'default', sessionPrefix: '' }], config, backends: ['alpha', 'beta'] });
    const queue = new HostQueue();
    queue.register('backend:alpha', 'alpha');
    queue.register('backend:beta', 'beta');
    const looked: string[] = [];
    const ingress = new Ingress({
      policy,
      router,
      hub,
      hostQueue: queue,
      lanes: (k) => {
        let l = lanes.get(k);
        if (!l) lanes.set(k, (l = new Lane({ sessionKey: k, harness, hub, policy, thinkingHeadline: null })));
        return l;
      },
      // As the daemon answers from its outbound records: alpha delivered `om_alpha` on this channel.
      deliveredBy: (channel, id) => {
        looked.push(id);
        return channel === 'fake' && id === 'om_alpha' ? ['alpha'] : [];
      },
      recover: (_channel, id) => (id === 'om_turn' ? { from: { agent: 'default', sessionKey: 'main' }, turnId: 't1' } : undefined),
      clickOwner: (env) => (env.content.some((b) => b.type === 'event' && b.data.messageId === 'om_alpha') ? 'alpha' : undefined),
    });
    const room = { id: 'room', kind: 'group' as const };
    const view = async (consumer: string) => (await queue.read(consumer)).map((x) => [x.bindingId, x.envelope.id, x.input.origin.self === true, x.input.origin.principal?.id]);
    const rules = (r: IngressResult) => r.explanation!.matched.map((m) => [m.bindingId, m.rejected?.code]);

    // The account is the owner's own: its message would be the owner speaking. Known by id, it is nobody speaking.
    const echo = await ingress.accept(fakeEnvelope({ id: 'om_alpha', sender: alice, conversation: room, text: 'see you at five' }));
    expect(echo.origin).toEqual({ kind: 'agent', principal: null, self: true, evidence: 'platform_signed', via: 'fake:default:room', adapter: 'fake' });
    expect(echo).toMatchObject({ accepted: true, action: 'host', deliveries: [], hosts: [{ cursor: 1, duplicate: false, bindingId: 'beta-sees', to: 'beta' }] });
    expect(echo.hosts).toHaveLength(1);
    expect(rules(echo)).toEqual([['to-alpha', 'own_echo'], ['beta-sees', undefined]]);
    expect(echo.explanation).toMatchObject({ echoOf: { backends: ['alpha'] }, principal: null, cause: { peer: 'fake:alice', basis: 'none' } });
    expect(router.explain(echo.inputId!)).toMatchObject({ echoOf: { backends: ['alpha'] } });
    expect(await view('backend:alpha')).toEqual([]);
    expect(await view('backend:beta')).toEqual([['beta-sees', 'om_alpha', true, undefined]]);

    // The channel reports the edit of that message as a revision of it: the same.
    const edit = await ingress.accept(fakeEnvelope({ id: 'om_alpha~2', revisionOf: 'om_alpha', sender: alice, conversation: room, text: 'see you at six' }));
    expect(edit.origin).toMatchObject({ kind: 'agent', principal: null, self: true });
    expect(rules(edit)).toEqual([['to-alpha', 'own_echo'], ['beta-sees', undefined]]);
    expect(await view('backend:alpha')).toEqual([]);
    expect(lanes.size).toBe(0);

    // Without platform evidence the id proves nothing (a forged copy): a stranger's message, routed by the rules.
    const forged = await ingress.accept(fakeEnvelope({ id: 'om_alpha', account: 'second', sender: { channelUserId: 'alice', evidence: 'none' }, conversation: room, text: 'see you at five' }));
    expect(forged.origin).toMatchObject({ kind: 'human', principal: null });
    expect(forged.origin!.self).toBeUndefined();
    expect(forged.hosts?.map((h) => [h.bindingId, h.to])).toEqual([['to-alpha', 'alpha'], ['beta-sees', 'beta']]);
    expect('echoOf' in forged.explanation!).toBe(false);

    // A click is its message's sender's input (PB-1), not an echo, even if the envelope carried that id.
    const click = await ingress.accept(fakeEnvelope({ id: 'om_alpha', account: 'third', sender: alice, conversation: room, content: [{ type: 'event', name: 'action', data: { actionId: 'pick:yes', messageId: 'om_alpha' } }] }));
    expect(click.origin).toMatchObject({ kind: 'human', principal: { id: 'fake:alice' } });
    expect(click.origin!.self).toBeUndefined();
    expect(click.hosts?.map((h) => [h.bindingId, h.to])).toEqual([['to-alpha', 'alpha']]);

    // The same words under another id are somebody's message: the owner's here, a turn and alpha's item.
    const said = await ingress.accept(fakeEnvelope({ id: 'om_typed', sender: alice, conversation: room, text: 'see you at five' }));
    expect(said.origin).toMatchObject({ kind: 'human', principal: { id: 'fake:alice', labels: ['owner'] } });
    expect(said.origin!.self).toBeUndefined();
    expect(said).toMatchObject({ action: 'dispatch', hosts: [{ bindingId: 'to-alpha', to: 'alpha' }, { bindingId: 'beta-sees', to: 'beta' }] });
    expect(rules(said).some((x) => x[1] !== undefined)).toBe(false);
    expect('echoOf' in said.explanation!).toBe(false);
    await until(() => turns.includes(said.inputId!));
    expect(turns).toEqual([said.inputId]);

    // A message a turn of this deployment sent is the outbound index's (ID-8), as before: from its agent, with its chain.
    const own = await ingress.accept(fakeEnvelope({ id: 'om_turn', sender: stranger, conversation: room, text: 'done' }));
    expect(own.origin).toMatchObject({ kind: 'agent', principal: { id: 'agent:default' }, self: true });
    expect(own.explanation).toMatchObject({ cause: { basis: 'recovered', from: { sessionKey: 'main', turnId: 't1' } } });
    expect('echoOf' in own.explanation!).toBe(false);
    expect(rules(own)).toEqual([['beta-sees', undefined]]);
    // The records are asked by message id only, and never for an envelope without platform evidence or a click.
    expect(looked).toEqual(['om_alpha', 'om_alpha~2', 'om_alpha', 'om_typed']);
    await lanes.get('fake:default:room')?.whenIdle();
    queue.close();
  });
});

describe("Ingress: an inbound message while a backend's deliver is in flight (PB-8)", () => {
  const room = { id: 'room', kind: 'group' as const };
  const bob = { channelUserId: 'bob', evidence: 'platform_signed' as const };
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  /** alpha and beta each get the room's messages, the host's own queue too, and the local agent a turn. */
  function world(queue: HostQueue, router?: Router) {
    const hub = new Hub(new MemorySessionLog());
    const policy: SessionPolicy = defaultPolicy({ owners: ['fake:alice'], run: RUN });
    const lanes = new Map<string, Lane>();
    const turns: string[] = [];
    const harness = new FakeHarness(async (t) => void turns.push(...t.inputs.map((i) => i.inputId)));
    const config = {
      version: 'v1',
      identities: [],
      bindings: [
        { id: 'to-alpha', match: { conversation: 'room' }, on: 'host' as const, to: 'alpha' },
        { id: 'to-beta', match: { conversation: 'room' }, on: 'host' as const, to: 'beta' },
        { id: 'to-host', match: { conversation: 'room' }, on: 'host' as const },
        { id: 'room-agent', match: { conversation: 'room' }, on: 'dispatch' as const, agent: 'default' },
      ],
    };
    router ??= new Router({ agents: [{ name: 'default', sessionPrefix: '' }], config, backends: ['alpha', 'beta'] });
    /** What the daemon's records say alpha delivered, and the delivers of alpha in flight (resolved by `settle`). */
    const delivered = new Set<string>();
    let inFlight: { settled: Promise<void>; settle: () => void } | undefined;
    const asked: string[] = [];
    const settledAs: string[] = [];
    const ingress = new Ingress({
      policy,
      router,
      hub,
      hostQueue: queue,
      lanes: (k) => {
        let l = lanes.get(k);
        if (!l) lanes.set(k, (l = new Lane({ sessionKey: k, harness, hub, policy, thinkingHeadline: null })));
        return l;
      },
      deliveredBy: (_channel, id) => (delivered.has(id) ? ['alpha'] : []),
      echoPending: (env) => {
        asked.push(env.id);
        return inFlight && env.conversation.id === 'room' ? [{ backend: 'alpha', settled: inFlight.settled }] : [];
      },
      onEchoSettled: (a) => settledAs.push(`${a.messageId}:${a.to}:${a.outcome}`),
      clickOwner: () => undefined,
    });
    const send = () => {
      let settle!: () => void;
      const settled = new Promise<void>((r) => (settle = r));
      inFlight = { settled, settle: () => (inFlight = undefined, settle()) };
      return inFlight;
    };
    const view = async (consumer: string) => (await queue.read(consumer, { after: 0 })).map((x) => x.envelope.id);
    return { ingress, router, lanes, turns, delivered, send, view, asked, settledAs };
  }
  const rules = (e: { matched: { bindingId: string; rejected?: { code: string } }[] }) => e.matched.map((m) => [m.bindingId, m.rejected?.code]);

  it("the queue entry for a backend that is sending into the conversation is set aside until its delivery has settled: dropped when the message is then on record as its own (explain: echoOf late, own_echo), queued otherwise, behind what came meanwhile; every other rule takes the input at once; a click, an envelope without platform evidence and a message already known as an echo are never set aside #PB-8 #EX-1", async () => {
    const queue = new HostQueue();
    for (const b of ['alpha', 'beta']) queue.register(`backend:${b}`, b);
    const w = world(queue);

    // Nothing in flight: queued for everybody at once, nothing set aside.
    const before = await w.ingress.accept(fakeEnvelope({ id: 'in-1', sender: bob, conversation: room, text: 'anyone?' }));
    expect(before.hosts?.map((h) => h.to)).toEqual(['alpha', 'beta', undefined]);
    expect([before.deferred, before.explanation!.deferred]).toEqual([undefined, undefined]);

    // alpha's deliver is in flight: its message is on the platform (om_1), not on record yet.
    const sending = w.send();
    // The channel hands it back, from the account's own user; and somebody answers.
    const echo = await w.ingress.accept(fakeEnvelope({ id: 'om_1', sender: alice, conversation: room, text: 'I am here' }));
    const reply = await w.ingress.accept(fakeEnvelope({ id: 'in-2', sender: bob, conversation: room, text: 'good' }));
    for (const r of [echo, reply]) {
      // Everybody else has it now, as the ordinary message it is as far as anyone knows: beta, the host's queue, a turn.
      expect(r).toMatchObject({ accepted: true, action: 'dispatch', deferred: [{ bindingId: 'to-alpha', to: 'alpha' }] });
      expect(r.hosts?.map((h) => h.to)).toEqual(['beta', undefined]);
      expect(r.origin!.self).toBeUndefined();
      expect(r.explanation).toMatchObject({ deferred: { backends: ['alpha'] } });
      expect('echoOf' in r.explanation!).toBe(false);
      expect(rules(w.router.explain(r.inputId!)!)).toEqual([['to-alpha', undefined], ['to-beta', undefined], ['to-host', undefined], ['room-agent', undefined]]);
    }
    await until(() => w.turns.includes(echo.inputId!) && w.turns.includes(reply.inputId!));
    // alpha has neither, and was given nothing of them to answer.
    expect(await w.view('backend:alpha')).toEqual(['in-1']);
    expect(queue.deferred().map((d) => [d.item.to, d.item.envelope.id])).toEqual([['alpha', 'om_1'], ['alpha', 'in-2']]);
    expect(queue.grantedMessage('alpha', { channel: 'fake', account: 'default', conversationId: 'room', messageId: 'om_1' })).toBe(false);
    // Never set aside: a click, and an envelope whose id proves nothing (no platform evidence). alpha is not asked about them.
    const click = await w.ingress.accept(fakeEnvelope({ id: 'in-3', sender: bob, conversation: room, content: [{ type: 'event', name: 'action', data: { actionId: 'pick:yes', messageId: 'other' } }] }));
    const unsigned = await w.ingress.accept(fakeEnvelope({ id: 'in-4', sender: { channelUserId: 'bob', evidence: 'none' }, conversation: room, text: 'psst' }));
    expect([click.deferred, unsigned.deferred]).toEqual([undefined, undefined]);
    expect(unsigned.hosts?.map((h) => h.to)).toEqual(['alpha', 'beta', undefined]);
    expect(w.asked).toEqual(['in-1', 'om_1', 'in-2']);
    expect(await w.view('backend:alpha')).toEqual(['in-1', 'in-4']);

    // The delivery settles: om_1 is on record as alpha's.
    w.delivered.add('om_1');
    sending.settle();
    await until(() => queue.deferred().length === 0);
    // The echo never reaches alpha; the reply does, behind what was queued meanwhile.
    expect(await w.view('backend:alpha')).toEqual(['in-1', 'in-4', 'in-2']);
    expect(w.settledAs).toEqual(['om_1:alpha:own_echo', 'in-2:alpha:queued']);
    const late = w.router.explain(echo.inputId!)!;
    expect(late.echoOf).toEqual({ backends: ['alpha'], late: true });
    expect('deferred' in late).toBe(false);
    expect(rules(late)).toEqual([['to-alpha', 'own_echo'], ['to-beta', undefined], ['to-host', undefined], ['room-agent', undefined]]);
    const queued = w.router.explain(reply.inputId!)!;
    expect(['echoOf' in queued, 'deferred' in queued, rules(queued)[0]]).toEqual([false, false, ['to-alpha', undefined]]);

    // On record now: the same message handed in again (another account's copy) is the plain echo, and nothing is set aside
    // for it although alpha is sending again.
    w.send();
    const known = await w.ingress.accept(fakeEnvelope({ id: 'om_1', account: 'second', sender: alice, conversation: room, text: 'I am here' }));
    expect(known.origin).toMatchObject({ self: true, principal: null });
    expect([known.deferred, known.explanation!.echoOf, queue.deferred().length]).toEqual([undefined, { backends: ['alpha'] }, 0]);
    expect(w.asked).toEqual(['in-1', 'om_1', 'in-2']);
    for (const l of w.lanes.values()) await l.whenIdle();
    queue.close();
  });

  it('entries a previous process left set aside are settled at the next start by what is on record then: the echo of a delivery that got recorded is dropped, the rest is queued #PB-8 #RS-1', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aio-echo-'));
    dirs.push(dir);
    const path = join(dir, 'q.sqlite');
    const routerPath = join(dir, 'r.sqlite');
    // The room is alpha's alone here: no other rule matches what is said in it.
    const table = () =>
      new Router({ agents: [{ name: 'default', sessionPrefix: '' }], config: { version: 'v1', bindings: [{ id: 'to-alpha', match: { conversation: 'room' }, on: 'host', to: 'alpha' }], identities: [] }, backends: ['alpha'], path: routerPath });
    const queue = new HostQueue({ path });
    queue.register('backend:alpha', 'alpha');
    const first = world(queue, table());
    // alpha is sending two messages; the process ends before either delivery settles (nothing resolves `settled`).
    first.send();
    const a = await first.ingress.accept(fakeEnvelope({ id: 'om_1', sender: bob, conversation: room, text: 'recorded before the stop' }));
    const b = await first.ingress.accept(fakeEnvelope({ id: 'om_2', sender: bob, conversation: room, text: 'unknown at the stop' }));
    const c = await first.ingress.accept(fakeEnvelope({ id: 'in-1', sender: bob, conversation: room, text: 'a person' }));
    expect(queue.deferred()).toHaveLength(3);
    expect(await first.view('backend:alpha')).toEqual([]);
    queue.close();
    first.router.close();

    // The next process: om_1's delivery got on record; om_2's was settled unknown (no id on record).
    const queue2 = new HostQueue({ path });
    const second = world(queue2, table());
    second.delivered.add('om_1');
    expect(second.ingress.resolveDeferred()).toEqual({ dropped: 1, queued: 2 });
    expect(queue2.deferred()).toEqual([]);
    expect(await second.view('backend:alpha')).toEqual(['om_2', 'in-1']);
    expect(second.router.explain(a.inputId!)).toMatchObject({ echoOf: { backends: ['alpha'], late: true }, dropped: 'no_match' });
    expect(rules(second.router.explain(a.inputId!)!)).toEqual([['to-alpha', 'own_echo']]);
    for (const r of [b, c]) {
      const e = second.router.explain(r.inputId!)!;
      expect(['echoOf' in e, 'deferred' in e, 'dropped' in e, rules(e)]).toEqual([false, false, false, [['to-alpha', undefined]]]);
    }
    // Once: nothing is left to settle.
    expect(second.ingress.resolveDeferred()).toEqual({ dropped: 0, queued: 0 });
    queue2.close();
    second.router.close();
  });

  it("mayBeEcho: an envelope can be our message handed back only with evidence that lets its id be trusted, as its source caps it, and never when it is a click #PB-8", () => {
    const src = (evidence: EmitSource['evidence']) => ({ evidence });
    const signed = fakeEnvelope({ id: 'm', sender: alice });
    expect(mayBeEcho(signed)).toBe(true);
    expect(mayBeEcho(signed, src(['platform_signed', 'none']))).toBe(true);
    expect(mayBeEcho(fakeEnvelope({ id: 'm', sender: { channelUserId: 'a@example.test', evidence: 'dkim_pass' } }), src(['dkim_pass', 'none']))).toBe(true);
    // The source may not give that evidence (a bridge without the grant): capped to none, so the id proves nothing.
    expect(mayBeEcho(signed, src(['none']))).toBe(false);
    expect(mayBeEcho(fakeEnvelope({ id: 'm', sender: { channelUserId: 'alice', evidence: 'none' } }))).toBe(false);
    expect(mayBeEcho(fakeEnvelope({ id: 'm', sender: { channelUserId: 'alice', evidence: 'device_only' } }), src(['device_only', 'none']))).toBe(false);
    expect(mayBeEcho(fakeEnvelope({ id: 'm', sender: alice, content: [{ type: 'event', name: 'action', data: { actionId: 'pick:yes' } }] }))).toBe(false);
  });
});

describe('Ingress source stamping (channel-stamping, decision 13)', () => {
  const src = (o: Partial<EmitSource> = {}): EmitSource => ({ channel: 'fake', account: 'default', evidence: ['platform_signed', 'none'], declaresSender: true, ...o });

  it('refuses an envelope claiming another channel, account or reply route, without remembering it #ID-3', async () => {
    const { ingress, lanes } = world();
    const s = src();
    const cases = [
      fakeEnvelope({ id: 'x1', channel: 'lark-bot', sender: alice }),
      fakeEnvelope({ id: 'x2', account: 'other', sender: alice }),
      fakeEnvelope({ id: 'x3', sender: alice, replyRoute: { channel: 'lark-bot', account: 'default', conversationId: 'c1' } }),
      fakeEnvelope({ id: 'x4', sender: alice, replyRoute: { channel: 'fake', account: 'other', conversationId: 'c1' } }),
    ];
    for (const env of cases) {
      const r = await ingress.accept(env, s);
      expect(r).toMatchObject({ accepted: false, action: 'invalid' });
      expect(r.error!.startsWith(SOURCE_MISMATCH)).toBe(true);
      expect(r.inputId).toBeUndefined();
    }
    expect(lanes.size).toBe(0);
    // Not in the dedup table: a conforming envelope with x3's id is accepted afterwards.
    expect(await ingress.accept(fakeEnvelope({ id: 'x3', sender: alice }), s)).toMatchObject({ accepted: true, action: 'dispatch' });
    await lanes.get('fake:default:c1')!.whenIdle();
  });

  it('checks the source before dedup: a forged copy of a seen (channel, account, id) is invalid, not a duplicate #ID-3 #IN-5', async () => {
    const { ingress, lanes } = world();
    const ok = await ingress.accept(fakeEnvelope({ id: 'seen', sender: alice }), src());
    expect(ok.accepted).toBe(true);
    // Emitted by another instance (account "b") but claiming the first one's (channel, account, id).
    const forged = await ingress.accept(fakeEnvelope({ id: 'seen', sender: alice }), src({ account: 'b' }));
    expect(forged).toMatchObject({ accepted: false, action: 'invalid' });
    expect(forged.inputId).toBeUndefined();
    await lanes.get('fake:default:c1')!.whenIdle();
  });

  it('caps evidence beyond the source to none: the owner is a stranger, the explanation keeps the claim, the caller object is untouched #ID-3 #ID-4', async () => {
    const { ingress, lanes } = world();
    const env = fakeEnvelope({ id: 'cap', conversation: group, sender: { ...alice } });
    const r = await ingress.accept(env, src({ evidence: ['device_only', 'none'] }));
    expect(r.accepted).toBe(true);
    expect(r.origin).toMatchObject({ principal: null, evidence: 'none', adapter: 'fake' });
    expect(r.claimedEvidence).toBe('platform_signed');
    expect(r.explanation).toMatchObject({ evidence: 'none', claimedEvidence: 'platform_signed', principal: null });
    expect(r.envelope!.sender.evidence).toBe('none');
    expect(r.envelope).not.toBe(env);
    expect(env.sender.evidence).toBe('platform_signed');
    // Within the cap nothing is copied and nothing is claimed.
    const within = fakeEnvelope({ id: 'ok', sender: alice });
    const w = await ingress.accept(within, src());
    expect(w.envelope).toBe(within);
    expect(w.claimedEvidence).toBeUndefined();
    expect(w.explanation!.claimedEvidence).toBeUndefined();
    expect(w.origin!.principal?.id).toBe('fake:alice');
    for (const l of lanes.values()) await l.whenIdle();
  });

  it('drops sender.declared when the source may not declare senders, also from a trusted agent account #ID-3', async () => {
    const { ingress } = world();
    const env = fakeEnvelope({ id: 'decl', conversation: group, sender: { channelUserId: 'peer', evidence: 'platform_signed', isBot: true, declared: 'runner:x/run:1' } });
    const trusted = await ingress.accept({ ...env, id: 'decl-0' }, src());
    expect(trusted.origin?.declared).toBe('runner:x/run:1');
    const r = await ingress.accept(env, src({ declaresSender: false }));
    expect(r.accepted).toBe(true);
    expect(r.origin?.declared).toBeUndefined();
    expect(r.envelope!.sender.declared).toBeUndefined();
    expect(r.envelope!.sender.evidence).toBe('platform_signed');
    expect(env.sender.declared).toBe('runner:x/run:1');
  });

  it('emitter(source) answers like accept(env, source); without a source nothing is checked or capped #ID-3', async () => {
    const { ingress, lanes } = world();
    const emit = ingress.emitter(src({ evidence: ['none'] }));
    expect(await emit(fakeEnvelope({ id: 'e1', channel: 'other', sender: alice }))).toMatchObject({ accepted: false, permanent: true });
    const ok = await emit(fakeEnvelope({ id: 'e2', conversation: group, sender: alice }));
    expect(ok.accepted).toBe(true);
    const again = await ingress.accept(fakeEnvelope({ id: 'e2', conversation: group, sender: alice }), src({ evidence: ['none'] }));
    expect(again).toMatchObject({ action: 'duplicate', inputId: ok.inputId, claimedEvidence: 'platform_signed', explanation: { evidence: 'none' } });
    // Regression: the trusted path (no source) stamps as claimed.
    const env = fakeEnvelope({ id: 'e3', channel: 'other', sender: { channelUserId: 'alice', evidence: 'dkim_pass' } });
    const t = await ingress.accept(env);
    expect(t).toMatchObject({ accepted: true, origin: { evidence: 'dkim_pass', adapter: 'other' } });
    expect(t.envelope).toBe(env);
    expect(t.claimedEvidence).toBeUndefined();
    for (const l of lanes.values()) await l.whenIdle();
  });
});

describe('Ingress dedup beyond one process and one delivery (IN-5)', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const tempPath = () => {
    const d = mkdtempSync(join(tmpdir(), 'aio-ingress-'));
    dirs.push(d);
    return join(d, 'log.sqlite');
  };

  /** One "process": a SQLite log at `path`, its lanes, an Ingress over them. */
  function processAt(path: string, o: { router?: Router; failLane?: (k: string) => boolean } = {}) {
    const log = new SqliteSessionLog({ path });
    const hub = new Hub(log);
    const policy = defaultPolicy({ owners: ['fake:alice'], run: RUN });
    const lanes = new Map<string, Lane>();
    const harness = new FakeHarness(async () => {});
    const ingress = new Ingress({
      policy,
      ...(o.router ? { router: o.router } : {}),
      lanes: (k) => {
        if (o.failLane?.(k)) throw new Error(`lane ${k} failed to open`);
        let l = lanes.get(k);
        if (!l) lanes.set(k, (l = new Lane({ sessionKey: k, harness, hub, policy, thinkingHeadline: null })));
        return l;
      },
    });
    const admitted = (k: string) => bodies(log.read(k, 0), 'input.admitted');
    const idle = async () => {
      for (const l of lanes.values()) await l.whenIdle();
    };
    const stop = async () => {
      for (const l of lanes.values()) await l.close();
      log.close();
    };
    return { ingress, admitted, idle, stop };
  }

  it('after a restart (a new Ingress) the same (channel, account, id) does not enter the session a second time #IN-5', async () => {
    const path = tempPath();
    const env = fakeEnvelope({ id: 'om_redelivered', sender: alice, text: 'once' });
    const one = processAt(path);
    expect((await one.ingress.accept(env)).action).toBe('dispatch');
    await one.idle();
    expect(one.admitted('fake:default:c1')).toHaveLength(1);
    await one.stop();
    const two = processAt(path);
    await two.ingress.accept({ ...env });
    await two.idle();
    expect(two.admitted('fake:default:c1')).toHaveLength(1);
    await two.stop();
  });

  it('an envelope fanned out to two sessions whose second delivery throws: the redelivery does not give the first session the input twice #IN-5', async () => {
    const router = new Router({
      agents: [{ name: 'default', sessionPrefix: '' }],
      defaultAgent: 'default',
      config: {
        version: 'v',
        identities: [],
        bindings: [
          { id: 'a', match: {}, on: 'dispatch', session: { key: 'A' } },
          { id: 'b', match: {}, on: 'dispatch', session: { key: 'B' } },
        ],
      },
    });
    let failB = true;
    const w = processAt(tempPath(), { router, failLane: (k) => k === 'B' && failB });
    const env = fakeEnvelope({ id: 'om_fanout', sender: alice, text: 'to both' });
    await expect(w.ingress.accept(env)).rejects.toThrow(/lane B failed/);
    failB = false;
    // The adapter forgot its dedup key (the emit failed) and the platform redelivers.
    await w.ingress.accept({ ...env });
    await w.idle();
    expect(w.admitted('B')).toHaveLength(1);
    expect(w.admitted('A')).toHaveLength(1);
    await w.stop();
  });

  it('after a restart a context-only message delivered again is not recorded a second time #IN-5', async () => {
    const path = tempPath();
    const router = () =>
      new Router({
        agents: [{ name: 'default', sessionPrefix: '' }],
        defaultAgent: 'default',
        config: { version: 'v', identities: [], bindings: [{ id: 'c', match: {}, on: 'context', session: { key: 'C' } }] },
      });
    const env = fakeEnvelope({ id: 'om_ctx', sender: alice, text: 'fyi' });
    const one = processAt(path, { router: router() });
    expect((await one.ingress.accept(env)).action).toBe('observe');
    await one.stop();
    const two = processAt(path, { router: router() });
    expect((await two.ingress.accept({ ...env })).result).toEqual({ ok: true, disposition: 'duplicate' });
    expect(two.admitted('C')).toHaveLength(1);
    await two.stop();
  });

  it('past the dedup window: a redelivery still does not enter the session twice, and a revision still replaces its original #IN-5', async () => {
    const hub = new Hub(new MemorySessionLog());
    const policy = defaultPolicy({ owners: ['fake:alice'], run: RUN });
    const lanes = new Map<string, Lane>();
    const harness = new FakeHarness(async () => {});
    const ingress = new Ingress({
      policy,
      dedupWindow: 1,
      lanes: (k) => {
        let l = lanes.get(k);
        if (!l) lanes.set(k, (l = new Lane({ sessionKey: k, harness, hub, policy, thinkingHeadline: null })));
        return l;
      },
    });
    const seg = (text: string) => [{ type: 'transcript' as const, speaker: 'eve', text, startMs: 0, endMs: 900, stable: true }];
    const m1 = fakeEnvelope({ id: 'w1', sender: alice, text: 'first' });
    const first = await ingress.accept(m1);
    const c1 = await ingress.accept(fakeEnvelope({ id: 'c1', sender: stranger, conversation: group, content: seg('helo') }));
    await ingress.accept(fakeEnvelope({ id: 'w2', sender: alice, text: 'second' })); // pushes w1 and c1 out of the window
    expect((await ingress.accept({ ...m1 })).result).toEqual({ ok: true, disposition: 'duplicate' });
    const rev = await ingress.accept(fakeEnvelope({ id: 'c1-r1', revisionOf: 'c1', sender: stranger, conversation: group, content: seg('hello') }));
    expect(rev.inputId).toBe(c1.inputId);
    for (const l of lanes.values()) await l.whenIdle();
    expect(bodies(hub.log.read('fake:default:c1', 0), 'input.admitted').filter((b) => (b as { inputId: string }).inputId === first.inputId)).toHaveLength(1);
    expect(lanes.get('fake:default:g1')!.observed().map((i) => i.content)).toEqual([seg('hello')]);
  });
});
