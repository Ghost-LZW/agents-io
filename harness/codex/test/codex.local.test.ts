import { describe, expect, it } from 'vitest';
import { FakeChannel, defaultChannelCaps } from '@agents-io/testkit';
import { Compositor, Hub, Ingress, Lane, MemorySessionLog, Outbox, defaultPolicy } from '@agents-io/session';
import { diffStats, summarizeItem } from '../src/index.js';
import { displayCommand } from '../src/map.js';
import { collector, input, isCompleted, open, run, setup, tick } from './codex-helpers.js';

// Local tier (decision 14): RunSpec mapping, display and helpers with no promise behind them.
// When one breaks because the behaviour changed on purpose, delete or rewrite it.

describe('open', () => {
  it('maps RunSpec and the bypass profile to thread/start; nativeId is the thread id', async () => {
    const { fake, harness } = setup();
    const s = await open(harness, { mcp: { url: 'http://127.0.0.1:9/mcp', token: 'tok' } });
    expect(s.nativeId()).toBe('thr-1');
    const p = fake.sent('thread/start')[0]!.params;
    expect(p).toMatchObject({ model: 'gpt-5.5', cwd: '/work', approvalPolicy: 'never', sandbox: 'workspace-write' });
    expect(p.config.mcp_servers.agents_io).toEqual({ url: 'http://127.0.0.1:9/mcp', http_headers: { Authorization: 'Bearer tok' }, default_tools_approval_mode: 'approve' });
  });
});

describe('turn mapping', () => {
  it('shows reasoning in the ProgressView like Claude thinking (one stream per item, parts as paragraphs)', async () => {
    const { fake, harness } = setup();
    fake.onTurnStart = (p, tid) => {
      const th = p.threadId;
      const n = (method: string, params: object) => fake.notify(method, { threadId: th, turnId: tid, ...params });
      fake.echoUser(th, tid, p.clientUserMessageId);
      n('item/started', { item: { type: 'reasoning', id: 'r1', summary: [], content: [] }, startedAtMs: 1 });
      n('item/reasoning/summaryTextDelta', { itemId: 'r1', delta: 'Plan A', summaryIndex: 0 });
      n('item/reasoning/textDelta', { itemId: 'r1', delta: 'raw duplicate', contentIndex: 0 });
      n('item/reasoning/summaryTextDelta', { itemId: 'r1', delta: 'Plan B', summaryIndex: 1 });
      n('item/completed', { item: { type: 'reasoning', id: 'r1', summary: ['Plan A', 'Plan B'], content: [] }, completedAtMs: 1 });
      const msg = { type: 'agentMessage', id: 'm1', phase: 'final_answer', memoryCitation: null, delivery: null, questions: null };
      n('item/started', { item: { ...msg, text: '' }, startedAtMs: 1 });
      n('item/completed', { item: { ...msg, text: 'Done' }, completedAtMs: 1 });
      fake.completeTurn(th, tid, 'completed');
    };
    const hub = new Hub(new MemorySessionLog());
    const policy = defaultPolicy({ owners: ['fake:alice'], run });
    const lane = new Lane({ sessionKey: 'fake:default:c1', harness, hub, policy, cwd: '/work' });
    const ingress = new Ingress({ policy, lanes: () => lane });
    const channel = new FakeChannel('fake', defaultChannelCaps);
    const compositor = new Compositor({ hub, sessionKey: 'fake:default:c1', adapter: channel, outbox: new Outbox({ hub, sleep: async () => {} }), throttleMs: 1 });
    compositor.start();
    const ac = new AbortController();
    void channel.start({ account: 'default', config: {}, signal: ac.signal, emit: ingress.emitter(), log: () => {} });
    try {
      await channel.inject({ sender: { channelUserId: 'alice', evidence: 'platform_signed' }, text: 'think' });
      for (let i = 0; i < 200 && channel.sent[0]?.finalized !== true; i++) await tick();
      const card = channel.sent[0]!;
      const fin = card.edits.at(-1) ?? card.msg;
      expect(fin.progress!.steps).toEqual([{ kind: 'reasoning', id: 'r1', text: 'Plan A\n\nPlan B', done: true }]);
      expect(fin.progress!.answer).toBe('Done');
      const delta = hub.log.read('fake:default:c1', 0).filter((e) => e.body.t === 'item.completed' && e.body.item.type === 'reasoning');
      expect(delta[0]).toMatchObject({ audience: 'commentary', visibility: 'participants' });
    } finally {
      ac.abort();
      await compositor.stop();
      await lane.close();
    }
  });
});

describe('approvals', () => {
  const cmdParams = (th: string, tid: string, extra: object = {}) => ({
    kind: 'command', threadId: th, turnId: tid, itemId: 'c1', startedAtMs: 1, environmentId: 'local',
    command: "/bin/zsh -lc 'rm -rf build'", cwd: '/work', commandActions: [], ...extra,
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
});

describe('helpers', () => {
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

describe('live (realtime voice, decision 11)', () => {
  it('is only offered when enabled, and opts the connection into the experimental API', async () => {
    const off = setup();
    expect((await open(off.harness)).live).toBeUndefined();
    expect(off.fake.sent('initialize')[0]!.params.capabilities.experimentalApi).toBe(false);
    const on = setup({ live: true });
    const s = await open(on.harness);
    expect(s.live).toBeDefined();
    const caps = on.fake.sent('initialize')[0]!.params.capabilities;
    expect(caps.experimentalApi).toBe(true);
    expect(caps.optOutNotificationMethods).not.toContain('thread/realtime/itemAdded');
    expect(caps.optOutNotificationMethods).toContain('thread/realtime/outputAudio/delta');
    expect((await open(on.harness, { options: { live: false } })).live).toBeUndefined();
  });
});
