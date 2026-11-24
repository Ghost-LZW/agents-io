import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/*
 * `coreRegistries` (core.ts) is the kernel without modules: what it imports, all the way down,
 * reaches no module package and not the composition root (`bundle.ts`, which imports them all).
 * Static imports only; `import type` is erased and not followed.
 */

const src = join(import.meta.dirname, '..', 'src');

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

/** The workspace packages `scripts/boundaries.json` classifies as core, by package name. */
function corePackages(): Set<string> {
  const root = join(import.meta.dirname, '..', '..', '..');
  const { packages } = JSON.parse(readFileSync(join(root, 'scripts', 'boundaries.json'), 'utf8')) as { packages: Record<string, { role: string }> };
  return new Set(Object.entries(packages).filter(([, p]) => p.role === 'core').map(([dir]) => (JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf8')) as { name: string }).name));
}

describe('core.ts', () => {
  it('reaches no module package and not bundle.ts: only the kernel\'s own files and core packages', () => {
    const { files, packages } = reached(join(src, 'core.ts'));
    const names = [...files].map((f) => relative(src, f));
    expect(names).toEqual(expect.arrayContaining(['core.ts', 'harness-registry.ts', 'channel-registry.ts', 'modules.ts']));
    expect(names).not.toContain('bundle.ts');
    const core = corePackages();
    expect(core).toEqual(new Set(['@agents-io/protocol', '@agents-io/session', '@agents-io/host-mcp', '@agents-io/daemon']));
    expect([...packages].filter((p) => p.startsWith('@agents-io/') && !core.has(p))).toEqual([]);
  });
});
