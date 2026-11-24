import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { InboundEnvelope, errors, type BlobStore } from '@agents-io/protocol';
import { LarkBotAdapter, MemoryDeclaredSenderStore, type LarkBotConfig } from '../src/index.js';
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

// Moved from enrich.test.ts: feature-path tests with no promise in docs/INVARIANTS.md (decision 14: local tier).

describe('merged-forward', () => {
  it('expands merged-forward children into attributed text, including non-text placeholders', async () => {
    const { lark, envs, ctl, done } = await setup();
    lark.foreign.set('om_forward', [
      { message_id: 'om_forward', msg_type: 'merge_forward', body: { content: 'Merged and Forwarded Message' } },
      {
        message_id: 'om_child1', upper_message_id: 'om_forward', msg_type: 'text', sender: { id: 'ou_alice', id_type: 'open_id', sender_type: 'user' },
        body: { content: JSON.stringify({ text: '@_user_1 please read this' }) },
        mentions: [{ key: '@_user_1', id: 'ou_bob', id_type: 'open_id', name: 'Bob' }],
      },
      {
        message_id: 'om_child2', upper_message_id: 'om_forward', msg_type: 'post', sender: { id: 'ou_bob', id_type: 'open_id', sender_type: 'user' },
        body: { content: JSON.stringify({ zh_cn: { title: 'Result', content: [[{ tag: 'text', text: 'Done' }]] } }) },
      },
      { message_id: 'om_child3', upper_message_id: 'om_forward', msg_type: 'image', body: { content: JSON.stringify({ image_key: 'img_1' }) } },
    ]);
    await lark.fire('im.message.receive_v1', messageEvent({ id: 'om_forward', type: 'merge_forward', content: { text: 'Merged and Forwarded Message' } }));
    expect(envs[0]!.content).toEqual([{ type: 'text', text: '合并转发（3 条消息）\n\n1. ou_alice (text)\n@Bob please read this\n\n2. ou_bob (post)\nResult\nDone\n\n3. 未知发送者 (image)\n[image]' }]);
    expect(lark.lookups.filter((l) => l === 'get:om_forward')).toHaveLength(1);
    expect(errors(InboundEnvelope, envs[0])).toEqual([]);
    ctl.abort();
    await done;
  });

  it('reports when merged-forward children cannot be fetched instead of calling the type unsupported', async () => {
    const { lark, envs, logs, ctl, done } = await setup();
    await lark.fire('im.message.receive_v1', messageEvent({ id: 'om_missing_forward', type: 'merge_forward' }));
    expect(envs[0]!.content).toEqual([{ type: 'text', text: '[合并转发内容无法读取]' }]);
    expect(logs.some((line) => line.includes('merged forward om_missing_forward not fetched'))).toBe(true);
    ctl.abort();
    await done;
  });

  it('clips a large merged forward and expands it when quoted', async () => {
    const { lark, envs, ctl, done } = await setup();
    lark.foreign.set('om_long', [
      { message_id: 'om_long', msg_type: 'merge_forward', body: { content: 'Merged and Forwarded Message' } },
      { message_id: 'om_child', upper_message_id: 'om_long', msg_type: 'text', body: { content: JSON.stringify({ text: 'A'.repeat(20_000) }) } },
    ]);
    await lark.fire('im.message.receive_v1', messageEvent({ id: 'om_long', type: 'merge_forward' }));
    const expanded = envs[0]!.content[0];
    expect(expanded).toMatchObject({ type: 'text', text: expect.stringContaining('[转发内容已截断]') });
    expect(expanded.type === 'text' && expanded.text.length).toBeLessThanOrEqual(16_000);
    await lark.fire('im.message.receive_v1', messageEvent({ id: 'om_reply', parent: 'om_long', content: { text: 'summary?' } }));
    expect(envs[1]!.content[0]).toMatchObject({ type: 'quote', text: expect.stringContaining('合并转发（1 条消息）') });
    ctl.abort();
    await done;
  });
});
