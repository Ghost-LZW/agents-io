import { describe, expect, it } from 'vitest';
import type { SessionEvent } from '@agents-io/protocol';
import { withholding } from '../src/withhold.js';

/*
 * U20 (docs/HOSTS.md §4.1a): what an external reader does not see of a checked turn before its answer,
 * and each card, are past the exit check.
 */

const G1 = { channel: 'fake', account: 'default', conversationId: 'g1' };
const OPS = { channel: 'fake', account: 'default', conversationId: 'ops' };

function log(bodies: { body: SessionEvent['body']; turnId?: string; itemId?: string; native?: unknown }[]): SessionEvent[] {
  return bodies.map((b, i) => ({
    v: 1,
    sessionKey: 'S',
    seq: i + 1,
    ts: i,
    harness: 'fake',
    generation: 1,
    visibility: 'participants',
    level: 'primary',
    audience: b.body.t.startsWith('text.') ? 'answer' : 'status',
    durability: 'durable',
    ...(b.turnId !== undefined ? { turnId: b.turnId } : {}),
    ...(b.itemId !== undefined ? { itemId: b.itemId } : {}),
    ...(b.native !== undefined ? { native: b.native } : {}),
    body: b.body,
  })) as SessionEvent[];
}

const view = (e: SessionEvent) => ({ body: e.body as unknown, ...(e.native !== undefined ? { native: e.native } : {}) });
const read = (events: SessionEvent[]) => {
  const w = withholding(events);
  // Asked with events of another read of the log (other objects), as the external endpoint does.
  return events.map((e) => structuredClone(e)).map((e) => w.apply(e, view(e)) as { body: Record<string, unknown>; native?: unknown; withheld?: string });
};

const SECRET = 'the plan is to move on Friday';

const turn = (settled: SessionEvent['body'][] = []) =>
  log([
    { turnId: 't1', body: { t: 'turn.started', turnId: 't1', inputIds: ['i1'], replyRoute: G1, checked: true } },
    { turnId: 't1', itemId: 'q1', body: { t: 'item.started', item: { itemId: 'q1', type: 'tool', title: `AskUserQuestion: ${SECRET}?`, status: 'running', inputSummary: SECRET } } },
    { turnId: 't1', itemId: 'q1', body: { t: 'request.opened', requestId: 'r1', kind: 'question', title: `${SECRET}?`, risk: {}, inputPreview: SECRET, questions: [{ id: '0', text: SECRET }], allowedDecisions: ['answer'], allowAlways: false, defaultDeny: true } },
    { turnId: 't1', itemId: 'th', body: { t: 'item.completed', item: { itemId: 'th', type: 'reasoning', title: `Thinking about ${SECRET}`, status: 'completed' } } },
    { turnId: 't1', itemId: 'c1', body: { t: 'item.completed', item: { itemId: 'c1', type: 'command', title: 'ls', status: 'completed' } } },
    { turnId: 't1', body: { t: 'headline', text: SECRET } },
    { turnId: 't1', body: { t: 'text.delta', stream: 'answer', delta: SECRET } },
    { turnId: 't1', body: { t: 'text.snapshot', text: SECRET, final: true } },
    { turnId: 't1', body: { t: 'usage', usage: { tokens: 3 } }, native: { type: 'result', result: SECRET } },
    // No turn id: the turn open at its seq.
    { body: { t: 'native', name: 'claude-code.assistant' }, native: { message: SECRET } },
    { turnId: 't1', body: { t: 'turn.completed', turnId: 't1', status: 'completed' } },
    ...settled.map((body) => ({ turnId: 't1', body })),
  ]);

const settled = (kind: string, result: 'delivered' | 'held' | 'rejected', extra: Record<string, unknown> = {}): SessionEvent['body'] =>
  ({ t: 'delivery.settled', operationId: `op-${kind}`, route: G1, result, kind, turnId: 't1', ...extra }) as SessionEvent['body'];

const leaks = (events: ReturnType<typeof read>) => events.filter((e) => JSON.stringify(e).includes(SECRET.slice(0, 10)));

