import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SessionEvent } from '@agents-io/protocol';
import { MemorySessionLog } from '@agents-io/session';
import { FakeChannel, FakeHarness, type FakeTurnScript } from '@agents-io/testkit';
import { resolveConfig } from '../src/config.js';
import { Gateway } from '../src/gateway.js';
import { cleanups, until } from './gateway-helpers.js';

/*
 * `policy.strangers: "ask"` (decision 15): a message from someone the deployment does not know,
 * addressed to it, becomes a question in the owner's chat; nothing runs until the owner allows it.
 */

const alice = { channelUserId: 'alice', evidence: 'platform_signed' as const };
const eve = { channelUserId: 'eve', displayName: 'Eve', evidence: 'platform_signed' as const };

async function setup(o: { strangers?: 'drop' | 'ask'; script?: FakeTurnScript } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'aio-strangers-'));
  const base = resolveConfig(
    { policy: { owners: ['fake:alice'], ownerSessionKey: 'main', strangers: o.strangers ?? 'ask' }, local: { principal: 'me' } },
    { env: {}, baseDir: dir, cwd: dir },
  );
  const config = { ...base, socketPath: join(dir, 'run', 'aio.sock') };
  const chat = new FakeChannel('fake');
  const harness = new FakeHarness(o.script);
  const gw = await Gateway.start({ config, harness, log: new MemorySessionLog(), channels: [{ adapter: chat }], logger: () => {} });
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  cleanups.push(() => gw.stop());
  // The owner's chat becomes known with the owner's first message.
  await chat.inject({ conversation: { id: 'c-alice', kind: 'dm' }, sender: alice, text: 'hi' });
  await until(() => chat.sent.find((s) => s.route.conversationId === 'c-alice' && s.finalized));
  return { gw, chat, harness };
}

const askCard = (chat: FakeChannel) => chat.sent.find((s) => s.route.conversationId === 'c-alice' && s.msg.actions?.some((a) => a.id.startsWith('aio:stranger:')));
const askCards = (chat: FakeChannel) => chat.sent.filter((s) => s.msg.actions?.some((a) => a.id.startsWith('aio:stranger:')));
const click = (chat: FakeChannel, actionId: string, sender = alice) =>
  chat.inject({ conversation: { id: 'c-alice', kind: 'dm' }, sender, content: [{ type: 'event', name: 'action', data: { actionId } }] });
const turnsIn = (gw: Gateway, key: string) => gw.hub.log.read(key, 0).filter((e: SessionEvent) => e.body.t === 'turn.started');

