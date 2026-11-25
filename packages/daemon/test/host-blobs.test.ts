import { createHash } from 'node:crypto';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RenderedMessage } from '@agents-io/protocol';
import { FsBlobStore } from '@agents-io/session';
import { HostBlobs, MAX_ATTACHMENTS, type HostBlobsOptions } from '../../kernel/src/host-blobs.js';
import { cleanups, tmp } from './helpers.js';

const refOf = (bytes: Uint8Array) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');
const KIB = 1024;

/** `HostBlobs` over a store in a temporary directory; `puts` is every copy into the shared store, `peak` how many ran at once. */
function world(o: Partial<HostBlobsOptions> & { maxBytes?: number } = {}) {
  const dir = tmp();
  const { maxBytes, ...limits } = o;
  const store = new FsBlobStore({ dir: join(dir, 'blobs'), ...(maxBytes !== undefined ? { maxBytes } : {}) });
  const copies = { puts: [] as string[], running: 0, peak: 0 };
  const put = store.put.bind(store);
  store.put = async (...a: Parameters<FsBlobStore['put']>) => {
    copies.running++;
    copies.peak = Math.max(copies.peak, copies.running);
    try {
      // Long enough for another copy to start meanwhile, were nothing in the way.
      await new Promise((r) => setTimeout(r, 3));
      const ref = await put(...a);
      copies.puts.push(ref);
      return ref;
    } finally {
      copies.running--;
    }
  };
  const granted = new Set<string>();
  const warns: string[] = [];
  const hb = new HostBlobs({ store, uploadsDir: join(dir, 'blobs', 'uploads'), granted: (b, ref) => granted.has(`${b} ${ref}`), log: (level, msg) => void (level === 'warn' && warns.push(msg)), sweepEveryMs: 0, ...limits });
  cleanups.push(() => hb.close());
  const upload = async (backend: string, bytes: Uint8Array) => {
    const r = await hb.put({ base64: b64(bytes) }, backend);
    if (!r.ok) throw new Error(`${r.code}: ${r.message}`);
    return refOf(bytes);
  };
  const staged = (backend: string) => (existsSync(join(dir, 'blobs', 'uploads', backend)) ? readdirSync(join(dir, 'blobs', 'uploads', backend)).sort() : []);
  return { dir, store, hb, granted, warns, copies, upload, staged };
}

const msg = (...refs: string[]): RenderedMessage => ({ text: 'x', attachments: refs.map((ref) => ({ ref, mime: 'text/plain', name: 'a.txt' })) });

