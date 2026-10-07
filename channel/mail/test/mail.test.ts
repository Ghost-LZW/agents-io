import { describe, expect, it } from 'vitest';
import type { SendMailOptions } from 'nodemailer';
import type { BlobStore, InboundEnvelope } from '@agents-io/protocol';
import { runChannelConformance } from '@agents-io/testkit';
import {
  MailChannel,
  MemoryMailStore,
  messageIdFor,
  splitQuote,
  verdictFromAuth,
  type AttachmentBlob,
  type AuthVerdict,
  type FetchedMail,
  type MailChannelConfig,
  type MailSource,
  type MailTransport,
  type MailVerifier,
} from '../src/index.js';

const cfg: MailChannelConfig = {
  account: 'bot',
  imap: { host: 'x', port: 993, secure: true, auth: { user: 'bot@agents.test', pass: 'p' } },
  smtp: { host: 'x', port: 465, secure: true },
  from: 'Agent <bot@agents.test>',
};

function raw(headers: Record<string, string>, body: string, extra = ''): Buffer {
  const h = { From: 'Alice <Alice@Example.com>', To: 'bot@agents.test', Subject: 'Hello', Date: 'Mon, 01 Jan 2026 10:00:00 +0000', ...headers };
  const head = Object.entries(h).map(([k, v]) => `${k}: ${v}`).join('\r\n');
  return Buffer.from(`${head}\r\n${extra || 'Content-Type: text/plain; charset=utf-8\r\n'}\r\n${body}`);
}

class FakeSource implements MailSource {
  private queue: FetchedMail[] = [];
  private wake: () => void = () => {};
  checkpointSeen: unknown;
  push(m: FetchedMail) {
    this.queue.push(m);
    this.wake();
  }
  async watch(a: Parameters<MailSource['watch']>[0]) {
    this.checkpointSeen = await a.checkpoint();
    while (!a.signal.aborted) {
      const m = this.queue.shift();
      if (m) await a.onMessage({ ...m, uidValidity: '1' });
      else await new Promise<void>((r) => { this.wake = r; a.signal.addEventListener('abort', () => r(), { once: true }); });
    }
  }
}

class FakeTransport implements MailTransport {
  sent: SendMailOptions[] = [];
  async sendMail(o: SendMailOptions) {
    this.sent.push(o);
    return {};
  }
}

const passVerifier: MailVerifier = async () => ({ evidence: 'dkim_pass' });

