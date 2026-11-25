// Records the Codex transcripts (docs/design/conformance-fixtures §2.2) from a real `codex app-server`:
//
//   CODEX_HOME=<a home with a model provider> node --experimental-transform-types \
//     --disable-warning=ExperimentalWarning --import ./scripts/source-loader.mjs \
//     harness/codex/scripts/record-transcripts.ts [scenario…]
//
// Each scenario of harness/codex/test/transcript-scenarios.ts runs once through the real adapter
// on a throwaway stdio app-server (never a shared daemon), its exchange tapped at the adapter's
// Transport (`recordTransport`), scrubbed of what is particular to this machine and run (home
// directory, host name, the workspace, ids Codex made up) and written to
// packages/testkit/conformance/transcripts/codex/<scenario>.ndjson. `AIO_RECORD_OUT` writes
// elsewhere; `CODEX_BIN` picks the binary. The model is the scenario's (`run.model`).
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, hostname, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TranscriptRecorder, formatTranscript, scrubTranscript } from '@agents-io/testkit';
import { CodexHarness, codexEnv, recordTransport, spawnTransport, versionFromUserAgent } from '../src/index.js';
import { CODEX_SCENARIOS, events } from '../test/transcript-scenarios.js';

const here = dirname(fileURLToPath(import.meta.url));
const out = process.env.AIO_RECORD_OUT ?? join(here, '..', '..', '..', 'packages', 'testkit', 'conformance', 'transcripts', 'codex');
const codexHome = process.env.CODEX_HOME;
if (!codexHome) throw new Error('set CODEX_HOME to a Codex home with a working model provider');
const bin = process.env.CODEX_BIN ?? 'codex';
const only = process.argv.slice(2);

/** Ids Codex makes up, by where they are: `<$thread-1>`, `<$turn-1>`, `<$item-3>`, … */
function codexId(key: string, value: string, path: string): string | undefined {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
  const prefixed = /^[a-z]{2,8}_[A-Za-z0-9-]{8,}$/.test(value);
  if (!uuid && !prefixed) return undefined;
  if (key === 'threadId' || /(^|\.)thread\.id$/.test(path) || key === 'conversationId') return 'thread';
  if (key === 'turnId' || /(^|\.)turn\.id$/.test(path) || /TurnId$/.test(key)) return 'turn';
  if (key === 'itemId' || /(^|\.)item\.id$/.test(path)) return 'item';
  if (key === 'callId') return 'call';
  if (/(^|[A-Z_])(id|Id)$/.test(key) || key === 'id') return 'id';
  return undefined;
}

mkdirSync(out, { recursive: true });
for (const sc of CODEX_SCENARIOS) {
  if (only.length && !only.includes(sc.name)) continue;
  const workspace = mkdtempSync(join(realpathSync(tmpdir()), 'aio-codex-rec-'));
  const recorder = new TranscriptRecorder({
    provider: 'codex',
    protocol: 'codex.app-server',
    scenario: sc.name,
    metadata: { description: sc.description, model: sc.run.model, source: 'harness/codex/scripts/record-transcripts.ts' },
  });
  let closed: ((reason: string) => void) | undefined;
  const exited = new Promise<string>((r) => (closed = r));
  const harness = new CodexHarness({
    codexHome,
    transport: () => {
      const t = recordTransport(spawnTransport({ bin, args: ['app-server'], env: codexEnv({ codexHome }) }), recorder.tap);
      t.onClose((reason) => closed?.(reason));
      return t;
    },
    log: (level, msg) => console.error(`[${sc.name}] ${level}: ${msg}`),
  });
  console.error(`[${sc.name}] recording in ${workspace}`);
  try {
    const s = await harness.open({ sessionKey: 's1', generation: 1, cwd: workspace, run: sc.run, ...(sc.profiles ? { options: { profiles: sc.profiles } } : {}) });
    const ev = events(s);
    await sc.drive(s, ev);
    await s.close('recorded');
    await ev.done;
    console.error(`[${sc.name}] ${ev.all.map((e) => e.body.t).join(' ')}`);
    console.error(`[${sc.name}] app-server ${await Promise.race([exited, new Promise<string>((r) => setTimeout(() => r('still running after 10s'), 10_000))])}`);
  } finally {
    await harness.dispose();
    rmSync(workspace, { recursive: true, force: true });
  }
  const t = recorder.transcript();
  const init = t.entries.find((e) => e.type === 'emit_inbound' && e.label === 'initialize');
  t.header.version = versionFromUserAgent(((init as { frame: { result?: { userAgent?: string } } } | undefined)?.frame.result?.userAgent)) ?? 'unknown';
  const scrubbed = scrubTranscript(t, { home: homedir(), hostname: hostname(), workspace, ids: codexId, rewrite: machineSetup });
  const file = join(out, `${sc.name}.ndjson`);
  writeFileSync(file, formatTranscript(scrubbed));
  console.error(`[${sc.name}] wrote ${file} (${scrubbed.entries.length} lines, codex ${t.header.version})`);
}

/** The recording machine's own setup: its model provider's name and what its user agent says about the terminal. */
function machineSetup(key: string, value: unknown): unknown {
  if (key === 'modelProvider' && typeof value === 'string') return 'replay-provider';
  if (key === 'userAgent' && typeof value === 'string') return value.replace(/\s.*$/, ' (replay)');
  return undefined;
}
