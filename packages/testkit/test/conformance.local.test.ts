import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  TranscriptRecorder,
  TranscriptReplay,
  match,
  parseScenario,
  parseTranscript,
  readScenario,
  readTranscript,
  runScenario,
  scenarioFiles,
  scrubTranscript,
  substitute,
  type Bindings,
  type ScenarioDriver,
  type Transcript,
} from '../src/index.js';

/*
 * The conformance fixture tooling (docs/design/conformance-fixtures): the matcher, the transcript
 * and scenario formats, the replay, the stdio replayer, the runner. No promise of its own: what it
 * runs are the tests (the scenarios count as core tests of their ids).
 */

const root = join(import.meta.dirname, '..', '..', '..');
const CONFORMANCE = join(import.meta.dirname, '..', 'conformance');
const REPLAY = join(import.meta.dirname, '..', 'src', 'transcript-replay.ts');
const loader = ['--experimental-transform-types', '--disable-warning=ExperimentalWarning', '--import', join(root, 'scripts', 'source-loader.mjs')];

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'aio-conf-'));
  dirs.push(d);
  return d;
};
/** Every `.ndjson` under `d`, at any depth. */
const ndjsonUnder = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? ndjsonUnder(join(d, e.name)) : e.name.endsWith('.ndjson') ? [join(d, e.name)] : []));

describe('match', () => {
  const m = (p: unknown, a: unknown, b: Bindings = new Map(), exact = false) => match(p, a, b, { exact });

  it('objects match as a subset, arrays element by element with the same length, the rest by equality; exact allows no other key', () => {
    expect(m({ a: 1 }, { a: 1, b: 2 })).toBeUndefined();
    expect(m({ a: 1 }, { a: 1, b: 2 }, new Map(), true)).toBe('value: unexpected b=2');
    expect(m({ a: { b: [1, { c: 'x' }] } }, { a: { b: [1, { c: 'x', d: 0 }] } })).toBeUndefined();
    expect(m([1], [1, 2])).toBe('value: expected 1 elements, got 2: [1,2]');
    expect(m({ a: 1 }, { a: '1' })).toBe('a: expected 1, got "1"');
    expect(m({ a: null }, {})).toBe('a: missing (expected null)');
    expect(m({ a: null }, { a: null })).toBeUndefined();
  });

  it('<any> matches what is there; <$name> binds once and must match after; a failed match binds nothing', () => {
    const b: Bindings = new Map();
    expect(m({ a: '<any>' }, {})).toBe('a: missing (expected "<any>")');
    expect(m({ id: '<$x>', again: '<$x>' }, { id: 7, again: 7 }, b)).toBeUndefined();
    expect(b.get('x')).toBe(7);
    expect(m({ id: '<$x>' }, { id: 8 }, b)).toBe('id: <$x> is 7, got 8');
    expect(m({ y: '<$y>', z: 1 }, { y: 'v', z: 2 }, b)).toBe('z: expected 1, got 2');
    expect(b.has('y')).toBe(false);
    expect(m({ o: '<$o>' }, { o: { deep: [1] } }, b)).toBeUndefined();
    expect(m({ o: '<$o>' }, { o: { deep: [1] } }, b)).toBeUndefined();
  });

  it('a string with placeholders in text is a template: literal parts are there, placeholders stand for substrings', () => {
    const b: Bindings = new Map([['ws', '/tmp/w']]);
    expect(m('<$ws>/a.txt', '/tmp/w/a.txt', b)).toBeUndefined();
    expect(m('<$ws>/a.txt', '/tmp/x/a.txt', b)).toBe('value: expected "<$ws>/a.txt", got "/tmp/x/a.txt"');
    expect(m('echo: <$t> (<any>)', 'echo: hi there (x)', b)).toBeUndefined();
    expect(b.get('t')).toBe('hi there');
    expect(m('<$t>!', 'hi there!', b)).toBeUndefined();
  });

  it('substitute sends bound values, templates as text, and an unbound one as its name when asked', () => {
    const b: Bindings = new Map<string, unknown>([['n', 3], ['s', 'x']]);
    expect(substitute({ a: '<$n>', b: ['id-<$s>'], c: 'plain' }, b)).toEqual({ a: 3, b: ['id-x'], c: 'plain' });
    expect(() => substitute('<$nope>', b)).toThrow('value: <$nope> is not bound');
    expect(substitute({ t: '<$thread-1>' }, b, { unbound: 'name' })).toEqual({ t: 'thread-1' });
    expect(b.get('thread-1')).toBe('thread-1');
    expect(() => substitute({ x: '<any>' }, b)).toThrow('x: <any> cannot be sent');
  });
});

