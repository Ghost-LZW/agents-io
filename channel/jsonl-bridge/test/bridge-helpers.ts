import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ChannelAdapter, InboundEnvelope } from '@agents-io/protocol';
import { spawnChannel, type BridgedChannel } from '../src/index.js';

export const here = dirname(fileURLToPath(import.meta.url));
const fixture = (n: string) => join(here, 'fixtures', n);
export const route = { channel: 'fake-child', account: 'default', conversationId: 'c1' };
export const hasPython = spawnSync('python3', ['--version']).status === 0;

// Fixtures run under plain node on the TypeScript sources (no dist/ needed).
const loader = ['--experimental-transform-types', '--disable-warning=ExperimentalWarning', '--import', join(here, '..', '..', '..', 'scripts', 'source-loader.mjs')];

/** Starts the adapter and collects what it emits; `stop` aborts and waits for start to return. */
export function run(adapter: ChannelAdapter, account = 'default') {
  const ctl = new AbortController();
  const inbound: InboundEnvelope[] = [];
  const logs: string[] = [];
  const waiters: (() => void)[] = [];
  const started = adapter.start({
    account,
    config: undefined,
    signal: ctl.signal,
    emit: async (env) => {
      inbound.push(env);
      waiters.splice(0).forEach((w) => w());
      return { accepted: true, inputId: `in-${inbound.length}` };
    },
    log: (level, msg) => logs.push(`${level}: ${msg}`),
  });
  const until = async (pred: () => boolean, ms = 5000) => {
    const deadline = Date.now() + ms;
    while (!pred()) {
      if (Date.now() > deadline) throw new Error(`timed out; inbound=${inbound.length} logs=${logs.join(' | ')}`);
      await new Promise<void>((r) => {
        waiters.push(r);
        setTimeout(r, 25);
      });
    }
  };
  return { inbound, logs, until, stop: async () => (ctl.abort(), await started) };
}

let open: BridgedChannel[] = [];
/** Closes every channel opened through `track`; call it from `afterEach`. */
export async function closeAll() {
  await Promise.all(open.map((c) => c.close()));
  open = [];
}
export const track = async (p: Promise<BridgedChannel>) => {
  const c = await p;
  open.push(c);
  return c;
};
export const fakeChild = (env: Record<string, string> = {}, extra = {}) =>
  track(spawnChannel({ command: process.execPath, args: [...loader, fixture('fake_child.mjs')], env, account: 'default', ...extra }));
export const rawChild = (mode: string, extra = {}, env: Record<string, string> = {}) =>
  track(spawnChannel({ command: process.execPath, args: [...loader, fixture('raw_child.mjs')], env: { MODE: mode, ...env }, account: 'default', ...extra }));

/** A file the raw child appends its pid to on every launch. */
export function pidLog() {
  const file = join(mkdtempSync(join(tmpdir(), 'bridge-')), 'pids');
  const pids = () => (existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(Number) : []);
  return { file, pids };
}
export const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
export const waitFor = async (pred: () => boolean, ms = 5000) => {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 20));
  }
};
