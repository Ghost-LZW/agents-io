import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Deliver } from '@agents-io/protocol';
import { FakeChannel, FakeHarness, type FakeTurnScript } from '@agents-io/testkit';
import { resolveConfig, type HarnessInstance } from '../src/config.js';
import { Gateway, InstanceHarness } from '../src/gateway.js';
import { cleanups, tmp, until } from './helpers.js';

/*
 * Several Lark bots in one daemon (decision 8, docs/design/multi-lark-bot §8.1):
 * two adapters with the channel id `lark-bot`, accounts `a` and `b`. Replies, tool
 * messages and host deliveries go out through the bot of the route's account only.
 */

/** What a harness does with HarnessOpenArgs.mcp: a JSON-RPC tools/call over streamable HTTP. */
async function mcpCall(mcp: { url: string; token: string } | undefined, name: string, args: Record<string, unknown>, callId: string) {
  if (!mcp) throw new Error('no mcp mounted');
  const res = await fetch(mcp.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${mcp.token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args, _meta: { 'claudecode/toolUseId': callId } } }),
  });
  const body = (await res.json()) as { result: { isError?: boolean; content: { text: string }[] } };
  return { isError: !!body.result.isError, text: body.result.content[0]!.text };
}

/** A bot whose connection never comes up: `start` rejects, so the instance ends at once (configured, not running). */
/** A lark-bot whose connection fails. Same adapter class as its siblings: one channel id is one adapter (channel-stamping F4). */
function deadBot(): FakeChannel {
  const ch = new FakeChannel('lark-bot');
  ch.start = async () => {
    throw new Error('connect refused');
  };
  return ch;
}

async function bots(o: { raw?: Record<string, unknown>; script?: FakeTurnScript; accounts?: string[]; dead?: string[] } = {}) {
  const dir = tmp('aio-ml-');
  mkdirSync(join(dir, 'work'), { recursive: true });
  const raw = { dataDir: dir, policy: { owners: ['lark-bot:alice'] }, local: { principal: 'me' }, cwd: join(dir, 'work'), ...o.raw };
  const base = resolveConfig(raw, { env: {}, baseDir: dir, cwd: dir });
  const config = { ...base, socketPath: join(dir, 'run', 'aio.sock') };
  const harness = new FakeHarness(o.script);
  const chans = Object.fromEntries((o.accounts ?? ['a', 'b']).map((acc) => [acc, (o.dead?.includes(acc) ? deadBot() : new FakeChannel('lark-bot'))]));
  const gw = await Gateway.start({
    config,
    buildHarness: (i: HarnessInstance) => new InstanceHarness(i, harness),
    channels: Object.entries(chans).map(([account, adapter]) => ({ adapter, account })),
    logger: () => {},
    listen: false,
  });
  cleanups.push(() => gw.stop());
  return { gw, harness, chans };
}

const alice = { sender: { channelUserId: 'alice', evidence: 'platform_signed' as const } };
const deliver = (route: { channel: string; account: string; conversationId: string }, operationId: string) =>
  ({ v: 1, type: 'deliver', id: 'x', operationId, route, message: { text: 'hi' } }) as unknown as Deliver;

