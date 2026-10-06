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
});
