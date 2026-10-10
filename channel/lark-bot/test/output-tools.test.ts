import { describe, expect, it } from 'vitest';
import type { BlobStore, ReplyRoute } from '@agents-io/protocol';
import { LarkBotAdapter } from '../src/index.js';
import { FakeLark } from './fake-lark.js';

/* What the host output tools (send_file, ask_choice, mention) hand this adapter. */

const cfg = { appId: 'cli_x', appSecret: 's', domain: 'lark' as const, editMinIntervalMs: 0 };
const route: ReplyRoute = { channel: 'lark-bot', account: 'acct', conversationId: 'oc_chat', replyToMessageId: 'om_in1' };

function blobs(): BlobStore & { m: Map<string, { bytes: Uint8Array; mime: string; name?: string }> } {
  const m = new Map<string, { bytes: Uint8Array; mime: string; name?: string }>();
  return {
    m,
    async put(bytes, meta) {
      const ref = `sha256:${m.size + 1}`;
      m.set(ref, { bytes, ...meta });
      return ref;
    },
    async get(ref) {
      const b = m.get(ref);
      if (!b) throw new Error('missing');
      return b;
    },
  };
}

function make() {
  const lark = new FakeLark();
  const store = blobs();
  const adapter = new LarkBotAdapter(cfg, { deps: lark.deps, blobs: store });
  return { lark, adapter, store };
}

describe('send_file on Lark', () => {
  it('uploads a host file with file.create and sends a file message; the caption goes first #DL-2', async () => {
    const { lark, adapter, store } = make();
    const ref = await store.put(new TextEncoder().encode('# readme\n'), { mime: 'text/markdown', name: 'README.md' });
    const r = await adapter.send(route, { text: 'here it is', attachments: [{ ref, mime: 'text/markdown', name: 'README.md' }] }, { operationId: 'op1' });
    expect(lark.uploads).toEqual([{ kind: 'file', fileType: 'stream', name: 'README.md', bytes: 9, key: 'file_v3_1' }]);
    expect(lark.messages.map((m) => m.msg_type)).toEqual(['text', 'file']);
    expect(JSON.parse(lark.messages[1]!.content)).toEqual({ file_key: 'file_v3_1' });
    expect(r.providerMessageId).toBe(lark.messages[0]!.id);
    // A retry of the same op neither uploads nor sends again.
    await adapter.send(route, { text: 'here it is', attachments: [{ ref, mime: 'text/markdown', name: 'README.md' }] }, { operationId: 'op1' });
    expect(lark.uploads).toHaveLength(1);
    expect(lark.messages).toHaveLength(2);
  });
});
