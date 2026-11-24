import { homedir } from 'node:os';
import { join } from 'node:path';
import { Type, type Static } from '@sinclair/typebox';
import type { HarnessChildSecrets, HarnessModule, HarnessResolveContext } from '@agents-io/protocol';
import { CODEX_DECLARATIONS, CodexHarness, type CodexTransportOption } from './harness.js';
import type { CodexProfile } from './map.js';

/*
 * The Codex harness kind (`use: "codex"`, and the `codex` section of the older `harness` block):
 * its config keys, defaults and construction. The daemon registers it in its bundle.
 */

const Closed = { additionalProperties: false } as const;

const Transport = Type.Union([
  Type.Object({ kind: Type.Literal('stdio') }, Closed),
  Type.Object(
    {
      kind: Type.Literal('unix'),
      spawn: Type.Union([Type.Literal('own'), Type.Literal('daemon'), Type.Literal('none')]),
      path: Type.Optional(Type.String()),
      stateDir: Type.Optional(Type.String()),
      reconnectWindowMs: Type.Optional(Type.Number()),
    },
    Closed,
  ),
]);

/** A `use: "codex"` instance's own keys (beside `use`, `env`, `cwd`, `run`, `profiles`, `options`). */
const Instance = Type.Object({
  /** CODEX_HOME: config.toml, auth, sessions, skills (default ~/.codex). */
  home: Type.Optional(Type.String()),
  /** The `codex` binary (default `codex` on PATH). */
  executable: Type.Optional(Type.String()),
  /** Dotted key → value, passed as `-c key=<TOML>` to `codex app-server` (argv: "env:NAME" only where Codex can name a variable). */
  config: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  enable: Type.Optional(Type.Array(Type.String())),
  disable: Type.Optional(Type.Array(Type.String())),
  transport: Type.Optional(Transport),
  /** Realtime voice (decision 11): opt the app-server connection into Codex's experimental realtime API, so `live_join` works. Default false. */
  live: Type.Optional(Type.Boolean()),
  /** Not supported: `codex app-server` rejects --profile (checked: codex-cli 0.160, 0.171). Listed to give a clear error. */
  profile: Type.Optional(Type.String()),
});

/** The older block's `harness.codex` section (beside `run`, `profiles`, `options`). */
const LegacySection = Type.Object({ bin: Type.Optional(Type.String()), transport: Type.Optional(Transport) });

/** Codex launch settings (CodexHarnessOptions): what an instance's entry resolves to (`HarnessInstance.launch`). */
export interface CodexLaunch {
  bin?: string;
  codexHome?: string;
  config?: Record<string, unknown>;
  enable?: string[];
  disable?: string[];
  transport: CodexTransportOption;
  live?: boolean;
}

/** Where a codex instance keeps its socket, server record and turn snapshots unless it sets `transport.stateDir`. */
export function codexStateDir(name: string): string {
  return join(homedir(), '.agents-io', `codex.${name}`);
}

const pathish = (p: string) => p.startsWith('~') || p.startsWith('.') || p.includes('/');

function transportOf(t: Static<typeof Transport> | undefined, defaultStateDir: string | undefined, path: (p: string) => string): CodexTransportOption {
  if (!t || t.kind === 'stdio') return { kind: 'stdio' };
  const stateDir = t.stateDir ? path(t.stateDir) : defaultStateDir;
  return { ...t, ...(t.path ? { path: path(t.path) } : {}), ...(stateDir ? { stateDir } : {}) };
}

