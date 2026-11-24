import { existsSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HarnessEvent, HarnessOpenArgs, HarnessSession, InputRecord } from '@agents-io/protocol';
import { AcpHarness, type AcpHarnessOptions } from '../src/index.js';

export const here = dirname(fileURLToPath(import.meta.url));
export const root = join(here, '..', '..', '..');
/** Node running a fixture on the TypeScript sources (no dist/ needed). */
export const loader = ['--experimental-transform-types', '--disable-warning=ExperimentalWarning', '--import', join(root, 'scripts', 'source-loader.mjs')];
export const FAKE_AGENT = join(here, 'fake-agent.ts');

export const tmp = (prefix = 'aio-acp-') => mkdtempSync(join(realpathSync(tmpdir()), prefix));

let made: AcpHarness[] = [];
/** Disposes every adapter made through `fake`; call it from `afterEach`. */
export async function disposeAll() {
  await Promise.all(made.map((h) => h.dispose()));
  made = [];
}

/** An adapter on the fake agent (fake-agent.ts) with `env`; `log` is the file the agent records its calls in. */
export function fake(env: Record<string, string> = {}, extra: Partial<AcpHarnessOptions> = {}) {
  const dir = tmp();
  const log = join(dir, 'agent.jsonl');
  const logs: string[] = [];
  const h = new AcpHarness({
    command: process.execPath,
    args: [...loader, FAKE_AGENT],
    env: { FAKE_ACP_LOG: log, FAKE_ACP_STATE: join(dir, 'state'), ...env },
    log: (l, m) => logs.push(`${l}: ${m}`),
    cancelTimeoutMs: 5_000,
    ...extra,
  });
  made.push(h);
  return { h, dir, log, logs, calls: () => calls(log) };
}

/** What the fake agent recorded, in order (`{ call, … }`). */
export function calls(log: string): Record<string, any>[] {
  return existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
}

export const run = { harness: 'acp', model: '', profile: 'restricted' };
export const openArgs = (extra: Partial<HarnessOpenArgs> = {}): HarnessOpenArgs => ({ sessionKey: 's1', generation: 1, cwd: tmpdir(), run, ...extra });
export const input = (inputId: string, text: string, extra: Partial<InputRecord> = {}): InputRecord => ({
  inputId,
  origin: { kind: 'human', principal: { id: 'owner', labels: [] }, evidence: 'platform_signed', via: 'test:default:c1', adapter: 'test' },
  content: [{ type: 'text', text }],
  replyRoute: null,
  channelContext: {},
  ...extra,
});

/** A session's events as they come, and a wait for the first one that matches. */
export function events(s: HarnessSession) {
  const all: HarnessEvent[] = [];
  const waiters: { pred: (e: HarnessEvent) => boolean; resolve: (e: HarnessEvent) => void }[] = [];
  const done = (async () => {
    for await (const e of s.events) {
      all.push(e);
      for (const w of [...waiters]) if (w.pred(e)) (waiters.splice(waiters.indexOf(w), 1), w.resolve(e));
    }
  })();
  return {
    all,
    done,
    of: <T extends HarnessEvent['body']['t']>(t: T) => all.flatMap((e) => (e.body.t === t ? [e.body as Extract<HarnessEvent['body'], { t: T }>] : [])),
    until(pred: (e: HarnessEvent) => boolean, ms = 10_000): Promise<HarnessEvent> {
      const hit = all.find(pred);
      if (hit) return Promise.resolve(hit);
      return new Promise((resolve, reject) => {
        const w = { pred, resolve };
        waiters.push(w);
        setTimeout(() => {
          if (!waiters.includes(w)) return;
          waiters.splice(waiters.indexOf(w), 1);
          reject(new Error(`no matching event within ${ms}ms; got ${all.map((e) => e.body.t).join(', ')}`));
        }, ms).unref();
      });
    },
  };
}

export const completed = (turnId?: string) => (e: HarnessEvent) => e.body.t === 'turn.completed' && (turnId === undefined || e.body.turnId === turnId);
