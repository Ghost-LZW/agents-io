import type {
  Body,
  BodyType,
  Decision,
  HarnessEvent,
  HarnessOpenArgs,
  HarnessSession,
  InputRecord,
  ItemSummary,
  RunSpec,
  SteerResult,
} from '@agents-io/protocol';
import type { CanUseTool, EffortLevel, PermissionUpdate, SDKResultMessage } from '@anthropic-ai/claude-agent-sdk';
import { toUserMessage } from './content.js';
import { AsyncQueue } from './queue.js';
import {
  QUESTION_TOOLS,
  inputSummary,
  itemTitle,
  itemType,
  oneLine,
  planSteps,
  preview,
  resultText,
  riskOf,
} from './tools.js';
import type {
  ClaudeCodeOptions,
  ClaudeProfile,
  PermissionResult,
  QueryLike,
  SDKMessage,
  SDKUserMessage,
} from './types.js';

type Status = 'completed' | 'interrupted' | 'failed' | 'ambiguous';
type TurnError = { code: string; retryable: boolean; message?: string };
type Written = { inputId: string; message: SDKUserMessage };

interface ActiveTurn {
  turnId: string;
  run: RunSpec;
  /** uuid → inputId for inputs written to the CLI and not yet seen in `user_message_uuids`. */
  pending: Map<string, string>;
  interrupting: boolean;
  /** Any CLI output since the turn started. */
  sawActivity: boolean;
  /** Set when a CLI result arrived but inputs of this turn are still pending (a follow-up CLI turn will run them). */
  between?: { status: Status; error?: TurnError };
  usage?: unknown;
  finalText?: string;
}

interface OpenRequest {
  requestId: string;
  toolName: string;
  toolUseId: string;
  input: Record<string, unknown>;
  suggestions?: PermissionUpdate[];
  allowAlways: boolean;
  turnId?: string;
  resolve(r: PermissionResult): void;
  promise: Promise<PermissionResult>;
}

const EPHEMERAL = new Set<BodyType>(['text.delta', 'item.progress', 'headline']);
const EFFORTS = new Set<EffortLevel>(['low', 'medium', 'high', 'xhigh', 'max']);
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

export function isEffort(e: string | undefined): e is EffortLevel {
  return e !== undefined && EFFORTS.has(e as EffortLevel);
}

function levelOf(b: Body): HarnessEvent['level'] {
  switch (b.t) {
    case 'native':
      return 'debug';
    case 'item.started':
    case 'item.completed':
    case 'item.progress':
    case 'plan.updated':
    case 'usage':
      return 'detail';
    case 'text.delta':
      return b.stream === 'answer' ? 'primary' : 'detail';
    default:
      return 'primary';
  }
}

function audienceOf(b: Body): HarnessEvent['audience'] {
  switch (b.t) {
    case 'text.delta':
      return b.stream === 'answer' ? 'answer' : 'commentary';
    case 'text.snapshot':
      return 'answer';
    case 'item.started':
    case 'item.completed':
    case 'item.progress':
    case 'plan.updated':
      return 'commentary';
    case 'request.opened':
    case 'request.resolved':
      return 'approval';
    case 'native':
      return 'internal';
    default:
      return 'status';
  }
}

export interface SessionInit {
  args: HarnessOpenArgs;
  options: ClaudeCodeOptions;
  profile: ClaudeProfile;
  /** Native session id known up front (resume id, or the id we asked the CLI to use). */
  sessionId: string;
  prompt: AsyncQueue<SDKUserMessage>;
  stderrTail: () => string;
}

/**
 * One Claude Code session. The CLI is driven through the Agent SDK's streaming input;
 * this class only translates. It never queues: the session layer calls `startTurn`
 * only when idle and `steer` only while a turn runs.
 */
export class ClaudeCodeSession implements HarnessSession {
  private readonly out = new AsyncQueue<HarnessEvent>();
  readonly events: AsyncIterable<HarnessEvent> = this.out;

