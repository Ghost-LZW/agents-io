import { randomUUID } from 'node:crypto';
import {
  InboundEnvelope,
  errors,
  routeKey,
  type Command,
  type ContentBlock,
  type DecisionKind,
  type InputRecord,
  type ChannelCaps,
  type Evidence,
  type Origin,
  type ReplyRoute,
  type Tier,
  type SessionLaunch,
  type SessionScope,
  type InboundItem,
} from '@agents-io/protocol';
import { channelRefOf, type HostQueue } from './host-queue.js';
import type { Hub } from './hub.js';
import type { CommandResult, Lane } from './lane.js';
import { conversationRouteKey, withDefaults, type FullPolicy, type SessionPolicy } from './policy.js';
import { Router, RouterError, defaultBindings, sourceOf, type Explanation, type RouteDelivery } from './router.js';
import type { TopicRecord } from './topics.js';
import { contentText, type WatchDelivery, type WatchDispatcher } from './watch.js';

const ACTION_PREFIX = 'req:';

/** Action id the compositor puts on approval buttons: `req:<requestId>:<decisionKind>`. */
export function actionId(requestId: string, kind: DecisionKind): string {
  return `${ACTION_PREFIX}${requestId}:${kind}`;
}

export function parseActionId(id: string): { requestId: string; kind: 'allow_once' | 'allow_session' | 'deny' } | undefined {
  if (!id.startsWith(ACTION_PREFIX)) return undefined;
  const cut = id.lastIndexOf(':');
  const kind = id.slice(cut + 1);
  const requestId = id.slice(ACTION_PREFIX.length, cut);
  if (!requestId || (kind !== 'allow_once' && kind !== 'allow_session' && kind !== 'deny')) return undefined;
  return { requestId, kind };
}

const STOP_PREFIX = 'turn:';
const STOP_SUFFIX = ':interrupt';

/** Action id of a stop button on a turn's card: `turn:<turnId>:interrupt`. A click becomes an `interrupt` command. */
export function interruptActionId(turnId: string): string {
  return `${STOP_PREFIX}${turnId}${STOP_SUFFIX}`;
}

export function parseInterruptActionId(id: string): { turnId: string } | undefined {
  if (!id.startsWith(STOP_PREFIX) || !id.endsWith(STOP_SUFFIX)) return undefined;
  const turnId = id.slice(STOP_PREFIX.length, id.length - STOP_SUFFIX.length);
  return turnId ? { turnId } : undefined;
}

/**
 * Thrown by `IngressOptions.lanes` when a session must not take input at all,
 * e.g. `agent_unavailable`: the agent it is pinned to is gone. Ingress answers
 * the delivery with `{ ok: false, reason: code }`, marks it in the explanation and
 * calls `onUnavailable`; any other error from `lanes` propagates.
 */
