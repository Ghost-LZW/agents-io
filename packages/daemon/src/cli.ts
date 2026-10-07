#!/usr/bin/env node
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import type { ContentBlock, RenderedMessage, ReplyRoute, RunEnded, SessionEvent, Tier } from '@agents-io/protocol';
import { runAttach } from './attach.js';
import { CommandError, DaemonUnavailable, LocalClient } from './client.js';
import { ConfigError, defaultInstance, loadConfig, type LoadOptions } from './config.js';
import { consoleProof } from './console.js';
import { runScenarios } from './e2e.js';
import { Gateway, buildHarness } from './gateway.js';
import { TokenError, consoleUrlPath, readTokenFile, tokenPath } from './token.js';
import { WATCH_SPEC_HELP, formatWatch, parseDuration, parseWatchSpec } from './watch-spec.js';

const USAGE = `aio: the agents-io daemon and its CLI

daemon
  aio serve     [--harness <instance>]
  aio e2e       [--harness <instance>] [--only <id|name>[,…]] [--data-dir <dir>] [--verbose]

local ends (as the local principal)
  aio attach    [--session <key>] [--tier full|card|headline|final] [--from <seq>] [--verbose]
  aio input     [--session <key>] [--mode queue|steer|interrupt] [--wait] <text…>
  aio sessions
  aio watch     add [--session <target>] key=value… | list [--session <target>] | remove <id>

host commands (authenticate with the token file next to the socket; docs/HOSTS.md §5)
  aio run       --agent <task agent> [--run-id <id>] [--cwd <dir>] [--env K=V …] [--timeout 10m]
                [--observe <route json> …] -- <instruction text>     (blocks; exits with the run's exit code)
  aio send      --route <route json> --operation-id <id> [--file message.json|-] [--text <text>]
  aio tail      --consumer <name> [--from <cursor>] [--once]          (JSON lines, each with its cursor)
  aio ack       --consumer <name> <cursor>
  aio bindings  put [--file table.json|-] | get
  aio explain   <inputId>
  aio verify    <channelRef>                                          (channel:<channel>/<message id>)

console (HTTP + WebSocket API for web UIs, on 127.0.0.1:7464 by default; config \`console\`)
  aio console-link                                                    (prints a one-time login URL, valid 5 min)

watch keys: ${WATCH_SPEC_HELP}

--harness: a name from \`harnesses\` (or claude-code|codex: that kind's first instance)
run exit codes: 0 completed, 1 failed, 3 ambiguous, 124 timed out, 130 interrupted
other exit codes: 1 failed, 2 usage/config error, 69 daemon not running, 77 not authorized

common: --config <aio.config.json> (or $AIO_CONFIG)  --env-file <.env.live>
        --socket <path> (or $AIO_SOCKET; default from the config)  --name <host name> (default aio-<command>)`;

const TIERS = ['full', 'card', 'headline', 'final'];

export interface CliArgs {
  cmd: string;
  values: Record<string, string | boolean | string[] | undefined>;
  rest: string[];
}

