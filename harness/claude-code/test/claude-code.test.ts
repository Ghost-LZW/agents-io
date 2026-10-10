import { describe, expect, it } from 'vitest';
import { runHarnessEnvConformance } from '@agents-io/testkit';
import type { HarnessSession } from '@agents-io/protocol';
import { ClaudeCodeHarness, convertBlock, inputUuid, preface } from '../src/index.js';
import type { PermissionResult } from '../src/types.js';
import { bodies, collectUntil, fakeQueryFn, input, isTurnCompleted, sdk, type FakeQuery } from './fake-query.js';
import { run, setup, uuidOf } from './claude-code-helpers.js';

describe('probe', () => {
  it('reports versions and caps #HC-1', async () => {
    const h = new ClaudeCodeHarness({ sdkVersion: '0.3.291', cliVersion: async () => '2.1.291' });
    const p = await h.probe();
    expect(p.version).toBe('claude-code 2.1.291 (agent-sdk 0.3.291)');
    expect(p.caps).toMatchObject({ steer: 'tool_boundary', interrupt: true, approvals: true, questions: true, tokenDeltas: true, resume: true, switchModelMidSession: true, cancelQueued: true });
  });

  it('refuses unknown major versions #HC-1', async () => {
    await expect(new ClaudeCodeHarness({ sdkVersion: '0.4.0', cliVersion: async () => '2.1.291' }).probe()).rejects.toThrow(/unsupported Claude Agent SDK 0\.4\.0/);
    await expect(new ClaudeCodeHarness({ sdkVersion: '0.3.291', cliVersion: async () => '3.0.0' }).probe()).rejects.toThrow(/unsupported Claude Code CLI 3\.0\.0/);
  });

  it('open() refuses too #HC-1', async () => {
    const h = new ClaudeCodeHarness({ query: fakeQueryFn().fn, sdkVersion: '1.0.0', cliVersion: async () => '2.1.291' });
    await expect(h.open({ sessionKey: 's', generation: 1, cwd: '.', run })).rejects.toThrow(/unsupported/);
  });
});

describe('open → SDK options', () => {
  it('bypass profile, model verbatim, effort, mcp, env scrub, local CLI #RS-3 #SE-1', async () => {
    process.env.CLAUDE_CODE_RESUME_INTERRUPTED_TURN = '1';
    try {
      const { q, s } = await setup({ run: { ...run, model: 'claude-haiku-4-5', effort: 'low' }, mcp: { url: 'http://127.0.0.1:9/mcp', token: 'tok' } });
      const o = q.options;
      expect(o.model).toBe('claude-haiku-4-5');
      expect(o.effort).toBe('low');
      expect(o.permissionMode).toBe('bypassPermissions');
      expect(o.allowDangerouslySkipPermissions).toBe(true);
      expect(o.includePartialMessages).toBe(true);
      expect(o.cwd).toBe('/tmp/x');
      expect(o.pathToClaudeCodeExecutable).toBe('/usr/local/bin/claude');
      expect(o.mcpServers).toEqual({ agents_io: { type: 'http', url: 'http://127.0.0.1:9/mcp', headers: { Authorization: 'Bearer ${AGENTS_IO_MCP_TOKEN}' }, alwaysLoad: true } });
      expect(o.env).toMatchObject({ AGENTS_IO_MCP_TOKEN: 'tok' });
      expect(o.allowedTools).toEqual(['mcp__agents_io']);
      expect(o.env).not.toHaveProperty('CLAUDE_CODE_RESUME_INTERRUPTED_TURN');
      expect(o.canUseTool).toBeUndefined();
      expect(o.sessionId).toBe(s.nativeId());
      expect(o.resume).toBeUndefined();
    } finally {
      delete process.env.CLAUDE_CODE_RESUME_INTERRUPTED_TURN;
    }
  });

  it('host MCP token is passed through the env, never in mcpServers (the SDK puts those on the CLI argv) #SE-1', async () => {
    const { q } = await setup({ run, mcp: { url: 'http://h/mcp', token: 'sekrit-token-123' } });
    const o = q.options;
    // The SDK serialises mcpServers as `--mcp-config <json>`; the CLI expands ${VAR} from its env.
    expect(JSON.stringify(o.mcpServers)).not.toContain('sekrit-token-123');
    expect(o.mcpServers?.agents_io).toMatchObject({ headers: { Authorization: 'Bearer ${AGENTS_IO_MCP_TOKEN}' } });
    expect(o.env?.AGENTS_IO_MCP_TOKEN).toBe('sekrit-token-123');
  });

  describe('per-session env (args.env)', () => {
    it('is the top layer of the child env: over config.configDir and options.env #LA-3', async () => {
      const { q } = await setup(
        { env: { CLAUDE_CONFIG_DIR: '/session/cfg', FOO: 'session' } },
        { env: { FOO: 'open', BAR: 'open' } },
        { configDir: '/instance/cfg' },
      );
      expect(q.options.env).toMatchObject({ CLAUDE_CONFIG_DIR: '/session/cfg', FOO: 'session', BAR: 'open' });
    });

    it('never reaches argv-bound options or events (conformance) #HC-2 #SE-1', async () => {
      const fq = fakeQueryFn();
      const h = new ClaudeCodeHarness({ query: fq.fn, claudePath: '/usr/local/bin/claude', sdkVersion: '0.3.291', cliVersion: async () => '2.1.291' });
      const report = await runHarnessEnvConformance({
        adapter: h,
        open: { sessionKey: 's', generation: 1, cwd: '/tmp/x', run },
        // The SDK builds argv from every option except env; functions drop out of the JSON.
        lastSpawn: () => {
          const { env, ...rest } = fq.last().options;
          return { env: env ?? {}, argv: [JSON.stringify(rest)] };
        },
        turn: { turnId: 't1', inputs: [input('i1', 'hi')] },
        settle: async () => {
          const q = fq.last();
          await q.waitWritten(1);
          q.push(sdk.init(), sdk.text('m1', 'hello'), sdk.result({ uuids: [uuidOf(q, 0)] }));
        },
      });
      expect(report.failed).toEqual([]);
      expect(report.passed).toEqual(['env.in_child_env', 'env.not_in_argv', 'env.not_in_events']);
    });
  });

  it('non-bypass default is permissionMode default (never omitted), profiles map from options #ID-6', async () => {
    const a = await setup({ run: { ...run, profile: 'reviewer' } });
    expect(a.q.options.permissionMode).toBe('default');
    expect(a.q.options.allowDangerouslySkipPermissions).toBeUndefined();
    expect(typeof a.q.options.canUseTool).toBe('function');
    const b = await setup(
      { run: { ...run, profile: 'ro' }, resume: 'abc-session' },
      { profiles: { ro: { permissionMode: 'dontAsk', allowedTools: ['Read'], disallowedTools: ['Bash'] } }, mcpTransport: 'sse' },
    );
    expect(b.q.options).toMatchObject({ permissionMode: 'dontAsk', allowedTools: ['Read'], disallowedTools: ['Bash'], resume: 'abc-session' });
    expect(b.q.options.sessionId).toBeUndefined();
    expect(b.s.nativeId()).toBe('abc-session');
  });

  it('emits nativeId at open and again when system/init reports another id #RS-1 #HC-1', async () => {
    const { s, q, it, give, conform } = await setup({ resume: 'old' });
    const first = await collectUntil(it, (e) => e.body.t === 'session.bound');
    expect(first[0]!.body).toMatchObject({ nativeId: 'old' });
    give('t1', 'i1');
    await s.startTurn('t1', [input('i1', 'hi')]);
    q.push(sdk.init('forked-id'), sdk.result({ uuids: [uuidOf(q, 0)] }));
    const evs = await collectUntil(it, isTurnCompleted);
    expect(evs.find((e) => e.body.t === 'session.bound')?.body).toMatchObject({ nativeId: 'forked-id' });
    expect(s.nativeId()).toBe('forked-id');
    conform(evs);
  });
});

