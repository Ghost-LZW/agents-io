#!/usr/bin/env node
// Core / module boundaries (docs/design/core-slimming §6). Reads text only; never builds or runs anything.
//
//   node scripts/boundaries.mjs check     fail when a core file gains an import or a vendor name its baseline lacks
//   node scripts/boundaries.mjs shrink    lower the baseline to today's counts (refuses while any count is above it)
//   node scripts/boundaries.mjs report    counts per file and rule, worst first [--json]
//   … --root <dir>                        another workspace (with its own scripts/boundaries*.json); tests
//
// Classification: scripts/boundaries.json. Baseline: scripts/boundaries.baseline.json, which may only shrink:
// a new violation is fixed, never added to the baseline. Only `src/` of each package is production code.
//
// Rules, per production file:
//   import:<pkg>   a workspace package its package's `may` list lacks (every package but examples; the
//                  composition root's `bundle` files may also import modules)
//   vendor         in core files outside a bundle: identifiers containing a vendor word, and string
//                  literals equal to a module id (comments are ignored)
// and per package.json (counted on that file), so a dependency no import shows is seen too:
//   dep:<pkg>      a workspace package in `dependencies`, `optionalDependencies` or `peerDependencies`
//                  its `may` list lacks (the composition root, `root`, may also depend on modules); and
//                  a module package in a core package's `devDependencies` but the root's (its tests run
//                  without modules)
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const rootAt = argv.indexOf('--root');
const root = rootAt >= 0 && argv[rootAt + 1] ? resolve(argv[rootAt + 1]) : fileURLToPath(new URL('..', import.meta.url));
const CLASSIFICATION = join(root, 'scripts', 'boundaries.json');
const BASELINE = join(root, 'scripts', 'boundaries.baseline.json');

const rel = (p) => relative(root, p).split(sep).join('/');

function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    if (fallback !== undefined && e.code === 'ENOENT') return fallback;
    throw e;
  }
}

function walk(dir, out = []) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    if (name === 'node_modules' || name === 'dist') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|mts|cts|tsx|js|mjs)$/.test(name) && !/\.d\.ts$/.test(name)) out.push(p);
  }
  return out;
}

// ---------- a small lexer: code, strings and comments apart ----------

/** Splits TS/JS source into code text (strings and comments blanked) and string literal values. */
function lex(src) {
  let code = '';
  const strings = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && d === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end < 0 ? n : end + 2;
      code += src.slice(i, stop).replace(/[^\n]/g, ' ');
      i = stop;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      let value = '';
      let depth = 0;
      while (j < n) {
        const e = src[j];
        if (e === '\\') {
          value += src[j + 1] ?? '';
          j += 2;
          continue;
        }
        if (c === '`' && e === '$' && src[j + 1] === '{') depth++;
        else if (c === '`' && e === '}' && depth > 0) depth--;
        else if (e === c && depth === 0) break;
        else if (c !== '`' && e === '\n') break;
        value += e;
        j++;
      }
      strings.push(value);
      code += src.slice(i, j + 1).replace(/[^\n]/g, ' ');
      i = j + 1;
      continue;
    }
    code += c;
    i++;
  }
  return { code, strings };
}

// ---------- classification ----------

function loadClassification() {
  const cls = readJson(CLASSIFICATION);
  const pkgs = new Map();
  for (const [dir, spec] of Object.entries(cls.packages)) {
    const pj = readJson(join(root, dir, 'package.json'));
    // The composition root is a core package, the only one that may have `bundle` files (or depend on modules).
    if (spec.root && spec.role !== 'core') throw new Error(`${dir}: only a core package can be the composition root (root)`);
    if (spec.bundle?.length && !spec.root) throw new Error(`${dir}: only the composition root (root: true) has bundle files`);
    pkgs.set(dir, { dir, name: pj.name, json: pj, ...spec, root: spec.root === true, bundle: new Set((spec.bundle ?? []).map((f) => `${dir}/${f}`)) });
  }
  const roots = [...pkgs.values()].filter((p) => p.root).map((p) => p.dir);
  if (roots.length > 1) throw new Error(`more than one composition root (root: true): ${roots.join(', ')}`);
  const byName = new Map([...pkgs.values()].map((p) => [p.name, p]));
  // Every workspace package must be classified, so a new one cannot slip past.
  for (const group of ['packages', 'harness', 'channel', 'examples']) {
    let names = [];
    try {
      names = readdirSync(join(root, group));
    } catch {}
    for (const name of names) {
      const dir = `${group}/${name}`;
      try {
        statSync(join(root, dir, 'package.json'));
      } catch {
        continue;
      }
      if (!pkgs.has(dir)) throw new Error(`${dir} is not classified in scripts/boundaries.json`);
    }
  }
  return { pkgs, byName, vendor: cls.vendor };
}

// ---------- counting ----------

