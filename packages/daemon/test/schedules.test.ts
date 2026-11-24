import { describe, expect, it } from 'vitest';
import type { ModuleManifest } from '@agents-io/protocol';
import type { FakeTurnScript } from '@agents-io/testkit';
import { FEATURES } from '../src/host.js';
import { ModuleRegistry } from '../src/modules.js';
import { daemon, until } from './helpers.js';

// Config schedules reach their session as a turn, survive a restart, and a host schedule lands in the host queue.

const text = (i: { content: { type: string; text?: string }[] }) => i.content.map((c) => (c.type === 'text' ? c.text : '')).join(' ');

describe('config schedules', () => {
  it('fire a turn in their session at their time; their next time survives a restart #SC-1', async () => {
    const seen: string[] = [];
    const script: FakeTurnScript = async (t) => {
      seen.push(...t.inputs.map(text));
      t.emit({ t: 'text.snapshot', text: 'ok', final: true }, { audience: 'answer' });
    };
    const at = Date.now() + 400;
    const raw = {
      agents: { chat: { harness: 'claude-code' } },
      schedules: [{ id: 'soon', when: { at }, target: { sessionKey: 'main' }, text: 'look at the calendar' }],
    };
    const w = await daemon({ raw, script });
    await until(() => seen.length > 0, 5000);
    expect(seen).toEqual(['[schedule soon] look at the calendar']);
    // A one-shot is gone once fired, so a restart on the same data does not fire it again.
    const dir = w.dir;
    await w.stop();
    const again = await daemon({ raw: { ...raw, schedules: [] }, script, dir });
    expect(again.gw.schedules.registry.list()).toEqual([]);
    await new Promise((r) => setTimeout(r, 300));
    expect(seen).toHaveLength(1);
  });

  it('a host schedule puts one item into the host queue #SC-1 #HQ-2', async () => {
    const at = Date.now() + 300;
    const w = await daemon({ raw: { schedules: [{ id: 'nudge', when: { at }, action: 'host', text: 'time to sync' }] } });
    const t = await w.host({ name: 'tail' });
    // Long-poll: the item arrives when the schedule fires.
    const { items } = await t.inboundRead({ consumer: 'pull', waitMs: 5000 });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ bindingId: 'schedule:nudge', channelRef: expect.stringMatching(/^schedule:schedule:nudge:\d+$/) });
    expect(text(items[0]!.input)).toBe('[schedule nudge] time to sync');
  });

  // INVARIANTS SC-1 不成立 (2026-11-24): the schedules stop after the modules; a firing due meanwhile fails (the modules are stopping) and is redone at once, again and again.
  it('a schedule due while the daemon stops is not fired then (the schedules stop before the modules); the next start fires it, once #SC-1', async () => {
    // A module that takes a while to stop: the daemon stops its modules for 800 ms.
    const slow: ModuleManifest<undefined> = { id: 'slow', kind: 'feature', setup: () => ({ stop: () => new Promise<void>((r) => setTimeout(r, 800)) }) };
    const moduleRegistry = new ModuleRegistry([slow]);
    const logs: string[] = [];
    const w = await daemon({ moduleRegistry, gateway: { logger: (_level, msg) => logs.push(msg) } });
    const route = { channel: 'fake', account: 'default', conversationId: 'dm-alice' };
    w.gw.schedules.registry.put({ id: 'note', when: { at: Date.now() + 200 }, action: 'message', route, text: 'a note' }, 'config');
    w.gw.schedules.changed();
    await w.stop();
    expect(logs.filter((m) => m.includes('schedule note'))).toEqual([]);
    expect(w.chat.sent).toEqual([]);
    // Due 600 ms ago at the next start (not missed): fired then, once.
    const again = await daemon({ dir: w.dir, moduleRegistry });
    await until(() => again.chat.sent.length > 0, 5000);
    await new Promise((r) => setTimeout(r, 200));
    expect(again.chat.sent.map((s) => [s.route.conversationId, s.msg.text])).toEqual([['dm-alice', 'a note']]);
    expect(again.gw.schedules.registry.get('note')).toBeUndefined();
  });

  it('a malformed config schedule is logged and skipped, the others load #SC-1', async () => {
    const w = await daemon({
      raw: {
        schedules: [
          { id: 'bad', when: { cron: '0 9 * *' }, target: { sessionKey: 'main' }, text: 'x' },
          { id: 'good', when: { cron: '0 9 * * *' }, target: { sessionKey: 'main' }, text: 'y' },
        ],
      },
    });
    expect(w.gw.schedules.registry.list().map((s) => s.id)).toEqual(['good']);
  });
});

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

