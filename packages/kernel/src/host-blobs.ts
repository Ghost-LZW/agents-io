import { createHash, randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';
import { chmod, mkdir, open, readFile, readdir, rename, rm, rmdir, stat, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BLOB_FRAME_MAX_BYTES, type HostBlobGetResult, type HostBlobPutResult, type HostBlobStatResult, type HostRequestFrame, type RenderedMessage } from '@agents-io/protocol';
import { BlobTooLargeError, parseBlobRef, type FsBlobStore } from '@agents-io/session';
import type { LogFn, Outcome } from './gateway.js';

/*
 * Blobs over the host protocol (`blob.stat`, `blob.get`, `blob.put`; docs/HOSTS.md §4.13, PB-6).
 *
 * The host token is the admin credential: it reads and writes the daemon's shared blob store.
 *
 * A backend's key reads two kinds of ref and no other: the media of the items routed to it
 * (`granted`, recorded by the host queue with the item) and the bytes it uploaded itself. Its
 * uploads are staged in a directory of its own, `<uploadsDir>/<backend>/<hex>`, never in the shared
 * content-addressed store: a ref is the SHA-256 of the bytes, so sharing a store would let one
 * backend reach another's upload by its hash, or probe what the store holds. Staged files expire
 * (the file's mtime is the upload time); one attached to a `deliver` is copied to the shared store
 * first, where channel adapters read attachments.
 *
 * What one backend can make the daemon hold or do is bounded per backend: writes to its staging
 * directory, the sweep of it and the copies to the shared store run one after another (`serial`);
 * an upload is copied to the shared store once (`promoted`); an unfinished upload holds one buffer
 * per 64 KiB, not one per part; a message carries at most `MAX_ATTACHMENTS` attachments.
 */

export interface HostBlobsOptions {
  /** The shared store (what channels put inbound media in, and read attachments from). */
  store: FsBlobStore;
  /** Where backends' uploads are staged, one directory per backend. */
  uploadsDir: string;
  /** `ref` is the blob of a media block of an item routed to `backend` (`HostQueue.grantedBlob`). */
  granted(backend: string, ref: string): boolean;
  log: LogFn;
  now?: () => number;
  /** How long a staged upload stays readable and attachable (default 24 h). */
  ttlMs?: number;
  /** The most bytes one backend may have staged (default 8 × the store's per-blob limit). */
  quotaBytes?: number;
  /** The most uploads one backend may have staged (default 256). */
  maxFiles?: number;
  /** An unfinished upload in parts is dropped after this long without a part (default 5 min). */
  partIdleMs?: number;
  /** Staged uploads of every backend are swept this often (default 1 h; 0: no timer). */
  sweepEveryMs?: number;
}

/** The limits of `HostBlobs` a test may override (`GatewayOptions.hostBlobs`). */
export type HostBlobsLimits = Pick<HostBlobsOptions, 'now' | 'ttlMs' | 'quotaBytes' | 'maxFiles' | 'partIdleMs'>;

type GetFrame = Pick<Extract<HostRequestFrame, { type: 'blob.get' }>, 'ref' | 'offset' | 'length'>;
type PutFrame = Pick<Extract<HostRequestFrame, { type: 'blob.put' }>, 'base64' | 'part' | 'mime' | 'name'>;

/**
 * An unfinished upload. A part of a block or more that starts on a block boundary is kept as it
 * came; anything else is gathered into `open`, a block of `PART_BLOCK_BYTES`, so every buffer in
 * `chunks` holds at least a block: the upload holds `size / PART_BLOCK_BYTES + 1` buffers at most,
 * however small its parts were.
 */
interface Part {
  chunks: Buffer[];
  open: Buffer | undefined;
  /** Bytes of `open` in use. */
  fill: number;
  size: number;
  at: number;
}

/** Small parts of an unfinished upload are gathered into blocks of this size. */
const PART_BLOCK_BYTES = 64 * 1024;

function append(part: Part, bytes: Buffer): void {
  part.size += bytes.byteLength;
  if (part.fill === 0 && bytes.byteLength >= PART_BLOCK_BYTES) return void part.chunks.push(bytes);
  for (let at = 0; at < bytes.byteLength; ) {
    part.open ??= Buffer.allocUnsafe(PART_BLOCK_BYTES);
    const n = bytes.copy(part.open, part.fill, at);
    at += n;
    part.fill += n;
    if (part.fill < PART_BLOCK_BYTES) break;
    part.chunks.push(part.open);
    part.open = undefined;
    part.fill = 0;
  }
}

const buffersOf = (part: Part): Buffer[] => (part.open ? [...part.chunks, part.open.subarray(0, part.fill)] : part.chunks);

/** The most attachments one message of a backend carries (PB-6). */
export const MAX_ATTACHMENTS = 32;
/** Unfinished uploads in parts one connection owner (a backend, or the host token) may have at once. */
const MAX_PARTS = 2;
/** The host token's unfinished uploads are kept under this key (no backend id is empty). */
const HOST = '';
const HEX = /^[0-9a-f]{64}$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
/** One text for a ref nothing holds and a ref the key may not read: the answer says nothing about what exists. */
const NOT_FOUND = 'no such blob';

const ok = <T>(value: T): Outcome => ({ ok: true, value });
const fail = (code: string, message: string): Outcome => ({ ok: false, code, message });

export class HostBlobs {
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly quotaBytes: number;
  private readonly maxFiles: number;
  private readonly partIdleMs: number;
  /** Unfinished uploads, per owner and upload id. In memory: a restart starts them again. */
  private readonly parts = new Map<string, Map<string, Part>>();
  /**
   * Per backend, the end of what is queued on its staging directory: an upload being written (the
   * quota is read, then written against), the sweep of the directory, a copy to the shared store.
   */
  private readonly staging = new Map<string, Promise<unknown>>();
  /**
   * Per backend, the staged uploads (hex) it already copied to the shared store: attached again,
   * they are not read again. In memory, and only as long as the staged file is there.
   */
  private readonly promoted = new Map<string, Set<string>>();
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly o: HostBlobsOptions) {
    this.now = o.now ?? Date.now;
    this.ttlMs = o.ttlMs ?? 24 * 3_600_000;
    this.quotaBytes = o.quotaBytes ?? 8 * o.store.maxBytes;
    this.maxFiles = o.maxFiles ?? 256;
    this.partIdleMs = o.partIdleMs ?? 5 * 60_000;
    const every = o.sweepEveryMs ?? 3_600_000;
    if (every > 0) {
      this.timer = setInterval(() => void this.sweep(), every);
      this.timer.unref?.();
    }
  }

  /** `blob.stat`: the size, or null. For a backend: only a ref it may read. */
  async stat(ref: string, backend?: string): Promise<Outcome> {
    const at = await this.readable(ref, backend);
    return ok<HostBlobStatResult>(at ? { size: at.size } : null);
  }

  /** `blob.get`: the whole blob when it fits a frame, or the range asked for. */
  async get(f: GetFrame, backend?: string): Promise<Outcome> {
    const at = await this.readable(f.ref, backend);
    if (!at) return fail('not_found', NOT_FOUND);
    const ranged = f.offset !== undefined || f.length !== undefined;
    if (!ranged && at.size > BLOB_FRAME_MAX_BYTES) return fail('too_large', `the blob is ${at.size} bytes: read it in ranges (offset, length; at most ${BLOB_FRAME_MAX_BYTES} bytes each)`);
    const offset = f.offset ?? 0;
    if (offset > at.size) return fail('bad_offset', `offset ${offset} is past the blob's ${at.size} bytes`);
    const length = Math.min(f.length ?? at.size - offset, at.size - offset, BLOB_FRAME_MAX_BYTES);
    try {
      const fh = await open(at.path, 'r');
      try {
        const buf = Buffer.alloc(length);
        let read = 0;
        while (read < length) {
          const r = await fh.read(buf, read, length - read, offset + read);
          if (r.bytesRead === 0) break;
          read += r.bytesRead;
        }
        return ok<HostBlobGetResult>({ base64: buf.subarray(0, read).toString('base64'), size: at.size, offset });
      } finally {
        await fh.close();
      }
    } catch (e) {
      // Gone between the look and the read (a staged upload that just expired): as if it never was.
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return fail('not_found', NOT_FOUND);
      return fail('blob_error', 'the blob could not be read');
    }
  }

  /** `blob.put`: one blob in a frame, or one part of an upload. */
  async put(f: PutFrame, backend?: string): Promise<Outcome> {
    // Refused before decoding: a frame the parser let through may be far larger.
    if (f.base64.length > Math.ceil(BLOB_FRAME_MAX_BYTES / 3) * 4) return fail('too_large', `a frame carries at most ${BLOB_FRAME_MAX_BYTES} bytes: upload in parts`);
    if (f.base64.length % 4 !== 0 || !BASE64.test(f.base64)) return fail('invalid_frame', 'base64 is not base64');
    const bytes = Buffer.from(f.base64, 'base64');
    if (bytes.byteLength > BLOB_FRAME_MAX_BYTES) return fail('too_large', `a frame carries at most ${BLOB_FRAME_MAX_BYTES} bytes: upload in parts`);
    const max = this.o.store.maxBytes;
    const tooLarge = (size: number) => fail('too_large', `a blob of ${size} bytes exceeds the ${max}-byte limit`);
    if (!f.part) {
      if (bytes.byteLength === 0) return fail('invalid_frame', 'the blob is empty');
      if (bytes.byteLength > max) return tooLarge(bytes.byteLength);
      return this.finish(bytes, f, backend);
    }
    const owner = backend ?? HOST;
    const now = this.now();
    this.dropIdle(now);
    let mine = this.parts.get(owner);
    let part = mine?.get(f.part.upload);
    if (f.part.offset === 0) {
      // Starts the upload, or starts it again: what it had is replaced.
      if (!part && (mine?.size ?? 0) >= MAX_PARTS) return fail('busy', `at most ${MAX_PARTS} unfinished uploads at once: finish one, or wait for an idle one to be dropped`);
      part = { chunks: [], open: undefined, fill: 0, size: 0, at: now };
    } else if (!part || f.part.offset !== part.size) {
      return fail('bad_offset', `expected offset ${part?.size ?? 0}`);
    }
    if (bytes.byteLength === 0 && !f.part.last) return fail('invalid_frame', 'a part that is not the last is empty');
    if (part.size + bytes.byteLength > max) {
      mine?.delete(f.part.upload);
      if (mine && mine.size === 0) this.parts.delete(owner);
      return tooLarge(part.size + bytes.byteLength);
    }
    append(part, bytes);
    part.at = now;
    if (!f.part.last) {
      if (!mine) this.parts.set(owner, (mine = new Map()));
      mine.set(f.part.upload, part);
      return ok<HostBlobPutResult>({ upload: f.part.upload, received: part.size });
    }
    mine?.delete(f.part.upload);
    if (mine && mine.size === 0) this.parts.delete(owner);
    if (part.size === 0) return fail('invalid_frame', 'the blob is empty');
    return this.finish(Buffer.concat(buffersOf(part), part.size), f, backend);
  }

  /**
   * PB-6: the attachments of a backend's `deliver` / `deliver.update`. At most `MAX_ATTACHMENTS`
   * (`too_many`, before anything is looked at). Every ref must be an upload of its own that has not
   * expired, or the media of an item routed to it (a platform ref too); `{ ok: false, ref }` names
   * the first that is not, and nothing was stored. Its uploads are copied to the shared store,
   * where channel adapters read attachments (and a send retried after a restart finds them): each
   * once, however often it is named or attached, and one at a time per backend. An attachment
   * without a name goes out as `file`: the store's name for those bytes may be another conversation's.
   */
  async attachments(
    backend: string,
    msg: RenderedMessage,
  ): Promise<{ ok: true; msg: RenderedMessage } | { ok: false; code: 'too_many' } | { ok: false; ref: string; code: 'unknown_blob' | 'blob_error' }> {
    const list = msg.attachments ?? [];
    if (!list.length) return { ok: true, msg };
    if (list.length > MAX_ATTACHMENTS) return { ok: false, code: 'too_many' };
    // Every ref is checked before any byte is copied: a refused deliver leaves nothing in the shared store.
    // Its own uploads among them, each once: the first attachment naming one gives the copy its mime and name.
    const mine = new Map<string, { hex: string; mime: string; name?: string }>();
    const seen = new Set<string>();
    for (const a of list) {
      if (seen.has(a.ref)) continue;
      seen.add(a.ref);
      const hex = parseBlobRef(a.ref);
      const s = hex !== undefined ? await this.staged(backend, hex) : undefined;
      if (!s && !this.o.granted(backend, a.ref)) return { ok: false, ref: a.ref, code: 'unknown_blob' };
      if (s && hex !== undefined) mine.set(a.ref, { hex, mime: a.mime, ...(a.name !== undefined ? { name: a.name } : {}) });
    }
    if (mine.size) {
      const failed = await this.serial(backend, async () => {
        for (const [ref, a] of mine) {
          const code = await this.promote(backend, ref, a);
          if (code !== undefined) return { ok: false as const, ref, code };
        }
        return undefined;
      });
      if (failed) return failed;
    }
    return { ok: true, msg: { ...msg, attachments: list.map((a) => (a.name !== undefined ? a : { ...a, name: 'file' })) } };
  }

  /**
   * Copy `backend`'s staged upload `ref` to the shared store; the code it failed with, if it did.
   * Called on the backend's `serial` chain: one staged file is in memory at a time. One it copied
   * before is not read again, as long as the store still has it; that says nothing about what
   * others put in the store, since it is this backend's own earlier copy that is remembered.
   * The mime and name are the backend's word for bytes others may hold too: stored as provisional.
   */
  private async promote(backend: string, ref: string, a: { hex: string; mime: string; name?: string }): Promise<'unknown_blob' | 'blob_error' | undefined> {
    if (this.promoted.get(backend)?.has(a.hex) && (await this.o.store.stat(ref)) !== undefined) return undefined;
    let bytes: Buffer;
    try {
      bytes = await readFile(join(this.dir(backend), a.hex));
    } catch {
      // Expired between the check and the read: no longer its upload.
      return 'unknown_blob';
    }
    if (createHash('sha256').update(bytes).digest('hex') !== a.hex) return 'blob_error';
    try {
      if ((await this.o.store.put(bytes, { mime: a.mime, ...(a.name !== undefined ? { name: a.name } : {}) }, { provisional: true })) !== ref) return 'blob_error';
    } catch {
      return 'blob_error';
    }
    let done = this.promoted.get(backend);
    if (!done) this.promoted.set(backend, (done = new Set()));
    done.add(a.hex);
    return undefined;
  }

  /** Remove everything staged for `backend`, and its unfinished uploads (`backends.forget`). */
  forget(backend: string): void {
    this.parts.delete(backend);
    this.promoted.delete(backend);
    if (!safeSegment(backend)) return;
    try {
      rmSync(join(this.o.uploadsDir, backend), { recursive: true, force: true });
    } catch (e) {
      this.o.log('warn', `backend ${backend}: its staged uploads could not be removed: ${(e as Error).message}`);
    }
  }

  /** Drop `backend`'s unfinished uploads (its key was rotated or revoked: whoever started them is gone). */
  dropParts(backend: string): void {
    this.parts.delete(backend);
  }

  /**
   * What `backend`'s unfinished uploads (the host token's without it) hold in memory now: how many
   * uploads, their bytes, and the buffers those bytes are kept in.
   */
  pending(backend?: string): { uploads: number; bytes: number; buffers: number } {
    const mine = [...(this.parts.get(backend ?? HOST)?.values() ?? [])];
    return { uploads: mine.length, bytes: mine.reduce((n, p) => n + p.size, 0), buffers: mine.reduce((n, p) => n + p.chunks.length + (p.open ? 1 : 0), 0) };
  }


  async sweep(): Promise<number> {
    this.dropIdle(this.now());
    let n = 0;
    let dirs: string[];
    try {
      dirs = await readdir(this.o.uploadsDir);
    } catch {
      return 0;
    }
    for (const d of dirs) {
      if (!safeSegment(d)) continue;
      // Not while that backend's upload is being written: it made the directory and is about to write into it.
      n += await this.serial(d, async () => {
        const gone = await this.expire(d);
        // An empty directory goes too (rmdir refuses one that is not).
        await rmdir(join(this.o.uploadsDir, d)).catch(() => undefined);
        return gone;
      });
    }
    return n;
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.parts.clear();
    this.promoted.clear();
  }

  /** Run `fn` after everything queued for `backend`'s staging directory, and before what is queued next. */
  private serial<T>(backend: string, fn: () => Promise<T>): Promise<T> {
    const prior = this.staging.get(backend) ?? Promise.resolve();
    const run = prior.then(fn);
    const tail = run.catch(() => undefined);
    this.staging.set(backend, tail);
    void tail.then(() => {
      if (this.staging.get(backend) === tail) this.staging.delete(backend);
    });
    return run;
  }

  /**
   * Where the bytes of `ref` are, for this caller. A backend: its own staged upload, else the shared
   * store only once the ref is granted to it; without a grant the store is not even looked at.
   */
  private async readable(ref: string, backend: string | undefined): Promise<{ path: string; size: number } | undefined> {
    if (backend === undefined) {
      const s = await this.o.store.stat(ref);
      return s ? { path: s.path, size: s.size } : undefined;
    }
    const hex = parseBlobRef(ref);
    if (hex === undefined) return undefined;
    const mine = await this.staged(backend, hex);
    if (mine) return mine;
    if (!this.o.granted(backend, ref)) return undefined;
    const s = await this.o.store.stat(ref);
    return s ? { path: s.path, size: s.size } : undefined;
  }

  private dir(backend: string): string {
    return join(this.o.uploadsDir, backend);
  }

  /**
   * `backend`'s staged upload of these bytes, while it has not expired (an expired one is deleted:
   * on the `serial` chain, where the age is looked at again, so the same bytes uploaded anew
   * meanwhile are not what goes). Not to be called from inside `serial`.
   */
  private async staged(backend: string, hex: string): Promise<{ path: string; size: number } | undefined> {
    if (!safeSegment(backend) || !HEX.test(hex)) return undefined;
    const path = join(this.dir(backend), hex);
    try {
      const s = await stat(path);
      if (!s.isFile()) return undefined;
      if (this.now() - s.mtimeMs > this.ttlMs) {
        await this.serial(backend, async () => {
          const now = await stat(path);
          if (this.now() - now.mtimeMs <= this.ttlMs) return;
          await rm(path, { force: true });
          this.promoted.get(backend)?.delete(hex);
        });
        return undefined;
      }
      return { path, size: s.size };
    } catch {
      return undefined;
    }
  }

  /**
   * Delete `backend`'s expired staged files (leftover temporary files too); how many went. With a
   * file goes the memory of its copy to the shared store. Called on the `serial` chain.
   */
  private async expire(backend: string): Promise<number> {
    const done = this.promoted.get(backend);
    let names: string[];
    try {
      names = await readdir(this.dir(backend));
    } catch {
      this.promoted.delete(backend);
      return 0;
    }
    let n = 0;
    const kept = new Set<string>();
    for (const name of names) {
      const path = join(this.dir(backend), name);
      try {
        const s = await stat(path);
        if (this.now() - s.mtimeMs <= this.ttlMs) {
          kept.add(name);
          continue;
        }
        await rm(path, { force: true });
        n++;
      } catch {
        // gone meanwhile
      }
    }
    if (done) {
      for (const hex of done) if (!kept.has(hex)) done.delete(hex);
      if (done.size === 0) this.promoted.delete(backend);
    }
    return n;
  }

  private dropIdle(now: number): void {
    for (const [owner, mine] of this.parts) {
      for (const [id, p] of mine) if (now - p.at > this.partIdleMs) mine.delete(id);
      if (mine.size === 0) this.parts.delete(owner);
    }
  }

  private async finish(bytes: Buffer, f: PutFrame, backend: string | undefined): Promise<Outcome> {
    if (backend === undefined) {
      try {
        const ref = await this.o.store.put(bytes, { mime: f.mime ?? 'application/octet-stream', ...(f.name ? { name: f.name } : {}) });
        return ok<HostBlobPutResult>({ ref, size: bytes.byteLength });
      } catch (e) {
        if (e instanceof BlobTooLargeError) return fail('too_large', e.message);
        return fail('blob_error', 'the blob could not be stored');
      }
    }
    if (!safeSegment(backend)) return fail('blob_error', 'the blob could not be stored');
    try {
      return await this.serial(backend, () => this.stage(backend, bytes));
    } catch (e) {
      this.o.log('warn', `backend ${backend}: an upload could not be staged: ${(e as Error).message}`);
      return fail('blob_error', 'the blob could not be stored');
    }
  }

  /** Write `bytes` into `backend`'s staging directory, within its quota. */
  private async stage(backend: string, bytes: Buffer): Promise<Outcome> {
    const hex = createHash('sha256').update(bytes).digest('hex');
    const dir = this.dir(backend);
    await mkdir(this.o.uploadsDir, { recursive: true, mode: 0o700 });
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700);
    await this.expire(backend);
    let files = 0;
    let total = 0;
    for (const name of await readdir(dir)) {
      if (!HEX.test(name)) continue;
      if (name === hex) continue;
      try {
        total += (await stat(join(dir, name))).size;
        files++;
      } catch {
        // gone meanwhile
      }
    }
    // The same bytes again replace their file (and start their 24 h again): they count once.
    if (files + 1 > this.maxFiles || total + bytes.byteLength > this.quotaBytes) {
      return fail('quota_exceeded', `this backend has ${files} upload(s) of ${total} bytes staged (at most ${this.maxFiles} and ${this.quotaBytes} bytes); they expire ${Math.round(this.ttlMs / 3_600_000)} h after their upload`);
    }
    const path = join(dir, hex);
    const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      await writeFile(tmp, bytes, { mode: 0o600, flag: 'wx' });
      // The upload time, by the clock expiry is judged with.
      const at = new Date(this.now());
      await utimes(tmp, at, at);
      await rename(tmp, path);
    } catch (e) {
      await rm(tmp, { force: true });
      throw e;
    }
    return ok<HostBlobPutResult>({ ref: `sha256:${hex}`, size: bytes.byteLength });
  }
}

/** A name that is one path segment and nothing else (backend ids are; checked again where a path is built). */
function safeSegment(s: string): boolean {
  return s.length > 0 && s !== '.' && s !== '..' && !/[/\\\0]/.test(s);
}
