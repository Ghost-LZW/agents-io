import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { FakeTurnScript } from '@agents-io/testkit';
import type { LocalClient } from '../src/client.js';
import { withholding } from '@agents-io/session';
import { cleanups, closeAndWait, daemon, tmp, until, type World } from './helpers.js';
import { mcpCall } from './output-tools-helpers.js';
import { alice, CONV, read as readLog, textOf, turnsIn, world as topicsWorld } from './topics-helpers.js';

/*
 * U20 (docs/HOSTS.md §4.1a): an `outbound.scoped` host checks what goes to the conversations of its
 * scope, the turn's own answer included, with the content; it may `hold`. U21: a dispatch without history.
 */

const answer: FakeTurnScript = async (t) => {
  t.emit({ t: 'text.delta', stream: 'answer', delta: 'secret plan ' }, { audience: 'answer' });
  t.emit({ t: 'text.snapshot', text: 'secret plan for the group', final: true }, { audience: 'answer' });
};

type Result = { ok: boolean; value?: unknown; error?: { code: string } };
const request = (c: LocalClient, f: Record<string, unknown>) => (c as unknown as { request(f: Record<string, unknown>): Promise<Result> }).request(f);

const events = (w: World, key: string, t: string) => w.gw.hub.log.read(key, 0).filter((e) => e.body.t === t).map((e) => e.body as Record<string, unknown>);
const group = { id: 'g1', kind: 'group' as const };
const scope = { routes: [{ channel: 'fake', account: 'default', conversationId: 'g1' }] };
const KEY = 'fake:default:g1';

async function scopedHost(w: World, routes = scope.routes): Promise<{ h: LocalClient; hello: Record<string, unknown> }> {
  const h = await w.client();
  const hello = (await h.hello({ token: w.gw.token, name: 'lb', callouts: ['route', 'outbound.scoped'], outboundScope: { routes } } as never)) as unknown as Record<string, unknown>;
  return { h, hello };
}

const say = (w: World, id: string, text = 'hi', conversation: { id: string; kind: 'group' | 'dm' } = group) =>
  w.chat.inject({ id, sender: { channelUserId: 'alice', evidence: 'platform_signed' }, conversation, text, admission: 'dispatch' });

describe('outbound.scoped: declaring a scope', () => {
  it('a hello names outbound.scoped with a scope: granted with its revision; with outbound too it is invalid; a probe hello changes nothing; a role hello without it clears it; it survives a restart #DL-7', async () => {
    const w = await daemon();
    const probe = await w.client();
    const p = await probe.hello({ token: w.gw.token, name: 'probe' });
    expect(p.features).toEqual(expect.arrayContaining(['callouts.outbound.scope', 'reply.check', 'callout.history']));
    expect(p.host).toBe(false);

    const bad = await w.client();
    await expect(bad.hello({ token: w.gw.token, name: 'lb', callouts: ['outbound', 'outbound.scoped'], outboundScope: scope } as never)).rejects.toMatchObject({ code: 'invalid_frame' });

    const { h, hello } = await scopedHost(w);
    expect(hello).toMatchObject({ host: true, callouts: ['route', 'outbound.scoped'], outboundScope: { revision: 1, routes: 1 } });
    expect(w.gw.host.inScope({ channel: 'fake', account: 'default', conversationId: 'g1' })).toBe(true);
    // A probe while the host is connected: features, no takeover, the scope stays.
    const probe2 = await w.client();
    expect(await probe2.hello({ token: w.gw.token, name: 'probe2', callouts: [] })).toMatchObject({ host: false });
    expect(w.gw.host.outboundScope()?.revision).toBe(1);
    // Replace it as a whole.
    expect(await request(h, { type: 'host.outboundScope', routes: [] })).toMatchObject({ ok: true, value: { revision: 2 } });
    expect(w.gw.host.inScope({ channel: 'fake', account: 'default', conversationId: 'g1' })).toBe(false);
    expect(await request(probe2, { type: 'host.outboundScope', routes: [] })).toMatchObject({ ok: false, error: { code: 'not_scoped' } });
    await request(h, { type: 'host.outboundScope', routes: scope.routes });
    await closeAndWait(w.gw, h);
    // Away and across a restart: still declared.
    await w.stop();
    const w2 = await daemon({ dir: w.dir });
    expect(w2.gw.host.outboundScope()).toMatchObject({ host: 'lb', revision: 3 });
    // A host taking the role without outbound.scoped ends it.
    await w2.host({ callouts: ['route'] });
    expect(w2.gw.host.outboundScope()).toBeUndefined();
  });
});

