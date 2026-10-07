import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SessionEvent } from '@agents-io/protocol';
import { MemorySessionLog } from '@agents-io/session';
import { FakeChannel, FakeHarness, type FakeTurnScript } from '@agents-io/testkit';
import { parseAttachLine } from '../src/attach.js';
import { LocalClient } from '../src/client.js';
import { resolveConfig } from '../src/config.js';
import { Gateway } from '../src/gateway.js';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function until<T>(get: () => T | undefined | false, ms = 3000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = get();
    if (v !== undefined && v !== false) return v;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

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

async function setup(script: FakeTurnScript, outputTools = true) {
  const dir = mkdtempSync(join(tmpdir(), 'aio-out-'));
  const base = resolveConfig({ policy: { owners: ['fake:alice'] }, local: { principal: 'me' }, outputTools }, { env: {}, baseDir: dir, cwd: dir });
  const config = { ...base, socketPath: join(dir, 'run', 'aio.sock'), blobs: { ...base.blobs, dir: join(dir, 'blobs') } };
  const chat = new FakeChannel('fake');
  const harness = new FakeHarness(script);
  const gw = await Gateway.start({ config, harness, log: new MemorySessionLog(), channels: [{ adapter: chat }], logger: () => {} });
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  cleanups.push(() => gw.stop());
  const c = await LocalClient.connect(config.socketPath);
  cleanups.push(() => c.close());
  const events: SessionEvent[] = [];
  const sub = await c.subscribe({ sessionKey: 'fake:default:c1', tier: 'full', fromSeq: 0 });
  void (async () => {
    for await (const e of sub) events.push(e);
  })();
  return { gw, chat, harness, events, c };
}

const completed = (evs: SessionEvent[]) => evs.filter((e) => e.body.t === 'turn.completed').length;

describe('dev-gateway host output tools', () => {
  it('mounts a per-binding token; ask_choice buttons → click → choice event in the asking session; outbound denial', async () => {
    const holder: { h?: FakeHarness } = {};
    const results: { isError: boolean; text: string }[] = [];
    const w = await setup(async (t) => {
      const mcp = holder.h!.sessions.at(-1)!.args.mcp;
      const first = t.inputs[0]!.content[0]!;
      if (first.type === 'text') {
        results.push(await mcpCall(mcp, 'ask_choice', { question: 'Red or blue?', options: ['red', 'blue'] }, 'toolu_1'));
        results.push(await mcpCall(mcp, 'send_message', { route: 'fake:default:elsewhere', text: 'leak' }, 'toolu_2'));
        t.emit({ t: 'text.snapshot', text: 'waiting', final: true }, { audience: 'answer' });
      } else {
        t.emit({ t: 'text.snapshot', text: `got ${JSON.stringify(first)}`, final: true }, { audience: 'answer' });
      }
    });
    holder.h = w.harness;
    await w.chat.inject({ sender: { channelUserId: 'alice', evidence: 'platform_signed' }, text: 'ask me' });
    const choiceMsg = await until(() => w.chat.sent.find((s) => s.msg.actions?.some((a) => a.id.startsWith('choice:'))));
    const mcp = w.harness.sessions[0]!.args.mcp!;
    expect(mcp.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    expect(mcp.token.length).toBeGreaterThan(20);
    await until(() => results.length === 2);
    expect(results[0]!.isError).toBe(false);
    expect(results[1]).toMatchObject({ isError: true, text: expect.stringMatching(/outbound policy/) });
    await until(() => completed(w.events) === 1);
    const blue = choiceMsg.msg.actions!.find((a) => a.label === 'blue')!;
    // A card click comes from a conversation kind the policy does not tie to the DM session; it still reaches the asker.
    await w.chat.inject({ sender: { channelUserId: 'alice', evidence: 'platform_signed' }, conversation: { id: 'c1', kind: 'dm' }, content: [{ type: 'event', name: 'action', data: { actionId: blue.id } }] });
    await until(() => completed(w.events) === 2);
    const answer = w.events.filter((e) => e.body.t === 'text.snapshot').map((e) => (e.body as { text: string }).text).at(-1)!;
    expect(answer).toContain('"name":"choice"');
    expect(answer).toContain('"label":"blue"');
    expect((await fetch(mcp.url, { method: 'POST', body: '{}' })).status).toBe(401);
  });

  it('outputTools: false mounts nothing', async () => {
    const w = await setup(async (t) => t.emit({ t: 'text.snapshot', text: 'ok', final: true }, { audience: 'answer' }), false);
    await w.chat.inject({ sender: { channelUserId: 'alice', evidence: 'platform_signed' }, text: 'hi' });
    await until(() => completed(w.events) === 1);
    expect(w.harness.sessions[0]!.args.mcp).toBeUndefined();
    expect(w.gw.tools).toBeUndefined();
  });

  it('attach parses /choose', () => {
    expect(parseAttachLine('/choose ch_1 2')).toEqual({ kind: 'choose', choiceId: 'ch_1', selected: [2] });
    expect(parseAttachLine('/choose ch_1 1,3')).toEqual({ kind: 'choose', choiceId: 'ch_1', selected: [1, 3] });
    expect(parseAttachLine('/choose ch_1')).toMatchObject({ kind: 'error' });
  });
});
