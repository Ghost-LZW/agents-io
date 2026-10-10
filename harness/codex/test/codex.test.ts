import { describe, expect, it } from 'vitest';
import type { HarnessSession } from '@agents-io/protocol';
import { assertConformingStream } from '@agents-io/testkit';
import { Hub, Lane, MemorySessionLog, defaultPolicy } from '@agents-io/session';
import { UnsupportedCodexVersionError, renderInputs } from '../src/index.js';
import { FakeAppServer, FakeRpcError } from './fake-app-server.js';
import { collector, input, isCompleted, open, run, setup, tick } from './codex-helpers.js';

describe('handshake and probe', () => {
  it('initializes with clientInfo, sends initialized, reports version and caps #HC-1', async () => {
    const { fake, harness } = setup();
    const p = await harness.probe();
    expect(p.version).toBe('0.160.1');
    expect(p.caps).toMatchObject({ steer: 'native', interrupt: true, approvals: true, questions: true, tokenDeltas: true, injectWithoutTurn: true, resume: true, switchModelMidSession: true, cancelQueued: false });
    const init = fake.sent('initialize')[0]!;
    expect(init.params.clientInfo).toMatchObject({ name: 'agents_io' });
    expect(init.params.capabilities).toMatchObject({ experimentalApi: false });
    expect(init.params.capabilities.optOutNotificationMethods).toContain('thread/realtime/started');
    const idx = fake.received.findIndex((m) => m.method === 'initialized');
    expect(idx).toBeGreaterThan(fake.received.indexOf(init));
  });

  it('refuses unknown versions clearly, unless allowed #HC-1', async () => {
    const { fake, harness } = setup();
    fake.userAgent = 'agents_io/0.170.0 (x)';
    await expect(harness.probe()).rejects.toBeInstanceOf(UnsupportedCodexVersionError);
    await expect(harness.probe()).rejects.toThrow(/0\.170\.0 is not supported.*0\.160\.x/);
    expect(fake.sent('initialized')).toHaveLength(0);

    const ok = setup({ allowUnknownVersion: true });
    ok.fake.userAgent = 'agents_io/0.170.0 (x)';
    expect((await ok.harness.probe()).version).toBe('0.170.0');

    const bad = setup({ allowUnknownVersion: true });
    bad.fake.userAgent = 'garbage';
    await expect(bad.harness.probe()).rejects.toThrow(/could not determine/);
  });
});

describe('open', () => {
  it('uses on-request for unconfigured profiles and honours configured ones #ID-6', async () => {
    const { fake, harness } = setup();
    await open(harness, { run: { ...run, profile: 'restricted' } });
    expect(fake.sent('thread/start')[0]!.params).toMatchObject({ approvalPolicy: 'on-request', sandbox: 'workspace-write' });
    await open(harness, { sessionKey: 's2', options: { profiles: { bypass: { approvalPolicy: 'never', sandbox: 'danger-full-access' } } } });
    expect(fake.sent('thread/start')[1]!.params).toMatchObject({ approvalPolicy: 'never', sandbox: 'danger-full-access' });
    expect(fake.spawned).toBe(1); // one process, many threads
  });

  it('rejects a per-session env (one shared app-server), accepts an empty one #HC-2', async () => {
    const { fake, harness } = setup();
    await expect(open(harness, { env: { K: 'v' } })).rejects.toThrow(/per-session env.*own app-server/);
    expect(fake.sent('thread/start')).toHaveLength(0);
    await open(harness, { env: {} });
    expect(fake.sent('thread/start')).toHaveLength(1);
  });

  it('resumes an existing thread #RS-1', async () => {
    const { fake, harness } = setup();
    const s = await open(harness, { resume: 'thr-old' });
    expect(s.nativeId()).toBe('thr-old');
    expect(fake.sent('thread/resume')[0]!.params).toMatchObject({ threadId: 'thr-old', excludeTurns: true, approvalPolicy: 'never' });
  });
});