export class LaneUnavailableError extends Error {
  override name = 'LaneUnavailableError';
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface IngressOptions {
  policy?: SessionPolicy;
  /**
   * Lane for a session key; the host decides how lanes are created and kept.
   * `agent` is the binding's target agent (a named run configuration), absent for
   * watch deliveries and legacy admits. `launch` is a callout answer's launch for
   * the session (decision 7), already checked by the router's `launches`; the host
   * pins it when the lane is created. Throws `LaneUnavailableError` to refuse.
   */
  lanes: (sessionKey: string, agent?: string, launch?: SessionLaunch) => Lane | Promise<Lane>;
  /**
   * A table delivery was refused by `lanes` (`LaneUnavailableError`): tell the
   * session and, for a `dispatch` delivery, the route (a `context` delivery was never
   * addressed to the agent, so nothing is said there). Errors it throws are
   * reported to `onReplyError`.
   */
  onUnavailable?: (a: { sessionKey: string; agent?: string; on: RouteDelivery['on']; code: string; message: string; input: InputRecord }) => Promise<void> | void;
  /**
   * The binding tables. Default: a router with `defaultBindings({ agent: "default" })`
   * (bare route-key sessions) over `watches`, or — when the policy sets the
   * legacy `Policy.admit` — no table at all, so `admit` decides.
   */
  router?: Router;
  /** Where `on: "host"` inputs go. Without one they are only logged (`onHostUnavailable`). */
  hostQueue?: HostQueue;
  /**
   * The hub the lanes write to. When given, approval and stop clicks go to the
   * session that owns the request or turn (`Hub.locate`), not to the click's
   * conversation (card callbacks often carry another conversation kind, no thread).
   */
  hub?: Pick<Hub, 'locate'>;
  newId?: (prefix: string) => string;
  /**
   * Rewrite a routed envelope before it becomes an input, e.g. turn a click on
   * an `ask_choice` button (or a numbered reply) into a `choice` event for the
   * session that asked. Applies to the strongest table delivery (not to watch
   * deliveries). Return undefined to leave it unchanged.
   */
  rewrite?: (args: { env: InboundEnvelope; origin: Origin; sessionKey: string }) => InboundRewrite | undefined | Promise<InboundRewrite | undefined>;
  /** How many envelope ids to remember for dedup (default 10 000). */
  dedupWindow?: number;
  /** Watches: delivered through when a watch rule wins a session, and the digest machinery of `on: "digest"` rules. */
  watches?: WatchDispatcher;
  onWatchError?: (err: unknown) => void;
  /** A `host` rule matched but there is no `hostQueue`. */
  onHostUnavailable?: (args: { inputId: string; bindingId: string }) => void;
  /**
   * Capabilities of the adapter that renders replies to a route, and the tier it renders
   * at (default `caps.defaultTier`). When given, inputs with a reply route carry a
   * `reply` summary in channelContext (see {@link replySummary}).
   */
  replyCaps?: (channel: string, account: string) => { caps: ChannelCaps; tier?: Tier } | undefined;
  /**
   * Sends the short system reply to a topic command (`/new`, `/topics`, `/switch`) on
   * the route it came from (`sessionKey`: the topic session now current, where the delivery
   * is recorded); `operationId` is stable per command input. Without it the
   * command still acts, the reply is only in the result.
   */
  systemReply?: (a: { route: ReplyRoute; text: string; operationId: string; sessionKey: string }) => Promise<void>;
  /**
   * One line added to inputs routed to a conversation's current topic
   * (`channelContext.topicTools`), telling the model how to move between topics, e.g.
   * `TOPIC_TOOLS_HINT` when the agent has the session_* output tools. A function picks
   * it per target agent (undefined: none). Without it the input only names its topic.
   */
  topicHint?: string | ((agent: string | undefined) => string | undefined);
  onReplyError?: (err: unknown) => void;
}

export interface InboundRewrite {
  /** Deliver to this session instead (the one that asked the question). */
  sessionKey?: string;
  content?: ContentBlock[];
}

/** What happened at one target session. */
export interface DeliveryOutcome {
  bindingId: string;
  source: RouteDelivery['source'];
  on: RouteDelivery['on'];
  sessionKey: string;
  agent?: string;
  inputId?: string;
  result?: CommandResult;
  /** Watch and digest deliveries: what the watch machinery did. */
  watch?: WatchDelivery;
  /** The session refused it before it reached a lane (`LaneUnavailableError`). */
  unavailable?: { code: string; message: string };
}

/**
 * The configured channel instance an envelope was emitted by, as the caller (the
 * daemon) knows it — not as the envelope says. Passed to `Ingress.accept`, it binds
 * the envelope to that instance (channel-stamping, decision 13):
 * - `env.channel` / `env.account` (and the reply route's, when there is one) must be
 *   this channel and account, else the envelope is refused (`SOURCE_MISMATCH`);
 * - the sender's evidence is capped to `evidence` (anything else becomes `none`);
 * - `sender.declared` is dropped unless `declaresSender`.
 */
export interface EmitSource {
  /** Channel id: the adapter's id (a bridge's pinned hello id). */
  channel: string;
  /** The configured account. */
  account: string;
  /** Evidence this channel may give (deployment grant ∩ caps); `none` is always allowed. */
  evidence: readonly Evidence[];
  /** `caps.declaresSender`: whether it may attach a declared identity to inbound messages. */
  declaresSender: boolean;
}

/**
 * Stable prefix of `IngressResult.error` for an envelope that claims another channel,
 * account or reply route than the source that emitted it (refused, `action: "invalid"`).
 */
export const SOURCE_MISMATCH = 'source_mismatch:';

export interface IngressResult {
  /** The host durably took the envelope (also true for a deliberate drop). */
  accepted: boolean;
  /** The strongest table delivery: `dispatch`, else `observe` (context / digest), else `host` (only queued), else `drop`. */
  action: 'dispatch' | 'observe' | 'host' | 'drop' | 'resolve' | 'interrupt' | 'command' | 'duplicate' | 'invalid';
  inputId?: string;
  sessionKey?: string;
  origin?: Origin;
  result?: CommandResult;
  error?: string;
  /** Deliveries through watches (only when a watch rule won a session). */
  watched?: WatchDelivery[];
  /** Every target session, table rules and watches. */
  deliveries?: DeliveryOutcome[];
  /** Queued for the host. */
  host?: { cursor: number; duplicate: boolean; bindingId: string };
  /** Why (also persisted: `Router.explain(inputId)`). */
  explanation?: Explanation;
  /** A topic command was answered instead of delivering the input. */
  command?: { name: TopicCommand['name']; ok: boolean; reply: string; topic?: string };
  /**
   * The envelope as processed: with an `EmitSource`, evidence capped and `declared`
   * dropped. What the input, the host queue and records hold. The caller's object
   * is never changed; when nothing was capped this is that object.
   */
  envelope?: InboundEnvelope;
  /** The source capped the sender's evidence: what the envelope claimed. */
  claimedEvidence?: Evidence;
}

/**
 * Turns adapter claims into stamped, routed inputs. Identity is only ever
 * concluded by `Policy.identify`; whatever the envelope says about the sender is
 * evidence. Where the input goes is the `Router`'s binding tables.
 */
export class Ingress {
  private readonly policy: FullPolicy;
  private readonly router: Router;
  private readonly newId: (prefix: string) => string;
  private seen = new Map<string, IngressResult>();
  /** Envelopes being processed, so a concurrent duplicate waits for (and reuses) the first. */
  private inflight = new Map<string, Promise<IngressResult>>();
  /** `${channel}:${account}:${envelopeId}` → inputId, so revisions keep the original input id. */
  private inputIds = new Map<string, string>();

