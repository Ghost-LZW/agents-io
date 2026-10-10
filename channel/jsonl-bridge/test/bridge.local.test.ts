import { mkdtempSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeChannel } from '@agents-io/testkit';
import { connectChannel, serveChannel } from '../src/index.js';
import { closeAll, route, run, track } from './bridge-helpers.js';

afterEach(closeAll);

describe('connectChannel', () => {
  let server: Server | undefined;
  afterEach(() => void server?.close());

  it('talks to an adapter served over a unix socket', async () => {
    const fake = new FakeChannel('sock');
    const path = join(mkdtempSync(join(tmpdir(), 'bridge-')), 's.sock');
    server = createServer((s) => void serveChannel(fake, { input: s, output: s }));
    await new Promise<void>((r) => server!.listen(path, r));
    const ch = await track(connectChannel({ path, account: 'default' }));
    const r = run(ch);
    await r.until(() => (fake as any).ctx !== undefined);
    await fake.inject({ text: 'over socket' });
    await r.until(() => r.inbound.length === 1);
    expect((await ch.send({ ...route, channel: 'sock' }, { text: 'x' }, { operationId: 'o' })).providerMessageId).toBe('m1');
    await r.stop();
  });
});
