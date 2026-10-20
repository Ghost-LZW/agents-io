import type { BlobStore, ContentBlock, InboundEnvelope } from '@agents-io/protocol';
import { messageMedia, messageText } from './inbound.js';
import type { ResolvedConfig } from './config.js';
import type { DeclaredSenderStore } from './store.js';
import type { LarkClientLike, LarkMessageItem } from './types.js';

/**
 * Inbound enrichment that needs the network: attachment download into the host's
 * blob store, the text of a replied-to message, and sender display names. It runs
 * after the envelope is mapped and is fully best-effort: every failure leaves the
 * envelope as the plain mapping made it (plus a text notice for undownloaded media).
 */
export interface EnrichDeps {
  client: () => LarkClientLike;
  store: DeclaredSenderStore;
  cfg: ResolvedConfig;
  now: () => number;
  log: (level: 'debug' | 'info' | 'warn', msg: string) => void;
}

const LARK_FILE = /^lark-file:([^/]+)\/(.+)$/;
const CACHE_MAX = 2000;
const NAME_FAIL_TTL_MS = 10 * 60_000;
const MERGED_FORWARD_MAX_ITEMS = 100;
const MERGED_FORWARD_MAX_CHARS = 16_000;
const MERGED_FORWARD_MAX_MEDIA = 4;

class TimeoutError extends Error {
  override name = 'TimeoutError';
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string, onTimeout?: () => void): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  const timer = new Promise<never>((_, reject) => {
    t = setTimeout(() => {
      onTimeout?.();
      reject(new TimeoutError(`${what} timed out after ${ms}ms`));
    }, ms);
  });
  return Promise.race([p, timer]).finally(() => clearTimeout(t));
}

function put<K, V>(m: Map<K, V>, k: K, v: V): void {
  m.delete(k);
  m.set(k, v);
  if (m.size > CACHE_MAX) {
    const oldest = m.keys().next();
    if (!oldest.done) m.delete(oldest.value);
  }
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 200);

function header(h: any, name: string): string | undefined {
  if (!h) return undefined;
  const v = typeof h.get === 'function' ? h.get(name) : (h[name] ?? h[name.toLowerCase()]);
  return v == null ? undefined : String(v);
}

/** `attachment; filename="a.pdf"` / `filename*=UTF-8''a%20b.pdf`. */
export function dispositionName(cd: string | undefined): string | undefined {
  if (!cd) return undefined;
  const star = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/.exec(cd);
  if (star) {
    try {
      return decodeURIComponent(star[1]!.trim().replace(/^"|"$/g, ''));
    } catch {
      /* fall through */
    }
  }
  const plain = /filename\s*=\s*("([^"]*)"|[^;]+)/.exec(cd);
  const v = (plain?.[2] ?? plain?.[1])?.trim();
  if (!v) return undefined;
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
}

/** Image formats Claude/Codex accept, from magic bytes. */
export function sniffMime(b: Uint8Array): string | undefined {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'image/gif';
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50)
    return 'image/webp';
  if (b.length >= 5 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return 'application/pdf';
  return undefined;
}

/** Concrete mime for a downloaded resource: the server's, else sniffed, else a default per block kind. */
function mimeOf(headerType: string | undefined, bytes: Uint8Array, block: Extract<ContentBlock, { ref: string }>): string {
  const h = headerType?.split(';')[0]!.trim().toLowerCase();
  if (h && h !== 'application/octet-stream' && !h.endsWith('/*')) return h;
  const sniffed = sniffMime(bytes);
  if (sniffed) return sniffed;
  if (block.mime === 'audio/*') return 'audio/opus'; // Lark voice messages are opus
  if (block.mime === 'video/*') return 'video/mp4';
  return block.mime.endsWith('/*') ? 'application/octet-stream' : block.mime;
}

/** `Request failed with status code 400` → `400 234003 File not in msg.` (the error body of a stream request is itself a stream). */
async function httpErrorText(e: any): Promise<string> {
  const status = e?.response?.status;
  let body: any = e?.response?.data;
  if (body && typeof body.on === 'function') {
    body = await withTimeout(
      new Promise<string>((resolve) => {
        const chunks: Buffer[] = [];
        let n = 0;
        body.on('data', (c: Buffer) => {
          if ((n += c.length) <= 4096) chunks.push(Buffer.from(c));
        });
        body.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        body.on('error', () => resolve(''));
      }),
      2000,
      'error body',
    ).catch(() => '');
    try {
      body = JSON.parse(body as string);
    } catch {
      /* not JSON */
    }
  }
  if (status && body && typeof body === 'object' && body.code !== undefined) return `${status} ${body.code} ${body.msg ?? ''}`.trim();
  return errText(e);
}

