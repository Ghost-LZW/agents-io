import { createHash } from 'node:crypto';
import type { RenderedMessage } from '@agents-io/protocol';

export interface OutMessage {
  msg_type: 'text' | 'post' | 'interactive' | 'image' | 'file' | 'audio';
  content: string;
}

/** Lark `uuid` request param: at most 50 chars, dedups for one hour. Stable per (account, operationId, part). */
export function uuidFor(account: string, operationId: string, part = 0): string {
  return createHash('sha256').update(`${account}\0${operationId}\0${part}`).digest('hex').slice(0, 50);
}

/** Split on paragraph, then line, then hard boundaries so every chunk is <= max chars. */
export function splitText(text: string, max: number): string[] {
  if (max <= 0 || text.length <= max) return [text];
  const out: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n\n', max);
    if (cut < max / 2) cut = rest.lastIndexOf('\n', max);
    if (cut < max / 2) cut = rest.lastIndexOf(' ', max);
    if (cut < max / 2) cut = max;
    out.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).replace(/^\s+/, '');
  }
  if (rest) out.push(rest);
  return out;
}

const MD_HINT = /(^|\n)\s*(#{1,6}\s|[-*]\s|\d+\.\s|>\s|```)|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\)|`[^`]+`/;

export function looksLikeMarkdown(text: string): boolean {
  return MD_HINT.test(text);
}

/** True when the message needs interactive-card structure rather than plain text. */
export function needsCard(msg: RenderedMessage): boolean {
  return !!(msg.sections?.length || msg.actions?.length || msg.link);
}

/** `channelData` is honoured only when it looks like a Lark card (schema 2.0 or legacy). */
export function isLarkCard(v: unknown): v is Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const o = v as Record<string, any>;
  return (
    o.schema === '2.0' ||
    (o.type === 'template' && typeof o.data === 'object') ||
    Array.isArray(o.elements) ||
    Array.isArray(o.body?.elements) ||
    (typeof o.header === 'object' && o.header !== null && typeof o.config === 'object')
  );
}

const md = (content: string, extra: Record<string, unknown> = {}) => ({ tag: 'markdown', content, ...extra });

/** Card JSON 2.0. `text` replaces `msg.text` (used for splitting/truncation). */
export function buildCard(msg: RenderedMessage, text: string = msg.text): Record<string, unknown> {
  const elements: unknown[] = [];
  const sections = msg.sections ?? [];
  if (!sections.some((s) => s.kind === 'body') && text) elements.push(md(text));
  for (const s of sections) {
    switch (s.kind) {
      case 'body':
        elements.push(md(s.text));
        break;
      case 'details':
        elements.push({
          tag: 'collapsible_panel',
          expanded: !(s.collapsed ?? true),
          header: { title: { tag: 'plain_text', content: 'Details' } },
          elements: [md(s.text)],
        });
        break;
      case 'status':
        elements.push(md(s.text, { text_size: 'notation' }));
        break;
      case 'footer':
        elements.push({ tag: 'hr' }, md(s.text, { text_size: 'notation' }));
        break;
    }
  }
  for (const a of msg.actions ?? []) {
    elements.push({
      tag: 'button',
      text: { tag: 'plain_text', content: a.label },
      type: a.style ?? 'default',
      behaviors: [{ type: 'callback', value: { actionId: a.id } }],
    });
  }
  if (msg.link) {
    elements.push({
      tag: 'button',
      text: { tag: 'plain_text', content: msg.link.label },
      type: 'default',
      behaviors: [{ type: 'open_url', default_url: msg.link.url }],
    });
  }
  return {
    schema: '2.0',
    config: { update_multi: true, summary: { content: (msg.text || msg.link?.label || '').slice(0, 80) } },
    body: { elements },
  };
}

/** Shrink all text until the serialised card fits `maxBytes` (a card over the platform limit is rejected outright). */
export function fitCard(msg: RenderedMessage, text: string, maxBytes: number): Record<string, unknown> {
  let factor = 1;
  const shrink = (t: string) => (factor === 1 || t.length <= 16 ? t : `${t.slice(0, Math.floor(t.length * factor))}…`);
  let card = buildCard(msg, text);
  while (Buffer.byteLength(JSON.stringify(card)) > maxBytes && factor > 0.01) {
    factor *= 0.8;
    const m: RenderedMessage = {
      ...msg,
      ...(msg.sections ? { sections: msg.sections.map((x) => ({ ...x, text: shrink(x.text) })) } : {}),
    };
    card = buildCard(m, shrink(text));
  }
  return card;
}

export function textMessage(text: string): OutMessage {
  if (looksLikeMarkdown(text)) {
    return { msg_type: 'post', content: JSON.stringify({ zh_cn: { content: [[{ tag: 'md', text }]] } }) };
  }
  return { msg_type: 'text', content: JSON.stringify({ text }) };
}

export function cardMessage(card: unknown): OutMessage {
  return { msg_type: 'interactive', content: JSON.stringify(card) };
}

/** Outcome card used by `retract`. */
export function outcomeCard(outcome: string): Record<string, unknown> {
  return buildCard({ text: outcome }, outcome);
}
