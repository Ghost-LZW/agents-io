import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { HarnessEvent } from '@agents-io/protocol';
import { checkEventStream, readTranscript, type Transcript } from '@agents-io/testkit';
import { CodexHarness, spawnTransport, type Transport } from '../src/index.js';
import { CODEX_SCENARIOS, events } from './transcript-scenarios.js';

/*
 * Real Codex 0.171 exchanges, recorded (`harness/codex/scripts/record-transcripts.ts`, model
 * gpt-6-sol) as language-neutral transcripts (docs/design/conformance-fixtures §2), replayed through
 * the real adapter: `aio-transcript-replay` stands where `codex app-server` would, over stdio, and
 * fails (exit 3) on any frame the adapter writes that the recording did not have. The session does
 * what the recording did (`transcript-scenarios.ts`).
 */

const root = join(import.meta.dirname, '..', '..', '..');
const DIR = join(root, 'packages', 'testkit', 'conformance', 'transcripts', 'codex');
const REPLAY = join(root, 'packages', 'testkit', 'src', 'transcript-replay.ts');
const loader = ['--experimental-transform-types', '--disable-warning=ExperimentalWarning', '--import', join(root, 'scripts', 'source-loader.mjs')];

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

interface Replayed {
  t: Transcript;
  events: HarnessEvent[];
  /** `checkEventStream` of the session's events (HC-1). */
  violations: ReturnType<typeof checkEventStream>;
  of<T extends HarnessEvent['body']['t']>(t: T): Extract<HarnessEvent['body'], { t: T }>[];
}

/** Plays the scenario `name` through a CodexHarness whose app-server is the transcript's replay. */
async function replay(name: string): Promise<Replayed> {
  const sc = CODEX_SCENARIOS.find((s) => s.name === name)!;
  const file = join(DIR, `${name}.ndjson`);
  const t = readTranscript(file);
  let transport: (Transport & { stderrTail(): string }) | undefined;
  let exited!: Promise<string>;
  const harness = new CodexHarness({
    transport: () => {
      const tr = spawnTransport({ bin: process.execPath, args: [...loader, REPLAY, file], env: process.env });
      exited = new Promise((r) => tr.onClose(r));
      transport = tr;
      return tr;
    },
  });
  const workspace = mkdtempSync(join(realpathSync(tmpdir()), 'aio-codex-replay-'));
  cleanups.push(() => rmSync(workspace, { recursive: true, force: true }));
  cleanups.push(() => void harness.dispose());
  const s = await harness.open({ sessionKey: 's1', generation: 1, cwd: workspace, run: sc.run, ...(sc.profiles ? { options: { profiles: sc.profiles } } : {}) });
  const ev = events(s);
  try {
    await sc.drive(s, { all: ev.all, until: (p) => ev.until(p, 10_000) });
  } catch (e) {
    throw new Error(`${(e as Error).message}\n--- replay stderr ---\n${transport?.stderrTail()}`);
  }
  await s.close('replayed');
  await ev.done;
  // Every recorded line was played, and nothing differed (the replay exits 0 only then).
  expect(`${await exited}${transport!.stderrTail()}`).toBe('codex app-server exited (code 0)');
  // The scenarios give their one turn `in-1`, and steer `in-2` into it.
  const violations = checkEventStream(ev.all, { turnInputs: { t1: ['in-1', 'in-2'] } });
  return { t, events: ev.all, violations, of: (k) => ev.all.flatMap((e) => (e.body.t === k ? [e.body as never] : [])) };
}

/** The text of the transcript's last agent message (what the model answered when it was recorded). */
function recordedAnswer(t: Transcript): string | undefined {
  const texts = t.entries.flatMap((e) => {
    const f = e.type === 'emit_inbound' ? (e.frame as { method?: string; params?: { item?: { type?: string; text?: string } } }) : undefined;
    return f?.method === 'item/completed' && f.params?.item?.type === 'agentMessage' ? [f.params.item.text ?? ''] : [];
  });
  return texts.at(-1);
}