  constructor(private readonly o: IngressOptions) {
    this.policy = withDefaults(o.policy);
    this.newId = o.newId ?? ((p) => `${p}_${randomUUID()}`);
    this.router =
      o.router ??
      new Router({
        agents: [{ name: DEFAULT_AGENT, sessionPrefix: '' }],
        defaultAgent: DEFAULT_AGENT,
        ...(this.policy.admit ? { legacyAdmit: this.policy.admit } : { config: { version: 'default', bindings: defaultBindings({ agent: DEFAULT_AGENT }), identities: [] } }),
        ...(o.watches ? { watches: o.watches } : {}),
      });
  }

  /** A `ChannelContext.emit` implementation for one adapter, bound to `source` when given (see {@link EmitSource}). */
  emitter(source?: EmitSource): (env: InboundEnvelope) => Promise<{ accepted: boolean; inputId?: string }> {
    return async (env) => {
      const r = await this.accept(env, source);
      return { accepted: r.accepted, ...(r.inputId !== undefined ? { inputId: r.inputId } : {}) };
    };
  }

  /**
   * Stamp and route one envelope. With `source` it is bound to the channel instance
   * that emitted it ({@link EmitSource}); without one the caller is trusted as is
   * (an embedder feeding envelopes it built itself, tests).
   */
  async accept(env: InboundEnvelope, source?: EmitSource): Promise<IngressResult> {
    const errs = errors(InboundEnvelope, env);
    if (errs.length) return { accepted: false, action: 'invalid', error: errs.slice(0, 3).join('; ') };
    // Before dedup: a forged envelope must not get a real message's input id back as a duplicate.
    const bad = source && sourceMismatch(env, source);
    if (bad) return { accepted: false, action: 'invalid', error: `${SOURCE_MISMATCH} ${bad}` };
    const norm = source ? capEnvelope(env, source) : env;
    const capped = norm.sender.evidence !== env.sender.evidence ? { claimedEvidence: env.sender.evidence } : {};
    // Per account too: a platform message id is shared by every bot account that receives it.
    const key = envKey(norm.channel, norm.account, norm.id);
    const prior = this.seen.get(key);
    if (prior) return { ...prior, action: 'duplicate', envelope: norm, ...capped };
    const running = this.inflight.get(key);
    if (running) {
      const first = await running.catch(() => undefined);
      return first?.accepted ? { ...first, action: 'duplicate', envelope: norm, ...capped } : this.accept(env, source);
    }
    const p = this.process(norm, capped.claimedEvidence).then((r) => ({ ...r, envelope: norm, ...capped }));
    this.inflight.set(key, p);
    try {
      const r = await p;
      if (r.accepted) this.remember(key, r);
      return r;
    } finally {
      this.inflight.delete(key);
    }
  }

