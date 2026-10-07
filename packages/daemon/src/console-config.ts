import { createHash } from 'node:crypto';
import { chmodSync, closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Value } from '@sinclair/typebox/value';
import { ADMIN_REDACTED, type AdminConfigDocument, type AdminConfigPutResult, type AdminConfigValidation, type ConfigIssue } from '@agents-io/protocol';
import { loadEnvFile } from '@agents-io/testkit';
import { ConfigError, ConfigFile, findEnvFile, resolveConfig } from './config.js';

/*
 * The config file as the console sees it (`GET/PUT /api/config`,
 * `POST /api/config/validate`). Secrets never leave the daemon. Which fields
 * are credentials follows the config schema (`isCredential`): every value of
 * an `env` map (harness instance, claude `mcpServers.<id>`, `settings.env`,
 * bridge channel, codex `mcp_servers.<id>.env`), every header (`headers`,
 * `http_headers`, anywhere), codex `bearer_token`s, mail `auth.pass` /
 * `auth.accessToken`, lark-bot `appSecret` / `encryptKey` /
 * `verificationToken`, a bridge argument after a secret-looking flag; and, in
 * the free-form parts the daemon passes through (channel `config`, `options`,
 * …), any string under a secret-looking key. GET shows a credential only as
 * its `env:NAME` reference or ADMIN_REDACTED; writing ADMIN_REDACTED back to a
 * credential field keeps the stored value, and any new literal in a credential
 * field is refused (`inline_secret`). Validation is the startup one
 * (`resolveConfig`, with the env file read afresh). Writes are atomic (temp
 * file + fsync + rename) and 0600. The daemon does not reload its config: a
 * changed file takes effect at the next start (`applied: "restart"`).
 */

/** Keys whose string values are secrets, in the free-form parts of the config. */
const SECRET_KEY = /(secret|password|passwd|passphrase|token|api[-_]?key|credential|private[-_]?key|authorization|cookie|bearer)|^pass$/i;

/** Keys that name a variable holding a secret (codex `bearer_token_env_var`, `env_key`): not secrets themselves. */
const NAMES_A_VARIABLE = /(env_var|env_key|_var|Var|Env)$/;

const isSecretKey = (k: string) => SECRET_KEY.test(k) && !NAMES_A_VARIABLE.test(k);
/** A command-line flag naming a secret (`--token`, `--api-key=`): the next argument (or its value) is one. */
const SECRET_FLAG = /^--?[\w-]*(secret|password|passwd|token|api[-_]?key|credential|auth)[\w-]*$/i;
const envRef = (v: unknown): string | undefined => (typeof v === 'string' && v.startsWith('env:') ? v.slice(4) : undefined);
const pointer = (segs: (string | number)[]) => segs.map((s) => '/' + String(s).replace(/~/g, '~0').replace(/\//g, '~1')).join('');

type Json = unknown;
type Path = (string | number)[];

/** Codex `config` keys are dotted TOML paths (`mcp_servers.x.env`); split them into segments. */
const tomlSegs = (k: string) => (k.match(/[A-Za-z0-9_][A-Za-z0-9_-]*|"[^"\\]*"/g) ?? [k]).map((x) => x.replace(/^"|"$/g, ''));

/**
 * Whether the string at `at` in `doc` is a credential, by where the config
 * schema (config.ts) puts it.
 */
export function isCredential(doc: Json, at: Path): boolean {
  const s = at.map(String);
  const leaf = s.at(-1);
  // Header values, anywhere (claude mcpServers `headers`, codex `http_headers`, options passed through).
  if (s.slice(0, -1).some((x) => x === 'headers' || x === 'http_headers' || /(^|\.)http_headers$/.test(x))) return true;
  if (s[0] === 'harnesses' && s.length >= 4) {
    const rest = s.slice(2);
    if (rest[0] === 'env') return true;
    if (rest[0] === 'mcpServers' && rest[2] === 'env') return true;
    if (rest[0] === 'settings' && rest[1] === 'env') return true;
    if (rest[0] === 'config') {
      // codex: `mcp_servers.<id>.env.VAR`, `…bearer_token`, `…experimental_bearer_token`
      const segs = rest.slice(1).flatMap(tomlSegs);
      const [last, parent] = [segs.at(-1), segs.at(-2)];
      if (parent === 'env' || last === 'bearer_token' || last === 'experimental_bearer_token') return true;
    }
  }
  if (s[0] === 'channels' && s.length >= 3) {
    const ch = get(doc, at.slice(0, 2)) as { type?: unknown; args?: unknown } | undefined;
    const rest = s.slice(2);
    if (ch?.type === 'bridge' && rest[0] === 'env') return true;
    if (ch?.type === 'bridge' && rest[0] === 'args' && rest.length === 2) {
      const args = Array.isArray(ch.args) ? ch.args : [];
      const i = Number(rest[1]);
      const prev = args[i - 1];
      const self = args[i];
      if (typeof prev === 'string' && SECRET_FLAG.test(prev)) return true;
      if (typeof self === 'string' && self.includes('=') && SECRET_FLAG.test(self.slice(0, self.indexOf('=')))) return true;
      return false;
    }
    if (ch?.type === 'mail' && rest[0] === 'config' && (rest[1] === 'imap' || rest[1] === 'smtp') && rest[2] === 'auth' && (leaf === 'pass' || leaf === 'accessToken')) return true;
    if (ch?.type === 'lark-bot' && rest[0] === 'config' && rest.length === 2 && (leaf === 'appSecret' || leaf === 'encryptKey' || leaf === 'verificationToken')) return true;
  }
  // Free-form parts: a secret-looking key.
  const key = [...at].reverse().find((x): x is string => typeof x === 'string');
  return key !== undefined && isSecretKey(key);
}

/** Walk every string leaf with its path (object keys and array indexes). */
function walk(v: Json, at: Path, visit: (value: string, at: Path) => string | undefined): Json {
  if (typeof v === 'string') return visit(v, at) ?? v;
  if (Array.isArray(v)) return v.map((x, i) => walk(x, [...at, i], visit));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, [...at, k], visit)]));
  return v;
}

