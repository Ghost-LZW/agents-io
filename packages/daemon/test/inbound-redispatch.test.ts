import { describe, expect, it } from 'vitest';
import type { Binding, BindingTable, InputRecord } from '@agents-io/protocol';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { daemon, tmp, until } from './helpers.js';

/*
 * `inbound.redispatch` (docs/design/inbound-redispatch): a host delivers an item
 * that went to its queue (host offline, a callout timed out…) to a session later,
 * with the origin it was stamped with on arrival.
 */

const hostRule: Binding = { id: 'to-host', match: { channel: 'fake', keywords: ['xwo'] }, on: 'host' };
const table = (bindings: Binding[]): BindingTable => ({ version: 'r1', bindings, identities: [], onHostDown: 'keep' });
// Not an owner: the config's default bindings do not dispatch it, only the host rule takes it.
const bob = { channelUserId: 'bob', evidence: 'platform_signed' as const };

async function world(raw?: Record<string, unknown>) {
  const inputs: InputRecord[] = [];
  const w = await daemon({
    ...(raw ? { raw } : {}),
    script: async (t) => {
      inputs.push(...t.inputs);
      t.emit({ t: 'text.snapshot', text: 'ok', final: true }, { audience: 'answer' });
    },
  });
  const h = await w.host();
  await h.bindingsPut(table([hostRule]));
  return { w, h, inputs };
}