describe('withholding a checked turn from external readers', () => {
  it('before the answer settles: answer, reasoning, headline, the card and the tool item that opened it, and every native are withheld (checking) #DL-7', () => {
    const out = read(turn());
    expect(leaks(out)).toEqual([]);
    expect(out[0]!.withheld).toBeUndefined();
    for (const i of [1, 2, 3, 5, 6, 7, 8]) expect(out[i]!.withheld).toBe('checking');
    expect(out[8]!.native).toBeUndefined();
    expect(out[9]).toMatchObject({ withheld: 'checking' });
    expect(out[9]!.native).toBeUndefined();
    // A command item has nothing withheld: its title stays.
    expect(out[4]).toMatchObject({ body: { item: { title: 'ls' } } });
    expect(out[4]!.withheld).toBeUndefined();
  });

  it('the card settles delivered: the card and its tool item read; the answer still checking; then delivered: everything reads #DL-7', () => {
    const card = read(turn([settled('question', 'delivered', { requestId: 'r1' })]));
    expect(card[1]!.withheld).toBeUndefined();
    expect(card[2]).toMatchObject({ body: { title: `${SECRET}?`, questions: [{ text: SECRET }] } });
    expect(card[7]!.withheld).toBe('checking');
    const all = read(turn([settled('question', 'delivered', { requestId: 'r1' }), settled('reply', 'delivered')]));
    expect(all.every((e) => e.withheld === undefined)).toBe(true);
    expect(all[8]!.native).toEqual({ type: 'result', result: SECRET });
  });

  it('held: withheld for good (held); a held card stays held even after the answer is delivered #DL-7', () => {
    const held = read(turn([settled('reply', 'held', { reason: 'x' })]));
    expect(leaks(held)).toEqual([]);
    expect(held[7]!.withheld).toBe('held');
    const card = read(turn([settled('question', 'held', { requestId: 'r1' }), settled('reply', 'delivered')]));
    expect(card[2]!.withheld).toBe('held');
    expect(card[1]!.withheld).toBe('held');
    expect(card[7]!.withheld).toBeUndefined();
  });

  it('denied by the check: held for good like a hold; rejected by the channel (past the check) releases #DL-7', () => {
    const denied = read(turn([settled('question', 'rejected', { requestId: 'r1', denied: true }), settled('reply', 'rejected', { denied: true, reason: 'no' })]));
    expect(leaks(denied)).toEqual([]);
    expect(denied[7]!.withheld).toBe('held');
    expect(denied[2]!.withheld).toBe('held');
    const failed = read(turn([settled('question', 'rejected', { requestId: 'r1' }), settled('reply', 'rejected')]));
    expect(failed.every((e) => e.withheld === undefined)).toBe(true);
  });

  it('a route added checked mid-turn (mirror): withheld from there on, and released only when that route settles #DL-7', () => {
    const events = log([
      { turnId: 't1', body: { t: 'turn.started', turnId: 't1', inputIds: ['i1'], replyRoute: OPS, checked: false } },
      { turnId: 't1', body: { t: 'text.delta', stream: 'answer', delta: 'early words' } },
      { turnId: 't1', body: { t: 'turn.delivery_added', turnId: 't1', route: G1, reason: 'mirror', checked: true } },
      { turnId: 't1', body: { t: 'text.snapshot', text: SECRET, final: true } },
      { turnId: 't1', body: { t: 'turn.completed', turnId: 't1', status: 'completed' } },
      // The route out of scope settles first: not what releases it.
      { turnId: 't1', body: { t: 'delivery.settled', operationId: 'a', route: OPS, result: 'delivered', kind: 'reply', turnId: 't1' } },
    ]);
    const out = read(events);
    expect(out[1]!.withheld).toBeUndefined();
    expect(out[3]!.withheld).toBe('checking');
    const done = read([...events, ...log([{ turnId: 't1', body: { t: 'delivery.settled', operationId: 'b', route: G1, result: 'delivered', kind: 'reply', turnId: 't1' } }]).map((e) => ({ ...e, seq: 7 }))]);
    expect(done[3]!.withheld).toBeUndefined();
  });

  it('a card of a turn checked mid-turn: its settlement on the route out of scope releases nothing; only the checked route\'s does #DL-7', () => {
    const events = log([
      { turnId: 't1', body: { t: 'turn.started', turnId: 't1', inputIds: ['i1'], replyRoute: OPS, checked: false } },
      { turnId: 't1', body: { t: 'turn.delivery_added', turnId: 't1', route: G1, reason: 'steer', checked: true } },
      { turnId: 't1', itemId: 'q1', body: { t: 'item.started', item: { itemId: 'q1', type: 'tool', title: `AskUserQuestion: ${SECRET}?`, status: 'running', inputSummary: SECRET } } },
      { turnId: 't1', itemId: 'q1', body: { t: 'request.opened', requestId: 'r1', kind: 'question', title: `${SECRET}?`, risk: {}, questions: [{ id: '0', text: SECRET }], allowedDecisions: ['answer'], allowAlways: false, defaultDeny: true } },
      // Out of scope, not checked: sent first.
      { turnId: 't1', body: { t: 'delivery.settled', operationId: 'q-ops', route: OPS, result: 'delivered', kind: 'question', requestId: 'r1', turnId: 't1' } },
    ]);
    const out = read(events);
    expect(out[2]!.withheld).toBe('checking');
    expect(out[3]!.withheld).toBe('checking');
    expect(leaks(out)).toEqual([]);
    const more = (body: SessionEvent['body']) => [...events, ...log([{ turnId: 't1', body }]).map((e) => ({ ...e, seq: 6 }))];
    const released = read(more({ t: 'delivery.settled', operationId: 'q-g1', route: G1, result: 'delivered', kind: 'question', requestId: 'r1', turnId: 't1' } as SessionEvent['body']));
    expect(released[3]!.withheld).toBeUndefined();
    expect(released[2]!.withheld).toBeUndefined();
    const held = read(more({ t: 'delivery.settled', operationId: 'q-g1', route: G1, result: 'held', kind: 'question', requestId: 'r1', turnId: 't1' } as SessionEvent['body']));
    expect(held[3]!.withheld).toBe('held');
  });

  it('a log with no checked turn reads as it is #DL-7', () => {
    const events = log([
      { turnId: 't1', body: { t: 'turn.started', turnId: 't1', inputIds: ['i1'], replyRoute: G1 } },
      { turnId: 't1', body: { t: 'text.snapshot', text: SECRET, final: true } },
    ]);
    const w = withholding(events);
    expect(w.none).toBe(true);
    expect(read(events).every((e) => e.withheld === undefined)).toBe(true);
  });
});