function get(v: Json, at: Path): Json {
  let cur = v;
  for (const s of at) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string | number, Json>)[s];
  }
  return cur;
}

/** A literal (not an `env:` reference, not empty) in a credential field. */
const literalCredential = (doc: Json, value: string, at: Path) => value !== '' && envRef(value) === undefined && isCredential(doc, at);

/** The document with every literal credential replaced by ADMIN_REDACTED. */
export function redact(raw: Json): Json {
  return walk(raw, [], (value, at) => (literalCredential(raw, value, at) ? ADMIN_REDACTED : undefined));
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
 * literal at its path, or in a field that is not a credential (GET would show
 * the stored value there), is an issue.
 */
export function unredact(next: Json, stored: Json): { doc: Json; kept: Set<string>; issues: ConfigIssue[] } {
  const kept = new Set<string>();
  const issues: ConfigIssue[] = [];
  const doc = walk(next, [], (value, at) => {
    if (value !== ADMIN_REDACTED) return undefined;
    const old = get(stored, at);
    const path = pointer(at);
    if (typeof old !== 'string' || old === ADMIN_REDACTED || !isCredential(next, at) || !isCredential(stored, at)) {
      issues.push({ path, code: 'redacted_without_value', message: `${ADMIN_REDACTED} keeps the stored value of a secret field, but the file has none here; write an "env:NAME" reference`, severity: 'error' });
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
  walk(raw, [], (value, at) => {
    if (!literalCredential(raw, value, at)) return undefined;
    const path = pointer(at);
    const old = kept === 'all' || kept.has(path);
    const arg = at[0] === 'channels' && at[2] === 'args';
    issues.push({
      path,
      code: 'inline_secret',
      severity: old ? 'warning' : 'error',
      message: arg
        ? 'a secret on the bridge command line is visible to other local users (ps); pass it in the bridge env ("env": { "NAME": "env:NAME" })'
        : old
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

  /** The value of one variable (same lookup as `defined`). Stays in the daemon: provisioning compares app ids with it. */
  lookup(name: string): string | undefined {
    const v = this.env()[name];
    return v === '' ? undefined : v;
  }

  /** Which of `names` the env file or the environment sets (names only; values never leave). */
  defined(names: string[]): string[] {
    const env = this.env();
    return names.filter((n) => env[n] !== undefined && env[n] !== '');
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

  /**
   * `update`, but only if the result passes the checks `PUT` runs (schema, the
   * startup validation with the env file read afresh; literal secrets already in
   * the file stay warnings): otherwise nothing is written and the issues come back.
   * Errors thrown by `fn` propagate (nothing written).
   */
  updateValidated(fn: (raw: Record<string, unknown>) => Record<string, unknown>): { ok: true; revision: string } | { ok: false; issues: ConfigIssue[] } {
    const cur = this.read();
    if (cur.parseError) throw new ConfigError(`${this.o.path} is not JSON: ${cur.parseError}`);
    const doc = fn(structuredClone(cur.raw) as Record<string, unknown>);
    const issues = this.check(doc, 'all').filter((i) => i.severity === 'error');
    if (issues.length) return { ok: false, issues };
    return { ok: true, revision: this.write(doc) };
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
