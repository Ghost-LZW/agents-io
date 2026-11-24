import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

/*
 * The boundary guard (scripts/boundaries.mjs, core-slimming §6) on a workspace of its own
 * (`--root`): a core package's package.json is checked as its imports are, so a dependency on a
 * module package that no import shows (the kernel's, before it was its own package, came through
 * the composition root) is a violation; the composition root (`root: true`) may have it.
 */

const GUARD = join(import.meta.dirname, '..', '..', '..', 'scripts', 'boundaries.mjs');
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

type Pkg = { role: string; may: string[]; root?: boolean; bundle?: string[]; deps?: Record<string, Record<string, string>>; src?: Record<string, string> };

/** A workspace with these packages (by directory), classified as given, and an empty baseline. */
function workspace(pkgs: Record<string, Pkg>): string {
  const dir = mkdtempSync(join(tmpdir(), 'aio-guard-'));
  dirs.push(dir);
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  };
  const packages: Record<string, unknown> = {};
  for (const [d, p] of Object.entries(pkgs)) {
    packages[d] = { role: p.role, may: p.may, ...(p.root ? { root: true } : {}), ...(p.bundle ? { bundle: p.bundle } : {}) };
    write(`${d}/package.json`, JSON.stringify({ name: `@agents-io/${d.split('/')[1]}`, ...p.deps }));
    for (const [f, text] of Object.entries(p.src ?? { 'src/index.ts': 'export {};\n' })) write(`${d}/${f}`, text);
  }
  write('scripts/boundaries.json', JSON.stringify({ packages, vendor: { identifierWords: ['acme'], literals: ['acme'] } }));
  write('scripts/boundaries.baseline.json', '{}\n');
  return dir;
}

function check(dir: string) {
  const r = spawnSync(process.execPath, [GUARD, 'check', '--root', dir], { encoding: 'utf8' });
  return { status: r.status, out: r.stdout + r.stderr };
}

const W = 'workspace:*';
const kernel = (deps: Record<string, Record<string, string>> = {}): Pkg => ({ role: 'core', may: ['packages/protocol'], deps });
const base = {
  'packages/protocol': { role: 'core', may: [] },
  'channel/acme': { role: 'module', may: ['packages/protocol'], deps: { dependencies: { '@agents-io/protocol': W } } },
  'packages/testkit': { role: 'test', may: ['packages/protocol'] },
} satisfies Record<string, Pkg>;

describe('scripts/boundaries.mjs: package.json dependencies', () => {
  it('a core package depending on what it may import passes, and so does the composition root depending on a module package', () => {
    const dir = workspace({
      ...base,
      'packages/kernel': kernel({ dependencies: { '@agents-io/protocol': W }, devDependencies: { '@agents-io/testkit': W } }),
      'packages/daemon': {
        role: 'core',
        root: true,
        may: ['packages/protocol', 'packages/kernel'],
        bundle: ['src/bundle.ts'],
        deps: { dependencies: { '@agents-io/kernel': W, '@agents-io/acme': W } },
        src: { 'src/bundle.ts': "import { acmeChannel } from '@agents-io/acme';\nexport const channels = [acmeChannel];\n" },
      },
    });
    expect(check(dir)).toEqual({ status: 0, out: expect.stringContaining('boundaries ok: 0 known violation(s)') });
  });

  it('a core package that is not the composition root depending on a module package fails, though no file imports it', () => {
    for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies', 'devDependencies']) {
      const dir = workspace({ ...base, 'packages/kernel': kernel({ [field]: { '@agents-io/acme': W } }) });
      const r = check(dir);
      expect(r.status, field).toBe(1);
      expect(r.out, field).toContain('packages/kernel/package.json  dep:@agents-io/acme: 0 -> 1');
    }
  });

  it('a production dependency on a workspace package the `may` list lacks fails, for a module package too; a test package as a dev dependency does not', () => {
    const dir = workspace({
      ...base,
      'packages/session': { role: 'core', may: ['packages/protocol'] },
      'packages/kernel': kernel({ dependencies: { '@agents-io/session': W }, devDependencies: { '@agents-io/testkit': W } }),
      'channel/other': { role: 'module', may: ['packages/protocol'], deps: { dependencies: { '@agents-io/kernel': W } } },
    });
    const r = check(dir);
    expect(r.status).toBe(1);
    expect(r.out).toContain('packages/kernel/package.json  dep:@agents-io/session: 0 -> 1');
    expect(r.out).toContain('channel/other/package.json  dep:@agents-io/kernel: 0 -> 1');
    expect(r.out).not.toContain('testkit');
  });

  it('only the composition root may have bundle files, and there is at most one', () => {
    const bundled = workspace({ ...base, 'packages/kernel': { ...kernel(), bundle: ['src/bundle.ts'] } });
    expect(check(bundled)).toMatchObject({ status: 1, out: expect.stringContaining('packages/kernel: only the composition root (root: true) has bundle files') });
    const two = workspace({ ...base, 'packages/kernel': { ...kernel(), root: true }, 'packages/daemon': { ...kernel(), root: true } });
    expect(check(two)).toMatchObject({ status: 1, out: expect.stringContaining('more than one composition root (root: true): packages/kernel, packages/daemon') });
  });
});