  private remember(key: string, r: IngressResult): void {
    this.seen.set(key, r);
    const max = this.o.dedupWindow ?? 10_000;
    for (const k of this.seen.keys()) {
      if (this.seen.size <= max) break;
      this.seen.delete(k);
      this.inputIds.delete(k);
    }
  }

  private async process(env: InboundEnvelope, claimedEvidence?: Evidence): Promise<IngressResult> {
    const identity = await this.policy.identify({
      channel: env.channel,
      account: env.account,
      channelUserId: env.sender.channelUserId,
      evidence: env.sender.evidence,
      ...(env.sender.isBot !== undefined ? { isBot: env.sender.isBot } : {}),
      ...(env.sender.declared !== undefined ? { declared: env.sender.declared } : {}),
    });
    const origin: Origin = {
      kind: identity.kind,
      principal: identity.principal,
      evidence: env.sender.evidence,
      ...(identity.declared !== undefined ? { declared: identity.declared } : {}),
      ...(identity.self ? { self: true } : {}),
      via: env.replyRoute ? routeKey(env.replyRoute) : conversationRouteKey(env),
      adapter: env.channel,
    };

    // A click on an approval or stop button acts on a request or turn: it goes to the session that
    // owns it (Hub index), which re-checks who may act (resolver eligibility, Policy.control, still
    // the running turn). Other action ids are inputs and route through the bindings (`actionPrefix`).
    const click = env.admission === 'drop' || origin.self ? undefined : actionClick(env);
    if (click) {
      const owner = this.o.hub ? this.o.hub.locate(click.kind === 'interrupt' ? { turnId: click.turnId } : { requestId: click.requestId }) : conversationRouteKey(env);
      const action = click.kind === 'interrupt' ? ('interrupt' as const) : ('resolve' as const);
      // Unknown id: answer without creating a lane for the click's conversation.
      if (owner === undefined) return { accepted: true, action, origin, result: { ok: false, reason: click.kind === 'interrupt' ? 'stale_turn' : 'unknown_request' } };
      let lane: Lane;
      try {
        lane = await this.o.lanes(owner);
      } catch (e) {
        if (!(e instanceof LaneUnavailableError)) throw e;
        return { accepted: true, action, sessionKey: owner, origin, result: { ok: false, reason: e.code } };
      }
      const cmd: Command =
        click.kind === 'interrupt'
          ? { type: 'interrupt', sessionKey: owner, turnId: click.turnId, origin }
          : { type: 'resolve', sessionKey: owner, requestId: click.requestId, decision: { kind: click.kind }, origin };
      const result = await lane.command(cmd);
      return { accepted: true, action, sessionKey: owner, origin, result };
    }

    const revisionOf = env.revisionOf !== undefined ? this.inputIds.get(envKey(env.channel, env.account, env.revisionOf)) : undefined;
    let input: InputRecord = {
      inputId: revisionOf ?? this.newId('in'),
      origin,
      content: env.content,
      replyRoute: env.replyRoute,
      channelContext: channelContext(env, this.replyOf(env)),
    };
    const decision = await this.router.route(env, origin, input);
    const own = decision.deliveries.filter((d) => d.source !== 'watch');
    // Latest-wins revisions keep the original input id, but only for context-only inputs:
    // a dispatched input may already be running, so its revision is a new input.
    if (revisionOf && own.some((d) => d.on === 'dispatch')) input = { ...input, inputId: this.newId('in') };
    this.inputIds.set(envKey(env.channel, env.account, env.id), input.inputId);
    const explanation: Explanation = { ...decision.explanation, inputId: input.inputId, ...(claimedEvidence !== undefined ? { claimedEvidence } : {}) };
    this.router.record(explanation);

    // The strongest table delivery is the input's own place (where a click on a choice is rewritten to).
    const primary = own.find((d) => d.on === 'dispatch') ?? own.find((d) => d.on === 'digest') ?? own[0];
    // `/new`, `/topics`, `/switch` addressed to a topic session act on its conversation's topics; nothing is delivered.
    const cmd = primary?.on === 'dispatch' && primary.topic && this.router.topics ? parseTopicCommand(env.content) : undefined;
    if (cmd && primary) return this.topicCommand(cmd, primary, env, origin, input, explanation);
    if (primary && this.o.rewrite) {
      const rw = await this.o.rewrite({ env, origin, sessionKey: primary.sessionKey });
      if (rw?.content) {
        env = { ...env, content: rw.content };
        input = { ...input, content: rw.content };
      }
      if (rw?.sessionKey && rw.sessionKey !== primary.sessionKey) {
        // Another table delivery already going there yields to the rewritten primary.
        const i = decision.deliveries.findIndex((d) => d !== primary && d.sessionKey === rw.sessionKey && d.source !== 'watch');
        if (i >= 0) decision.deliveries.splice(i, 1);
        primary.sessionKey = rw.sessionKey;
        // Labelled with the topic whose session answers it (e.g. a parked one that asked the question), or none.
        const t = this.router.topics?.bySession(rw.sessionKey);
        if (t) primary.topic = { id: t.id, conversation: t.conversation, ...(t.title !== undefined ? { title: t.title } : {}) };
        else delete primary.topic;
      }
    }

    const outcomes: DeliveryOutcome[] = [];
    const watched: WatchDelivery[] = [];
    for (const d of decision.deliveries) {
      if (d.source === 'watch') continue;
      outcomes.push(await this.deliverOwn(d, env, origin, input));
    }
    let host: IngressResult['host'];
    if (decision.host) {
      if (this.o.hostQueue) {
        const { raw: _raw, ...envelope } = env;
        const r = this.o.hostQueue.append({ channelRef: channelRefOf(env), account: env.account, bindingId: decision.host.bindingId, input, envelope, receivedAt: Date.now() });
        host = { ...r, bindingId: decision.host.bindingId };
      } else this.o.onHostUnavailable?.({ inputId: input.inputId, bindingId: decision.host.bindingId });
    }
    for (const d of decision.deliveries) {
      if (d.source !== 'watch' || !this.o.watches || d.watchId === undefined) continue;
      try {
        // No reply summary: it would describe the watched source, not where the reply goes.
        const w = await this.o.watches.deliverWatch(d.watchId, env, origin, channelContext(env, undefined));
        watched.push(w);
        outcomes.push({ bindingId: d.bindingId, source: d.source, on: d.on, sessionKey: d.sessionKey, ...(w.inputId ? { inputId: w.inputId } : {}), ...(w.result ? { result: w.result } : {}), watch: w });
      } catch (e) {
        this.o.onWatchError?.(e);
      }
    }

    // Refused deliveries say so in `explain` (recorded again, same input id).
    const refused = outcomes.filter((x) => x.unavailable && x.source !== 'watch');
    if (refused.length) {
      for (const m of explanation.matched) {
        const r = refused.find((x) => x.bindingId === m.bindingId && x.source === m.source);
        if (r) m.rejected = { code: r.unavailable!.code, message: r.unavailable!.message };
      }
      this.router.record(explanation);
    }

    const first = outcomes.find((x) => x.source !== 'watch' && x.on === 'dispatch') ?? outcomes.find((x) => x.source !== 'watch');
    const action: IngressResult['action'] = first ? (first.on === 'dispatch' ? 'dispatch' : 'observe') : host ? 'host' : 'drop';
    return {
      accepted: true,
      action,
      inputId: first?.inputId ?? input.inputId,
      ...(first ? { sessionKey: first.sessionKey } : {}),
      origin,
      ...(first?.result ? { result: first.result } : {}),
      ...(watched.length ? { watched } : {}),
      deliveries: outcomes,
      ...(host ? { host } : {}),
      explanation,
    };
  }

