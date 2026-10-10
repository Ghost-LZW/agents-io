import { randomUUID } from 'node:crypto';
import {
  routeKey,
  type BodyOf,
  type Command,
  type Decision,
  type HarnessAdapter,
  type HarnessCaps,
  type HarnessEvent,
  type HarnessSession,
  type InputMode,
  type InputRecord,
  type LiveFrame,
  type LiveStartArgs,
  type LoopGuardTrip,
  type Origin,
  type ReplyRoute,
  type ResolvedBy,
  type Resolver,
  type RunSpec,
  type SessionEvent,
  type TurnContext,
  type TurnProvenance,
} from '@agents-io/protocol';
import type { Hub } from './hub.js';
import type { EventDraft, SessionSnapshot, SessionState, Visibility } from './log.js';
import { withDefaults, type FullPolicy, type SessionPolicy } from './policy.js';
import { GROUPISH } from './watch.js';
import { LoopGuard, loopGuardMessage, turnCause, type LoopGuardOptions, type TurnCause } from './loop-guard.js';

export interface ModelReviewArgs {
  sessionKey: string;
  request: BodyOf<'request.opened'>;
  ctx: TurnContext;
  model: string;
  prompt?: string;
  signal: AbortSignal;
}

/** Host-provided model review. Return a decision, or `escalate` to hand the request to a human. */
export type ModelReviewer = (args: ModelReviewArgs) => Promise<Decision | { escalate: true; reason?: string }>;

export interface LaneOptions {
  sessionKey: string;
  harness: HarnessAdapter;
  hub: Hub;
  policy?: SessionPolicy;
  cwd?: string;
  /** Native session/thread id to resume on first open. */
  resume?: string;
  /**
   * Several harnesses (named instances): the adapter a turn's `RunSpec.harness`
   * names. Each open uses it; a turn naming another adapter than the open
   * session's closes that session and opens the new one (next generation).
   * `harness` stays the adapter events are attributed to before the first open.
   */
  harnessFor?: (name: string) => HarnessAdapter;
  /** Native id to resume when opening this adapter id (with `harnessFor`; wins over `resume`). */
  resumeFor?: (harnessId: string) => string | undefined;
  /**
   * Host MCP endpoint mounted into the harness. A function is called on every open
   * (each harness binding), so the host can mint one token per run.
   */
  mcp?: LaneMcp | ((args: { sessionKey: string; generation: number; harnessId: string }) => LaneMcp | undefined);
  harnessOptions?: Record<string, unknown>;
  modelReviewer?: ModelReviewer;
  /** Human/host requests without `expiresAt` are denied after this long (default 10 min). */
  requestTimeoutMs?: number;
  /** How many times an admitted-but-unconsumed input is re-queued before it is rejected (default 1). */
  requeueLimit?: number;
  /** Synthetic ephemeral headline right after `turn.started` (default `Thinking…`; null disables). */
  thinkingHeadline?: string | null;
  newId?: (prefix: string) => string;
  /**
   * Context-only inputs (binding `context`, watch `context`; revisions latest-wins) are
   * handed to the next turn ahead of its triggering inputs, at most this many / this many
   * characters of content (the most recent win; one line says how many older ones were
   * left out). Defaults: `CONTEXT_DEFAULTS`. `maxItems: 0` turns the hand-over off.
   */
  context?: { maxItems?: number; maxChars?: number };
  /** Tee of raw harness events (conformance checks, debugging). */
  onHarnessEvent?: (e: HarnessEvent) => void;
  /** A live (realtime voice) on this session ended, whichever side ended it (decision 11). */
  onLiveEnded?: (liveId: string, reason: string) => void;
  /**
   * Hop and same-pair limits checked on every input that would start or join a turn
   * (docs/design/agent-messaging §4.4); defaults `LOOP_GUARD_DEFAULTS`. `false` turns it off.
   */
  loopGuard?: LoopGuardOptions | false;
  /**
   * The loop guard stopped an input (it was recorded as context with
   * `channelContext.loopGuard`, and a `loop_guard` notice is in this session's log),
   * e.g. to tell the sending session and record it for `explain`. Errors are ignored.
   */
  onLoopGuard?: (a: { sessionKey: string; input: InputRecord; trip: LoopGuardTrip }) => void;
  /** An input with a cause was admitted (as an input or as context), e.g. to index it for `explain --chain`. Errors are ignored. */
  onCause?: (a: { sessionKey: string; input: InputRecord }) => void;
}

/** A live running on the session (decision 11): what delegated inputs are attributed to. */
export interface LiveInfo {
  liveId: string;
  title: string;
  /** Where the live happens (the channel's media peer). */
  route: ReplyRoute;
  /** Route of the turn that opened it: delegated turns may send text there. */
  controlRoute: ReplyRoute | null;
}

export interface LaneMcp {
  url: string;
  token: string;
  transport?: 'http' | 'sse';
}

export type CommandResult =
  | { ok: true; disposition?: BodyOf<'input.admitted'>['disposition'] | 'duplicate' }
  | { ok: false; reason: string };

interface Queued {
  input: InputRecord;
  attempts: number;
}

/** Bounds of the context handed to one turn. */
export const CONTEXT_DEFAULTS = { maxItems: 50, maxChars: 20_000 } as const;

/** A context-only input recorded but not yet handed to a turn. */
interface PendingContext {
  /** Latest revision. */
  input: InputRecord;
  /** Input id it is handed under: its own, or `<id>@<seq>` for a revision of one already handed. */
  handId: string;
  /** A revision of an input an earlier turn already saw. */
  revised: boolean;
}

/** What one turn is handed ahead of its triggering inputs. */
interface ContextBatch {
  /** Records as handed (marked `context: true`, the omitted-count line first). */
  records: InputRecord[];
  /** The pending entries this batch takes (handed or omitted), by original input id. */
  taken: [string, PendingContext][];
}

interface ActiveTurn {
  turnId: string;
  inputs: InputRecord[];
  attempts: Map<string, number>;
  owner: string | null;
  replyRoute: ReplyRoute | null;
  run: RunSpec | undefined;
  /** Between planning and the harness accepting the turn. */
  starting: boolean;
  interruptRequested: boolean;
  deliveries: ReplyRoute[];
  consumed: Set<string>;
  /** The harness reported consuming inputs this turn was not given. */
  foreignConsumed: boolean;
  /** Input ids of a turn adopted from a previous host; their records are not in memory. */
  adopted?: Set<string>;
  /**
   * Context records handed ahead of the inputs (ids as handed). The harness may report
   * them consumed or not: neither requeues them nor makes the turn ambiguous.
   */
  context: InputRecord[];
}

/** A turn the log shows open from a previous host process. */
type Dangling = NonNullable<SessionSnapshot['turn']>;

interface PendingRequest {
  body: BodyOf<'request.opened'>;
  resolver: Resolver;
  turnId: string | undefined;
  audience: SessionEvent['audience'];
  timer?: ReturnType<typeof setTimeout>;
  abort?: AbortController;
}

const principalId = (i: InputRecord) => i.origin.principal?.id;

/**
 * Inputs merge into one turn only if they share a principal and a reply route.
 * Unknown senders (principal null) never merge with anything.
 */
function batchKey(i: InputRecord): string | null {
  const p = principalId(i);
  if (p === undefined) return null;
  return `${p}\u0000${i.replyRoute ? routeKey(i.replyRoute) : '-'}`;
}

const sameRoute = (a: ReplyRoute | null, b: ReplyRoute | null) =>
  (a === null && b === null) || (a !== null && b !== null && routeKey(a) === routeKey(b));

/**
 * One per session; the single writer of its log and the only caller of its
 * harness session. The lane owns the input queue: the harness only ever sees
 * one batch (one principal, one reply route) per turn, and a steer only when its
 * caps allow and the principal owns the active turn.
 */
