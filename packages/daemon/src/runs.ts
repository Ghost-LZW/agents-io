import { statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import {
  PROTOCOL_VERSION,
  type ContentBlock,
  type InputRecord,
  type Origin,
  type ReplyRoute,
  type RouteExplanation,
  type RunEnded,
  type RunSpec,
  type RunStart,
  type RunStartResult,
  type SessionEvent,
} from '@agents-io/protocol';
import type { Hub, Lane, Subscription } from '@agents-io/session';
import type { AgentConfig } from './config.js';
import type { LogFn, Outcome } from './gateway.js';
import type { Peer } from './local-server.js';

/*
 * Task runs (docs/HOSTS.md §4 `run.start`): one headless turn of a `mode: task`
 * agent in a fresh session `run:<runId>`, closed when the turn ends. The request
 * env goes only into the harness child's environment (never the log, never
 * argv). `overrides` change this run's RunSpec only, or the request fails
 * (`bad_override`). The run's end is reported as `run.ended` with an exit code,
 * its turn, duration and usage; a re-sent `run.start` reads the same from the log.
 */

export type RunStatus = RunEnded['status'];

/** Exit code of a run: 0 completed, 1 failed, 3 ambiguous, 124 timed out, 130 interrupted (cancelled). */
export function exitCodeOf(status: RunStatus, errorCode?: string): number {
  switch (status) {
    case 'completed':
      return 0;
    case 'failed':
      return 1;
    case 'ambiguous':
      return 3;
    case 'timeout':
      return 124;
    case 'interrupted':
      return errorCode === 'timeout' ? 124 : 130;
  }
}

/** `run.start` answer (protocol `RunStartResult`). */
export type { RunStartResult };

/** `run.start.overrides`. */
export type RunOverrides = NonNullable<RunStart['overrides']>;

/** Binding id of a task run's input in `explain` (its routing record names the run, EX-7). */
export const RUN_RULE = 'host:run';

/** What a run needs from the daemon. */
export interface RunDeps {
  readonly hub: Hub;
  agents(): Record<string, AgentConfig>;
  /** Default working directory of an agent's runs on a harness instance (the agent's, unless a preset moves the run). */
  agentCwd(agent: AgentConfig, instance: string): string;
  /** The run's RunSpec: the agent's defaults with `overrides` applied, or why one cannot apply. */
  runSpec(agent: AgentConfig, overrides: RunOverrides | undefined): { ok: true; spec: RunSpec } | { ok: false; code: string; message: string };
  /** Build the run's lane (its own harness adapter with `env` in the child's environment) for `spec`. */
  openRunLane(o: { runId: string; sessionKey: string; agent: AgentConfig; spec: RunSpec; cwd: string; env: Record<string, string>; turnId: string }): { lane: Lane; dispose(): Promise<void> };
  /** The routing record of an input id, if any (a host-chosen `inputId` must not be one another input has). */
  explained(inputId: string): RouteExplanation | undefined;
  /** Write the run input's routing record (`explain`, EX-7). */
  recordRunInput(r: { input: InputRecord; runId: string; agent: string; sessionKey: string; rejected?: { code: string; message?: string } }): void;
  /** Where run.ended goes when no connection that asked for the run is left. */
  hostPeer(): Peer | undefined;
  log: LogFn;
}

interface ActiveRun {
  runId: string;
  sessionKey: string;
  inputId: string;
  correlation?: string;
  spec: RunSpec;
  turnId: string;
  lane: Lane;
  dispose(): Promise<void>;
  sub: Subscription;
  listeners: Set<Peer>;
  observe: ReplyRoute[];
  timer?: ReturnType<typeof setTimeout>;
  timedOut: boolean;
  started: boolean;
  ending: boolean;
  origin: Origin;
  /** When run.start accepted it; the log's first and last records of the run (durationMs). */
  acceptedAt: number;
  firstTs?: number;
  endTs?: number;
  /** `turn.completed.usage` of the run's turn. */
  usage?: unknown;
}

const RUN_ID = /^[^\s\u0000-\u001f]{1,256}$/;
const VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** A host-chosen input id: a plain token (no characters derived ids use: `@`, `>`, `~`, `/`). */
const INPUT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
/** Input ids the daemon makes itself (the lane's omitted-context record). */
const RESERVED_INPUT_ID = /^ctxo_/;
const CORRELATION = /^[^\u0000-\u001f\u007f]{1,256}$/;
/** The error of a run that timed out (a fresh object per frame). */
const timeoutError = () => ({ code: 'timeout', message: 'run.start timeoutMs elapsed' });

export const runSessionKey = (runId: string) => `run:${runId}`;

export class Runs {
  private readonly active = new Map<string, ActiveRun>();
  private stopped = false;

  constructor(private readonly d: RunDeps) {}

  /** Running run ids. */
  running(): string[] {
    return [...this.active.keys()];
  }

  async start(peer: Peer, f: RunStart, origin: Origin): Promise<Outcome> {
    if (this.stopped) return fail('stopped', 'daemon is stopping');
    if (!RUN_ID.test(f.runId)) return fail('bad_run_id', 'runId must be 1-256 characters without whitespace');
    const agent = this.d.agents()[f.agent];
    if (!agent) return fail('unknown_agent', `unknown agent ${JSON.stringify(f.agent)} (agents: ${Object.keys(this.d.agents()).join(', ') || 'none'})`);
    if (agent.mode !== 'task') return fail('not_task_agent', `agent ${JSON.stringify(f.agent)} is interactive; run.start only runs mode: task agents (interactive agents are reached through bindings)`);
    const sessionKey = runSessionKey(f.runId);

    const running = this.active.get(f.runId);
    if (running) {
      // The runId is the idempotency key: the first request's input, overrides and correlation hold.
      running.listeners.add(peer);
      return ok<RunStartResult>({ runId: f.runId, sessionKey, state: 'running', inputId: running.inputId, run: running.spec });
    }
    if (this.d.hub.log.head(sessionKey) > 0) {
      // Ran before (runIds are idempotency keys): report how it ended instead of running it again.
      const ended = this.outcome(f.runId) ?? this.settleDangling(sessionKey, f.runId);
      setImmediate(() => peer.send(ended as unknown as Record<string, unknown>));
      return ok<RunStartResult>({ runId: f.runId, sessionKey, state: 'ended', ended });
    }

    if (f.inputId !== undefined && (!INPUT_ID.test(f.inputId) || RESERVED_INPUT_ID.test(f.inputId)))
      return fail('bad_input_id', 'inputId must be 1-256 letters, digits, ".", "_", ":" or "-", starting with a letter or digit (and not ctxo_…)');
    if (f.correlation !== undefined && !CORRELATION.test(f.correlation)) return fail('bad_correlation', 'correlation must be 1-256 characters without control characters');
    if (f.inputId !== undefined) {
      // Unique per deployment: explain and cause chains key on it. A record of this very run is one an earlier daemon wrote before it stopped.
      const known = this.d.explained(f.inputId);
      if (known && known.run?.runId !== f.runId) return fail('input_id_taken', `input ${f.inputId} is already on record (inputIds name one input)`);
    }
    const planned = this.d.runSpec(agent, f.overrides);
    if (!planned.ok) return fail(planned.code, planned.message);
    const spec = planned.spec;

    const cwd = f.cwd ?? this.d.agentCwd(agent, spec.harness);
    if (!isAbsolute(cwd)) return fail('bad_cwd', `cwd must be absolute: ${cwd}`);
    try {
      if (!statSync(cwd).isDirectory()) return fail('bad_cwd', `cwd is not a directory: ${cwd}`);
    } catch {
      return fail('bad_cwd', `cwd does not exist: ${cwd}`);
    }
    const env = f.env ?? {};
    for (const k of Object.keys(env)) if (!VAR_NAME.test(k)) return fail('bad_env', `${JSON.stringify(k)} is not an environment variable name`);
    if (!f.input.length) return fail('empty_input', 'run.start needs input');

    const acceptedAt = Date.now();
    const turnId = `turn_run_${randomSuffix()}`;
    let built: { lane: Lane; dispose(): Promise<void> };
    try {
      built = this.d.openRunLane({ runId: f.runId, sessionKey, agent, spec, cwd, env, turnId });
    } catch (e) {
      return fail('harness_unavailable', (e as Error).message);
    }
    const observe = f.observe?.routes ?? [];
    const input: InputRecord = {
      inputId: f.inputId ?? `in_run_${randomSuffix()}`,
      origin,
      content: f.input as ContentBlock[],
      replyRoute: observe[0] ?? null,
      // Out of channelContext: that is shown to the model, the correlation id never is.
      ...(f.correlation !== undefined ? { correlation: f.correlation } : {}),
      channelContext: { channel: 'host', runId: f.runId, agent: agent.name },
    };
    // Before the first await: a concurrent run.start with the same inputId finds this record.
    const recorded = { input, runId: f.runId, agent: agent.name, sessionKey };
    this.d.recordRunInput(recorded);
    const sub = this.d.hub.subscribe({ sessionKey, tier: 'full', fromSeq: this.d.hub.log.head(sessionKey), visibility: ['participants', 'operators', 'internal'] });
    const run: ActiveRun = {
      runId: f.runId,
      sessionKey,
      inputId: input.inputId,
      ...(f.correlation !== undefined ? { correlation: f.correlation } : {}),
      spec,
      turnId,
      lane: built.lane,
      dispose: built.dispose,
      sub,
      listeners: new Set([peer]),
      observe,
      timedOut: false,
      started: false,
      ending: false,
      origin,
      acceptedAt,
    };
    this.active.set(f.runId, run);
    void this.watch(run);
    if (f.timeoutMs !== undefined && f.timeoutMs > 0) {
      const ms = f.timeoutMs;
      run.timer = setTimeout(() => {
        run.timedOut = true;
        // In the log, so a re-sent run.start reports `timeout` too (not a cancel).
        if (!run.ending)
          this.d.hub.append(run.sessionKey, {
            ts: Date.now(),
            ...(run.started ? { turnId: run.turnId } : {}),
            level: 'detail',
            audience: 'status',
            durability: 'durable',
            visibility: 'operators',
            body: { t: 'notice', code: 'run_timeout', message: `run.start timeoutMs (${ms} ms) elapsed; interrupting the run` },
          });
        void this.interrupt(run);
      }, ms);
    }
    const r = await run.lane.command({ type: 'input', sessionKey, input, mode: 'queue' });
    if (!r.ok) {
      this.d.recordRunInput({ ...recorded, rejected: { code: 'start_failed', message: r.reason } });
      await this.end(run, 'failed', { code: 'start_failed', message: r.reason });
      return fail('start_failed', r.reason);
    }
    this.d.log(
      'info',
      `run ${f.runId}: agent ${agent.name} (${spec.harness}${spec.model ? `, ${spec.model}` : ''}${spec.effort ? `, ${spec.effort}` : ''}, ${spec.profile}) in ${cwd}${Object.keys(env).length ? ` (env: ${Object.keys(env).join(', ')})` : ''}`,
    );
    return ok<RunStartResult>({ runId: f.runId, sessionKey, state: 'started', inputId: input.inputId, run: spec });
  }

  async cancel(runId: string, reason?: string): Promise<Outcome> {
    const run = this.active.get(runId);
    if (!run) return this.d.hub.log.head(runSessionKey(runId)) > 0 ? fail('run_ended', `run ${runId} already ended`) : fail('unknown_run', `no run ${runId}`);
    this.d.log('info', `run ${runId}: cancel${reason ? ` (${reason})` : ''}`);
    await this.interrupt(run);
    return ok({ runId, cancelled: true });
  }

  /** A connection went away: its runs keep running; their run.ended goes to the host, if one is connected. */
  peerGone(peer: Peer): void {
    for (const r of this.active.values()) r.listeners.delete(peer);
  }

  /** Daemon shutdown: interrupt every run and wait (bounded by the caller) for them to end. */
  async stop(): Promise<void> {
    this.stopped = true;
    await Promise.all([...this.active.values()].map(async (r) => {
      await this.interrupt(r);
      await this.end(r, 'interrupted', { code: 'daemon_stopping' });
    }));
  }

  /**
   * Run sessions an earlier daemon left mid-turn: their outcome is unknown
   * (`ambiguous`). Called at start, before anything opens them.
   */
  settleAllDangling(): void {
    for (const key of this.d.hub.log.sessions()) {
      if (!key.startsWith('run:') || !this.d.hub.snapshot(key).turn) continue;
      this.settleDangling(key, key.slice(4));
    }
  }

  private settleDangling(sessionKey: string, runId: string): RunEnded {
    const snap = this.d.hub.snapshot(sessionKey);
    if (snap.turn) {
      this.d.hub.append(sessionKey, {
        ts: Date.now(),
        turnId: snap.turn.turnId,
        level: 'primary',
        audience: 'status',
        durability: 'durable',
        harness: snap.harness,
        generation: snap.generation,
        body: { t: 'turn.completed', turnId: snap.turn.turnId, status: 'ambiguous', error: { code: 'host_restarted', retryable: false, message: 'the run was going when the previous daemon stopped' } },
      });
    }
    return this.outcome(runId) ?? ended(runId, sessionKey, 'ambiguous', { code: 'host_restarted' });
  }

  /**
   * How a run that is not running ended, from its session log: the same frame the run's end
   * sent (status, error, turn, input, correlation, usage, duration), so a re-sent `run.start`
   * agrees with the first `run.ended`.
   */
  outcome(runId: string): RunEnded | undefined {
    const sessionKey = runSessionKey(runId);
    let end: { status: RunStatus; error?: { code: string; message?: string }; at: number; usage?: unknown; restarted?: boolean } | undefined;
    let first: number | undefined;
    let inputId: string | undefined;
    let correlation: string | undefined;
    let turnId: string | undefined;
    let timedOut = false;
    for (const e of this.d.hub.log.read(sessionKey, 0)) {
      const b = e.body;
      first ??= e.ts;
      if (b.t === 'input.admitted' && inputId === undefined) {
        inputId = b.inputId;
        correlation = b.input?.correlation;
      }
      if (b.t === 'turn.started' && turnId === undefined) turnId = b.turnId;
      if (b.t === 'notice' && b.code === 'run_timeout') timedOut = true;
      if (b.t === 'turn.completed') {
        const timeout = timedOut && b.status === 'interrupted';
        const error = timeout ? timeoutError() : b.error ? { code: b.error.code, ...(b.error.message ? { message: b.error.message } : {}) } : undefined;
        end = { status: timeout ? 'timeout' : b.status, ...(error ? { error } : {}), at: e.ts, usage: b.usage, restarted: b.error?.code === 'host_restarted' };
      }
      if (b.t === 'input.rejected' && turnId === undefined && !end) end = { status: 'failed', error: { code: 'start_failed', message: b.reason }, at: e.ts };
      if (b.t === 'input.cancelled' && turnId === undefined && !end) end = timedOut ? { status: 'timeout', error: timeoutError(), at: e.ts } : { status: 'interrupted', error: { code: 'cancelled' }, at: e.ts };
    }
    if (!end) return undefined;
    // A run settled at a later start (host_restarted) ended at an unknown time: no duration.
    return ended(runId, sessionKey, end.status, end.error, {
      ...(first !== undefined && !end.restarted ? { durationMs: end.at - first } : {}),
      ...(end.usage !== undefined ? { usage: end.usage } : {}),
      ...(turnId !== undefined ? { turnId } : {}),
      ...(inputId !== undefined ? { inputId } : {}),
      ...(correlation !== undefined ? { correlation } : {}),
    });
  }

  private async interrupt(run: ActiveRun): Promise<void> {
    const r = await run.lane.command({ type: 'interrupt', sessionKey: run.sessionKey, origin: run.origin, cancelQueue: true }).catch((e: Error) => ({ ok: false as const, reason: e.message }));
    if (!r.ok && r.reason !== 'no_active_turn') this.d.log('warn', `run ${run.runId}: interrupt failed: ${r.reason}`);
  }

  private async watch(run: ActiveRun): Promise<void> {
    for await (const e of run.sub) {
      if (this.onEvent(run, e)) break;
    }
  }

  /** True once the run has ended. */
  private onEvent(run: ActiveRun, e: SessionEvent): boolean {
    const b = e.body;
    run.firstTs ??= e.ts;
    if (b.t === 'turn.started' && b.inputIds.includes(run.inputId)) {
      run.started = true;
      run.turnId = b.turnId;
      // More observers than the input's reply route: the compositors render the turn there too.
      for (const route of run.observe.slice(1)) {
        this.d.hub.append(run.sessionKey, { ts: Date.now(), turnId: b.turnId, level: 'detail', audience: 'status', durability: 'durable', body: { t: 'turn.delivery_added', turnId: b.turnId, route, reason: 'mirror' } });
      }
      return false;
    }
    if (b.t === 'turn.completed' && (b.turnId === run.turnId || run.started)) {
      run.endTs = e.ts;
      if (b.usage !== undefined) run.usage = b.usage;
      // A turn that completed (or failed) as the timer fired keeps its own outcome.
      const timeout = run.timedOut && b.status === 'interrupted';
      const err = timeout ? timeoutError() : b.error ? { code: b.error.code, ...(b.error.message ? { message: b.error.message } : {}) } : undefined;
      void this.end(run, timeout ? 'timeout' : b.status, err);
      return true;
    }
    if (b.t === 'input.rejected' && b.inputIds.includes(run.inputId) && !run.started) {
      run.endTs = e.ts;
      void this.end(run, 'failed', { code: 'start_failed', message: b.reason });
      return true;
    }
    if (b.t === 'input.cancelled' && b.inputIds.includes(run.inputId) && !run.started) {
      run.endTs = e.ts;
      if (run.timedOut) void this.end(run, 'timeout', timeoutError());
      else void this.end(run, 'interrupted', { code: 'cancelled' });
      return true;
    }
    return false;
  }

  private async end(run: ActiveRun, status: RunStatus, error?: { code: string; message?: string }): Promise<void> {
    if (run.ending) return;
    run.ending = true;
    if (run.timer) clearTimeout(run.timer);
    run.sub.close();
    const frame = ended(run.runId, run.sessionKey, status, error, {
      durationMs: (run.endTs ?? Date.now()) - (run.firstTs ?? run.acceptedAt),
      ...(run.usage !== undefined ? { usage: run.usage } : {}),
      ...(run.started ? { turnId: run.turnId } : {}),
      inputId: run.inputId,
      ...(run.correlation !== undefined ? { correlation: run.correlation } : {}),
    });
    this.d.log('info', `run ${run.runId}: ${status} (exit ${frame.exitCode})${error ? ` ${error.code}` : ''}`);
    try {
      await run.dispose();
    } catch (e) {
      this.d.log('warn', `run ${run.runId}: close failed: ${(e as Error).message}`);
    }
    this.active.delete(run.runId);
    const live = [...run.listeners].filter((p) => !p.signal.aborted);
    const to = live.length ? live : [this.d.hostPeer()].filter((p): p is Peer => !!p);
    for (const p of to) p.send(frame as unknown as Record<string, unknown>);
  }
}

function ended(
  runId: string,
  sessionKey: string,
  status: RunStatus,
  error?: { code: string; message?: string },
  facts: Pick<RunEnded, 'durationMs' | 'usage' | 'turnId' | 'inputId' | 'correlation'> = {},
): RunEnded {
  return { v: PROTOCOL_VERSION, type: 'run.ended', runId, sessionKey, status, exitCode: exitCodeOf(status, error?.code), ...(error ? { error } : {}), ...facts };
}

function randomSuffix(): string {
  return globalThis.crypto.randomUUID();
}

function ok<T>(value: T): Outcome {
  return { ok: true, value };
}

function fail(code: string, message = code): Outcome {
  return { ok: false, code, message };
}
