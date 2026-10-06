import type { Evidence, Principal, ReplyRoute } from './common.js';
import type { InputMode } from './commands.js';
import type { InboundEnvelope, InputRecord, Origin } from './inbound.js';
import type { RunSpec } from './run.js';
import type { Resolver } from './requests.js';
import type { BodyOf } from './events.js';

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
}
