import { describe, expect, it } from 'vitest';
import type { FakeTurnScript } from '@agents-io/testkit';
import { FEATURES } from '../src/host.js';
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