// Blobs over the host protocol, the parts no connection is needed for (docs/HOSTS.md §4.13, INVARIANTS PB-6).
describe('HostBlobs', () => {
  it('an unfinished upload keeps its bytes in a bounded number of buffers however small its parts are: 200 000 one-byte parts, then larger ones, are held in blocks of 64 KiB, and the finished blob is the bytes in the order sent #PB-6', async () => {
    const { hb, staged } = world();
    const N = 200_000;
    const all: Buffer[] = [];
    let offset = 0;
    const part = async (bytes: Buffer, last = false) => {
      const r = await hb.put({ base64: b64(bytes), part: { upload: 'u', offset, ...(last ? { last } : {}) } }, 'alpha');
      if (!r.ok) throw new Error(`${r.code}: ${r.message}`);
      all.push(bytes);
      offset += bytes.byteLength;
      return r.value;
    };
    for (let i = 0; i < N; i++) await part(Buffer.from([i % 251]));
    // One buffer per part would be 200 000 of them (some hundred bytes of heap each, for one byte of payload).
    const held = hb.pending('alpha');
    expect(held).toMatchObject({ uploads: 1, bytes: N });
    expect(held.buffers).toBeLessThanOrEqual(Math.ceil(N / (64 * KIB)) + 1);
    // Parts of every size, small after large and large after small: still bounded by the bytes, not by the parts.
    await part(Buffer.alloc(300 * KIB, 7));
    for (let i = 0; i < 5000; i++) await part(Buffer.from([1, 2, 3]));
    await part(Buffer.alloc(64 * KIB, 8));
    await part(Buffer.alloc(64 * KIB - 1, 9));
    for (let i = 0; i < 100; i++) await part(Buffer.alloc(700, i));
    const now = hb.pending('alpha');
    expect(now.bytes).toBe(offset);
    expect(now.buffers).toBeLessThanOrEqual(Math.ceil(offset / (64 * KIB)) + 1);
    // The other owner's count is its own.
    expect(hb.pending('beta')).toEqual({ uploads: 0, bytes: 0, buffers: 0 });
    expect(hb.pending()).toEqual({ uploads: 0, bytes: 0, buffers: 0 });
    const whole = Buffer.concat(all.concat(Buffer.from('the end')));
    expect(await part(Buffer.from('the end'), true)).toEqual({ ref: refOf(whole), size: whole.byteLength });
    expect(hb.pending('alpha')).toEqual({ uploads: 0, bytes: 0, buffers: 0 });
    expect(staged('alpha')).toEqual([refOf(whole).slice(7)]);
    const got = await hb.get({ ref: refOf(whole), offset: N - 2, length: 8 }, 'alpha');
    expect(got).toMatchObject({ ok: true, value: { base64: b64(whole.subarray(N - 2, N + 6)) } });
  });

  it("attaching an upload copies it to the shared store once and one at a time per backend: repeated in one message, attached by forty delivers at once, or attached again later, its staged file is read one time; more than 32 attachments are refused before anything is read or copied; the memory of a copy goes with the upload's expiry and with forget, and a blob gone from the store is copied again #PB-6", async () => {
    const skew = { ms: 0 };
    const { hb, store, copies, upload, granted } = world({ now: () => Date.now() + skew.ms });
    const x = await upload('alpha', Buffer.from('uploaded by alpha: x'));
    const y = await upload('alpha', Buffer.alloc(200 * KIB, 5));
    const z = await upload('alpha', Buffer.from('uploaded by alpha: z'));

    // One message naming the same upload as often as allowed: one copy, and the message keeps every entry.
    const many = await hb.attachments('alpha', msg(...Array<string>(MAX_ATTACHMENTS).fill(x)));
    expect(MAX_ATTACHMENTS).toBe(32);
    expect(many).toMatchObject({ ok: true, msg: { attachments: Array(MAX_ATTACHMENTS).fill({ ref: x, mime: 'text/plain', name: 'a.txt' }) } });
    expect(copies.puts).toEqual([x]);
    // One more is refused whole, whatever it names (its own uploads here): nothing is read, nothing is copied.
    expect(await hb.attachments('alpha', msg(...Array<string>(MAX_ATTACHMENTS + 1).fill(y)))).toEqual({ ok: false, code: 'too_many' });
    expect(await hb.attachments('alpha', msg(...Array<string>(100_000).fill('sha256:nothing')))).toEqual({ ok: false, code: 'too_many' });
    expect(copies.puts).toEqual([x]);
    expect(await store.stat(y)).toBeUndefined();

    // Forty delivers at once naming one upload, and forty naming another: each upload is copied once, one copy at a time.
    copies.peak = 0;
    const burst = await Promise.all([...Array.from({ length: 40 }, () => hb.attachments('alpha', msg(y))), ...Array.from({ length: 40 }, () => hb.attachments('alpha', msg(z, y, x)))]);
    expect(burst.every((r) => r.ok)).toBe(true);
    expect(copies.puts.slice().sort()).toEqual([x, y, z].sort());
    expect(copies.peak).toBe(1);
    // Later again: no read at all.
    expect((await hb.attachments('alpha', msg(x, y, z))).ok).toBe(true);
    expect(copies.puts).toHaveLength(3);

    // Another backend's own upload of the same bytes is its own to copy: what alpha did changes nothing for it.
    await upload('beta', Buffer.from('uploaded by alpha: x'));
    expect((await hb.attachments('beta', msg(x))).ok).toBe(true);
    expect(copies.puts).toEqual([...copies.puts.slice(0, 3), x]);
    expect((await hb.attachments('beta', msg(x))).ok).toBe(true);
    expect(copies.puts).toHaveLength(4);
    // Two backends copy side by side; each still one at a time.
    const [p, q] = [await upload('alpha', Buffer.alloc(100 * KIB, 1)), await upload('beta', Buffer.alloc(100 * KIB, 2))];
    await Promise.all([hb.attachments('alpha', msg(p)), hb.attachments('beta', msg(q)), hb.attachments('alpha', msg(p)), hb.attachments('beta', msg(q))]);
    expect(copies.puts.slice(4).sort()).toEqual([p, q].sort());

    // A granted ref (the media of its item) is not an upload: nothing is copied for it.
    granted.add(`alpha sha256:${'a'.repeat(64)}`);
    expect((await hb.attachments('alpha', msg(`sha256:${'a'.repeat(64)}`))).ok).toBe(true);
    expect(copies.puts).toHaveLength(6);

    // The blob vanished from the shared store (someone removed it by hand): the next attach copies it again.
    rmSync(join(store.dir, x.slice(7, 9)), { recursive: true, force: true });
    expect(await store.stat(x)).toBeUndefined();
    expect((await hb.attachments('alpha', msg(x))).ok).toBe(true);
    expect(await store.stat(x)).toMatchObject({ size: 20 });
    expect(copies.puts).toHaveLength(7);

    // The upload expired and was uploaded again: a new upload, copied (and checked) again. forget: the same.
    skew.ms += 25 * 3_600_000;
    expect(await hb.attachments('alpha', msg(z))).toEqual({ ok: false, ref: z, code: 'unknown_blob' });
    await upload('alpha', Buffer.from('uploaded by alpha: z'));
    expect((await hb.attachments('alpha', msg(z))).ok).toBe(true);
    expect(copies.puts).toHaveLength(8);
    hb.forget('alpha');
    expect(await hb.attachments('alpha', msg(z))).toEqual({ ok: false, ref: z, code: 'unknown_blob' });
    await upload('alpha', Buffer.from('uploaded by alpha: z'));
    expect((await hb.attachments('alpha', msg(z))).ok).toBe(true);
    expect(copies.puts).toHaveLength(9);
  });

  it("the sweep and an upload of one backend do not cross: an upload into a staging directory the sweep is emptying at that moment succeeds, a hundred times over; the sweep still deletes what expired and removes the empty directory #PB-6", async () => {
    const skew = { ms: 0 };
    const { hb, warns, staged, dir } = world({ now: () => Date.now() + skew.ms });
    const failed: string[] = [];
    for (let i = 0; i < 100; i++) {
      const bytes = Buffer.from(`upload number ${i}`);
      // The one before expired: the sweep deletes it and removes the directory while this one is being written.
      skew.ms += 25 * 3_600_000;
      const [r] = await Promise.all([hb.put({ base64: b64(bytes) }, 'alpha'), hb.sweep(), hb.sweep()]);
      if (!r.ok) failed.push(`${i}: ${r.code}`);
      else expect(staged('alpha')).toEqual([refOf(bytes).slice(7)]);
    }
    expect(failed).toEqual([]);
    expect(warns).toEqual([]);
    skew.ms += 25 * 3_600_000;
    expect(await hb.sweep()).toBe(1);
    expect(existsSync(join(dir, 'blobs', 'uploads', 'alpha'))).toBe(false);
  });
});
