import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { BodyOf, ChainExplanation, EffectExplanation, RouteExplanation, SessionEvent } from '@agents-io/protocol';
import { agentInput } from '@agents-io/session';
import { FakeChannel, FakeHarness, type FakeTurnScript } from '@agents-io/testkit';
import { ConfigError, resolveConfig, type HarnessInstance } from '../src/config.js';
import { Gateway, InstanceHarness } from '../src/gateway.js';
import { cleanups, daemon, tmp, until } from './helpers.js';
import { CONV, alice, turnsIn, world as topicsWorld } from './topics-helpers.js';

/*
 * Agent messaging foundation through the daemon (docs/design/agent-messaging): the outbound
 * index recognises our own messages coming back through a channel (also through a sibling
 * bot), `explain` follows a side effect to its turn and an input's chain back to its root,
 * and the loop guard reports to both sessions without sending anything.
 */

const answer: FakeTurnScript = async (t) => t.emit({ t: 'text.snapshot', text: 'on it', final: true }, { audience: 'answer' });

/** Two lark-bot accounts `a` and `b` in one daemon (decision 8); only `a` is in nobody's selfAccounts. */
async function bots(raw: Record<string, unknown> = {}) {
  const dir = tmp('aio-am-');
  mkdirSync(join(dir, 'work'), { recursive: true });
  const config = { ...resolveConfig({ dataDir: dir, policy: { owners: ['lark-bot:alice'] }, local: { principal: 'me' }, cwd: join(dir, 'work'), ...raw }, { env: {}, baseDir: dir, cwd: dir }), socketPath: join(dir, 'run', 'aio.sock') };
  const harness = new FakeHarness(answer);
  const chans = { a: new FakeChannel('lark-bot'), b: new FakeChannel('lark-bot') };
  const gw = await Gateway.start({
    config,
    buildHarness: (i: HarnessInstance) => new InstanceHarness(i, harness),
    channels: Object.entries(chans).map(([account, adapter]) => ({ adapter, account })),
    logger: () => {},
    listen: false,
  });
  cleanups.push(() => gw.stop());
  return { gw, chans };
}

const ok = <T>(o: { ok: boolean; value?: unknown }): T => {
  if (!o.ok) throw new Error(`not ok: ${JSON.stringify(o)}`);
  return o.value as T;
};
const of = <K extends SessionEvent['body']['t']>(evs: SessionEvent[], t: K) => evs.filter((e) => e.body.t === t).map((e) => e.body as BodyOf<K>);

describe('the outbound index', () => {
  it("bot a's reply delivered into a group comes back through bot b: self, from the agent that wrote it, recovered — no selfAccounts needed #ID-8 #ID-5", async () => {
    const { gw, chans } = await bots();
    const group = { id: 'g1', kind: 'group' as const };
    // The owner @-s bot a in the group: a turn, a card sent by a.
    const r = await chans.a.inject({ id: 'om_human', sender: { channelUserId: 'alice', evidence: 'platform_signed' }, conversation: group, text: 'hi', admission: 'dispatch' });
    const card = await until(() => chans.a.sent[0]);
    const turnId = await until(() => of(gw.hub.log.read('lark-bot:a:g1', 0), 'turn.started')[0]?.turnId);
    // Lark pushes bot a's message to bot b as well: same platform message id.
    const echo = await chans.b.inject({ id: card.providerMessageId, sender: { channelUserId: 'ou_bot_a', isBot: true, evidence: 'platform_signed' }, conversation: group, text: 'on it' });
    const ex = gw.router.explain(echo.inputId!)!;
    expect(ex.cause).toMatchObject({ basis: 'recovered', hop: 1, chain: r.inputId, from: { sessionKey: 'lark-bot:a:g1', turnId }, rootPrincipal: 'lark-bot:alice' });
    expect(ex.cause!.peer).toMatch(/^[^/]+\/lark-bot:a:g1$/);
    expect(ex.principal).toMatch(/^agent:/);
    // Self: recorded at most as context, never a turn in b's session.
    expect(of(gw.hub.log.read('lark-bot:b:g1', 0), 'turn.started')).toEqual([]);
    expect(chans.b.sent).toEqual([]);
  });

  it('explain by the operationId of a reply card: its turn and that turn\'s inputs; explain --chain walks a recovered input back to the root #EX-2 #EX-6', async () => {
    const { gw, chans } = await bots();
    const group = { id: 'g1', kind: 'group' as const };
    const r = await chans.a.inject({ id: 'om_h', sender: { channelUserId: 'alice', evidence: 'platform_signed' }, conversation: group, text: 'hi', admission: 'dispatch' });
    const card = await until(() => chans.a.sent[0]);
    const turnId = await until(() => of(gw.hub.log.read('lark-bot:a:g1', 0), 'turn.started')[0]?.turnId);
    const fx = ok<EffectExplanation>(gw.explain(card.op.operationId));
    expect(fx).toMatchObject({ operationId: card.op.operationId, sessionKey: 'lark-bot:a:g1', turnId, inputIds: [r.inputId], result: 'delivered', providerMessageId: card.providerMessageId });

    const echo = await chans.b.inject({ id: card.providerMessageId, sender: { channelUserId: 'ou_bot_a', isBot: true, evidence: 'platform_signed' }, conversation: group, text: 'on it' });
    const chain = ok<ChainExplanation>(gw.explain(echo.inputId!, true));
    expect(chain).toMatchObject({ inputId: echo.inputId, chain: r.inputId, end: 'root' });
    expect(chain.links).toMatchObject([
      { inputId: echo.inputId, hop: 1, basis: 'recovered' },
      { inputId: r.inputId, hop: 0, sessionKey: 'lark-bot:a:g1', principal: 'lark-bot:alice', turnId },
    ]);
    expect(chain.links[1]!.address).toMatch(/\/lark-bot:a:g1$/);
    // Unknown ids are an error, not an empty answer.
    expect(gw.explain('nope', true)).toMatchObject({ ok: false, code: 'unknown_input' });
    expect(gw.explain('nope')).toMatchObject({ ok: false, code: 'unknown_input' });
  });

  it('an agent-authored send carries its chain position out-of-band (SendOp.cause); host deliveries carry none #EX-5 #DL-4b', async () => {
    const { gw, chans } = await bots();
    await chans.a.inject({ sender: { channelUserId: 'alice', evidence: 'platform_signed' }, text: 'hi' });
    const card = await until(() => chans.a.sent[0]);
    // A turn a person started is hop 0: what it sends is hop 1 at a recipient; the chain id is opaque.
    expect(card.op).toMatchObject({ as: expect.stringMatching(/^session:/), cause: { hop: 1, chain: expect.stringMatching(/^[0-9a-f]{16}$/) } });
    await gw.deliver('xwo', { v: 1, type: 'deliver', id: 'x', operationId: 'h1', route: { channel: 'lark-bot', account: 'a', conversationId: 'c9' }, message: { text: 'hi' } } as never);
    expect(chans.a.sent.at(-1)!.op.cause).toBeUndefined();
  });
});