  /**
   * Deliver a queued host-inbound item to a session the host names (`inbound.redispatch`),
   * as the input it was when it arrived: same origin (sender, evidence, route), content,
   * reply route and channel context, plus `channelContext.redispatchedBy`. Its input id is
   * `<original>~r<cursor>`. Both explanations are recorded: the new input's
   * (`redispatchOf`), and the original's gains a `redispatched` entry. Idempotency
   * per cursor is the caller's (the queue records it, pending from `beforeDeliver`).
   * The delivery goes straight to the session: a topic command in the item's text
   * (`/new`, `/topics`, `/switch`) is plain input here, not handled as a command.
   */
  async redispatch(
    item: InboundItem,
    o: {
      agent?: string;
      session?: SessionScope;
      launch?: SessionLaunch;
      by: string;
      /** Called with the placed delivery before it is made: a refusal stops it (nothing delivered or recorded). */
      beforeDeliver?: (d: RouteDelivery, inputId: string, launch?: { cwd?: string; envKeys: string[]; outcome: string }) => { ok: true } | { ok: false; code: string; message: string };
    },
  ): Promise<{ ok: true; delivery: RouteDelivery; outcome: DeliveryOutcome; inputId: string; launch?: { cwd?: string; envKeys: string[]; outcome: string } } | { ok: false; code: string; message: string }> {
    const env = item.envelope;
    const origin = item.input.origin;
    const inputId = `${item.input.inputId}~r${item.cursor}`;
    let r: ReturnType<Router['redirect']>;
    try {
      r = this.router.redirect(env, origin, {
        inputId,
        ...(o.agent !== undefined ? { agent: o.agent } : {}),
        ...(o.session !== undefined ? { session: o.session } : {}),
        ...(o.launch !== undefined ? { launch: o.launch } : {}),
        redispatchOf: { inputId: item.input.inputId, cursor: item.cursor, by: o.by },
      });
    } catch (e) {
      if (e instanceof RouterError) return { ok: false, code: e.code === 'invalid' ? 'invalid_frame' : e.code, message: e.message };
      throw e;
    }
    if (!r.ok) return r;
    const { delivery, explanation } = r;
    const before = o.beforeDeliver?.(delivery, inputId, explanation.matched[0]!.launch);
    if (before && !before.ok) return before;
    const input: InputRecord = { ...item.input, inputId, channelContext: { ...item.input.channelContext, redispatchedBy: o.by } };
    const outcome = await this.deliverOwn(delivery, env, origin, input);
    if (outcome.unavailable) explanation.matched[0]!.rejected = { code: outcome.unavailable.code, message: outcome.unavailable.message };
    this.router.record(explanation);
    if (outcome.result?.ok !== false) {
      const orig = this.router.explain(item.input.inputId);
      if (orig) {
        const entry = { cursor: item.cursor, inputId, sessionKey: delivery.sessionKey, ...(delivery.agent ? { agent: delivery.agent } : {}), by: o.by, at: explanation.at };
        this.router.record({ ...orig, redispatched: [...(orig.redispatched ?? []), entry] });
      }
    }
    const launch = explanation.matched[0]!.launch;
    return { ok: true, delivery, outcome, inputId, ...(launch ? { launch } : {}) };
  }

