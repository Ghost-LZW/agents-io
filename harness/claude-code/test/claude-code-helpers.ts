import type { HarnessEvent, HarnessOpenArgs, RunSpec } from '@agents-io/protocol';
import { assertConformingStream } from '@agents-io/testkit';
import { ClaudeCodeHarness, type ClaudeCodeHarnessConfig } from '../src/index.js';
import type { ClaudeCodeOptions } from '../src/types.js';
import { fakeQueryFn, type FakeQuery } from './fake-query.js';

export const run: RunSpec = { harness: 'claude-code', model: 'haiku', profile: 'bypass' };

/** Opens a session on a fake SDK query; `it` reads its events, `conform` checks what was read. */
export async function setup(over: Partial<HarnessOpenArgs> = {}, options: ClaudeCodeOptions = {}, config: ClaudeCodeHarnessConfig = {}) {
  const fq = fakeQueryFn();
  const h = new ClaudeCodeHarness({
    ...config,
    query: fq.fn,
    claudePath: '/usr/local/bin/claude',
    sdkVersion: '0.3.291',
    cliVersion: async () => '2.1.291',
  });
  const s = await h.open({ sessionKey: 's', generation: 1, cwd: '/tmp/x', run, options: options as Record<string, unknown>, ...over });
  const q = fq.last();
  const raw = s.events[Symbol.asyncIterator]();
  const seen: HarnessEvent[] = [];
  const it: AsyncIterator<HarnessEvent> = {
    next: async () => {
      const r = await raw.next();
      if (!r.done) seen.push(r.value);
      return r;
    },
  };
  const turnInputs = new Map<string, string[]>();
  return {
    h,
    s,
    q,
    it,
    turnInputs,
    /** Tracks which inputs each turn was given, for conformance checks. */
    give(turnId: string, ...ids: string[]) {
      turnInputs.set(turnId, [...(turnInputs.get(turnId) ?? []), ...ids]);
    },
    /** Checks everything read so far (the argument only documents what the test looked at). */
    conform(_evs?: HarnessEvent[]) {
      assertConformingStream(seen, { turnInputs: (t) => turnInputs.get(t) });
    },
  };
}

export const uuidOf = (q: FakeQuery, i: number) => q.written[i]!.uuid!;