describe('turn mapping', () => {
  it('maps a full turn to a conforming stream #HC-1 #ID-2', async () => {
    const { fake, harness } = setup();
    const s = await open(harness);
    const c = collector(s);
    fake.onTurnStart = (p, tid) => {
      const th = p.threadId;
      const n = (method: string, params: object) => fake.notify(method, { threadId: th, turnId: tid, ...params });
      fake.notify('thread/status/changed', { threadId: th, status: { type: 'active', activeFlags: [] } });
      fake.echoUser(th, tid, p.clientUserMessageId);
      n('item/started', { item: { type: 'reasoning', id: 'r1', summary: [], content: [] }, startedAtMs: 1 });
      n('item/reasoning/summaryTextDelta', { itemId: 'r1', delta: 'thinking', summaryIndex: 0 });
      n('item/completed', { item: { type: 'reasoning', id: 'r1', summary: ['thinking'], content: [] }, completedAtMs: 1 });
      n('item/started', { item: { type: 'agentMessage', id: 'm1', text: '', phase: 'commentary', memoryCitation: null, delivery: null, questions: null }, startedAtMs: 1 });
      n('item/agentMessage/delta', { itemId: 'm1', delta: 'Looking.' });
      n('item/completed', { item: { type: 'agentMessage', id: 'm1', text: 'Looking.', phase: 'commentary', memoryCitation: null, delivery: null, questions: null }, completedAtMs: 1 });
      n('turn/plan/updated', { explanation: null, plan: [{ step: 'look', status: 'inProgress' }, { step: 'fix', status: 'pending' }] });
      const cmd = { type: 'commandExecution', id: 'c1', pluginId: null, scriptPath: null, command: "/bin/zsh -lc 'ls -la'", cwd: '/work', processId: null, source: 'agent', commandActions: [], aggregatedOutput: null, exitCode: null, durationMs: null };
      n('item/started', { item: { ...cmd, status: 'inProgress' }, startedAtMs: 1 });
      n('item/commandExecution/outputDelta', { itemId: 'c1', delta: 'a.ts\n' });
      n('item/completed', { item: { ...cmd, status: 'completed', aggregatedOutput: 'a.ts\n', exitCode: 0, durationMs: 3 }, completedAtMs: 1 });
      const fc = { type: 'fileChange', id: 'f1', changes: [{ path: 'a.ts', kind: { type: 'update', move_path: null }, diff: '' }] };
      n('item/started', { item: { ...fc, status: 'inProgress' }, startedAtMs: 1 });
      n('item/completed', { item: { ...fc, status: 'completed' }, completedAtMs: 1 });
      n('turn/diff/updated', { diff: 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1,2 +1,2 @@\n-old\n+new\n+more\n' });
      const mcp = { type: 'mcpToolCall', id: 't1', server: 'lark', tool: 'send', arguments: { to: 'x' }, appContext: null, mcpAppUi: null, pluginId: null, readOnlyHint: null, error: null, durationMs: null };
      n('item/started', { item: { ...mcp, status: 'inProgress', result: null }, startedAtMs: 1 });
      n('item/mcpToolCall/progress', { itemId: 't1', message: 'sending' });
      n('item/completed', { item: { ...mcp, status: 'completed', result: { content: [{ type: 'text', text: 'sent' }], structuredContent: null, _meta: null } }, completedAtMs: 1 });
      n('item/completed', { item: { type: 'webSearch', id: 'w1', query: 'codex', action: null, results: null }, completedAtMs: 1 });
      n('item/started', { item: { type: 'agentMessage', id: 'm2', text: '', phase: 'final_answer', memoryCitation: null, delivery: null, questions: null }, startedAtMs: 1 });
      n('item/agentMessage/delta', { itemId: 'm2', delta: 'Done' });
      n('item/completed', { item: { type: 'agentMessage', id: 'm2', text: 'Done', phase: 'final_answer', memoryCitation: null, delivery: null, questions: null }, completedAtMs: 1 });
      n('thread/tokenUsage/updated', { tokenUsage: { total: { totalTokens: 10 }, last: { totalTokens: 10 }, modelContextWindow: 100 } });
      fake.notify('some/new/notification', { threadId: th, x: 1 });
      fake.completeTurn(th, tid, 'completed');
    };
    await s.startTurn('T1', [input('i1', 'fix it')]);
    await c.until(isCompleted);
    assertConformingStream(c.events, { turnInputs: { T1: ['i1'] } });

    const start = fake.sent('turn/start')[0]!.params;
    expect(start.clientUserMessageId).toBe('i1');
    expect(start.input[0].text).toBe('[sender from=owner kind=human via=lark:a:c1 chat="Team"]\nfix it');
    expect(start.effort).toBe('high'); // thread default was medium
    expect(start.model).toBeUndefined(); // unchanged from thread/start

    expect(c.of('turn.started')[0]).toMatchObject({ turnId: 'T1', inputIds: ['i1'], run });
    expect(c.of('input.consumed')).toEqual([{ t: 'input.consumed', inputIds: ['i1'], turnId: 'T1' }]);
    const items = c.of('item.completed').map((b) => [b.item.type, b.item.title, b.item.status]);
    expect(items).toEqual([
      ['reasoning', 'thinking', 'completed'],
      ['agent_message', 'Looking.', 'completed'],
      ['command', 'ls -la', 'completed'],
      ['file_change', 'Edit a.ts', 'completed'],
      ['mcp_tool', 'lark.send', 'completed'],
      ['web_search', 'codex', 'completed'],
      ['agent_message', 'Done', 'completed'],
    ]);
    expect(c.of('item.completed')[2]!.item.result).toEqual({ preview: 'a.ts\n', truncated: false, isError: false });
    expect(c.of('item.completed')[4]!.item.result?.preview).toBe('sent');
    const deltas = c.events.filter((e) => e.body.t === 'text.delta').map((e) => [(e.body as any).stream, e.audience, e.durability]);
    expect(deltas).toEqual([
      ['reasoning', 'commentary', 'ephemeral'],
      ['answer', 'commentary', 'ephemeral'],
      ['command_output', 'status', 'ephemeral'],
      ['answer', 'answer', 'ephemeral'],
    ]);
    expect(c.of('headline')[0]?.text).toBe('Looking.');
    expect(c.of('plan.updated')[0]?.steps).toEqual([{ text: 'look', status: 'in_progress' }, { text: 'fix', status: 'pending' }]);
    expect(c.of('diff.updated')[0]?.files).toEqual([{ path: 'a.ts', added: 2, removed: 1 }]);
    expect(c.of('item.progress')[0]).toMatchObject({ itemId: 't1', text: 'sending' });
    expect(c.of('usage')).toHaveLength(1);
    expect(c.of('native').map((b) => b.name)).toContain('some/new/notification');
    const finals = c.events.filter((e) => e.body.t === 'text.snapshot' && (e.body as any).final);
    expect(finals).toHaveLength(1);
    expect(finals[0]).toMatchObject({ audience: 'answer', itemId: 'm2', body: { text: 'Done' } });
    expect(c.of('session.state').map((b) => b.state)).toEqual(['running', 'idle']);
    const done = c.of('turn.completed')[0]!;
    expect(done).toMatchObject({ status: 'completed', usage: { total: { totalTokens: 10 } } });
  });

  it('a profile switch resets reviewer, approval policy and sandbox the new profile leaves unset #ID-6', async () => {
    const { fake, harness } = setup();
    const profiles = {
      auto: { approvalPolicy: 'on-request' as const, approvalsReviewer: 'auto_review' as const, sandbox: 'danger-full-access' as const },
      human: {},
    };
    const s = await open(harness, { run: { ...run, profile: 'auto' }, options: { profiles } });
    const c = collector(s);
    fake.onTurnStart = (p, tid) => {
      fake.echoUser(p.threadId, tid, p.clientUserMessageId);
      fake.completeTurn(p.threadId, tid, 'completed');
    };
    await s.startTurn('T1', [input('i1', 'a')]);
    await c.until(isCompleted);
    await s.startTurn('T2', [input('i2', 'b')], { ...run, profile: 'human' });
    await c.until((e) => isCompleted(e) && e.turnId === 'T2');
    // turn/start overrides persist on the thread: anything not re-sent stays as profile `auto` set it.
    expect(fake.sent('turn/start')[1]!.params).toMatchObject({
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user',
      sandboxPolicy: { type: 'workspaceWrite' },
    });
  });

  it('maps failed turns with code and retryable #HC-1 #IN-2', async () => {
    const { fake, harness } = setup();
    const s = await open(harness);
    const c = collector(s);
    fake.onTurnStart = (p, tid) => {
      fake.echoUser(p.threadId, tid, p.clientUserMessageId);
      fake.notify('error', { threadId: p.threadId, turnId: tid, willRetry: true, error: { message: 'reconnecting', codexErrorInfo: 'serverOverloaded', additionalDetails: null } });
      fake.completeTurn(p.threadId, tid, 'failed', { message: 'stream closed', codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 502 } }, additionalDetails: null });
    };
    await s.startTurn('T1', [input('i1', 'x')]);
    await c.until(isCompleted);
    expect(c.of('notice')[0]).toMatchObject({ code: 'api_retry', message: 'reconnecting' });
    expect(c.of('turn.completed')[0]).toMatchObject({ status: 'failed', error: { code: 'responseStreamDisconnected', retryable: true, message: 'stream closed' } });
    assertConformingStream(c.events);
  });

  it('reports a rejected turn/start as a failed turn #IN-1 #HC-1', async () => {
    const { fake, harness } = setup();
    fake.handlers['turn/start'] = () => {
      throw new FakeRpcError(-32600, 'model not found');
    };
    const s = await open(harness);
    const c = collector(s);
    await s.startTurn('T1', [input('i1', 'x')]);
    await c.until(isCompleted);
    expect(c.of('turn.completed')[0]).toMatchObject({ status: 'failed', error: { code: 'turn_start_rejected', message: 'model not found' } });
    assertConformingStream(c.events);
  });

  it('a resumed thread reporting its last turn usage before turn/start answers does not steal the new turn #HC-1', async () => {
    const { fake, harness } = setup();
    const start = fake.handlers['turn/start']!;
    fake.handlers['turn/start'] = (p) => {
      // What Codex does right after thread/resume: the usage of the thread's previous turn.
      fake.notify('thread/tokenUsage/updated', { threadId: p.threadId, turnId: 'earlier-turn', tokenUsage: { total: { totalTokens: 5 }, last: { totalTokens: 5 }, modelContextWindow: 100 } });
      return start(p);
    };
    fake.onTurnStart = (p, tid) => {
      fake.echoUser(p.threadId, tid, p.clientUserMessageId);
      fake.completeTurn(p.threadId, tid, 'completed');
    };
    const s = await open(harness, { resume: 'thr-7' });
    const c = collector(s);
    await s.startTurn('T1', [input('i1', 'x')]);
    await c.until((e) => isCompleted(e) && e.turnId === 'T1');
    expect(c.of('turn.completed')[0]).toMatchObject({ turnId: 'T1', status: 'completed' });
    expect(c.of('input.consumed')).toEqual([{ t: 'input.consumed', inputIds: ['i1'], turnId: 'T1' }]);
    expect(c.events.filter((e) => e.body.t === 'native' && e.body.name === 'turn/started')).toHaveLength(0);
  });

  it('maps turns started by another client as foreign turns #HC-1', async () => {
    const { fake, harness } = setup();
    const s = await open(harness);
    const c = collector(s);
    fake.notify('turn/started', { threadId: 'thr-1', turn: { id: 'tui-1', status: 'inProgress', items: [] } });
    fake.echoUser('thr-1', 'tui-1', null, 'typed in the TUI', 'um-tui');
    fake.notify('item/completed', { threadId: 'thr-1', turnId: 'tui-1', item: { type: 'agentMessage', id: 'm', text: 'ok', phase: 'final_answer', memoryCitation: null, delivery: null, questions: null } });
    fake.notify('turn/completed', { threadId: 'thr-1', turn: { id: 'tui-1', status: 'completed', items: [], error: null } });
    fake.notify('thread/tokenUsage/updated', { threadId: 'thr-1', turnId: 'tui-1', tokenUsage: {} }); // late: no new turn
    await c.until(isCompleted);
    await tick();
    expect(c.of('session.bound')).toEqual([{ t: 'session.bound', nativeId: 'thr-1' }]);
    expect(c.of('turn.started')).toEqual([{ t: 'turn.started', turnId: 'codex:tui-1', inputIds: [], replyRoute: null, initiator: 'foreign', nativeTurnId: 'tui-1' }]);
    expect(c.of('item.completed').map((b) => b.item.type)).toEqual(['user_message', 'agent_message']);
    expect(c.of('turn.completed')[0]).toMatchObject({ turnId: 'codex:tui-1', status: 'completed' });
    // the host can start its own turn afterwards
    fake.onTurnStart = (p, tid) => {
      fake.echoUser(p.threadId, tid, p.clientUserMessageId);
      fake.completeTurn(p.threadId, tid, 'completed');
    };
    await s.startTurn('T1', [input('i1', 'x')]);
    await c.until((e) => isCompleted(e) && e.turnId === 'T1');
    expect(c.of('turn.started')[1]).toMatchObject({ turnId: 'T1', initiator: 'host' });
    assertConformingStream(c.events, { turnInputs: { 'codex:tui-1': [], T1: ['i1'] } });
  });

  it('injects context with thread/inject_items #IN-6 #ID-2', async () => {
    const { fake, harness } = setup();
    fake.handlers['thread/inject_items'] = () => ({});
    const s = await open(harness);
    await s.inject!([input('i1', 'fyi: the build is green', { channelContext: {} })]);
    expect(fake.sent('thread/inject_items')[0]!.params).toEqual({
      threadId: 'thr-1',
      items: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: '[sender from=owner kind=human via=lark:a:c1]\nfyi: the build is green' }] }],
    });
  });
});

