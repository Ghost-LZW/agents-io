import type { ProgressStep, ProgressView, ReplyRoute } from '@agents-io/protocol';
import { LarkApiError, call } from './cardkit.js';
import { labels, type Locale } from './process-card.js';
import type { LarkClientLike } from './types.js';

/**
 * Feishu's native thinking bubble (`im.v1 message_cot`, the same UI Feishu's own AI uses),
 * driven by AG-UI events: RUN_STARTED, REASONING_* for thinking and narration, TOOL_CALL_* for
 * tool calls, RUN_FINISHED to settle it (which completes the bubble server side). The SDK
 * has no method for it, so it goes through `client.request`. Clients older than PC 7.70 /
 * mobile 7.74 render a plain fallback.
 *
 * Strictly cosmetic: nothing here throws to the caller. One request in flight per bubble,
 * latest view wins; the first failure turns the bubble off for the rest of the turn (and
 * closes it with the explicit complete endpoint if it already exists).
 */

const COT_URL = '/open-apis/im/v1/message_cot';
const MAX_EVENTS_PER_PUT = 50;
const MAX_DELTA = 8000;
const MAX_RESULT = 4000;
const MAX_TITLE = 100;

interface CotEvent {
  event_type: string;
  content: string;
  timestamp: number;
}

export interface CotOptions {
  client: LarkClientLike;
  route: ReplyRoute;
  turnId: string;
  locale: Locale;
  timeoutMs: number;
  now: () => number;
  log: (msg: string) => void;
  /** Called once when creating the bubble failed (the adapter remembers it per chat/app). */
  onCreateFailed: (err: LarkApiError) => void;
}

const ICONS: Record<Extract<ProgressStep, { kind: 'tool' }>['type'], string> = {
  command: 'bash',
  file_change: 'write',
  web_search: 'search',
  subagent: 'task',
  mcp_tool: 'default',
  tool: 'default',
  hook: 'default',
  compaction: 'default',
  user_message: 'default',
  agent_message: 'default',
  reasoning: 'default',
};

function toolIcon(s: Extract<ProgressStep, { kind: 'tool' }>): string {
  if (s.type === 'tool' || s.type === 'mcp_tool') {
    const t = s.title.toLowerCase();
    if (/^(read|notebookread)\b/.test(t)) return 'read';
    if (/^(grep|glob|search|websearch|webfetch|fetch)\b/.test(t)) return 'search';
    if (/^(todowrite|task)\b/.test(t)) return 'task';
  }
  return ICONS[s.type] ?? 'default';
}

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();
const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

export class CotBubble {
  private cotId: string | undefined;
  private messageId: string | undefined;
  private state: 'idle' | 'live' | 'failed' | 'settled' = 'idle';
  private pending: ProgressView | undefined;
  private final: ProgressView | undefined;
  private pumping: Promise<void> | undefined;
  /** Per reasoning/narration step: text already sent, and whether its message was ended. */
  private readonly texts = new Map<string, { sent: string; ended: boolean; mid: string }>();
  private readonly tools = new Map<string, { resulted: boolean }>();
  private lastReasoning: string | undefined;
  private firstMidUsed = false;

  constructor(private readonly o: CotOptions) {}

  /** True once the bubble failed for this turn (the card then shows the process itself, in `auto`). */
  get failed(): boolean {
    return this.state === 'failed';
  }

  get created(): boolean {
    return this.cotId !== undefined;
  }

  /** Feed the latest cumulative view. Never throws, never waits. */
  push(p: ProgressView): void {
    if (this.state === 'failed' || this.state === 'settled' || this.final) return;
    this.pending = p;
    this.kick();
  }

  /** Settle the bubble with the final view. Resolves once settled or failed; never rejects. */
  finish(p: ProgressView): Promise<void> {
    if (this.state === 'failed' || this.state === 'settled') return Promise.resolve();
    this.final = p;
    this.pending = p;
    this.kick();
    return this.idle();
  }