describe('schedule tools', () => {
  it("an agent sets a reminder for its own session, which comes back to it as a turn; it lists and removes only its own #SC-3", async () => {
    const results: { isError: boolean; text: string }[] = [];
    const seen: string[] = [];
    const holder: { w?: Awaited<ReturnType<typeof daemon>> } = {};
    const script: FakeTurnScript = async (t) => {
      const said = t.inputs.map(text).join(' ');
      seen.push(said);
      const mcp = holder.w!.harness.sessions.at(-1)!.args.mcp;
      if (said.includes('remind me')) {
        results.push(await mcpCall(mcp, 'schedule_add', { id: 'tea', when: { at: Date.now() + 500 }, text: 'the tea is ready' }, 'c1'));
        results.push(await mcpCall(mcp, 'schedule_add', { when: { at: Date.now() + 500 }, text: 'elsewhere', target: { sessionKey: 'other' } }, 'c2'));
        results.push(await mcpCall(mcp, 'schedule_add', { when: { every_minutes: 1 }, text: 'poll' }, 'c3'));
        results.push(await mcpCall(mcp, 'schedule_list', {}, 'c4'));
        results.push(await mcpCall(mcp, 'get_channel_context', {}, 'c5'));
      }
      t.emit({ t: 'text.snapshot', text: 'ok', final: true }, { audience: 'answer' });
    };
    const w = await daemon({ raw: { agents: { chat: { harness: 'claude-code', tools: true } }, policy: { owners: ['fake:alice'], scheduleMinMinutes: 5 } }, script });
    holder.w = w;
    await w.chat.inject({ sender: { channelUserId: 'alice', evidence: 'platform_signed' }, text: 'remind me in a moment' });
    await until(() => results.length === 5, 5000);
    const [added, elsewhere, tooOften, listed, ctx] = results;
    expect(added!.isError).toBe(false);
    expect(JSON.parse(added!.text).schedule).toMatchObject({ id: 'tea', action: 'turn', mine: true });
    // A target is not an argument of the tool (the schema drops it): the schedule is the caller's own all the same.
    expect(JSON.parse(elsewhere!.text).schedule.target).toEqual({ sessionKey: 'fake:default:c1' });
    expect(tooOften).toMatchObject({ isError: true, text: expect.stringMatching(/every 1 minutes; the owner's minimum is 5/) });
    expect(JSON.parse(listed!.text).schedules.map((s: { id: string }) => s.id)).toContain('tea');
    expect(JSON.parse(ctx!.text).abilities).toMatchObject({ tools: expect.arrayContaining(['schedule_add', 'send_message']), schedules: { mine: 2 } });
    // At its time the reminder comes back to the same session, as a turn.
    await until(() => seen.some((s) => s === '[schedule tea] the tea is ready'), 5000);
    // Someone else's schedule is not the agent's to remove.
    w.gw.schedules.registry.put({ id: 'owners', when: { cron: '0 9 * * *' }, target: { sessionKey: 'main' }, text: 'x' }, 'config');
    const removal = await w.gw.removeSchedule({ kind: 'agent', principal: null, evidence: 'daemon', declared: 'session:someone', via: 'agent:someone', adapter: 'agent' }, 'owners');
    expect(removal).toMatchObject({ ok: false, code: 'forbidden' });
  });
});

/** What an `outbound` callout was asked: what, to where, with which text, from which session and turn. */
interface Asked {
  kind?: string;
  to: { conversationId: string };
  content?: { text?: string };
  from: { sessionKey: string; turnId: string; replyRoute: unknown; inputs: { inputId: string; origin: { kind: string; via: string } }[] } | null;
}

describe("an agent's message schedule and the host's outbound checks", () => {
  // INVARIANTS DL-7 / DL-5 / SC-3 不成立 (2026-11-24): schedule_add is not asked of an outbound + outbound.content host, and its firing is not checked.
  it('outbound + outbound.content host without a scope: schedule_add is asked with the content, as send_message is, and refused where the host denies; what it allowed is asked again as it fires, as the agent\'s send then: held there, not sent #DL-7 #DL-5 #SC-3', async () => {
    const results: { isError: boolean; text: string }[] = [];
    const holder: { w?: Awaited<ReturnType<typeof daemon>> } = {};
    const script: FakeTurnScript = async (t) => {
      const mcp = holder.w!.harness.sessions.at(-1)!.args.mcp;
      if (t.inputs.some((i) => text(i).includes('go'))) {
        const at = Date.now() + 700;
        results.push(await mcpCall(mcp, 'schedule_add', { id: 'leak', action: 'message', route: 'fake:default:ops', when: { at }, text: 'the secret, to ops' }, 'c1'));
        results.push(await mcpCall(mcp, 'send_message', { route: 'fake:default:ops', text: 'the secret, direct' }, 'c2'));
        results.push(await mcpCall(mcp, 'schedule_add', { id: 'later', action: 'message', route: 'fake:default:team', when: { at }, text: 'fine for now' }, 'c3'));
        results.push(await mcpCall(mcp, 'schedule_add', { id: 'here', action: 'message', when: { at }, text: 'back here' }, 'c4'));
      }
      t.emit({ t: 'text.snapshot', text: 'ok', final: true }, { audience: 'answer' });
    };
    const w = await daemon({ raw: { agents: { chat: { harness: 'claude-code', tools: true } }, policy: { owners: ['fake:alice'] } }, script });
    holder.w = w;
    const h = await w.client();
    await h.hello({ token: w.gw.token, name: 'lb', callouts: ['route', 'outbound', 'outbound.content'] } as never);
    const asked: Asked[] = [];
    let firing = false;
    h.onRequest('policy', (f) => {
      if ((f as { hook: string }).hook !== 'outbound') return { on: 'dispatch' };
      const a = (f as { args: Asked }).args;
      asked.push(a);
      if (a.to.conversationId === 'ops') return { verdict: 'deny', reason: 'never to ops' };
      // The host changed its mind about the team chat after the schedule was set.
      return firing && a.to.conversationId === 'team' ? { verdict: 'hold', reason: 'not any more' } : { verdict: 'allow' };
    });
    await w.chat.inject({ sender: { channelUserId: 'alice', evidence: 'platform_signed' }, text: 'go' });
    await until(() => results.length === 4, 5000);
    firing = true;
    const [leak, direct, later, here] = results;
    // Where the host denies the agent's send_message, its schedule_add is refused the same way: nothing is set.
    expect(direct).toMatchObject({ isError: true, text: expect.stringMatching(/never to ops/) });
    expect(leak).toMatchObject({ isError: true, text: expect.stringMatching(/does not let you send to fake:default:ops/) });
    expect(w.gw.schedules.registry.get('leak')).toBeUndefined();
    expect([later!.isError, here!.isError]).toEqual([false, false]);
    const session = 'fake:default:c1';
    // Each was asked as it was set: kind tool, with the text, from the agent's turn.
    const set = asked.filter((a) => a.from?.turnId !== undefined && !a.from.turnId.startsWith('schedule:'));
    expect(set.map((a) => [a.kind, a.to.conversationId, a.content?.text, a.from?.sessionKey])).toEqual([
      ['tool', 'ops', 'the secret, to ops', session],
      ['tool', 'ops', 'the secret, direct', session],
      ['tool', 'team', 'fine for now', session],
      ['tool', 'c1', 'back here', session],
    ]);
    const nextAt = (id: string) => w.gw.schedules.registry.get(id)!.nextAt!;
    const ops = { later: `schedule:later:${nextAt('later')}`, here: `schedule:here:${nextAt('here')}` };
    const settled = (id: string) => w.gw.hub.log.read(`schedule:${id}`, 0).find((e) => e.body.t === 'delivery.settled')?.body as Record<string, unknown> | undefined;
    await until(() => settled('later') && settled('here'), 5000);
    // As each fired it was asked again, as the agent's send_message would be then: its session, the firing as its turn
    // (one system input, no reply route of its own), kind tool, the text.
    const fired = asked.filter((a) => a.from?.turnId.startsWith('schedule:'));
    expect(fired.map((a) => [a.kind, a.to.conversationId, a.content?.text, a.from?.sessionKey, a.from?.turnId, a.from?.replyRoute])).toEqual(
      expect.arrayContaining([
        ['tool', 'team', 'fine for now', session, ops.later, null],
        ['tool', 'c1', 'back here', session, ops.here, null],
      ]),
    );
    expect(fired).toHaveLength(2);
    expect(fired[0]!.from!.inputs).toEqual([expect.objectContaining({ inputId: fired[0]!.from!.turnId, origin: expect.objectContaining({ kind: 'system', via: expect.stringMatching(/^schedule:/) }) })]);
    // Held at its time: never sent. Allowed: sent, as the agent (DL-4b), and its settlement says it was the agent's message.
    expect(settled('later')).toMatchObject({ operationId: ops.later, result: 'held', reason: 'not any more', kind: 'tool' });
    expect(settled('here')).toMatchObject({ operationId: ops.here, result: 'delivered', kind: 'tool' });
    expect(w.chat.sent.filter((s) => ['ops', 'team'].includes(s.route.conversationId))).toEqual([]);
    const back = w.chat.sent.filter((s) => s.msg.text === 'back here');
    expect(back.map((s) => [s.route.conversationId, s.op.as])).toEqual([['c1', `session:${session}`]]);
  });

  // INVARIANTS DL-7 / SC-3 不成立 (2026-11-24): an agent's scheduled message into a chat in the scope goes out unchecked.
  it("outbound.scoped host: an agent's scheduled message into a chat in its scope is asked with its content as it fires; held, it is not sent. The owner's own schedule there is not asked, and says what it was #DL-7 #SC-3", async () => {
    const results: { isError: boolean; text: string }[] = [];
    const holder: { w?: Awaited<ReturnType<typeof daemon>> } = {};
    const script: FakeTurnScript = async (t) => {
      const mcp = holder.w!.harness.sessions.at(-1)!.args.mcp;
      if (t.inputs.some((i) => text(i).includes('go'))) {
        results.push(await mcpCall(mcp, 'schedule_add', { id: 'leak', action: 'message', when: { at: Date.now() + 600 }, text: 'the secret, scheduled' }, 'c1'));
      }
      t.emit({ t: 'text.snapshot', text: 'the secret, said', final: true }, { audience: 'answer' });
    };
    const g1 = { channel: 'fake', account: 'default', conversationId: 'g1' };
    const raw = {
      agents: { chat: { harness: 'claude-code', tools: true } },
      policy: { owners: ['fake:alice'] },
      schedules: [{ id: 'owners', when: { at: Date.now() + 1500 }, action: 'message', route: g1, text: 'the weekly note' }],
    };
    const w = await daemon({ raw, script });
    holder.w = w;
    const h = await w.client();
    await h.hello({ token: w.gw.token, name: 'lb', callouts: ['route', 'outbound.scoped'], outboundScope: { routes: [g1] } } as never);
    const asked: Asked[] = [];
    h.onRequest('policy', (f) => {
      if ((f as { hook: string }).hook !== 'outbound') return { on: 'dispatch' };
      asked.push((f as { args: Asked }).args);
      return { verdict: 'hold', reason: 'not for this group' };
    });
    await w.chat.inject({ id: 'om_1', sender: { channelUserId: 'alice', evidence: 'platform_signed' }, conversation: { id: 'g1', kind: 'group' }, text: 'go', admission: 'dispatch' });
    await until(() => results.length === 1, 5000);
    expect(results[0]!.isError).toBe(false);
    const op = `schedule:leak:${w.gw.schedules.registry.get('leak')!.nextAt}`;
    const settled = (id: string) => w.gw.hub.log.read(`schedule:${id}`, 0).find((e) => e.body.t === 'delivery.settled')?.body as Record<string, unknown> | undefined;
    await until(() => settled('leak') && settled('owners'), 5000);
    // The turn's answer and the scheduled message were each asked with their content; both held, neither sent.
    expect(asked.map((a) => [a.kind, a.content?.text])).toEqual([
      ['reply', 'the secret, said'],
      ['tool', 'the secret, scheduled'],
    ]);
    expect(asked[1]!.from).toMatchObject({ sessionKey: 'fake:default:g1', turnId: op, replyRoute: null });
    expect(settled('leak')).toMatchObject({ operationId: op, result: 'held', reason: 'not for this group', kind: 'tool' });
    // The owner's configured message is not the agent's: not asked (as before), sent, and its settlement says what it was.
    expect(settled('owners')).toMatchObject({ result: 'delivered', kind: 'notice' });
    expect(w.chat.sent.filter((s) => s.route.conversationId === 'g1').map((s) => s.msg.text)).toEqual(['the weekly note']);
  });
});

describe('host schedule requests', () => {
  it('a host sets, lists and removes schedules; a bad one is invalid_frame; features list schedules #SC-3', async () => {
    const w = await daemon({});
    const t = await w.host({ name: 'herdr' });
    expect(FEATURES).toContain('schedules');
    const put = await t.schedulePut({ id: 'h1', when: { cron: '0 9 * * *', tz: 'Asia/Shanghai' }, action: 'host', text: 'sync' });
    expect(put.schedule).toMatchObject({ id: 'h1', action: 'host', createdBy: 'host:herdr' });
    expect(typeof put.schedule.nextAt).toBe('number');
    expect((await t.scheduleList()).schedules.map((s) => s.id)).toEqual(['h1']);
    await expect(t.schedulePut({ id: 'bad', when: { cron: 'nope' }, action: 'host', text: 'x' })).rejects.toMatchObject({ code: 'invalid_frame' });
    expect(await t.scheduleRemove('h1')).toEqual({ scheduleId: 'h1', removed: true });
    expect((await t.scheduleList()).schedules).toEqual([]);
  });
});