export class Lane {
  readonly sessionKey: string;
  private readonly policy: FullPolicy;
  private readonly newId: (prefix: string) => string;
  private queue: Queued[] = [];
  private turn: ActiveTurn | undefined;
  private session: HarnessSession | undefined;
  private caps: HarnessCaps | undefined;
  /** The adapter of the open session (or the last one, or `o.harness` before any). */
  private adapter: HarnessAdapter;
  private generation = 0;
  private lastRun: RunSpec | undefined;
  private state: SessionState = 'idle';
  private requests = new Map<string, PendingRequest>();
  private resolved = new Set<string>();
  private known = new Set<string>();
  private observedInputs = new Map<string, InputRecord>();
  private chain: Promise<unknown> = Promise.resolve();
  private idleWaiters: (() => void)[] = [];
  private closed = false;
  private closeReason = 'lane closed';
  private detached = false;
  private dangling: Dangling | undefined;
  /** The harness was opened (once) to give it a chance to adopt `dangling` before a new turn settles it. */
  private adoptionChecked = false;
  /** Provenance of recent turns, by turn id (bounded). */
  private provenances = new Map<string, TurnProvenance>();
  /**
   * What context-only and watched inputs handed to earlier turns bring into every later
   * turn (they stay in the harness conversation).
   */
  private ctxSeen = { any: false, external: false, group: false };
  private readonly ctxLimits: { maxItems: number; maxChars: number };
  /** Context-only inputs recorded but not handed to a turn yet: original input id → entry, in arrival order. */
  private pendingCtx = new Map<string, PendingContext>();
  /** Pending context pushed out by `maxItems` before a turn took it (reported in the omitted line). */
  private ctxDropped = 0;
  /** Original ids of context inputs already handed to a turn (bounded). */
  private handedCtx = new Set<string>();
  private live: LiveInfo | undefined;
  /** Delegations (live.handoff) waiting for the turn the harness starts for them. */
  private handoffs = new Map<string, InputRecord>();
  private readonly guard: LoopGuard | undefined;
  /** The chain of the last turn: an adopted turn (no inputs in memory) keeps it. */
  private lastCause: TurnCause | undefined;

  constructor(private readonly o: LaneOptions) {
    this.sessionKey = o.sessionKey;
    this.adapter = o.harness;
    this.policy = withDefaults(o.policy);
    this.newId = o.newId ?? ((p) => `${p}_${randomUUID()}`);
    this.guard = o.loopGuard === false ? undefined : new LoopGuard(o.loopGuard ?? {});
    // A log written by an earlier host: continue its generations, and remember a turn it left open
    // so the harness can adopt it (turn.adopted) or the next turn settles it as ambiguous.
    const snap = o.hub.snapshot(o.sessionKey);
    this.generation = snap.generation;
    this.lastRun = snap.turn?.run;
    this.dangling = snap.turn ?? undefined;
    this.ctxLimits = {
      maxItems: Math.max(0, o.context?.maxItems ?? CONTEXT_DEFAULTS.maxItems),
      maxChars: Math.max(1, o.context?.maxChars ?? CONTEXT_DEFAULTS.maxChars),
    };
    // Context recorded but not handed over before the previous host stopped is still handed to the next turn.
    if (snap.seq > 0) this.rebuildContext(o.hub.log.read(o.sessionKey, 0));
  }

  // ---- public API ---------------------------------------------------------

  /** Apply a command. Commands and harness events are processed one at a time. */
  command(cmd: Command): Promise<CommandResult> {
    return this.serial(() => this.handle(cmd));
  }

  /**
   * Record a context-only input: logged with its record (so a restart can rebuild it),
   * never starts a turn, handed to the next turn that starts here ahead of that turn's
   * own inputs. Same inputId = revision, latest wins. Digest items are not handed: their
   * digest turn carries them.
   */
  observe(input: InputRecord): Promise<CommandResult> {
    return this.serial(async () => {
      this.recordContext(input);
      this.indexCause(input);
      return { ok: true, disposition: 'observe_only' } as const;
    });
  }

  private recordContext(input: InputRecord): void {
    this.observedInputs.set(input.inputId, input);
    const e = this.emit({ body: { t: 'input.admitted', inputId: input.inputId, disposition: 'observe_only', ...pid(input), input } });
    this.addContext(input, e.seq);
  }

  private indexCause(input: InputRecord): void {
    if (!input.cause || !this.o.onCause) return;
    try {
      this.o.onCause({ sessionKey: this.sessionKey, input });
    } catch {
      // indexing is best effort: the log has the record
    }
  }

  /**
   * The loop guard stopped `input`: it is recorded as context (labelled `loopGuard`,
   * handed to the next turn like any context), with a `loop_guard` notice for operators.
   * Never a turn, never anything on a channel.
   */
  private guarded(input: InputRecord, trip: LoopGuardTrip): CommandResult {
    const t = { ...trip, sessionKey: this.sessionKey };
    const record: InputRecord = { ...input, replyRoute: input.replyRoute, channelContext: { ...input.channelContext, loopGuard: trip.tripped } };
    this.recordContext(record);
    this.emit({ level: 'primary', visibility: 'operators', body: { t: 'notice', code: 'loop_guard', message: loopGuardMessage(trip, input.inputId) } });
    this.indexCause(record);
    try {
      this.o.onLoopGuard?.({ sessionKey: this.sessionKey, input: record, trip: t });
    } catch {
      // reporting elsewhere is best effort: this session's log has it
    }
    return { ok: true, disposition: 'observe_only' };
  }

  /** Context-only inputs the next turn will be handed (latest revisions, arrival order, before the bounds). */
  pendingContext(): InputRecord[] {
    return [...this.pendingCtx.values()].map((p) => p.input);
  }

  /** Record a `notice` in this session's log (e.g. a watch digest being delivered). */
  notice(message: string, level: 'primary' | 'detail' = 'detail'): Promise<void> {
    return this.serial(async () => {
      this.emit({ level, body: { t: 'notice', code: 'other', message } });
    });
  }

  /** Latest revision of every observe-only input, in first-seen order. */
  observed(): InputRecord[] {
    return [...this.observedInputs.values()];
  }

  /** Id of the adapter the session is (or was last) bound to; `harness` before the first open. */
  get harnessId(): string {
    return this.adapter.id;
  }

  /** Queued input ids, in order. */
  queued(): string[] {
    return this.queue.map((q) => q.input.inputId);
  }

  /**
   * Take the queued inputs `match` selects out of the queue (recorded as
   * `input.cancelled` with `reason`), e.g. to hand them to another session.
   */
  take(match: (input: InputRecord) => boolean, reason: string): Promise<InputRecord[]> {
    return this.serial(async () => {
      const taken = this.queue.filter((q) => match(q.input));
      if (!taken.length) return [];
      this.queue = this.queue.filter((q) => !taken.includes(q));
      this.emit({ body: { t: 'input.cancelled', inputIds: taken.map((q) => q.input.inputId), reason } });
      this.notifyIdle();
      return taken.map((q) => q.input);
    });
  }

  activeTurn(): { turnId: string; owner: string | null; inputIds: string[] } | undefined {
    const t = this.turn;
    return t && { turnId: t.turnId, owner: t.owner, inputIds: t.inputs.map((i) => i.inputId) };
  }

  /**
   * The running turn as policy hooks see it (reply route, inputs, deliveries), or
   * undefined when idle. Host tools resolve their destination from it.
   */
  currentTurn(): TurnContext | undefined {
    return this.turn ? this.context() : undefined;
  }

  /**
   * Where a turn's inputs came from (decision 4: tag, never block): who triggered
   * it, and whether its context holds watched / digest / context-only, external or
   * group content. Default: the running turn. Context-only inputs count for the turn
   * they are handed to and every later one (they stay in the harness conversation);
   * so do watched inputs (digests, watch triggers). Context recorded while a turn runs
   * is not in that turn: it counts from the next turn, which is handed it.
   */
  provenance(turnId?: string): TurnProvenance | undefined {
    const id = turnId ?? this.turn?.turnId;
    return id === undefined ? undefined : this.provenances.get(id);
  }