describe('input writing', () => {
  it('one SDKUserMessage per input, uuid bound to inputId, explicit priority, preface #ID-2', async () => {
    const { s, q } = await setup();
    const id = '1b4e28ba-2fa1-41d2-883f-0016d3cca427';
    await s.startTurn('t1', [input(id, 'hello', { channelContext: { chat: 'Team' } }), input('plain-id', 'second')]);
    await q.waitWritten(2);
    expect(q.written[0]!.uuid).toBe(id);
    expect(q.written[1]!.uuid).toBe(inputUuid('plain-id'));
    expect(q.written[1]!.uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(q.written.map((m) => m.priority)).toEqual(['later', 'later']);
    expect(q.written[0]!.origin).toEqual({ kind: 'human' });
    const content = q.written[0]!.message.content as { type: string; text: string }[];
    expect(content[0]!.text).toBe('[agents-io input from=owner kind=human evidence=platform_signed via=fake:a:c1 chat=Team]');
    expect(content[1]).toEqual({ type: 'text', text: 'hello' });
  });

  it('converts every content block kind #MD-1', async () => {
    const t = async (b: Parameters<typeof convertBlock>[0], r?: Parameters<typeof convertBlock>[1]) => convertBlock(b, r);
    expect((await t({ type: 'quote', text: 'a\nb' })).blocks).toEqual([{ type: 'text', text: '> a\n> b' }]);
    expect((await t({ type: 'transcript', speaker: 'Ann', text: 'hi', startMs: 61000, endMs: 63500, stable: true })).blocks[0]).toEqual({ type: 'text', text: '[Ann 01:01-01:03] hi' });
    expect((await t({ type: 'ref', uri: 'doc://x', title: 'Spec' })).blocks[0]).toEqual({ type: 'text', text: '[ref "Spec"] doc://x' });
    expect((await t({ type: 'event', name: 'card.click', data: { a: 1 } })).blocks[0]).toEqual({ type: 'text', text: '[event card.click] {"a":1}' });
    const noRes = await t({ type: 'image', ref: 'sha256:aa', mime: 'image/png' });
    expect(noRes.notices[0]).toMatch(/no resolveImage/);
    expect(noRes.blocks[0]!.type).toBe('text');
    const withRes = await t({ type: 'image', ref: 'sha256:aa', mime: 'image/png' }, async () => ({ base64: 'QUJD' }));
    expect(withRes.blocks[0]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJD' } });
    expect((await t({ type: 'file', ref: 'sha256:bb', mime: 'application/pdf', name: 'a.pdf' })).blocks[0]).toEqual({ type: 'text', text: '[file a.pdf application/pdf sha256:bb]' });
    const local = await convertBlock({ type: 'file', ref: 'sha256:bb', mime: 'application/pdf', name: 'a.pdf' }, undefined, async () => ({ path: '/blobs/bb.pdf' }));
    expect(local.blocks[0]).toEqual({ type: 'text', text: '[file a.pdf application/pdf at /blobs/bb.pdf]' });
  });

  it('skipped images surface as a notice event #MD-1', async () => {
    const { s, it } = await setup();
    await s.startTurn('t1', [input('i1', 'look', { content: [{ type: 'image', ref: 'sha256:aa', mime: 'image/png' }] })]);
    const evs = await collectUntil(it, (e) => e.body.t === 'turn.started');
    expect(bodies(evs, 'notice')[0]!.message).toMatch(/skipped/);
  });

  it('preface marks unknown senders and agents #ID-2', () => {
    const p = preface({ ...input('x', ''), origin: { kind: 'agent', principal: null, evidence: 'none', via: 'lark:a:c', adapter: 'lark', declared: 'bot-7' } });
    expect(p).toBe('[agents-io input from=unknown kind=agent evidence=none via=lark:a:c declared=bot-7]');
  });

  it('preface carries ref=channel:<channel>/<message id> only for a channel message, verbatim (never truncated) #EX-4', () => {
    const ref = 'channel:lark-bot/om_1';
    expect(preface({ ...input('x', ''), channelRef: ref, channelContext: { chat: 'Team' } })).toBe(`[agents-io input from=owner kind=human evidence=platform_signed via=fake:a:c1 ref=${ref} chat=Team]`);
    // local / host / system inputs have no channel message to point at
    expect(preface(input('x', ''))).not.toMatch(/ ref=/);
    // a long mail Message-ID stays whole; one with whitespace is quoted, still one token
    const long = `channel:mail/<${'a'.repeat(200)}@mail.example.com>`;
    expect(preface({ ...input('x', ''), channelRef: long })).toContain(` ref=${long}`);
    expect(preface({ ...input('x', ''), channelRef: 'channel:x/a b' })).toContain(' ref="channel:x/a b"');
  });

  it('labels context-only inputs as not addressed to the agent, keeping their own sender preface #ID-2', async () => {
    const { s, q } = await setup();
    const stranger = { kind: 'human' as const, principal: null, evidence: 'platform_signed' as const, via: 'lark:a:g1', adapter: 'lark' };
    const ctx = { ...input('c1', 'the launch moved to Thursday'), origin: stranger, channelContext: { senderName: 'Eve', context: true, watch: 'wg' } };
    await s.startTurn('t1', [ctx, input('i1', 'what did they say?')]);
    await q.waitWritten(2);
    const first = q.written[0]!.message.content as { type: string; text: string }[];
    expect(first[0]!.text).toBe(
      '[agents-io context, not addressed to you: recorded in the conversation; read it, do not reply to it unless the addressed input asks]\n' +
        '[agents-io input from=unknown kind=human evidence=platform_signed via=lark:a:g1 senderName=Eve context=true watch=wg]',
    );
    expect(first[1]).toEqual({ type: 'text', text: 'the launch moved to Thursday' });
    const second = q.written[1]!.message.content as { type: string; text: string }[];
    expect(second[0]!.text).toBe('[agents-io input from=owner kind=human evidence=platform_signed via=fake:a:c1]');
  });

  it('a watched input reaches the model with the watch= marker in its sender preface #ID-2', async () => {
    const { s, q } = await setup();
    // What Watches.deliverWatch hands the lane for a trigger watch (packages/session/src/watch.ts).
    const watched = input('w1', 'ship it?', { channelContext: { watch: 'wg', watchMode: 'trigger', watchSource: 'lark:a:g1' } });
    await s.startTurn('t1', [watched]);
    await q.waitWritten(1);
    const first = q.written[0]!.message.content as { type: string; text: string }[];
    expect(first[0]!.text).toMatch(/^\[agents-io input .* watch=wg( |\])/);
  });

  it('the sender preface names the origin evidence #ID-2', () => {
    expect(preface(input('x', ''))).toContain(' evidence=platform_signed ');
    expect(preface({ ...input('x', ''), origin: { kind: 'agent', principal: { id: 'agent:reviewer', labels: ['agent'] }, evidence: 'daemon', via: 'agent:reviewer:reviewer:main', adapter: 'agent' } })).toContain(' evidence=daemon ');
  });

  it('an agent message shows hop=N only (chain and turn ids stay out); a loop-guarded one shows loopGuard= #ID-2', () => {
    const agent = { kind: 'agent' as const, principal: { id: 'agent:reviewer', labels: ['agent'] }, evidence: 'daemon' as const, via: 'agent:reviewer:reviewer:main', adapter: 'agent' };
    const cause = { peer: 'reviewer/reviewer:main', basis: 'internal' as const, hop: 3, chain: 'in_root', from: { sessionKey: 'reviewer:main', turnId: 'turn_9' }, rootPrincipal: 'lark:ou_owner' };
    const p = preface({ ...input('x', ''), origin: agent, cause, channelContext: {} });
    expect(p).toBe('[agents-io input from=agent:reviewer kind=agent evidence=daemon via=agent:reviewer:reviewer:main hop=3]');
    expect(p).not.toMatch(/in_root|turn_9|lark:ou_owner/);
    // A broken chain (outside agent) has no hop; a human input none either.
    expect(preface({ ...input('x', ''), origin: { ...agent, evidence: 'platform_signed' }, cause: { peer: 'lark:ou_x', basis: 'none' } })).not.toMatch(/ hop=/);
    expect(preface(input('x', ''))).not.toMatch(/ hop=/);
    expect(preface({ ...input('x', ''), origin: agent, cause, channelContext: { context: true, loopGuard: 'pair' } })).toMatch(/ hop=3 .*loopGuard=pair\]$/);
  });

  it('startTurn only when idle #HC-1', async () => {
    const { s } = await setup();
    await s.startTurn('t1', [input('i1', 'a')]);
    await expect(s.startTurn('t2', [input('i2', 'b')])).rejects.toThrow(/session layer owns the queue/);
  });
});

describe('event mapping', () => {
  it('maps a full turn and conforms #HC-1', async () => {
    const { s, q, it, give, conform } = await setup();
    give('t1', 'i1');
    await s.startTurn('t1', [input('i1', 'do it')]);
    await q.waitWritten(1);
    q.push(
      sdk.init(),
      sdk.thinkingDelta('hmm'),
      sdk.textDelta('Look'),
      sdk.text('m1', 'Looking.'),
      sdk.toolUse('tu1', 'Bash', { command: 'ls -la /tmp' }),
      sdk.toolProgress('tu1', 1.5),
      sdk.toolResult('tu1', 'x'.repeat(1000)),
      sdk.toolUse('ag1', 'Agent', { description: 'scan repo', prompt: 'go' }),
      sdk.system('task_started', { task_id: 'k1', tool_use_id: 'ag1', description: 'scan repo' }),
      sdk.toolUse('sub1', 'Read', { file_path: '/a.ts' }, 'ag1'),
      sdk.textDelta('sub', 'ag1'),
      sdk.toolResult('sub1', [{ type: 'text', text: 'file' }], false, 'ag1'),
      sdk.system('task_progress', { task_id: 'k1', tool_use_id: 'ag1', description: 'scan repo', usage: { total_tokens: 1, tool_uses: 1, duration_ms: 900 }, last_tool_name: 'Read' }),
      sdk.toolResult('ag1', 'report'),
      sdk.toolUse('td', 'TodoWrite', { todos: [{ content: 'a', status: 'completed', activeForm: 'A' }, { content: 'b', status: 'in_progress', activeForm: 'B' }] }),
      sdk.toolResult('td', 'ok'),
      sdk.system('compact_boundary', { compact_metadata: { trigger: 'auto', pre_tokens: 1000, post_tokens: 100 } }),
      sdk.system('api_retry', { attempt: 1, max_retries: 3, retry_delay_ms: 2000, error_status: 529, error: 'overloaded' }),
      { type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning', rateLimitType: 'five_hour' }, uuid: 'u', session_id: 'sess-1' },
      { type: 'tool_use_summary', summary: 'Listed files', preceding_tool_use_ids: ['tu1'], uuid: 'u2', session_id: 'sess-1' },
      sdk.system('hook_started', { hook_id: 'h' }),
      sdk.text('m2', 'Done.'),
      sdk.result({ uuids: [uuidOf(q, 0)], result: 'Done.' }),
    );
    const evs = await collectUntil(it, isTurnCompleted);
    conform(evs);

    const deltas = bodies(evs, 'text.delta');
    expect(deltas).toContainEqual({ t: 'text.delta', delta: 'hmm', stream: 'reasoning' });
    expect(deltas).toContainEqual({ t: 'text.delta', delta: 'Look', stream: 'answer' });
    expect(evs.find((e) => e.body.t === 'text.delta' && e.body.delta === 'sub')?.parentItemId).toBe('ag1');
    expect(evs.filter((e) => e.body.t === 'text.delta').every((e) => e.durability === 'ephemeral')).toBe(true);

    const started = bodies(evs, 'item.started').map((b) => b.item);
    expect(started.find((i) => i.itemId === 'tu1')).toMatchObject({ type: 'command', title: 'Bash: ls -la /tmp', status: 'running' });
    expect(started.find((i) => i.itemId === 'ag1')).toMatchObject({ type: 'subagent', title: 'Agent: scan repo' });
    expect(evs.find((e) => e.body.t === 'item.started' && e.body.item.itemId === 'sub1')?.parentItemId).toBe('ag1');

    const done = bodies(evs, 'item.completed').map((b) => b.item);
    const bash = done.find((i) => i.itemId === 'tu1')!;
    expect(bash.status).toBe('completed');
    expect(bash.result).toMatchObject({ truncated: true, isError: false });
    expect(bash.result!.preview.length).toBe(400);

    const prog = evs.filter((e) => e.body.t === 'item.progress');
    expect(prog.map((e) => e.body)).toContainEqual({ t: 'item.progress', itemId: 'tu1', elapsedMs: 1500 });
    expect(prog.map((e) => e.body)).toContainEqual({ t: 'item.progress', itemId: 'ag1', text: 'scan repo · Read', elapsedMs: 900 });
    expect(prog.every((e) => e.durability === 'ephemeral')).toBe(true);

    expect(bodies(evs, 'plan.updated')[0]!.steps).toEqual([{ text: 'a', status: 'completed' }, { text: 'b', status: 'in_progress' }]);
    expect(bodies(evs, 'notice').map((n) => n.code)).toEqual(['compacting', 'api_retry', 'rate_limited']);
    expect(bodies(evs, 'headline')[0]!.text).toBe('Listed files');
    expect(bodies(evs, 'native').map((n) => n.name)).toEqual(expect.arrayContaining(['system/init', 'system/hook_started']));
    expect(evs.find((e) => e.body.t === 'native' && e.body.name === 'system/hook_started')?.native).toMatchObject({ hook_id: 'h' });

    const snaps = bodies(evs, 'text.snapshot');
    expect(snaps.at(-1)).toEqual({ t: 'text.snapshot', text: 'Done.', final: true });
    expect(snaps[0]).toEqual({ t: 'text.snapshot', text: 'Looking.', final: false });
    expect(bodies(evs, 'input.consumed')).toEqual([{ t: 'input.consumed', inputIds: ['i1'], turnId: 't1' }]);
    expect(bodies(evs, 'usage')[0]!.usage).toMatchObject({ totalCostUsd: 0.001 });
    expect(bodies(evs, 'turn.completed')[0]).toMatchObject({ turnId: 't1', status: 'completed' });
    expect(evs.filter((e) => e.turnId === 't1').length).toBeGreaterThan(20);
  });

  it('error results fail the turn; is_error success too #HC-1', async () => {
    const { s, q, it, give, conform } = await setup();
    give('t1', 'i1');
    await s.startTurn('t1', [input('i1', 'x')]);
    q.push(sdk.result({ uuids: [uuidOf(q, 0)], subtype: 'error_max_turns', errors: ['too many turns'] }));
    let evs = await collectUntil(it, isTurnCompleted);
    expect(bodies(evs, 'turn.completed')[0]).toMatchObject({ status: 'failed', error: { code: 'error_max_turns', message: 'too many turns' } });
    give('t2', 'i2');
    await s.startTurn('t2', [input('i2', 'y')]);
    await q.waitWritten(2);
    q.push(sdk.result({ uuids: [uuidOf(q, 1)], is_error: true, result: 'API Error: 529', terminal_reason: 'api_error' }));
    evs = [...evs, ...(await collectUntil(it, isTurnCompleted))];
    expect(bodies(evs, 'turn.completed')[1]).toMatchObject({ status: 'failed', error: { code: 'api_error' } });
    conform(evs);
  });

  it('the CLI dying mid-turn ends it ambiguous #IN-1 #HC-1', async () => {
    const { s, q, it, give, conform } = await setup();
    give('t1', 'i1');
    await s.startTurn('t1', [input('i1', 'x')]);
    q.push(sdk.init(), sdk.toolUse('tu', 'Bash', { command: 'sleep 9' }));
    q.crash();
    const evs = await collectUntil(it, () => false);
    expect(bodies(evs, 'turn.completed')[0]).toMatchObject({ status: 'ambiguous', error: { code: 'harness_exited' } });
    conform(evs);
    await expect(s.startTurn('t2', [input('i2', 'y')])).rejects.toThrow(/closed/);
  });
});

describe('consumed reconciliation', () => {
  it('a CLI batch of several inputs → one turn, one input.consumed #IN-1 #HC-1', async () => {
    const { s, q, it, give, conform } = await setup();
    give('t1', 'a', 'b');
    await s.startTurn('t1', [input('a', '1'), input('b', '2')]);
    await q.waitWritten(2);
    q.push(sdk.init(), sdk.text('m', 'ok'), sdk.result({ uuids: [uuidOf(q, 0), uuidOf(q, 1)], result: 'ok' }));
    const evs = await collectUntil(it, isTurnCompleted);
    expect(bodies(evs, 'input.consumed')).toEqual([{ t: 'input.consumed', inputIds: ['a', 'b'], turnId: 't1' }]);
    conform(evs);
  });

  it('CLI splits our inputs over two native turns → still one canonical turn #IN-1 #HC-1', async () => {
    const { s, q, it, give, conform } = await setup();
    give('t1', 'a', 'b');
    await s.startTurn('t1', [input('a', '1'), input('b', '2')]);
    await q.waitWritten(2);
    q.push(sdk.init(), sdk.text('m1', 'first'), sdk.result({ uuids: [uuidOf(q, 0)], result: 'first', queued_turn_count: 1 }));
    q.push(sdk.init(), sdk.text('m2', 'second'), sdk.result({ uuids: [uuidOf(q, 1)], result: 'second' }));
    const evs = await collectUntil(it, isTurnCompleted);
    expect(bodies(evs, 'input.consumed').map((b) => b.inputIds)).toEqual([['a'], ['b']]);
    expect(bodies(evs, 'turn.completed')).toHaveLength(1);
    expect(bodies(evs, 'text.snapshot').filter((x) => x.final)).toEqual([{ t: 'text.snapshot', text: 'second', final: true }]);
    conform(evs);
  });

  it('ignores uuids the CLI enqueued itself #IN-4 #HC-1', async () => {
    const { s, q, it, give, conform } = await setup();
    give('t1', 'a');
    await s.startTurn('t1', [input('a', '1')]);
    await q.waitWritten(1);
    q.push(sdk.result({ uuids: ['99999999-9999-4999-8999-999999999999', uuidOf(q, 0)] }));
    const evs = await collectUntil(it, isTurnCompleted);
    expect(bodies(evs, 'input.consumed')).toEqual([{ t: 'input.consumed', inputIds: ['a'], turnId: 't1' }]);
    conform(evs);
  });
});

describe('steer', () => {
  it('writes priority next and reconciles the fold-in #IN-1 #HC-1', async () => {
    const { s, q, it, give, conform } = await setup();
    give('t1', 'a');
    await s.startTurn('t1', [input('a', 'start')]);
    q.push(sdk.init(), sdk.toolUse('tu', 'Bash', { command: 'make' }));
    await collectUntil(it, (e) => e.body.t === 'item.started');
    give('t1', 'b');
    expect(await s.steer([input('b', 'also this')], 't1')).toBe('steered');
    await q.waitWritten(2);
    expect(q.written[1]!.priority).toBe('next');
    q.push(sdk.toolResult('tu', 'ok'), sdk.result({ uuids: [uuidOf(q, 0), uuidOf(q, 1)] }));
    const evs = await collectUntil(it, isTurnCompleted);
    expect(bodies(evs, 'input.consumed')).toEqual([{ t: 'input.consumed', inputIds: ['a', 'b'], turnId: 't1' }]);
    conform(evs);
  });

  it('a steer that missed the fold runs as the CLI next turn but is reported in the same turn #IN-1 #HC-1', async () => {
    const { s, q, it, give, conform } = await setup();
    give('t1', 'a', 'b');
    await s.startTurn('t1', [input('a', 'start')]);
    q.push(sdk.init());
    await collectUntil(it, (e) => e.body.t === 'native' && e.body.name === 'system/init');
    expect(await s.steer([input('b', 'late')], 't1')).toBe('steered');
    await q.waitWritten(2);
    // The CLI finished before reading b (queued_turn_count 0 at that instant), then ran b as a new turn.
    q.push(sdk.result({ uuids: [uuidOf(q, 0)], queued_turn_count: 0 }));
    q.push(sdk.init(), sdk.text('m2', 'got late'), sdk.result({ uuids: [uuidOf(q, 1)], result: 'got late' }));
    const evs = await collectUntil(it, isTurnCompleted);
    expect(bodies(evs, 'input.consumed').map((b) => b.inputIds)).toEqual([['a'], ['b']]);
    expect(bodies(evs, 'turn.completed')).toEqual([expect.objectContaining({ turnId: 't1', status: 'completed' })]);
    conform(evs);
  });

  it('reports no_active_turn / stale / not_steerable #HC-1', async () => {
    const { s } = await setup();
    expect(await s.steer([input('x', 'x')], 't1')).toBe('no_active_turn');
    await s.startTurn('t1', [input('a', 'a')]);
    expect(await s.steer([input('x', 'x')], 't0')).toBe('stale');
    void s.interrupt('t1');
    expect(await s.steer([input('x', 'x')], 't1')).toBe('not_steerable');
  });
});

describe('approvals', () => {
  type Opts = Parameters<NonNullable<FakeQuery['options']['canUseTool']>>[2];
  const ask = (q: FakeQuery, tool: string, toolInput: Record<string, unknown>, o: Partial<Opts> & { requestId: string }) => {
    const ctl = new AbortController();
    const p = q.options.canUseTool!(tool, toolInput, { signal: ctl.signal, toolUseID: `tu-${o.requestId}`, ...o } as Opts);
    return { p: p as Promise<PermissionResult>, ctl };
  };

  async function inTurn() {
    const ctx = await setup({ run: { ...run, profile: 'ask' } });
    ctx.give('t1', 'a');
    await ctx.s.startTurn('t1', [input('a', 'go')]);
    return ctx;
  }

  it('tool approval: allow_session returns the suggestions as updatedPermissions #RQ-1', async () => {
    const { s, q, it } = await inTurn();
    const suggestions = [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'git push:*' }], behavior: 'allow', destination: 'session' }];
    const { p } = ask(q, 'Bash', { command: 'git push origin main' }, { requestId: 'r1', suggestions: suggestions as never, decisionReason: '\u001b[1mask rule\u001b[0m' });
    const [opened] = (await collectUntil(it, (e) => e.body.t === 'request.opened')).slice(-1);
    expect(opened!.body).toMatchObject({
      t: 'request.opened',
      requestId: 'r1',
      kind: 'tool_approval',
      title: 'Bash: git push origin main',
      risk: { writes: true, network: true },
      allowedDecisions: ['allow_once', 'allow_session', 'deny'],
      allowAlways: true,
      defaultDeny: false,
    });
    expect(opened!.itemId).toBe('tu-r1');
    expect((opened!.native as { decisionReason: string }).decisionReason).toBe('ask rule');
    await s.respond('r1', { kind: 'allow_session' });
    expect(await p).toEqual({ behavior: 'allow', updatedInput: { command: 'git push origin main' }, updatedPermissions: suggestions });
    const [resolved] = await collectUntil(it, (e) => e.body.t === 'request.resolved').then((x) => x.slice(-1));
    expect(resolved!.body).toMatchObject({ requestId: 'r1', decision: { kind: 'allow_session' } });
  });

  it('suppressAlwaysAllowRule / defaultToNo are carried; allow_session degrades to once #RQ-1', async () => {
    const { s, q, it } = await inTurn();
    const { p } = ask(q, 'Write', { file_path: '/etc/x' }, { requestId: 'r2', suggestions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }], suppressAlwaysAllowRule: true, defaultToNo: true, blockedPath: '/etc/x' });
    const opened = (await collectUntil(it, (e) => e.body.t === 'request.opened')).at(-1)!.body;
    expect(opened).toMatchObject({ kind: 'file_change', allowAlways: false, defaultDeny: true, allowedDecisions: ['allow_once', 'deny'], risk: { writes: true, elevated: true } });
    await s.respond('r2', { kind: 'allow_session' });
    expect(await p).toEqual({ behavior: 'allow', updatedInput: { file_path: '/etc/x' } });
  });

  it('deny carries message and interrupt; second respond is a no-op #RQ-1', async () => {
    const { s, q } = await inTurn();
    const { p } = ask(q, 'Bash', { command: 'rm -rf /' }, { requestId: 'r3' });
    await s.respond('r3', { kind: 'deny', message: 'nope', interruptTurn: true });
    await s.respond('r3', { kind: 'allow_once' });
    expect(await p).toEqual({ behavior: 'deny', message: 'nope', interrupt: true });
  });

  it('a denied tool completes as declined #RQ-1', async () => {
    const { s, q, it, conform } = await inTurn();
    q.push(sdk.toolUse('tu-r4', 'Bash', { command: 'rm x' }));
    const { p } = ask(q, 'Bash', { command: 'rm x' }, { requestId: 'r4' });
    await collectUntil(it, (e) => e.body.t === 'request.opened');
    await s.respond('r4', { kind: 'deny' });
    await p;
    q.push(sdk.toolResult('tu-r4', 'denied', true), sdk.result({ uuids: [uuidOf(q, 0)] }));
    const evs = await collectUntil(it, isTurnCompleted);
    expect(bodies(evs, 'item.completed')[0]!.item.status).toBe('declined');
  });

  it('redelivered request ids open one prompt; abort → runtime_cancelled #RQ-1 #RQ-2', async () => {
    const { q, it, conform, s } = await inTurn();
    const a = ask(q, 'Bash', { command: 'ls' }, { requestId: 'r6' });
    const b = ask(q, 'Bash', { command: 'ls' }, { requestId: 'r6' });
    expect(b.p).toBe(a.p);
    a.ctl.abort();
    expect((await a.p).behavior).toBe('deny');
    q.push(sdk.result({ uuids: [uuidOf(q, 0)] }));
    const evs = await collectUntil(it, isTurnCompleted);
    expect(bodies(evs, 'request.opened')).toHaveLength(1);
    expect(bodies(evs, 'request.resolved')).toEqual([{ t: 'request.resolved', requestId: 'r6', decision: null, by: 'runtime_cancelled' }]);
    conform(evs);
    await s.respond('r6', { kind: 'allow_once' }); // late answer is ignored
  });

  it('native decisions pass through verbatim #RQ-1', async () => {
    const { s, q } = await inTurn();
    const { p } = ask(q, 'Bash', { command: 'ls' }, { requestId: 'r7' });
    await s.respond('r7', { kind: 'native', payload: { behavior: 'allow', updatedInput: { command: 'ls -1' } } });
    expect(await p).toEqual({ behavior: 'allow', updatedInput: { command: 'ls -1' } });
  });
});