describe('outbound.scoped: a checked turn', () => {
  it('a turn whose reply route is in scope is checked: no streaming, the answer is asked of the host once with its content after the turn, then sent once #DL-7 #DL-1', async () => {
    const w = await daemon({ script: answer });
    const { h } = await scopedHost(w);
    const asked: Record<string, unknown>[] = [];
    h.onRequest('policy', (f) => {
      if ((f as { hook: string }).hook !== 'outbound') return { on: 'dispatch' };
      asked.push(f);
      return { verdict: 'allow' };
    });
    await say(w, 'om_1');
    await until(() => events(w, KEY, 'delivery.settled').find((e) => e.kind === 'reply'));
    expect(events(w, KEY, 'turn.started')[0]).toMatchObject({ checked: true });
    expect(w.chat.sent).toHaveLength(1);
    expect(w.chat.sent[0]!.edits).toHaveLength(0);
    expect(w.chat.sent[0]!.msg.text).toBe('secret plan for the group');
    expect(w.chat.sent[0]!.msg.progress).toBeUndefined();
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ hook: 'outbound', args: { kind: 'reply', to: { conversationId: 'g1' }, content: { text: 'secret plan for the group' } } });
    expect(events(w, KEY, 'delivery.settled').find((e) => e.kind === 'reply')).toMatchObject({ result: 'delivered', kind: 'reply', turnId: expect.any(String) });
    // Late joiners do not get the unchecked text.
    expect(w.gw.hub.snapshot(KEY).partialText).toBe('');
  });

  it('hold: nothing reaches the channel, one held settlement, and the next turn is told before its input (without the answer) #DL-7 #DL-1', async () => {
    const seen: { inputId: string; content: unknown }[][] = [];
    const w = await daemon({
      script: async (t) => {
        seen.push(t.inputs.map((i) => ({ inputId: i.inputId, content: i.content })));
        await answer(t);
      },
    });
    const { h } = await scopedHost(w);
    h.onRequest('policy', (f) => ((f as { hook: string }).hook === 'outbound' ? { verdict: 'hold', reason: 'not for this group' } : { on: 'dispatch' }));
    await say(w, 'om_1');
    const held = await until(() => events(w, KEY, 'delivery.settled').find((e) => e.result === 'held'));
    expect(held).toMatchObject({ kind: 'reply', reason: 'not for this group' });
    expect(events(w, KEY, 'delivery.settled').filter((e) => e.operationId === held.operationId)).toHaveLength(1);
    expect(w.chat.sent).toHaveLength(0);
    await say(w, 'om_2', 'again');
    await until(() => seen.length === 2);
    const second = seen[1]!;
    expect(second[0]!.inputId).toBe(`held:${held.operationId as string}`);
    const told = JSON.stringify(second[0]!.content);
    expect(told).toContain('上一条回答没有发出。原因：not for this group');
    expect(told).not.toContain('secret plan');
  });

  it('the host away: a checked answer is held (host_unavailable), the turn\'s own reply route too; a route out of scope is not checked and streams as before #DL-7', async () => {
    const w = await daemon({ script: answer });
    const { h } = await scopedHost(w);
    await closeAndWait(w.gw, h);
    await say(w, 'om_1');
    const held = await until(() => events(w, KEY, 'delivery.settled').find((e) => e.result === 'held'));
    expect(held).toMatchObject({ kind: 'reply', reason: 'host_unavailable' });
    expect(w.chat.sent).toHaveLength(0);
    // A DM is not in scope: checked false, streamed (open + final) as without a host.
    await say(w, 'om_dm', 'hi', { id: 'dm-alice', kind: 'dm' });
    const dmKey = 'fake:default:dm-alice';
    await until(() => events(w, dmKey, 'turn.completed').length > 0 && w.chat.sent.some((s) => s.finalized || s.edits.length));
    expect(events(w, dmKey, 'turn.started')[0]).toMatchObject({ checked: false });
    expect(w.chat.sent.filter((s) => s.route.conversationId === 'dm-alice')).toHaveLength(1);
  });

  it('a host without a scope (or none at all) sees no checked field and nothing changes #DL-7 #DL-5', async () => {
    const w = await daemon({ script: answer });
    await w.host({ callouts: ['route', 'outbound'] });
    await say(w, 'om_1');
    await until(() => events(w, KEY, 'turn.completed').length);
    expect(events(w, KEY, 'turn.started')[0]).not.toHaveProperty('checked');
    await until(() => events(w, KEY, 'delivery.settled').length >= 1);
    for (const s of events(w, KEY, 'delivery.settled')) {
      expect(s).not.toHaveProperty('kind');
      expect(s.result).not.toBe('held');
    }
  });

  it('checked survives a restart: the snapshot of a turn still open says checked and has no partial text #DL-7', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow: FakeTurnScript = async (t) => {
      t.emit({ t: 'text.delta', stream: 'answer', delta: 'half an answer' }, { audience: 'answer' });
      await gate;
    };
    const w = await daemon({ script: slow });
    await scopedHost(w);
    await say(w, 'om_1');
    await until(() => events(w, KEY, 'text.delta').length);
    expect(w.gw.hub.snapshot(KEY).turn).toMatchObject({ checked: true });
    expect(w.gw.hub.snapshot(KEY).partialText).toBe('');
    release();
  });
});

