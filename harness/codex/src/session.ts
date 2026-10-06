import type {
  Audience,
  Body,
  BodyOf,
  Decision,
  HarnessEvent,
  HarnessOpenArgs,
  HarnessSession,
  InputRecord,
  Level,
  RunSpec,
  SteerResult,
} from '@agents-io/protocol';
import type { RequestId } from './generated/RequestId.js';
import type { ThreadStatus } from './generated/v2/ThreadStatus.js';
import type { TurnError } from './generated/v2/TurnError.js';
import type { TurnStartParams } from './generated/v2/TurnStartParams.js';
import type { TurnStartResponse } from './generated/v2/TurnStartResponse.js';
import type { TurnSteerParams } from './generated/v2/TurnSteerParams.js';
import type { TurnInterruptParams } from './generated/v2/TurnInterruptParams.js';
import type { ThreadUnsubscribeParams } from './generated/v2/ThreadUnsubscribeParams.js';
import type { ErrorNotification } from './generated/v2/ErrorNotification.js';
import type { ThreadStatusChangedNotification } from './generated/v2/ThreadStatusChangedNotification.js';
import type { ThreadTokenUsageUpdatedNotification } from './generated/v2/ThreadTokenUsageUpdatedNotification.js';
import type { TurnStartedNotification } from './generated/v2/TurnStartedNotification.js';
import type { TurnCompletedNotification } from './generated/v2/TurnCompletedNotification.js';
import type { TurnDiffUpdatedNotification } from './generated/v2/TurnDiffUpdatedNotification.js';
import type { TurnPlanUpdatedNotification } from './generated/v2/TurnPlanUpdatedNotification.js';
import type { ItemStartedNotification } from './generated/v2/ItemStartedNotification.js';
import type { ItemCompletedNotification } from './generated/v2/ItemCompletedNotification.js';
import type { AgentMessageDeltaNotification } from './generated/v2/AgentMessageDeltaNotification.js';
import type { McpToolCallProgressNotification } from './generated/v2/McpToolCallProgressNotification.js';
import type { ServerRequestResolvedNotification } from './generated/v2/ServerRequestResolvedNotification.js';
import type { ModelReroutedNotification } from './generated/v2/ModelReroutedNotification.js';
import { isApprovalMethod, openedFor, responseFor, type ApprovalMethod } from './approvals.js';
import {
  asCompleted,
  asStarted,
  decodeClientId,
  diffStats,
  encodeClientId,
  errorCode,
  planSteps,
  renderInputs,
  resolveProfile,
  sandboxPolicyOf,
  summarizeItem,
  turnError,
  turnStatus,
  type CodexProfile,
  type MediaResolver,
} from './map.js';
import { AsyncQueue } from './queue.js';
import { RpcError, type RpcClient } from './rpc.js';

/** Per-session options, read from `HarnessOpenArgs.options`. */
export interface CodexOpenOptions {
  /** agents-io profile name → Codex approval/sandbox settings. Built in: `bypass` (never ask, workspace-write). */
  profiles?: Record<string, CodexProfile>;
  /** Extra Codex config overrides for thread/start / thread/resume (same keys as config.toml). */
  config?: Record<string, unknown>;
  resolveMedia?: MediaResolver;
  /** Prefix each input with a one-line `[sender …]` context line (default true). */
  preface?: boolean;
  baseInstructions?: string;
  developerInstructions?: string;
  ephemeral?: boolean;
  /** Name the host MCP endpoint is mounted under (default `agents_io`). */
  mcpServerName?: string;
}

interface Turn {
  turnId: string;
  run: RunSpec;
  codexTurnId?: string;
  bound: Promise<string | undefined>;
  bind(id: string | undefined): void;
  startInputs: string[];
  steerInputs: Set<string>;
  consumed: Set<string>;
  openItems: Set<string>;
  itemAudience: Map<string, Audience>;
  usage?: unknown;
  error?: TurnError;
  lastAnswer?: { itemId: string; text: string };
  lastDiff?: string;
  done: boolean;
  finished: Promise<void>;
  finish(): void;
}

