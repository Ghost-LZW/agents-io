import { describe, expect, it } from 'vitest';
import type { BlobStore, ReplyRoute } from '@agents-io/protocol';
import { LarkBotAdapter, mapCardAction } from '../src/index.js';
import { FakeLark, messageEvent, startAdapter, tick } from './fake-lark.js';

/* Local tier (decision 14): rendering of the output tools, no promise behind it.
   What the host output tools (send_file, ask_choice, mention) hand this adapter. */

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
  it('sends images with image.create, a bare file without an empty text message, pdf with its file_type', async () => {
    const { lark, adapter, store } = make();
    const png = await store.put(new Uint8Array([1, 2, 3]), { mime: 'image/png', name: 'a.png' });
    const pdf = await store.put(new Uint8Array([4]), { mime: 'application/pdf', name: 'r.pdf' });
    await adapter.send(route, { text: '', attachments: [{ ref: png, mime: 'image/png', name: 'a.png' }] }, { operationId: 'op1' });
    await adapter.send(route, { text: '', attachments: [{ ref: pdf, mime: 'application/pdf', name: 'r.pdf' }] }, { operationId: 'op2' });
    expect(lark.uploads.map((u) => [u.kind, u.fileType])).toEqual([
      ['image', undefined],
      ['file', 'pdf'],
    ]);
    expect(lark.messages.map((m) => m.msg_type)).toEqual(['image', 'file']);
    expect(JSON.parse(lark.messages[0]!.content)).toEqual({ image_key: 'img_v3_1' });
  });

  it('fails clearly when the blob is not in the store', async () => {
    const { adapter } = make();
    await expect(adapter.send(route, { text: '', attachments: [{ ref: 'sha256:nope', mime: 'text/plain' }] }, { operationId: 'op1' })).rejects.toThrow(/missing/);
  });
});

describe('ask_choice on Lark', () => {
  it('single choice: buttons whose callbacks carry the choice action ids', async () => {
    const { lark, adapter } = make();
    await adapter.send(
      route,
      {
        text: 'Red or blue?',
        actions: [
          { id: 'choice:ch_1:1', label: 'red' },
          { id: 'choice:ch_1:2', label: 'blue' },
        ],
        channelData: { 'agents-io/choice': { choiceId: 'ch_1', question: 'Red or blue?', options: ['red', 'blue'], multi: false } },
      },
      { operationId: 'op1' },
    );
    const card = JSON.parse(lark.messages[0]!.content);
    const buttons = card.body.elements.filter((e: { tag: string }) => e.tag === 'button');
    expect(buttons.map((b: { behaviors: { value: { actionId: string } }[] }) => b.behaviors[0]!.value.actionId)).toEqual(['choice:ch_1:1', 'choice:ch_1:2']);
  });

  it('multi choice: a form with a multi-select; the submit maps back with formValue', async () => {
    const { lark, adapter } = make();
    await adapter.send(
      route,
      {
        text: 'Pick',
        actions: [
          { id: 'choice:ch_2:1', label: 'a' },
          { id: 'choice:ch_2:2', label: 'b' },
        ],
        channelData: { 'agents-io/choice': { choiceId: 'ch_2', question: 'Pick', options: ['a', 'b'], multi: true } },
      },
      { operationId: 'op1' },
    );
    const form = JSON.parse(lark.messages[0]!.content).body.elements.find((e: { tag: string }) => e.tag === 'form');
    expect(form.elements[0]).toMatchObject({ tag: 'multi_select_static', name: 'choice', options: [{ value: '1' }, { value: '2' }] });
    expect(form.elements[1]).toMatchObject({ form_action_type: 'submit', behaviors: [{ value: { actionId: 'choice:ch_2:form' } }] });
    const env = mapCardAction(
      { event_id: 'e1', operator: { open_id: 'ou_alice' }, action: { value: { actionId: 'choice:ch_2:form' }, form_value: { choice: ['1', '2'] } }, context: { open_message_id: 'om_1', open_chat_id: 'oc_chat' } },
      { account: 'acct' },
    )!;
    expect(env.content[0]).toMatchObject({ type: 'event', name: 'action', data: { actionId: 'choice:ch_2:form', formValue: { choice: ['1', '2'] } } });
  });
});

describe('mention on Lark', () => {
  it('turns ids into at tags, mapping union_ids learned from inbound events to open_ids', async () => {
    const { lark, adapter } = make();
    const { ctl, done } = startAdapter(adapter);
    await tick();
    await lark.handlers.get('im.message.receive_v1')!(messageEvent({ sender: { union_id: 'on_bob', open_id: 'ou_bob' } }));
    await adapter.send(
      route,
      { text: '@Bob @Carol please look', channelData: { 'agents-io/mentions': { targets: [{ id: 'on_bob', name: 'Bob' }, { id: 'on_carol', name: 'Carol' }], text: 'please look' } } },
      { operationId: 'op1' },
    );
    const last = lark.messages.at(-1)!;
    expect(last.msg_type).toBe('text');
    expect(JSON.parse(last.content).text).toBe('<at user_id="ou_bob">Bob</at> @Carol please look');
    ctl.abort();
    await done;
  });
});