  private q!: QueryLike;
  private sessionId: string;
  private turn: ActiveTurn | undefined;
  private model: string;
  private effort: string | undefined;
  private profile: ClaudeProfile;
  /** Unconsumed inputs of turns that already ended (interrupted / failed). */
  private stray = new Map<string, string>();
  private items = new Map<string, { item: ItemSummary; parentItemId?: string; turnId?: string }>();
  private requests = new Map<string, OpenRequest>();
  private declined = new Set<string>();
  private msgText: { id: string; text: string } | undefined;
  private unownedActivity = false;
  private closing = false;
  private exited = false;
  private pumpDone: Promise<void> = Promise.resolve();
  private idleWaiters: (() => void)[] = [];

  constructor(private readonly init: SessionInit) {
    this.sessionId = init.sessionId;
    this.model = init.args.run.model;
    this.effort = init.args.run.effort;
    this.profile = init.profile;
  }

  /** Called once by the adapter after `query()` returned. */
  attach(q: QueryLike): void {
    this.q = q;
    this.emit({ t: 'session.bound', nativeId: this.sessionId });
    if (this.effort !== undefined && !isEffort(this.effort))
      this.emit({ t: 'notice', code: 'other', message: `effort "${this.effort}" is not supported by Claude Code; ignored` });
    this.pumpDone = this.pump();
  }

  readonly canUseTool: CanUseTool = (toolName, input, opts) => {
    const existing = this.requests.get(opts.requestId);
    if (existing) return existing.promise; // redelivered after reinitialize: never open a second prompt

    const isQuestion = QUESTION_TOOLS.has(toolName);
    const allowAlways = !isQuestion && !opts.suppressAlwaysAllowRule && (opts.suggestions?.length ?? 0) > 0;
    let resolve!: (r: PermissionResult) => void;
    const promise = new Promise<PermissionResult>((r) => (resolve = r));
    const req: OpenRequest = {
      requestId: opts.requestId,
      toolName,
      toolUseId: opts.toolUseID,
      input,
      suggestions: opts.suggestions,
      allowAlways,
      turnId: this.turn?.turnId,
      resolve,
      promise,
    };
    this.requests.set(req.requestId, req);

    const kind = isQuestion ? 'question' : itemType(toolName) === 'file_change' ? 'file_change' : 'tool_approval';
    const title = isQuestion
      ? `Question: ${inputSummary(toolName, input, 200) ?? toolName}`
      : opts.title
        ? oneLine(opts.title.replace(ANSI, ''), 200)
        : itemTitle(toolName, input);
    const parentItemId = this.items.get(opts.toolUseID)?.parentItemId;
    this.emit(
      {
        t: 'request.opened',
        requestId: req.requestId,
        kind,
        title,
        risk: riskOf(toolName, input, opts.blockedPath),
        allowedDecisions: isQuestion ? ['answer', 'deny'] : ['allow_once', ...(allowAlways ? ['allow_session'] : []), 'deny'],
        allowAlways,
        defaultDeny: opts.defaultToNo === true,
      },
      {
        itemId: opts.toolUseID,
        ...(parentItemId ? { parentItemId } : {}),
        native: {
          toolName,
          input,
          suggestions: opts.suggestions,
          decisionReason: opts.decisionReason?.replace(ANSI, ''),
          blockedPath: opts.blockedPath,
          mcpServer: opts.mcpServer,
          displayName: opts.displayName,
          description: opts.description,
          agentID: opts.agentID,
          suppressAlwaysAllowRule: opts.suppressAlwaysAllowRule,
          defaultToNo: opts.defaultToNo,
        },
      },
    );

    const onAbort = () => this.cancelRequest(req, 'runtime_cancelled');
    if (opts.signal.aborted) onAbort();
    else opts.signal.addEventListener('abort', onAbort, { once: true });
    return promise;
  };

  nativeId(): string | undefined {
    return this.sessionId;
  }