  /** `inputs` triggered the turn; `context` was handed ahead of them. */
  private track(turnId: string, inputs: InputRecord[], context: InputRecord[] = []): void {
    const ctx = context.filter((c) => c.channelContext.contextOmitted === undefined);
    // Relayed inputs bring the producing turn's flags along: an agent passing on a stranger's words is not a clean source.
    const carried = (k: 'external' | 'watched' | 'group') => inputs.some((i) => i.cause?.carried?.[k] === true);
    const cause = inputs.length ? turnCause(inputs) : this.lastCause;
    if (cause) this.lastCause = cause;
    const p: TurnProvenance = {
      sessionKey: this.sessionKey,
      turnId,
      triggeredBy: inputs.map((i) => i.origin.principal?.id ?? null),
      watched: this.ctxSeen.any || context.length > 0 || inputs.some(isWatched) || carried('watched'),
      external: this.ctxSeen.external || ctx.some(isExternal) || inputs.some(isExternal) || carried('external'),
      group: this.ctxSeen.group || ctx.some(isGroup) || inputs.some(isGroup) || carried('group'),
      ...(cause ? { cause } : {}),
    };
    this.provenances.set(turnId, p);
    for (const k of this.provenances.keys()) {
      if (this.provenances.size <= 256) break;
      this.provenances.delete(k);
    }
  }

  /** Harness binding generation of the open (or last) session. */
  get currentGeneration(): number {
    return this.generation;
  }

  /** Resolves when no turn is running or starting and the queue is empty. */
  whenIdle(): Promise<void> {
    if (!this.turn && this.queue.length === 0) return Promise.resolve();
    return new Promise((r) => this.idleWaiters.push(r));
  }

  /**
   * Close the harness session (its running turn is interrupted and recorded). Inputs
   * still queued are rejected right away (`lane_closed: <reason>`, with their reply
   * route so renderers tell the sender), and so is anything queued after this (a
   * requeue as the turn ends, an input whose admission was in flight): a closed lane
   * never runs another turn and its queue is in memory only.
   */
  async close(reason = 'lane closed'): Promise<void> {
    this.stopTimers(reason);
    await this.session?.close(reason);
  }

  /** The live running on this session, if any. */
  liveInfo(): LiveInfo | undefined {
    return this.live;
  }

  /**
   * Start realtime voice on this session's harness thread (decision 11). Opens the
   * harness when needed. Refuses a transport the harness's live does not list, before
   * `start`. A frames transport's video reaches only a live that declares `video`.
   * Resolves with the harness's SDP answer for the far side (webrtc).
   */
  async startLive(info: LiveInfo, args: Omit<LiveStartArgs, 'liveId'>): Promise<{ answerSdp?: string }> {
    const s = await this.serial(async () => {
      if (this.closed) throw new Error('session is closed');
      if (this.live) throw new Error(`a live (${this.live.title}) is already running in this session`);
      const s = await this.ensureSession(this.lastRun ?? (await this.policy.plan({ sessionKey: this.sessionKey, inputs: [] })));
      if (!s.live) throw new Error(`harness ${this.adapter.id} has no realtime voice (live)`);
      const takes = s.live.transports ?? ['webrtc'];
      if (!takes.includes(args.transport.type))
        throw new LiveTransportError(`harness ${this.adapter.id}'s live does not take the ${args.transport.type} transport (it takes: ${takes.join(', ')})`);
      this.live = info;
      return s;
    });
    const t = args.transport;
    const transport = t.type === 'frames' && !s.live!.video ? { ...t, media: { frames: audioOnly(t.media.frames), send: (f: LiveFrame) => t.media.send(f) } } : t;
    try {
      const r = await s.live!.start({ liveId: info.liveId, ...args, transport });
      await this.serial(async () => {
        this.emit({ body: { t: 'live.started', liveId: info.liveId, title: info.title, route: info.route, controlRoute: info.controlRoute } });
      });
      return r;
    } catch (e) {
      await this.serial(async () => {
        if (this.live?.liveId === info.liveId) this.live = undefined;
      });
      throw e;
    }
  }

  /** Have the live's voice say `text`. */
  async liveSay(text: string): Promise<void> {
    if (!this.live || !this.session?.live) throw new Error('no live is running in this session');
    await this.session.live.say(text);
  }

  /** End the live (its `live.ended` follows from the harness). */
  async stopLive(): Promise<void> {
    if (!this.live) return;
    await this.session?.live?.stop();
  }

  /**
   * Open the harness now instead of on the first input, e.g. so a resumed session
   * can adopt a turn that is still running natively. `run` defaults to the last turn's.
   */
  open(run?: RunSpec): Promise<void> {
    return this.serial(async () => {
      if (this.closed) return;
      await this.ensureSession(run ?? this.lastRun ?? (await this.policy.plan({ sessionKey: this.sessionKey, inputs: [] })));
    });
  }

  /**
   * Stop without touching the harness session (no interrupt, no close) and without
   * recording anything when its stream ends. For harnesses that outlive the host
   * (Codex over a Unix socket): call the adapter's own detach afterwards, and the
   * running turn stays open in the log for the next host to adopt.
   */
  detach(reason = 'detached'): void {
    this.detached = true;
    this.stopTimers(reason);
  }

  /**
   * Inputs queued behind the running turn (or the adopted one) are not: the queue is in
   * memory only, and no later host could run them. They are rejected like on `close`.
   */
  private stopTimers(reason: string): void {
    this.closed = true;
    this.closeReason = reason;
    for (const p of this.requests.values()) {
      if (p.timer) clearTimeout(p.timer);
      p.abort?.abort();
    }
    this.rejectQueue();
  }

  /**
   * A closed lane's queue: `input.rejected lane_closed: <reason>`, one event per reply
   * route (in queue order) so a renderer can tell each sender. Never the running turn's
   * inputs: its end (or the next host adopting it) settles them.
   */
  private rejectQueue(): void {
    if (!this.queue.length) return;
    const queued = this.queue;
    this.queue = [];
    const reason = `${LANE_CLOSED}: ${this.closeReason}`;
    for (const g of byRoute(queued.map((q) => q.input))) {
      this.emit({ body: { t: 'input.rejected', inputIds: g.ids, reason, ...(g.route ? { replyRoute: g.route } : {}) } });
    }
    this.notifyIdle();
  }