export function parseCli(argv: string[]): CliArgs {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        config: { type: 'string' },
        'env-file': { type: 'string' },
        socket: { type: 'string' },
        name: { type: 'string' },
        harness: { type: 'string' },
        session: { type: 'string' },
        tier: { type: 'string' },
        from: { type: 'string' },
        mode: { type: 'string' },
        only: { type: 'string' },
        'data-dir': { type: 'string' },
        wait: { type: 'boolean' },
        verbose: { type: 'boolean', short: 'v' },
        'no-color': { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
        agent: { type: 'string' },
        'run-id': { type: 'string' },
        cwd: { type: 'string' },
        env: { type: 'string', multiple: true },
        timeout: { type: 'string' },
        observe: { type: 'string', multiple: true },
        quiet: { type: 'boolean', short: 'q' },
        route: { type: 'string' },
        'operation-id': { type: 'string' },
        file: { type: 'string' },
        text: { type: 'string' },
        consumer: { type: 'string' },
        once: { type: 'boolean' },
        limit: { type: 'string' },
      },
    });
  } catch (e) {
    throw new ConfigError((e as Error).message);
  }
  const { values, positionals } = parsed;
  const [cmd = 'help', ...rest] = positionals;
  if (values.tier !== undefined && !TIERS.includes(values.tier)) throw new ConfigError(`--tier must be one of ${TIERS.join(', ')}`);
  if (values.from !== undefined && !/^\d+$/.test(values.from)) throw new ConfigError(cmd === 'tail' ? '--from must be a cursor number' : '--from must be a seq number');
  if (values.mode !== undefined && !['queue', 'steer', 'interrupt'].includes(values.mode)) throw new ConfigError('--mode must be queue, steer or interrupt');
  if (values.limit !== undefined && !/^[1-9]\d*$/.test(values.limit)) throw new ConfigError('--limit must be a positive number');
  return { cmd: values.help ? 'help' : cmd, values, rest };
}

const str = (a: CliArgs, k: string) => (typeof a.values[k] === 'string' ? (a.values[k] as string) : undefined);
const list = (a: CliArgs, k: string) => (Array.isArray(a.values[k]) ? (a.values[k] as string[]) : []);

function need(a: CliArgs, k: string): string {
  const v = str(a, k);
  if (!v) throw new ConfigError(`${a.cmd}: --${k} is required`);
  return v;
}

function config(a: CliArgs, extra: Partial<LoadOptions> = {}) {
  return loadConfig({
    ...(str(a, 'config') ? { path: str(a, 'config') } : {}),
    ...(str(a, 'env-file') ? { envFile: str(a, 'env-file') } : {}),
    ...(str(a, 'harness') ? { harness: str(a, 'harness') } : {}),
    ...extra,
  });
}

/** The daemon's socket: --socket, $AIO_SOCKET, else the config's `socketPath`. */
export function socketOf(a: CliArgs, env: NodeJS.ProcessEnv = process.env): string {
  const s = str(a, 'socket') ?? env.AIO_SOCKET;
  return s ? resolve(s) : config(a, { channels: false }).socketPath;
}

/** Connect and authenticate as a host (not THE host: no consumer, no callouts). */
async function hostClient(a: CliArgs): Promise<LocalClient> {
  const socket = socketOf(a);
  const token = readTokenFile(tokenPath(socket));
  const client = await LocalClient.connect(socket);
  try {
    await client.hello({ token, name: str(a, 'name') ?? `aio-${a.cmd}` });
  } catch (e) {
    client.close();
    throw e;
  }
  return client;
}

