import { describe, expect, it } from 'vitest';
import type { InboundItem, RenderedMessage, ReplyRoute, RouteExplanation, SendOp } from '@agents-io/protocol';
import { FakeChannel, type FakeTurnScript } from '@agents-io/testkit';
import type { LocalClient } from '@agents-io/kernel';
import { daemon, until, type World } from './helpers.js';

/*
 * PB-8: a channel may hand a sent message back as an inbound one. The echo of a message a backend
 * delivered is known by its platform id: it is not queued for that backend and is nobody speaking.
 * Backend ids are neutral (alpha, beta). The fake channel numbers what it sends m1, m2, …: inputs
 * are named apart from those (in-1, …), so an input carrying a sent id is that message's echo.
 */

/** The account's own user, as its echoes carry it: here the deployment's owner (a personal account). */
const me = { channelUserId: 'alice', evidence: 'platform_signed' as const };
const bob = { channelUserId: 'bob', evidence: 'platform_signed' as const };
const room = { id: 'room', kind: 'group' as const };
const hall = { id: 'hall', kind: 'group' as const };

const at = (conversationId: string): ReplyRoute => ({ channel: 'fake', account: 'default', conversationId });
const say = (c: LocalClient, operationId: string, route: ReplyRoute, message: RenderedMessage = { text: 'hi' }) => c.exchange({ type: 'deliver', operationId, route, message });
const sentId = (r: { value?: unknown }) => (r.value as { providerMessageId: string }).providerMessageId;
const view = async (w: World, consumer: string) => (await w.gw.hostQueue.read(consumer)).map((x: InboundItem) => [x.bindingId, x.envelope.id]);
const explained = async (h: LocalClient, inputId: string) => (await h.explain(inputId)) as unknown as RouteExplanation;
const rules = (e: RouteExplanation) => e.matched.map((m) => [m.bindingId, m.on, m.rejected?.code]);
const turnsIn = (w: World, sessionKey: string) => w.gw.hub.log.read(sessionKey, 0).filter((e) => e.body.t === 'turn.started').length;

/** One backend, and a rule that gives it everything said in `room`. */
const one = (more: Record<string, unknown>[] = []) => ({
  backends: { alpha: {} },
  bindings: [{ id: 'room-to-alpha', match: { channel: 'fake', conversation: 'room' }, on: 'host', to: 'alpha' }, ...more],
});

/** A channel whose send can stay open after the platform has the message, and can report a message as several. */
class Slow extends FakeChannel {
  /** While set, a send returns only once it resolves (the message is already in `sent`). */
  hold: Promise<void> | undefined;
  /** How many more platform messages a send reports besides its own (a split message). */
  parts = 0;

  override async send(route: ReplyRoute, msg: RenderedMessage, op: SendOp) {
    const r = await super.send(route, msg, op);
    const more = Array.from({ length: this.parts }, (_, i) => `${r.providerMessageId}.${i + 1}`);
    if (this.hold) await this.hold;
    return more.length ? { providerMessageId: r.providerMessageId, providerMessageIds: [r.providerMessageId, ...more] } : r;
  }
}

