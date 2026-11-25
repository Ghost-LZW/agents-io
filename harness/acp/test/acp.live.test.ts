import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertConformingStream, runHarnessConformance } from '@agents-io/testkit';
import { AcpHarness } from '../src/index.js';
import { events, input } from './transcript-scenarios.js';

/*
 * Runs against a real ACP agent: AGENTS_IO_LIVE_ACP=1 and AIO_ACP_COMMAND (the program; its
 * arguments as a JSON array in AIO_ACP_ARGS), with the agent's own environment (its model and
 * credentials) in this process's. docs/E2E.md §1.6 has the recipe (Claude Code's ACP agent,
 * installed into a throwaway directory, on the test model).
 */
const live = process.env.AGENTS_IO_LIVE_ACP === '1' && !!process.env.AIO_ACP_COMMAND;
const agent = () => ({ command: process.env.AIO_ACP_COMMAND!, args: process.env.AIO_ACP_ARGS ? (JSON.parse(process.env.AIO_ACP_ARGS) as string[]) : [] });
const run = { harness: 'acp', model: '', profile: 'restricted' };

describe.skipIf(!live)('live ACP agent', () => {
  it('passes the harness conformance suite on a real agent: a turn, steer, session/cancel, close and a conforming stream #HC-1', async () => {
    const cwd = mkdtempSync(join(realpathSync(tmpdir()), 'agents-io-acp-'));
    const harness = new AcpHarness({ ...agent(), cwd, log: (level, msg) => level !== 'debug' && console.log(`acp ${level}: ${msg}`) });
    try {
      const report = await runHarnessConformance({
        adapter: harness,
        open: { sessionKey: 'live', generation: 1, cwd, run },
        turn: { turnId: 'LT1', inputs: [input('live-1', 'Reply with exactly the word: pong. Do not use any tool.')] },
        longTurn: { turnId: 'LT2', inputs: [input('live-2', 'Count from 1 to 400, one number per line, with no other text. Do not use any tool.')] },
        timeoutMs: 120_000,
      });
      console.log(`live acp ${harness.agent?.name} ${harness.agent?.version}`);
      expect(report.failed).toEqual([]);
    } finally {
      await harness.dispose();
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 300_000);

  it('resumes a session on a new agent process with session/load, and the agent remembers it #RS-1 #HC-1', async () => {
    const cwd = mkdtempSync(join(realpathSync(tmpdir()), 'agents-io-acp-'));
    const first = new AcpHarness({ ...agent(), cwd });
    const second = new AcpHarness({ ...agent(), cwd });
    try {
      expect((await first.probe()).caps.resume).toBe(true);
      const s = await first.open({ sessionKey: 'live', generation: 1, cwd, run });
      const ev = events(s);
      await s.startTurn('LT1', [input('live-1', 'Remember the word: kiwi. Reply with exactly: ok')], run);
      await ev.until((e) => e.body.t === 'turn.completed');
      const id = s.nativeId()!;
      await s.close('first process');
      await first.dispose();

      const s2 = await second.open({ sessionKey: 'live', generation: 2, cwd, run, resume: id });
      expect(s2.nativeId()).toBe(id);
      const ev2 = events(s2);
      await s2.startTurn('LT2', [input('live-2', 'Which word did I ask you to remember? Reply with just that word.')], run);
      await ev2.until((e) => e.body.t === 'turn.completed');
      await s2.close('done');
      await ev2.done;
      assertConformingStream(ev2.all, { turnInputs: { LT2: ['live-2'] } });
      expect(ev2.all.filter((e) => e.durability === 'durable').map((e) => e.body.t)[0]).toBe('session.bound');
      const final = ev2.all.find((e) => e.body.t === 'text.snapshot' && e.body.final);
      expect(final?.body).toMatchObject({ text: expect.stringMatching(/kiwi/i) });
    } finally {
      await first.dispose();
      await second.dispose();
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 300_000);
});
