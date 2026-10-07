import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import type { FakeTurnScript } from '@agents-io/testkit';
import { daemon, tmp, until } from './helpers.js';

const AGENTS = {
  chat: { harness: 'claude-code', model: 'sonnet' },
  exec: { harness: 'claude-code', mode: 'task', profile: 'bypass', model: 'haiku' },
};

/** Fails the turn on `fail`, waits for an interrupt on `wait`, else echoes. */
const script: FakeTurnScript = async (t) => {
  const text = t.inputs.flatMap((i) => i.content).map((c) => (c.type === 'text' ? c.text : '')).join(' ');
  if (text.includes('fail')) throw new Error('boom');
  if (text.includes('wait')) await new Promise((_, reject) => t.signal.addEventListener('abort', () => reject(new Error('interrupted')), { once: true }));
  t.emit({ t: 'item.started', item: { itemId: 'i1', type: 'command', title: 'echo pong', status: 'running' } });
  t.emit({ t: 'text.snapshot', text: `echo: ${text}`, final: true }, { audience: 'answer' });
};

async function world(raw: Record<string, unknown> = {}) {
  return daemon({ raw: { agents: AGENTS, ...raw }, script });
}

describe('run.start', () => {
  it('runs one turn of a task agent in a fresh session run:<id> with its run config and the given cwd; run.ended exit 0; the session is closed', async () => {
    const w = await world();
    const h = await w.host();
    const r = await h.runStart({ runId: 'r1', agent: 'exec', cwd: w.dir, input: [{ type: 'text', text: 'pong please' }] });
    expect(r).toEqual({ runId: 'r1', sessionKey: 'run:r1', state: 'started' });
    const ended = await h.runEndedOf('r1');
    expect(ended).toMatchObject({ type: 'run.ended', runId: 'r1', sessionKey: 'run:r1', status: 'completed', exitCode: 0 });
    const s = w.harness.sessions.at(-1)!;
    expect(s.args).toMatchObject({ sessionKey: 'run:r1', cwd: w.dir, run: { harness: 'claude-code', model: 'haiku', profile: 'bypass' } });
    const log = w.gw.hub.log.read('run:r1', 0);
    expect(log.some((e) => e.body.t === 'text.snapshot' && e.body.text === 'echo: pong please')).toBe(true);
    // Closed: no live lane, the harness session's stream ended.
    expect(w.gw.sessions().find((x) => x.sessionKey === 'run:r1')).toMatchObject({ live: false, state: 'idle' });
    // The same runId again reports how it ended instead of running again.
    const again = await h.runStart({ runId: 'r1', agent: 'exec', input: [{ type: 'text', text: 'pong please' }] });
    expect(again).toMatchObject({ state: 'ended', ended: { status: 'completed', exitCode: 0 } });
    expect(w.harness.sessions.filter((x) => x.args.sessionKey === 'run:r1')).toHaveLength(1);
  });

  it('exit codes: a failing turn is 1, a cancel is 130, a timeout 124', async () => {
    const w = await world();
    const h = await w.host();
    await h.runStart({ runId: 'f', agent: 'exec', input: [{ type: 'text', text: 'please fail' }] });
    expect(await h.runEndedOf('f')).toMatchObject({ status: 'failed', exitCode: 1 });

    await h.runStart({ runId: 'c', agent: 'exec', input: [{ type: 'text', text: 'wait for cancel' }] });
    await until(() => w.gw.hub.snapshot('run:c').turn);
    expect(await h.runCancel('c', 'test')).toMatchObject({ cancelled: true });
    expect(await h.runEndedOf('c')).toMatchObject({ status: 'interrupted', exitCode: 130 });
    await expect(h.runCancel('c')).rejects.toMatchObject({ code: 'run_ended' });
    await expect(h.runCancel('nope')).rejects.toMatchObject({ code: 'unknown_run' });

    await h.runStart({ runId: 't', agent: 'exec', input: [{ type: 'text', text: 'wait forever' }], timeoutMs: 50 });
    expect(await h.runEndedOf('t')).toMatchObject({ status: 'interrupted', exitCode: 124, error: { code: 'timeout' } });
  });

  it('env goes into the run child only: the instance built for the run has it; the log, explain records and other instances do not', async () => {
    const w = await world();
    const h = await w.host();
    const secret = 'sekrit-value-123';
    await h.runStart({ runId: 'e', agent: 'exec', input: [{ type: 'text', text: 'hi' }], env: { XWO_CREDENTIAL: secret } });
    await h.runEndedOf('e');
    const runInst = w.built.find((i) => i.env.XWO_CREDENTIAL !== undefined)!;
    expect(runInst.env.XWO_CREDENTIAL).toBe(secret);
    expect(runInst.env.AGENTS_IO_RUN_ID).toBe('e');
    expect(JSON.parse(runInst.env.AGENTS_IO_TURN_PROVENANCE!)).toMatchObject({ sessionKey: 'run:e', triggeredBy: ['host:cli'], external: false });
    expect(w.built.filter((i) => i !== runInst).every((i) => i.env.XWO_CREDENTIAL === undefined)).toBe(true);
    // Nothing persisted carries it.
    await w.stop();
    for (const f of ['log.sqlite', 'log.sqlite-wal']) {
      try {
        expect(readFileSync(join(w.dir, f)).includes(secret)).toBe(false);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      }
    }
  });

  it('refuses interactive and unknown agents, bad cwd and env names', async () => {
    const w = await world();
    const h = await w.host();
    const input = [{ type: 'text' as const, text: 'x' }];
    await expect(h.runStart({ runId: 'a', agent: 'chat', input })).rejects.toMatchObject({ code: 'not_task_agent' });
    await expect(h.runStart({ runId: 'a', agent: 'ghost', input })).rejects.toMatchObject({ code: 'unknown_agent' });
    await expect(h.runStart({ runId: 'a', agent: 'exec', input, cwd: join(w.dir, 'missing') })).rejects.toMatchObject({ code: 'bad_cwd' });
    await expect(h.runStart({ runId: 'a', agent: 'exec', input, cwd: 'relative' })).rejects.toMatchObject({ code: 'bad_cwd' });
    await expect(h.runStart({ runId: 'a', agent: 'exec', input, env: { 'NOT-A-VAR': '1' } })).rejects.toMatchObject({ code: 'bad_env' });
    await expect(h.runStart({ runId: 'has space', agent: 'exec', input })).rejects.toMatchObject({ code: 'bad_run_id' });
    // Plain client frames can not start runs.
    const plain = await w.client();
    await expect(plain.runStart({ runId: 'a', agent: 'exec', input })).rejects.toMatchObject({ code: 'unauthorized' });
  });

  it('agent instructions reach the harness; observe routes render the run on a channel; run.ended goes to the host when the asking connection left', async () => {
    const instructions = join(tmp(), 'executor.md');
    writeFileSync(instructions, 'You are the executor.\n');
    const w = await world({ agents: { ...AGENTS, exec: { ...AGENTS.exec, instructionsFile: instructions } } });
    const host = await w.host({ consumer: 'xwo' });
    host.onRequest('inbound', () => ({ accepted: true }));
    const tool = await w.host({ name: 'aio-run' });
    const route = { channel: 'fake', account: 'default', conversationId: 'ops' };
    await tool.runStart({ runId: 'o', agent: 'exec', input: [{ type: 'text', text: 'wait' }], observe: { routes: [route] } });
    await until(() => w.chat.sent.some((s) => s.route.conversationId === 'ops'));
    const s = w.harness.sessions.at(-1)!;
    expect((s.args.options as { sdk?: { systemPrompt?: unknown } }).sdk?.systemPrompt).toEqual({ type: 'preset', preset: 'claude_code', append: 'You are the executor.\n' });
    const endedToHost = host.runEndedOf('o');
    tool.close();
    await new Promise((r) => setTimeout(r, 50));
    await host.runCancel('o');
    expect(await endedToHost).toMatchObject({ runId: 'o', status: 'interrupted', exitCode: 130 });
    // The observed card was finalized with the run's end.
    await until(() => w.chat.sent.find((x) => x.route.conversationId === 'ops')?.finalized);
  });

  it('a run an earlier daemon left mid-turn is ambiguous (exit 3) after the restart', async () => {
    const w = await world();
    // What a crashed daemon leaves: a run session whose turn never completed.
    const draft = { ts: Date.now(), level: 'primary' as const, audience: 'status' as const, durability: 'durable' as const, harness: 'claude-code', generation: 1 };
    w.gw.hub.append('run:d', { ...draft, turnId: 't-d', body: { t: 'turn.started', turnId: 't-d', inputIds: ['in-d'], replyRoute: null } });
    await w.stop();
    const w2 = await daemon({ dir: w.dir, raw: { agents: AGENTS }, script });
    const h = await w2.host();
    expect(await h.runStart({ runId: 'd', agent: 'exec', input: [{ type: 'text', text: 'again' }] })).toMatchObject({ state: 'ended', ended: { status: 'ambiguous', exitCode: 3, error: { code: 'host_restarted' } } });
  });

  it('daemon stop interrupts running runs and tells their connections', async () => {
    const w = await world();
    const h = await w.host();
    await h.runStart({ runId: 's', agent: 'exec', input: [{ type: 'text', text: 'wait' }] });
    await until(() => w.gw.hub.snapshot('run:s').turn);
    const ended = h.runEndedOf('s');
    await w.stop();
    expect(await ended).toMatchObject({ status: 'interrupted' });
  });
});

