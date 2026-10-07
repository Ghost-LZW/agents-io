import {
  routeKey,
  type Admission,
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
  type InputRecord,
  type Watch,
  type WatchSource,
} from '@agents-io/protocol';

export type { ControlArgs };

/** The protocol `Policy`; kept as an alias for existing imports. */
export type SessionPolicy = Policy;

export type FullPolicy = Required<SessionPolicy>;

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
  /** Put every owner DM into this one session instead of one per conversation. */
  ownerSessionKey?: string;
  /**
   * Sources an agent may watch without asking anyone. Each entry matches when every
   * field it sets equals the watch's source (channel, account, conversation, conversationKind).
   */
  watchAllowlist?: Partial<Pick<WatchSource, 'channel' | 'account' | 'conversation' | 'conversationKind'>>[];
}

const OWNER = 'owner';

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
  const owners = new Set(o.owners);
  const selfAccounts = new Set(o.selfAccounts ?? []);
  const agentAccounts = new Set(o.agentAccounts ?? []);
  const routes = new Set(o.routes ?? []);

  return {
    async identify(a: IdentifyArgs): Promise<Identity> {
      const key = `${a.channel}:${a.channelUserId}`;
      if (selfAccounts.has(key)) {
        return { kind: 'agent', principal: null, self: true, ...(a.declared !== undefined ? { declared: a.declared } : {}) };
      }
      if (agentAccounts.has(key)) {
        if (a.declared === undefined) return { kind: 'agent', principal: null };
        const self = o.isSelfDeclared?.(a.declared) ?? false;
        return { kind: 'agent', principal: { id: a.declared, labels: ['agent'] }, declared: a.declared, ...(self ? { self } : {}) };
      }
      // A declaration from any other account is a claim we do not accept.
      if (owners.has(key)) return { kind: 'human', principal: { id: key, labels: [OWNER] } };
      return { kind: a.isBot ? 'agent' : 'human', principal: null };
    },

    async admit(env: InboundEnvelope, origin: Origin): Promise<Admission> {
      const key = conversationRouteKey(env);
      if (origin.self || env.admission === 'drop') return { action: 'drop' };
      const dm = env.conversation.kind === 'dm';
      if (isOwner(origin)) {
        return {
          action: env.admission === 'observe' ? 'observe' : 'dispatch',
          sessionKey: dm && o.ownerSessionKey ? o.ownerSessionKey : key,
          mode: env.modeHint ?? 'queue',
        };
      }
      if (dm) return { action: 'drop' };
      return { action: 'observe', sessionKey: key };
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
    admit: p.admit?.bind(p) ?? d.admit,
    plan: p.plan?.bind(p) ?? d.plan,
    resolve: p.resolve?.bind(p) ?? d.resolve,
    outbound: p.outbound?.bind(p) ?? d.outbound,
    control: p.control?.bind(p) ?? d.control,
    escalate: p.escalate?.bind(p) ?? d.escalate,
    watch: p.watch?.bind(p) ?? d.watch,
    triage: p.triage?.bind(p) ?? d.triage,
  };
}
