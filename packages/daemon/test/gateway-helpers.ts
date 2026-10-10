import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'vitest';
import type { Policy, SessionEvent } from '@agents-io/protocol';
import { MemorySessionLog } from '@agents-io/session';
import { FakeChannel, FakeHarness, type FakeTurnScript } from '@agents-io/testkit';
import { LocalClient } from '../src/client.js';
import { resolveConfig } from '../src/config.js';
import { Gateway } from '../src/gateway.js';

export const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

export async function until<T>(get: () => T | undefined | false, ms = 3000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = get();
    if (v !== undefined && v !== false) return v;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** A gateway over an in-memory log, a FakeChannel `fake` (owner fake:alice) and a FakeHarness. */
export async function setup(o: { script?: FakeTurnScript; policy?: Partial<Policy> } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'aio-gw-'));
  const base = resolveConfig({ policy: { owners: ['fake:alice'] }, local: { principal: 'me' } }, { env: {}, baseDir: dir, cwd: dir });
  const config = { ...base, socketPath: join(dir, 'run', 'aio.sock') };
  const chat = new FakeChannel('fake');
  const harness = new FakeHarness(o.script);
  const gw = await Gateway.start({ config, harness, log: new MemorySessionLog(), channels: [{ adapter: chat }], ...(o.policy ? { policy: o.policy } : {}), logger: () => {} });
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  cleanups.push(() => gw.stop());
  const client = async () => {
    const c = await LocalClient.connect(config.socketPath);
    cleanups.push(() => c.close());
    return c;
  };
  const collect = async (c: LocalClient, sessionKey: string, tier: 'full' | 'final' = 'full') => {
    const events: SessionEvent[] = [];
    const sub = await c.subscribe({ sessionKey, tier, fromSeq: 0 });
    void (async () => {
      for await (const e of sub) events.push(e);
    })();
    return events;
  };
  return { gw, chat, harness, config, client, collect, dir };
}