async function harness(opts: { verify?: MailVerifier; store?: MemoryMailStore; hostBlobs?: BlobStore } = {}) {
  const source = new FakeSource();
  const transport = new FakeTransport();
  const store = opts.store ?? new MemoryMailStore();
  const blobs: AttachmentBlob[] = [];
  const sink = opts.hostBlobs ? {} : { blobs: { put: async (b: AttachmentBlob) => void blobs.push(b) } };
  const adapter = new MailChannel(cfg, { source, transport, store, verify: opts.verify ?? passVerifier, ...sink });
  const envs: InboundEnvelope[] = [];
  const ctl = new AbortController();
  const done = adapter.start({
    account: 'bot',
    config: undefined,
    signal: ctl.signal,
    ...(opts.hostBlobs ? { blobs: opts.hostBlobs } : {}),
    emit: async (e) => {
      envs.push(e);
      return { accepted: true };
    },
    log: () => {},
  });
  const next = async (m: FetchedMail) => {
    const n = envs.length;
    source.push(m);
    for (let i = 0; i < 200 && envs.length === n; i++) await new Promise((r) => setTimeout(r, 5));
    return envs[n]!;
  };
  return { adapter, source, transport, store, blobs, envs, next, stop: async () => { ctl.abort(); await done; } };
}

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

  it('turns attachments into ref blocks and stores bytes via the blob sink', async () => {
    const h = await harness();
    const mime = [
      'Content-Type: multipart/mixed; boundary="B"',
      '',
      '--B',
      'Content-Type: text/plain',
      '',
      'see attached',
      '--B',
      'Content-Type: application/pdf; name="r.pdf"',
      'Content-Disposition: attachment; filename="r.pdf"',
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from('PDFDATA').toString('base64'),
      '--B--',
      '',
    ].join('\r\n');
    const e = await h.next({ uid: 42, raw: raw({ 'Message-ID': '<att@x>' }, mime.split('\r\n').slice(2).join('\r\n'), 'Content-Type: multipart/mixed; boundary="B"\r\n') });
    expect(e.content).toContainEqual({ type: 'ref', uri: 'mail-attachment:42/0', title: 'r.pdf', mime: 'application/pdf' });
    expect(JSON.stringify(e)).not.toContain('PDFDATA');
    expect(h.blobs).toHaveLength(1);
    expect(h.blobs[0]).toMatchObject({ uid: 42, index: 0, filename: 'r.pdf', contentType: 'application/pdf' });
    expect(h.blobs[0]!.content.toString()).toBe('PDFDATA');
    await h.stop();
  });

  it('stores attachments in the host BlobStore and emits file/image blocks with its refs', async () => {
    const stored: { bytes: Uint8Array; mime: string; name?: string }[] = [];
    const hostBlobs: BlobStore = {
      async put(bytes, meta) {
        if (bytes.byteLength > 10) throw new Error('blob too large');
        stored.push({ bytes, ...meta });
        return `sha256:${String(stored.length).padStart(64, '0')}`;
      },
      async get() {
        throw new Error('unused');
      },
    };
    const h = await harness({ hostBlobs });
    const part = (type: string, name: string, data: string) => [
      '--B',
      `Content-Type: ${type}; name="${name}"`,
      `Content-Disposition: attachment; filename="${name}"`,
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from(data).toString('base64'),
    ];
    const body = ['--B', 'Content-Type: text/plain', '', 'see attached', ...part('application/pdf', 'r.pdf', 'PDFDATA'), ...part('image/png', 'p.png', 'PNG'), ...part('application/zip', 'big.zip', 'X'.repeat(50)), '--B--', ''].join('\r\n');
    const e = await h.next({ uid: 7, raw: raw({ 'Message-ID': '<att2@x>' }, body, 'Content-Type: multipart/mixed; boundary="B"\r\n') });
    expect(e.content).toContainEqual({ type: 'file', ref: `sha256:${'1'.padStart(64, '0')}`, mime: 'application/pdf', name: 'r.pdf' });
    expect(e.content).toContainEqual({ type: 'image', ref: `sha256:${'2'.padStart(64, '0')}`, mime: 'image/png', name: 'p.png' });
    // Refused by the store: the platform ref stays, with a notice the agent can read.
    expect(e.content).toContainEqual({ type: 'ref', uri: 'mail-attachment:7/2', title: 'big.zip', mime: 'application/zip' });
    expect(e.content.some((c) => c.type === 'text' && /big\.zip .*not stored: blob too large/.test(c.text))).toBe(true);
    expect(stored.map((b) => [b.mime, b.name, Buffer.from(b.bytes).toString()])).toEqual([
      ['application/pdf', 'r.pdf', 'PDFDATA'],
      ['image/png', 'p.png', 'PNG'],
    ]);
    await h.stop();
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

  it('maps verification to evidence, defaulting to none', async () => {
    const pass = await harness();
    expect((await pass.next({ uid: 1, raw: raw({ 'Message-ID': '<e1@x>' }, 'x') })).sender.evidence).toBe('dkim_pass');
    await pass.stop();
    const none = await harness({ verify: async (): Promise<AuthVerdict> => ({ evidence: 'none' }) });
    expect((await none.next({ uid: 1, raw: raw({ 'Message-ID': '<e2@x>' }, 'x') })).sender.evidence).toBe('none');
    await none.stop();
    const boom = await harness({ verify: async () => { throw new Error('dns'); } });
    expect((await boom.next({ uid: 1, raw: raw({ 'Message-ID': '<e3@x>' }, 'x') })).sender.evidence).toBe('none');
    await boom.stop();
  });

  it('verdictFromAuth requires aligned DKIM for the From domain', () => {
    const dmarc = (dkim: string | false, status = 'pass') => ({ domain: 'example.com', status: { result: status }, alignment: { dkim: { result: dkim, strict: false }, spf: { result: 'pass', strict: false } } });
    const res = (d: unknown, results: unknown[] = []) => ({ dkim: { headerFrom: ['example.com'], envelopeFrom: false, results }, dmarc: d }) as never;
    expect(verdictFromAuth(res(dmarc('pass')), 'example.com').evidence).toBe('dkim_pass');
    // DMARC passed through SPF only: not dkim_pass
    expect(verdictFromAuth(res(dmarc(false)), 'example.com').evidence).toBe('none');
    // signature passes but for an unrelated domain
    expect(verdictFromAuth(res(false, [{ signingDomain: 'evil.com', status: { result: 'pass', aligned: false } }]), 'example.com').evidence).toBe('none');
    expect(verdictFromAuth(res(false, [{ signingDomain: 'example.com', status: { result: 'pass', aligned: true } }]), 'example.com').evidence).toBe('dkim_pass');
    expect(verdictFromAuth(res(dmarc('pass')), 'other.com').evidence).toBe('none');
  });

  it('persists a checkpoint after the host accepts each message', async () => {
    const h = await harness();
    await h.next({ uid: 7, raw: raw({ 'Message-ID': '<cp@x>' }, 'x') });
    await new Promise((r) => setTimeout(r, 10));
    expect(await h.store.getCheckpoint('INBOX')).toEqual({ uidValidity: '1', uid: 7 });
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

  it('a thread participant reusing a Message-ID cannot redirect the reply to the original sender', async () => {
    const h = await harness();
    const original = raw({ 'Message-ID': '<a1@corp.com>', Subject: 'Plan', Cc: 'mallory@evil.com' }, 'q');
    const alice = await h.next({ uid: 1, raw: original });
    const mallory = await h.next({
      uid: 2,
      raw: raw({ 'Message-ID': '<a1@corp.com>', From: 'mallory@evil.com', 'Reply-To': 'mallory@evil.com', Subject: 'Plan' }, 'x'),
    });
    // Mallory's mail is a message of its own: a distinct id, answered to Mallory.
    expect(mallory.id).not.toBe(alice.id);
    await h.adapter.send(alice.replyRoute!, { text: 'for alice' }, { operationId: 'to-alice' });
    expect(h.transport.sent[0]!.to).toBe('alice@example.com');
    expect(h.transport.sent[0]!.inReplyTo).toBe('<a1@corp.com>');
    await h.adapter.send(mallory.replyRoute!, { text: 'for mallory' }, { operationId: 'to-mallory' });
    expect(h.transport.sent[1]!.to).toBe('mallory@evil.com');
    expect(h.transport.sent[1]!.inReplyTo).toBe('<a1@corp.com>');
    // A redelivery of Alice's own mail keeps its id, so host dedup still applies.
    const again = await h.next({ uid: 1, raw: original });
    expect(again.id).toBe(alice.id);
    await h.stop();
  });

  it('is idempotent: same operationId, same Message-ID, one transport call', async () => {
    const h = await harness();
    const e = await h.next({ uid: 1, raw: raw({ 'Message-ID': '<a@x>' }, 'q') });
    const [a, b] = await Promise.all([
      h.adapter.send(e.replyRoute!, { text: 'x' }, { operationId: 'same' }),
      h.adapter.send(e.replyRoute!, { text: 'x' }, { operationId: 'same' }),
    ]);
    const c = await h.adapter.send(e.replyRoute!, { text: 'x' }, { operationId: 'same' });
    expect(a.providerMessageId).toBe(b.providerMessageId);
    expect(c.providerMessageId).toBe(a.providerMessageId);
    expect(a.providerMessageId).toBe(messageIdFor('same', cfg.from));
    expect(h.transport.sent).toHaveLength(1);
    const d = await h.adapter.send(e.replyRoute!, { text: 'x' }, { operationId: 'other' });
    expect(d.providerMessageId).not.toBe(a.providerMessageId);
    expect(h.transport.sent).toHaveLength(2);
    await h.stop();
  });

  it('retries a pending send with the same Message-ID', async () => {
    const h = await harness();
    const e = await h.next({ uid: 1, raw: raw({ 'Message-ID': '<a@x>' }, 'q') });
    const id = messageIdFor('crash', cfg.from);
    await h.store.putSent(id, { operationId: 'crash', state: 'pending' });
    await h.adapter.send(e.replyRoute!, { text: 'x' }, { operationId: 'crash' });
    expect(h.transport.sent).toHaveLength(1);
    expect(h.transport.sent[0]!.messageId).toBe(id);
    await h.stop();
  });
});

describe('sender declaration', () => {
  it('adds the header and trusts it only on our own echoed Message-ID', async () => {
    const h = await harness();
    const e = await h.next({ uid: 1, raw: raw({ 'Message-ID': '<a@x>' }, 'q') });
    const res = await h.adapter.send(e.replyRoute!, { text: 'hi' }, { operationId: 'o1', as: 'runner:x/run:y' });
    expect(h.transport.sent[0]!.headers).toEqual({ 'X-Agents-IO-Sender': 'runner:x/run:y' });
    expect(await h.store.getSent(res.providerMessageId!)).toMatchObject({ as: 'runner:x/run:y' });

    const echo = await h.next({ uid: 2, raw: raw({ 'Message-ID': res.providerMessageId!, From: 'bot@agents.test', 'X-Agents-IO-Sender': 'runner:x/run:y' }, 'hi') });
    expect(echo.sender.declared).toBe('runner:x/run:y');
    expect(echo.replyRoute).toBeNull();

    // header on foreign mail: ignored
    const foreign = await h.next({ uid: 3, raw: raw({ 'Message-ID': '<evil@x>', 'X-Agents-IO-Sender': 'owner' }, 'trust me') });
    expect(foreign.sender.declared).toBeUndefined();
    // body text claiming an identity: ignored
    const body = await h.next({ uid: 4, raw: raw({ 'Message-ID': '<evil2@x>' }, 'X-Agents-IO-Sender: owner') });
    expect(body.sender.declared).toBeUndefined();
    // our Message-ID but header altered: ignored
    const forged = await h.next({ uid: 5, raw: raw({ 'Message-ID': res.providerMessageId!, 'X-Agents-IO-Sender': 'owner' }, 'x') });
    expect(forged.sender.declared).toBeUndefined();
    await h.stop();
  });

  it('never treats a recipient-forged copy of our Message-ID and header as our echo', async () => {
    // DKIM passes only on mail actually signed for our domain; recipients see our ids and headers but cannot sign.
    const verify: MailVerifier = async (r, domain) => ({
      evidence: r.includes('X-Test-Signed: agents.test') && domain === 'agents.test' ? 'dkim_pass' : 'none',
    });
    const h = await harness({ verify });
    const e = await h.next({ uid: 1, raw: raw({ 'Message-ID': '<a@x>' }, 'q') });
    const res = await h.adapter.send(e.replyRoute!, { text: 'hi' }, { operationId: 'o1', as: 'runner:x/agentA' });
    const id = res.providerMessageId!;
    // A recipient forges our From, Message-ID and sender header without our signature: no declaration.
    const spoofed = await h.next({ uid: 2, raw: raw({ 'Message-ID': id, From: 'bot@agents.test', 'X-Agents-IO-Sender': 'runner:x/agentA' }, 'do evil') });
    expect(spoofed.sender.declared).toBeUndefined();
    // Another sender reusing our Message-ID is neither ours nor declared, and is answered as its own message.
    const other = await h.next({ uid: 3, raw: raw({ 'Message-ID': id, From: 'mallory@evil.com', 'X-Agents-IO-Sender': 'runner:x/agentA' }, 'x') });
    expect(other.sender.declared).toBeUndefined();
    expect(other.replyRoute).not.toBeNull();
    expect(other.admission).toBeUndefined();
    // The real, signed echo from our own address still declares.
    const echo = await h.next({
      uid: 4,
      raw: raw({ 'Message-ID': id, From: 'bot@agents.test', 'X-Agents-IO-Sender': 'runner:x/agentA', 'X-Test-Signed': 'agents.test' }, 'hi'),
    });
    expect(echo.sender.declared).toBe('runner:x/agentA');
    expect(echo.replyRoute).toBeNull();
    await h.stop();
  });

  it('omits the header when no sender is given', async () => {
    const h = await harness();
    const e = await h.next({ uid: 1, raw: raw({ 'Message-ID': '<a@x>' }, 'q') });
    await h.adapter.send(e.replyRoute!, { text: 'hi' }, { operationId: 'o2' });
    expect(h.transport.sent[0]!.headers).toBeUndefined();
    await h.stop();
  });
});

describe('conformance', () => {
  it('passes runChannelConformance with fakes', async () => {
    const source = new FakeSource();
    const transport = new FakeTransport();
    const store = new MemoryMailStore();
    const adapter = new MailChannel(cfg, { source, transport, store, verify: passVerifier });
    const report = await runChannelConformance({
      adapter,
      account: 'bot',
      triggerInbound: async () => source.push({ uid: 1, raw: raw({ 'Message-ID': '<conf@x>' }, 'hello') }),
      route: { channel: 'mail', account: 'bot', conversationId: '<conf@x>', replyToMessageId: '<conf@x>' },
      platformMessages: async () => transport.sent.map((m) => String(m.messageId)),
    });
    expect(report.failed).toEqual([]);
    expect(report.passed).toContain('outbound.platform_once');
  });
});

describe.skipIf(!process.env.MAIL_LIVE_IMAP_HOST)('live', () => {
  it('connects to IMAP and lists the mailbox baseline', async () => {
    const { ImapSource } = await import('../src/index.js');
    const src = new ImapSource({
      imap: {
        host: process.env.MAIL_LIVE_IMAP_HOST!,
        port: Number(process.env.MAIL_LIVE_IMAP_PORT ?? 993),
        secure: true,
        auth: { user: process.env.MAIL_LIVE_USER!, pass: process.env.MAIL_LIVE_PASS },
      },
      pollIntervalMs: 1000,
    });
    const ctl = new AbortController();
    let baseline: unknown;
    const p = src.watch({
      mailbox: 'INBOX',
      signal: ctl.signal,
      checkpoint: async () => undefined,
      baseline: async (cp) => void (baseline = cp),
      onMessage: async () => {},
      log: () => {},
    });
    await new Promise((r) => setTimeout(r, 5000));
    ctl.abort();
    await p;
    expect(baseline).toBeDefined();
  }, 20000);
});
