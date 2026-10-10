import { describe, expect, it } from 'vitest';
import type { BlobStore } from '@agents-io/protocol';
import { runChannelConformance } from '@agents-io/testkit';
import { MailChannel, MemoryMailStore, messageIdFor, verdictFromAuth, type AuthVerdict, type MailVerifier } from '../src/index.js';
import { FakeSource, FakeTransport, cfg, harness, passVerifier, raw } from './mail-helpers.js';

describe('inbound', () => {
  it('turns attachments into ref blocks and stores bytes via the blob sink #MD-1', async () => {
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

  it('stores attachments in the host BlobStore and emits file/image blocks with its refs #MD-1', async () => {
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

  it('maps verification to evidence, defaulting to none #ID-4 #ID-3', async () => {
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

  it('verdictFromAuth requires aligned DKIM for the From domain #ID-4', () => {
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

  it('persists a checkpoint after the host accepts each message #IN-7', async () => {
    const h = await harness();
    await h.next({ uid: 7, raw: raw({ 'Message-ID': '<cp@x>' }, 'x') });
    await new Promise((r) => setTimeout(r, 10));
    expect(await h.store.getCheckpoint('INBOX')).toEqual({ uidValidity: '1', uid: 7 });
    await h.stop();
  });

  // INVARIANTS IN-7 不成立 1: onMessage moves the checkpoint after any emit that returns, also { accepted: false } (gateway stopping); turns red when fixed — make it `it` and update INVARIANTS.
  it.fails('does not move the checkpoint past a message the host answered accepted:false #IN-7', async () => {
    const source = new FakeSource();
    const store = new MemoryMailStore();
    const adapter = new MailChannel(cfg, { source, transport: new FakeTransport(), store, verify: passVerifier, blobs: { put: async () => {} } });
    const ctl = new AbortController();
    let emitted = 0;
    const done = adapter.start({
      account: 'bot',
      config: undefined,
      signal: ctl.signal,
      emit: async () => {
        emitted++;
        return { accepted: false, error: 'gateway stopping' };
      },
      log: () => {},
    });
    source.push({ uid: 7, raw: raw({ 'Message-ID': '<stop@x>' }, 'x') });
    for (let i = 0; i < 200 && emitted === 0; i++) await new Promise((r) => setTimeout(r, 5));
    await new Promise((r) => setTimeout(r, 10));
    expect(emitted).toBe(1);
    expect((await store.getCheckpoint('INBOX'))?.uid).not.toBe(7);
    ctl.abort();
    await done;
  });
});

describe('outbound', () => {
  it('a thread participant reusing a Message-ID cannot redirect the reply to the original sender #DL-3 #IN-5', async () => {
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

  it('is idempotent: same operationId, same Message-ID, one transport call #DL-2', async () => {
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

  it('retries a pending send with the same Message-ID #DL-2', async () => {
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
  it('adds the header and trusts it only on our own echoed Message-ID #DL-4b #ID-5', async () => {
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

  it('never treats a recipient-forged copy of our Message-ID and header as our echo #DL-4b #ID-4', async () => {
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

  it('omits the header when no sender is given #DL-4b', async () => {
    const h = await harness();
    const e = await h.next({ uid: 1, raw: raw({ 'Message-ID': '<a@x>' }, 'q') });
    await h.adapter.send(e.replyRoute!, { text: 'hi' }, { operationId: 'o2' });
    expect(h.transport.sent[0]!.headers).toBeUndefined();
    await h.stop();
  });
});

describe('conformance', () => {
  it('passes runChannelConformance with fakes #CN-1', async () => {
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

describe('internal delivery (opt-in provider evidence)', () => {
  const noAuth: MailVerifier = async () => ({ evidence: 'none' });
  const internal = { From: 'Owner <i@example.com>', 'Message-ID': '<int@x>', 'X-QQ-BUSINESS-ORIGIN': '2' };

  it('mail from a listed domain without Received/Authentication-Results is platform_signed #ID-3 #ID-4', async () => {
    const h = await harness({ verify: noAuth, cfg: { internalDelivery: { domains: ['Example.com'] } } });
    const e = await h.next({ uid: 1, raw: raw(internal, 'hi') });
    expect(e.sender.evidence).toBe('platform_signed');
    expect(h.adapter.caps('bot').evidence).toContain('platform_signed');
    await h.stop();
  });

  it('a provider-added hop (mail from outside) never counts, even from a listed domain #ID-4', async () => {
    const h = await harness({ verify: noAuth, cfg: { internalDelivery: { domains: ['example.com'] } } });
    const viaMx = await h.next({ uid: 1, raw: raw({ ...internal, Received: 'from evil.test by mx.example.net' }, 'hi') });
    expect(viaMx.sender.evidence).toBe('none');
    const withAuth = await h.next({ uid: 2, raw: raw({ ...internal, 'Message-ID': '<int2@x>', 'Authentication-Results': 'mx; spf=softfail' }, 'hi') });
    expect(withAuth.sender.evidence).toBe('none');
    await h.stop();
  });

  it('is off by default and limited to the listed domains #ID-4', async () => {
    const off = await harness({ verify: noAuth });
    expect((await off.next({ uid: 1, raw: raw(internal, 'hi') })).sender.evidence).toBe('none');
    await off.stop();
    const other = await harness({ verify: noAuth, cfg: { internalDelivery: { domains: ['other.test'] } } });
    expect((await other.next({ uid: 1, raw: raw(internal, 'hi') })).sender.evidence).toBe('none');
    await other.stop();
  });
});
