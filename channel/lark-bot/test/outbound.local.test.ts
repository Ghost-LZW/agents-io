import { describe, expect, it } from 'vitest';
import type { ReplyRoute } from '@agents-io/protocol';
import { LarkBotAdapter, type DeclaredSenderStore } from '../src/index.js';
import { FakeLark } from './fake-lark.js';

/* Rendering and edit-pacing tests with no promise behind them (decision 14: local tier). */

const cfg = { appId: 'cli_x', appSecret: 's', domain: 'lark' as const, editMinIntervalMs: 0 };
const route: ReplyRoute = { channel: 'lark-bot', account: 'acct', conversationId: 'oc_chat' };

function make(config: Record<string, unknown> = {}, store?: DeclaredSenderStore) {
  const lark = new FakeLark();
  const adapter = new LarkBotAdapter({ ...cfg, ...config }, { deps: lark.deps, ...(store ? { store } : {}) });
  return { lark, adapter };
}

describe('send', () => {
  it('sends plain text as a text message to the chat', async () => {
    const { lark, adapter } = make();
    const r = await adapter.send(route, { text: 'hi there' }, { operationId: 'op1' });
    expect(r.providerMessageId).toBe('om_1');
    expect(lark.messages[0]).toMatchObject({ msg_type: 'text', receive: { kind: 'create', chatId: 'oc_chat' } });
    expect(JSON.parse(lark.messages[0]!.content)).toEqual({ text: 'hi there' });
  });

  it('uses a post with md for markdown text, and replies (in thread) when routed to a message', async () => {
    const { lark, adapter } = make();
    await adapter.send(
      { ...route, threadId: 'omt_1', replyToMessageId: 'om_in1' },
      { text: '**bold** and `code`' },
      { operationId: 'op1' },
    );
    expect(lark.messages[0]).toMatchObject({ msg_type: 'post', receive: { kind: 'reply', to: 'om_in1', inThread: true } });
    expect(JSON.parse(lark.messages[0]!.content).zh_cn.content[0][0]).toEqual({ tag: 'md', text: '**bold** and `code`' });
  });

  it('renders sections, actions and link as a schema 2.0 card', async () => {
    const { lark, adapter } = make();
    await adapter.send(
      route,
      {
        text: 'fallback',
        sections: [
          { kind: 'body', text: 'main' },
          { kind: 'details', text: 'log', collapsed: true },
          { kind: 'footer', text: 'done' },
        ],
        actions: [{ id: 'approve', label: 'Approve', style: 'primary' }],
        link: { label: 'Open', url: 'https://x.test' },
      },
      { operationId: 'op1' },
    );
    const m = lark.messages[0]!;
    expect(m.msg_type).toBe('interactive');
    const card = JSON.parse(m.content);
    expect(card.schema).toBe('2.0');
    const els = card.body.elements;
    expect(els[0]).toMatchObject({ tag: 'markdown', content: 'main' });
    expect(els[1]).toMatchObject({ tag: 'collapsible_panel', expanded: false });
    const btn = els.find((e: any) => e.tag === 'button' && e.type === 'primary');
    expect(btn.behaviors[0]).toEqual({ type: 'callback', value: { actionId: 'approve' } });
    expect(els.at(-1).behaviors[0]).toEqual({ type: 'open_url', default_url: 'https://x.test' });
  });

  it('sends channelData verbatim when it is a Lark card, ignores it otherwise', async () => {
    const { lark, adapter } = make();
    const card = { schema: '2.0', header: { title: { tag: 'plain_text', content: 'T' } }, body: { elements: [] } };
    await adapter.send(route, { text: 'x', channelData: card }, { operationId: 'a' });
    await adapter.send(route, { text: 'plain', channelData: { nope: true } }, { operationId: 'b' });
    expect(JSON.parse(lark.messages[0]!.content)).toEqual(card);
    expect(lark.messages[1]!.msg_type).toBe('text');
  });

  it('puts actions on the last part when a card message is split', async () => {
    const { lark, adapter } = make({ maxChars: 30 });
    await adapter.send(route, { text: 'a'.repeat(40) + ' ' + 'b'.repeat(40), actions: [{ id: 'ok', label: 'OK' }] }, { operationId: 'x' });
    expect(lark.messages.map((m) => m.msg_type)).toEqual(['text', 'text', 'interactive']);
  });

  it('fits cards under maxCardBytes by truncating', async () => {
    const { lark, adapter } = make({ maxCardBytes: 2000, maxChars: 100000 });
    await adapter.send(route, { text: 'x'.repeat(10000), actions: [{ id: 'ok', label: 'OK' }] }, { operationId: 'x' });
    expect(Buffer.byteLength(lark.messages[0]!.content)).toBeLessThanOrEqual(2000);
  });
});

describe('edit / finalize / retract / reconcile', () => {
  const streaming = { text: 'working', sections: [{ kind: 'status' as const, text: 'step 1' }] };

  it('patches the card on edit and on finalize', async () => {
    const { lark, adapter } = make();
    const { providerMessageId: id } = await adapter.send(route, streaming, { operationId: 'o' });
    await adapter.edit(route, id!, { ...streaming, text: 'step 2', sections: [{ kind: 'body', text: 'step 2' }] }, { operationId: 'e1', sequence: 1 });
    await adapter.finalize(route, id!, { text: 'done', sections: [{ kind: 'body', text: 'done' }] });
    const m = lark.messages[0]!;
    expect(m.patches).toHaveLength(2);
    expect(JSON.parse(m.patches[0]!).body.elements[0].content).toBe('step 2');
    expect(JSON.parse(m.patches[1]!).body.elements[0].content).toBe('done');
  });

  it('spaces patches of one message by editMinIntervalMs (configurable)', async () => {
    const lark = new FakeLark();
    let t = 1000;
    const slept: number[] = [];
    const adapter = new LarkBotAdapter(
      { ...cfg, editMinIntervalMs: 500 },
      { deps: lark.deps, now: () => t, sleep: async (ms) => (slept.push(ms), (t += ms)) },
    );
    const { providerMessageId: id } = await adapter.send(route, streaming, { operationId: 'o' });
    await adapter.edit(route, id!, { text: 'a' }, { operationId: 'e1', sequence: 1 });
    t += 100;
    await adapter.edit(route, id!, { text: 'b' }, { operationId: 'e2', sequence: 2 });
    expect(slept).toEqual([400]);
  });

  it('edits plain text messages with update instead of patch', async () => {
    const { lark, adapter } = make();
    const { providerMessageId: id } = await adapter.send(route, { text: 'plain' }, { operationId: 'o' });
    await adapter.edit(route, id!, { text: 'plain 2' }, { operationId: 'e', sequence: 1 });
    expect(lark.messages[0]!.updates).toHaveLength(1);
    expect(lark.messages[0]!.patches).toHaveLength(0);
  });

  it('retract replaces the card with the outcome', async () => {
    const { lark, adapter } = make();
    const { providerMessageId: id } = await adapter.send(route, streaming, { operationId: 'o' });
    await adapter.retract(route, id!, 'cancelled by user');
    expect(JSON.parse(lark.messages[0]!.patches[0]!).body.elements[0].content).toBe('cancelled by user');
  });
});