describe('steer', () => {
  it('steers with the Codex turn id and reconciles consumption of steered input #IN-1 #HC-1', async () => {
    const { fake, harness } = setup();
    const s = await open(harness);
    const c = collector(s);
    let codexTurn = '';
    fake.onTurnStart = (p, tid) => {
      codexTurn = tid;
      fake.echoUser(p.threadId, tid, p.clientUserMessageId);
    };
    fake.onSteer = (p, tid) => {
      fake.echoUser(p.threadId, tid, p.clientUserMessageId, 'more');
      fake.completeTurn(p.threadId, tid, 'completed');
    };
    await s.startTurn('T1', [input('i1', 'a')]);
    expect(await s.steer([input('i2', 'b'), input('i3', 'c')], 'T1')).toBe('steered');
    await c.until(isCompleted);
    const steer = fake.sent('turn/steer')[0]!.params;
    expect(steer).toMatchObject({ threadId: 'thr-1', expectedTurnId: codexTurn, clientUserMessageId: JSON.stringify(['i2', 'i3']) });
    expect(c.of('input.consumed').map((b) => b.inputIds)).toEqual([['i1'], ['i2', 'i3']]);
    assertConformingStream(c.events, { turnInputs: { T1: ['i1', 'i2', 'i3'] } });
    expect(await s.steer([input('i4', 'late')], 'T1')).toBe('no_active_turn');
  });

  it('maps stale, not steerable and no-active-turn #HC-1', async () => {
    const { fake, harness } = setup();
    const s = await open(harness);
    collector(s);
    expect(await s.steer([input('i0', 'x')], 'T0')).toBe('no_active_turn');
    await s.startTurn('T1', [input('i1', 'a')]);
    expect(await s.steer([input('i2', 'x')], 'OTHER')).toBe('stale');
    expect(fake.sent('turn/steer')).toHaveLength(0);

    // Codex's own active turn moved on (e.g. another client).
    fake.activeTurn.set('thr-1', 'turn-x');
    expect(await s.steer([input('i3', 'x')], 'T1')).toBe('stale');

    fake.handlers['turn/steer'] = () => {
      throw new FakeRpcError(-32600, 'cannot steer a compact turn', { message: 'cannot steer a compact turn', codexErrorInfo: { activeTurnNotSteerable: { turnKind: 'compact' } } });
    };
    expect(await s.steer([input('i4', 'x')], 'T1')).toBe('not_steerable');

    fake.handlers['turn/steer'] = () => {
      throw new FakeRpcError(-32600, 'no active turn to steer');
    };
    expect(await s.steer([input('i5', 'x')], 'T1')).toBe('no_active_turn');

    fake.handlers['turn/steer'] = () => {
      throw new FakeRpcError(-32603, 'boom');
    };
    await expect(s.steer([input('i6', 'x')], 'T1')).rejects.toThrow('boom');
  });

  it('a steer whose response is lost keeps its inputs: a later echo still counts them as consumed #IN-1 #HC-1', async () => {
    const { fake, harness } = setup({ requestTimeoutMs: 100 });
    const s = await open(harness);
    const c = collector(s);
    fake.onTurnStart = (p, tid) => fake.echoUser(p.threadId, tid, p.clientUserMessageId);
    fake.handlers['turn/steer'] = (p) => {
      // Codex takes the steer, but its response never arrives (stalled server): the request times out.
      setTimeout(() => fake.echoUser(p.threadId, fake.activeTurn.get(p.threadId)!, p.clientUserMessageId, 'more'), 150);
      return new Promise(() => {});
    };
    await s.startTurn('T1', [input('i1', 'a')]);
    await c.until((e) => e.body.t === 'input.consumed');
    // Not a failure: the lane must not requeue an input Codex may already have (it reconciles at turn end).
    expect(await s.steer([input('i2', 'b')], 'T1')).toBe('steered');
    expect(c.of('notice').some((n) => n.code === 'continuity' && /i2/.test(n.message))).toBe(true);
    await c.until((e) => e.body.t === 'input.consumed' && (e.body as any).inputIds.includes('i2'));
    expect(c.of('input.consumed').map((b) => b.inputIds)).toEqual([['i1'], ['i2']]);
    expect(c.of('item.completed').filter((b) => b.item.type === 'user_message')).toEqual([]);
  });
});

