import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { HarnessEvent } from '@agents-io/protocol';
import { checkEventStream, readTranscript, type Transcript } from '@agents-io/testkit';
import { AcpHarness } from '../src/index.js';
import { loader, root } from './acp-helpers.js';
import { ACP_SCENARIOS, events } from './transcript-scenarios.js';

/*
 * A real ACP agent's exchanges (Claude Code's ACP agent, `@agentclientprotocol/claude-agent-acp`
 * 0.110.1, model gpt-6-sol), recorded (`harness/acp/scripts/record-transcripts.ts`) as
 * language-neutral transcripts (docs/design/conformance-fixtures §2, protocol `acp`), replayed
 * through the real adapter: `aio-transcript-replay` stands where the agent would, over stdio, and
 * fails (exit 3) on any frame the adapter writes that the recording did not have. The session does
 * what the recording did (`transcript-scenarios.ts`).
 */

const DIR = join(root, 'packages', 'testkit', 'conformance', 'transcripts', 'acp');
const REPLAY = join(root, 'packages', 'testkit', 'src', 'transcript-replay.ts');

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

interface Replayed {
  t: Transcript;
  events: HarnessEvent[];
  /** `checkEventStream` of the session's events (HC-1). */
  violations: ReturnType<typeof checkEventStream>;
  of<T extends HarnessEvent['body']['t']>(t: T): Extract<HarnessEvent['body'], { t: T }>[];
}

/** Plays the scenario `name` through an AcpHarness whose agent is the transcript's replay. */
async function replay(name: string): Promise<Replayed> {
  const sc = ACP_SCENARIOS.find((s) => s.name === name)!;
  const file = join(DIR, `${name}.ndjson`);
  const t = readTranscript(file);
  const stderr: string[] = [];
  const harness = new AcpHarness({
    command: process.execPath,
    args: [...loader, REPLAY, file],
    log: (level, msg) => {
      if (msg.startsWith('agent stderr: ')) stderr.push(msg);
      else if (level !== 'debug') stderr.push(`${level}: ${msg}`);
    },
    ...(sc.profiles ? { profiles: sc.profiles } : {}),
  });
  const workspace = mkdtempSync(join(realpathSync(tmpdir()), 'aio-acp-replay-'));
  cleanups.push(() => rmSync(workspace, { recursive: true, force: true }));
  cleanups.push(() => harness.dispose());
  const s = await harness.open({ sessionKey: 's1', generation: 1, cwd: workspace, run: sc.run, ...(sc.before ? { resume: 'session-1' } : {}) });
  const ev = events(s);
  try {
    await sc.drive(s, { all: ev.all, until: (p) => ev.until(p, 10_000) });
  } catch (e) {
    throw new Error(`${(e as Error).message}\n--- replay ---\n${stderr.join('\n')}`);
  }
  await s.close('replayed');
  await ev.done;
  await harness.dispose();
  // The replay's last words reach its stderr just after it exits.
  await new Promise((r) => setTimeout(r, 100));
  // Every recorded line was played, and nothing differed (the replay exits 0 only then; a frame it did not expect is on its stderr).
  expect(stderr.join('\n')).toBe('');
  const violations = checkEventStream(ev.all, { turnInputs: { t1: ['in-1'] } });
  return { t, events: ev.all, violations, of: (k) => ev.all.flatMap((e) => (e.body.t === k ? [e.body as never] : [])) };
}

/** The agent's answer in the transcript: its message chunks after the last prompt. */
function recordedAnswer(t: Transcript): string {
  const prompts = t.entries.map((e, i) => (e.type === 'expect_outbound' && (e.frame as { method?: string }).method === 'session/prompt' ? i : -1)).filter((i) => i >= 0);
  return t.entries
    .slice(prompts.at(-1)! + 1)
    .flatMap((e) => {
      const u = e.type === 'emit_inbound' ? (e.frame as { method?: string; params?: { update?: { sessionUpdate?: string; content?: { text?: string } } } }) : undefined;
      return u?.method === 'session/update' && u.params?.update?.sessionUpdate === 'agent_message_chunk' ? [u.params.update.content?.text ?? ''] : [];
    })
    .join('');
}

