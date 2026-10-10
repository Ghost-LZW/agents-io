import { describe, expect, it } from 'vitest';
import { mapAnswers, riskOf } from '../src/index.js';
import type { PermissionResult } from '../src/types.js';
import { bodies, collectUntil, input, isTurnCompleted, sdk, type FakeQuery } from './fake-query.js';
import { run, setup, uuidOf } from './claude-code-helpers.js';

// Local tier (decision 14): SDK option mapping and helpers with no promise behind them.
// When one breaks because the behaviour changed on purpose, delete or rewrite it.

describe('open → SDK options', () => {
  describe('per-session env (args.env)', () => {
    it('without args.env the instance configDir still applies', async () => {
      const { q } = await setup({}, {}, { configDir: '/instance/cfg' });
      expect(q.options.env?.CLAUDE_CONFIG_DIR).toBe('/instance/cfg');
    });
  });

  it('instance launch config: env over process.env, configDir, settings, sources, plugins, skills, flags, dirs, MCP', async () => {
    process.env.AGENTS_IO_TEST_INHERITED = 'from-process';
    process.env.AGENTS_IO_TEST_REMOVED = 'from-process';
    try {
      const { q } = await setup(
        { run: { ...run, profile: 'ro' }, mcp: { url: 'http://h/mcp', token: 't' } },
        { env: { PER_OPEN: '1' }, profiles: { ro: { permissionMode: 'default', additionalDirectories: ['/p', '/shared'] } } },
        {
          env: { ANTHROPIC_BASE_URL: 'http://gw', AGENTS_IO_TEST_REMOVED: undefined, CLAUDE_CONFIG_DIR: '/loses' },
          configDir: '/cfg/claude-a',
          settings: { model: 'x', permissions: { allow: ['Read'] } },
          settingSources: ['user'],
          mcpServers: { docs: { type: 'http', url: 'http://docs' } },
          plugins: ['/plugins/one'],
          skills: ['pdf'],
          extraArgs: { 'debug-to-stderr': null },
          additionalDirectories: ['/shared', '/i'],
          profiles: { ro: { permissionMode: 'dontAsk' }, other: { permissionMode: 'plan' } },
        },
      );
      const o = q.options;
      expect(o.env).toMatchObject({ AGENTS_IO_TEST_INHERITED: 'from-process', ANTHROPIC_BASE_URL: 'http://gw', CLAUDE_CONFIG_DIR: '/cfg/claude-a', PER_OPEN: '1' });
      expect(o.env).not.toHaveProperty('AGENTS_IO_TEST_REMOVED');
      expect(o.settings).toEqual({ model: 'x', permissions: { allow: ['Read'] } });
      expect(o.settingSources).toEqual(['user']);
      expect(o.plugins).toEqual([{ type: 'local', path: '/plugins/one' }]);
      expect(o.skills).toEqual(['pdf']);
      expect(o.extraArgs).toEqual({ 'debug-to-stderr': null });
      // Per-open profiles win over the instance's; directories are the union.
      expect(o.permissionMode).toBe('default');
      expect(o.additionalDirectories).toEqual(['/shared', '/i', '/p']);
      expect(o.mcpServers).toEqual({ docs: { type: 'http', url: 'http://docs' }, agents_io: { type: 'http', url: 'http://h/mcp', headers: { Authorization: 'Bearer ${AGENTS_IO_MCP_TOKEN}' }, alwaysLoad: true } });
      expect(o.env).toMatchObject({ AGENTS_IO_MCP_TOKEN: 't' });
      // Instance profiles apply when the open passes none.
      const b = await setup({ run: { ...run, profile: 'other' } }, {}, { profiles: { other: { permissionMode: 'plan' } }, settings: '/etc/s.json' });
      expect(b.q.options).toMatchObject({ permissionMode: 'plan', settings: '/etc/s.json' });
      expect(b.q.options.settingSources).toBeUndefined();
      expect(b.q.options.env).not.toHaveProperty('CLAUDE_CONFIG_DIR', '/cfg/claude-a');
      // Per-open sdk options (e.g. e2e's settingSources: []) still win.
      const c = await setup({}, { sdk: { settingSources: [] } }, { settingSources: ['user', 'project'] });
      expect(c.q.options.settingSources).toEqual([]);
    } finally {
      delete process.env.AGENTS_IO_TEST_INHERITED;
      delete process.env.AGENTS_IO_TEST_REMOVED;
    }
  });
});