  /** One table delivery: a turn, a context record, or a digest item. */
  private async deliverOwn(d: RouteDelivery, env: InboundEnvelope, origin: Origin, input: InputRecord): Promise<DeliveryOutcome> {
    const base = { bindingId: d.bindingId, source: d.source, on: d.on, sessionKey: d.sessionKey, ...(d.agent ? { agent: d.agent } : {}), inputId: input.inputId };
    if (d.on === 'digest' && this.o.watches && d.digest) {
      const w = await this.o.watches.deliverDigest(
        { rule: `${d.source}:${d.bindingId}`, sessionKey: d.sessionKey, digest: d.digest, source: sourceOf(d.match), ...(d.note !== undefined ? { note: d.note } : {}) },
        env,
        origin,
        channelContext(env, undefined),
      );
      return { ...base, ...(w.inputId ? { inputId: w.inputId } : {}), ...(w.result ? { result: w.result } : {}), watch: w };
    }
    let lane: Lane;
    try {
      lane = await this.o.lanes(d.sessionKey, d.agent, d.launch);
    } catch (e) {
      if (!(e instanceof LaneUnavailableError)) throw e;
      try {
        await this.o.onUnavailable?.({ sessionKey: d.sessionKey, ...(d.agent ? { agent: d.agent } : {}), on: d.on, code: e.code, message: e.message, input });
      } catch (err) {
        this.o.onReplyError?.(err);
      }
      return { ...base, result: { ok: false, reason: e.code }, unavailable: { code: e.code, message: e.message } };
    }
    // The model sees which topic it is in (and, in the current one, how to rotate or switch with the output tools).
    if (d.topic) {
      const current = this.router.topics?.get(d.topic.id)?.state !== 'parked';
      const hint = !current ? undefined : typeof this.o.topicHint === 'function' ? this.o.topicHint(d.agent) : this.o.topicHint;
      input = { ...input, channelContext: { ...input.channelContext, ...topicContext(d.topic, hint) } };
    }
    if (d.on === 'dispatch') {
      const result = await lane.command({ type: 'input', sessionKey: d.sessionKey, input, mode: d.mode ?? env.modeHint ?? 'queue' });
      return { ...base, result };
    }
    // context (or a digest without the watch machinery: recorded, never batched)
    const result = await lane.observe(input);
    return { ...base, result };
  }