describe('outbound.scoped: added routes, cards, external readers', () => {
  it('run.start: a second observe route in scope is a checked mirror (no streaming; held there), the first, out of scope, streams as before #DL-7', async () => {
    const w = await daemon({ raw: { agents: { exec: { harness: 'claude-code', mode: 'task', profile: 'bypass', model: 'haiku' } } }, script: answer });
    const { h } = await scopedHost(w);
    const asked: Record<string, unknown>[] = [];
    h.onRequest('policy', (f) => {
      const a = (f as { args: Record<string, unknown> }).args;
      asked.push(a);
      return { verdict: 'hold', reason: 'not here' };
    });
    const ops = { channel: 'fake', account: 'default', conversationId: 'ops' };
    await h.runStart({ runId: 'm', agent: 'exec', input: [{ type: 'text', text: 'go' }], observe: { routes: [ops, scope.routes[0]!] } });
    const held = await until(() => events(w, 'run:m', 'delivery.settled').find((e) => e.result === 'held'));
    expect(events(w, 'run:m', 'turn.started')[0]).toMatchObject({ checked: false });
    expect(events(w, 'run:m', 'turn.delivery_added')[0]).toMatchObject({ reason: 'mirror', route: { conversationId: 'g1' }, checked: true });
    expect(held).toMatchObject({ kind: 'reply', route: { conversationId: 'g1' }, reason: 'not here' });
    expect(w.chat.sent.filter((x) => x.route.conversationId === 'g1')).toHaveLength(0);
    expect(asked.filter((a) => a.kind === 'reply')).toHaveLength(1);
    expect(asked[0]).toMatchObject({ to: { conversationId: 'g1' }, content: { text: 'secret plan for the group' } });
    await until(() => w.chat.sent.find((x) => x.route.conversationId === 'ops')?.finalized || w.chat.sent.find((x) => x.route.conversationId === 'ops'));
    expect(w.gw.hub.snapshot('run:m').turn ?? { checked: true }).toMatchObject({ checked: true });
  });

  it('a held card settles its request as cancelled: the turn goes on at once, the card is never sent #DL-7', async () => {
    let decision: unknown;
    const w = await daemon({
      script: async (t) => {
        t.emit({ t: 'item.started', item: { itemId: 'tool1', type: 'tool', title: 'AskUserQuestion: which plan?', status: 'running' } }, { itemId: 'tool1' });
        t.emit({ t: 'request.opened', requestId: 'r1', kind: 'question', title: 'Which plan?', risk: {}, questions: [{ id: '0', text: 'Which plan?', options: [{ label: 'A' }, { label: 'B' }] }], allowedDecisions: ['answer'], allowAlways: false, defaultDeny: true }, { itemId: 'tool1', audience: 'approval' });
        decision = await t.waitDecision('r1');
        await answer(t);
      },
    });
    const { h } = await scopedHost(w);
    const kinds: string[] = [];
    h.onRequest('policy', (f) => {
      if ((f as { hook: string }).hook !== 'outbound') return { on: 'dispatch' };
      const kind = (f as { args: { kind: string } }).args.kind;
      kinds.push(kind);
      return kind === 'question' ? { verdict: 'hold', reason: 'ask in DM' } : { verdict: 'allow' };
    });
    const t0 = Date.now();
    await say(w, 'om_1');
    await until(() => events(w, KEY, 'delivery.settled').find((e) => e.kind === 'reply'), 8000);
    expect(Date.now() - t0).toBeLessThan(8000);
    expect(events(w, KEY, 'delivery.settled').find((e) => e.kind === 'question')).toMatchObject({ result: 'held', requestId: 'r1', reason: 'ask in DM' });
    expect(events(w, KEY, 'request.resolved').find((e) => e.requestId === 'r1')).toMatchObject({ by: 'runtime_cancelled' });
    expect(decision).toMatchObject({ kind: 'deny' });
    expect(kinds).toEqual(['question', 'reply']);
    // Only the answer went out.
    expect(w.chat.sent).toHaveLength(1);
    expect(w.chat.sent[0]!.msg.text).toBe('secret plan for the group');
  });

  it('external MCP session_events: a checked turn reads withheld (checking) until it settles, then in full; held (or denied) stays held; the host log has it all #DL-7', async () => {
    const dir = tmp();
    const tokDir = join(dir, 'ext');
    mkdirSync(tokDir, { recursive: true, mode: 0o700 });
    const tokenFile = join(tokDir, 'reader.token');
    const TOKEN = 'reader-token-0123456789';
    writeFileSync(tokenFile, TOKEN + '\n', { mode: 0o600 });
    const native: FakeTurnScript = async (t) => {
      t.emit({ t: 'usage', usage: { tokens: 1 } }, { native: { type: 'result', result: 'secret plan for the group' } });
      await answer(t);
    };
    const w = await daemon({ dir, script: native, raw: { externalMcp: { listen: '127.0.0.1:0', clients: { reader: { tokenFile, scopes: ['read'] } } } } });
    const c = new Client({ name: 'outside', version: '0.0.1' });
    await c.connect(new StreamableHTTPClientTransport(new URL(w.gw.adminStatus().externalMcp!.url), { requestInit: { headers: { authorization: `Bearer ${TOKEN}` } } }));
    cleanups.push(() => c.close());
    const read = async () => {
      const r = (await c.callTool({ name: 'session_events', arguments: { session: KEY, tier: 'full', from_seq: 0, limit: 200 } })) as { content: { text: string }[] };
      if (!r.content[0]!.text.startsWith('{')) throw new Error(r.content[0]!.text);
      return JSON.parse(r.content[0]!.text) as { events: { body: Record<string, unknown>; native?: unknown; withheld?: string }[] };
    };
    const { h } = await scopedHost(w);
    let release!: (v: unknown) => void;
    let verdict: unknown = { verdict: 'allow' };
    h.onRequest('policy', (f) => {
      if ((f as { hook: string }).hook !== 'outbound') return { on: 'dispatch' };
      return new Promise((r) => (release = () => r(verdict)));
    });
    await say(w, 'om_1');
    await until(() => events(w, KEY, 'turn.completed').length > 0 && release);
    const checking = await read();
    expect(JSON.stringify(checking)).not.toContain('secret plan');
    expect(checking.events.find((e) => e.body.t === 'text.snapshot')).toMatchObject({ withheld: 'checking', body: { text: '' } });
    expect(checking.events.some((e) => e.native !== undefined && JSON.stringify(e.native).includes('secret'))).toBe(false);
    // The host's log (and its subscription) has the text.
    expect(events(w, KEY, 'text.snapshot')[0]).toMatchObject({ text: 'secret plan for the group' });
    release(undefined);
    await until(() => events(w, KEY, 'delivery.settled').find((e) => e.kind === 'reply'));
    const after = await read();
    expect(after.events.find((e) => e.body.t === 'text.snapshot')).toMatchObject({ body: { text: 'secret plan for the group' } });
    expect(after.events.find((e) => e.body.t === 'text.snapshot')!.withheld).toBeUndefined();
    // A held one stays held.
    verdict = { verdict: 'hold' };
    release = undefined as never;
    await say(w, 'om_2', 'again');
    await until(() => events(w, KEY, 'turn.completed').length === 2 && !!release);
    release(undefined);
    await until(() => events(w, KEY, 'delivery.settled').find((e) => e.result === 'held'));
    const held = await read();
    const snaps = held.events.filter((e) => e.body.t === 'text.snapshot');
    expect(snaps[1]).toMatchObject({ withheld: 'held', body: { text: '' } });
    // A denied one too: never sent, so never released.
    verdict = { verdict: 'deny', reason: 'no' };
    release = undefined as never;
    await say(w, 'om_3', 'once more');
    await until(() => events(w, KEY, 'turn.completed').length === 3 && !!release);
    release(undefined);
    await until(() => events(w, KEY, 'delivery.settled').find((e) => e.denied === true));
    const denied = await read();
    expect(JSON.stringify(denied.events.slice(-12))).not.toContain('secret plan');
    expect(denied.events.filter((e) => e.body.t === 'text.snapshot')[2]).toMatchObject({ withheld: 'held', body: { text: '' } });
  });
});

describe('U21: a dispatch without history', () => {
  it('a route callout answering history: false hands no channel history for that dispatch #IN-9', async () => {
    const w = await daemon({ raw: { policy: { owners: ['fake:alice'] } } });
    let fetched = 0;
    (w.chat as unknown as { history: () => Promise<unknown[]> }).history = async () => {
      fetched++;
      return [];
    };
    const h = await w.host({ callouts: ['route'] });
    await h.bindingsPut({ version: 'v1', bindings: [{ id: 'all', match: { channel: 'fake' }, on: 'dispatch', callout: { onFailure: 'dispatch' } }], identities: [], onHostDown: 'keep' });
    let history: boolean | undefined = false;
    h.onRequest('policy', () => ({ on: 'dispatch', ...(history === false ? { history: false } : {}) }));
    await say(w, 'om_1');
    await until(() => events(w, KEY, 'turn.completed').length === 1);
    expect(fetched).toBe(0);
    history = undefined;
    await say(w, 'om_2', 'again', { id: 'g2', kind: 'group' });
    await until(() => events(w, 'fake:default:g2', 'turn.completed').length === 1);
    expect(fetched).toBe(1);
  });
});