async function readInput(file: string | undefined): Promise<string> {
  if (file !== undefined && file !== '-') {
    try {
      return readFileSync(file, 'utf8');
    } catch (e) {
      throw new ConfigError(`cannot read ${file}: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`);
    }
  }
  if (process.stdin.isTTY) throw new ConfigError('reading JSON from stdin, but stdin is a terminal (pipe it, or use --file)');
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function json<T>(text: string, what: string): T {
  try {
    return JSON.parse(text) as T;
  } catch (e) {
    throw new ConfigError(`${what} is not JSON: ${(e as Error).message}`);
  }
}

const print = (v: unknown) => console.log(JSON.stringify(v, null, 2));

async function serve(a: CliArgs): Promise<number> {
  const c = config(a);
  const gw = await Gateway.start({ config: c, console: c.console.enabled, logger: (level, msg) => console.error(`[aio] ${level}: ${msg}`) });
  let version = 'not probed';
  try {
    version = (await gw.harness().probe()).version;
  } catch (e) {
    console.error(`[aio] warn: harness probe failed: ${(e as Error).message}`);
  }
  console.error(`[aio] serving on ${c.socketPath} (host token in ${tokenPath(c.socketPath)})`);
  // Names and kinds only: instance env values are secrets.
  const instances = Object.values(c.harnesses).map((i) => `${i.name} (${i.kind}${i.name === c.defaultHarness ? `, default, ${version}` : ''})`);
  console.error(`[aio] harnesses: ${instances.join(', ')}; log ${c.logPath}; local principal ${c.local.principal.id}; default session ${c.local.session}`);
  const agents = Object.values(c.agents).map((x) => `${x.name} (${x.mode}, ${x.harness}${x.name === c.defaultAgent ? ', default' : ''})`);
  console.error(`[aio] agents: ${agents.join(', ') || 'none'}; bindings: ${c.table ? `${c.table.bindings.length} from config` : 'owners default table'}`);
  console.error(`[aio] channels: ${c.channels.map((ch) => ch.type).join(', ') || 'none'}; owners: ${c.policy.owners.length}`);
  if (gw.console) console.error(`[aio] console API on ${gw.console.url} (login link: aio console-link)`);
  await new Promise<void>((done) => {
    let stopping = false;
    const stop = (sig: string) => {
      if (stopping) process.exit(130);
      stopping = true;
      console.error(`[aio] ${sig}: stopping (again to force)`);
      void gw.stop().finally(done);
    };
    process.on('SIGINT', () => stop('SIGINT'));
    process.on('SIGTERM', () => stop('SIGTERM'));
  });
  return 0;
}

async function attach(a: CliArgs): Promise<number> {
  const c = config(a, { channels: false });
  const client = await LocalClient.connect(str(a, 'socket') ?? process.env.AIO_SOCKET ?? c.socketPath);
  await runAttach({
    client,
    sessionKey: str(a, 'session') ?? c.local.session,
    tier: (str(a, 'tier') ?? 'full') as Tier,
    ...(str(a, 'from') !== undefined ? { fromSeq: Number(str(a, 'from')) } : {}),
    input: process.stdin,
    output: process.stdout,
    color: !a.values['no-color'] && process.stdout.isTTY === true,
    verbose: a.values.verbose === true,
  });
  return 0;
}

/** `aio input`: a local input into a session (what `aio-dev send` was). */
async function input(a: CliArgs): Promise<number> {
  const c = config(a, { channels: false });
  const text = a.rest.join(' ').trim();
  if (!text) throw new ConfigError('input: nothing to send');
  const sessionKey = str(a, 'session') ?? c.local.session;
  const client = await LocalClient.connect(str(a, 'socket') ?? process.env.AIO_SOCKET ?? c.socketPath);
  try {
    const sub = a.values.wait ? await client.subscribe({ sessionKey, tier: 'final', fromSeq: (await client.sessions()).find((s) => s.sessionKey === sessionKey)?.head ?? 0 }) : undefined;
    const r = await client.input(sessionKey, text, (str(a, 'mode') ?? 'queue') as 'queue');
    console.log(`${r.inputId} ${r.disposition}`);
    if (!sub) return 0;
    let turnId: string | undefined;
    for await (const e of sub) {
      const b = e.body;
      if (b.t === 'turn.started' && b.inputIds.includes(r.inputId)) turnId = b.turnId;
      if (b.t === 'text.snapshot' && b.final && e.turnId === turnId) console.log(b.text);
      if (b.t === 'turn.completed' && b.turnId === turnId) {
        if (b.status !== 'completed') console.error(`turn ${b.status}`);
        return b.status === 'completed' ? 0 : 1;
      }
    }
    return 1;
  } finally {
    client.close();
  }
}

async function sessions(a: CliArgs): Promise<number> {
  const client = await LocalClient.connect(socketOf(a));
  for (const s of await client.sessions()) console.log(`${s.sessionKey}\t${s.state}\tseq ${s.head}${s.turnId ? `\tturn ${s.turnId}` : ''}${s.pendingRequests.length ? `\trequests ${s.pendingRequests.join(',')}` : ''}${s.launch?.cwd ? `\tcwd ${s.launch.cwd}` : ''}${s.launch?.envKeys.length ? `\tenv ${s.launch.envKeys.join(',')}` : ''}`);
  client.close();
  return 0;
}

async function watch(a: CliArgs): Promise<number> {
  const c = config(a, { channels: false });
  const [sub = 'list', ...tokens] = a.rest;
  const session = str(a, 'session');
  const client = await LocalClient.connect(str(a, 'socket') ?? process.env.AIO_SOCKET ?? c.socketPath);
  try {
    switch (sub) {
      case 'add': {
        const w = await client.watchAdd(parseWatchSpec(tokens, session ?? c.local.session));
        console.log(formatWatch(w));
        return 0;
      }
      case 'list':
      case 'ls': {
        const ws = await client.watchList(session);
        for (const w of ws) console.log(formatWatch(w));
        if (!ws.length) console.error('no watches');
        return 0;
      }
      case 'remove':
      case 'rm': {
        if (!tokens[0]) throw new ConfigError('usage: aio watch remove <id>');
        const r = await client.watchRemove(tokens[0]);
        console.log(r.removed ? `removed ${tokens[0]}` : `no watch ${tokens[0]}`);
        return r.removed ? 0 : 1;
      }
      default:
        throw new ConfigError(`unknown watch command ${sub} (add, list, remove)`);
    }
  } finally {
    client.close();
  }
}

/** `--env K=V` pairs (values may contain `=`). */
export function parseEnvPairs(pairs: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of pairs) {
    const eq = p.indexOf('=');
    const k = eq > 0 ? p.slice(0, eq) : '';
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new ConfigError(`--env ${JSON.stringify(eq > 0 ? k : p)}: expected NAME=value`);
    out[k] = p.slice(eq + 1);
  }
  return out;
}

