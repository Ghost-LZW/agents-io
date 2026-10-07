import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ChannelContext, InputRecord } from '@agents-io/protocol';
import { FsBlobStore, MemorySessionLog } from '@agents-io/session';
import { FakeChannel, FakeHarness } from '@agents-io/testkit';
import { toUserMessage } from '@agents-io/harness-claude-code';
import { CodexHarness, renderInputs } from '@agents-io/harness-codex';
import { resolveConfig, type HarnessInstance } from '../src/config.js';
import { Gateway, buildHarness } from '../src/gateway.js';
import { CLAUDE_IMAGE_MAX_BYTES, blobResolvers } from '../src/media.js';

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

const input = (content: InputRecord['content']): InputRecord => ({
  inputId: 'i1',
  origin: { kind: 'human', principal: { id: 'owner', labels: ['owner'] }, evidence: 'platform_signed', via: 'lark-bot:a:c1', adapter: 'lark-bot' },
  content,
  replyRoute: null,
  channelContext: {},
});

/** A FakeChannel that keeps the context the gateway started it with. */
class CtxChannel extends FakeChannel {
  started: ChannelContext | undefined;
  override async start(ctx: ChannelContext): Promise<void> {
    this.started = ctx;
    return super.start(ctx);
  }
}

describe('media through the gateway blob store', () => {
  it('Claude receives a real image block and a file path; Codex a localImage with the stored bytes', async () => {
    const store = new FsBlobStore({ dir: join(tmp(), 'blobs') });
    const img = await store.put(PNG, { mime: 'image/png' });
    const pdf = await store.put(Buffer.from('%PDF-1.4'), { mime: 'application/pdf', name: 'r.pdf' });
    const r = blobResolvers(store);
    const rec = input([
      { type: 'image', ref: img, mime: 'image/png' },
      { type: 'file', ref: pdf, mime: 'application/pdf', name: 'r.pdf' },
      { type: 'image', ref: 'lark-file:om_1/k', mime: 'image/*' },
    ]);

    const { message, notices } = await toUserMessage(rec, { priority: 'next', resolveImage: r.resolveImage, resolveFile: r.resolveFile });
    const blocks = message.message.content as { type: string; text?: string; source?: { media_type: string; data: string } }[];
    expect(blocks[1]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG.toString('base64') } });
    expect(blocks[2]!.text).toMatch(/^\[file r\.pdf application\/pdf at \/.+\.pdf\]$/);
    expect(blocks[3]!.text).toMatch(/not shown: unavailable/); // a platform ref the store does not hold
    expect(notices).toHaveLength(1);

    const items = await renderInputs([rec], { resolveMedia: r.resolveMedia });
    const local = items.find((i) => i.type === 'localImage') as { type: 'localImage'; path: string };
    expect(local).toBeDefined();
    expect(readFileSync(local.path).equals(PNG)).toBe(true);
    expect(local.path.endsWith('.png')).toBe(true);
    const text = items.filter((i) => i.type === 'text').map((i) => (i as { text: string }).text).join('\n');
    expect(text).toMatch(/\[file r\.pdf \(application\/pdf\) at \/.+\.pdf\]/);
    expect(text).toContain('[image lark-file:om_1/k (image/*) not available]');
  });

  it('refuses images over the inline limit with a reason instead of failing the turn', async () => {
    const store = new FsBlobStore({ dir: join(tmp(), 'blobs'), maxBytes: CLAUDE_IMAGE_MAX_BYTES + 10 });
    const big = await store.put(new Uint8Array(CLAUDE_IMAGE_MAX_BYTES + 1), { mime: 'image/png' });
    const { message, notices } = await toUserMessage(input([{ type: 'image', ref: big, mime: 'image/png' }]), {
      priority: 'next',
      resolveImage: blobResolvers(store).resolveImage,
    });
    expect((message.message.content as { type: string }[])[1]!.type).toBe('text');
    expect(notices[0]).toMatch(/inline limit/);
  });

  it('buildHarness hands the resolvers to both kinds; explicit config options win', () => {
    const dir = tmp();
    const config = resolveConfig(
      { harnesses: { c: { use: 'claude-code', options: { clientComposed: true } }, x: { use: 'codex' } } },
      { env: {}, baseDir: dir, cwd: dir },
    );
    const media = blobResolvers(new FsBlobStore({ dir: join(dir, 'blobs') }));
    const claude = buildHarness(config.harnesses.c as HarnessInstance, media);
    expect(claude.instance.options).toMatchObject({ resolveImage: media.resolveImage, resolveFile: media.resolveFile, clientComposed: true });
    const codex = buildHarness(config.harnesses.x as HarnessInstance, media);
    expect(codex.inner).toBeInstanceOf(CodexHarness);
    expect((codex.inner as unknown as { opts: { resolveMedia?: unknown } }).opts.resolveMedia).toBe(media.resolveMedia);
  });

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
