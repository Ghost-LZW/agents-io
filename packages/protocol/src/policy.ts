import type { Evidence, Principal, ReplyRoute } from './common.js';
import type { InputMode } from './commands.js';
import type { InboundEnvelope, InputRecord, Origin } from './inbound.js';
import type { RunSpec } from './run.js';
import type { Resolver } from './requests.js';
import type { BodyOf } from './events.js';
import type { Watch } from './watch.js';
import type { TurnProvenance } from './host.js';
import type { AgentAddress } from './address.js';

export interface IdentifyArgs {
  channel: string;
  account: string;
  channelUserId: string;
  evidence: Evidence;
  isBot?: boolean;
  /** Identity the message declared via adapter-controlled metadata. */
  declared?: string;
}

export interface Identity {
  kind: Origin['kind'];
  principal: Principal | null;
  /** Accepted declared identity; omit to reject the declaration. */
  declared?: string;
  /** This deployment's own agent output echoed back. */
  self?: boolean;
  /**
   * The sending account is a trusted agent account (`agentAccounts`): its out-of-band
   * claims (a declared identity, a declared hop: `sender.cause`) may be taken.
   */
  trustedAgent?: boolean;
}

/** What one agent may do to another (`Policy.contact`). */
export type ContactOp = 'list' | 'send' | 'run' | 'observe' | 'control';

export interface ContactArgs {
  from: AgentAddress;
  to: AgentAddress | { agent: string };
  op: ContactOp;
  /** The sender's running turn, when the contact comes from one. */
  turn: TurnContext | null;
}

export interface Admission {
  action: 'dispatch' | 'observe' | 'drop';
  sessionKey?: string;
  mode?: InputMode;
}

export interface TurnDraft {
  sessionKey: string;
  inputs: InputRecord[];
  previous?: RunSpec;
}

export interface TurnContext {
  sessionKey: string;
  turnId: string;
  run: RunSpec;
  inputs: InputRecord[];
  replyRoute: ReplyRoute | null;
  /** Principal id that owns the turn (steer and approvals check against it). */
  owner?: string;
  /** Extra delivery routes added during the turn (steer from another end, mirror). */
  deliveries: ReplyRoute[];
  /** Where the turn's inputs came from (tag only, never used to block). */
  provenance?: TurnProvenance;
}

export interface ControlArgs {
  sessionKey: string;
  op: 'interrupt' | 'cancel_queue' | 'set_model' | 'set_effort' | 'reset' | 'resume_interrupted';
  origin: Origin;
  turn?: TurnContext;
}

/**
 * Host policy. Every hook is optional; agents-io ships defaults that only cover a
 * single owner using it for themselves.
 */
export interface Policy {
  identify?(args: IdentifyArgs): Promise<Identity>;
  admit?(env: InboundEnvelope, origin: Origin): Promise<Admission>;
  plan?(turn: TurnDraft): Promise<RunSpec>;
  resolve?(req: BodyOf<'request.opened'>, ctx: TurnContext): Promise<Resolver>;
  outbound?(args: { from: TurnContext | null; to: ReplyRoute }): Promise<'allow' | 'deny'>;
  /** May this origin interrupt, clear the queue, or change the session? */
  control?(args: ControlArgs): Promise<'allow' | 'deny'>;
  /** A `model` resolver could not decide; who answers next. */
  escalate?(req: BodyOf<'request.opened'>, ctx: TurnContext): Promise<Resolver>;
  /**
   * May `by` create this watch? Default: owners may watch anything; an agent only
   * sources on the deployment's allowlist (no human approval).
   */
  watch?(args: { watch: Watch; by: Origin }): Promise<'allow' | 'deny'>;
  /**
   * Semantic gate for a watched input that passed the watch's filters. Default
   * keeps the watch's own mode. Inputs that arrive via a watch are untrusted:
   * their origin stays the original sender, never the watch's creator.
   */
  triage?(args: { watch: Watch; input: InputRecord }): Promise<'drop' | 'context' | 'trigger'>;
  /**
   * May one agent contact another (list it, send to it, run it, observe or control it)?
   * Default: deny unless `policy.agentContacts` allows it (docs/design/agent-messaging §4.6).
   * Defined for the agent-messaging tools; nothing calls it yet.
   */
  contact?(args: ContactArgs): Promise<'allow' | 'deny'>;
}
