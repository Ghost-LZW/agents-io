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
  type Origin,
  type ReplyRoute,
  type ResolvedBy,
  type Resolver,
  type RunSpec,
  type SessionEvent,
  type TurnContext,
} from '@agents-io/protocol';
import type { Hub } from './hub.js';
import type { EventDraft, SessionState, Visibility } from './log.js';
import { withDefaults, type FullPolicy, type SessionPolicy } from './policy.js';

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
  mcp?: { url: string; token: string };
  harnessOptions?: Record<string, unknown>;
  modelReviewer?: ModelReviewer;
  /** Human/host requests without `expiresAt` are denied after this long (default 10 min). */
  requestTimeoutMs?: number;
  /** How many times an admitted-but-unconsumed input is re-queued before it is rejected (default 1). */
  requeueLimit?: number;
  /** Synthetic ephemeral headline right after `turn.started` (default `Thinking…`; null disables). */
  thinkingHeadline?: string | null;
  newId?: (prefix: string) => string;
  /** Tee of raw harness events (conformance checks, debugging). */
  onHarnessEvent?: (e: HarnessEvent) => void;
}

export type CommandResult =
  | { ok: true; disposition?: BodyOf<'input.admitted'>['disposition'] | 'duplicate' }
  | { ok: false; reason: string };