describe('outbound.content: the outbound hook with the content, no scope', () => {
  const contentHost = async (w: World, callouts = ['route', 'outbound', 'outbound.content']) => {
    const h = await w.client();
    const hello = (await h.hello({ token: w.gw.token, name: 'lb', callouts } as never)) as unknown as Record<string, unknown>;
    return { h, hello };
  };

  it('granted with outbound only; an output tool\'s message is asked once with content, turnId and kind; hold: held, never sent, no agents-io.output; every settlement says its kind; the answer is not checked #DL-5 #DL-7 #DL-1', async () => {
    const holder: { h?: World['harness'] } = {};
    const results: { isError: boolean; text: string }[] = [];
    const w = await daemon({
      raw: { outputTools: true },
      script: async (t) => {
        results.push(await mcpCall(holder.h!.sessions.at(-1)!.args.mcp, 'send_message', { route: 'fake:default:ops', text: 'the plan, privately' }, `toolu_${t.turnId}`));
        await answer(t);
      },
    });
    holder.h = w.harness;
    const probe = await w.client();
    expect((await probe.hello({ token: w.gw.token, name: 'probe' })).features).toEqual(expect.arrayContaining(['callouts.outbound.content', 'callouts.outbound.scope', 'reply.check']));
    const { h, hello } = await contentHost(w);
    expect(hello.callouts).toEqual(['route', 'outbound', 'outbound.content']);
    const asked: Record<string, unknown>[] = [];
    h.onRequest('policy', (f) => {
      if ((f as { hook: string }).hook !== 'outbound') return { on: 'dispatch' };
      asked.push((f as { args: Record<string, unknown> }).args);
      return { verdict: 'hold', reason: 'not to ops' };
    });
    await say(w, 'om_1');
    await until(() => events(w, KEY, 'turn.completed').length > 0 && events(w, KEY, 'delivery.settled').find((e) => e.kind === 'reply'));
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ kind: 'tool', to: { conversationId: 'ops' }, content: { text: 'the plan, privately' }, turnId: expect.any(String), from: { sessionKey: KEY } });
    const held = events(w, KEY, 'delivery.settled').find((e) => e.result === 'held');
    expect(held).toMatchObject({ kind: 'tool', turnId: asked[0]!.turnId, reason: 'not to ops', route: { conversationId: 'ops' } });
    expect(w.chat.sent.filter((s) => s.route.conversationId === 'ops')).toHaveLength(0);
    expect(w.gw.hub.log.read(KEY, 0).filter((e) => e.body.t === 'native' && (e.body as { name: string }).name === 'agents-io.output')).toHaveLength(0);
    expect(results[0]).toMatchObject({ isError: true });
    expect(results[0]!.text).toContain('没有发出');
    // The answer on the turn's own route: as before (no checked field, not asked), its settlement says kind reply.
    expect(events(w, KEY, 'turn.started')[0]).not.toHaveProperty('checked');
    expect(events(w, KEY, 'delivery.settled').find((e) => e.kind === 'reply')).toMatchObject({ result: 'delivered', turnId: asked[0]!.turnId });
    // Alone (without outbound) it names nothing.
    await closeAndWait(w.gw, h);
    const { hello: a } = await contentHost(w, ['route', 'outbound.content']);
    expect(a.callouts).toEqual(['route']);
  });

  it('a text-like attachment comes with its text, an image with its reference only #DL-7', async () => {
    const holder: { h?: World['harness'] } = {};
    const w = await daemon({
      raw: { outputTools: true },
      script: async (t) => {
        const mcp = holder.h!.sessions.at(-1)!.args.mcp;
        await mcpCall(mcp, 'send_file', { path: 'notes.md' }, `toolu_md_${t.turnId}`);
        await mcpCall(mcp, 'send_file', { path: 'pic.png' }, `toolu_png_${t.turnId}`);
        await answer(t);
      },
    });
    holder.h = w.harness;
    writeFileSync(join(w.config.cwd, 'notes.md'), '# private notes\nthe plan\n');
    writeFileSync(join(w.config.cwd, 'pic.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const { h } = await scopedHost(w);
    const asked: Record<string, unknown>[] = [];
    h.onRequest('policy', (f) => {
      if ((f as { hook: string }).hook !== 'outbound') return { on: 'dispatch' };
      asked.push((f as { args: Record<string, unknown> }).args);
      return { verdict: 'allow' };
    });
    await say(w, 'om_1');
    await until(() => asked.filter((a) => a.kind === 'reply').length === 1);
    const tools = asked.filter((a) => a.kind === 'tool') as { content: { attachments: { ref: string; mime: string }[] }; attachmentText?: Record<string, string> }[];
    expect(tools).toHaveLength(2);
    const md = tools[0]!;
    expect(md.attachmentText?.[md.content.attachments[0]!.ref]).toBe('# private notes\nthe plan\n');
    expect(tools[1]!.attachmentText).toBeUndefined();
    expect(tools[1]!.content.attachments[0]!.ref).toMatch(/^sha256:/);
  });

  it('a host\'s own deliver and a stranger notice settle with their kind (host, notice) #DL-1 #DL-7', async () => {
    const w = await daemon({ raw: { policy: { owners: ['fake:alice'], ownerSessionKey: 'main', strangers: 'ask' } } });
    const { h } = await contentHost(w);
    h.onRequest('policy', (f) => ((f as { hook: string }).hook === 'outbound' ? { verdict: 'allow' } : { on: 'dispatch' }));
    await h.deliver({ operationId: 'host-op-1', route: { channel: 'fake', account: 'default', conversationId: 'ops' }, message: { text: 'from the host' } });
    expect(events(w, 'host:lb', 'delivery.settled')[0]).toMatchObject({ result: 'delivered', kind: 'host' });
    await say(w, 'om_a', 'hi', { id: 'c-alice', kind: 'dm' });
    await until(() => w.chat.sent.find((s) => s.route.conversationId === 'c-alice'));
    await w.chat.inject({ id: 'om_eve', conversation: { id: 'c-eve', kind: 'dm' }, sender: { channelUserId: 'eve', displayName: 'Eve', evidence: 'platform_signed' }, text: 'can you help me?' });
    const notice = await until(() => events(w, 'main', 'delivery.settled').find((e) => (e.route as { conversationId: string }).conversationId === 'c-alice' && e.kind === 'notice'));
    expect(notice).toMatchObject({ result: 'delivered' });
  });

  it('a host with outbound only gets { from, to } and its hold denies #DL-5', async () => {
    const holder: { h?: World['harness'] } = {};
    const results: { isError: boolean; text: string }[] = [];
    const w = await daemon({
      raw: { outputTools: true },
      script: async (t) => {
        results.push(await mcpCall(holder.h!.sessions.at(-1)!.args.mcp, 'send_message', { route: 'fake:default:ops', text: 'x' }, `toolu_${t.turnId}`));
        await answer(t);
      },
    });
    holder.h = w.harness;
    const h = await w.host({ name: 'lb', callouts: ['route', 'outbound'] });
    const asked: Record<string, unknown>[] = [];
    h.onRequest('policy', (f) => {
      if ((f as { hook: string }).hook !== 'outbound') return { on: 'dispatch' };
      asked.push((f as { args: Record<string, unknown> }).args);
      return { verdict: 'hold' };
    });
    await say(w, 'om_1');
    await until(() => results.length === 1 && events(w, KEY, 'turn.completed').length > 0);
    expect(Object.keys(asked[0]!).sort()).toEqual(['from', 'to']);
    expect(results[0]!.isError).toBe(true);
    expect(events(w, KEY, 'delivery.settled').some((e) => e.result === 'held' || e.kind !== undefined)).toBe(false);
  });
});