  /** Resolves when nothing is in flight. */
  async idle(): Promise<void> {
    while (this.pumping) await this.pumping;
  }

  private kick(): void {
    if (this.pumping) return;
    this.pumping = this.pump().finally(() => {
      this.pumping = undefined;
      if (this.pending && this.state !== 'failed' && this.state !== 'settled') this.kick();
    });
  }

  private ev(type: string, content: unknown): CotEvent {
    return { event_type: type, content: JSON.stringify(content), timestamp: this.o.now() };
  }

  private async pump(): Promise<void> {
    try {
      while (this.pending && this.state !== 'failed' && this.state !== 'settled') {
        const p = this.pending;
        this.pending = undefined;
        const final = this.final !== undefined && p === this.final;
        if (!this.cotId) {
          // Only open a bubble once there is a process to show.
          if (!p.steps.length) {
            if (final) this.state = 'settled';
            continue;
          }
          await this.create();
          await this.put([this.ev('RUN_STARTED', { threadId: this.o.route.conversationId, runId: this.o.turnId }), this.ev('REASONING_START', { messageId: this.firstMid() })]);
        }
        const events = this.diff(p, final);
        if (final) {
          events.push(this.ev('REASONING_END', { messageId: this.lastReasoning ?? this.firstMid() }));
          events.push(this.ev('RUN_FINISHED', { threadId: this.o.route.conversationId, runId: this.o.turnId, status: p.status === 'completed' ? 'done' : 'interrupted' }));
        }
        await this.put(events);
        if (final) this.state = 'settled';
      }
    } catch (err) {
      const e = err instanceof LarkApiError ? err : new LarkApiError('message_cot', undefined, String(err));
      const wasCreated = this.cotId !== undefined;
      this.state = 'failed';
      this.o.log(`thinking bubble off for turn ${this.o.turnId}: ${e.message}`);
      if (!wasCreated) this.o.onCreateFailed(e);
      else await this.complete('error').catch(() => undefined);
    }
  }

  private firstMid(): string {
    return 'rs0';
  }

  private async create(): Promise<void> {
    const r = this.o.route;
    // Anchor to the triggering message; inside a thread the bubble needs reply_in_thread to land in it.
    const anchor = r.replyToMessageId?.startsWith('om_') ? r.replyToMessageId : undefined;
    const res = (await call('message_cot.create', this.o.timeoutMs, async () =>
      (await this.o.client.request({
        method: 'POST',
        url: COT_URL,
        params: { receive_id_type: 'chat_id' },
        data: { receive_id: r.conversationId, ...(anchor ? { origin_message_id: anchor, ...(r.threadId ? { reply_in_thread: true } : {}) } : {}) },
        timeout: this.o.timeoutMs,
      })) as { code?: number; msg?: string; data?: { cot_id?: string; message_id?: string } },
    )) as { data?: { cot_id?: string; message_id?: string } };
    const cotId = res.data?.cot_id;
    const messageId = res.data?.message_id;
    if (!cotId || !messageId) throw new LarkApiError('message_cot.create', undefined, 'no cot_id/message_id returned');
    this.cotId = cotId;
    this.messageId = messageId;
    this.state = 'live';
  }

  private async put(events: CotEvent[]): Promise<void> {
    for (let i = 0; i < events.length; i += MAX_EVENTS_PER_PUT) {
      const batch = events.slice(i, i + MAX_EVENTS_PER_PUT);
      await call('message_cot.append', this.o.timeoutMs, async () =>
        (await this.o.client.request({
          method: 'PUT',
          url: COT_URL,
          data: { cot_id: this.cotId, message_id: this.messageId, events: batch },
          timeout: this.o.timeoutMs,
        })) as { code?: number; msg?: string },
      );
    }
  }