describe('interrupt', () => {
  it('calls query.interrupt, withdraws still-queued inputs, ends interrupted #IN-1 #HC-1', async () => {
    const { s, q, it, give, conform } = await setup();
    give('t1', 'a', 'b');
    await s.startTurn('t1', [input('a', 'long job')]);
    q.push(sdk.init(), sdk.toolUse('tu', 'Bash', { command: 'sleep 100' }));
    await collectUntil(it, (e) => e.body.t === 'item.started');
    await s.steer([input('b', 'more')], 't1');
    await q.waitWritten(2);
    q.cliQueue.add(uuidOf(q, 1)); // the CLI has not folded b in yet
    await s.interrupt('t1');
    expect(q.calls.map((c) => c.method)).toEqual(['interrupt', 'cancelAsyncMessage']);
    q.push(sdk.result({ uuids: [uuidOf(q, 0)], subtype: 'error_during_execution', terminal_reason: 'aborted_tools' }));
    const evs = await collectUntil(it, isTurnCompleted);
    expect(bodies(evs, 'input.cancelled')).toEqual([{ t: 'input.cancelled', inputIds: ['b'], reason: 'interrupted' }]);
    expect(bodies(evs, 'turn.completed')[0]).toMatchObject({ status: 'interrupted' });
    conform(evs);
  });

  it('interrupt before the CLI picked up the input ends the turn without a result #IN-1 #HC-1', async () => {
    const { s, q, it, give, conform } = await setup();
    give('t1', 'a');
    await s.startTurn('t1', [input('a', 'x')]);
    await q.waitWritten(1);
    q.cliQueue.add(uuidOf(q, 0));
    await s.interrupt('t1');
    const evs = await collectUntil(it, isTurnCompleted);
    expect(bodies(evs, 'turn.completed')[0]).toMatchObject({ status: 'interrupted' });
    conform(evs);
  });

  it('interrupt for another turn id is ignored; cancelQueued withdraws a pending steer #IN-1 #HC-1', async () => {
    const { s, q, it, give, conform } = await setup();
    give('t1', 'a', 'b');
    await s.startTurn('t1', [input('a', 'x')]);
    q.push(sdk.init());
    await s.interrupt('t0');
    expect(q.calls).toEqual([]);
    await s.steer([input('b', 'y')], 't1');
    await q.waitWritten(2);
    q.cliQueue.add(uuidOf(q, 1));
    await s.cancelQueued!(['b']);
    q.push(sdk.result({ uuids: [uuidOf(q, 0)] }));
    const evs = await collectUntil(it, isTurnCompleted);
    expect(bodies(evs, 'input.cancelled')[0]).toMatchObject({ inputIds: ['b'] });
    expect(bodies(evs, 'turn.completed')[0]).toMatchObject({ status: 'completed' });
    conform(evs);
  });
});