  async startTurn(turnId: string, inputs: InputRecord[], run?: RunSpec): Promise<void> {
    if (this.exited || this.closing) throw new Error('claude-code session is closed');
    if (this.turn) throw new Error(`startTurn(${turnId}) while turn ${this.turn.turnId} is active: the session layer owns the queue`);
    if (!inputs.length) throw new Error('startTurn needs at least one input');
    const r = run ?? this.init.args.run;
    const t: ActiveTurn = { turnId, run: r, pending: new Map(), interrupting: false, sawActivity: false };
    this.turn = t; // claim before any await so a concurrent startTurn fails
    try {
      await this.applyRun(r);
      const msgs = await this.convert(inputs, 'later');
      this.emit({
        t: 'turn.started',
        turnId,
        inputIds: inputs.map((i) => i.inputId),
        replyRoute: inputs[0]?.replyRoute ?? null,
        run: r,
      });
      this.unownedActivity = false;
      this.msgText = undefined;
      this.write(t, msgs);
    } catch (err) {
      if (this.turn === t) this.turn = undefined;
      throw err;
    }
  }

  async steer(inputs: InputRecord[], expectedTurnId: string): Promise<SteerResult> {
    const t = this.turn;
    if (!t) return 'no_active_turn';
    if (t.turnId !== expectedTurnId) return 'stale';
    if (t.interrupting) return 'not_steerable';
    const msgs = await this.convert(inputs, 'next');
    if (this.turn !== t) return this.turn ? 'stale' : 'no_active_turn';
    if (t.interrupting) return 'not_steerable';
    this.write(t, msgs);
    return 'steered';
  }

  async cancelQueued(inputIds: string[]): Promise<void> {
    const want = new Set(inputIds);
    const t = this.turn;
    if (t) {
      const uuids = [...t.pending].filter(([, id]) => want.has(id)).map(([u]) => u);
      await this.cancelPending(t.pending, uuids, 'cancelled', t);
      this.maybeFinishWithoutResult(t);
    }
    const strays = [...this.stray].filter(([, id]) => want.has(id)).map(([u]) => u);
    await this.cancelPending(this.stray, strays, 'cancelled');
  }

  async interrupt(turnId: string): Promise<void> {
    const t = this.turn;
    if (!t || t.turnId !== turnId) return;
    t.interrupting = true;
    const receipt = await this.q.interrupt();
    // Inputs the CLI still holds would run as a fresh turn after the interrupt: withdraw ours.
    const still = (receipt?.still_queued ?? []).filter((u) => t.pending.has(u));
    await this.cancelPending(t.pending, still, 'interrupted', t);
    this.maybeFinishWithoutResult(t);
  }

  async respond(requestId: string, decision: Decision): Promise<void> {
    const req = this.requests.get(requestId);
    if (!req) return; // already answered (first wins) or cancelled by the CLI
    this.requests.delete(requestId);
    const result = this.toPermissionResult(req, decision);
    if (result.behavior === 'deny') this.declined.add(req.toolUseId);
    req.resolve(result);
    this.emit(
      { t: 'request.resolved', requestId, decision, by: { kind: 'host' } },
      req.turnId && this.turn?.turnId === req.turnId ? { turnId: req.turnId } : { turnId: undefined },
    );
  }

  async close(_reason: string): Promise<void> {
    if (this.closing) return this.pumpDone;
    this.closing = true;
    const t = this.turn;
    if (t && !this.exited) {
      await Promise.race([this.interrupt(t.turnId).catch(() => undefined), delay(2000)]);
      await Promise.race([this.whenIdle(), delay(3000)]);
    }
    this.init.prompt.close();
    await Promise.race([this.pumpDone, delay(3000)]);
    try {
      this.q.close();
    } catch {
      // already gone
    }
    await this.pumpDone;
  }

  // ---- internals ----------------------------------------------------------

  private async applyRun(r: RunSpec): Promise<void> {
    if (r.model !== this.model) {
      await this.q.setModel(r.model);
      this.model = r.model;
    }
    if (r.effort !== this.effort) {
      if (r.effort === undefined || isEffort(r.effort)) {
        await this.q.applyFlagSettings({ effortLevel: r.effort ?? null });
      } else {
        this.emit({ t: 'notice', code: 'other', message: `effort "${r.effort}" is not supported by Claude Code; ignored` });
      }
      this.effort = r.effort;
    }
    const want = this.init.options.profiles?.[r.profile] ?? defaultProfile(r.profile);
    if (want === this.profile) return;
    if (!sameTools(want, this.profile)) {
      throw new Error(
        `profile "${r.profile}" changes tool permissions; Claude Code fixes them at launch, reopen the session instead`,
      );
    }
    const mode = want.permissionMode ?? 'default';
    if (mode !== (this.profile.permissionMode ?? 'default')) await this.q.setPermissionMode(mode);
    this.profile = want;
  }

