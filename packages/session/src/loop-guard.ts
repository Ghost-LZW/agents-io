import {
  agentInputOrigin,
  formatAddress,
  parseAddress,
  type AgentAddress,
  type ContentBlock,
  type InputCause,
  type InputRecord,
  type LoopGuardTrip,
  type Principal,
  type ReplyRoute,
  type TurnProvenance,
} from '@agents-io/protocol';

/*
 * Cause chains and the loop guard (docs/design/agent-messaging §4.3–§4.4). An input
 * an agent's turn produces carries `InputRecord.cause`: one hop more than the turn,
 * the same chain. The lane is the single checkpoint: an agent input over the hop limit,
 * or one more from a peer that already started too many turns in a session, does not
 * start a turn; it is recorded as context instead.
 */

/** Hop and same-pair limits (config `policy.loopGuard`). */
export interface LoopGuardOptions {
  /** An agent input with a hop above this does not start a turn. Default 8. */
  maxHops?: number;
  /**
   * Per receiving session and peer: at most `maxTurns` turns started by that peer's agent
   * inputs within `windowMs` since the last turn a non-agent input started. Defaults 10 / 15 min.
   */
  pair?: { maxTurns?: number; windowMs?: number };
}

export const LOOP_GUARD_DEFAULTS = { maxHops: 8, pair: { maxTurns: 10, windowMs: 15 * 60_000 } } as const;

/**
 * The peer a same-pair count is kept for: an agent of this deployment by its name
 * (topic rotation keeps the principal), an outside sender by its channel identity.
 */
export function peerKey(input: InputRecord): string {
  const c = input.cause;
  if (c && (c.basis === 'internal' || c.basis === 'recovered')) {
    const a = parseAddress(c.peer);
    if (a) return `agent:${a.agent}`;
  }
  return c?.peer ?? input.origin.principal?.id ?? input.origin.via;
}

interface PairEntry {
  /** When each counted turn was admitted (within the window). */
  times: number[];
  /** Stopped since: every input from this peer is stopped until a non-agent input or the window passes. */
  trippedAt?: number;
}

/** One per lane: in memory (a restart clears the pair counts; the hop limit rides on the persisted cause). */
export class LoopGuard {
  private readonly maxHops: number;
  private readonly maxTurns: number;
  private readonly windowMs: number;
  private pairs = new Map<string, PairEntry>();

  constructor(
    o: LoopGuardOptions = {},
    private readonly now: () => number = Date.now,
  ) {
    this.maxHops = Math.max(1, o.maxHops ?? LOOP_GUARD_DEFAULTS.maxHops);
    this.maxTurns = Math.max(1, o.pair?.maxTurns ?? LOOP_GUARD_DEFAULTS.pair.maxTurns);
    this.windowMs = Math.max(1, o.pair?.windowMs ?? LOOP_GUARD_DEFAULTS.pair.windowMs);
  }

  /**
   * An input about to start (or join) a turn: the trip if it must not, else undefined
   * (and it is counted). A non-agent input clears every pair count: a person is back.
   */
  check(input: InputRecord): LoopGuardTrip | undefined {
    if (input.origin.kind !== 'agent') {
      this.pairs.clear();
      return undefined;
    }
    const hop = input.cause?.hop;
    if (hop !== undefined && hop > this.maxHops) return { tripped: 'hops', hop, limit: this.maxHops };
    const peer = peerKey(input);
    const t = this.now();
    let e = this.pairs.get(peer);
    if (e?.trippedAt !== undefined && t - e.trippedAt >= this.windowMs) e = undefined;
    if (!e) {
      e = { times: [] };
      this.pairs.set(peer, e);
    }
    e.times = e.times.filter((x) => t - x < this.windowMs);
    const trip = (): LoopGuardTrip => ({ tripped: 'pair', peer, count: e!.times.length, limit: this.maxTurns, windowMs: this.windowMs, ...(hop !== undefined ? { hop } : {}) });
    if (e.trippedAt !== undefined) return trip();
    if (e.times.length >= this.maxTurns) {
      e.trippedAt = t;
      return trip();
    }
    e.times.push(t);
    return undefined;
  }
}

/** One line for the `loop_guard` notice: what tripped, and what lifts it. */
export function loopGuardMessage(t: LoopGuardTrip, inputId: string): string {
  if (t.tripped === 'hops') return `loop guard: input ${inputId} is hop ${t.hop} of an agent chain, over the limit of ${t.limit}; recorded as context, no turn started (a new message from a person starts a new chain)`;
  const mins = Math.round((t.windowMs ?? 0) / 60_000);
  return `loop guard: ${t.peer} already started ${t.count} turns here within ${mins} min (limit ${t.limit}); input ${inputId} recorded as context, no turn started (lifts when a person writes here, or after ${mins} min)`;
}

/** What a turn's chain is, as recorded in its provenance. */
export type TurnCause = NonNullable<TurnProvenance['cause']>;

/**
 * The chain a turn sits in: its triggering input with the highest hop (an input without
 * a known hop counts as 0, the root of its own chain). Undefined for a turn without inputs.
 */
export function turnCause(inputs: InputRecord[]): TurnCause | undefined {
  let best: InputRecord | undefined;
  let hop = 0;
  for (const i of inputs) {
    const h = i.cause?.hop ?? 0;
    if (best === undefined || h > hop) {
      best = i;
      hop = h;
    }
  }
  if (!best) return undefined;
  const linked = best.cause?.hop !== undefined;
  return {
    hop,
    chain: linked ? (best.cause!.chain ?? best.inputId) : best.inputId,
    rootPrincipal: linked ? (best.cause!.rootPrincipal ?? null) : (best.origin.principal?.id ?? null),
  };
}

/** A turn of this deployment that produced an input (what `causeFrom` needs to know about it). */
export interface ProducingTurn {
  from: AgentAddress;
  turnId: string;
  /** The turn's provenance (its chain and flags), when still known. */
  provenance?: Pick<TurnProvenance, 'external' | 'watched' | 'group' | 'cause'>;
}

/** The cause of an input a turn produced: one hop more, the same chain, the turn's flags carried over (never laundered). */
export function causeFrom(t: ProducingTurn, basis: 'internal' | 'recovered'): InputCause {
  const c = t.provenance?.cause;
  const p = t.provenance;
  return {
    peer: formatAddress(t.from),
    basis,
    hop: (c?.hop ?? 0) + 1,
    ...(c ? { chain: c.chain } : {}),
    from: { sessionKey: t.from.sessionKey, turnId: t.turnId },
    rootPrincipal: c?.rootPrincipal ?? null,
    ...(p ? { carried: { external: p.external, watched: p.watched, group: p.group } } : {}),
  };
}

/**
 * An input one of this deployment's agents sends to another session, stamped by the
 * daemon: kind `agent`, the agent's principal, evidence `daemon`, `via` = the sending
 * session, and the cause one hop past the sending turn (basis `internal`). For the
 * agent-messaging tools (`agent_send`, `agent_run`); the stamp is never the client's.
 */
export function agentInput(a: {
  inputId: string;
  turn: ProducingTurn;
  content: ContentBlock[];
  replyRoute: ReplyRoute | null;
  /** Default `agent:<agent>`; a host identity map may name another (never an owner). */
  principal?: Principal;
  channelContext?: InputRecord['channelContext'];
}): InputRecord {
  return {
    inputId: a.inputId,
    origin: agentInputOrigin(a.turn.from, a.principal),
    content: a.content,
    replyRoute: a.replyRoute,
    cause: causeFrom(a.turn, 'internal'),
    channelContext: { ...(a.channelContext ?? {}) },
  };
}
