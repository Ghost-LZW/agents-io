import type { DatabaseSync, StatementSync } from 'node:sqlite';
import type { IdentityEntry, InboundEnvelope, InboundItem, InputRecord, Origin, RenderedMessage, ReplyRoute } from '@agents-io/protocol';
import { routeKey } from '@agents-io/protocol';
import type { IngressResult } from '@agents-io/session';

/**
 * Messages from people the deployment does not know, addressed to it (a DM, or an @ in a
 * group), when `policy.strangers` is `ask` (decision 15): the owner gets one card per sender
 * and chat with "allow once / always / ignore". Allowing sends the held messages to the chat's
 * session as they arrived (original sender, `restricted` like any non-owner turn); "always"
 * also keeps the sender as a `guest` identity, whose later messages go there without asking.
 * Who is trusted stays the owner's call; this only asks.
 */

export const GUEST_LABEL = 'guest';
const ACTION_PREFIX = 'aio:stranger:';
type Answer = 'once' | 'always' | 'ignore';
const ANSWERS: readonly Answer[] = ['once', 'always', 'ignore'];
/** Messages held per ask; later ones are counted, not kept. */
const MAX_HELD = 20;

interface Ask {
  id: number;
  /** `channel:account:conversation[:thread]:sender` — one open ask per sender and chat. */
  key: string;
  state: 'open' | Answer;
  sender: { channel: string; channelUserId: string; name?: string };
  where: string;
  held: { input: InputRecord; envelope: InboundEnvelope; receivedAt: number }[];
  dropped: number;
  card?: { route: ReplyRoute; providerMessageId: string };
}

export interface StrangersOptions {
  db: DatabaseSync;
  /** Where the question goes: the owner's own chat with the deployment; null while unknown. */
  ownerRoute: () => ReplyRoute | null;
  /** Send (through the outbox) on a route; resolves the platform message id when delivered. */
  send: (route: ReplyRoute, msg: RenderedMessage, operationId: string) => Promise<string | undefined>;
  /** Replace an earlier message (the card, once answered). Failures are only logged. */
  edit: (route: ReplyRoute, providerMessageId: string, msg: RenderedMessage) => Promise<void>;
  /** Deliver a held input to its chat's session, as it arrived. */
  admit: (item: InboundItem, session: 'per-conversation' | 'per-thread') => Promise<{ ok: boolean; message?: string }>;
  /** The guests changed: identify them from now on. */
  onGuests: (entries: IdentityEntry[]) => void;
  /** Ask about `channel:channelUserId` senders on these channels only (default: every channel but mail). */
  channels?: (channel: string) => boolean;
  log: (level: 'info' | 'warn', msg: string) => void;
  now?: () => number;
}

export class Strangers {
  private readonly q: Record<'askGet' | 'askOpen' | 'askPut' | 'askNew' | 'guestAll' | 'guestPut', StatementSync>;
  private readonly now: () => number;

  constructor(private readonly o: StrangersOptions) {
    this.now = o.now ?? Date.now;
    o.db.exec(`
      CREATE TABLE IF NOT EXISTS daemon_stranger_asks (id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL, state TEXT NOT NULL, at INTEGER NOT NULL, json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS daemon_stranger_asks_open ON daemon_stranger_asks (key, state);
      CREATE TABLE IF NOT EXISTS daemon_guests (key TEXT PRIMARY KEY, at INTEGER NOT NULL, json TEXT NOT NULL) WITHOUT ROWID;
    `);
    const p = (sql: string) => o.db.prepare(sql);
    this.q = {
      askGet: p('SELECT json FROM daemon_stranger_asks WHERE id = ?'),
      askOpen: p("SELECT json FROM daemon_stranger_asks WHERE key = ? AND state = 'open' ORDER BY id DESC LIMIT 1"),
      askPut: p('UPDATE daemon_stranger_asks SET state = ?, json = ? WHERE id = ?'),
      askNew: p("INSERT INTO daemon_stranger_asks (key, state, at, json) VALUES (?, 'open', ?, '{}')"),
      guestAll: p('SELECT json FROM daemon_guests ORDER BY at'),
      guestPut: p('INSERT INTO daemon_guests (key, at, json) VALUES (?, ?, ?) ON CONFLICT(key) DO NOTHING'),
    };
    this.o.onGuests(this.guests());
  }

