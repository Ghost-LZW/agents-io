import { createHash } from 'node:crypto';
import { chmodSync, closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Value } from '@sinclair/typebox/value';
import { ADMIN_REDACTED, type AdminConfigDocument, type AdminConfigValidation, type ChannelModule, type ConfigIssue } from '@agents-io/protocol';
import {
  ConfigError,
  NO_REGISTRIES,
  canonical,
  configFileSchema,
  credentialMark,
  findEnvFile,
  loadEnvFile,
  resolveConfig,
  type ChannelRegistry,
  type Config,
  type ConfigStoreOptions,
  type ConsoleConfigStore,
  type HarnessRegistry,
  type ModuleRegistry,
  type PutOutcome,
} from '@agents-io/kernel';

/*
 * The config file as the console sees it (`GET/PUT /api/config`,
 * `POST /api/config/validate`). Secrets never leave the daemon. Which fields
 * are credentials follows the config schema (`isCredential`): every value of
 * an `env` map (harness instance, claude `mcpServers.<id>`, `settings.env`,
 * codex `mcp_servers.<id>.env`), every header (`headers`, `http_headers`,
 * anywhere), codex `bearer_token`s, external MCP clients' `token`; in a
 * channel entry, what its type marks (`ChannelModule`: a string at or under a
 * schema marked `x-credential`, e.g. a bridge's `env`; what its `isCredential`
 * says, e.g. a bridge argument after a secret-looking flag, mail `auth.pass` /
 * `auth.accessToken`, lark-bot `appSecret` / `encryptKey` /
 * `verificationToken`); and, in the free-form parts the daemon passes through
 * (channel `config`, `options`, …), any string under a secret-looking key. GET
 * shows a credential only as its `env:NAME` reference or ADMIN_REDACTED;
 * writing ADMIN_REDACTED back to a credential field keeps the stored value,
 * and any new literal in a credential field is refused (`inline_secret`; in a
 * channel entry with its type's advice when it has one, `credentialHint`: a
 * bridge argument is visible to other local users). Validation is the startup
 * one (`resolveConfig`, with the env file read afresh) over the registries the
 * next start would read the document with: the module files it names imported
 * first (`modules` entries, module channel files: `ConfigStoreOptions.importModules`,
 * as `aio serve` does at its start), else the daemon's. The same registries say
 * which variables it reads; which of its strings are credentials (redacted by
 * `GET`, kept for the marker and refused as literals by `PUT`) both they and the
 * daemon's say: a module channel file gone or changed since the start does not
 * unmark what its descriptor marked then. Writes are
 * atomic (temp file + fsync + rename) and 0600. The
 * daemon does not reload its config: a changed file (a module's config
 * section too) takes effect at the next start (`applied: "restart"`), except `channels`
 * with `console.liveChannels` (the gateway applies them and calls
 * `channelsApplied`).
 */

/** Keys whose string values are secrets, in the free-form parts of the config. */
const SECRET_KEY = /(secret|password|passwd|passphrase|token|api[-_]?key|credential|private[-_]?key|authorization|cookie|bearer)|^pass$/i;

/** Keys that name a variable holding a secret (codex `bearer_token_env_var`, `env_key`): not secrets themselves. */
const NAMES_A_VARIABLE = /(env_var|env_key|_var|Var|Env)$/;

