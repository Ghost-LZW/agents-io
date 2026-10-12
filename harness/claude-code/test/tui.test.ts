import { describe, expect, it } from 'vitest';
import type { HarnessEvent, InputRecord } from '@agents-io/protocol';
import { ClaudeTuiSession, type TuiHook, type TuiLink } from '../src/index.js';
import { AsyncQueue } from '../src/queue.js';

/* Claude Code's own TUI as a session's harness (decision 15, S2): hooks in, inbox messages out. */

function link() {
  const hooks = new AsyncQueue<TuiHook>();
  const sent: string[] = [];
  let closed = false;
  const l: TuiLink = { send: async (t) => void sent.push(t), hooks, close: () => void (closed = true) };
  return { l, hooks, sent, closed: () => closed };
}

function collect(s: ClaudeTuiSession) {
  const events: HarnessEvent[] = [];
  void (async () => {
    for await (const e of s.events) events.push(e);
  })();
  return events;
}

const tick = () => new Promise((r) => setTimeout(r, 0));
const bodies = (events: HarnessEvent[]) => events.map((e) => e.body);
const input: InputRecord = {
  inputId: 'in1',
  origin: { kind: 'human', principal: { id: 'lark-bot:bob', labels: [] }, evidence: 'platform_signed', via: 'lark-bot:a:oc_1' },
  content: [{ type: 'text', text: 'please look at the build' }],
  replyRoute: { channel: 'lark-bot', account: 'a', conversationId: 'oc_1' },
  channelContext: {},
};

describe('ClaudeTuiSession', () => {
  it('a turn is one inbox message with its source line; hooks become its events and Stop its answer #LN-9', async () => {
    const k = link();
    const s = new ClaudeTuiSession('sid-1', k.l);
    const events = collect(s);
    await s.startTurn('t1', [input]);
    expect(k.sent[0]).toMatch(/^\[agents-io turn t1\]\n\[agents-io input from=lark-bot:bob /);
    expect(k.sent[0]).toContain('please look at the build');
    k.hooks.push({ event: 'UserPromptSubmit', body: { prompt: k.sent[0], prompt_id: 'p1' } });
    k.hooks.push({ event: 'PreToolUse', body: { tool_name: 'Bash', tool_input: { command: 'pnpm build' }, tool_use_id: 'tu1' } });
    k.hooks.push({ event: 'PostToolUse', body: { tool_name: 'Bash', tool_input: { command: 'pnpm build' }, tool_response: { stdout: 'ok' }, tool_use_id: 'tu1' } });
    k.hooks.push({ event: 'Stop', body: { last_assistant_message: 'The build passes.' } });
    await tick();
    expect(bodies(events).map((b) => b.t)).toEqual(['session.bound', 'turn.started', 'input.consumed', 'item.started', 'item.completed', 'text.snapshot', 'turn.completed']);
    expect(bodies(events)[0]).toEqual({ t: 'session.bound', nativeId: 'sid-1' });
    expect(bodies(events)[1]).toMatchObject({ turnId: 't1', inputIds: ['in1'], replyRoute: input.replyRoute, initiator: 'host' });
    expect(bodies(events)[5]).toEqual({ t: 'text.snapshot', text: 'The build passes.', final: true });
    expect(events[5]!.audience).toBe('answer');
  });

  it('something typed in the terminal is a foreign turn with no reply route #LN-9', async () => {
    const k = link();
    const s = new ClaudeTuiSession('sid-1', k.l);
    const events = collect(s);
    k.hooks.push({ event: 'UserPromptSubmit', body: { prompt: 'what changed today?', prompt_id: 'p9' } });
    k.hooks.push({ event: 'Stop', body: { last_assistant_message: 'Two commits.' } });
    await tick();
    expect(bodies(events)[1]).toMatchObject({ t: 'turn.started', turnId: 'tui_p9', inputIds: [], replyRoute: null, initiator: 'foreign' });
    expect(bodies(events).at(-1)).toEqual({ t: 'turn.completed', turnId: 'tui_p9', status: 'completed' });
    // While it runs, the session layer cannot start a turn of its own.
    k.hooks.push({ event: 'UserPromptSubmit', body: { prompt: 'and yesterday?', prompt_id: 'p10' } });
    await tick();
    await expect(s.startTurn('t2', [input])).rejects.toThrow();
  });

  it('a permission prompt is a request: answered from outside, or over once the terminal answered #LN-9 #RQ-1', async () => {
    const k = link();
    const s = new ClaudeTuiSession('sid-1', k.l);
    const events = collect(s);
    await s.startTurn('t1', [input]);
    const answers: unknown[] = [];
    k.hooks.push({ event: 'PermissionRequest', body: { tool_name: 'Bash', tool_input: { command: 'rm -rf dist' } }, answer: (o) => void answers.push(o) });
    await tick();
    const opened = bodies(events).find((b) => b.t === 'request.opened') as { requestId: string; title: string; allowedDecisions: string[] };
    expect(opened.allowedDecisions).toEqual(['allow_once', 'deny']);
    await s.respond(opened.requestId, { kind: 'allow_once' });
    expect(answers).toEqual([{ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } }]);
    await s.respond(opened.requestId, { kind: 'deny' }); // once only
    expect(answers).toHaveLength(1);

    let abandon: (() => void) | undefined;
    k.hooks.push({ event: 'PermissionRequest', body: { tool_name: 'Edit', tool_input: { file_path: '/x' } }, answer: () => undefined, onAbandoned: (fn) => void (abandon = fn) });
    await tick();
    abandon!();
    await tick();
    const second = bodies(events).filter((b) => b.t === 'request.opened')[1] as { requestId: string };
    expect(bodies(events).at(-1)).toEqual({ t: 'request.resolved', requestId: second.requestId, decision: null, by: { kind: 'harness' } });
  });

  it('the TUI leaving ends the stream; a send that fails fails the turn, not the session #LN-9', async () => {
    const k = link();
    const s = new ClaudeTuiSession('sid-1', { ...k.l, send: async () => Promise.reject(new Error('the terminal UI is not connected')) });
    const events = collect(s);
    await s.startTurn('t1', [input]);
    await tick();
    expect(bodies(events).at(-1)).toMatchObject({ t: 'turn.completed', turnId: 't1', status: 'failed', error: { code: 'tui_unreachable' } });
    k.hooks.close();
    await tick();
    await tick();
    const n = events.length;
    await s.startTurn('t2', [input]).catch(() => undefined);
    expect(events.length).toBe(n); // closed: nothing more
  });
});
