import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { HarnessEvent } from '@agents-io/protocol';
import type { ClaudeCodeOptions } from '../src/types.js';
import { DEFAULT_IDLE_TIMEOUT_MS, IDLE_CONTINUE } from '../src/watchdog.js';
import { bodies, collectUntil, input, isTurnCompleted, sdk } from './fake-query.js';
import { setup, uuidOf } from './claude-code-helpers.js';

// HC-3b: the idle deadline within a turn (after its first output). Timeouts are tens of
// milliseconds; "never fires" waits a few times that. The first-byte watchdog is off here unless said.

const MS = 25;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function configDir(fallbackModel: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'aio-idle-'));
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ fallbackModel }));
  return dir;
}

async function open(fallbackModel: unknown = ['claude-opus-5-5', 'gemini-3.8-flash-high'], options: ClaudeCodeOptions = {}) {
  return setup(
    { env: { CLAUDE_CONFIG_DIR: configDir(fallbackModel) } },
    { firstByteTimeoutMs: 0, idleTimeoutMs: MS, idleStallNotice: 'stopped after {seconds} s; ran: {tools}', ...options },
    { settingSources: ['user'] },
  );
}

const isFallback = (e: HarnessEvent) => e.body.t === 'native' && e.body.name === 'system/model_fallback';
const methods = (q: { calls: { method: string }[] }) => q.calls.map((c) => c.method);
const textOf = (m: { message: { content: unknown } }) =>
  typeof m.message.content === 'string'
    ? m.message.content
    : (m.message.content as { type: string; text?: string }[]).map((b) => b.text ?? '').join('');
const finals = (evs: HarnessEvent[]) =>
  evs.flatMap((e) => (e.body.t === 'text.snapshot' && e.body.final ? [e.body.text] : []));