export const codexHarnessModule: HarnessModule<CodexLaunch> = {
  kind: 'codex',
  schema: Instance,
  defaults: { model: '', modelEnv: 'AGENTS_IO_LIVE_CODEX_MODEL', configDirEnv: ['CODEX_HOME'] },
  declares: CODEX_DECLARATIONS,
  legacy: {
    schema: LegacySection,
    envPrefixes: ['OPENAI_', 'CODEX_'],
    // stateDir stays the adapter default (~/.agents-io/codex), so a running deployment keeps adopting its turns.
    resolve: (s, ctx) => {
      const x = s as Static<typeof LegacySection>;
      return { ...(x.bin ? { bin: x.bin } : {}), transport: transportOf(x.transport, undefined, ctx.path) };
    },
  },

  resolve(entry, ctx) {
    const x = entry as Static<typeof Instance>;
    const where = ctx.where;
    if (x.profile !== undefined)
      ctx.fail(`${where}.profile: \`codex app-server\` does not accept --profile (codex-cli 0.160 rejects it, and \`-c profile=…\` is legacy); use \`config\` keys or a separate \`home\``);
    if ('CODEX_HOME' in ctx.env && x.home) ctx.fail(`${where}: set \`home\` or env.CODEX_HOME, not both`);
    const transport = transportOf(x.transport, codexStateDir(ctx.name), ctx.path);
    if ((x.config && Object.keys(x.config).length) || x.enable?.length || x.disable?.length) {
      if (transport.kind === 'unix' && transport.spawn !== 'own')
        ctx.fail(`${where}: config/enable/disable only apply to a server the gateway starts (stdio or unix spawn "own"), not spawn "${transport.spawn}"`);
    }
    const launch: CodexLaunch = {
      ...(x.executable ? { bin: pathish(x.executable) ? ctx.path(x.executable) : x.executable } : {}),
      ...(x.home ? { codexHome: ctx.path(x.home) } : {}),
      ...(x.config ? { config: codexConfigViaEnv(x.config, `${where}.config`, ctx) } : {}),
      ...(x.enable ? { enable: x.enable } : {}),
      ...(x.disable ? { disable: x.disable } : {}),
      ...(x.live ? { live: true } : {}),
      transport,
    };
    return { launch };
  },

  // Two codex instances must never share a server record or turn snapshots: restart adoption would cross them.
  checkAll(instances) {
    const dirs = new Map<string, string>();
    for (const i of instances) {
      const t = i.launch.transport;
      if (t.kind !== 'unix') continue;
      const dir = t.stateDir ?? '(default ~/.agents-io/codex)';
      const other = dirs.get(dir);
      if (other) return `harnesses ${other} and ${i.name} use the same codex stateDir ${dir}; give each its own`;
      dirs.set(dir, i.name);
    }
    return undefined;
  },

  create(init) {
    const x = init.launch;
    return new CodexHarness({
      bin: x.bin ?? 'codex',
      env: init.env,
      transport: x.transport,
      profiles: init.profiles as Record<string, CodexProfile>,
      ...(x.codexHome ? { codexHome: x.codexHome } : {}),
      ...(x.config ? { config: x.config } : {}),
      ...(x.enable ? { enable: x.enable } : {}),
      ...(x.disable ? { disable: x.disable } : {}),
      ...(x.live ? { live: true } : {}),
      ...(init.blobs ? { blobs: init.blobs } : {}),
    });
  },
};

const VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const envRef = (v: unknown): string | undefined => (typeof v === 'string' && v.startsWith('env:') ? v.slice(4) : undefined);
const TOML_SEG = /[A-Za-z0-9_][A-Za-z0-9_-]*|"[^"\\]*"/g;
const tomlKey = (segs: string[]) => segs.map((x) => (/^[A-Za-z0-9_-]+$/.test(x) ? x : JSON.stringify(x))).join('.');

/**
 * Codex `config` (passed as `-c key=value`): each "env:NAME" is replaced by the Codex setting
 * that names a variable instead of holding the value, with the value in the app-server's env:
 * `…http_headers.H` → `…env_http_headers.H`, `…bearer_token` → `…bearer_token_env_var`,
 * `…experimental_bearer_token` → `…env_key`, `mcp_servers.<id>.env.VAR` → `mcp_servers.<id>.env_vars`.
 * Anywhere else it is an error.
 */
function codexConfigViaEnv(config: Record<string, unknown>, at: string, ctx: Pick<HarnessResolveContext, 'fail'> & { secrets: HarnessChildSecrets }): Record<string, unknown> {
  const s = ctx.secrets;
  const DROP = Symbol('drop');
  const extra: [string, unknown][] = [];
  const forward = new Map<string, string[]>();
  const visit = (v: unknown, segs: string[]): unknown => {
    const name = envRef(v);
    if (name !== undefined) {
      const where = `${at}.${segs.join('.')}`;
      const [last, parent] = [segs.at(-1)!, segs.at(-2)];
      const value = s.value(name, where);
      if (parent === 'env' && segs.length >= 3 && VAR_NAME.test(last)) {
        // A stdio MCP server's env: forward the variable from the app-server's environment.
        const server = tomlKey(segs.slice(0, -2));
        forward.set(server, [...(forward.get(server) ?? []), last]);
        if (value !== undefined) s.toChild(last, value, where);
        return DROP;
      }
      let key: string[] | undefined;
      if (parent === 'http_headers') key = [...segs.slice(0, -2), 'env_http_headers', last];
      else if (last === 'bearer_token') key = [...segs.slice(0, -1), 'bearer_token_env_var'];
      else if (last === 'experimental_bearer_token') key = [...segs.slice(0, -1), 'env_key'];
      if (!key)
        ctx.fail(
          `${where}: "env:" values would be on the codex app-server command line, visible to other local users via ps; ` +
            'use a setting that names a variable (http_headers → env_http_headers, bearer_token → bearer_token_env_var, ' +
            'experimental_bearer_token → env_key, mcp_servers.<id>.env.<VAR>) or write a non-secret value literally',
        );
      if (value !== undefined) s.toChild(name, value, where);
      extra.push([tomlKey(key), name]);
      return DROP;
    }
    if (Array.isArray(v)) return v.map((x, i) => visit(x, [...segs, `[${i}]`]));
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) {
        const r = visit(x, [...segs, k]);
        if (r !== DROP) out[k] = r;
      }
      return out;
    }
    return v;
  };
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(config)) {
    const segs = (k.match(TOML_SEG) ?? [k]).map((x) => x.replace(/^"|"$/g, ''));
    const r = visit(v, segs);
    if (r !== DROP) out[k] = r;
  }
  for (const [k, v] of extra) out[k] = v;
  for (const [server, vars] of forward) out[`${server}.env_vars`] = vars;
  return out;
}
