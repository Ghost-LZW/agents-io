import { describe, expect, it } from 'vitest';
import { daemon } from './helpers.js';

// A host edits what it delivered (`deliver.update`) and has a channel make a conversation (`conversation.create`).

describe('deliver.update', () => {
  it('edits a delivered message, finalizes it once per operationId, and refuses what it cannot #DL-8', async () => {
    const w = await daemon({});
    const c = await w.client();
    const hello = await c.hello({ token: w.gw.token, name: 'probe' });
    expect(hello.features).toEqual(expect.arrayContaining(['deliver.update', 'conversation.create']));
    const t = await w.host({ name: 'herdr' });
    const route = { channel: 'fake', account: 'default', conversationId: 'dm-alice' };
    const sent = await t.deliver({ operationId: 'n1', route, message: { text: 'working' } });
    const id = sent.providerMessageId!;
    const r1 = await t.deliverUpdate({ operationId: 'n1:1', route, providerMessageId: id, message: { text: 'step 1' }, sequence: 1 });
    expect(r1).toMatchObject({ status: 'delivered', duplicate: false, providerMessageId: id });
    const fin = { operationId: 'n1:final', route, providerMessageId: id, message: { text: 'done' }, sequence: 2, final: true };
    expect(await t.deliverUpdate(fin)).toMatchObject({ status: 'delivered', duplicate: false });
    expect(await t.deliverUpdate(fin)).toMatchObject({ status: 'delivered', duplicate: true });
    const rec = w.chat.sent.find((s) => s.providerMessageId === id)!;
    expect(rec.edits.map((m) => m.text)).toEqual(['step 1', 'done']);
    expect(rec.finalized).toBe(true);
    // A message the channel does not know: the edit is refused, not thrown.
    const bad = await t.deliverUpdate({ operationId: 'x:1', route, providerMessageId: 'nope', message: { text: '?' }, sequence: 1 });
    expect(bad).toMatchObject({ status: 'rejected' });
    await expect(t.deliverUpdate({ operationId: 'x:2', route: { ...route, channel: 'none' }, providerMessageId: id, message: { text: '?' }, sequence: 1 })).rejects.toMatchObject({ code: 'unknown_channel' });
  });
});

describe('conversation.create', () => {
  it('has the channel make one conversation per operationId #DL-8', async () => {
    const w = await daemon({});
    const t = await w.host({ name: 'herdr' });
    const spec = { operationId: 'wb-1', channel: 'fake', account: 'default', name: 'workbench', owner: 'alice', members: ['alice'] };
    const a = await t.conversationCreate(spec);
    expect(a).toMatchObject({ conversationId: 'oc_new1', channel: 'fake', account: 'default', duplicate: false });
    expect(await t.conversationCreate(spec)).toMatchObject({ conversationId: 'oc_new1', duplicate: true });
    expect(w.chat.created).toEqual([{ operationId: 'wb-1', name: 'workbench', owner: 'alice', members: ['alice'] }]);
    await expect(t.conversationCreate({ ...spec, operationId: 'wb-2', name: ' ' })).rejects.toMatchObject({ code: 'invalid_frame' });
  });
});