/** The run request `aio run` sends, from its arguments. */
export function runRequest(a: CliArgs, cwd = process.cwd()): { runId: string; agent: string; input: ContentBlock[]; cwd?: string; env?: Record<string, string>; observe?: { routes: ReplyRoute[] }; timeoutMs?: number } {
  const agent = need(a, 'agent');
  const text = a.rest.join(' ').trim();
  if (!text) throw new ConfigError('run: no instruction (put it after --: aio run --agent <name> -- <instruction>)');
  const env = parseEnvPairs(list(a, 'env'));
  const routes = list(a, 'observe').map((r) => json<ReplyRoute>(r, '--observe'));
  const timeout = str(a, 'timeout');
  return {
    runId: str(a, 'run-id') ?? `run_${randomUUID()}`,
    agent,
    input: [{ type: 'text', text }],
    ...(str(a, 'cwd') !== undefined ? { cwd: resolve(cwd, str(a, 'cwd')!) } : {}),
    ...(Object.keys(env).length ? { env } : {}),
    ...(routes.length ? { observe: { routes } } : {}),
    ...(timeout !== undefined ? { timeoutMs: parseDuration(timeout) } : {}),
  };
}

/** One short stderr line per notable run event (undefined: nothing to say). */
export function progressLine(e: SessionEvent): string | undefined {
  const b = e.body;
  const cut = (s: string, n = 120) => (s.length > n ? `${s.slice(0, n - 1)}…` : s).replace(/\s+/g, ' ');
  switch (b.t) {
    case 'turn.started':
      return `▸ started${b.run ? ` (${b.run.harness}, ${b.run.model || 'default model'}, ${b.run.profile})` : ''}`;
    case 'item.started':
      return b.item.type === 'reasoning' || b.item.type === 'agent_message' ? undefined : `  · ${b.item.type}: ${cut(b.item.title)}`;
    case 'item.completed':
      return b.item.status === 'failed' || b.item.status === 'declined' ? `  ✗ ${b.item.type} ${b.item.status}: ${cut(b.item.title)}` : undefined;
    case 'request.opened':
      return `  ? ${b.kind} ${b.requestId}: ${cut(b.title ?? '')} (${b.resolver?.kind ?? 'pending'})`;
    case 'notice':
      return `  ! ${cut(b.message)}`;
    case 'turn.completed':
      return `▪ ${b.status}${b.error ? ` (${b.error.code}${b.error.message ? `: ${cut(b.error.message, 200)}` : ''})` : ''}`;
    default:
      return undefined;
  }
}

