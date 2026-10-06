import { createTransport } from 'nodemailer';
import type { ChannelAdapter, ChannelCaps, ChannelContext, RenderedMessage, ReplyRoute, SendOp, SendResult } from '@agents-io/protocol';
import { mailauthVerifier } from './auth.js';
import { ImapSource } from './imap.js';
import { SENDER_HEADER, parseInbound } from './inbound.js';
import { messageIdFor, renderHtml, renderText, replySubject } from './outbound.js';
import {
  MemoryMailStore,
  type BlobSink,
  type MailChannelConfig,
  type MailSource,
  type MailStore,
  type MailTransport,
  type MailVerifier,
} from './types.js';

export interface MailAdapterDeps {
  store?: MailStore;
  blobs?: BlobSink;
  source?: MailSource;
  transport?: MailTransport;
  verify?: MailVerifier;
}

const discardBlobs: BlobSink = { async put() {} };

export class MailChannel implements ChannelAdapter {
  readonly id = 'mail';
  private readonly store: MailStore;
  private readonly blobs: BlobSink;
  private readonly source: MailSource;
  private readonly transport: MailTransport;
  private readonly verify: MailVerifier;
  private readonly inflight = new Map<string, Promise<SendResult>>();

  constructor(
    private readonly cfg: MailChannelConfig,
    deps: MailAdapterDeps = {},
  ) {
    this.store = deps.store ?? new MemoryMailStore();
    this.blobs = deps.blobs ?? discardBlobs;
    this.source = deps.source ?? new ImapSource(cfg);
    this.transport = deps.transport ?? (createTransport(cfg.smtp) as MailTransport);
    this.verify = deps.verify ?? mailauthVerifier;
  }

  caps(_account: string): ChannelCaps {
    return {
      text: { maxChars: 100_000, markdown: 'none' },
      edit: false,
      buttons: false,
      // Outbound attachments are not implemented yet.
      media: { in: ['file', 'image'], out: [] },
      voiceOut: 'none',
      threads: true,
      approvals: 'link',
      defaultTier: 'final',
      evidence: ['dkim_pass', 'none'],
      declaresSender: true,
    };
  }

  async start(ctx: ChannelContext): Promise<void> {
    const mailbox = this.cfg.mailbox ?? 'INBOX';
    await this.source.watch({
      mailbox,
      signal: ctx.signal,
      log: ctx.log,
      checkpoint: () => this.store.getCheckpoint(mailbox),
      baseline: (cp) => this.store.setCheckpoint(mailbox, cp),
      onMessage: async (mail) => {
        const env = await parseInbound(mail.uid, mail.raw, {
          channel: this.id,
          account: this.cfg.account,
          store: this.store,
          blobs: this.blobs,
          verify: this.verify,
        });
        // Checkpoint only after the host has durably taken the envelope; a throw retries it.
        await ctx.emit(env);
        await this.store.setCheckpoint(mailbox, { uidValidity: mail.uidValidity, uid: mail.uid });
      },
    });
  }

  send(route: ReplyRoute, msg: RenderedMessage, op: SendOp): Promise<SendResult> {
    const messageId = messageIdFor(op.operationId, this.cfg.from);
    const existing = this.inflight.get(messageId);
    if (existing) return existing;
    const p = this.doSend(route, msg, op, messageId).finally(() => this.inflight.delete(messageId));
    this.inflight.set(messageId, p);
    return p;
  }

  private async doSend(route: ReplyRoute, msg: RenderedMessage, op: SendOp, messageId: string): Promise<SendResult> {
    const prior = await this.store.getSent(messageId);
    if (prior?.state === 'sent') return { providerMessageId: messageId };

    const target = await this.resolveTarget(route, msg);
    // Recorded before sending so an echo can never beat the record; 'pending' is retried with the same Message-ID.
    await this.store.putSent(messageId, { operationId: op.operationId, ...(op.as ? { as: op.as } : {}), state: 'pending' });

    await this.transport.sendMail({
      from: this.cfg.from,
      to: target.to,
      ...(this.cfg.bccSelf ? { bcc: this.cfg.from } : {}),
      subject: target.subject,
      messageId,
      ...(target.inReplyTo ? { inReplyTo: target.inReplyTo } : {}),
      ...(target.references.length ? { references: target.references } : {}),
      text: renderText(msg),
      html: renderHtml(msg),
      ...(op.as ? { headers: { 'X-Agents-IO-Sender': op.as } } : {}),
    });

    await this.store.putSent(messageId, { operationId: op.operationId, ...(op.as ? { as: op.as } : {}), state: 'sent' });
    return { providerMessageId: messageId };
  }

  private async resolveTarget(route: ReplyRoute, msg: RenderedMessage) {
    if (route.conversationId.startsWith('mailto:')) {
      const to = route.conversationId.slice('mailto:'.length);
      const first = msg.text.split('\n').find((l) => l.trim()) ?? '(no subject)';
      return { to, subject: first.slice(0, 80), inReplyTo: undefined as string | undefined, references: [] as string[] };
    }
    const meta =
      (route.replyToMessageId ? await this.store.getMeta(route.replyToMessageId) : undefined) ?? (await this.store.getMeta(route.conversationId));
    if (!meta) throw new Error(`mail: no known message to reply to for ${route.replyToMessageId ?? route.conversationId}`);
    const inReplyTo = route.replyToMessageId ?? meta.references.at(-1);
    const refs = [...meta.references];
    if (!refs.includes(meta.threadRoot)) refs.unshift(meta.threadRoot);
    return { to: meta.replyTo, subject: replySubject(meta.subject), inReplyTo, references: refs };
  }
}

export { SENDER_HEADER };