describe('run changes and close', () => {
  it('switches model and effort mid-session, refuses tool-permission changes #ID-6', async () => {
    const { s, q, it } = await setup({}, { profiles: { bypass: { permissionMode: 'bypassPermissions' }, narrow: { permissionMode: 'bypassPermissions', allowedTools: ['Read'] } } });
    await s.startTurn('t1', [input('a', 'x')], { ...run, model: 'sonnet', effort: 'high' });
    expect(q.calls).toEqual([{ method: 'setModel', arg: 'sonnet' }, { method: 'applyFlagSettings', arg: { effortLevel: 'high' } }]);
    await q.waitWritten(1);
    q.push(sdk.result({ uuids: [uuidOf(q, 0)] }));
    await collectUntil(it, isTurnCompleted);
    await expect(s.startTurn('t2', [input('b', 'y')], { ...run, profile: 'narrow' })).rejects.toThrow(/reopen the session/);
    // the failed start released the turn
    await s.startTurn('t3', [input('c', 'z')], { ...run, model: 'sonnet', effort: 'high' });
  });

  it('close ends the prompt stream, closes the query and the event stream #HC-1', async () => {
    const { s, q, it } = await setup();
    await s.close('bye');
    expect(q.promptEnded).toBe(true);
    expect(q.calls.map((c) => c.method)).toContain('close');
    const rest = await collectUntil(it, () => false);
    expect(rest.some((e) => e.body.t === 'notice')).toBe(false);
  });

  it('close mid-turn interrupts and ends the turn #RS-3 #IN-1', async () => {
    const { s, q, it, give, conform } = await setup();
    give('t1', 'a');
    await s.startTurn('t1', [input('a', 'x')]);
    q.push(sdk.init(), sdk.toolUse('tu', 'Bash', { command: 'sleep 100' }));
    const closing = s.close('shutdown');
    await new Promise((r) => setTimeout(r, 10));
    expect(q.calls[0]!.method).toBe('interrupt');
    q.push(sdk.result({ uuids: [uuidOf(q, 0)], subtype: 'error_during_execution', terminal_reason: 'aborted_tools' }));
    await closing;
    const evs = await collectUntil(it, () => false);
    expect(bodies(evs, 'turn.completed')[0]).toMatchObject({ status: 'interrupted' });
    conform(evs);
  });
});

export type { HarnessSession };
