import {
  PROTOCOL_VERSION,
  type BodyOf,
  type ItemSummary,
  type ReplyRoute,
  type RunSpec,
  type SessionEvent,
} from '@agents-io/protocol';

export type SessionState = BodyOf<'session.state'>['state'];
export type Visibility = SessionEvent['visibility'];

/**
 * An event before the log stamps it. `harness`, `generation` and `visibility`
 * default to the session's last known binding and `participants`.
 */
export type EventDraft = Omit<SessionEvent, 'v' | 'sessionKey' | 'seq' | 'harness' | 'generation' | 'visibility'> & {
  harness?: string;
  generation?: number;
  visibility?: Visibility;
};

/**
 * Whether an event is ephemeral (never persisted, no seq of its own). Deltas and
 * progress are always ephemeral; headlines and non-final snapshots are ephemeral
 * when the producer says so; everything else is durable whatever it claims.
 */
export function isEphemeral(e: Pick<SessionEvent, 'body' | 'durability'>): boolean {
  const b = e.body;
  if (b.t === 'text.delta' || b.t === 'item.progress') return true;
  if (e.durability !== 'ephemeral') return false;
  return b.t === 'headline' || (b.t === 'text.snapshot' && !b.final);
}

/** What a late joiner needs to render the session without replaying it. */
export interface SessionSnapshot {
  sessionKey: string;
  /** Last durable seq folded into this snapshot; live events continue after it. */
  seq: number;
  harness: string;
  generation: number;
  state: SessionState;
  turn: {
    turnId: string;
    inputIds: string[];
    replyRoute: ReplyRoute | null;
    run?: RunSpec;
    owner?: string;
    deliveries: ReplyRoute[];
  } | null;
  /** Cumulative answer text of the current turn. */
  partialText: string;
  activeItems: ItemSummary[];
  pendingRequests: BodyOf<'request.opened'>[];
  plan: BodyOf<'plan.updated'>['steps'] | null;
  headline: string | null;
  /** Inputs admitted but not yet started, consumed, cancelled or rejected. */
  queued: string[];
}

export function emptySnapshot(sessionKey: string): SessionSnapshot {
  return {
    sessionKey,
    seq: 0,
    harness: '',
    generation: 0,
    state: 'idle',
    turn: null,
    partialText: '',
    activeItems: [],
    pendingRequests: [],
    plan: null,
    headline: null,
    queued: [],
  };
}

/** Content a snapshot shows; only `participants` events add it (approvals: anything not `internal`). */
const SHOWN: ReadonlySet<string> = new Set(['text.delta', 'text.snapshot', 'item.started', 'plan.updated', 'headline', 'request.opened']);

/**
 * Folds one event into a snapshot in place. Safe for durable and ephemeral events.
 * Every late joiner gets the same snapshot, so content from `operators`/`internal`
 * events is left out (lifecycle and removals still apply); replay from a seq for those.
 */
export function foldSnapshot(s: SessionSnapshot, e: SessionEvent): void {
  if (!isEphemeral(e)) s.seq = e.seq;
  if (e.harness) s.harness = e.harness;
  if (e.generation) s.generation = e.generation;
  const b = e.body;
  if (SHOWN.has(b.t) && e.visibility !== 'participants' && !(b.t === 'request.opened' && e.visibility !== 'internal')) return;
  const drop = (ids: string[]) => (s.queued = s.queued.filter((q) => !ids.includes(q)));
  switch (b.t) {
    case 'session.state':
      s.state = b.state;
      break;
    case 'input.admitted':
      if ((b.disposition === 'queued' || b.disposition === 'new_turn') && !s.queued.includes(b.inputId)) s.queued.push(b.inputId);
      break;
    case 'input.consumed':
    case 'input.cancelled':
    case 'input.rejected':
      drop(b.inputIds);
      break;
    case 'turn.started':
      s.turn = {
        turnId: b.turnId,
        inputIds: [...b.inputIds],
        replyRoute: b.replyRoute,
        ...(b.run ? { run: b.run } : {}),
        ...(b.owner !== undefined ? { owner: b.owner } : {}),
        deliveries: [],
      };
      drop(b.inputIds);
      s.state = 'running';
      s.partialText = '';
      s.activeItems = [];
      s.plan = null;
      s.headline = null;
      break;
    case 'turn.adopted':
      // Same turn as the one the log already shows open: keep what it knew (route, owner, deliveries).
      if (s.turn?.turnId !== b.turnId) {
        s.turn = { turnId: b.turnId, inputIds: [...b.inputIds], replyRoute: null, ...(b.run ? { run: b.run } : {}), deliveries: [] };
        s.partialText = '';
        s.activeItems = [];
        s.plan = null;
      }
      drop(b.inputIds); // the harness runs them: they are not waiting any more
      s.state = 'running';
      break;
    case 'turn.delivery_added':
      if (s.turn?.turnId === b.turnId) s.turn.deliveries.push(b.route);
      break;
    case 'turn.completed':
      if (s.turn?.turnId === b.turnId || !s.turn) {
        s.turn = null;
        s.activeItems = [];
        s.pendingRequests = [];
        if (s.state !== 'error') s.state = 'idle';
      }
      break;
    case 'text.delta':
      if (b.stream === 'answer') s.partialText += b.delta;
      break;
    case 'text.snapshot':
      if (e.audience === 'answer' || e.audience === 'commentary') s.partialText = b.text;
      break;
    case 'item.started':
      s.activeItems = [...s.activeItems.filter((i) => i.itemId !== b.item.itemId), b.item];
      break;
    case 'item.completed':
      s.activeItems = s.activeItems.filter((i) => i.itemId !== b.item.itemId);
      break;
    case 'request.opened':
      s.pendingRequests = [...s.pendingRequests.filter((r) => r.requestId !== b.requestId), b];
      break;
    case 'request.resolved':
      s.pendingRequests = s.pendingRequests.filter((r) => r.requestId !== b.requestId);
      break;
    case 'plan.updated':
      s.plan = b.steps;
      break;
    case 'headline':
      s.headline = b.text;
      break;
  }
}

