import { describe, expect, it } from 'vitest';
import type { Binding, BindingTable, InputRecord } from '@agents-io/protocol';
import { parseCli, redispatchRequest } from '../src/cli.js';
import { daemon, until } from './helpers.js';

/*
 * `inbound.redispatch` (docs/design/inbound-redispatch): a host delivers an item
 * that went to its queue (host offline, a callout timed out…) to a session later,
 * with the origin it was stamped with on arrival.
 */

const hostRule: Binding = { id: 'to-host', match: { channel: 'fake', keywords: ['xwo'] }, on: 'host' };
const table = (bindings: Binding[]): BindingTable => ({ version: 'r1', bindings, identities: [], onHostDown: 'keep' });
// Not an owner: the config's default bindings do not dispatch it, only the host rule takes it.
const bob = { channelUserId: 'bob', evidence: 'platform_signed' as const };

async function world() {
  const inputs: InputRecord[] = [];
  const w = await daemon({
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
  it('delivers a queued item with its original origin, records both sides in explain, and is idempotent per cursor', async () => {
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

  it('concurrent first requests deliver once', async () => {
    const { w, h, inputs } = await world();
    await w.chat.inject({ id: 'm2', sender: bob, text: 'xwo twice' });
    const [item] = (await h.inboundRead({ consumer: 'any', after: 0 })).items;
    const rs = await Promise.all([h.inboundRedispatch({ cursor: item!.cursor, session: { key: 'C1' } }), h.inboundRedispatch({ cursor: item!.cursor, session: { key: 'C1' } })]);
    expect(rs.map((x) => x.duplicate).sort()).toEqual([false, true]);
    await until(() => inputs.length === 1);
    await new Promise((res) => setTimeout(res, 50));
    expect(inputs).toHaveLength(1);
  });

  it('default session is the per-conversation one; errors: unknown cursor, unknown agent, bad scope; a failure is not recorded', async () => {
    const { w, h } = await world();
    await w.chat.inject({ id: 'm3', sender: bob, conversation: { id: 'g9', kind: 'group' }, text: 'xwo hello' });
    const [item] = (await h.inboundRead({ consumer: 'any', after: 0 })).items;
    await expect(h.inboundRedispatch({ cursor: 999 })).rejects.toMatchObject({ code: 'unknown_cursor' });
    await expect(h.inboundRedispatch({ cursor: item!.cursor, agent: 'nobody' })).rejects.toMatchObject({ code: 'unknown_agent' });
    await expect(h.call('inbound.redispatch', { cursor: item!.cursor, session: 'sideways' })).rejects.toMatchObject({ code: 'invalid_frame' });
    const ok = await h.inboundRedispatch({ cursor: item!.cursor });
    expect(ok.duplicate).toBe(false);
    expect(ok.sessionKey).toContain('g9');
  });

  it('a plain (non-host) connection cannot redispatch', async () => {
    const { w, h } = await world();
    await w.chat.inject({ id: 'm4', sender: bob, text: 'xwo x' });
    const [item] = (await h.inboundRead({ consumer: 'any', after: 0 })).items;
    const c = await w.client();
    await expect(c.call('inbound.redispatch', { cursor: item!.cursor })).rejects.toMatchObject({ code: 'unauthorized' });
  });

  it('aio redispatch parses its arguments', () => {
    const r = (argv: string[]) => redispatchRequest(parseCli(['redispatch', ...argv]));
    expect(r(['7'])).toEqual({ cursor: 7 });
    expect(r(['7', '--agent', 'chat', '--session', 'main', '--cwd', '/w', '--env', 'A=1'])).toEqual({ cursor: 7, agent: 'chat', session: 'main', launch: { cwd: '/w', env: { A: '1' } } });
    expect(r(['7', '--session', 'K9'])).toEqual({ cursor: 7, session: { key: 'K9' } });
    expect(r(['7', '--session', '{"key":"K9","agent":"x"}']).session).toEqual({ key: 'K9', agent: 'x' });
    expect(() => r(['x'])).toThrow(/usage/);
  });
});