describe('recorded Codex 0.171 transcripts, replayed through the adapter', () => {
  it('a plain turn: the adapter writes exactly the recorded frames (initialize, thread/start, turn/start, thread/unsubscribe), accepts 0.171 without a warning and maps the answer to a conforming stream #HC-1', async () => {
    const r = await replay('plain-turn');
    expect(r.violations).toEqual([]);
    expect(r.t.header).toMatchObject({ provider: 'codex', protocol: 'codex.app-server', version: '0.171.0' });
    expect(r.of('notice')).toEqual([]);
    expect(r.of('input.consumed')).toEqual([expect.objectContaining({ inputIds: ['in-1'], turnId: 't1' })]);
    expect(r.of('text.snapshot').filter((x) => x.final).at(-1)?.text).toBe(recordedAnswer(r.t));
    expect(r.of('turn.completed')).toEqual([expect.objectContaining({ turnId: 't1', status: 'completed' })]);
  });

  it('a steer: turn/steer goes with the Codex turn id once the answer started, the steered input is consumed by the same turn, which completes #IN-1', async () => {
    const r = await replay('steer');
    expect(r.of('turn.started')).toHaveLength(1);
    expect(r.of('input.consumed').flatMap((c) => c.inputIds).sort()).toEqual(['in-1', 'in-2']);
    expect(r.of('text.snapshot').filter((x) => x.final).at(-1)?.text).toBe(recordedAnswer(r.t));
    expect(r.of('turn.completed')).toEqual([expect.objectContaining({ turnId: 't1', status: 'completed' })]);
  });

  it('a steer: the answer Codex abandoned when steered is closed before the turn completes, so the stream conforms #HC-1', async () => {
    const r = await replay('steer');
    expect(r.violations).toEqual([]);
    // Codex 0.171 abandons the answer it was writing when steered (item/started, deltas, never
    // item/completed): the adapter ends it skipped. Its partial text streamed, but it is not the
    // answer: no snapshot of it; the final answer is the completed one.
    const skipped = r.of('item.completed').filter((c) => c.item.status === 'skipped');
    expect(skipped).toEqual([expect.objectContaining({ item: expect.objectContaining({ type: 'agent_message' }) })]);
    const abandoned = skipped[0]!.item.itemId;
    expect(r.events.some((e) => e.itemId === abandoned && e.body.t === 'text.delta')).toBe(true);
    expect(r.events.filter((e) => e.itemId === abandoned && e.body.t === 'text.snapshot')).toEqual([]);
    expect(r.of('text.snapshot').filter((x) => x.final).map((x) => x.text)).toEqual([recordedAnswer(r.t)]);
  });

  it('an approval: the server request opens a request, the decision goes back as the recorded answer to it, the command runs and the turn completes #HC-9 #HC-1', async () => {
    const r = await replay('approval');
    expect(r.violations).toEqual([]);
    const [opened] = r.of('request.opened');
    expect(opened).toMatchObject({ kind: 'tool_approval' });
    expect(r.of('request.resolved')).toEqual([expect.objectContaining({ requestId: opened!.requestId, decision: { kind: 'allow_once' } })]);
    expect(r.of('turn.completed')).toEqual([expect.objectContaining({ turnId: 't1', status: 'completed' })]);
  });

  it('an interrupt: turn/interrupt goes with the Codex turn id once the answer started, and the turn ends interrupted with its input consumed #IN-1 #HC-1', async () => {
    const r = await replay('interrupt');
    expect(r.violations).toEqual([]);
    expect(r.of('input.consumed').flatMap((c) => c.inputIds)).toEqual(['in-1']);
    expect(r.of('turn.completed')).toEqual([expect.objectContaining({ turnId: 't1', status: 'interrupted' })]);
  });
});
