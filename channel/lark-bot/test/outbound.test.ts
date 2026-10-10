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
  it('is idempotent: same operationId gives one platform message and a stable uuid #DL-2', async () => {
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

  it('retries a failed operation under the same uuid #DL-2 #DL-1', async () => {
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

  it('splits text longer than caps.text.maxChars, one uuid per part, returns the last part id #DL-2', async () => {
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
});

describe('edit / finalize / retract / reconcile', () => {
  const streaming = { text: 'working', sections: [{ kind: 'status' as const, text: 'step 1' }] };

  it('drops stale or duplicate edit sequences #DL-2', async () => {
    const { lark, adapter } = make();
    const { providerMessageId: id } = await adapter.send(route, streaming, { operationId: 'o' });
    await adapter.edit(route, id!, { text: 'b' }, { operationId: 'e2', sequence: 2 });
    await adapter.edit(route, id!, { text: 'a' }, { operationId: 'e1', sequence: 1 });
    await adapter.edit(route, id!, { text: 'b' }, { operationId: 'e2', sequence: 2 });
    expect(lark.messages[0]!.patches).toHaveLength(1);
  });

  it('reconcile reports alive, gone (deleted flag) and gone (error code) #RS-1', async () => {
    const { lark, adapter } = make();
    const { providerMessageId: id } = await adapter.send(route, streaming, { operationId: 'o' });
    expect(await adapter.reconcile(route, id!)).toBe('alive');
    lark.messages[0]!.deleted = true;
    expect(await adapter.reconcile(route, id!)).toBe('gone');
    expect(await adapter.reconcile(route, 'om_missing')).toBe('gone');
  });

  it('surfaces API failures as LarkApiError with the platform code #DL-1', async () => {
    const { adapter } = make();
    await expect(adapter.edit(route, 'om_missing', { text: 'x' }, { operationId: 'e', sequence: 1 })).rejects.toMatchObject({ code: 230002 });
  });
});

describe('declared sender', () => {
  it('records op.as and recovers it as sender.declared when the platform delivers the bot message #DL-4b', async () => {
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

  it('never derives declared from text or for humans #DL-4b #ID-4', async () => {
    const { lark, adapter } = make();
    const run = startAdapter(adapter);
    await tick();
    await lark.fire('im.message.receive_v1', messageEvent({ id: 'om_h', content: { text: '[as runner:evil/run:1] hi' } }));
    await lark.fire('im.message.receive_v1', messageEvent({ id: 'om_b', senderType: 'app', sender: { open_id: 'ou_otherbot' } }));
    expect(run.envs.map((e) => e.sender.declared)).toEqual([undefined, undefined]);
    run.ctl.abort();
    await run.done;
  });

  it('uses a host-supplied persistent store #DL-4b', async () => {
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
  it('send / edit / finalize / retract refuse a route of another account, not retryable, without calling the API #DL-4', async () => {
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
