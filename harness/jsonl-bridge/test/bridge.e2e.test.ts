import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runHarnessConformance } from '@agents-io/testkit';
import { spawnHarness } from '../src/index.js';
import { collect, disposeAll, hasPython, here, input, openArgs, track } from './bridge-helpers.js';

afterEach(disposeAll);

describe.skipIf(!hasPython)('a harness in Python (examples/echo_harness.py)', () => {
  it('passes the same harness conformance suite over the bridge, declares what it says in its hello, and answers its compaction command #HC-1', async () => {
    const h = track(spawnHarness({ command: 'python3', args: [join(here, '..', 'examples', 'echo_harness.py')] }));
    const report = await runHarnessConformance({ adapter: h, open: openArgs() });
    expect(report.failed).toEqual([]);
    expect(report.passed).toEqual(['probe.schema', 'declares.schema', 'methods.functions', 'open', 'turn.completes', 'steer.result', 'interrupt.ends_turn (skipped)', 'close.ends_stream', 'stream.conforms']);
    expect({ displayName: h.displayName, compact: h.compact, detach: h.detach }).toEqual({ displayName: 'Echo (Python)', compact: { command: '/compact' }, detach: undefined });

    const s = await h.open(openArgs('k2'));
    expect(s.nativeId()).toBe('py-k2');
    await s.startTurn('t1', [input('i1', '/compact', { channelContext: { nativeCommand: true } })]);
    const evs = await collect(s.events, (e) => e.body.t === 'turn.completed');
    expect(evs.find((e) => e.body.t === 'text.snapshot')?.body).toMatchObject({ text: 'compacted' });
  });
});
