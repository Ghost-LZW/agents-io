import type { SessionEvent, Tier } from '@agents-io/protocol';
import { isSnapshotEvent } from '@agents-io/session';

interface OutputLike {
  tool: string;
  route: { channel: string; conversationId: string };
  msg: { text: string; attachments?: { name?: string; mime: string; ref: string }[] };
  choice?: { choiceId: string; question: string; options: string[]; multi: boolean };
}

const oneLine = (s: string, max = 120) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
};
const short = (id: string) => (id.length > 14 ? id.slice(0, 13) + '…' : id);

/**
 * Turns a session event stream into terminal text: answer deltas inline, one line
 * per tool item, plan, request (with the id to /approve), and turn boundaries.
 * Stateful only to know whether a text line is open.
 */
export class EventRenderer {
  /** Answer text is streaming on the current line. */
  private inText = false;
  /** Turns whose answer arrived as deltas (so the final snapshot is not printed again). */
  private streamed = new Set<string>();

  constructor(private readonly o: { color?: boolean; verbose?: boolean; tier?: Tier } = {}) {}

  private paint(code: string, s: string): string {
    return this.o.color ? `\x1b[${code}m${s}\x1b[0m` : s;
  }

  private line(s: string): string {
    const pre = this.inText ? '\n' : '';
    this.inText = false;
    return `${pre}${s}\n`;
  }

  render(e: SessionEvent): string {
    if (isSnapshotEvent(e)) {
      const s = e.native;
      const parts = [`session ${s.sessionKey} @${s.seq}: ${s.state}`];
      if (s.turn) parts.push(`turn ${short(s.turn.turnId)}`);
      if (s.queued.length) parts.push(`${s.queued.length} queued`);
      let out = this.line(this.paint('2', `── ${parts.join(', ')}`));
      if (s.partialText) out += this.line(s.partialText);
      for (const r of s.pendingRequests) out += this.line(this.request(r.requestId, r.title, r.allowedDecisions));
      return out;
    }
    const b = e.body;
    switch (b.t) {
      case 'text.delta':
        if (b.stream !== 'answer') return '';
        if (e.turnId) this.streamed.add(e.turnId);
        this.inText = true;
        return b.delta;
      case 'text.snapshot':
        if (!b.final || e.audience !== 'answer' || (e.turnId && this.streamed.has(e.turnId))) return '';
        return this.line(b.text);
      case 'turn.started': {
        const run = b.run ? ` ${b.run.harness}/${b.run.model || 'default'} ${b.run.profile}` : '';
        return this.line(this.paint('36', `── turn ${short(b.turnId)} started (${b.inputIds.length} input${b.inputIds.length === 1 ? '' : 's'}${b.owner ? `, ${b.owner}` : ''})${run}`));
      }
      case 'turn.adopted':
        return this.line(this.paint('36', `── turn ${short(b.turnId)} adopted after restart (events in the gap were not seen)`));
      case 'turn.completed': {
        const color = b.status === 'completed' ? '32' : b.status === 'interrupted' ? '33' : '31';
        const err = b.error ? ` (${b.error.code}${b.error.message ? `: ${oneLine(b.error.message, 80)}` : ''})` : '';
        return this.line(this.paint(color, `── turn ${short(b.turnId)} ${b.status}${err}`));
      }
      case 'turn.delivery_added':
        return this.line(this.paint('2', `   + also delivering to ${b.route.channel}:${b.route.conversationId} (${b.reason})`));
      case 'item.started':
        return this.line(this.paint('34', `   ▶ ${b.item.type}: ${oneLine(b.item.title)}`));
      case 'item.completed': {
        const ok = b.item.status === 'completed';
        const preview = b.item.result?.preview ? `  → ${oneLine(b.item.result.preview, 80)}` : '';
        return this.line(this.paint(ok ? '34' : '31', `   ${ok ? '✓' : '✗'} ${oneLine(b.item.title, 80)} [${b.item.status}]${preview}`));
      }
      case 'plan.updated': {
        const mark = { pending: '○', in_progress: '◐', completed: '●' } as const;
        return this.line(b.steps.map((s) => `   ${mark[s.status]} ${s.text}`).join('\n'));
      }
      case 'request.opened':
        if (b.resolver && b.resolver.kind !== 'human' && b.resolver.kind !== 'host' && !this.o.verbose) return '';
        return this.line(this.paint('1;33', this.request(b.requestId, b.title, b.allowedDecisions, b.inputPreview)));
      case 'request.resolved': {
        const by = typeof b.by === 'string' ? b.by : `${b.by.kind}${b.by.id ? ` ${b.by.id}` : ''}`;
        return this.line(this.paint('33', `   · request ${b.requestId} → ${b.decision?.kind ?? 'none'} (by ${by})`));
      }
      case 'input.admitted':
        return this.line(this.paint('2', `   · input ${short(b.inputId)} ${b.disposition}${b.principalId ? ` from ${b.principalId}` : ''}`));
      case 'input.rejected':
      case 'input.cancelled':
        return this.line(this.paint('31', `   · input ${b.inputIds.map(short).join(', ')} ${b.t === 'input.rejected' ? 'rejected' : 'cancelled'}: ${b.reason}`));
      case 'notice':
        return this.line(this.paint('33', `   ! ${b.code}: ${oneLine(b.message)}`));
      case 'headline':
        return this.o.verbose || this.o.tier === 'headline' ? this.line(this.paint('2', `   … ${oneLine(b.text)}`)) : '';
      case 'native':
        if (b.name === 'agents-io.output') return this.line(this.paint('1;35', this.output(e.native as OutputLike)));
        return this.o.verbose ? this.line(this.paint('2', `   native ${b.name}`)) : '';
      case 'session.state':
        return this.o.verbose ? this.line(this.paint('2', `   [${b.state}]`)) : '';
      default:
        return this.o.verbose ? this.line(this.paint('2', `   ${b.t}`)) : '';
    }
  }

  /** A message an agent sent with an output tool (send_file, ask_choice, mention, …). */
  private output(r: OutputLike): string {
    if (!r?.msg) return '   ✉ (output)';
    const where = `${r.route.channel}:${r.route.conversationId}`;
    const lines: string[] = [];
    if (r.choice) {
      lines.push(`   ? ${r.choice.question}  [${r.tool} → ${where}]`);
      r.choice.options.forEach((o, i) => lines.push(`     ${i + 1}. ${o}`));
      lines.push(`     answer: /choose ${r.choice.choiceId} <n>${r.choice.multi ? '[,<n>…]' : ''}`);
      return lines.join('\n');
    }
    for (const a of r.msg.attachments ?? []) lines.push(`   📎 ${a.name ?? 'file'} (${a.mime}, ${a.ref})  [${r.tool} → ${where}]`);
    if (r.msg.text) lines.push(`   ✉ ${r.msg.text}${r.msg.attachments?.length ? '' : `  [${r.tool} → ${where}]`}`);
    return lines.join('\n') || `   ✉ (empty ${r.tool})`;
  }

  private request(id: string, title: string, allowed: string[], preview?: string): string {
    const how = [allowed.includes('allow_once') || !allowed.length ? `/approve ${id}` : '', allowed.includes('deny') || !allowed.length ? `/deny ${id}` : ''].filter(Boolean).join(' | ');
    return `   ? request ${id}: ${oneLine(title)}${preview ? ` — ${oneLine(preview, 80)}` : ''}  [${how}]`;
  }
}
