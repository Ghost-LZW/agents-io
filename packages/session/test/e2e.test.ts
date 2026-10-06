import { afterEach, describe, expect, it } from 'vitest';
import { FakeChannel, FakeHarness, assertConformingStream, defaultChannelCaps, type FakeTurnScript } from '@agents-io/testkit';
import type { ChannelCaps, HarnessEvent, RenderedMessage } from '@agents-io/protocol';
import {
  Compositor,
  Hub,
  Ingress,
  Lane,
  MemorySessionLog,
  Outbox,
  defaultPolicy,
  newTurnView,
  renderTurn,
  type SessionPolicy,
} from '../src/index.js';
import { RUN, bodies, until } from './helpers.js';

const SESSION = 'fake:default:c1';
const alice = { channelUserId: 'alice', evidence: 'platform_signed' as const };
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

function world(script: FakeTurnScript, o: { caps?: ChannelCaps; policy?: Partial<SessionPolicy> } = {}) {
  const hub = new Hub(new MemorySessionLog());
  const policy: SessionPolicy = { ...defaultPolicy({ owners: ['fake:alice'], run: RUN }), ...o.policy };
  const raw: HarnessEvent[] = [];
  const lanes = new Map<string, Lane>();
  const harness = new FakeHarness(script);
  const ingress = new Ingress({
    policy,
    lanes: (sessionKey) => {
      let l = lanes.get(sessionKey);
      if (!l) lanes.set(sessionKey, (l = new Lane({ sessionKey, harness, hub, policy, onHarnessEvent: (e) => raw.push(e) })));
      return l;
    },
  });
  const channel = new FakeChannel('fake', o.caps ?? defaultChannelCaps);
  const outbox = new Outbox({ hub, sleep: async () => {} });
  const compositor = new Compositor({ hub, sessionKey: SESSION, adapter: channel, outbox, throttleMs: 5, as: 'runner:me/run:1' });
  compositor.start();
  const ac = new AbortController();
  void channel.start({ account: 'default', config: {}, signal: ac.signal, emit: ingress.emitter(), log: () => {} });
  cleanups.push(async () => {
    ac.abort();
    await compositor.stop();
    for (const l of lanes.values()) await l.close();
  });
  const events = () => hub.log.read(SESSION, 0);
  return { hub, channel, events, raw, lanes };
}

const lastRender = (rec: { msg: RenderedMessage; edits: RenderedMessage[] }) => rec.edits.at(-1) ?? rec.msg;