interface PendingRequest {
  rpcId: RequestId;
  method: ApprovalMethod;
  params: unknown;
  turnId?: string;
}

interface Applied {
  model?: string;
  effort?: string;
  profile: string;
}

/** Hooks into the shared app-server connection, implemented by CodexHarness. */
export interface SessionHost {
  rpc: RpcClient;
  detach(session: CodexSession): void;
}

type Extra = Partial<Omit<HarnessEvent, 'body' | 'ts'>>;

const EPHEMERAL = new Set<Body['t']>(['text.delta', 'item.progress', 'headline']);

export class CodexSession implements HarnessSession {
  private readonly queue = new AsyncQueue<HarnessEvent>();
  readonly events: AsyncIterable<HarnessEvent> = this.queue;
  private active: Turn | undefined;
  private requests = new Map<string, PendingRequest>();
  private clientIds = new Map<string, string[]>();
  private state: BodyOf<'session.state'>['state'] | undefined;
  private closed = false;

  constructor(
    private readonly host: SessionHost,
    readonly threadId: string,
    private readonly args: HarnessOpenArgs,
    private readonly opts: CodexOpenOptions,
    private applied: Applied,
  ) {}

  nativeId(): string {
    return this.threadId;
  }

  // ---- commands ---------------------------------------------------------------

  async startTurn(turnId: string, inputs: InputRecord[], run?: RunSpec): Promise<void> {
    if (this.closed) throw new Error('codex session is closed');
    if (this.active) throw new Error(`turn ${this.active.turnId} is still active`);
    const effective = run ?? this.args.run;
    const t = this.newTurn(turnId, effective, inputs.map((i) => i.inputId));
    this.active = t;
    this.emit({ t: 'turn.started', turnId, inputIds: t.startInputs, replyRoute: inputs[0]?.replyRoute ?? null, run: effective }, { turnId });

    const clientUserMessageId = encodeClientId(t.startInputs);
    this.clientIds.set(clientUserMessageId, t.startInputs);
    try {
      const input = await renderInputs(inputs, { resolveMedia: this.opts.resolveMedia, preface: this.opts.preface });
      const params: TurnStartParams = { threadId: this.threadId, input, clientUserMessageId, ...this.overrides(effective) };
      const res = await this.host.rpc.request<TurnStartResponse>('turn/start', params);
      this.applied = { model: effective.model || this.applied.model, effort: effective.effort ?? this.applied.effort, profile: effective.profile };
      if (!t.codexTurnId) t.bind(res.turn.id);
    } catch (e) {
      t.bind(undefined);
      if (t.done) return;
      const unknown = !(e instanceof RpcError);
      this.finishTurn(t, unknown ? 'ambiguous' : 'failed', {
        code: unknown ? 'harness_unreachable' : 'turn_start_rejected',
        retryable: false,
        message: (e as Error).message,
      });
    }
  }

  async steer(inputs: InputRecord[], expectedTurnId: string): Promise<SteerResult> {
    const t = this.active;
    if (!t || t.done) return 'no_active_turn';
    if (t.turnId !== expectedTurnId) return 'stale';
    const codexTurnId = await t.bound;
    if (!codexTurnId || t.done) return 'no_active_turn';
    const ids = inputs.map((i) => i.inputId);
    const clientUserMessageId = encodeClientId(ids);
    this.clientIds.set(clientUserMessageId, ids);
    for (const id of ids) t.steerInputs.add(id);
    try {
      const input = await renderInputs(inputs, { resolveMedia: this.opts.resolveMedia, preface: this.opts.preface });
      const params: TurnSteerParams = { threadId: this.threadId, expectedTurnId: codexTurnId, clientUserMessageId, input };
      await this.host.rpc.request('turn/steer', params);
      return 'steered';
    } catch (e) {
      for (const id of ids) t.steerInputs.delete(id);
      this.clientIds.delete(clientUserMessageId);
      const r = classifySteerError(e);
      if (r) return r;
      throw e;
    }
  }

