import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { InputRecord, ReplyRoute, Topic, TurnContext } from '@agents-io/protocol';
import { Hub, MemorySessionLog, Outbox, defaultPolicy } from '@agents-io/session';
import { HostMcpServer, HostTools, MemoryBlobStore, type TopicControl } from '../src/index.js';

const SK = 's1';
const ROUTE: ReplyRoute = { channel: 'fake', account: 'default', conversationId: 'c1' };
const input = (id: string, extra: Record<string, string | boolean> = {}): InputRecord => ({
  inputId: id,
  origin: { kind: 'human', principal: { id: 'fake:alice', labels: ['owner'] }, evidence: 'platform_signed', via: 'fake:default:c1', adapter: 'fake' },
  content: [{ type: 'text', text: 'what is the capital of Australia?' }],
  replyRoute: ROUTE,
  channelContext: { channel: 'fake', ...extra },
});
const turnOf = (inputs: InputRecord[] = [input('in1')]): TurnContext => ({ sessionKey: SK, turnId: 't1', run: { harness: 'fake', model: 'm', profile: 'bypass' }, inputs, replyRoute: ROUTE, deliveries: [] });
const topic = (id: string, sessionKey: string, state: 'current' | 'parked', title?: string): Topic => ({ id, conversation: 'fake:default:c1', sessionKey, state, createdAt: 1, lastActiveAt: 2, ...(title ? { title } : {}) });

function world() {
  let topics: Topic[] = [topic('tp_a', SK, 'current', 'Rust CLI'), topic('tp_b', 's1#tp_b', 'parked', 'Groceries')];
  const calls: { op: string; sessionKey: string; turn: TurnContext; args: unknown }[] = [];
  const control: TopicControl = {
    list: (sk) => (topics.some((t) => t.sessionKey === sk) ? topics : undefined),
    rotate: async (sk, turn, a) => {
      calls.push({ op: 'rotate', sessionKey: sk, turn, args: a });
      const t = topic('tp_new', 's1#tp_new', 'current', a.title);
      const previous = topics.find((x) => x.state === 'current')!;
      topics = [t, ...topics.map((x) => ({ ...x, state: 'parked' as const }))];
      return { topic: t, previous, handed: turn.inputs.map((i) => `${i.inputId}>tp_new`) };
    },
    switch: async (sk, turn, a) => {
      calls.push({ op: 'switch', sessionKey: sk, turn, args: a });
      return { topic: topics.find((t) => t.id === a.topicId)!, handed: turn.inputs.map((i) => `${i.inputId}>${a.topicId}`) };
    },
  };
  const hub = new Hub(new MemorySessionLog());
  let turn: TurnContext | undefined = turnOf();
  const tools = new HostTools({ hub, outbox: new Outbox({ hub }), policy: defaultPolicy({ owners: ['fake:alice'] }), turn: () => turn, adapter: () => undefined, blobs: new MemoryBlobStore(), cwd: () => '/', topics: control });
  const run = (name: string, args: Record<string, unknown> = {}, id = Math.random().toString(36), sk = SK) => tools.call({ sessionKey: sk, generation: 1 }, name, args, { toolCallId: id }).then((t) => JSON.parse(t));
  return { tools, calls, run, setTurn: (t: TurnContext | undefined) => (turn = t) };
}

