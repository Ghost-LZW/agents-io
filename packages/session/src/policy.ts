import {
  routeKey,
  type BodyOf,
  type IdentifyArgs,
  type Identity,
  type InboundEnvelope,
  type Origin,
  type Policy,
  type ReplyRoute,
  type Resolver,
  type RunSpec,
  type TurnContext,
  type TurnDraft,
  type ControlArgs,
  type Evidence,
  type InputRecord,
  type Watch,
  type WatchSource,
} from '@agents-io/protocol';
import { IdentityMap, OWNER_LABEL, ownerIdentities } from './identity.js';

export type { ControlArgs };

/** The protocol `Policy`; kept as an alias for existing imports. */
export type SessionPolicy = Policy;

/**
 * Every hook filled in, except `admit`: routing is the `Router`'s binding tables.
 * `admit` is legacy and only present when a host app set it (see `RouterOptions.legacyAdmit`).
 */
export type FullPolicy = Required<Omit<SessionPolicy, 'admit'>> & Pick<SessionPolicy, 'admit'>;

export interface DefaultPolicyOptions {
  /** Owners as `${channel}:${channelUserId}`. Nobody else is identified. */
  owners: string[];
  /** This deployment's own bot accounts (`${channel}:${channelUserId}`): their messages are echoes, marked `self`. */
  selfAccounts?: string[];
  /** Agent accounts whose adapter-declared identity is accepted. */
  agentAccounts?: string[];
  /** Declared identities (from trusted agent accounts) that belong to this deployment, e.g. `runner:me/`. */
  isSelfDeclared?: (declared: string) => boolean;
  /** RunSpec base for every turn (profile is decided by the policy). */
  run?: Omit<RunSpec, 'profile'>;
  /** Route keys the owner preregistered as allowed outbound destinations. */
  routes?: string[];
  /**
   * Not used by the policy any more: owner DMs go to this session through the
   * default binding table (`ownersTable({ ownerSessionKey })`). Kept so existing
   * option objects still type-check.
   */
  ownerSessionKey?: string;
  /**
   * Evidence an input must carry to be recognised as an owner. Default
   * `platform_signed` and `dkim_pass`: an unsigned mail claiming the owner's address is a stranger.
   */
  ownerEvidence?: Evidence[];
  /**
   * Sources an agent may watch without asking anyone. Each entry matches when every
   * field it sets equals the watch's source (channel, account, conversation, conversationKind).
   */
  watchAllowlist?: Partial<Pick<WatchSource, 'channel' | 'account' | 'conversation' | 'conversationKind'>>[];
}

const OWNER = OWNER_LABEL;

export function conversationRouteKey(env: InboundEnvelope): string {
  return routeKey({
    channel: env.channel,
    account: env.account,
    conversationId: env.conversation.id,
    ...(env.conversation.threadId !== undefined ? { threadId: env.conversation.threadId } : {}),
  });
}

const isOwner = (o: Origin | undefined) => !!o?.principal?.labels.includes(OWNER);

/**
 * Defaults for "one owner using it for themselves" (POSITIONING §4). Every hook
 * is meant to be overridden by spreading: `{ ...defaultPolicy(o), resolve }`.
 */
export function defaultPolicy(o: DefaultPolicyOptions): FullPolicy {
  const ids = new IdentityMap([ownerIdentities(o.owners, o.ownerEvidence)], {
    ...(o.selfAccounts ? { selfAccounts: o.selfAccounts } : {}),
    ...(o.agentAccounts ? { agentAccounts: o.agentAccounts } : {}),
    ...(o.isSelfDeclared ? { isSelfDeclared: o.isSelfDeclared } : {}),
  });
  const routes = new Set(o.routes ?? []);

  return {
    async identify(a: IdentifyArgs): Promise<Identity> {
      return ids.identify(a);
    },

    async plan(turn: TurnDraft): Promise<RunSpec> {
      const base = o.run ?? turn.previous ?? { harness: 'default', model: 'default' };
      const allOwner = turn.inputs.length > 0 && turn.inputs.every((i) => isOwner(i.origin));
      return {
        harness: base.harness,
        model: base.model,
        ...(base.effort !== undefined ? { effort: base.effort } : {}),
        profile: allOwner ? 'bypass' : 'restricted',
      };
    },

    async resolve(_req: BodyOf<'request.opened'>, ctx: TurnContext): Promise<Resolver> {
      return ctx.run.profile === 'bypass'
        ? { kind: 'auto', decision: { kind: 'allow_once' } }
        : { kind: 'auto', decision: { kind: 'deny', message: 'not allowed in restricted profile' } };
    },

    async outbound({ from, to }: { from: TurnContext | null; to: ReplyRoute }): Promise<'allow' | 'deny'> {
      const k = routeKey(to);
      if (routes.has(k)) return 'allow';
      if (!from) return 'deny';
      // A bypass turn (owner-triggered) can already reach anything through its harness; holding back its
      // sends and lives would cost function without containing risk (decisions 4, 5).
      if (from.run.profile === 'bypass') return 'allow';
      const own = [from.replyRoute, ...from.inputs.map((i) => i.replyRoute)];
      return own.some((r) => r && routeKey(r) === k) ? 'allow' : 'deny';
    },

    async control({ origin, turn }: ControlArgs): Promise<'allow' | 'deny'> {
      const owner = turn?.owner ?? null;
      const p = origin.principal;
      if (!p) return 'deny';
      return isOwner(origin) || (owner !== null && p.id === owner) ? 'allow' : 'deny';
    },

    async escalate(_req: BodyOf<'request.opened'>, ctx: TurnContext): Promise<Resolver> {
      const owner = ctx.owner ?? null;
      return {
        kind: 'human',
        principals: owner ? [owner] : [],
        routes: ctx.replyRoute ? [routeKey(ctx.replyRoute)] : [],
      };
    },

    async watch({ watch, by }: { watch: Watch; by: Origin }): Promise<'allow' | 'deny'> {
      if (isOwner(by)) return 'allow';
      if (by.kind !== 'agent' && by.kind !== 'system') return 'deny';
      const src = watch.source;
      const ok = (o.watchAllowlist ?? []).some((a) =>
        (['channel', 'account', 'conversation', 'conversationKind'] as const).every((k) => a[k] === undefined || a[k] === src[k]),
      );
      return ok ? 'allow' : 'deny';
    },

    async triage({ watch }: { watch: Watch; input: InputRecord }): Promise<'drop' | 'context' | 'trigger'> {
      return watch.mode === 'trigger' ? 'trigger' : 'context';
    },
  };
}

/** Fill missing hooks from `defaultPolicy({ owners: [] })`. */
export function withDefaults(p: SessionPolicy = {}): FullPolicy {
  const d = defaultPolicy({ owners: [] });
  return {
    identify: p.identify?.bind(p) ?? d.identify,
    ...(p.admit ? { admit: p.admit.bind(p) } : {}),
    plan: p.plan?.bind(p) ?? d.plan,
    resolve: p.resolve?.bind(p) ?? d.resolve,
    outbound: p.outbound?.bind(p) ?? d.outbound,
    control: p.control?.bind(p) ?? d.control,
    escalate: p.escalate?.bind(p) ?? d.escalate,
    watch: p.watch?.bind(p) ?? d.watch,
    triage: p.triage?.bind(p) ?? d.triage,
  };
}
