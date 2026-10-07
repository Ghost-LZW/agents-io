import { readFileSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Binding, BindingTable, InboundItem } from '@agents-io/protocol';
import { CommandError } from '../src/client.js';
import { tokenPath } from '../src/token.js';
import { closeAndWait, daemon, until } from './helpers.js';

const hostRule = (o: Partial<Binding> = {}): Binding => ({ id: 'to-host', match: { channel: 'fake', keywords: ['xwo'] }, on: 'host', ...o });
const table = (version: string, bindings: Binding[], o: Partial<BindingTable> = {}): BindingTable => ({ version, bindings, identities: [], ...o });
const alice = { channelUserId: 'alice', evidence: 'platform_signed' as const };

describe('host.hello', () => {
  it('writes a 0600 token file next to the socket; the token is required; frames before hello are refused', async () => {
    const w = await daemon();
    const tp = tokenPath(w.config.socketPath);
    expect(statSync(tp).mode & 0o777).toBe(0o600);
    expect(readFileSync(tp, 'utf8').trim()).toBe(w.gw.token);
    const c = await w.client();
    await expect(c.explain('x')).rejects.toMatchObject({ code: 'unauthorized' });
    await expect(c.hello({ token: 'nope', name: 'xwo' })).rejects.toMatchObject({ code: 'unauthorized' });
    const r = await c.hello({ token: w.gw.token, name: 'xwo' });
    expect(r).toMatchObject({ name: 'xwo', host: false, bindings: { version: null, active: false } });
    await expect(c.hello({ token: w.gw.token, name: 'again' })).rejects.toMatchObject({ code: 'already_authenticated' });
    // Client frames still work on a host connection.
    expect(Array.isArray(await c.sessions())).toBe(true);
  });

  it('at most one host (consumer / callouts); plain authenticated connections are not limited; the slot frees on disconnect', async () => {
    const w = await daemon();
    const h1 = await w.host({ consumer: 'xwo' });
    expect(w.gw.router.hostConnected).toBe(true);
    const other = await w.client();
    await expect(other.hello({ token: w.gw.token, name: 'b', callouts: true })).rejects.toMatchObject({ code: 'host_connected' });
    const tool1 = await w.host();
    const tool2 = await w.host();
    expect(await tool1.inboundRead({ consumer: 'x' })).toMatchObject({ items: [] });
    expect(await tool2.bindingsGet()).toMatchObject({ host: null, hostConnected: true });
    await closeAndWait(w.gw, h1);
    expect(w.gw.router.hostConnected).toBe(false);
    const h2 = await w.host({ callouts: true });
    expect(w.gw.host.hostPeer()).toBeDefined();
    await closeAndWait(w.gw, h2);
  });

  it('the token is fresh per start and the file goes away on stop', async () => {
    const w = await daemon();
    const t1 = w.gw.token;
    await w.stop();
    expect(() => statSync(tokenPath(w.config.socketPath))).toThrow();
    const w2 = await daemon({ dir: w.dir });
    expect(w2.gw.token).not.toBe(t1);
  });
});

describe('bindings.put / get', () => {
  it('installs the host table (routing follows it), persists it, and suspends it while the host is away', async () => {
    const w = await daemon();
    const h = await w.host({ consumer: 'xwo' });
    h.onRequest('inbound', () => ({ accepted: true }));
    const put = await h.bindingsPut(table('v1', [hostRule()]));
    expect(put).toMatchObject({ version: 'v1', changed: true, active: true });
    expect(await h.bindingsPut(table('v1', [hostRule()]))).toMatchObject({ changed: false });
    await expect(h.bindingsPut(table('v2', [{ id: 'x', match: {}, on: 'dispatch', agent: 'nobody' }]))).rejects.toMatchObject({ code: 'unknown_agent' });
    expect((await h.bindingsGet()).host?.table.version).toBe('v1');

    const r1 = await w.chat.inject({ sender: alice, conversation: { id: 'g1', kind: 'group' }, text: 'xwo please' });
    expect(w.gw.router.explain(r1.inputId!)?.matched.map((m) => m.bindingId)).toContain('to-host');
    await closeAndWait(w.gw, h);
    expect(w.gw.router.hostTable()).toMatchObject({ active: false, suspended: 'host_down' });
    const r2 = await w.chat.inject({ sender: alice, conversation: { id: 'g1', kind: 'group' }, text: 'xwo again' });
    expect(w.gw.router.explain(r2.inputId!)?.matched.map((m) => m.bindingId)).not.toContain('to-host');

    // Restart: the table is still there, suspended until a host connects.
    await w.stop();
    const w2 = await daemon({ dir: w.dir });
    expect(w2.gw.router.hostTable()).toMatchObject({ table: { version: 'v1' }, active: false });
    const h2 = await w2.host({ callouts: true });
    expect((await h2.bindingsGet()).host).toMatchObject({ active: true });
    await closeAndWait(w2.gw, h2);
  });

  it('onHostDown keep stays active without a host', async () => {
    const w = await daemon();
    const h = await w.host();
    expect(await h.bindingsPut(table('k1', [hostRule()], { onHostDown: 'keep' }))).toMatchObject({ active: true });
    const r = await w.chat.inject({ sender: alice, conversation: { id: 'g1', kind: 'group' }, text: 'xwo' });
    expect(w.gw.router.explain(r.inputId!)?.matched.map((m) => m.bindingId)).toContain('to-host');
  });

  it('a host table may not target a task agent', async () => {
    const w = await daemon({ raw: { agents: { chat: { harness: 'claude-code' }, exec: { harness: 'claude-code', mode: 'task' } } } });
    const h = await w.host();
    await expect(h.bindingsPut(table('t', [{ id: 'bad', match: {}, on: 'dispatch', agent: 'exec' }]))).rejects.toMatchObject({ code: 'task_agent' });
  });
});