describe('idle deadline', () => {
  it('defaults to 90 s #HC-3b', () => {
    expect(DEFAULT_IDLE_TIMEOUT_MS).toBe(90_000);
  });

  it('a request after read-only tools that sends nothing goes on on the next fallback model; nothing is run or written twice #HC-3b', async () => {
    const { s, q, it, give, conform } = await open();
    give('t1', 'a');
    await s.startTurn('t1', [input('a', 'what is in the readme')]);
    q.push(sdk.init(), sdk.textDelta('let me look'), sdk.toolUse('tu', 'Read', { file_path: '/x/README.md' }), sdk.toolResult('tu', '# x'));
    const evs = await collectUntil(it, isFallback);
    expect(methods(q)).toEqual(['interrupt', 'setModel']);
    expect(evs.at(-1)!.native).toMatchObject({
      subtype: 'model_fallback',
      trigger: 'idle_timeout',
      original_model: 'haiku',
      fallback_model: 'claude-opus-5-5',
      timeout_ms: MS,
    });
    await q.waitWritten(2);
    // The turn so far is in the CLI's history: one "go on", the input is not written again.
    expect(textOf(q.written[1]!)).toBe(IDLE_CONTINUE);
    q.push(sdk.result({ uuids: [uuidOf(q, 0)], subtype: 'error_during_execution', terminal_reason: 'aborted_streaming' }));
    q.push(sdk.text('m2', 'it says x'), sdk.result({ uuids: [uuidOf(q, 1)], result: 'it says x' }));
    evs.push(...(await collectUntil(it, isTurnCompleted)));
    expect(q.written).toHaveLength(2);
    expect(bodies(evs, 'input.consumed')).toEqual([{ t: 'input.consumed', inputIds: ['a'], turnId: 't1' }]);
    expect(bodies(evs, 'turn.completed')).toEqual([expect.objectContaining({ turnId: 't1', status: 'completed' })]);
    conform(evs);
  });

  it('after a tool that may have changed something, the turn ends failed (idle_timeout), says so, and nothing runs again #HC-3b', async () => {
    const { s, q, it, give, conform } = await open();
    give('t1', 'a');
    await s.startTurn('t1', [input('a', 'restart the service')]);
    q.push(sdk.init(), sdk.text('m1', 'restarting'), sdk.toolUse('tu', 'Bash', { command: 'systemctl restart x' }), sdk.toolResult('tu', 'ok'));
    await wait(MS * 4);
    expect(methods(q)).toEqual(['interrupt']); // no model switch: the Bash call is not run again
    expect(q.written).toHaveLength(1);
    q.push(sdk.result({ uuids: [uuidOf(q, 0)], subtype: 'error_during_execution', terminal_reason: 'aborted_streaming' }));
    const evs = await collectUntil(it, isTurnCompleted);
    expect(finals(evs)).toEqual(['restarting\n\nstopped after 0 s; ran: Bash']);
    expect(bodies(evs, 'turn.completed')).toEqual([
      expect.objectContaining({ turnId: 't1', status: 'failed', error: expect.objectContaining({ code: 'idle_timeout', retryable: false }) }),
    ]);
    expect(evs.filter(isFallback)).toEqual([]);
    conform(evs);
  });

  it('a follow-up queued behind a turn it ends after a side effect is not cancelled: withdrawn, left unconsumed for the next turn #HC-3b', async () => {
    const { s, q, it, give, conform } = await open();
    give('t1', 'a', 'b');
    await s.startTurn('t1', [input('a', 'restart the service')]);
    q.push(sdk.init(), sdk.text('m1', 'restarting'), sdk.toolUse('tu', 'Bash', { command: 'systemctl restart x' }), sdk.toolResult('tu', 'ok'));
    expect(await s.steer([input('b', 'and then tell me the status')], 't1')).toBe('steered');
    await q.waitWritten(2);
    q.cliQueue.add(uuidOf(q, 1)); // the CLI holds the follow-up: not started
    await wait(MS * 4);
    expect(methods(q)).toEqual(['interrupt', 'cancelAsyncMessage']);
    q.push(sdk.result({ uuids: [uuidOf(q, 0)], subtype: 'error_during_execution', terminal_reason: 'aborted_streaming' }));
    const evs = await collectUntil(it, isTurnCompleted);
    expect(bodies(evs, 'input.cancelled')).toEqual([]);
    expect(bodies(evs, 'input.consumed')).toEqual([{ t: 'input.consumed', inputIds: ['a'], turnId: 't1' }]);
    expect(bodies(evs, 'turn.completed')).toEqual([
      expect.objectContaining({ turnId: 't1', status: 'failed', error: expect.objectContaining({ code: 'idle_timeout' }) }),
    ]);
    conform(evs);
  });

  it('a follow-up the CLI took for a run of its own (not withdrawn, not named) is carried: not consumed, never written again; the next turn given it owns that run #HC-3b', async () => {
    const { s, q, it, give, conform } = await open();
    give('t1', 'a', 'b');
    await s.startTurn('t1', [input('a', 'restart the service')]);
    q.push(sdk.init(), sdk.text('m1', 'restarting'), sdk.toolUse('tu', 'Bash', { command: 'systemctl restart x' }), sdk.toolResult('tu', 'ok'));
    expect(await s.steer([input('b', 'and then tell me the status')], 't1')).toBe('steered');
    await q.waitWritten(2);
    // Not in the CLI's queue: it has dequeued the follow-up already, for a run of its own.
    await wait(MS * 4);
    expect(methods(q)).toEqual(['interrupt']);
    q.push(sdk.result({ uuids: [uuidOf(q, 0)], subtype: 'error_during_execution', terminal_reason: 'aborted_streaming' }));
    const evs = await collectUntil(it, isTurnCompleted);
    expect(bodies(evs, 'input.cancelled')).toEqual([]);
    expect(bodies(evs, 'input.consumed')).toEqual([{ t: 'input.consumed', inputIds: ['a'], turnId: 't1' }]);
    // The CLI starts that run before the host's next turn does: held, not a turn nobody owns.
    q.push({ ...sdk.text('m2', 'it is running'), user_message_uuid: uuidOf(q, 1) });
    await wait(MS);
    give('t2', 'b');
    await s.startTurn('t2', [input('b', 'and then tell me the status')]);
    q.push(sdk.result({ uuids: [uuidOf(q, 1)], result: 'it is running' }));
    const evs2 = await collectUntil(it, isTurnCompleted);
    expect(q.written).toHaveLength(2); // adopted, never written again
    expect(bodies(evs2, 'input.consumed')).toEqual([{ t: 'input.consumed', inputIds: ['b'], turnId: 't2' }]);
    expect(bodies(evs2, 'turn.completed')).toEqual([expect.objectContaining({ turnId: 't2', status: 'completed' })]);
    expect(finals(evs2)).toEqual(['it is running']);
    expect(evs2.filter((e) => e.body.t === 'text.snapshot').every((e) => e.turnId === 't2')).toBe(true);
    expect([...evs, ...evs2].filter((e) => e.body.t === 'notice')).toEqual([]); // no "started a turn on its own"
    conform();
  });

  it('a result that comes before the interrupt receipt waits for the withdraw: the follow-up is withdrawn, unconsumed, and runs once as the next turn #HC-3b', async () => {
    const { s, q, it, give, conform } = await open();
    give('t1', 'a', 'b');
    await s.startTurn('t1', [input('a', 'restart the service')]);
    q.push(sdk.init(), sdk.text('m1', 'restarting'), sdk.toolUse('tu', 'Bash', { command: 'systemctl restart x' }), sdk.toolResult('tu', 'ok'));
    expect(await s.steer([input('b', 'and then tell me the status')], 't1')).toBe('steered');
    await q.waitWritten(2);
    q.cliQueue.add(uuidOf(q, 1));
    const interrupt = q.interrupt.bind(q);
    q.interrupt = async () => {
      q.push(sdk.result({ uuids: [uuidOf(q, 0)], subtype: 'error_during_execution', terminal_reason: 'aborted_streaming' }));
      await wait(MS);
      return interrupt();
    };
    const evs = await collectUntil(it, isTurnCompleted);
    expect(methods(q)).toEqual(['interrupt', 'cancelAsyncMessage']);
    expect(q.cliQueue.size).toBe(0); // nothing left in the CLI to run on its own
    expect(bodies(evs, 'input.consumed')).toEqual([{ t: 'input.consumed', inputIds: ['a'], turnId: 't1' }]);
    expect(bodies(evs, 'input.cancelled')).toEqual([]);
    give('t2', 'b');
    await s.startTurn('t2', [input('b', 'and then tell me the status')]);
    expect(q.written).toHaveLength(3); // withdrawn: written for its own turn
    q.push(sdk.text('m2', 'up'), sdk.result({ uuids: [uuidOf(q, 2)], result: 'up' }));
    const evs2 = await collectUntil(it, isTurnCompleted);
    expect(bodies(evs2, 'input.consumed')).toEqual([{ t: 'input.consumed', inputIds: ['b'], turnId: 't2' }]);
    expect(finals(evs2)).toEqual(['up']);
    conform();
  });

  it('a withdraw answered late: carried meanwhile, so the adopting turn writes the follow-up again only once the CLI gave it back #HC-3b', async () => {
    const { s, q, it, give, conform } = await open(undefined, { idleWithdrawWaitMs: MS });
    give('t1', 'a', 'b');
    await s.startTurn('t1', [input('a', 'restart the service')]);
    q.push(sdk.init(), sdk.text('m1', 'restarting'), sdk.toolUse('tu', 'Bash', { command: 'systemctl restart x' }), sdk.toolResult('tu', 'ok'));
    expect(await s.steer([input('b', 'and then tell me the status')], 't1')).toBe('steered');
    await q.waitWritten(2);
    q.cliQueue.add(uuidOf(q, 1));
    const cancel = q.cancelAsyncMessage.bind(q);
    let release!: () => void;
    const slow = new Promise<void>((r) => (release = r));
    q.cancelAsyncMessage = async (u: string) => {
      await slow;
      return cancel(u);
    };
    await wait(MS * 4);
    q.push(sdk.result({ uuids: [uuidOf(q, 0)], subtype: 'error_during_execution', terminal_reason: 'aborted_streaming' }));
    const evs = await collectUntil(it, isTurnCompleted);
    expect(bodies(evs, 'input.consumed')).toEqual([{ t: 'input.consumed', inputIds: ['a'], turnId: 't1' }]);
    expect(bodies(evs, 'input.cancelled')).toEqual([]);
    give('t2', 'b');
    await s.startTurn('t2', [input('b', 'and then tell me the status')]);
    expect(q.written).toHaveLength(2); // the CLI may still hold it: not written twice
    release();
    await q.waitWritten(3); // given back: written again, in t2
    expect(q.cliQueue.size).toBe(0);
    q.push(sdk.text('m2', 'up'), sdk.result({ uuids: [uuidOf(q, 2)], result: 'up' }));
    const evs2 = await collectUntil(it, isTurnCompleted);
    expect(bodies(evs2, 'input.consumed')).toEqual([{ t: 'input.consumed', inputIds: ['b'], turnId: 't2' }]);
    expect(bodies(evs2, 'turn.completed')).toEqual([expect.objectContaining({ turnId: 't2', status: 'completed' })]);
    conform();
  });

  it('a withdraw answered late that the CLI kept: the adopting turn owns the CLI\'s run of it, nothing written twice #HC-3b', async () => {
    const { s, q, it, give, conform } = await open(undefined, { idleWithdrawWaitMs: MS });
    give('t1', 'a', 'b');
    await s.startTurn('t1', [input('a', 'restart the service')]);
    q.push(sdk.init(), sdk.text('m1', 'restarting'), sdk.toolUse('tu', 'Bash', { command: 'systemctl restart x' }), sdk.toolResult('tu', 'ok'));
    expect(await s.steer([input('b', 'and then tell me the status')], 't1')).toBe('steered');
    await q.waitWritten(2);
    q.cliQueue.add(uuidOf(q, 1));
    let release!: () => void;
    const slow = new Promise<void>((r) => (release = r));
    q.cancelAsyncMessage = async () => {
      await slow;
      return false; // dequeued meanwhile: the CLI runs it
    };
    await wait(MS * 4);
    q.push(sdk.result({ uuids: [uuidOf(q, 0)], subtype: 'error_during_execution', terminal_reason: 'aborted_streaming' }));
    const evs = await collectUntil(it, isTurnCompleted);
    expect(bodies(evs, 'input.consumed')).toEqual([{ t: 'input.consumed', inputIds: ['a'], turnId: 't1' }]);
    give('t2', 'b');
    await s.startTurn('t2', [input('b', 'and then tell me the status')]);
    release();
    await wait(MS);
    q.push(sdk.text('m2', 'up'), sdk.result({ uuids: [uuidOf(q, 1)], result: 'up' }));
    const evs2 = await collectUntil(it, isTurnCompleted);
    expect(q.written).toHaveLength(2);
    expect(bodies(evs2, 'input.consumed')).toEqual([{ t: 'input.consumed', inputIds: ['b'], turnId: 't2' }]);
    expect(finals(evs2)).toEqual(['up']);
    conform();
  });

  it('a withdraw answered late while the CLI already runs the follow-up: that run is not the stalled turn\'s; carried, the next turn owns its run and answer #HC-3b', async () => {
    const { s, q, it, give, conform } = await open(undefined, { idleWithdrawWaitMs: MS * 6 });
    give('t1', 'a', 'b');
    await s.startTurn('t1', [input('a', 'restart the service')]);
    q.push(sdk.init(), sdk.text('m1', 'restarting'), sdk.toolUse('tu', 'Bash', { command: 'systemctl restart x' }), sdk.toolResult('tu', 'ok'));
    expect(await s.steer([input('b', 'and then tell me the status')], 't1')).toBe('steered');
    await q.waitWritten(2);
    q.cliQueue.add(uuidOf(q, 1));
    let release!: () => void;
    const slow = new Promise<void>((r) => (release = r));
    let asked = false;
    q.cancelAsyncMessage = async () => {
      asked = true;
      await slow;
      return false; // dequeued meanwhile: the CLI runs it
    };
    while (!asked) await wait(MS / 5);
    // The CLI ends the interrupted run, then starts the follow-up's own run while the withdraw waits.
    q.push(sdk.result({ uuids: [uuidOf(q, 0)], subtype: 'error_during_execution', terminal_reason: 'aborted_streaming' }));
    q.push(sdk.init(), { ...sdk.text('m2', 'it is up'), user_message_uuid: uuidOf(q, 1) });
    const evs = await collectUntil(it, isTurnCompleted);
    expect(bodies(evs, 'input.consumed')).toEqual([{ t: 'input.consumed', inputIds: ['a'], turnId: 't1' }]);
    expect(bodies(evs, 'input.cancelled')).toEqual([]);
    expect(JSON.stringify(evs)).not.toContain('it is up'); // not said as the stalled turn's
    // Its result comes after the stalled turn ended, before the host's next turn: held, not a turn nobody owns.
    q.push(sdk.result({ uuids: [uuidOf(q, 1)], result: 'it is up' }));
    release();
    await wait(MS);
    give('t2', 'b');
    await s.startTurn('t2', [input('b', 'and then tell me the status')]);
    const evs2 = await collectUntil(it, isTurnCompleted);
    expect(q.written).toHaveLength(2); // never written again
    expect(bodies(evs2, 'input.consumed')).toEqual([{ t: 'input.consumed', inputIds: ['b'], turnId: 't2' }]);
    expect(bodies(evs2, 'turn.completed')).toEqual([expect.objectContaining({ turnId: 't2', status: 'completed' })]);
    expect(finals(evs2)).toEqual(['it is up']);
    expect(evs2.filter((e) => e.body.t === 'text.snapshot').every((e) => e.turnId === 't2')).toBe(true);
    expect([...evs, ...evs2].filter((e) => e.body.t === 'notice')).toEqual([]);
    conform();
  });

  it('the CLI runs the follow-up the interrupt receipt listed, with no result for the stalled run first: that run is still not the stalled turn\'s #HC-3b', async () => {
    const { s, q, it, give, conform } = await open(undefined, { idleWithdrawWaitMs: MS * 6 });
    give('t1', 'a', 'b');
    await s.startTurn('t1', [input('a', 'restart the service')]);
    q.push(sdk.init(), sdk.text('m1', 'restarting'), sdk.toolUse('tu', 'Bash', { command: 'systemctl restart x' }), sdk.toolResult('tu', 'ok'));
    expect(await s.steer([input('b', 'and then tell me the status')], 't1')).toBe('steered');
    await q.waitWritten(2);
    q.cliQueue.add(uuidOf(q, 1));
    let release!: () => void;
    const slow = new Promise<void>((r) => (release = r));
    let asked = false;
    q.cancelAsyncMessage = async () => {
      asked = true;
      await slow;
      return false;
    };
    while (!asked) await wait(MS / 5);
    // Named by output after the receipt said it was queued, not started: its own run.
    q.push(sdk.init(), { ...sdk.text('m2', 'it is up'), user_message_uuid: uuidOf(q, 1) });
    const evs = await collectUntil(it, isTurnCompleted);
    expect(bodies(evs, 'turn.completed')).toEqual([expect.objectContaining({ turnId: 't1', status: 'failed' })]);
    expect(bodies(evs, 'input.consumed')).toEqual([{ t: 'input.consumed', inputIds: ['a'], turnId: 't1' }]);
    expect(JSON.stringify(evs)).not.toContain('it is up');
    q.push(sdk.result({ uuids: [uuidOf(q, 1)], result: 'it is up' }));
    release();
    await wait(MS);
    give('t2', 'b');
    await s.startTurn('t2', [input('b', 'and then tell me the status')]);
    const evs2 = await collectUntil(it, isTurnCompleted);
    expect(q.written).toHaveLength(2);
    expect(bodies(evs2, 'input.consumed')).toEqual([{ t: 'input.consumed', inputIds: ['b'], turnId: 't2' }]);
    expect(finals(evs2)).toEqual(['it is up']);
    expect([...evs, ...evs2].filter((e) => e.body.t === 'notice')).toEqual([]);
    conform();
  });

  it('an interrupt receipt that never comes after the result came: the stalled turn still ends, its follow-up carried #HC-3b', async () => {
    const { s, q, it, give, conform } = await open();
    give('t1', 'a', 'b');
    await s.startTurn('t1', [input('a', 'restart the service')]);
    q.push(sdk.init(), sdk.text('m1', 'restarting'), sdk.toolUse('tu', 'Bash', { command: 'systemctl restart x' }), sdk.toolResult('tu', 'ok'));
    expect(await s.steer([input('b', 'and then tell me the status')], 't1')).toBe('steered');
    await q.waitWritten(2);
    q.interrupt = async () => {
      q.calls.push({ method: 'interrupt' });
      q.push(sdk.result({ uuids: [uuidOf(q, 0)], subtype: 'error_during_execution', terminal_reason: 'aborted_streaming' }));
      return new Promise<never>(() => undefined);
    };
    const evs = await collectUntil(it, isTurnCompleted);
    expect(bodies(evs, 'input.consumed')).toEqual([{ t: 'input.consumed', inputIds: ['a'], turnId: 't1' }]);
    expect(bodies(evs, 'turn.completed')).toEqual([
      expect.objectContaining({ turnId: 't1', status: 'failed', error: expect.objectContaining({ code: 'idle_timeout' }) }),
    ]);
    give('t2', 'b');
    await s.startTurn('t2', [input('b', 'and then tell me the status')]);
    q.push(sdk.text('m2', 'up'), sdk.result({ uuids: [uuidOf(q, 1)], result: 'up' }));
    const evs2 = await collectUntil(it, isTurnCompleted);
    expect(q.written).toHaveLength(2);
    expect(bodies(evs2, 'input.consumed')).toEqual([{ t: 'input.consumed', inputIds: ['b'], turnId: 't2' }]);
    conform();
  }, 10_000);

  it('a stalled run\'s result that comes after the interrupt\'s 5 s ended the turn is not the next turn\'s end #HC-3b', async () => {
    const { s, q, it, give, conform } = await open();
    give('t1', 'a', 'b');
    await s.startTurn('t1', [input('a', 'restart the service')]);
    q.push(sdk.init(), { ...sdk.text('m1', 'restarting'), user_message_uuid: uuidOf(q, 0) });
    q.push(sdk.toolUse('tu', 'Bash', { command: 'systemctl restart x' }), sdk.toolResult('tu', 'ok'));
    expect(await s.steer([input('b', 'and then tell me the status')], 't1')).toBe('steered');
    await q.waitWritten(2);
    q.cliQueue.add(uuidOf(q, 1)); // withdrawn: left for the next turn
    const evs = await collectUntil(it, isTurnCompleted); // no result: ended by the 5 s
    expect(bodies(evs, 'input.consumed')).toEqual([{ t: 'input.consumed', inputIds: ['a'], turnId: 't1' }]);
    give('t2', 'b');
    await s.startTurn('t2', [input('b', 'and then tell me the status')]);
    await q.waitWritten(3);
    // The interrupted run's result, late, then the next turn's own run.
    q.push(sdk.result({ uuids: [uuidOf(q, 0)], subtype: 'error_during_execution', terminal_reason: 'aborted_streaming' }));
    q.push(sdk.text('m2', 'up'), sdk.result({ uuids: [uuidOf(q, 2)], result: 'up' }));
    const evs2 = await collectUntil(it, isTurnCompleted);
    expect(bodies(evs2, 'input.consumed')).toEqual([{ t: 'input.consumed', inputIds: ['b'], turnId: 't2' }]);
    expect(bodies(evs2, 'turn.completed')).toEqual([expect.objectContaining({ turnId: 't2', status: 'completed' })]);
    expect(finals(evs2)).toEqual(['up']);
    conform();
  }, 10_000);

  it('an interrupted result that names no uuid: the stalled turn counts its own input consumed (it is not run again) #HC-3b', async () => {
    const { s, q, it, give, conform } = await open();
    give('t1', 'a', 'b');
    await s.startTurn('t1', [input('a', 'restart the service')]);
    q.push(sdk.init(), sdk.text('m1', 'restarting'), sdk.toolUse('tu', 'Bash', { command: 'systemctl restart x' }), sdk.toolResult('tu', 'ok'));
    expect(await s.steer([input('b', 'and then tell me the status')], 't1')).toBe('steered');
    await q.waitWritten(2);
    q.cliQueue.add(uuidOf(q, 1));
    await wait(MS * 4);
    q.push(sdk.result({ subtype: 'error_during_execution', terminal_reason: 'aborted_streaming' }));
    const evs = await collectUntil(it, isTurnCompleted);
    // Only the withdrawn follow-up is left for the next turn.
    expect(bodies(evs, 'input.consumed')).toEqual([{ t: 'input.consumed', inputIds: ['a'], turnId: 't1' }]);
    expect(bodies(evs, 'input.cancelled')).toEqual([]);
    conform(evs);
  });

  it('a result that arrives while the follow-up is being withdrawn waits for it: withdrawn stays unconsumed, the rest consumed #HC-3b', async () => {
    const { s, q, it, give, conform } = await open();
    give('t1', 'a', 'b');
    await s.startTurn('t1', [input('a', 'restart the service')]);
    q.push(sdk.init(), sdk.text('m1', 'restarting'), sdk.toolUse('tu', 'Bash', { command: 'systemctl restart x' }), sdk.toolResult('tu', 'ok'));
    expect(await s.steer([input('b', 'and then tell me the status')], 't1')).toBe('steered');
    await q.waitWritten(2);
    q.cliQueue.add(uuidOf(q, 1));
    const cancel = q.cancelAsyncMessage.bind(q);
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    q.cancelAsyncMessage = async (u: string) => {
      await held;
      return cancel(u);
    };
    await wait(MS * 4);
    expect(methods(q)).toEqual(['interrupt']);
    q.push(sdk.result({ subtype: 'error_during_execution', terminal_reason: 'aborted_streaming' }));
    await wait(MS);
    release();
    const evs = await collectUntil(it, isTurnCompleted);
    expect(bodies(evs, 'input.consumed')).toEqual([{ t: 'input.consumed', inputIds: ['a'], turnId: 't1' }]);
    expect(bodies(evs, 'input.cancelled')).toEqual([]);
    conform(evs);
  });

  it('a Bash call that runs while the interrupt is on its way: no model switch, no "go on"; the turn ends failed and says so #HC-3b', async () => {
    const { s, q, it, give, conform } = await open();
    give('t1', 'a');
    await s.startTurn('t1', [input('a', 'what is in the readme')]);
    q.push(sdk.init(), sdk.text('m1', 'let me look'), sdk.toolUse('tu', 'Read', { file_path: '/x/README.md' }), sdk.toolResult('tu', '# x'));
    // The deadline fires on the read; before the CLI takes the interrupt, the model asks for a Bash call and it runs.
    const interrupt = q.interrupt.bind(q);
    q.interrupt = async () => {
      q.push(sdk.toolUse('tu2', 'Bash', { command: 'touch /x/done' }), sdk.toolResult('tu2', ''));
      await wait(MS);
      return interrupt();
    };
    await wait(MS * 4);
    expect(methods(q)).toEqual(['interrupt']); // read again after the interrupt: no setModel
    expect(q.written).toHaveLength(1); // no "go on": the Bash call is not run again
    q.push(sdk.result({ uuids: [uuidOf(q, 0)], subtype: 'error_during_execution', terminal_reason: 'aborted_streaming' }));
    const evs = await collectUntil(it, isTurnCompleted);
    expect(finals(evs)).toEqual(['let me look\n\nstopped after 0 s; ran: Bash']);
    expect(bodies(evs, 'turn.completed')).toEqual([
      expect.objectContaining({ turnId: 't1', status: 'failed', error: expect.objectContaining({ code: 'idle_timeout', retryable: false }) }),
    ]);
    expect(evs.filter(isFallback)).toEqual([]);
    conform(evs);
  });

  it('a Bash call cut off by the interrupt (no result) counts as a side effect too #HC-3b', async () => {
    const { s, q, it, give, conform } = await open();
    give('t1', 'a');
    await s.startTurn('t1', [input('a', 'hi')]);
    q.push(sdk.init(), sdk.text('m1', 'one moment'));
    const interrupt = q.interrupt.bind(q);
    q.interrupt = async () => {
      q.push(sdk.toolUse('tu', 'Bash', { command: 'make install' }));
      await wait(MS);
      return interrupt();
    };
    await wait(MS * 4);
    expect(methods(q)).toEqual(['interrupt']);
    expect(q.written).toHaveLength(1);
    q.push(sdk.result({ uuids: [uuidOf(q, 0)], subtype: 'error_during_execution', terminal_reason: 'aborted_tools' }));
    const evs = await collectUntil(it, isTurnCompleted);
    expect(finals(evs).at(-1)).toBe('one moment\n\nstopped after 0 s; ran: Bash');
    expect(bodies(evs, 'turn.completed')).toEqual([
      expect.objectContaining({ status: 'failed', error: expect.objectContaining({ code: 'idle_timeout' }) }),
    ]);
    expect(evs.filter(isFallback)).toEqual([]);
    conform(evs);
  });

  it('not while a tool runs (its permission prompt included), nor while the CLI compacts #HC-3b', async () => {
    const { s, q, it, give, conform } = await open();
    give('t1', 'a');
    await s.startTurn('t1', [input('a', 'build it')]);
    q.push(sdk.init(), sdk.toolUse('tu', 'Bash', { command: 'make' }));
    await wait(MS * 4); // the tool runs (its own timeout bounds it)
    expect(methods(q)).toEqual([]);
    q.push(sdk.toolResult('tu', 'built'), sdk.system('status', { status: 'compacting' }));
    await wait(MS * 4); // compacting is a model call of its own
    expect(methods(q)).toEqual([]);
    q.push(sdk.system('status', { status: null }), sdk.text('m2', 'done'), sdk.result({ uuids: [uuidOf(q, 0)], result: 'done' }));
    const evs = await collectUntil(it, isTurnCompleted);
    expect(bodies(evs, 'turn.completed')).toEqual([expect.objectContaining({ status: 'completed' })]);
    conform(evs);
  });

  it('every CLI message starts it again: a slow but streaming answer is never cut #HC-3b', async () => {
    const { s, q, it, give, conform } = await open();
    give('t1', 'a');
    await s.startTurn('t1', [input('a', 'tell me a story')]);
    q.push(sdk.init());
    for (let i = 0; i < 6; i++) {
      q.push(sdk.textDelta(`w${i} `));
      await wait(MS / 2);
    }
    expect(methods(q)).toEqual([]);
    q.push(sdk.result({ uuids: [uuidOf(q, 0)], result: 'w0 w1' }));
    conform(await collectUntil(it, isTurnCompleted));
  });

  it('each model at most once per turn: the chain used up ends the turn with the notice #HC-3b', async () => {
    const { s, q, it, give, conform } = await open(['claude-opus-5-5']);
    give('t1', 'a');
    await s.startTurn('t1', [input('a', 'hi')]);
    q.push(sdk.init(), sdk.textDelta('h'));
    await collectUntil(it, isFallback);
    await q.waitWritten(2);
    q.push(sdk.result({ uuids: [uuidOf(q, 0)], subtype: 'error_during_execution', terminal_reason: 'aborted_streaming' }));
    q.push(sdk.textDelta('x')); // the fallback starts, then hangs too: no model left
    await wait(MS * 4);
    expect(methods(q)).toEqual(['interrupt', 'setModel', 'interrupt']);
    q.push(sdk.result({ uuids: [uuidOf(q, 1)], subtype: 'error_during_execution', terminal_reason: 'aborted_streaming' }));
    const evs = await collectUntil(it, isTurnCompleted);
    expect(q.written).toHaveLength(2);
    expect(bodies(evs, 'turn.completed')).toEqual([
      expect.objectContaining({ status: 'failed', error: expect.objectContaining({ code: 'idle_timeout' }) }),
    ]);
    expect(finals(evs).at(-1)).toBe('stopped after 0 s; ran: -');
    conform(evs);
  });

  it('idleTimeoutMs: 0 turns it off #HC-3b', async () => {
    const { s, q, it, give, conform } = await open(undefined, { idleTimeoutMs: 0 });
    give('t1', 'a');
    await s.startTurn('t1', [input('a', 'x')]);
    q.push(sdk.init(), sdk.textDelta('h'));
    await wait(MS * 4);
    expect(methods(q)).toEqual([]);
    q.push(sdk.result({ uuids: [uuidOf(q, 0)], result: 'h' }));
    conform(await collectUntil(it, isTurnCompleted));
  });
});
