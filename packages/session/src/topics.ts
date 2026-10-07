import { randomBytes } from 'node:crypto';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import type { Topic, TopicChangeReason, TopicSwitchResult } from '@agents-io/protocol';
import type { Hub } from './hub.js';

/*
 * Topics (docs/design/locus/DECISIONS.md decision 6). A flat conversation holds
 * several topics, each its own session, and one current topic that bindings
 * with `session: "topic"` route to. This is only the table: when to start or
 * switch a topic is the agent's call (output tools) or the user's (`/new`,
 * `/topics`, `/switch`). Parked topics are never deleted; switching back routes
 * to their session again, whose lane resumes the harness session natively.
 */

export class TopicError extends Error {
  override name = 'TopicError';
  constructor(
    readonly code: 'unknown_topic' | 'unknown_conversation' | 'wrong_conversation',
    message: string,
  ) {
    super(message);
  }
}

/** A topic plus the agent whose sessions it names (a conversation has one topic list per agent). */
export interface TopicRecord extends Topic {
  agent: string;
}

/** What changed when a conversation's current topic moved. */
export interface TopicChange {
  conversation: string;
  agent: string;
  from?: TopicRecord;
  to: TopicRecord;
  reason: TopicChangeReason;
  /** The turn that made the change (session_rotate / session_switch, or switching back after a failed one). */
  turn?: TurnRef;
  /** `to` is a new topic (`create`), not a switch to an existing one. */
  created?: true;
}

export interface TopicRegistryOptions {
  /** Share an open database (the session log's); the registry then never closes it. */
  db?: DatabaseSync;
  /** SQLite file or `:memory:` (default) when no `db` is given. */
  path?: string;
  /** When given, every change appends `topic.changed` to the session left and the one now current. */
  hub?: Pick<Hub, 'append'>;
  now?: () => number;
  newId?: () => string;
  onChange?: (c: TopicChange) => void;
}

/** Fields of a new topic. */
export interface TopicDraft {
  title?: string;
}

/** A running turn and the session it runs in. */
export interface TurnRef {
  sessionKey: string;
  turnId: string;
}

/** How a change came about, besides its reason. */
export interface TopicChangeOptions {
  /** The turn that made it: `topic.changed` in that turn's session carries its turn id (its card then says where it went). */
  turn?: TurnRef;
}

export interface TopicCreateOptions extends TopicChangeOptions {
  /** What the topic being parked was about (session_rotate's summary): saved on that topic, the one it describes. */
  summaryOfPrevious?: string;
}

/** Spells the session key of a new topic: `first` when the conversation has none yet. */
export type TopicSessionKey = (args: { topicId: string; first: boolean }) => string;

interface Row {
  id: string;
  conversation: string;
  agent: string;
  session_key: string;
  title: string | null;
  summary: string | null;
  native_id: string | null;
  state: string;
  created_at: number;
  last_active_at: number;
}

const fromRow = (r: Row): TopicRecord => ({
  id: r.id,
  conversation: r.conversation,
  agent: r.agent,
  sessionKey: r.session_key,
  ...(r.title !== null ? { title: r.title } : {}),
  ...(r.summary !== null ? { summary: r.summary } : {}),
  ...(r.native_id !== null ? { nativeId: r.native_id } : {}),
  state: r.state === 'current' ? 'current' : 'parked',
  createdAt: r.created_at,
  lastActiveAt: r.last_active_at,
});

/** The protocol view of a record (no agent). */
export function topicView(t: TopicRecord): Topic {
  const { agent: _agent, ...rest } = t;
  return rest;
}

/** Newest activity first; ties: newest created first. */
const byActivity = (a: TopicRecord, b: TopicRecord) => b.lastActiveAt - a.lastActiveAt || b.createdAt - a.createdAt;

/**
 * The persistent topic table, in the same SQLite database as the session log.
 * Every topic is kept in memory too (topics are few and small), written through.
 * All methods are synchronous, so routing can resolve a topic in one step.
 */
export class TopicRegistry {
  readonly db: DatabaseSync;
  private readonly ownsDb: boolean;
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly byId = new Map<string, TopicRecord>();
  private readonly bySessionKey = new Map<string, TopicRecord>();
  private q: Record<'insert' | 'state' | 'touch' | 'native' | 'title' | 'summary' | 'all', StatementSync>;

