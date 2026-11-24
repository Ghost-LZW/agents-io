import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { HarnessEvent } from '@agents-io/protocol';
import type { ClaudeCodeOptions } from '../src/types.js';
import { WATCHDOG_CONTINUE } from '../src/watchdog.js';
import { bodies, collectUntil, input, isTurnCompleted, sdk } from './fake-query.js';
import { run, setup, uuidOf } from './claude-code-helpers.js';

// HC-3: the first-byte watchdog. Timeouts are tens of milliseconds; "never fires" waits a few times that.

const MS = 25;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const NO_SETTINGS = Symbol('no settings.json');

/** A CLAUDE_CONFIG_DIR whose settings.json sets `fallbackModel`. */
function configDir(fallbackModel: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'aio-wd-'));
  if (fallbackModel !== NO_SETTINGS) writeFileSync(join(dir, 'settings.json'), JSON.stringify({ fallbackModel }));
  return dir;
}

async function open(fallbackModel: unknown = ['claude-opus-5-5', 'gemini-3.8-flash-high'], options: ClaudeCodeOptions = {}) {
  return setup(
    { env: { CLAUDE_CONFIG_DIR: configDir(fallbackModel) } },
    { firstByteTimeoutMs: MS, ...options },
    { settingSources: ['user'] },
  );
}

const isFallback = (e: HarnessEvent) => e.body.t === 'native' && e.body.name === 'system/model_fallback';
const methods = (q: { calls: { method: string }[] }) => q.calls.map((c) => c.method);
const textOf = (m: { message: { content: unknown } }) =>
  typeof m.message.content === 'string'
    ? m.message.content
    : (m.message.content as { type: string; text?: string }[]).map((b) => b.text ?? '').join('');

/** setModel as Claude Code answers it: `refuse` models fail its model check (529, or it hangs and gives up). */
function refuseModels(q: { setModel: (m?: string) => Promise<void>; calls: { method: string; arg?: unknown }[] }, refuse: string[]) {
  q.setModel = async (m?: string) => {
    q.calls.push({ method: 'setModel', arg: m });
    if (m && refuse.includes(m)) throw new Error(`Couldn't confirm model "${m}" with the API.`);
  };
}

/**
 * setModel that takes its time on `model` (Claude Code checks a model with a request first; one that hangs
 * fails after seconds): `started` resolves when it is called, `release()` lets it answer (fail or not).
 */
function slowCheck(q: { setModel: (m?: string) => Promise<void>; calls: { method: string; arg?: unknown }[] }, model: string, fails: boolean) {
  const prev = q.setModel.bind(q);
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let called!: () => void;
  const started = new Promise<void>((r) => (called = r));
  q.setModel = async (m?: string) => {
    if (m !== model) return prev(m);
    q.calls.push({ method: 'setModel', arg: m });
    called();
    await gate;
    if (fails) throw new Error(`Couldn't confirm model "${m}" with the API.`);
  };
  return { started, release };
}

