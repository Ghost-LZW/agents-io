import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'vitest';
import type { LocalClient } from '../src/client.js';
import type { Gateway } from '../src/gateway.js';

/*
 * What the kernel's own tests share. They import the kernel only (`../src/`), never
 * `@agents-io/daemon` or a module package: the kernel runs without them.
 */

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

export function tmp(prefix = 'aio-k-'): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

/** Wait for `c` to be fully closed on the daemon side. */
export async function closeAndWait(gw: Gateway, c: LocalClient, wasHost = true): Promise<void> {
  c.close();
  if (wasHost) await until(() => gw.host.hostPeer() === undefined);
}