  // ---- serialisation ------------------------------------------------------

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => {});
    return run;
  }

  // ---- event helpers ------------------------------------------------------

  private emit(d: Partial<EventDraft> & Pick<EventDraft, 'body'>): SessionEvent {
    return this.o.hub.append(this.sessionKey, {
      ts: Date.now(),
      level: 'primary',
      audience: 'status',
      durability: 'durable',
      harness: this.adapter.id,
      generation: this.generation,
      ...d,
    });
  }

  private emitHarness(e: HarnessEvent, gen: number, override: Partial<HarnessEvent> = {}): SessionEvent {
    const merged = { ...e, ...override };
    return this.o.hub.append(this.sessionKey, {
      ...merged,
      harness: this.adapter.id,
      generation: gen,
      visibility: visibilityOf(merged),
    });
  }

  private setState(s: SessionState): void {
    if (this.state === s) return;
    this.state = s;
    this.emit({ body: { t: 'session.state', state: s } });
  }

  private refreshState(): void {
    if (!this.turn) return this.setState('idle');
    const waiting = [...this.requests.values()].some((r) => r.resolver.kind === 'human' || r.resolver.kind === 'host');
    this.setState(waiting ? 'requires_action' : 'running');
  }

  private context(turnId?: string): TurnContext {
    const t = this.turn && (!turnId || this.turn.turnId === turnId) ? this.turn : undefined;
    return {
      sessionKey: this.sessionKey,
      turnId: t?.turnId ?? turnId ?? '',
      run: t?.run ?? this.lastRun ?? { harness: this.adapter.id, model: 'default', profile: 'restricted' },
      inputs: t?.inputs ?? [],
      replyRoute: t?.replyRoute ?? null,
      ...(t?.owner != null ? { owner: t.owner } : {}),
      deliveries: t ? [...t.deliveries] : [],
    };
  }

  // ---- commands -----------------------------------------------------------

  private async handle(cmd: Command): Promise<CommandResult> {
    if (this.closed) return { ok: false, reason: 'closed' };
    if (cmd.sessionKey !== this.sessionKey) return { ok: false, reason: 'wrong_session' };
    switch (cmd.type) {
      case 'input': {
        const r = await this.input(cmd.input, cmd.mode, cmd.expectedTurnId);
        // Closed while its admission awaited a policy hook: it queued behind a lane that never runs again.
        if (this.closed) this.rejectQueue();
        return r;
      }
      case 'interrupt':
        return this.interrupt(cmd.origin, cmd.turnId, cmd.cancelQueue ?? false);
      case 'resolve':
        return this.resolveCommand(cmd.requestId, cmd.decision, cmd.origin, cmd.onBehalfOf);
      case 'control':
        return { ok: false, reason: 'unsupported' };
      case 'subscribe':
      case 'unsubscribe':
        return { ok: false, reason: 'use_hub_subscribe' };
    }
  }

  private async input(input: InputRecord, mode: InputMode, expectedTurnId?: string): Promise<CommandResult> {
    if (this.known.has(input.inputId)) return { ok: true, disposition: 'duplicate' };
    this.known.add(input.inputId);
    // The single loop checkpoint: every path that starts or joins a turn (queue, steer, interrupt) comes here.
    const trip = this.guard?.check(input);
    if (trip) return this.guarded(input, trip);
    this.indexCause(input);

    if (mode === 'steer') {
      const r = await this.trySteer(input, expectedTurnId);
      if (r) return r;
    } else if (mode === 'interrupt' && this.turn) {
      const t = this.turn;
      const allowed = (await this.policy.control({ sessionKey: this.sessionKey, op: 'interrupt', origin: input.origin, turn: this.context() })) === 'allow';
      if (allowed) {
        this.queue.unshift({ input, attempts: 0 });
        this.emit({ body: { t: 'input.admitted', inputId: input.inputId, disposition: 'queued', ...pid(input) } });
        await this.interruptTurn(t);
        return { ok: true, disposition: 'queued' };
      }
    }
    return this.enqueue(input);
  }

  private async enqueue(input: InputRecord): Promise<CommandResult> {
    const idle = !this.turn && this.queue.length === 0;
    this.queue.push({ input, attempts: 0 });
    const disposition = idle ? 'new_turn' : 'queued';
    this.emit({ body: { t: 'input.admitted', inputId: input.inputId, disposition, ...pid(input) } });
    if (idle) await this.pump();
    return { ok: true, disposition };
  }

  /** Returns a result when steered; undefined to fall back to queue. */
  private async trySteer(input: InputRecord, expectedTurnId?: string): Promise<CommandResult | undefined> {
    const t = this.turn;
    const degrade = (why: string) => {
      if (t) this.emit({ turnId: t.turnId, level: 'detail', body: { t: 'notice', code: 'other', message: `steer degraded to queue: ${why}` } });
      return undefined;
    };
    if (!t) return undefined;
    if (t.starting || !this.session || !t.run) return degrade('turn_starting');
    if (!this.caps || this.caps.steer === 'none') return degrade('unsupported');
    const p = principalId(input);
    if (p === undefined || p !== t.owner) return degrade('not_turn_owner');
    if (expectedTurnId && expectedTurnId !== t.turnId) return degrade('stale');
    // Steering must not change the turn's profile (permissions are never borrowed).
    const replan = await this.policy.plan({ sessionKey: this.sessionKey, inputs: [...t.inputs, input], previous: t.run });
    if (replan.profile !== t.run.profile) return degrade('profile_change');
    let res: Awaited<ReturnType<HarnessSession['steer']>>;
    try {
      res = await this.session.steer([input], t.turnId);
    } catch {
      res = 'unsupported';
    }
    if (res !== 'steered') return degrade(res);
    t.inputs.push(input);
    this.track(t.turnId, t.inputs, t.context);
    t.attempts.set(input.inputId, 0);
    this.emit({ turnId: t.turnId, body: { t: 'input.admitted', inputId: input.inputId, disposition: 'steer', ...pid(input) } });
    const extra = input.replyRoute;
    if (extra && !sameRoute(extra, t.replyRoute) && !t.deliveries.some((d) => sameRoute(d, extra))) {
      t.deliveries.push(extra);
      this.emit({ turnId: t.turnId, body: { t: 'turn.delivery_added', turnId: t.turnId, route: extra, reason: 'steer' } });
    }
    return { ok: true, disposition: 'steer' };
  }

  private async interrupt(origin: Origin, turnId: string | undefined, cancelQueue: boolean): Promise<CommandResult> {
    const t = this.turn;
    if (turnId && t?.turnId !== turnId) return { ok: false, reason: 'stale_turn' };
    if (!t && !cancelQueue) return { ok: false, reason: 'no_active_turn' };
    const allowed = async (op: 'interrupt' | 'cancel_queue', turn?: TurnContext) =>
      (await this.policy.control({ sessionKey: this.sessionKey, op, origin, ...(turn ? { turn } : {}) })) === 'allow';
    if (t && !(await allowed('interrupt', this.context()))) return { ok: false, reason: 'forbidden' };
    if (cancelQueue) {
      // Its own op: owning the running turn says nothing about other principals' queued inputs.
      // Without it, a caller still cancels the inputs it queued itself.
      const me = origin.principal?.id;
      const all = await allowed('cancel_queue');
      const cancel = all ? this.queue : this.queue.filter((q) => me !== undefined && principalId(q.input) === me);
      if (!t && !all && cancel.length === 0) return { ok: false, reason: 'forbidden' };
      if (cancel.length) {
        this.queue = this.queue.filter((q) => !cancel.includes(q));
        this.emit({ body: { t: 'input.cancelled', inputIds: cancel.map((q) => q.input.inputId), reason: 'interrupt' } });
      }
    }
    if (t) await this.interruptTurn(t);
    this.notifyIdle();
    return { ok: true };
  }

  private async interruptTurn(t: ActiveTurn): Promise<void> {
    if (t.starting) {
      t.interruptRequested = true;
      return;
    }
    await this.session?.interrupt(t.turnId);
  }

  // ---- context hand-over --------------------------------------------------

  /** A context-only input joins the pending context (latest revision wins, in its first-arrival position). */
  private addContext(input: InputRecord, seq: number): void {
    if (this.ctxLimits.maxItems === 0) return;
    if (input.channelContext.watchMode === 'digest') return; // the digest turn carries it
    const id = input.inputId;
    const prior = this.pendingCtx.get(id);
    if (prior) {
      this.pendingCtx.set(id, { ...prior, input });
      return;
    }
    // A revision of one an earlier turn already saw is handed again, under a fresh id
    // (harnesses key their messages by input id).
    const revised = this.handedCtx.has(id);
    this.pendingCtx.set(id, { input, handId: revised ? `${id}@${seq}` : id, revised });
    for (const k of this.pendingCtx.keys()) {
      if (this.pendingCtx.size <= this.ctxLimits.maxItems) break;
      this.pendingCtx.delete(k);
      this.ctxDropped++;
    }
  }

  /**
   * The context to hand a turn: the most recent pending entries within the bounds, in
   * arrival order, each marked `context: true` and routed like the turn (adapters take
   * the turn's reply route from its first input); first a line saying how many older
   * ones were left out, if any.
   */
  private takeContext(turnId: string, route: ReplyRoute | null): ContextBatch {
    const entries = [...this.pendingCtx];
    if (!entries.length) return { records: [], taken: [] };
    const { maxChars } = this.ctxLimits;
    const kept: InputRecord[] = [];
    let chars = 0;
    for (let i = entries.length - 1; i >= 0; i--) {
      const [, p] = entries[i]!;
      const n = charsOf(p.input.content);
      if (kept.length && chars + n > maxChars) break;
      // Only the newest one can be over the limit on its own: it is clipped, never left out.
      const clip = n > maxChars;
      kept.unshift({
        ...p.input,
        inputId: p.handId,
        replyRoute: route,
        content: clip ? clipContent(p.input.content, maxChars) : p.input.content,
        channelContext: {
          ...p.input.channelContext,
          context: true,
          ...(p.revised ? { contextRevised: true } : {}),
          ...(clip ? { contextClipped: true } : {}),
        },
      });
      chars += Math.min(n, maxChars);
    }
    const omitted = this.ctxDropped + entries.length - kept.length;
    if (omitted > 0) {
      kept.unshift({
        inputId: `ctxo_${turnId}`,
        origin: { kind: 'system', principal: null, evidence: 'none', via: `session:${this.sessionKey}`, adapter: 'session' },
        content: [{ type: 'text', text: `[${omitted} older context message${omitted === 1 ? '' : 's'} omitted]` }],
        replyRoute: route,
        channelContext: { context: true, contextOmitted: omitted },
      });
    }
    return { records: kept, taken: entries };
  }

  /** The turn took this context: it is not handed again. */
  private commitContext(batch: ContextBatch, inputs: InputRecord[]): void {
    for (const [id, p] of batch.taken) {
      if (this.pendingCtx.get(id) === p) this.pendingCtx.delete(id);
      this.markHanded(id);
    }
    if (batch.taken.length) this.ctxDropped = 0;
    for (const r of batch.records) if (r.channelContext.contextOmitted === undefined) this.flagSeen(r);
    for (const r of inputs) if (isWatched(r)) this.flagSeen(r);
  }

  private markHanded(id: string): void {
    this.handedCtx.delete(id);
    this.handedCtx.add(id);
    for (const k of this.handedCtx) {
      if (this.handedCtx.size <= 4096) break;
      this.handedCtx.delete(k);
    }
  }

  private flagSeen(r: InputRecord): void {
    this.ctxSeen.any = true;
    if (isExternal(r)) this.ctxSeen.external = true;
    if (isGroup(r)) this.ctxSeen.group = true;
  }

  /**
   * Replay an earlier host's log: context recorded (`input.admitted` observe_only, with
   * its record) that no turn's inputs took is pending again, and what turns were handed
   * (context, watched inputs) restores the provenance carried into later turns.
   */
  private rebuildContext(events: SessionEvent[]): void {
    const records = new Map<string, InputRecord>();
    for (const e of events) {
      const b = e.body;
      if (b.t === 'input.admitted' && b.input) {
        records.set(b.inputId, b.input);
        if (b.disposition === 'observe_only') {
          this.observedInputs.set(b.inputId, b.input);
          this.addContext(b.input, e.seq);
        }
      } else if (b.t === 'turn.started' || b.t === 'turn.adopted') {
        const ids = new Set(b.inputIds);
        // What a turn kept is the newest part of what was pending: everything up to the
        // newest entry it was handed was taken (handed, or left out as older).
        const entries = [...this.pendingCtx];
        let last = -1;
        entries.forEach(([, p], i) => {
          if (ids.has(p.handId)) last = i;
        });
        for (const [id, p] of entries.slice(0, last + 1)) {
          this.pendingCtx.delete(id);
          this.markHanded(id);
          if (ids.has(p.handId)) this.flagSeen(p.input);
        }
        if (last >= 0 || b.inputIds.some((id) => id.startsWith('ctxo_'))) this.ctxDropped = 0;
        for (const id of b.inputIds) {
          const r = records.get(id);
          if (r && isWatched(r)) this.flagSeen(r);
        }
      }
    }
  }

  // ---- turns --------------------------------------------------------------

  private takeBatch(): Queued[] {
    const head = this.queue.shift();
    if (!head) return [];
    const batch = [head];
    const key = batchKey(head.input);
    if (key !== null) {
      // Consecutive only: never let a later input jump ahead of someone else's.
      while (this.queue[0] && batchKey(this.queue[0].input) === key) batch.push(this.queue.shift()!);
    }
    return batch;
  }

  private async ensureSession(run: RunSpec): Promise<HarnessSession> {
    const adapter = this.o.harnessFor ? this.o.harnessFor(run.harness) : this.o.harness;
    if (this.session && adapter !== this.adapter) {
      // The turn names another harness: end this binding, the next one opens below.
      const old = this.session;
      this.session = undefined;
      this.emit({ level: 'detail', body: { t: 'notice', code: 'runtime_restart', message: `switching harness ${this.adapter.id} → ${adapter.id}` } });
      await old.close(`switching to harness ${adapter.id}`).catch(() => undefined);
    }
    if (this.session) return this.session;
    if (!this.caps || adapter !== this.adapter) this.caps = (await adapter.probe()).caps;
    this.adapter = adapter;
    const resume = this.o.resumeFor ? this.o.resumeFor(adapter.id) : this.o.resume;
    const gen = ++this.generation;
    const mcp = typeof this.o.mcp === 'function' ? this.o.mcp({ sessionKey: this.sessionKey, generation: gen, harnessId: adapter.id }) : this.o.mcp;
    const s = await adapter.open({
      sessionKey: this.sessionKey,
      generation: gen,
      cwd: this.o.cwd ?? process.cwd(),
      run,
      ...(resume !== undefined ? { resume } : {}),
      ...(mcp ? { mcp } : {}),
      ...(this.o.harnessOptions ? { options: this.o.harnessOptions } : {}),
    });
    this.session = s;
    void this.consume(s, gen);
    return s;
  }

  /**
   * A turn left open by an earlier host that no harness adopted: its outcome is unknown,
   * and its inputs the harness did not report consumed are rejected (`host_restarted`,
   * no route: the turn's card, finalized as ambiguous, already tells the sender).
   */
  private settleDangling(): void {
    const d = this.dangling;
    if (!d) return;
    this.dangling = undefined;
    this.emit({
      turnId: d.turnId,
      body: { t: 'turn.completed', turnId: d.turnId, status: 'ambiguous', error: { code: 'host_restarted', retryable: false, message: 'turn was running when the previous host stopped' } },
    });
    const left = unsettledInputsOf(this.o.hub.log.read(this.sessionKey, 0), d.turnId, d.inputIds);
    if (left.length) this.emit({ body: { t: 'input.rejected', inputIds: left, reason: HOST_RESTARTED } });
  }

  /**
   * Before settling a turn left open by an earlier host, open the harness and let
   * the events it queued on open (a `turn.adopted`) run first: they are behind this
   * task in the chain. Returns true when the pump was deferred.
   */
  private async awaitAdoption(): Promise<boolean> {
    if (!this.dangling || this.adoptionChecked) return false;
    this.adoptionChecked = true;
    try {
      await this.ensureSession(this.lastRun ?? (await this.policy.plan({ sessionKey: this.sessionKey, inputs: [] })));
    } catch {
      return false; // the turn's own start reports the failure
    }
    setTimeout(() => void this.serial(() => this.pump()).catch(() => undefined), 0);
    return true;
  }

  /** Start the next turn if idle. Loops past batches whose start fails. */
  private async pump(): Promise<void> {
    if (this.closed) this.rejectQueue();
    if (!this.turn && this.queue.length && !this.closed && (await this.awaitAdoption())) return;
    if (!this.turn && this.queue.length && !this.closed) this.settleDangling();
    while (!this.turn && this.queue.length && !this.closed) {
      const batch = this.takeBatch();
      const inputs = batch.map((q) => q.input);
      const t: ActiveTurn = {
        turnId: this.newId('turn'),
        inputs,
        attempts: new Map(batch.map((q) => [q.input.inputId, q.attempts])),
        owner: principalId(inputs[0]!) ?? null,
        replyRoute: inputs[0]!.replyRoute,
        run: undefined,
        starting: true,
        interruptRequested: false,
        deliveries: [],
        consumed: new Set(),
        foreignConsumed: false,
        context: [],
      };
      // Context recorded since the previous turn goes first: the model reads it before what it is asked.
      const ctx = this.takeContext(t.turnId, t.replyRoute);
      t.context = ctx.records;
      this.turn = t;
      this.track(t.turnId, inputs, ctx.records);
      try {
        const run = await this.policy.plan({ sessionKey: this.sessionKey, inputs, ...(this.lastRun ? { previous: this.lastRun } : {}) });
        t.run = run;
        this.lastRun = run;
        const s = await this.ensureSession(run);
        await s.startTurn(t.turnId, [...ctx.records, ...inputs], run);
        this.commitContext(ctx, inputs);
        t.starting = false;
        if (t.interruptRequested) await s.interrupt(t.turnId);
      } catch (err) {
        this.turn = undefined;
        // No turn.started, so no card: the reply route lets renderers tell the sender (one batch, one route).
        this.emit({
          body: { t: 'input.rejected', inputIds: inputs.map((i) => i.inputId), reason: `start_failed: ${errMsg(err)}`, ...(t.replyRoute ? { replyRoute: t.replyRoute } : {}) },
        });
      }
    }
    if (!this.turn) this.refreshState();
    this.notifyIdle();
  }

  private notifyIdle(): void {
    if (this.turn || this.queue.length) return;
    for (const w of this.idleWaiters.splice(0)) w();
  }

  // ---- harness events -----------------------------------------------------

  private async consume(s: HarnessSession, gen: number): Promise<void> {
    try {
      for await (const e of s.events) {
        if (gen !== this.generation || this.detached) continue; // late event from an older binding
        try {
          this.o.onHarnessEvent?.(e);
          // Re-checked when it runs: a switch to another harness may have started a new generation meanwhile.
          await this.serial(async () => (gen === this.generation ? this.onHarnessEvent(e, gen) : undefined));
        } catch (err) {
          // One bad event (a throwing hook, a failed log write) must not end the stream: record it and go on.
          await this.serial(async () => {
            this.emit({ ...(e.turnId ? { turnId: e.turnId } : {}), level: 'detail', body: { t: 'notice', code: 'other', message: `handling harness event ${e.body.t} failed: ${errMsg(err)}` } });
          }).catch(() => undefined);
        }
      }
    } catch (err) {
      if (this.detached) return;
      await this.serial(async () => {
        this.emit({ level: 'detail', body: { t: 'notice', code: 'runtime_restart', message: `harness stream failed: ${errMsg(err)}` } });
      }).catch(() => undefined);
      // The lane gives up on this session: close it rather than leave it running unowned.
      await s.close('harness stream failed').catch(() => undefined);
    }
    if (this.detached) return; // the turn keeps running natively; the next host adopts it
    await this.serial(() => this.onHarnessClosed(s, gen));
  }

  private async onHarnessClosed(s: HarnessSession, gen: number): Promise<void> {
    if (this.session !== s || gen !== this.generation) return;
    this.session = undefined;
    const t = this.turn;
    if (t && !t.starting) {
      // The harness died mid-turn: outcome unknown, never auto-retried.
      await this.finishTurn(t, { t: 'turn.completed', turnId: t.turnId, status: 'ambiguous', error: { code: 'harness_closed', retryable: false } }, undefined, gen);
    }
  }

  private async onHarnessEvent(e: HarnessEvent, gen: number): Promise<void> {
    const b = e.body;
    const t = this.turn;
    switch (b.t) {
      case 'live.handoff': {
        // The voice side delegated (decision 11): one input from the far side, no principal.
        const live = this.live?.liveId === b.liveId ? this.live : undefined;
        const record: InputRecord = {
          inputId: b.inputId,
          origin: {
            kind: 'human',
            principal: null,
            evidence: 'none',
            via: live ? routeKey(live.route) : `live:${b.liveId}`,
            adapter: live?.route.channel ?? 'live',
          },
          content: [{ type: 'transcript', text: b.text, startMs: 0, endMs: 0, stable: true }],
          replyRoute: live?.controlRoute ?? null,
          channelContext: { live: true, liveId: b.liveId, conversationKind: 'meeting', ...(live ? { liveTitle: live.title } : {}) },
        };
        this.emit({ body: { t: 'input.admitted', inputId: b.inputId, disposition: t ? 'steer' : 'new_turn', input: record } });
        this.emitHarness(e, gen);
        if (t) t.inputs.push(record);
        else {
          this.handoffs.set(b.inputId, record);
          for (const k of this.handoffs.keys()) {
            if (this.handoffs.size <= 32) break;
            this.handoffs.delete(k);
          }
        }
        return;
      }
      case 'live.ended':
        if (this.live?.liveId === b.liveId) this.live = undefined;
        this.emitHarness(e, gen);
        this.o.onLiveEnded?.(b.liveId, b.reason);
        return;
      case 'turn.started': {
        if (!t && b.initiator === 'harness') {
          // A turn the harness started for a delegation: the lane runs it like its own (queue
          // waits, tools and provenance see it). No reply route: the voice speaks the answer.
          const inputs = b.inputIds.map((id) => this.handoffs.get(id)).filter((r): r is InputRecord => !!r);
          for (const id of b.inputIds) this.handoffs.delete(id);
          this.turn = {
            turnId: b.turnId,
            inputs,
            attempts: new Map(),
            owner: null,
            replyRoute: null,
            run: this.lastRun,
            starting: false,
            interruptRequested: false,
            deliveries: [],
            consumed: new Set(inputs.map((i) => i.inputId)),
            foreignConsumed: false,
            context: [],
          };
          this.track(b.turnId, inputs);
          this.emitHarness(e, gen);
          this.refreshState();
          return;
        }
        const ours = t && t.turnId === b.turnId;
        const body = ours && b.owner === undefined && t.owner !== null ? { ...b, owner: t.owner } : b;
        this.emitHarness(e, gen, { body });
        this.refreshState();
        if (ours && this.o.thinkingHeadline !== null) {
          this.emit({ turnId: b.turnId, durability: 'ephemeral', body: { t: 'headline', text: this.o.thinkingHeadline ?? 'Thinking…' } });
        }
        return;
      }
      case 'turn.adopted': {
        // A turn still running natively from an earlier host; the lane owns it from here on.
        const d = this.dangling?.turnId === b.turnId ? this.dangling : undefined;
        if (d) this.dangling = undefined;
        if (!t) {
          this.turn = {
            turnId: b.turnId,
            inputs: [],
            adopted: new Set(b.inputIds),
            attempts: new Map(),
            owner: d?.owner ?? null,
            replyRoute: d?.replyRoute ?? null,
            run: b.run ?? d?.run,
            starting: false,
            interruptRequested: false,
            deliveries: d ? [...d.deliveries] : [],
            consumed: new Set(),
            foreignConsumed: false,
            context: [],
          };
          this.track(b.turnId, []);
        }
        this.emitHarness(e, gen);
        this.refreshState();
        return;
      }
      case 'input.consumed':
        if (t && t.turnId === b.turnId) {
          for (const id of b.inputIds) {
            if (t.context.some((c) => c.inputId === id)) continue; // context: consumed or not, nothing to reconcile
            if (t.inputs.some((i) => i.inputId === id) || t.adopted?.has(id)) t.consumed.add(id);
            else t.foreignConsumed = true;
          }
        }
        this.emitHarness(e, gen);
        return;
      case 'request.opened':
        return this.openRequest(e, b, gen);
      case 'request.resolved': {
        if (this.resolved.has(b.requestId)) return; // we already answered it (first wins)
        const p = this.requests.get(b.requestId);
        if (p) this.dropPending(b.requestId, p);
        this.resolved.add(b.requestId);
        this.emitHarness(e, gen, p ? { audience: p.audience } : {});
        this.refreshState();
        return;
      }
      case 'turn.completed':
        if (t && t.turnId === b.turnId) return this.finishTurn(t, b, e, gen);
        this.emitHarness(e, gen);
        return;
      case 'session.state':
        // The lane derives state from the turn lifecycle; harness states only add 'stalled'/'error'.
        if (b.state === 'stalled' || b.state === 'error') {
          this.state = b.state;
          this.emitHarness(e, gen);
        }
        return;
      default:
        this.emitHarness(e, gen);
    }
  }

  private async finishTurn(t: ActiveTurn, b: BodyOf<'turn.completed'>, e: HarnessEvent | undefined, gen: number): Promise<void> {
    for (const [id, p] of [...this.requests]) {
      if (p.turnId !== t.turnId) continue;
      this.dropPending(id, p);
      this.resolved.add(id);
      this.emit({ turnId: t.turnId, audience: p.audience, body: { t: 'request.resolved', requestId: id, decision: null, by: 'runtime_cancelled' } });
    }
    // admitted ≠ consumed: consuming inputs we never gave this turn means the harness merged on its own.
    const status = b.status === 'completed' && t.foreignConsumed ? 'ambiguous' : b.status;
    const body = { ...b, status };
    if (e) this.emitHarness(e, gen, { body });
    else this.emit({ turnId: t.turnId, body });

    const unconsumed = t.inputs.filter((i) => !t.consumed.has(i.inputId));
    const retry = status === 'completed' || (status === 'failed' && b.error?.retryable === true);
    const limit = this.o.requeueLimit ?? 1;
    const requeue: Queued[] = [];
    const rejected: string[] = [];
    for (const i of unconsumed) {
      const attempts = t.attempts.get(i.inputId) ?? 0;
      if (retry && attempts < limit) requeue.push({ input: i, attempts: attempts + 1 });
      else rejected.push(i.inputId);
    }
    if (rejected.length) {
      const reason = status === 'completed' || status === 'failed' ? 'not_consumed' : status;
      this.emit({ body: { t: 'input.rejected', inputIds: rejected, reason } });
    }
    for (const q of requeue) this.emit({ body: { t: 'input.admitted', inputId: q.input.inputId, disposition: 'queued', ...pid(q.input) } });
    this.queue.unshift(...requeue);

    this.turn = undefined;
    if (!this.queue.length) this.refreshState();
    await this.pump();
  }

  // ---- requests -----------------------------------------------------------

  private async openRequest(e: HarnessEvent, b: BodyOf<'request.opened'>, gen: number): Promise<void> {
    // Harnesses replay pending requests after a reconnect; the original is still waiting on its resolver.
    if (this.requests.has(b.requestId)) return;
    const ctx = this.context(e.turnId);
    const owner = this.turn?.owner ?? null;
    let resolver: Resolver;
    try {
      resolver = await this.policy.resolve(b, ctx);
    } catch (err) {
      resolver = { kind: 'auto', decision: { kind: 'deny', message: `policy error: ${errMsg(err)}` } };
    }
    if (resolver.kind === 'model' && !this.o.modelReviewer) resolver = await this.escalate(b, ctx);

    // A request without a turn id opened during a turn belongs to it; one opened while idle to no turn.
    const p: PendingRequest = { body: b, resolver, turnId: e.turnId ?? this.turn?.turnId, audience: audienceFor(resolver, e.audience) };
    this.requests.set(b.requestId, p);
    this.resolved.delete(b.requestId);
    this.emitHarness(e, gen, { body: { ...b, resolver }, audience: p.audience });

    switch (resolver.kind) {
      case 'auto':
        await this.settle(b.requestId, resolver.decision, { kind: 'auto' });
        return;
      case 'model':
        this.startReview(b.requestId, p, resolver, ctx, owner, gen);
        return;
      case 'human':
      case 'host':
        this.arm(b.requestId, p);
        this.refreshState();
        return;
    }
  }

  private startReview(id: string, p: PendingRequest, r: Resolver & { kind: 'model' }, ctx: TurnContext, owner: string | null, gen: number): void {
    const abort = new AbortController();
    p.abort = abort;
    this.arm(id, p);
    const reviewer = this.o.modelReviewer!;
    void reviewer({
      sessionKey: this.sessionKey,
      request: p.body,
      ctx,
      model: r.model,
      ...(r.prompt !== undefined ? { prompt: r.prompt } : {}),
      signal: abort.signal,
    })
      .catch((err: unknown) => ({ escalate: true as const, reason: errMsg(err) }))
      .then((out) =>
        this.serial(async () => {
          if (this.requests.get(id) !== p) return; // already settled (timeout, harness, turn end)
          if ('escalate' in out) {
            if (p.timer) clearTimeout(p.timer);
            const next = await this.escalate(p.body, ctx);
            const q: PendingRequest = { body: p.body, resolver: next, turnId: p.turnId, audience: audienceFor(next, 'approval') };
            this.requests.set(id, q);
            // Re-open with the escalated resolver; subscribers upsert by requestId.
            this.emit({ turnId: p.turnId, generation: gen, audience: q.audience, body: { ...p.body, resolver: next } });
            if (next.kind === 'auto') await this.settle(id, next.decision, { kind: 'auto' });
            else {
              this.arm(id, q);
              this.refreshState();
            }
            return;
          }
          await this.settle(id, out, { kind: 'model', id: r.model });
        }),
      )
      .catch(() => undefined); // failures are recorded inside; never an unhandled rejection
  }

  /** `policy.escalate`, guarded like `resolve`: a throwing hook denies the request (with a notice). */
  private async escalate(b: BodyOf<'request.opened'>, ctx: TurnContext): Promise<Resolver> {
    try {
      return await this.policy.escalate(b, ctx);
    } catch (err) {
      const message = `policy error: ${errMsg(err)}`;
      this.emit({ ...(ctx.turnId ? { turnId: ctx.turnId } : {}), level: 'detail', body: { t: 'notice', code: 'other', message: `escalate failed for ${b.requestId}: ${errMsg(err)}` } });
      return { kind: 'auto', decision: { kind: 'deny', message } };
    }
  }

  private arm(id: string, p: PendingRequest): void {
    if (p.timer) clearTimeout(p.timer);
    const ms = p.body.expiresAt !== undefined ? Math.max(0, p.body.expiresAt - Date.now()) : (this.o.requestTimeoutMs ?? 600_000);
    p.timer = setTimeout(() => {
      void this.serial(() => this.settle(id, { kind: 'deny', message: 'request timed out' }, 'timeout'));
    }, ms);
    p.timer.unref?.();
  }

  private dropPending(id: string, p: PendingRequest): void {
    if (p.timer) clearTimeout(p.timer);
    p.abort?.abort();
    this.requests.delete(id);
  }

  /** Record and deliver a decision. First caller wins; later ones get false. */
  private async settle(id: string, decision: Decision, by: ResolvedBy): Promise<boolean> {
    const p = this.requests.get(id);
    if (!p) return false;
    this.dropPending(id, p);
    this.resolved.add(id);
    this.emit({ turnId: p.turnId, audience: p.audience, body: { t: 'request.resolved', requestId: id, decision, by } });
    try {
      await this.session?.respond(id, decision);
    } catch (err) {
      this.emit({ turnId: p.turnId, level: 'detail', body: { t: 'notice', code: 'other', message: `respond failed: ${errMsg(err)}` } });
    }
    this.refreshState();
    return true;
  }

  private async resolveCommand(requestId: string, decision: Decision, origin: Origin, onBehalfOf?: string): Promise<CommandResult> {
    const p = this.requests.get(requestId);
    if (!p) return { ok: false, reason: this.resolved.has(requestId) ? 'already_resolved' : 'unknown_request' };
    let by: ResolvedBy;
    // A host relays a principal's answer: only a host connection may (system origin through the host adapter;
    // the gateway checks this too), and a human request still checks the principal.
    if (onBehalfOf !== undefined) {
      if (origin.kind !== 'system' || origin.adapter !== 'host' || !onBehalfOf) return { ok: false, reason: 'not_eligible' };
      const via = origin.principal?.id ?? origin.via;
      if (p.resolver.kind === 'human') {
        if (!p.resolver.principals.includes(onBehalfOf)) return { ok: false, reason: 'not_eligible' };
        by = { kind: 'human', id: onBehalfOf, via };
      } else if (p.resolver.kind === 'host') by = { kind: 'host', id: onBehalfOf, via };
      else return { ok: false, reason: 'not_awaiting_resolve' };
    } else if (p.resolver.kind === 'human') {
      const id = origin.principal?.id;
      if (!id || !p.resolver.principals.includes(id)) return { ok: false, reason: 'not_eligible' };
      by = { kind: 'human', id };
    } else if (p.resolver.kind === 'host') {
      if (origin.kind !== 'system') return { ok: false, reason: 'not_eligible' };
      by = { kind: 'host', ...(origin.principal ? { id: origin.principal.id } : {}) };
    } else return { ok: false, reason: 'not_awaiting_resolve' };
    if (!decisionAllowed(p.body, decision)) return { ok: false, reason: 'decision_not_allowed' };
    await this.settle(requestId, decision, by);
    return { ok: true };
  }
}

