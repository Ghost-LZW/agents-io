import { describe, expect, it } from 'vitest';
import type { HarnessEvent, HarnessOpenArgs, HarnessSession, InputRecord } from '@agents-io/protocol';
import { assertConformingStream, checkEventStream } from '@agents-io/testkit';
import { CodexHarness, UnsupportedCodexVersionError, diffStats, renderInputs, summarizeItem, type CodexHarnessOptions } from '../src/index.js';
import { displayCommand } from '../src/map.js';
import { FakeAppServer, FakeRpcError } from './fake-app-server.js';

const input = (id: string, text: string, extra: Partial<InputRecord> = {}): InputRecord => ({
  inputId: id,
  origin: { kind: 'human', principal: { id: 'owner', labels: ['owner'] }, evidence: 'platform_signed', via: 'lark:a:c1', adapter: 'lark' },
  content: [{ type: 'text', text }],
  replyRoute: { channel: 'lark', account: 'a', conversationId: 'c1' },
  channelContext: { chat: 'Team' },
  ...extra,
});

const run = { harness: 'codex', model: 'gpt-5.5', effort: 'high', profile: 'bypass' };

function setup(opts: Partial<CodexHarnessOptions> = {}) {
  const fake = new FakeAppServer();
  const harness = new CodexHarness({ transport: fake.transport, ...opts });
  return { fake, harness };
}

async function open(harness: CodexHarness, over: Partial<HarnessOpenArgs> = {}) {
  return harness.open({ sessionKey: 's1', generation: 1, cwd: '/work', run, ...over });
}

/** Collects events until `until` matches (inclusive). */
function collector(s: HarnessSession) {
  const events: HarnessEvent[] = [];
  const waiters: { pred: (e: HarnessEvent) => boolean; resolve: (e: HarnessEvent) => void }[] = [];
  let ended = false;
  const done = (async () => {
    for await (const e of s.events) {
      events.push(e);
      for (const w of [...waiters]) if (w.pred(e)) (waiters.splice(waiters.indexOf(w), 1), w.resolve(e));
    }
    ended = true;
  })();
  return {
    events,
    done,
    get ended() {
      return ended;
    },
    until(pred: (e: HarnessEvent) => boolean): Promise<HarnessEvent> {
      const hit = events.find(pred);
      if (hit) return Promise.resolve(hit);
      return new Promise((resolve) => waiters.push({ pred, resolve }));
    },
    of<T extends HarnessEvent['body']['t']>(t: T) {
      return events.filter((e) => e.body.t === t).map((e) => e.body as Extract<HarnessEvent['body'], { t: T }>);
    },
  };
}

const isCompleted = (e: HarnessEvent) => e.body.t === 'turn.completed';
const tick = () => new Promise((r) => setTimeout(r, 5));