  guests(): IdentityEntry[] {
    return (this.q.guestAll.all() as { json: string }[]).map((r) => JSON.parse(r.json) as IdentityEntry);
  }

  /**
   * An input no rule dispatched (Ingress `onUndispatched`). Acts only on a person's message with
   * platform evidence, addressed to the deployment, on a chat channel: a guest's goes to its
   * session, anyone else's is held and asked about. Everything else is left as routed.
   */
  async undispatched(a: { env: InboundEnvelope; origin: Origin; input: InputRecord }, addressed: boolean): Promise<void> {
    const { env, origin, input } = a;
    if (!addressed || !env.replyRoute || origin.kind !== 'human' || origin.self) return;
    if (origin.evidence !== 'platform_signed' && origin.evidence !== 'dkim_pass') return;
    if (!(this.o.channels ?? ((c) => c !== 'mail'))(env.channel)) return;
    if (isClick(env)) return;
    const labels = origin.principal?.labels ?? [];
    if (labels.includes('owner')) return;
    const session = env.conversation.kind === 'dm' ? 'per-conversation' : 'per-thread';
    const held = { input, envelope: withoutRaw(env), receivedAt: this.now() };
    if (labels.includes(GUEST_LABEL)) {
      const r = await this.o.admit(item(held, 0), session);
      if (!r.ok) this.o.log('warn', `guest ${env.channel}:${env.sender.channelUserId}: not delivered: ${r.message ?? 'refused'}`);
      return;
    }
    const key = `${routeKey(env.replyRoute)}:${env.sender.channelUserId}`;
    const open = this.q.askOpen.get(key) as { json: string } | undefined;
    if (open) {
      const ask = JSON.parse(open.json) as Ask;
      if (ask.held.length < MAX_HELD) ask.held.push(held);
      else ask.dropped++;
      this.save(ask);
      return;
    }
    const to = this.o.ownerRoute();
    if (!to) {
      this.o.log('warn', `a message from ${env.channel}:${env.sender.channelUserId} was not asked about: the owner's chat is not known yet (message the deployment once)`);
      return;
    }
    const id = Number((this.q.askNew.run(key, this.now()) as { lastInsertRowid: number | bigint }).lastInsertRowid);
    const ask: Ask = {
      id,
      key,
      state: 'open',
      sender: { channel: env.channel, channelUserId: env.sender.channelUserId, ...(env.sender.displayName ? { name: env.sender.displayName } : {}) },
      where: env.conversation.kind === 'dm' ? 'a direct message' : `a ${env.conversation.kind}${typeof env.context?.chatName === 'string' ? ` (${env.context.chatName})` : ''}`,
      held: [held],
      dropped: 0,
    };
    this.save(ask);
    const providerMessageId = await this.o.send(to, this.card(ask), `stranger:${id}:ask`);
    if (providerMessageId) this.save({ ...ask, card: { route: to, providerMessageId } });
  }