function decisionAllowed(b: BodyOf<'request.opened'>, d: Decision): boolean {
  if (d.kind === 'allow_session' && !b.allowAlways) return false;
  return b.allowedDecisions.length === 0 || b.allowedDecisions.includes(d.kind);
}

function audienceFor(r: Resolver, fallback: SessionEvent['audience']): SessionEvent['audience'] {
  return r.kind === 'human' || r.kind === 'host' ? 'approval' : fallback === 'approval' ? 'status' : fallback;
}

function visibilityOf(e: HarnessEvent): Visibility {
  if (e.audience === 'internal') return 'internal';
  if (e.body.t === 'native' || e.level === 'debug') return 'operators';
  return 'participants';
}

/**
 * Principal of an admitted input; inputs that arrived via a watch also carry the
 * record itself, so the target session's log shows what arrived and from where.
 */
/** `input.rejected` reason prefix: the lane closed (stop, restart, detach) with the input still queued. */
export const LANE_CLOSED = 'lane_closed';
/** `input.rejected` reason: an earlier host process left the input unsettled (a crash, or its turn was never adopted). */
export const HOST_RESTARTED = 'host_restarted';

/** Records grouped by reply route, in order of first appearance. */
function byRoute(inputs: InputRecord[]): { route: ReplyRoute | null; ids: string[] }[] {
  const groups = new Map<string, { route: ReplyRoute | null; ids: string[] }>();
  for (const i of inputs) {
    const k = i.replyRoute ? routeKey(i.replyRoute) : '-';
    const g = groups.get(k) ?? { route: i.replyRoute, ids: [] };
    g.ids.push(i.inputId);
    groups.set(k, g);
  }
  return [...groups.values()];
}

