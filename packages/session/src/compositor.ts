import {
  routeKey,
  type BodyOf,
  type ChannelAdapter,
  type ChannelCaps,
  type DecisionKind,
  type RenderedMessage,
  type ReplyRoute,
  type SessionEvent,
  type Tier,
} from '@agents-io/protocol';
import type { Hub, Subscription } from './hub.js';
import { actionId } from './ingress.js';
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
}

export function newTurnView(turnId: string): TurnView {
  return { turnId, text: '', finalText: null, currentTool: null, headline: null, plan: null, pending: [], status: null };
}

/** Fold one event of the turn into its view. Returns whether anything visible changed. */
export function foldTurn(v: TurnView, e: SessionEvent): boolean {
  const b = e.body;
  switch (b.t) {
    case 'text.delta':
      if (b.stream !== 'answer') return false;
      v.text += b.delta;
      return true;
    case 'text.snapshot':
      if (e.audience !== 'answer') return false;
      v.text = b.text;
      if (b.final) v.finalText = b.text;
      return true;
    case 'item.started':
      v.currentTool = b.item.title;
      return true;
    case 'item.completed':
      if (v.currentTool !== b.item.title) return false;
      v.currentTool = null;
      return true;
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
      return true;
    default:
      return false;
  }
}

const DECISION_LABEL: Record<string, string> = { allow_once: 'Allow', allow_session: 'Always allow', deny: 'Deny' };
const STATUS_LABEL: Record<string, string> = { completed: 'Done', interrupted: 'Interrupted', failed: 'Failed', ambiguous: 'Outcome unknown' };

export interface RenderOptions {
  route?: ReplyRoute;
  caps?: Pick<ChannelCaps, 'buttons' | 'text'>;
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
      const sections: NonNullable<RenderedMessage['sections']> = [];
      if (v.plan && !done) {
        const mark = { pending: '○', in_progress: '◐', completed: '●' } as const;
        sections.push({ kind: 'details', text: v.plan.map((s) => `${mark[s.status]} ${s.text}`).join('\n'), collapsed: true });
      }
      if (statusLine) sections.push({ kind: 'status', text: statusLine });
      const text = done ? (v.finalText ?? v.text) : v.text || '…';
      return { text: clip(text), sections, ...(actions.length ? { actions } : {}) };
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
      if (b.replyRoute) this.track(b.turnId, b.replyRoute);
      return;
    }
    if (b.t === 'turn.delivery_added') {
      this.track(b.turnId, b.route);
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

  private track(turnId: string, route: ReplyRoute): void {
    if (route.channel !== this.o.adapter.id) return;
    const k = this.key(turnId, route);
    if (this.routes.has(k)) return;
    const caps = this.o.adapter.caps(route.account);
    const tier = this.o.tier ?? caps.defaultTier;
    const r: RouteState = {
      route,
      view: newTurnView(turnId),
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
    return renderTurn(r.view, r.tier, { route: r.route, caps: r.caps });
  }

  private async sendCard(r: RouteState): Promise<void> {
    const rec = await this.o.outbox.send(this.o.adapter, {
      operationId: `${this.base(r)}:open`,
      sessionKey: this.o.sessionKey,
      turnId: r.view.turnId,
      route: r.route,
      msg: this.render(r),
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
    const n = ++r.editSeq;
    r.lastEditAt = Date.now();
    await this.o.adapter.edit(r.route, r.messageId, this.render(r), {
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