const isSecretKey = (k: string) => SECRET_KEY.test(k) && !NAMES_A_VARIABLE.test(k);
const envRef = (v: unknown): string | undefined => (typeof v === 'string' && v.startsWith('env:') ? v.slice(4) : undefined);
const pointer = (segs: (string | number)[]) => segs.map((s) => '/' + String(s).replace(/~/g, '~0').replace(/\//g, '~1')).join('');

type Json = unknown;
type Path = (string | number)[];

/** Codex `config` keys are dotted TOML paths (`mcp_servers.x.env`); split them into segments. */
const tomlSegs = (k: string) => (k.match(/[A-Za-z0-9_][A-Za-z0-9_-]*|"[^"\\]*"/g) ?? [k]).map((x) => x.replace(/^"|"$/g, ''));

/**
 * The channel registries whose types say which strings of a document are credentials: one, or
 * several, where a string any of them marks is one (the console's: the document's own registries
 * and the daemon's, `ConfigStore`).
 */
export type CredentialMarks = ChannelRegistry | readonly ChannelRegistry[];

const eachRegistry = (marks: CredentialMarks): readonly ChannelRegistry[] => (typeof (marks as ChannelRegistry).get === 'function' ? [marks as ChannelRegistry] : (marks as readonly ChannelRegistry[]));

/**
 * The channel entry `at` is in (below `channels[<i>]`), when its type is registered in `channels`:
 * the type's module, the entry as the document has it, and `at` from the entry (`['args', '3']`).
 */
function channelAt(doc: Json, at: Path, channels: ChannelRegistry): { module: ChannelModule; entry: Record<string, unknown>; path: [string, ...string[]] } | undefined {
  if (at[0] !== 'channels' || at.length < 3) return undefined;
  const entry = get(doc, at.slice(0, 2));
  const type = entry && typeof entry === 'object' ? (entry as { type?: unknown }).type : undefined;
  const module = typeof type === 'string' ? channels.get(type) : undefined;
  return module ? { module, entry: entry as Record<string, unknown>, path: at.slice(2).map(String) as [string, ...string[]] } : undefined;
}

/**
 * Whether the string at `at` in `doc` is a credential, by where the config
 * schema (config.ts) puts it. A channel entry's type says for its own keys
 * (`channels`: the registry the document's types come from, default none,
 * `@agents-io/daemon`'s the built-in one; several: what any of their types for it marks): its
 * `x-credential` marks and `isCredential`.
 */
export function isCredential(doc: Json, at: Path, channels: CredentialMarks = NO_REGISTRIES.channelRegistry): boolean {
  const s = at.map(String);
  const leaf = s.at(-1);
  // `host.tokenFile` is a path, not the token.
  if (s[0] === 'host' && s[1] === 'tokenFile') return false;
  // So are the external MCP clients' `tokenFile`s; their `token` is an `env:` reference (a literal is refused at load).
  if (s[0] === 'externalMcp' && s[1] === 'clients' && s.length === 4 && leaf === 'tokenFile') return false;
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
  for (const registry of eachRegistry(channels)) {
    const ch = channelAt(doc, at, registry);
    if (!ch) continue;
    const [key, ...below] = ch.path;
    const own = Object.hasOwn(ch.module.entry, key) ? ch.module.entry[key] : undefined;
    if (credentialMark(own, below) || ch.module.isCredential?.(ch.path, ch.entry) === true) return true;
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
const literalCredential = (doc: Json, value: string, at: Path, channels: CredentialMarks) => value !== '' && envRef(value) === undefined && isCredential(doc, at, channels);

/** The document with every literal credential replaced by ADMIN_REDACTED (`channels`: as for `isCredential`). */
export function redact(raw: Json, channels: CredentialMarks = NO_REGISTRIES.channelRegistry): Json {
  return walk(raw, [], (value, at) => (literalCredential(raw, value, at, channels) ? ADMIN_REDACTED : undefined));
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
 * Every variable the document's channel entries read without naming it as `env:NAME`
 * (`ChannelModule.implicitEnv` of each entry's type, in entry order), each once, none of `skip`.
 * A type's answer that is no array of strings (or that throws: the document may not validate) gives none.
 */
export function implicitEnv(raw: Json, channels: ChannelRegistry = NO_REGISTRIES.channelRegistry, skip: readonly string[] = []): string[] {
  const out = new Set<string>();
  const entries = raw && typeof raw === 'object' ? (raw as { channels?: unknown }).channels : undefined;
  for (const entry of Array.isArray(entries) ? entries : []) {
    const type = entry && typeof entry === 'object' ? (entry as { type?: unknown }).type : undefined;
    const m = typeof type === 'string' ? channels.get(type) : undefined;
    if (!m?.implicitEnv) continue;
    let names: unknown;
    try {
      names = m.implicitEnv(entry);
    } catch {
      continue;
    }
    for (const n of Array.isArray(names) ? names : []) if (typeof n === 'string' && n && !skip.includes(n)) out.add(n);
  }
  return [...out];
}

/**
 * Put the stored values back where a document says ADMIN_REDACTED. Returns the
 * document and the paths kept that way; an ADMIN_REDACTED with no stored
 * literal at its path, or in a field that is not a credential (GET would show
 * the stored value there), is an issue (`channels`: as for `isCredential`).
 */
export function unredact(next: Json, stored: Json, channels: CredentialMarks = NO_REGISTRIES.channelRegistry): { doc: Json; kept: Set<string>; issues: ConfigIssue[] } {
  const kept = new Set<string>();
  const issues: ConfigIssue[] = [];
  const doc = walk(next, [], (value, at) => {
    if (value !== ADMIN_REDACTED) return undefined;
    const old = get(stored, at);
    const path = pointer(at);
    if (typeof old !== 'string' || old === ADMIN_REDACTED || !isCredential(next, at, channels) || !isCredential(stored, at, channels)) {
      issues.push({ path, code: 'redacted_without_value', message: `${ADMIN_REDACTED} keeps the stored value of a secret field, but the file has none here; write an "env:NAME" reference`, severity: 'error' });
      return undefined;
    }
    kept.add(path);
    return old;
  });
  return { doc, kept, issues };
}

/**
 * Literal secrets: errors, except at `kept` paths (already in the file), which are warnings. In a
 * channel entry its type may say what to do instead (`ChannelModule.credentialHint`; with several
 * registries, the first that does).
 */
function secretIssues(raw: Json, kept: Set<string> | 'all', channels: CredentialMarks): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  walk(raw, [], (value, at) => {
    if (!literalCredential(raw, value, at, channels)) return undefined;
    const path = pointer(at);
    const old = kept === 'all' || kept.has(path);
    const hint = eachRegistry(channels)
      .map((registry) => {
        const ch = channelAt(raw, at, registry);
        return ch?.module.credentialHint?.(ch.path, ch.entry);
      })
      .find((h) => typeof h === 'string' && h);
    issues.push({
      path,
      code: 'inline_secret',
      severity: old ? 'warning' : 'error',
      message:
        typeof hint === 'string' && hint
          ? hint
          : old
            ? 'a literal secret is stored in the config file; move it to the env file and reference it as "env:NAME"'
            : 'secrets do not go into the config file: put the value in the env file (or the environment) and write "env:NAME"',
    });
    return undefined;
  });
  return issues;
}

/** Each issue once (a file that does not import may fail the resolution with the same message). */
function distinct(issues: ConfigIssue[]): ConfigIssue[] {
  const seen = new Set<string>();
  return issues.filter((i) => {
    const k = JSON.stringify([i.path, i.code, i.message]);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Map a ConfigError message (`agents.x.harness: …`) to a JSON pointer when it names a key of the file (`file`: its schema). */
function pathOfMessage(msg: string, file: { properties: Record<string, unknown> }): string {
  const m = /^(?:invalid config: )?`?([A-Za-z_][\w-]*(?:\[\d+\])*(?:\.[\w-]+(?:\[\d+\])*)*)`?(?:[: ]|$)/.exec(msg);
  if (!m || !(m[1]!.split(/[.[]/)[0]! in file.properties)) return '';
  return pointer(m[1]!.split('.').flatMap((s) => s.split(/\[(\d+)\]/).filter(Boolean)));
}

/** The registries a document is read with. */
interface Registries {
  harnesses: HarnessRegistry;
  channels: ChannelRegistry;
  modules: ModuleRegistry;
  /**
   * Whose marks say which of its strings are credentials (`CredentialMarks`): `channels`, and the
   * daemon's when they are others. The daemon's `module` type knows the descriptors its start
   * imported, by each entry's `module` as written (`ChannelModuleFiles`): one whose file is gone or
   * resolves to another file since (a package upgraded, a file replaced) still marks what it marked.
   */
  marks: readonly ChannelRegistry[];
}

/**
 * The config file of a daemon (`ConsoleConfigStore`, the console's and the gateway's); the
 * `ConfigAccess` its modules' admin contributions get (`AdminContext.config`).
 */
export class ConfigStore implements ConsoleConfigStore {
  /**
   * The file as the running daemon reflects it: as it started, with `channels` replaced by
   * the ones last applied live. To tell whether a change needs a restart.
   */
  private running: Record<string, unknown>;
  /** The daemon's registries (`ConfigStoreOptions`). */
  private readonly daemon: Registries;

  constructor(private readonly o: ConfigStoreOptions) {
    const channels = o.channelRegistry ?? NO_REGISTRIES.channelRegistry;
    this.daemon = { harnesses: o.harnessRegistry ?? NO_REGISTRIES.harnessRegistry, channels, modules: o.moduleRegistry ?? NO_REGISTRIES.moduleRegistry, marks: [channels] };
    const raw = this.read().raw;
    this.running = raw && typeof raw === 'object' && !Array.isArray(raw) ? structuredClone(raw as Record<string, unknown>) : {};
  }

  /**
   * The registries `raw` is read with: with `importModules`, the module files it names imported
   * (cached by the module loader: a file imported before is not run again); a file that does not
   * import is an issue, and `raw` is then read with the daemon's. Without it, the daemon's. Its
   * credentials are what these and the daemon's mark (`Registries.marks`): a module channel file
   * that cannot be found now is the resolution's issue, never a reason to show what it marked.
   */
  private async registriesOf(raw: Json): Promise<{ regs: Registries; issues: ConfigIssue[] }> {
    if (!this.o.importModules) return { regs: this.daemon, issues: [] };
    try {
      const r = await this.o.importModules(raw, { baseDir: dirname(this.o.path) });
      const marks = r.channelRegistry === this.daemon.channels ? this.daemon.marks : [r.channelRegistry, this.daemon.channels];
      return { regs: { harnesses: this.daemon.harnesses, channels: r.channelRegistry, modules: r.moduleRegistry, marks }, issues: [] };
    } catch (e) {
      if (!(e instanceof ConfigError)) throw e;
      const file = configFileSchema(this.daemon.harnesses, this.daemon.channels, this.daemon.modules);
      return { regs: this.daemon, issues: [{ path: pathOfMessage(e.message, file), code: 'invalid', message: e.message, severity: 'error' }] };
    }
  }

  /** `live` when the running daemon matches `doc`, else `restart`. */
  appliedOf(doc: Json): 'live' | 'restart' {
    return canonical(doc) === canonical(this.running) ? 'live' : 'restart';
  }

  /** The daemon now runs the `channels` of `doc`. */
  channelsApplied(doc: Json): void {
    const ch = doc && typeof doc === 'object' ? (doc as { channels?: unknown }).channels : undefined;
    const { channels: _old, ...rest } = this.running;
    this.running = ch === undefined ? rest : { ...rest, channels: structuredClone(ch) };
  }

  /** The startup resolution of `raw` with the daemon's registries, the env file read afresh (throws `ConfigError`). */
  resolve(raw: Json): Config {
    return this.resolveWith(raw, this.daemon);
  }

  /** `resolve` with `regs`. */
  private resolveWith(raw: Json, regs: Registries): Config {
    return resolveConfig(raw, { env: this.env(), baseDir: dirname(this.o.path), ...(this.o.cwd ? { cwd: this.o.cwd } : {}), harnessRegistry: regs.harnesses, channelRegistry: regs.channels, moduleRegistry: regs.modules });
  }

  /**
   * The startup resolution of `raw` with the registries the next start would read it with (its
   * module files imported, `importModules`), and the channel registry among them: what a channel
   * applied live is built with. Throws `ConfigError` (a file that does not import too).
   */
  async resolveImported(raw: Json): Promise<{ config: Config; channelRegistry: ChannelRegistry }> {
    const { regs, issues } = await this.registriesOf(raw);
    if (issues.length) throw new ConfigError(issues[0]!.message);
    return { config: this.resolveWith(raw, regs), channelRegistry: regs.channels };
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

  /** Every variable `value` references as `"env:NAME"` (`envRefs`). */
  envRefs(value: unknown): string[] {
    return envRefs(value);
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

  /** The file as `GET /api/config` shows it: read with the registries of its module files (`registriesOf`). */
  async document(): Promise<AdminConfigDocument> {
    const { raw, revision, parseError } = this.read();
    const env = this.env();
    const { regs, issues: unimported } = parseError ? { regs: this.daemon, issues: [] } : await this.registriesOf(raw);
    const issues = parseError ? [{ path: '', code: 'parse', message: `the file is not JSON: ${parseError}`, severity: 'error' as const }] : distinct([...unimported, ...this.check(raw, 'all', regs)]);
    return {
      path: this.o.path,
      revision,
      config: redact(raw, regs.marks) as Record<string, unknown>,
      issues,
      env: [
        ...envRefs(raw).map((name) => ({ name, set: env[name] !== undefined })),
        // What a channel entry reads without an `env:` reference: its type says (`ChannelModule.implicitEnv`).
        ...implicitEnv(raw, regs.channels, envRefs(raw)).map((name) => ({ name, set: env[name] !== undefined, implicit: true })),
      ],
    };
  }

  /** Validate a document as `PUT` would (ADMIN_REDACTED keeps stored values). */
  async validate(next: Record<string, unknown>): Promise<AdminConfigValidation> {
    const r = await this.prepare(next, this.read().raw);
    return { valid: !r.issues.some((i) => i.severity === 'error'), issues: r.issues };
  }

  /** `next` as it would replace `stored`, and its issues, read with the registries of its module files. */
  private async prepare(next: Record<string, unknown>, stored: Json): Promise<{ doc: Json; issues: ConfigIssue[] }> {
    const { regs, issues: unimported } = await this.registriesOf(next);
    const { doc, kept, issues } = unredact(next, stored, regs.marks);
    return { doc, issues: distinct([...unimported, ...issues, ...this.check(doc, kept, regs)]) };
  }

  /** Schema issues (with paths), literal secrets, then the startup checks (with `regs`). */
  private check(raw: Json, kept: Set<string> | 'all', regs: Registries): ConfigIssue[] {
    const issues: ConfigIssue[] = [];
    const file = configFileSchema(regs.harnesses, regs.channels, regs.modules);
    for (const e of Value.Errors(file, raw)) {
      issues.push({ path: e.path, code: 'schema', message: e.message, severity: 'error' });
      if (issues.length >= 20) break;
    }
    issues.push(...secretIssues(raw, kept, regs.marks));
    if (!issues.some((i) => i.code === 'schema')) {
      try {
        const c = this.resolveWith(raw, regs);
        // A daemon that imports no module files would not start on a `modules` entry (`Gateway.start`).
        if (!this.o.importModules) {
          for (const [i, e] of (c.moduleEntries ?? []).entries())
            if (!regs.modules.fromEntry(e)) issues.push({ path: `/modules/${i}`, code: 'invalid', message: `modules[${i}] (module ${e.module}) is not loaded: this daemon imports no module files of its config, so it would not start on this file`, severity: 'error' });
        }
      } catch (e) {
        if (!(e instanceof ConfigError)) throw e;
        issues.push({ path: pathOfMessage(e.message, file), code: 'invalid', message: e.message, severity: 'error' });
      }
    }
    return issues;
  }

  async put(next: Record<string, unknown>, ifRevision?: string): Promise<PutOutcome> {
    for (;;) {
      const cur = this.read();
      if (ifRevision !== undefined && ifRevision !== cur.revision) return { status: 409, code: 'conflict', message: `the config file changed (revision ${cur.revision}, not ${ifRevision}); reload it` };
      const { doc, issues } = await this.prepare(next, cur.raw);
      // Changed while its module files were imported: again, against the file as it is now.
      if (this.read().revision !== cur.revision) continue;
      if (issues.some((i) => i.severity === 'error')) return { status: 422, body: { valid: false, issues } };
      const revision = this.write(doc);
      return { status: 200, body: { revision, issues, applied: this.appliedOf(doc) } };
    }
  }

  /** Change the file programmatically (a module's admin route); same atomic 0600 write, no secret checks. */
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
    // Synchronous (`ConfigAccess`): with the daemon's registries; module files written since its start were checked when written.
    const issues = this.check(doc, 'all', this.daemon).filter((i) => i.severity === 'error');
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
