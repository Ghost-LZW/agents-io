import type {
  Audience,
  Body,
  BodyOf,
  Decision,
  HarnessEvent,
  HarnessOpenArgs,
  HarnessSession,
  InputRecord,
  ItemSummary,
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
import type { ThreadResumeParams } from './generated/v2/ThreadResumeParams.js';
import type { ThreadResumeResponse } from './generated/v2/ThreadResumeResponse.js';
import type { ThreadTurnsListParams } from './generated/v2/ThreadTurnsListParams.js';
import type { ThreadTurnsListResponse } from './generated/v2/ThreadTurnsListResponse.js';
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
import type { ReasoningSummaryTextDeltaNotification } from './generated/v2/ReasoningSummaryTextDeltaNotification.js';
import type { ReasoningTextDeltaNotification } from './generated/v2/ReasoningTextDeltaNotification.js';
import type { McpToolCallProgressNotification } from './generated/v2/McpToolCallProgressNotification.js';
import type { ServerRequestResolvedNotification } from './generated/v2/ServerRequestResolvedNotification.js';
import type { ModelReroutedNotification } from './generated/v2/ModelReroutedNotification.js';
import type { ItemGuardianApprovalReviewStartedNotification } from './generated/v2/ItemGuardianApprovalReviewStartedNotification.js';
import type { ItemGuardianApprovalReviewCompletedNotification } from './generated/v2/ItemGuardianApprovalReviewCompletedNotification.js';
import type { GuardianApprovalReviewAction } from './generated/v2/GuardianApprovalReviewAction.js';
import type { ThreadInjectItemsParams } from './generated/v2/ThreadInjectItemsParams.js';
import { isApprovalMethod, openedFor, responseFor, type ApprovalMethod } from './approvals.js';
import {
  asCompleted,
  displayCommand,
  asStarted,
  decodeClientId,
  diffStats,
  encodeClientId,
  errorCode,
  FALLBACK_PROFILE,
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
  /**
   * `mcp_servers.<name>.default_tools_approval_mode` for the host endpoint: `approve`
   * (default; the host checks destinations itself), `auto`, `prompt`, `writes`, or null to leave Codex's default.
   */
  mcpApprovalMode?: 'auto' | 'prompt' | 'writes' | 'approve' | null;
}

interface Turn {
  turnId: string;
  run?: RunSpec;
  initiator: 'host' | 'foreign';
  codexTurnId?: string;
  bound: Promise<string | undefined>;
  bind(id: string | undefined): void;
  startInputs: string[];
  steerInputs: Set<string>;
  consumed: Set<string>;
  openItems: Map<string, ItemSummary>;
  itemAudience: Map<string, Audience>;
  /** Reasoning item → which delta stream it uses and the last part index seen. */
  reasoning: Map<string, { kind: 'summary' | 'raw'; part: number }>;
  usage?: unknown;
  error?: TurnError;
  lastAnswer?: { itemId: string; text: string };
  lastDiff?: string;
  /** Events may have been missed (connection dropped, or adopted after a host restart). */
  gap?: boolean;
  done: boolean;
  finished: Promise<void>;
  finish(): void;
}

interface PendingRequest {
  rpcId: RequestId;
  method: ApprovalMethod;
  params: unknown;
  turnId?: string;
  /** Not yet re-sent by Codex since the last reconnect. */
  unconfirmed?: boolean;
  /** Answered while the connection was down; sent when Codex replays the request. */
  answer?: Decision;
}

/** What survives a host restart for a turn still running in a detached app-server. */
export interface TurnSnapshot {
  turnId: string;
  codexTurnId: string;
  run?: RunSpec;
  initiator?: 'host' | 'foreign';
  startInputs: string[];
  steerInputs: string[];
  consumed: string[];
}

interface Applied {
  model?: string;
  effort?: string;
  profile: string;
}

/** Hooks into the shared app-server connection, implemented by CodexHarness. */
export interface SessionHost {
  readonly rpc: RpcClient;
  detach(session: CodexSession): void;
  /** Persist (or clear, with undefined) the running turn so a restarted host can adopt it. */
  saveTurn?(threadId: string, snap: TurnSnapshot | undefined): void;
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
  private finishedCodexTurns = new Set<string>();
  /** File paths of fileChange items, for approval previews. */
  private fileItems = new Map<string, string[]>();

  constructor(
    private readonly host: SessionHost,
    readonly threadId: string,
    private readonly args: HarnessOpenArgs,
    private readonly opts: CodexOpenOptions,
    private applied: Applied,
    adopt?: TurnSnapshot,
  ) {
    this.emit({ t: 'session.bound', nativeId: threadId }, { level: 'detail' });
    if (adopt) {
      const t = this.newTurn(adopt.turnId, adopt.run, adopt.startInputs, adopt.initiator ?? 'host');
      t.bind(adopt.codexTurnId);
      for (const id of adopt.steerInputs) t.steerInputs.add(id);
      for (const id of adopt.consumed) t.consumed.add(id);
      for (const ids of [adopt.startInputs, ...adopt.steerInputs.map((i) => [i])]) this.clientIds.set(encodeClientId(ids), ids);
      t.gap = true;
      this.active = t;
      this.emit(
        { t: 'turn.adopted', turnId: adopt.turnId, nativeTurnId: adopt.codexTurnId, inputIds: [...adopt.startInputs, ...adopt.steerInputs], ...(adopt.run ? { run: adopt.run } : {}) },
        { turnId: adopt.turnId },
      );
    }
  }

  /** Turn id of a turn adopted from a previous host process, if any. */
  adoptedTurnId(): string | undefined {
    return this.active?.gap ? this.active.turnId : undefined;
  }

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
    this.emit(
      { t: 'turn.started', turnId, inputIds: t.startInputs, replyRoute: inputs[0]?.replyRoute ?? null, run: effective, initiator: 'host' },
      { turnId },
    );

    const clientUserMessageId = encodeClientId(t.startInputs);
    this.clientIds.set(clientUserMessageId, t.startInputs);
    try {
      const input = await renderInputs(inputs, { resolveMedia: this.opts.resolveMedia, preface: this.opts.preface });
      const params: TurnStartParams = { threadId: this.threadId, input, clientUserMessageId, ...this.overrides(effective) };
      const res = await this.host.rpc.request<TurnStartResponse>('turn/start', params);
      this.applied = { model: effective.model || this.applied.model, effort: effective.effort ?? this.applied.effort, profile: effective.profile };
      if (!t.codexTurnId) t.bind(res.turn.id);
      this.saveTurn(t);
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
    const rollback = () => {
      for (const id of ids) t.steerInputs.delete(id);
      this.clientIds.delete(clientUserMessageId);
    };
    let params: TurnSteerParams;
    try {
      const input = await renderInputs(inputs, { resolveMedia: this.opts.resolveMedia, preface: this.opts.preface });
      params = { threadId: this.threadId, expectedTurnId: codexTurnId, clientUserMessageId, input };
    } catch (e) {
      rollback();
      throw e;
    }
    try {
      await this.host.rpc.request('turn/steer', params);
      this.saveTurn(t);
      return 'steered';
    } catch (e) {
      if (!(e instanceof RpcError) && !t.done) {
        // Outcome unknown (timed out, connection lost): Codex may have taken it. Keep the
        // inputs on the turn so a later userMessage echo of the clientId still counts them as
        // consumed; whatever is never echoed is unconsumed at turn end and reconciled there.
        this.saveTurn(t);
        this.emit(
          { t: 'notice', code: 'continuity', message: `codex steer of ${ids.join(', ')} unconfirmed (${(e as Error).message})` },
          { turnId: t.turnId, level: 'detail' },
        );
        return 'steered';
      }
      rollback();
      const r = classifySteerError(e);
      if (r) return r;
      if (t.done) return 'no_active_turn';
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
    if (!r || r.answer) throw new Error(`unknown or already resolved request ${requestId}`);
    r.answer = decision;
    // Connection down (reconnecting), or back but the request not yet replayed: a write now
    // may be lost. Codex replays the request on the new connection and the answer goes out
    // then (onServerRequest); until then it is not resolved.
    if (this.host.rpc.closed === undefined && !r.unconfirmed) await this.sendAnswer(requestId, r, decision);
  }

  private async sendAnswer(requestId: string, r: PendingRequest, decision: Decision): Promise<void> {
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

  /**
   * Leave without touching the running turn: no interrupt, no unsubscribe. Used
   * when the host shuts down but the app-server (unix transport) keeps running;
   * a later `open({ resume })` adopts the turn from the persisted snapshot.
   */
  detachFromServer(): void {
    if (this.closed) return;
    if (this.active && !this.active.done) this.saveTurn(this.active);
    this.closed = true;
    this.queue.close();
  }

  /**
   * After a new connection to the same app-server: rejoin the thread (Codex
   * replays requests still pending, with the same ids) and settle a turn that
   * ended while we were away.
   */
  async reattach(): Promise<void> {
    if (this.closed) return;
    for (const r of this.requests.values()) r.unconfirmed = true;
    if (this.active) this.active.gap = true;
    const params: ThreadResumeParams = { threadId: this.threadId, excludeTurns: true };
    const res = await this.host.rpc.request<ThreadResumeResponse>('thread/resume', params);
    await this.afterResume(res.thread.status);
    // Replays arrive right after the resume response; whatever is not replayed was answered elsewhere.
    setTimeout(() => {
      for (const [id, r] of this.requests) if (r.unconfirmed) this.cancelRequest(id, { kind: 'harness' });
    }, 2000).unref();
  }

  /** Called once the thread is (re)joined. Settles an adopted or gapped turn if Codex no longer runs it. */
  async afterResume(status: ThreadStatus): Promise<void> {
    const t = this.active;
    if (!t || t.done || !t.codexTurnId) return;
    this.emit({ t: 'notice', code: 'continuity', message: `reattached to codex turn ${t.codexTurnId}; events during the gap were not replayed` }, { turnId: t.turnId, level: 'detail' });
    const list = await this.host.rpc
      .request<ThreadTurnsListResponse>('thread/turns/list', { threadId: this.threadId, limit: 20, sortDirection: 'desc' } satisfies ThreadTurnsListParams)
      .catch(() => undefined);
    if (t.done) return;
    const turn = list?.data.find((x) => x.id === t.codexTurnId);
    if (turn && turn.status === 'inProgress') return;
    if (!turn) {
      // Active with a turn we cannot see: keep ours unless Codex shows another one running.
      if (status.type === 'active' && !list?.data.some((x) => x.status === 'inProgress')) return;
      return this.finishTurn(t, 'ambiguous', { code: 'turn_lost', retryable: false, message: 'codex no longer knows this turn' });
    }
    let st = turnStatus(turn.status);
    if (st === 'completed' && turn.error) st = 'failed';
    for (const item of turn.items) if (item.type === 'agentMessage' && item.phase !== 'commentary') t.lastAnswer = { itemId: item.id, text: item.text };
    this.finishTurn(t, st, turn.error && st !== 'completed' ? turnError(turn.error) : undefined);
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
        if (!this.turnOrForeign(p.turn.id)) this.native(method, params);
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
          // Reasoning reaches participants like Claude's thinking (`commentary`, detail level), so
          // process UIs (the Lark thinking bubble) show it. One stream per item (the first seen:
          // summary or raw text), so a model sending both is not shown twice; a new part starts a paragraph.
          const kind = method === 'item/reasoning/summaryTextDelta' ? 'summary' : 'raw';
          let r = t.reasoning.get(p.itemId);
          if (!r) t.reasoning.set(p.itemId, (r = { kind, part: -1 }));
          if (r.kind !== kind) return;
          const part = kind === 'summary' ? (params as ReasoningSummaryTextDeltaNotification).summaryIndex : (params as ReasoningTextDeltaNotification).contentIndex;
          const delta = r.part >= 0 && part !== r.part ? `\n\n${p.delta}` : p.delta;
          r.part = part;
          this.emit({ t: 'text.delta', delta, stream: 'reasoning' }, { turnId: t.turnId, itemId: p.itemId, level: 'detail', audience: 'commentary' });
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
        // Never binds: after thread/resume Codex reports the usage of the thread's last turn (an
        // earlier one), which can arrive between our turn/start and its answer.
        const t = this.turnFor(p.turnId, false);
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
      case 'item/autoApprovalReview/completed':
        return this.onAutoReview(method, params as ItemGuardianApprovalReviewStartedNotification | ItemGuardianApprovalReviewCompletedNotification);
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
    const requestId = String(id);
    const known = this.requests.get(requestId);
    if (known) {
      // Replayed to a new connection (same id): already open on our stream.
      known.rpcId = id;
      known.params = params;
      known.unconfirmed = false;
      if (known.answer) {
        this.sendAnswer(requestId, known, known.answer).catch((e: Error) =>
          this.emit({ t: 'notice', code: 'other', message: `answer to request ${requestId} failed: ${e.message}` }, { turnId: known.turnId, level: 'detail' }),
        );
      }
      return;
    }
    const t = p.turnId ? this.turnFor(p.turnId) : this.active;
    this.requests.set(requestId, { rpcId: id, method, params, turnId: t?.turnId });
    this.emit(
      { t: 'request.opened', requestId, ...openedFor(method, params, p.itemId ? this.fileItems.get(p.itemId) : undefined) },
      { turnId: t?.turnId, itemId: p.itemId, audience: 'approval', native: { method, params } },
    );
  }

  /**
   * With `approvalsReviewer: auto_review` Codex decides by itself and the request
   * never reaches clients. It is reported as `notice{auto_review}` (when it starts,
   * then its outcome), not as a request: nothing here can answer it, so it must never
   * reach a resolver or the lane's policy, which would record a decision Codex ignores.
   */
  private onAutoReview(
    method: 'item/autoApprovalReview/started' | 'item/autoApprovalReview/completed',
    p: ItemGuardianApprovalReviewStartedNotification | ItemGuardianApprovalReviewCompletedNotification,
  ): void {
    const t = this.turnFor(p.turnId);
    const title = reviewTitle(p.action);
    const extra = { turnId: t?.turnId, itemId: p.targetItemId ?? undefined, native: { method, params: p } } satisfies Extra;
    if (method === 'item/autoApprovalReview/started') {
      this.emit({ t: 'notice', code: 'auto_review', message: `auto review: ${title}` }, { ...extra, level: 'detail' });
      return;
    }
    const why = p.review.rationale ? ` (${p.review.rationale})` : '';
    this.emit({ t: 'notice', code: 'auto_review', message: `auto review ${p.review.status}: ${title}${why}` }, extra);
  }

  /** Add context to the thread without starting a turn (`thread/inject_items`, raw Responses API items). */
  async inject(inputs: InputRecord[]): Promise<void> {
    if (this.closed) throw new Error('codex session is closed');
    const rendered = await renderInputs(inputs, { resolveMedia: this.opts.resolveMedia, preface: this.opts.preface });
    const content = rendered.map((u) =>
      u.type === 'text' ? { type: 'input_text', text: u.text } : u.type === 'image' && 'url' in u ? { type: 'input_image', image_url: u.url } : { type: 'input_text', text: `[${u.type} not injectable]` },
    );
    const params: ThreadInjectItemsParams = { threadId: this.threadId, items: [{ type: 'message', role: 'user', content }] };
    await this.host.rpc.request('thread/inject_items', params);
  }

  // ---- internals ----------------------------------------------------------------

  private onItem(method: 'item/started' | 'item/completed', p: ItemStartedNotification | ItemCompletedNotification): void {
    const t = method === 'item/started' ? this.turnOrForeign(p.turnId) : this.turnFor(p.turnId);
    if (!t) return this.native(method, p);
    const item = p.item;
    if (item.type === 'fileChange') this.fileItems.set(item.id, item.changes.map((c) => c.path));
    const started = method === 'item/started';

    if (item.type === 'userMessage' && item.clientId) {
      const ids = this.clientIds.get(item.clientId) ?? decodeClientId(item.clientId);
      const ours = ids.filter((id) => t.startInputs.includes(id) || t.steerInputs.has(id));
      if (ours.length) {
        if (!started) {
          const fresh = ours.filter((id) => !t.consumed.has(id));
          for (const id of fresh) t.consumed.add(id);
          if (fresh.length) this.saveTurn(t);
          if (fresh.length) this.emit({ t: 'input.consumed', inputIds: fresh, turnId: t.turnId }, { turnId: t.turnId, itemId: item.id, level: 'detail' });
        }
        return;
      }
    }

    const m = summarizeItem(item, this.args.cwd);
    if (!m) return this.native(method, p, t.turnId);
    const extra = { turnId: t.turnId, itemId: item.id, audience: m.audience, level: m.level } satisfies Extra;
    if (started) {
      t.openItems.set(item.id, m.summary);
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
    if (t.gap) {
      // Their item/completed may have been sent while we were disconnected.
      for (const [itemId, item] of t.openItems) {
        this.emit(
          { t: 'item.completed', item: { ...item, status: 'skipped', result: { preview: 'completion not observed (reconnected)', truncated: null, isError: false } } },
          { turnId: t.turnId, itemId, level: 'detail' },
        );
      }
      t.openItems.clear();
    }
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
    if (t.codexTurnId) {
      this.finishedCodexTurns.add(t.codexTurnId);
      if (this.finishedCodexTurns.size > 64) this.finishedCodexTurns.delete(this.finishedCodexTurns.values().next().value!);
    }
    const body: BodyOf<'turn.completed'> = { t: 'turn.completed', turnId: t.turnId, status };
    if (t.usage !== undefined) body.usage = t.usage;
    if (error) body.error = error;
    this.emit(body, { turnId: t.turnId, native });
    if (this.active === t) this.active = undefined;
    for (const [cid, ids] of this.clientIds) if (ids.every((id) => t.startInputs.includes(id) || t.steerInputs.has(id))) this.clientIds.delete(cid);
    t.bind(undefined);
    this.host.saveTurn?.(this.threadId, undefined);
    this.fileItems.clear();
    t.finish();
  }

  private saveTurn(t: Turn): void {
    if (!this.host.saveTurn || t.done || !t.codexTurnId) return;
    this.host.saveTurn(this.threadId, {
      turnId: t.turnId,
      codexTurnId: t.codexTurnId,
      run: t.run,
      initiator: t.initiator,
      startInputs: t.startInputs,
      steerInputs: [...t.steerInputs],
      consumed: [...t.consumed],
    });
  }

  private cancelRequest(requestId: string, by: BodyOf<'request.resolved'>['by'] = 'runtime_cancelled'): void {
    const r = this.requests.get(requestId);
    if (!r) return;
    this.requests.delete(requestId);
    this.emit({ t: 'request.resolved', requestId, decision: null, by }, { turnId: this.liveTurnId(r.turnId), audience: 'approval' });
  }

  /** Our active turn for a Codex turn id. Binds an unbound turn (events can precede the turn/start response). */
  private turnFor(codexTurnId: string | null | undefined, bind = true): Turn | undefined {
    const t = this.active;
    if (!t || t.done || !codexTurnId) return undefined;
    if (t.codexTurnId === codexTurnId) return t;
    if (t.codexTurnId === undefined && bind) {
      t.bind(codexTurnId);
      return t;
    }
    return undefined; // a turn some other client started while ours runs
  }

  /**
   * A Codex turn we did not start (another client on the thread, e.g. a TUI, or
   * one already running when we attached): `turn.started{initiator:'foreign'}`
   * with a minted turnId, so its items, approvals and completion map normally.
   */
  private foreignTurn(codexTurnId: string): Turn {
    const t = this.newTurn(`codex:${codexTurnId}`, undefined, [], 'foreign');
    t.bind(codexTurnId);
    this.active = t;
    this.emit(
      { t: 'turn.started', turnId: t.turnId, inputIds: [], replyRoute: null, initiator: 'foreign', nativeTurnId: codexTurnId },
      { turnId: t.turnId },
    );
    return t;
  }

  /** turnFor, or a new foreign turn when nothing of ours is running. */
  private turnOrForeign(codexTurnId: string | null | undefined): Turn | undefined {
    const t = this.turnFor(codexTurnId);
    if (t || !codexTurnId || this.closed) return t;
    if (this.active && !this.active.done) return undefined;
    if (this.finishedCodexTurns.has(codexTurnId)) return undefined; // late event for a turn that already ended
    return this.foreignTurn(codexTurnId);
  }

  private liveTurnId(turnId: string | undefined): string | undefined {
    return turnId && this.active?.turnId === turnId && !this.active.done ? turnId : undefined;
  }

  private newTurn(turnId: string, run: RunSpec | undefined, startInputs: string[], initiator: 'host' | 'foreign' = 'host'): Turn {
    let bindFn!: (id: string | undefined) => void;
    let finishFn!: () => void;
    const bound = new Promise<string | undefined>((r) => (bindFn = r));
    const finished = new Promise<void>((r) => (finishFn = r));
    const t: Turn = {
      turnId,
      run,
      initiator,
      bound,
      bind: (id) => {
        if (id && !t.codexTurnId) t.codexTurnId = id;
        bindFn(t.codexTurnId);
      },
      startInputs,
      steerInputs: new Set(),
      consumed: new Set(),
      openItems: new Map(),
      itemAudience: new Map(),
      reasoning: new Map(),
      done: false,
      finished,
      finish: finishFn,
    };
    return t;
  }

  /**
   * turn/start overrides persist for later turns, so only send what changed. A
   * profile switch sends every permission field (defaults for what the profile
   * leaves unset), so nothing the previous profile set carries over.
   */
  private overrides(run: RunSpec): Partial<TurnStartParams> {
    const o: Partial<TurnStartParams> = {};
    if (run.model && run.model !== this.applied.model) o.model = run.model;
    if (run.effort && run.effort !== this.applied.effort) o.effort = run.effort;
    if (run.profile !== this.applied.profile) {
      const p = resolveProfile(run.profile, this.opts.profiles);
      o.approvalPolicy = p.approvalPolicy ?? FALLBACK_PROFILE.approvalPolicy!;
      o.approvalsReviewer = p.approvalsReviewer ?? 'user';
      o.sandboxPolicy = sandboxPolicyOf(p) ?? sandboxPolicyOf(FALLBACK_PROFILE)!;
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

function reviewTitle(a: GuardianApprovalReviewAction): string {
  switch (a.type) {
    case 'command':
      return `Run: ${displayCommand(a.command)}`;
    case 'execve':
      return `Run: ${a.argv.join(' ') || a.program}`;
    case 'writeStdin':
      return 'Write to terminal';
    case 'applyPatch':
      return `Apply file changes (${a.files.join(', ')})`;
    case 'networkAccess':
      return `Network access to ${a.host}`;
    case 'mcpToolCall':
      return `${a.server}.${a.toolName}`;
    case 'requestPermissions':
      return a.reason ?? 'Grant additional permissions';
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