  async interrupt(turnId: string): Promise<void> {
    const t = this.active;
    if (!t || t.turnId !== turnId || t.done) return;
    const codexTurnId = await t.bound;
    if (!codexTurnId || t.done) return;
    const params: TurnInterruptParams = { threadId: this.threadId, turnId: codexTurnId };
    try {
      await this.host.rpc.request('turn/interrupt', params);
    } catch (e) {
      // "no active turn to interrupt": it ended on its own; turn/completed reports how.
      if (!(e instanceof RpcError)) throw e;
    }
  }

  async respond(requestId: string, decision: Decision): Promise<void> {
    const r = this.requests.get(requestId);
    if (!r) throw new Error(`unknown or already resolved request ${requestId}`);
    const { result, interrupt } = responseFor(r.method, r.params, decision);
    this.requests.delete(requestId);
    this.host.rpc.respond(r.rpcId, result);
    // The adapter cannot know who decided; the session layer, which called respond, can rewrite `by`.
    this.emit({ t: 'request.resolved', requestId, decision, by: { kind: 'host' } }, { turnId: this.liveTurnId(r.turnId), audience: 'approval' });
    if (interrupt && r.turnId) await this.interrupt(r.turnId);
  }

  async close(reason: string): Promise<void> {
    if (this.closed) return;
    const t = this.active;
    if (t && !t.done) {
      await this.interrupt(t.turnId).catch(() => undefined);
      await Promise.race([t.finished, delay(3000)]);
      if (!t.done) this.finishTurn(t, 'ambiguous', { code: 'session_closed', retryable: false, message: reason });
    }
    this.closed = true;
    const params: ThreadUnsubscribeParams = { threadId: this.threadId };
    await this.host.rpc.request('thread/unsubscribe', params, 5000).catch(() => undefined);
    this.host.detach(this);
    this.queue.close();
  }

  /** The app-server went away. Whatever was running has an unknown outcome. */
  transportClosed(reason: string): void {
    if (this.closed) return;
    const t = this.active;
    if (t && !t.done) this.finishTurn(t, 'ambiguous', { code: 'harness_exited', retryable: false, message: reason });
    for (const id of [...this.requests.keys()]) this.cancelRequest(id);
    this.setState('error');
    this.closed = true;
    this.queue.close();
  }

  // ---- inbound from app-server --------------------------------------------------

