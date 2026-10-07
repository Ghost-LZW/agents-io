import { describe, expect, it } from 'vitest';
import type { ReplyRoute } from '@agents-io/protocol';
import { LarkApiError, LarkBotAdapter, MemoryDeclaredSenderStore, uuidFor, type DeclaredSenderStore } from '../src/index.js';
import { FakeLark, messageEvent, startAdapter, tick } from './fake-lark.js';

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

  it('is idempotent: same operationId gives one platform message and a stable uuid', async () => {
    const { lark, adapter } = make();
    const a = await adapter.send(route, { text: 'x' }, { operationId: 'op-same' });
    const b = await adapter.send(route, { text: 'x' }, { operationId: 'op-same' });
    expect(b).toEqual(a);
    expect(lark.messages).toHaveLength(1);
    expect(lark.messages[0]!.uuid).toBe(uuidFor('default', 'op-same', 0));
    expect(lark.messages[0]!.uuid!.length).toBeLessThanOrEqual(50);
    expect(uuidFor('default', 'other')).not.toBe(uuidFor('default', 'op-same'));
    // a fresh adapter (process restart) re-sends with the same uuid, so Lark itself dedups
    const fresh = new LarkBotAdapter(cfg, { deps: lark.deps });
    const c = await fresh.send(route, { text: 'x' }, { operationId: 'op-same' });
    expect(c).toEqual(a);
    expect(lark.messages).toHaveLength(1);
  });

  it('retries a failed operation under the same uuid', async () => {
    const { lark, adapter } = make();
    const orig = lark.client.im.v1.message.create;
    let calls = 0;
    lark.client.im.v1.message.create = async (p) => {
      if (calls++ === 0) return { code: 99991400, msg: 'rate limited' };
      return orig(p);
    };
    await expect(adapter.send(route, { text: 'x' }, { operationId: 'op' })).rejects.toBeInstanceOf(LarkApiError);
    await expect(adapter.send(route, { text: 'x' }, { operationId: 'op' })).resolves.toEqual({ providerMessageId: 'om_1' });
  });

  it('splits text longer than caps.text.maxChars, one uuid per part, returns the last part id', async () => {
    const { lark, adapter } = make({ maxChars: 50 });
    expect(adapter.caps('a').text.maxChars).toBe(50);
    const text = Array.from({ length: 8 }, (_, i) => `paragraph number ${i} with filler`).join('\n\n');
    const r = await adapter.send(route, { text }, { operationId: 'big' });
    expect(lark.messages.length).toBeGreaterThan(3);
    for (const m of lark.messages) expect(JSON.parse(m.content).text.length).toBeLessThanOrEqual(50);
    expect(lark.messages.map((m) => JSON.parse(m.content).text).join('\n\n')).toBe(text);
    expect(new Set(lark.messages.map((m) => m.uuid)).size).toBe(lark.messages.length);
    expect(r.providerMessageId).toBe(lark.messages.at(-1)!.id);
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

  it('drops stale or duplicate edit sequences', async () => {
    const { lark, adapter } = make();
    const { providerMessageId: id } = await adapter.send(route, streaming, { operationId: 'o' });
    await adapter.edit(route, id!, { text: 'b' }, { operationId: 'e2', sequence: 2 });
    await adapter.edit(route, id!, { text: 'a' }, { operationId: 'e1', sequence: 1 });
    await adapter.edit(route, id!, { text: 'b' }, { operationId: 'e2', sequence: 2 });
    expect(lark.messages[0]!.patches).toHaveLength(1);
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

  it('reconcile reports alive, gone (deleted flag) and gone (error code)', async () => {
    const { lark, adapter } = make();
    const { providerMessageId: id } = await adapter.send(route, streaming, { operationId: 'o' });
    expect(await adapter.reconcile(route, id!)).toBe('alive');
    lark.messages[0]!.deleted = true;
    expect(await adapter.reconcile(route, id!)).toBe('gone');
    expect(await adapter.reconcile(route, 'om_missing')).toBe('gone');
  });

  it('surfaces API failures as LarkApiError with the platform code', async () => {
    const { adapter } = make();
    await expect(adapter.edit(route, 'om_missing', { text: 'x' }, { operationId: 'e', sequence: 1 })).rejects.toMatchObject({ code: 230002 });
  });
});

describe('declared sender', () => {
  it('records op.as and recovers it as sender.declared when the platform delivers the bot message', async () => {
    const { lark, adapter } = make();
    const run = startAdapter(adapter);
    await tick();
    const { providerMessageId: id } = await adapter.send(route, { text: 'from agent' }, { operationId: 'o', as: 'runner:x/run:y' });
    await adapter.send(route, { text: 'no declaration' }, { operationId: 'o2' });
    await lark.fire(
      'im.message.receive_v1',
      messageEvent({ id: id!, chatType: 'group', senderType: 'app', sender: { open_id: 'ou_bot' }, content: { text: 'from agent' } }),
    );
    const e = run.envs[0]!;
    expect(e.sender).toMatchObject({ channelUserId: 'ou_bot', isBot: true, declared: 'runner:x/run:y' });
    expect(e.admission).toBe('observe');
    run.ctl.abort();
    await run.done;
  });

  it('never derives declared from text or for humans', async () => {
    const { lark, adapter } = make();
    const run = startAdapter(adapter);
    await tick();
    await lark.fire('im.message.receive_v1', messageEvent({ id: 'om_h', content: { text: '[as runner:evil/run:1] hi' } }));
    await lark.fire('im.message.receive_v1', messageEvent({ id: 'om_b', senderType: 'app', sender: { open_id: 'ou_otherbot' } }));
    expect(run.envs.map((e) => e.sender.declared)).toEqual([undefined, undefined]);
    run.ctl.abort();
    await run.done;
  });

  it('uses a host-supplied persistent store', async () => {
    const calls: [string, string][] = [];
    const inner = new MemoryDeclaredSenderStore();
    const store: DeclaredSenderStore = {
      set: async (id, as) => (calls.push([id, as]), inner.set(id, as)),
      get: async (id) => inner.get(id),
    };
    const { adapter } = make({}, store);
    await adapter.send(route, { text: 'x' }, { operationId: 'o', as: 'a/b' });
    expect(calls).toEqual([['om_1', 'a/b']]);
    expect(await adapter.declaredSenderOf('om_1')).toBe('a/b');
  });
});

describe('routes of another account (several bots in one daemon)', () => {
  it('send / edit / finalize / retract refuse a route of another account, not retryable, without calling the API', async () => {
    const { lark, adapter } = make();
    const run = startAdapter(adapter, { account: 'a' });
    await tick();
    const { providerMessageId: id } = await adapter.send({ ...route, account: 'a' }, { text: 'mine' }, { operationId: 'o1' });
    const before = lark.messages.length;
    const other = { ...route, account: 'b' };
    for (const call of [
      () => adapter.send(other, { text: 'not mine' }, { operationId: 'o2' }),
      () => adapter.edit(other, id!, { text: 'x' }, { operationId: 'o1', sequence: 1 }),
      () => adapter.finalize(other, id!, { text: 'x' }),
      () => adapter.retract(other, id!, 'failed'),
    ]) {
      const err = await call().then(() => undefined, (e: unknown) => e);
      expect(err).toBeInstanceOf(LarkApiError);
      expect(err).toMatchObject({ retryable: false });
      expect(String(err)).toContain('account "b"');
    }
    expect(lark.messages.length).toBe(before);
    expect(lark.messages.flatMap((m) => m.patches)).toEqual([]);
    run.ctl.abort();
    await run.done;
  });
});
