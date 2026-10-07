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

/*
 * Neutral `channelData` keys from the host output tools (`@agents-io/host-mcp`
 * neutral.ts). Duplicated as strings so this adapter does not depend on the host package.
 */
export const MENTIONS_KEY = 'agents-io/mentions';
export const CHOICE_KEY = 'agents-io/choice';

export interface MentionsData {
  targets: { id: string; name?: string }[];
  text: string;
}
export interface ChoiceData {
  choiceId: string;
  question: string;
  options: string[];
  multi: boolean;
}

export function neutral<T>(msg: RenderedMessage, key: string): T | undefined {
  const d = msg.channelData;
  if (!d || typeof d !== 'object' || Array.isArray(d)) return undefined;
  const v = (d as Record<string, unknown>)[key];
  return v && typeof v === 'object' ? (v as T) : undefined;
}

const escapeAt = (s: string) => s.replace(/[<>]/g, '');

/**
 * A text message @-mentioning people. Lark's `<at user_id="…">` takes an open_id (or
 * user_id); `openId` maps the ids we were given (often union_ids) to one. Unmappable
 * ids degrade to plain `@name` text.
 */
export function mentionMessage(m: MentionsData, openId: (id: string) => string | undefined): OutMessage {
  const tags = m.targets.map((t) => {
    const oid = t.id === 'all' ? 'all' : openId(t.id);
    return oid ? `<at user_id="${oid}">${escapeAt(t.name ?? '')}</at>` : `@${t.name ?? t.id}`;
  });
  return { msg_type: 'text', content: JSON.stringify({ text: `${tags.join(' ')} ${m.text}` }) };
}

/** Card for a multi-select ask_choice: a form with a multi-select and a submit button (`choice:<id>:form`). */
export function choiceFormCard(c: ChoiceData): Record<string, unknown> {
  return {
    schema: '2.0',
    config: { update_multi: true, summary: { content: c.question.slice(0, 80) } },
    body: {
      elements: [
        md(c.question),
        {
          tag: 'form',
          name: 'choice_form',
          elements: [
            {
              tag: 'multi_select_static',
              name: 'choice',
              placeholder: { tag: 'plain_text', content: 'Select…' },
              options: c.options.map((o, i) => ({ text: { tag: 'plain_text', content: o }, value: String(i + 1) })),
            },
            {
              tag: 'button',
              name: 'choice_submit',
              text: { tag: 'plain_text', content: 'Submit' },
              type: 'primary',
              form_action_type: 'submit',
              behaviors: [{ type: 'callback', value: { actionId: `choice:${c.choiceId}:form` } }],
            },
          ],
        },
      ],
    },
  };
}

/** `im.v1.file.create` file_type for a name/mime. */
export function larkFileType(name: string, mime: string): 'opus' | 'mp4' | 'pdf' | 'doc' | 'xls' | 'ppt' | 'stream' {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  if (mime === 'audio/opus' || ext === 'opus') return 'opus';
  if (mime === 'video/mp4' || ext === 'mp4') return 'mp4';
  if (ext === 'pdf') return 'pdf';
  if (ext === 'doc' || ext === 'docx') return 'doc';
  if (ext === 'xls' || ext === 'xlsx' || ext === 'csv') return 'xls';
  if (ext === 'ppt' || ext === 'pptx') return 'ppt';
  return 'stream';
}
