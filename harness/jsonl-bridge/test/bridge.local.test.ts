import { afterEach, describe, expect, it } from 'vitest';
import type { HarnessResolveContext } from '@agents-io/protocol';
import { bridgeHarnessModule } from '../src/index.js';
import { collect, disposeAll, fakeProgram, input, openArgs, rawProgram, waitFor } from './bridge-helpers.js';

afterEach(disposeAll);

describe('the harness bridge: a program that goes away', () => {
  it('a program that dies mid-turn ends its sessions (their streams end, no turn.completed) and fails what was asked of it, retryably; the next open starts it again', async () => {
    const p = fakeProgram();
    const s = await p.h.open(openArgs('k1'));
    await s.startTurn('t1', [input('i1', 'die')]);
    const evs = await collect(s.events, () => false);
    expect(evs.map((e) => e.body.t)).not.toContain('turn.completed');
    await expect(s.startTurn('t2', [input('i2', 'again')])).rejects.toMatchObject({ code: 'peer_closed', retryable: true });
    await s.close('done');
    expect(p.h.state()).toMatchObject({ connected: false, error: 'harness program exited (3)' });
    const s2 = await p.h.open(openArgs('k2'));
    await s2.startTurn('t3', [input('i3', 'back')]);
    const more = await collect(s2.events, (e) => e.body.t === 'turn.completed');
    expect(more.find((e) => e.body.t === 'text.snapshot')?.body).toMatchObject({ text: 'echo: back' });
    expect(p.calls().filter((c) => c.call === 'start')).toHaveLength(2);
  });

  it('a program that stops answering is killed after repeated timeouts; one that never says hello fails the probe and is killed', async () => {
    const r = rawProgram({ MODE: 'deaf' }, { requestTimeoutMs: 100, timeoutsBeforeRestart: 2 });
    const s = await r.h.open(openArgs());
    await expect(s.startTurn('t1', [input('i1', 'x')])).rejects.toMatchObject({ code: 'timeout', retryable: true });
    await expect(s.startTurn('t2', [input('i2', 'y')])).rejects.toMatchObject({ code: 'timeout', retryable: true });
    await collect(s.events, () => false);
    await waitFor(() => !r.h.state().connected);
    expect(r.logs).toContain('warn: harness program not answering (2 requests timed out); killing it');

    const mute = rawProgram({ MODE: 'mute' }, { helloTimeoutMs: 200 });
    await expect(mute.h.probe()).rejects.toMatchObject({ code: 'timeout' });
    expect(mute.h.state()).toEqual({ connected: false, error: 'probe timed out after 200ms' });
  });

  it("the program's stderr lines and log frames reach the host's log; a fatal one gets it killed, which ends its sessions", async () => {
    const noisy = rawProgram({ MODE: 'noisy' });
    await noisy.h.probe();
    await waitFor(() => noisy.logs.includes('info: noisy on stderr'));
    expect(noisy.logs).toContain('info: noisy program says hi');

    const fatal = rawProgram({ MODE: 'fatal' });
    const s = await fatal.h.open(openArgs());
    await collect(s.events, () => false);
    expect(fatal.logs).toContain('fatal: cannot go on');
    await waitFor(() => !fatal.h.state().connected);
  });
});

describe('the bridge harness kind', () => {
  const ctx = (env: Record<string, string> = {}): HarnessResolveContext & { missing: string[] } => {
    const missing: string[] = [];
    return {
      name: 'plug',
      where: 'harnesses.plug',
      env: {},
      path: (p) => (p.startsWith('/') ? p : `/cfg/${p.replace(/^\.\//, '')}`),
      secrets: {
        value: (name, at) => (env[name] === undefined ? void missing.push(`${at}: ${name}`) : env[name]),
        toChild: () => {},
      },
      fail: (msg) => {
        throw new Error(msg);
      },
      missing,
    };
  };

  it('resolves its entry: a path command and cwd from the config file, a bare command as is, args as written, "env:NAME" in config substituted (a missing one names the key)', () => {
    const c = ctx({ TOKEN: 's3cret' });
    expect(bridgeHarnessModule.resolve!({ use: 'bridge', command: './bin/h', args: ['--x', 'env:TOKEN'], cwd: 'work', config: { token: 'env:TOKEN', list: ['env:TOKEN', 1] } }, c)).toEqual({
      launch: { command: '/cfg/bin/h', args: ['--x', 'env:TOKEN'], cwd: '/cfg/work', config: { token: 's3cret', list: ['s3cret', 1] } },
    });
    expect(bridgeHarnessModule.resolve!({ use: 'bridge', command: 'python3' }, ctx())).toEqual({ launch: { command: 'python3' } });
    const m = ctx();
    bridgeHarnessModule.resolve!({ use: 'bridge', command: 'h', config: { a: { b: 'env:GONE' } } }, m);
    expect(m.missing).toEqual(['harnesses.plug.config.a.b: GONE']);
    expect(bridgeHarnessModule).toMatchObject({ kind: 'bridge', profilesInOpen: true, probeAtStart: true });
  });
});
