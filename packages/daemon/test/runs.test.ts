import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { HOST_RESULT_VALUES, errors } from '@agents-io/protocol';
import type { InputRecord, RouteExplanation, RunEnded } from '@agents-io/protocol';
import { Hub, MemorySessionLog } from '@agents-io/session';
import type { Lane } from '@agents-io/session';
import type { FakeTurnScript } from '@agents-io/testkit';
import type { AgentConfig } from '../src/config.js';
import type { Peer } from '../src/local-server.js';
import { Runs, type RunDeps } from '../src/runs.js';
import { daemon, tmp, until } from './helpers.js';

const AGENTS = {
  chat: { harness: 'claude-code', model: 'sonnet' },
  exec: { harness: 'claude-code', mode: 'task', profile: 'bypass', model: 'haiku' },
};

/** Fails the turn on `fail`, waits for an interrupt on `wait`, never ends on `hang`, reports usage on `usage`, else echoes. */
const script: FakeTurnScript = async (t) => {
  const text = t.inputs.flatMap((i) => i.content).map((c) => (c.type === 'text' ? c.text : '')).join(' ');
  if (text.includes('usage')) t.usage({ totalCostUsd: 0.25, usage: { input_tokens: 12, output_tokens: 3 } });
  if (text.includes('fail')) throw new Error('boom');
  if (text.includes('hang')) await new Promise(() => {});
  if (text.includes('wait')) await new Promise((_, reject) => t.signal.addEventListener('abort', () => reject(new Error('interrupted')), { once: true }));
  t.emit({ t: 'item.started', item: { itemId: 'i1', type: 'command', title: 'echo pong', status: 'running' } });
  t.emit({ t: 'text.snapshot', text: `echo: ${text}`, final: true }, { audience: 'answer' });
};

async function world(raw: Record<string, unknown> = {}) {
  return daemon({ raw: { agents: AGENTS, ...raw }, script });
}

