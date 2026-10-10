import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { HarnessOpenArgs, HarnessSession } from '@agents-io/protocol';
import { FakeChannel, FakeHarness } from '@agents-io/testkit';
import { LocalClient } from '../src/client.js';
import { resolveConfig } from '../src/config.js';
import { Gateway } from '../src/gateway.js';
import { tmp, until } from './helpers.js';

const HANGING_CHANNEL = fileURLToPath(new URL('./fixtures/chan-hangs.mjs', import.meta.url));

/** A harness whose turns never end (they ignore interrupts) and whose sessions never finish closing. */
class StuckHarness extends FakeHarness {
  constructor() {
    super(() => new Promise(() => {}));
  }
  override async open(args: HarnessOpenArgs): Promise<HarnessSession> {
    const s = await super.open(args);
    s.close = () => new Promise(() => {});
    s.interrupt = async () => {};
    return s;
  }
}

describe('gateway stop', () => {
  // The bounds (gateway.ts stop: lane close 8 s, whenIdle 3 s, compositors 5 s, channels 3 s + 3 s, …) are real timers: seconds, hence e2e.
  it('returns within its bounds when a harness close() and a channel close() never return #RS-8', async () => {
    const dir = tmp('aio-stop-');
    mkdirSync(join(dir, 'work'), { recursive: true });
    const config = {
      ...resolveConfig({ dataDir: dir, policy: { owners: ['fake:alice'] }, local: { principal: 'me' }, cwd: join(dir, 'work'), channels: [{ type: 'module', module: HANGING_CHANNEL, account: 'h' }] }, { env: {}, baseDir: dir, cwd: dir }),
      socketPath: join(dir, 'run', 'aio.sock'),
    };
    const harness = new StuckHarness();
    const gw = await Gateway.start({ config, harness, channels: [{ adapter: new FakeChannel('fake') }], logger: () => {} });
    const c = await LocalClient.connect(config.socketPath);
    await c.input('s', 'never ends');
    await until(() => harness.sessions.length === 1 && gw.sessions().find((x) => x.sessionKey === 's' && x.turnId));
    const t0 = Date.now();
    await gw.stop();
    const took = Date.now() - t0;
    c.close();
    // The sum of the bounds that can apply here is about 25 s; a hang would hit the test timeout.
    expect(took).toBeLessThan(35_000);
  }, 60_000);
});