/** Inputs of `turnId` (started with `inputIds`, plus any steered into it) with no consumed / rejected / cancelled record. */
function unsettledInputsOf(events: SessionEvent[], turnId: string, inputIds: string[]): string[] {
  const ids = new Set(inputIds);
  for (const e of events) {
    const b = e.body;
    if (b.t === 'input.admitted' && b.disposition === 'steer' && e.turnId === turnId) ids.add(b.inputId);
  }
  for (const e of events) {
    const b = e.body;
    if (b.t === 'input.consumed' || b.t === 'input.rejected' || b.t === 'input.cancelled') for (const id of b.inputIds) ids.delete(id);
  }
  return [...ids];
}

/**
 * Inputs an earlier host process admitted and never started, consumed, rejected or
 * cancelled (`snapshot.queued`): it stopped without settling them (a crash; a clean stop
 * rejects its queue). Their records are not in the log, so they cannot be replayed:
 * records `input.rejected host_restarted` for them. Inputs of the turn the log shows open
 * are left to that turn (adopted, or settled by the next lane). Call once per process,
 * before any lane of the session exists (a lane closing in this process settles its own).
 * Returns the ids rejected.
 */
export function settleLeftoverInputs(hub: Hub, sessionKey: string): string[] {
  const snap = hub.snapshot(sessionKey);
  const ids = snap.queued.filter((id) => !snap.turn?.inputIds.includes(id));
  if (!ids.length) return [];
  hub.append(sessionKey, { ts: Date.now(), level: 'primary', audience: 'status', durability: 'durable', body: { t: 'input.rejected', inputIds: ids, reason: HOST_RESTARTED } });
  return ids;
}

