import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BLOB_GET_MAX_BYTES, type BlobAccess, type HarnessAdapter } from '@agents-io/protocol';
import { runHarnessConformance, runHarnessEnvConformance } from '@agents-io/testkit';
import { spawnHarness, type BridgedHarness } from '../src/index.js';
import { alive, calls, collect, disposeAll, fakeProgram, input, openArgs, rawProgram, tmpFile, track, waitFor } from './bridge-helpers.js';

afterEach(disposeAll);

const DECLARES = { displayName: 'Plug', compact: { command: '/squash' }, modes: ['plan'], ownerProfileSwitch: true, ephemeralOpen: true, adopts: true, attach: 'join', sessionEnv: 'own-process' };
const declared = (h: HarnessAdapter) => ({ displayName: h.displayName, compact: h.compact, modes: h.modes, ownerProfileSwitch: h.ownerProfileSwitch, ephemeralOpen: h.ephemeralOpen, adopts: h.adopts, attach: h.attach, sessionEnv: h.sessionEnv });
const nothing = { displayName: undefined, compact: undefined, modes: undefined, ownerProfileSwitch: undefined, ephemeralOpen: undefined, adopts: undefined, attach: undefined, sessionEnv: undefined };

describe('the harness bridge: hello', () => {
  it("the program's answer to probe is what the adapter declares and which optional methods it has; before it the adapter declares nothing; an older program's (version and caps only) gets today's defaults #PR-1", async () => {
    const p = fakeProgram({ DECLARES: JSON.stringify(DECLARES), METHODS: 'detach' }, { instance: 'plug', config: { greeting: 'hi' } });
    expect(declared(p.h)).toEqual(nothing);
    expect(p.h.detach).toBeUndefined();
    expect(p.h.ownProcess).toBeUndefined();
    expect(p.h.state()).toEqual({ connected: false });
    expect((await p.h.probe()).caps).toMatchObject({ steer: 'none', interrupt: true });
    expect(declared(p.h)).toEqual(DECLARES);
    expect(typeof p.h.detach).toBe('function');
    expect(typeof p.h.ownProcess).toBe('function');
    expect(p.h.state()).toEqual({ connected: true });
    // The host says what it speaks, and which instance and config the program serves.
    expect(p.calls().find((c) => c.call === 'init')).toMatchObject({ call: 'init', instance: 'plug', config: { greeting: 'hi' }, blobs: true });

    const old = rawProgram();
    expect(await old.h.probe()).toEqual({ version: 'raw-1', caps: expect.objectContaining({ resume: true }) });
    expect(declared(old.h)).toEqual(nothing);
    expect(old.h.detach).toBeUndefined();
    expect(old.h.ownProcess).toBeUndefined();
  });

  it("refuses a hello of the wrong shape, naming the member; 'takeover' (the bridge carries no takeover); a frame of another protocol version; a restarted program declaring otherwise than the first; a program that cannot be run #CF-4", async () => {
    const refused = async (hello: unknown) => (await rawProgram({ HELLO: JSON.stringify(hello) }).h.probe().catch((e) => e)) as Error & { code: string };
    const caps = (await rawProgram().h.probe()).caps;
    expect(await refused({ version: 'x', caps, declares: { modes: ['fast'] } })).toMatchObject({ code: 'bad_hello', message: expect.stringContaining('/declares/modes/0') });
    expect(await refused({ version: 'x', caps, declares: { sessionEnv: null } })).toMatchObject({ code: 'bad_hello', message: expect.stringContaining('/declares/sessionEnv') });
    expect(await refused({ version: 'x', caps, declares: { compact: { command: '' } } })).toMatchObject({ code: 'bad_hello', message: expect.stringContaining('/declares/compact/command') });
    expect(await refused({ version: 'x', caps, declares: { displayName: 7 } })).toMatchObject({ code: 'bad_hello', message: expect.stringContaining('/declares/displayName') });
    expect(await refused({ version: 'x', caps: { steer: 'sometimes' } })).toMatchObject({ code: 'bad_hello', message: expect.stringContaining('/caps') });
    expect(await refused({ version: 'x', caps, declares: { attach: 'takeover' } })).toMatchObject({ code: 'bad_hello', message: "declares attach 'takeover', which needs a takeover (HarnessAdapter.takeover); the bridge cannot carry one" });
    await expect(rawProgram({ MODE: 'v2' }).h.probe()).rejects.toMatchObject({ code: 'bad_result' });
    await expect(spawnHarness({ command: '/nonexistent/harness-program' }).probe()).rejects.toMatchObject({ code: 'ENOENT' });

    // A program that dies and is started again must declare what it did the first time.
    const launches = tmpFile('launches');
    const r = rawProgram({ LAUNCHES: launches, HELLO: JSON.stringify({ version: 'x', caps, declares: { displayName: 'A' } }), HELLO2: JSON.stringify({ version: 'x', caps, declares: { displayName: 'B' } }) });
    const s = await r.h.open(openArgs());
    await s.startTurn('t1', [input('i1', 'die')]);
    await collect(s.events, () => false).catch(() => undefined);
    await expect(r.h.open(openArgs('s2'))).rejects.toMatchObject({ code: 'bad_hello', message: expect.stringContaining('a restarted program must declare the same') });
    expect(r.h.displayName).toBe('A');
  });
});