async function runCmd(a: CliArgs): Promise<number> {
  const req = runRequest(a);
  const quiet = a.values.quiet === true;
  const client = await hostClient(a);
  const sessionKey = `run:${req.runId}`;
  if (!str(a, 'run-id') && !quiet) console.error(`run id ${req.runId}`);
  let answer = '';
  let completedSeen = false;
  let onSig: (() => void) | undefined;
  try {
    // Subscribe first (the session is empty until the run starts), so no event is missed.
    const sub = await client.subscribe({ sessionKey, tier: 'full', fromSeq: 0 });
    const pump = (async () => {
      for await (const e of sub) {
        if (e.body.t === 'text.snapshot' && e.body.final && e.audience === 'answer') answer = e.body.text;
        if (e.body.t === 'turn.completed') completedSeen = true;
        const line = quiet ? undefined : progressLine(e);
        if (line) process.stderr.write(line + '\n');
      }
    })();
    let cancelled = false;
    onSig = () => {
      if (cancelled) process.exit(130);
      cancelled = true;
      console.error('cancelling the run (again to stop waiting)');
      void client.runCancel(req.runId, 'aio run interrupted').catch(() => undefined);
    };
    process.on('SIGINT', onSig);
    process.on('SIGTERM', onSig);
    const started = await client.runStart(req);
    const ended: RunEnded = started.ended ?? (await client.runEndedOf(req.runId));
    // The turn's events precede run.ended on this connection; let the pump catch up.
    for (let i = 0; i < 50 && !completedSeen; i++) await new Promise((r) => setTimeout(r, 10));
    await sub.close();
    void pump;
    if (answer) process.stdout.write(answer.endsWith('\n') ? answer : answer + '\n');
    if (!quiet) console.error(`run ${req.runId} ${ended.status} (exit ${ended.exitCode})${ended.error ? `: ${ended.error.code}${ended.error.message ? ` ${ended.error.message}` : ''}` : ''}`);
    return ended.exitCode;
  } finally {
    if (onSig) {
      process.off('SIGINT', onSig);
      process.off('SIGTERM', onSig);
    }
    client.close();
  }
}

async function send(a: CliArgs): Promise<number> {
  const route = json<ReplyRoute>(need(a, 'route'), '--route');
  const operationId = need(a, 'operation-id');
  const text = str(a, 'text');
  const message: RenderedMessage = text !== undefined ? { text } : json<RenderedMessage>(await readInput(str(a, 'file')), 'the message');
  const client = await hostClient(a);
  try {
    const r = await client.deliver({ operationId, route, message });
    print(r);
    return r.status === 'delivered' ? 0 : 1;
  } finally {
    client.close();
  }
}

async function tail(a: CliArgs): Promise<number> {
  const consumer = need(a, 'consumer');
  const once = a.values.once === true;
  const limit = str(a, 'limit') ? Number(str(a, 'limit')) : 100;
  const client = await hostClient(a);
  let stop = false;
  const onSig = () => {
    stop = true;
    client.close();
  };
  process.on('SIGINT', onSig);
  process.on('SIGTERM', onSig);
  process.stdout.on('error', onSig); // EPIPE: the reader went away
  let after = str(a, 'from') !== undefined ? Number(str(a, 'from')) : undefined;
  try {
    while (!stop) {
      const r = await client.inboundRead({ consumer, ...(after !== undefined ? { after } : {}), limit, waitMs: once ? 0 : 30_000 });
      for (const item of r.items) process.stdout.write(JSON.stringify(item) + '\n');
      // Pull never moves the cursor: continue after what was printed, whatever is acked.
      after = r.items.at(-1)?.cursor ?? after ?? r.acked;
      if (once && r.items.length < limit) break;
    }
    return 0;
  } catch (e) {
    if (stop) return 0;
    throw e;
  } finally {
    process.off('SIGINT', onSig);
    process.off('SIGTERM', onSig);
    process.stdout.off('error', onSig);
    client.close();
  }
}