  private async convert(inputs: InputRecord[], priority: 'next' | 'later'): Promise<Written[]> {
    const out: Written[] = [];
    for (const input of inputs) {
      const { message, notices } = await toUserMessage(input, {
        priority,
        resolveImage: this.init.options.resolveImage,
        resolveFile: this.init.options.resolveFile,
        clientComposed: this.init.options.clientComposed,
      });
      for (const n of notices) this.emit({ t: 'notice', code: 'other', message: n });
      out.push({ inputId: input.inputId, message });
    }
    return out;
  }

  private write(t: ActiveTurn, msgs: Written[]): void {
    for (const { inputId, message } of msgs) {
      t.pending.set(message.uuid!, inputId);
      this.init.prompt.push(message);
    }
  }

  private async cancelPending(from: Map<string, string>, uuids: string[], reason: string, t?: ActiveTurn) {
    const fn = this.q.cancelAsyncMessage;
    if (!fn || !uuids.length) return;
    const cancelled: string[] = [];
    for (const u of uuids) {
      try {
        if (await fn.call(this.q, u)) {
          const id = from.get(u);
          from.delete(u);
          if (id) cancelled.push(id);
        }
      } catch {
        // already dequeued: it will be consumed (or swept) by the CLI
      }
    }
    if (cancelled.length) {
      this.emit(
        { t: 'input.cancelled', inputIds: cancelled, reason },
        t && this.turn === t ? { turnId: t.turnId } : { turnId: undefined },
      );
    }
  }

  /** A turn can end without a result when every input was withdrawn before the CLI started it. */
  private maybeFinishWithoutResult(t: ActiveTurn): void {
    if (this.turn !== t || t.pending.size) return;
    if (t.between) this.finish(t, t.interrupting ? 'interrupted' : t.between.status, t.between.error);
    else if (!t.sawActivity) this.finish(t, 'interrupted');
  }

  private async pump(): Promise<void> {
    let failure: unknown;
    try {
      for await (const m of this.q) {
        try {
          this.onMessage(m);
        } catch (err) {
          this.emit({ t: 'notice', code: 'other', message: `claude-code adapter failed to map a message: ${(err as Error).message}` }, { native: m });
        }
      }
    } catch (err) {
      failure = err;
    }
    this.exited = true;
    for (const req of [...this.requests.values()]) this.cancelRequest(req, 'runtime_cancelled');
    const t = this.turn;
    if (t) {
      const tail = this.init.stderrTail();
      const message = [failure ? String((failure as Error).message ?? failure) : 'claude process exited', tail].filter(Boolean).join('\n');
      this.finish(t, 'ambiguous', { code: 'harness_exited', retryable: false, message });
    }
    if (!this.closing) {
      this.emit({ t: 'notice', code: 'other', message: `claude process ended${failure ? `: ${(failure as Error).message}` : ''}` });
    }
    this.out.close();
  }

  private onMessage(m: SDKMessage): void {
    if (m.type !== 'result') this.markActivity(m);
    switch (m.type) {
      case 'stream_event':
        return this.onStreamEvent(m);
      case 'assistant':
        return this.onAssistant(m);
      case 'user':
        return this.onUser(m);
      case 'result':
        return this.onResult(m);
      case 'tool_progress':
        return this.progress(m.tool_use_id, { elapsedMs: Math.round(m.elapsed_time_seconds * 1000) }, m);
      case 'tool_use_summary':
        return this.emit({ t: 'headline', text: oneLine(m.summary, 200) });
      case 'rate_limit_event': {
        const i = m.rate_limit_info;
        if (i.status === 'allowed') return this.native('rate_limit_event', m);
        const when = i.resetsAt ? ` until ${new Date(i.resetsAt * 1000).toISOString()}` : '';
        return this.emit(
          { t: 'notice', code: 'rate_limited', message: `rate limit ${i.status}${i.rateLimitType ? ` (${i.rateLimitType})` : ''}${when}` },
          { native: m },
        );
      }
      case 'system':
        return this.onSystem(m);
      default:
        return this.native(m.type, m);
    }
  }

