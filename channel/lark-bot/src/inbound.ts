import { PROTOCOL_VERSION, type ContentBlock, type InboundEnvelope } from '@agents-io/protocol';
import type { RawCardActionEvent, RawMessageEvent } from './types.js';

export const CHANNEL_ID = 'lark-bot';

/** `lark-file:<message_id>/<file_key>`: the platform ref of a message resource. With a host blob store the adapter downloads it (enrich.ts) and emits a `sha256:` ref instead; this one remains only when that is not possible. */
export const larkFileRef = (messageId: string, key: string) => `lark-file:${messageId}/${key}`;

type Mention = NonNullable<RawMessageEvent['message']['mentions']>[number];

export interface MapContext {
  account: string;
  botOpenId: string | undefined;
  /** Sender declared for this message when this bot sent it (looked up by the adapter from its store). */
  declared: string | undefined;
}

/**
 * Sender id choice: `union_id` when the event carries it (stable across the apps of one
 * developer tenant, so identity bindings survive moving to another bot), else `open_id`
 * (scoped to this app), else `user_id`. The same user can therefore appear under either
 * form depending on app permissions; hosts that bind identities should bind per-channel.
 */
export function senderId(id: { union_id?: string; open_id?: string; user_id?: string } | undefined): string | undefined {
  return id?.union_id || id?.open_id || id?.user_id || undefined;
}

export function isBotMentioned(mentions: Mention[] | undefined, botOpenId: string | undefined): boolean {
  if (!botOpenId) return false;
  return (mentions ?? []).some((m) => m.id?.open_id === botOpenId);
}

function safeParse(s: string): Record<string, any> {
  try {
    const v = JSON.parse(s);
    return v && typeof v === 'object' ? (v as Record<string, any>) : {};
  } catch {
    return {};
  }
}

/** Replace `@_user_1` placeholders: the bot's own mention is removed, others become `@name`. */
function normalizeMentions(text: string, mentions: Mention[] | undefined, botOpenId: string | undefined): string {
  let out = text;
  for (const m of mentions ?? []) {
    const isBot = !!botOpenId && m.id?.open_id === botOpenId;
    out = out.split(m.key).join(isBot ? '' : `@${m.name ?? 'user'}`);
  }
  return out.replace(/[ \t]{2,}/g, ' ').trim();
}

/** Flatten a `post` (rich text) body into markdown-ish text plus the media it references. */
function flattenPost(
  content: Record<string, any>,
  messageId: string,
  mentions: Mention[] | undefined,
  botOpenId: string | undefined,
): { text: string; media: ContentBlock[] } {
  // Either `{title, content}` or locale-wrapped `{zh_cn: {title, content}}`.
  const body: any = Array.isArray(content.content) ? content : (Object.values(content).find((v) => v && typeof v === 'object') ?? {});
  const media: ContentBlock[] = [];
  const lines: string[] = [];
  if (typeof body.title === 'string' && body.title) lines.push(body.title);
  for (const para of (Array.isArray(body.content) ? body.content : []) as any[][]) {
    let line = '';
    for (const el of Array.isArray(para) ? para : []) {
      switch (el?.tag) {
        case 'text':
          line += el.text ?? '';
          break;
        case 'a':
          line += el.href ? `[${el.text ?? el.href}](${el.href})` : (el.text ?? '');
          break;
        case 'at': {
          const m = (mentions ?? []).find((x) => x.key === el.user_id);
          const isBot = !!botOpenId && (m?.id?.open_id === botOpenId || el.user_id === botOpenId);
          if (!isBot) line += `@${el.user_name ?? m?.name ?? 'user'}`;
          break;
        }
        case 'img':
          if (el.image_key) media.push({ type: 'image', ref: larkFileRef(messageId, el.image_key), mime: 'image/*' });
          break;
        case 'media':
          if (el.file_key) media.push({ type: 'file', ref: larkFileRef(messageId, el.file_key), mime: 'video/*' });
          break;
        case 'md':
        case 'code_block':
          line += el.text ?? '';
          break;
        default:
          break;
      }
    }
    lines.push(line);
  }
  return { text: lines.join('\n').trim(), media };
}

/** Strings under `text`/`content`/`title` keys of a card's JSON, in order (nested JSON strings included). */
function cardText(v: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 12) return out;
  if (Array.isArray(v)) for (const x of v) cardText(x, out, depth + 1);
  else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (typeof x === 'string' && (k === 'text' || k === 'content' || k === 'title')) {
        const t = x.trim();
        if (t.startsWith('{') || t.startsWith('[')) cardText(safeParse(t), out, depth + 1);
        else if (t && out.at(-1) !== t) out.push(t);
      } else if (typeof x === 'object') cardText(x, out, depth + 1);
    }
  }
  return out;
}

/**
 * Plain text of a message as `im.v1.message.get` returns it, for a quote block:
 * text and post bodies flattened (mention placeholders become `@name`), cards reduced to
 * their visible strings, media as a bracketed placeholder.
 */
export function messageText(msgType: string | undefined, rawContent: string | undefined, mentions: { key: string; name?: string }[] = []): string {
  const c = safeParse(rawContent ?? '');
  const named = (t: string) => mentions.reduce((acc, m) => acc.split(m.key).join(`@${m.name ?? 'user'}`), t);
  switch (msgType) {
    case 'text':
      return named(String(c.text ?? '')).trim();
    case 'post': {
      const { text, media } = flattenPost(c, '', [], undefined);
      return [named(text), ...media.map((m) => `[${m.type}]`)].filter(Boolean).join('\n');
    }
    case 'interactive':
      return cardText(c).join('\n');
    case 'image':
      return '[image]';
    case 'file':
      return `[file${c.file_name ? ` ${c.file_name}` : ''}]`;
    case 'audio':
      return '[audio]';
    case 'media':
      return `[video${c.file_name ? ` ${c.file_name}` : ''}]`;
    case 'sticker':
      return '[sticker]';
    default:
      return `[${msgType ?? 'unknown'} message]`;
  }
}