describe('approvals', () => {
  const cmdParams = (th: string, tid: string, extra: object = {}) => ({
    kind: 'command', threadId: th, turnId: tid, itemId: 'c1', startedAtMs: 1, environmentId: 'local',
    command: "/bin/zsh -lc 'rm -rf build'", cwd: '/work', commandActions: [], ...extra,
  });

  it('opens a request and maps decisions to Codex responses #RQ-1', async () => {
    const { fake, harness } = setup();
    const s = await open(harness, { run: { ...run, profile: 'restricted' } });
    const c = collector(s);
    const answers: unknown[] = [];
    fake.onTurnStart = async (p, tid) => {
      fake.echoUser(p.threadId, tid, p.clientUserMessageId);
      answers.push((await fake.request('item/commandExecution/requestApproval', cmdParams(p.threadId, tid))).result);
      fake.notify('serverRequest/resolved', { threadId: p.threadId, requestId: 0 });
      answers.push((await fake.request('item/fileChange/requestApproval', { threadId: p.threadId, turnId: tid, itemId: 'f1', startedAtMs: 1 })).result);
      answers.push((await fake.request('item/tool/requestUserInput', { threadId: p.threadId, turnId: tid, itemId: 'q1', questions: [{ id: 'color', header: 'Color', question: 'Which color?', isOther: false, isSecret: false, options: null }], isBlocking: true, autoResolutionMs: null })).result);
      answers.push((await fake.request('item/permissions/requestApproval', { threadId: p.threadId, turnId: tid, itemId: 'p1', environmentId: null, startedAtMs: 1, cwd: '/work', reason: 'need net', permissions: { network: { enabled: true }, fileSystem: null } })).result);
      fake.completeTurn(p.threadId, tid, 'completed');
    };
    await s.startTurn('T1', [input('i1', 'clean')]);

    const decide = async (n: number, d: Parameters<HarnessSession['respond']>[1]) => {
      const opened = await c.until((e) => e.body.t === 'request.opened' && c.of('request.opened').length >= n);
      await s.respond((c.of('request.opened')[n - 1]!).requestId, d);
      return opened;
    };
    await decide(1, { kind: 'allow_session' });
    await decide(2, { kind: 'deny', interruptTurn: true });
    await decide(3, { kind: 'answer', answers: { color: 'blue' } });
    await decide(4, { kind: 'allow_once' });
    await c.until(isCompleted);

    expect(answers).toEqual([
      { decision: 'acceptForSession' },
      { decision: 'cancel' },
      { answers: { color: { answers: ['blue'] } } },
      { permissions: { network: { enabled: true } }, scope: 'turn' },
    ]);
    const opened = c.of('request.opened');
    expect(opened.map((o) => o.kind)).toEqual(['tool_approval', 'file_change', 'question', 'permissions']);
    expect(opened[0]).toMatchObject({ requestId: '0', title: 'Run: rm -rf build', allowAlways: true, defaultDeny: true });
    expect(opened[2]!.title).toBe('Which color?');
    expect(opened[0]!.inputPreview).toBe('rm -rf build (in /work)');
    expect(opened[2]!.questions).toEqual([{ id: 'color', text: 'Which color?', header: 'Color' }]);
    expect(opened[3]!.inputPreview).toBe('network');
    const ev = c.events.find((e) => e.body.t === 'request.opened')!;
    expect(ev).toMatchObject({ turnId: 'T1', itemId: 'c1', audience: 'approval' });
    // one resolution per request, even though Codex also sent serverRequest/resolved for #0
    expect(c.of('request.resolved').map((r) => [r.requestId, r.decision?.kind])).toEqual([
      ['0', 'allow_session'], ['1', 'deny'], ['2', 'answer'], ['3', 'allow_once'],
    ]);
    assertConformingStream(c.events);
  });

  it('honours availableDecisions and reports requests resolved elsewhere #RQ-1', async () => {
    const { fake, harness } = setup();
    const s = await open(harness);
    const c = collector(s);
    let answer: unknown;
    fake.onTurnStart = async (p, tid) => {
      fake.echoUser(p.threadId, tid, p.clientUserMessageId);
      // another client answers request 0: we only see serverRequest/resolved
      void fake.request('item/commandExecution/requestApproval', cmdParams(p.threadId, tid));
      await tick();
      fake.notify('serverRequest/resolved', { threadId: p.threadId, requestId: 0 });
      answer = (await fake.request('item/commandExecution/requestApproval', cmdParams(p.threadId, tid, { availableDecisions: ['accept', 'cancel'] }))).result;
      fake.completeTurn(p.threadId, tid, 'completed');
    };
    await s.startTurn('T1', [input('i1', 'x')]);
    await c.until((e) => e.body.t === 'request.opened' && (e.body as any).requestId === '1');
    const second = c.of('request.opened')[1]!;
    expect(second.allowedDecisions).toEqual(['allow_once', 'deny', 'native']);
    expect(second.allowAlways).toBe(false);
    await s.respond('1', { kind: 'deny' });
    await c.until(isCompleted);
    expect(answer).toEqual({ decision: 'cancel' }); // decline not offered
    expect(c.of('request.resolved')[0]).toMatchObject({ requestId: '0', decision: null, by: { kind: 'harness' } });
    await expect(s.respond('0', { kind: 'allow_once' })).rejects.toThrow(/unknown or already resolved/);
    assertConformingStream(c.events);
  });

  it('passes native decisions through and cancels open requests when the turn ends #RQ-2', async () => {
    const { fake, harness } = setup();
    const s = await open(harness);
    const c = collector(s);
    let answer: unknown;
    fake.onTurnStart = async (p, tid) => {
      fake.echoUser(p.threadId, tid, p.clientUserMessageId);
      answer = (await fake.request('item/commandExecution/requestApproval', cmdParams(p.threadId, tid))).result;
      void fake.request('item/fileChange/requestApproval', { threadId: p.threadId, turnId: tid, itemId: 'f1', startedAtMs: 1 });
      await tick();
      fake.completeTurn(p.threadId, tid, 'interrupted');
    };
    await s.startTurn('T1', [input('i1', 'x')]);
    await c.until((e) => e.body.t === 'request.opened');
    const payload = { decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['rm'] } } };
    await s.respond('0', { kind: 'native', payload });
    await c.until(isCompleted);
    expect(answer).toEqual(payload);
    expect(c.of('request.resolved')[1]).toMatchObject({ requestId: '1', by: 'runtime_cancelled' });
    assertConformingStream(c.events);
  });

  const autoReview = (fake: FakeAppServer, th: string, tid: string, status: 'approved' | 'denied', rationale: string | null = null) => {
    const base = { threadId: th, turnId: tid, reviewId: 'rv1', targetItemId: 'c1', action: { type: 'command', source: 'shell', command: 'curl example.com', cwd: '/work' } };
    fake.notify('item/autoApprovalReview/started', { ...base, startedAtMs: 1, review: { status: 'inProgress', riskLevel: null, userAuthorization: null, rationale: null } });
    fake.notify('item/autoApprovalReview/completed', { ...base, startedAtMs: 1, completedAtMs: 2, decisionSource: 'agent', review: { status, riskLevel: 'high', userAuthorization: null, rationale } });
  };

  it('reports Codex auto reviews as notices, never as requests a resolver could answer #RQ-1', async () => {
    const { fake, harness } = setup();
    const s = await open(harness);
    const c = collector(s);
    fake.onTurnStart = (p, tid) => {
      fake.echoUser(p.threadId, tid, p.clientUserMessageId);
      autoReview(fake, p.threadId, tid, 'denied', 'exfiltration');
      fake.completeTurn(p.threadId, tid, 'completed');
    };
    await s.startTurn('T1', [input('i1', 'x')]);
    await c.until(isCompleted);
    expect(c.of('request.opened')).toEqual([]);
    expect(c.of('request.resolved')).toEqual([]);
    expect(c.of('notice').filter((n) => n.code === 'auto_review').map((n) => n.message)).toEqual([
      'auto review: Run: curl example.com',
      'auto review denied: Run: curl example.com (exfiltration)',
    ]);
    const done = c.events.find((e) => e.body.t === 'notice' && /denied/.test((e.body as any).message))!;
    expect(done).toMatchObject({ turnId: 'T1', level: 'primary', native: { method: 'item/autoApprovalReview/completed' } });
    assertConformingStream(c.events);
  });

  it('a restricted lane records no deny for an action Codex auto review approved #RQ-1 #ID-6', async () => {
    const { fake, harness } = setup();
    fake.onTurnStart = (p, tid) => {
      fake.echoUser(p.threadId, tid, p.clientUserMessageId);
      autoReview(fake, p.threadId, tid, 'approved');
      fake.completeTurn(p.threadId, tid, 'completed');
    };
    const hub = new Hub(new MemorySessionLog());
    const lane = new Lane({ sessionKey: 'k', harness, hub, policy: defaultPolicy({ owners: ['lark:someone-else'], run }), cwd: '/work' });
    try {
      const stranger = input('i1', 'x', { origin: { kind: 'human', principal: null, evidence: 'platform_signed', via: 'lark:a:c1', adapter: 'lark' } });
      await lane.command({ type: 'input', sessionKey: 'k', input: stranger, mode: 'queue' });
      const log = () => hub.log.read('k', 0).map((e) => e.body);
      for (let i = 0; i < 200 && !log().some((b) => b.t === 'turn.completed'); i++) await tick();
      expect(log().find((b) => b.t === 'turn.started')).toMatchObject({ run: { profile: 'restricted' } });
      expect(log().filter((b) => b.t === 'request.opened' || b.t === 'request.resolved')).toEqual([]);
      expect(log().filter((b) => b.t === 'notice' && b.code === 'auto_review').map((b) => (b as any).message)).toContain('auto review approved: Run: curl example.com');
    } finally {
      await lane.close();
    }
  });

  it('refuses server requests it does not implement #HC-1', async () => {
    const { fake, harness } = setup();
    const s = await open(harness);
    collector(s);
    const r = await fake.request('item/tool/call', { threadId: 'thr-1', turnId: 'x', callId: 'c', tool: 't', arguments: {} });
    expect(r.error.code).toBe(-32601);
    const r2 = await fake.request('account/chatgptAuthTokens/refresh', {});
    expect(r2.error.code).toBe(-32601);
  });
});