describe('outbound.scoped: the rest of it', () => {
  it('a scope record that does not parse fails closed: every route is checked #DL-7', async () => {
    const w = await daemon();
    w.gw.records.setFlag('host.outbound.scope', '{not json');
    expect(w.gw.host.outboundScope()).toMatchObject({ all: true });
    expect(w.gw.host.inScope({ channel: 'fake', account: 'default', conversationId: 'anything' })).toBe(true);
  });

  it('a live never opens (nor speaks) where the scoped host checks #DL-7 #DL-5', async () => {
    const w = await daemon();
    await scopedHost(w);
    const turn = { sessionKey: KEY, turnId: 't', replyRoute: scope.routes[0], inputs: [], deliveries: [] } as never;
    const liveAllowed = (w.gw as unknown as { liveAllowed(t: unknown, r: unknown): Promise<void> }).liveAllowed.bind(w.gw);
    await expect(liveAllowed(turn, scope.routes[0])).rejects.toThrow(/checked by the host/);
  });

  it('inbound.redispatch: a queued item redispatched to its route in scope runs a checked turn #DL-7 #HQ-4', async () => {
    const w = await daemon({ script: answer });
    const { h } = await scopedHost(w);
    await h.bindingsPut({ version: 'r1', bindings: [{ id: 'to-host', match: { channel: 'fake' }, on: 'host' }], identities: [], onHostDown: 'keep' });
    const asked: Record<string, unknown>[] = [];
    h.onRequest('policy', (f) => {
      if ((f as { hook: string }).hook !== 'outbound') return { on: 'dispatch' };
      asked.push((f as { args: Record<string, unknown> }).args);
      return { verdict: 'allow' };
    });
    await w.chat.inject({ id: 'om_q', sender: { channelUserId: 'alice', evidence: 'platform_signed' }, conversation: group, text: 'hi' });
    const [item] = (await h.inboundRead({ consumer: 'any', after: 0 })).items;
    await h.inboundRedispatch({ cursor: item!.cursor });
    const started = await until(() => events(w, KEY, 'turn.started').find((e) => (e.inputIds as string[]).some((i) => i.endsWith('~r1'))));
    expect(started).toMatchObject({ checked: true, replyRoute: { conversationId: 'g1' } });
    const settled = await until(() => events(w, KEY, 'delivery.settled').find((e) => e.kind === 'reply' && e.turnId === started.turnId));
    expect(settled).toMatchObject({ result: 'delivered' });
    expect(asked.filter((a) => a.kind === 'reply' && a.turnId === started.turnId)).toHaveLength(1);
    const sent = w.chat.sent.find((s) => s.msg.text === 'secret plan for the group');
    expect(sent!.edits).toHaveLength(0);
  });

  it('checked survives a real restart: the open turn still reads checked with no partial text, and nothing unchecked reaches the group #DL-7 #RS-2', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow: FakeTurnScript = async (t) => {
      t.emit({ t: 'text.delta', stream: 'answer', delta: 'half an answer' }, { audience: 'answer' });
      await gate;
    };
    const w = await daemon({ script: slow });
    await scopedHost(w);
    await say(w, 'om_1');
    await until(() => events(w, KEY, 'text.delta').length);
    await w.stop();
    release();
    const w2 = await daemon({ dir: w.dir, script: answer });
    const snap = w2.gw.hub.snapshot(KEY);
    if (snap.turn) {
      expect(snap.turn).toMatchObject({ checked: true });
      expect(snap.partialText).toBe('');
    } else {
      // The stop settled the turn: its log still says it was checked.
      expect(events(w2, KEY, 'turn.started')[0]).toMatchObject({ checked: true });
    }
    expect(w.chat.sent.filter((s) => s.edits.some((e) => e.text.includes('half')) || s.msg.text.includes('half'))).toHaveLength(0);
    expect(w2.chat.sent).toHaveLength(0);
  });
});

