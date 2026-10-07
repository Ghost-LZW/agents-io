import {
  routeKey,
  type BodyOf,
  type ChannelAdapter,
  type ChannelCaps,
  type DecisionKind,
  type ItemSummary,
  type ProgressStep,
  type ProgressView,
  type RenderedMessage,
  type ReplyRoute,
  type SessionEvent,
  type Tier,
} from '@agents-io/protocol';
import type { Hub, Subscription } from './hub.js';
import { actionId, interruptActionId } from './ingress.js';
import type { Outbox } from './outbox.js';

/** What one turn looks like to a rendering end. */
export interface TurnView {
  turnId: string;
  text: string;
  finalText: string | null;
  currentTool: string | null;
  headline: string | null;
  plan: BodyOf<'plan.updated'>['steps'] | null;
  /** Requests routed to humans that are still open. */
  pending: BodyOf<'request.opened'>[];
  status: BodyOf<'turn.completed'>['status'] | null;
  /** Ordered process (reasoning, narration, tools) for native process UIs. */
  steps: ProgressStep[];
  /**
   * Text of the current assistant message. Unlike `text`, interim text that is
   * followed by a tool call moves into a narration step, so this ends as the answer.
   */
  answer: string;
  answerFinal: boolean;
  startedAt?: number;
  endedAt?: number;
}

export function newTurnView(turnId: string, startedAt?: number): TurnView {
  return {
    turnId,
    text: '',
    finalText: null,
    currentTool: null,
    headline: null,
    plan: null,
    pending: [],
    status: null,
    steps: [],
    answer: '',
    answerFinal: false,
    ...(startedAt !== undefined ? { startedAt } : {}),
  };
}

/** Bounds so a long turn cannot grow the view (and every render of it) without limit. */
const MAX_STEPS = 300;
const MAX_STEP_TEXT = 20_000;
const MAX_PREVIEW = 2_000;
const MAX_INPUT = 500;
/** Item types that are not tool calls: they never become `tool` steps. */
const NOT_TOOLS: ReadonlySet<ItemSummary['type']> = new Set<ItemSummary['type']>(['user_message', 'agent_message', 'reasoning']);

const clipTo = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

function appendCapped(text: string, delta: string): string {
  if (text.length >= MAX_STEP_TEXT) return text;
  const next = text + delta;
  return next.length > MAX_STEP_TEXT ? `${next.slice(0, MAX_STEP_TEXT - 1)}…` : next;
}

function pushStep(v: TurnView, step: ProgressStep): void {
  v.steps.push(step);
  if (v.steps.length > MAX_STEPS) v.steps.splice(0, v.steps.length - MAX_STEPS);
}

/** A reasoning block ends as soon as anything else happens in the turn. */
function closeReasoning(v: TurnView): void {
  for (const s of v.steps) if (s.kind === 'reasoning' && !s.done) s.done = true;
}

function textStep(v: TurnView, kind: 'reasoning' | 'narration', id: string | undefined): Extract<ProgressStep, { kind: 'reasoning' | 'narration' }> {
  const last = v.steps.at(-1);
  // Without an item id, consecutive deltas of the same kind belong to the open block.
  if (last && last.kind === kind && (id === undefined ? last.kind === 'narration' || !last.done : last.id === id)) return last;
  if (id !== undefined) {
    const known = v.steps.find((s) => s.kind === kind && s.id === id);
    if (known) return known as Extract<ProgressStep, { kind: 'reasoning' | 'narration' }>;
  }
  if (kind === 'reasoning') closeReasoning(v);
  const sid = id ?? `${kind === 'reasoning' ? 'r' : 'n'}${v.steps.length}`;
  const step: ProgressStep = kind === 'reasoning' ? { kind, id: sid, text: '', done: false } : { kind, id: sid, text: '' };
  pushStep(v, step);
  return step;
}

/** Interim answer text that a tool call follows was narration, not the answer. */
function answerToNarration(v: TurnView): void {
  if (!v.answer.trim() || v.answerFinal) return;
  pushStep(v, { kind: 'narration', id: `n${v.steps.length}`, text: clipTo(v.answer, MAX_STEP_TEXT) });
  v.answer = '';
}

