import { AGENT_CHANNEL, agentPrincipalId, type Evidence, type IdentifyArgs, type Identity, type IdentityEntry, type Principal } from '@agents-io/protocol';

/*
 * Identity map (docs/HOSTS.md §3, decision 3): channel identity → host principal.
 * agents-io only stamps what the map says, and only when the input carries enough
 * evidence; it keeps no member directory of its own. The local `owners` config is
 * the smallest such map (`ownerIdentities`).
 */

export class IdentityError extends Error {
  override name = 'IdentityError';
  constructor(
    readonly code: 'conflict' | 'invalid',
    message: string,
  ) {
    super(message);
  }
}

/** Evidence an entry accepts when it names none. */
export const DEFAULT_EVIDENCE: readonly Evidence[] = ['platform_signed', 'dkim_pass'];

export const OWNER_LABEL = 'owner';

export interface IdentityRules {
  /** This deployment's own bot accounts (`${channel}:${channelUserId}`): their messages are echoes, marked `self`. */
  selfAccounts?: string[];
  /** Agent accounts whose adapter-declared identity is accepted. */
  agentAccounts?: string[];
  /** Declared identities (from trusted agent accounts) that belong to this deployment, e.g. `runner:me/`. */
  isSelfDeclared?: (declared: string) => boolean;
}

export const identityKey = (channel: string, channelUserId: string) => `${channel}:${channelUserId}`;

/** `owners` (`${channel}:${channelUserId}`) as identity entries: principal = that string, label `owner`. */
export function ownerIdentities(owners: string[], evidence?: Evidence[]): IdentityEntry[] {
  const out: IdentityEntry[] = [];
  for (const o of new Set(owners)) {
    const cut = o.indexOf(':');
    if (cut <= 0 || cut === o.length - 1) throw new IdentityError('invalid', `owner ${JSON.stringify(o)} is not channel:channelUserId`);
    out.push({ channel: o.slice(0, cut), channelUserId: o.slice(cut + 1), principal: o, labels: [OWNER_LABEL], ...(evidence ? { evidence: [...evidence] } : {}) });
  }
  return out;
}

/** Throws `IdentityError('conflict')` when one channel identity is mapped twice. */
export function checkIdentities(entries: IdentityEntry[]): void {
  const seen = new Map<string, string>();
  for (const e of entries) {
    if (!e.channel || !e.channelUserId || !e.principal) throw new IdentityError('invalid', `identity entry needs channel, channelUserId and principal: ${JSON.stringify(e)}`);
    // An agent never speaks with an owner's authority: agent principals can not carry the owner label (agent-messaging §4.2).
    if (e.channel === AGENT_CHANNEL && e.labels.includes(OWNER_LABEL)) throw new IdentityError('invalid', `identity entry for agent ${JSON.stringify(e.channelUserId)} carries the ${OWNER_LABEL} label; agent principals can never be owners`);
    const k = identityKey(e.channel, e.channelUserId);
    const prior = seen.get(k);
    if (prior !== undefined) throw new IdentityError('conflict', `channel identity ${k} is mapped twice (to ${prior} and ${e.principal})`);
    seen.set(k, e.principal);
  }
}

/**
 * A validated map plus the deployment's own accounts. `layers` are applied in
 * order; a later layer's entry replaces an earlier one for the same channel
 * identity (the host's map over the local `owners`). Each layer must be
 * conflict-free on its own.
 */
export class IdentityMap {
  private readonly byKey = new Map<string, IdentityEntry>();
  /** Every principal id and mapped channel identity: a declaration naming one is a forgery. */
  private readonly members = new Set<string>();
  private readonly selfAccounts: Set<string>;
  private readonly agentAccounts: Set<string>;

  constructor(
    layers: IdentityEntry[][] = [],
    private readonly rules: IdentityRules = {},
  ) {
    for (const layer of layers) {
      checkIdentities(layer);
      for (const e of layer) this.byKey.set(identityKey(e.channel, e.channelUserId), e);
    }
    for (const [k, e] of this.byKey) {
      this.members.add(k);
      this.members.add(e.principal);
    }
    this.selfAccounts = new Set(rules.selfAccounts ?? []);
    this.agentAccounts = new Set(rules.agentAccounts ?? []);
  }

  entry(channel: string, channelUserId: string): IdentityEntry | undefined {
    return this.byKey.get(identityKey(channel, channelUserId));
  }

  /**
   * The principal inputs of one of this deployment's agents carry: the map's entry for
   * `{ channel: "agent", channelUserId: <agent> }` (a host may name its own member id),
   * else `agent:<agent>` with label `agent`. Never an owner (`checkIdentities`).
   */
  agentPrincipal(agent: string): Principal {
    const e = this.byKey.get(identityKey(AGENT_CHANNEL, agent));
    return e ? { id: e.principal, labels: [...e.labels] } : { id: agentPrincipalId(agent), labels: ['agent'] };
  }

  /**
   * The safety rules, in order: our own accounts are echoes; trusted agent
   * accounts may declare an identity, never one of the mapped members; a mapped
   * channel identity is that member only with accepted evidence; everyone else
   * is unknown (principal null). A declaration from any other account is ignored.
   */
  identify(a: IdentifyArgs): Identity {
    const key = identityKey(a.channel, a.channelUserId);
    if (this.selfAccounts.has(key)) {
      return { kind: 'agent', principal: null, self: true, ...(a.declared !== undefined ? { declared: a.declared } : {}) };
    }
    if (this.agentAccounts.has(key)) {
      // Declarations only describe agents: one naming a member (an owner) is a forgery, never that member.
      if (a.declared === undefined || this.members.has(a.declared)) return { kind: 'agent', principal: null, trustedAgent: true };
      const self = this.rules.isSelfDeclared?.(a.declared) ?? false;
      return { kind: 'agent', principal: { id: a.declared, labels: ['agent'] }, declared: a.declared, trustedAgent: true, ...(self ? { self } : {}) };
    }
    const e = this.byKey.get(key);
    // An address alone proves nothing (a mail From header is trivially forged): require evidence.
    if (e && (e.evidence ?? DEFAULT_EVIDENCE).includes(a.evidence)) return { kind: 'human', principal: { id: e.principal, labels: [...e.labels] } };
    return { kind: a.isBot ? 'agent' : 'human', principal: null };
  }
}