describe('consumed reconciliation', () => {
  it('marks a turn ambiguous when Codex never echoes an input #IN-1 #HC-1', async () => {
    const { fake, harness } = setup();
    const s = await open(harness);
    const c = collector(s);
    fake.onTurnStart = (p, tid) => {
      fake.echoUser(p.threadId, tid, 'i1');
      fake.completeTurn(p.threadId, tid, 'completed');
    };
    await s.startTurn('T1', [input('i1', 'a'), input('i2', 'b')]);
    await c.until(isCompleted);
    expect(fake.sent('turn/start')[0]!.params.clientUserMessageId).toBe('["i1","i2"]');
    expect(c.of('input.consumed').map((b) => b.inputIds)).toEqual([['i1']]);
    expect(c.of('notice').map((n) => n.code)).toContain('continuity');
    expect(c.of('turn.completed')[0]!.status).toBe('ambiguous');
    assertConformingStream(c.events, { turnInputs: { T1: ['i1', 'i2'] } });
  });

  it('decodes batch client ids and ignores user messages from other clients #IN-4 #HC-1', async () => {
    const { fake, harness } = setup();
    const s = await open(harness);
    const c = collector(s);
    fake.onTurnStart = (p, tid) => {
      fake.echoUser(p.threadId, tid, p.clientUserMessageId);
      fake.echoUser(p.threadId, tid, null, 'typed in the TUI', 'um-tui');
      fake.completeTurn(p.threadId, tid, 'completed');
    };
    await s.startTurn('T1', [input('i1', 'a'), input('i2', 'b')]);
    await c.until(isCompleted);
    expect(c.of('input.consumed').map((b) => b.inputIds)).toEqual([['i1', 'i2']]);
    expect(c.of('item.completed').map((b) => [b.item.type, b.item.title])).toEqual([['user_message', 'typed in the TUI']]);
    expect(c.of('turn.completed')[0]!.status).toBe('completed');
    assertConformingStream(c.events, { turnInputs: { T1: ['i1', 'i2'] } });
  });
});

