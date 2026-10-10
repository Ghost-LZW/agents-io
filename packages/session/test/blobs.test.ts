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
