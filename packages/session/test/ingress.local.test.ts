import { describe, expect, it } from 'vitest';
import { FakeHarness, fakeEnvelope } from '@agents-io/testkit';
import { Hub, Ingress, Lane, MemorySessionLog, defaultPolicy, replySummary } from '../src/index.js';
import type { ChannelCaps, InputRecord } from '@agents-io/protocol';
import { RUN } from './helpers.js';

const alice = { channelUserId: 'alice', evidence: 'platform_signed' as const };

function world(o: { replyCaps?: ConstructorParameters<typeof Ingress>[0]['replyCaps'] } = {}) {
  const hub = new Hub(new MemorySessionLog());
  const policy = defaultPolicy({ owners: ['fake:alice'], run: RUN });
  const lanes = new Map<string, Lane>();
  const seen: InputRecord[] = [];
  const harness = new FakeHarness(async (t) => {
    seen.push(...t.inputs);
  });
  const ingress = new Ingress({
    policy,
    lanes: (k) => {
      let l = lanes.get(k);
      if (!l) lanes.set(k, (l = new Lane({ sessionKey: k, harness, hub, policy, thinkingHeadline: null })));
      return l;
    },
    ...(o.replyCaps ? { replyCaps: o.replyCaps } : {}),
  });
  return { ingress, lanes, seen };
}

describe('Ingress', () => {
  it('passes the envelope context (e.g. a mail subject) to the harness as channelContext', async () => {
    const { ingress, lanes, seen } = world();
    await ingress.accept(fakeEnvelope({ sender: alice, text: 'hi', context: { subject: 'Weekly report', channel: 'spoofed' } }));
    await lanes.get('fake:default:c1')!.whenIdle();
    expect(seen[0]!.channelContext).toMatchObject({ subject: 'Weekly report', channel: 'fake' });
  });

  it('adds a compact reply summary from the rendering adapter caps when configured', async () => {
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
    const { ingress, lanes, seen } = world({ replyCaps: (channel) => (channel === 'fake' ? { caps } : undefined) });
    await ingress.accept(fakeEnvelope({ sender: alice, text: 'hi', context: { reply: 'spoofed' } }));
    await lanes.get('fake:default:c1')!.whenIdle();
    expect(seen[0]!.channelContext.reply).toBe('card markdown=basic maxChars=4000 buttons=yes media=image,file');
    const mail: ChannelCaps = { ...caps, buttons: false, media: { in: [], out: [] }, text: { maxChars: 100000, markdown: 'none' } };
    expect(replySummary(mail, 'final')).toBe('final markdown=none maxChars=100000 buttons=no media=none');
  });
});