  private complete(reason: 'done' | 'error'): Promise<unknown> {
    if (!this.cotId) return Promise.resolve();
    return call('message_cot.complete', this.o.timeoutMs, async () =>
      (await this.o.client.request({
        method: 'POST',
        url: `${COT_URL}/complete/${encodeURIComponent(this.cotId!)}`,
        params: { message_id: this.messageId, reason },
        timeout: this.o.timeoutMs,
      })) as { code?: number; msg?: string },
    );
  }

  /** Events for what changed since the last push. Steps are cumulative and may grow in place. */
  private diff(p: ProgressView, final: boolean): CotEvent[] {
    const out: CotEvent[] = [];
    const t = labels(this.o.locale);
    p.steps.forEach((s, i) => {
      const later = i < p.steps.length - 1;
      if (s.kind === 'reasoning' || s.kind === 'narration') {
        let st = this.texts.get(s.id);
        if (st?.ended) return;
        const text = s.text;
        if (!st) {
          if (!text.trim()) return;
          const mid = this.firstMidUsed ? `rs-${s.id}` : this.firstMid();
          this.firstMidUsed = true;
          st = { sent: '', ended: false, mid };
          this.texts.set(s.id, st);
          out.push(this.ev('REASONING_MESSAGE_START', { messageId: mid, role: 'reasoning' }));
        }
        // Append-only: a rewritten block (not an extension of what was sent) keeps what was sent.
        if (text.length > st.sent.length && text.startsWith(st.sent)) {
          const delta = text.slice(st.sent.length);
          for (let k = 0; k < delta.length; k += MAX_DELTA) out.push(this.ev('REASONING_MESSAGE_CONTENT', { messageId: st.mid, delta: delta.slice(k, k + MAX_DELTA) }));
          st.sent = text;
        }
        this.lastReasoning = st.mid;
        const closed = (s.kind === 'reasoning' ? s.done : false) || later || final;
        if (closed) {
          out.push(this.ev('REASONING_MESSAGE_END', { messageId: st.mid }));
          st.ended = true;
        }
        return;
      }
      let st = this.tools.get(s.itemId);
      if (!st) {
        if (!this.lastReasoning) {
          // Tool nodes hang under a reasoning node; a turn that starts with a tool gets a placeholder.
          const mid = this.firstMid();
          this.firstMidUsed = true;
          out.push(
            this.ev('REASONING_MESSAGE_START', { messageId: mid, role: 'reasoning' }),
            this.ev('REASONING_MESSAGE_CONTENT', { messageId: mid, delta: t.cotThinking }),
            this.ev('REASONING_MESSAGE_END', { messageId: mid }),
          );
          this.lastReasoning = mid;
        }
        // The client draws the title, not TOOL_CALL_ARGS, so the subject goes into the title.
        const title = clip(oneLine(`${s.parentItemId ? '↳ ' : ''}${s.title}`), MAX_TITLE);
        out.push(
          this.ev('TOOL_CALL_START', { toolCallId: s.itemId, icon: toolIcon(s), title, toolCallName: s.type, parentMessageId: this.lastReasoning }),
          ...(s.inputSummary ? [this.ev('TOOL_CALL_ARGS', { toolCallId: s.itemId, delta: s.inputSummary })] : []),
          this.ev('TOOL_CALL_END', { toolCallId: s.itemId }),
        );
        st = { resulted: false };
        this.tools.set(s.itemId, st);
      }
      // A result settles the node; without one it would spin, so a finished turn settles all of them.
      if (!st.resulted && (s.status !== 'running' || final)) {
        const preview = s.resultPreview?.trim();
        const failed = s.status === 'failed' || s.status === 'declined' || s.isError === true;
        const content = preview
          ? { type: 'code', ...(s.type === 'command' ? { language: 'bash' } : {}), code: clip(preview, MAX_RESULT) }
          : { type: 'text', text: failed ? t.cotFailed : t.cotDone };
        out.push(this.ev('TOOL_CALL_RESULT', { messageId: `tr-${s.itemId}`, toolCallId: s.itemId, role: 'tool', content: JSON.stringify(content) }));
        st.resulted = true;
      }
    });
    return out;
  }
}
