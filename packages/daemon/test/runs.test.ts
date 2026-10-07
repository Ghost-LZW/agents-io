import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { HOST_RESULT_VALUES, errors } from '@agents-io/protocol';
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

  it('a session whose recorded agent is gone refuses input with agent_unavailable, never falling back to the default agent', async () => {
    const w1 = await daemon({ raw: { agents: { chat: { harness: 'claude-code' }, helper: { harness: 'claude-code', cwd: 'helper-dir' } } }, script });
    const c1 = await w1.client();
    await c1.input('helper:x', 'hi');
    await until(() => w1.harness.sessions.find((s) => s.args.sessionKey === 'helper:x'));
    await w1.stop();

    // Restarted without `helper`: the session it opened stays its own, closed.
    const w2 = await daemon({ dir: w1.dir, raw: { agents: { chat: { harness: 'claude-code' } } }, script });
    const c2 = await w2.client();
    await expect(c2.input('helper:x', 'again', 'queue', 'in-again')).rejects.toMatchObject({ code: 'agent_unavailable' });
    expect(w2.harness.sessions.find((s) => s.args.sessionKey === 'helper:x')).toBeUndefined();
    const log = w2.gw.hub.log.read('helper:x', 0);
    expect(log.some((e) => e.body.t === 'notice' && e.body.message.startsWith('agent_unavailable: session helper:x belongs to agent "helper"'))).toBe(true);
    expect(log.some((e) => e.body.t === 'input.rejected' && e.body.inputIds.includes('in-again') && e.body.reason === 'agent_unavailable')).toBe(true);
    // Without an inputId (`aio send`): the generated one is recorded as rejected.
    await expect(c2.input('helper:x', 'once more')).rejects.toMatchObject({ code: 'agent_unavailable' });
    const generated = w2.gw.hub.log.read('helper:x', 0).filter((e) => e.body.t === 'input.rejected' && e.body.inputIds.some((id) => id.startsWith('in_')));
    expect(generated).toHaveLength(1);
    // Other commands fail with the same code but write nothing to the log.
    const before = w2.gw.hub.log.read('helper:x', 0).length;
    expect(await w2.gw.command({ type: 'interrupt', sessionKey: 'helper:x' }, w2.gw.localOrigin('helper:x'))).toMatchObject({ ok: false, code: 'agent_unavailable' });
    expect(w2.gw.hub.log.read('helper:x', 0)).toHaveLength(before);
    // Still pinned to `helper`: a refusal never re-pins.
    expect(w2.gw.records.agentOf('helper:x')).toBe('helper');

    // A session never pinned still opens with the default agent (its cwd, not helper's), and is pinned to it.
    await c2.input('helper:new', 'hi');
    const fresh = await until(() => w2.harness.sessions.find((s) => s.args.sessionKey === 'helper:new'));
    expect(fresh.args.cwd).not.toBe(join(w1.dir, 'helper-dir'));
    expect(w2.gw.records.agentOf('helper:new')).toBe('chat');
  });

  it('a session whose recorded agent is a task agent now refuses input with agent_unavailable', async () => {
    const w1 = await daemon({ raw: { agents: { chat: { harness: 'claude-code' }, helper: { harness: 'claude-code' } } }, script });
    const c1 = await w1.client();
    await c1.input('helper:x', 'hi');
    await until(() => w1.harness.sessions.find((s) => s.args.sessionKey === 'helper:x'));
    await w1.stop();

    const w2 = await daemon({ dir: w1.dir, raw: { agents: { chat: { harness: 'claude-code' }, helper: { harness: 'claude-code', mode: 'task' } } }, script });
    const c2 = await w2.client();
    await expect(c2.input('helper:x', 'again')).rejects.toMatchObject({ code: 'agent_unavailable', message: expect.stringContaining('is a task agent now') });
    expect(w2.harness.sessions).toHaveLength(0);
    expect(w2.gw.records.agentOf('helper:x')).toBe('helper');
  });

  it('a channel message to a session whose agent is gone: refused (no harness), a notice on the route, and explain says agent_unavailable', async () => {
    const alice = { channelUserId: 'alice', evidence: 'platform_signed' as const };
    const owner = (agent: string) => [{ id: 'owner', match: { conversationKind: 'dm', labels: ['owner'] }, on: 'dispatch', agent, session: 'main' }];
    const w1 = await daemon({ raw: { agents: { chat: { harness: 'claude-code' } }, bindings: owner('chat') }, script });
    const r1 = await w1.chat.inject({ sender: alice, text: 'hi' });
    const key = w1.gw.router.explain(r1.inputId!)!.matched[0]!.sessionKey!;
    await until(() => w1.chat.sent.find((s) => s.finalized));
    await w1.stop();

    // `chat` renamed to `assistant`: the owner's rule still routes to the same session key, pinned to `chat`.
    const w2 = await daemon({ dir: w1.dir, raw: { agents: { assistant: { harness: 'claude-code' } }, bindings: owner('assistant') }, script });
    const r2 = await w2.chat.inject({ sender: alice, text: 'still there?' });
    expect(r2.accepted).toBe(true);
    const ex = w2.gw.router.explain(r2.inputId!)!;
    expect(ex.matched[0]).toMatchObject({ sessionKey: key, agent: 'assistant', rejected: { code: 'agent_unavailable' } });
    const h = await w2.host();
    const viaHost = await h.explain(r2.inputId!);
    expect(errors(HOST_RESULT_VALUES.explain, viaHost)).toEqual([]);
    expect(viaHost.matched[0]!.rejected?.code).toBe('agent_unavailable');
    const notice = await until(() => w2.chat.sent.find((s) => s.msg.text?.includes('agent is not available')));
    expect(notice.route).toMatchObject({ channel: 'fake' });
    expect(w2.harness.sessions).toHaveLength(0);
    const log = w2.gw.hub.log.read(key, 0);
    expect(log.some((e) => e.body.t === 'input.rejected' && e.body.inputIds.includes(r2.inputId!) && e.body.reason === 'agent_unavailable')).toBe(true);
  });

  it('an observe-only (context) message to a session whose agent is gone: refused and logged, but nothing is said on the route', async () => {
    const alice = { channelUserId: 'alice', evidence: 'platform_signed' as const };
    const rule = (agent: string, on: string) => [{ id: 'owner', match: { conversationKind: 'dm', labels: ['owner'] }, on, agent, session: 'main' }];
    const w1 = await daemon({ raw: { agents: { chat: { harness: 'claude-code' } }, bindings: rule('chat', 'dispatch') }, script });
    const r1 = await w1.chat.inject({ sender: alice, text: 'hi' });
    const key = w1.gw.router.explain(r1.inputId!)!.matched[0]!.sessionKey!;
    await until(() => w1.chat.sent.find((s) => s.finalized));
    await w1.stop();

    const w2 = await daemon({ dir: w1.dir, raw: { agents: { assistant: { harness: 'claude-code' } }, bindings: rule('assistant', 'context') }, script });
    const r2 = await w2.chat.inject({ sender: alice, text: 'just recording' });
    expect(w2.gw.router.explain(r2.inputId!)!.matched[0]).toMatchObject({ sessionKey: key, on: 'context', rejected: { code: 'agent_unavailable' } });
    const log = await until(() => {
      const l = w2.gw.hub.log.read(key, 0);
      return l.some((e) => e.body.t === 'input.rejected' && e.body.inputIds.includes(r2.inputId!)) ? l : undefined;
    });
    expect(log.some((e) => e.body.t === 'notice' && e.body.message.startsWith('agent_unavailable:'))).toBe(true);
    // Give a stray notice the chance to be sent, then check none was.
    await new Promise((r) => setTimeout(r, 50));
    expect(w2.chat.sent).toHaveLength(0);
    expect(w2.harness.sessions).toHaveLength(0);
  });
});
