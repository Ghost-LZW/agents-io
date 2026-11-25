import { describe, expect, it, afterEach } from 'vitest';
import type { BlobAccess, HarnessResolveContext } from '@agents-io/protocol';
import {
  AcpSession,
  acpHarnessModule,
  claudeFlavor,
  diffFiles,
  elicitationContent,
  flavorFor,
  genericFlavor,
  inputSummary,
  itemTypeOf,
  mcpToolOfName,
  permissionDecisions,
  permissionOutcome,
  renderPrompt,
  turnOutcome,
  withDefaults,
  type AcpLink,
} from '../src/index.js';
import { completed, disposeAll, events, fake, input, openArgs, run } from './acp-helpers.js';

afterEach(disposeAll);

const opts = (...kinds: ('allow_once' | 'allow_always' | 'reject_once' | 'reject_always')[]) => kinds.map((kind) => ({ optionId: kind, name: kind, kind }));

describe('ACP mapping', () => {
  it('a decision picks an option the agent offered, never a wider one', () => {
    const all = opts('allow_once', 'allow_always', 'reject_once', 'reject_always');
    expect(permissionOutcome(all, { kind: 'allow_once' })).toEqual({ outcome: 'selected', optionId: 'allow_once' });
    expect(permissionOutcome(all, { kind: 'allow_session' })).toEqual({ outcome: 'selected', optionId: 'allow_always' });
    expect(permissionOutcome(opts('allow_once', 'reject_once'), { kind: 'allow_session' })).toEqual({ outcome: 'selected', optionId: 'allow_once' });
    expect(() => permissionOutcome(opts('allow_always', 'reject_once'), { kind: 'allow_once' })).toThrow(/no one-time allow/);
    expect(permissionOutcome(opts('allow_once', 'reject_always'), { kind: 'deny' })).toEqual({ outcome: 'selected', optionId: 'reject_always' });
    expect(permissionOutcome(opts('allow_once'), { kind: 'deny' })).toEqual({ outcome: 'cancelled' });
    expect(permissionOutcome(all, { kind: 'native', payload: { optionId: 'reject_always' } })).toEqual({ outcome: 'selected', optionId: 'reject_always' });
    expect(permissionOutcome(all, { kind: 'native', payload: { outcome: 'cancelled' } })).toEqual({ outcome: 'cancelled' });
    expect(() => permissionOutcome(all, { kind: 'native', payload: { optionId: 'nope' } })).toThrow(/names no option/);
    expect(() => permissionOutcome(all, { kind: 'answer', answers: {} })).toThrow(/no decision for a permission/);
    expect(permissionDecisions(opts('allow_always', 'reject_once'))).toEqual(['allow_session', 'deny', 'native']);
    expect(permissionDecisions(opts('allow_once'))).toEqual(['allow_once', 'allow_session', 'deny', 'native']);
  });

  it("an elicitation's answers in their schema's types; a choice's label back to its const", () => {
    const props = {
      colour: { type: 'string', oneOf: [{ const: 'r', title: 'Red' }, { const: 'g', title: 'Green' }] },
      count: { type: 'integer' },
      ratio: { type: 'number' },
      sure: { type: 'boolean' },
      tags: { type: 'array', items: { anyOf: [{ const: 'a', title: 'Alpha' }] } },
      free: { type: 'string' },
    };
    expect(elicitationContent(props, { colour: 'Green', count: '3.7', ratio: '0.5', sure: 'yes', tags: ['Alpha', 'b'], free: 'x', unknown: 'y' })).toEqual({ colour: 'g', count: 3, ratio: 0.5, sure: true, tags: ['a', 'b'], free: 'x' });
    expect(elicitationContent(props, { count: 'many', sure: 'no' })).toEqual({ sure: false });
    expect(genericFlavor.elicitationQuestions!({ message: 'm', requestedSchema: { properties: { colour: { type: 'string', title: 'Colour', description: 'Pick one', enum: ['red'] }, tags: { type: 'array', items: { enum: ['x'] } } } } })).toEqual([
      { id: 'colour', text: 'Colour', header: 'Pick one', options: [{ label: 'red' }] },
      { id: 'tags', text: 'tags', options: [{ label: 'x' }], multiSelect: true },
    ]);
  });

  it('stop reasons, tool kinds, inputs and diffs', () => {
    expect(turnOutcome('end_turn')).toEqual({ status: 'completed' });
    expect(turnOutcome('cancelled')).toEqual({ status: 'interrupted' });
    expect(turnOutcome('refusal')).toMatchObject({ status: 'failed', error: { code: 'refusal' } });
    expect(turnOutcome('max_tokens')).toMatchObject({ status: 'failed', error: { code: 'max_tokens' } });
    expect(turnOutcome('something_new')).toMatchObject({ status: 'ambiguous', error: { code: 'unknown_stop_reason' } });
    expect(turnOutcome(undefined)).toMatchObject({ status: 'ambiguous', error: { code: 'unknown_stop_reason', message: 'the agent answered the prompt with no stop reason' } });
    expect(itemTypeOf({ toolCallId: 'x', kind: 'execute' }, undefined, false)).toBe('command');
    expect(itemTypeOf({ toolCallId: 'x', kind: 'move' }, undefined, false)).toBe('file_change');
    expect(itemTypeOf({ toolCallId: 'x', kind: 'fetch' }, undefined, false)).toBe('web_search');
    expect(itemTypeOf({ toolCallId: 'x', kind: 'read' }, undefined, true)).toBe('subagent');
    expect(itemTypeOf({ toolCallId: 'x' }, { server: 's', name: 'n' }, false)).toBe('mcp_tool');
    expect(inputSummary({ command: ['git', 'status'] })).toBe('git status');
    expect(inputSummary({}, [{ path: '/a/b' }])).toBe('/a/b');
    expect(inputSummary({ other: 1 })).toBe('{"other":1}');
    expect(diffFiles([{ type: 'diff', path: '/a', oldText: 'x\ny', newText: 'x\nz\nw' }])).toEqual([{ path: '/a', added: 2, removed: 1 }]);
    expect(mcpToolOfName('mcp__agents-io__send_message')).toEqual({ server: 'agents-io', name: 'send_message' });
    expect(mcpToolOfName('mcp__my_srv__a__b')).toEqual({ server: 'my_srv', name: 'a__b' });
    expect(mcpToolOfName('Bash')).toBeUndefined();
  });

  it('a prompt: preface and text per input; a harness command alone as it is; images inline when the agent takes them, files as links, missing ones as a note', async () => {
    const blobs: BlobAccess = {
      stat: async (ref) => (ref === 'b1' ? { path: '/blobs/b1', mime: 'image/png', size: 3 } : ref === 'f1' ? { path: '/blobs/f1', mime: 'text/plain', size: 5, name: 'notes.txt' } : undefined),
      get: async () => ({ bytes: new Uint8Array([1, 2, 3]), mime: 'image/png' }),
    };
    const media = input('i1', 'see', { content: [{ type: 'text', text: 'see' }, { type: 'image', ref: 'b1', mime: 'image/png' }, { type: 'file', ref: 'f1', mime: 'text/plain', name: 'notes.txt' }, { type: 'image', ref: 'lark-img:x', mime: 'image/png' }] });
    expect(await renderPrompt([media], { blobs, support: { image: true } })).toEqual([
      { type: 'text', text: '[sender from=owner kind=human evidence=platform_signed via=test:default:c1]\nsee' },
      { type: 'image', data: 'AQID', mimeType: 'image/png' },
      { type: 'resource_link', uri: 'file:///blobs/f1', name: 'notes.txt', mimeType: 'text/plain', size: 5 },
      { type: 'text', text: '[image lark-img:x (image/png) not available]' },
    ]);
    // An agent without image support gets the image as a link to its file.
    expect((await renderPrompt([media], { blobs, support: {} }))[1]).toEqual({ type: 'resource_link', uri: 'file:///blobs/b1', name: 'b1', mimeType: 'image/png', size: 3 });
    expect(await renderPrompt([input('c', '/compact', { channelContext: { nativeCommand: true } })])).toEqual([{ type: 'text', text: '/compact' }]);
    expect((await renderPrompt([input('x', 'aside', { channelContext: { context: true } })]))[0]!.type === 'text' && (await renderPrompt([input('x', 'aside', { channelContext: { context: true } })]))[0]).toMatchObject({ text: expect.stringMatching(/^\[context, not addressed to you/) });
  });

  it('flavors: picked by the agent that names itself; hooks over the generic ones', () => {
    expect(flavorFor({ name: '@agentclientprotocol/claude-agent-acp' }).name).toBe('claude');
    expect(flavorFor({ name: 'gemini-cli' }).name).toBe('generic');
    expect(flavorFor(undefined).name).toBe('generic');
    const c = withDefaults(claudeFlavor);
    expect(c.subagent({ toolCallId: 'x', name: 'Task' })).toBe(true);
    expect(c.planMode).toBe('plan');
    expect(c.compactCommand([{ name: 'compact' }])).toBe('/compact');
    expect(withDefaults(genericFlavor).compactCommand([{ name: 'init' }])).toBeUndefined();
    expect(c.restrictedMode([{ id: 'auto' }, { id: 'default', name: 'Manual' }])).toBe('default');
    expect(withDefaults(genericFlavor).restrictedMode([{ id: 'auto' }, { id: 'yolo' }])).toBeUndefined();
    expect(c.compaction({ toolCallId: 'x', title: 'Compact conversation', kind: 'think', meta: { claudeCode: { toolName: 'compact' } } })).toBe(true);
    expect(c.compaction({ toolCallId: 'x', title: 'Run ls', meta: { claudeCode: { toolName: 'Bash' } } })).toBe(false);
    expect(withDefaults(genericFlavor).compaction({ toolCallId: 'x', meta: { claudeCode: { toolName: 'compact' } } })).toBe(false);
  });
});

describe('the acp harness kind', () => {
  const ctx = (fails: string[] = []): HarnessResolveContext => ({
    name: 'a',
    where: 'harnesses.a',
    env: {},
    path: (p) => (p.startsWith('/') ? p : `/cfg/${p}`),
    secrets: { value: () => undefined, toChild: () => undefined },
    fail: (m) => {
      fails.push(m);
      throw new Error(m);
    },
  });

  it('resolves an entry: a path command against the config, a bare one on PATH; profiles only select a session mode; an unknown flavor fails', () => {
    expect(acpHarnessModule.resolve!({ use: 'acp', command: './agent', args: ['--acp'], cwd: 'work', flavor: 'claude', mcp: 'stdio-bridge', planMode: 'plan' }, ctx()).launch).toEqual({ command: '/cfg/./agent', args: ['--acp'], cwd: '/cfg/work', flavor: 'claude', mcp: 'stdio-bridge', planMode: 'plan' });
    expect(acpHarnessModule.resolve!({ use: 'acp', command: 'gemini' }, ctx()).launch).toEqual({ command: 'gemini' });
    expect(() => acpHarnessModule.resolve!({ use: 'acp', command: 'x', flavor: 'zed' }, ctx())).toThrow('harnesses.a.flavor: unknown ACP flavor "zed" (known: generic, claude)');
    expect(() => acpHarnessModule.resolve!({ use: 'acp', command: 'x', profiles: { bypass: { mode: 'yolo', sandbox: 'none' } } }, ctx())).toThrow('harnesses.a.profiles.bypass: an acp profile has only `mode` (the session mode its turns run in), not `sandbox`');
    expect(() => acpHarnessModule.resolve!({ use: 'acp', command: 'x', profiles: { bypass: { mode: '' } } }, ctx())).toThrow(/profiles\.bypass\.mode: a session mode id/);
  });

  it('declares Plan mode and compaction from what its sessions showed (or its config), and its display name from its flavor; nothing before', async () => {
    const { h } = fake();
    expect([h.modes, h.compact, h.displayName]).toEqual([undefined, undefined, undefined]);
    const s = await h.open(openArgs());
    const ev = events(s);
    await s.startTurn('t1', [input('in-1', 'hi')], run);
    await ev.until(completed('t1'));
    expect(h.modes).toEqual(['plan']);
    // The agent advertises its commands when it likes (here just after session/new).
    for (let i = 0; i < 100 && !h.compact; i++) await new Promise((r) => setTimeout(r, 20));
    expect(h.compact).toEqual({ command: '/compact' });
    await s.close('done');
    const quiet = fake({ FAKE_ACP_NO_MODES: '1', FAKE_ACP_NO_COMMANDS: '1' }, { planMode: 'architect', compact: '/squash', displayName: 'Agent', flavor: 'claude' });
    expect([quiet.h.modes, quiet.h.compact, quiet.h.displayName]).toEqual([['plan'], { command: '/squash' }, 'Agent']);
    expect(fake({}, { flavor: 'claude' }).h.displayName).toBe('Claude Code (ACP)');
  });

  it('a plan, a thought and usage map to plan.updated, reasoning deltas and the turn usage; a session mode the profile names but the agent lacks fails the start', async () => {
    const { h } = fake({}, { profiles: { restricted: { mode: 'nonexistent' }, plain: {} } });
    const s = await h.open(openArgs());
    const ev = events(s);
    await expect(s.startTurn('t0', [input('in-0', 'hi')], run)).rejects.toThrow('profile restricted: the agent has no session mode "nonexistent" (it has "default", "plan", "yolo")');
    const plain = { ...run, profile: 'plain' };
    await s.startTurn('t1', [input('in-1', 'plan')], plain);
    await ev.until(completed('t1'));
    expect(ev.of('plan.updated')).toEqual([{ t: 'plan.updated', steps: [{ text: 'look', status: 'completed' }, { text: 'think', status: 'in_progress' }, { text: 'answer', status: 'pending' }] }]);
    await s.startTurn('t2', [input('in-2', 'think')], plain);
    await ev.until(completed('t2'));
    expect(ev.all.filter((e) => e.body.t === 'text.delta' && e.body.stream === 'reasoning').map((e) => [e.audience, e.level])).toEqual([['commentary', 'detail']]);
    await s.startTurn('t3', [input('in-3', 'usage')], plain);
    await ev.until(completed('t3'));
    expect(ev.of('turn.completed').at(-1)).toMatchObject({ usage: { used: 1200, size: 200000, cost: { amount: 0.01, currency: 'USD' } } });
    await s.close('done');
  });

  it("a profile with no mode configured: restricted (any profile but bypass) runs in the agent's asking mode, not the one the session opened in; bypass in that one; with no asking mode among the agent's the turn does not start until one is configured; an agent with no modes runs as it is", async () => {
    const modes = (c: Record<string, any>[]) => c.filter((x) => x.call === 'session/prompt').map((x) => x.mode);
    const turns = async (f: ReturnType<typeof fake>, profiles: string[]) => {
      const s = await f.h.open(openArgs());
      const ev = events(s);
      for (const [i, profile] of profiles.entries()) {
        await s.startTurn(`t${i}`, [input(`in-${i}`, 'hi')], { ...run, profile });
        await ev.until(completed(`t${i}`));
      }
      return s;
    };
    // It opens in a mode that decides by itself, as Claude Code's ACP agent opens in `auto`.
    const a = fake({ FAKE_ACP_OPEN_MODE: 'yolo' });
    await (await turns(a, ['restricted', 'bypass', 'custom', 'restricted'])).close('done');
    expect(modes(a.calls())).toEqual(['default', 'yolo', 'default', 'default']);

    // None of its modes is known to ask: a restricted turn does not start, and says what to configure; bypass runs.
    const b = fake({ FAKE_ACP_MODES: 'auto,full-access', FAKE_ACP_OPEN_MODE: 'auto' });
    const s = await b.h.open(openArgs());
    const ev = events(s);
    await expect(s.startTurn('t0', [input('in-0', 'hi')], run)).rejects.toThrow(
      'profile restricted: no session mode is configured for it (profiles.restricted.mode) and the agent offers none known to ask before it acts (it has "auto", "full-access"); configure the mode its turns run in',
    );
    await s.startTurn('t1', [input('in-1', 'hi')], { ...run, profile: 'bypass' });
    await ev.until(completed('t1'));
    expect(ev.of('turn.started').map((x) => x.turnId)).toEqual(['t1']);
    expect(modes(b.calls())).toEqual(['auto']);
    await s.close('done');
    const configured = fake({ FAKE_ACP_MODES: 'auto,full-access', FAKE_ACP_OPEN_MODE: 'auto' }, { profiles: { restricted: { mode: 'auto' } } });
    await (await turns(configured, ['restricted'])).close('done');
    expect(modes(configured.calls())).toEqual(['auto']);

    // No session modes: nothing to select.
    const none = fake({ FAKE_ACP_NO_MODES: '1' });
    await (await turns(none, ['restricted'])).close('done');
    expect(none.calls().filter((x) => x.call === 'session/set_mode')).toEqual([]);
  });

  it('a prompt the agent answers with an error fails the turn (prompt_failed), its input not consumed', async () => {
    const { h } = fake();
    const s = await h.open(openArgs());
    const ev = events(s);
    await s.startTurn('t1', [input('in-1', 'fail')], run);
    await ev.until(completed('t1'));
    expect(ev.of('input.consumed')).toEqual([]);
    expect(ev.of('turn.completed')).toEqual([expect.objectContaining({ status: 'failed', error: expect.objectContaining({ code: 'prompt_failed', message: expect.stringContaining('the fake agent failed') }) })]);
    await s.close('done');
  });

  it("anything that throws while mapping the prompt's answer ends the turn ambiguous (adapter_error), logged, and is never an unhandled rejection", async () => {
    const logs: string[] = [];
    const link: AcpLink = {
      request: async () => ({}) as never,
      // An answer whose stop reason cannot even be read.
      prompt: async () =>
        ({
          get stopReason(): never {
            throw new Error('unreadable');
          },
        }) as never,
      notify: async () => undefined,
      gone: false,
      flavor: withDefaults(genericFlavor),
      support: {},
      closes: false,
      cancelTimeoutMs: 1_000,
      profiles: {},
      planMode: undefined,
      learned: () => undefined,
      forget: () => undefined,
      log: (level, msg) => logs.push(`${level}: ${msg}`),
    };
    const s = new AcpSession(link, 'sess-x');
    const ev = events(s);
    await s.startTurn('t1', [input('in-1', 'hello')]);
    await ev.until(completed('t1'));
    expect(ev.of('turn.completed')).toEqual([expect.objectContaining({ turnId: 't1', status: 'ambiguous', error: expect.objectContaining({ code: 'adapter_error', message: expect.stringContaining('unreadable') }) })]);
    expect(logs).toEqual([expect.stringMatching(/^error: acp session sess-x: mapping the answer to session\/prompt failed: unreadable/)]);
    await s.close('done');
    await ev.done;
  });
});