describe('several lark-bot accounts (decision 8)', () => {
  it('a DM to bot b is answered by b only, and its output-tool messages go out through b', async () => {
    const holder: { h?: FakeHarness } = {};
    const tool: { isError: boolean; text: string }[] = [];
    const w = await bots({
      script: async (t) => {
        tool.push(await mcpCall(holder.h!.sessions.at(-1)!.args.mcp, 'ask_choice', { question: 'Red or blue?', options: ['red', 'blue'] }, 'toolu_1'));
        t.emit({ t: 'text.snapshot', text: 'answer from b', final: true }, { audience: 'answer' });
      },
    });
    holder.h = w.harness;
    const { a, b } = w.chans as { a: FakeChannel; b: FakeChannel };
    await b.inject({ ...alice, conversation: { id: 'dm1', kind: 'dm' }, text: 'hello b' });
    await until(() => b.sent.find((s) => s.finalized && JSON.stringify(s.edits.at(-1)).includes('answer from b')));
    expect(tool).toEqual([expect.objectContaining({ isError: false })]);
    expect(b.sent.some((s) => s.msg.actions?.some((x) => x.id.startsWith('choice:')))).toBe(true);
    expect(b.sent.every((s) => s.route.account === 'b')).toBe(true);
    expect(a.sent).toEqual([]);
  });

  it('the same message id arriving at both bots: two inputs, two sessions, two input.verify records', async () => {
    const w = await bots();
    const { a, b } = w.chans as { a: FakeChannel; b: FakeChannel };
    const ra = await a.inject({ ...alice, id: 'om_same', conversation: { id: 'g1', kind: 'dm' }, text: 'to both' });
    const rb = await b.inject({ ...alice, id: 'om_same', conversation: { id: 'g1', kind: 'dm' }, text: 'to both' });
    expect(ra.accepted && rb.accepted).toBe(true);
    expect(ra.inputId).not.toBe(rb.inputId);
    const keys = w.gw.sessions().map((s) => s.sessionKey);
    expect(keys).toEqual(expect.arrayContaining(['lark-bot:a:g1', 'lark-bot:b:g1']));
    expect(w.gw.records.verify('channel:lark-bot/om_same').records.map((r) => r.account).sort()).toEqual(['a', 'b']);
    await until(() => a.sent.find((s) => s.finalized) && b.sent.find((s) => s.finalized));
    expect(a.sent.every((s) => s.route.account === 'a') && b.sent.every((s) => s.route.account === 'b')).toBe(true);
  });

  it('host deliver: to its own account; an account that is not running is unknown_channel (no fallback with several bots)', async () => {
    const w = await bots();
    const { a, b } = w.chans as { a: FakeChannel; b: FakeChannel };
    expect(await w.gw.deliver('xwo', deliver({ channel: 'lark-bot', account: 'b', conversationId: 'c9' }, 'op1'))).toMatchObject({ ok: true });
    expect(b.sent).toHaveLength(1);
    const r = await w.gw.deliver('xwo', deliver({ channel: 'lark-bot', account: 'c', conversationId: 'c9' }, 'op2'));
    expect(r).toMatchObject({ ok: false, code: 'unknown_channel' });
    expect((r as { message: string }).message).toContain('lark-bot (a), lark-bot (b)');
    expect(a.sent).toEqual([]);
    expect(b.sent).toHaveLength(1);
  });

  it('a bot that failed to start is configured but not running: its messages are never sent as the other bot', async () => {
    const w = await bots({ dead: ['b'] });
    const { a } = w.chans as { a: FakeChannel };
    await until(() => ((w.gw as unknown as { channels: { ended?: boolean }[] }).channels.some((c) => c.ended) ? true : undefined));
    const r = (await w.gw.deliver('xwo', deliver({ channel: 'lark-bot', account: 'b', conversationId: 'c9' }, 'op1'))) as { ok: boolean; code: string; message: string };
    expect(r).toMatchObject({ ok: false, code: 'unknown_channel' });
    expect(r.message).toContain('configured but not running');
    expect(r.message).toContain('lark-bot (a)');
    // An account nobody configured is told apart from a configured one that is down.
    const n = (await w.gw.deliver('xwo', deliver({ channel: 'lark-bot', account: 'zz', conversationId: 'c9' }, 'op2'))) as { message: string };
    expect(n.message).toContain('no channel lark-bot with account zz is configured');
    // System replies take the same path: nothing goes out as a.
    await (w.gw as unknown as { systemReply(x: unknown): Promise<void> }).systemReply({ route: { channel: 'lark-bot', account: 'b', conversationId: 'c9' }, text: 'x', operationId: 'sys1', sessionKey: 's' });
    expect(a.sent).toEqual([]);
    // Bot a itself still works.
    expect(await w.gw.deliver('xwo', deliver({ channel: 'lark-bot', account: 'a', conversationId: 'c9' }, 'op3'))).toMatchObject({ ok: true });
    expect(a.sent).toHaveLength(1);
  });

  it('every agent-authored message carries the agent identity (SendOp.as); host deliveries and system replies carry none', async () => {
    const holder: { h?: FakeHarness } = {};
    const w = await bots({
      script: async (t) => {
        await mcpCall(holder.h!.sessions.at(-1)!.args.mcp, 'ask_choice', { question: 'Red or blue?', options: ['red', 'blue'] }, 'toolu_1');
        t.emit({ t: 'text.snapshot', text: 'answer from b', final: true }, { audience: 'answer' });
      },
    });
    holder.h = w.harness;
    const { b } = w.chans as { b: FakeChannel };
    await b.inject({ ...alice, text: 'hi' });
    await until(() => b.sent.some((m) => m.finalized) && b.sent.length >= 2);
    const key = w.harness.sessions.at(-1)!.args.sessionKey;
    expect(b.sent.length).toBeGreaterThanOrEqual(2);
    for (const m of b.sent) expect(m.op.as).toBe(`session:${key}`);
    await w.gw.deliver('xwo', deliver({ channel: 'lark-bot', account: 'b', conversationId: 'c9' }, 'opx'));
    expect(b.sent.at(-1)!.op.as).toBeUndefined();
    await (w.gw as unknown as { systemReply(x: unknown): Promise<void> }).systemReply({ route: { channel: 'lark-bot', account: 'b', conversationId: 'c9' }, text: 'x', operationId: 'sys1', sessionKey: 's' });
    expect(b.sent.at(-1)!.msg).toMatchObject({ text: 'x' });
    expect(b.sent.at(-1)!.op.as).toBeUndefined();
  });

  it('one bot only: a delivery naming another account still goes out, as that bot\'s account', async () => {
    const w = await bots({ accounts: ['solo'] });
    const solo = w.chans.solo!;
    expect(await w.gw.deliver('xwo', deliver({ channel: 'lark-bot', account: 'default', conversationId: 'c9' }, 'op1'))).toMatchObject({ ok: true });
    expect(solo.sent.map((s) => s.route.account)).toEqual(['solo']);
  });

  it('a binding with match.account only takes that bot\'s inputs', async () => {
    const w = await bots({
      raw: { bindings: [{ id: 'only-a', match: { channel: 'lark-bot', account: 'a' }, on: 'dispatch', session: 'per-conversation' }] },
    });
    const { a, b } = w.chans as { a: FakeChannel; b: FakeChannel };
    const ra = await a.inject({ ...alice, id: 'm1', conversation: { id: 'g1', kind: 'group' }, text: 'x' });
    const rb = await b.inject({ ...alice, id: 'm2', conversation: { id: 'g1', kind: 'group' }, text: 'x' });
    expect(ra).toMatchObject({ accepted: true });
    expect(w.gw.router.explain(ra.inputId!)?.matched.map((m) => m.bindingId)).toEqual(['only-a']);
    expect(w.gw.router.explain(rb.inputId!)).toMatchObject({ matched: [], dropped: 'no_match' });
    await until(() => a.sent.find((s) => s.finalized));
    expect(b.sent).toEqual([]);
  });
});