  private markActivity(m: SDKMessage): void {
    const t = this.turn;
    if (t) {
      t.sawActivity = true;
      // Only real turn output means the CLI picked up the rest of this turn's inputs.
      if (m.type === 'assistant' || m.type === 'stream_event' || m.type === 'user') t.between = undefined;
      return;
    }
    if (m.type === 'system' && (m.subtype === 'init' || m.subtype === 'session_state_changed')) return;
    if (!this.unownedActivity && (m.type === 'assistant' || m.type === 'stream_event')) {
      this.unownedActivity = true;
      this.emit({ t: 'notice', code: 'other', message: 'claude started a turn on its own (e.g. a background task finished)' });
    }
  }

  private onSystem(m: Extract<SDKMessage, { type: 'system' }>): void {
    switch (m.subtype) {
      case 'init':
        if (m.session_id && m.session_id !== this.sessionId) {
          this.sessionId = m.session_id;
          this.emit({ t: 'session.bound', nativeId: m.session_id });
        }
        return this.native('system/init', m);
      case 'api_retry':
        return this.emit(
          {
            t: 'notice',
            code: 'api_retry',
            message: `API ${m.error_status ?? m.error}; retry ${m.attempt}/${m.max_retries} in ${Math.round(m.retry_delay_ms / 1000)}s`,
          },
          { native: m },
        );
      case 'compact_boundary': {
        const c = m.compact_metadata;
        return this.emit(
          {
            t: 'notice',
            code: 'compacting',
            message: `context compacted (${c.trigger}) ${c.pre_tokens}${c.post_tokens !== undefined ? ` → ${c.post_tokens}` : ''} tokens`,
          },
          { native: m },
        );
      }
      case 'status':
        if (m.status === 'compacting') return this.emit({ t: 'notice', code: 'compacting', message: 'compacting context' }, { native: m });
        if (m.compact_result === 'failed')
          return this.emit({ t: 'notice', code: 'other', message: `compaction failed${m.compact_error ? `: ${m.compact_error}` : ''}` }, { native: m });
        return this.native('system/status', m);
      case 'task_started':
        if (m.tool_use_id && this.items.has(m.tool_use_id))
          return this.progress(m.tool_use_id, { text: oneLine(m.description, 200) }, m);
        return this.native('system/task_started', m);
      case 'task_progress':
        if (m.tool_use_id && this.items.has(m.tool_use_id))
          return this.progress(
            m.tool_use_id,
            { text: oneLine(m.summary ?? (m.last_tool_name ? `${m.description} · ${m.last_tool_name}` : m.description), 200), elapsedMs: m.usage.duration_ms },
            m,
          );
        return this.native('system/task_progress', m);
      case 'task_notification':
        if (m.tool_use_id && this.items.has(m.tool_use_id))
          return this.progress(m.tool_use_id, { text: oneLine(`${m.status}: ${m.summary}`, 200) }, m);
        return this.native('system/task_notification', m);
      default:
        return this.native(`system/${m.subtype}`, m);
    }
  }

  private onStreamEvent(m: Extract<SDKMessage, { type: 'stream_event' }>): void {
    const ev = m.event as { type: string; delta?: { type: string; text?: string; thinking?: string } };
    if (ev.type !== 'content_block_delta' || !ev.delta) return;
    const parent = m.parent_tool_use_id ? { parentItemId: m.parent_tool_use_id, level: 'detail' as const } : {};
    if (ev.delta.type === 'text_delta' && ev.delta.text) this.emit({ t: 'text.delta', delta: ev.delta.text, stream: 'answer' }, parent);
    else if (ev.delta.type === 'thinking_delta' && ev.delta.thinking)
      this.emit({ t: 'text.delta', delta: ev.delta.thinking, stream: 'reasoning' }, parent);
  }