describe('outbound.scoped: review of 3653cb0', () => {
  it('deny on a checked answer: rejected and denied, never sent; the agent is told like a hold, without the answer #DL-7 #DL-1', async () => {
    const seen: { inputId: string; content: unknown }[][] = [];
    const w = await daemon({
      script: async (t) => {
        seen.push(t.inputs.map((i) => ({ inputId: i.inputId, content: i.content })));
        await answer(t);
      },
    });
    const { h } = await scopedHost(w);
    h.onRequest('policy', (f) => ((f as { hook: string }).hook === 'outbound' ? { verdict: 'deny', reason: 'not here' } : { on: 'dispatch' }));
    await say(w, 'om_1');
    const denied = await until(() => events(w, KEY, 'delivery.settled').find((e) => e.kind === 'reply'));
    expect(denied).toMatchObject({ result: 'rejected', denied: true, reason: 'not here' });
    expect(w.chat.sent).toHaveLength(0);
    await say(w, 'om_2', 'again');
    await until(() => seen.length === 2);
    expect(seen[1]![0]!.inputId).toBe(`held:${denied.operationId as string}`);
    const told = JSON.stringify(seen[1]![0]!.content);
    expect(told).toContain('上一条回答没有发出。原因：not here');
    expect(told).not.toContain('secret plan');
  });

  it('the scope cleared while a checked turn runs: its answer is still checked, and with no scoped host it is held, not sent (fail closed) #DL-7', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const w = await daemon({
      script: async (t) => {
        await gate;
        await answer(t);
      },
    });
    const { h } = await scopedHost(w);
    h.onRequest('policy', (f) => ((f as { hook: string }).hook === 'outbound' ? { verdict: 'allow' } : { on: 'dispatch' }));
    await say(w, 'om_1');
    await until(() => events(w, KEY, 'turn.started').length);
    expect(events(w, KEY, 'turn.started')[0]).toMatchObject({ checked: true });
    await closeAndWait(w.gw, h);
    // A host taking the role without outbound.scoped clears the scope.
    await w.host({ callouts: ['route'] });
    expect(w.gw.host.outboundScope()).toBeUndefined();
    release();
    const settled = await until(() => events(w, KEY, 'delivery.settled').find((e) => e.kind === 'reply'));
    expect(settled).toMatchObject({ result: 'held', reason: 'host_unavailable', turnId: events(w, KEY, 'turn.started')[0]!.turnId });
    expect(w.chat.sent).toHaveLength(0);
  });

  it('a route a steer adds mid-turn is checked as it is added: checked there (no streaming, asked once), the turn\'s own route out of scope streams as before #DL-7', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const steered: string[] = [];
    const w = await daemon({
      script: async (t) => {
        await gate;
        if (steered.length) t.emit({ t: 'input.consumed', inputIds: steered, turnId: t.turnId });
        await answer(t);
      },
    });
    // A harness that steers: both inputs end up in the running turn.
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
    const { h } = await scopedHost(w);
    await h.bindingsPut({ version: 's1', bindings: [{ id: 'shared', match: { channel: 'fake' }, on: 'dispatch', session: { key: 'shared' } }], identities: [], onHostDown: 'keep' });
    const asked: Record<string, unknown>[] = [];
    h.onRequest('policy', (f) => {
      if ((f as { hook: string }).hook !== 'outbound') return { on: 'dispatch' };
      asked.push((f as { args: Record<string, unknown> }).args);
      return { verdict: 'allow' };
    });
    await say(w, 'om_dm', 'hi', { id: 'dm-alice', kind: 'dm' });
    await until(() => events(w, 'shared', 'turn.started').length);
    expect(events(w, 'shared', 'turn.started')[0]).toMatchObject({ checked: false, replyRoute: { conversationId: 'dm-alice' } });
    await w.chat.inject({ id: 'om_g', sender: { channelUserId: 'alice', evidence: 'platform_signed' }, conversation: group, text: 'and here', admission: 'dispatch', modeHint: 'steer' });
    const added = await until(() => events(w, 'shared', 'turn.delivery_added')[0]);
    expect(added).toMatchObject({ reason: 'steer', route: { conversationId: 'g1' }, checked: true });
    release();
    await until(() => events(w, 'shared', 'turn.completed').length === 1 && events(w, 'shared', 'delivery.settled').find((e) => e.kind === 'reply' && (e.route as { conversationId: string }).conversationId === 'g1'));
    // (Each conversation's own session gets the message too: only the shared session's turn is looked at.)
    const turnId = events(w, 'shared', 'turn.started')[0]!.turnId;
    const ours = w.chat.sent.filter((s) => s.op.operationId.startsWith(`shared:${turnId as string}:`));
    const inGroup = ours.filter((s) => s.route.conversationId === 'g1');
    expect(inGroup).toHaveLength(1);
    expect(inGroup[0]!.edits).toHaveLength(0);
    expect(inGroup[0]!.msg.text).toBe('secret plan for the group');
    expect(asked.filter((a) => a.kind === 'reply' && a.turnId === turnId)).toEqual([expect.objectContaining({ to: expect.objectContaining({ conversationId: 'g1' }), content: { text: 'secret plan for the group' } })]);
    // The turn's own route, out of scope: opened and finished as before, never asked.
    expect(ours.filter((s) => s.route.conversationId === 'dm-alice')).toHaveLength(1);
    expect(ours.find((s) => s.route.conversationId === 'dm-alice')!.finalized || ours.find((s) => s.route.conversationId === 'dm-alice')!.edits.length > 0).toBe(true);
  });

  it('a topic title where the scoped host checks is asked before it is kept (kind title, the title as content, session_rotate\'s summary as details): not allowed, neither is kept anywhere; allowed, kept #DL-7 #TP-1', async () => {
    const { w, tools } = await topicsWorld();
    const h = await w.client();
    await h.hello({ token: w.gw.token, name: 'lb', callouts: ['outbound.scoped'], outboundScope: { routes: [{ channel: 'fake', account: 'default', conversationId: 'c1' }] } } as never);
    const titles: Record<string, unknown>[] = [];
    let verdict: unknown = { verdict: 'hold', reason: 'private' };
    h.onRequest('policy', (f) => {
      const a = (f as { args: Record<string, unknown> }).args;
      if (a.kind !== 'title') return { verdict: 'allow' };
      titles.push(a);
      return verdict;
    });
    await w.chat.inject({ sender: alice, text: 'my codename is HERON' });
    await until(() => turnsIn(w, CONV).length === 1);
    await w.chat.inject({ sender: alice, text: 'something unrelated' });
    const rotated = await until(() => tools.find((t) => t.name === 'session_rotate'));
    expect(rotated.isError).toBe(false);
    expect(rotated.json.topic.title ?? undefined).toBeUndefined();
    const b = w.gw.topics.list({ conversation: CONV }).find((t) => t.state === 'current')!;
    expect(b.sessionKey).not.toBe(CONV);
    expect(b.title).toBeUndefined();
    const summary = 'The user told me their codename.';
    expect(titles).toEqual([expect.objectContaining({ kind: 'title', content: { text: 'Capitals', sections: [{ kind: 'details', text: summary }] }, to: expect.objectContaining({ conversationId: 'c1' }) })]);
    const all = () => w.gw.hub.log.sessions().flatMap((k) => readLog(w, k));
    expect(JSON.stringify(all().filter((e) => e.body.t === 'topic.changed'))).not.toContain('Capitals');
    // The summary is not kept on the topic left (session_list, topic.list) either; topic.changed says so.
    const a = w.gw.topics.list({ conversation: CONV }).find((t) => t.sessionKey === CONV)!;
    expect(a.summary).toBeUndefined();
    expect(readLog(w, CONV).filter((e) => e.body.t === 'topic.changed' && e.body.from === a.id).map((e) => e.body)).toEqual([expect.objectContaining({ to: b.id, reason: 'agent', check: 'held' })]);
    // The new topic still gets it as context (her own note); an external reader of that topic does not.
    const handed = readLog(w, b.sessionKey).find((e) => e.body.t === 'input.admitted' && e.body.input?.channelContext.topicSummary === true)!;
    expect(JSON.stringify(handed.body)).toContain(summary);
    const ext = withholding(readLog(w, b.sessionKey));
    expect(ext.none).toBe(false);
    expect(JSON.stringify(ext.apply(handed, { body: handed.body }))).not.toContain(summary);
    expect(ext.apply(handed, { body: handed.body })).toMatchObject({ withheld: 'held' });
    // Allowed: kept.
    verdict = { verdict: 'allow' };
    await until(() => turnsIn(w, b.sessionKey).length === 1);
    await w.chat.inject({ sender: alice, text: 'another unrelated thing' });
    await until(() => w.gw.topics.list({ conversation: CONV }).find((t) => t.title === 'Capitals'));
    expect(titles).toHaveLength(2);
    expect(w.gw.topics.get(b.id)!.summary).toBe(summary);
    expect(readLog(w, b.sessionKey).filter((e) => e.body.t === 'topic.changed').at(-1)!.body).toMatchObject({ from: b.id, title: 'Capitals', check: 'allowed' });
  });

  it('session_rotate called three times in one checked turn: only the call the host allowed reads; the one failing before the ask and the one refused after it stay withheld (held) #DL-7', async () => {
    const holder: { w?: World } = {};
    const results: { isError: boolean; text: string }[] = [];
    const script: FakeTurnScript = async (t) => {
      const w = holder.w!;
      const text = textOf(t);
      if (/unrelated/.test(text) && !/Summary of the previous topic/.test(text)) {
        const mcp = w.harness.sessions.filter((x) => x.args.sessionKey === CONV).at(-1)!.args.mcp!;
        // As a harness reports an MCP call: item.started, the call, item.completed (same id as its call id).
        const rotate = async (id: string, args: Record<string, unknown>) => {
          const input = JSON.stringify(args);
          const item = { itemId: id, type: 'mcp_tool' as const, title: `agents-io.session_rotate: ${input}`, status: 'running' as const, inputSummary: input, tool: { server: 'agents-io', name: 'session_rotate' } };
          t.emit({ t: 'item.started', item }, { itemId: id });
          const r = await mcpCall(mcp, 'session_rotate', args, `${t.turnId}:${id}`);
          results.push(r);
          t.emit({ t: 'item.completed', item: { ...item, status: r.isError ? 'failed' : 'completed', result: { preview: r.text, truncated: false, isError: r.isError } } }, { itemId: id });
        };
        await rotate('rotA', { title: 'Alpha HERON', summary: '' });
        await rotate('rotB', { title: 'Bravo', summary: 'Nothing private.' });
        await rotate('rotC', { title: 'Charlie HERON', summary: 'Their codename is HERON.' });
      }
      t.emit({ t: 'text.snapshot', text: 'ok', final: true }, { audience: 'answer' });
    };
    const w = await daemon({ script, raw: { outputTools: true } });
    holder.w = w;
    const h = await w.client();
    await h.hello({ token: w.gw.token, name: 'lb', callouts: ['outbound.scoped'], outboundScope: { routes: [{ channel: 'fake', account: 'default', conversationId: 'c1' }] } } as never);
    const titles: unknown[] = [];
    h.onRequest('policy', (f) => {
      const a = (f as { args: Record<string, unknown> }).args;
      if (a.kind === 'title') titles.push(a.content);
      return { verdict: 'allow' };
    });
    await w.chat.inject({ sender: alice, text: 'hello' });
    await until(() => turnsIn(w, CONV).length === 1);
    await w.chat.inject({ sender: alice, text: 'something unrelated' });
    await until(() => results.length === 3 && turnsIn(w, CONV).length === 2);
    // A: refused before the host was asked; B: asked and allowed; C: refused, the turn was already handed.
    expect(results.map((r) => r.isError)).toEqual([true, false, true]);
    expect(titles).toEqual([{ text: 'Bravo', sections: [{ kind: 'details', text: 'Nothing private.' }] }]);
    const log = readLog(w, CONV);
    const ext = withholding(log);
    const seen = (id: string) => log.filter((e) => e.itemId === id).map((e) => ext.apply(e, { body: e.body as unknown }) as { body: unknown; withheld?: string });
    for (const id of ['rotA', 'rotC']) {
      expect(JSON.stringify(seen(id))).not.toContain('HERON');
      expect(seen(id).every((e) => e.withheld === 'held')).toBe(true);
    }
    expect(JSON.stringify(seen('rotB'))).toContain('Bravo');
    expect(seen('rotB').every((e) => e.withheld === undefined)).toBe(true);
  });

  it('a host input to a session in scope: its reply route is local, checked: false, never asked; the next channel turn there is checked #DL-7', async () => {
    const w = await daemon({ script: answer });
    const { h } = await scopedHost(w);
    const asked: Record<string, unknown>[] = [];
    h.onRequest('policy', (f) => {
      if ((f as { hook: string }).hook !== 'outbound') return { on: 'dispatch' };
      asked.push((f as { args: Record<string, unknown> }).args);
      return { verdict: 'allow' };
    });
    await h.input(KEY, 'from the host');
    await until(() => events(w, KEY, 'turn.completed').length === 1);
    expect(events(w, KEY, 'turn.started')[0]).toMatchObject({ checked: false, replyRoute: { channel: 'local' } });
    expect(asked).toHaveLength(0);
    expect(w.chat.sent).toHaveLength(0);
    await say(w, 'om_1');
    await until(() => events(w, KEY, 'delivery.settled').find((e) => e.kind === 'reply'));
    expect(events(w, KEY, 'turn.started')[1]).toMatchObject({ checked: true, replyRoute: { conversationId: 'g1' } });
    expect(asked.filter((a) => a.kind === 'reply')).toHaveLength(1);
  });
});