describe('recorded ACP transcripts (Claude Code ACP agent 0.110.1), replayed through the adapter', () => {
  it('a plain turn: the adapter writes exactly the recorded frames (initialize with no fs or terminal capability, session/new, session/prompt, session/close) and maps the answer to a conforming stream #HC-1', async () => {
    const r = await replay('plain-turn');
    expect(r.violations).toEqual([]);
    expect(r.t.header).toMatchObject({ provider: 'acp', protocol: 'acp', version: '0.110.1' });
    expect(r.of('input.consumed')).toEqual([expect.objectContaining({ inputIds: ['in-1'], turnId: 't1' })]);
    expect(r.of('text.snapshot').filter((x) => x.final).at(-1)?.text).toBe(recordedAnswer(r.t).trim());
    expect(r.of('turn.completed')).toEqual([expect.objectContaining({ turnId: 't1', status: 'completed', usage: expect.objectContaining({ outputTokens: expect.any(Number) }) })]);
  });

  it('a permission: a restricted turn with no mode configured runs in the agent\'s asking session mode (session/set_mode default, not the auto it opened in), the request opens, allow once goes back as the option the agent offered, the command runs and the turn completes #HC-1 #RQ-1', async () => {
    const r = await replay('permission');
    expect(r.violations).toEqual([]);
    // The replay played every frame: the adapter, given no profiles, wrote this set_mode.
    const frames = r.t.entries.flatMap((e) => (e.type === 'runtime_exit' ? [] : [e.frame as { method?: string; params?: { modeId?: string }; result?: { modes?: { currentModeId?: string } } }]));
    expect(frames.find((f) => f.result?.modes)?.result?.modes?.currentModeId).toBe('auto');
    expect(frames.filter((f) => f.method === 'session/set_mode').map((f) => f.params?.modeId)).toEqual(['default']);
    const [opened] = r.of('request.opened');
    expect(opened).toMatchObject({ kind: 'tool_approval', title: 'touch approved.txt', risk: { writes: true }, inputPreview: 'touch approved.txt', allowedDecisions: ['allow_once', 'allow_session', 'deny', 'native'], allowAlways: false });
    expect(r.of('request.resolved')).toEqual([expect.objectContaining({ requestId: opened!.requestId, decision: { kind: 'allow_once' } })]);
    expect(r.of('item.completed')).toEqual([expect.objectContaining({ item: expect.objectContaining({ type: 'command', status: 'completed' }) })]);
    expect(r.of('turn.completed')).toEqual([expect.objectContaining({ turnId: 't1', status: 'completed' })]);
  });

  it('a cancel: session/cancel once the answer started, and the turn ends interrupted with its input consumed #HC-1 #IN-1', async () => {
    const r = await replay('cancel');
    expect(r.violations).toEqual([]);
    expect(r.of('input.consumed').flatMap((c) => c.inputIds)).toEqual(['in-1']);
    expect(r.of('turn.completed')).toEqual([expect.objectContaining({ turnId: 't1', status: 'interrupted' })]);
  });

  it('a load: session/load on a new agent process; the conversation it replays before answering is no event, the next turn is #RS-1 #HC-1', async () => {
    const r = await replay('load');
    expect(r.violations).toEqual([]);
    expect(r.events.filter((e) => e.durability === 'durable').map((e) => e.body.t)).toEqual(['session.bound', 'turn.started', 'input.consumed', 'text.snapshot', 'text.snapshot', 'turn.completed']);
    expect(r.of('session.bound')).toEqual([{ t: 'session.bound', nativeId: 'session-1' }]);
    expect(r.of('text.snapshot').filter((x) => x.final).at(-1)?.text).toBe(recordedAnswer(r.t).trim());
  });
});