interface Queued {
  input: InputRecord;
  attempts: number;
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
}

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

  constructor(private readonly o: LaneOptions) {
    this.sessionKey = o.sessionKey;
    this.policy = withDefaults(o.policy);
    this.newId = o.newId ?? ((p) => `${p}_${randomUUID()}`);
  }

  // ---- public API ---------------------------------------------------------

  /** Apply a command. Commands and harness events are processed one at a time. */
  command(cmd: Command): Promise<CommandResult> {
    return this.serial(() => this.handle(cmd));
  }

  /** Record an observe-only input (logged, never starts a turn). Same inputId = revision, latest wins. */
  observe(input: InputRecord): Promise<CommandResult> {
    return this.serial(async () => {
      this.observedInputs.set(input.inputId, input);
      this.emit({ body: { t: 'input.admitted', inputId: input.inputId, disposition: 'observe_only', ...pid(input) } });
      return { ok: true, disposition: 'observe_only' } as const;
    });
  }

  /** Latest revision of every observe-only input, in first-seen order. */
  observed(): InputRecord[] {
    return [...this.observedInputs.values()];
  }

  /** Queued input ids, in order. */
  queued(): string[] {
    return this.queue.map((q) => q.input.inputId);
  }

  activeTurn(): { turnId: string; owner: string | null; inputIds: string[] } | undefined {
    const t = this.turn;
    return t && { turnId: t.turnId, owner: t.owner, inputIds: t.inputs.map((i) => i.inputId) };
  }

  /** Resolves when no turn is running or starting and the queue is empty. */
  whenIdle(): Promise<void> {
    if (!this.turn && this.queue.length === 0) return Promise.resolve();
    return new Promise((r) => this.idleWaiters.push(r));
  }

  async close(reason = 'lane closed'): Promise<void> {
    this.closed = true;
    for (const p of this.requests.values()) {
      if (p.timer) clearTimeout(p.timer);
      p.abort?.abort();
    }
    await this.session?.close(reason);
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
      harness: this.o.harness.id,
      generation: this.generation,
      ...d,
    });
  }

  private emitHarness(e: HarnessEvent, gen: number, override: Partial<HarnessEvent> = {}): SessionEvent {
    const merged = { ...e, ...override };
    return this.o.hub.append(this.sessionKey, {
      ...merged,
      harness: this.o.harness.id,
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
      run: t?.run ?? this.lastRun ?? { harness: this.o.harness.id, model: 'default', profile: 'restricted' },
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
      case 'input':
        return this.input(cmd.input, cmd.mode, cmd.expectedTurnId);
      case 'interrupt':
        return this.interrupt(cmd.origin, cmd.turnId, cmd.cancelQueue ?? false);
      case 'resolve':
        return this.resolveCommand(cmd.requestId, cmd.decision, cmd.origin);
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
    const op = t ? 'interrupt' : 'cancel_queue';
    if (!t && !cancelQueue) return { ok: false, reason: 'no_active_turn' };
    if ((await this.policy.control({ sessionKey: this.sessionKey, op, origin, ...(t ? { turn: this.context() } : {}) })) !== 'allow') {
      return { ok: false, reason: 'forbidden' };
    }
    if (cancelQueue && this.queue.length) {
      const ids = this.queue.map((q) => q.input.inputId);
      this.queue = [];
      this.emit({ body: { t: 'input.cancelled', inputIds: ids, reason: 'interrupt' } });
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
    if (this.session) return this.session;
    if (!this.caps) this.caps = (await this.o.harness.probe()).caps;
    const gen = ++this.generation;
    const s = await this.o.harness.open({
      sessionKey: this.sessionKey,
      generation: gen,
      cwd: this.o.cwd ?? process.cwd(),
      run,
      ...(this.o.resume !== undefined ? { resume: this.o.resume } : {}),
      ...(this.o.mcp ? { mcp: this.o.mcp } : {}),
      ...(this.o.harnessOptions ? { options: this.o.harnessOptions } : {}),
    });
    this.session = s;
    void this.consume(s, gen);
    return s;
  }

  /** Start the next turn if idle. Loops past batches whose start fails. */
  private async pump(): Promise<void> {
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
      };
      this.turn = t;
      try {
        const run = await this.policy.plan({ sessionKey: this.sessionKey, inputs, ...(this.lastRun ? { previous: this.lastRun } : {}) });
        t.run = run;
        this.lastRun = run;
        const s = await this.ensureSession(run);
        await s.startTurn(t.turnId, [...inputs], run);
        t.starting = false;
        if (t.interruptRequested) await s.interrupt(t.turnId);
      } catch (err) {
        this.turn = undefined;
        this.emit({
          body: { t: 'input.rejected', inputIds: inputs.map((i) => i.inputId), reason: `start_failed: ${errMsg(err)}` },
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
        if (gen !== this.generation) continue; // late event from an older binding
        this.o.onHarnessEvent?.(e);
        await this.serial(() => this.onHarnessEvent(e, gen));
      }
    } catch (err) {
      await this.serial(async () => {
        this.emit({ level: 'detail', body: { t: 'notice', code: 'runtime_restart', message: `harness stream failed: ${errMsg(err)}` } });
      });
    }
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
      case 'turn.started': {
        const ours = t && t.turnId === b.turnId;
        const body = ours && b.owner === undefined && t.owner !== null ? { ...b, owner: t.owner } : b;
        this.emitHarness(e, gen, { body });
        this.refreshState();
        if (ours && this.o.thinkingHeadline !== null) {
          this.emit({ turnId: b.turnId, durability: 'ephemeral', body: { t: 'headline', text: this.o.thinkingHeadline ?? 'Thinking…' } });
        }
        return;
      }
      case 'input.consumed':
        if (t && t.turnId === b.turnId) {
          for (const id of b.inputIds) {
            if (t.inputs.some((i) => i.inputId === id)) t.consumed.add(id);
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
      if (p.turnId !== undefined && p.turnId !== t.turnId) continue;
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
    const ctx = this.context(e.turnId);
    const owner = this.turn?.owner ?? null;
    let resolver: Resolver;
    try {
      resolver = await this.policy.resolve(b, ctx);
    } catch (err) {
      resolver = { kind: 'auto', decision: { kind: 'deny', message: `policy error: ${errMsg(err)}` } };
    }
    if (resolver.kind === 'model' && !this.o.modelReviewer) resolver = await this.policy.escalate(b, ctx);

    const p: PendingRequest = { body: b, resolver, turnId: e.turnId, audience: audienceFor(resolver, e.audience) };
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
            const next = await this.policy.escalate(p.body, ctx);
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
      );
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

  private async resolveCommand(requestId: string, decision: Decision, origin: Origin): Promise<CommandResult> {
    const p = this.requests.get(requestId);
    if (!p) return { ok: false, reason: this.resolved.has(requestId) ? 'already_resolved' : 'unknown_request' };
    let by: ResolvedBy;
    // Eligibility is re-checked here, server side, whatever the client showed.
    if (p.resolver.kind === 'human') {
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

function pid(i: InputRecord): { principalId?: string } {
  const id = principalId(i);
  return id === undefined ? {} : { principalId: id };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