describe('withholding the agent\'s session_rotate (its title and summary) from external readers', () => {
  const ARGS = `{"title":"${SECRET}","summary":"${SECRET}"}`;
  // Claude Code: the title carries the input; Codex: `<server>.<tool>` only. With `tool` (HC-7) or without it.
  const rotate = (checked: boolean | undefined, check?: 'allowed' | 'held', o: { tool?: boolean; completed?: boolean; ended?: boolean } = {}) =>
    log([
      { turnId: 't1', body: { t: 'turn.started', turnId: 't1', inputIds: ['i1'], replyRoute: G1, ...(checked !== undefined ? { checked } : {}) } },
      {
        turnId: 't1',
        itemId: 'rot',
        body: { t: 'item.started', item: { itemId: 'rot', type: 'mcp_tool', title: `agents-io.session_rotate: ${ARGS}`, status: 'running', inputSummary: ARGS, ...(o.tool !== false ? { tool: { server: 'agents-io', name: 'session_rotate' } } : {}) } },
      },
      { turnId: 't1', itemId: 'rot', body: { t: 'item.progress', itemId: 'rot', text: SECRET } },
      ...(check ? [{ turnId: 't1', body: { t: 'topic.changed', conversation: 'fake:default:g1', from: 'tpA', to: 'tpB', reason: 'agent', ...(check === 'allowed' ? { title: 'T' } : {}), check } as SessionEvent['body'] }] : []),
      ...(o.ended !== false
        ? [{ turnId: 't1', itemId: 'rot', body: { t: 'item.completed', item: { itemId: 'rot', type: 'mcp_tool', title: 'agents-io.session_rotate', status: 'completed', inputSummary: ARGS, result: { preview: SECRET, truncated: false, isError: false } } } as SessionEvent['body'] }]
        : []),
      { turnId: 't1', itemId: 'ls', body: { t: 'item.completed', item: { itemId: 'ls', type: 'command', title: 'ls', status: 'completed', inputSummary: '/tmp' } } },
      ...(o.completed !== false ? [{ turnId: 't1', body: { t: 'turn.completed', turnId: 't1', status: 'completed' } as SessionEvent['body'] }] : []),
    ]);
  const items = (r: ReturnType<typeof read>) => r.filter((e) => (e.body.item as { itemId?: string } | undefined)?.itemId === 'rot' || e.body.t === 'item.progress');

  it('in a checked turn: withheld (checking) until topic.changed says the ask was allowed; held: for good; never asked by the end of the call (or the turn): held #DL-7', () => {
    const checking = read(rotate(true, undefined, { completed: false, ended: false }));
    expect(JSON.stringify(items(checking))).not.toContain(SECRET);
    expect(items(checking).every((e) => e.withheld === 'checking')).toBe(true);
    // Another tool item of the turn reads as it is.
    expect(checking.find((e) => (e.body.item as { itemId?: string } | undefined)?.itemId === 'ls')!.body).toMatchObject({ item: { inputSummary: '/tmp' } });
    // Its label (`tool`) is not content: it stays.
    expect(items(checking)[0]!.body).toMatchObject({ item: { title: '', tool: { name: 'session_rotate' } } });

    const allowed = read(rotate(true, 'allowed'));
    expect(items(allowed).filter((e) => e.body.t !== 'item.progress').every((e) => JSON.stringify(e.body).includes(SECRET))).toBe(true);
    expect(items(allowed).every((e) => e.withheld === undefined)).toBe(true);

    // The call ended without an ask (the turn still running), or the turn ended with the call open: held.
    for (const r of [read(rotate(true, 'held')), read(rotate(true, undefined)), read(rotate(true, undefined, { completed: false })), read(rotate(true, undefined, { ended: false }))]) {
      expect(JSON.stringify(items(r))).not.toContain(SECRET);
      expect(items(r).every((e) => e.withheld === 'held')).toBe(true);
    }
    // Without `tool`: known by its title.
    expect(items(read(rotate(true, 'held', { tool: false }))).every((e) => e.withheld === 'held')).toBe(true);
  });

  it('held where the turn was not checked (a host input in a scoped conversation): withheld once topic.changed says held; nothing asked and not checked: reads as it is #DL-7', () => {
    const held = rotate(false, 'held');
    expect(withholding(held).none).toBe(false);
    expect(items(read(held)).every((e) => e.withheld === 'held')).toBe(true);
    const plain = rotate(undefined);
    expect(withholding(plain).none).toBe(true);
    expect(read(plain).every((e) => e.withheld === undefined)).toBe(true);
  });

  // Two session_rotate calls in one turn: a check answers the call running when it was asked, not the turn.
  const twice = (checked: boolean, first: 'allowed' | 'held' | undefined, second: 'allowed' | 'held' | undefined, o: { parallel?: boolean } = {}) => {
    const ARG = (n: string) => `{"title":"${n} ${SECRET}","summary":"${n} ${SECRET}"}`;
    const item = (id: string, t: 'item.started' | 'item.completed') => ({
      turnId: 't1',
      itemId: id,
      body: {
        t,
        item: { itemId: id, type: 'mcp_tool', title: `agents-io.session_rotate: ${ARG(id)}`, status: t === 'item.started' ? 'running' : 'completed', inputSummary: ARG(id), tool: { server: 'agents-io', name: 'session_rotate' } },
      } as SessionEvent['body'],
    });
    const changed = (check: 'allowed' | 'held' | undefined) =>
      check ? [{ turnId: 't1', body: { t: 'topic.changed', conversation: 'fake:default:g1', from: 'tpA', to: 'tpB', reason: 'agent', check } as SessionEvent['body'] }] : [];
    return log([
      { turnId: 't1', body: { t: 'turn.started', turnId: 't1', inputIds: ['i1'], replyRoute: G1, checked } },
      ...(o.parallel
        ? [item('A', 'item.started'), item('B', 'item.started'), ...changed(first), ...changed(second), item('A', 'item.completed'), item('B', 'item.completed')]
        : [item('A', 'item.started'), ...changed(first), item('A', 'item.completed'), item('B', 'item.started'), ...changed(second), item('B', 'item.completed')]),
      { turnId: 't1', body: { t: 'turn.completed', turnId: 't1', status: 'completed' } },
    ]);
  };
  const of = (r: ReturnType<typeof read>, id: string) => r.filter((e) => (e.body.item as { itemId?: string } | undefined)?.itemId === id);

  it('two rotates in one checked turn: each is released only by its own check; one never asked (it failed before the ask, or was refused after the other) stays held #DL-7', () => {
    // The first fails before the host is asked (e.g. an empty summary), the second is allowed.
    const failedFirst = read(twice(true, undefined, 'allowed'));
    expect(JSON.stringify(of(failedFirst, 'A'))).not.toContain(SECRET);
    expect(of(failedFirst, 'A').every((e) => e.withheld === 'held')).toBe(true);
    expect(of(failedFirst, 'B').every((e) => e.withheld === undefined && JSON.stringify(e.body).includes(`B ${SECRET}`))).toBe(true);
    // The first is allowed, the second refused without an ask ("this turn was already handed").
    const refusedSecond = read(twice(true, 'allowed', undefined));
    expect(of(refusedSecond, 'A').every((e) => e.withheld === undefined)).toBe(true);
    expect(JSON.stringify(of(refusedSecond, 'B'))).not.toContain(SECRET);
    expect(of(refusedSecond, 'B').every((e) => e.withheld === 'held')).toBe(true);
    // One held, one allowed: each its own.
    const heldThenAllowed = read(twice(true, 'held', 'allowed'));
    expect(of(heldThenAllowed, 'A').every((e) => e.withheld === 'held')).toBe(true);
    expect(of(heldThenAllowed, 'B').every((e) => e.withheld === undefined)).toBe(true);
  });

  it('two rotates in one turn not checked where one was asked: the one never asked is held; two running at once: allowed releases neither, held holds both #DL-7', () => {
    // A host input in a scoped conversation: rotates there are asked; the turn is not checked.
    const unchecked = twice(false, 'allowed', undefined);
    expect(withholding(unchecked).none).toBe(false);
    expect(of(read(unchecked), 'A').every((e) => e.withheld === undefined)).toBe(true);
    expect(of(read(unchecked), 'B').every((e) => e.withheld === 'held')).toBe(true);
    const parallelAllowed = read(twice(true, 'allowed', undefined, { parallel: true }));
    expect(JSON.stringify([...of(parallelAllowed, 'A'), ...of(parallelAllowed, 'B')])).not.toContain(SECRET);
    expect([...of(parallelAllowed, 'A'), ...of(parallelAllowed, 'B')].every((e) => e.withheld === 'held')).toBe(true);
    const parallelHeld = read(twice(false, 'held', undefined, { parallel: true }));
    expect([...of(parallelHeld, 'A'), ...of(parallelHeld, 'B')].every((e) => e.withheld === 'held')).toBe(true);
  });

  it('in the new topic\'s log: the summary handed from a topic whose rotate was held is withheld (held); one allowed reads #DL-7', () => {
    const newTopic = (check: 'allowed' | 'held') =>
      log([
        { body: { t: 'topic.changed', conversation: 'fake:default:g1', from: 'tpA', to: 'tpB', reason: 'agent', check } as SessionEvent['body'] },
        {
          body: {
            t: 'input.admitted',
            inputId: 'sum_t1',
            disposition: 'observe_only',
            input: { inputId: 'sum_t1', origin: { kind: 'system', principal: null, evidence: 'none', via: 'topic:tpA', adapter: 'session' }, content: [{ type: 'text', text: SECRET }], replyRoute: G1, channelContext: { topicSummary: true, fromTopic: 'tpA' } },
          } as SessionEvent['body'],
        },
      ]);
    const held = read(newTopic('held'));
    expect(JSON.stringify(held)).not.toContain(SECRET);
    expect(held[1]!.withheld).toBe('held');
    expect(withholding(newTopic('allowed')).none).toBe(true);
    expect(JSON.stringify(read(newTopic('allowed')))).toContain(SECRET);
  });
});
