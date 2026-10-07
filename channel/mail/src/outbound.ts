import { createHash } from 'node:crypto';
import type { RenderedMessage } from '@agents-io/protocol';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const paras = (s: string) =>
  s
    .split(/\n{2,}/)
    .map((p) => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`)
    .join('\n');

/** The bare, lowercase address of a `Name <addr>` or `addr` string. */
export function addressOf(from: string): string {
  return (/<([^>]+)>/.exec(from)?.[1] ?? from).trim().toLowerCase();
}

/** Same operationId (and sending domain) always yields the same Message-ID. */
export function messageIdFor(operationId: string, fromAddress: string): string {
  const domain = fromAddress.split('@')[1]?.replace(/>$/, '') || 'agents-io.invalid';
  const h = createHash('sha256').update(operationId).digest('hex').slice(0, 32);
  return `<${h}@${domain}>`;
}

export function renderText(msg: RenderedMessage): string {
  const parts = [msg.text];
  if (msg.link) parts.push(`${msg.link.label}: ${msg.link.url}`);
  return parts.join('\n\n');
}

export function renderHtml(msg: RenderedMessage): string {
  const out: string[] = [];
  if (msg.sections?.length) {
    for (const s of msg.sections) {
      if (s.kind === 'body') out.push(paras(s.text));
      else if (s.kind === 'details')
        out.push(`<blockquote style="margin:8px 0;padding-left:10px;border-left:3px solid #ccc;color:#555">${paras(s.text)}</blockquote>`);
      else if (s.kind === 'status') out.push(`<p><em>${esc(s.text)}</em></p>`);
      else out.push(`<p style="color:#888;font-size:smaller">${esc(s.text).replace(/\n/g, '<br>')}</p>`);
    }
  } else out.push(paras(msg.text));
  if (msg.link) out.push(`<p><a href="${esc(msg.link.url)}">${esc(msg.link.label)}</a></p>`);
  return out.join('\n');
}

export function replySubject(subject: string): string {
  return /^\s*re:/i.test(subject) ? subject : `Re: ${subject || '(no subject)'}`;
}
