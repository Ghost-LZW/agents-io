#!/usr/bin/env node
// Invariants <-> tests (decision 14, docs/TESTING.md). Reads text only; never runs a test.
//
//   node scripts/invariants.mjs check              drift report (warnings only for now; exit 0)
//   node scripts/invariants.mjs affected [files…]  changed files -> invariants -> tests per tier
//   node scripts/invariants.mjs list [ID…|--json]  the tests tagged with each id (or every test as JSON)
//
// Ids come from the `### XX-n …` headings of docs/INVARIANTS.md; tags are `#XX-n` in test names.
// A test's tier is its file suffix: *.test.ts core, *.local.test.ts, *.e2e.test.ts, *.live.test.ts.
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const TIERS = ['core', 'local', 'e2e', 'live'];
const TAG = /#([A-Z]{2}-\d+[a-z]?)(?![\w-])/g;

// ---------- docs/INVARIANTS.md ----------

function readInvariants() {
  const text = readFileSync(join(root, 'docs', 'INVARIANTS.md'), 'utf8');
  const lines = text.split('\n');
  const entries = new Map();
  let cur = null;
  let field = null;
  for (const [i, line] of lines.entries()) {
    const h = /^###\s+([A-Z]{2}-\d+[a-z]?)\s+(.*)$/.exec(line);
    if (h) {
      cur = { id: h[1], title: h[2].trim(), line: i + 1, fields: {}, body: '' };
      entries.set(cur.id, cur);
      field = null;
      continue;
    }
    if (/^##\s/.test(line) || /^---\s*$/.test(line)) {
      cur = null;
      continue;
    }
    if (!cur) continue;
    cur.body += line + '\n';
    const f = /^- \*\*([^*]+)\*\*[：:]?(.*)$/.exec(line);
    if (f) {
      field = f[1].replace(/[（(].*$/, '').trim();
      cur.fields[field] = (cur.fields[field] ?? '') + f[2] + '\n';
    } else if (field && (/^\s+/.test(line) || line.startsWith('|'))) {
      cur.fields[field] += line + '\n';
    } else if (line.trim() === '') {
      // a blank line inside a field's numbered list keeps the field open
    } else {
      field = null;
    }
  }
  for (const e of entries.values()) {
    const status = e.fields['状态'] ?? '';
    e.status = status.trim();
    // Open "不成立" items: any `不成立` field (including "不成立（可能）") with an item that is not struck out.
    const bad = Object.entries(e.fields).filter(([k]) => k.startsWith('不成立') || k === '与原则不符');
    e.false = bad.some(([k, v]) => {
      if (k === '与原则不符') return false;
      const items = v.split('\n').map((s) => s.trim()).filter(Boolean);
      return items.some((s) => !/^(\d+\.\s*)?~~/.test(s));
    });
    e.untested = /没有测试/.test(status);
    // Every path-ish mention in the implementation fields: full paths and bare basenames.
    const impl = Object.entries(e.fields)
      .filter(([k]) => k.startsWith('实现') || k === '现状')
      .map(([, v]) => v)
      .join('\n') + (e.fields['实现与测试'] ?? '');
    const files = new Set();
    for (const m of impl.matchAll(/([\w./-]+\.(?:ts|mjs|js))(?::[\d-]+)?/g)) files.add(m[1]);
    e.files = [...files];
  }
  return { entries, text };
}

// ---------- tests ----------

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue;
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) walk(p, out);
    else if (name.endsWith('.test.ts') && p.split(sep).includes('test')) out.push(p);
  }
  return out;
}

function tierOf(file) {
  const m = /\.(local|e2e|live)\.test\.ts$/.exec(file);
  return m ? m[1] : 'core';
}

/** Reads a JS string literal starting at `i` (a quote). Returns [value, endIndex]. */
function readString(src, i) {
  const q = src[i];
  let j = i + 1;
  let v = '';
  while (j < src.length && src[j] !== q) {
    if (src[j] === '\\') {
      v += src[j + 1];
      j += 2;
      continue;
    }
    if (q === '`' && src[j] === '$' && src[j + 1] === '{') {
      let depth = 0;
      const start = j;
      for (; j < src.length; j++) {
        if (src[j] === '{') depth++;
        else if (src[j] === '}' && --depth === 0) break;
      }
      v += src.slice(start, j + 1);
      j++;
      continue;
    }
    v += src[j++];
  }
  return [v, j + 1];
}

function skipBalanced(src, i) {
  // src[i] === '('
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    const c = src[j];
    if (c === "'" || c === '"' || c === '`') {
      j = readString(src, j)[1] - 1;
      continue;
    }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      if (--depth === 0) return j + 1;
    }
  }
  return src.length;
}