  private onAssistant(m: Extract<SDKMessage, { type: 'assistant' }>): void {
    const parentItemId = m.parent_tool_use_id ?? undefined;
    if (m.error) {
      this.emit(
        { t: 'notice', code: m.error === 'rate_limit' ? 'rate_limited' : 'other', message: `assistant error: ${m.error}` },
        { native: m },
      );
    }
    const content = (m.message?.content ?? []) as unknown as { type: string; [k: string]: unknown }[];
    for (const block of content) {
      if (block.type === 'text' && typeof block.text === 'string') {
        if (parentItemId) continue; // subagent text arrives as deltas; it is not this turn's answer
        const id = String(m.message.id ?? m.uuid);
        if (this.msgText?.id !== id) this.msgText = { id, text: '' };
        this.msgText.text = this.msgText.text ? `${this.msgText.text}\n\n${block.text}` : block.text;
        this.emit({ t: 'text.snapshot', text: this.msgText.text, final: false });
      } else if (block.type === 'tool_use' || block.type === 'server_tool_use' || block.type === 'mcp_tool_use') {
        const id = String(block.id);
        const name = String(block.name);
        const item: ItemSummary = {
          itemId: id,
          type: itemType(name),
          title: itemTitle(name, block.input),
          status: 'running',
          ...(inputSummary(name, block.input) ? { inputSummary: inputSummary(name, block.input) } : {}),
        };
        this.items.set(id, { item, ...(parentItemId ? { parentItemId } : {}), turnId: this.turn?.turnId });
        this.emit({ t: 'item.started', item }, { itemId: id, ...(parentItemId ? { parentItemId } : {}) });
        const steps = planSteps(name, block.input);
        if (steps && !parentItemId) this.emit({ t: 'plan.updated', steps });
      } else if (block.type === 'thinking' || block.type === 'redacted_thinking') {
        // streamed as reasoning deltas
      } else if (block.type.endsWith('_tool_result')) {
        this.completeItem(String(block.tool_use_id), block.content, false, m);
      } else {
        this.native(`assistant/${block.type}`, { ...m, message: { ...m.message, content: [block] } });
      }
    }
  }

  private onUser(m: Extract<SDKMessage, { type: 'user' }>): void {
    const content = m.message?.content;
    if (!Array.isArray(content)) return this.native('user', m);
    let mapped = false;
    for (const block of content as unknown as { type: string; [k: string]: unknown }[]) {
      if (block.type === 'tool_result') {
        mapped = true;
        this.completeItem(String(block.tool_use_id), block.content, block.is_error === true, m);
      }
    }
    if (!mapped) this.native('user', m);
  }

  private completeItem(id: string, content: unknown, isError: boolean, m: SDKMessage): void {
    const known = this.items.get(id);
    this.items.delete(id);
    const text = resultText(content);
    const max = this.init.options.previewChars ?? 400;
    const p = preview(text, max);
    const status: ItemSummary['status'] = isError ? (this.declined.has(id) ? 'declined' : 'failed') : 'completed';
    this.declined.delete(id);
    const item: ItemSummary = {
      ...(known?.item ?? { itemId: id, type: 'tool', title: 'tool' }),
      status,
      result: { preview: p.preview, truncated: p.truncated, isError },
    };
    const turnId = known?.turnId;
    const sameTurn = turnId !== undefined && this.turn?.turnId === turnId;
    this.emit(
      { t: 'item.completed', item },
      {
        itemId: id,
        ...(known?.parentItemId ? { parentItemId: known.parentItemId } : {}),
        ...(sameTurn || turnId === undefined ? {} : { turnId: undefined }),
        native: 'tool_use_result' in m ? (m as { tool_use_result?: unknown }).tool_use_result : undefined,
      },
    );
  }

