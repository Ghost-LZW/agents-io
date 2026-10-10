import type { ReplyRoute } from './common.js';
import type { Origin } from './inbound.js';

/*
 * Addresses of agents and sessions (docs/design/agent-messaging §4.1). An agent is
 * addressed by its configured name (letters, digits, `.`, `_`, `-`: no `/`, no `:`); a
 * session by `<agent>/<sessionKey>`, the session key verbatim. As a route it is the
 * virtual channel `agent`: `{ channel: "agent", account: <agent>, conversationId: <sessionKey> }`,
 * route key `agent:<agent>:<sessionKey>`, so `Origin.via`, reply routes and route parsing
 * keep their shape.
 */

/** The virtual channel of agent addresses (`ReplyRoute.channel`, identity entries' `channel`). */
export const AGENT_CHANNEL = 'agent';

/** One session of one agent. */
export interface AgentAddress {
  agent: string;
  sessionKey: string;
}

/** `<agent>/<sessionKey>`. */
export function formatAddress(a: AgentAddress): string {
  return `${a.agent}/${a.sessionKey}`;
}

/** `<agent>/<sessionKey>` → address; undefined when it is not one (no `/`, empty parts). */
export function parseAddress(s: string): AgentAddress | undefined {
  const cut = s.indexOf('/');
  if (cut <= 0 || cut === s.length - 1) return undefined;
  const agent = s.slice(0, cut);
  if (agent.includes(':')) return undefined;
  return { agent, sessionKey: s.slice(cut + 1) };
}

/** The `agent` route of a session address. */
export function agentRoute(a: AgentAddress): ReplyRoute {
  return { channel: AGENT_CHANNEL, account: a.agent, conversationId: a.sessionKey };
}

/** The address an `agent` route points at, if it is one. */
export function addressOfRoute(r: ReplyRoute): AgentAddress | undefined {
  return r.channel === AGENT_CHANNEL && r.account && r.conversationId ? { agent: r.account, sessionKey: r.conversationId } : undefined;
}

/** Route key of a session address: `agent:<agent>:<sessionKey>` (what `Origin.via` of its inputs is). */
export function agentRouteKey(a: AgentAddress): string {
  return `${AGENT_CHANNEL}:${a.agent}:${a.sessionKey}`;
}

/** Default principal id of an agent (per agent, not per session: the session is in `via`). */
export function agentPrincipalId(agent: string): string {
  return `${AGENT_CHANNEL}:${agent}`;
}

/**
 * The origin of an input this daemon produces for one of its agents' sessions:
 * kind `agent`, the agent's principal (default `agent:<agent>`, label `agent`; a host
 * identity map may name another, never one labelled `owner`), evidence `daemon`,
 * `via` = the sending session's route key.
 */
export function agentInputOrigin(from: AgentAddress, principal: Origin['principal'] = { id: agentPrincipalId(from.agent), labels: ['agent'] }): Origin {
  return { kind: 'agent', principal, evidence: 'daemon', via: agentRouteKey(from), adapter: AGENT_CHANNEL };
}
