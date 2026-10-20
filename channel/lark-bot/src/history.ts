import type { ContentBlock, HistoryScope, InboundEnvelope } from '@agents-io/protocol';
import { LarkApiError, call } from './cardkit.js';
import type { ResolvedConfig } from './config.js';
import type { InboundEnricher } from './enrich.js';
import { CHANNEL_ID, mapMessageEvent, messageText } from './inbound.js';
import type { LarkClientLike, LarkMessageItem, RawMessageEvent } from './types.js';

/**
 * Earlier messages of a chat or thread for `ChannelAdapter.history` (docs/CHANNELS.md §1c):
 * `im.v1.message.list`, newest first, mapped like inbound events (text and post flattened,
 * mentions as `@name`, media as `lark-file:` refs, nothing downloaded), oldest first in the
 * result. Best effort: every failure is logged and answers [] (a missing permission once,
 * then the feature rests for `degradeTtlMs`).
 */
export interface HistoryDeps {
  client: () => LarkClientLike;
  cfg: ResolvedConfig;
  /** The account the adapter receives as (`start`). */
  account: () => string;
  botOpenId: () => string | undefined;
  enricher: InboundEnricher;
  /** union_id behind an open_id, learnt from inbound events. */
  unionOf: (openId: string) => string | undefined;
  /** Remember union_id → open_id (outbound at tags need the open_id). */
  learn: (unionId: string, openId: string) => void;
  now: () => number;
  log: (level: 'debug' | 'info' | 'warn', msg: string) => void;
}

/** One page of `message.list` holds at most 50. */
const PAGE_MAX = 50;
/** Codes that mean the app lacks a scope (`230027` no permission, `9999167x` scope not granted): no history for the app, not one chat. */
const PERMISSION_CODES = new Set([230027, 99991672, 99991679, 99991663]);

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 200);

export class HistoryFetcher {
  /** History rests until then after a permission error. */
  private offUntil = 0;
  private permissionWarned = false;

  constructor(private readonly d: HistoryDeps) {}

  /** Never rejects. */
  async fetch(env: InboundEnvelope, scope: HistoryScope): Promise<InboundEnvelope[]> {
    const limit = this.d.cfg.historyOnMention[scope];
    if (!limit || env.channel !== CHANNEL_ID || env.account !== this.d.account()) return [];
    const container = scope === 'thread' ? env.conversation.threadId : env.conversation.id;
    if (!container || this.d.now() < this.offUntil) return [];
    const api = this.d.client().im.v1.message.list?.bind(this.d.client().im.v1.message);
    if (!api) return [];
    let items: LarkMessageItem[];
    try {
      items = await this.list(api, scope, container, env, limit);
    } catch (e) {
      const code = e instanceof LarkApiError ? e.code : undefined;
      if (code !== undefined && PERMISSION_CODES.has(code)) {
        this.offUntil = this.d.now() + this.d.cfg.degradeTtlMs;
        // One warning: every @ would repeat it until the scopes are granted.
        this.d.log(this.permissionWarned ? 'debug' : 'warn', `lark history off for ${Math.round(this.d.cfg.degradeTtlMs / 60_000)} min: the app needs im:message:readonly (and im:message.group_msg in groups) to read earlier messages: ${errText(e)}`);
        this.permissionWarned = true;
      } else {
        this.d.log('warn', `lark ${scope} history of ${container} not read: ${errText(e)}`);
      }
      return [];
    }
    const before = env.sentAt;
    const kept = items
      .filter((i) => i.message_id && i.message_id !== env.id && !i.deleted && i.msg_type !== 'system')
      .filter((i) => before === undefined || !(Number(i.create_time) > before))
      .slice(0, limit)
      .reverse();
    const byId = new Map(kept.map((i) => [i.message_id!, i]));
    // Names (and union_ids) of the people in it, in parallel and cached: the mapping below then reads the cache.
    const users = new Set(kept.filter((i) => i.sender?.sender_type === 'user' && i.sender.id).map((i) => i.sender!.id));
    await Promise.all([...users].map((id) => this.d.enricher.contact(this.d.unionOf(id) ?? id)));
    const out: InboundEnvelope[] = [];
    for (const i of kept) {
      try {
        const e = await this.envelope(i, env, scope, byId);
        if (e) out.push(e);
      } catch (err) {
        this.d.log('debug', `lark history message ${i.message_id} skipped: ${errText(err)}`);
      }
    }
    return out;
  }

