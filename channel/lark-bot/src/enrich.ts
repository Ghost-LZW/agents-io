import type { BlobStore, ContentBlock, InboundEnvelope } from '@agents-io/protocol';
import { messageText } from './inbound.js';
import type { ResolvedConfig } from './config.js';
import type { DeclaredSenderStore } from './store.js';
import type { LarkClientLike } from './types.js';

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
  private readonly names = new Map<string, { name: string | undefined; until: number }>();

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
      const item = res?.data?.items?.[0];
      if (!item) throw new Error('message.get returned no item');
      const raw = (item.deleted ? '[deleted message]' : messageText(item.msg_type, item.body?.content, item.mentions)).replace(/\n{3,}/g, '\n\n').trim();
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
    if (!this.d.cfg.resolveSenderNames) return undefined;
    const now = this.d.now();
    const hit = this.names.get(id);
    if (hit && hit.until > now) return hit.name;
    const api = this.d.client().contact?.v3.user;
    if (!api) return undefined;
    try {
      const res = await withTimeout(api.get({ path: { user_id: id }, params: { user_id_type: idType(id) } }), this.d.cfg.lookupTimeoutMs, 'contact.user.get');
      if (res?.code) throw new Error(`contact.user.get ${res.code}: ${res.msg ?? ''}`);
      const u = res?.data?.user;
      const name = u?.name || u?.nickname || u?.en_name || undefined;
      put(this.names, id, { name, until: now + (name ? this.d.cfg.senderNameTtlMs : NAME_FAIL_TTL_MS) });
      return name;
    } catch (e) {
      put(this.names, id, { name: undefined, until: now + NAME_FAIL_TTL_MS });
      this.d.log('debug', `sender name of ${id} not resolved: ${errText(e)}`);
      return undefined;
    }
  }
}
