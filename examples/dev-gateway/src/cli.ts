#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import type { Tier } from '@agents-io/protocol';
import { runAttach } from './attach.js';
import { LocalClient } from './client.js';
import { ConfigError, defaultInstance, loadConfig, type LoadOptions } from './config.js';
import { runScenarios } from './e2e.js';
import { Gateway, buildHarness } from './gateway.js';
import { WATCH_SPEC_HELP, formatWatch, parseWatchSpec } from './watch-spec.js';

const USAGE = `aio-dev: agents-io dev gateway (example)

  aio-dev serve     [--harness <instance>]
  aio-dev attach    [--session <key>] [--tier full|card|headline|final] [--from <seq>] [--verbose]
  aio-dev send      [--session <key>] [--mode queue|steer|interrupt] [--wait] <text…>
  aio-dev sessions
  aio-dev watch     add [--session <target>] key=value…
  aio-dev watch     list [--session <target>]
  aio-dev watch     remove <id>
  aio-dev e2e       [--harness <instance>] [--only <id|name>[,…]] [--verbose]

watch keys: ${WATCH_SPEC_HELP}

--harness: a name from \`harnesses\` (or claude-code|codex: that kind's first instance)

common: --config <aio.config.json> (or $AIO_CONFIG)  --env-file <.env.live>`;

const TIERS = ['full', 'card', 'headline', 'final'];

export interface CliArgs {
  cmd: string;
  values: Record<string, string | boolean | undefined>;
  rest: string[];
}

export function parseCli(argv: string[]): CliArgs {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      config: { type: 'string' },
      'env-file': { type: 'string' },
      harness: { type: 'string' },
      session: { type: 'string' },
      tier: { type: 'string' },
      from: { type: 'string' },
      mode: { type: 'string' },
      only: { type: 'string' },
      wait: { type: 'boolean' },
      verbose: { type: 'boolean', short: 'v' },
      'no-color': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const [cmd = 'help', ...rest] = positionals;
  if (values.tier !== undefined && !TIERS.includes(values.tier)) throw new ConfigError(`--tier must be one of ${TIERS.join(', ')}`);
  if (values.from !== undefined && !/^\d+$/.test(values.from)) throw new ConfigError('--from must be a seq number');
  if (values.mode !== undefined && !['queue', 'steer', 'interrupt'].includes(values.mode)) throw new ConfigError('--mode must be queue, steer or interrupt');
  return { cmd: values.help ? 'help' : cmd, values, rest };
}

function config(a: CliArgs, extra: Partial<LoadOptions> = {}) {
  return loadConfig({
    ...(typeof a.values.config === 'string' ? { path: a.values.config } : {}),
    ...(typeof a.values['env-file'] === 'string' ? { envFile: a.values['env-file'] } : {}),
    ...(typeof a.values.harness === 'string' ? { harness: a.values.harness } : {}),
    ...extra,
  });
}

async function serve(a: CliArgs): Promise<number> {
  const c = config(a);
  const gw = await Gateway.start({ config: c, logger: (level, msg) => console.error(`[aio] ${level}: ${msg}`) });
  let version = 'not probed';
  try {
    version = (await gw.harness().probe()).version;
  } catch (e) {
    console.error(`[aio] warn: harness probe failed: ${(e as Error).message}`);
  }
  console.error(`[aio] serving on ${c.socketPath}`);
  // Names and kinds only: instance env values are secrets.
  const instances = Object.values(c.harnesses).map((i) => `${i.name} (${i.kind}${i.name === c.defaultHarness ? `, default, ${version}` : ''})`);
  console.error(`[aio] harnesses: ${instances.join(', ')}; log ${c.logPath}; local principal ${c.local.principal.id}; default session ${c.local.session}`);
  console.error(`[aio] channels: ${c.channels.map((ch) => ch.type).join(', ') || 'none'}; owners: ${c.policy.owners.length}`);
  await new Promise<void>((resolve) => {
    let stopping = false;
    const stop = (sig: string) => {
      if (stopping) process.exit(130);
      stopping = true;
      console.error(`[aio] ${sig}: stopping (again to force)`);
      void gw.stop().finally(resolve);
    };
    process.on('SIGINT', () => stop('SIGINT'));
    process.on('SIGTERM', () => stop('SIGTERM'));
  });
  return 0;
}