describe('inbound.redispatch', () => {
  it('delivers a queued item with its original origin, records both sides in explain, and is idempotent per cursor #HQ-4 #ID-1 #EX-1', async () => {
    const { w, h, inputs } = await world();
    const r = await w.chat.inject({ id: 'm1', sender: bob, conversation: { id: 'g1', kind: 'group' }, text: 'xwo please' });
    const [item] = (await h.inboundRead({ consumer: 'any', after: 0 })).items;
    expect(item).toMatchObject({ channelRef: 'channel:fake/m1' });
    expect(inputs).toHaveLength(0);

    const res = await h.inboundRedispatch({ cursor: item!.cursor, session: { key: 'R1' } });
    expect(res).toMatchObject({ cursor: item!.cursor, of: r.inputId, inputId: `${r.inputId}~r${item!.cursor}`, sessionKey: 'R1', on: 'dispatch', by: 'host:xwo', duplicate: false });
    await until(() => inputs.length === 1);
    const got = inputs[0]!;
    // The sender, principal and evidence are the original ones, not the host's.
    expect(got.origin).toEqual(item!.input.origin);
    expect(got.origin).toMatchObject({ kind: 'human', evidence: 'platform_signed', adapter: 'fake' });
    expect(got.origin.via).not.toMatch(/^host/);
    expect(got.channelContext).toMatchObject({ redispatchedBy: 'host:xwo' });
    expect(got.content).toEqual(item!.input.content);

    expect(w.gw.router.explain(res.inputId)).toMatchObject({ redispatchOf: { inputId: r.inputId, cursor: item!.cursor, by: 'host:xwo' }, principal: item!.input.origin.principal?.id ?? null, matched: [{ bindingId: 'host:redispatch', sessionKey: 'R1' }] });
    expect(w.gw.router.explain(r.inputId!)?.redispatched).toEqual([expect.objectContaining({ cursor: item!.cursor, inputId: res.inputId, sessionKey: 'R1', by: 'host:xwo' })]);

    // Again (even to another session): the first outcome, nothing delivered.
    expect(await h.inboundRedispatch({ cursor: item!.cursor, session: { key: 'R2' } })).toMatchObject({ sessionKey: 'R1', duplicate: true });
    const both = await Promise.all([h.inboundRedispatch({ cursor: item!.cursor }), h.inboundRedispatch({ cursor: item!.cursor })]);
    expect(both.every((b) => b.duplicate)).toBe(true);
    await new Promise((res) => setTimeout(res, 50));
    expect(inputs).toHaveLength(1);
    // It does not ack the item.
    expect(w.gw.hostQueue.cursor('any')).toBe(0);
  });

  it('concurrent first requests deliver once #HQ-4', async () => {
    const { w, h, inputs } = await world();
    await w.chat.inject({ id: 'm2', sender: bob, text: 'xwo twice' });
    const [item] = (await h.inboundRead({ consumer: 'any', after: 0 })).items;
    const rs = await Promise.all([h.inboundRedispatch({ cursor: item!.cursor, session: { key: 'C1' } }), h.inboundRedispatch({ cursor: item!.cursor, session: { key: 'C1' } })]);
    expect(rs.map((x) => x.duplicate).sort()).toEqual([false, true]);
    await until(() => inputs.length === 1);
    await new Promise((res) => setTimeout(res, 50));
    expect(inputs).toHaveLength(1);
  });

  it('default session is the per-conversation one; errors before delivery: unknown cursor, unknown agent, bad scope, task run key #HQ-4', async () => {
    const { w, h } = await world();
    await w.chat.inject({ id: 'm3', sender: bob, conversation: { id: 'g9', kind: 'group' }, text: 'xwo hello' });
    const [item] = (await h.inboundRead({ consumer: 'any', after: 0 })).items;
    await expect(h.inboundRedispatch({ cursor: 999 })).rejects.toMatchObject({ code: 'unknown_cursor' });
    await expect(h.inboundRedispatch({ cursor: item!.cursor, agent: 'nobody' })).rejects.toMatchObject({ code: 'unknown_agent' });
    await expect(h.call('inbound.redispatch', { cursor: item!.cursor, session: 'sideways' })).rejects.toMatchObject({ code: 'invalid_frame' });
    // A task run session is run.start's (like session.prepare): a clean invalid_frame, live run or not.
    await expect(h.inboundRedispatch({ cursor: item!.cursor, session: { key: 'run:r1' } })).rejects.toMatchObject({ code: 'invalid_frame' });
    expect(w.gw.hostQueue.redispatched(item!.cursor)).toBeUndefined();
    const ok = await h.inboundRedispatch({ cursor: item!.cursor });
    expect(ok.duplicate).toBe(false);
    expect(ok.sessionKey).toContain('g9');
  });

  it('a delivery refused by the session is not recorded: a retry elsewhere (with a launch) goes through; agent_conflict; the result names the session\'s own agent #HQ-4 #LA-1', async () => {
    const dir = tmp();
    for (const d of ['a', 'b']) mkdirSync(join(dir, d), { recursive: true });
    const { w, h, inputs } = await world({
      agents: { chat: { harness: 'claude-code' }, dev: { harness: 'claude-code', sessionParams: { cwdRoots: [dir], envKeys: [] } } },
      defaultAgent: 'chat',
    });
    await w.chat.inject({ id: 'm5', sender: bob, text: 'xwo one' });
    await w.chat.inject({ id: 'm6', sender: bob, text: 'xwo two' });
    const [i1, i2] = (await h.inboundRead({ consumer: 'any', after: 0 })).items;
    await h.call('session.prepare', { sessionKey: 'L1', agent: 'dev', launch: { cwd: join(dir, 'a') } });

    // The session keeps its launch: refused, nothing recorded or delivered.
    await expect(h.inboundRedispatch({ cursor: i1!.cursor, agent: 'dev', session: { key: 'L1' }, launch: { cwd: join(dir, 'b') } })).rejects.toMatchObject({ code: 'launch_conflict' });
    expect(w.gw.hostQueue.redispatched(i1!.cursor)).toBeUndefined();
    const ok = await h.inboundRedispatch({ cursor: i1!.cursor, agent: 'dev', session: { key: 'L2' }, launch: { cwd: join(dir, 'b') } });
    expect(ok).toMatchObject({ sessionKey: 'L2', agent: 'dev', duplicate: false, launch: { cwd: join(dir, 'b'), envKeys: [], outcome: 'applied' } });
    expect(w.gw.hostQueue.redispatched(i1!.cursor)).not.toHaveProperty('pending');

    // A named agent must be the session's; without one, the result says whose session it is.
    await expect(h.inboundRedispatch({ cursor: i2!.cursor, agent: 'chat', session: { key: 'L1' } })).rejects.toMatchObject({ code: 'agent_conflict' });
    expect(w.gw.hostQueue.redispatched(i2!.cursor)).toBeUndefined();
    expect(await h.inboundRedispatch({ cursor: i2!.cursor, session: { key: 'L1' } })).toMatchObject({ sessionKey: 'L1', agent: 'dev', duplicate: false });
    await until(() => inputs.length === 2);
  });

  it('concurrent requests: when the first fails, a waiter tries again with its own arguments #HQ-4', async () => {
    const { w, h, inputs } = await world();
    await w.chat.inject({ id: 'm7', sender: bob, text: 'xwo race' });
    const [item] = (await h.inboundRead({ consumer: 'any', after: 0 })).items;
    const f = (o: Record<string, unknown>) => ({ v: 1, type: 'inbound.redispatch', id: 'x', cursor: item!.cursor, ...o }) as never;
    const [a, b] = await Promise.all([w.gw.redispatch('xwo', f({ agent: 'nobody' })), w.gw.redispatch('xwo', f({ session: { key: 'W1' } }))]);
    expect(a).toMatchObject({ ok: false, code: 'unknown_agent' });
    expect(b).toMatchObject({ ok: true, value: { sessionKey: 'W1', duplicate: false } });
    await until(() => inputs.length === 1);
  });

  it('at most once: a redispatch cut off before its outcome was recorded is reported, never sent again #HQ-4', async () => {
    const { w, h, inputs } = await world();
    const r = await w.chat.inject({ id: 'm8', sender: bob, text: 'xwo crash' });
    const [item] = (await h.inboundRead({ consumer: 'any', after: 0 })).items;
    // What an earlier daemon left when it stopped between the delivery and its record.
    const inputId = `${r.inputId}~r${item!.cursor}`;
    w.gw.hostQueue.recordRedispatch(item!.cursor, { cursor: item!.cursor, of: r.inputId, inputId, sessionKey: 'X1', on: 'dispatch', at: 1, by: 'host:xwo', duplicate: false, pending: true });
    const res = await h.inboundRedispatch({ cursor: item!.cursor, session: { key: 'X2' } });
    expect(res).toMatchObject({ sessionKey: 'X1', inputId, duplicate: true, interrupted: true });
    expect(res).not.toHaveProperty('pending');
    await new Promise((res) => setTimeout(res, 50));
    expect(inputs).toHaveLength(0);
  });

  it('a plain (non-host) connection cannot redispatch #HQ-4', async () => {
    const { w, h } = await world();
    await w.chat.inject({ id: 'm4', sender: bob, text: 'xwo x' });
    const [item] = (await h.inboundRead({ consumer: 'any', after: 0 })).items;
    const c = await w.client();
    await expect(c.call('inbound.redispatch', { cursor: item!.cursor })).rejects.toMatchObject({ code: 'unauthorized' });
  });
});
