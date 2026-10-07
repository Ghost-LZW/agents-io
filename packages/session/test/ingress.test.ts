import { describe, expect, it } from 'vitest';
import { FakeHarness, fakeEnvelope } from '@agents-io/testkit';
import { Hub, Ingress, Lane, MemorySessionLog, actionId, defaultPolicy, parseActionId, type SessionPolicy } from '../src/index.js';
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
