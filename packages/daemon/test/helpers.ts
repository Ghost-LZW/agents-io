import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'vitest';
import type { HarnessAdapter, Policy } from '@agents-io/protocol';
import { FakeChannel, FakeHarness, type FakeTurnScript } from '@agents-io/testkit';
import { LocalClient } from '../src/client.js';
import { resolveConfig, type Config, type HarnessInstance } from '../src/config.js';
import { Gateway, InstanceHarness, type GatewayOptions } from '../src/gateway.js';
import { readTokenFile, tokenPath } from '../src/token.js';

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

export function tmp(prefix = 'aio-d-'): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

export interface World {
  gw: Gateway;
  dir: string;
  config: Config;
  chat: FakeChannel;
  harness: FakeHarness;
  /** Instances the daemon built (each run builds its own), with their env. */
  built: HarnessInstance[];
  client(): Promise<LocalClient>;
  /** A connection that said host.hello with the daemon's token. */
  host(o?: { name?: string; consumer?: string; callouts?: boolean | string[] }): Promise<LocalClient>;
  stop(): Promise<void>;
}

/**
 * A daemon over a SQLite log in `dir` (reuse `dir` to restart it), a FakeChannel `fake`
 * (owner fake:alice) and a FakeHarness behind every instance.
 */
export async function daemon(
  o: {
    raw?: Record<string, unknown>;
    script?: FakeTurnScript;
    dir?: string;
    policy?: Partial<Policy>;
    single?: boolean;
    /** Serve the console API (on a free port unless `raw.console.port` says otherwise); the config is written to `<dir>/aio.config.json` (0600) as its source. */
    console?: boolean;
    /** The env the console's config store and provisioning children see. */
    consoleEnv?: NodeJS.ProcessEnv;
    /** Build configured channels' adapters (GatewayOptions.channelAdapter). */
    channelAdapter?: GatewayOptions['channelAdapter'];
    /** GatewayOptions.channelStartGraceMs. */
    channelStartGraceMs?: number;
  } = {},
): Promise<World> {
  const dir = o.dir ?? tmp();
  mkdirSync(join(dir, 'work'), { recursive: true });
  const raw = { dataDir: dir, policy: { owners: ['fake:alice'] }, local: { principal: 'me' }, cwd: join(dir, 'work'), ...o.raw };
  if (o.console) {
    const c = (raw as { console?: Record<string, unknown> }).console;
    (raw as Record<string, unknown>).console = { port: 0, ...c };
  }
  const base = resolveConfig(raw, { env: {}, baseDir: dir, cwd: dir });
  const configPath = join(dir, 'aio.config.json');
  if (o.console && !o.dir) writeFileSync(configPath, JSON.stringify(raw, null, 2) + '\n', { mode: 0o600 });
  const config = { ...base, socketPath: join(dir, 'run', 'aio.sock'), ...(o.console ? { source: { path: configPath, envFile: join(dir, '.env.live') } } : {}) };
  const chat = new FakeChannel('fake');
  const harness = new FakeHarness(o.script);
  const built: HarnessInstance[] = [];
  const gw = await Gateway.start({
    config,
    ...(o.single ? { harness: harness as HarnessAdapter } : {
      buildHarness: (i: HarnessInstance) => {
        built.push(i);
        return new InstanceHarness(i, harness);
      },
    }),
    channels: [{ adapter: chat }],
    ...(o.policy ? { policy: o.policy } : {}),
    hostPush: { timeoutMs: 300, retryMs: 20 },
    logger: () => {},
    ...(o.console ? { console: true, consoleEnv: o.consoleEnv ?? {} } : {}),
    ...(o.channelAdapter ? { channelAdapter: o.channelAdapter } : {}),
    ...(o.channelStartGraceMs !== undefined ? { channelStartGraceMs: o.channelStartGraceMs } : {}),
  });
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    await gw.stop();
  };
  cleanups.push(stop);
  const client = async () => {
    const c = await LocalClient.connect(config.socketPath);
    cleanups.push(() => c.close());
    return c;
  };
  const host = async (h: { name?: string; consumer?: string; callouts?: boolean | string[] } = {}) => {
    const c = await client();
    await c.hello({ token: readTokenFile(tokenPath(config.socketPath)), name: h.name ?? 'xwo', ...(h.consumer !== undefined ? { consumer: h.consumer } : {}), ...(h.callouts ? { callouts: h.callouts } : {}) });
    return c;
  };
  return { gw, dir, config, chat, harness, built, client, host, stop };
}

/** Wait for `c` to be fully closed on the daemon side. */
export async function closeAndWait(gw: Gateway, c: LocalClient, wasHost = true): Promise<void> {
  c.close();
  if (wasHost) await until(() => gw.host.hostPeer() === undefined);
}

/** Node flags that let a fixture child run the workspace's TypeScript sources (no dist/ needed). */
export const SOURCE_LOADER = [
  '--experimental-transform-types',
  '--disable-warning=ExperimentalWarning',
  '--import',
  join(import.meta.dirname, '..', '..', '..', 'scripts', 'source-loader.mjs'),
];