describe('handshake and probe', () => {
  it('initializes with clientInfo, sends initialized, reports version and caps', async () => {
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

  it('refuses unknown versions clearly, unless allowed', async () => {
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
  it('maps RunSpec and the bypass profile to thread/start; nativeId is the thread id', async () => {
    const { fake, harness } = setup();
    const s = await open(harness, { mcp: { url: 'http://127.0.0.1:9/mcp', token: 'tok' } });
    expect(s.nativeId()).toBe('thr-1');
    const p = fake.sent('thread/start')[0]!.params;
    expect(p).toMatchObject({ model: 'gpt-5.5', cwd: '/work', approvalPolicy: 'never', sandbox: 'workspace-write' });
    expect(p.config.mcp_servers.agents_io).toEqual({ url: 'http://127.0.0.1:9/mcp', http_headers: { Authorization: 'Bearer tok' } });
  });

  it('uses on-request for unconfigured profiles and honours configured ones', async () => {
    const { fake, harness } = setup();
    await open(harness, { run: { ...run, profile: 'restricted' } });
    expect(fake.sent('thread/start')[0]!.params).toMatchObject({ approvalPolicy: 'on-request', sandbox: 'workspace-write' });
    await open(harness, { sessionKey: 's2', options: { profiles: { bypass: { approvalPolicy: 'never', sandbox: 'danger-full-access' } } } });
    expect(fake.sent('thread/start')[1]!.params).toMatchObject({ approvalPolicy: 'never', sandbox: 'danger-full-access' });
    expect(fake.spawned).toBe(1); // one process, many threads
  });

  it('resumes an existing thread', async () => {
    const { fake, harness } = setup();
    const s = await open(harness, { resume: 'thr-old' });
    expect(s.nativeId()).toBe('thr-old');
    expect(fake.sent('thread/resume')[0]!.params).toMatchObject({ threadId: 'thr-old', excludeTurns: true, approvalPolicy: 'never' });
  });
});

describe('turn mapping', () => {
  it('maps a full turn to a conforming stream', async () => {
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
      ['reasoning', 'internal', 'ephemeral'],
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

  it('sends per-turn overrides only when the RunSpec changes', async () => {
    const { fake, harness } = setup();
    const s = await open(harness, { run: { ...run, effort: undefined } });
    const c = collector(s);
    fake.onTurnStart = (p, tid) => {
      fake.echoUser(p.threadId, tid, p.clientUserMessageId);
      fake.completeTurn(p.threadId, tid, 'completed');
    };
    await s.startTurn('T1', [input('i1', 'a')]);
    await c.until(isCompleted);
    await s.startTurn('T2', [input('i2', 'b')], { harness: 'codex', model: 'gpt-6', effort: 'low', profile: 'restricted' });
    await c.until((e) => isCompleted(e) && e.turnId === 'T2');
    const [a, b] = fake.sent('turn/start').map((m) => m.params);
    expect(a).not.toHaveProperty('model');
    expect(a).not.toHaveProperty('approvalPolicy');
    expect(b).toMatchObject({ model: 'gpt-6', effort: 'low', approvalPolicy: 'on-request', sandboxPolicy: { type: 'workspaceWrite' } });
    expect(checkEventStream(c.events)).toEqual([]);
  });

  it('maps failed turns with code and retryable', async () => {
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

  it('reports a rejected turn/start as a failed turn', async () => {
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

  it('maps turns started by another client as foreign turns', async () => {
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

  it('injects context with thread/inject_items', async () => {
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
  it('steers with the Codex turn id and reconciles consumption of steered input', async () => {
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

  it('maps stale, not steerable and no-active-turn', async () => {
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
});

describe('approvals', () => {
  const cmdParams = (th: string, tid: string, extra: object = {}) => ({
    kind: 'command', threadId: th, turnId: tid, itemId: 'c1', startedAtMs: 1, environmentId: 'local',
    command: "/bin/zsh -lc 'rm -rf build'", cwd: '/work', commandActions: [], ...extra,
  });

  it('opens a request and maps decisions to Codex responses', async () => {
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

  it('honours availableDecisions and reports requests resolved elsewhere', async () => {
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

  it('passes native decisions through and cancels open requests when the turn ends', async () => {
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

  it('offers Codex amendments as suggestions and maps them back from allow_session', async () => {
    const { fake, harness } = setup();
    const s = await open(harness);
    const c = collector(s);
    const answers: unknown[] = [];
    const avail = ['accept', { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['touch', 'x'] } }, 'cancel'];
    fake.onTurnStart = async (p, tid) => {
      fake.echoUser(p.threadId, tid, p.clientUserMessageId);
      const params = cmdParams(p.threadId, tid, { command: "/bin/zsh -lc 'touch x'", proposedExecpolicyAmendment: ['touch', 'x'], availableDecisions: avail });
      answers.push((await fake.request('item/commandExecution/requestApproval', params)).result);
      answers.push((await fake.request('item/commandExecution/requestApproval', params)).result);
      fake.completeTurn(p.threadId, tid, 'completed');
    };
    await s.startTurn('T1', [input('i1', 'x')]);
    await c.until((e) => e.body.t === 'request.opened');
    const o = c.of('request.opened')[0]!;
    expect(o.allowedDecisions).toEqual(['allow_once', 'allow_session', 'deny', 'native']);
    expect(o.allowAlways).toBe(true);
    expect(o.suggestions).toEqual([{ execpolicyAmendment: ['touch', 'x'] }]);
    await s.respond(o.requestId, { kind: 'allow_session' });
    await c.until((e) => e.body.t === 'request.opened' && c.of('request.opened').length === 2);
    await s.respond(c.of('request.opened')[1]!.requestId, { kind: 'allow_session', updatedPermissions: { execpolicyAmendment: ['touch'] } });
    await c.until(isCompleted);
    expect(answers).toEqual([
      { decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['touch', 'x'] } } },
      { decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: ['touch'] } } },
    ]);
  });

  it('shows Codex auto reviews as requests resolved by the harness', async () => {
    const { fake, harness } = setup();
    const s = await open(harness);
    const c = collector(s);
    fake.onTurnStart = (p, tid) => {
      fake.echoUser(p.threadId, tid, p.clientUserMessageId);
      const base = { threadId: p.threadId, turnId: tid, reviewId: 'rv1', targetItemId: 'c1', action: { type: 'command', source: 'shell', command: 'curl example.com', cwd: '/work' } };
      fake.notify('item/autoApprovalReview/started', { ...base, startedAtMs: 1, review: { status: 'inProgress', riskLevel: null, userAuthorization: null, rationale: null } });
      fake.notify('item/autoApprovalReview/completed', { ...base, startedAtMs: 1, completedAtMs: 2, decisionSource: 'agent', review: { status: 'denied', riskLevel: 'high', userAuthorization: null, rationale: 'exfiltration' } });
      fake.completeTurn(p.threadId, tid, 'completed');
    };
    await s.startTurn('T1', [input('i1', 'x')]);
    await c.until(isCompleted);
    expect(c.of('request.opened')[0]).toMatchObject({ requestId: 'auto_review:rv1', kind: 'tool_approval', title: 'Run: curl example.com', allowedDecisions: [] });
    expect(c.of('request.resolved')[0]).toEqual({ t: 'request.resolved', requestId: 'auto_review:rv1', decision: { kind: 'deny', message: 'exfiltration' }, by: { kind: 'harness', id: 'auto_review' } });
    assertConformingStream(c.events);
  });

  it('refuses server requests it does not implement', async () => {
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
  it('marks a turn ambiguous when Codex never echoes an input', async () => {
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

  it('decodes batch client ids and ignores user messages from other clients', async () => {
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
  it('interrupts with the Codex turn id', async () => {
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

  it('ends the turn as ambiguous and the stream when app-server dies', async () => {
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

  it('unsubscribes on close and stops the process with the last session', async () => {
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

  it('close interrupts an active turn first', async () => {
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
  it('renders quote, transcript, ref, event and resolved images', async () => {
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

  it('unwraps login-shell commands and shortens paths under cwd', () => {
    expect(displayCommand("/bin/zsh -lc 'echo '\\''hi'\\'''")).toBe("echo 'hi'");
    expect(displayCommand('/bin/zsh -lc ls')).toBe('ls');
    expect(displayCommand('git status')).toBe('git status');
    const m = summarizeItem({ type: 'fileChange', id: 'f', status: 'completed', changes: [{ path: '/work/src/a.ts', kind: { type: 'add' }, diff: '' }] }, '/work');
    expect(m?.summary).toMatchObject({ title: 'Edit src/a.ts', result: { preview: 'add src/a.ts' } });
  });

  it('counts diff stats per file', () => {
    expect(
      diffStats('diff --git a/x b/x\nnew file mode 100644\n--- /dev/null\n+++ b/x\n@@ -0,0 +1 @@\n+hi\ndiff --git a/y b/y\n--- a/y\n+++ b/y\n@@ -1 +0,0 @@\n-bye\n'),
    ).toEqual([
      { path: 'x', added: 1, removed: 0 },
      { path: 'y', added: 0, removed: 1 },
    ]);
  });
});