describe('explain from a side effect', () => {
  it('a system reply (a topic command) names the input it answers; a host delivery names no turn #EX-2', async () => {
    const { w } = await topicsWorld();
    await w.chat.inject({ sender: alice, text: 'hello' });
    await until(() => turnsIn(w, CONV).length === 1);
    const r = await w.chat.inject({ sender: alice, text: '/topics' });
    const reply = await until(() => w.chat.sent.find((s) => /^Topics/.test(s.msg.text ?? '')));
    const fx = ok<EffectExplanation>(w.gw.explain(reply.op.operationId));
    expect(fx).toMatchObject({ inputIds: [r.inputId], result: 'delivered' });
    expect(fx.turnId).toBeUndefined();
    const h = await w.host();
    await h.deliver({ operationId: 'note-1', route: { channel: 'fake', account: 'default', conversationId: 'c7' }, message: { text: 'from the host' } });
    expect(ok<EffectExplanation>(w.gw.explain('host:note-1'))).toMatchObject({ sessionKey: 'host:xwo', inputIds: [] });
  });
});

describe('loop guard through the daemon', () => {
  it('a trip leaves a loop_guard notice in the receiving and the sending session, explain shows it (also after a restart), nothing goes to a channel #IN-8 #EX-6', async () => {
    const w = await daemon({ raw: { policy: { owners: ['fake:alice'], loopGuard: { maxHops: 2 } } }, script: answer });
    // The sender: a session whose turn exists in this daemon.
    const r = await w.chat.inject({ sender: { channelUserId: 'alice', evidence: 'platform_signed' }, text: 'start' });
    const senderKey = 'fake:default:c1';
    const turnId = await until(() => of(w.gw.hub.log.read(senderKey, 0), 'turn.started')[0]?.turnId);
    await w.gw.lane(senderKey).whenIdle();
    const sentBefore = w.chat.sent.length;
    const deep = agentInput({
      inputId: 'deep1',
      turn: { from: { agent: 'default', sessionKey: senderKey }, turnId, provenance: { external: false, watched: false, group: false, cause: { hop: 2, chain: r.inputId!, rootPrincipal: 'fake:alice' } } },
      content: [{ type: 'text', text: 'and again' }],
      replyRoute: { channel: 'fake', account: 'default', conversationId: 'c2' },
    });
    expect(await w.gw.lane('target').command({ type: 'input', sessionKey: 'target', input: deep, mode: 'queue' })).toEqual({ ok: true, disposition: 'observe_only' });
    const notice = (k: string) => w.gw.hub.log.read(k, 0).filter((e) => e.body.t === 'notice' && e.body.code === 'loop_guard');
    expect(notice('target')).toHaveLength(1);
    expect(notice(senderKey)).toHaveLength(1);
    expect((notice(senderKey)[0]!.body as { message: string }).message).toContain('deep1');
    expect(notice(senderKey)[0]!.visibility).toBe('operators');
    // The chain from the stopped input: it, then the person's input that started the sender's turn.
    const chain = ok<ChainExplanation>(w.gw.explain('deep1', true));
    expect(chain.links).toMatchObject([
      { inputId: 'deep1', hop: 3, sessionKey: 'target', basis: 'internal', loopGuard: { tripped: 'hops', hop: 3, limit: 2 } },
      { inputId: r.inputId, hop: 0, principal: 'fake:alice' },
    ]);
    expect(chain.end).toBe('root');
    await new Promise((res) => setTimeout(res, 50));
    expect(w.chat.sent.length).toBe(sentBefore);
    // The cause index and the logs are in the database: the chain is still there after a restart.
    await w.stop();
    const w2 = await daemon({ dir: w.dir });
    expect(ok<ChainExplanation>(w2.gw.explain('deep1', true))).toMatchObject({ end: 'root', links: [{ inputId: 'deep1', hop: 3 }, { inputId: r.inputId, hop: 0 }] });
  });

  it('inbound.redispatch goes through the same checkpoint: a queued over-hop agent message stays context #IN-8 #HQ-4', async () => {
    const w = await daemon({ raw: { policy: { owners: ['fake:alice'], agentAccounts: ['fake:peerbot'], loopGuard: { maxHops: 3 } } }, script: answer });
    const h = await w.host();
    await h.bindingsPut({ version: 'r1', bindings: [{ id: 'to-host', match: { channel: 'fake', keywords: ['xwo'] }, on: 'host' }], identities: [], onHostDown: 'keep' });
    const r = await w.chat.inject({ sender: { channelUserId: 'peerbot', isBot: true, evidence: 'platform_signed', cause: { hop: 7, chain: 'theirs' } }, conversation: { id: 'g1', kind: 'group' }, text: 'xwo again' });
    expect((w.gw.router.explain(r.inputId!) as RouteExplanation).cause).toEqual({ peer: 'fake:peerbot', basis: 'declared', hop: 7, chain: 'theirs' });
    const [item] = (await h.inboundRead({ consumer: 'any', after: 0 })).items;
    expect(item!.input.cause).toMatchObject({ hop: 7 });
    const res = await h.inboundRedispatch({ cursor: item!.cursor, session: { key: 'R1' } });
    expect(res).toMatchObject({ disposition: 'observe_only' });
    expect(ok(w.gw.explain(res.inputId))).toMatchObject({ loopGuard: { tripped: 'hops', hop: 7, limit: 3, sessionKey: 'R1' } });
    expect(of(w.gw.hub.log.read('R1', 0), 'turn.started')).toEqual([]);
  });
});