function toolStep(v: TurnView, item: ItemSummary, parentItemId: string | undefined): void {
  const fields = {
    type: item.type,
    title: item.title,
    status: item.status,
    ...(item.inputSummary !== undefined ? { inputSummary: clipTo(item.inputSummary, MAX_INPUT) } : {}),
    ...(item.result ? { resultPreview: clipTo(item.result.preview, MAX_PREVIEW), isError: item.result.isError } : {}),
  };
  const known = v.steps.find((s): s is Extract<ProgressStep, { kind: 'tool' }> => s.kind === 'tool' && s.itemId === item.itemId);
  if (known) {
    Object.assign(known, fields);
    return;
  }
  closeReasoning(v);
  if (!parentItemId) answerToNarration(v);
  pushStep(v, { kind: 'tool', itemId: item.itemId, ...fields, ...(parentItemId ? { parentItemId } : {}) });
}

function reasoningItem(v: TurnView, item: ItemSummary, completed: boolean): boolean {
  const known = v.steps.find((s): s is Extract<ProgressStep, { kind: 'reasoning' }> => s.kind === 'reasoning' && s.id === item.itemId);
  if (known) {
    if (completed && !known.done) known.done = true;
    if (!known.text && completed && item.title && item.title !== 'Reasoning') known.text = item.title;
    return true;
  }
  if (!completed || !item.title || item.title === 'Reasoning') return false;
  closeReasoning(v);
  pushStep(v, { kind: 'reasoning', id: item.itemId, text: clipTo(item.title, MAX_STEP_TEXT), done: true });
  return true;
}

/** Fold one event of the turn into its view. Returns whether anything visible changed. */
export function foldTurn(v: TurnView, e: SessionEvent): boolean {
  const b = e.body;
  switch (b.t) {
    case 'text.delta':
      if (e.parentItemId !== undefined) return false; // a subagent's text is neither this turn's answer nor its thinking
      if (b.stream === 'reasoning') {
        const s = textStep(v, 'reasoning', e.itemId);
        s.text = appendCapped(s.text, b.delta);
        return true;
      }
      if (b.stream !== 'answer') return false;
      if (e.audience === 'commentary') {
        const s = textStep(v, 'narration', e.itemId);
        s.text = appendCapped(s.text, b.delta);
        return true;
      }
      closeReasoning(v);
      v.text += b.delta;
      v.answer += b.delta;
      return true;
    case 'text.snapshot':
      if (e.audience === 'commentary') {
        const s = textStep(v, 'narration', e.itemId);
        s.text = clipTo(b.text, MAX_STEP_TEXT);
        return true;
      }
      if (e.audience !== 'answer') return false;
      closeReasoning(v);
      v.text = b.text;
      v.answer = b.text;
      if (b.final) {
        v.finalText = b.text;
        v.answerFinal = true;
      }
      return true;
    case 'item.started':
      if (b.item.type === 'reasoning') return reasoningItem(v, b.item, false);
      if (NOT_TOOLS.has(b.item.type)) return false;
      toolStep(v, b.item, e.parentItemId);
      v.currentTool = b.item.title;
      return true;
    case 'item.completed': {
      if (b.item.type === 'reasoning') return reasoningItem(v, b.item, true);
      if (NOT_TOOLS.has(b.item.type)) return false;
      toolStep(v, b.item, e.parentItemId);
      if (v.currentTool === b.item.title) v.currentTool = null;
      return true;
    }
    case 'headline':
      v.headline = b.text;
      return true;
    case 'plan.updated':
      v.plan = b.steps;
      return true;
    case 'request.opened':
      v.pending = v.pending.filter((r) => r.requestId !== b.requestId);
      if (b.resolver?.kind === 'human') v.pending.push(b);
      return true;
    case 'request.resolved': {
      const n = v.pending.length;
      v.pending = v.pending.filter((r) => r.requestId !== b.requestId);
      return v.pending.length !== n;
    }
    case 'turn.completed':
      v.status = b.status;
      v.currentTool = null;
      v.pending = [];
      if (v.finalText === null && v.text) v.finalText = v.text;
      closeReasoning(v);
      if (v.finalText !== null && !v.answer) v.answer = v.finalText;
      v.answerFinal = true;
      v.endedAt = e.ts;
      return true;
    default:
      return false;
  }
}