async function attach(a: CliArgs): Promise<number> {
  const c = config(a, { channels: false });
  const client = await LocalClient.connect(c.socketPath);
  await runAttach({
    client,
    sessionKey: (a.values.session as string | undefined) ?? c.local.session,
    tier: ((a.values.tier as string | undefined) ?? 'full') as Tier,
    ...(a.values.from !== undefined ? { fromSeq: Number(a.values.from) } : {}),
    input: process.stdin,
    output: process.stdout,
    color: !a.values['no-color'] && process.stdout.isTTY === true,
    verbose: a.values.verbose === true,
  });
  return 0;
}

async function send(a: CliArgs): Promise<number> {
  const c = config(a, { channels: false });
  const text = a.rest.join(' ').trim();
  if (!text) throw new ConfigError('send: nothing to send');
  const sessionKey = (a.values.session as string | undefined) ?? c.local.session;
  const client = await LocalClient.connect(c.socketPath);
  try {
    const sub = a.values.wait ? await client.subscribe({ sessionKey, tier: 'final', fromSeq: (await client.sessions()).find((s) => s.sessionKey === sessionKey)?.head ?? 0 }) : undefined;
    const r = await client.input(sessionKey, text, ((a.values.mode as string | undefined) ?? 'queue') as 'queue');
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
  const c = config(a, { channels: false });
  const client = await LocalClient.connect(c.socketPath);
  for (const s of await client.sessions()) console.log(`${s.sessionKey}\t${s.state}\tseq ${s.head}${s.turnId ? `\tturn ${s.turnId}` : ''}${s.pendingRequests.length ? `\trequests ${s.pendingRequests.join(',')}` : ''}`);
  client.close();
  return 0;
}

async function watch(a: CliArgs): Promise<number> {
  const c = config(a, { channels: false });
  const [sub = 'list', ...tokens] = a.rest;
  const session = a.values.session as string | undefined;
  const client = await LocalClient.connect(c.socketPath);
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
        if (!tokens[0]) throw new ConfigError('usage: aio-dev watch remove <id>');
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

async function e2e(a: CliArgs): Promise<number> {
  const c = config(a, { channels: false });
  const inst = defaultInstance(c);
  const probe = await buildHarness(inst).probe();
  const modelFrom = process.env[inst.kind === 'codex' ? 'AGENTS_IO_LIVE_CODEX_MODEL' : 'AGENTS_IO_LIVE_CLAUDE_MODEL'] ? 'env' : 'config/default';
  console.log(`e2e against ${inst.name} (${inst.kind}): ${probe.version}; model ${inst.run.model || '(codex default)'} from ${modelFrom}`);
  const only = typeof a.values.only === 'string' ? a.values.only.split(',').map((s) => s.trim()) : undefined;
  const results = await runScenarios(c, { ...(only ? { only } : {}), verbose: a.values.verbose === true });
  const n = (s: string) => results.filter((r) => r.status === s).length;
  console.log(`\n${n('PASS')} passed, ${n('FAIL')} failed, ${n('SKIP')} skipped`);
  return n('FAIL') ? 1 : 0;
}

export async function main(argv: string[]): Promise<number> {
  const a = parseCli(argv);
  switch (a.cmd) {
    case 'serve':
      return serve(a);
    case 'attach':
      return attach(a);
    case 'send':
      return send(a);
    case 'sessions':
      return sessions(a);
    case 'e2e':
      return e2e(a);
    case 'watch':
      return watch(a);
    case 'help':
      console.log(USAGE);
      return 0;
    default:
      console.error(`unknown command ${a.cmd}\n\n${USAGE}`);
      return 2;
  }
}

const invoked = process.argv[1] ? pathToFileURL(realpathSync(process.argv[1])).href : undefined;
if (invoked === import.meta.url) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e: Error) => {
      console.error(e instanceof ConfigError ? e.message : (e.stack ?? e.message));
      process.exit(e instanceof ConfigError ? 2 : 1);
    },
  );
}
