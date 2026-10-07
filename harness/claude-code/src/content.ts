import { createHash } from 'node:crypto';
import type { ContentBlock, InputRecord } from '@agents-io/protocol';
import type { FileResolver, ImageResolver, SDKUserMessage } from './types.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The CLI echoes `SDKUserMessage.uuid` back in `result.user_message_uuids`. It is typed
 * as a UUID, so an inputId that is one is used verbatim; any other id maps to a stable
 * UUID derived from it (the session keeps the reverse map).
 */
export function inputUuid(inputId: string): string {
  if (UUID_RE.test(inputId)) return inputId.toLowerCase();
  const h = createHash('sha256').update(`agents-io:input:${inputId}`).digest('hex');
  const variant = ((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

type TextBlock = { type: 'text'; text: string };
type ImageMime = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
type ImageBlock = { type: 'image'; source: { type: 'base64'; media_type: ImageMime; data: string } };
export type UserBlock = TextBlock | ImageBlock;

const IMAGE_MIMES = new Set<string>(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const EVENT_JSON_MAX = 4000;

/** Short structured preface naming who sent the input and from where. */
export function preface(input: InputRecord): string {
  const o = input.origin;
  const parts = [`from=${o.principal?.id ?? 'unknown'}`, `kind=${o.kind}`, `via=${o.via}`];
  if (o.declared) parts.push(`declared=${o.declared}`);
  if (o.self) parts.push('self=true');
  for (const [k, v] of Object.entries(input.channelContext)) parts.push(`${k}=${oneLine(String(v))}`);
  return `[agents-io input ${parts.join(' ')}]`;
}

function oneLine(s: string, max = 120): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

function mmss(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

export interface ConvertResult {
  blocks: UserBlock[];
  /** Human-readable reasons content was dropped or degraded. */
  notices: string[];
}

/** Converts one ContentBlock to Messages API user blocks. */
export async function convertBlock(b: ContentBlock, resolveImage?: ImageResolver, resolveFile?: FileResolver): Promise<ConvertResult> {
  switch (b.type) {
    case 'text':
      return { blocks: [{ type: 'text', text: b.text }], notices: [] };
    case 'quote':
      return {
        blocks: [{ type: 'text', text: b.text.split('\n').map((l) => `> ${l}`).join('\n') }],
        notices: [],
      };
    case 'transcript': {
      const tag = `[${b.speaker ?? 'unknown speaker'} ${mmss(b.startMs)}-${mmss(b.endMs)}${b.stable ? '' : ' unstable'}]`;
      return { blocks: [{ type: 'text', text: `${tag} ${b.text}` }], notices: [] };
    }
    case 'ref':
      return { blocks: [{ type: 'text', text: `[ref${b.title ? ` "${b.title}"` : ''}] ${b.uri}` }], notices: [] };
    case 'event': {
      let json = JSON.stringify(b.data);
      if (json.length > EVENT_JSON_MAX) json = json.slice(0, EVENT_JSON_MAX) + '…(truncated)';
      return { blocks: [{ type: 'text', text: `[event ${b.name}] ${json}` }], notices: [] };
    }
    case 'image': {
      const label = `${b.name ?? b.ref} (${b.mime})`;
      if (!resolveImage) {
        return {
          blocks: [{ type: 'text', text: `[image ${label} not shown: no image resolver configured]` }],
          notices: [`image ${label} skipped: no resolveImage option`],
        };
      }
      try {
        const r = await resolveImage(b.ref, b.mime);
        const mime = r?.mime ?? b.mime;
        if (!r || !IMAGE_MIMES.has(mime)) {
          return {
            blocks: [{ type: 'text', text: `[image ${label} not shown: unavailable]` }],
            notices: [`image ${label} skipped: ${r ? `unsupported type ${mime}` : 'resolver returned nothing'}`],
          };
        }
        return { blocks: [{ type: 'image', source: { type: 'base64', media_type: mime as ImageMime, data: r.base64 } }], notices: [] };
      } catch (err) {
        return {
          blocks: [{ type: 'text', text: `[image ${label} not shown: resolver failed]` }],
          notices: [`image ${label} skipped: ${(err as Error).message}`],
        };
      }
    }
    case 'file':
    case 'audio': {
      const label = [b.type, b.name, b.mime].filter(Boolean).join(' ');
      // A local copy lets the agent open the file with its own tools.
      const local = resolveFile ? await resolveFile(b.ref, b.mime, b.name).catch(() => undefined) : undefined;
      return {
        blocks: [{ type: 'text', text: local ? `[${label} at ${local.path}]` : `[${label} ${b.ref}]` }],
        notices: [],
      };
    }
  }
}

export interface UserMessageOpts {
  priority: 'next' | 'later';
  resolveImage?: ImageResolver;
  resolveFile?: FileResolver;
  clientComposed?: boolean;
}

/** One SDKUserMessage per input, `uuid` bound to the inputId, priority always explicit. */
export async function toUserMessage(
  input: InputRecord,
  opts: UserMessageOpts,
): Promise<{ message: SDKUserMessage; notices: string[] }> {
  const blocks: UserBlock[] = [{ type: 'text', text: preface(input) }];
  const notices: string[] = [];
  for (const c of input.content) {
    const r = await convertBlock(c, opts.resolveImage, opts.resolveFile);
    blocks.push(...r.blocks);
    notices.push(...r.notices);
  }
  const message: SDKUserMessage = {
    type: 'user',
    message: { role: 'user', content: blocks },
    parent_tool_use_id: null,
    priority: opts.priority,
    uuid: inputUuid(input.inputId) as SDKUserMessage['uuid'],
    timestamp: new Date().toISOString(),
  };
  // Only a human origin is forwarded: peer/channel origins carry CLI-side hold semantics.
  if (input.origin.kind === 'human') message.origin = { kind: 'human' };
  if (opts.clientComposed) message.client_composed = true;
  return { message, notices };
}
