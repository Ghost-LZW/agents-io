import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/*
 * The kernel package (`@agents-io/kernel`) is the kernel without modules: what its entry imports,
 * all the way down, reaches no module package and not the composition root (`@agents-io/daemon`,
 * whose `bundle.ts` imports them all), and its package.json depends on neither. Static imports
 * only; `import type` is erased and not followed. (`pnpm boundaries:check` counts the same per file
 * and per package.json, `boundaries.local.test.ts`.)
 */

const src = join(import.meta.dirname, '..', 'src');
const root = join(import.meta.dirname, '..', '..', '..');

/** The files under src/ and the packages `file` reaches through its value imports and re-exports. */
function reached(file: string, files = new Set<string>(), packages = new Set<string>()) {
  if (files.has(file)) return { files, packages };
  files.add(file);
  const code = readFileSync(file, 'utf8');
  for (const m of code.matchAll(/^\s*(?:import|export)\s+(type\s+)?(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/gm)) {
    if (m[1]) continue;
    const spec = m[2]!;
    if (spec.startsWith('.')) {
      const ts = join(dirname(file), spec.replace(/\.js$/, '.ts'));
      reached(existsSync(ts) ? ts : join(dirname(file), spec), files, packages);
    } else if (!spec.startsWith('node:')) packages.add(spec.split('/').slice(0, spec.startsWith('@') ? 2 : 1).join('/'));
  }
  return { files, packages };
}

/** The workspace packages `scripts/boundaries.json` classifies, by package name, with their role and whether each is the composition root. */
function classified(): Map<string, { role: string; root: boolean }> {
  const { packages } = JSON.parse(readFileSync(join(root, 'scripts', 'boundaries.json'), 'utf8')) as { packages: Record<string, { role: string; root?: boolean }> };
  return new Map(Object.entries(packages).map(([dir, p]) => [(JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf8')) as { name: string }).name, { role: p.role, root: p.root === true }]));
}

/**
 * The core packages the kernel may reach: itself and the ones its `may` list in
 * `scripts/boundaries.json` names. Not every core package: the console (`@agents-io/console`) is
 * one that depends on the kernel, and the composition root is one too.
 */
function kernelPackages(): Set<string> {
  const { packages } = JSON.parse(readFileSync(join(root, 'scripts', 'boundaries.json'), 'utf8')) as { packages: Record<string, { may: string[] }> };
  const name = (dir: string) => (JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf8')) as { name: string }).name;
  const roles = classified();
  return new Set(['packages/kernel', ...packages['packages/kernel']!.may].map(name).filter((n) => roles.get(n)?.role === 'core' && !roles.get(n)!.root));
}

describe('@agents-io/kernel', () => {
  it('reaches no module package and not the composition root: only its own files and core packages', () => {
    const { files, packages } = reached(join(src, 'index.ts'));
    const names = [...files].map((f) => relative(src, f));
    expect(names).toEqual(expect.arrayContaining(['index.ts', 'core.ts', 'gateway.ts', 'config.ts', 'harness-registry.ts', 'channel-registry.ts', 'modules.ts', 'module-channel.ts']));
    expect(names.filter((n) => n.startsWith('..'))).toEqual([]);
    const core = kernelPackages();
    expect(core).toEqual(new Set(['@agents-io/protocol', '@agents-io/session', '@agents-io/host-mcp', '@agents-io/kernel']));
    expect([...packages].filter((p) => p.startsWith('@agents-io/') && !core.has(p))).toEqual([]);
  });

  it('depends on no module package and not on the composition root: core packages, and test support for its tests', () => {
    const pj = JSON.parse(readFileSync(join(src, '..', 'package.json'), 'utf8')) as Record<string, Record<string, string> | undefined>;
    const named = (field: string) => Object.keys(pj[field] ?? {}).filter((n) => n.startsWith('@agents-io/'));
    const roles = classified();
    const core = kernelPackages();
    expect(['dependencies', 'optionalDependencies', 'peerDependencies'].flatMap(named).filter((n) => !core.has(n))).toEqual([]);
    expect(named('devDependencies').filter((n) => !core.has(n) && roles.get(n)?.role !== 'test')).toEqual([]);
  });
});