describe('strangers: ask', () => {
  it('a stranger\'s DM runs nothing until the owner allows it; then it runs as that sender, restricted #ID-9', async () => {
    const w = await setup();
    await w.chat.inject({ conversation: { id: 'c-eve', kind: 'dm' }, sender: eve, text: 'can you help me?' });
    const card = await until(() => askCard(w.chat));
    expect(card.msg.text).toContain('Eve');
    expect(card.msg.text).toContain('can you help me?');
    expect(w.harness.sessions).toHaveLength(1); // the owner's only
    expect(w.chat.sent.filter((s) => s.route.conversationId === 'c-eve')).toEqual([]);

    // Someone else's click does nothing.
    await click(w.chat, card.msg.actions![0]!.id, eve);
    expect(w.harness.sessions).toHaveLength(1);

    await click(w.chat, card.msg.actions!.find((a) => a.id.endsWith(':once'))!.id);
    const reply = await until(() => w.chat.sent.find((s) => s.route.conversationId === 'c-eve' && s.finalized));
    expect(reply.edits.at(-1)?.text ?? reply.msg.text).toBe('echo: can you help me?');
    const started = await until(() => w.gw.sessions().find((s) => s.sessionKey !== 'main' && s.sessionKey.includes('c-eve')));
    const turn = turnsIn(w.gw, started.sessionKey)[0]!.body as { run: { profile: string }; owner: string | null };
    expect(turn.run.profile).toBe('restricted');
    // The card says what happened and has no buttons left.
    await until(() => card.edits.at(-1)?.text.includes('Allowed this time'));
    expect(card.edits.at(-1)!.actions).toBeUndefined();

    // "Once" lets in those messages only: the next one is asked about again.
    await w.chat.inject({ conversation: { id: 'c-eve', kind: 'dm' }, sender: eve, text: 'and again' });
    await until(() => askCards(w.chat).length === 2);
  });

  it('"always" makes the sender a guest: later messages go straight to their session #ID-9', async () => {
    const w = await setup();
    await w.chat.inject({ conversation: { id: 'c-eve', kind: 'dm' }, sender: eve, text: 'one' });
    const card = await until(() => askCard(w.chat));
    await click(w.chat, card.msg.actions!.find((a) => a.id.endsWith(':always'))!.id);
    await until(() => w.chat.sent.filter((s) => s.route.conversationId === 'c-eve' && s.finalized).length === 1);
    await w.chat.inject({ conversation: { id: 'c-eve', kind: 'dm' }, sender: eve, text: 'two' });
    await until(() => w.chat.sent.filter((s) => s.route.conversationId === 'c-eve' && s.finalized).length === 2);
    expect(askCards(w.chat)).toHaveLength(1);
  });

  it('messages sent before the owner answers are held on one card; "ignore" runs none of them #ID-9', async () => {
    const w = await setup();
    await w.chat.inject({ conversation: { id: 'c-eve', kind: 'dm' }, sender: eve, text: 'one' });
    const card = await until(() => askCard(w.chat));
    await w.chat.inject({ conversation: { id: 'c-eve', kind: 'dm' }, sender: eve, text: 'two' });
    await click(w.chat, card.msg.actions!.find((a) => a.id.endsWith(':ignore'))!.id);
    await until(() => card.edits.at(-1)?.text.includes('Ignored'));
    expect(card.edits.at(-1)!.text).toContain('(2 messages)');
    expect(w.harness.sessions).toHaveLength(1);
    expect(askCards(w.chat)).toHaveLength(1);
  });

  it('a group message that does not address the deployment is only context, never asked about #ID-9', async () => {
    const w = await setup();
    await w.chat.inject({ conversation: { id: 'g1', kind: 'group' }, sender: eve, admission: 'observe', text: 'chatting' });
    await new Promise((r) => setTimeout(r, 30));
    expect(askCard(w.chat)).toBeUndefined();
  });

  it('a stranger\'s DM activity the adapter marks observe (a reaction) is never asked about and runs nothing #ID-9 #RT-2', async () => {
    const w = await setup();
    await w.chat.inject({
      conversation: { id: 'c-eve', kind: 'dm' },
      sender: eve,
      admission: 'observe',
      content: [{ type: 'event', name: 'reaction', data: { emoji: 'THUMBSUP', action: 'added', messageId: 'om_1' } }],
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(askCard(w.chat)).toBeUndefined();
    expect(w.harness.sessions).toHaveLength(1);
  });

  it('a guest\'s turn asks the owner, in the owner\'s chat, about what it wants to do #ID-9 #RQ-5', async () => {
    const w = await setup({
      script: async (t) => {
        if (!t.inputs.some((i) => i.origin.principal?.labels.includes('guest') || i.origin.principal === null)) {
          t.emit({ t: 'text.snapshot', text: 'ok', final: true }, { audience: 'answer' });
          return;
        }
        t.emit({ t: 'request.opened', requestId: 'r1', kind: 'tool_approval', title: 'rm -rf build', risk: { writes: true }, allowedDecisions: ['allow_once', 'deny'], allowAlways: false, defaultDeny: true });
        const d = await t.waitDecision('r1');
        t.emit({ t: 'text.snapshot', text: `got ${d.kind}`, final: true }, { audience: 'answer' });
      },
    });
    await w.chat.inject({ conversation: { id: 'c-eve', kind: 'dm' }, sender: eve, text: 'clean up' });
    const card = await until(() => askCard(w.chat));
    await click(w.chat, card.msg.actions!.find((a) => a.id.endsWith(':once'))!.id);
    // The guest's turn shows up in the owner's chat with the approval buttons.
    const approval = await until(() =>
      w.chat.sent.find((s) => s.route.conversationId === 'c-alice' && [s.msg, ...s.edits].some((m) => m.actions?.some((a) => a.id.includes('r1')))),
    );
    const allow = [approval.msg, ...approval.edits].flatMap((m) => m.actions ?? []).find((a) => a.id.includes('r1') && a.id.includes('allow_once'))!;
    await click(w.chat, allow.id);
    const reply = await until(() => w.chat.sent.find((s) => s.route.conversationId === 'c-eve' && s.finalized));
    expect(reply.edits.at(-1)?.text ?? reply.msg.text).toBe('got allow_once');
  });

  it('default "drop": a stranger\'s DM is dropped and nobody is asked #ID-9', async () => {
    const w = await setup({ strangers: 'drop' });
    await w.chat.inject({ conversation: { id: 'c-eve', kind: 'dm' }, sender: eve, text: 'hello?' });
    await new Promise((r) => setTimeout(r, 30));
    expect(askCard(w.chat)).toBeUndefined();
    expect(w.harness.sessions).toHaveLength(1);
  });
});