  /** Answer a topic command, checked by `Policy.control` (as a `reset` of the session it was sent to). */
  private async topicCommand(cmd: TopicCommand, d: RouteDelivery, env: InboundEnvelope, origin: Origin, input: InputRecord, explanation: Explanation): Promise<IngressResult> {
    const topics = this.router.topics!;
    const conversation = d.topic!.conversation;
    const agent = d.agent ?? DEFAULT_AGENT;
    let ok = (await this.policy.control({ sessionKey: d.sessionKey, op: 'reset', origin })) === 'allow';
    let reply: string;
    let now: TopicRecord | undefined = topics.get(d.topic!.id);
    if (!ok) reply = 'Topic commands are only for the owner.';
    else if (cmd.name === 'new') {
      const r = this.router.newTopic(agent, conversation, cmd.arg ? { title: cmd.arg } : {}, 'user');
      now = r.topic;
      reply = `New topic${r.topic.title ? `: ${r.topic.title}` : ''}. Your next message starts it; /topics lists the earlier ones.`;
    } else {
      const list = topics.list({ conversation, agent });
      if (cmd.name === 'topics') reply = formatTopics(list);
      else {
        const arg = cmd.arg ?? '';
        const n = /^#?\d+$/.test(arg) ? Number(arg.replace('#', '')) : undefined;
        const target = n !== undefined ? list[n - 1] : list.find((t) => t.id === arg);
        if (!target) {
          ok = false;
          reply = arg ? `No topic ${arg}. /topics lists them.` : 'Usage: /switch <number or id> (see /topics).';
        } else if (target.state === 'current') reply = `Already in topic ${list.indexOf(target) + 1}${target.title ? `: ${target.title}` : ''}.`;
        else {
          now = topics.switchTo(target.id, 'user').topic;
          reply = `Switched to topic ${list.indexOf(target) + 1}${target.title ? `: ${target.title}` : ''}. It continues where it left off.`;
        }
      }
    }
    if (env.replyRoute && this.o.systemReply) {
      try {
        await this.o.systemReply({ route: env.replyRoute, text: reply, operationId: `topic-cmd:${input.inputId}`, sessionKey: now?.sessionKey ?? d.sessionKey });
      } catch (e) {
        this.o.onReplyError?.(e);
      }
    }
    return {
      accepted: true,
      action: 'command',
      inputId: input.inputId,
      sessionKey: now?.sessionKey ?? d.sessionKey,
      origin,
      explanation,
      command: { name: cmd.name, ok, reply, ...(now ? { topic: now.id } : {}) },
    };
  }

