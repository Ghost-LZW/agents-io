import type { BodyOf, ItemSummary, SessionEvent } from '@agents-io/protocol';
import { EventType, type BaseEvent } from '@ag-ui/core';

/*
 * The AG-UI projection (core-slimming G9, north): a session's log as AG-UI events (docs.ag-ui.com,
 * `@ag-ui/core` 1.0), for a run (one POST: the turn that takes the run's input) or for every turn
 * from a seq on (a resume). Pure: the same events give the same output
 * (`packages/testkit/conformance/projections/ag-ui/` pins the table, INVARIANTS PR-4).
 *
 * | agents-io event | AG-UI |
 * |---|---|
 * | (the run's request) / `turn.started` (a resume) | `RUN_STARTED` |
 * | `session.snapshot` | `STATE_SNAPSHOT` (the session's state, attention without request titles) |
 * | `text.delta` (answer) | `TEXT_MESSAGE_START` (first), `TEXT_MESSAGE_CONTENT` |
 * | `text.snapshot` | the rest not streamed yet, `TEXT_MESSAGE_END`; a final answer repeating what was said is not said again |
 * | `text.delta` (reasoning) | `REASONING_START`, `REASONING_MESSAGE_START` (first), `REASONING_MESSAGE_CONTENT`; ended by anything else |
 * | `item.started` (tool-like items) | `TOOL_CALL_START`, `TOOL_CALL_ARGS` (`{ title, input }`), `TOOL_CALL_END` |
 * | `item.completed` | `TOOL_CALL_RESULT` (its preview, else its status) |
 * | `plan.updated` | `ACTIVITY_SNAPSHOT` (`PLAN`) |
 * | `request.opened` / `request.resolved` | `CUSTOM` `agents-io.request.opened` / `agents-io.request.resolved` |
 * | `turn.completed` | `RUN_FINISHED` (completed: `success`; interrupted: `cancelled`), else `RUN_ERROR` (`code`: the turn's error code) |
 * | `input.rejected` / `input.cancelled` of the run's input | `RUN_ERROR` / `RUN_FINISHED` (`cancelled`) |
 */

/** One AG-UI event as the projection writes it (plain JSON; `@ag-ui/core`'s `EventSchema` checks it). */
export type AgUiEvent = BaseEvent & { type: EventType };

const NOT_TOOLS = new Set<ItemSummary['type']>(['agent_message', 'user_message', 'reasoning']);

const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

/** What a run's `STATE_SNAPSHOT` says of the session (from its snapshot): what it is doing, what waits (no request titles: U20). */
export function sessionState(snapshot: unknown): Record<string, unknown> {
  const s = (snapshot ?? {}) as { sessionKey?: string; seq?: number; state?: string; turn?: { turnId: string } | null; queued?: string[]; attention?: { state: string; reasons: { kind: string; [k: string]: unknown }[]; since?: number; seq?: number } };
  const attention = s.attention ? { state: s.attention.state, reasons: s.attention.reasons.map(({ title: _t, ...r }) => r) } : undefined;
  return {
    sessionKey: s.sessionKey,
    seq: s.seq ?? 0,
    state: s.state ?? 'idle',
    ...(s.turn ? { turnId: s.turn.turnId } : {}),
    queued: s.queued?.length ?? 0,
    ...(attention ? { attention } : {}),
  };
}

interface Run {
  runId: string;
  turnId?: string;
  /** The text message being streamed. */
  text?: { id: string; streamed: string };
  /** The reasoning message being streamed. */
  reasoning?: string;
  said: string[];
  n: number;
  /** Tool calls started (their result still to come). */
  calls: Set<string>;
}

/**
 * The AG-UI events of a session for a thread. With `runId`: one run, the turn that takes `inputId`
 * (`begin` gives its `RUN_STARTED`; it is finished once that turn ends, or the input is refused).
 * Without: every turn is a run of its own (`runId` its turn id), from `turn.started` to
 * `turn.completed`. `push` each event of the session's log, in order (live ephemeral ones too).
 */
export class AgUiProjection {
  private run: Run | undefined;
  /** The one run's input (with `runId`). */
  private readonly inputId: string | undefined;
  finished = false;

  constructor(private readonly o: { threadId: string; runId?: string; inputId?: string }) {
    this.inputId = o.inputId;
    if (o.runId !== undefined) this.run = { runId: o.runId, said: [], n: 0, calls: new Set() };
  }

  /** The run's start (with `runId`). */
  begin(): AgUiEvent[] {
    if (!this.run) return [];
    return [{ type: EventType.RUN_STARTED, threadId: this.o.threadId, runId: this.run.runId }];
  }