async function ack(a: CliArgs): Promise<number> {
  const consumer = need(a, 'consumer');
  const cursor = a.rest[0];
  if (!cursor || !/^\d+$/.test(cursor)) throw new ConfigError('usage: aio ack --consumer <name> <cursor>');
  const client = await hostClient(a);
  try {
    const r = await client.inboundAck(consumer, Number(cursor));
    console.log(`${r.consumer} acked ${r.acked}`);
    return 0;
  } finally {
    client.close();
  }
}

async function bindings(a: CliArgs): Promise<number> {
  const [sub] = a.rest;
  if (sub !== 'put' && sub !== 'get') throw new ConfigError('usage: aio bindings put [--file table.json|-] | aio bindings get');
  const table = sub === 'put' ? json<Record<string, unknown>>(await readInput(str(a, 'file')), 'the table') : undefined;
  const client = await hostClient(a);
  try {
    if (sub === 'get') {
      print(await client.bindingsGet());
      return 0;
    }
    // `{ table: … }` (a bindings.put frame's body) or the table itself.
    const t = (table && 'table' in table ? table.table : table) as Parameters<LocalClient['bindingsPut']>[0];
    const r = await client.bindingsPut(t);
    print(r);
    if (!r.active) console.error(`note: table ${r.version} is installed but not active (${r.suspended ?? 'inactive'}): with onHostDown "suspend" (the default) it routes only while a host is connected (consumer or callouts)`);
    return 0;
  } finally {
    client.close();
  }
}

async function explain(a: CliArgs): Promise<number> {
  const id = a.rest[0];
  if (!id) throw new ConfigError('usage: aio explain <inputId>');
  const client = await hostClient(a);
  try {
    print(await client.explain(id));
    return 0;
  } finally {
    client.close();
  }
}

async function verify(a: CliArgs): Promise<number> {
  const ref = a.rest[0];
  if (!ref) throw new ConfigError('usage: aio verify <channelRef>   (channel:<channel>/<message id>)');
  const client = await hostClient(a);
  try {
    const r = await client.verify(ref);
    print(r);
    return r.found ? 0 : 1;
  } finally {
    client.close();
  }
}

/**
 * `aio console-link`: ask the running daemon's console (with the host token)
 * for a one-time login link and print it. The console first proves it knows
 * the host token (`POST /api/console-proof`, an HMAC over a fresh challenge),
 * so the token is never sent to another listener on that port.
 */