function gate(): { held: Promise<void>; release: () => void } {
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  return { held, release };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** `p`'s result, which must be there within `ms`: the inbound was not made to wait. */
async function prompt<T>(p: Promise<T>, ms = 100): Promise<T> {
  const r = await Promise.race([p, sleep(ms).then(() => 'held' as const)]);
  expect(r).not.toBe('held');
  return r as T;
}

/** What is set aside for a backend, not in its queue yet. */
const aside = (w: World) => w.gw.hostQueue.deferred().map((d) => [d.item.to, d.item.envelope.id]);

describe("backends: the echo of a backend's own deliver (PB-8)", () => {
  it("the echo of a backend's own text deliver is not queued for it and starts no turn, though its rule and a dispatch rule match the conversation; explain says own_echo and echoOf, input.verify says self #PB-8 #EX-1 #ID-5", async () => {
    const turns: string[] = [];
    const script: FakeTurnScript = async (t) => void turns.push(...t.inputs.map((i) => i.inputId));
    const w = await daemon({ raw: one([{ id: 'room-agent', match: { channel: 'fake', conversation: 'room' }, on: 'dispatch' }]), script });
    // Somebody writes in the room: alpha's item (and its grant to answer there), and a turn of the local agent.
    const first = await w.chat.inject({ id: 'in-1', sender: bob, text: 'anyone there?', conversation: room });
    await until(() => turns.includes(first.inputId!));
    const a = await w.backend('alpha');
    const h = await w.host({ name: 'admin' });
    const sent = sentId(await say(a.c, 'op-1', at('room'), { text: 'I am here' }));
    expect(w.chat.sent.find((x) => x.op.operationId === 'backend:alpha:op-1')).toMatchObject({ providerMessageId: sent, msg: { text: 'I am here' } });
    const session = (await explained(h, first.inputId!)).matched.find((m) => m.bindingId === 'room-agent')!.sessionKey!;
    expect(turnsIn(w, session)).toBe(1);

    // The channel hands the message back as one from the account's own user: here the owner.
    const echo = await w.chat.inject({ id: sent, sender: me, text: 'I am here', conversation: room });
    expect(echo).toMatchObject({ accepted: true });
    // Not alpha's: its queue has what it had.
    expect(w.gw.hostQueue.head()).toBe(1);
    expect(await view(w, 'backend:alpha')).toEqual([['room-to-alpha', 'in-1']]);
    // Nobody spoke: no turn, and nothing of it in the session the room's messages go to.
    expect(turns).toEqual([first.inputId]);
    expect(turnsIn(w, session)).toBe(1);
    expect(JSON.stringify(w.gw.hub.log.read(session, 0))).not.toContain(echo.inputId!);
    // The admin sees why.
    const e = await explained(h, echo.inputId!);
    expect(e).toMatchObject({ echoOf: { backends: ['alpha'] }, principal: null, dropped: 'no_match' });
    expect(e.matched).toEqual([{ bindingId: 'room-to-alpha', source: 'config', on: 'host', to: 'alpha', rejected: { code: 'own_echo', message: expect.stringContaining('"alpha"') } }]);
    // And a host checking the author is told it is the deployment's own, not the owner.
    expect((await h.verify(`channel:fake/${sent}`)).records).toMatchObject([{ self: true, kind: 'agent', principal: null, labels: [] }]);

    // What a person says next is alpha's and a turn, as before.
    const next = await w.chat.inject({ id: 'in-2', sender: bob, text: 'good', conversation: room });
    await until(() => turns.includes(next.inputId!));
    expect(await view(w, 'backend:alpha')).toEqual([['room-to-alpha', 'in-1'], ['room-to-alpha', 'in-2']]);
    expect(rules(await explained(h, next.inputId!))).toEqual([['room-to-alpha', 'host', undefined], ['room-agent', 'dispatch', undefined]]);
  });

  it('every message of a multi-part delivery is known as its echo, and so is a message edited with deliver.update: its id again and the revision the channel reports #PB-8', async () => {
    const chat = new Slow('fake');
    const w = await daemon({ raw: one(), chat });
    await w.chat.inject({ id: 'in-1', sender: bob, text: 'tell me everything', conversation: room });
    const a = await w.backend('alpha');
    const h = await w.host({ name: 'admin' });
    const own = async (o: Parameters<FakeChannel['inject']>[0]) => {
      const r = await w.chat.inject({ sender: me, conversation: room, ...o });
      const e = await explained(h, r.inputId!);
      return [e.echoOf?.backends, rules(e)];
    };
    const OWN = [['alpha'], [['room-to-alpha', 'host', 'own_echo']]];

    // The channel splits the message in three and reports each id.
    chat.parts = 2;
    const first = sentId(await say(a.c, 'op-1', at('room'), { text: 'a long story' }));
    chat.parts = 0;
    expect(w.gw.outbox.get('backend:alpha:op-1')).toMatchObject({ providerMessageIds: [first, `${first}.1`, `${first}.2`] });
    for (const [i, m] of [first, `${first}.1`, `${first}.2`].entries()) expect([m, await own({ id: m, text: `part ${i + 1}` })]).toEqual([m, OWN]);
    expect(w.gw.hostQueue.head()).toBe(1);

    // A message alpha delivered and then edited (final: recorded), handed back only after the edit.
    const second = sentId(await say(a.c, 'op-2', at('room'), { text: 'a draft' }));
    expect((await a.c.exchange({ type: 'deliver.update', operationId: 'u-1', route: at('room'), providerMessageId: second, message: { text: 'the final text' }, sequence: 1, final: true })).value).toMatchObject({ status: 'delivered' });
    expect(await own({ id: second, text: 'the final text' })).toEqual(OWN);
    // The channel reports a later edit as a revision of that message, under an id of its own.
    expect((await a.c.exchange({ type: 'deliver.update', operationId: 'u-2', route: at('room'), providerMessageId: second, message: { text: 'edited again' }, sequence: 2 })).value).toMatchObject({ status: 'delivered' });
    expect(await own({ id: `${second}~2`, revisionOf: second, text: 'edited again' })).toEqual(OWN);
    expect(w.gw.hostQueue.head()).toBe(1);

    // A revision of somebody else's message is that person's, as before.
    const theirs = await w.chat.inject({ id: 'in-1~2', revisionOf: 'in-1', sender: bob, text: 'tell me most of it', conversation: room });
    const e = await explained(h, theirs.inputId!);
    expect([e.echoOf, rules(e)]).toEqual([undefined, [['room-to-alpha', 'host', undefined]]]);
    expect(await view(w, 'backend:alpha')).toEqual([['room-to-alpha', 'in-1'], ['room-to-alpha', 'in-1~2']]);
  });

  it('an echo that arrives before the send returns waits for the delivery to be recorded and is then known; a message of another conversation is not held, and another person\'s message held in that conversation is routed as usual afterwards #PB-8', async () => {
    const chat = new Slow('fake');
    const w = await daemon({ raw: one([{ id: 'hall-to-alpha', match: { channel: 'fake', conversation: 'hall' }, on: 'host', to: 'alpha' }]), chat });
    await w.chat.inject({ id: 'in-1', sender: bob, text: 'are you coming?', conversation: room });
    const a = await w.backend('alpha');
    const h = await w.host({ name: 'admin' });

    // The platform has the message; the send call has not returned, so nothing is recorded yet.
    const g = gate();
    chat.hold = g.held;
    const sending = say(a.c, 'op-1', at('room'), { text: 'on my way' });
    await until(() => chat.sent.length === 1);
    const sent = chat.sent[0]!.providerMessageId;
    expect(w.gw.outbox.get('backend:alpha:op-1')).toBeUndefined();
    expect(w.gw.records.backendSent('fake', sent)).toEqual([]);

    // The echo comes first, and somebody answers in the same room meanwhile.
    const done: string[] = [];
    const echo = w.chat.inject({ id: sent, sender: me, text: 'on my way', conversation: room }).then((r) => (done.push('echo'), r));
    const reply = w.chat.inject({ id: 'in-2', sender: bob, text: 'good', conversation: room }).then((r) => (done.push('reply'), r));
    // Another conversation is not held up by it.
    expect(await w.chat.inject({ id: 'in-3', sender: bob, text: 'hello hall', conversation: hall })).toMatchObject({ accepted: true });
    await new Promise((r) => setTimeout(r, 40));
    expect(done).toEqual([]);
    expect(await view(w, 'backend:alpha')).toEqual([['room-to-alpha', 'in-1'], ['hall-to-alpha', 'in-3']]);

    // The send returns: recorded, and both go on.
    g.release();
    expect((await sending).value).toMatchObject({ status: 'delivered', providerMessageId: sent });
    const [e, r] = await Promise.all([echo, reply]);
    expect(done.sort()).toEqual(['echo', 'reply']);
    const ex = await explained(h, e.inputId!);
    expect([ex.echoOf, rules(ex), ex.dropped]).toEqual([{ backends: ['alpha'] }, [['room-to-alpha', 'host', 'own_echo']], 'no_match']);
    // The other person's message is alpha's item; the echo never was.
    expect(rules(await explained(h, r.inputId!))).toEqual([['room-to-alpha', 'host', undefined]]);
    expect(await view(w, 'backend:alpha')).toEqual([['room-to-alpha', 'in-1'], ['hall-to-alpha', 'in-3'], ['room-to-alpha', 'in-2']]);

    // Nothing in flight any more: a message in the room is not held at all.
    chat.hold = undefined;
    expect(await w.chat.inject({ id: 'in-4', sender: bob, text: 'see you', conversation: room })).toMatchObject({ accepted: true });
  });

  it("a send that outlasts the wait: the echo of each part goes on as an ordinary message for everybody else but never reaches the backend that is still sending; its queue entry waits for the delivery to settle and is dropped then, and a person's message kept from it meanwhile is queued for it then; explain and the log say so #PB-8 #EX-1", async () => {
    const chat = new Slow('fake');
    const warned: string[] = [];
    const w = await daemon({
      raw: one([{ id: 'room-host', match: { channel: 'fake', conversation: 'room' }, on: 'host' }]),
      chat,
      gateway: { backendEchoWaitMs: 200, logger: (level, msg) => void (level === 'warn' && warned.push(msg)) },
    });
    await w.chat.inject({ id: 'in-1', sender: bob, text: 'send me the files', conversation: room });
    const a = await w.backend('alpha');
    const h = await w.host({ name: 'admin' });
    // One deliver, three platform messages: the first is out, and the call goes on (uploads) well past the wait.
    const g = gate();
    chat.hold = g.held;
    chat.parts = 2;
    const sending = say(a.c, 'op-1', at('room'), { text: 'here they are' });
    await until(() => chat.sent.length === 1);
    const sent = chat.sent[0]!.providerMessageId;

    // The first part comes back. Held at first, …
    let first: { inputId?: string } | undefined;
    const echo = w.chat.inject({ id: sent, sender: me, text: 'here they are', conversation: room }).then((r) => (first = r));
    await sleep(20);
    expect(first).toBeUndefined();
    // … then let go while the send is still open: nothing says whose it is, so for everybody else it is the account's user's message.
    await echo;
    expect(w.gw.outbox.get('backend:alpha:op-1')).toBeUndefined();
    const held = await explained(h, first!.inputId!);
    expect([held.echoOf, held.deferred, held.principal]).toEqual([undefined, { backends: ['alpha'] }, 'fake:alice']);
    expect(rules(held)).toEqual([['room-to-alpha', 'host', undefined], ['room-host', 'host', undefined]]);
    expect(await view(w, 'legacy')).toEqual([['room-host', 'in-1'], ['room-host', sent]]);
    // Not for the backend that is sending it: its entry is set aside, not in its queue.
    expect(await view(w, 'backend:alpha')).toEqual([['room-to-alpha', 'in-1']]);
    expect(aside(w)).toEqual([['alpha', sent]]);

    // The delivery's wait is used up: the second part's echo and a person's message are not held at all, and are kept from alpha alike.
    const second = await prompt(w.chat.inject({ id: `${sent}.1`, sender: me, text: 'file one', conversation: room }));
    const reply = await prompt(w.chat.inject({ id: 'in-2', sender: bob, text: 'thanks', conversation: room }));
    expect(w.gw.outbox.get('backend:alpha:op-1')).toBeUndefined();
    expect((await view(w, 'legacy')).map((x) => x[1])).toEqual(['in-1', sent, `${sent}.1`, 'in-2']);
    expect(await view(w, 'backend:alpha')).toEqual([['room-to-alpha', 'in-1']]);
    expect(aside(w)).toEqual([['alpha', sent], ['alpha', `${sent}.1`], ['alpha', 'in-2']]);

    // The send returns: every part's id is on record. Both echoes are dropped, the person's message is alpha's.
    g.release();
    expect((await sending).value).toMatchObject({ status: 'delivered', providerMessageIds: [sent, `${sent}.1`, `${sent}.2`] });
    await until(() => aside(w).length === 0);
    expect(await view(w, 'backend:alpha')).toEqual([['room-to-alpha', 'in-1'], ['room-to-alpha', 'in-2']]);
    for (const r of [first!, second]) {
      const e = await explained(h, r.inputId!);
      expect([e.echoOf, e.deferred]).toEqual([{ backends: ['alpha'], late: true }, undefined]);
      expect(rules(e)).toEqual([['room-to-alpha', 'host', 'own_echo'], ['room-host', 'host', undefined]]);
    }
    const e = await explained(h, reply.inputId!);
    expect([e.echoOf, e.deferred, rules(e)]).toEqual([undefined, undefined, [['room-to-alpha', 'host', undefined], ['room-host', 'host', undefined]]]);
    // The third part comes back after that: the plain echo, nobody's item.
    const third = await explained(h, (await w.chat.inject({ id: `${sent}.2`, sender: me, text: 'file two', conversation: room })).inputId!);
    expect([third.echoOf, rules(third), third.dropped]).toEqual([{ backends: ['alpha'] }, [['room-to-alpha', 'host', 'own_echo']], 'no_match']);
    expect(w.gw.hostQueue.head()).toBe(6);
    // The admin's log: the wait ran out once for that delivery, and each echo let through is named.
    expect(warned.filter((m) => m.includes("backend alpha's deliver into fake room has not settled after 200 ms"))).toHaveLength(1);
    expect(warned.filter((m) => m.includes('is the echo of a message backend alpha delivered'))).toHaveLength(2);
  });

  it('the echo of a delivery whose outcome stays unknown cannot be known by its id: it is an ordinary message, for the backend that sent it too, once that delivery has settled #PB-8', async () => {
    // Settled unknown before the echo comes: no message id is on record.
    const chat = new Slow('fake');
    const w = await daemon({ raw: one(), chat, gateway: { outboxAttemptTimeoutMs: 60 } });
    await w.chat.inject({ id: 'in-1', sender: bob, text: 'are you coming?', conversation: room });
    const a = await w.backend('alpha');
    const h = await w.host({ name: 'admin' });
    const g = gate();
    chat.hold = g.held;
    expect((await say(a.c, 'op-1', at('room'), { text: 'on my way' })).value).toMatchObject({ status: 'unknown' });
    const sent = chat.sent[0]!.providerMessageId;
    expect(w.gw.records.backendSent('fake', sent)).toEqual([]);
    const r = await w.chat.inject({ id: sent, sender: me, text: 'on my way', conversation: room });
    const ex = await explained(h, r.inputId!);
    expect([ex.echoOf, ex.deferred, rules(ex)]).toEqual([undefined, undefined, [['room-to-alpha', 'host', undefined]]]);
    expect(await view(w, 'backend:alpha')).toEqual([['room-to-alpha', 'in-1'], ['room-to-alpha', sent]]);
    g.release();
    await w.stop();

    // The echo comes while that send is open and outlasts the wait: kept from alpha until the delivery settles, unknown, then queued for it.
    const chat2 = new Slow('fake');
    const w2 = await daemon({ raw: one(), chat: chat2, gateway: { outboxAttemptTimeoutMs: 300, backendEchoWaitMs: 40 } });
    await w2.chat.inject({ id: 'in-1', sender: bob, text: 'are you coming?', conversation: room });
    const a2 = await w2.backend('alpha');
    const h2 = await w2.host({ name: 'admin' });
    const g2 = gate();
    chat2.hold = g2.held;
    const sending = say(a2.c, 'op-1', at('room'), { text: 'on my way' });
    await until(() => chat2.sent.length === 1);
    const sent2 = chat2.sent[0]!.providerMessageId;
    const r2 = await w2.chat.inject({ id: sent2, sender: me, text: 'on my way', conversation: room });
    expect(w2.gw.outbox.get('backend:alpha:op-1')).toBeUndefined();
    expect((await explained(h2, r2.inputId!)).deferred).toEqual({ backends: ['alpha'] });
    expect(await view(w2, 'backend:alpha')).toEqual([['room-to-alpha', 'in-1']]);
    expect((await sending).value).toMatchObject({ status: 'unknown' });
    await until(() => aside(w2).length === 0);
    const ex2 = await explained(h2, r2.inputId!);
    expect([ex2.echoOf, ex2.deferred, rules(ex2)]).toEqual([undefined, undefined, [['room-to-alpha', 'host', undefined]]]);
    expect(await view(w2, 'backend:alpha')).toEqual([['room-to-alpha', 'in-1'], ['room-to-alpha', sent2]]);
    g2.release();
  });

  it("an inbound waits only where waiting can tell something: not an envelope without platform evidence, not a message this daemon is already known to have delivered, not one of another channel; one delivery makes its conversation wait once; and what arrives while a message of the conversation waits stays behind it, a click too #PB-8", async () => {
    const chat = new Slow('fake');
    const other = new FakeChannel('other');
    const w = await daemon({ raw: one([{ id: 'room-host', match: { conversation: 'room' }, on: 'host' }]), chat, moreChannels: [other], gateway: { backendEchoWaitMs: 300 } });
    await w.chat.inject({ id: 'in-1', sender: bob, text: 'which one?', conversation: room });
    const a = await w.backend('alpha');
    const h = await w.host({ name: 'admin' });
    // A message the host itself delivered into the room: on record as this daemon's, and not as a backend's.
    const byHost = (await h.deliver({ operationId: 'op-h', route: at('room'), message: { text: 'from the host' } })).providerMessageId!;
    const g = gate();
    chat.hold = g.held;
    const sending = say(a.c, 'op-1', at('room'), { text: 'pick one' });
    await until(() => chat.sent.length === 2);

    // None of these can be the message alpha is sending: not held, and alpha's at once where its rule matches.
    await prompt(w.chat.inject({ id: 'in-2', sender: { channelUserId: 'bob', evidence: 'none' }, text: 'unsigned', conversation: room }));
    await prompt(w.chat.inject({ id: byHost, sender: me, text: 'from the host', conversation: room }));
    expect((await prompt(other.inject({ id: 'in-3', sender: bob, text: 'the same room id elsewhere', conversation: room }))).accepted).toBe(true);
    expect(await view(w, 'backend:alpha')).toEqual([['room-to-alpha', 'in-1'], ['room-to-alpha', 'in-2'], ['room-to-alpha', byHost]]);
    expect(aside(w)).toEqual([]);

    // A person's message could be it, for all the daemon knows: it waits. A click made after it stays behind it.
    const order: string[] = [];
    const said = w.chat.inject({ id: 'in-4', sender: bob, text: 'not that one, the second', conversation: room }).then(() => order.push('said'));
    const click = w.chat.inject({ id: 'in-5', sender: bob, conversation: room, content: [{ type: 'event', name: 'action', data: { actionId: 'pick:2', messageId: 'a-card' } }] }).then(() => order.push('click'));
    await sleep(80);
    expect(order).toEqual([]);
    await Promise.all([said, click]);
    expect(order).toEqual(['said', 'click']);
    expect((await view(w, 'legacy')).map((x) => x[1])).toEqual(['in-1', 'in-2', byHost, 'in-3', 'in-4', 'in-5']);

    // The delivery's wait is used up: the next message does not wait for it, though the send is still open.
    expect(w.gw.outbox.get('backend:alpha:op-1')).toBeUndefined();
    await prompt(w.chat.inject({ id: 'in-6', sender: bob, text: 'hello?', conversation: room }));
    expect(aside(w)).toEqual([['alpha', 'in-4'], ['alpha', 'in-6']]);
    g.release();
    expect((await sending).value).toMatchObject({ status: 'delivered' });
    await until(() => aside(w).length === 0);
    expect((await view(w, 'backend:alpha')).map((x) => x[1])).toEqual(['in-1', 'in-2', byHost, 'in-4', 'in-6']);
  });

  it('with backendEchoWaitMs 0 no inbound waits, and the backend that is sending still does not get its own message back #PB-8', async () => {
    const chat = new Slow('fake');
    const w = await daemon({ raw: one(), chat, gateway: { backendEchoWaitMs: 0 } });
    await w.chat.inject({ id: 'in-1', sender: bob, text: 'are you coming?', conversation: room });
    const a = await w.backend('alpha');
    const h = await w.host({ name: 'admin' });
    const g = gate();
    chat.hold = g.held;
    const sending = say(a.c, 'op-1', at('room'), { text: 'on my way' });
    await until(() => chat.sent.length === 1);
    const sent = chat.sent[0]!.providerMessageId;
    const echo = await prompt(w.chat.inject({ id: sent, sender: me, text: 'on my way', conversation: room }));
    expect(w.gw.outbox.get('backend:alpha:op-1')).toBeUndefined();
    expect(aside(w)).toEqual([['alpha', sent]]);
    g.release();
    expect((await sending).value).toMatchObject({ status: 'delivered', providerMessageId: sent });
    await until(() => aside(w).length === 0);
    expect(await view(w, 'backend:alpha')).toEqual([['room-to-alpha', 'in-1']]);
    const e = await explained(h, echo.inputId!);
    expect([e.echoOf, rules(e), e.dropped]).toEqual([{ backends: ['alpha'], late: true }, [['room-to-alpha', 'host', 'own_echo']], 'no_match']);
  });

  it('an inbound message waiting for a deliver in flight is not taken when the daemon begins to stop: the channel is told not now, never a permanent refusal, and the next daemon knows the redelivered echo #PB-8 #IN-7', async () => {
    const chat = new Slow('fake');
    const w = await daemon({ raw: one(), chat, gateway: { backendEchoWaitMs: 10_000 } });
    await w.chat.inject({ id: 'in-1', sender: bob, text: 'are you coming?', conversation: room });
    const a = await w.backend('alpha');
    const g = gate();
    chat.hold = g.held;
    const sending = say(a.c, 'op-1', at('room'), { text: 'on my way' }).catch(() => undefined);
    await until(() => chat.sent.length === 1);
    const sent = chat.sent[0]!.providerMessageId;
    const echo = w.chat.inject({ id: sent, sender: me, text: 'on my way', conversation: room });
    const stopping = w.stop();
    // Not accepted and not refused for good: the channel keeps it for the next process. Told as stopping
    // begins, not when the wait's own bound (10 s here) runs out.
    expect(await Promise.race([echo, new Promise((r) => setTimeout(() => r('still waiting'), 2000))])).toEqual({ accepted: false, error: 'gateway stopping' });
    // The send returns while the daemon still waits for its sends: it is recorded.
    g.release();
    await sending;
    await stopping;

    const again = await daemon({ raw: one(), dir: w.dir });
    const h = await again.host({ name: 'admin' });
    expect(again.gw.outbox.get('backend:alpha:op-1')).toMatchObject({ status: 'delivered', providerMessageId: sent });
    const redelivered = await again.chat.inject({ id: sent, sender: me, text: 'on my way', conversation: room });
    const e = await explained(h, redelivered.inputId!);
    expect([e.echoOf, rules(e)]).toEqual([{ backends: ['alpha'] }, [['room-to-alpha', 'host', 'own_echo']]]);
    expect(await view(again, 'backend:alpha')).toEqual([['room-to-alpha', 'in-1']]);
  });

  it("another person's message with the same text, and the account's own hand-typed one, are not swallowed: only the delivered message's id is an echo #PB-8", async () => {
    const w = await daemon({ raw: one() });
    await w.chat.inject({ id: 'in-1', sender: bob, text: 'when?', conversation: room });
    const a = await w.backend('alpha');
    const h = await w.host({ name: 'admin' });
    const sent = sentId(await say(a.c, 'op-1', at('room'), { text: 'see you at five' }));
    // The same words from somebody else, and typed by the account's owner by hand: each its own message id.
    const theirs = await w.chat.inject({ id: 'in-2', sender: bob, text: 'see you at five', conversation: room });
    const typed = await w.chat.inject({ id: 'in-3', sender: me, text: 'see you at five', conversation: room });
    // And the echo itself.
    const echo = await w.chat.inject({ id: sent, sender: me, text: 'see you at five', conversation: room });
    const items = (await w.gw.hostQueue.read('backend:alpha')).map((x) => [x.envelope.id, x.input.origin.kind, x.input.origin.principal?.id ?? null, x.input.origin.self === true]);
    expect(items).toEqual([
      ['in-1', 'human', null, false],
      ['in-2', 'human', null, false],
      ['in-3', 'human', 'fake:alice', false],
    ]);
    for (const r of [theirs, typed]) {
      const e = await explained(h, r.inputId!);
      expect([e.echoOf, rules(e)]).toEqual([undefined, [['room-to-alpha', 'host', undefined]]]);
    }
    expect((await explained(h, echo.inputId!)).echoOf).toEqual({ backends: ['alpha'] });
    expect((await h.verify('channel:fake/in-3')).records).toMatchObject([{ kind: 'human', principal: 'fake:alice' }]);
    expect('self' in (await h.verify('channel:fake/in-3')).records[0]!).toBe(false);
  });

  it('another backend gets the echo only through a rule with includeSelf, as a self input without a principal; the backend that sent it never does, also with includeSelf; an untargeted host rule and a session with includeSelf get it as context, never a turn #PB-8 #PB-1 #ID-5', async () => {
    const routes = [at('room'), at('hall')];
    const raw = {
      backends: { alpha: { routes }, beta: { routes } },
      bindings: [
        // The room is shared the plain way: neither asks for the deployment's own messages.
        { id: 'room-to-alpha', match: { channel: 'fake', conversation: 'room' }, on: 'host', to: 'alpha' },
        { id: 'room-to-beta', match: { channel: 'fake', conversation: 'room' }, on: 'host', to: 'beta' },
        // In the hall everybody asks to see them too.
        { id: 'hall-alpha', match: { channel: 'fake', conversation: 'hall', includeSelf: true }, on: 'host', to: 'alpha' },
        { id: 'hall-beta', match: { channel: 'fake', conversation: 'hall', includeSelf: true }, on: 'host', to: 'beta' },
        { id: 'hall-host', match: { channel: 'fake', conversation: 'hall', includeSelf: true }, on: 'host' },
        { id: 'hall-agent', match: { channel: 'fake', conversation: 'hall', includeSelf: true }, on: 'dispatch' },
      ],
    };
    const w = await daemon({ raw });
    const a = await w.backend('alpha');
    const b = await w.backend('beta');
    const h = await w.host({ name: 'admin' });
    const got = async (consumer: string) => (await w.gw.hostQueue.read(consumer)).map((x) => [x.bindingId, x.envelope.id, x.input.origin.kind, x.input.origin.principal, x.input.origin.self === true]);

    // The shared room: alpha speaks, and its echo is nobody's item. beta would have to ask for it.
    const inRoom = sentId(await say(a.c, 'op-1', at('room'), { text: 'alpha in the room' }));
    const e1 = await explained(h, (await w.chat.inject({ id: inRoom, sender: me, text: 'alpha in the room', conversation: room })).inputId!);
    expect([e1.echoOf, rules(e1), e1.dropped]).toEqual([{ backends: ['alpha'] }, [['room-to-alpha', 'host', 'own_echo']], 'no_match']);
    expect(w.gw.hostQueue.head()).toBe(0);

    // The hall: alpha speaks. beta, the host queue and the agent's session see that the account said it; alpha does not.
    const byAlpha = sentId(await say(a.c, 'op-2', at('hall'), { text: 'alpha in the hall' }));
    const r2 = await w.chat.inject({ id: byAlpha, sender: me, text: 'alpha in the hall', conversation: hall });
    const e2 = await explained(h, r2.inputId!);
    expect(e2.echoOf).toEqual({ backends: ['alpha'] });
    expect(rules(e2)).toEqual([['hall-alpha', 'host', 'own_echo'], ['hall-beta', 'host', undefined], ['hall-host', 'host', undefined], ['hall-agent', 'context', undefined]]);
    expect(await got('backend:alpha')).toEqual([]);
    expect(await got('backend:beta')).toEqual([['hall-beta', byAlpha, 'agent', null, true]]);
    expect(await got('legacy')).toEqual([['hall-host', byAlpha, 'agent', null, true]]);
    const session = e2.matched.find((m) => m.bindingId === 'hall-agent')!.sessionKey!;
    await until(() => JSON.stringify(w.gw.hub.log.read(session, 0)).includes(r2.inputId!));
    expect(turnsIn(w, session)).toBe(0);

    // beta speaks there: the other way round.
    const byBeta = sentId(await say(b.c, 'op-1', at('hall'), { text: 'beta in the hall' }));
    const e3 = await explained(h, (await w.chat.inject({ id: byBeta, sender: me, text: 'beta in the hall', conversation: hall })).inputId!);
    expect(e3.echoOf).toEqual({ backends: ['beta'] });
    expect(rules(e3)).toEqual([['hall-alpha', 'host', undefined], ['hall-beta', 'host', 'own_echo'], ['hall-host', 'host', undefined], ['hall-agent', 'context', undefined]]);
    expect(await got('backend:alpha')).toEqual([['hall-alpha', byBeta, 'agent', null, true]]);
    expect((await got('backend:beta')).map((x) => x[1])).toEqual([byAlpha]);
    expect(turnsIn(w, session)).toBe(0);

    // A person speaking there is everybody's, and a turn.
    const r4 = await w.chat.inject({ id: 'in-1', sender: bob, text: 'hello all', conversation: hall });
    expect(rules(await explained(h, r4.inputId!))).toEqual([['hall-alpha', 'host', undefined], ['hall-beta', 'host', undefined], ['hall-host', 'host', undefined], ['hall-agent', 'dispatch', undefined]]);
    expect((await got('backend:alpha')).at(-1)).toEqual(['hall-alpha', 'in-1', 'human', null, false]);
    expect((await got('backend:beta')).at(-1)).toEqual(['hall-beta', 'in-1', 'human', null, false]);
    await until(() => turnsIn(w, session) === 1);
  });

  it('after a restart between the send and the echo it is still known: the outbound records survive #PB-8 #RS-1', async () => {
    const w = await daemon({ raw: one() });
    await w.chat.inject({ id: 'in-1', sender: bob, text: 'are you coming?', conversation: room });
    const a = await w.backend('alpha');
    const sent = sentId(await say(a.c, 'op-1', at('room'), { text: 'on my way' }));
    await w.stop();

    const again = await daemon({ raw: one(), dir: w.dir });
    const h = await again.host({ name: 'admin' });
    const echo = await again.chat.inject({ id: sent, sender: me, text: 'on my way', conversation: room });
    const e = await explained(h, echo.inputId!);
    expect([e.echoOf, rules(e), e.dropped]).toEqual([{ backends: ['alpha'] }, [['room-to-alpha', 'host', 'own_echo']], 'no_match']);
    // alpha's queue is what it was before the restart; a person's message still reaches it.
    expect(await view(again, 'backend:alpha')).toEqual([['room-to-alpha', 'in-1']]);
    await again.chat.inject({ id: 'in-2', sender: bob, text: 'good', conversation: room });
    expect(await view(again, 'backend:alpha')).toEqual([['room-to-alpha', 'in-1'], ['room-to-alpha', 'in-2']]);
    // Entries a process that stopped before a delivery settled left set aside for alpha (as `Ingress` sets them aside):
    // the echo of a delivery that is on record, and a person's message.
    const [queued] = await again.gw.hostQueue.read('backend:alpha', { after: 0 });
    const { cursor: _cursor, ...item } = queued!;
    for (const id of [sent, 'in-9']) again.gw.hostQueue.defer({ ...item, to: 'alpha', channelRef: `channel:fake/${id}`, envelope: { ...item.envelope, id } });
    expect(aside(again)).toEqual([['alpha', sent], ['alpha', 'in-9']]);
    await again.stop();
    // The next start settles them by what is on record: the echo is dropped, the message queued.
    const third = await daemon({ raw: one(), dir: w.dir });
    expect(aside(third)).toEqual([]);
    expect(await view(third, 'backend:alpha')).toEqual([['room-to-alpha', 'in-1'], ['room-to-alpha', 'in-2'], ['room-to-alpha', 'in-9']]);
    await third.stop();

    // alpha is taken out of the config: what it delivered is still known as the deployment's own, not as the owner speaking.
    const turns: string[] = [];
    const script: FakeTurnScript = async (t) => void turns.push(...t.inputs.map((i) => i.inputId));
    const without = await daemon({ raw: { bindings: [{ id: 'room-agent', match: { channel: 'fake', conversation: 'room' }, on: 'dispatch' }] }, dir: w.dir, script });
    const h2 = await without.host({ name: 'admin' });
    const later = await without.chat.inject({ id: sent, sender: me, text: 'on my way', conversation: room });
    const e2 = await explained(h2, later.inputId!);
    expect([e2.echoOf, e2.principal, rules(e2), e2.dropped]).toEqual([{ backends: ['alpha'] }, null, [], 'no_match']);
    // A person's message there is a turn, the echo is not.
    const spoken = await without.chat.inject({ id: 'in-3', sender: bob, text: 'anyone?', conversation: room });
    await until(() => turns.includes(spoken.inputId!));
    expect(turns).toEqual([spoken.inputId]);
  });

  it('without backends nothing changes: the echo of a host-token deliver and a message nobody here sent are routed as before, with backends configured too #PB-8', async () => {
    for (const raw of [undefined, { backends: { alpha: {} } }]) {
      const turns: string[] = [];
      const script: FakeTurnScript = async (t) => void turns.push(...t.inputs.map((i) => i.inputId));
      const w = await daemon({ ...(raw ? { raw } : {}), script });
      const h = await w.host({ name: 'admin' });
      // The host's own deliver is not a backend's: handed back from the owner's account it is the owner's message.
      const sent = (await h.deliver({ operationId: 'op-1', route: at('c1'), message: { text: 'from the host' } })).providerMessageId!;
      expect(w.gw.records.sentByUs('fake', sent)).toBe(true);
      const echo = await w.chat.inject({ id: sent, sender: me, text: 'from the host' });
      const plain = await w.chat.inject({ id: 'in-1', sender: me, text: 'from the owner' });
      await until(() => turns.includes(echo.inputId!) && turns.includes(plain.inputId!));
      const [e, p] = [await explained(h, echo.inputId!), await explained(h, plain.inputId!)];
      expect(e.matched).toEqual(p.matched);
      // (The owner's DM matches both default rules; the turn wins the session.)
      expect(rules(e)).toEqual([['default:owner-dm', 'dispatch', undefined], ['default:observe-dm', 'context', undefined]]);
      expect([e.principal, 'echoOf' in e, 'echoOf' in p]).toEqual(['fake:alice', false, false]);
      const record = (await h.verify(`channel:fake/${sent}`)).records[0]!;
      expect(record).toMatchObject({ kind: 'human', principal: 'fake:alice', labels: ['owner'] });
      expect('self' in record).toBe(false);
      await w.stop();
    }
  });
});
