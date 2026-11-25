import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { HarnessAdapter, HarnessEvent } from '@agents-io/protocol';
import { TranscriptHarness, TranscriptRecorder, checkEventStream, formatTranscript, readTranscript, scrubTranscript } from '@agents-io/testkit';
import { spawnHarness } from '../src/index.js';
import { collect, disposeAll, fixture, here, input, loader, openArgs, track } from './bridge-helpers.js';

/*
 * Harness bridge transcripts (`aio.jsonl-harness`, docs/design/conformance-fixtures §2): the host's
 * `record` tap takes down a program's exchange; `aio-transcript-replay` plays it back as that
 * program over stdio, and testkit's `TranscriptHarness` in process (what the TS kernel scenario
 * runner uses). Both must be the same harness as the program was.
 */

afterEach(disposeAll);

const REPLAY = join(here, '..', '..', '..', 'packages', 'testkit', 'src', 'transcript-replay.ts');

/** One session, one turn, then close: the bodies of its events. */
async function drive(h: HarnessAdapter, cwd: string): Promise<HarnessEvent['body'][]> {
  const p = await h.probe();
  expect(p.caps).toMatchObject({ steer: 'none', interrupt: true });
  const s = await h.open(openArgs('s1', { cwd }));
  await s.startTurn('t1', [input('i1', 'hi')]);
  const events = await collect(s.events, (e) => e.body.t === 'turn.completed');
  expect(checkEventStream(events, { turnInputs: { t1: ['i1'] } })).toEqual([]);
  await s.close('done');
  return events.map((e) => e.body);
}

describe('harness bridge transcripts', () => {
  it("a program's exchange recorded at the host replays as that program, over stdio and in process: the host writes the same frames and gets the same events #HC-1", async () => {
    const cwd = mkdtempSync(join(realpathSync(tmpdir()), 'aio-bridge-rec-'));
    const out = mkdtempSync(join(tmpdir(), 'aio-bridge-transcript-'));
    try {
      const rec = new TranscriptRecorder({ provider: 'fake-program', protocol: 'aio.jsonl-harness', scenario: 'echo-turn' });
      const live = spawnHarness({ command: process.execPath, args: [...loader, fixture('fake_harness.mjs')], record: rec.tap });
      const bodies = await drive(live, cwd);
      expect(bodies.map((b) => b.t)).toEqual(['turn.started', 'session.bound', 'text.snapshot', 'input.consumed', 'turn.completed']);
      rec.version = (await live.probe()).version;
      await live.dispose();
      rec.exit('success');
      const t = scrubTranscript(rec.transcript(), { workspace: cwd });
      // What the host wrote, in order; the program's frames came as they came (events may pass a result).
      expect(t.entries.filter((e) => e.type === 'expect_outbound').map((e) => e.label)).toEqual(['probe', 'open', 'startTurn', 'close', 'shutdown']);
      expect(t.entries.slice(0, 4).map((e) => (e.type === 'runtime_exit' ? 'exit' : e.label))).toEqual(['probe', 'probe', 'open', 'open']);
      expect(t.entries.at(-1)).toEqual({ type: 'runtime_exit', status: 'success' });
      expect(t.entries[2]).toMatchObject({ type: 'expect_outbound', frame: { type: 'open', cwd: '<$workspace>' } });
      const file = join(out, 'echo-turn.ndjson');
      writeFileSync(file, formatTranscript(t));

      // Out of process: the replay is the program, for the real bridge host.
      const stderr: string[] = [];
      const replayed = track(spawnHarness({ command: process.execPath, args: [...loader, REPLAY, file], log: (_l, m, d) => (d as { stream?: string } | undefined)?.stream === 'stderr' && stderr.push(m) }));
      expect(await drive(replayed, cwd)).toEqual(bodies);
      await replayed.dispose();
      expect(stderr).toEqual([]);

      // In process: TranscriptHarness writes what the bridge host writes.
      const inProcess = new TranscriptHarness(readTranscript(file));
      expect(await drive(inProcess, cwd)).toEqual(bodies);
      await inProcess.dispose();
      await inProcess.replay.whenDone();
      expect([inProcess.replay.error, inProcess.replay.done]).toEqual([undefined, true]);

      // A host that writes something else is told where: the replay stops and the request fails.
      const other = new TranscriptHarness(readTranscript(file));
      await other.probe();
      await expect(other.open(openArgs('s2', { cwd }))).rejects.toMatchObject({ code: 'peer_closed' });
      expect(other.replay.error).toMatchObject({ kind: 'mismatch', line: 4, label: 'open', message: expect.stringContaining('sessionKey: expected "s1", got "s2"') });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(out, { recursive: true, force: true });
    }
  });
});
