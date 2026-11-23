import { readFileSync, statSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import type { Binding, BindingTable, InboundItem } from '@agents-io/protocol';
import { CommandError } from '../src/client.js';
import { tokenPath } from '../src/token.js';
import { closeAndWait, daemon, until, type World } from './helpers.js';

const hostRule = (o: Partial<Binding> = {}): Binding => ({ id: 'to-host', match: { channel: 'fake', keywords: ['xwo'] }, on: 'host', ...o });
const table = (version: string, bindings: Binding[], o: Partial<BindingTable> = {}): BindingTable => ({ version, bindings, identities: [], ...o });
const alice = { channelUserId: 'alice', evidence: 'platform_signed' as const };

describe('host.hello', () => {
  it('writes a 0600 token file next to the socket; the token is required; frames before hello are refused #HQ-7 #SE-2', async () => {
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

  it('at most one host (consumer / callouts); plain authenticated connections are not limited; the slot frees on disconnect #HQ-6', async () => {
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

  it('the token is fresh per start and the file goes away on stop #HQ-7', async () => {
    const w = await daemon();
    const t1 = w.gw.token;
    await w.stop();
    expect(() => statSync(tokenPath(w.config.socketPath))).toThrow();
    const w2 = await daemon({ dir: w.dir });
    expect(w2.gw.token).not.toBe(t1);
  });
});

describe('bindings.put / get', () => {
  it('installs the host table (routing follows it), persists it, and suspends it while the host is away #HQ-5', async () => {
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

  it('onHostDown keep stays active without a host #HQ-5', async () => {
    const w = await daemon();
    const h = await w.host();
    expect(await h.bindingsPut(table('k1', [hostRule()], { onHostDown: 'keep' }))).toMatchObject({ active: true });
    const r = await w.chat.inject({ sender: alice, conversation: { id: 'g1', kind: 'group' }, text: 'xwo' });
    expect(w.gw.router.explain(r.inputId!)?.matched.map((m) => m.bindingId)).toContain('to-host');
  });

  it('a host table may not target a task agent #RT-1', async () => {
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

  it('push: delivered in order, the cursor moves on { accepted: true }; a refusal is redelivered; unacked items come again after a reconnect #HQ-1', async () => {
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

  it('pull: inbound.read never moves the cursor; inbound.ack does; channel redeliveries are one item #HQ-1 #HQ-2', async () => {
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

  it('an unacked item is pushed again to the same consumer after a daemon restart #HQ-1', async () => {
    const w = await withHostTable();
    const seen: InboundItem[] = [];
    const h = await w.host({ consumer: 'xwo' });
    // The host never answers: the push stays unacked when the daemon stops.
    h.onRequest('inbound', (f) => {
      seen.push(f.item as InboundItem);
      return new Promise(() => {});
    });
    await w.chat.inject({ id: 'r1', sender: alice, text: 'xwo across a restart' });
    await until(() => seen.length === 1);
    await w.stop();
    const w2 = await daemon({ dir: w.dir });
    const again: InboundItem[] = [];
    const h2 = await w2.host({ consumer: 'xwo' });
    h2.onRequest('inbound', (f) => {
      again.push(f.item as InboundItem);
      return { accepted: true };
    });
    await until(() => again.length === 1);
    expect(again[0]).toMatchObject({ cursor: seen[0]!.cursor, channelRef: 'channel:fake/r1' });
    await until(() => w2.gw.hostQueue.cursor('xwo') === seen[0]!.cursor);
  });
});

describe('route callouts', () => {
  const calloutRule: Binding = { id: 'ask', match: { channel: 'fake', keywords: ['triage'] }, on: 'dispatch', callout: { timeoutMs: 80 } };

  it('timeout → onFailure (default host: the durable queue); recorded in explain #HQ-3 #EX-1', async () => {
    const w = await daemon();
    const h = await w.host({ callouts: true });
    await h.bindingsPut(table('c1', [calloutRule]));
    h.onRequest('policy', () => new Promise(() => {}));
    const r = await w.chat.inject({ id: 'c-1', sender: alice, conversation: { id: 'g1', kind: 'group' }, text: 'triage this' });
    const ex = w.gw.router.explain(r.inputId!)!;
    expect(ex.matched.find((m) => m.bindingId === 'ask')).toMatchObject({ on: 'host', callout: { outcome: 'timeout', on: 'host' } });
    expect((await h.inboundRead({ consumer: 'any' })).items.map((i) => i.channelRef)).toEqual(['channel:fake/c-1']);
  });

  it('an answer replaces the rule; no host → no_host and onFailure #HQ-3', async () => {
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
  it('deliver is idempotent per operationId, across a restart too; an unknown channel is an error #DL-2 #RS-1', async () => {
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

  it('a send in flight when the daemon died is settled unknown on the next start (logged in its session) and not sent again #DL-2 #RS-1', async () => {
    const w = await daemon();
    const route = { channel: 'fake', account: 'default', conversationId: 'dm-alice' };
    // What a crash between the in-flight mark and the settlement leaves behind.
    w.gw.records.begin({ operationId: 'host:op-c', sessionKey: 'host:xwo', route, attempts: 1, startedAt: Date.now() });
    await w.stop();
    const w2 = await daemon({ dir: w.dir });
    expect(w2.gw.outbox.get('host:op-c')).toMatchObject({ status: 'unknown', attempts: 1 });
    expect(w2.gw.hub.log.read('host:xwo', 0).map((e) => e.body)).toContainEqual({ t: 'delivery.settled', operationId: 'host:op-c', route, result: 'unknown' });
    const h = await w2.host();
    expect(await h.deliver({ operationId: 'op-c', route, message: { text: 'maybe sent' } })).toMatchObject({ status: 'unknown', duplicate: true });
    expect(w2.chat.sent).toHaveLength(0);
  });

  // Regression (core-slimming G10, was `it.fails`): the settled record used to commit before delivery.settled was written, and nothing recovered it.
  it('a settlement that fails after its record and before delivery.settled leaves nothing settled: the next start settles it unknown in its session, indexed, and does not send again #DL-1 #DL-2 #EX-2', async () => {
    const w = await daemon();
    const route = { channel: 'fake', account: 'default', conversationId: 'dm-alice' };
    let calls = 0;
    const send = w.chat.send.bind(w.chat);
    w.chat.send = (r, m, op) => (calls++, send(r, m, op));
    // From here on this process's log refuses delivery.settled (a disk error; a crash at this point is the same).
    const log = w.gw.hub.log;
    const append = log.append.bind(log);
    log.append = (key, d) => {
      if (d.body.t === 'delivery.settled') throw new Error('disk I/O error');
      return append(key, d);
    };
    const h = await w.host();
    await expect(h.deliver({ operationId: 'op-f', route, message: { text: 'sent, settlement lost' } })).rejects.toThrow('disk I/O error');
    // The send worked: the adapter is not called again because the settlement failed.
    expect(calls).toBe(1);
    expect(log.read('host:xwo', 0).filter((e) => e.body.t === 'delivery.settled')).toEqual([]);
    await w.stop();
    const w2 = await daemon({ dir: w.dir });
    expect(w2.gw.hub.log.read('host:xwo', 0).map((e) => e.body)).toContainEqual({ t: 'delivery.settled', operationId: 'host:op-f', route, result: 'unknown' });
    expect(w2.gw.outbox.get('host:op-f')).toMatchObject({ status: 'unknown' });
    expect(w2.gw.records.outboundByOperation('host:op-f')).toMatchObject({ sessionKey: 'host:xwo', result: 'unknown' });
    expect(await (await w2.host()).deliver({ operationId: 'op-f', route, message: { text: 'again' } })).toMatchObject({ status: 'unknown', duplicate: true });
    expect(w2.chat.sent).toHaveLength(0);
  });

  it('a settlement whose outbound index cannot be written fails whole: the host gets internal, explain knows nothing; the same operationId again is unknown, says why, and is not sent again #DL-1 #DL-2 #EX-2', async () => {
    const w = await daemon();
    const route = { channel: 'fake', account: 'default', conversationId: 'dm-alice' };
    let calls = 0;
    const send = w.chat.send.bind(w.chat);
    w.chat.send = (r, m, op) => (calls++, send(r, m, op));
    // The index write fails once (the disk is full).
    const records = w.gw.records;
    const putOutbound = records.putOutbound.bind(records);
    let full = true;
    records.putOutbound = (r) => {
      if (!full) return putOutbound(r);
      full = false;
      throw new Error('database or disk is full');
    };
    const h = await w.host();
    await expect(h.deliver({ operationId: 'op-g', route, message: { text: 'sent, settlement lost' } })).rejects.toMatchObject({ code: 'internal', message: 'internal: database or disk is full' });
    expect(calls).toBe(1);
    expect(w.gw.outbox.get('host:op-g')).toBeUndefined();
    expect(w.gw.hub.log.read('host:xwo', 0).filter((e) => e.body.t === 'delivery.settled')).toEqual([]);
    await expect(h.explain('host:op-g')).rejects.toMatchObject({ code: 'unknown_input' });
    // The same operationId again, in this process: settled unknown now, nothing sent.
    expect(await h.deliver({ operationId: 'op-g', route, message: { text: 'again' } })).toMatchObject({
      operationId: 'op-g',
      status: 'unknown',
      attempts: 1,
      error: 'recording its outcome failed in this process (database or disk is full); not resent',
      duplicate: false,
    });
    expect(calls).toBe(1);
    expect(w.gw.hub.log.read('host:xwo', 0).filter((e) => e.body.t === 'delivery.settled').map((e) => e.body)).toEqual([{ t: 'delivery.settled', operationId: 'host:op-g', route, result: 'unknown' }]);
    expect(await h.explain('host:op-g')).toMatchObject({ operationId: 'host:op-g', sessionKey: 'host:xwo', inputIds: [], result: 'unknown' });
    expect(await h.deliver({ operationId: 'op-g', route, message: { text: 'and again' } })).toMatchObject({ status: 'unknown', duplicate: true });
    expect(calls).toBe(1);
  });

  it('after the 30-day prune of settled outbox records, the same operationId is not sent again #DL-2', async () => {
    const w = await daemon();
    const route = { channel: 'fake', account: 'default', conversationId: 'dm-alice' };
    await (await w.host()).deliver({ operationId: 'op-old', route, message: { text: 'once' } });
    await w.stop();
    // 31 days pass: age the settled record; the next start prunes at open.
    const db = new DatabaseSync(w.config.logPath);
    db.prepare('UPDATE daemon_outbox SET at = at - ?').run(31 * 86_400_000);
    db.close();
    const w2 = await daemon({ dir: w.dir });
    expect(await (await w2.host()).deliver({ operationId: 'op-old', route, message: { text: 'once' } })).toMatchObject({ status: 'delivered', duplicate: true });
    expect(w2.chat.sent).toHaveLength(0);
  });

  it('stop waits for a send in flight: it settles before the records close #DL-1 #RS-8', async () => {
    const w = await daemon();
    const route = { channel: 'fake', account: 'default', conversationId: 'dm-alice' };
    const send = w.chat.send.bind(w.chat);
    let started = false;
    w.chat.send = async (r, m, op) => {
      started = true;
      await new Promise((res) => setTimeout(res, 300));
      return send(r, m, op);
    };
    const h = await w.host();
    void h.deliver({ operationId: 'op-s', route, message: { text: 'slow' } }).catch(() => undefined);
    await until(() => started);
    await w.stop();
    expect(w.chat.sent).toHaveLength(1);
    const w2 = await daemon({ dir: w.dir });
    expect(w2.gw.outbox.get('host:op-s')).toMatchObject({ status: 'delivered' });
    expect(w2.gw.records.allInFlight()).toEqual([]);
  });

  it('input.verify answers the platform author and evidence the channel reported, and the principal it was stamped with; unknown refs are not found #EX-4 #ID-4', async () => {
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

  it('explain returns the routing record of an input; unknown ids are an error #EX-1', async () => {
    const w = await daemon();
    const r = await w.chat.inject({ sender: alice, text: 'hi' });
    const h = await w.host();
    const ex = await h.explain(r.inputId!);
    expect(ex).toMatchObject({
      inputId: r.inputId,
      principal: 'fake:alice',
      matched: [
        { bindingId: 'default:owner-dm', source: 'config', on: 'dispatch' },
        { bindingId: 'default:observe-dm', source: 'config', on: 'context' },
      ],
    });
    await expect(h.explain('in_nope')).rejects.toBeInstanceOf(CommandError);
  });

  it('explain by the operationId of an output-tool send returns the turnId and that turn\'s inputIds #EX-2', async () => {
    const holder: { w?: World } = {};
    const w = await daemon({
      raw: { outputTools: true },
      script: async (t) => {
        await mcpCall(holder.w!.harness.sessions.at(-1)!.args.mcp, 'send_message', { route: 'current', text: 'side effect' }, 'toolu_ex2');
        t.emit({ t: 'text.snapshot', text: 'done', final: true }, { audience: 'answer' });
      },
    });
    holder.w = w;
    const r = await w.chat.inject({ sender: alice, text: 'do it' });
    await until(() => w.chat.sent.some((s) => s.msg.text === 'side effect'));
    const started = w.gw.hub.log.read('fake:default:c1', 0).find((e) => e.body.t === 'turn.started')!.body as { turnId: string; inputIds: string[] };
    expect(started.inputIds).toEqual([r.inputId]);
    const ex = await (await w.host()).explain('tool:fake:default:c1:toolu_ex2');
    expect(ex).toMatchObject({ turnId: started.turnId, inputIds: [r.inputId] });
  });
});

/** What a harness does with HarnessOpenArgs.mcp: a JSON-RPC tools/call over streamable HTTP. */
async function mcpCall(mcp: { url: string; token: string } | undefined, name: string, args: Record<string, unknown>, callId: string) {
  if (!mcp) throw new Error('no mcp mounted');
  const res = await fetch(mcp.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${mcp.token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args, _meta: { 'claudecode/toolUseId': callId } } }),
  });
  const body = (await res.json()) as { result: { isError?: boolean; content: { text: string }[] } };
  return { isError: !!body.result.isError, text: body.result.content[0]!.text };
}