const idType = (id: string): 'union_id' | 'open_id' | 'user_id' => (id.startsWith('on_') ? 'union_id' : id.startsWith('ou_') ? 'open_id' : 'user_id');

export class InboundEnricher {
  private readonly quotes = new Map<string, { text: string }>();
  private readonly names = new Map<string, { name: string | undefined; unionId?: string; until: number }>();

  constructor(private readonly d: EnrichDeps) {}

  /** Never throws. */
  async enrich(env: InboundEnvelope, blobs: BlobStore | undefined): Promise<InboundEnvelope> {
    const [content, displayName] = await Promise.all([this.content(env, blobs), env.sender.isBot ? undefined : this.senderName(env.sender.channelUserId)]);
    return {
      ...env,
      content,
      sender: { ...env.sender, ...(displayName && !env.sender.displayName ? { displayName } : {}) },
    };
  }

  private async content(env: InboundEnvelope, blobs: BlobStore | undefined): Promise<ContentBlock[]> {
    const out: ContentBlock[] = [];
    for (const b of env.content) {
      if (b.type === 'text' && b.text === '[merged forward message]' && (env.raw as { messageType?: string } | undefined)?.messageType === 'merge_forward') {
        out.push(...(await this.mergedForward(env.id, blobs)));
        continue;
      }
      if (b.type === 'quote' && b.fromMessageId && !b.text) {
        out.push(await this.quote(b.fromMessageId));
        continue;
      }
      if ((b.type === 'image' || b.type === 'file' || b.type === 'audio') && blobs) {
        out.push(...(await this.media(b, blobs)));
        continue;
      }
      out.push(b);
    }
    return out;
  }

  // ---- media ----------------------------------------------------------------------------

  private async media(b: Extract<ContentBlock, { ref: string }>, blobs: BlobStore): Promise<ContentBlock[]> {
    const m = LARK_FILE.exec(b.ref);
    if (!m) return [b];
    const [, messageId, key] = m as unknown as [string, string, string];
    try {
      const got = await this.download(messageId, key, b.type === 'image' ? 'image' : 'file');
      const mime = mimeOf(got.type, got.bytes, b);
      const name = b.name ?? got.name;
      const ref = await blobs.put(got.bytes, { mime, ...(name ? { name } : {}) });
      return [{ type: b.type, ref, mime, ...(name ? { name } : {}) }];
    } catch (e) {
      this.d.log('warn', `lark ${b.type} ${key} of ${messageId} not downloaded: ${errText(e)}`);
      return [b, { type: 'text', text: `[${b.type} ${b.name ?? key} not downloaded: ${errText(e)}]` }];
    }
  }