describe('interrupt and lifecycle', () => {
  it('interrupts with the Codex turn id #IN-1 #HC-1', async () => {
    const { fake, harness } = setup();
    const s = await open(harness);
    const c = collector(s);
    fake.onTurnStart = (p, tid) => fake.echoUser(p.threadId, tid, p.clientUserMessageId);
    await s.startTurn('T1', [input('i1', 'long task')]);
    await s.interrupt('NOT-T1'); // ignored
    await s.interrupt('T1');
    await c.until(isCompleted);
    expect(fake.sent('turn/interrupt').map((m) => m.params)).toEqual([{ threadId: 'thr-1', turnId: 'turn-1' }]);
    expect(c.of('turn.completed')[0]!.status).toBe('interrupted');
    assertConformingStream(c.events);
  });

  it('ends the turn as ambiguous and the stream when app-server dies #IN-1 #HC-1', async () => {
    const { fake, harness } = setup();
    const s = await open(harness);
    const c = collector(s);
    fake.onTurnStart = () => fake.kill('codex app-server exited (SIGKILL)');
    await s.startTurn('T1', [input('i1', 'x')]);
    await c.done;
    expect(c.of('turn.completed')[0]).toMatchObject({ status: 'ambiguous', error: { code: 'harness_exited' } });
    expect(c.of('session.state').at(-1)?.state).toBe('error');
    assertConformingStream(c.events);
    // the next open respawns
    await open(harness, { sessionKey: 's2' });
    expect(fake.spawned).toBe(2);
  });

  it('unsubscribes on close and stops the process with the last session #HC-1', async () => {
    const { fake, harness } = setup();
    const a = await open(harness);
    const b = await open(harness, { sessionKey: 's2' });
    const ca = collector(a);
    await a.close('done');
    await ca.done;
    expect(fake.sent('thread/unsubscribe').map((m) => m.params)).toEqual([{ threadId: 'thr-1' }]);
    await tick();
    expect(fake.closedByClient).toBe(0);
    await b.close('done');
    await tick();
    expect(fake.closedByClient).toBe(1);
    await expect(a.startTurn('T9', [input('i9', 'x')])).rejects.toThrow(/closed/);
  });

  it('close interrupts an active turn first #IN-1 #HC-1', async () => {
    const { fake, harness } = setup();
    const s = await open(harness);
    const c = collector(s);
    fake.onTurnStart = (p, tid) => fake.echoUser(p.threadId, tid, p.clientUserMessageId);
    await s.startTurn('T1', [input('i1', 'x')]);
    await s.close('bye');
    await c.done;
    expect(fake.sent('turn/interrupt')).toHaveLength(1);
    expect(c.of('turn.completed')[0]!.status).toBe('interrupted');
    assertConformingStream(c.events);
  });
});