const T = (lines: unknown[]) => parseTranscript(lines.map((l) => JSON.stringify(l)).join('\n'));
const header = { type: 'transcript_start', provider: 'p', protocol: 'aio.jsonl-harness', version: '1', scenario: 's' };

describe('transcripts', () => {
  it('parse: a header first, then outbound, inbound and exit lines, nothing unknown', () => {
    expect(T([header, { type: 'expect_outbound', frame: {} }]).entries).toHaveLength(1);
    expect(() => T([{ type: 'expect_outbound', frame: {} }])).toThrow('line 1: a transcript starts with transcript_start');
    expect(() => T([header, header])).toThrow('line 2: transcript_start only on line 1');
    expect(() => T([header, { type: 'emit_inbound', frame: {}, extra: 1 }])).toThrow('line 2: emit_inbound has unknown extra');
    expect(() => T([header, { type: 'emit_inbound', frame: {}, afterMs: -1 }])).toThrow('afterMs must be a non-negative integer');
    expect(() => T([{ ...header, metadata: { match: 'fuzzy' } }])).toThrow('metadata.match must be "exact" or "subset"');
    expect(() => T([header, { type: 'runtime_exit', status: 'ok' }])).toThrow('status must be success, error or cancelled');
  });

  it('a recorder labels frames (a result by the request it answers) and scrub takes out the machine and the run', () => {
    const r = new TranscriptRecorder({ provider: 'p', protocol: 'codex.app-server', scenario: 's' });
    r.tap('outbound', { id: 1, method: 'thread/start', params: { cwd: '/w/x' } });
    r.tap('inbound', { id: 1, result: { thread: { id: '019a-uuid-ish' }, home: '/Users/me/.codex', host: 'my-mac' } });
    r.tap('outbound', { id: 2, method: 'turn/start', params: { threadId: '019a-uuid-ish', token: 'secret' } });
    r.version = '0.171.0';
    const t = r.transcript();
    expect(t.entries.map((e) => (e.type === 'runtime_exit' ? '' : e.label))).toEqual(['thread/start', 'thread/start', 'turn/start']);
    const s = scrubTranscript(t, { home: '/Users/me', hostname: 'my-mac', workspace: '/w/x', ids: (k, _v, path) => (path.endsWith('thread.id') || k === 'threadId' ? 'thread' : undefined), volatile: (k) => k === 'token' });
    expect(s.header.version).toBe('0.171.0');
    expect(s.entries.map((e) => (e as { frame: unknown }).frame)).toEqual([
      { id: 1, method: 'thread/start', params: { cwd: '<$workspace>' } },
      { id: 1, result: { thread: { id: '<$thread-1>' }, home: '/home/replay-user/.codex', host: 'replay-host' } },
      { id: 2, method: 'turn/start', params: { threadId: '<$thread-1>', token: '<any>' } },
    ]);
  });

  const play = (t: Transcript, o: Partial<ConstructorParameters<typeof TranscriptReplay>[1]> = {}) => {
    const sent: unknown[] = [];
    const r = new TranscriptReplay(t, { emit: (f) => sent.push(f), ...o }).start();
    return { r, sent };
  };
  const flush = () => new Promise((res) => setTimeout(res, 5));

  it('replay: inbound lines go out in order with bindings, outbound frames are compared, early ones wait their turn; a gate holds its lines', async () => {
    const t = T([
      { ...header, metadata: { match: 'subset' } },
      { type: 'expect_outbound', label: 'open', frame: { type: 'open', id: '<$id>' } },
      { type: 'emit_inbound', label: 'open', frame: { type: 'result', id: '<$id>', ok: true, native: '<$n-1>' } },
      { type: 'emit_inbound', label: 'late', frame: { type: 'event', n: 1 } },
      { type: 'expect_outbound', frame: { type: 'close', id: '<$c>' } },
      { type: 'emit_inbound', frame: { type: 'result', id: '<$c>', ok: true } },
    ]);
    const { r, sent } = play(t, { gates: ['late'] });
    // close comes early: it waits for its line.
    r.outbound({ type: 'open', id: 'h1', extra: true });
    r.outbound({ type: 'close', id: 'h2' });
    await flush();
    expect(sent).toEqual([{ type: 'result', id: 'h1', ok: true, native: 'n-1' }]);
    expect(r.reached('late')).toBe(true);
    r.release('late');
    await r.whenDone();
    expect(sent.slice(1)).toEqual([{ type: 'event', n: 1 }, { type: 'result', id: 'h2', ok: true }]);
    expect([r.done, r.error]).toEqual([true, undefined]);
  });

  it('replay: a differing frame, and one after the last line, stop it with where and why; teardown can be answered instead', async () => {
    const t = T([header, { type: 'expect_outbound', label: 'probe', frame: { type: 'probe', id: 'h1' } }, { type: 'emit_inbound', frame: { type: 'result', id: 'h1', ok: true } }]);
    const a = play(t);
    a.r.outbound({ type: 'probe', id: 'h1', features: [] });
    await a.r.whenDone();
    expect(a.r.error).toMatchObject({ kind: 'mismatch', line: 2, label: 'probe', message: 'line 2 (probe): value: unexpected features=[]' });
    const b = play(t);
    b.r.outbound({ type: 'probe', id: 'h1' });
    b.r.outbound({ type: 'close', id: 'h2' });
    await flush();
    expect(b.r.error).toMatchObject({ kind: 'exhausted', line: 4 });
    const c = play(t, { afterEnd: (f) => [{ answered: f }] });
    c.r.outbound({ type: 'probe', id: 'h1' });
    c.r.outbound({ type: 'close', id: 'h2' });
    await flush();
    expect(c.r.error).toBeUndefined();
    expect(c.sent).toEqual([{ type: 'result', id: 'h1', ok: true }, { answered: { type: 'close', id: 'h2' } }]);
  });

  it('the stdio replayer plays a transcript for whoever writes its stdin: 0 when played to the end, 3 on a differing frame, 4 when stdin ends early', async () => {
    const d = tmp();
    const file = join(d, 't.ndjson');
    writeFileSync(file, [header, { type: 'expect_outbound', frame: { type: 'probe', id: 'h1' } }, { type: 'emit_inbound', frame: { type: 'result', id: 'h1', ok: true } }].map((l) => JSON.stringify(l)).join('\n'));
    const run = (input: string[]) =>
      new Promise<{ code: number | null; out: string; err: string }>((res) => {
        const p = spawn(process.execPath, [...loader, REPLAY, file], { stdio: ['pipe', 'pipe', 'pipe'] });
        let out = '';
        let err = '';
        p.stdout.on('data', (c) => (out += c));
        p.stderr.on('data', (c) => (err += c));
        p.on('close', (code) => res({ code, out, err }));
        for (const l of input) p.stdin.write(l + '\n');
        p.stdin.end();
      });
    expect(await run([JSON.stringify({ type: 'probe', id: 'h1' })])).toEqual({ code: 0, out: JSON.stringify({ type: 'result', id: 'h1', ok: true }) + '\n', err: '' });
    const bad = await run([JSON.stringify({ type: 'probe', id: 'h9' })]);
    expect([bad.code, bad.err]).toEqual([3, expect.stringContaining('mismatch: line 2: id: expected "h1", got "h9"')]);
    const early = await run([]);
    expect([early.code, early.err]).toEqual([4, expect.stringContaining('stdin ended at line 2 of 3')]);
  });
});

