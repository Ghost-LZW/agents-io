import { PROTOCOL_VERSION, type InboundEnvelope } from '@agents-io/protocol';
import type { ResolvedConfig } from './config.js';
import { CHANNEL_ID, messageText, senderId } from './inbound.js';
import type { LarkClientLike, RawReactionEvent } from './types.js';

/**
 * People's emoji reactions on this bot's messages (`config.reactions`, docs/CHANNELS.md §2).
 * Neither reaction event names the chat or the author of the message, so the message is looked
 * up (`im.v1.message.get`): only this app's own answers and output-tool messages count, and the
 * chat's kind comes from the inbound messages seen since the start or, failing that,
 * `im.v1.chat.get`. A reaction is never addressed to the deployment: the envelope is `observe`.
 */

export type ReactionAction = 'added' | 'removed';

/** Where a message of this bot is, and what it said (for the agent: which message the reaction is on). */
export interface Placement {
  chatId: string;
  threadId?: string;
  kind: 'dm' | 'group' | 'thread';
  text: string;
}

/** This bot's messages that are part of a conversation (a thinking bubble is not). */
const OWN_TYPES = new Set(['text', 'post', 'interactive', 'image', 'file', 'audio', 'media']);
const CACHE_MAX = 2000;

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 200);

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  const timer = new Promise<never>((_, reject) => (t = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms)));
  return Promise.race([p, timer]).finally(() => clearTimeout(t));
}

function put<K, V>(m: Map<K, V>, k: K, v: V): void {
  m.delete(k);
  m.set(k, v);
  if (m.size > CACHE_MAX) {
    const oldest = m.keys().next();
    if (!oldest.done) m.delete(oldest.value);
  }
}

/**
 * The reaction as an inbound envelope, or undefined when it is not one to pass on: by an app
 * (this bot's own acknowledgements, other bots'), without an emoji, a message or a person.
 */
export function mapReaction(ev: RawReactionEvent, action: ReactionAction, at: Placement, ctx: { account: string }): InboundEnvelope | undefined {
  // `app_id` cannot tell: on a person's reaction the header's (this app's own) shows through.
  if (ev.operator_type !== 'user') return undefined;
  const emoji = ev.reaction_type?.emoji_type;
  const messageId = ev.message_id;
  const sid = senderId(ev.user_id);
  if (!emoji || !messageId || !sid) return undefined;
  const when = Number(ev.action_time);
  // Distinct per event: adding, removing and adding again are three inputs. Never the message's own
  // id, which the outbound index knows as this deployment's (it would be taken for an echo).
  const id = `reaction:${ev.event_id || `${messageId}:${sid}:${emoji}:${action}:${ev.action_time ?? ''}`}`;
  return {
    v: PROTOCOL_VERSION,
    id,
    channel: CHANNEL_ID,
    account: ctx.account,
    conversation: { id: at.chatId, kind: at.kind, ...(at.threadId ? { threadId: at.threadId } : {}) },
    sender: { channelUserId: sid, evidence: 'platform_signed' },
    content: [{ type: 'event', name: 'reaction', data: { emoji, action, messageId, text: at.text } }],
    replyRoute: {
      channel: CHANNEL_ID,
      account: ctx.account,
      conversationId: at.chatId,
      ...(at.threadId ? { threadId: at.threadId } : {}),
      replyToMessageId: messageId,
    },
    // A reaction is never addressed to the deployment: context for the conversation's next turn.
    admission: 'observe',
    ...(Number.isFinite(when) && when > 0 ? { sentAt: when } : {}),
    raw: ev,
  };
}

export interface ReactionDeps {
  client: () => LarkClientLike;
  cfg: ResolvedConfig;
  /** The chat's kind as inbound messages showed it, and where a looked-up one is kept. */
  chatKind: (chatId: string) => 'dm' | 'group' | undefined;
  learnChatKind: (chatId: string, kind: 'dm' | 'group') => void;
  /** A thinking bubble this process opened: a message of the bot's, but no part of the conversation. */
  isBubble: (messageId: string) => boolean;
  log: (level: 'debug' | 'info' | 'warn', msg: string) => void;
}