describe('the harness bridge: sessions', () => {
  it('passes the harness conformance suite, as an in-process adapter does: probe, declarations, a turn, steer, interrupt, close #HC-1', async () => {
    const p = fakeProgram({ DECLARES: JSON.stringify(DECLARES), METHODS: 'detach' });
    const report = await runHarnessConformance({ adapter: p.h, open: openArgs(), longTurn: { turnId: 't-long', inputs: [input('i-long', 'long job')] } });
    expect(report.failed).toEqual([]);
    expect(report.passed).toEqual(['probe.schema', 'declares.schema', 'methods.functions', 'open', 'turn.completes', 'steer.result', 'interrupt.ends_turn', 'close.ends_stream', 'stream.conforms']);
    expect(p.calls().filter((c) => c.call === 'interrupt' || c.call === 'close').map((c) => c.call)).toEqual(['interrupt', 'close']);
  });

  it("a per-session env reaches the program's session and nothing else: not its command line, not an event (env conformance) #HC-2", async () => {
    const p = fakeProgram();
    const report = await runHarnessEnvConformance({
      adapter: p.h,
      open: openArgs(),
      turn: { turnId: 't1', inputs: [input('i1', 'hi')] },
      lastSpawn: () => ({ env: p.calls().findLast((c) => c.call === 'open')!.env ?? {}, argv: p.calls().find((c) => c.call === 'start')!.argv }),
    });
    expect(report.failed).toEqual([]);
    expect(report.passed).toEqual(['env.in_child_env', 'env.not_in_argv', 'env.not_in_events']);
  });

  it("a session's native id, and the command a terminal joins it with, come from the program; inject and cancelQueued exist as its caps say #LN-8 #HC-1", async () => {
    const p = fakeProgram({ CLIENT: '1', CAPS: JSON.stringify({ injectWithoutTurn: true, cancelQueued: true }) });
    const s = await p.h.open(openArgs('k1'));
    expect(s.nativeId()).toBe('native-k1');
    expect(p.h.nativeClient!('native-k1')).toEqual({ command: 'fake-tui', args: ['--resume', 'native-k1'] });
    expect(p.h.nativeClient!('native-other')).toBeUndefined();
    await s.inject!([input('c1', 'context')]);
    await s.cancelQueued!(['q1']);
    expect(p.calls().filter((c) => c.call === 'inject' || c.call === 'cancelQueued')).toEqual([
      expect.objectContaining({ call: 'inject', sessionKey: 'k1', inputs: ['context'] }),
      expect.objectContaining({ call: 'cancelQueued', sessionKey: 'k1', inputIds: ['q1'] }),
    ]);
    const bare = fakeProgram();
    const b = await bare.h.open(openArgs('k2'));
    expect(b.inject).toBeUndefined();
    expect(b.cancelQueued).toBeUndefined();
    expect(bare.h.nativeClient!('native-k2')).toBeUndefined();
  });

  it("drops malformed, unknown and invalid frames from the program without breaking the connection #PR-2", async () => {
    const r = rawProgram({ MODE: 'noisy' });
    await r.h.probe();
    const s = await r.h.open(openArgs());
    await s.startTurn('t1', [input('i1', 'still here')]);
    const evs = await collect(s.events, (e) => e.body.t === 'turn.completed');
    expect(evs.find((e) => e.body.t === 'text.snapshot')?.body).toMatchObject({ text: 'raw: still here' });
    expect(r.logs).toEqual(expect.arrayContaining([expect.stringMatching(/^warn: dropping malformed line/), 'debug: ignoring unknown frame type from-the-future', 'warn: dropping invalid event frame', 'info: noisy program says hi']));
  });
});

