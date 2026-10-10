import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SessionEvent } from '@agents-io/protocol';
import { LarkBotAdapter } from '@agents-io/channel-lark-bot';
import { MemorySessionLog } from '@agents-io/session';
import { FakeHarness, type FakeTurnScript } from '@agents-io/testkit';
import { FakeLark, messageEvent } from '../../../channel/lark-bot/test/fake-lark.js';
import { LocalClient } from '../src/client.js';
import { resolveConfig } from '../src/config.js';
import { Gateway } from '../src/gateway.js';

/* Lark card clicks arrive as conversation kind `other` (no DM/thread info): they must still reach the owning session. */

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

const SESSION = 'main';

async function setup(script: FakeTurnScript) {
  const dir = mkdtempSync(join(tmpdir(), 'aio-lark-'));
  const base = resolveConfig(
    { policy: { owners: ['lark-bot:on_alice'], ownerSessionKey: SESSION }, local: { principal: 'me' }, outputTools: true },
    { env: {}, baseDir: dir, cwd: dir },
  );
  const config = { ...base, socketPath: join(dir, 'run', 'aio.sock'), blobs: { ...base.blobs, dir: join(dir, 'blobs') } };
  const lark = new FakeLark();
  const adapter = new LarkBotAdapter({ appId: 'cli_x', appSecret: 's', domain: 'feishu', editMinIntervalMs: 0, streamTextIntervalMs: 0 }, { deps: lark.deps });
  const harness = new FakeHarness(script);
  const gw = await Gateway.start({
    config,
    harness,
    log: new MemorySessionLog(),
    channels: [{ adapter }],
    policy: { resolve: async () => ({ kind: 'human', principals: ['lark-bot:on_alice'], routes: [] }) },
    logger: () => {},
  });
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  cleanups.push(() => gw.stop());
  const c = await LocalClient.connect(config.socketPath);
  cleanups.push(() => c.close());
  const events: SessionEvent[] = [];
  const sub = await c.subscribe({ sessionKey: SESSION, tier: 'full', fromSeq: 0 });
  void (async () => {
    for await (const e of sub) events.push(e);
  })();
  await until(() => lark.handlers.has('card.action.trigger'));
  return { lark, harness, events, gw };
}

/** Every callback actionId on any card the bot has shown so far. */
function actionIds(lark: FakeLark): string[] {
  const blobs = [...lark.messages.flatMap((m) => [m.content, ...m.patches]), ...[...lark.cards.values()].map((c) => JSON.stringify(c.json))];
  const ids = blobs.flatMap((b) => [...b.replace(/\\"/g, '"').matchAll(/"actionId":"([^"]+)"/g)].map((m) => m[1]!));
  return [...new Set(ids)];
}

const click = (lark: FakeLark, n: number, actionId: string) =>
  lark.fire('card.action.trigger', {
    event_id: `ev_click${n}`,
    operator: { open_id: 'ou_alice', union_id: 'on_alice' },
    action: { tag: 'button', value: { actionId } },
    context: { open_message_id: lark.messages.at(-1)!.id, open_chat_id: 'oc_chat' },
  });

async function mcpCall(mcp: { url: string; token: string } | undefined, name: string, args: Record<string, unknown>, callId: string) {
  if (!mcp) throw new Error('no mcp mounted');
  const res = await fetch(mcp.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${mcp.token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args, _meta: { 'claudecode/toolUseId': callId } } }),
  });
  return (await res.json()) as { result: { isError?: boolean } };
}

const of = (evs: SessionEvent[], t: string) => evs.filter((e) => e.body.t === t).map((e) => e.body as never as Record<string, unknown>);

describe('lark clicks reach the owning session (ownerSessionKey)', () => {
  it('approval and stop buttons on a DM turn in the owner session #RQ-1 #CT-1', async () => {
    const w = await setup(async (t) => {
      const first = t.inputs[0]!.content[0]!;
      if (first.type === 'text' && first.text === 'approve') {
        t.emit({ t: 'request.opened', requestId: 'r1', kind: 'tool_approval', title: 'rm -rf build', risk: { writes: true }, allowedDecisions: ['allow_once', 'deny'], allowAlways: false, defaultDeny: true });
        const d = await t.waitDecision('r1');
        t.emit({ t: 'text.snapshot', text: `got ${d.kind}`, final: true }, { audience: 'answer' });
        return;
      }
      await new Promise((_, rej) => t.signal.addEventListener('abort', () => rej(new Error('stop'))));
    });
    await w.lark.fire('im.message.receive_v1', messageEvent({ id: 'om_a', content: { text: 'approve' } }));
    const allow = await until(() => actionIds(w.lark).find((a) => a.includes('r1') && a.includes('allow_once')));
    await click(w.lark, 1, allow);
    await until(() => of(w.events, 'turn.completed').length === 1);
    expect(of(w.events, 'request.resolved')[0]).toMatchObject({ requestId: 'r1', by: { kind: 'human', id: 'lark-bot:on_alice' } });

    await w.lark.fire('im.message.receive_v1', messageEvent({ id: 'om_b', content: { text: 'long' } }));
    const turnId = (await until(() => of(w.events, 'turn.started')[1]))['turnId'] as string;
    const stop = await until(() => actionIds(w.lark).find((a) => a.includes(turnId)));
    await click(w.lark, 2, stop);
    await until(() => of(w.events, 'turn.completed')[1]);
    expect(of(w.events, 'turn.completed')[1]).toMatchObject({ status: 'interrupted' });
  });

  it('an ask_choice button click reaches the asking owner session #RQ-1', async () => {
    const holder: { h?: FakeHarness } = {};
    const w = await setup(async (t) => {
      const first = t.inputs[0]!.content[0]!;
      if (first.type === 'text') {
        await mcpCall(holder.h!.sessions.at(-1)!.args.mcp, 'ask_choice', { question: 'Red or blue?', options: ['red', 'blue'] }, 'toolu_1');
        t.emit({ t: 'text.snapshot', text: 'waiting', final: true }, { audience: 'answer' });
      } else t.emit({ t: 'text.snapshot', text: `got ${JSON.stringify(first)}`, final: true }, { audience: 'answer' });
    });
    holder.h = w.harness;
    await w.lark.fire('im.message.receive_v1', messageEvent({ id: 'om_c', content: { text: 'ask me' } }));
    const pick = await until(() => actionIds(w.lark).find((a) => a.startsWith('choice:') && a.endsWith(':2')));
    await until(() => of(w.events, 'turn.completed').length === 1);
    await click(w.lark, 3, pick);
    await until(() => of(w.events, 'turn.completed').length === 2);
    const answer = (of(w.events, 'text.snapshot').at(-1)!['text'] as string) ?? '';
    expect(answer).toContain('"name":"choice"');
    expect(answer).toContain('"label":"blue"');
  });
});
