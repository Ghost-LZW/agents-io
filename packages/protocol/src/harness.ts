import type { InputRecord } from './inbound.js';
import type { RunSpec, HarnessCaps } from './run.js';
import type { Decision } from './requests.js';
import type { HarnessEvent } from './events.js';

export interface HarnessOpenArgs {
  sessionKey: string;
  generation: number;
  cwd: string;
  /** Native session/thread id to resume. */
  resume?: string;
  run: RunSpec;
  /** Host MCP endpoint the harness should mount (outbound tools etc.). */
  mcp?: { url: string; token: string; transport?: 'http' | 'sse' };
  /** Harness-specific options from deployment config. */
  options?: Record<string, unknown>;
}

export type SteerResult = 'steered' | 'stale' | 'not_steerable' | 'no_active_turn' | 'unsupported';

/**
 * Wraps a harness (Claude Code, Codex, …) itself. Adapters translate, they never
 * run their own agent loop.
 */
export interface HarnessAdapter {
  readonly id: string;
  /** Version assertion; refuse to start on unknown versions. */
  probe(): Promise<{ version: string; caps: HarnessCaps }>;
  open(args: HarnessOpenArgs): Promise<HarnessSession>;
}

export interface HarnessSession {
  /** Native session/thread id once known; the host persists it for resume. */
  nativeId(): string | undefined;
  /** Start a turn. Must only be called when idle; the session layer owns the queue. */
  startTurn(turnId: string, inputs: InputRecord[], run?: RunSpec): Promise<void>;
  steer(inputs: InputRecord[], expectedTurnId: string): Promise<SteerResult>;
  cancelQueued?(inputIds: string[]): Promise<void>;
  /** Add context without starting a turn (caps.injectWithoutTurn). */
  inject?(inputs: InputRecord[]): Promise<void>;
  interrupt(turnId: string): Promise<void>;
  /**
   * Answer a request. Every opened request must be closed by a `request.resolved`
   * in the adapter's own stream, so the stream is checkable on its own: after
   * respond() emit `by: { kind: 'host' }`. The session layer records the real
   * resolver (auto, model, human) and drops the adapter's echo.
   */
  respond(requestId: string, decision: Decision): Promise<void>;
  /** Events in emission order. Ends when the session closes. */
  readonly events: AsyncIterable<HarnessEvent>;
  close(reason: string): Promise<void>;
}
