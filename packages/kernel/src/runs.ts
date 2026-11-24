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
 * (`bad_override`). Every run's end is in its session log (the harness's record, or
 * the daemon's when the harness left none), and `run.ended` is built from the log:
 * the first one and the answer to a re-sent `run.start` (also after a restart) are
 * the same frame.
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
  /** Default working directory of an agent's runs (the agent's own, also when a preset moves the run to another instance). */
  agentCwd(agent: AgentConfig): string;
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
  spec: RunSpec;
  turnId: string;
  lane: Lane;
  dispose(): Promise<void>;
  sub: Subscription;
  listeners: Set<Peer>;
  observe: ReplyRoute[];
  timer?: ReturnType<typeof setTimeout>;
  started: boolean;
  /** Set once the run ends: settles when its run.ended has been sent. */
  done?: Promise<void>;
  origin: Origin;
}

/** An end the daemon writes when the harness left none in the log. */
type Unlogged = { status: 'failed' | 'interrupted'; error: { code: string; message?: string } };

/** What a run's session log says about it (`Runs.read`). */
interface RunLog {
  facts: Pick<RunEnded, 'turnId' | 'inputId' | 'correlation'>;
  /** The first record's time. */
  first?: number;
  /** The run's end: its first `turn.completed`, or an `input.rejected` / `input.cancelled` before any turn. */
  end?: { status: RunStatus; error?: { code: string; message?: string }; at: number; usage?: unknown; restarted: boolean };
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
/** The error of a run the daemon interrupted as it stopped. */
const stoppingError = () => ({ code: 'daemon_stopping', message: 'the daemon stopped while the run was going' });
/** Notices (in the run's log) that say why a run was interrupted; the first one holds. */
const CAUSES = { run_timeout: { status: 'timeout', error: timeoutError }, run_stopping: { status: 'interrupted', error: stoppingError } } as const;

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

