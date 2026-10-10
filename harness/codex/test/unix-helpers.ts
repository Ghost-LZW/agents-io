import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'vitest';
import type { HarnessEvent, HarnessSession, InputRecord } from '@agents-io/protocol';
import { CodexHarness, type CodexHarnessOptions } from '../src/index.js';
import { FakeAppServer } from './fake-app-server.js';

export const input = (id: string, text = 'x'): InputRecord => ({
  inputId: id,
  origin: { kind: 'human', principal: { id: 'owner', labels: [] }, evidence: 'platform_signed', via: 'lark:a:c1', adapter: 'lark' },
  content: [{ type: 'text', text }],
  replyRoute: null,
  channelContext: {},
});
export const run = { harness: 'codex', model: 'gpt-5.5', profile: 'bypass' };
export const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

const dirs: string[] = [];
export const cleanups: (() => Promise<unknown> | unknown)[] = [];

/** Call once at the top of a test file: removes the dirs and runs the cleanups after each test. */
export function cleanupAfterEach() {
  afterEach(async () => {
    for (const c of cleanups.splice(0)) await c();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
}

/** Short private dir: sun_path is ~104 bytes on macOS. */
export function privDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'aio-'));
  chmodSync(d, 0o700);
  dirs.push(d);
  return d;
}

export async function fakeOnSocket() {
  const dir = privDir();
  const sock = join(dir, 's.sock');
  const fake = new FakeAppServer();
  await fake.listen(sock);
  chmodSync(sock, 0o600);
  cleanups.push(() => fake.stopListening());
  return { fake, dir, sock };
}

export function harnessFor(sock: string, stateDir: string, extra: Partial<CodexHarnessOptions> = {}) {
  const h = new CodexHarness({ transport: { kind: 'unix', spawn: 'none', path: sock, stateDir, reconnectWindowMs: 5000 }, ...extra });
  cleanups.push(() => h.dispose());
  return h;
}

export function collector(s: HarnessSession) {
  const events: HarnessEvent[] = [];
  const waiters: { pred: (e: HarnessEvent) => boolean; resolve: () => void }[] = [];
  const done = (async () => {
    for await (const e of s.events) {
      events.push(e);
      for (const w of [...waiters]) if (w.pred(e)) (waiters.splice(waiters.indexOf(w), 1), w.resolve());
    }
  })();
  return {
    events,
    done,
    until: (pred: (e: HarnessEvent) => boolean) =>
      events.some(pred) ? Promise.resolve() : new Promise<void>((resolve) => waiters.push({ pred, resolve })),
    of: <T extends HarnessEvent['body']['t']>(t: T) => events.filter((e) => e.body.t === t).map((e) => e.body as Extract<HarnessEvent['body'], { t: T }>),
  };
}
export const isCompleted = (e: HarnessEvent) => e.body.t === 'turn.completed';
export const cmdApproval = (th: string, tid: string) => ({
  kind: 'command', threadId: th, turnId: tid, itemId: 'c1', startedAtMs: 1, environmentId: 'local', command: 'rm -rf build', cwd: '/w', commandActions: [],
});
