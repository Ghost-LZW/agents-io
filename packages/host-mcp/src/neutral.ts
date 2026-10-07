import { createHash } from 'node:crypto';
import type { BlobStore } from '@agents-io/protocol';

/*
 * Neutral `RenderedMessage.channelData` keys the output tools use until the
 * protocol has first-class fields for them (see the proposal in docs/CHANNELS.md).
 * Adapters that understand a key render it natively; every other adapter just
 * shows `text`, which always carries a readable fallback.
 */

/** `channelData[MENTIONS_KEY]`: people to @-mention. `text` is the message without the mentions. */
export const MENTIONS_KEY = 'agents-io/mentions';
export interface MentionsData {
  targets: { id: string; name?: string }[];
  text: string;
}

/** `channelData[CHOICE_KEY]`: an ask_choice question. Buttons carry `choiceActionId(choiceId, n)`. */
export const CHOICE_KEY = 'agents-io/choice';
export interface ChoiceData {
  choiceId: string;
  question: string;
  options: string[];
  multi: boolean;
}

/** `channelData[OUTPUT_KEY]`: which output tool produced the message. */
export const OUTPUT_KEY = 'agents-io/output';

const CHOICE_PREFIX = 'choice:';

/** Button action id of option `n` (1-based) of a choice; `form` for a multi-select submit. */
export function choiceActionId(choiceId: string, n: number | 'form'): string {
  return `${CHOICE_PREFIX}${choiceId}:${n}`;
}

export function parseChoiceActionId(id: string): { choiceId: string; n: number | 'form' } | undefined {
  if (!id.startsWith(CHOICE_PREFIX)) return undefined;
  const cut = id.lastIndexOf(':');
  const choiceId = id.slice(CHOICE_PREFIX.length, cut);
  const tail = id.slice(cut + 1);
  if (!choiceId) return undefined;
  if (tail === 'form') return { choiceId, n: 'form' };
  const n = Number(tail);
  return Number.isInteger(n) && n > 0 ? { choiceId, n } : undefined;
}

/** In-memory `BlobStore` (`sha256:<hex>` refs). Fine for one process; hosts should provide a durable one. */
export class MemoryBlobStore implements BlobStore {
  private m = new Map<string, { bytes: Uint8Array; mime: string; name?: string }>();
  constructor(private readonly maxEntries = 256) {}

  async put(bytes: Uint8Array, meta: { mime: string; name?: string }): Promise<string> {
    const ref = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    this.m.delete(ref);
    this.m.set(ref, { bytes, mime: meta.mime, ...(meta.name !== undefined ? { name: meta.name } : {}) });
    while (this.m.size > this.maxEntries) this.m.delete(this.m.keys().next().value!);
    return ref;
  }

  async get(ref: string): Promise<{ bytes: Uint8Array; mime: string; name?: string }> {
    const b = this.m.get(ref);
    if (!b) throw new Error(`blob not found: ${ref}`);
    return b;
  }
}

const MIME: Record<string, string> = {
  txt: 'text/plain',
  md: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json',
  html: 'text/html',
  xml: 'application/xml',
  log: 'text/plain',
  ts: 'text/plain',
  js: 'text/javascript',
  py: 'text/x-python',
  pdf: 'application/pdf',
  zip: 'application/zip',
  gz: 'application/gzip',
  tar: 'application/x-tar',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  opus: 'audio/opus',
  m4a: 'audio/mp4',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
};

export function mimeOf(name: string): string {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  return MIME[ext] ?? 'application/octet-stream';
}

export function mediaKind(mime: string): 'image' | 'audio' | 'file' {
  if (mime.startsWith('image/') && mime !== 'image/svg+xml') return 'image';
  if (mime.startsWith('audio/')) return 'audio';
  return 'file';
}