describe('end to end: channel → ingress → lane → harness → compositor → channel', () => {
  it('streams a card: send, throttled edits, finalize', async () => {
    const w = world(async (t) => {
      const item = { itemId: 'i1', type: 'command' as const, title: 'ls src', status: 'running' as const };
      t.emit({ t: 'item.started', item });
      await new Promise((r) => setTimeout(r, 15));
      t.emit({ t: 'item.completed', item: { ...item, status: 'completed' } });
      t.emit({ t: 'text.delta', delta: 'Found ', stream: 'answer' }, { durability: 'ephemeral', audience: 'answer' });
      t.emit({ t: 'text.snapshot', text: 'Found 3 files', final: false }, { audience: 'answer', durability: 'ephemeral' });
      await new Promise((r) => setTimeout(r, 15));
      t.emit({ t: 'text.snapshot', text: 'Found 3 files.', final: true }, { audience: 'answer' });
    });
    const r = await w.channel.inject({ sender: alice, text: 'list files' });
    expect(r.accepted).toBe(true);
    await until(() => w.channel.sent[0]?.finalized === true);

    expect(w.channel.sent).toHaveLength(1);
    const card = w.channel.sent[0]!;
    expect(card.op).toMatchObject({ as: 'runner:me/run:1' });
    expect(card.route).toEqual({ channel: 'fake', account: 'default', conversationId: 'c1' });
    expect(card.edits.length).toBeGreaterThan(1);
    expect(card.edits.some((m) => m.sections?.some((s) => s.text === '▶ ls src'))).toBe(true);
    expect(lastRender(card)).toMatchObject({ text: 'Found 3 files.', sections: [{ kind: 'status', text: 'Done' }] });

    await until(() => bodies(w.events(), 'delivery.settled').length === 2);
    expect(bodies(w.events(), 'render.anchor')).toHaveLength(1);
    expect(bodies(w.events(), 'delivery.settled').map((b) => (b as { result: string }).result)).toEqual(['delivered', 'delivered']);
    assertConformingStream(w.raw);
    assertConformingStream(w.events());
  });

  it('approval by button click on the card, re-checked server side', async () => {
    const w = world(
      async (t) => {
        t.emit({ t: 'request.opened', requestId: 'r1', kind: 'tool_approval', title: 'git push', risk: { network: true }, allowedDecisions: ['allow_once', 'deny'], allowAlways: false, defaultDeny: true });
        const d = await t.waitDecision('r1');
        t.emit({ t: 'text.snapshot', text: `push ${d.kind}`, final: true }, { audience: 'answer' });
      },
      { policy: { resolve: async (_r, ctx) => ({ kind: 'human', principals: ['fake:alice'], routes: ctx.replyRoute ? ['fake:default:c1'] : [] }) } },
    );
    await w.channel.inject({ sender: alice, text: 'ship it' });
    await until(() => !!w.channel.sent[0] && !!lastRender(w.channel.sent[0]).actions?.length);
    const card = w.channel.sent[0]!;
    const actions = lastRender(card).actions!;
    expect(actions.map((a) => a.label)).toEqual(['Allow', 'Deny']);
    expect(lastRender(card).sections).toContainEqual({ kind: 'status', text: 'Approval needed: git push' });

    const click = (sender: typeof alice, id: string) =>
      w.channel.inject({ sender, content: [{ type: 'event', name: 'action', data: { actionId: id, messageId: card.providerMessageId } }] });
    // Someone else clicking the owner's button is refused by the lane.
    await click({ channelUserId: 'eve', evidence: 'platform_signed' }, actions[0]!.id);
    await click(alice, actions[0]!.id);
    await until(() => card.finalized);
    expect(lastRender(card).text).toBe('push allow_once');
    expect(lastRender(card).actions).toBeUndefined();
    expect(bodies(w.events(), 'request.resolved')).toEqual([{ t: 'request.resolved', requestId: 'r1', decision: { kind: 'allow_once' }, by: { kind: 'human', id: 'fake:alice' } }]);
  });

  it('final-tier channel without edit: one message per turn, plus one per human request', async () => {
    const caps: ChannelCaps = { ...defaultChannelCaps, edit: false, buttons: false, defaultTier: 'final' };
    const w = world(
      async (t) => {
        t.emit({ t: 'text.snapshot', text: 'thinking out loud', final: false }, { audience: 'answer' });
        t.emit({ t: 'request.opened', requestId: 'r1', kind: 'tool_approval', title: 'rm', risk: {}, allowedDecisions: ['allow_once', 'deny'], allowAlways: false, defaultDeny: true });
        await t.waitDecision('r1');
        t.emit({ t: 'text.snapshot', text: 'answer', final: true }, { audience: 'answer' });
      },
      { caps, policy: { resolve: async () => ({ kind: 'human', principals: ['fake:alice'], routes: [] }) } },
    );
    await w.channel.inject({ sender: alice, text: 'go' });
    await until(() => w.channel.sent.length === 1);
    expect(w.channel.sent[0]!.msg).toEqual({ text: 'Approval needed: rm' });
    const lane = w.lanes.get(SESSION)!;
    await lane.command({ type: 'resolve', sessionKey: SESSION, requestId: 'r1', decision: { kind: 'allow_once' }, origin: { kind: 'human', principal: { id: 'fake:alice', labels: ['owner'] }, evidence: 'platform_signed', via: 'web', adapter: 'web' } });
    await until(() => w.channel.sent.length === 2);
    expect(w.channel.sent[1]!.msg).toEqual({ text: 'answer' });
    expect(w.channel.sent.every((s) => s.edits.length === 0)).toBe(true);
  });
});

describe('renderTurn', () => {
  it('renders headline and final tiers', () => {
    const v = newTurnView('t');
    v.currentTool = 'edit src/foo.ts';
    expect(renderTurn(v, 'headline')).toEqual({ text: '▶ edit src/foo.ts', spokenText: '▶ edit src/foo.ts' });
    v.text = 'partial';
    expect(renderTurn(v, 'final')).toEqual({ text: 'partial' });
    expect(renderTurn({ ...v, text: 'x'.repeat(50) }, 'card', { caps: { buttons: true, text: { maxChars: 10, markdown: 'none' } } }).text).toHaveLength(10);
  });
});