  private progress(itemId: string, p: { text?: string; elapsedMs?: number }, m: SDKMessage): void {
    const known = this.items.get(itemId);
    if (!known) return this.native(m.type === 'system' ? `system/${m.subtype}` : m.type, m);
    this.emit(
      { t: 'item.progress', itemId, ...p },
      { itemId, ...(known.parentItemId ? { parentItemId: known.parentItemId } : {}) },
    );
  }

  private onResult(m: SDKResultMessage): void {
    const t = this.turn;
    const usage = {
      usage: m.usage,
      modelUsage: m.modelUsage,
      totalCostUsd: m.total_cost_usd,
      durationMs: m.duration_ms,
      numTurns: m.num_turns,
    };
    if (!t) {
      this.unownedActivity = false;
      // An unsolicited CLI turn, or one that ran inputs of an already-ended turn.
      const uuids = m.user_message_uuids ?? (m.user_message_uuid ? [m.user_message_uuid] : []);
      const late = uuids.filter((u) => this.stray.has(u)).map((u) => this.stray.get(u)!);
      for (const u of uuids) this.stray.delete(u);
      if (late.length)
        this.emit({ t: 'notice', code: 'other', message: `inputs ${late.join(', ')} ran after their turn ended` }, { native: m });
      this.emit({ t: 'usage', usage });
      return this.native('result', m);
    }

    const uuids = m.user_message_uuids ?? (m.user_message_uuid ? [m.user_message_uuid] : undefined);
    const consumed: string[] = [];
    if (uuids) {
      for (const u of uuids) {
        const id = t.pending.get(u);
        if (id !== undefined) {
          consumed.push(id);
          t.pending.delete(u);
        }
      }
    } else if (m.subtype === 'success') {
      // Older producers: no echo at all. Everything written so far must have been read.
      consumed.push(...t.pending.values());
      t.pending.clear();
    }
    if (consumed.length) this.emit({ t: 'input.consumed', inputIds: consumed, turnId: t.turnId });
    this.emit({ t: 'usage', usage }, { native: m });
    t.usage = usage;

    let status: Status = 'completed';
    let error: TurnError | undefined;
    const aborted = m.terminal_reason === 'aborted_streaming' || m.terminal_reason === 'aborted_tools';
    if (t.interrupting || aborted) status = 'interrupted';
    else if (m.subtype !== 'success') {
      status = 'failed';
      error = { code: m.subtype, retryable: false, message: m.errors.join('\n') || undefined };
    } else if (m.is_error) {
      status = 'failed';
      error = {
        code: m.terminal_reason ?? 'api_error',
        retryable: m.api_error_status === 429 || (m.api_error_status ?? 0) >= 500,
        message: m.result || undefined,
      };
    } else if (m.result) {
      t.finalText = m.result;
    }

    if (status === 'completed' && t.pending.size) {
      // The CLI ran part of this turn's inputs; the rest (a batch member or a steer that
      // missed the fold) run as its next turn, which still belongs to this one.
      t.between = { status };
      if (t.finalText) this.emit({ t: 'text.snapshot', text: t.finalText, final: false });
      return;
    }
    this.finish(t, status, error);
  }

  private finish(t: ActiveTurn, status: Status, error?: TurnError): void {
    if (this.turn !== t) return;
    for (const req of [...this.requests.values()]) if (req.turnId === t.turnId) this.cancelRequest(req, 'runtime_cancelled');
    if (status === 'completed') {
      for (const [id, rec] of this.items) {
        if (rec.turnId !== t.turnId) continue;
        this.items.delete(id);
        this.emit({ t: 'item.completed', item: { ...rec.item, status: 'skipped' } }, { itemId: id });
      }
      const text = t.finalText ?? this.msgText?.text;
      if (text) this.emit({ t: 'text.snapshot', text, final: true });
    }
    this.emit({
      t: 'turn.completed',
      turnId: t.turnId,
      status,
      ...(t.usage !== undefined ? { usage: t.usage } : {}),
      ...(error ? { error } : {}),
    });
    for (const [u, id] of t.pending) this.stray.set(u, id);
    const leftovers = [...t.pending.keys()];
    t.pending.clear();
    this.turn = undefined;
    this.msgText = undefined;
    for (const w of this.idleWaiters.splice(0)) w();
    if (leftovers.length && !this.exited) void this.cancelPending(this.stray, leftovers, `turn ${status}`);
  }

