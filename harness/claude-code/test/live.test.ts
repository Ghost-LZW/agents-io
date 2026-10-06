import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkEventStream } from '@agents-io/testkit';
import type { HarnessEvent } from '@agents-io/protocol';
import { ClaudeCodeHarness } from '../src/index.js';
import { loadEnvFile } from './env-file.js';
import { input } from './fake-query.js';

/**
 * Optional gitignored `<repo>/.env.live`: KEY=VALUE lines handed to the CLI via
 * `options.env` (e.g. ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN for a gateway).
 * Values are never printed.
 */
const fileEnv = loadEnvFile(new URL('../../../.env.live', import.meta.url));
const setting = (k: string) => process.env[k] ?? fileEnv[k];
const live = setting('AGENTS_IO_LIVE_CLAUDE') === '1';
const model = setting('AGENTS_IO_LIVE_CLAUDE_MODEL') ?? 'haiku';
const options = (extra: Record<string, unknown> = {}) => ({ env: fileEnv, ...extra });

/** Runs the real local `claude` CLI. Costs a few cents; opt in with AGENTS_IO_LIVE_CLAUDE=1. */
describe.skipIf(!live)('live Claude Code', () => {
  it(
    'one cheap turn produces a conforming stream',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'agents-io-cc-'));
      const h = new ClaudeCodeHarness();
      const probe = await h.probe();
      const s = await h.open({ sessionKey: 'live', generation: 1, cwd: dir, run: { harness: 'claude-code', model, profile: 'bypass' }, options: options() });
      const evs: HarnessEvent[] = [];
      try {
        await s.startTurn('t1', [
          input('live-input-1', 'Run the shell command `echo agents-io` with the Bash tool, then reply with exactly one word: pong'),
        ]);
        for await (const e of s.events) {
          evs.push(e);
          if (e.body.t === 'turn.completed') break;
        }
      } finally {
        await s.close('test done');
        rmSync(dir, { recursive: true, force: true });
      }
      const types = evs.map((e) => e.body.t);
      console.log(`[live] ${probe.version}; .env.live keys: ${Object.keys(fileEnv).length}; native id ${s.nativeId()}; ${evs.length} events: ${[...new Set(types)].join(', ')}`);
      expect(checkEventStream(evs, { turnInputs: { t1: ['live-input-1'] } })).toEqual([]);
      const done = evs.find((e) => e.body.t === 'turn.completed')!.body;
      expect(done).toMatchObject({ t: 'turn.completed', turnId: 't1', status: 'completed' });
      expect(evs.find((e) => e.body.t === 'input.consumed')?.body).toEqual({ t: 'input.consumed', inputIds: ['live-input-1'], turnId: 't1' });
      expect(types).toContain('text.delta');
      const final = evs.filter((e) => e.body.t === 'text.snapshot' && e.body.final).at(-1)?.body as { text: string } | undefined;
      expect(final?.text.toLowerCase()).toContain('pong');
      const bash = evs.find((e) => e.body.t === 'item.completed' && e.body.item.type === 'command');
      if (bash) expect((bash.body as { item: { result?: { preview: string } } }).item.result?.preview).toContain('agents-io');
      expect(s.nativeId()).toMatch(/^[0-9a-f-]{36}$/);
    },
    180_000,
  );

  it(
    'a default-mode turn routes Bash through request.opened and respond()',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'agents-io-cc-'));
      const h = new ClaudeCodeHarness();
      const s = await h.open({
        sessionKey: 'live2',
        generation: 1,
        cwd: dir,
        run: { harness: 'claude-code', model, profile: 'ask' },
        options: options({ sdk: { settingSources: [] } }),
      });
      const evs: HarnessEvent[] = [];
      try {
        await s.startTurn('t1', [input('live-input-2', 'Use the Bash tool to run `mkdir approved-dir && ls`, then reply with exactly one word: done')]);
        for await (const e of s.events) {
          evs.push(e);
          if (e.body.t === 'request.opened') await s.respond(e.body.requestId, { kind: 'allow_once' });
          if (e.body.t === 'turn.completed') break;
        }
      } finally {
        await s.close('test done');
        rmSync(dir, { recursive: true, force: true });
      }
      console.log(`[live2] ${evs.length} events: ${[...new Set(evs.map((e) => e.body.t))].join(', ')}`);
      expect(checkEventStream(evs, { turnInputs: { t1: ['live-input-2'] } })).toEqual([]);
      const opened = evs.find((e) => e.body.t === 'request.opened');
      expect(opened?.body).toMatchObject({ kind: 'tool_approval', risk: { writes: true } });
      expect(evs.find((e) => e.body.t === 'request.resolved')?.body).toMatchObject({ decision: { kind: 'allow_once' } });
      const bash = evs.find((e) => e.body.t === 'item.completed' && e.body.item.type === 'command');
      expect((bash?.body as { item: { status: string; result?: { preview: string } } }).item).toMatchObject({ status: 'completed' });
      expect(evs.find((e) => e.body.t === 'turn.completed')?.body).toMatchObject({ status: 'completed' });
    },
    180_000,
  );
});
