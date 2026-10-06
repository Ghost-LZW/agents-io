import { ImapFlow } from 'imapflow';
import type { MailChannelConfig, MailSource } from './types.js';

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
    function done() {
      clearTimeout(t);
      signal.removeEventListener('abort', done);
      resolve();
    }
  });

/**
 * IMAP source on imapflow. imapflow idles automatically while the connection is
 * quiet; an `exists` event wakes the drain loop, and a poll timer covers servers
 * without IDLE (or a silent dead connection).
 */
export class ImapSource implements MailSource {
  constructor(private readonly cfg: Pick<MailChannelConfig, 'imap' | 'pollIntervalMs'>) {}

  async watch(args: Parameters<MailSource['watch']>[0]): Promise<void> {
    const { signal, log } = args;
    let backoff = 1000;
    while (!signal.aborted) {
      try {
        await this.session(args);
        backoff = 1000;
      } catch (err) {
        if (signal.aborted) return;
        log('warn', `imap session failed: ${String(err)}`);
      }
      await sleep(backoff, signal);
      backoff = Math.min(backoff * 2, 60_000);
    }
  }

  private async session(args: Parameters<MailSource['watch']>[0]): Promise<void> {
    const { mailbox, signal, log } = args;
    const { host, port, secure, auth } = this.cfg.imap;
    const client = new ImapFlow({ host, port, secure, auth, logger: false });
    let wake: () => void = () => {};
    let closed: () => void = () => {};
    const closedP = new Promise<void>((r) => (closed = r));
    client.on('error', (err) => log('warn', `imap error: ${String(err)}`));
    client.on('close', () => closed());
    client.on('exists', () => wake());
    const onAbort = () => {
      closed();
      wake();
    };
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      await client.connect();
      const lock = await client.getMailboxLock(mailbox);
      try {
        const box = client.mailbox;
        if (!box) throw new Error('mailbox not open');
        const uidValidity = String(box.uidValidity ?? 0n);
        let cp = await args.checkpoint();
        if (!cp || cp.uidValidity !== uidValidity) {
          cp = { uidValidity, uid: Math.max(0, (box.uidNext ?? 1) - 1) };
          await args.baseline(cp);
          log('info', `imap baseline set at uid ${cp.uid}`);
        }
        let last = cp.uid;
        while (!signal.aborted) {
          const range = `${last + 1}:*`;
          // `N:*` always includes the highest message even if it is below N, so filter.
          const batch: { uid: number; raw: Buffer }[] = [];
          for await (const msg of client.fetch(range, { uid: true, source: true }, { uid: true })) {
            if (msg.uid > last && msg.source) batch.push({ uid: msg.uid, raw: msg.source });
          }
          batch.sort((a, b) => a.uid - b.uid);
          for (const m of batch) {
            await args.onMessage({ uid: m.uid, raw: m.raw, uidValidity });
            last = m.uid;
          }
          const woke = new Promise<void>((r) => (wake = r));
          await Promise.race([woke, closedP, sleep(this.cfg.pollIntervalMs ?? 60_000, signal)]);
          if (!client.usable) return;
        }
      } finally {
        lock.release();
      }
    } finally {
      signal.removeEventListener('abort', onAbort);
      await client.logout().catch(() => client.close());
    }
  }
}
