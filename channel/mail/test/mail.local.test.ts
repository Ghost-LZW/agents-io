import { describe, expect, it } from 'vitest';
import type { BlobStore } from '@agents-io/protocol';
import { splitQuote } from '../src/index.js';
import { harness, raw } from './mail-helpers.js';

/* Threading headers, quote stripping, attachment and choice rendering: feature paths with no promise
   behind them (decision 14: local tier). */

describe('inbound', () => {
  it('maps threading ids and sender', async () => {
    const h = await harness();
    const first = await h.next({ uid: 1, raw: raw({ 'Message-ID': '<a@x>' }, 'hi') });
    expect(first.id).toBe('<a@x>');
    expect(first.conversation).toEqual({ id: '<a@x>', kind: 'mail' });
    expect(first.sender.channelUserId).toBe('alice@example.com');
    expect(first.replyRoute).toEqual({ channel: 'mail', account: 'bot', conversationId: '<a@x>', replyToMessageId: '<a@x>' });

    const reply = await h.next({ uid: 2, raw: raw({ 'Message-ID': '<b@x>', 'In-Reply-To': '<a@x>' }, 'again') });
    expect(reply.conversation.id).toBe('<a@x>');
    const deep = await h.next({ uid: 3, raw: raw({ 'Message-ID': '<c@x>', 'In-Reply-To': '<b@x>', References: '<a@x> <b@x>' }, 'deep') });
    expect(deep.conversation.id).toBe('<a@x>');
    expect(deep.replyRoute?.replyToMessageId).toBe('<c@x>');
    await h.stop();
  });

  it('strips quoted history into a truncated quote block', async () => {
    const h = await harness();
    const body = 'Sounds good.\n\nOn Mon, 1 Jan 2026 at 09:00, Bot <bot@agents.test> wrote:\n> earlier text\n> more';
    const e = await h.next({ uid: 1, raw: raw({ 'Message-ID': '<q@x>', 'In-Reply-To': '<p@x>' }, body) });
    expect(e.content[0]).toEqual({ type: 'text', text: 'Subject: Hello\n\nSounds good.' });
    expect(e.content[1]).toMatchObject({ type: 'quote', fromMessageId: '<p@x>' });
    expect((e.content[1] as { text: string }).text).toContain('> earlier text');

    const long = 'ok\n' + Array.from({ length: 2000 }, () => '> quoted line here').join('\n');
    const e2 = await h.next({ uid: 2, raw: raw({ 'Message-ID': '<q2@x>' }, long) });
    expect((e2.content[1] as { text: string }).text.length).toBeLessThan(4100);
    await h.stop();
  });

  it('splitQuote handles outlook and original-message markers', () => {
    expect(splitQuote('yes\n\n-----Original Message-----\nFrom: a\nSent: b\n').body).toBe('yes');
    expect(splitQuote('yes\n\nFrom: a\nSent: b\nTo: c\n\nold').body).toBe('yes');
    expect(splitQuote('no quotes').quoted).toBe('');
  });

  it('drops auto-replies and bounces', async () => {
    const h = await harness();
    const a = await h.next({ uid: 1, raw: raw({ 'Message-ID': '<oo@x>', 'Auto-Submitted': 'auto-replied' }, 'out of office') });
    expect(a.admission).toBe('drop');
    const b = await h.next({ uid: 2, raw: raw({ 'Message-ID': '<bulk@x>', Precedence: 'bulk' }, 'news') });
    expect(b.admission).toBe('drop');
    const c = await h.next({ uid: 3, raw: raw({ 'Message-ID': '<bn@x>', From: 'MAILER-DAEMON@example.com' }, 'undeliverable') });
    expect(c.admission).toBe('drop');
    const d = await h.next({ uid: 4, raw: raw({ 'Message-ID': '<ok@x>', 'Auto-Submitted': 'no' }, 'normal') });
    expect(d.admission).toBeUndefined();
    await h.stop();
  });
});

describe('outbound', () => {
  it('sends output-tool attachments from the host blob store; a numbered ask_choice is plain text', async () => {
    const m = new Map<string, { bytes: Uint8Array; mime: string; name?: string }>([['sha256:r', { bytes: new TextEncoder().encode('# hi'), mime: 'text/markdown', name: 'README.md' }]]);
    const hostBlobs: BlobStore = { put: async () => 'x', get: async (ref) => { const b = m.get(ref); if (!b) throw new Error('missing'); return b; } };
    const h = await harness({ hostBlobs });
    const e = await h.next({ uid: 1, raw: raw({ 'Message-ID': '<f@x>', Subject: 'File' }, 'send it') });
    expect(h.adapter.caps('bot').media.out).toEqual(['file', 'image']);
    await h.adapter.send(e.replyRoute!, { text: 'here', attachments: [{ ref: 'sha256:r', mime: 'text/markdown', name: 'README.md' }] }, { operationId: 'op1' });
    const sent = h.transport.sent[0]!;
    expect(sent.attachments).toEqual([{ filename: 'README.md', content: Buffer.from('# hi'), contentType: 'text/markdown' }]);
    await expect(h.adapter.send(e.replyRoute!, { text: 'x', attachments: [{ ref: 'sha256:gone', mime: 'text/plain' }] }, { operationId: 'op2' })).rejects.toThrow(/attachment sha256:gone/);
    expect(h.transport.sent).toHaveLength(1);
    await h.adapter.send(e.replyRoute!, { text: 'Pick\n\n1. a\n2. b\n\nReply with the number of your choice', channelData: { 'agents-io/choice': { choiceId: 'c', question: 'Pick', options: ['a', 'b'], multi: false } } }, { operationId: 'op3' });
    expect(h.transport.sent[1]!.text).toContain('1. a\n2. b');
    await h.stop();
  });

  it('replies with In-Reply-To, References and Re: subject', async () => {
    const h = await harness();
    const e = await h.next({ uid: 1, raw: raw({ 'Message-ID': '<c@x>', 'In-Reply-To': '<b@x>', References: '<a@x> <b@x>', Subject: 'Plan' }, 'q') });
    const r = await h.adapter.send(e.replyRoute!, { text: 'Done', sections: [{ kind: 'body', text: 'Done <b>' }, { kind: 'footer', text: 'bye' }] }, { operationId: 'op1' });
    const m = h.transport.sent[0]!;
    expect(m.to).toBe('alice@example.com');
    expect(m.subject).toBe('Re: Plan');
    expect(m.inReplyTo).toBe('<c@x>');
    expect(m.references).toEqual(['<a@x>', '<b@x>', '<c@x>']);
    expect(m.text).toBe('Done');
    expect(m.html).toContain('Done &lt;b&gt;');
    expect(m.messageId).toBe(r.providerMessageId);
    await h.stop();
  });
});