describe('item.tool: an MCP tool item says its server and tool (HC-7)', () => {
  const mcpTool: FakeTurnScript = async (t) => {
    const item = { itemId: `m_${t.turnId}`, type: 'mcp_tool' as const, title: 'chatlog.sessions_get: {"session":"friendDm"}', status: 'running' as const, tool: { server: 'chatlog', name: 'sessions_get' } };
    t.emit({ t: 'item.started', item }, { itemId: item.itemId });
    t.emit({ t: 'item.completed', item: { ...item, status: 'completed' } }, { itemId: item.itemId });
    await answer(t);
  };
  const items = (w: World, key: string) => events(w, key, 'item.completed').map((b) => b.item as Record<string, unknown>);

  it('kept in the log while an outbound.scoped or outbound.content host is declared; with neither, the item reads as before (no tool) #HC-7', async () => {
    // No host, then a host with outbound only: the title is the same, no `tool`.
    const w = await daemon({ script: mcpTool });
    expect((await (await w.client()).hello({ token: w.gw.token, name: 'probe' })).features).toEqual(expect.arrayContaining(['item.tool']));
    await say(w, 'om_1', 'hi', { id: 'dm-alice', kind: 'dm' });
    await until(() => events(w, 'fake:default:dm-alice', 'turn.completed').length === 1);
    expect(items(w, 'fake:default:dm-alice')).toEqual([expect.not.objectContaining({ tool: expect.anything() })]);
    expect(items(w, 'fake:default:dm-alice')[0]).toMatchObject({ type: 'mcp_tool', title: 'chatlog.sessions_get: {"session":"friendDm"}' });
    const plain = await w.client();
    await plain.hello({ token: w.gw.token, name: 'lb', callouts: ['route', 'outbound'] } as never);
    plain.onRequest('policy', () => ({ verdict: 'allow' }));
    await say(w, 'om_2', 'again', { id: 'dm-alice', kind: 'dm' });
    await until(() => events(w, 'fake:default:dm-alice', 'turn.completed').length === 2);
    expect(items(w, 'fake:default:dm-alice').every((i) => i.tool === undefined)).toBe(true);
    await closeAndWait(w.gw, plain);

    // outbound + outbound.content: kept (a conversation out of any scope too).
    const content = await w.client();
    await content.hello({ token: w.gw.token, name: 'lb', callouts: ['route', 'outbound', 'outbound.content'], takeover: true } as never);
    content.onRequest('policy', (f) => ((f as { hook: string }).hook === 'outbound' ? { verdict: 'allow' } : { on: 'dispatch' }));
    await say(w, 'om_3', 'and again', { id: 'dm-alice', kind: 'dm' });
    await until(() => events(w, 'fake:default:dm-alice', 'turn.completed').length === 3);
    expect(items(w, 'fake:default:dm-alice').at(-1)).toMatchObject({ title: 'chatlog.sessions_get: {"session":"friendDm"}', tool: { server: 'chatlog', name: 'sessions_get' } });
    await closeAndWait(w.gw, content);

    // outbound.scoped: kept, in scope and out of it.
    const { h } = await scopedHost(w);
    h.onRequest('policy', (f) => ((f as { hook: string }).hook === 'outbound' ? { verdict: 'allow' } : { on: 'dispatch' }));
    await say(w, 'om_4');
    await until(() => events(w, KEY, 'turn.completed').length === 1);
    expect(items(w, KEY)).toEqual([expect.objectContaining({ tool: { server: 'chatlog', name: 'sessions_get' } })]);
  });

  it('a host asking only optIn ["item.tool"] gets tool and nothing else changes (no checked, settlements without kind, the same events as with outbound alone); a probe is granted nothing; kept while the host is away, cleared by a host hello without it #HC-7 #DL-5', async () => {
    const w = await daemon({ script: mcpTool });
    const DM = 'fake:default:dm-alice';
    const dm = { id: 'dm-alice', kind: 'dm' as const };
    const turnShape = (n: number) => {
      const turnId = events(w, DM, 'turn.started')[n]!.turnId as string;
      return w.gw.hub.log
        .read(DM, 0)
        .filter((e) => e.turnId === turnId || (e.body as { turnId?: string }).turnId === turnId)
        .map((e) => {
          const b = e.body as Record<string, unknown>;
          const item = b.item as Record<string, unknown> | undefined;
          const { tool: _tool, ...rest } = item ?? {};
          return `${e.audience}/${e.level}/${b.t}:${Object.keys(b).sort().join(',')}${item ? `|${Object.keys(rest).sort().join(',')}` : ''}`;
        });
    };
    // A hello that does not take the host role is granted nothing.
    expect(await (await w.client()).hello({ token: w.gw.token, name: 'probe', optIn: ['item.tool'] } as never)).toMatchObject({ host: false, optIn: [] });
    // With outbound alone (as before): the reference turn.
    const plain = await w.client();
    expect(await plain.hello({ token: w.gw.token, name: 'lb', callouts: ['route', 'outbound'] } as never)).not.toHaveProperty('optIn');
    plain.onRequest('policy', (f) => ((f as { hook: string }).hook === 'outbound' ? { verdict: 'allow' } : { on: 'dispatch' }));
    await say(w, 'om_1', 'hi', dm);
    await until(() => events(w, DM, 'turn.completed').length === 1);
    await closeAndWait(w.gw, plain);
    expect(items(w, DM)[0]).not.toHaveProperty('tool');

    // The same host asking for item.tool: the item keeps tool; every event of the turn has the same fields otherwise.
    const h = await w.client();
    expect(await h.hello({ token: w.gw.token, name: 'lb', callouts: ['route', 'outbound'], optIn: ['item.tool', 'nope'] } as never)).toMatchObject({ host: true, callouts: ['route', 'outbound'], optIn: ['item.tool'] });
    h.onRequest('policy', (f) => ((f as { hook: string }).hook === 'outbound' ? { verdict: 'allow' } : { on: 'dispatch' }));
    await say(w, 'om_2', 'again', dm);
    await until(() => events(w, DM, 'turn.completed').length === 2);
    expect(items(w, DM)[1]).toMatchObject({ title: 'chatlog.sessions_get: {"session":"friendDm"}', tool: { server: 'chatlog', name: 'sessions_get' } });
    expect(turnShape(0)).toEqual(expect.arrayContaining([expect.stringMatching(/item.completed:/), expect.stringMatching(/delivery.settled:/), expect.stringMatching(/turn.started:/)]));
    expect(turnShape(1)).toEqual(turnShape(0));
    expect(events(w, DM, 'turn.started').every((b) => !('checked' in b))).toBe(true);
    expect(events(w, DM, 'delivery.settled').every((b) => !('kind' in b))).toBe(true);
    await closeAndWait(w.gw, h);

    // Away: still kept. A host hello without it: cleared.
    await say(w, 'om_3', 'and again', dm);
    await until(() => events(w, DM, 'turn.completed').length === 3);
    expect(items(w, DM)[2]).toMatchObject({ tool: { name: 'sessions_get' } });
    const again = await w.client();
    await again.hello({ token: w.gw.token, name: 'lb', callouts: ['route', 'outbound'] } as never);
    again.onRequest('policy', (f) => ((f as { hook: string }).hook === 'outbound' ? { verdict: 'allow' } : { on: 'dispatch' }));
    await say(w, 'om_4', 'once more', dm);
    await until(() => events(w, DM, 'turn.completed').length === 4);
    expect(items(w, DM)[3]).not.toHaveProperty('tool');
  });
});
