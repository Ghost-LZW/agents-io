import { describe, expect, it } from 'vitest';
import { MailChannel, mailChannelModule } from '../src/index.js';

/* The mail channel type's `create`: the adapter of one resolved entry, as the daemon builds it. */

const init = { index: 0, account: 'work', config: undefined, log: () => {}, stateDir: '/data/channels/mail.work', acceptId: () => undefined, onState: () => {} };

describe('mail channel module', () => {
  it('builds a MailChannel from the entry config with the entry account; declares its channel id', async () => {
    const b = await mailChannelModule.create({ type: 'mail', account: 'work', config: { imap: { host: 'imap.example', port: 993, secure: true, auth: { user: 'u', pass: 'p' } }, smtp: { host: 'smtp.example', port: 465, secure: true }, from: 'me@example' } }, init);
    expect(b.adapter).toBeInstanceOf(MailChannel);
    expect((b.adapter as unknown as { cfg: { account: string; from: string } }).cfg).toMatchObject({ account: 'work', from: 'me@example' });
    expect(mailChannelModule.ids).toEqual(['mail']);
  });
});
