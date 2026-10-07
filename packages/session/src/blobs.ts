import { createHash, randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BlobStore } from '@agents-io/protocol';

/** Default per-blob limit of {@link FsBlobStore}: 20 MiB. */
export const DEFAULT_BLOB_MAX_BYTES = 20 * 1024 * 1024;

const REF_RE = /^sha256:([0-9a-f]{64})$/;

/** Thrown by `put` when the payload exceeds the store's limit (nothing is written). */
export class BlobTooLargeError extends Error {
  override name = 'BlobTooLargeError';
  constructor(
    readonly size: number,
    readonly maxBytes: number,
  ) {
    super(`blob of ${size} bytes exceeds the ${maxBytes}-byte limit`);
  }
}

export interface FsBlobStoreOptions {
  /** Root directory (created 0700). */
  dir: string;
  /** Largest blob accepted by `put` (default {@link DEFAULT_BLOB_MAX_BYTES}). */
  maxBytes?: number;
}

interface BlobMeta {
  mime: string;
  name?: string;
  size: number;
  /** Data file name inside the shard directory (`<hex>.<ext>`). */
  file: string;
}

/** A conservative extension for a mime type, so tools that infer the format from the path work. */
function extOf(mime: string): string {
  const m = mime.toLowerCase().split(';')[0]!.trim();
  const known: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/bmp': 'bmp',
    'image/tiff': 'tiff',
    'image/heic': 'heic',
    'application/pdf': 'pdf',
    'text/plain': 'txt',
    'audio/opus': 'opus',
    'audio/ogg': 'ogg',
    'audio/mpeg': 'mp3',
    'audio/wav': 'wav',
    'video/mp4': 'mp4',
  };
  return known[m] ?? 'bin';
}

/** Parses `sha256:<hex>`; undefined for any other ref (e.g. a platform ref). */
export function parseBlobRef(ref: string): string | undefined {
  return REF_RE.exec(ref)?.[1];
}

/**
 * Content-addressed blob store on the local filesystem. Refs are `sha256:<hex>` of
 * the bytes; the same bytes always get the same ref (the first `put` sets the stored
 * mime and name). Layout: `<dir>/<hex[0..2]>/<hex>.<ext>` plus `<hex>.json` metadata;
 * directories are 0700 and files 0600. `get` re-hashes, so a tampered file is refused.
 */
export class FsBlobStore implements BlobStore {
  readonly dir: string;
  readonly maxBytes: number;
  private ready: Promise<void> | undefined;

  constructor(o: FsBlobStoreOptions) {
    this.dir = o.dir;
    this.maxBytes = o.maxBytes ?? DEFAULT_BLOB_MAX_BYTES;
  }

  private init(): Promise<void> {
    return (this.ready ??= (async () => {
      await mkdir(this.dir, { recursive: true, mode: 0o700 });
      await chmod(this.dir, 0o700);
    })());
  }

  private shard(hex: string): string {
    return join(this.dir, hex.slice(0, 2));
  }

  async put(bytes: Uint8Array, meta: { mime: string; name?: string }): Promise<string> {
    if (bytes.byteLength > this.maxBytes) throw new BlobTooLargeError(bytes.byteLength, this.maxBytes);
    await this.init();
    const hex = createHash('sha256').update(bytes).digest('hex');
    const ref = `sha256:${hex}`;
    const shard = this.shard(hex);
    await mkdir(shard, { recursive: true, mode: 0o700 });
    if (await this.readMeta(hex)) return ref;
    const file = `${hex}.${extOf(meta.mime)}`;
    const m: BlobMeta = { mime: meta.mime, ...(meta.name ? { name: meta.name } : {}), size: bytes.byteLength, file };
    // Data first, then metadata: a blob is visible only once both are complete (tmp + rename).
    await atomicWrite(join(shard, file), bytes);
    await atomicWrite(join(shard, `${hex}.json`), Buffer.from(JSON.stringify(m)));
    return ref;
  }

  async get(ref: string): Promise<{ bytes: Uint8Array; mime: string; name?: string }> {
    const hex = parseBlobRef(ref);
    if (!hex) throw new Error(`not a blob ref: ${ref}`);
    const m = await this.readMeta(hex);
    if (!m) throw new Error(`blob not found: ${ref}`);
    const bytes = await readFile(join(this.shard(hex), m.file));
    if (createHash('sha256').update(bytes).digest('hex') !== hex) throw new Error(`blob ${ref} is corrupt`);
    return { bytes: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength), mime: m.mime, ...(m.name ? { name: m.name } : {}) };
  }

  /** Local path, mime and size of a stored blob (for harnesses that read files themselves); undefined when absent. */
  async stat(ref: string): Promise<{ path: string; mime: string; name?: string; size: number } | undefined> {
    const hex = parseBlobRef(ref);
    if (!hex) return undefined;
    const m = await this.readMeta(hex);
    if (!m) return undefined;
    const path = join(this.shard(hex), m.file);
    try {
      await stat(path);
    } catch {
      return undefined;
    }
    return { path, mime: m.mime, ...(m.name ? { name: m.name } : {}), size: m.size };
  }

  private async readMeta(hex: string): Promise<BlobMeta | undefined> {
    try {
      const m = JSON.parse(await readFile(join(this.shard(hex), `${hex}.json`), 'utf8')) as BlobMeta;
      return typeof m?.file === 'string' && typeof m.mime === 'string' && !m.file.includes('/') ? m : undefined;
    } catch {
      return undefined;
    }
  }
}

async function atomicWrite(path: string, bytes: Uint8Array): Promise<void> {
  const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await writeFile(tmp, bytes, { mode: 0o600, flag: 'wx' });
    await rename(tmp, path);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
}