  onNotification(method: string, params: unknown): void {
    switch (method) {
      case 'turn/started': {
        const p = params as TurnStartedNotification;
        if (!this.turnFor(p.turn.id)) this.native(method, params);
        return;
      }
      case 'turn/completed': {
        const p = params as TurnCompletedNotification;
        const t = this.turnFor(p.turn.id);
        if (!t) return this.native(method, params);
        const err = p.turn.error ?? t.error;
        let status = turnStatus(p.turn.status);
        if (status === 'completed' && err) status = 'failed';
        this.finishTurn(t, status, err && status !== 'completed' ? turnError(err) : undefined, params);
        return;
      }
      case 'item/started':
      case 'item/completed':
        return this.onItem(method, params as ItemStartedNotification | ItemCompletedNotification);
      case 'item/agentMessage/delta':
      case 'item/reasoning/summaryTextDelta':
      case 'item/reasoning/textDelta':
      case 'item/commandExecution/outputDelta': {
        const p = params as AgentMessageDeltaNotification;
        const t = this.turnFor(p.turnId);
        if (!t) return this.native(method, params);
        if (method === 'item/agentMessage/delta') {
          this.emit({ t: 'text.delta', delta: p.delta, stream: 'answer' }, { turnId: t.turnId, itemId: p.itemId, audience: t.itemAudience.get(p.itemId) ?? 'answer' });
        } else if (method === 'item/commandExecution/outputDelta') {
          this.emit({ t: 'text.delta', delta: p.delta, stream: 'command_output' }, { turnId: t.turnId, itemId: p.itemId, level: 'detail' });
        } else {
          this.emit({ t: 'text.delta', delta: p.delta, stream: 'reasoning' }, { turnId: t.turnId, itemId: p.itemId, level: 'detail', audience: 'internal' });
        }
        return;
      }
      case 'item/mcpToolCall/progress': {
        const p = params as McpToolCallProgressNotification;
        const t = this.turnFor(p.turnId);
        if (!t) return this.native(method, params);
        this.emit({ t: 'item.progress', itemId: p.itemId, text: p.message }, { turnId: t.turnId, itemId: p.itemId, level: 'detail' });
        return;
      }
      case 'turn/plan/updated': {
        const p = params as TurnPlanUpdatedNotification;
        const t = this.turnFor(p.turnId);
        if (!t) return this.native(method, params);
        this.emit({ t: 'plan.updated', steps: planSteps(p.plan) }, { turnId: t.turnId, native: p.explanation ? { explanation: p.explanation } : undefined });
        return;
      }
      case 'turn/diff/updated': {
        const p = params as TurnDiffUpdatedNotification;
        const t = this.turnFor(p.turnId);
        if (!t) return this.native(method, params);
        const files = diffStats(p.diff);
        const key = JSON.stringify(files);
        if (key === t.lastDiff) return; // Codex re-sends the aggregate diff after each file item
        t.lastDiff = key;
        this.emit({ t: 'diff.updated', files }, { turnId: t.turnId, level: 'detail', native: params });
        return;
      }
      case 'thread/tokenUsage/updated': {
        const p = params as ThreadTokenUsageUpdatedNotification;
        const t = this.turnFor(p.turnId);
        if (t) t.usage = p.tokenUsage;
        this.emit({ t: 'usage', usage: p.tokenUsage }, { turnId: t?.turnId, level: 'debug', audience: 'internal' });
        return;
      }
      case 'thread/status/changed': {
        const p = params as ThreadStatusChangedNotification;
        const s = sessionState(p.status);
        if (s) this.setState(s);
        return;
      }
      case 'error': {
        const p = params as ErrorNotification;
        const t = this.turnFor(p.turnId);
        if (p.willRetry) {
          const code = errorCode(p.error.codexErrorInfo);
          this.emit(
            { t: 'notice', code: code === 'rateLimitExceeded' || code === 'usageLimitExceeded' ? 'rate_limited' : 'api_retry', message: p.error.message },
            { turnId: t?.turnId, level: 'detail', native: params },
          );
        } else {
          if (t) t.error = p.error; // turn/completed follows and carries the failure
          this.native(method, params, t?.turnId);
        }
        return;
      }
      case 'serverRequest/resolved': {
        const p = params as ServerRequestResolvedNotification;
        // Still pending here means another client answered it, or Codex dropped it (turn ended).
        if (this.requests.has(String(p.requestId))) this.cancelRequest(String(p.requestId), { kind: 'harness' });
        return;
      }
      case 'item/autoApprovalReview/started':
      case 'item/autoApprovalReview/completed': {
        const p = params as { turnId: string };
        const t = this.turnFor(p.turnId);
        const done = method.endsWith('completed');
        this.emit(
          { t: 'notice', code: 'auto_review', message: done ? 'auto review finished' : 'auto review started' },
          { turnId: t?.turnId, level: 'detail', native: params },
        );
        return;
      }
      case 'model/rerouted': {
        const p = params as ModelReroutedNotification;
        const t = this.turnFor(p.turnId);
        this.emit({ t: 'notice', code: 'other', message: `model rerouted ${p.fromModel} → ${p.toModel}` }, { turnId: t?.turnId, native: params });
        return;
      }
      default:
        return this.native(method, params);
    }
  }

  onServerRequest(id: RequestId, method: string, params: unknown): void {
    if (!isApprovalMethod(method)) {
      // Dynamic tools, auth refresh, attestation: this adapter registers none of them.
      this.host.rpc.respondError(id, -32601, `@agents-io/harness-codex does not handle ${method}`);
      this.native(method, params);
      return;
    }
    const p = params as { turnId?: string | null; itemId?: string };
    const t = p.turnId ? this.turnFor(p.turnId) : this.active;
    const requestId = String(id);
    this.requests.set(requestId, { rpcId: id, method, params, turnId: t?.turnId });
    this.emit(
      { t: 'request.opened', requestId, ...openedFor(method, params) },
      { turnId: t?.turnId, itemId: p.itemId, audience: 'approval', native: { method, params } },
    );
  }