describe('host inbound queue', () => {
  async function withHostTable() {
    const w = await daemon();
    const admin = await w.host();
    await admin.bindingsPut(table('q1', [hostRule()], { onHostDown: 'keep' }));
    return w;
  }

  it('push: delivered in order, the cursor moves on { accepted: true }; a refusal is redelivered; unacked items come again after a reconnect', async () => {
    const w = await withHostTable();
    const got: InboundItem[] = [];
    let refuseOnce = true;
    const h = await w.host({ consumer: 'xwo' });
    h.onRequest('inbound', (f) => {
      const item = f.item as InboundItem;
      if (refuseOnce) {
        refuseOnce = false;
        return { accepted: false };
      }
      got.push(item);
      return { accepted: true };
    });
    await w.chat.inject({ id: 'm1', sender: alice, text: 'xwo one' });
    await w.chat.inject({ id: 'm2', sender: alice, text: 'xwo two' });
    await until(() => got.length === 2);
    expect(got.map((i) => i.channelRef)).toEqual(['channel:fake/m1', 'channel:fake/m2']);
    expect(got[0]!.input.origin.principal?.id).toBe('fake:alice');
    expect(w.gw.hostQueue.cursor('xwo')).toBe(got[1]!.cursor);

    // A host that never answers: the item stays, and comes again on the next connection.
    h.onRequest('inbound', () => new Promise(() => {}));
    await w.chat.inject({ id: 'm3', sender: alice, text: 'xwo three' });
    await until(() => w.gw.hostQueue.head() === got[1]!.cursor + 1);
    await closeAndWait(w.gw, h);
    expect(w.gw.hostQueue.cursor('xwo')).toBe(got[1]!.cursor);
    const again: InboundItem[] = [];
    const h2 = await w.host({ consumer: 'xwo' });
    h2.onRequest('inbound', (f) => {
      again.push(f.item as InboundItem);
      return { accepted: true };
    });
    await until(() => again.length === 1);
    expect(again[0]!.channelRef).toBe('channel:fake/m3');
    await until(() => w.gw.hostQueue.cursor('xwo') === again[0]!.cursor);
    await closeAndWait(w.gw, h2);
  });

  it('pull: inbound.read never moves the cursor; inbound.ack does; channel redeliveries are one item', async () => {
    const w = await withHostTable();
    await w.chat.inject({ id: 'p1', sender: alice, text: 'xwo a' });
    await w.chat.inject({ id: 'p1', sender: alice, text: 'xwo a' }); // the channel redelivers
    await w.chat.inject({ id: 'p2', sender: alice, text: 'xwo b' });
    const t = await w.host({ name: 'tail' });
    const r1 = await t.inboundRead({ consumer: 'xwo' });
    expect(r1.items.map((i) => i.channelRef)).toEqual(['channel:fake/p1', 'channel:fake/p2']);
    expect(r1.acked).toBe(0);
    expect((await t.inboundRead({ consumer: 'xwo' })).items).toHaveLength(2);
    expect(await t.inboundAck('xwo', r1.items[0]!.cursor)).toMatchObject({ acked: r1.items[0]!.cursor });
    expect((await t.inboundRead({ consumer: 'xwo' })).items.map((i) => i.channelRef)).toEqual(['channel:fake/p2']);
    expect((await t.inboundRead({ consumer: 'xwo', after: r1.items[1]!.cursor, waitMs: 50 })).items).toEqual([]);
    // Long poll: an item arriving while waiting answers the read.
    const waiting = t.inboundRead({ consumer: 'xwo', after: r1.items[1]!.cursor, waitMs: 5000 });
    await w.chat.inject({ id: 'p3', sender: alice, text: 'xwo c' });
    expect((await waiting).items.map((i) => i.channelRef)).toEqual(['channel:fake/p3']);
  });
});