describe('gateway / non-Claude models', () => {
  it('options.env is merged over process.env; model ids are never validated', async () => {
    process.env.AGENTS_IO_TEST_INHERITED = 'from-process';
    process.env.ANTHROPIC_MODEL = 'overridden-below';
    try {
      const { q, s, it } = await setup(
        { run: { ...run, model: 'gemini-3.8-flash-high' } },
        {
          env: {
            ANTHROPIC_BASE_URL: 'http://gateway.local',
            ANTHROPIC_AUTH_TOKEN: 'secret',
            ANTHROPIC_MODEL: 'gemini-3.8-flash-high',
            ANTHROPIC_SMALL_FAST_MODEL: 'gemini-3.8-flash-low',
            CLAUDE_CODE_MAX_CONTEXT_TOKENS: '1000000',
            CLAUDE_CODE_RESUME_INTERRUPTED_TURN: '1',
          },
        },
      );
      expect(q.options.model).toBe('gemini-3.8-flash-high');
      expect(q.options.env).toMatchObject({
        AGENTS_IO_TEST_INHERITED: 'from-process',
        ANTHROPIC_BASE_URL: 'http://gateway.local',
        ANTHROPIC_AUTH_TOKEN: 'secret',
        ANTHROPIC_MODEL: 'gemini-3.8-flash-high',
        ANTHROPIC_SMALL_FAST_MODEL: 'gemini-3.8-flash-low',
        CLAUDE_CODE_MAX_CONTEXT_TOKENS: '1000000',
      });
      // even an explicit request from deployment config cannot re-enable auto re-run
      expect(q.options.env).not.toHaveProperty('CLAUDE_CODE_RESUME_INTERRUPTED_TURN');
      await s.startTurn('t1', [input('a', 'x')], { ...run, model: 'gpt-7-mini' });
      expect(q.calls).toEqual([{ method: 'setModel', arg: 'gpt-7-mini' }]);
      await q.waitWritten(1);
      q.push(sdk.init(), sdk.result({ uuids: [uuidOf(q, 0)] }));
      const evs = await collectUntil(it, isTurnCompleted);
      expect(bodies(evs, 'turn.started')[0]!.run.model).toBe('gpt-7-mini');
    } finally {
      delete process.env.AGENTS_IO_TEST_INHERITED;
      delete process.env.ANTHROPIC_MODEL;
    }
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

  it('AskUserQuestion is a question; answers map to question text', async () => {
    const { s, q, it } = await inTurn();
    const questions = [
      { question: 'Which DB?', header: 'DB', options: [{ label: 'pg', description: '' }, { label: 'sqlite', description: '' }], multiSelect: false },
      { question: 'Which features?', header: 'Feat', options: [{ label: 'a', description: '' }, { label: 'b', description: '' }], multiSelect: true },
    ];
    const { p } = ask(q, 'AskUserQuestion', { questions }, { requestId: 'r5' });
    const opened = (await collectUntil(it, (e) => e.body.t === 'request.opened')).at(-1)!.body;
    expect(opened).toMatchObject({ kind: 'question', title: 'Question: Which DB?', allowedDecisions: ['answer', 'deny'], allowAlways: false });
    await s.respond('r5', { kind: 'answer', answers: { DB: 'pg', '1': ['a', 'b'] } });
    expect(await p).toEqual({ behavior: 'allow', updatedInput: { questions, answers: { 'Which DB?': 'pg', 'Which features?': 'a, b' } } });
    expect(mapAnswers({ questions }, { 'Which DB?': 'sqlite' })).toEqual({ 'Which DB?': 'sqlite' });
  });
});

describe('helpers', () => {
  it('derives risk from tool names', () => {
    expect(riskOf('Read', { file_path: 'a' })).toEqual({});
    expect(riskOf('WebFetch', { url: 'x' })).toEqual({ network: true });
    expect(riskOf('Bash', { command: 'sudo rm x' })).toEqual({ writes: true, elevated: true });
    expect(riskOf('mcp__lark__send', {})).toEqual({ network: true });
  });
});
