import { createHash } from 'node:crypto';
import { chmodSync, closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Value } from '@sinclair/typebox/value';
import { ADMIN_REDACTED, type AdminConfigDocument, type AdminConfigPutResult, type AdminConfigValidation, type ConfigIssue } from '@agents-io/protocol';
import { loadEnvFile } from '@agents-io/testkit';
import { ConfigError, ConfigFile, findEnvFile, resolveConfig } from './config.js';

/*
 * The config file as the console sees it (`GET/PUT /api/config`,
 * `POST /api/config/validate`). Secrets never leave the daemon: `env:NAME`
 * references are shown as written, a literal secret (a string under a
 * secret-looking key) as ADMIN_REDACTED; writing ADMIN_REDACTED back keeps the
 * stored value, and any new literal secret is refused (`inline_secret`).
 * Validation is the startup one (`resolveConfig`, with the env file read
 * afresh). Writes are atomic (temp file + fsync + rename) and 0600. The daemon
 * does not reload its config: a changed file takes effect at the next start
 * (`applied: "restart"`).
 */

/** Keys whose string values are secrets. */
const SECRET_KEY = /(secret|password|passwd|passphrase|token|api[-_]?key|credential|private[-_]?key|authorization|cookie|bearer)/i;

/** Keys that name a variable holding a secret (codex `bearer_token_env_var`, `env_key`): not secrets themselves. */
const NAMES_A_VARIABLE = /(env_var|env_key|_var|Var|Env)$/;

const isSecretKey = (k: string) => SECRET_KEY.test(k) && !NAMES_A_VARIABLE.test(k);
const envRef = (v: unknown): string | undefined => (typeof v === 'string' && v.startsWith('env:') ? v.slice(4) : undefined);
const pointer = (segs: (string | number)[]) => segs.map((s) => '/' + String(s).replace(/~/g, '~0').replace(/\//g, '~1')).join('');

type Json = unknown;

/** Walk every string leaf with its path (object keys and array indexes) and the nearest key. */
function walk(v: Json, at: (string | number)[], visit: (value: string, at: (string | number)[], key: string | undefined) => string | undefined): Json {
  if (typeof v === 'string') return visit(v, at, [...at].reverse().find((s): s is string => typeof s === 'string')) ?? v;
  if (Array.isArray(v)) return v.map((x, i) => walk(x, [...at, i], visit));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, [...at, k], visit)]));
  return v;
}

function get(v: Json, at: (string | number)[]): Json {
  let cur = v;
  for (const s of at) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string | number, Json>)[s];
  }
  return cur;
}

/** The document with literal secrets replaced by ADMIN_REDACTED. */
export function redact(raw: Json): Json {
  return walk(raw, [], (value, _at, key) => (key !== undefined && isSecretKey(key) && envRef(value) === undefined ? ADMIN_REDACTED : undefined));
}

/** Every `env:NAME` the document references, in order of first use. */
export function envRefs(raw: Json): string[] {
  const out = new Set<string>();
  walk(raw, [], (value) => {
    const n = envRef(value);
    if (n) out.add(n);
    return undefined;
  });
  return [...out];
}

/**
 * Put the stored values back where a document says ADMIN_REDACTED. Returns the
 * document and the paths kept that way; an ADMIN_REDACTED with no stored
 * literal at its path is an issue.
 */
export function unredact(next: Json, stored: Json): { doc: Json; kept: Set<string>; issues: ConfigIssue[] } {
  const kept = new Set<string>();
  const issues: ConfigIssue[] = [];
  const doc = walk(next, [], (value, at) => {
    if (value !== ADMIN_REDACTED) return undefined;
    const old = get(stored, at);
    const path = pointer(at);
    if (typeof old !== 'string' || old === ADMIN_REDACTED) {
      issues.push({ path, code: 'redacted_without_value', message: `${ADMIN_REDACTED} keeps the stored value, but the file has no value here; write an "env:NAME" reference`, severity: 'error' });
      return undefined;
    }
    kept.add(path);
    return old;
  });
  return { doc, kept, issues };
}

/** Literal secrets: errors, except at `kept` paths (already in the file), which are warnings. */
function secretIssues(raw: Json, kept: Set<string> | 'all'): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  walk(raw, [], (value, at, key) => {
    if (key === undefined || !isSecretKey(key) || envRef(value) !== undefined || value === '') return undefined;
    const path = pointer(at);
    const old = kept === 'all' || kept.has(path);
    issues.push({
      path,
      code: 'inline_secret',
      severity: old ? 'warning' : 'error',
      message: old
        ? 'a literal secret is stored in the config file; move it to the env file and reference it as "env:NAME"'
        : 'secrets do not go into the config file: put the value in the env file (or the environment) and write "env:NAME"',
    });
    return undefined;
  });
  return issues;
}

