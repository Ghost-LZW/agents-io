import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { HostMcpServer } from '../src/index.js';
import { SK, input, turnOf, world } from './topic-tools-helpers.js';

describe('topic tools', () => {
  it('session_rotate hands the turn over and tells the model to end the turn without answering #TP-1', async () => {
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

  it('session_switch resumes another topic of the same conversation only #TP-1', async () => {
    const w = world();
    await expect(w.run('session_switch', { topicId: 'tp_zz' })).rejects.toThrow(/no topic tp_zz/);
    await expect(w.run('session_switch', { topicId: 'tp_a' })).rejects.toThrow(/already in that topic/);
    const r = await w.run('session_switch', { topicId: 'tp_b' });
    expect(r).toMatchObject({ ok: true, topic: { topicId: 'tp_b', title: 'Groceries' }, handed: 1 });
    expect(r.note).toMatch(/full earlier context/);
    expect(w.calls.map((c) => c.op)).toEqual(['switch']);
  });

  it('a message just handed over by a rotate or switch is not moved again (no ping-pong) #TP-1', async () => {
    const w = world();
    w.setTurn(turnOf([input('in1>tp_a', { handedFrom: 's1#tp_b' })]));
    await expect(w.run('session_rotate', { title: 'x', summary: 'y' })).rejects.toThrow(/just handed to this topic/);
    await expect(w.run('session_switch', { topicId: 'tp_b' })).rejects.toThrow(/just handed to this topic/);
    // A fresh message batched with it may still move the turn.
    w.setTurn(turnOf([input('in1>tp_a', { handedFrom: 's1#tp_b' }), input('in2')]));
    expect(await w.run('session_switch', { topicId: 'tp_b' })).toMatchObject({ ok: true });
    expect(w.calls).toHaveLength(1);
  });

  it('a parked topic session may not hand over (someone switched meanwhile) #TP-1', async () => {
    const w = world();
    await expect(w.run('session_rotate', { title: 'x', summary: 'y' }, 'k', 's1#tp_b')).rejects.toThrow(/no longer the conversation's current one/);
  });

  it('are listed over MCP only when the host provides topics #CF-6', async () => {
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