describe('topic tools', () => {
  it('session_list shows the conversation topics and marks the caller; it needs no running turn', async () => {
    const w = world();
    w.setTurn(undefined);
    const r = await w.run('session_list');
    expect(r.topics).toEqual([
      expect.objectContaining({ topicId: 'tp_a', title: 'Rust CLI', current: true, you: true }),
      expect.objectContaining({ topicId: 'tp_b', title: 'Groceries', current: false }),
    ]);
    expect(r.topics[1].you).toBeUndefined();
    await expect(w.run('session_list', {}, 'x', 'not-a-topic')).rejects.toThrow(/does not keep topics/);
  });

  it('session_rotate hands the turn over and tells the model to end the turn without answering', async () => {
    const w = world();
    const r = await w.run('session_rotate', { title: 'Capitals', summary: 'user builds a Rust CLI' }, 'toolu_r');
    expect(r).toMatchObject({ ok: true, topic: { topicId: 'tp_new', title: 'Capitals' }, previous: { topicId: 'tp_a', title: 'Rust CLI' }, handed: 1 });
    expect(r.note).toMatch(/Do NOT answer the message in this turn/);
    expect(w.calls).toHaveLength(1);
    expect(w.calls[0]).toMatchObject({ op: 'rotate', sessionKey: SK, args: { title: 'Capitals', summary: 'user builds a Rust CLI' } });
    // A retried call (same tool-call id) answers the same; a second handover in the same turn is refused.
    expect(await w.run('session_rotate', { title: 'Capitals', summary: 'x' }, 'toolu_r')).toEqual(r);
    expect(w.calls).toHaveLength(1);
    await expect(w.run('session_switch', { topicId: 'tp_b' }, 'toolu_s')).rejects.toThrow(/already handed/);
  });

  it('session_rotate needs a title, a summary and a running turn with a message', async () => {
    const w = world();
    await expect(w.run('session_rotate', { title: 'x' })).rejects.toThrow(/summary is required/);
    await expect(w.run('session_rotate', { summary: 'x' })).rejects.toThrow(/title is required/);
    w.setTurn(turnOf([input('ctx1', { context: true })]));
    await expect(w.run('session_rotate', { title: 'x', summary: 'y' })).rejects.toThrow(/no message to hand over/);
    w.setTurn(undefined);
    await expect(w.run('session_rotate', { title: 'x', summary: 'y' })).rejects.toThrow(/no turn is running/);
    expect(w.calls).toHaveLength(0);
  });

  it('session_switch resumes another topic of the same conversation only', async () => {
    const w = world();
    await expect(w.run('session_switch', { topicId: 'tp_zz' })).rejects.toThrow(/no topic tp_zz/);
    await expect(w.run('session_switch', { topicId: 'tp_a' })).rejects.toThrow(/already in that topic/);
    const r = await w.run('session_switch', { topicId: 'tp_b' });
    expect(r).toMatchObject({ ok: true, topic: { topicId: 'tp_b', title: 'Groceries' }, handed: 1 });
    expect(r.note).toMatch(/full earlier context/);
    expect(w.calls.map((c) => c.op)).toEqual(['switch']);
  });

  it('a message just handed over by a rotate or switch is not moved again (no ping-pong)', async () => {
    const w = world();
    w.setTurn(turnOf([input('in1>tp_a', { handedFrom: 's1#tp_b' })]));
    await expect(w.run('session_rotate', { title: 'x', summary: 'y' })).rejects.toThrow(/just handed to this topic/);
    await expect(w.run('session_switch', { topicId: 'tp_b' })).rejects.toThrow(/just handed to this topic/);
    // A fresh message batched with it may still move the turn.
    w.setTurn(turnOf([input('in1>tp_a', { handedFrom: 's1#tp_b' }), input('in2')]));
    expect(await w.run('session_switch', { topicId: 'tp_b' })).toMatchObject({ ok: true });
    expect(w.calls).toHaveLength(1);
  });

  it('a parked topic session may not hand over (someone switched meanwhile)', async () => {
    const w = world();
    await expect(w.run('session_rotate', { title: 'x', summary: 'y' }, 'k', 's1#tp_b')).rejects.toThrow(/no longer the conversation's current one/);
  });

  it('are listed over MCP only when the host provides topics', async () => {
    const w = world();
    const s = new HostMcpServer({ tools: w.tools });
    await s.listen();
    const client = new Client({ name: 't', version: '0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(s.url), { requestInit: { headers: { Authorization: `Bearer ${s.mint({ sessionKey: SK, generation: 1 })}` } } }));
    const tools = (await client.listTools()).tools;
    expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(['session_rotate', 'session_list', 'session_switch']));
    expect(tools.find((t) => t.name === 'session_rotate')!.description).toMatch(/end your turn without answering/);
    await client.close();
    await s.close();
  });
});