describe('interactive agents', () => {
  it('a binding to a named agent opens its session with that agent: prefix, model, cwd', async () => {
    const w = await daemon({
      raw: {
        agents: { chat: { harness: 'claude-code' }, helper: { harness: 'claude-code', model: 'opus', cwd: 'helper-dir' } },
        bindings: [
          { id: 'owner', match: { conversationKind: 'dm', labels: ['owner'] }, on: 'dispatch', agent: 'chat', session: 'main' },
          { id: 'help', match: { keywords: ['help'] }, on: 'dispatch', agent: 'helper' },
        ],
      },
    });
    const r1 = await w.chat.inject({ sender: { channelUserId: 'alice', evidence: 'platform_signed' }, text: 'hi' });
    expect(w.gw.router.explain(r1.inputId!)!.matched).toEqual([{ bindingId: 'owner', source: 'config', on: 'dispatch', agent: 'chat', sessionKey: 'local:main' }]);
    const r2 = await w.chat.inject({ sender: { channelUserId: 'bob', evidence: 'platform_signed' }, conversation: { id: 'g9', kind: 'group' }, text: 'help me' });
    const ex = w.gw.router.explain(r2.inputId!)!;
    expect(ex.matched[0]).toMatchObject({ agent: 'helper', sessionKey: 'helper:fake:default:g9' });
    await until(() => w.harness.sessions.find((s) => s.args.sessionKey === 'helper:fake:default:g9'));
    const s = w.harness.sessions.find((x) => x.args.sessionKey === 'helper:fake:default:g9')!;
    expect(s.args.run).toMatchObject({ model: 'opus', profile: 'restricted' });
    expect(s.args.cwd).toBe(join(w.dir, 'helper-dir'));
  });
});