/**
 * Per-session event log. The single writer of `seq`: durable events get a
 * per-session, monotonic, gapless seq; ephemeral ones are kept only in a bounded
 * in-memory ring and carry the seq of the durable event they follow.
 */
export interface SessionLog {
  append(sessionKey: string, draft: EventDraft): SessionEvent;
  /** Durable events with `seq > fromSeq`, oldest first. */
  read(sessionKey: string, fromSeq: number, limit?: number): SessionEvent[];
  /** Last durable seq (0 when empty). */
  head(sessionKey: string): number;
  /** Events with `seq <= floor` are no longer retained; a reader behind it needs a snapshot. */
  floor(sessionKey: string): number;
  /** Fold of every event so far, including ephemeral ones and trimmed history. */
  snapshot(sessionKey: string): SessionSnapshot;
  /** Recent ephemeral events (bounded ring). */
  ephemeral(sessionKey: string): SessionEvent[];
  sessions(): string[];
  close?(): void;
}

export interface LogOptions {
  /** Ephemeral ring size per session (default 256). */
  ephemeralRing?: number;
}

interface SessionMeta {
  head: number;
  fold: SessionSnapshot;
  ring: SessionEvent[];
}

/** Shared seq/ring/fold logic; subclasses only store durable events. */
export abstract class BaseSessionLog implements SessionLog {
  private meta = new Map<string, SessionMeta>();
  protected readonly ringSize: number;

  constructor(opts: LogOptions = {}) {
    this.ringSize = opts.ephemeralRing ?? 256;
  }

  protected abstract persist(e: SessionEvent): void;
  protected abstract load(sessionKey: string, fromSeq: number, limit: number): SessionEvent[];
  /** Restore head and fold for a session not seen in this process. */
  protected abstract restore(sessionKey: string): { head: number; fold: SessionSnapshot };
  abstract floor(sessionKey: string): number;
  abstract sessions(): string[];

  protected metaOf(sessionKey: string): SessionMeta {
    let m = this.meta.get(sessionKey);
    if (!m) {
      const r = this.restore(sessionKey);
      m = { head: r.head, fold: r.fold, ring: [] };
      this.meta.set(sessionKey, m);
    }
    return m;
  }

  append(sessionKey: string, draft: EventDraft): SessionEvent {
    const m = this.metaOf(sessionKey);
    const ephemeral = isEphemeral(draft);
    // Spread first so unknown fields from newer producers are preserved.
    const e: SessionEvent = {
      ...draft,
      v: PROTOCOL_VERSION,
      sessionKey,
      seq: ephemeral ? m.head : m.head + 1,
      harness: draft.harness ?? m.fold.harness,
      generation: draft.generation ?? m.fold.generation,
      visibility: draft.visibility ?? 'participants',
      durability: ephemeral ? 'ephemeral' : 'durable',
    };
    if (ephemeral) {
      m.ring.push(e);
      if (m.ring.length > this.ringSize) m.ring.splice(0, m.ring.length - this.ringSize);
    } else {
      this.persist(e);
      m.head = e.seq;
    }
    foldSnapshot(m.fold, e);
    return e;
  }

  read(sessionKey: string, fromSeq: number, limit = Number.MAX_SAFE_INTEGER): SessionEvent[] {
    return this.load(sessionKey, Math.max(fromSeq, this.floor(sessionKey)), limit);
  }

  head(sessionKey: string): number {
    return this.metaOf(sessionKey).head;
  }

  snapshot(sessionKey: string): SessionSnapshot {
    return structuredClone(this.metaOf(sessionKey).fold);
  }

  ephemeral(sessionKey: string): SessionEvent[] {
    return [...this.metaOf(sessionKey).ring];
  }
}

export interface MemoryLogOptions extends LogOptions {
  /** Keep at most this many durable events per session; older ones are trimmed (default: all). */
  retain?: number;
}

export class MemorySessionLog extends BaseSessionLog {
  private events = new Map<string, SessionEvent[]>();
  private floors = new Map<string, number>();
  private readonly retain: number;

  constructor(opts: MemoryLogOptions = {}) {
    super(opts);
    this.retain = opts.retain ?? Number.POSITIVE_INFINITY;
  }

  protected persist(e: SessionEvent): void {
    let list = this.events.get(e.sessionKey);
    if (!list) this.events.set(e.sessionKey, (list = []));
    list.push(e);
    if (list.length > this.retain) {
      const cut = list.splice(0, list.length - this.retain);
      this.floors.set(e.sessionKey, cut.at(-1)!.seq);
    }
  }

  protected load(sessionKey: string, fromSeq: number, limit: number): SessionEvent[] {
    const list = this.events.get(sessionKey) ?? [];
    const out: SessionEvent[] = [];
    for (const e of list) {
      if (e.seq <= fromSeq) continue;
      out.push(e);
      if (out.length >= limit) break;
    }
    return out;
  }

  protected restore(sessionKey: string) {
    return { head: 0, fold: emptySnapshot(sessionKey) };
  }

  floor(sessionKey: string): number {
    return this.floors.get(sessionKey) ?? 0;
  }

  sessions(): string[] {
    return [...this.events.keys()];
  }
}