  constructor(private readonly o: TopicRegistryOptions = {}) {
    this.ownsDb = !o.db;
    this.db = o.db ?? new DatabaseSync(o.path ?? ':memory:');
    this.now = o.now ?? Date.now;
    this.newId = o.newId ?? (() => `tp_${randomBytes(5).toString('hex')}`);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS topics (
        id TEXT PRIMARY KEY,
        conversation TEXT NOT NULL,
        agent TEXT NOT NULL,
        session_key TEXT NOT NULL UNIQUE,
        title TEXT,
        summary TEXT,
        native_id TEXT,
        state TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_active_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS topics_conversation ON topics (conversation, agent);
    `);
    const p = (sql: string) => this.db.prepare(sql);
    this.q = {
      insert: p('INSERT INTO topics (id, conversation, agent, session_key, title, summary, native_id, state, created_at, last_active_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'),
      state: p('UPDATE topics SET state = ?, last_active_at = ? WHERE id = ?'),
      touch: p('UPDATE topics SET last_active_at = ? WHERE id = ?'),
      native: p('UPDATE topics SET native_id = ? WHERE id = ?'),
      title: p('UPDATE topics SET title = ? WHERE id = ?'),
      summary: p('UPDATE topics SET summary = ? WHERE id = ?'),
      all: p('SELECT * FROM topics'),
    };
    for (const r of this.q.all.all() as unknown as Row[]) this.remember(fromRow(r));
  }

  private remember(t: TopicRecord): void {
    this.byId.set(t.id, t);
    this.bySessionKey.set(t.sessionKey, t);
  }

  // ---- reading ------------------------------------------------------------

  get(topicId: string): TopicRecord | undefined {
    return this.byId.get(topicId);
  }

  /** The topic whose session this is, if the session is one. */
  bySession(sessionKey: string): TopicRecord | undefined {
    return this.bySessionKey.get(sessionKey);
  }

  /** The current topic of a conversation for one agent. */
  current(conversation: string, agent: string): TopicRecord | undefined {
    for (const t of this.byId.values()) if (t.conversation === conversation && t.agent === agent && t.state === 'current') return t;
    return undefined;
  }

  /** Topics, newest activity first; only those of `conversation` / `agent` / `sessionKey` when given. */
  list(f: { conversation?: string; agent?: string; sessionKey?: string } = {}): TopicRecord[] {
    return [...this.byId.values()]
      .filter((t) => (f.conversation === undefined || t.conversation === f.conversation) && (f.agent === undefined || t.agent === f.agent) && (f.sessionKey === undefined || t.sessionKey === f.sessionKey))
      .sort(byActivity);
  }

  /** The topics of the conversation a topic session belongs to (same agent), newest activity first. */
  siblings(sessionKey: string): TopicRecord[] {
    const t = this.bySession(sessionKey);
    return t ? this.list({ conversation: t.conversation, agent: t.agent }) : [];
  }

  // ---- writing ------------------------------------------------------------

  /**
   * The conversation's current topic, created on first use (reason `system`).
   * A conversation whose topics are all parked (not reachable through this
   * class) gets its most recent one back as current.
   */
  ensureCurrent(conversation: string, agent: string, sessionKey: TopicSessionKey, draft: TopicDraft = {}): { topic: TopicRecord; created: boolean } {
    const cur = this.current(conversation, agent);
    if (cur) return { topic: cur, created: false };
    const latest = this.list({ conversation, agent })[0];
    if (latest) return { topic: this.switchTo(latest.id, 'system').topic as TopicRecord, created: false };
    const r = this.create(conversation, agent, sessionKey, draft, 'system');
    return { topic: r.topic as TopicRecord, created: true };
  }

  /** Start a new topic and make it current; the current one is parked (with `summaryOfPrevious` as its summary). */
  create(conversation: string, agent: string, sessionKey: TopicSessionKey, draft: TopicDraft, reason: TopicChangeReason, opts: TopicCreateOptions = {}): TopicSwitchResult & { topic: TopicRecord; previous?: TopicRecord } {
    const previous = this.current(conversation, agent);
    const first = !this.list({ conversation, agent }).length;
    const id = this.newId();
    let key = sessionKey({ topicId: id, first });
    // A key that already names a topic (or another conversation's) never gets reused.
    if (this.bySessionKey.has(key)) key = sessionKey({ topicId: id, first: false });
    const at = this.now();
    const t: TopicRecord = {
      id,
      conversation,
      agent,
      sessionKey: key,
      ...(clean(draft.title) !== undefined ? { title: clean(draft.title)! } : {}),
      state: 'current',
      createdAt: at,
      lastActiveAt: at,
    };
    const summary = previous ? opts.summaryOfPrevious?.trim() : undefined;
    this.db.exec('BEGIN');
    try {
      if (previous) this.q.state.run('parked', previous.lastActiveAt, previous.id);
      if (previous && summary) this.q.summary.run(summary, previous.id);
      this.q.insert.run(t.id, conversation, agent, key, t.title ?? null, null, null, 'current', at, at);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    if (previous) previous.state = 'parked';
    if (previous && summary) previous.summary = summary;
    this.remember(t);
    this.changed({ conversation, agent, ...(previous ? { from: previous } : {}), to: t, reason, ...(opts.turn ? { turn: opts.turn } : {}), created: true });
    return { topic: t, ...(previous ? { previous } : {}), created: true };
  }

  /** Make an existing topic current (parking the current one). Already current: nothing changes. */
  switchTo(topicId: string, reason: TopicChangeReason, opts: TopicChangeOptions = {}): TopicSwitchResult & { topic: TopicRecord; previous?: TopicRecord } {
    const t = this.byId.get(topicId);
    if (!t) throw new TopicError('unknown_topic', `no topic ${topicId}`);
    const previous = this.current(t.conversation, t.agent);
    if (previous === t) return { topic: t, created: false };
    const at = this.now();
    this.db.exec('BEGIN');
    try {
      if (previous) this.q.state.run('parked', previous.lastActiveAt, previous.id);
      this.q.state.run('current', at, t.id);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    if (previous) previous.state = 'parked';
    t.state = 'current';
    t.lastActiveAt = at;
    this.changed({ conversation: t.conversation, agent: t.agent, ...(previous ? { from: previous } : {}), to: t, reason, ...(opts.turn ? { turn: opts.turn } : {}) });
    return { topic: t, ...(previous ? { previous } : {}), created: false };
  }

  /** The topic's session was active (an input routed to it). */
  touch(sessionKey: string): void {
    const t = this.bySessionKey.get(sessionKey);
    if (!t) return;
    t.lastActiveAt = this.now();
    this.q.touch.run(t.lastActiveAt, t.id);
  }

  /** The harness's own session id of a topic session became known (`session.bound`). */
  setNativeId(sessionKey: string, nativeId: string): void {
    const t = this.bySessionKey.get(sessionKey);
    if (!t || t.nativeId === nativeId) return;
    t.nativeId = nativeId;
    this.q.native.run(nativeId, t.id);
  }

  setTitle(topicId: string, title: string | undefined): void {
    const t = this.byId.get(topicId);
    if (!t) throw new TopicError('unknown_topic', `no topic ${topicId}`);
    const v = clean(title);
    if (v === undefined) delete t.title;
    else t.title = v;
    this.q.title.run(v ?? null, t.id);
  }

  close(): void {
    if (this.ownsDb) this.db.close();
  }

  private changed(c: TopicChange): void {
    const hub = this.o.hub;
    if (hub) {
      const body = { t: 'topic.changed' as const, conversation: c.conversation, ...(c.from ? { from: c.from.id } : {}), to: c.to.id, ...(c.to.title !== undefined ? { title: c.to.title } : {}), reason: c.reason };
      for (const key of new Set([...(c.from ? [c.from.sessionKey] : []), c.to.sessionKey])) {
        const turnId = c.turn?.sessionKey === key ? { turnId: c.turn.turnId } : {};
        hub.append(key, { ts: this.now(), ...turnId, level: 'detail', audience: 'status', durability: 'durable', visibility: 'participants', body });
      }
    }
    this.o.onChange?.(c);
  }
}

/** Longest topic title kept. */
export const TOPIC_TITLE_MAX = 80;

function clean(s: string | undefined): string | undefined {
  const t = s?.replace(/\s+/g, ' ').trim();
  if (!t) return undefined;
  return t.length > TOPIC_TITLE_MAX ? `${t.slice(0, TOPIC_TITLE_MAX - 1)}…` : t;
}

/** A first topic's title from the message that opened it: its first line, short. */
export function titleFrom(text: string, max = 40): string | undefined {
  const line = text.split('\n').map((l) => l.trim()).find(Boolean);
  if (!line || line.startsWith('/')) return undefined;
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