async function consoleLink(a: CliArgs): Promise<number> {
  const socket = socketOf(a);
  const token = readTokenFile(tokenPath(socket));
  let url: string;
  try {
    url = readTokenFile(consoleUrlPath(socket));
  } catch {
    throw new DaemonUnavailable(`no console URL next to ${socket}: is \`aio serve\` running with the console enabled (config \`console\`)?`);
  }
  let res: Response;
  try {
    // The URL file may be stale and the port someone else's: the host token goes only to a listener that proves it knows it.
    const challenge = randomBytes(24).toString('base64url');
    const p = await fetch(`${url}/api/console-proof`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ challenge }) });
    const proof = p.ok ? ((await p.json().catch(() => ({}))) as { proof?: unknown }).proof : undefined;
    const want = Buffer.from(consoleProof(token, challenge));
    const got = Buffer.from(typeof proof === 'string' ? proof : '');
    if (got.length !== want.length || !timingSafeEqual(got, want))
      throw new CommandError('not_this_daemon', `${url} (from ${consoleUrlPath(socket)}) is not this daemon's console; the host token was not sent. Restart \`aio serve\` or check console.port`);
    res = await fetch(`${url}/api/login-link`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{}' });
  } catch (e) {
    if (e instanceof CommandError) throw e;
    throw new DaemonUnavailable(`cannot reach the console at ${url}: ${(e as Error).message}`);
  }
  const body = (await res.json()) as { url?: string; expiresAt?: number; error?: { code: string; message: string } };
  if (!res.ok || !body.url) throw new CommandError(body.error?.code ?? 'failed', body.error?.message ?? `HTTP ${res.status}`);
  console.log(body.url);
  if (process.stderr.isTTY) console.error(`one-time login link; valid until ${new Date(body.expiresAt ?? 0).toLocaleTimeString()}`);
  return 0;
}

async function e2e(a: CliArgs): Promise<number> {
  const c = config(a, { channels: false });
  const inst = defaultInstance(c);
  const probe = await buildHarness(inst).probe();
  const modelFrom = process.env[inst.kind === 'codex' ? 'AGENTS_IO_LIVE_CODEX_MODEL' : 'AGENTS_IO_LIVE_CLAUDE_MODEL'] ? 'env' : 'config/default';
  console.log(`e2e against ${inst.name} (${inst.kind}): ${probe.version}; model ${inst.run.model || '(codex default)'} from ${modelFrom}`);
  const only = str(a, 'only')?.split(',').map((s) => s.trim());
  const root = str(a, 'data-dir');
  const results = await runScenarios(c, { ...(only ? { only } : {}), ...(root ? { root: resolve(root.replace(/^~(?=$|\/)/, homedir())) } : {}), verbose: a.values.verbose === true });
  const n = (s: string) => results.filter((r) => r.status === s).length;
  console.log(`\n${n('PASS')} passed, ${n('FAIL')} failed, ${n('SKIP')} skipped`);
  return n('FAIL') ? 1 : 0;
}

const COMMANDS: Record<string, (a: CliArgs) => Promise<number>> = { serve, attach, input, sessions, watch, e2e, run: runCmd, send, tail, ack, bindings, explain, verify, 'console-link': consoleLink, console: consoleLink };

export async function main(argv: string[]): Promise<number> {
  const a = parseCli(argv);
  if (a.cmd === 'help') {
    console.log(USAGE);
    return 0;
  }
  const f = COMMANDS[a.cmd];
  if (!f) {
    console.error(`unknown command ${a.cmd}\n\n${USAGE}`);
    return 2;
  }
  return f(a);
}

/** Exit code for an error that ended a command. */
export function exitCodeFor(e: unknown): number {
  if (e instanceof ConfigError) return 2;
  if (e instanceof DaemonUnavailable || e instanceof TokenError) return 69;
  if (e instanceof CommandError && e.code === 'unauthorized') return 77;
  if (e instanceof CommandError && ['unknown_agent', 'not_task_agent', 'bad_cwd', 'bad_env', 'bad_run_id', 'invalid_frame', 'invalid', 'task_agent', 'unknown_agent', 'conflict', 'empty_input'].includes(e.code)) return 2;
  return 1;
}

/** Run the CLI and exit the process with its code (the `aio` bin). */
export function run(argv: string[]): void {
  main(argv).then(
    (code) => process.exit(code),
    (e: Error) => {
      const code = exitCodeFor(e);
      console.error(code === 1 && !(e instanceof CommandError) ? (e.stack ?? e.message) : `aio: ${e.message}`);
      process.exit(code);
    },
  );
}

const invoked = process.argv[1] ? pathToFileURL(realpathSync(process.argv[1])).href : undefined;
if (invoked === import.meta.url) run(process.argv.slice(2));