  /** Newest first, at most `limit` (+1: the trigger may be among them), paged. */
  private async list(api: NonNullable<LarkClientLike['im']['v1']['message']['list']>, scope: HistoryScope, container: string, env: InboundEnvelope, limit: number): Promise<LarkMessageItem[]> {
    const out: LarkMessageItem[] = [];
    let token: string | undefined;
    const want = limit + 1;
    for (let page = 0; out.length < want && page < Math.ceil(want / PAGE_MAX) + 1; page++) {
      const res = await call('message.list', this.d.cfg.lookupTimeoutMs, () =>
        api({
          params: {
            container_id_type: scope,
            container_id: container,
            sort_type: 'ByCreateTimeDesc',
            page_size: Math.min(PAGE_MAX, want - out.length),
            card_msg_content_type: 'user_card_content',
            // Chats take a time window (seconds; threads do not): nothing after the @.
            ...(scope === 'chat' && env.sentAt !== undefined ? { end_time: String(Math.ceil(env.sentAt / 1000)) } : {}),
            ...(token ? { page_token: token } : {}),
          },
        }),
      );
      out.push(...(res.data?.items ?? []));
      token = res.data?.page_token;
      if (!res.data?.has_more || !token) break;
    }
    return out;
  }

  /** A listed message as an envelope like the receive event would give (observe-only, nothing downloaded). */
  private async envelope(i: LarkMessageItem, trigger: InboundEnvelope, scope: HistoryScope, byId: Map<string, LarkMessageItem>): Promise<InboundEnvelope | undefined> {
    const s = i.sender;
    if (!s?.id) return undefined;
    const bot = this.d.botOpenId();
    let sender: { open_id?: string; union_id?: string };
    let channelUserId: string;
    let isBot = false;
    let displayName: string | undefined;
    if (s.sender_type === 'user') {
      const openId = s.id;
      // Looked up the way inbound events are (by union_id once known), so the name cache is shared.
      const known = this.d.unionOf(openId);
      const contact = await this.d.enricher.contact(known ?? openId);
      const unionId = known ?? contact.unionId;
      if (unionId) this.d.learn(unionId, openId);
      displayName = contact.name;
      sender = { open_id: openId, ...(unionId ? { union_id: unionId } : {}) };
      // The id inbound events use (union_id first), so identities and mentions match.
      channelUserId = unionId ?? openId;
    } else if (s.sender_type === 'app') {
      isBot = true;
      // This bot: the open_id its echoes carry (the outbound index recognises the message itself); another app: its app_id.
      const own = s.id === this.d.cfg.appId;
      channelUserId = own && bot ? bot : s.id;
      sender = { open_id: channelUserId };
    } else return undefined;
    const raw: RawMessageEvent = {
      sender: { sender_id: sender, sender_type: s.sender_type },
      message: {
        message_id: i.message_id!,
        ...(i.root_id ? { root_id: i.root_id } : {}),
        ...(i.parent_id ? { parent_id: i.parent_id } : {}),
        ...(i.create_time ? { create_time: i.create_time } : {}),
        chat_id: trigger.conversation.id,
        // A chat's topic root was a plain chat message when it was sent; a thread's messages stay in the thread.
        ...(scope === 'thread' && trigger.conversation.threadId ? { thread_id: trigger.conversation.threadId } : {}),
        chat_type: 'group',
        message_type: i.msg_type ?? 'unknown',
        content: i.body?.content ?? '',
        mentions: (i.mentions ?? []).map((m) => ({ key: m.key, id: { open_id: m.id }, name: m.name })),
      },
    };
    const env = mapMessageEvent(raw, { account: trigger.account, botOpenId: bot, declared: undefined });
    if (!env) return undefined;
    const content = env.content.flatMap((b): ContentBlock[] => {
      if (b.type !== 'quote' || b.text || !b.fromMessageId) return [b];
      // The replied-to message, when it is among the fetched ones; otherwise no quote (no lookup per message).
      const parent = byId.get(b.fromMessageId);
      if (!parent) return [];
      const t = messageText(parent.msg_type, parent.body?.content, parent.mentions).trim();
      const max = this.d.cfg.quoteMaxChars;
      return t ? [{ ...b, text: t.length > max ? t.slice(0, max - 1).trimEnd() + '…' : t }] : [];
    });
    const { raw: _raw, ...rest } = env;
    return {
      ...rest,
      content,
      sender: { channelUserId, ...(displayName ? { displayName } : {}), ...(isBot ? { isBot: true } : {}), evidence: 'platform_signed' },
      admission: 'observe',
    };
  }
}
