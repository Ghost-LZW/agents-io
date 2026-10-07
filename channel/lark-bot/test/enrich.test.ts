import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { InboundEnvelope, errors, type BlobStore } from '@agents-io/protocol';
import { LarkBotAdapter, MemoryDeclaredSenderStore, type LarkBotConfig } from '../src/index.js';
import { dispositionName, sniffMime } from '../src/enrich.js';
import { messageText } from '../src/inbound.js';
import { FakeLark, messageEvent, startAdapter, tick } from './fake-lark.js';

const cfg = { appId: 'cli_x', appSecret: 's', domain: 'feishu' as const, editMinIntervalMs: 0 };

async function setup(opts: Parameters<typeof startAdapter>[1] = {}, config: Partial<LarkBotConfig> = {}) {
  const lark = new FakeLark();
  const adapter = new LarkBotAdapter({ ...cfg, ...config }, { deps: lark.deps });
  const run = startAdapter(adapter, opts);
  await tick();
  return { lark, adapter, ...run };
}

/** In-memory BlobStore with the FsBlobStore ref scheme. */
function memoryBlobs(maxBytes = 1 << 20): BlobStore & { items: Map<string, { bytes: Uint8Array; mime: string; name?: string }> } {
  const items = new Map<string, { bytes: Uint8Array; mime: string; name?: string }>();
  return {
    items,
    async put(bytes, meta) {
      if (bytes.byteLength > maxBytes) throw new Error(`blob of ${bytes.byteLength} bytes exceeds the ${maxBytes}-byte limit`);
      const ref = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
      if (!items.has(ref)) items.set(ref, { bytes, ...meta });
      return ref;
    },
    async get(ref) {
      const it = items.get(ref);
      if (!it) throw new Error('not found');
      return it;
    },
  };
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const PDF = Buffer.from('%PDF-1.4 x');
const OGG = Buffer.from('OggS....');
const sha = (b: Buffer) => `sha256:${createHash('sha256').update(b).digest('hex')}`;

describe('inbound enrichment', () => {
  it('downloads media into the host blob store with real mime and name', async () => {
    const blobs = memoryBlobs();
    const { lark, envs, ctl, done } = await setup({ blobs });
    lark.resources.set('om_a/k1', { bytes: PNG, headers: { 'content-type': 'application/octet-stream' } });
    lark.resources.set('om_b/k2', {
      bytes: PDF,
      headers: { 'content-type': 'application/pdf', 'content-disposition': "attachment; filename*=UTF-8''r%C3%A9sum%C3%A9.pdf" },
    });
    lark.resources.set('om_c/k3', { bytes: OGG });
    await lark.fire('im.message.receive_v1', messageEvent({ id: 'om_a', type: 'image', content: { image_key: 'k1' } }));
    await lark.fire('im.message.receive_v1', messageEvent({ id: 'om_b', type: 'file', content: { file_key: 'k2' } }));
    await lark.fire('im.message.receive_v1', messageEvent({ id: 'om_c', type: 'audio', content: { file_key: 'k3' } }));
    expect(envs.map((e) => e.content)).toEqual([
      [{ type: 'image', ref: sha(PNG), mime: 'image/png' }],
      [{ type: 'file', ref: sha(PDF), mime: 'application/pdf', name: 'résumé.pdf' }],
      [{ type: 'audio', ref: sha(OGG), mime: 'audio/opus' }],
    ]);
    expect(lark.lookups.filter((l) => l.startsWith('resource:'))).toEqual(['resource:om_a/k1:image', 'resource:om_b/k2:file', 'resource:om_c/k3:file']);
    expect(Buffer.from(blobs.items.get(sha(PNG))!.bytes).equals(PNG)).toBe(true);
    for (const e of envs) expect(errors(InboundEnvelope, e)).toEqual([]);
    ctl.abort();
    await done;
  });

  it('keeps lark-file refs when there is no blob store', async () => {
    const { lark, envs, ctl, done } = await setup();
    lark.resources.set('om_a/k1', { bytes: PNG });
    await lark.fire('im.message.receive_v1', messageEvent({ id: 'om_a', type: 'image', content: { image_key: 'k1' } }));
    expect(envs[0]!.content).toEqual([{ type: 'image', ref: 'lark-file:om_a/k1', mime: 'image/*' }]);
    expect(lark.lookups.some((l) => l.startsWith('resource:'))).toBe(false);
    ctl.abort();
    await done;
  });

  it('keeps lark-file refs with a notice when the download fails or is too large', async () => {
    const { lark, envs, logs, ctl, done } = await setup({ blobs: memoryBlobs() }, { mediaMaxBytes: 8 });
    lark.resources.set('om_big/k1', { bytes: PNG }); // 11 bytes > 8
    await lark.fire('im.message.receive_v1', messageEvent({ id: 'om_big', type: 'image', content: { image_key: 'k1' } }));
    await lark.fire('im.message.receive_v1', messageEvent({ id: 'om_404', type: 'file', content: { file_key: 'gone', file_name: 'x.zip' } }));
    expect(envs[0]!.content[0]).toEqual({ type: 'image', ref: 'lark-file:om_big/k1', mime: 'image/*' });
    expect(envs[0]!.content[1]).toMatchObject({ type: 'text', text: expect.stringMatching(/^\[image k1 not downloaded: .*8-byte limit/) });
    expect(envs[1]!.content[1]).toMatchObject({ type: 'text', text: expect.stringMatching(/^\[file x\.zip not downloaded: .*400/) });
    expect(logs.filter((l) => l.startsWith('warn: lark'))).toHaveLength(2);
    ctl.abort();
    await done;
  });

  it('acks within ackTimeoutMs while a download hangs, then emits in chat order once it ends', async () => {
    const { lark, envs, ctl, done } = await setup({ blobs: memoryBlobs() }, { ackTimeoutMs: 20, mediaTimeoutMs: 80 });
    lark.resources.set('om_slow/k1', { bytes: PNG, hang: true });
    const t0 = Date.now();
    await lark.fire('im.message.receive_v1', messageEvent({ id: 'om_slow', type: 'image', content: { image_key: 'k1' } }));
    await lark.fire('im.message.receive_v1', messageEvent({ id: 'om_next', content: { text: 'after' } }));
    expect(Date.now() - t0).toBeLessThan(75);
    expect(envs).toHaveLength(0); // the text waits behind the image of the same chat
    for (let i = 0; i < 100 && envs.length < 2; i++) await tick();
    expect(envs.map((e) => e.id)).toEqual(['om_slow', 'om_next']);
    expect(envs[0]!.content[1]).toMatchObject({ type: 'text', text: expect.stringMatching(/timed out/) });
    ctl.abort();
    await done;
  });

  it('fills quote text from message.get (clipped, cached) and declared from the store for our own messages', async () => {
    const lark = new FakeLark();
    const store = new MemoryDeclaredSenderStore();
    const adapter = new LarkBotAdapter({ ...cfg, quoteMaxChars: 20 }, { deps: lark.deps, store });
    const run = startAdapter(adapter);
    await tick();
    lark.foreign.set('om_p', {
      message_id: 'om_p',
      msg_type: 'text',
      body: { content: JSON.stringify({ text: '@_user_1 please review the long design document today' }) },
      mentions: [{ key: '@_user_1', id: 'ou_bob', id_type: 'open_id', name: 'Bob' }],
    });
    lark.foreign.set('om_card', {
      message_id: 'om_card',
      msg_type: 'interactive',
      body: { content: JSON.stringify({ title: 'Done', elements: [[{ tag: 'text', text: 'All tests pass' }]] }) },
      sender: { id: 'cli_x', id_type: 'app_id', sender_type: 'app' },
    });
    store.set('om_card', 'runner:x/run:1');
    await lark.fire('im.message.receive_v1', messageEvent({ id: 'om_r1', parent: 'om_p', root: 'om_p0', content: { text: 'ok' } }));
    await lark.fire('im.message.receive_v1', messageEvent({ id: 'om_r2', parent: 'om_p', root: 'om_p0', content: { text: 'again' } }));
    await lark.fire('im.message.receive_v1', messageEvent({ id: 'om_r3', parent: 'om_card', content: { text: 'thanks' } }));
    await lark.fire('im.message.receive_v1', messageEvent({ id: 'om_r4', parent: 'om_missing', content: { text: '?' } }));
    expect(run.envs[0]!.content[0]).toEqual({ type: 'quote', text: '@Bob please review…', fromMessageId: 'om_p' });
    expect(run.envs[1]!.content[0]).toEqual(run.envs[0]!.content[0]);
    expect(lark.lookups.filter((l) => l === 'get:om_p')).toHaveLength(1);
    expect(run.envs[2]!.content[0]).toEqual({ type: 'quote', text: 'Done\nAll tests pass', fromMessageId: 'om_card', declared: 'runner:x/run:1' });
    expect(run.envs[3]!.content[0]).toEqual({ type: 'quote', text: '', fromMessageId: 'om_missing' });
    run.ctl.abort();
    await run.done;
  });

  it('resolves sender display names through contact (cached with a TTL), leaving them unset on failure', async () => {
    let now = 1_000_000;
    const lark = new FakeLark();
    lark.users.set('on_alice', { name: 'Alice Zhang' });
    const adapter = new LarkBotAdapter({ ...cfg, senderNameTtlMs: 1000 }, { deps: lark.deps, now: () => now });
    const run = startAdapter(adapter);
    await tick();
    await lark.fire('im.message.receive_v1', messageEvent({ id: 'om_1' }));
    await lark.fire('im.message.receive_v1', messageEvent({ id: 'om_2' }));
    await lark.fire('im.message.receive_v1', messageEvent({ id: 'om_3', sender: { open_id: 'ou_eve' } }));
    expect(run.envs.map((e) => e.sender.displayName)).toEqual(['Alice Zhang', 'Alice Zhang', undefined]);
    expect(lark.lookups.filter((l) => l.startsWith('user:'))).toEqual(['user:on_alice:union_id', 'user:ou_eve:open_id']);
    now += 2000;
    await lark.fire('im.message.receive_v1', messageEvent({ id: 'om_4' }));
    expect(lark.lookups.filter((l) => l.startsWith('user:on_alice'))).toHaveLength(2);
    run.ctl.abort();
    await run.done;
  });

  it('helpers: content-disposition names, magic-byte sniffing, message text flattening', () => {
    expect(dispositionName('attachment; filename="a b.pdf"')).toBe('a b.pdf');
    expect(dispositionName("attachment; filename*=UTF-8''%E6%8A%A5%E5%91%8A.docx")).toBe('报告.docx');
    expect(dispositionName(undefined)).toBeUndefined();
    expect(sniffMime(PNG)).toBe('image/png');
    expect(sniffMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffMime(Buffer.from('hello'))).toBeUndefined();
    const post = JSON.stringify({ zh_cn: { title: 'T', content: [[{ tag: 'text', text: 'line' }], [{ tag: 'img', image_key: 'i' }]] } });
    expect(messageText('post', post)).toBe('T\nline\n[image]');
    expect(messageText('file', JSON.stringify({ file_key: 'k', file_name: 'a.pdf' }))).toBe('[file a.pdf]');
    expect(messageText('share_chat', '{}')).toBe('[share_chat message]');
  });
});
