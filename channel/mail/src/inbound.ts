import { createHash } from 'node:crypto';
import { simpleParser, type ParsedMail } from 'mailparser';
import { PROTOCOL_VERSION, type ContentBlock, type InboundEnvelope } from '@agents-io/protocol';
import { splitQuote, truncate } from './quote.js';
import type { AuthVerdict, BlobSink, MailStore, MailVerifier, MessageMeta } from './types.js';

export const SENDER_HEADER = 'x-agents-io-sender';
export const QUOTE_MAX_CHARS = 4000;

export interface ParseDeps {
  channel: string;
  account: string;
  store: MailStore;
  blobs: BlobSink;
  verify: MailVerifier;
}

const asArray = (v: string | string[] | undefined): string[] => (v === undefined ? [] : Array.isArray(v) ? v : v.split(/\s+/).filter(Boolean));

function headerString(parsed: ParsedMail, name: string): string | undefined {
  const v = parsed.headers.get(name);
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map(String).join(', ');
  if (typeof v === 'object' && 'text' in v && typeof (v as { text: unknown }).text === 'string') return (v as { text: string }).text;
  if (typeof v === 'object' && 'value' in v) return String((v as { value: unknown }).value);
  return String(v);
}

/** Auto-replies, bounces and bulk mail must never reach an agent as a conversation. */
export function isAutomated(parsed: ParsedMail, fromAddress: string): boolean {
  const auto = headerString(parsed, 'auto-submitted')?.trim().toLowerCase();
  if (auto && auto !== 'no') return true;
  const prec = headerString(parsed, 'precedence')?.trim().toLowerCase();
  if (prec && ['bulk', 'junk', 'list', 'auto_reply'].includes(prec)) return true;
  if (headerString(parsed, 'x-autoreply') || headerString(parsed, 'x-autorespond')) return true;
  const ct = headerString(parsed, 'content-type') ?? '';
  if (/multipart\/report/i.test(ct)) return true;
  const local = fromAddress.split('@')[0] ?? '';
  return /^(mailer-daemon|postmaster)$/i.test(local);
}

export function threadRootOf(messageId: string, inReplyTo: string | undefined, references: string[]): string {
  return references[0] ?? inReplyTo ?? messageId;
}

/** Parses one raw message into an envelope (and records metadata needed to reply to it). */
export async function parseInbound(uid: number, raw: Buffer, deps: ParseDeps): Promise<InboundEnvelope> {
  const parsed = await simpleParser(raw);
  const messageId = parsed.messageId ?? `<sha256-${createHash('sha256').update(raw).digest('hex').slice(0, 32)}@generated.invalid>`;
  const references = asArray(parsed.references);
  const inReplyTo = parsed.inReplyTo?.trim() || undefined;
  const root = threadRootOf(messageId, inReplyTo, references);

  const from = parsed.from?.value[0];
  const fromAddress = (from?.address ?? '').toLowerCase();
  const fromDomain = fromAddress.split('@')[1] ?? '';

  const automated = isAutomated(parsed, fromAddress);
  const verdict: AuthVerdict = fromDomain ? await deps.verify(raw, fromDomain).catch(() => ({ evidence: 'none' as const })) : { evidence: 'none' };

  const sent = await deps.store.getSent(messageId);
  const ours = sent !== undefined;
  // Declared identity comes only from the header, only on mail we sent ourselves, and only if it matches what we recorded.
  const header = headerString(parsed, SENDER_HEADER)?.trim();
  const declared = ours && header && sent.as === header ? header : undefined;

  const subject = parsed.subject?.trim() ?? '';
  const { body, quoted } = splitQuote(parsed.text ?? '');
  const content: ContentBlock[] = [{ type: 'text', text: subject ? `Subject: ${subject}\n\n${body}` : body }];
  if (quoted) content.push({ type: 'quote', text: truncate(quoted, QUOTE_MAX_CHARS), ...(inReplyTo ? { fromMessageId: inReplyTo } : {}) });

  let index = 0;
  for (const att of parsed.attachments) {
    if (att.related) continue; // inline images of the HTML body
    const i = index++;
    await deps.blobs.put({ uid, index: i, filename: att.filename, contentType: att.contentType, content: att.content });
    content.push({ type: 'ref', uri: `mail-attachment:${uid}/${i}`, title: att.filename ?? `attachment-${i}` });
  }

  const meta: MessageMeta = {
    replyTo: (parsed.replyTo?.value[0]?.address ?? fromAddress).toLowerCase(),
    subject,
    references: [...references, messageId],
    threadRoot: root,
  };
  await deps.store.putMeta(messageId, meta);

  const env: InboundEnvelope = {
    v: PROTOCOL_VERSION,
    id: messageId,
    channel: deps.channel,
    account: deps.account,
    conversation: { id: root, kind: 'mail' },
    sender: {
      channelUserId: fromAddress,
      ...(from?.name ? { displayName: from.name } : {}),
      evidence: verdict.evidence,
      ...(declared ? { declared } : {}),
    },
    content,
    // Our own mail echoed back must not trigger a reply to ourselves.
    replyRoute: ours ? null : { channel: deps.channel, account: deps.account, conversationId: root, replyToMessageId: messageId },
    ...(automated ? { admission: 'drop' as const } : ours ? { admission: 'observe' as const } : {}),
    ...(parsed.date ? { sentAt: parsed.date.getTime() } : {}),
    raw: { uid, subject, inReplyTo, references, auth: verdict.detail },
  };
  return env;
}
