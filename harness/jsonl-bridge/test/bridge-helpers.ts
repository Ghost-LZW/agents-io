import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HarnessEvent, HarnessOpenArgs, InputRecord } from '@agents-io/protocol';
import { spawnHarness, type BridgedHarness, type HarnessBridgeOptions } from '../src/index.js';

export const here = dirname(fileURLToPath(import.meta.url));
export const fixture = (n: string) => join(here, 'fixtures', n);
export const hasPython = spawnSync('python3', ['--version']).status === 0;

/** Node running a fixture on the TypeScript sources (no dist/ needed). */
export const loader = ['--experimental-transform-types', '--disable-warning=ExperimentalWarning', '--import', join(here, '..', '..', '..', 'scripts', 'source-loader.mjs')];

let open: BridgedHarness[] = [];
/** Disposes every harness made through `track`; call it from `afterEach`. */
export async function disposeAll() {
  await Promise.all(open.map((h) => h.dispose()));
  open = [];
}
export const track = (h: BridgedHarness) => (open.push(h), h);

/** A temp file for a fixture to write to (`RECORD`, `STATE`, `LAUNCHES`). */
export const tmpFile = (name: string) => join(mkdtempSync(join(tmpdir(), 'hbridge-')), name);

/** The `serveHarness(FakeHarness)` program (fixtures/fake_harness.mjs) with `env`; `record` is its RECORD file. */
export function fakeProgram(env: Record<string, string> = {}, extra: Partial<HarnessBridgeOptions> = {}) {
  const record = tmpFile('record.jsonl');
  const logs: string[] = [];
  const h = track(spawnHarness({ command: process.execPath, args: [...loader, fixture('fake_harness.mjs')], env: { RECORD: record, ...env }, log: (l, m) => logs.push(`${l}: ${m}`), ...extra }));
  return { h, record, logs, calls: () => calls(record) };
}

/** The hand-written program (fixtures/raw_harness.mjs) with `env`. */
export function rawProgram(env: Record<string, string> = {}, extra: Partial<HarnessBridgeOptions> = {}) {
  const logs: string[] = [];
  const h = track(spawnHarness({ command: process.execPath, args: [fixture('raw_harness.mjs')], env, log: (l, m) => logs.push(`${l}: ${m}`), ...extra }));
  return { h, logs };
}

/** What a fixture recorded, in order (`{ call, … }`). */
export function calls(record: string): Record<string, any>[] {
  return existsSync(record) ? readFileSync(record, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
}

export const run = { harness: 'bridge', model: 'm', profile: 'restricted' };
export const openArgs = (sessionKey = 's1', extra: Partial<HarnessOpenArgs> = {}): HarnessOpenArgs => ({ sessionKey, generation: 1, cwd: tmpdir(), run, ...extra });
export const input = (inputId: string, text: string, extra: Partial<InputRecord> = {}): InputRecord => ({
  inputId,
  origin: { kind: 'human', principal: null, evidence: 'none', via: 'test', adapter: 'test' },
  content: [{ type: 'text', text }],
  replyRoute: null,
  channelContext: {},
  ...extra,
});

/** Collect a session's events until `stop` matches one (or the stream ends). */
export async function collect(events: AsyncIterable<HarnessEvent>, stop: (e: HarnessEvent) => boolean, ms = 5000): Promise<HarnessEvent[]> {
  const out: HarnessEvent[] = [];
  const done = (async () => {
    for await (const e of events) {
      out.push(e);
      if (stop(e)) return;
    }
  })();
  await Promise.race([done, new Promise((_, reject) => setTimeout(() => reject(new Error(`timed out; got ${out.map((e) => e.body.t).join(', ')}`)), ms))]);
  return out;
}

export const waitFor = async (pred: () => boolean, ms = 5000) => {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 20));
  }
};

export const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
