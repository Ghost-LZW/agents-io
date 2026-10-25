import { describe, expect, it } from 'vitest';
import { bodies, collectUntil, input, isTurnCompleted, sdk } from './fake-query.js';
import { setup, uuidOf } from './claude-code-helpers.js';

// HC-6: what hosts record from Claude Code's own system events is a public event (audience
// `status`: the session layer logs it for participants, so a `full` subscriber gets it); the native
// passthrough stays `internal` (logged internal: a host's `full` subscription does not get it).

describe('public events from Claude Code system events', () => {
  it('system/init is session.ready with the turn id; system/model_fallback is model.fallback; both reach a full subscriber, the natives do not #HC-6', async () => {
    const { s, q, it, give, conform } = await setup({}, { firstByteTimeoutMs: 0, idleTimeoutMs: 0 });
    give('t1', 'a');
    await s.startTurn('t1', [input('a', 'hi')]);
    q.push(
      { ...sdk.init(), model: 'claude-opus-5-5' },
      sdk.system('model_fallback', { trigger: 'overloaded', original_model: 'claude-opus-5-5', fallback_model: 'claude-sonnet-5' }),
      sdk.text('m1', 'hello'),
      sdk.result({ uuids: [uuidOf(q, 0)], result: 'hello' }),
    );
    const evs = await collectUntil(it, isTurnCompleted);
    const ready = evs.filter((e) => e.body.t === 'session.ready');
    expect(ready).toEqual([expect.objectContaining({ turnId: 't1', body: expect.objectContaining({ t: 'session.ready', model: 'claude-opus-5-5' }) })]);
    expect(bodies(evs, 'model.fallback')).toEqual([
      { t: 'model.fallback', from: 'claude-opus-5-5', to: 'claude-sonnet-5', trigger: 'overloaded' },
    ]);
    expect(evs.find((e) => e.body.t === 'model.fallback')!.turnId).toBe('t1');
    for (const e of evs.filter((x) => x.body.t === 'session.ready' || x.body.t === 'model.fallback')) expect(e.audience).toBe('status');
    for (const e of evs.filter((x) => x.body.t === 'native')) expect(e.audience).toBe('internal');
    conform(evs);
  });

  it('the first-byte watchdog\'s own switch is model.fallback too (trigger first_byte_timeout, timeoutMs) #HC-6', async () => {
    const { s, q, it, give } = await setup({}, { firstByteTimeoutMs: 20, idleTimeoutMs: 0, firstByteFallbackModel: 'claude-sonnet-5' });
    give('t1', 'a');
    await s.startTurn('t1', [input('a', 'hi')]);
    const evs = await collectUntil(it, (e) => e.body.t === 'model.fallback');
    expect(evs.at(-1)!.body).toEqual({ t: 'model.fallback', from: 'haiku', to: 'claude-sonnet-5', trigger: 'first_byte_timeout', timeoutMs: 20 });
    expect(evs.at(-1)!.turnId).toBe('t1');
  });
});
