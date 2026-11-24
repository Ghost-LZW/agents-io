import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { HarnessEvent } from '@agents-io/protocol';
import { checkEventStream, runHarnessConformance } from '@agents-io/testkit';
import { AcpHarness, MCP_STDIO_BRIDGE } from '../src/index.js';
import { completed, disposeAll, events, fake, input, loader, FAKE_AGENT, openArgs, run } from './acp-helpers.js';

/*
 * The ACP harness against a fake ACP agent on stdio (fake-agent.ts, the official SDK's agent side):
 * the adapter's contract (HC-1: probe, declarations, turns, interrupt, close, a conforming stream;
 * a protocol version it does not speak is refused), a session's own env only on a process of its
 * own (HC-2), permission requests as requests that resolve once (RQ-1 on the harness side), a
 * prompt the agent will not cancel holding the session until it answers, so that nothing it streams
 * is the next turn's and no two prompts overlap (LN-2, DL-3), and a resumed session whose replayed
 * history never becomes events (RS-1).
 */

afterEach(disposeAll);

describe('the ACP harness: contract', () => {
  it('passes the harness conformance suite: probe, declarations, a turn, steer, interrupt (session/cancel), close and the stream #HC-1', async () => {
    const { h } = fake();
    const report = await runHarnessConformance({
      adapter: h,
      open: openArgs(),
      longTurn: { turnId: 'long', inputs: [input('in-long', 'slow')] },
      timeoutMs: 10_000,
    });
    expect(report.failed).toEqual([]);
    expect(report.passed).toContain('interrupt.ends_turn');
  });

  it('probes the agent with initialize: protocol 1, no fs or terminal client capabilities, form elicitation; caps from its answer #HC-1', async () => {
    // What goes over the wire, as written (the fake's SDK fills in the defaults it parses).
    const sent: unknown[] = [];
    const { h } = fake({}, { record: (d, f) => d === 'outbound' && sent.push(f) });
    const p = await h.probe();
    expect(p.version).toBe('fake-acp 1.2.3');
    expect(p.caps).toMatchObject({ steer: 'none', interrupt: true, approvals: true, questions: true, resume: true, injectWithoutTurn: false });
    expect(sent[0]).toEqual({
      jsonrpc: '2.0',
      id: 0,
      method: 'initialize',
      params: { protocolVersion: 1, clientCapabilities: { elicitation: { form: {} } }, clientInfo: { name: 'agents-io', title: 'agents-io', version: '0.1.0' } },
    });
    // Without elicitation, no questions.
    const quietly: unknown[] = [];
    const quiet = fake({}, { elicitation: false, record: (d, f) => d === 'outbound' && quietly.push(f) });
    expect((await quiet.h.probe()).caps.questions).toBe(false);
    expect((quietly[0] as { params: { clientCapabilities: unknown } }).params.clientCapabilities).toEqual({});
  });

  it('refuses an agent that answers another protocol version, clearly, and does not keep it running #HC-1', async () => {
    const { h, calls } = fake({ FAKE_ACP_PROTOCOL: '2' });
    await expect(h.probe()).rejects.toThrow(/the ACP agent speaks protocol version 2; this adapter speaks 1/);
    const pid = calls().find((c) => c.call === 'start')!.pid as number;
    await new Promise((r) => setTimeout(r, 300));
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it('a turn: turn.started, the answer streamed and as the final snapshot, its input consumed, turn.completed; the prompt carries the sender preface as Codex writes it; a conforming stream #HC-1 #ID-2', async () => {
    const { h, calls } = fake();
    const s = await h.open(openArgs({ cwd: '/tmp' }));
    const ev = events(s);
    await s.startTurn('t1', [input('in-1', 'hello there')], run);
    await ev.until(completed('t1'));
    expect(ev.of('session.bound')).toEqual([{ t: 'session.bound', nativeId: s.nativeId() }]);
    expect(ev.of('input.consumed')).toEqual([{ t: 'input.consumed', inputIds: ['in-1'], turnId: 't1' }]);
    expect(ev.of('text.snapshot').filter((x) => x.final).map((x) => x.text)).toEqual([expect.stringContaining('hello there')]);
    expect(ev.of('turn.completed')).toEqual([expect.objectContaining({ turnId: 't1', status: 'completed' })]);
    // The prompt carries the sender preface (ID-2) then the text.
    const prompt = calls().find((c) => c.call === 'session/prompt')!.params.prompt;
    expect(prompt).toEqual([{ type: 'text', text: '[sender from=owner kind=human evidence=platform_signed via=test:default:c1]\nhello there' }]);
    expect(calls().find((c) => c.call === 'session/new')!.params).toEqual({ cwd: '/tmp', mcpServers: [] });
    await s.close('done');
    await ev.done;
    expect(checkEventStream(ev.all, { turnInputs: { t1: ['in-1'] } })).toEqual([]);
  });

  it('conversation-wide and per-sender context is shown when it changes, and again after a compaction: the compaction command, or one the agent reports (claude flavor) #ID-2', async () => {
    const ctx = { conversationKind: 'group', senderName: 'Alice' };
    const say = (id: string, text: string) => input(id, text, { channelContext: ctx });
    const full = (text: string) => `[sender from=owner kind=human evidence=platform_signed via=test:default:c1 conversationKind="group" senderName="Alice"]\n${text}`;
    const bare = (text: string) => `[sender from=owner kind=human evidence=platform_signed via=test:default:c1]\n${text}`;
    const prompts = (c: Record<string, any>[]) => c.filter((x) => x.call === 'session/prompt').map((x) => (x.params.prompt as { text?: string }[]).map((b) => b.text).join(''));
    const turns = async (h: ReturnType<typeof fake>['h'], inputs: ReturnType<typeof input>[]) => {
      const s = await h.open(openArgs());
      const ev = events(s);
      for (const [i, x] of inputs.entries()) {
        await s.startTurn(`t${i}`, [x], run);
        await ev.until(completed(`t${i}`));
      }
      await s.close('done');
    };

    const a = fake();
    await turns(a.h, [say('i1', 'hello'), say('i2', 'again'), input('c', '/compact', { channelContext: { ...ctx, nativeCommand: true } }), say('i3', 'after'), say('i4', 'then')]);
    // The command goes as it is; the context it may have dropped is given in full on the next input.
    expect(prompts(a.calls())).toEqual([full('hello'), bare('again'), '/compact', full('after'), bare('then')]);

    // Claude Code's ACP agent reports a compaction (its own too) as a tool call the claude flavor knows.
    const b = fake({}, { flavor: 'claude' });
    await turns(b.h, [say('i1', 'hello'), say('i2', 'compacting'), say('i3', 'after')]);
    expect(prompts(b.calls())).toEqual([full('hello'), bare('compacting'), full('after')]);
    // The generic flavor knows no such report.
    const c = fake();
    await turns(c.h, [say('i1', 'hello'), say('i2', 'compacting'), say('i3', 'after')]);
    expect(prompts(c.calls())).toEqual([full('hello'), bare('compacting'), bare('after')]);
  });

  it('tool calls are items: started, completed with their output; a tool before the answer leaves only the answer final #HC-1', async () => {
    const { h } = fake();
    const s = await h.open(openArgs());
    const ev = events(s);
    await s.startTurn('t1', [input('in-1', 'tool')], run);
    await ev.until(completed('t1'));
    expect(ev.of('item.started')).toEqual([{ t: 'item.started', item: expect.objectContaining({ itemId: 'call-1', type: 'command', title: 'Run ls', status: 'running', inputSummary: 'ls -la' }) }]);
    expect(ev.of('item.completed')).toEqual([{ t: 'item.completed', item: expect.objectContaining({ itemId: 'call-1', status: 'completed', result: { preview: 'a.txt\nb.txt', truncated: false, isError: false } }) }]);
    expect(ev.of('text.snapshot').filter((x) => x.final).map((x) => x.text)).toEqual(['done']);

    await s.startTurn('t2', [input('in-2', 'twice')], run);
    await ev.until(completed('t2'));
    const mcp = ev.of('item.started').find((x) => x.item.itemId === 'call-2')!.item;
    expect(mcp).toMatchObject({ type: 'mcp_tool', title: 'agents-io.get_channel_context', tool: { server: 'agents-io', name: 'get_channel_context' } });
    expect(ev.of('text.snapshot').filter((x) => x.final).at(-1)!.text).toBe('here it is');
    await s.close('done');
    await ev.done;
    expect(checkEventStream(ev.all, { turnInputs: { t1: ['in-1'], t2: ['in-2'] } })).toEqual([]);
  });

  it('an agent that answers the prompt with a null result ends the turn ambiguous (unknown_stop_reason) without an unhandled rejection; the session goes on #HC-1', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on('unhandledRejection', onUnhandled);
    try {
      const f = fake();
      const s = await f.h.open(openArgs());
      const ev = events(s);
      await s.startTurn('t1', [input('in-1', 'null')], run);
      await ev.until(completed('t1'));
      expect(ev.of('turn.completed')).toEqual([expect.objectContaining({ turnId: 't1', status: 'ambiguous', error: expect.objectContaining({ code: 'unknown_stop_reason' }) })]);
      expect(ev.of('input.consumed')).toEqual([{ t: 'input.consumed', inputIds: ['in-1'], turnId: 't1' }]);
      // The same session and agent process take the next turn.
      await s.startTurn('t2', [input('in-2', 'hello')], run);
      await ev.until(completed('t2'));
      expect(ev.of('turn.completed').at(-1)).toMatchObject({ turnId: 't2', status: 'completed' });
      expect(f.calls().filter((c) => c.call === 'start')).toHaveLength(1);
      await s.close('done');
      await ev.done;
      expect(checkEventStream(ev.all, { turnInputs: { t1: ['in-1'], t2: ['in-2'] } })).toEqual([]);
      await new Promise((r) => setTimeout(r, 50));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('a session with its own env is refused on the shared process; on ownProcess the env reaches the agent process and nothing else #HC-2', async () => {
    const secret = `s-${Math.random().toString(36).slice(2)}`;
    const { h } = fake({ FAKE_ACP_ENV_KEYS: 'AIO_TEST_SECRET' });
    await expect(h.open({ ...openArgs(), env: { AIO_TEST_SECRET: secret } })).rejects.toThrow(/process of its own/);
    expect(h.sessionEnv).toBe('own-process');
    const own = h.ownProcess({ env: { AIO_TEST_SECRET: secret } }) as AcpHarness;
    try {
      const s = await own.open(openArgs());
      const ev = events(s);
      await s.startTurn('t1', [input('in-1', 'hello')], run);
      await ev.until(completed('t1'));
      await s.close('done');
      await ev.done;
      const log = (own as unknown as { o: { env: Record<string, string> } }).o.env.FAKE_ACP_LOG!;
      const start = (await import('./acp-helpers.js')).calls(log).filter((c) => c.call === 'start');
      expect(start.at(-1)!.env).toEqual({ AIO_TEST_SECRET: secret });
      expect(start.at(-1)!.argv.some((a: string) => a.includes(secret))).toBe(false);
      expect(JSON.stringify(ev.all)).not.toContain(secret);
    } finally {
      await own.dispose();
    }
  });
});

describe('the ACP harness: permission requests', () => {
  const ask = async (decision: Parameters<import('@agents-io/protocol').HarnessSession['respond']>[1]) => {
    const f = fake();
    const s = await f.h.open(openArgs());
    const ev = events(s);
    await s.startTurn('t1', [input('in-1', 'permission')], run);
    const opened = (await ev.until((e) => e.body.t === 'request.opened')).body as Extract<import('@agents-io/protocol').HarnessEvent['body'], { t: 'request.opened' }>;
    await s.respond(opened.requestId, decision);
    await ev.until(completed('t1'));
    await s.close('done');
    await ev.done;
    return { opened, ev, calls: f.calls() };
  };

  it('session/request_permission opens a request (kind, title, allowed decisions, the always option as a suggestion); allow once picks the one-time option #RQ-1 #HC-1', async () => {
    const { opened, ev, calls } = await ask({ kind: 'allow_once' });
    expect(opened).toMatchObject({
      kind: 'file_change',
      title: 'Edit a.txt',
      risk: { writes: true },
      inputPreview: '/tmp/a.txt',
      allowedDecisions: ['allow_once', 'allow_session', 'deny', 'native'],
      allowAlways: true,
      defaultDeny: true,
      suggestions: [{ optionId: 'always', name: 'Always allow edits', kind: 'allow_always' }],
    });
    expect(calls.find((c) => c.call === 'permission-outcome')!.outcome).toEqual({ outcome: 'selected', optionId: 'allow' });
    expect(ev.of('request.resolved')).toEqual([{ t: 'request.resolved', requestId: opened.requestId, decision: { kind: 'allow_once' }, by: { kind: 'host' } }]);
    expect(ev.of('text.snapshot').filter((x) => x.final).at(-1)!.text).toBe('permission: allow');
    expect(checkEventStream(ev.all, { turnInputs: { t1: ['in-1'] } })).toEqual([]);
  });

  it('allow for the session picks the always option, deny the reject option, a native decision the option it names #RQ-1', async () => {
    expect((await ask({ kind: 'allow_session' })).calls.find((c) => c.call === 'permission-outcome')!.outcome).toEqual({ outcome: 'selected', optionId: 'always' });
    const denied = await ask({ kind: 'deny' });
    expect(denied.calls.find((c) => c.call === 'permission-outcome')!.outcome).toEqual({ outcome: 'selected', optionId: 'reject' });
    expect(denied.ev.of('text.snapshot').filter((x) => x.final).at(-1)!.text).toBe('permission: reject');
    expect((await ask({ kind: 'native', payload: { optionId: 'always' } })).calls.find((c) => c.call === 'permission-outcome')!.outcome).toEqual({ outcome: 'selected', optionId: 'always' });
  });

  it('an interrupt while a permission is open answers it cancelled (resolved by runtime_cancelled), sends session/cancel, and the turn ends interrupted #RQ-2 #HC-1', async () => {
    const f = fake();
    const s = await f.h.open(openArgs());
    const ev = events(s);
    await s.startTurn('t1', [input('in-1', 'permission')], run);
    const opened = (await ev.until((e) => e.body.t === 'request.opened')).body as { requestId: string };
    await s.interrupt('t1');
    await ev.until(completed('t1'));
    expect(ev.of('request.resolved')).toEqual([{ t: 'request.resolved', requestId: opened.requestId, decision: null, by: 'runtime_cancelled' }]);
    expect(ev.of('turn.completed')).toEqual([expect.objectContaining({ turnId: 't1', status: 'interrupted' })]);
    expect(f.calls().find((c) => c.call === 'permission-outcome')!.outcome).toEqual({ outcome: 'cancelled' });
    expect(f.calls().some((c) => c.call === 'session/cancel')).toBe(true);
    await expect(s.respond(opened.requestId, { kind: 'allow_once' })).rejects.toThrow(/no open request/);
    await s.close('done');
    await ev.done;
    expect(checkEventStream(ev.all, { turnInputs: { t1: ['in-1'] } })).toEqual([]);
  });
});

describe('the ACP harness: a prompt that outlives its cancel timeout', () => {
  /** What was said in a turn: its deltas and snapshots. */
  const said = (all: HarnessEvent[], turnId: string) => all.filter((e) => e.turnId === turnId && (e.body.t === 'text.delta' || e.body.t === 'text.snapshot')).map((e) => JSON.stringify(e.body));
  /** The fake agent's calls as `call:sessionId`. */
  const trail = (c: Record<string, any>[]) => c.filter((x) => x.call.startsWith('session/') || x.call === 'prompt-end').map((x) => `${x.call}:${x.sessionId ?? x.params?.sessionId ?? ''}`);
  /** t1 runs `stubborn` (the agent ignores session/cancel and keeps streaming) and is interrupted; t2 starts as soon as t1 has ended. */
  const interruptedThenNext = async (env: Record<string, string>, cancelTimeoutMs: number, ctx: Record<string, unknown> = {}) => {
    const f = fake(env, { cancelTimeoutMs });
    const s = await f.h.open(openArgs());
    const ev = events(s);
    const first = s.nativeId();
    await s.startTurn('t1', [input('in-1', 'stubborn', { channelContext: ctx })], run);
    await ev.until((e) => e.body.t === 'text.delta');
    await s.interrupt('t1');
    await ev.until(completed('t1'));
    // t2 takes a while (300 ms), as a real turn does: long enough to be written into.
    await s.startTurn('t2', [input('in-2', 'hello pause', { channelContext: ctx })], run);
    await ev.until(completed('t2'));
    return { f, s, ev, first };
  };

  it('the next turn waits for the agent to answer the prompt it would not cancel; what that prompt streams meanwhile is native, never the next turn\'s answer #LN-2 #DL-3', async () => {
    const { f, s, ev, first } = await interruptedThenNext({ FAKE_ACP_STUBBORN_MS: '1500' }, 1_000);
    expect(ev.of('turn.completed')[0]).toMatchObject({ turnId: 't1', status: 'interrupted', error: { code: 'cancel_timeout' } });
    // The agent ran one prompt at a time: the second after the first answered, on the same session.
    expect(trail(f.calls()).filter((c) => c.startsWith('session/prompt') || c.startsWith('prompt-end'))).toEqual([`session/prompt:${first}`, `prompt-end:${first}`, `session/prompt:${first}`, `prompt-end:${first}`]);
    expect(s.nativeId()).toBe(first);
    // t2 said only its own answer; the old prompt's words went out as native, in no turn.
    expect(said(ev.all, 't2').join('')).not.toContain('stale');
    expect(ev.of('text.snapshot').filter((x) => x.final).at(-1)!.text).toMatch(/^echo: [\s\S]*hello pause$/);
    const late = ev.all.filter((e) => e.body.t === 'native' && JSON.stringify(e.native).includes('stale'));
    expect(late.length).toBeGreaterThan(0);
    expect(late.every((e) => e.turnId === undefined && e.durability === 'ephemeral')).toBe(true);
    expect(ev.of('notice')).toEqual([]);
    await s.close('done');
    await ev.done;
    expect(checkEventStream(ev.all, { turnInputs: { t1: ['in-1'], t2: ['in-2'] } })).toEqual([]);
  }, 15_000);

  const ctx = { conversationKind: 'group', senderName: 'Alice' };
  const prompts = (c: Record<string, any>[]) => c.filter((x) => x.call === 'session/prompt').map((x) => (x.params.prompt as { text?: string }[]).map((b) => b.text).join(''));
  const full = (text: string) => `[sender from=owner kind=human evidence=platform_signed via=test:default:c1 conversationKind="group" senderName="Alice"]\n${text}`;
  const bare = (text: string) => `[sender from=owner kind=human evidence=platform_signed via=test:default:c1]\n${text}`;

  it('a prompt that does not answer within that wait either: the session is closed (session/close) and loaded again, the conversation kept, a notice says so, and the next turn runs there #LN-2 #DL-3', async () => {
    const caps = JSON.stringify({ sessionCapabilities: { systemPrompt: {}, close: {} } });
    const { f, s, ev, first } = await interruptedThenNext({ FAKE_ACP_STUBBORN_MS: '60000', FAKE_ACP_CAPS: caps }, 300, ctx);
    expect(ev.of('turn.completed')[0]).toMatchObject({ turnId: 't1', status: 'interrupted', error: { code: 'cancel_timeout' } });
    const t = trail(f.calls());
    const at = (c: string) => t.indexOf(c);
    expect(at(`session/close:${first}`)).toBeGreaterThan(at(`session/cancel:${first}`));
    expect(at(`session/load:${first}`)).toBeGreaterThan(at(`session/close:${first}`));
    // Loaded only once the old prompt answered (this agent stops it at session/close): nothing of it can stream into the loaded session.
    expect(at(`prompt-end:${first}`)).toBeGreaterThan(at(`session/close:${first}`));
    expect(at(`session/load:${first}`)).toBeGreaterThan(at(`prompt-end:${first}`));
    expect(t.filter((c) => c.startsWith('session/prompt'))).toEqual([`session/prompt:${first}`, `session/prompt:${first}`]);
    expect(t.lastIndexOf(`session/prompt:${first}`)).toBeGreaterThan(at(`session/load:${first}`));
    expect(s.nativeId()).toBe(first);
    expect(ev.of('session.bound')).toEqual([{ t: 'session.bound', nativeId: first }]);
    expect(ev.of('notice')).toEqual([
      { t: 'notice', code: 'continuity', message: `the agent did not stop turn t1: no answer to its session/prompt within 300ms of session/cancel, nor in the 300ms after: closed ACP session ${first} and loaded it again` },
    ]);
    // Nothing of the old prompt, nor of the load's replay, is the next turn's (or any turn's).
    expect(said(ev.all, 't2').join('')).not.toContain('stale');
    expect(ev.of('item.started')).toEqual([]);
    expect(ev.of('plan.updated')).toEqual([]);
    expect(ev.of('text.snapshot').filter((x) => x.final).at(-1)!.text).toMatch(/^echo: [\s\S]*hello pause$/);
    // The conversation is the same: the context is not given again in full (ID-2).
    expect(prompts(f.calls())).toEqual([full('stubborn'), bare('hello pause')]);
    await s.close('done');
    await ev.done;
    expect(checkEventStream(ev.all, { turnInputs: { t1: ['in-1'], t2: ['in-2'] } })).toEqual([]);
  }, 15_000);

  it('an agent that answers session/close but goes on with the prompt: the session is not loaded again (the prompt would stream into it); a new one is started, and nothing the old prompt says reaches the next turn #LN-2 #DL-3', async () => {
    const caps = JSON.stringify({ sessionCapabilities: { systemPrompt: {}, close: {} } });
    const { f, s, ev, first } = await interruptedThenNext({ FAKE_ACP_STUBBORN_MS: '60000', FAKE_ACP_CAPS: caps, FAKE_ACP_CLOSE_KEEPS_GOING: '1' }, 300, ctx);
    expect(ev.of('turn.completed')[0]).toMatchObject({ turnId: 't1', status: 'interrupted', error: { code: 'cancel_timeout' } });
    // t2 said only its own answer: nothing of the old prompt, which went on after session/close.
    expect(said(ev.all, 't2').join('')).not.toContain('stale');
    expect(ev.of('text.snapshot').filter((x) => x.final).at(-1)!.text).toMatch(/^echo: [\s\S]*hello pause$/);
    const t = trail(f.calls());
    expect(t.some((c) => c.startsWith('session/load'))).toBe(false);
    const second = s.nativeId();
    expect(second).not.toBe(first);
    expect(t.lastIndexOf('session/new:')).toBeGreaterThan(t.indexOf(`session/close:${first}`));
    expect(t.filter((c) => c.startsWith('session/prompt') || c.startsWith('prompt-end'))).toEqual([`session/prompt:${first}`, `session/prompt:${second}`, `prompt-end:${second}`]);
    expect(ev.of('session.bound')).toEqual([
      { t: 'session.bound', nativeId: first },
      { t: 'session.bound', nativeId: second },
    ]);
    expect(ev.of('notice')).toEqual([
      {
        t: 'notice',
        code: 'continuity',
        message: `the agent did not stop turn t1: no answer to its session/prompt within 300ms of session/cancel, nor in the 300ms after: started a new ACP session ${second} (the agent answered session/close, but still not the prompt 300ms after); the conversation so far is not in it`,
      },
    ]);
    // What the old prompt said before the new session was started is native, in no turn.
    const late = ev.all.filter((e) => e.body.t === 'native' && JSON.stringify(e.native).includes('stale'));
    expect(late.every((e) => e.turnId === undefined)).toBe(true);
    expect(prompts(f.calls())).toEqual([full('stubborn'), full('hello pause')]);
    // The old prompt still streams; none of it reaches this session.
    const before = ev.all.length;
    await new Promise((r) => setTimeout(r, 200));
    expect(ev.all.slice(before)).toEqual([]);
    await s.close('done');
    await ev.done;
    expect(checkEventStream(ev.all, { turnInputs: { t1: ['in-1'], t2: ['in-2'] } })).toEqual([]);
  }, 15_000);

  it('an agent without session/close: a new session is started (its id bound; a notice says the conversation is not in it), the next turn runs there with its context in full, and what the old one goes on streaming reaches no turn #LN-2 #DL-3 #ID-2', async () => {
    const { f, s, ev, first } = await interruptedThenNext({ FAKE_ACP_STUBBORN_MS: '60000' }, 300, ctx);
    const second = s.nativeId();
    expect(second).not.toBe(first);
    expect(ev.of('session.bound')).toEqual([
      { t: 'session.bound', nativeId: first },
      { t: 'session.bound', nativeId: second },
    ]);
    expect(ev.of('notice')).toEqual([
      {
        t: 'notice',
        code: 'continuity',
        message: `the agent did not stop turn t1: no answer to its session/prompt within 300ms of session/cancel, nor in the 300ms after: started a new ACP session ${second} (the agent does not take session/close); the conversation so far is not in it`,
      },
    ]);
    const t = trail(f.calls());
    expect(t.some((c) => c.startsWith('session/close'))).toBe(false);
    expect(t.filter((c) => c.startsWith('session/prompt') || c.startsWith('prompt-end'))).toEqual([`session/prompt:${first}`, `session/prompt:${second}`, `prompt-end:${second}`]);
    expect(said(ev.all, 't2').join('')).not.toContain('stale');
    expect(ev.of('text.snapshot').filter((x) => x.final).at(-1)!.text).toMatch(/^echo: [\s\S]*hello pause$/);
    expect(prompts(f.calls())).toEqual([full('stubborn'), full('hello pause')]);
    // The old session still streams; none of it reaches this one.
    const before = ev.all.length;
    await new Promise((r) => setTimeout(r, 200));
    expect(ev.all.slice(before)).toEqual([]);
    await s.close('done');
    await ev.done;
    expect(checkEventStream(ev.all, { turnInputs: { t1: ['in-1'], t2: ['in-2'] } })).toEqual([]);
  }, 15_000);

  it('a session closed while the next turn waits for the old prompt ends the wait at once: that turn does not start and no prompt is sent #RS-8', async () => {
    const f = fake({ FAKE_ACP_STUBBORN_MS: '60000' }, { cancelTimeoutMs: 2_000 });
    const s = await f.h.open(openArgs());
    const ev = events(s);
    await s.startTurn('t1', [input('in-1', 'stubborn')], run);
    await ev.until((e) => e.body.t === 'text.delta');
    await s.interrupt('t1');
    await ev.until(completed('t1'));
    const next = s.startTurn('t2', [input('in-2', 'hello')], run);
    const caught = next.catch((e: Error) => e);
    await new Promise((r) => setTimeout(r, 100));
    const closing = Date.now();
    await s.close('lane closed');
    expect(String(await caught)).toMatch(/acp session is closed/);
    expect(Date.now() - closing).toBeLessThan(1_000);
    await ev.done;
    expect(f.calls().filter((c) => c.call === 'session/prompt')).toHaveLength(1);
    expect(ev.of('turn.started').map((b) => b.turnId)).toEqual(['t1']);
  }, 15_000);
});

describe('the ACP harness: questions', () => {
  it('a form elicitation opens a question request (one question per field, choices by label); the answer goes back typed, a deny as a decline #HC-1 #RQ-1', async () => {
    const f = fake();
    const s = await f.h.open(openArgs());
    const ev = events(s);
    await s.startTurn('t1', [input('in-1', 'ask')], run);
    const opened = (await ev.until((e) => e.body.t === 'request.opened')).body as Extract<import('@agents-io/protocol').HarnessEvent['body'], { t: 'request.opened' }>;
    expect(opened).toMatchObject({
      kind: 'question',
      title: 'Which colour?',
      allowedDecisions: ['answer', 'deny', 'native'],
      questions: [
        { id: 'colour', text: 'Colour', options: [{ label: 'Red' }, { label: 'Green' }] },
        { id: 'count', text: 'How many' },
        { id: 'sure', text: 'Sure?' },
      ],
    });
    await s.respond(opened.requestId, { kind: 'answer', answers: { colour: 'Green', count: '2', sure: 'yes' } });
    await ev.until(completed('t1'));
    expect(f.calls().find((c) => c.call === 'elicitation-outcome')!.outcome).toEqual({ action: 'accept', content: { colour: 'g', count: 2, sure: true } });
    expect(ev.of('request.resolved')).toEqual([{ t: 'request.resolved', requestId: opened.requestId, decision: { kind: 'answer', answers: { colour: 'Green', count: '2', sure: 'yes' } }, by: { kind: 'host' } }]);

    await s.startTurn('t2', [input('in-2', 'ask')], run);
    const second = (await ev.until((e) => e.body.t === 'request.opened' && e.turnId === 't2')).body as { requestId: string };
    await s.respond(second.requestId, { kind: 'deny' });
    await ev.until(completed('t2'));
    expect(ev.of('text.snapshot').filter((x) => x.final).at(-1)!.text).toBe('declined');
    await s.close('done');
    await ev.done;
    expect(checkEventStream(ev.all, { turnInputs: { t1: ['in-1'], t2: ['in-2'] } })).toEqual([]);
  });
});

describe('the ACP harness: sessions across processes', () => {
  it('a session resumes on a new agent process with session/load; the replayed history (messages, a tool call, a plan) is not events, the next turn is #RS-1 #HC-1', async () => {
    const f = fake();
    const s = await f.h.open(openArgs());
    const nativeId = s.nativeId();
    const ev = events(s);
    await s.startTurn('t1', [input('in-1', 'first')], run);
    await ev.until(completed('t1'));
    await s.close('done');
    await f.h.dispose();

    const again = new AcpHarness({ command: process.execPath, args: [...loader, FAKE_AGENT], env: { FAKE_ACP_LOG: f.log, FAKE_ACP_STATE: `${f.dir}/state` } });
    try {
      const s2 = await again.open(openArgs({ resume: nativeId }));
      expect(s2.nativeId()).toBe(nativeId);
      const ev2 = events(s2);
      await s2.startTurn('t2', [input('in-2', 'second')], run);
      await ev2.until(completed('t2'));
      await s2.close('done');
      await ev2.done;
      expect(f.calls().filter((c) => c.call === 'session/load').map((c) => c.params.sessionId)).toEqual([nativeId]);
      // Only the session's binding and the new turn: nothing of the replay.
      expect(ev2.all.filter((e) => e.durability === 'durable').map((e) => e.body.t)).toEqual(['session.bound', 'turn.started', 'input.consumed', 'text.snapshot', 'text.snapshot', 'turn.completed']);
      expect(ev2.of('text.snapshot').map((x) => x.text).join(' ')).not.toContain('first');
      expect(ev2.of('item.started')).toEqual([]);
      expect(ev2.of('plan.updated')).toEqual([]);
    } finally {
      await again.dispose();
    }
  });

  it('a session the agent cannot load starts a new one and says so (continuity notice) #RS-1', async () => {
    const f = fake();
    const s = await f.h.open(openArgs({ resume: 'sess-nobody-knows' }));
    const ev = events(s);
    expect(s.nativeId()).not.toBe('sess-nobody-knows');
    await s.close('done');
    await ev.done;
    expect(ev.of('notice')).toEqual([expect.objectContaining({ code: 'continuity', message: expect.stringContaining('could not resume ACP session sess-nobody-knows') })]);
    expect(ev.of('session.bound')).toEqual([{ t: 'session.bound', nativeId: s.nativeId() }]);
  });

  it('an agent that exits mid-turn ends the turn ambiguous (agent_exited) and the session; the next open starts the agent again #HC-1', async () => {
    const f = fake();
    const s = await f.h.open(openArgs());
    const ev = events(s);
    await s.startTurn('t1', [input('in-1', 'exit')], run);
    await ev.until(completed('t1'));
    await ev.done;
    expect(ev.of('turn.completed')).toEqual([expect.objectContaining({ turnId: 't1', status: 'ambiguous', error: expect.objectContaining({ code: 'agent_exited' }) })]);
    expect(checkEventStream(ev.all, { turnInputs: { t1: ['in-1'] } })).toEqual([]);
    const s2 = await f.h.open(openArgs({ resume: s.nativeId() }));
    expect(s2.nativeId()).toBe(s.nativeId());
    expect(f.calls().filter((c) => c.call === 'start')).toHaveLength(2);
    await s2.close('done');
  });
});

describe('the ACP harness: the host MCP endpoint', () => {
  /** A stand-in for the host's MCP endpoint: stateless JSON answers, a bearer token. */
  async function endpoint(token: string) {
    const seen: { auth?: string; method?: string }[] = [];
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => {
        const m = JSON.parse(body) as { id?: number; method: string };
        seen.push({ auth: req.headers.authorization, method: m.method });
        if (req.headers.authorization !== `Bearer ${token}`) return res.writeHead(401).end();
        if (m.id === undefined) return res.writeHead(202).end();
        const result = m.method === 'tools/list' ? { tools: [{ name: 'send_message', inputSchema: { type: 'object' } }, { name: 'ask_choice', inputSchema: { type: 'object' } }] } : { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'x', version: '0' } };
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`, seen, close: () => new Promise((r) => server.close(r)) };
  }

  it('an agent that takes http MCP servers gets the endpoint as one, the token as a header; mcp: stdio-bridge runs the bridge, the token in its environment #SE-1', async () => {
    const token = `tok-${Math.random().toString(36).slice(2)}`;
    const ep = await endpoint(token);
    try {
      for (const way of ['http', 'stdio-bridge'] as const) {
        const f = fake({}, { mcp: way });
        const s = await f.h.open(openArgs({ mcp: { url: ep.url, token } }));
        const ev = events(s);
        await s.startTurn('t1', [input('in-1', 'mcp')], run);
        await ev.until(completed('t1'));
        expect(ev.of('text.snapshot').filter((x) => x.final).at(-1)!.text).toBe('tools: send_message,ask_choice');
        const servers = f.calls().find((c) => c.call === 'session/new')!.params.mcpServers;
        if (way === 'http') expect(servers).toEqual([{ type: 'http', name: 'agents-io', url: ep.url, headers: [{ name: 'Authorization', value: `Bearer ${token}` }] }]);
        else {
          expect(servers).toEqual([{ name: 'agents-io', command: process.execPath, args: [MCP_STDIO_BRIDGE], env: [{ name: 'AIO_MCP_URL', value: ep.url }, { name: 'AIO_MCP_TOKEN', value: token }] }]);
          expect(existsSync(MCP_STDIO_BRIDGE)).toBe(true);
        }
        // The token never reaches an event.
        await s.close('done');
        await ev.done;
        expect(JSON.stringify(ev.all)).not.toContain(token);
      }
      expect(ep.seen.every((x) => x.auth === `Bearer ${token}`)).toBe(true);
    } finally {
      await ep.close();
    }
  });

  it('without http MCP support the default is the stdio bridge; mcp: http then fails the open, saying why #FC-2', async () => {
    const f = fake({ FAKE_ACP_CAPS: JSON.stringify({ mcpCapabilities: {} }) });
    const s = await f.h.open(openArgs({ mcp: { url: 'http://127.0.0.1:1/mcp', token: 't' } }));
    expect(f.calls().find((c) => c.call === 'session/new')!.params.mcpServers[0]).toMatchObject({ command: process.execPath, args: [MCP_STDIO_BRIDGE] });
    await s.close('done');
    const g = fake({ FAKE_ACP_CAPS: JSON.stringify({ mcpCapabilities: {} }) }, { mcp: 'http' });
    await expect(g.h.open(openArgs({ mcp: { url: 'http://127.0.0.1:1/mcp', token: 't' } }))).rejects.toThrow(/does not take http MCP servers.*stdio-bridge/);
  });
});
