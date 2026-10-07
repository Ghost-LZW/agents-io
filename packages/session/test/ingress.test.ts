import { describe, expect, it } from 'vitest';
import { FakeHarness, fakeEnvelope } from '@agents-io/testkit';
import { Hub, Ingress, Lane, MemorySessionLog, actionId, defaultPolicy, interruptActionId, parseActionId, replySummary, type SessionPolicy } from '../src/index.js';
import type { ChannelCaps, InputRecord } from '@agents-io/protocol';
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
  it('stamps origin from Policy.identify and dispatches owner input to a lane', async () => {
    const { ingress, hub } = world();
    const r = await ingress.accept(fakeEnvelope({ id: 'm1', sender: { ...alice, declared: 'someone-else' }, text: 'hi' }));
    expect(r).toMatchObject({ accepted: true, action: 'dispatch', sessionKey: 'fake:default:c1', result: { ok: true, disposition: 'new_turn' } });
    // The declaration from a non-agent account is dropped: identity comes from policy only.
    expect(r.origin).toEqual({ kind: 'human', principal: { id: 'fake:alice', labels: ['owner'] }, evidence: 'platform_signed', via: 'fake:default:c1', adapter: 'fake' });
    await until(() => bodies(hub.log.read('fake:default:c1', 0), 'turn.completed').length === 1);
  });

  it('passes the envelope context (e.g. a mail subject) to the harness as channelContext', async () => {
    const { ingress, lanes, seen } = world();
    await ingress.accept(fakeEnvelope({ sender: alice, text: 'hi', context: { subject: 'Weekly report', channel: 'spoofed' } }));
    await lanes.get('fake:default:c1')!.whenIdle();
    expect(seen[0]![0]!.channelContext).toMatchObject({ subject: 'Weekly report', channel: 'fake' });
  });

  it('adds a compact reply summary from the rendering adapter caps when configured', async () => {
    const hub = new Hub(new MemorySessionLog());
    const policy = defaultPolicy({ owners: ['fake:alice'], run: RUN });
    const seen: InputRecord[] = [];
    const harness = new FakeHarness(async (t) => {
      seen.push(...t.inputs);
    });
    const lanes = new Map<string, Lane>();
    const caps: ChannelCaps = {
      text: { maxChars: 4000, markdown: 'basic' },
      edit: true,
      buttons: true,
      media: { in: [], out: ['image', 'file'] },
      voiceOut: 'none',
      threads: false,
      approvals: 'buttons',
      defaultTier: 'card',
      evidence: [],
      declaresSender: false,
    };
    const lane = (k: string) => {
      let l = lanes.get(k);
      if (!l) lanes.set(k, (l = new Lane({ sessionKey: k, harness, hub, policy, thinkingHeadline: null })));
      return l;
    };
    const ingress = new Ingress({ policy, lanes: lane, replyCaps: (channel) => (channel === 'fake' ? { caps } : undefined) });
    await ingress.accept(fakeEnvelope({ sender: alice, text: 'hi', context: { reply: 'spoofed' } }));
    await lanes.get('fake:default:c1')!.whenIdle();
    expect(seen[0]!.channelContext.reply).toBe('card markdown=basic maxChars=4000 buttons=yes media=image,file');
    const mail: ChannelCaps = { ...caps, buttons: false, media: { in: [], out: [] }, text: { maxChars: 100000, markdown: 'none' } };
    expect(replySummary(mail, 'final')).toBe('final markdown=none maxChars=100000 buttons=no media=none');
  });

  it('dedups by (channel, id)', async () => {
    const { ingress, lanes } = world();
    const env = fakeEnvelope({ id: 'same', sender: alice });
    const a = await ingress.accept(env);
    const b = await ingress.accept({ ...env });
    expect(b).toMatchObject({ action: 'duplicate', inputId: a.inputId });
    const other = await ingress.accept({ ...env, channel: 'other' });
    expect(other.action).not.toBe('duplicate');
    await lanes.get('fake:default:c1')!.whenIdle();
  });

  it('dedups a duplicate that arrives while the first copy is still being processed', async () => {
    const { ingress, lanes, seen } = world();
    const env = fakeEnvelope({ id: 'twice', sender: alice });
    const rs = await Promise.all([ingress.accept(env), ingress.accept({ ...env })]);
    expect(rs.map((r) => r.action).sort()).toEqual(['dispatch', 'duplicate']);
    expect(rs[1]!.inputId).toBe(rs[0]!.inputId);
    await lanes.get('fake:default:c1')!.whenIdle();
    expect(seen).toHaveLength(1);
  });

  it('dedups per account: the same platform message id reaching two accounts is two envelopes', async () => {
    const { ingress, lanes } = world();
    const a = await ingress.accept(fakeEnvelope({ id: 'om_1', account: 'a', sender: alice }));
    const b = await ingress.accept(fakeEnvelope({ id: 'om_1', account: 'b', sender: alice }));
    expect([a.action, b.action]).toEqual(['dispatch', 'dispatch']);
    expect(b.sessionKey).toBe('fake:b:c1');
    await lanes.get('fake:a:c1')!.whenIdle();
    await lanes.get('fake:b:c1')!.whenIdle();
  });

  it('routes approval and stop clicks to the session that owns the request or turn', async () => {
    const hub = new Hub(new MemorySessionLog());
    const policy = defaultPolicy({ owners: ['fake:alice'], ownerSessionKey: 'main', run: RUN });
    const asked = new FakeHarness(async (t) => {
      t.emit({ t: 'request.opened', requestId: 'r1', kind: 'tool_approval', title: 'push', risk: {}, allowedDecisions: ['allow_once', 'deny'], allowAlways: false, defaultDeny: true });
      await t.waitDecision('r1');
      await new Promise((_, reject) => t.signal.addEventListener('abort', () => reject(new Error('aborted'))));
    });
    const lanes = new Map<string, Lane>();
    const humanPolicy: SessionPolicy = { ...policy, resolve: async () => ({ kind: 'human', principals: ['fake:alice'], routes: [] }) };
    const ingress = new Ingress({
      policy: humanPolicy,
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

  it('drops self echoes and unknown DMs; observes strangers in groups', async () => {
    const { ingress, hub } = world();
    expect(await ingress.accept(fakeEnvelope({ sender: { channelUserId: 'mybot', evidence: 'platform_signed', isBot: true, declared: 'runner:me/run:1' } }))).toMatchObject({
      accepted: true,
      action: 'drop',
      origin: { kind: 'agent', self: true, declared: 'runner:me/run:1' },
    });
    expect(await ingress.accept(fakeEnvelope({ sender: stranger }))).toMatchObject({ action: 'drop' });
    const r = await ingress.accept(fakeEnvelope({ sender: stranger, conversation: group }));
    expect(r).toMatchObject({ action: 'observe', sessionKey: 'fake:default:g1' });
    expect(bodies(hub.log.read('fake:default:g1', 0))).toEqual([{ t: 'input.admitted', inputId: r.inputId, disposition: 'observe_only' }]);
  });

  it('applies revisionOf latest-wins for observe-only transcripts', async () => {
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

  it('rejects invalid envelopes without remembering them', async () => {
    const { ingress } = world();
    const bad = { ...fakeEnvelope({ id: 'bad' }), v: 2 } as unknown as Parameters<Ingress['accept']>[0];
    expect(await ingress.accept(bad)).toMatchObject({ accepted: false, action: 'invalid' });
  });

  it('turns an approval button click into a resolve command (eligibility re-checked by the lane)', async () => {
    const { ingress } = world();
    const click = (sender: typeof alice, aid: string) =>
      ingress.accept(fakeEnvelope({ sender, content: [{ type: 'event', name: 'action', data: { actionId: aid, messageId: 'm1' } }] }));
    expect(await click(alice, actionId('nope', 'allow_once'))).toMatchObject({ action: 'resolve', result: { ok: false, reason: 'unknown_request' } });
    expect(parseActionId('req:a:b:deny')).toEqual({ requestId: 'a:b', kind: 'deny' });
    expect(parseActionId('req:a:answer')).toBeUndefined();
  });
});