/** Finds it(...) / test(...) calls with their modifiers and names. */
function parseTests(file) {
  const src = readFileSync(file, 'utf8');
  const tests = [];
  const re = /(?<![\w.$])(it|test)(?=[.(\s])/g;
  let m;
  while ((m = re.exec(src))) {
    let i = m.index + m[1].length;
    const mods = [];
    let name = null;
    for (let guard = 0; guard < 8 && i < src.length; guard++) {
      while (/\s/.test(src[i])) i++;
      if (src[i] === '.') {
        const id = /^\.(\w+)/.exec(src.slice(i));
        if (!id) break;
        mods.push(id[1]);
        i += id[0].length;
        continue;
      }
      if (src[i] === '`' && mods.includes('each')) {
        i = readString(src, i)[1];
        continue;
      }
      if (src[i] === '(') {
        let k = i + 1;
        while (/\s/.test(src[k])) k++;
        if (src[k] === "'" || src[k] === '"' || src[k] === '`') {
          [name] = readString(src, k);
          break;
        }
        if (mods.length === 0) break; // it(variable, …) or a plain call
        i = skipBalanced(src, i);
        continue;
      }
      break;
    }
    if (name === null) continue;
    const line = src.slice(0, m.index).split('\n').length;
    const kind = mods.includes('fails') ? 'fails' : mods.includes('todo') ? 'todo' : mods.includes('skip') ? 'skip' : 'it';
    tests.push({ file: relative(root, file), line, name, kind, tags: [...name.matchAll(TAG)].map((t) => t[1]) });
  }
  return tests;
}

function readTests() {
  const files = ['packages', 'harness', 'channel', 'examples'].flatMap((d) => {
    try {
      return walk(join(root, d));
    } catch {
      return [];
    }
  });
  return files.sort().flatMap((f) => parseTests(f).map((t) => ({ ...t, tier: tierOf(f) })));
}

// ---------- commands ----------

function byId(tests) {
  const map = new Map();
  for (const t of tests) for (const id of t.tags) map.set(id, [...(map.get(id) ?? []), t]);
  return map;
}

function counts(list = []) {
  const c = Object.fromEntries(TIERS.map((t) => [t, 0]));
  let fails = 0;
  for (const t of list) {
    c[t.tier]++;
    if (t.kind === 'fails') fails++;
  }
  return { ...c, fails };
}

function check() {
  const { entries } = readInvariants();
  const tests = readTests();
  const tagged = byId(tests);
  const warn = [];
  const section = (title, rows) => {
    if (!rows.length) return;
    warn.push(`\n${title} (${rows.length})`);
    for (const r of rows) warn.push(`  ${r}`);
  };

  section(
    'tags naming no invariant in docs/INVARIANTS.md',
    tests.flatMap((t) => t.tags.filter((id) => !entries.has(id)).map((id) => `#${id}  ${t.file}:${t.line}  ${t.name}`)),
  );
  section(
    'invariants with no tagged test',
    [...entries.values()].filter((e) => !tagged.has(e.id)).map((e) => `${e.id}  ${e.title}  [${e.status.slice(0, 40)}]`),
  );
  section(
    'core tests without an #ID tag (a promise-less test belongs in *.local.test.ts)',
    tests.filter((t) => t.tier === 'core' && t.tags.length === 0).map((t) => `${t.file}:${t.line}  ${t.name}`),
  );
  const has = (e, kind) => (tagged.get(e.id) ?? []).some((t) => t.kind === kind);
  section(
    'invariants marked 不成立 with no it.fails tagged with them',
    [...entries.values()].filter((e) => e.false && !has(e, 'fails') && !has(e, 'todo')).map((e) => `${e.id}  ${e.title}`),
  );
  const todoOnly = [...entries.values()].filter((e) => e.false && !has(e, 'fails') && has(e, 'todo'));
  const notes = todoOnly.length ? [`note: 不成立 covered only by it.todo (not reproducible yet): ${todoOnly.map((e) => e.id).join(', ')}`] : [];
  // Quoted test names in INVARIANTS.md that match no test (renamed or deleted).
  const names = tests.map((t) => t.name);
  const describes = tests.map((t) => t.file).filter((f, i, a) => a.indexOf(f) === i)
    .flatMap((f) => [...readFileSync(join(root, f), 'utf8').matchAll(/\bdescribe(?:\.\w+)*\(\s*(['"`])((?:(?!\1).)*)\1/g)].map((d) => d[2]));
  const testFields = [...entries.values()].flatMap((e) =>
    Object.entries(e.fields).filter(([k]) => /^(测试|实现与测试|状态)/.test(k)).map(([, v]) => v),
  );
  const quoted = testFields.flatMap((v) => [...v.matchAll(/"((?:[^"\\\n]|\\.){12,}?)"/g)].map((q) => q[1]));
  const lost = [...new Set(quoted)].filter((q) => {
    const plain = q.replace(/\\"/g, '"').split(/\s*…/)[0];
    return /[a-z]/.test(plain) && !/[一-鿿]/.test(plain) && !names.some((n) => n.includes(plain)) && !describes.some((d) => d.includes(plain));
  });
  section('test names quoted in docs/INVARIANTS.md that match no test', lost.map((q) => `"${q}"`));

  const c = counts(tests);
  console.log(
    `invariants: ${entries.size} ids; tests: ${tests.length} (core ${c.core}, local ${c.local}, e2e ${c.e2e}, live ${c.live}); ` +
      `it.fails ${c.fails}; tagged ${tests.filter((t) => t.tags.length).length}`,
  );
  for (const n of notes) console.log(n);
  if (warn.length) console.log(warn.join('\n'));
  else console.log('no drift');
  console.log(warn.length ? '\n(warnings only: decision 14 turns these into errors once the backlog is cleared)' : '');
  process.exitCode = 0;
}

function changedFiles() {
  const run = (args) => {
    try {
      return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);
    } catch {
      return [];
    }
  };
  const base = run(['merge-base', 'HEAD', 'main'])[0] ?? 'HEAD';
  return [...new Set([...run(['diff', '--name-only', base]), ...run(['ls-files', '--others', '--exclude-standard'])])];
}

function affected(args) {
  const { entries } = readInvariants();
  const tests = readTests();
  const tagged = byId(tests);
  const files = (args.length ? args : changedFiles()).map((f) => relative(root, join(process.cwd(), f)).split(sep).join('/'));
  const hit = new Map(); // id -> reasons
  const unmapped = [];
  const add = (id, why) => hit.set(id, [...new Set([...(hit.get(id) ?? []), why])]);
  for (const f of files) {
    let found = false;
    if (/\.test\.ts$/.test(f)) {
      for (const t of tests.filter((t) => t.file === f)) for (const id of t.tags) (add(id, `tests in ${f}`), (found = true));
    } else {
      for (const e of entries.values()) {
        for (const ref of e.files) {
          const full = ref.includes('/');
          if ((full && (f === ref || f.endsWith('/' + ref))) || (!full && basename(f) === ref)) {
            add(e.id, `${f} (${ref})`);
            found = true;
          }
        }
      }
    }
    if (!found && /\/src\/.*\.(ts|mjs)$/.test(f)) unmapped.push(f);
  }
  if (!hit.size) console.log('no invariant names these files in its 实现 field.');
  const ids = [...hit.keys()].sort();
  for (const id of ids) {
    const e = entries.get(id);
    const c = counts(tagged.get(id));
    console.log(
      `${id}  ${e?.title ?? '(not in INVARIANTS.md)'}\n    core ${c.core}, e2e ${c.e2e}, local ${c.local}, live ${c.live}` +
        (c.fails ? `, it.fails ${c.fails}` : '') +
        `\n    via ${hit.get(id).join('; ')}`,
    );
  }
  if (unmapped.length) {
    console.log(`\nsource files no invariant names (no promise here, or INVARIANTS.md misses one):`);
    for (const f of unmapped) console.log(`  ${f}`);
  }
  if (ids.length) {
    const pattern = ids.map((id) => `#${id}\\b`).join('|');
    const inE2e = ids.some((id) => counts(tagged.get(id)).e2e > 0);
    console.log(`\nrun:\n  pnpm test                                  # always: core + local`);
    console.log(`  npx vitest run --project core -t '${pattern}'`);
    if (inE2e) console.log(`  npx vitest run --project e2e -t '${pattern}'   # these ids have e2e tests`);
  }
}

function list(args) {
  if (args[0] === '--json') {
    console.log(JSON.stringify(readTests()));
    return;
  }
  const { entries } = readInvariants();
  const tagged = byId(readTests());
  for (const id of args.length ? args : [...entries.keys()]) {
    const ts = tagged.get(id) ?? [];
    console.log(`${id}  ${entries.get(id)?.title ?? '(not in INVARIANTS.md)'}  — ${ts.length} tests`);
    for (const t of ts) console.log(`  [${t.tier}${t.kind === 'it' ? '' : ' ' + t.kind}] ${t.file}:${t.line}  ${t.name}`);
  }
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === 'check') check();
else if (cmd === 'affected') affected(rest);
else if (cmd === 'list') list(rest);
else {
  console.log('usage: node scripts/invariants.mjs check | affected [files…] | list [ID…]');
  process.exitCode = cmd ? 2 : 0;
}