  private replyOf(env: InboundEnvelope): string | undefined {
    if (!env.replyRoute || !this.o.replyCaps) return undefined;
    try {
      const c = this.o.replyCaps(env.replyRoute.channel, env.replyRoute.account);
      return c ? replySummary(c.caps, c.tier ?? c.caps.defaultTier) : undefined;
    } catch {
      return undefined;
    }
  }
}

/** Agent name of the router `Ingress` builds when given none. */
export const DEFAULT_AGENT = 'default';

/**
 * How a reply to this input will be shown, as one compact line (`channelContext.reply`):
 * `<tier> markdown=<none|basic|full> maxChars=<n> buttons=<yes|no> media=<kinds|none>`,
 * e.g. `card markdown=basic maxChars=4000 buttons=yes media=image,file,audio`.
 * `tier` is the rendering tier (`card` streams one editable message with process;
 * `final` sends only the final answer once the turn ends; `full`/`headline` likewise
 * by name); `media` lists the kinds the adapter can send. Key names are stable.
 */
export function replySummary(caps: ChannelCaps, tier: Tier): string {
  const media = caps.media.out.length ? caps.media.out.join(',') : 'none';
  return `${tier} markdown=${caps.text.markdown} maxChars=${caps.text.maxChars} buttons=${caps.buttons ? 'yes' : 'no'} media=${media}`;
}

/** `IngressOptions.topicHint` for agents that have the session_* output tools. */
export const TOPIC_TOOLS_HINT =
  'this conversation keeps topics: if this message starts a clearly unrelated subject, call session_rotate (title, summary) and end the turn; if it returns to an earlier topic, call session_list then session_switch and end the turn; otherwise just answer';

/** What an input routed to a topic carries: the topic's id and title, and the hint when given. */
export function topicContext(t: { id: string; title?: string }, hint?: string): InputRecord['channelContext'] {
  return { topic: t.id, ...(t.title !== undefined ? { topicTitle: t.title } : {}), ...(hint ? { topicTools: hint } : {}) };
}

/** A chat command on topics: `/new [title]`, `/topics`, `/switch <n|id>`. */
export interface TopicCommand {
  name: 'new' | 'topics' | 'switch';
  arg?: string;
}

/** The topic command a message is, if it is one (one text block, the command first). */
export function parseTopicCommand(content: ContentBlock[]): TopicCommand | undefined {
  if (content.length !== 1 || content[0]!.type !== 'text') return undefined;
  const m = /^\/(new|topics|switch)(?:\s+([\s\S]*))?$/i.exec(contentText(content, 2000).trim());
  if (!m) return undefined;
  const name = m[1]!.toLowerCase() as TopicCommand['name'];
  const arg = m[2]?.replace(/\s+/g, ' ').trim();
  if (name === 'topics' && arg) return undefined;
  return { name, ...(arg ? { arg } : {}) };
}

/** The `/topics` answer: newest first, numbered as `/switch <n>` takes them, the current one marked. */
export function formatTopics(list: TopicRecord[], now = Date.now()): string {
  if (!list.length) return 'No topics yet.';
  const lines = list.map((t, i) => `${t.state === 'current' ? '▶' : '  '} ${i + 1}. ${t.title ?? '(untitled)'} · ${ago(now - t.lastActiveAt)}`);
  return [`Topics (▶ current):`, ...lines, '/switch <n> resumes one, /new [title] starts another.'].join('\n');
}

function ago(ms: number): string {
  const m = Math.floor(Math.max(0, ms) / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`;
}

const envKey = (channel: string, account: string, id: string) => `${channel}:${account}:${id}`;

/** Why an envelope does not belong to the source that emitted it, if it does not. */
function sourceMismatch(env: InboundEnvelope, s: EmitSource): string | undefined {
  const at = `emitted by (${s.channel}, ${s.account})`;
  if (env.channel !== s.channel || env.account !== s.account) return `envelope claims (${env.channel}, ${env.account}), ${at}`;
  const r = env.replyRoute;
  if (r && (r.channel !== s.channel || r.account !== s.account)) return `reply route names (${r.channel}, ${r.account}), ${at}`;
  return undefined;
}

/** The envelope with the sender capped to what the source may claim: a copy when anything changes, else `env` itself. */
function capEnvelope(env: InboundEnvelope, s: EmitSource): InboundEnvelope {
  const evidence = env.sender.evidence === 'none' || s.evidence.includes(env.sender.evidence) ? env.sender.evidence : 'none';
  const dropDeclared = env.sender.declared !== undefined && !s.declaresSender;
  if (evidence === env.sender.evidence && !dropDeclared) return env;
  const { declared, ...sender } = env.sender;
  return { ...env, sender: { ...sender, ...(declared !== undefined && !dropDeclared ? { declared } : {}), evidence } };
}

function actionClick(env: InboundEnvelope) {
  if (env.content.length !== 1) return undefined;
  const c = env.content[0]!;
  if (c.type !== 'event' || c.name !== 'action' || typeof c.data.actionId !== 'string') return undefined;
  const stop = parseInterruptActionId(c.data.actionId);
  if (stop) return { kind: 'interrupt' as const, turnId: stop.turnId };
  return parseActionId(c.data.actionId);
}

function channelContext(env: InboundEnvelope, reply: string | undefined): InputRecord['channelContext'] {
  const ctx: InputRecord['channelContext'] = {
    // Adapter-supplied facts (mail subject, chat name…) first; the core fields below win on clashes.
    ...env.context,
    channel: env.channel,
    conversationKind: env.conversation.kind,
    conversationId: env.conversation.id,
  };
  if (env.sender.displayName !== undefined) ctx.senderName = env.sender.displayName;
  if (env.sender.isBot !== undefined) ctx.senderIsBot = env.sender.isBot;
  if (env.sentAt !== undefined) ctx.sentAt = env.sentAt;
  if (reply !== undefined) ctx.reply = reply;
  return ctx;
}