/** The cumulative structured view of a turn (`RenderedMessage.progress`). */
export function progressOf(v: TurnView): ProgressView {
  return {
    turnId: v.turnId,
    status: v.status ?? (v.pending.length ? 'requires_action' : 'running'),
    ...(v.headline !== null ? { headline: v.headline } : {}),
    steps: v.steps.map((s) => ({ ...s })),
    ...(v.plan ? { plan: v.plan.map((p) => ({ ...p })) } : {}),
    answer: v.answer,
    answerFinal: v.answerFinal,
    ...(v.startedAt !== undefined ? { startedAt: v.startedAt } : {}),
    ...(v.endedAt !== undefined ? { endedAt: v.endedAt } : {}),
  };
}

const DECISION_LABEL: Record<string, string> = { allow_once: 'Allow', allow_session: 'Always allow', deny: 'Deny' };
const STATUS_LABEL: Record<string, string> = { completed: 'Done', interrupted: 'Interrupted', failed: 'Failed', ambiguous: 'Outcome unknown' };

export interface RenderOptions {
  route?: ReplyRoute;
  caps?: Pick<ChannelCaps, 'buttons' | 'text'>;
  /** Offer a stop button (`interruptActionId`) while the turn runs, on card/full tiers. */
  interrupt?: boolean;
}

/** Render a turn view for one tier. Pending human requests always show. */
export function renderTurn(v: TurnView, tier: Tier, o: RenderOptions = {}): RenderedMessage {
  const max = o.caps?.text.maxChars ?? Number.MAX_SAFE_INTEGER;
  const clip = (s: string) => (s.length > max ? s.slice(0, Math.max(0, max - 1)) + '…' : s);
  const here = o.route ? routeKey(o.route) : undefined;
  const actions: NonNullable<RenderedMessage['actions']> = [];
  const asks: string[] = [];
  for (const r of v.pending) {
    asks.push(`Approval needed: ${r.title}`);
    const routes = r.resolver?.kind === 'human' ? r.resolver.routes : [];
    // Buttons only where the resolver said people answer; elsewhere just say it is waiting.
    if (o.caps?.buttons === false || (routes.length && here && !routes.includes(here))) continue;
    for (const d of r.allowedDecisions) {
      if (d === 'allow_session' && !r.allowAlways) continue;
      if (!(d in DECISION_LABEL)) continue;
      actions.push({ id: actionId(r.requestId, d as DecisionKind), label: DECISION_LABEL[d]!, ...(d === 'deny' ? { style: 'danger' as const } : d === 'allow_once' && !r.defaultDeny ? { style: 'primary' as const } : {}) });
    }
  }
  const done = v.status !== null;
  const statusLine = asks[0] ?? (done ? STATUS_LABEL[v.status!] : v.currentTool ? `▶ ${v.currentTool}` : (v.headline ?? 'Working…'));

  switch (tier) {
    case 'headline': {
      const line = clip(statusLine ?? '');
      return { text: line, spokenText: line, ...(actions.length ? { actions } : {}) };
    }
    case 'final': {
      if (!done && asks.length) return { text: clip(asks.join('\n')), ...(actions.length ? { actions } : {}) };
      return { text: clip(v.finalText ?? v.text) };
    }
    case 'card':
    case 'full': {
      if (o.interrupt && !done && o.caps?.buttons !== false) {
        actions.push({ id: interruptActionId(v.turnId), label: 'Stop', style: 'danger' });
      }
      const sections: NonNullable<RenderedMessage['sections']> = [];
      if (v.plan && !done) {
        const mark = { pending: '○', in_progress: '◐', completed: '●' } as const;
        sections.push({ kind: 'details', text: v.plan.map((s) => `${mark[s.status]} ${s.text}`).join('\n'), collapsed: true });
      }
      if (statusLine) sections.push({ kind: 'status', text: statusLine });
      const text = done ? (v.finalText ?? v.text) : v.text || '…';
      return { text: clip(text), sections, ...(actions.length ? { actions } : {}), progress: progressOf(v) };
    }
  }
}

