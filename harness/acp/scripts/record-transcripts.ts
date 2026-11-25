// Records the ACP transcripts (docs/design/conformance-fixtures §2.2) from a real ACP agent:
//
//   AIO_ACP_COMMAND=<agent program> [AIO_ACP_ARGS='["--flag"]'] <the agent's own env (model, keys)> \
//     node --experimental-transform-types --disable-warning=ExperimentalWarning \
//     --import ./scripts/source-loader.mjs harness/acp/scripts/record-transcripts.ts [scenario…]
//
// Each scenario of harness/acp/test/transcript-scenarios.ts runs once through the real adapter on
// a throwaway agent process (a scenario's `before` on another one, not recorded), its exchange
// tapped at the adapter's connection (`AcpHarnessOptions.record`), scrubbed of what is particular to
// this machine and run (home directory, host name, the workspace, ids the agent made up) and
// written to packages/testkit/conformance/transcripts/acp/<scenario>.ndjson. `AIO_RECORD_OUT` writes
// elsewhere. The agent's environment is this process's: give it its model and credentials there
// (harness/acp/README.md has the recipe used). It talks to a real model: run it by hand, never in CI.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, hostname, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TranscriptRecorder, formatTranscript, scrubTranscript } from '@agents-io/testkit';
import { AcpHarness } from '../src/index.js';
import { ACP_SCENARIOS, events } from '../test/transcript-scenarios.js';

const here = dirname(fileURLToPath(import.meta.url));
const out = process.env.AIO_RECORD_OUT ?? join(here, '..', '..', '..', 'packages', 'testkit', 'conformance', 'transcripts', 'acp');
const command = process.env.AIO_ACP_COMMAND;
if (!command) throw new Error('set AIO_ACP_COMMAND to an ACP agent program (and its environment: model, credentials)');
const args = process.env.AIO_ACP_ARGS ? (JSON.parse(process.env.AIO_ACP_ARGS) as string[]) : [];
const only = process.argv.slice(2);

/** Ids the agent makes up, by where they are: `<$session-1>`, `<$call-1>`, `<$msg-1>`, … */
function acpId(key: string, value: string): string | undefined {
  if (key === 'sessionId') return 'session';
  if (key === 'toolCallId') return 'call';
  if (key === 'messageId') return 'msg';
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) return 'id';
  if (/^toolu_[A-Za-z0-9]{8,}$/.test(value)) return 'call';
  return undefined;
}

mkdirSync(out, { recursive: true });
for (const sc of ACP_SCENARIOS) {
  if (only.length && !only.includes(sc.name)) continue;
  const workspace = mkdtempSync(join(realpathSync(tmpdir()), 'aio-acp-rec-'));
  const log = (level: string, msg: string) => console.error(`[${sc.name}] ${level}: ${msg}`);
  const open = { sessionKey: 's1', generation: 1, cwd: workspace, run: sc.run };
  let resume: string | undefined;
  if (sc.before) {
    const setup = new AcpHarness({ command, args, cwd: workspace, log, ...(sc.profiles ? { profiles: sc.profiles } : {}) });
    try {
      resume = await sc.before(setup, open);
    } finally {
      await setup.dispose();
    }
    console.error(`[${sc.name}] set up session ${resume}`);
  }
  const recorder = new TranscriptRecorder({ provider: 'acp', protocol: 'acp', scenario: sc.name, metadata: { description: sc.description, source: 'harness/acp/scripts/record-transcripts.ts' } });
  const harness = new AcpHarness({ command, args, cwd: workspace, log, record: recorder.tap, ...(sc.profiles ? { profiles: sc.profiles } : {}) });
  console.error(`[${sc.name}] recording in ${workspace}`);
  try {
    const s = await harness.open({ ...open, ...(resume ? { resume } : {}) });
    const ev = events(s);
    await sc.drive(s, ev);
    await s.close('recorded');
    await ev.done;
    console.error(`[${sc.name}] ${ev.all.map((e) => e.body.t).join(' ')}`);
  } finally {
    await harness.dispose();
    rmSync(workspace, { recursive: true, force: true });
  }
  const t = recorder.transcript();
  const agent = harness.agent;
  t.header.version = agent?.version ?? 'unknown';
  t.header.metadata = { ...t.header.metadata, agent: agent?.name ?? 'unknown', model: process.env.ANTHROPIC_MODEL ?? process.env.AIO_RECORD_MODEL ?? 'unknown' };
  const scrubbed = scrubTranscript(t, { home: homedir(), hostname: hostname(), workspace, ids: acpId });
  const file = join(out, `${sc.name}.ndjson`);
  writeFileSync(file, formatTranscript(scrubbed));
  console.error(`[${sc.name}] wrote ${file} (${scrubbed.entries.length} lines, ${agent?.name} ${t.header.version})`);
}