export class ReactionPlacer {
  /** message id → where it is (null: not one of this bot's conversation messages). */
  private readonly placed = new Map<string, Placement | null>();
  private chatWarned = false;

  constructor(private readonly d: ReactionDeps) {}

  /**
   * Where a reacted-to message is if this bot sent it; null when it is someone else's (or a
   * bubble), or when it cannot be told (lookup failed: logged, not cached).
   */
  async placement(messageId: string): Promise<Placement | null> {
    if (this.placed.has(messageId)) return this.placed.get(messageId)!;
    let item;
    try {
      const res = await withTimeout(
        this.d.client().im.v1.message.get({ path: { message_id: messageId }, params: { card_msg_content_type: 'user_card_content' } }),
        this.d.cfg.lookupTimeoutMs,
        'message.get',
      );
      if (res?.code) throw new Error(`message.get ${res.code}: ${res.msg ?? ''}`);
      const items = res?.data?.items ?? [];
      item = items.find((i) => i.message_id === messageId) ?? items[0];
      if (!item) throw new Error('message.get returned no item');
    } catch (e) {
      this.d.log('warn', `reaction on ${messageId} not passed on: the message could not be read: ${errText(e)}`);
      return null;
    }
    const own = item.sender?.sender_type === 'app' && item.sender.id === this.d.cfg.appId;
    if (!own || !OWN_TYPES.has(item.msg_type ?? '') || this.d.isBubble(messageId) || !item.chat_id) {
      put(this.placed, messageId, null);
      return null;
    }
    const threadId = item.thread_id || undefined;
    const kind = threadId ? 'thread' : await this.chatKind(item.chat_id);
    if (!kind) return null;
    const raw = (item.deleted ? '[deleted message]' : messageText(item.msg_type, item.body?.content, item.mentions)).replace(/\n{3,}/g, '\n\n').trim();
    const max = this.d.cfg.quoteMaxChars;
    const text = raw.length > max ? raw.slice(0, max - 1).trimEnd() + '…' : raw;
    const p: Placement = { chatId: item.chat_id, ...(threadId ? { threadId } : {}), kind, text };
    put(this.placed, messageId, p);
    return p;
  }

  /** `dm` or `group`, from what inbound messages showed, else `im.v1.chat.get` (`chat_mode`). */
  private async chatKind(chatId: string): Promise<'dm' | 'group' | undefined> {
    const known = this.d.chatKind(chatId);
    if (known) return known;
    try {
      const res = (await withTimeout(
        this.d.client().request({ method: 'GET', url: `/open-apis/im/v1/chats/${encodeURIComponent(chatId)}`, timeout: this.d.cfg.lookupTimeoutMs }),
        this.d.cfg.lookupTimeoutMs,
        'chat.get',
      )) as { code?: number; msg?: string; data?: { chat_mode?: string } } | undefined;
      if (res?.code) throw new Error(`chat.get ${res.code}: ${res.msg ?? ''}`);
      const mode = res?.data?.chat_mode;
      if (!mode) throw new Error('chat.get returned no chat_mode');
      const kind = mode === 'p2p' ? 'dm' : 'group';
      this.d.learnChatKind(chatId, kind);
      return kind;
    } catch (e) {
      // Without the kind the reaction cannot be routed like the chat's messages: dropped.
      const msg = `reaction in ${chatId} not passed on: the chat's kind is unknown (no message of it since the start, and im.v1.chat.get failed: ${errText(e)}; needs im:chat:readonly)`;
      if (!this.chatWarned) {
        this.chatWarned = true;
        this.d.log('warn', msg);
      } else this.d.log('debug', msg);
      return undefined;
    }
  }
}