/** Map a ConfigError message (`agents.x.harness: …`) to a JSON pointer when it names a key. */
function pathOfMessage(msg: string): string {
  const m = /^(?:invalid config: )?`?([A-Za-z_][\w-]*(?:\[\d+\])*(?:\.[\w-]+(?:\[\d+\])*)*)`?(?:[: ]|$)/.exec(msg);
  if (!m || !(m[1]!.split(/[.[]/)[0]! in ConfigFile.properties)) return '';
  return pointer(m[1]!.split('.').flatMap((s) => s.split(/\[(\d+)\]/).filter(Boolean)));
}

export interface ConfigStoreOptions {
  /** The config file (may not exist yet). */
  path: string;
  /** The env file `env:` references resolve from (default: found next to the config, as at startup). */
  envFile?: string;
  /** Process environment (default process.env); wins over the env file, as at startup. */
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

export type PutOutcome =
  | { status: 200; body: AdminConfigPutResult }
  | { status: 409; code: 'conflict'; message: string }
  | { status: 422; body: AdminConfigValidation };

export class ConfigStore {
  /** The file as the daemon started with it (canonical JSON), to tell whether a change needs a restart. */
  private readonly started: string;

  constructor(private readonly o: ConfigStoreOptions) {
    this.started = canonical(this.read().raw);
  }

  get path(): string {
    return this.o.path;
  }

  /** The env file provisioning writes to: the one in use, else `.env.live` next to the config. */
  envFilePath(): string {
    return this.o.envFile ?? findEnvFile({ configDir: dirname(this.o.path), ...(this.o.cwd ? { cwd: this.o.cwd } : {}) }) ?? join(dirname(this.o.path), '.env.live');
  }

  private env(): Record<string, string | undefined> {
    const file = this.o.envFile ?? findEnvFile({ configDir: dirname(this.o.path), ...(this.o.cwd ? { cwd: this.o.cwd } : {}) });
    let fileEnv: Record<string, string> = {};
    try {
      if (file && existsSync(file)) fileEnv = loadEnvFile(file);
    } catch {
      // an unreadable env file: references show as unset
    }
    return { ...fileEnv, ...(this.o.env ?? process.env) };
  }

  /** The file: its bytes' revision and parsed content ({} when missing). */
  read(): { raw: Json; revision: string; parseError?: string } {
    if (!existsSync(this.o.path)) return { raw: {}, revision: 'none' };
    const text = readFileSync(this.o.path, 'utf8');
    const revision = createHash('sha256').update(text).digest('hex').slice(0, 16);
    try {
      return { raw: JSON.parse(text), revision };
    } catch (e) {
      return { raw: {}, revision, parseError: (e as Error).message };
    }
  }

  document(): AdminConfigDocument {
    const { raw, revision, parseError } = this.read();
    const env = this.env();
    const issues = parseError ? [{ path: '', code: 'parse', message: `the file is not JSON: ${parseError}`, severity: 'error' as const }] : this.check(raw, 'all');
    return {
      path: this.o.path,
      revision,
      config: redact(raw) as Record<string, unknown>,
      issues,
      env: envRefs(raw).map((name) => ({ name, set: env[name] !== undefined })),
    };
  }

  /** Validate a document as `PUT` would (ADMIN_REDACTED keeps stored values). */
  validate(next: Record<string, unknown>): AdminConfigValidation {
    const r = this.prepare(next);
    return { valid: !r.issues.some((i) => i.severity === 'error'), issues: r.issues };
  }

  private prepare(next: Record<string, unknown>): { doc: Json; issues: ConfigIssue[] } {
    const { doc, kept, issues } = unredact(next, this.read().raw);
    return { doc, issues: [...issues, ...this.check(doc, kept)] };
  }

  /** Schema issues (with paths), literal secrets, then the startup checks. */
  private check(raw: Json, kept: Set<string> | 'all'): ConfigIssue[] {
    const issues: ConfigIssue[] = [];
    for (const e of Value.Errors(ConfigFile, raw)) {
      issues.push({ path: e.path, code: 'schema', message: e.message, severity: 'error' });
      if (issues.length >= 20) break;
    }
    issues.push(...secretIssues(raw, kept));
    if (!issues.some((i) => i.code === 'schema')) {
      try {
        resolveConfig(raw, { env: this.env(), baseDir: dirname(this.o.path), ...(this.o.cwd ? { cwd: this.o.cwd } : {}) });
      } catch (e) {
        if (!(e instanceof ConfigError)) throw e;
        issues.push({ path: pathOfMessage(e.message), code: 'invalid', message: e.message, severity: 'error' });
      }
    }
    return issues;
  }

  put(next: Record<string, unknown>, ifRevision?: string): PutOutcome {
    const cur = this.read();
    if (ifRevision !== undefined && ifRevision !== cur.revision) return { status: 409, code: 'conflict', message: `the config file changed (revision ${cur.revision}, not ${ifRevision}); reload it` };
    const { doc, issues } = this.prepare(next);
    if (issues.some((i) => i.severity === 'error')) return { status: 422, body: { valid: false, issues } };
    const revision = this.write(doc);
    return { status: 200, body: { revision, issues, applied: canonical(doc) === this.started ? 'live' : 'restart' } };
  }

  /** Change the file programmatically (bot provisioning); same atomic 0600 write, no secret checks. */
  update(fn: (raw: Record<string, unknown>) => Record<string, unknown>): string {
    const cur = this.read();
    if (cur.parseError) throw new ConfigError(`${this.o.path} is not JSON: ${cur.parseError}`);
    return this.write(fn(structuredClone(cur.raw) as Record<string, unknown>));
  }

  private write(doc: Json): string {
    const text = JSON.stringify(doc, null, 2) + '\n';
    writeFileAtomic(this.o.path, text);
    return createHash('sha256').update(text).digest('hex').slice(0, 16);
  }
}

/** Write via a temp file in the same directory, fsync, rename; the file ends up 0600. */
export function writeFileAtomic(path: string, text: string): void {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  const fd = openSync(tmp, 'wx', 0o600);
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      // already gone
    }
    throw e;
  }
}

function canonical(v: Json): string {
  const sort = (x: Json): Json =>
    Array.isArray(x) ? x.map(sort) : x && typeof x === 'object' ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, y]) => [k, sort(y)])) : x;
  return JSON.stringify(sort(v));
}