  // ---- internals ----------------------------------------------------------------

  private onItem(method: 'item/started' | 'item/completed', p: ItemStartedNotification | ItemCompletedNotification): void {
    const t = this.turnFor(p.turnId);
    if (!t) return this.native(method, p);
    const item = p.item;
    const started = method === 'item/started';

    if (item.type === 'userMessage' && item.clientId) {
      const ids = this.clientIds.get(item.clientId) ?? decodeClientId(item.clientId);
      const ours = ids.filter((id) => t.startInputs.includes(id) || t.steerInputs.has(id));
      if (ours.length) {
        if (!started) {
          const fresh = ours.filter((id) => !t.consumed.has(id));
          for (const id of fresh) t.consumed.add(id);
          if (fresh.length) this.emit({ t: 'input.consumed', inputIds: fresh, turnId: t.turnId }, { turnId: t.turnId, itemId: item.id, level: 'detail' });
        }
        return;
      }
    }

    const m = summarizeItem(item, this.args.cwd);
    if (!m) return this.native(method, p, t.turnId);
    const extra = { turnId: t.turnId, itemId: item.id, audience: m.audience, level: m.level } satisfies Extra;
    if (started) {
      t.openItems.add(item.id);
      t.itemAudience.set(item.id, m.audience);
      this.emit({ t: 'item.started', item: asStarted(m.summary) }, extra);
      if (item.type === 'contextCompaction') this.emit({ t: 'notice', code: 'compacting', message: 'compacting context' }, { turnId: t.turnId, level: 'detail' });
      return;
    }
    t.openItems.delete(item.id);
    this.emit({ t: 'item.completed', item: asCompleted(m.summary) }, extra);
    if (item.type === 'agentMessage') {
      this.emit({ t: 'text.snapshot', text: item.text, final: false }, extra);
      if (m.audience === 'commentary') {
        const line = item.text.trim().split('\n')[0];
        if (line) this.emit({ t: 'headline', text: line.slice(0, 120) }, { turnId: t.turnId, itemId: item.id, audience: 'commentary' });
      } else t.lastAnswer = { itemId: item.id, text: item.text };
    }
  }

  private finishTurn(t: Turn, status: BodyOf<'turn.completed'>['status'], error?: BodyOf<'turn.completed'>['error'], native?: unknown): void {
    if (t.done) return;
    for (const [id, r] of this.requests) if (r.turnId === t.turnId) this.cancelRequest(id);
    const missing = t.startInputs.filter((id) => !t.consumed.has(id));
    if (status === 'completed' && missing.length) {
      // admitted ≠ consumed: Codex did not echo these inputs' clientId, so we cannot claim the turn used them.
      this.emit({ t: 'notice', code: 'continuity', message: `codex did not confirm inputs ${missing.join(', ')}` }, { turnId: t.turnId, level: 'detail' });
      status = 'ambiguous';
    }
    if (t.lastAnswer) {
      this.emit({ t: 'text.snapshot', text: t.lastAnswer.text, final: true }, { turnId: t.turnId, itemId: t.lastAnswer.itemId, audience: 'answer' });
    }
    t.done = true;
    const body: BodyOf<'turn.completed'> = { t: 'turn.completed', turnId: t.turnId, status };
    if (t.usage !== undefined) body.usage = t.usage;
    if (error) body.error = error;
    this.emit(body, { turnId: t.turnId, native });
    if (this.active === t) this.active = undefined;
    for (const [cid, ids] of this.clientIds) if (ids.every((id) => t.startInputs.includes(id) || t.steerInputs.has(id))) this.clientIds.delete(cid);
    t.bind(undefined);
    t.finish();
  }

  private cancelRequest(requestId: string, by: BodyOf<'request.resolved'>['by'] = 'runtime_cancelled'): void {
    const r = this.requests.get(requestId);
    if (!r) return;
    this.requests.delete(requestId);
    this.emit({ t: 'request.resolved', requestId, decision: null, by }, { turnId: this.liveTurnId(r.turnId), audience: 'approval' });
  }