    const cwd = f.cwd ?? this.d.agentCwd(agent);
    if (!isAbsolute(cwd)) return fail('bad_cwd', `cwd must be absolute: ${cwd}`);
    try {
      if (!statSync(cwd).isDirectory()) return fail('bad_cwd', `cwd is not a directory: ${cwd}`);
    } catch {
      return fail('bad_cwd', `cwd does not exist: ${cwd}`);
    }
    const env = f.env ?? {};
    for (const k of Object.keys(env)) if (!VAR_NAME.test(k)) return fail('bad_env', `${JSON.stringify(k)} is not an environment variable name`);
    if (!f.input.length) return fail('empty_input', 'run.start needs input');

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
      spec,
      turnId,
      lane: built.lane,
      dispose: built.dispose,
      sub,
      listeners: new Set([peer]),
      observe,
      started: false,
      origin,
    };
    this.active.set(f.runId, run);
    void this.watch(run);
    if (f.timeoutMs !== undefined && f.timeoutMs > 0) {
      const ms = f.timeoutMs;
      run.timer = setTimeout(() => {
        // In the log: the run's end reads `timeout` (not a cancel), now and when re-sent.
        if (!run.done) this.cause(run, 'run_timeout', `run.start timeoutMs (${ms} ms) elapsed; interrupting the run`);
        void this.interrupt(run);
      }, ms);
    }
    const r = await run.lane.command({ type: 'input', sessionKey, input, mode: 'queue' }).catch((e: Error) => ({ ok: false as const, reason: e.message }));
    if (!r.ok) {
      this.d.recordRunInput({ ...recorded, rejected: { code: 'start_failed', message: r.reason } });
      await this.end(run, { status: 'failed', error: { code: 'start_failed', message: r.reason } });
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

  /**
   * Daemon shutdown: interrupt every run and wait (bounded by the caller) for its run.ended
   * to go out. A run interrupted this way ends `interrupted` with `daemon_stopping`.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    await Promise.all([...this.active.values()].map(async (r) => {
      if (!r.done) this.cause(r, 'run_stopping', 'the daemon is stopping; interrupting the run');
      await this.interrupt(r);
      // Closing the lane closes the harness session, which records how the turn ended.
      await this.end(r, { status: 'interrupted', error: stoppingError() });
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
    // Still no end: the previous daemon stopped between admitting the input and starting the turn.
    const log = this.read(runId);
    return this.frame(runId, log) ?? ended(runId, sessionKey, 'ambiguous', { code: 'host_restarted' }, log.facts);
  }

  /**
   * How a run that is not running ended, from its session log: the frame its end sent
   * (status, error, turn, input, correlation, usage, duration). `end` builds run.ended
   * the same way, so a re-sent `run.start` agrees with the first `run.ended`.
   */
  outcome(runId: string): RunEnded | undefined {
    return this.frame(runId, this.read(runId));
  }

  private frame(runId: string, log: RunLog): RunEnded | undefined {
    const { end, first } = log;
    if (!end) return undefined;
    // A run settled at a later start (host_restarted) ended at an unknown time: no duration.
    return ended(runId, runSessionKey(runId), end.status, end.error, {
      ...(first !== undefined && !end.restarted ? { durationMs: end.at - first } : {}),
      ...(end.usage !== undefined ? { usage: end.usage } : {}),
      ...log.facts,
    });
  }

  /**
   * A run's session log: the input (`input.admitted` has the whole InputRecord; an input the
   * lane refused before admitting it is named by its `input.rejected`, its correlation by its
   * routing record), the turn, why it was interrupted (`run_timeout`, `run_stopping`), its end.
   */
  private read(runId: string): RunLog {
    const sessionKey = runSessionKey(runId);
    let end: RunLog['end'];
    let first: number | undefined;
    let inputId: string | undefined;
    let correlation: string | undefined;
    let turnId: string | undefined;
    let cause: keyof typeof CAUSES | undefined;
    const interrupted = (at: number, error?: { code: string; message?: string }) => {
      const c = cause && CAUSES[cause];
      return c ? { status: c.status, error: c.error(), at, restarted: false } : { status: 'interrupted' as const, ...(error ? { error } : {}), at, restarted: false };
    };
    for (const e of this.d.hub.log.read(sessionKey, 0)) {
      const b = e.body;
      first ??= e.ts;
      if (b.t === 'input.admitted' && inputId === undefined) {
        inputId = b.inputId;
        correlation = b.input?.correlation;
      }
      if (b.t === 'turn.started' && turnId === undefined) turnId = b.turnId;
      if (b.t === 'notice' && Object.hasOwn(CAUSES, b.code)) cause ??= b.code as keyof typeof CAUSES;
      if (end) continue;
      if (b.t === 'turn.completed') {
        const error = b.error ? { code: b.error.code, ...(b.error.message ? { message: b.error.message } : {}) } : undefined;
        end =
          b.status === 'interrupted'
            ? { ...interrupted(e.ts, error), usage: b.usage }
            : { status: b.status, ...(error ? { error } : {}), at: e.ts, usage: b.usage, restarted: b.error?.code === 'host_restarted' };
      }
      if (turnId !== undefined) continue;
      if (b.t === 'input.rejected' || b.t === 'input.cancelled') inputId ??= b.inputIds[0];
      if (b.t === 'input.rejected') end = { status: 'failed', error: { code: 'start_failed', message: b.reason }, at: e.ts, restarted: false };
      if (b.t === 'input.cancelled') end = interrupted(e.ts, { code: 'cancelled' });
    }
    if (inputId !== undefined && correlation === undefined) {
      const run = this.d.explained(inputId)?.run;
      if (run?.runId === runId && run.correlation !== undefined) correlation = run.correlation;
    }
    return {
      facts: { ...(turnId !== undefined ? { turnId } : {}), ...(inputId !== undefined ? { inputId } : {}), ...(correlation !== undefined ? { correlation } : {}) },
      ...(first !== undefined ? { first } : {}),
      ...(end ? { end } : {}),
    };
  }

  /** Why the run is being interrupted, in its log (read by `read`). */
  private cause(run: ActiveRun, code: keyof typeof CAUSES, message: string): void {
    this.d.hub.append(run.sessionKey, {
      ts: Date.now(),
      ...(run.started ? { turnId: run.turnId } : {}),
      level: 'detail',
      audience: 'status',
      durability: 'durable',
      visibility: 'operators',
      body: { t: 'notice', code, message },
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

  /** True once the run has ended (its end is in the log). */
  private onEvent(run: ActiveRun, e: SessionEvent): boolean {
    const b = e.body;
    if (b.t === 'turn.started' && b.inputIds.includes(run.inputId)) {
      run.started = true;
      run.turnId = b.turnId;
      // More observers than the input's reply route: the compositors render the turn there too.
      for (const route of run.observe.slice(1)) {
        // The lane writes it: a mirror in an outbound.scoped host's scope is checked (U20).
        run.lane.mirror(b.turnId, route);
      }
      return false;
    }
    const ends =
      (b.t === 'turn.completed' && (b.turnId === run.turnId || run.started)) ||
      ((b.t === 'input.rejected' || b.t === 'input.cancelled') && b.inputIds.includes(run.inputId) && !run.started);
    if (ends) void this.end(run);
    return ends;
  }

  /**
   * End the run: close its lane, write `unlogged` if the log still has no end (a harness that
   * never reported one, an input the lane refused without a record), then send run.ended as
   * the log has it. Settles when it is sent; a second call waits for the first.
   */
  private end(run: ActiveRun, unlogged?: Unlogged): Promise<void> {
    run.done ??= this.finish(run, unlogged);
    return run.done;
  }

  private async finish(run: ActiveRun, unlogged: Unlogged = { status: 'interrupted', error: { code: 'cancelled' } }): Promise<void> {
    if (run.timer) clearTimeout(run.timer);
    run.sub.close();
    try {
      await run.dispose();
    } catch (e) {
      this.d.log('warn', `run ${run.runId}: close failed: ${(e as Error).message}`);
    }
    let frame: RunEnded;
    try {
      let log = this.read(run.runId);
      if (!log.end) {
        this.record(run, unlogged, log.facts.turnId);
        log = this.read(run.runId);
      }
      frame = this.frame(run.runId, log) ?? ended(run.runId, run.sessionKey, unlogged.status, unlogged.error, log.facts);
    } catch (e) {
      // The log closed first (a daemon stop that outwaited the bound on Runs.stop): what is known.
      this.d.log('warn', `run ${run.runId}: its log is gone: ${(e as Error).message}`);
      frame = ended(run.runId, run.sessionKey, unlogged.status, unlogged.error, { inputId: run.inputId, ...(run.started ? { turnId: run.turnId } : {}) });
    }
    this.d.log('info', `run ${run.runId}: ${frame.status} (exit ${frame.exitCode})${frame.error ? ` ${frame.error.code}` : ''}`);
    this.active.delete(run.runId);
    const live = [...run.listeners].filter((p) => !p.signal.aborted);
    const to = live.length ? live : [this.d.hostPeer()].filter((p): p is Peer => !!p);
    for (const p of to) p.send(frame as unknown as Record<string, unknown>);
  }

  /** The run's end, when its lane closed without one in the log: on its turn (`turnId`, open), or on its input. */
  private record(run: ActiveRun, u: Unlogged, turnId: string | undefined): void {
    const draft = { ts: Date.now(), level: 'primary', audience: 'status', durability: 'durable' } as const;
    if (turnId !== undefined) {
      const snap = this.d.hub.snapshot(run.sessionKey);
      this.d.hub.append(run.sessionKey, {
        ...draft,
        turnId,
        harness: snap.harness,
        generation: snap.generation,
        body: { t: 'turn.completed', turnId, status: u.status, error: { ...u.error, retryable: false } },
      });
    } else if (u.status === 'failed') this.d.hub.append(run.sessionKey, { ...draft, body: { t: 'input.rejected', inputIds: [run.inputId], reason: u.error.message ?? u.error.code } });
    else this.d.hub.append(run.sessionKey, { ...draft, body: { t: 'input.cancelled', inputIds: [run.inputId], reason: u.error.code } });
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