describe('run.start', () => {
  it('runs one turn of a task agent in a fresh session run:<id> with its run config and the given cwd; run.ended exit 0; the session is closed #RN-1', async () => {
    const w = await world();
    const h = await w.host();
    const r = await h.runStart({ runId: 'r1', agent: 'exec', cwd: w.dir, input: [{ type: 'text', text: 'pong please' }] });
    expect(r).toEqual({ runId: 'r1', sessionKey: 'run:r1', state: 'started', inputId: expect.stringMatching(/^in_run_/), run: { harness: 'claude-code', model: 'haiku', profile: 'bypass' } });
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

  it('exit codes: a failing turn is 1, a cancel is 130, a timeout 124 #RN-1', async () => {
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

    // `timeout` as the protocol has it (older daemons said `interrupted`); error.code stays for hosts that read it.
    await h.runStart({ runId: 't', agent: 'exec', input: [{ type: 'text', text: 'wait forever' }], timeoutMs: 50 });
    expect(await h.runEndedOf('t')).toMatchObject({ status: 'timeout', exitCode: 124, error: { code: 'timeout' } });
  });

  it('env goes into the run child only: the instance built for the run has it; the log, explain records and other instances do not #SE-1 #EX-3', async () => {
    const w = await world();
    const h = await w.host();
    const secret = 'sekrit-value-123';
    await h.runStart({ runId: 'e', agent: 'exec', input: [{ type: 'text', text: 'hi' }], env: { XWO_CREDENTIAL: secret } });
    await h.runEndedOf('e');
    const runInst = w.built.find((i) => i.env.XWO_CREDENTIAL !== undefined)!;
    expect(runInst.env.XWO_CREDENTIAL).toBe(secret);
    expect(runInst.env.AGENTS_IO_RUN_ID).toBe('e');
    expect(runInst.env).not.toHaveProperty('AGENTS_IO_TURN_PROVENANCE'); // removed (decision 13): a constant the host already knows
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

  it('refuses interactive and unknown agents, bad cwd and env names #RN-1', async () => {
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

  it('agent instructions reach the harness; observe routes render the run on a channel; run.ended goes to the host when the asking connection left #RN-1', async () => {
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

  it('a run an earlier daemon left mid-turn is ambiguous (exit 3) after the restart #RS-5 #RN-1', async () => {
    const w = await world();
    // What a crashed daemon leaves: a run session whose turn never completed.
    const draft = { ts: Date.now(), level: 'primary' as const, audience: 'status' as const, durability: 'durable' as const, harness: 'claude-code', generation: 1 };
    w.gw.hub.append('run:d', { ...draft, turnId: 't-d', body: { t: 'turn.started', turnId: 't-d', inputIds: ['in-d'], replyRoute: null } });
    await w.stop();
    const w2 = await daemon({ dir: w.dir, raw: { agents: AGENTS }, script });
    const h = await w2.host();
    expect(await h.runStart({ runId: 'd', agent: 'exec', input: [{ type: 'text', text: 'again' }] })).toMatchObject({ state: 'ended', ended: { status: 'ambiguous', exitCode: 3, error: { code: 'host_restarted' } } });
  });

  it('daemon stop interrupts running runs and tells their connections #RN-1', async () => {
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
  it('a binding to a named agent opens its session with that agent: prefix, model, cwd #RT-1', async () => {
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

  it('a session whose recorded agent is gone refuses input with agent_unavailable, never falling back to the default agent #FC-1 #IN-1', async () => {
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

  it('a session whose recorded agent is a task agent now refuses input with agent_unavailable #FC-1', async () => {
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

  it('a channel message to a session whose agent is gone: refused (no harness), a notice on the route, and explain says agent_unavailable #FC-1 #EX-1', async () => {
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

  it('an observe-only (context) message to a session whose agent is gone: refused and logged, but nothing is said on the route #FC-1 #IN-1', async () => {
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

  it('no interactive agent at all (only task agents): a channel input is refused with agent_unavailable, recorded in the log and in explain; accept does not throw #FC-3 #IN-1', async () => {
    // Config validation refuses bindings without an agent here, so the channel input reaches a session through a watch trigger.
    const w = await daemon({
      raw: { agents: { exec: AGENTS.exec }, watches: [{ id: 'w', source: { channel: 'fake', conversation: 'g1' }, target: { sessionKey: 'main' }, mode: 'trigger' }] },
      script,
    });
    const r = await w.chat.inject({ sender: { channelUserId: 'eve', evidence: 'platform_signed' }, conversation: { id: 'g1', kind: 'group' }, text: 'hi' });
    expect(r.accepted).toBe(true);
    await new Promise((res) => setTimeout(res, 150));
    expect(w.harness.sessions).toHaveLength(0);
    // The route is the watched group, where a watch never answers (CF-5): no notice is asserted.
    expect(w.gw.router.explain(r.inputId!)!.matched[0]).toMatchObject({ sessionKey: 'main', rejected: { code: 'agent_unavailable' } });
    // The input the watch would have given the session (its own id, inw_<watch>_…) is the one refused.
    expect(w.gw.hub.log.read('main', 0).some((e) => e.body.t === 'input.rejected' && e.body.inputIds.some((id) => id.startsWith('inw_w_')) && e.body.reason === 'agent_unavailable')).toBe(true);
  });
});

describe('run.start overrides', () => {
  /** Two instances (the agent's with its own profile `tight`, and a Codex one a preset names). */
  const raw = {
    harnesses: { 'claude-code': { use: 'claude-code', profiles: { tight: { permissionMode: 'default', disallowedTools: ['Bash'] } } }, cx: { use: 'codex' } },
    presets: { fast: { harness: 'cx', model: 'gpt-x', effort: 'low' } },
  };
  const input = [{ type: 'text' as const, text: 'go' }];
  const runOf = (w: Awaited<ReturnType<typeof world>>, runId: string) => w.gw.hub.log.read(`run:${runId}`, 0).find((e) => e.body.t === 'turn.started')!.body;

  it('apply to that run only: model, effort, profile and preset reach the harness and turn.started.run; the answer says what runs; without them the agent defaults hold #RN-2', async () => {
    const w = await world(raw);
    const h = await w.host();
    const probe = await w.client();
    expect((await probe.hello({ token: w.gw.token, name: 'probe' })).features).toEqual(expect.arrayContaining(['run.overrides', 'run.ended.usage', 'run.correlation']));

    const a = await h.runStart({ runId: 'a', agent: 'exec', input, overrides: { model: 'opus', effort: 'high' } });
    expect(a).toMatchObject({ state: 'started', run: { harness: 'claude-code', model: 'opus', effort: 'high', profile: 'bypass' } });
    await h.runEndedOf('a');
    expect(w.harness.sessions.find((s) => s.args.sessionKey === 'run:a')!.args.run).toEqual(a.run);
    expect(runOf(w, 'a')).toMatchObject({ run: a.run });

    const b = await h.runStart({ runId: 'b', agent: 'exec', input, overrides: { profile: 'tight' } });
    expect(b.run).toEqual({ harness: 'claude-code', model: 'haiku', profile: 'tight' });
    await h.runEndedOf('b');
    expect(runOf(w, 'b')).toMatchObject({ run: { profile: 'tight' } });

    // A preset moves the run to its instance (still as the agent), its model and effort; model / effort go over those.
    const c = await h.runStart({ runId: 'c', agent: 'exec', input, overrides: { preset: 'fast', effort: 'medium' } });
    expect(c.run).toEqual({ harness: 'cx', model: 'gpt-x', effort: 'medium', profile: 'bypass' });
    await h.runEndedOf('c');
    expect(w.built.find((i) => i.env.AGENTS_IO_RUN_ID === 'c')!.name).toBe('cx');
    expect(runOf(w, 'c')).toMatchObject({ run: c.run });

    // Another run of the agent, and the agent itself, are unchanged.
    const d = await h.runStart({ runId: 'd', agent: 'exec', input });
    expect(d.run).toEqual({ harness: 'claude-code', model: 'haiku', profile: 'bypass' });
    await h.runEndedOf('d');
    expect(w.harness.sessions.find((s) => s.args.sessionKey === 'run:d')!.args.run).toEqual(d.run);
    expect(w.config.agents.exec).toMatchObject({ harness: 'claude-code', model: 'haiku', profile: 'bypass' });
  });

  it('one that cannot apply fails the request with bad_override and nothing runs; never a silent fallback #RN-2', async () => {
    const w = await world({ ...raw, agents: { ...AGENTS, own: { harness: 'claude-code', mode: 'task', profile: 'tight' } } });
    const h = await w.host();
    const refused = async (runId: string, agent: string, overrides: Record<string, string>, message: RegExp) => {
      await expect(h.runStart({ runId, agent, input, overrides })).rejects.toMatchObject({ code: 'bad_override', message: expect.stringMatching(message) });
      expect(w.gw.hub.log.head(`run:${runId}`)).toBe(0);
    };
    await refused('p', 'exec', { profile: 'nope' }, /profile "nope" is not defined on harness instance claude-code \(its profiles: tight; built in: bypass, restricted\)/);
    await refused('q', 'exec', { preset: 'ghost' }, /unknown preset "ghost" \(configured: fast\)/);
    await refused('m', 'exec', { model: 'two words' }, /overrides.model/);
    await refused('e', 'exec', { effort: '' }, /overrides.effort/);
    // The agent's own profile is defined only on its instance: a preset moving the run elsewhere would lose it.
    await refused('o', 'own', { preset: 'fast' }, /profile "tight" is not defined on harness instance cx/);
    expect(w.harness.sessions).toHaveLength(0);
    // The same overrides on the agent's instance are fine; built-in profiles are on every instance.
    expect((await h.runStart({ runId: 'ok', agent: 'own', input, overrides: { profile: 'tight' } })).run).toMatchObject({ profile: 'tight' });
    expect((await h.runStart({ runId: 'ok2', agent: 'exec', input, overrides: { preset: 'fast', profile: 'restricted' } })).run).toMatchObject({ harness: 'cx', profile: 'restricted' });
  });
});

describe('run.start overrides: cwd', () => {
  it('a preset run keeps the agent\'s default cwd (its own instance\'s), not the one of the instance the preset names #RN-2', async () => {
    const own = tmp();
    const other = tmp();
    const w = await world({ harnesses: { 'claude-code': { use: 'claude-code', cwd: own }, cx: { use: 'codex', cwd: other } }, presets: { fast: { harness: 'cx', model: 'gpt-x' } } });
    const h = await w.host();
    expect((await h.runStart({ runId: 'p', agent: 'exec', input: [{ type: 'text', text: 'go' }], overrides: { preset: 'fast' } })).run).toMatchObject({ harness: 'cx' });
    await h.runEndedOf('p');
    expect(w.harness.sessions.find((s) => s.args.sessionKey === 'run:p')!.args.cwd).toBe(own);
    expect(w.built.find((i) => i.env.AGENTS_IO_RUN_ID === 'p')).toMatchObject({ name: 'cx', cwd: own });
  });
});

describe('run.ended', () => {
  it('carries the run\'s turn, input, duration and the harness\'s usage; a re-sent run.start answers the same frame from the log, also after a restart #RN-3', async () => {
    const w = await world();
    const h = await w.host();
    await h.runStart({ runId: 'u', agent: 'exec', input: [{ type: 'text', text: 'usage please' }] });
    const ended = await h.runEndedOf('u');
    const log = w.gw.hub.log.read('run:u', 0);
    const started = log.find((e) => e.body.t === 'turn.started')!;
    const completed = log.find((e) => e.body.t === 'turn.completed')!;
    expect(ended).toMatchObject({
      status: 'completed',
      exitCode: 0,
      turnId: started.turnId,
      inputId: expect.stringMatching(/^in_run_/),
      usage: { totalCostUsd: 0.25, usage: { input_tokens: 12, output_tokens: 3 } },
      durationMs: completed.ts - log[0]!.ts,
    });
    expect(ended).not.toHaveProperty('correlation');
    expect((await h.runStart({ runId: 'u', agent: 'exec', input: [{ type: 'text', text: 'again' }] })).ended).toEqual(ended);

    // A failing turn: no usage reported, still its turn and duration.
    await h.runStart({ runId: 'f', agent: 'exec', input: [{ type: 'text', text: 'please fail' }] });
    const failed = await h.runEndedOf('f');
    expect(failed).toMatchObject({ status: 'failed', exitCode: 1, turnId: expect.any(String), durationMs: expect.any(Number) });
    expect(failed).not.toHaveProperty('usage');

    // A timeout is `timeout` in the log too, not a cancel.
    await h.runStart({ runId: 't', agent: 'exec', input: [{ type: 'text', text: 'wait' }], timeoutMs: 30 });
    const timedOut = await h.runEndedOf('t');
    expect(timedOut).toMatchObject({ status: 'timeout', exitCode: 124, error: { code: 'timeout' } });
    expect(w.gw.hub.log.read('run:t', 0).some((e) => e.body.t === 'notice' && e.body.code === 'run_timeout')).toBe(true);

    await w.stop();
    const w2 = await daemon({ dir: w.dir, raw: { agents: AGENTS }, script });
    const h2 = await w2.host();
    expect((await h2.runStart({ runId: 'u', agent: 'exec', input: [{ type: 'text', text: 'again' }] })).ended).toEqual(ended);
    expect((await h2.runStart({ runId: 'f', agent: 'exec', input: [{ type: 'text', text: 'again' }] })).ended).toEqual(failed);
    expect((await h2.runStart({ runId: 't', agent: 'exec', input: [{ type: 'text', text: 'again' }] })).ended).toEqual(timedOut);
  });

  it('a run a previous daemon left mid-turn has no duration (its end is not known) #RN-3 #RS-5', async () => {
    const w = await world();
    const draft = { ts: Date.now(), level: 'primary' as const, audience: 'status' as const, durability: 'durable' as const, harness: 'claude-code', generation: 1 };
    w.gw.hub.append('run:d', { ...draft, turnId: 't-d', body: { t: 'turn.started', turnId: 't-d', inputIds: ['in-d'], replyRoute: null } });
    await w.stop();
    const w2 = await daemon({ dir: w.dir, raw: { agents: AGENTS }, script });
    const h = await w2.host();
    const r = await h.runStart({ runId: 'd', agent: 'exec', input: [{ type: 'text', text: 'again' }] });
    expect(r.ended).toMatchObject({ status: 'ambiguous', turnId: 't-d' });
    expect(r.ended).not.toHaveProperty('durationMs');
  });
});

describe('run.ended: every end is in the log', () => {
  const draft = { level: 'primary' as const, audience: 'status' as const, durability: 'durable' as const };
  const admitted = (inputId: string, correlation: string): InputRecord => ({
    inputId,
    origin: { kind: 'system', principal: null, evidence: 'daemon', via: 'host', adapter: 'host' },
    content: [{ type: 'text', text: 'x' }],
    replyRoute: null,
    correlation,
    channelContext: { channel: 'host', runId: 'x', agent: 'exec' },
  });

  it('a daemon stop ends a run interrupted with daemon_stopping (or as its harness recorded the turn); the frame is the log\'s, also after the restart #RN-3 #RN-1', async () => {
    const w = await world();
    const h = await w.host();
    await h.runStart({ runId: 's', agent: 'exec', input: [{ type: 'text', text: 'wait' }], inputId: 'in-s', correlation: 'deleg:s' });
    // A harness that does not end the turn when interrupted: closing the session settles it (ambiguous).
    await h.runStart({ runId: 'h', agent: 'exec', input: [{ type: 'text', text: 'hang' }] });
    await until(() => w.gw.hub.snapshot('run:s').turn && w.gw.hub.snapshot('run:h').turn);
    const endedS = h.runEndedOf('s');
    const endedH = h.runEndedOf('h');
    await w.stop();
    const s = await endedS;
    const hung = await endedH;
    const w2 = await daemon({ dir: w.dir, raw: { agents: AGENTS }, script });
    const log = w2.gw.hub.log.read('run:s', 0);
    expect(s).toEqual({
      v: expect.any(Number),
      type: 'run.ended',
      runId: 's',
      sessionKey: 'run:s',
      status: 'interrupted',
      exitCode: 130,
      error: { code: 'daemon_stopping', message: expect.any(String) },
      turnId: log.find((e) => e.body.t === 'turn.started')!.turnId,
      inputId: 'in-s',
      correlation: 'deleg:s',
      durationMs: log.find((e) => e.body.t === 'turn.completed')!.ts - log[0]!.ts,
    });
    expect(log.some((e) => e.body.t === 'notice' && e.body.code === 'run_stopping')).toBe(true);
    expect(hung).toMatchObject({ status: 'ambiguous', exitCode: 3, error: { code: 'harness_closed' }, durationMs: expect.any(Number) });

    const h2 = await w2.host();
    expect((await h2.runStart({ runId: 's', agent: 'exec', input: [{ type: 'text', text: 'again' }] })).ended).toEqual(s);
    expect((await h2.runStart({ runId: 'h', agent: 'exec', input: [{ type: 'text', text: 'again' }] })).ended).toEqual(hung);
  });

  it('a run cancelled, timed out or left before its turn started answers from the log: interrupted / timeout with its input, correlation and duration; ambiguous without a duration #RN-3 #RS-5', async () => {
    const w = await world();
    const t0 = Date.now();
    const at = (ms: number) => ({ ...draft, ts: t0 + ms });
    w.gw.hub.append('run:c', { ...at(0), body: { t: 'input.admitted', inputId: 'in-c', disposition: 'new_turn', input: admitted('in-c', 'deleg:c') } });
    w.gw.hub.append('run:c', { ...at(40), body: { t: 'input.cancelled', inputIds: ['in-c'], reason: 'interrupt' } });
    w.gw.hub.append('run:t', { ...at(0), body: { t: 'input.admitted', inputId: 'in-t', disposition: 'new_turn', input: admitted('in-t', 'deleg:t') } });
    w.gw.hub.append('run:t', { ...at(30), level: 'detail', visibility: 'operators', body: { t: 'notice', code: 'run_timeout', message: 'elapsed' } });
    w.gw.hub.append('run:t', { ...at(35), body: { t: 'input.cancelled', inputIds: ['in-t'], reason: 'interrupt' } });
    // The previous daemon stopped between admitting the input and starting its turn.
    w.gw.hub.append('run:a', { ...at(0), body: { t: 'input.admitted', inputId: 'in-a', disposition: 'new_turn', input: admitted('in-a', 'deleg:a') } });
    await w.stop();
    const w2 = await daemon({ dir: w.dir, raw: { agents: AGENTS }, script });
    const h = await w2.host();
    const again = async (runId: string) => (await h.runStart({ runId, agent: 'exec', input: [{ type: 'text', text: 'again' }] })).ended!;
    const c = await again('c');
    expect(c).toEqual({ v: expect.any(Number), type: 'run.ended', runId: 'c', sessionKey: 'run:c', status: 'interrupted', exitCode: 130, error: { code: 'cancelled' }, inputId: 'in-c', correlation: 'deleg:c', durationMs: 40 });
    expect(await again('c')).toEqual(c);
    expect(await again('t')).toMatchObject({ status: 'timeout', exitCode: 124, error: { code: 'timeout' }, inputId: 'in-t', correlation: 'deleg:t', durationMs: 35 });
    const a = await again('a');
    expect(a).toMatchObject({ status: 'ambiguous', exitCode: 3, error: { code: 'host_restarted' }, inputId: 'in-a', correlation: 'deleg:a' });
    expect(a).not.toHaveProperty('durationMs');
    expect(a).not.toHaveProperty('turnId');
    expect(w2.harness.sessions).toHaveLength(0);
  });

  it('an end the harness left out of the log is written by the daemon (a turn still open when the lane closed, an input the lane refused unrecorded): run.ended is the frame the log gives #RN-3 #RN-1', async () => {
    const hub = new Hub(new MemorySessionLog());
    const records = new Map<string, RouteExplanation>();
    /** `admit`: the lane records the input and starts a turn, then never ends it; else it refuses the input without a record. */
    let admit = true;
    const agent = { name: 'exec', harness: 'fake', mode: 'task', tools: false, configured: true } as AgentConfig;
    const deps: RunDeps = {
      hub,
      agents: () => ({ exec: agent }),
      agentCwd: () => tmp(),
      runSpec: () => ({ ok: true, spec: { harness: 'fake', model: 'm', profile: 'restricted' } }),
      openRunLane: ({ sessionKey, turnId }) => ({
        lane: {
          command: async (cmd: { type: string; input?: InputRecord }) => {
            if (cmd.type !== 'input') return { ok: true };
            if (!admit) return { ok: false, reason: 'closed' };
            const input = cmd.input!;
            hub.append(sessionKey, { ...draft, ts: Date.now(), body: { t: 'input.admitted', inputId: input.inputId, disposition: 'new_turn', input } });
            hub.append(sessionKey, { ...draft, ts: Date.now(), turnId, harness: 'fake', generation: 1, body: { t: 'turn.started', turnId, inputIds: [input.inputId], replyRoute: null } });
            return { ok: true, disposition: 'new_turn' };
          },
        } as unknown as Lane,
        dispose: async () => {},
      }),
      explained: (id) => records.get(id),
      recordRunInput: (r) =>
        void records.set(r.input.inputId, { inputId: r.input.inputId, tableVersions: [], matched: [], principal: null, evidence: 'daemon', at: 0, run: { runId: r.runId, ...(r.input.correlation ? { correlation: r.input.correlation } : {}) } } as RouteExplanation),
      hostPeer: () => undefined,
      log: () => {},
    };
    const runs = new Runs(deps);
    const sent: RunEnded[] = [];
    const peer = { id: 'p', signal: new AbortController().signal, send: (f: Record<string, unknown>) => sent.push(f as unknown as RunEnded) > 0 } as unknown as Peer;
    const origin = { kind: 'system' as const, principal: null, evidence: 'daemon' as const, via: 'host', adapter: 'host' };

    expect(await runs.start(peer, { v: 1, type: 'run.start', runId: 'open', agent: 'exec', input: [{ type: 'text', text: 'x' }], correlation: 'deleg:open' }, origin)).toMatchObject({ ok: true, value: { state: 'started' } });
    await runs.stop();
    const open = sent.find((f) => f.runId === 'open')!;
    expect(open).toMatchObject({ status: 'interrupted', exitCode: 130, error: { code: 'daemon_stopping' }, turnId: expect.any(String), inputId: expect.stringMatching(/^in_run_/), correlation: 'deleg:open', durationMs: expect.any(Number) });
    expect(hub.log.read('run:open', 0).filter((e) => e.body.t === 'turn.completed')).toMatchObject([{ body: { status: 'interrupted', error: { code: 'daemon_stopping', retryable: false } } }]);
    expect(runs.outcome('open')).toEqual(open);

    admit = false;
    const fresh = new Runs(deps);
    expect(await fresh.start(peer, { v: 1, type: 'run.start', runId: 'refused', agent: 'exec', input: [{ type: 'text', text: 'x' }], inputId: 'in-r', correlation: 'deleg:r' }, origin)).toMatchObject({ ok: false, code: 'start_failed' });
    const refused = sent.find((f) => f.runId === 'refused')!;
    expect(refused).toEqual({ v: expect.any(Number), type: 'run.ended', runId: 'refused', sessionKey: 'run:refused', status: 'failed', exitCode: 1, error: { code: 'start_failed', message: 'closed' }, inputId: 'in-r', correlation: 'deleg:r', durationMs: 0 });
    expect(hub.log.read('run:refused', 0).map((e) => e.body)).toEqual([{ t: 'input.rejected', inputIds: ['in-r'], reason: 'closed' }]);
    expect(fresh.outcome('refused')).toEqual(refused);
  });
});

describe('run.start inputId and correlation', () => {
  it('the input is the host\'s: its id and correlation id are kept (not in what the model is shown), echoed by run.ended, and explain names the run #EX-7 #RN-3', async () => {
    const seen: InputRecord[] = [];
    const w = await daemon({ raw: { agents: AGENTS }, script: async (t) => void seen.push(...t.inputs) });
    const h = await w.host();
    const r = await h.runStart({ runId: 'c1', agent: 'exec', input: [{ type: 'text', text: 'go' }], inputId: 'lbg_42', correlation: 'deleg:7 / turn 3' });
    expect(r).toMatchObject({ state: 'started', inputId: 'lbg_42' });
    const ended = await h.runEndedOf('c1');
    expect(ended).toMatchObject({ status: 'completed', inputId: 'lbg_42', correlation: 'deleg:7 / turn 3' });
    expect(seen[0]).toMatchObject({ inputId: 'lbg_42', correlation: 'deleg:7 / turn 3' });
    expect(Object.values(seen[0]!.channelContext)).not.toContain('deleg:7 / turn 3');

    const ex = await h.explain('lbg_42');
    expect(errors(HOST_RESULT_VALUES.explain, ex)).toEqual([]);
    expect(ex).toMatchObject({ inputId: 'lbg_42', principal: 'host:xwo', matched: [{ bindingId: 'host:run', source: 'host', on: 'dispatch', agent: 'exec', sessionKey: 'run:c1' }], run: { runId: 'c1', correlation: 'deleg:7 / turn 3' } });
    // The root of its cause chain: what the run's turn produces chains back here.
    const chain = await h.explain('lbg_42', { chain: true });
    expect(chain).toMatchObject({ inputId: 'lbg_42', chain: 'lbg_42', end: 'root', links: [{ inputId: 'lbg_42', hop: 0, run: { runId: 'c1', correlation: 'deleg:7 / turn 3' } }] });

    // Re-sent: the run's own record, not a taken id.
    expect(await h.runStart({ runId: 'c1', agent: 'exec', input: [{ type: 'text', text: 'go' }], inputId: 'lbg_42', correlation: 'deleg:7 / turn 3' })).toMatchObject({ state: 'ended', ended });
    // Without an inputId the daemon makes one; explain has it too.
    const g = await h.runStart({ runId: 'c2', agent: 'exec', input: [{ type: 'text', text: 'go' }] });
    expect(g.inputId).toMatch(/^in_run_/);
    expect(await h.explain(g.inputId!)).toMatchObject({ run: { runId: 'c2' } });
  });

  it('refuses an inputId another input has, ids that are not plain tokens and bad correlation ids; nothing runs #EX-7', async () => {
    const w = await world();
    const h = await w.host();
    const input = [{ type: 'text' as const, text: 'go' }];
    await h.runStart({ runId: 'first', agent: 'exec', input, inputId: 'mine-1' });
    await h.runEndedOf('first');
    const before = w.harness.sessions.length;
    await expect(h.runStart({ runId: 'second', agent: 'exec', input, inputId: 'mine-1' })).rejects.toMatchObject({ code: 'input_id_taken' });
    // A channel input's id is taken the same way.
    const ch = await w.chat.inject({ sender: { channelUserId: 'alice', evidence: 'platform_signed' }, text: 'hi' });
    await expect(h.runStart({ runId: 'third', agent: 'exec', input, inputId: ch.inputId! })).rejects.toMatchObject({ code: 'input_id_taken' });
    for (const id of ['has space', 'ctxo_turn', 'a@b', '-lead', 'x'.repeat(257), ''])
      await expect(h.runStart({ runId: 'bad', agent: 'exec', input, inputId: id })).rejects.toMatchObject({ code: 'bad_input_id' });
    for (const c of ['line\nbreak', 'y'.repeat(257), ''])
      await expect(h.runStart({ runId: 'bad', agent: 'exec', input, correlation: c })).rejects.toMatchObject({ code: 'bad_correlation' });
    expect(w.gw.hub.log.head('run:second') + w.gw.hub.log.head('run:third') + w.gw.hub.log.head('run:bad')).toBe(0);
    expect(w.harness.sessions.filter((s) => s.args.sessionKey.startsWith('run:')).length).toBe(before);
  });
});