export interface CompositorOptions {
  hub: Hub;
  sessionKey: string;
  adapter: ChannelAdapter;
  outbox: Outbox;
  /** Override the adapter's default tier. */
  tier?: Tier;
  /** Edit interval when the channel declares no native stream limit (default 1000 ms). */
  throttleMs?: number;
  /** Sender identity attached to every send (required when caps.declaresSender). */
  as?: string;
  /** Put a stop button on streaming cards while the turn runs (see `interruptActionId`). Default false. */
  interruptButton?: boolean;
  onError?: (err: unknown) => void;
}

interface RouteState {
  route: ReplyRoute;
  view: TurnView;
  caps: ChannelCaps;
  tier: Tier;
  streaming: boolean;
  messageId?: string;
  editSeq: number;
  lastEditAt: number;
  /** Serialised last render sent, so an unchanged render is not sent again. */
  lastRender?: string;
  timer?: ReturnType<typeof setTimeout>;
  chain: Promise<void>;
  sentRequests: Set<string>;
  finished: boolean;
}

/**
 * Renders the turns of one session onto one channel adapter: for each turn whose
 * reply route (or added delivery) is on this channel, send a message, edit it as
 * the turn progresses (throttled), and finalize it when the turn ends. Channels
 * that cannot edit, and the `final` tier, get one message per turn plus one per
 * human request.
 */
export class Compositor {
  private sub: Subscription | undefined;
  private routes = new Map<string, RouteState>();
  private loop: Promise<void> | undefined;

  constructor(private readonly o: CompositorOptions) {}

  start(): void {
    if (this.sub) return;
    this.sub = this.o.hub.subscribe({ sessionKey: this.o.sessionKey, fromSeq: this.o.hub.log.head(this.o.sessionKey), tier: 'full' });
    const sub = this.sub;
    this.loop = (async () => {
      for await (const e of sub) this.onEvent(e);
    })();
  }

  async stop(): Promise<void> {
    this.sub?.close();
    await this.loop;
    for (const r of this.routes.values()) if (r.timer) clearTimeout(r.timer);
    await this.flush();
  }

  /** Wait for every queued send/edit/finalize. */
  async flush(): Promise<void> {
    await Promise.all([...this.routes.values()].map((r) => r.chain));
  }

  private key(turnId: string, route: ReplyRoute) {
    return `${turnId}\u0000${routeKey(route)}`;
  }

  private onEvent(e: SessionEvent): void {
    const b = e.body;
    if (b.t === 'turn.started') {
      if (b.replyRoute) this.track(b.turnId, b.replyRoute, e.ts);
      return;
    }
    if (b.t === 'turn.delivery_added') {
      this.track(b.turnId, b.route, e.ts);
      return;
    }
    const turnId = e.turnId ?? (b.t === 'turn.completed' ? b.turnId : undefined);
    if (!turnId) return;
    for (const r of this.routes.values()) {
      if (r.view.turnId !== turnId || r.finished) continue;
      if (!foldTurn(r.view, e)) continue;
      if (b.t === 'turn.completed') this.finish(r);
      else this.changed(r, b.t === 'request.opened' ? b.requestId : undefined);
    }
  }

  private track(turnId: string, route: ReplyRoute, startedAt: number): void {
    if (route.channel !== this.o.adapter.id) return;
    const k = this.key(turnId, route);
    if (this.routes.has(k)) return;
    const caps = this.o.adapter.caps(route.account);
    const tier = this.o.tier ?? caps.defaultTier;
    const r: RouteState = {
      route,
      view: newTurnView(turnId, startedAt),
      caps,
      tier,
      streaming: caps.edit && !!this.o.adapter.edit && tier !== 'final',
      editSeq: 0,
      lastEditAt: 0,
      chain: Promise.resolve(),
      sentRequests: new Set(),
      finished: false,
    };
    this.routes.set(k, r);
    // Send right away so the end is never blank while the harness thinks.
    if (r.streaming) this.enqueue(r, () => this.sendCard(r));
  }

  private interval(r: RouteState): number {
    return r.caps.nativeStream?.minIntervalMs ?? this.o.throttleMs ?? 1000;
  }

  private base(r: RouteState): string {
    return `${this.o.sessionKey}:${r.view.turnId}:${routeKey(r.route)}`;
  }