describe('route callouts', () => {
  const calloutRule: Binding = { id: 'ask', match: { channel: 'fake', keywords: ['triage'] }, on: 'dispatch', callout: { timeoutMs: 80 } };

  it('timeout → onFailure (default host: the durable queue); recorded in explain', async () => {
    const w = await daemon();
    const h = await w.host({ callouts: true });
    await h.bindingsPut(table('c1', [calloutRule]));
    h.onRequest('policy', () => new Promise(() => {}));
    const r = await w.chat.inject({ id: 'c-1', sender: alice, conversation: { id: 'g1', kind: 'group' }, text: 'triage this' });
    const ex = w.gw.router.explain(r.inputId!)!;
    expect(ex.matched.find((m) => m.bindingId === 'ask')).toMatchObject({ on: 'host', callout: { outcome: 'timeout', on: 'host' } });
    expect((await h.inboundRead({ consumer: 'any' })).items.map((i) => i.channelRef)).toEqual(['channel:fake/c-1']);
  });

  it('an answer replaces the rule; no host → no_host and onFailure', async () => {
    const w = await daemon();
    const h = await w.host({ callouts: true });
    await h.bindingsPut(table('c2', [{ ...calloutRule, callout: { timeoutMs: 1000, onFailure: 'drop' } }], { onHostDown: 'keep' }));
    const asked: unknown[] = [];
    h.onRequest('policy', (f) => {
      asked.push(f);
      return { on: 'context', session: { key: 'triaged' } };
    });
    const r = await w.chat.inject({ sender: alice, conversation: { id: 'g1', kind: 'group' }, text: 'triage me' });
    expect(asked[0]).toMatchObject({ hook: 'route', args: { bindingId: 'ask', input: { inputId: r.inputId } } });
    expect(w.gw.router.explain(r.inputId!)!.matched.find((m) => m.bindingId === 'ask')).toMatchObject({ on: 'context', sessionKey: 'triaged', callout: { outcome: 'answered' } });
    await closeAndWait(w.gw, h);
    const r2 = await w.chat.inject({ sender: alice, conversation: { id: 'g1', kind: 'group' }, text: 'triage me again' });
    expect(w.gw.router.explain(r2.inputId!)!.matched.find((m) => m.bindingId === 'ask')).toMatchObject({ on: 'drop', callout: { outcome: 'no_host', on: 'drop' } });
  });
});

describe('deliver, input.verify, explain', () => {
  it('deliver is idempotent per operationId, across a restart too; an unknown channel is an error', async () => {
    const w = await daemon();
    const h = await w.host();
    const route = { channel: 'fake', account: 'default', conversationId: 'dm-alice' };
    const d1 = await h.deliver({ operationId: 'op-1', route, message: { text: 'hello from the host' } });
    expect(d1).toMatchObject({ operationId: 'op-1', status: 'delivered', duplicate: false });
    expect(await h.deliver({ operationId: 'op-1', route, message: { text: 'hello from the host' } })).toMatchObject({ status: 'delivered', duplicate: true });
    expect(w.chat.sent.filter((s) => s.msg.text === 'hello from the host')).toHaveLength(1);
    await expect(h.deliver({ operationId: 'op-2', route: { ...route, channel: 'nope' }, message: { text: 'x' } })).rejects.toMatchObject({ code: 'unknown_channel' });
    await w.stop();
    const w2 = await daemon({ dir: w.dir });
    const h2 = await w2.host();
    expect(await h2.deliver({ operationId: 'op-1', route, message: { text: 'hello from the host' } })).toMatchObject({ duplicate: true });
    expect(w2.chat.sent).toHaveLength(0);
  });

  it('input.verify answers the platform author and evidence the channel reported, and the principal it was stamped with; unknown refs are not found', async () => {
    const w = await daemon();
    await w.chat.inject({ id: 'v1', sender: { ...alice, displayName: 'Alice' }, text: 'confirm' });
    await w.chat.inject({ id: 'v2', sender: { channelUserId: 'alice', evidence: 'none' }, text: 'forged?' });
    const h = await w.host();
    const v1 = await h.verify('channel:fake/v1');
    expect(v1).toMatchObject({ found: true, records: [{ author: { channelUserId: 'alice', displayName: 'Alice' }, evidence: 'platform_signed', principal: 'fake:alice', labels: ['owner'], kind: 'human' }] });
    // Mapped id without enough evidence: not the member.
    expect((await h.verify('channel:fake/v2')).records[0]).toMatchObject({ evidence: 'none', principal: null });
    expect(await h.verify('channel:fake/never')).toEqual({ channelRef: 'channel:fake/never', found: false, records: [] });
    // Survives a restart (same database).
    await w.stop();
    const w2 = await daemon({ dir: w.dir });
    expect((await (await w2.host()).verify('channel:fake/v1')).found).toBe(true);
  });

  it('explain returns the routing record of an input; unknown ids are an error', async () => {
    const w = await daemon();
    const r = await w.chat.inject({ sender: alice, text: 'hi' });
    const h = await w.host();
    const ex = await h.explain(r.inputId!);
    expect(ex).toMatchObject({ inputId: r.inputId, principal: 'fake:alice', matched: [{ bindingId: 'default:owner-dm', source: 'config', on: 'dispatch' }] });
    await expect(h.explain('in_nope')).rejects.toBeInstanceOf(CommandError);
  });
});