  private cancelRequest(req: OpenRequest, by: 'runtime_cancelled' | 'timeout'): void {
    if (!this.requests.delete(req.requestId)) return;
    req.resolve({ behavior: 'deny', message: 'Permission request was cancelled.' });
    this.emit(
      { t: 'request.resolved', requestId: req.requestId, decision: null, by },
      req.turnId && this.turn?.turnId === req.turnId ? { turnId: req.turnId } : { turnId: undefined },
    );
  }

  private toPermissionResult(req: OpenRequest, d: Decision): PermissionResult {
    switch (d.kind) {
      case 'allow_once':
        return { behavior: 'allow', updatedInput: req.input };
      case 'allow_session': {
        if (!req.allowAlways) return { behavior: 'allow', updatedInput: req.input };
        const updatedPermissions = (d.updatedPermissions as PermissionUpdate[] | undefined) ?? req.suggestions;
        return { behavior: 'allow', updatedInput: req.input, ...(updatedPermissions ? { updatedPermissions } : {}) };
      }
      case 'deny':
        return {
          behavior: 'deny',
          message: d.message ?? 'The user denied this request.',
          ...(d.interruptTurn ? { interrupt: true } : {}),
        };
      case 'answer':
        return { behavior: 'allow', updatedInput: { ...req.input, answers: mapAnswers(req.input, d.answers) } };
      case 'native':
        return d.payload as PermissionResult;
    }
  }

  private native(name: string, raw: unknown): void {
    this.emit({ t: 'native', name }, { native: raw });
  }

  private emit(body: Body, extra: Partial<Omit<HarnessEvent, 'body'>> = {}): void {
    const turnId = 'turnId' in extra ? extra.turnId : this.turn?.turnId;
    const e: HarnessEvent = {
      ts: Date.now(),
      level: extra.level ?? levelOf(body),
      audience: extra.audience ?? audienceOf(body),
      durability: EPHEMERAL.has(body.t) ? 'ephemeral' : 'durable',
      body,
    };
    if (turnId !== undefined) e.turnId = turnId;
    if (extra.itemId !== undefined) e.itemId = extra.itemId;
    if (extra.parentItemId !== undefined) e.parentItemId = extra.parentItemId;
    if (extra.native !== undefined) e.native = extra.native;
    this.out.push(e);
  }

  private whenIdle(): Promise<void> {
    if (!this.turn) return Promise.resolve();
    return new Promise((r) => this.idleWaiters.push(r));
  }
}

export function defaultProfile(name: string): ClaudeProfile {
  return name === 'bypass' ? { permissionMode: 'bypassPermissions' } : { permissionMode: 'default' };
}

function sameTools(a: ClaudeProfile, b: ClaudeProfile): boolean {
  const eq = (x?: string[], y?: string[]) => JSON.stringify(x ?? []) === JSON.stringify(y ?? []);
  return (
    eq(a.allowedTools, b.allowedTools) &&
    eq(a.disallowedTools, b.disallowedTools) &&
    eq(a.additionalDirectories, b.additionalDirectories) &&
    (a.permissionPrompts ?? 'host') === (b.permissionPrompts ?? 'host') &&
    (a.permissionMode === 'bypassPermissions') === (b.permissionMode === 'bypassPermissions')
  );
}

/** Decision answers keyed by question text, header or index → AskUserQuestion `answers` (question text → string). */
export function mapAnswers(
  input: Record<string, unknown>,
  answers: Record<string, string | string[]>,
): Record<string, string> {
  const qs = (Array.isArray(input.questions) ? input.questions : []) as { question?: string; header?: string }[];
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(answers)) {
    const q = qs.find((x) => x.question === k) ?? qs.find((x) => x.header === k) ?? (/^\d+$/.test(k) ? qs[Number(k)] : undefined);
    out[q?.question ?? k] = Array.isArray(v) ? v.join(', ') : v;
  }
  return out;
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms).unref?.());
}

