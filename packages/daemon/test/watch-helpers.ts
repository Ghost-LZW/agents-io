import { join } from 'node:path';
import { FakeChannel, FakeHarness } from '@agents-io/testkit';
import { LocalClient } from '../src/client.js';
import { resolveConfig, type Config } from '../src/config.js';
import { Gateway } from '../src/gateway.js';
import { cleanups } from './helpers.js';

export const eve = { channelUserId: 'eve', evidence: 'platform_signed' as const };
export const group = { id: 'g1', kind: 'group' as const };

export function config(dir: string, raw: Record<string, unknown> = {}): Config {
  const base = resolveConfig({ policy: { owners: ['fake:alice'] }, local: { principal: 'me', session: 'main' }, logPath: join(dir, 'log.sqlite'), ...raw }, { env: {}, baseDir: dir, cwd: dir });
  return { ...base, socketPath: join(dir, 'run', 'aio.sock') };
}

export async function start(_dir: string, c: Config) {
  const chat = new FakeChannel('fake');
  const gw = await Gateway.start({ config: c, harness: new FakeHarness(), channels: [{ adapter: chat }], logger: () => {} });
  let stopped = false;
  const stop = async () => {
    if (!stopped) await gw.stop();
    stopped = true;
  };
  cleanups.push(stop);
  const client = await LocalClient.connect(c.socketPath);
  cleanups.push(() => client.close());
  return { gw, chat, client, stop };
}
