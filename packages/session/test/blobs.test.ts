import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BlobTooLargeError, FsBlobStore, parseBlobRef } from '../src/index.js';

const tmp = () => mkdtemp(join(tmpdir(), 'aio-blobs-'));
const bytes = (s: string) => new TextEncoder().encode(s);

describe('FsBlobStore', () => {
  it('is content-addressed (sha256), keeps mime and name, and round-trips bytes #MD-1', async () => {
    const store = new FsBlobStore({ dir: join(await tmp(), 'blobs') });
    const ref = await store.put(bytes('hello'), { mime: 'image/png', name: 'a.png' });
    expect(ref).toBe('sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
    expect(parseBlobRef(ref)).toHaveLength(64);
    expect(await store.put(bytes('hello'), { mime: 'text/plain', name: 'other' })).toBe(ref);
    const got = await store.get(ref);
    expect(new TextDecoder().decode(got.bytes)).toBe('hello');
    expect(got).toMatchObject({ mime: 'image/png', name: 'a.png' });
    const st = await store.stat(ref);
    expect(st).toMatchObject({ mime: 'image/png', size: 5 });
    expect(st!.path.endsWith('.png')).toBe(true);
  });

  it("a provisional put vouches for the bytes only: its mime and name hold until a put of the same bytes that is not provisional, whose mime, name and file extension then replace them for good; the path handed out before still reads the bytes; a provisional put never replaces anything, and without the flag the first writer's stay as before #PB-6 #MD-1", async () => {
    const dir = join(await tmp(), 'blobs');
    const store = new FsBlobStore({ dir });
    const png = bytes('the bytes of a picture');
    // A writer that only vouches for the bytes names them misleadingly.
    const ref = await store.put(png, { mime: 'application/octet-stream', name: 'invoice.exe' }, { provisional: true });
    const before = (await store.stat(ref))!;
    expect(before).toMatchObject({ mime: 'application/octet-stream', name: 'invoice.exe', size: png.byteLength });
    expect(before.path.endsWith('.bin')).toBe(true);
    // Another provisional writer changes nothing.
    expect(await store.put(png, { mime: 'text/plain', name: 'again.txt' }, { provisional: true })).toBe(ref);
    expect(await store.stat(ref)).toEqual(before);
    // The first writer that is not provisional (a channel storing an inbound picture) sets them.
    expect(await store.put(png, { mime: 'image/png', name: 'logo.png' })).toBe(ref);
    const after = (await store.stat(ref))!;
    expect(after).toMatchObject({ mime: 'image/png', name: 'logo.png', size: png.byteLength });
    expect(after.path.endsWith('.png')).toBe(true);
    expect((await stat(after.path)).mode & 0o777).toBe(0o600);
    expect(await store.get(ref)).toMatchObject({ mime: 'image/png', name: 'logo.png' });
    expect(new TextDecoder().decode((await store.get(ref)).bytes)).toBe('the bytes of a picture');
    // A path handed out while the metadata was provisional still reads the same bytes.
    expect(await readFile(before.path, 'utf8')).toBe('the bytes of a picture');
    // From here on nobody replaces them: not a provisional writer, not another plain one (as always).
    await store.put(png, { mime: 'application/octet-stream', name: 'x.bin' }, { provisional: true });
    await store.put(png, { mime: 'text/plain', name: 'other.txt' });
    expect(await store.stat(ref)).toEqual(after);
    // Across a restart too.
    expect(await new FsBlobStore({ dir }).stat(ref)).toEqual(after);
    // The same extension: only the metadata changes. No name given: none is kept.
    const txt = bytes('some text');
    const r2 = await store.put(txt, { mime: 'text/plain', name: 'guess.txt' }, { provisional: true });
    await store.put(txt, { mime: 'text/plain' });
    expect(await store.stat(r2)).toEqual({ path: (await store.stat(r2))!.path, mime: 'text/plain', size: txt.byteLength });
    expect((await store.stat(r2))!.path.endsWith('.txt')).toBe(true);
  });

  it('after a restart (a new store on the same directory) a reference reads back the same bytes, mime and name #RS-1', async () => {
    const dir = join(await tmp(), 'blobs');
    const data = new Uint8Array([0, 255, 1, 254, 128]);
    const ref = await new FsBlobStore({ dir }).put(data, { mime: 'image/png', name: 'a.png' });
    const got = await new FsBlobStore({ dir }).get(ref);
    expect(got.bytes).toEqual(data);
    expect(got).toMatchObject({ mime: 'image/png', name: 'a.png' });
  });

  it('writes files 0600 under 0700 directories #SE-2', async () => {
    const dir = join(await tmp(), 'blobs');
    const store = new FsBlobStore({ dir });
    const ref = await store.put(bytes('x'), { mime: 'application/octet-stream' });
    const st = await store.stat(ref);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    expect((await stat(join(st!.path, '..'))).mode & 0o777).toBe(0o700);
    expect((await stat(st!.path)).mode & 0o777).toBe(0o600);
    expect((await stat(st!.path.replace(/\.bin$/, '.json'))).mode & 0o777).toBe(0o600);
  });

  it('refuses blobs over the size limit, unknown refs and corrupted files #MD-1', async () => {
    const store = new FsBlobStore({ dir: await tmp(), maxBytes: 4 });
    await expect(store.put(bytes('12345'), { mime: 'text/plain' })).rejects.toBeInstanceOf(BlobTooLargeError);
    await expect(store.get('lark-file:m/k')).rejects.toThrow(/not a blob ref/);
    await expect(store.get(`sha256:${'0'.repeat(64)}`)).rejects.toThrow(/not found/);
    expect(await store.stat('lark-file:m/k')).toBeUndefined();
    const ref = await store.put(bytes('1234'), { mime: 'text/plain' });
    const p = (await store.stat(ref))!.path;
    expect(await readFile(p, 'utf8')).toBe('1234');
    await writeFile(p, 'evil');
    await expect(store.get(ref)).rejects.toThrow(/corrupt/);
  });
});
