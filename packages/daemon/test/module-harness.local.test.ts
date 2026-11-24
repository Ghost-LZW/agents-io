import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { SessionEvent } from '@agents-io/protocol';
import { FakeChannel, type FakeHarness } from '@agents-io/testkit';
import { LocalClient, readTokenFile, tokenPath } from '@agents-io/kernel';
import { Gateway, resolveConfig } from '../src/defaults.js';
import { cleanups, tmp, until } from './helpers.js';

/* A `use: "module"` harness gets the lifecycle calls a built-in adapter gets (HarnessAdapter detach / dispose / adopts): fixtures/harness-lifecycle.mjs. */

const here = dirname(fileURLToPath(import.meta.url));
const alice = { channelUserId: 'alice', evidence: 'platform_signed' as const };
const of = (evs: SessionEvent[], t: string) => evs.map((e) => e.body).filter((b) => b.t === t);
type Rec = { fake: FakeHarness; calls: string[] };
/** What each daemon start's factory call recorded for `key`. */
const recs = (key: string): Rec[] => ((globalThis as { __lifecycle?: Record<string, Rec[]> }).__lifecycle ??= {})[key] ?? [];
let keys = 0;

const lifecycle = (config: Record<string, unknown>) => ({ use: 'module', module: './fixtures/harness-lifecycle.mjs', config });

/**
 * A daemon on `dir`'s log whose default instance `plug` is the lifecycle module with `config`;
 * `others` adds more instances of it (name → its config).
 */
async function start(dir: string, config: Record<string, unknown>, agents?: Record<string, unknown>, others: Record<string, Record<string, unknown>> = {}) {
  mkdirSync(join(dir, 'work'), { recursive: true });
  const raw = {
    dataDir: dir,
    policy: { owners: ['fake:alice'] },
    local: { principal: 'me' },
    cwd: join(dir, 'work'),
    harnesses: { plug: lifecycle(config), ...Object.fromEntries(Object.entries(others).map(([name, c]) => [name, lifecycle(c)])) },
    defaultHarness: 'plug',
    ...(agents ? { agents } : {}),
  };
  const base = resolveConfig(raw, { env: {}, baseDir: here, cwd: dir });
  const socketPath = join(dir, 'run', 'aio.sock');
  const chat = new FakeChannel('fake');
  const gw = await Gateway.start({ config: { ...base, socketPath }, channels: [{ adapter: chat }], logger: () => {} });
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    await gw.stop();
  };
  cleanups.push(stop);
  const host = async () => {
    const c = await LocalClient.connect(socketPath);
    cleanups.push(() => c.close());
    await c.hello({ token: readTokenFile(tokenPath(socketPath)), name: 'test' });
    return c;
  };
  return { gw, chat, stop, host };
}

/** A session left mid-turn by a daemon on `dir` that stopped; returns its key. */
async function leaveTurn(dir: string, config: Record<string, unknown>): Promise<string> {
  const a = await start(dir, config);
  await a.chat.inject({ sender: alice, text: 'long job' });
  const key = await until(() => a.gw.hub.log.sessions().find((k) => a.gw.hub.snapshot(k).turn));
  await a.stop();
  return key;
}