  /** A click on an ask's button (Ingress `onAction`); undefined for any other action id. */
  async action(a: { actionId: string; origin: Origin }): Promise<IngressResult | undefined> {
    if (!a.actionId.startsWith(ACTION_PREFIX)) return undefined;
    const [idText, answer] = a.actionId.slice(ACTION_PREFIX.length).split(':');
    const done = (ok: boolean, reason?: string): IngressResult => ({ accepted: true, action: 'command', origin: a.origin, result: ok ? { ok: true } : { ok: false, reason: reason ?? 'refused' } });
    if (!(a.origin.principal?.labels ?? []).includes('owner')) return done(false, 'not_owner');
    const row = this.q.askGet.get(Number(idText)) as { json: string } | undefined;
    if (!row || !ANSWERS.includes(answer as Answer)) return done(false, 'unknown_request');
    const ask = { ...(JSON.parse(row.json) as Ask), id: Number(idText) };
    if (ask.state !== 'open') return done(false, 'already_answered');
    ask.state = answer as Answer;
    this.save(ask);
    if (ask.state === 'always') {
      const entry: IdentityEntry = { channel: ask.sender.channel, channelUserId: ask.sender.channelUserId, principal: `${ask.sender.channel}:${ask.sender.channelUserId}`, labels: [GUEST_LABEL] };
      this.q.guestPut.run(`${entry.channel}:${entry.channelUserId}`, this.now(), JSON.stringify(entry));
      this.o.onGuests(this.guests());
    }
    let failed = 0;
    if (ask.state !== 'ignore') {
      for (const [i, h] of ask.held.entries()) {
        const session = h.envelope.conversation.kind === 'dm' ? 'per-conversation' : 'per-thread';
        const r = await this.o.admit(item(h, ask.id * 1000 + i), session);
        if (!r.ok) {
          failed++;
          this.o.log('warn', `stranger ask ${ask.id}: message ${i + 1} not delivered: ${r.message ?? 'refused'}`);
        }
      }
    }
    if (ask.card) await this.o.edit(ask.card.route, ask.card.providerMessageId, this.card(ask, failed)).catch((e: Error) => this.o.log('warn', `stranger ask ${ask.id}: card not updated: ${e.message}`));
    return done(true);
  }

  private save(ask: Ask): void {
    this.q.askPut.run(ask.state, JSON.stringify(ask), ask.id);
  }

  private card(ask: Ask, failed = 0): RenderedMessage {
    const who = ask.sender.name ? `${ask.sender.name} (${ask.sender.channel}:${ask.sender.channelUserId})` : `${ask.sender.channel}:${ask.sender.channelUserId}`;
    const first = ask.held[0] ? quote(ask.held[0].envelope) : '';
    const more = ask.held.length + ask.dropped > 1 ? `\n(${ask.held.length + ask.dropped} messages)` : '';
    const head = `${who} wrote to the agent in ${ask.where}:\n${first}${more}`;
    if (ask.state === 'open') {
      return {
        text: `${head}\n\nLet the agent answer?`,
        actions: [
          { id: `${ACTION_PREFIX}${ask.id}:once`, label: 'Allow this time', style: 'primary' },
          { id: `${ACTION_PREFIX}${ask.id}:always`, label: 'Always allow' },
          { id: `${ACTION_PREFIX}${ask.id}:ignore`, label: 'Ignore' },
        ],
      };
    }
    const outcome = { once: 'Allowed this time.', always: `Allowed; ${who} is a guest from now on.`, ignore: 'Ignored.' }[ask.state];
    return { text: `${head}\n\n${outcome}${failed ? ` ${failed} message(s) could not be delivered.` : ''}` };
  }
}

function item(h: Ask['held'][number], cursor: number): InboundItem {
  return {
    cursor,
    channelRef: h.input.channelRef ?? `channel:${h.envelope.channel}/${h.envelope.id}`,
    account: h.envelope.account,
    bindingId: 'strangers',
    input: h.input,
    envelope: h.envelope,
    receivedAt: h.receivedAt,
  };
}

function withoutRaw(env: InboundEnvelope): InboundEnvelope {
  const { raw: _raw, ...rest } = env;
  return rest;
}

function isClick(env: InboundEnvelope): boolean {
  return env.content.length === 1 && env.content[0]!.type === 'event';
}

function quote(env: InboundEnvelope): string {
  const text = env.content
    .map((c) => (c.type === 'text' ? c.text : c.type === 'image' ? '[image]' : c.type === 'file' ? `[file${c.name ? ` ${c.name}` : ''}]` : c.type === 'audio' ? '[audio]' : ''))
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  return `> ${text.length > 300 ? `${text.slice(0, 299)}…` : text || '(no text)'}`;
}
