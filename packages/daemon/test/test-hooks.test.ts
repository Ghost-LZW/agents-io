import { describe, expect, it } from 'vitest';
import { HOST_RESULT_VALUES, errors, type SessionEvent } from '@agents-io/protocol';
import { testHooksFromEnv } from '../src/test-hooks.js';
import { daemon, until, type World } from './helpers.js';

/*
 * Test hooks (HOSTS §4.3, SE-6): `test.replay` and `test.fault drop-response`, the two transport
 * primitives fault injection needs. Off unless the daemon was started with AIO_TEST_HOOKS=1; then
 * only over the host protocol (the host token); every use logged at warn; memory only.
 */

const alice = { channelUserId: 'alice', evidence: 'platform_signed' as const };
const dm = { conversation: { id: 'dm-alice', kind: 'dm' as const } };
const route = { channel: 'fake', account: 'default', conversationId: 'dm-alice' };

const bodies = (w: World, key: string) => w.gw.hub.log.read(key, 0).map((e: SessionEvent) => e.body);

function logs() {
  const lines: { level: string; msg: string }[] = [];
  return { lines, logger: (level: string, msg: string) => void lines.push({ level, msg }) };
}

describe('test hooks', () => {
  it('are off by default: both frames answer test_hooks_off, test.hooks is not advertised, sends are not wrapped; only AIO_TEST_HOOKS=1 turns them on #SE-6', async () => {
    const w = await daemon();
    expect(w.gw.testHooks).toBeUndefined();
    const c = await w.client();
    const hello = await c.hello({ token: w.gw.token, name: 'fi' });
    expect(hello.features).not.toContain('test.hooks');
    await expect(c.testReplay({ inputId: 'in_x' })).rejects.toMatchObject({ code: 'test_hooks_off' });
    await expect(c.testFault({ action: 'list' })).rejects.toMatchObject({ code: 'test_hooks_off' });
    await expect(c.testFault({ action: 'drop-response', channel: 'fake', next: 1 })).rejects.toMatchObject({ code: 'test_hooks_off' });
    expect(Object.prototype.hasOwnProperty.call(w.chat, 'send')).toBe(false);
    expect(await c.deliver({ operationId: 'op-off', route, message: { text: 'normal' } })).toMatchObject({ status: 'delivered' });

    expect(testHooksFromEnv({ AIO_TEST_HOOKS: '1' })).toBe(true);
    for (const v of [undefined, '', '0', 'true', 'yes', ' 1', '1 ']) expect(testHooksFromEnv(v === undefined ? {} : { AIO_TEST_HOOKS: v })).toBe(false);
  });

  it('need the host token: before host.hello (or with a wrong token) they are refused #SE-6', async () => {
    const w = await daemon({ gateway: { testHooks: true } });
    const c = await w.client();
    await expect(c.testFault({ action: 'list' })).rejects.toMatchObject({ code: 'unauthorized' });
    await expect(c.testReplay({ inputId: 'in_x' })).rejects.toMatchObject({ code: 'unauthorized' });
    await expect(c.hello({ token: 'nope', name: 'fi' })).rejects.toMatchObject({ code: 'unauthorized' });
    await expect(c.testFault({ action: 'clear' })).rejects.toMatchObject({ code: 'unauthorized' });
  });

  it('replay hands an accepted channel message to the gateway again: every copy is a duplicate, the session admits it once and one turn runs; gone after a restart #SE-6 #IN-5', async () => {
    const log = logs();
    const w = await daemon({ gateway: { testHooks: true, logger: log.logger } });
    const h = await w.host({ name: 'fi' });
    const r = await w.chat.inject({ ...dm, id: 'm1', sender: alice, text: 'hello once' });
    const inputId = r.inputId!;
    const key = w.gw.router.explain(inputId)!.matched[0]!.sessionKey!;
    await until(() => bodies(w, key).some((b) => b.t === 'turn.completed'));

    const [a, b] = await Promise.all([h.testReplay({ inputId }), h.testReplay({ inputId, times: 2 })]);
    for (const x of [a, b]) {
      expect(errors(HOST_RESULT_VALUES['test.replay'], x)).toEqual([]);
      expect(x).toMatchObject({ inputId, channelRef: 'channel:fake/m1', channel: 'fake', account: 'default' });
      for (const c of x.results) expect(c).toEqual({ action: 'duplicate', inputId });
    }
    expect(b.results).toHaveLength(2);
    await new Promise((res) => setTimeout(res, 50));
    expect(bodies(w, key).filter((x) => x.t === 'input.admitted' && x.inputId === inputId)).toHaveLength(1);
    expect(bodies(w, key).filter((x) => x.t === 'turn.started')).toHaveLength(1);
    expect((await h.verify(a.channelRef)).records).toHaveLength(1);
    expect(log.lines.filter((l) => l.level === 'warn' && l.msg.includes(`fi replays ${inputId}`))).toHaveLength(2);

    await expect(h.testReplay({ inputId: 'in_never' })).rejects.toMatchObject({ code: 'not_found' });
    for (const times of [0, 11, 1.5]) await expect(h.testReplay({ inputId, times })).rejects.toMatchObject({ code: 'invalid_frame' });

    await w.stop();
    const w2 = await daemon({ dir: w.dir, gateway: { testHooks: true } });
    await expect((await w2.host()).testReplay({ inputId })).rejects.toMatchObject({ code: 'not_found' });
  });

  it('drop-response: the next send goes out to the platform, its response is dropped and it settles unknown without a retry; the one after is normal; clear removes injections; conversation narrows it to one chat #SE-6 #DL-1', async () => {
    const log = logs();
    const w = await daemon({ gateway: { testHooks: true, outboxAttemptTimeoutMs: 150, logger: log.logger } });
    const h = await w.host({ name: 'fi' });

    const set = await h.testFault({ action: 'drop-response', channel: 'fake', next: 1 });
    expect(errors(HOST_RESULT_VALUES['test.fault'], set)).toEqual([]);
    expect(set.faults).toMatchObject([{ kind: 'drop-response', channel: 'fake', remaining: 1 }]);
    await expect(h.testFault({ action: 'drop-response', channel: 'nope', next: 1 })).rejects.toMatchObject({ code: 'unknown_channel' });
    for (const next of [0, 101]) await expect(h.testFault({ action: 'drop-response', channel: 'fake', next })).rejects.toMatchObject({ code: 'invalid_frame' });

    const d1 = await h.deliver({ operationId: 'op-d1', route, message: { text: 'dropped answer' } });
    expect(d1).toMatchObject({ status: 'unknown', attempts: 1 });
    expect(w.chat.sent.filter((s) => s.msg.text === 'dropped answer')).toHaveLength(1);
    expect(w.gw.hub.log.read('host:fi', 0).map((e) => e.body)).toContainEqual({ t: 'delivery.settled', operationId: 'host:op-d1', route, result: 'unknown' });
    expect((await h.testFault({ action: 'list' })).faults).toEqual([]);
    expect(await h.deliver({ operationId: 'op-d1', route, message: { text: 'dropped answer' } })).toMatchObject({ status: 'unknown', duplicate: true });
    expect(w.chat.sent.filter((s) => s.msg.text === 'dropped answer')).toHaveLength(1);

    expect(await h.deliver({ operationId: 'op-d2', route, message: { text: 'normal' } })).toMatchObject({ status: 'delivered' });
    expect((await h.testFault({ action: 'drop-response', channel: 'fake', account: 'default', next: 2 })).faults).toHaveLength(1);
    expect((await h.testFault({ action: 'clear' })).faults).toEqual([]);
    expect(await h.deliver({ operationId: 'op-d3', route, message: { text: 'after clear' } })).toMatchObject({ status: 'delivered' });
    // A (channel, account) that is not running is refused, nothing is armed.
    await expect(h.testFault({ action: 'drop-response', channel: 'fake', account: 'other', next: 1 })).rejects.toMatchObject({ code: 'unknown_channel' });
    expect((await h.testFault({ action: 'list' })).faults).toEqual([]);

    // `conversation` narrows it to one chat: a send to another chat of the same channel goes through and
    // does not use the injection up; the next send to that chat is the one dropped.
    const group = { channel: 'fake', account: 'default', conversationId: 'fi-group' };
    const armed = await h.testFault({ action: 'drop-response', channel: 'fake', conversation: 'fi-group', next: 1 });
    expect(errors(HOST_RESULT_VALUES['test.fault'], armed)).toEqual([]);
    expect(armed.faults).toMatchObject([{ kind: 'drop-response', channel: 'fake', conversation: 'fi-group', remaining: 1 }]);
    expect(await h.deliver({ operationId: 'op-c1', route, message: { text: 'other chat' } })).toMatchObject({ status: 'delivered' });
    expect((await h.testFault({ action: 'list' })).faults).toMatchObject([{ conversation: 'fi-group', remaining: 1 }]);
    expect(await h.deliver({ operationId: 'op-c2', route: group, message: { text: 'group answer' } })).toMatchObject({ status: 'unknown', attempts: 1 });
    expect(w.chat.sent.filter((s) => s.msg.text === 'group answer')).toHaveLength(1);
    expect((await h.testFault({ action: 'list' })).faults).toEqual([]);

    // A turn's own sends go through the same adapter: the first one (here the progress card's open) is dropped,
    // settled unknown in the session and sent once; the next (the final answer) goes out normally.
    await h.testFault({ action: 'drop-response', channel: 'fake', next: 1 });
    const r = await w.chat.inject({ ...dm, id: 'm-drop', sender: alice, text: 'answer me' });
    const key = w.gw.router.explain(r.inputId!)!.matched[0]!.sessionKey!;
    await until(() => bodies(w, key).filter((b) => b.t === 'delivery.settled').length === 2, 3000);
    const settled = bodies(w, key).filter((b) => b.t === 'delivery.settled') as { operationId: string; result: string }[];
    expect(settled.map((b) => b.result)).toEqual(['unknown', 'delivered']);
    expect(w.chat.sent.filter((s) => s.op.operationId === settled[0]!.operationId)).toHaveLength(1);
    expect(w.chat.sent.find((s) => s.op.operationId === settled[1]!.operationId)?.msg.text).toBe('echo: answer me');

    const warns = log.lines.filter((l) => l.level === 'warn' && l.msg.startsWith('test hook')).map((l) => l.msg);
    expect(warns.some((m) => m.includes('host:op-d1') && m.includes('response dropped'))).toBe(true);
    expect(warns.some((m) => m.includes('fi asked test.fault clear'))).toBe(true);
  });
});
