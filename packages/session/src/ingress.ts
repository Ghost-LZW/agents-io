import { randomUUID } from 'node:crypto';
import {
  InboundEnvelope,
  errors,
  routeKey,
  type Command,
  type DecisionKind,
  type InputRecord,
  type ChannelCaps,
  type Origin,
  type Tier,
} from '@agents-io/protocol';
import type { CommandResult, Lane } from './lane.js';
import { conversationRouteKey, withDefaults, type FullPolicy, type SessionPolicy } from './policy.js';
import type { WatchDelivery, WatchDispatcher } from './watch.js';

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

export interface IngressOptions {
  policy?: SessionPolicy;
  /** Lane for a session key; the host decides how lanes are created and kept. */
  lanes: (sessionKey: string) => Lane | Promise<Lane>;
  newId?: (prefix: string) => string;
  /** How many envelope ids to remember for dedup (default 10 000). */
  dedupWindow?: number;
  /** Watches: after its own admission an envelope is also delivered to every session watching it. */
  watches?: WatchDispatcher;
  onWatchError?: (err: unknown) => void;
  /**
   * Capabilities of the adapter that renders replies to a route, and the tier it renders
   * at (default `caps.defaultTier`). When given, inputs with a reply route carry a
   * `reply` summary in channelContext (see {@link replySummary}).
   */
  replyCaps?: (channel: string, account: string) => { caps: ChannelCaps; tier?: Tier } | undefined;
}

export interface IngressResult {
  /** The host durably took the envelope (also true for a deliberate drop). */
  accepted: boolean;
  action: 'dispatch' | 'observe' | 'drop' | 'resolve' | 'interrupt' | 'duplicate' | 'invalid';
  inputId?: string;
  sessionKey?: string;
  origin?: Origin;
  result?: CommandResult;
  error?: string;
  /** Deliveries to watching sessions (only when a watch matched). */
  watched?: WatchDelivery[];
}

/**
 * Turns adapter claims into stamped inputs. Identity is only ever concluded by
 * `Policy.identify`; whatever the envelope says about the sender is evidence.
 */
export class Ingress {
  private readonly policy: FullPolicy;
  private readonly newId: (prefix: string) => string;
  private seen = new Map<string, IngressResult>();
  /** `${channel}:${envelopeId}` → inputId, so revisions keep the original input id. */
  private inputIds = new Map<string, string>();

  constructor(private readonly o: IngressOptions) {
    this.policy = withDefaults(o.policy);
    this.newId = o.newId ?? ((p) => `${p}_${randomUUID()}`);
  }

  /** A `ChannelContext.emit` implementation for one adapter. */
  emitter(): (env: InboundEnvelope) => Promise<{ accepted: boolean; inputId?: string }> {
    return async (env) => {
      const r = await this.accept(env);
      return { accepted: r.accepted, ...(r.inputId !== undefined ? { inputId: r.inputId } : {}) };
    };
  }

  async accept(env: InboundEnvelope): Promise<IngressResult> {
    const errs = errors(InboundEnvelope, env);
    if (errs.length) return { accepted: false, action: 'invalid', error: errs.slice(0, 3).join('; ') };
    const key = `${env.channel}:${env.id}`;
    const prior = this.seen.get(key);
    if (prior) return { ...prior, action: 'duplicate' };
    const r = await this.process(env);
    if (r.accepted) this.remember(key, r);
    const watched = await this.fanout(env, r);
    return watched?.length ? { ...r, watched } : r;
  }

  /**
   * The watch step, separate from (and after) the envelope's own admission.
   *
   * It runs whatever the admission was, including `drop`: a policy drop means
   * "not for the session it would have gone to" (a stranger's DM, a group
   * message nobody addressed to the bot), which is exactly what a watch on the
   * owner's inbox or a group is for. It does not run for what is not a message
   * at all: an adapter-level drop (`env.admission === 'drop'`: auto-replies,
   * bounces, bulk mail), card clicks (resolve/interrupt), invalid envelopes and
   * duplicates. Our own echoes reach it but are filtered by `excludeSelf`
   * (default true) and can never trigger. A host that wants a sender ignored
   * everywhere says so in `Policy.triage` as well as in `Policy.admit`.
   */
  private async fanout(env: InboundEnvelope, r: IngressResult): Promise<WatchDelivery[] | undefined> {
    const w = this.o.watches;
    if (!w || !r.accepted || !r.origin) return undefined;
    if (r.action !== 'dispatch' && r.action !== 'observe' && r.action !== 'drop') return undefined;
    if (env.admission === 'drop' || actionClick(env)) return undefined;
    try {
      return await w.fanout(env, r.origin, r.action === 'drop' ? undefined : r.sessionKey, channelContext(env, undefined)); // no reply summary: it would describe the watched source, not where the reply goes
    } catch (e) {
      this.o.onWatchError?.(e);
      return undefined;
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

  private async process(env: InboundEnvelope): Promise<IngressResult> {
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

    const admission = await this.policy.admit(env, origin);
    if (admission.action === 'drop') return { accepted: true, action: 'drop', origin };
    const sessionKey = admission.sessionKey ?? conversationRouteKey(env);

    // A button click on an approval card becomes a resolve command; the lane re-checks eligibility.
    const click = actionClick(env);
    if (click?.kind === 'interrupt') {
      // The lane checks Policy.control and that the turn is still the running one.
      const lane = await this.o.lanes(sessionKey);
      const result = await lane.command({ type: 'interrupt', sessionKey, turnId: click.turnId, origin });
      return { accepted: true, action: 'interrupt', sessionKey, origin, result };
    }
    if (click) {
      const lane = await this.o.lanes(sessionKey);
      const cmd: Command = { type: 'resolve', sessionKey, requestId: click.requestId, decision: { kind: click.kind }, origin };
      const result = await lane.command(cmd);
      return { accepted: true, action: 'resolve', sessionKey, origin, result };
    }

    const revisionOf = env.revisionOf !== undefined ? this.inputIds.get(`${env.channel}:${env.revisionOf}`) : undefined;
    const observe = admission.action === 'observe';
    // Latest-wins revisions keep the original input id, but only for observe-only inputs:
    // a dispatched input may already be running, so its revision is a new input.
    const inputId = observe && revisionOf ? revisionOf : this.newId('in');
    this.inputIds.set(`${env.channel}:${env.id}`, inputId);

    const input: InputRecord = {
      inputId,
      origin,
      content: env.content,
      replyRoute: env.replyRoute,
      channelContext: channelContext(env, this.replyOf(env)),
    };
    const lane = await this.o.lanes(sessionKey);
    if (observe) {
      const result = await lane.observe(input);
      return { accepted: true, action: 'observe', inputId, sessionKey, origin, result };
    }
    const result = await lane.command({ type: 'input', sessionKey, input, mode: admission.mode ?? env.modeHint ?? 'queue' });
    return { accepted: true, action: 'dispatch', inputId, sessionKey, origin, result };
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
