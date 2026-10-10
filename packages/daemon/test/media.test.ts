import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { InputRecord } from '@agents-io/protocol';
import { FsBlobStore } from '@agents-io/session';
import { toUserMessage } from '@agents-io/harness-claude-code';
import { renderInputs } from '@agents-io/harness-codex';
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

describe('media through the gateway blob store', () => {
  it('Claude receives a real image block and a file path; Codex a localImage with the stored bytes #MD-1', async () => {
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

  it('refuses images over the inline limit with a reason instead of failing the turn #MD-1', async () => {
    const store = new FsBlobStore({ dir: join(tmp(), 'blobs'), maxBytes: CLAUDE_IMAGE_MAX_BYTES + 10 });
    const big = await store.put(new Uint8Array(CLAUDE_IMAGE_MAX_BYTES + 1), { mime: 'image/png' });
    const { message, notices } = await toUserMessage(input([{ type: 'image', ref: big, mime: 'image/png' }]), {
      priority: 'next',
      resolveImage: blobResolvers(store).resolveImage,
    });
    expect((message.message.content as { type: string }[])[1]!.type).toBe('text');
    expect(notices[0]).toMatch(/inline limit/);
  });
});
