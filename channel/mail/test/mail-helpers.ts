import type { SendMailOptions } from 'nodemailer';
import type { BlobStore, InboundEnvelope } from '@agents-io/protocol';
import {
  MailChannel,
  MemoryMailStore,
  type AttachmentBlob,
  type FetchedMail,
  type MailChannelConfig,
  type MailSource,
  type MailTransport,
  type MailVerifier,
} from '../src/index.js';

/* Fakes shared by mail.test.ts (core) and mail.local.test.ts. */

export const cfg: MailChannelConfig = {
  account: 'bot',
  imap: { host: 'x', port: 993, secure: true, auth: { user: 'bot@agents.test', pass: 'p' } },
  smtp: { host: 'x', port: 465, secure: true },
  from: 'Agent <bot@agents.test>',
};

export function raw(headers: Record<string, string>, body: string, extra = ''): Buffer {
  const h = { From: 'Alice <Alice@Example.com>', To: 'bot@agents.test', Subject: 'Hello', Date: 'Mon, 01 Jan 2026 10:00:00 +0000', ...headers };
  const head = Object.entries(h).map(([k, v]) => `${k}: ${v}`).join('\r\n');
  return Buffer.from(`${head}\r\n${extra || 'Content-Type: text/plain; charset=utf-8\r\n'}\r\n${body}`);
}

export class FakeSource implements MailSource {
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
      let wait = !m;
      if (m) {
        try {
          await a.onMessage({ ...m, uidValidity: '1' });
        } catch (e) {
          // Like ImapSource: the message is fetched again later (here: at the next push).
          a.log('warn', `onMessage failed: ${String(e)}`);
          this.queue.unshift(m);
          wait = true;
        }
      }
      if (wait) await new Promise<void>((r) => { this.wake = r; a.signal.addEventListener('abort', () => r(), { once: true }); });
    }
  }
}

export class FakeTransport implements MailTransport {
  sent: SendMailOptions[] = [];
  async sendMail(o: SendMailOptions) {
    this.sent.push(o);
    return {};
  }
}

export const passVerifier: MailVerifier = async () => ({ evidence: 'dkim_pass' });

export async function harness(opts: { verify?: MailVerifier; store?: MemoryMailStore; hostBlobs?: BlobStore; cfg?: Partial<MailChannelConfig> } = {}) {
  const source = new FakeSource();
  const transport = new FakeTransport();
  const store = opts.store ?? new MemoryMailStore();
  const blobs: AttachmentBlob[] = [];
  const sink = opts.hostBlobs ? {} : { blobs: { put: async (b: AttachmentBlob) => void blobs.push(b) } };
  const adapter = new MailChannel({ ...cfg, ...opts.cfg }, { source, transport, store, verify: opts.verify ?? passVerifier, ...sink });
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