describe('scenarios', () => {
  const S = (lines: unknown[]) => parseScenario(lines.map((l) => JSON.stringify(l)).join('\n'), 'x');
  const h = { scenario: 'x', description: 'what it shows, at length', invariants: ['IN-1'] };

  it('parse: a header with ids, then lines of one kind each, checked', () => {
    expect(S([h, { note: 'hi' }, { expect: { end: 'log', match: {} } }]).steps).toHaveLength(2);
    expect(() => S([{ ...h, invariants: [] }])).toThrow('invariants must be a non-empty list');
    expect(() => S([{ ...h, invariants: ['in-1'] }])).toThrow('invariants must be a non-empty list');
    expect(() => S([h, { emit: { end: 'nowhere' } }])).toThrow('end must be channel, client, host or log');
    expect(() => S([h, { emit: { end: 'channel', frame: { type: 'send' } } }])).toThrow('a channel frame is {"type": "inbound", "envelope": {…}}');
    expect(() => S([h, { expect: { end: 'log', match: {}, none: {} } }])).toThrow('needs exactly one of match, none, gapless');
    expect(() => S([h, { expect: { end: 'log', match: {}, after: 'z' } }])).toThrow('no earlier expectation has that label');
    expect(() => S([h, { expect: { end: 'log', none: {}, until: 'z' } }])).toThrow('no expectation has that label');
    expect(() => S([h, { expect: { end: 'client', gapless: true } }])).toThrow('gapless at a connection names the session');
    expect(() => S([h, { fault: { crash: true } }])).toThrow('the only fault is {"restart": true}');
    expect(() => S([h, { emit: { end: 'log', event: { body: {} } }, note: 'x' }])).toThrow('a line is one of');
  });

  /** A kernel that is only a log: what an `emit` at the log end appends, an `expect` at the log end reads. */
  const logDriver = (): ScenarioDriver & { logs: Map<string, unknown[]> } => {
    const logs = new Map<string, unknown[]>();
    return {
      logs,
      start: async () => ({
        log: (k) => logs.get(k) ?? [],
        attention: (k) => ({ events: (logs.get(k) ?? []).length }),
        append: (k, e) => logs.set(k, [...(logs.get(k) ?? []), { ...e, seq: (logs.get(k) ?? []).length + 1 }]),
        stop: async () => {},
      }),
    };
  };
  const ev = (t: string, extra: Record<string, unknown> = {}) => ({ emit: { end: 'log', event: { ts: 1, body: { t, ...extra } } } });

  it('run: expectations bind and keep order at an end; none checks its window at the end; gapless reads the seqs; a failure says the line and what was there', async () => {
    const ok = S([h, ev('a', { id: 'x1' }), ev('b'), ev('a', { id: 'x2' }), { expect: { end: 'log', match: { body: { t: 'a', id: '<$first>' } } } }, { expect: { end: 'log', none: { body: { id: '<$first>' } } } }, { expect: { end: 'log', match: { body: { t: 'a' }, seq: 3 } } }, { expect: { end: 'log', gapless: true } }, { expect: { end: 'attention', match: { events: 3 } } }]);
    expect((await runScenario(ok, logDriver(), { settleMs: 0 })).bindings.get('first')).toBe('x1');
    const twice = S([h, ev('a', { id: 'x1' }), ev('a', { id: 'x1' }), { expect: { end: 'log', match: { body: { id: '<$first>' } } } }, { expect: { end: 'log', none: { body: { id: '<$first>' } } } }]);
    await expect(runScenario(twice, logDriver(), { settleMs: 0 })).rejects.toThrow('x:5: expected no {"body":{"id":"<$first>"}} at log:s, got {"ts":1,"body":{"t":"a","id":"x1"},"seq":2}');
    const order = S([h, ev('b'), ev('a'), { expect: { end: 'log', match: { body: { t: 'a' } } } }, { expect: { end: 'log', timeoutMs: 50, match: { body: { t: 'b' } } } }]);
    await expect(runScenario(order, logDriver(), { settleMs: 0 })).rejects.toThrow('x:5: expected at log:s: {"body":{"t":"b"}}\ngot nothing since the last match');
    const next = S([h, ev('a'), ev('b'), { expect: { end: 'log', next: true, timeoutMs: 50, match: { body: { t: 'b' } } } }]);
    await expect(runScenario(next, logDriver(), { settleMs: 0 })).rejects.toThrow('x:4: expected at log:s (next)');
  });

  /** A kernel with a log and the reference channel: a message emitted at the channel end is in the log (`admitted`) before its answer. */
  const channelDriver = (): ScenarioDriver => ({
    start: async ({ channel }) => {
      const logs = new Map<string, unknown[]>();
      const ac = new AbortController();
      const emit = async (env: { id: string }) => {
        const log = logs.get('s') ?? [];
        logs.set('s', [...log, { ts: 1, body: { t: 'admitted', id: env.id }, seq: log.length + 1 }]);
        return { accepted: true, inputId: env.id };
      };
      void channel.start({ account: 'default', config: {}, signal: ac.signal, emit, log: () => {} });
      return { log: (k) => logs.get(k) ?? [], stop: async () => ac.abort() };
    },
  });

  it('run: after orders items across ends, the log end too: every log a line names is read whenever any end observes an item, from the start', async () => {
    const msg = (id: string) => ({ emit: { end: 'channel', frame: { type: 'inbound', envelope: { id, text: id } } } });
    const answer = (id: string, more: Record<string, unknown> = {}) => ({ expect: { end: 'channel', ...more, match: { type: 'result', ok: true, value: { inputId: id } } } });
    const o = { settleMs: 0, timeoutMs: 1000 };
    // m1 is in the log before r1 (its answer), m2 after it: the first admission after r1 is m2's, though no line named the log before.
    const logAfter = S([h, msg('m1'), answer('m1', { label: 'r1' }), msg('m2'), answer('m2'), { expect: { end: 'log', after: 'r1', match: { body: { t: 'admitted', id: '<$which>' } } } }]);
    expect((await runScenario(logAfter, channelDriver(), o)).bindings.get('which')).toBe('m2');
    // Both admissions were before `later` (m2's answer): none is after it, with or without an earlier line naming the log.
    const lines = [msg('m1'), answer('m1'), msg('m2'), answer('m2', { label: 'later' }), { expect: { end: 'log', after: 'later', timeoutMs: 50, match: { body: { t: 'admitted' } } } }];
    await expect(runScenario(S([h, ...lines]), channelDriver(), o)).rejects.toThrow('x:6: expected at log:s after later: {"body":{"t":"admitted"}}');
    await expect(runScenario(S([h, { expect: { end: 'log', none: { body: { t: 'no-such-event' } } } }, ...lines]), channelDriver(), o)).rejects.toThrow('x:7: expected at log:s after later');
    // And the other way: the answer observed after m2's admission is m2's.
    const channelAfter = S([h, msg('m1'), msg('m2'), { expect: { end: 'log', label: 'a2', match: { body: { id: 'm2' } } } }, { expect: { end: 'channel', after: 'a2', match: { type: 'result', value: { inputId: '<$answered>' } } } }]);
    expect((await runScenario(channelAfter, channelDriver(), o)).bindings.get('answered')).toBe('m2');
  });

  it('the conformance data: every scenario and transcript parses; every transcript a scenario plays is there; the kernel and attention directories have scenarios', () => {
    const scenarios = ndjsonUnder(join(CONFORMANCE, 'scenarios'));
    const transcripts = ndjsonUnder(join(CONFORMANCE, 'transcripts'));
    expect(scenarioFiles(join(CONFORMANCE, 'scenarios', 'kernel')).length).toBeGreaterThanOrEqual(5);
    expect(scenarioFiles(join(CONFORMANCE, 'scenarios', 'attention')).length).toBeGreaterThanOrEqual(20);
    for (const f of scenarios) {
      const s = readScenario(f);
      for (const { step } of s.steps) if ('harness' in step && 'transcript' in step.harness) expect(() => readTranscript(resolve(dirname(f), step.harness.transcript)), f).not.toThrow();
    }
    for (const f of transcripts) {
      const t = readTranscript(f);
      expect(t.header.protocol, f).toBe(f.includes('/codex/') ? 'codex.app-server' : 'aio.jsonl-harness');
    }
    expect(transcripts.filter((f) => f.includes('/codex/')).map((f) => f.split('/').pop()).sort()).toEqual(['approval.ndjson', 'interrupt.ndjson', 'plain-turn.ndjson', 'steer.ndjson']);
  });

  it('every scenario under conformance/scenarios is one a core runner plays (the top level of kernel/ or attention/), and those are exactly the scenarios invariants.mjs counts', () => {
    // The runners: packages/kernel/test/scenarios.test.ts plays scenarioFiles(scenarios/kernel), packages/session/test/attention.test.ts scenarioFiles(scenarios/attention).
    const played = ['kernel', 'attention'].flatMap((d) => scenarioFiles(join(CONFORMANCE, 'scenarios', d))).sort();
    expect(ndjsonUnder(join(CONFORMANCE, 'scenarios')).sort()).toEqual(played);
    const listed = JSON.parse(execFileSync(process.execPath, [join(root, 'scripts', 'invariants.mjs'), 'list', '--json'], { encoding: 'utf8', maxBuffer: 64 << 20 })) as { file: string; scenario?: boolean }[];
    expect(listed.filter((t) => t.scenario).map((t) => join(root, t.file)).sort()).toEqual(played);
  });
});