describe('the harness bridge: blobs', () => {
  it("the program reads the host's blob store, read-only, as an in-process harness does (blob.stat, blob.get): a stored image's path and bytes; nothing for a ref the store lacks; get refuses one over its limit #MD-1", async () => {
    const file = tmpFile('img.png');
    writeFileSync(file, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const stored: Record<string, { path: string; mime: string; name?: string; size: number }> = {
      'sha256:img': { path: file, mime: 'image/png', name: 'img.png', size: 4 },
      'sha256:big': { path: file, mime: 'application/zip', size: BLOB_GET_MAX_BYTES + 1 },
    };
    const blobs: BlobAccess = {
      stat: async (ref) => stored[ref],
      get: async (ref) => {
        if (!stored[ref]) throw new Error(`no blob ${ref}`);
        return { bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]), mime: stored[ref]!.mime };
      },
    };
    const p = fakeProgram({}, { blobs });
    const s = await p.h.open(openArgs());
    const media = (ref: string, type: 'image' | 'file', mime: string) => ({ type, ref, mime });
    await s.startTurn('t1', [input('i1', 'see', { content: [media('sha256:img', 'image', 'image/png'), media('lark-file:x', 'file', 'application/pdf'), media('sha256:big', 'file', 'application/zip')] })]);
    await collect(s.events, (e) => e.body.t === 'turn.completed');
    expect(p.calls().find((c) => c.call === 'blobs')!.seen).toEqual([
      'sha256:img: stat image/png 4 true; get image/png 4 89504e47',
      'lark-file:x: stat none; get error not_found',
      `sha256:big: stat application/zip ${BLOB_GET_MAX_BYTES + 1} true; get error too_large`,
    ]);

    // Without a store, both fail (`unsupported`): the host has none to read.
    const none = fakeProgram();
    const n = await none.h.open(openArgs());
    await n.startTurn('t1', [input('i1', 'see', { content: [media('sha256:img', 'image', 'image/png')] })]);
    await collect(n.events, (e) => e.body.t === 'turn.completed');
    expect(none.calls().find((c) => c.call === 'blobs')!.seen).toEqual(['sha256:img: stat error unsupported; get error unsupported']);
  });
});

describe('the harness bridge: stop', () => {
  it('detach (a program that has it): it detaches its sessions, keeping the running turn (no close, no interrupt, no more events), then it is shut down and exits #RS-2', async () => {
    const state = tmpFile('state.json');
    const p = fakeProgram({ METHODS: 'detach', STATE: state, DECLARES: JSON.stringify({ adopts: true }) });
    const s = await p.h.open(openArgs('k1'));
    await s.startTurn('t1', [input('i1', 'long job')]);
    await collect(s.events, (e) => e.body.t === 'turn.started');
    const pid = p.calls().find((c) => c.call === 'start')!.pid as number;
    await p.h.detach!();
    // The session ends on the host side; the turn was never completed.
    const rest = await collect(s.events, () => false);
    expect(rest.map((e) => e.body.t)).not.toContain('turn.completed');
    await waitFor(() => !alive(pid));
    expect(p.calls().map((c) => c.call)).toEqual(['start', 'init', 'open', 'startTurn', 'detach', 'exit']);
    expect(p.calls().find((c) => c.call === 'detach')!.running).toEqual({ k1: { turnId: 't1', inputIds: ['i1'] } });
    await expect(p.h.open(openArgs('k2'))).rejects.toMatchObject({ code: 'closed' });

    // The next host's program adopts the turn when the session reopens with its native id.
    const q = fakeProgram({ METHODS: 'detach', STATE: state, DECLARES: JSON.stringify({ adopts: true }) });
    const s2 = await q.h.open(openArgs('k1', { resume: 'native-k1' }));
    const evs = await collect(s2.events, (e) => e.body.t === 'turn.completed');
    expect(evs.map((e) => e.body.t)).toEqual(['turn.adopted', 'input.consumed', 'text.snapshot', 'turn.completed']);
  });

  it('dispose shuts the program down, which stops what it still runs; one that ignores shutdown is killed after the grace period #RS-8', async () => {
    const p = fakeProgram();
    await p.h.open(openArgs('k1'));
    const pid = p.calls().find((c) => c.call === 'start')!.pid as number;
    await p.h.dispose();
    expect(alive(pid)).toBe(false);
    expect(p.calls().map((c) => c.call)).toEqual(['start', 'init', 'open', 'close', 'dispose', 'exit']);
    await expect(p.h.probe()).rejects.toMatchObject({ code: 'closed' });

    const stubborn = fakeProgram({ MODE: 'stubborn' }, { shutdownGraceMs: 200 });
    await stubborn.h.probe();
    const spid = stubborn.calls().find((c) => c.call === 'start')!.pid as number;
    const t0 = Date.now();
    await stubborn.h.dispose();
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(alive(spid)).toBe(false);
  });
});

describe('the harness bridge: own process', () => {
  it("sessionEnv 'own-process': ownProcess is a copy of the program of its own, with the env over the instance's and the cwd, declaring what the first did #LA-3", async () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'hbridge-cwd-')));
    const p = fakeProgram({ DECLARES: JSON.stringify({ sessionEnv: 'own-process', displayName: 'Plug' }), ROLE: 'shared' });
    await p.h.probe();
    const ownRecord = tmpFile('own.jsonl');
    const own = track(p.h.ownProcess!({ env: { ROLE: 'own', RECORD: ownRecord }, cwd }) as BridgedHarness);
    // Known before its program starts: the first one's.
    expect(own.displayName).toBe('Plug');
    expect(own.sessionEnv).toBe('own-process');
    expect(typeof own.ownProcess).toBe('function');
    await own.open(openArgs('k1'));
    expect(calls(ownRecord).map((c) => c.call)).toEqual(['start', 'init', 'open']);
    expect(calls(ownRecord)[0]).toMatchObject({ role: 'own', cwd });
    expect(p.calls()[0]).toMatchObject({ role: 'shared' });
    expect(p.calls().some((c) => c.call === 'open')).toBe(false);
  });
});