describe('helpers', () => {
  it('renders quote, transcript, ref, event and resolved images #MD-1', async () => {
    const rec = input('i1', 'look', {
      content: [
        { type: 'quote', text: 'a\nb' },
        { type: 'transcript', speaker: 'Ann', text: 'hello', startMs: 1000, endMs: 2500, stable: true },
        { type: 'image', ref: 'sha256:1', mime: 'image/png', name: 'x.png' },
        { type: 'ref', uri: 'https://e.x/doc', title: 'Doc' },
        { type: 'event', name: 'card.click', data: { v: 1 } },
        { type: 'image', ref: 'sha256:2', mime: 'image/png' },
      ],
    });
    const out = await renderInputs([rec], { resolveMedia: (b) => (b.ref === 'sha256:1' ? { path: '/blobs/1.png' } : null) });
    expect(out).toEqual([
      { type: 'text', text: '[sender from=owner kind=human via=lark:a:c1 chat="Team"]\n> a\n> b\n[transcript 1s-3s] Ann: hello', text_elements: [] },
      { type: 'localImage', path: '/blobs/1.png' },
      { type: 'text', text: '[ref Doc](https://e.x/doc)\n[event card.click] {"v":1}\n[image sha256:2 (image/png) not available]', text_elements: [] },
    ]);
  });

  it('sender preface carries ref=channel:<channel>/<message id> only for a channel message, bare like Claude Code #EX-4', async () => {
    const ref = 'channel:lark-bot/om_1';
    expect(await renderInputs([{ ...input('i1', 'confirm'), channelRef: ref }])).toEqual([
      { type: 'text', text: `[sender from=owner kind=human via=lark:a:c1 ref=${ref} chat="Team"]\nconfirm`, text_elements: [] },
    ]);
    expect(((await renderInputs([input('i2', 'local')]))[0] as { text: string }).text).not.toMatch(/ ref=/);
  });

  it('labels context-only inputs as not addressed to the agent (also without the sender preface) #ID-2', async () => {
    const stranger = { kind: 'human' as const, principal: null, evidence: 'platform_signed' as const, via: 'lark:a:g1', adapter: 'lark' };
    const ctx = { ...input('c1', 'the launch moved to Thursday'), origin: stranger, channelContext: { senderName: 'Eve', context: true } };
    const label = '[context, not addressed to you: recorded in the conversation; read it, do not reply to it unless the addressed input asks]';
    expect(await renderInputs([ctx, input('i1', 'what did they say?')])).toEqual([
      { type: 'text', text: `${label}\n[sender from=unknown kind=human via=lark:a:g1 senderName="Eve" context=true]\nthe launch moved to Thursday`, text_elements: [] },
      { type: 'text', text: '[sender from=owner kind=human via=lark:a:c1 chat="Team"]\nwhat did they say?', text_elements: [] },
    ]);
    expect(await renderInputs([ctx], { preface: false })).toEqual([{ type: 'text', text: `${label}\nthe launch moved to Thursday`, text_elements: [] }]);
  });

  // What Watches.deliverWatch hands the lane for a trigger watch (packages/session/src/watch.ts).
  const watched = () => input('w1', 'ship it?', { channelContext: { watch: 'wg', watchMode: 'trigger', watchSource: 'lark:a:g1' } });

  it('a watched input reaches the model with the watch= marker in its sender preface #ID-2', async () => {
    const { fake, harness } = setup();
    const s = await open(harness);
    collector(s);
    await s.startTurn('T1', [watched()]);
    expect(fake.sent('turn/start')[0]!.params.input[0].text).toMatch(/^\[sender .* watch="wg"( |\])/);
  });

  // INVARIANTS ID-2 不成立 1: the sender preface omits origin.evidence; turns red when fixed — make it `it` and update INVARIANTS.
  it.fails('the sender preface names the origin evidence #ID-2', async () => {
    const [first] = (await renderInputs([input('i1', 'x')])) as { text: string }[];
    expect(first!.text).toMatch(/ evidence=("?)platform_signed\1/);
  });

  // INVARIANTS ID-2 不成立 2: `preface: false` drops the whole sender preface, watch marker included; turns red when fixed — make it `it` and update INVARIANTS.
  it.fails('preface: false still marks a watched input as watched #ID-2', async () => {
    const [first] = (await renderInputs([watched()], { preface: false })) as { text: string }[];
    expect(first!.text).toMatch(/watch=("?)wg\1/);
  });
});

describe('live (realtime voice, decision 11)', () => {
  const offer = { type: 'webrtc' as const, sdp: 'v=0 offer' };

  function liveServer(fake: FakeAppServer) {
    fake.handlers['thread/realtime/start'] = (p) => {
      queueMicrotask(() => {
        fake.notify('thread/realtime/started', { threadId: p.threadId, realtimeSessionId: p.threadId, version: 'v3' });
        fake.notify('thread/realtime/sdp', { threadId: p.threadId, sdp: 'v=0 answer' });
      });
      return {};
    };
    fake.handlers['thread/realtime/stop'] = (p) => {
      queueMicrotask(() => fake.notify('thread/realtime/closed', { threadId: p.threadId, reason: 'requested' }));
      return {};
    };
    fake.handlers['thread/realtime/appendSpeech'] = () => ({});
  }

  it('starts v3 over WebRTC on the thread and returns the answer; transcripts, speech and stop map #LN-4', async () => {
    const { fake, harness } = setup({ live: true });
    liveServer(fake);
    const s = await open(harness);
    const c = collector(s);
    const r = await s.live!.start({ liveId: 'L1', transport: offer, instructions: 'be brief', voice: 'cove' });
    expect(r).toEqual({ answerSdp: 'v=0 answer' });
    expect(fake.sent('thread/realtime/start')[0]!.params).toEqual({
      threadId: 'thr-1',
      version: 'v3',
      outputModality: 'audio',
      transport: offer,
      initialItems: [{ role: 'developer', text: 'be brief' }],
      voice: 'cove',
    });
    await expect(s.live!.start({ liveId: 'L2', transport: offer })).rejects.toThrow(/already running/);
    fake.notify('thread/realtime/transcript/done', { threadId: 'thr-1', role: 'user', text: ' 听见吗 ' });
    fake.notify('thread/realtime/transcript/done', { threadId: 'thr-1', role: 'assistant', text: '听见啦' });
    await s.live!.say('hello all');
    expect(fake.sent('thread/realtime/appendSpeech')[0]!.params).toEqual({ threadId: 'thr-1', text: 'hello all' });
    await s.live!.stop();
    await c.until((e) => e.body.t === 'live.ended');
    expect(c.of('live.transcript')).toEqual([
      { t: 'live.transcript', liveId: 'L1', role: 'user', text: '听见吗' },
      { t: 'live.transcript', liveId: 'L1', role: 'assistant', text: '听见啦' },
    ]);
    expect(c.of('live.ended')).toEqual([{ t: 'live.ended', liveId: 'L1', reason: 'requested' }]);
    await expect(s.live!.say('x')).rejects.toThrow(/no live/);
  });

  it('a delegation becomes the input of the turn Codex starts for it (initiator harness, consumed) #LN-6', async () => {
    const { fake, harness } = setup({ live: true });
    liveServer(fake);
    const s = await open(harness);
    const c = collector(s);
    await s.live!.start({ liveId: 'L1', transport: offer });
    fake.notify('thread/realtime/itemAdded', { threadId: 'thr-1', item: { type: 'handoff_request', handoff_id: 'h1', item_id: 'h1', input_transcript: '看看当前目录', active_transcript: [] } });
    fake.notify('turn/started', { threadId: 'thr-1', turn: { id: 'd-1', status: 'inProgress', items: [] } });
    fake.notify('item/completed', { threadId: 'thr-1', turnId: 'd-1', item: { type: 'agentMessage', id: 'm', text: '目录是空的', phase: 'final_answer', memoryCitation: null, delivery: null, questions: null } });
    // a second delegation while that turn runs is folded into it
    fake.notify('thread/realtime/itemAdded', { threadId: 'thr-1', item: { type: 'handoff_request', handoff_id: 'h2', input_transcript: '你挂了吧' } });
    fake.notify('turn/completed', { threadId: 'thr-1', turn: { id: 'd-1', status: 'completed', items: [], error: null } });
    await c.until(isCompleted);
    expect(c.of('live.handoff')).toEqual([
      { t: 'live.handoff', liveId: 'L1', inputId: 'live:L1:h1', text: '看看当前目录' },
      { t: 'live.handoff', liveId: 'L1', inputId: 'live:L1:h2', text: '你挂了吧' },
    ]);
    expect(c.of('turn.started')).toEqual([{ t: 'turn.started', turnId: 'codex:d-1', inputIds: ['live:L1:h1'], replyRoute: null, initiator: 'harness', nativeTurnId: 'd-1' }]);
    expect(c.of('input.consumed').map((b) => b.inputIds)).toEqual([['live:L1:h1'], ['live:L1:h2']]);
    expect(c.of('turn.completed')[0]).toMatchObject({ turnId: 'codex:d-1', status: 'completed' });
    // a turn with no delegation pending stays foreign
    fake.notify('turn/started', { threadId: 'thr-1', turn: { id: 'tui-2', status: 'inProgress', items: [] } });
    await c.until((e) => e.body.t === 'turn.started' && e.turnId === 'codex:tui-2');
    expect(c.of('turn.started')[1]).toMatchObject({ initiator: 'foreign', inputIds: [] });
  });

  it('a start whose answer never comes or fails cleans up; the session closing ends the live #LN-4', async () => {
    const { fake, harness } = setup({ live: true });
    fake.handlers['thread/realtime/start'] = () => {
      throw new FakeRpcError(-32600, 'realtime unavailable');
    };
    fake.handlers['thread/realtime/stop'] = () => ({});
    const s = await open(harness);
    const c = collector(s);
    await expect(s.live!.start({ liveId: 'L1', transport: offer })).rejects.toThrow(/realtime unavailable/);
    liveServer(fake);
    fake.handlers['thread/realtime/stop'] = () => ({});
    await s.live!.start({ liveId: 'L2', transport: offer });
    await s.close('bye');
    await c.done;
    expect(c.of('live.ended')).toEqual([{ t: 'live.ended', liveId: 'L2', reason: 'session closed' }]);
  });
});