function count() {
  const { pkgs, byName, vendor } = loadClassification();
  const words = new RegExp(`(?<![\\w$])[\\w$]*(?:${vendor.identifierWords.join('|')})[\\w$]*`, 'gi');
  const literals = new Set(vendor.literals);
  const found = {};
  const bump = (file, key) => {
    found[file] ??= {};
    found[file][key] = (found[file][key] ?? 0) + 1;
  };
  for (const pkg of pkgs.values()) {
    if (pkg.role === 'example') continue;
    // package.json: what the package depends on, whether or not an import shows it.
    const manifest = `${pkg.dir}/package.json`;
    for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies', 'devDependencies']) {
      for (const name of Object.keys(pkg.json[field] ?? {})) {
        const target = byName.get(name);
        if (!target || target === pkg) continue;
        const allowed =
          field === 'devDependencies'
            ? !(pkg.role === 'core' && !pkg.root && target.role === 'module')
            : pkg.may.includes('*') || pkg.may.includes(target.dir) || (pkg.root && target.role === 'module');
        if (!allowed) bump(manifest, `dep:${name}`);
      }
    }
    for (const path of walk(join(root, pkg.dir, 'src'))) {
      const file = rel(path);
      const src = readFileSync(path, 'utf8');
      const inBundle = pkg.bundle.has(file);
      // Imports: string literals naming a workspace package, right after `from` / `import`.
      for (const m of src.matchAll(/\b(?:from|import)\s*\(?\s*['"](@agents-io\/[a-z0-9-]+)/g)) {
        const target = byName.get(m[1]);
        if (!target || target === pkg) continue;
        const allowed = pkg.may.includes('*') || pkg.may.includes(target.dir) || (inBundle && target.role === 'module');
        if (!allowed) bump(file, `import:${m[1]}`);
      }
      if (pkg.role !== 'core' || inBundle) continue;
      const { code, strings } = lex(src);
      for (const _ of code.matchAll(words)) bump(file, 'vendor');
      for (const s of strings) if (literals.has(s)) bump(file, 'vendor');
    }
  }
  return found;
}

// ---------- commands ----------

function flatten(m) {
  const out = new Map();
  for (const [file, keys] of Object.entries(m)) for (const [k, v] of Object.entries(keys)) out.set(`${file}\t${k}`, v);
  return out;
}

function sorted(m) {
  const out = {};
  for (const file of Object.keys(m).sort()) {
    const keys = Object.keys(m[file]).sort();
    if (keys.length === 0) continue;
    out[file] = Object.fromEntries(keys.map((k) => [k, m[file][k]]));
  }
  return out;
}

function compare(now, base) {
  const over = [];
  const under = [];
  const a = flatten(now);
  const b = flatten(base);
  for (const [k, v] of a) {
    const was = b.get(k) ?? 0;
    if (v > was) over.push({ k, v, was });
    else if (v < was) under.push({ k, v, was });
  }
  for (const [k, was] of b) if (!a.has(k)) under.push({ k, v: 0, was });
  return { over, under };
}

const show = ({ k, v, was }) => {
  const [file, rule] = k.split('\t');
  return `  ${file}  ${rule}: ${was} -> ${v}`;
};

function cmdCheck() {
  const now = count();
  const { over, under } = compare(now, readJson(BASELINE, {}));
  if (under.length) {
    console.log(`${under.length} count(s) below the baseline; run \`node scripts/boundaries.mjs shrink\` to lock them in:`);
    for (const u of under) console.log(show(u));
  }
  if (over.length) {
    console.error(`boundaries: ${over.length} violation(s) above the baseline (fix them; the baseline only shrinks):`);
    for (const o of over) console.error(show(o));
    process.exit(1);
  }
  const total = [...flatten(now).values()].reduce((s, v) => s + v, 0);
  console.log(`boundaries ok: ${total} known violation(s) left in the baseline`);
}

function cmdShrink() {
  const now = count();
  const base = readJson(BASELINE, null);
  if (base) {
    const { over } = compare(now, base);
    if (over.length) {
      console.error('boundaries: refusing to shrink while counts are above the baseline:');
      for (const o of over) console.error(show(o));
      process.exit(1);
    }
  }
  writeFileSync(BASELINE, JSON.stringify(sorted(now), null, 2) + '\n');
  console.log(`wrote ${rel(BASELINE)}`);
}

function cmdReport(json) {
  const now = sorted(count());
  if (json) {
    console.log(JSON.stringify(now, null, 2));
    return;
  }
  const rows = Object.entries(now)
    .map(([file, keys]) => ({ file, keys, total: Object.values(keys).reduce((s, v) => s + v, 0) }))
    .sort((x, y) => y.total - x.total);
  for (const r of rows) {
    const parts = Object.entries(r.keys).map(([k, v]) => `${k}=${v}`);
    console.log(`${String(r.total).padStart(5)}  ${r.file}  ${parts.join(' ')}`);
  }
}

const [cmd, ...rest] = argv.filter((_, i) => rootAt < 0 || (i !== rootAt && i !== rootAt + 1));
if (cmd === 'check') cmdCheck();
else if (cmd === 'shrink') cmdShrink();
else if (cmd === 'report') cmdReport(rest.includes('--json'));
else {
  console.error('usage: node scripts/boundaries.mjs check | shrink | report [--json] [--root <dir>]');
  process.exit(2);
}