describe('module harness lifecycle', () => {
  it('with detach: at stop its lane is detached (the running turn is not interrupted and stays open) and detach is called once, not dispose', async () => {
    const key = `k${++keys}`;
    const dir = tmp();
    const a = await start(dir, { key, detach: true, dispose: true });
    await a.chat.inject({ sender: alice, text: 'long job' });
    const sk = await until(() => a.gw.hub.log.sessions().find((k) => a.gw.hub.snapshot(k).turn));
    await a.stop();
    expect(recs(key)[0]!.calls).toEqual(['detach']);
    const b = await start(dir, { key });
    expect(of(b.gw.hub.log.read(sk, 0), 'turn.completed')).toEqual([expect.objectContaining({ status: 'ambiguous', error: expect.objectContaining({ code: 'host_restarted' }) })]);
  });

  it('without detach: at stop its sessions are closed (the running turn ends), then dispose is called', async () => {
    const key = `k${++keys}`;
    const dir = tmp();
    const a = await start(dir, { key, dispose: true });
    await a.chat.inject({ sender: alice, text: 'long job' });
    const sk = await until(() => a.gw.hub.log.sessions().find((k) => a.gw.hub.snapshot(k).turn));
    await a.stop();
    expect(recs(key)[0]!.calls).toEqual(['dispose']);
    const b = await start(dir, { key });
    const done = of(b.gw.hub.log.read(sk, 0), 'turn.completed');
    expect(done).toHaveLength(1);
    expect(done[0]).not.toMatchObject({ error: { code: 'host_restarted' } });
  });

  it('adopts: the next start reopens a session left mid-turn before any input (the harness opens it with resume); without it the turn is settled ambiguous and the harness is not opened', async () => {
    const adopting = `k${++keys}`;
    const d1 = tmp();
    const k1 = await leaveTurn(d1, { key: adopting, detach: true, adopts: true });
    const b = await start(d1, { key: adopting, detach: true, adopts: true });
    const reopened = recs(adopting)[1]!.fake;
    await until(() => reopened.sessions.length === 1);
    expect(reopened.sessions[0]!.args).toMatchObject({ sessionKey: k1, resume: 'n1' });
    // The fake does not adopt it, so the lane settles it once open (RS-5).
    await until(() => !b.gw.hub.snapshot(k1).turn);

    const plain = `k${++keys}`;
    const d2 = tmp();
    const k2 = await leaveTurn(d2, { key: plain, detach: true });
    const c = await start(d2, { key: plain, detach: true });
    expect(c.gw.hub.snapshot(k2).turn).toBeFalsy();
    expect(of(c.gw.hub.log.read(k2, 0), 'turn.completed')).toEqual([expect.objectContaining({ status: 'ambiguous', error: expect.objectContaining({ code: 'host_restarted' }) })]);
    expect(recs(plain)[1]!.fake.sessions).toEqual([]);
  });

  it('a task run on a module instance never disposes the adapter the instance shares; a failing detach or dispose does not fail the stop', async () => {
    const key = `k${++keys}`;
    const dir = tmp();
    const a = await start(dir, { key, dispose: true }, { exec: { harness: 'plug', mode: 'task' } });
    const h = await a.host();
    await h.runStart({ runId: 'r1', agent: 'exec', input: [{ type: 'text', text: 'pong' }] });
    expect(await h.runEndedOf('r1')).toMatchObject({ status: 'completed', exitCode: 0 });
    expect(recs(key)[0]!.calls).toEqual([]);
    // A rejecting dispose is logged; the stop still finishes.
    const rec = recs(key)[0]!;
    rec.calls.push = () => {
      throw new Error('boom');
    };
    await expect(a.stop()).resolves.toBeUndefined();
  });

  it('every module instance gets its lifecycle calls at stop: one no session used, one only task runs used; an adapter two instances share gets each call once', async () => {
    const [plug, idle, runs, twin] = [`k${++keys}`, `k${++keys}`, `k${++keys}`, `k${++keys}`];
    const dir = tmp();
    const a = await start(
      dir,
      { key: plug },
      { exec: { harness: 'runs', mode: 'task' } },
      {
        idle: { key: idle, detach: true, dispose: true },
        runs: { key: runs, dispose: true },
        twin1: { key: twin, share: twin, detach: true },
        twin2: { key: twin, share: twin, detach: true },
      },
    );
    const h = await a.host();
    await h.runStart({ runId: 'r1', agent: 'exec', input: [{ type: 'text', text: 'pong' }] });
    expect(await h.runEndedOf('r1')).toMatchObject({ status: 'completed', exitCode: 0 });
    expect(recs(runs)[0]!.fake.sessions).toHaveLength(1);
    await a.stop();
    expect(recs(idle)[0]!.calls).toEqual(['detach']);
    expect(recs(runs)[0]!.calls).toEqual(['dispose']);
    expect(recs(twin)).toHaveLength(1);
    expect(recs(twin)[0]!.calls).toEqual(['detach']);
  });
});