  /** Our active turn for a Codex turn id. Binds an unbound turn (events can precede the turn/start response). */
  private turnFor(codexTurnId: string | null | undefined): Turn | undefined {
    const t = this.active;
    if (!t || t.done || !codexTurnId) return undefined;
    if (t.codexTurnId === codexTurnId) return t;
    if (t.codexTurnId === undefined) {
      t.bind(codexTurnId);
      return t;
    }
    return undefined; // a turn some other client started on this thread
  }

  private liveTurnId(turnId: string | undefined): string | undefined {
    return turnId && this.active?.turnId === turnId && !this.active.done ? turnId : undefined;
  }

  private newTurn(turnId: string, run: RunSpec, startInputs: string[]): Turn {
    let bindFn!: (id: string | undefined) => void;
    let finishFn!: () => void;
    const bound = new Promise<string | undefined>((r) => (bindFn = r));
    const finished = new Promise<void>((r) => (finishFn = r));
    const t: Turn = {
      turnId,
      run,
      bound,
      bind: (id) => {
        if (id && !t.codexTurnId) t.codexTurnId = id;
        bindFn(t.codexTurnId);
      },
      startInputs,
      steerInputs: new Set(),
      consumed: new Set(),
      openItems: new Set(),
      itemAudience: new Map(),
      done: false,
      finished,
      finish: finishFn,
    };
    return t;
  }

  /** turn/start overrides persist for later turns, so only send what changed. */
  private overrides(run: RunSpec): Partial<TurnStartParams> {
    const o: Partial<TurnStartParams> = {};
    if (run.model && run.model !== this.applied.model) o.model = run.model;
    if (run.effort && run.effort !== this.applied.effort) o.effort = run.effort;
    if (run.profile !== this.applied.profile) {
      const p = resolveProfile(run.profile, this.opts.profiles);
      if (p.approvalPolicy) o.approvalPolicy = p.approvalPolicy;
      if (p.approvalsReviewer) o.approvalsReviewer = p.approvalsReviewer;
      const sp = sandboxPolicyOf(p);
      if (sp) o.sandboxPolicy = sp;
    }
    return o;
  }

  private setState(s: BodyOf<'session.state'>['state']): void {
    if (s === this.state) return;
    this.state = s;
    this.emit({ t: 'session.state', state: s }, { level: 'detail' });
  }

  private native(name: string, params: unknown, turnId?: string): void {
    this.emit({ t: 'native', name }, { turnId, level: 'debug', audience: 'internal', native: params });
  }

  private emit(body: Body, extra: Extra = {}): void {
    if (this.closed) return;
    const e: HarnessEvent = {
      ts: Date.now(),
      level: (extra.level ?? 'primary') as Level,
      audience: extra.audience ?? 'status',
      durability: EPHEMERAL.has(body.t) ? 'ephemeral' : 'durable',
      body,
    };
    if (extra.turnId) e.turnId = extra.turnId;
    if (extra.itemId) e.itemId = extra.itemId;
    if (extra.native !== undefined) e.native = extra.native;
    this.queue.push(e);
  }
}

function sessionState(s: ThreadStatus): BodyOf<'session.state'>['state'] | undefined {
  switch (s.type) {
    case 'idle':
      return 'idle';
    case 'active':
      return s.activeFlags.length ? 'requires_action' : 'running';
    case 'systemError':
      return 'error';
    case 'notLoaded':
      return undefined;
  }
}

/** turn/steer failures Codex reports as a JSON-RPC error (-32600 invalid request). */
export function classifySteerError(e: unknown): SteerResult | undefined {
  if (!(e instanceof RpcError)) return undefined;
  const data = e.data as { codexErrorInfo?: unknown } | undefined;
  const info = data?.codexErrorInfo;
  const msg = e.message.toLowerCase();
  if ((info && typeof info === 'object' && 'activeTurnNotSteerable' in info) || msg.includes('cannot steer')) return 'not_steerable';
  if (msg.includes('expected active turn id')) return 'stale';
  if (msg.includes('no active turn')) return 'no_active_turn';
  return undefined;
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref());

