import { describe, expect, it } from 'vitest';

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