  private enqueue(r: RouteState, fn: () => Promise<void>): void {
    r.chain = r.chain.then(fn).catch((err) => this.o.onError?.(err));
  }

  private render(r: RouteState): RenderedMessage {
    return renderTurn(r.view, r.tier, { route: r.route, caps: r.caps, ...(this.o.interruptButton ? { interrupt: true } : {}) });
  }

  private async sendCard(r: RouteState): Promise<void> {
    const msg = this.render(r);
    r.lastRender = JSON.stringify(msg);
    const rec = await this.o.outbox.send(this.o.adapter, {
      operationId: `${this.base(r)}:open`,
      sessionKey: this.o.sessionKey,
      turnId: r.view.turnId,
      route: r.route,
      msg,
      ...(this.o.as !== undefined ? { as: this.o.as } : {}),
    });
    r.lastEditAt = Date.now();
    if (rec.status === 'delivered' && rec.providerMessageId) {
      r.messageId = rec.providerMessageId;
      this.o.hub.append(this.o.sessionKey, {
        ts: Date.now(),
        turnId: r.view.turnId,
        level: 'detail',
        audience: 'status',
        durability: 'durable',
        visibility: 'operators',
        body: { t: 'render.anchor', route: r.route, turnId: r.view.turnId, providerMessageId: rec.providerMessageId },
      });
    }
  }

  private changed(r: RouteState, openedRequest?: string): void {
    if (!r.streaming) {
      // No edits: a human request still has to reach people, as its own message.
      const req = openedRequest && r.view.pending.find((p) => p.requestId === openedRequest);
      if (req && !r.sentRequests.has(req.requestId)) {
        r.sentRequests.add(req.requestId);
        const msg = renderTurn({ ...r.view, pending: [req] }, 'final', { route: r.route, caps: r.caps });
        this.enqueue(r, async () => {
          await this.o.outbox.send(this.o.adapter, {
            operationId: `${this.base(r)}:req:${req.requestId}`,
            sessionKey: this.o.sessionKey,
            turnId: r.view.turnId,
            route: r.route,
            msg,
            ...(this.o.as !== undefined ? { as: this.o.as } : {}),
          });
        });
      }
      return;
    }
    if (r.timer) return; // an edit is already scheduled and will pick up this change
    const wait = Math.max(0, r.lastEditAt + this.interval(r) - Date.now());
    // Approvals skip the throttle: they are what a person is waiting to act on.
    const delay = openedRequest ? 0 : wait;
    r.timer = setTimeout(() => {
      r.timer = undefined;
      this.enqueue(r, () => this.edit(r));
    }, delay);
  }

  private async edit(r: RouteState): Promise<void> {
    if (r.finished || !r.messageId || !this.o.adapter.edit) return;
    const msg = this.render(r);
    const json = JSON.stringify(msg);
    if (json === r.lastRender) return;
    r.lastRender = json;
    const n = ++r.editSeq;
    r.lastEditAt = Date.now();
    await this.o.adapter.edit(r.route, r.messageId, msg, {
      operationId: `${this.base(r)}:edit:${n}`,
      sequence: n,
      ...(this.o.as !== undefined ? { as: this.o.as } : {}),
    });
  }

  private finish(r: RouteState): void {
    r.finished = true;
    if (r.timer) clearTimeout(r.timer);
    r.timer = undefined;
    this.enqueue(r, async () => {
      const msg = this.render(r);
      const d = { operationId: `${this.base(r)}:final`, sessionKey: this.o.sessionKey, turnId: r.view.turnId, route: r.route };
      const id = r.messageId;
      const adapter = this.o.adapter;
      if (r.streaming && id) {
        await this.o.outbox.deliver(d, async () => {
          if (adapter.finalize) await adapter.finalize(r.route, id, msg);
          else await adapter.edit!(r.route, id, msg, { operationId: d.operationId, sequence: ++r.editSeq });
          return { providerMessageId: id };
        });
      } else {
        await this.o.outbox.send(adapter, { ...d, msg, ...(this.o.as !== undefined ? { as: this.o.as } : {}) });
      }
    });
    this.enqueue(r, async () => {
      this.routes.delete(this.key(r.view.turnId, r.route));
    });
  }
}
