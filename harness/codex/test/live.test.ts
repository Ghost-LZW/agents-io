import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { HarnessEvent, InputRecord } from '@agents-io/protocol';
import { assertConformingStream } from '@agents-io/testkit';
import { CodexHarness } from '../src/index.js';

/** Runs against the real `codex app-server` (needs a logged-in codex). AGENTS_IO_LIVE_CODEX=1 to enable. */
const live = process.env.AGENTS_IO_LIVE_CODEX === '1';

describe.skipIf(!live)('live codex app-server', () => {
  it('runs one turn with a no-approval profile and emits a conforming stream', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'agents-io-codex-'));
    const harness = new CodexHarness({ bin: process.env.CODEX_BIN ?? 'codex' });
    try {
      const { version, caps } = await harness.probe();
      expect(version).toMatch(/^0\.160\./);
      expect(caps.steer).toBe('native');

      const s = await harness.open({
        sessionKey: 'live',
        generation: 1,
        cwd,
        run: { harness: 'codex', model: process.env.CODEX_MODEL ?? '', profile: 'bypass' },
        options: { ephemeral: true },
      });
      expect(s.nativeId()).toBeTruthy();
      const input: InputRecord = {
        inputId: 'live-1',
        origin: { kind: 'human', principal: { id: 'owner', labels: [] }, evidence: 'device_only', via: 'test:a:c', adapter: 'test' },
        content: [{ type: 'text', text: 'Reply with exactly the word: pong' }],
        replyRoute: null,
        channelContext: {},
      };
      const events: HarnessEvent[] = [];
      const done = (async () => {
        for await (const e of s.events) {
          events.push(e);
          if (e.body.t === 'turn.completed') return;
        }
      })();
      await s.startTurn('LT1', [input]);
      await done;
      await s.close('test done');

      assertConformingStream(events, { turnInputs: { LT1: ['live-1'] } });
      const completed = events.find((e) => e.body.t === 'turn.completed')!.body;
      expect(completed).toMatchObject({ status: 'completed' });
      expect(events.some((e) => e.body.t === 'input.consumed')).toBe(true);
      const final = events.find((e) => e.body.t === 'text.snapshot' && e.body.final);
      expect(final?.body).toMatchObject({ text: expect.stringMatching(/pong/i) });
    } finally {
      await harness.dispose();
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 180_000);

  /** Host restart over unix: the turn keeps running in the detached app-server and the new host sees it finish. */
  it('survives a host restart mid-turn over a unix socket (spawn: own)', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'aio-cwd-'));
    const stateDir = mkdtempSync(join(tmpdir(), 'aio-st-'));
    const opts = { bin: process.env.CODEX_BIN ?? 'codex', transport: { kind: 'unix' as const, spawn: 'own' as const, stateDir } };
    const a = new CodexHarness(opts);
    let b: CodexHarness | undefined;
    try {
      const s1 = await a.open({ sessionKey: 'live-unix', generation: 1, cwd, run: { harness: 'codex', model: process.env.CODEX_MODEL ?? '', profile: 'bypass' } });
      const thread = s1.nativeId()!;
      const first: HarnessEvent[] = [];
      const firstDone = (async () => {
        for await (const e of s1.events) first.push(e);
      })();
      const prompt: InputRecord = {
        inputId: 'live-u1',
        origin: { kind: 'human', principal: { id: 'owner', labels: [] }, evidence: 'device_only', via: 'test:a:c', adapter: 'test' },
        content: [{ type: 'text', text: 'Count from 1 to 60, one number per line, then write the word: finished' }],
        replyRoute: null,
        channelContext: {},
      };
      await s1.startTurn('LU1', [prompt]);
      // Wait until Codex is visibly working, then drop the host mid-turn.
      for (let i = 0; i < 600 && !first.some((e) => e.body.t === 'input.consumed'); i++) await new Promise((r) => setTimeout(r, 100));
      expect(first.some((e) => e.body.t === 'turn.completed')).toBe(false);
      await a.detach();
      await firstDone;

      b = new CodexHarness(opts);
      const s2 = await b.open({ sessionKey: 'live-unix', generation: 2, cwd, run: { harness: 'codex', model: process.env.CODEX_MODEL ?? '', profile: 'bypass' }, resume: thread });
      const second: HarnessEvent[] = [];
      for await (const e of s2.events) {
        second.push(e);
        if (e.body.t === 'turn.completed') break;
      }
      const done = second.find((e) => e.body.t === 'turn.completed')!.body;
      expect(done).toMatchObject({ turnId: 'LU1', status: 'completed' });
      const final = second.find((e) => e.body.t === 'text.snapshot' && e.body.final);
      expect(final?.body).toMatchObject({ text: expect.stringMatching(/finished/i) });
      assertConformingStream([...first, ...second], { turnInputs: { LU1: ['live-u1'] } });
    } finally {
      await (b ?? a).shutdownOwnServer();
      rmSync(cwd, { recursive: true, force: true });
      rmSync(stateDir, { recursive: true, force: true });
    }
  }, 240_000);
});