describe('agent identity and contact', () => {
  it('a local or host client cannot set a cause or the loopGuard label on its input #ID-7', async () => {
    const seen: { cause?: unknown; channelContext: Record<string, unknown> }[] = [];
    const w = await daemon({ script: async (t) => void seen.push(...t.inputs) });
    for (const c of [await w.client(), await w.host()]) {
      await c.command({
        type: 'input',
        sessionKey: 'S1',
        mode: 'queue',
        input: { content: [{ type: 'text', text: 'hi' }], cause: { peer: 'x/y', basis: 'internal', hop: 1 }, channelContext: { loopGuard: 'hops', note: 'kept' } } as never,
      }).catch(() => undefined);
    }
    await until(() => seen.length >= 1);
    await w.gw.lane('S1').whenIdle();
    for (const i of seen) {
      expect(i.cause).toBeUndefined();
      expect(i.channelContext.loopGuard).toBeUndefined();
    }
  });

  it('a config identity giving an agent the owner label fails the start #ID-7', () => {
    const dir = tmp('aio-am-');
    expect(() => resolveConfig({ dataDir: dir, policy: { owners: ['fake:alice'] }, identities: [{ channel: 'agent', channelUserId: 'default', principal: 'boss', labels: ['owner'] }] }, { env: {}, baseDir: dir, cwd: dir })).toThrow(ConfigError);
    expect(() => resolveConfig({ dataDir: dir, policy: { owners: ['agent:default'] } }, { env: {}, baseDir: dir, cwd: dir })).toThrow(/owner/);
  });

  it('Policy.contact: denied without policy.agentContacts; a host listing the contact callout decides, a failing host falls back to the local answer #CF-9', async () => {
    const w = await daemon();
    const a = { from: { agent: 'default', sessionKey: 'k1' }, to: { agent: 'default' }, op: 'send' as const, turn: null };
    expect(await w.gw.policy.contact(a)).toBe('deny');
    const h = await w.host({ callouts: ['contact'] });
    let answer: unknown = { verdict: 'allow' };
    const asked: unknown[] = [];
    h.onRequest('policy', (f) => {
      asked.push(f);
      return answer;
    });
    expect(await w.gw.policy.contact(a)).toBe('allow');
    expect(asked[0]).toMatchObject({ hook: 'contact', args: { from: a.from, to: a.to, op: 'send', turn: null } });
    answer = { verdict: 'maybe' };
    expect(await w.gw.policy.contact(a)).toBe('deny');
    const allowing = await daemon({ raw: { policy: { owners: ['fake:alice'], agentContacts: [{ from: '*', to: 'default', ops: ['send'] }] } } });
    expect(await allowing.gw.policy.contact(a)).toBe('allow');
    expect(await allowing.gw.policy.contact({ ...a, op: 'run' })).toBe('deny');
  });
});
