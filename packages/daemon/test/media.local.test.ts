import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ChannelContext, InputRecord } from '@agents-io/protocol';
import { MemorySessionLog } from '@agents-io/session';
import { FakeChannel, FakeHarness } from '@agents-io/testkit';
import { resolveConfig } from '../src/config.js';
import { Gateway } from '../src/gateway.js';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'aio-media-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');

/** A FakeChannel that keeps the context the gateway started it with. */
class CtxChannel extends FakeChannel {
  started: ChannelContext | undefined;
  override async start(ctx: ChannelContext): Promise<void> {
    this.started = ctx;
    return super.start(ctx);
  }
}

describe('media through the gateway blob store', () => {
  it('every channel gets the blob store, and inputs carry the reply summary of their channel', async () => {
    const dir = tmp();
    const base = resolveConfig({ policy: { owners: ['fake:alice'] }, local: { principal: 'me' }, blobs: { dir: 'b', maxBytes: 1000 } }, { env: {}, baseDir: dir, cwd: dir });
    expect(base.blobs).toEqual({ dir: join(dir, 'b'), maxBytes: 1000 });
    const seen: InputRecord[] = [];
    const harness = new FakeHarness(async (t) => {
      seen.push(...t.inputs);
    });
    const chat = new CtxChannel('fake');
    const gw = await Gateway.start({ config: { ...base, socketPath: join(dir, 'run', 'aio.sock') }, harness, log: new MemorySessionLog(), channels: [{ adapter: chat }], listen: false, logger: () => {} });
    cleanups.push(() => gw.stop());
    expect(chat.started?.blobs).toBe(gw.blobs);
    const ref = await chat.started!.blobs!.put(PNG, { mime: 'image/png' });
    expect((await gw.blobs.get(ref)).mime).toBe('image/png');
    await expect(chat.started!.blobs!.put(new Uint8Array(1001), { mime: 'image/png' })).rejects.toThrow(/limit/);
    await chat.inject({ sender: { channelUserId: 'alice', evidence: 'platform_signed' }, text: 'hi' });
    for (let i = 0; i < 200 && !seen.length; i++) await new Promise((r) => setTimeout(r, 5));
    expect(seen[0]!.channelContext.reply).toBe('card markdown=basic maxChars=4000 buttons=yes media=image,file');
  });
});