  /** Official `im.v1.messageResource.get`, bounded in size and time. */
  private async download(messageId: string, key: string, type: 'image' | 'file'): Promise<{ bytes: Uint8Array; type?: string; name?: string }> {
    const api = this.d.client().im.v1.messageResource;
    if (!api) throw new Error('client has no messageResource API');
    const max = this.d.cfg.mediaMaxBytes;
    const deadline = this.d.now() + this.d.cfg.mediaTimeoutMs;
    const left = () => Math.max(1, deadline - this.d.now());
    const res = await withTimeout(
      api.get({ params: { type }, path: { message_id: messageId, file_key: key } }).catch(async (e) => {
        throw new Error(await httpErrorText(e));
      }),
      left(),
      'download',
    );
    const declared = Number(header(res.headers, 'content-length'));
    const stream = res.getReadableStream();
    // destroy() without an error: the read promise is settled by us, and an 'error' event nobody awaits must not escape.
    const stop = () => {
      try {
        stream.destroy?.();
      } catch {
        /* already closed */
      }
    };
    if (Number.isFinite(declared) && declared > max) {
      stop();
      throw new Error(`${declared} bytes exceeds the ${max}-byte limit`);
    }
    const read = new Promise<Uint8Array>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      stream.on('data', (c: Buffer | string) => {
        const buf = typeof c === 'string' ? Buffer.from(c) : c;
        size += buf.length;
        if (size > max) {
          const err = new Error(`more than the ${max}-byte limit`);
          stop();
          reject(err);
          return;
        }
        chunks.push(buf);
      });
      stream.on('error', reject);
      stream.on('end', () => resolve(new Uint8Array(Buffer.concat(chunks))));
    });
    const bytes = await withTimeout(read, left(), 'download', stop);
    const ct = header(res.headers, 'content-type');
    const name = dispositionName(header(res.headers, 'content-disposition'));
    return { bytes, ...(ct ? { type: ct } : {}), ...(name ? { name } : {}) };
  }

  // ---- quotes -----------------------------------------------------------------------------

  /** `message.get` returns a merged forward's whole tree, linked by `upper_message_id`. */
  private mergedForwardView(items: LarkMessageItem[], messageId: string): { text: string; media: { path: string; block: ContentBlock }[] } | undefined {
    const root = items.find((item) => item.message_id === messageId);
    if (root?.msg_type !== 'merge_forward') return undefined;
    const descendants = items.filter((item) => item.message_id && item.message_id !== messageId);
    const byId = new Map(descendants.map((item) => [item.message_id!, item]));
    const children = new Map<string, LarkMessageItem[]>();
    for (const item of descendants) {
      const upper = item.upper_message_id;
      const parent = upper && upper !== item.message_id && (upper === messageId || byId.get(upper)?.msg_type === 'merge_forward') ? upper : messageId;
      const group = children.get(parent) ?? [];
      group.push(item);
      children.set(parent, group);
    }
    const direct = children.get(messageId) ?? [];
    if (!direct.length) return undefined;
    const heading = this.d.cfg.locale === 'zh' ? `合并转发（${direct.length} 条消息）` : `Merged forward (${direct.length} messages)`;
    const truncated = this.d.cfg.locale === 'zh' ? '[转发内容已截断]' : '[Forwarded content truncated]';
    const ordered: { item: LarkMessageItem; path: string; depth: number }[] = [];
    const visit = (parent: string, prefix: string, depth: number, ancestors: Set<string>): void => {
      for (const [index, item] of (children.get(parent) ?? []).entries()) {
        if (ordered.length > MERGED_FORWARD_MAX_ITEMS) break;
        if (!item.message_id || ancestors.has(item.message_id)) continue;
        const path = prefix ? `${prefix}.${index + 1}` : String(index + 1);
        ordered.push({ item, path, depth });
        if (item.msg_type === 'merge_forward' && !item.deleted) visit(item.message_id, path, depth + 1, new Set([...ancestors, item.message_id]));
      }
    };
    visit(messageId, '', 0, new Set([messageId]));
    let text = heading;
    const media: { path: string; block: ContentBlock }[] = [];
    for (const [index, { item, path, depth }] of ordered.entries()) {
      if (index >= MERGED_FORWARD_MAX_ITEMS) {
        text += `\n\n${truncated}`;
        break;
      }
      const sender = item.sender?.id || (this.d.cfg.locale === 'zh' ? '未知发送者' : 'unknown sender');
      const childCount = item.message_id ? (children.get(item.message_id)?.length ?? 0) : 0;
      const kind = item.msg_type === 'merge_forward'
        ? this.d.cfg.locale === 'zh' ? `merge_forward，${childCount} 条子消息` : `merge_forward, ${childCount} children`
        : item.msg_type ?? 'unknown';
      const body = item.deleted ? '[deleted message]' : item.msg_type === 'merge_forward'
        ? childCount ? '' : (this.d.cfg.locale === 'zh' ? '[嵌套转发内容无法读取]' : '[Nested forward content unavailable]')
        : messageText(item.msg_type, item.body?.content, item.mentions);
      const indent = '  '.repeat(depth);
      const line = `\n\n${indent}${path}. ${sender} (${kind})${body ? `\n${indent}${body.replaceAll('\n', `\n${indent}`)}` : ''}`;
      if (text.length + line.length > MERGED_FORWARD_MAX_CHARS) {
        text += `${line.slice(0, Math.max(0, MERGED_FORWARD_MAX_CHARS - text.length - truncated.length - 2))}\n\n${truncated}`;
        break;
      }
      text += line;
      if (!item.deleted) media.push(...messageMedia(item.msg_type, item.body?.content, messageId).map((block) => ({ path, block })));
    }
    return { text, media };
  }

  private mergedForwardText(items: LarkMessageItem[], messageId: string): string | undefined {
    return this.mergedForwardView(items, messageId)?.text;
  }

  private async mergedForward(messageId: string, blobs: BlobStore | undefined): Promise<ContentBlock[]> {
    try {
      const res = await withTimeout(
        this.d.client().im.v1.message.get({ path: { message_id: messageId }, params: { card_msg_content_type: 'user_card_content' } }),
        this.d.cfg.lookupTimeoutMs,
        'merged message.get',
      );
      if (res?.code) throw new Error(`message.get ${res.code}: ${res.msg ?? ''}`);
      const items = res?.data?.items ?? [];
      const view = this.mergedForwardView(items, messageId);
      if (!view) throw new Error('message.get returned no merged-forward children');
      const out: ContentBlock[] = [{ type: 'text', text: view.text }];
      if (!blobs) return out;
      const attached = await Promise.all(view.media.slice(0, MERGED_FORWARD_MAX_MEDIA).map(async ({ path, block }): Promise<ContentBlock[]> => [
        { type: 'text', text: this.d.cfg.locale === 'zh' ? `转发第 ${path} 条的媒体：` : `Media from forwarded message ${path}:` },
        ...(await this.media(block as Extract<ContentBlock, { ref: string }>, blobs)),
      ]));
      for (const blocks of attached) out.push(...blocks);
      if (view.media.length > MERGED_FORWARD_MAX_MEDIA)
        out.push({ type: 'text', text: this.d.cfg.locale === 'zh' ? `[其余 ${view.media.length - MERGED_FORWARD_MAX_MEDIA} 个媒体已省略]` : `[${view.media.length - MERGED_FORWARD_MAX_MEDIA} more media omitted]` });
      return out;
    } catch (e) {
      this.d.log('warn', `merged forward ${messageId} not fetched: ${errText(e)}`);
      return [{ type: 'text', text: this.d.cfg.locale === 'zh' ? '[合并转发内容无法读取]' : '[Merged forward content unavailable]' }];
    }
  }

  /** The replied-to message as a quote: text from `im.v1.message.get`, `declared` from our own store. */
  private async quote(parentId: string): Promise<ContentBlock> {
    let declared: string | undefined;
    try {
      declared = await this.d.store.get(parentId);
    } catch {
      declared = undefined;
    }
    const base = { type: 'quote' as const, fromMessageId: parentId, ...(declared ? { declared } : {}) };
    if (!this.d.cfg.fetchQuotes) return { ...base, text: '' };
    const hit = this.quotes.get(parentId);
    if (hit) return { ...base, text: hit.text };
    try {
      const res = await withTimeout(this.d.client().im.v1.message.get({ path: { message_id: parentId }, params: { card_msg_content_type: 'user_card_content' } }), this.d.cfg.lookupTimeoutMs, 'message.get');
      if (res?.code) throw new Error(`message.get ${res.code}: ${res.msg ?? ''}`);
      const items = res?.data?.items ?? [];
      const item = items.find((candidate) => candidate.message_id === parentId) ?? items[0];
      if (!item) throw new Error('message.get returned no item');
      const raw = (item.deleted ? '[deleted message]' : item.msg_type === 'merge_forward' ? this.mergedForwardText(items, parentId) ?? '[merged forward message]' : messageText(item.msg_type, item.body?.content, item.mentions)).replace(/\n{3,}/g, '\n\n').trim();
      const max = this.d.cfg.quoteMaxChars;
      const text = raw.length > max ? raw.slice(0, max - 1).trimEnd() + '…' : raw;
      put(this.quotes, parentId, { text });
      return { ...base, text };
    } catch (e) {
      this.d.log('debug', `quoted message ${parentId} not fetched: ${errText(e)}`);
      return { ...base, text: '' };
    }
  }

  // ---- sender names -------------------------------------------------------------------------

  /** Display name via `contact.v3.user.get` (contact:user.base:readonly), cached with a TTL; undefined on any failure. */
  async senderName(id: string): Promise<string | undefined> {
    return (await this.contact(id)).name;
  }

  /**
   * Display name and union_id of a user (`contact.v3.user.get`, contact:user.base:readonly),
   * cached with a TTL (a failure for 10 minutes); empty on any failure or with names off.
   */
  async contact(id: string): Promise<{ name?: string; unionId?: string }> {
    if (!this.d.cfg.resolveSenderNames) return {};
    const now = this.d.now();
    const hit = this.names.get(id);
    const view = (h: { name: string | undefined; unionId?: string }) => ({ ...(h.name ? { name: h.name } : {}), ...(h.unionId ? { unionId: h.unionId } : {}) });
    if (hit && hit.until > now) return view(hit);
    const api = this.d.client().contact?.v3.user;
    if (!api) return {};
    try {
      const res = await withTimeout(api.get({ path: { user_id: id }, params: { user_id_type: idType(id) } }), this.d.cfg.lookupTimeoutMs, 'contact.user.get');
      if (res?.code) throw new Error(`contact.user.get ${res.code}: ${res.msg ?? ''}`);
      const u = res?.data?.user;
      const name = u?.name || u?.nickname || u?.en_name || undefined;
      const entry = { name, ...(u?.union_id ? { unionId: u.union_id } : {}), until: now + (name ? this.d.cfg.senderNameTtlMs : NAME_FAIL_TTL_MS) };
      put(this.names, id, entry);
      // The same person by the id inbound events carry: one lookup serves both.
      if (entry.unionId && entry.unionId !== id) put(this.names, entry.unionId, entry);
      return view(entry);
    } catch (e) {
      put(this.names, id, { name: undefined, until: now + NAME_FAIL_TTL_MS });
      this.d.log('debug', `sender name of ${id} not resolved: ${errText(e)}`);
      return {};
    }
  }
}