  push(e: SessionEvent): AgUiEvent[] {
    if (this.finished) return [];
    const b = e.body;
    if (b.t === 'session.snapshot') return [{ type: EventType.STATE_SNAPSHOT, snapshot: sessionState(b.snapshot) }];
    const one = this.o.runId !== undefined;
    if (b.t === 'turn.started' || b.t === 'turn.adopted') {
      if (one) {
        if (this.run && this.run.turnId === undefined && this.inputId !== undefined && b.inputIds.includes(this.inputId)) this.run.turnId = b.turnId;
        return [];
      }
      this.run = { runId: b.turnId, turnId: b.turnId, said: [], n: 0, calls: new Set() };
      return [{ type: EventType.RUN_STARTED, threadId: this.o.threadId, runId: b.turnId }];
    }
    if (one && (b.t === 'input.rejected' || b.t === 'input.cancelled') && this.inputId !== undefined && b.inputIds.includes(this.inputId) && this.run?.turnId === undefined) {
      this.finished = true;
      if (b.t === 'input.cancelled') return [{ type: EventType.RUN_FINISHED, threadId: this.o.threadId, runId: this.run!.runId, outcome: { type: 'cancelled' } }];
      return [{ type: EventType.RUN_ERROR, message: `the session did not take the input: ${b.reason}`, code: 'rejected' }];
    }
    const r = this.run;
    const turnId = e.turnId ?? r?.turnId;
    if (!r || r.turnId === undefined || turnId !== r.turnId) return [];
    switch (b.t) {
      case 'text.delta': {
        if (!b.delta) return [];
        if (b.stream === 'reasoning') {
          const out = this.endText(r);
          if (r.reasoning === undefined) {
            r.reasoning = `${r.turnId}:r${++r.n}`;
            out.push({ type: EventType.REASONING_START, messageId: r.reasoning }, { type: EventType.REASONING_MESSAGE_START, messageId: r.reasoning, role: 'reasoning' });
          }
          out.push({ type: EventType.REASONING_MESSAGE_CONTENT, messageId: r.reasoning, delta: b.delta });
          return out;
        }
        if (b.stream !== 'answer') return [];
        const out = this.endReasoning(r);
        if (!r.text) {
          r.text = { id: `${r.turnId}:${++r.n}`, streamed: '' };
          out.push({ type: EventType.TEXT_MESSAGE_START, messageId: r.text.id, role: 'assistant' });
        }
        r.text.streamed += b.delta;
        out.push({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: r.text.id, delta: b.delta });
        return out;
      }
      case 'text.snapshot': {
        const out = this.endReasoning(r);
        const text = b.text;
        const open = r.text;
        if (open && text.startsWith(open.streamed)) {
          const rest = text.slice(open.streamed.length);
          if (rest) out.push({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: open.id, delta: rest });
          out.push({ type: EventType.TEXT_MESSAGE_END, messageId: open.id });
          r.text = undefined;
          r.said.push(text);
          return out;
        }
        out.push(...this.endText(r));
        if (!norm(text)) return out;
        if (!open && r.said.length && (norm(text) === norm(r.said.at(-1)!) || norm(text) === norm(r.said.join(' ')))) return out;
        const id = `${r.turnId}:${++r.n}`;
        out.push({ type: EventType.TEXT_MESSAGE_START, messageId: id, role: 'assistant' }, { type: EventType.TEXT_MESSAGE_CONTENT, messageId: id, delta: text }, { type: EventType.TEXT_MESSAGE_END, messageId: id });
        r.said.push(text);
        return out;
      }
      case 'item.started':
      case 'item.completed': {
        const item = b.item;
        if (NOT_TOOLS.has(item.type)) return [];
        const out = [...this.endReasoning(r), ...this.endText(r)];
        if (!r.calls.has(item.itemId)) {
          r.calls.add(item.itemId);
          const args = JSON.stringify({ title: item.title, ...(item.inputSummary ? { input: item.inputSummary } : {}) });
          out.push(
            { type: EventType.TOOL_CALL_START, toolCallId: item.itemId, toolCallName: item.tool ? `${item.tool.server}.${item.tool.name}` : item.type },
            { type: EventType.TOOL_CALL_ARGS, toolCallId: item.itemId, delta: args },
            { type: EventType.TOOL_CALL_END, toolCallId: item.itemId },
          );
        }
        if (b.t === 'item.completed') {
          r.calls.delete(item.itemId);
          out.push({ type: EventType.TOOL_CALL_RESULT, messageId: `${item.itemId}:result`, toolCallId: item.itemId, content: item.result?.preview || item.status, role: 'tool' });
        }
        return out;
      }
      case 'plan.updated':
        return [{ type: EventType.ACTIVITY_SNAPSHOT, messageId: `${r.turnId}:plan`, activityType: 'PLAN', content: { steps: b.steps }, replace: true }];
      case 'request.opened':
        return [{ type: EventType.CUSTOM, name: 'agents-io.request.opened', value: { requestId: b.requestId, kind: b.kind, title: b.title } }];
      case 'request.resolved':
        return [{ type: EventType.CUSTOM, name: 'agents-io.request.resolved', value: { requestId: b.requestId, decision: b.decision?.kind ?? null } }];
      case 'turn.completed':
        return this.end(r, b);
      default:
        return [];
    }
  }

  private endText(r: Run): AgUiEvent[] {
    const t = r.text;
    if (!t) return [];
    r.text = undefined;
    r.said.push(t.streamed);
    return [{ type: EventType.TEXT_MESSAGE_END, messageId: t.id }];
  }

  private endReasoning(r: Run): AgUiEvent[] {
    const id = r.reasoning;
    if (id === undefined) return [];
    r.reasoning = undefined;
    return [
      { type: EventType.REASONING_MESSAGE_END, messageId: id },
      { type: EventType.REASONING_END, messageId: id },
    ];
  }

  private end(r: Run, b: BodyOf<'turn.completed'>): AgUiEvent[] {
    const out = [...this.endReasoning(r), ...this.endText(r)];
    if (this.o.runId !== undefined) this.finished = true;
    this.run = this.o.runId !== undefined ? r : undefined;
    if (b.status === 'completed') out.push({ type: EventType.RUN_FINISHED, threadId: this.o.threadId, runId: r.runId, outcome: { type: 'success' } });
    else if (b.status === 'interrupted') out.push({ type: EventType.RUN_FINISHED, threadId: this.o.threadId, runId: r.runId, outcome: { type: 'cancelled' } });
    else out.push({ type: EventType.RUN_ERROR, message: b.error?.message ?? `the turn ended ${b.status}`, code: b.error?.code ?? b.status });
    return out;
  }
}