export function mapMessageEvent(ev: RawMessageEvent, ctx: MapContext): InboundEnvelope | undefined {
  const msg = ev.message;
  if (!msg?.message_id || !msg.chat_id) return undefined;
  const sid = senderId(ev.sender?.sender_id);
  if (!sid) return undefined;

  const parsed = safeParse(msg.content);
  const content: ContentBlock[] = [];
  const mid = msg.message_id;
  switch (msg.message_type) {
    case 'text': {
      const t = normalizeMentions(String(parsed.text ?? ''), msg.mentions, ctx.botOpenId);
      if (t) content.push({ type: 'text', text: t });
      break;
    }
    case 'post': {
      const { text, media } = flattenPost(parsed, mid, msg.mentions, ctx.botOpenId);
      if (text) content.push({ type: 'text', text });
      content.push(...media);
      break;
    }
    case 'image':
      if (parsed.image_key) content.push({ type: 'image', ref: larkFileRef(mid, parsed.image_key), mime: 'image/*' });
      break;
    case 'file':
      if (parsed.file_key)
        content.push({
          type: 'file',
          ref: larkFileRef(mid, parsed.file_key),
          mime: 'application/octet-stream',
          ...(parsed.file_name ? { name: String(parsed.file_name) } : {}),
        });
      break;
    case 'audio':
      if (parsed.file_key) content.push({ type: 'audio', ref: larkFileRef(mid, parsed.file_key), mime: 'audio/*' });
      break;
    case 'media':
      if (parsed.file_key)
        content.push({
          type: 'file',
          ref: larkFileRef(mid, parsed.file_key),
          mime: 'video/*',
          ...(parsed.file_name ? { name: String(parsed.file_name) } : {}),
        });
      break;
    default:
      content.push({ type: 'text', text: `[unsupported ${msg.message_type} message]` });
  }

  // A reply to an earlier message (not merely a thread member replying within its own thread).
  if (msg.parent_id && (!msg.root_id || msg.parent_id !== msg.root_id)) {
    content.unshift({ type: 'quote', text: '', fromMessageId: msg.parent_id });
  }

  const inThread = !!(msg.thread_id || msg.root_id);
  const isDm = msg.chat_type === 'p2p';
  const kind = isDm ? 'dm' : inThread ? 'thread' : 'group';
  const threadId = msg.thread_id || msg.root_id || undefined;
  const isBot = ev.sender?.sender_type === 'app';
  const echo = ctx.botOpenId !== undefined && ev.sender?.sender_id?.open_id === ctx.botOpenId;
  const declared = isBot || echo ? ctx.declared : undefined;
  const mentioned = isBotMentioned(msg.mentions, ctx.botOpenId);

  const createMs = Number(msg.create_time ?? ev.create_time);
  return {
    v: PROTOCOL_VERSION,
    id: mid,
    channel: CHANNEL_ID,
    account: ctx.account,
    conversation: { id: msg.chat_id, kind, ...(threadId ? { threadId } : {}) },
    sender: {
      channelUserId: sid,
      ...(isBot ? { isBot: true } : {}),
      evidence: 'platform_signed',
      ...(declared ? { declared } : {}),
    },
    content,
    replyRoute: {
      channel: CHANNEL_ID,
      account: ctx.account,
      conversationId: msg.chat_id,
      ...(threadId ? { threadId } : {}),
      replyToMessageId: mid,
    },
    // Own echoes are never work; in groups only an @mention of the bot asks for a reply.
    admission: echo ? 'observe' : isDm || mentioned ? 'dispatch' : 'observe',
    ...(Number.isFinite(createMs) ? { sentAt: createMs } : {}),
    raw: { mentions: msg.mentions ?? [], messageType: msg.message_type, botMentioned: mentioned, event: ev },
  };
}

export function mapCardAction(ev: RawCardActionEvent, ctx: Pick<MapContext, 'account'>): InboundEnvelope | undefined {
  const sid = senderId(ev.operator);
  const messageId = ev.context?.open_message_id;
  const chatId = ev.context?.open_chat_id;
  if (!sid || !messageId || !chatId) return undefined;
  const value = ev.action?.value;
  const actionId =
    (value && typeof value === 'object' && typeof (value as any).actionId === 'string' ? (value as any).actionId : undefined) ??
    ev.action?.name ??
    '';
  const key = ev.event_id ?? ev.token ?? `${messageId}:${actionId}:${Date.now()}`;
  return {
    v: PROTOCOL_VERSION,
    id: `card:${key}`,
    channel: CHANNEL_ID,
    account: ctx.account,
    // Group vs DM is not in the callback payload; hosts key policy off conversation.id.
    conversation: { id: chatId, kind: 'other' },
    sender: { channelUserId: sid, ...(ev.operator?.name ? { displayName: ev.operator.name } : {}), evidence: 'platform_signed' },
    content: [
      {
        type: 'event',
        name: 'action',
        data: {
          actionId,
          messageId,
          value: value ?? null,
          // A submitted card form (e.g. an ask_choice multi-select): field name → value(s).
          ...(ev.action?.form_value && typeof ev.action.form_value === 'object' ? { formValue: ev.action.form_value as Record<string, unknown> } : {}),
        },
      },
    ],
    replyRoute: { channel: CHANNEL_ID, account: ctx.account, conversationId: chatId, replyToMessageId: messageId },
    admission: 'dispatch',
    raw: ev,
  };
}
