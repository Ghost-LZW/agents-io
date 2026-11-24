import { describe, expect, it } from 'vitest';
import { PrefaceMemo, type HarnessSession, type InputRecord } from '@agents-io/protocol';
import { assertConformingStream } from '@agents-io/testkit';
import { Hub, Lane, MemorySessionLog, defaultPolicy } from '@agents-io/session';
import { UnsupportedCodexVersionError, renderInputs } from '../src/index.js';
import { FakeAppServer, FakeRpcError } from './fake-app-server.js';
import { collector, input, isCompleted, open, run, setup, tick } from './codex-helpers.js';

// Moved from codex.test.ts: feature-path tests with no promise in docs/INVARIANTS.md (decision 14: local tier).

describe('collaboration-mode', () => {
  it('sends Plan and Default collaboration modes on successive turns', async () => {
    const { fake, harness } = setup();
    const s = await open(harness);
    const c = collector(s);
    fake.onTurnStart = (p, tid) => {
      fake.echoUser(p.threadId, tid, p.clientUserMessageId);
      fake.completeTurn(p.threadId, tid, 'completed');
    };
    await s.startTurn('T1', [input('i1', 'plan')], { ...run, mode: 'plan' });
    await c.until((e) => isCompleted(e) && e.turnId === 'T1');
    await s.startTurn('T2', [input('i2', 'execute')], { ...run, mode: 'default' });
    await c.until((e) => isCompleted(e) && e.turnId === 'T2');
    expect(fake.sent('turn/start').map((m) => m.params.collaborationMode)).toEqual([
      { mode: 'plan', settings: { model: run.model, reasoning_effort: run.effort, developer_instructions: null } },
      { mode: 'default', settings: { model: run.model, reasoning_effort: run.effort, developer_instructions: null } },
    ]);
  });

  it('uses the resolved thread model for Plan when the configured model is empty', async () => {
    const { fake, harness } = setup();
    const s = await open(harness, { run: { ...run, model: '' } });
    const c = collector(s);
    fake.onTurnStart = (p, tid) => {
      fake.echoUser(p.threadId, tid, p.clientUserMessageId);
      fake.completeTurn(p.threadId, tid, 'completed');
    };
    await s.startTurn('T1', [input('i1', 'plan')], { ...run, model: '', mode: 'plan' });
    await c.until(isCompleted);
    expect(fake.sent('turn/start')[0]!.params.collaborationMode.settings.model).toBe('gpt-default');
  });
});