function pid(i: InputRecord): { principalId?: string; input?: InputRecord } {
  const id = principalId(i);
  // Watched inputs and agent inputs (with a cause) keep their record in the log: where they came from, and their chain.
  return { ...(id === undefined ? {} : { principalId: id }), ...(i.channelContext.watch !== undefined || i.cause ? { input: i } : {}) };
}

/** Arrived through a watch (context, trigger) or is a digest of watched items. */
const isWatched = (i: InputRecord) => i.channelContext.watch !== undefined;

/** From a sender without a principal; a digest carries its senders' content. Host/system inputs are not external. */
const isExternal = (i: InputRecord) => i.origin.principal === null && (i.origin.kind !== 'system' || i.origin.adapter === 'watch');

const isGroup = (i: InputRecord) => {
  const k = i.channelContext.conversationKind;
  return (typeof k === 'string' && GROUPISH.has(k)) || i.channelContext.watchGroup === true;
};

/** Characters of content counted against `context.maxChars` (a media block counts as a short label). */
function charsOf(content: InputRecord['content']): number {
  let n = 0;
  for (const b of content) {
    switch (b.type) {
      case 'text':
      case 'quote':
      case 'transcript':
        n += b.text.length;
        break;
      case 'ref':
        n += b.uri.length + (b.title?.length ?? 0);
        break;
      case 'event':
        n += b.name.length + JSON.stringify(b.data).length;
        break;
      default:
        n += 32;
    }
  }
  return n;
}

/** Content cut to `max` characters in all (text-like blocks are clipped, the rest dropped once over). */
function clipContent(content: InputRecord['content'], max: number): InputRecord['content'] {
  let left = max;
  const out: InputRecord['content'] = [];
  for (const b of content) {
    if (left <= 0) break;
    if (b.type === 'text' || b.type === 'quote' || b.type === 'transcript') {
      const text = b.text.length > left ? `${b.text.slice(0, Math.max(0, left - 1))}…` : b.text;
      left -= text.length;
      out.push({ ...b, text });
    } else {
      const n = charsOf([b]);
      if (n > left) break;
      left -= n;
      out.push(b);
    }
  }
  return out;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** A frames transport's inbound frames without the video ones (for a live that does not take video). */
async function* audioOnly(frames: AsyncIterable<LiveFrame>): AsyncIterable<LiveFrame> {
  for await (const f of frames) if (f.kind !== 'video') yield f;
}

/** `startLive` was given a transport the harness's live does not take (nothing was started). */
export class LiveTransportError extends Error {
  override name = 'LiveTransportError';
}