describe('first-byte watchdog', () => {
  it('a turn with no first byte is interrupted and goes on on the first fallback model; the host gets system/model_fallback; the next turn is back on its own model #HC-3', async () => {
    const { s, q, it, give, conform } = await open();
    give('t1', 'a');
    await s.startTurn('t1', [input('a', 'hello')]);
    q.push(sdk.init()); // the CLI starting is not the model answering
    const evs = await collectUntil(it, isFallback);
    expect(q.calls).toEqual([{ method: 'interrupt' }, { method: 'setModel', arg: 'claude-opus-5-5' }]);
    const fb = evs.at(-1)!;
    expect(fb.turnId).toBe('t1');
    expect(fb.native).toMatchObject({
      type: 'system',
      subtype: 'model_fallback',
      trigger: 'first_byte_timeout',
      original_model: 'haiku',
      fallback_model: 'claude-opus-5-5',
      timeout_ms: MS,
    });
    await q.waitWritten(2);
    // The input is in Claude Code's history already: not written again, a short "go on" instead.
    const [, cont] = q.written;
    expect(textOf(cont!)).toBe(WATCHDOG_CONTINUE);
    expect(cont!.uuid).not.toBe(uuidOf(q, 0));
    // The given-up attempt's result is not the turn's end; the second attempt's is.
    q.push(sdk.result({ uuids: [uuidOf(q, 0)], subtype: 'error_during_execution', terminal_reason: 'aborted_streaming' }));
    q.push(sdk.text('m1', 'hi'), sdk.result({ uuids: [uuidOf(q, 1)], result: 'hi' }));
    evs.push(...(await collectUntil(it, isTurnCompleted)));
    expect(q.written).toHaveLength(2);
    expect(bodies(evs, 'input.consumed')).toEqual([{ t: 'input.consumed', inputIds: ['a'], turnId: 't1' }]);
    expect(bodies(evs, 'turn.completed')).toEqual([expect.objectContaining({ turnId: 't1', status: 'completed' })]);
    expect(evs.filter(isFallback)).toHaveLength(1);
    conform(evs);

    give('t2', 'b');
    await s.startTurn('t2', [input('b', 'again')], run);
    expect(q.calls.at(-1)).toEqual({ method: 'setModel', arg: 'haiku' });
    q.push(sdk.textDelta('ok'), sdk.result({ uuids: [uuidOf(q, 2)], result: 'ok' }));
    conform(await collectUntil(it, isTurnCompleted));
  });

  it('never once the model answered or called a tool: any model output before the deadline turns it off for the turn #HC-3', async () => {
    for (const first of [sdk.textDelta('h'), sdk.thinkingDelta('hm'), sdk.toolUse('tu', 'Bash', { command: 'touch x' })]) {
      const { s, q, it, give, conform } = await open();
      give('t1', 'a');
      await s.startTurn('t1', [input('a', 'x')]);
      q.push(sdk.init(), first);
      await wait(MS * 4);
      expect(methods(q)).toEqual([]);
      q.push(sdk.result({ uuids: [uuidOf(q, 0)] }));
      const evs = await collectUntil(it, isTurnCompleted);
      expect(evs.filter(isFallback)).toEqual([]);
      conform(evs);
    }
  });

  it('a turn of several records is one request (HC-4): its first byte is watched, switched once, nothing written twice #HC-3 #HC-4', async () => {
    const { s, q, it, give, conform } = await open();
    give('t1', 'c1', 'c2', 'a');
    const ctx = (id: string, text: string) => ({ ...input(id, text), channelContext: { context: true } });
    await s.startTurn('t1', [ctx('c1', 'background'), ctx('c2', 'rules'), input('a', '2 + 2')]);
    q.push(sdk.init());
    const evs = await collectUntil(it, isFallback);
    expect(methods(q)).toEqual(['interrupt', 'setModel']);
    await q.waitWritten(2);
    expect(textOf(q.written[1]!)).toBe(WATCHDOG_CONTINUE);
    q.push(sdk.result({ uuids: [uuidOf(q, 0)], subtype: 'error_during_execution', terminal_reason: 'aborted_streaming' }));
    q.push(sdk.text('m1', '4'), sdk.result({ uuids: [uuidOf(q, 1)], result: '4' }));
    evs.push(...(await collectUntil(it, isTurnCompleted)));
    expect(q.written).toHaveLength(2);
    expect(bodies(evs, 'input.consumed')).toEqual([{ t: 'input.consumed', inputIds: ['c1', 'c2', 'a'], turnId: 't1' }]);
    conform(evs);
  });

  it('not after a side effect: a request after a tool result that sends nothing is waited on, never switched (the tool is not run twice) #HC-3', async () => {
    const { s, q, it, give, conform } = await open();
    give('t1', 'a');
    await s.startTurn('t1', [input('a', 'list the services')]);
    q.push(sdk.init(), sdk.toolUse('tu', 'Bash', { command: 'curl x' }), sdk.toolResult('tu', 'web, db'));
    await wait(MS * 4); // the next request hangs: not switched, as before
    expect(methods(q)).toEqual([]);
    expect(q.written).toHaveLength(1);
    q.push(sdk.text('m2', 'web and db'), sdk.result({ uuids: [uuidOf(q, 0)], result: 'web and db' }));
    const evs = await collectUntil(it, isTurnCompleted);
    expect(evs.filter(isFallback)).toEqual([]);
    conform(evs);
  });

  it('not while the CLI holds a late steer after its result: the CLI may be idle, a switch would answer twice #HC-3', async () => {
    const { s, q, it, give, conform } = await open();
    give('t1', 'a', 'b');
    await s.startTurn('t1', [input('a', 'start')]);
    q.push(sdk.init(), sdk.textDelta('ok'));
    expect(await s.steer([input('b', 'late')], 't1')).toBe('steered');
    await q.waitWritten(2);
    q.push(sdk.result({ uuids: [uuidOf(q, 0)], result: 'ok', queued_turn_count: 0 }));
    await wait(MS * 4); // b not acknowledged yet, nothing streams: not timed
    expect(methods(q)).toEqual([]);
    expect(q.written).toHaveLength(2);
    q.push(sdk.text('m2', 'got late'), sdk.result({ uuids: [uuidOf(q, 1)], result: 'got late' }));
    const evs = await collectUntil(it, isTurnCompleted);
    expect(bodies(evs, 'input.consumed').map((b) => b.inputIds)).toEqual([['a'], ['b']]);
    expect(evs.filter(isFallback)).toEqual([]);
    conform(evs);
  });

  it('at most once per turn: a fallback that hangs too is waited on, not switched again #HC-3', async () => {
    const { s, q, it } = await open();
    await s.startTurn('t1', [input('a', 'x')]);
    await collectUntil(it, isFallback);
    q.push(sdk.result({ uuids: [uuidOf(q, 0)], subtype: 'error_during_execution', terminal_reason: 'aborted_streaming' }));
    await wait(MS * 4);
    expect(methods(q)).toEqual(['interrupt', 'setModel']);
    expect(q.written).toHaveLength(2);
  });

  it('not when Claude Code already switched models in the turn (its own fallbackModel): one switch mechanism per turn #HC-3', async () => {
    const { s, q } = await open();
    await s.startTurn('t1', [input('a', 'x')]);
    q.push(sdk.system('model_fallback', { trigger: 'overloaded', original_model: 'haiku', fallback_model: 'claude-opus-5-5' }));
    await wait(MS * 4);
    expect(methods(q)).toEqual([]);
  });

  it('paused while the CLI compacts, counting again from zero after it; a harness command (/compact) is not watched #HC-3', async () => {
    const a = await open();
    await a.s.startTurn('t1', [input('a', 'x')]);
    a.q.push(sdk.system('status', { status: 'compacting' }));
    await wait(MS * 4);
    expect(methods(a.q)).toEqual([]);
    a.q.push(sdk.system('compact_boundary', { compact_metadata: { trigger: 'auto', pre_tokens: 100 } }));
    await collectUntil(a.it, isFallback);
    expect(methods(a.q)).toEqual(['interrupt', 'setModel']);

    const b = await open();
    await b.s.startTurn('t1', [input('c', '/compact', { channelContext: { nativeCommand: true } })]);
    await wait(MS * 4);
    expect(methods(b.q)).toEqual([]);
  });

  it('without a fallback model ([] in settings, none set, or only the turn\'s own model) it waits as before #HC-3', async () => {
    for (const fm of [[], NO_SETTINGS, ['haiku']]) {
      const { s, q } = await open(fm);
      await s.startTurn('t1', [input('a', 'x')]);
      await wait(MS * 4);
      expect(methods(q)).toEqual([]);
    }
  });

  it('an input the CLI had not started yet is withdrawn before it is sent again, so it never runs twice #HC-3', async () => {
    const { s, q, it, give, conform } = await open();
    give('t1', 'a');
    await s.startTurn('t1', [input('a', 'x')]);
    await q.waitWritten(1);
    q.cliQueue.add(uuidOf(q, 0)); // still in the CLI's queue (it was busy starting up)
    const evs = await collectUntil(it, isFallback);
    expect(methods(q)).toEqual(['interrupt', 'cancelAsyncMessage', 'setModel']);
    await q.waitWritten(2);
    q.push(sdk.textDelta('ok'), sdk.result({ uuids: [uuidOf(q, 1)], result: 'ok' }));
    evs.push(...(await collectUntil(it, isTurnCompleted)));
    expect(bodies(evs, 'input.consumed')).toEqual([{ t: 'input.consumed', inputIds: ['a'], turnId: 't1' }]);
    expect(bodies(evs, 'input.cancelled')).toEqual([]);
    conform(evs);
  });

  it('the host interrupting the turn turns the watchdog off; one interrupting while it switches ends the turn, nothing sent again #HC-3', async () => {
    const a = await open();
    await a.s.startTurn('t1', [input('a', 'x')]);
    a.q.cliQueue.add(uuidOf(a.q, 0));
    await a.s.interrupt('t1');
    await wait(MS * 4);
    expect(methods(a.q)).toEqual(['interrupt', 'cancelAsyncMessage']);

    const b = await open();
    b.give('t1', 'a');
    await b.s.startTurn('t1', [input('a', 'x')]);
    // The host stops the turn while the watchdog's interrupt is in flight.
    const slow = b.q.interrupt.bind(b.q);
    let release!: () => void;
    b.q.interrupt = async () => {
      const r = await slow();
      await new Promise<void>((ok) => (release = ok));
      return r;
    };
    await wait(MS * 2);
    b.q.interrupt = slow;
    const host = b.s.interrupt('t1');
    release();
    await host;
    b.q.push(sdk.result({ uuids: [uuidOf(b.q, 0)], subtype: 'error_during_execution', terminal_reason: 'aborted_streaming' }));
    const evs = await collectUntil(b.it, isTurnCompleted);
    expect(bodies(evs, 'turn.completed')).toEqual([expect.objectContaining({ status: 'interrupted' })]);
    expect(b.q.written).toHaveLength(1);
    expect(methods(b.q)).not.toContain('setModel');
    expect(evs.filter(isFallback)).toEqual([]);
    b.conform(evs);
  });

  it('an input is never in the history twice: what the attempt held gets one "go on", a steer the CLI still queued is withdrawn and written again after it #HC-3', async () => {
    const { s, q, it, give, conform } = await open();
    give('t1', 'a', 'b');
    await s.startTurn('t1', [input('a', 'x')]);
    expect(await s.steer([input('b', 'y')], 't1')).toBe('steered');
    q.cliQueue.add(uuidOf(q, 1)); // the steer waits in the CLI's queue; the attempt holds 'a'
    const evs = await collectUntil(it, isFallback);
    await q.waitWritten(4);
    expect(methods(q)).toEqual(['interrupt', 'cancelAsyncMessage', 'setModel']);
    expect(textOf(q.written[2]!)).toBe(WATCHDOG_CONTINUE);
    expect(q.written[3]!.message).toEqual(q.written[1]!.message);
    expect(q.written.filter((m) => textOf(m) === textOf(q.written[0]!))).toHaveLength(1);
    q.push(sdk.result({ uuids: [uuidOf(q, 0)], subtype: 'error_during_execution', terminal_reason: 'aborted_streaming' }));
    q.push(sdk.textDelta('ok'), sdk.result({ uuids: [uuidOf(q, 2), uuidOf(q, 3)], result: 'ok' }));
    evs.push(...(await collectUntil(it, isTurnCompleted)));
    expect(bodies(evs, 'input.consumed')).toEqual([
      { t: 'input.consumed', inputIds: ['a'], turnId: 't1' },
      { t: 'input.consumed', inputIds: ['b'], turnId: 't1' },
    ]);
    expect(bodies(evs, 'turn.completed')).toEqual([expect.objectContaining({ status: 'completed' })]);
    conform(evs);
  });

  it('a fallback whose model check fails (529, or it hangs too) is passed over for the next one in the chain #HC-3', async () => {
    const { s, q, it, give, conform } = await open(['claude-opus-5-5', 'gemini-3.8-flash-high']);
    refuseModels(q, ['claude-opus-5-5']);
    give('t1', 'a');
    await s.startTurn('t1', [input('a', 'x')]);
    const evs = await collectUntil(it, isFallback);
    expect(q.calls).toEqual([
      { method: 'interrupt' },
      { method: 'setModel', arg: 'claude-opus-5-5' },
      { method: 'setModel', arg: 'gemini-3.8-flash-high' },
    ]);
    expect(evs.at(-1)!.native).toMatchObject({ original_model: 'haiku', fallback_model: 'gemini-3.8-flash-high', trigger: 'first_byte_timeout' });
    await q.waitWritten(2);
    expect(textOf(q.written[1]!)).toBe(WATCHDOG_CONTINUE);
    q.push(sdk.result({ uuids: [uuidOf(q, 0)], subtype: 'error_during_execution', terminal_reason: 'aborted_streaming' }));
    q.push(sdk.textDelta('ok'), sdk.result({ uuids: [uuidOf(q, 1)], result: 'ok' }));
    evs.push(...(await collectUntil(it, isTurnCompleted)));
    expect(bodies(evs, 'turn.completed')).toEqual([expect.objectContaining({ status: 'completed' })]);
    conform(evs);
  });

  it('the chain used up: the turn fails at once with first_byte_timeout naming each refusal; never sent again on the model that hangs #HC-3', async () => {
    const { s, q, it, give, conform } = await open(['claude-opus-5-5', 'gemini-3.8-flash-high']);
    refuseModels(q, ['claude-opus-5-5', 'gemini-3.8-flash-high']);
    give('t1', 'a');
    await s.startTurn('t1', [input('a', 'x')]);
    const evs = await collectUntil(it, isTurnCompleted);
    expect(methods(q)).toEqual(['interrupt', 'setModel', 'setModel']);
    expect(q.written).toHaveLength(1);
    expect(evs.filter(isFallback)).toEqual([]);
    expect(bodies(evs, 'input.consumed')).toEqual([{ t: 'input.consumed', inputIds: ['a'], turnId: 't1' }]);
    const done = bodies(evs, 'turn.completed')[0]!;
    expect(done).toMatchObject({ status: 'failed', error: { code: 'first_byte_timeout', retryable: true } });
    expect(done.error!.message).toMatch(/haiku.*claude-opus-5-5.*gemini-3\.8-flash-high/);
    conform(evs);
    // The next turn starts on its own model, which is still current: no switch needed.
    give('t2', 'b');
    await s.startTurn('t2', [input('b', 'y')], run);
    expect(q.calls.filter((c) => c.method === 'setModel')).toHaveLength(2);
  });

  it('the host interrupting while the "go on" message still waits in the CLI withdraws it and ends the turn; nothing runs after #HC-3', async () => {
    const { s, q, it, give, conform } = await open();
    give('t1', 'a');
    await s.startTurn('t1', [input('a', 'x')]);
    const evs = await collectUntil(it, isFallback);
    await q.waitWritten(2);
    q.push(sdk.result({ uuids: [uuidOf(q, 0)], subtype: 'error_during_execution', terminal_reason: 'aborted_streaming' }));
    q.cliQueue.add(uuidOf(q, 1));
    await s.interrupt('t1');
    evs.push(...(await collectUntil(it, isTurnCompleted)));
    expect(q.calls.at(-1)).toEqual({ method: 'cancelAsyncMessage', arg: uuidOf(q, 1) });
    expect(bodies(evs, 'turn.completed')).toEqual([expect.objectContaining({ status: 'interrupted' })]);
    expect(bodies(evs, 'input.consumed')).toEqual([{ t: 'input.consumed', inputIds: ['a'], turnId: 't1' }]);
    expect(bodies(evs, 'input.cancelled')).toEqual([]);
    conform(evs);
  });

  it('a turn that stayed on the fallback (its own model failed the check) and hangs there skips both for the rest of the chain #HC-3', async () => {
    const { s, q, it, give } = await open(['claude-opus-5-5', 'gemini-3.8-flash-high']);
    give('t1', 'a');
    await s.startTurn('t1', [input('a', 'x')]);
    await collectUntil(it, isFallback);
    q.push(sdk.result({ uuids: [uuidOf(q, 0)], subtype: 'error_during_execution', terminal_reason: 'aborted_streaming' }));
    q.push(sdk.textDelta('ok'), sdk.result({ uuids: [uuidOf(q, 1)], result: 'ok' }));
    await collectUntil(it, isTurnCompleted);
    refuseModels(q, ['haiku']);
    give('t2', 'b');
    await s.startTurn('t2', [input('b', 'y')], run);
    await collectUntil(it, (e) => isFallback(e) && (e.native as { trigger?: string }).trigger === 'first_byte_timeout');
    expect(q.calls.filter((c) => c.method === 'setModel').map((c) => c.arg)).toEqual(['claude-opus-5-5', 'haiku', 'gemini-3.8-flash-high']);
  });

  it('a steer that comes while the watchdog switches models is held back (the idle CLI would run it on the model that hangs) and written after the "go on" on the new model #HC-3', async () => {
    const { s, q, it, give, conform } = await open(['claude-opus-5-5', 'gemini-3.8-flash-high']);
    const check = slowCheck(q, 'claude-opus-5-5', true); // fb-1 hangs too: its check fails after a while
    give('t1', 'a', 'b');
    await s.startTurn('t1', [input('a', 'x')]);
    q.push(sdk.init());
    await check.started;
    q.push(sdk.result({ uuids: [uuidOf(q, 0)], subtype: 'error_during_execution', terminal_reason: 'aborted_streaming' }));
    expect(await s.steer([input('b', 'y')], 't1')).toBe('steered');
    await wait(MS);
    expect(q.written).toHaveLength(1); // nothing reaches the CLI while it is still on the hung model
    check.release();
    const evs = await collectUntil(it, isFallback);
    expect(evs.at(-1)!.native).toMatchObject({ original_model: 'haiku', fallback_model: 'gemini-3.8-flash-high' });
    await q.waitWritten(3);
    expect(textOf(q.written[1]!)).toBe(WATCHDOG_CONTINUE);
    expect(textOf(q.written[2]!)).toContain('y');
    expect(methods(q)).toEqual(['interrupt', 'setModel', 'setModel']);
    q.push(sdk.textDelta('ok'), sdk.result({ uuids: [uuidOf(q, 1), uuidOf(q, 2)], result: 'ok' }));
    evs.push(...(await collectUntil(it, isTurnCompleted)));
    expect(bodies(evs, 'input.consumed')).toEqual([
      { t: 'input.consumed', inputIds: ['a'], turnId: 't1' },
      { t: 'input.consumed', inputIds: ['b'], turnId: 't1' },
    ]);
    expect(bodies(evs, 'turn.completed')).toEqual([expect.objectContaining({ status: 'completed' })]);
    conform(evs);
  });

  it('a steer held while switching: the chain used up leaves it unconsumed and unwritten (the lane re-queues it); a host interrupt cancels it #HC-3', async () => {
    const a = await open(['claude-opus-5-5', 'gemini-3.8-flash-high']);
    refuseModels(a.q, ['gemini-3.8-flash-high']);
    const ca = slowCheck(a.q, 'claude-opus-5-5', true);
    a.give('t1', 'a', 'b');
    await a.s.startTurn('t1', [input('a', 'x')]);
    a.q.push(sdk.init());
    await ca.started;
    expect(await a.s.steer([input('b', 'y')], 't1')).toBe('steered');
    ca.release();
    const ea = await collectUntil(a.it, isTurnCompleted);
    expect(bodies(ea, 'turn.completed')).toEqual([expect.objectContaining({ status: 'failed', error: expect.objectContaining({ code: 'first_byte_timeout' }) })]);
    expect(bodies(ea, 'input.consumed')).toEqual([{ t: 'input.consumed', inputIds: ['a'], turnId: 't1' }]);
    expect(bodies(ea, 'input.cancelled')).toEqual([]);
    expect(a.q.written).toHaveLength(1);
    a.conform(ea);

    const b = await open(['claude-opus-5-5', 'gemini-3.8-flash-high']);
    const cb = slowCheck(b.q, 'claude-opus-5-5', false);
    b.give('t1', 'a', 'b');
    await b.s.startTurn('t1', [input('a', 'x')]);
    b.q.push(sdk.init());
    await cb.started;
    expect(await b.s.steer([input('b', 'y')], 't1')).toBe('steered');
    const host = b.s.interrupt('t1');
    cb.release();
    await host;
    const eb = await collectUntil(b.it, isTurnCompleted);
    expect(bodies(eb, 'input.cancelled')).toEqual([{ t: 'input.cancelled', inputIds: ['b'], reason: 'interrupted' }]);
    expect(bodies(eb, 'turn.completed')).toEqual([expect.objectContaining({ status: 'interrupted' })]);
    expect(b.q.written).toHaveLength(1);
    b.conform(eb);
  });

  it('the host interrupting just as the fallback model is set: the turn ends, and the next turn still switches back to its own model (the CLI is on the fallback) #HC-3', async () => {
    const { s, q, it, give, conform } = await open();
    const check = slowCheck(q, 'claude-opus-5-5', false);
    give('t1', 'a');
    await s.startTurn('t1', [input('a', 'x')]);
    q.push(sdk.init());
    await check.started;
    q.push(sdk.result({ uuids: [uuidOf(q, 0)], subtype: 'error_during_execution', terminal_reason: 'aborted_streaming' }));
    const host = s.interrupt('t1');
    check.release(); // Claude Code is on claude-opus-5-5 from here on
    await host;
    const evs = await collectUntil(it, isTurnCompleted);
    expect(bodies(evs, 'turn.completed')).toEqual([expect.objectContaining({ status: 'interrupted' })]);
    expect(q.written).toHaveLength(1);
    conform(evs);
    give('t2', 'b');
    await s.startTurn('t2', [input('b', 'y')], run);
    expect(q.calls.filter((c) => c.method === 'setModel').map((c) => c.arg)).toEqual(['claude-opus-5-5', 'haiku']);
  });
});
