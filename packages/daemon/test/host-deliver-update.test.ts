import { describe, expect, it } from 'vitest';
import { fakeEnvelope } from '@agents-io/testkit';
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

describe('message.ack', () => {
  it("puts the channel's mark on a message and takes it away; a channel without marks is unsupported #DL-8", async () => {
    const w = await daemon({});
    const t = await w.host({ name: 'herdr' });
    const route = { channel: 'fake', account: 'default', conversationId: 'dm-alice' };
    expect(await t.messageAck({ route, messageId: 'm1', state: 'working' })).toEqual({ messageId: 'm1', state: 'working' });
    await t.messageAck({ route, messageId: 'm1', state: 'none' });
    expect(w.chat.acks).toEqual([
      { messageId: 'm1', state: 'working' },
      { messageId: 'm1', state: 'none' },
    ]);
    await expect(t.messageAck({ route: { ...route, channel: 'none' }, messageId: 'm1', state: 'done' })).rejects.toMatchObject({ code: 'unknown_channel' });
  });
});

describe('history.read', () => {
  it("answers the channel's earlier messages of a queued item's conversation, oldest first, only its own and earlier, none it sent #DL-8 #ID-8", async () => {
    const w = await daemon({ raw: { bindings: [{ id: 'to-host', match: { channel: 'fake', keywords: ['xwo'] }, on: 'host' }] } });
    const t = await w.host({ name: 'herdr', consumer: 'herdr' });
    t.onRequest('inbound', () => ({ accepted: true }));
    const base = Date.now();
    await w.chat.inject({ id: 'trig', sender: { channelUserId: 'alice', evidence: 'platform_signed' }, text: 'xwo what happened?', sentAt: base });
    const pull = await w.host({ name: 'tail' });
    const [item] = (await pull.inboundRead({ consumer: 'pull', waitMs: 2000 })).items;
    w.chat.historyAnswer = [
      fakeEnvelope({ id: 'h1', channel: 'fake', account: 'default', text: 'first', sentAt: base - 2000 }),
      fakeEnvelope({ id: 'h2', channel: 'fake', account: 'default', text: 'second', sentAt: base - 1000 }),
      fakeEnvelope({ id: 'later', channel: 'fake', account: 'default', text: 'after', sentAt: base + 1000 }),
      fakeEnvelope({ id: 'other', channel: 'elsewhere', account: 'default', text: 'no', sentAt: base - 500 }),
    ];
    // A message this deployment sent itself (here the host's deliver) is never history, also after a restart.
    const ours = await t.deliver({ operationId: 'answer-1', route: { channel: 'fake', account: 'default', conversationId: 'dm-alice' }, message: { text: 'an answer' } });
    expect(ours.providerMessageId).toBeTruthy();
    w.chat.historyAnswer.push(fakeEnvelope({ id: ours.providerMessageId!, channel: 'fake', account: 'default', text: 'an answer', sentAt: base - 100 }));
    const r = await t.historyRead({ cursor: item!.cursor, scope: 'chat' });
    expect(r.messages.map((m) => m.id)).toEqual(['h1', 'h2']);
    expect(w.chat.historyCalls).toEqual([{ id: 'trig', scope: 'chat' }]);
    await expect(t.historyRead({ cursor: 99_999, scope: 'thread' })).rejects.toMatchObject({ code: 'unknown_cursor' });
  });
});

describe('history.read across a restart', () => {
  it("still leaves out what this deployment sent before it restarted #ID-8", async () => {
    const raw = { bindings: [{ id: 'to-host', match: { channel: 'fake', keywords: ['xwo'] }, on: 'host' }] };
    const w = await daemon({ raw });
    const t = await w.host({ name: 'herdr' });
    const ours = await t.deliver({ operationId: 'answer-1', route: { channel: 'fake', account: 'default', conversationId: 'dm-alice' }, message: { text: 'an earlier answer' } });
    const dir = w.dir;
    await w.stop();
    const again = await daemon({ raw, dir });
    const h = await again.host({ name: 'herdr', consumer: 'herdr' });
    h.onRequest('inbound', () => ({ accepted: true }));
    const base = Date.now();
    await again.chat.inject({ id: 'trig2', sender: { channelUserId: 'alice', evidence: 'platform_signed' }, text: 'xwo and now?', sentAt: base });
    const pull = await again.host({ name: 'tail' });
    const [item] = (await pull.inboundRead({ consumer: 'pull', waitMs: 2000 })).items;
    again.chat.historyAnswer = [
      fakeEnvelope({ id: 'p1', channel: 'fake', account: 'default', text: 'a person', sentAt: base - 2000 }),
      fakeEnvelope({ id: ours.providerMessageId!, channel: 'fake', account: 'default', text: 'an earlier answer', sentAt: base - 1000 }),
    ];
    const r = await h.historyRead({ cursor: item!.cursor, scope: 'chat' });
    expect(r.messages.map((m) => m.id)).toEqual(['p1']);
  });
});
