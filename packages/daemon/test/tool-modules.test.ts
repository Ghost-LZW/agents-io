import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { HarnessOpenArgs, InputRecord, LiveEndpoint, Origin } from '@agents-io/protocol';
import { KERNEL_TOOL_NAMES, TOOL_GROUPS, TOOL_NAMES } from '@agents-io/host-mcp';
import { TOPIC_TOOLS_HINT } from '@agents-io/session';
import { FakeChannel, type FakeHarness } from '@agents-io/testkit';
import { resolveConfig } from '../src/defaults.js';
import { daemon, until, type World } from './helpers.js';
import { bridge, live } from './live-channels-helpers.js';
import { mcpCall } from './output-tools-helpers.js';

/*
 * The watch, schedule, live and topic tools are built-in feature modules (core-slimming G6 step 3,
 * `tool-modules.ts`; the schedule tools since the merge of origin/main): the bundled aio offers what
 * it offered before, and a group that is off is not there at all. The live tools are offered only
 * while a running channel can open a live (ROADMAP §1 principle 2).
 */

const alice = { channelUserId: 'alice', evidence: 'platform_signed' as const };

/** The `tools/list` answers captured before the tools were modules: with the live tools, and without them. */
const FIXTURE = new URL('../../host-mcp/test/fixtures/tools-list.json', import.meta.url);
const FIXTURE_NO_LIVE = new URL('../../host-mcp/test/fixtures/tools-list-no-live.json', import.meta.url);

/** A FakeChannel that can open a live (`ChannelAdapter.openLive`); these tests never join one. */
class LiveChannel extends FakeChannel {
  async openLive(): Promise<LiveEndpoint> {
    throw new Error('no live in these tests');
  }
}

/** The raw `tools/list` answer a harness binding gets. */
async function toolsList(mcp: HarnessOpenArgs['mcp']): Promise<{ tools: { name: string }[] }> {
  const res = await fetch(mcp!.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${mcp!.token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });
  return ((await res.json()) as { result: { tools: { name: string }[] } }).result;
}

/**
 * A daemon whose agent sees one message: what it is offered over MCP and the input's channelContext.
 * `canLive`: its channel `fake` can open a live.
 */
async function offered(raw: Record<string, unknown>, o: { canLive?: boolean } = {}) {
  const holder: { h?: FakeHarness } = {};
  const got: { listed?: { tools: { name: string }[] }; input?: InputRecord } = {};
  const w = await daemon({
    raw,
    ...(o.canLive ? { chat: new LiveChannel('fake') } : {}),
    script: async (t) => {
      const mcp = holder.h!.sessions.at(-1)!.args.mcp;
      got.listed = mcp ? await toolsList(mcp) : { tools: [] };
      got.input = t.inputs[0]!;
      t.emit({ t: 'text.snapshot', text: 'ok', final: true }, { audience: 'answer' });
    },
  });
  holder.h = w.harness;
  await w.chat.inject({ sender: alice, text: 'hello' });
  await until(() => got.input);
  return { w, listed: got.listed!, input: got.input! };
}

describe('the watch, live and topic tools as modules', () => {
  it('the bundled aio offers them, on by default: an agent with tools: true lists the 18 tools byte for byte as before they were modules where a channel can open a live, the same without live_* where none can, and its inputs of a current topic carry the hint #CF-6', async () => {
    const { w, listed, input } = await offered({ outputTools: true }, { canLive: true });
    // The `tools/list` answer captured from the code before the tool catalog existed (packages/host-mcp/test/catalog.test.ts).
    expect(JSON.stringify(listed, null, 2) + '\n').toBe(readFileSync(FIXTURE, 'utf8'));
    expect(listed.tools.map((t) => t.name)).toEqual(TOOL_NAMES);
    // No running channel can open a live (a plain FakeChannel, as the public lark-bot): the same answer without the three.
    const none = await offered({ outputTools: true });
    expect(JSON.stringify(none.listed, null, 2) + '\n').toBe(readFileSync(FIXTURE_NO_LIVE, 'utf8'));
    expect(none.listed.tools.map((t) => t.name)).toEqual(TOOL_NAMES.filter((n) => !n.startsWith('live_')));
    expect(none.w.gw.adminStatus().modules.find((m) => m.id === 'tools.live')).toEqual({ id: 'tools.live', origin: 'builtin', enabled: true });
    expect(input.channelContext.topic).toBeDefined();
    expect(input.channelContext.topicTools).toBe(TOPIC_TOOLS_HINT);
    expect(w.gw.adminStatus().modules.filter((m) => m.id.startsWith('tools.'))).toEqual([
      { id: 'tools.watch', origin: 'builtin', enabled: true },
      { id: 'tools.schedules', origin: 'builtin', enabled: true },
      { id: 'tools.live', origin: 'builtin', enabled: true },
      { id: 'tools.topics', origin: 'builtin', enabled: true },
    ]);
  });

  it('the hint goes to an agent offered a topic tool, as before: its tools list naming one, not one without #CF-6', async () => {
    const agents = (tools: string[]) => ({ outputTools: true, agents: { chat: { harness: 'claude-code', tools } }, defaultAgent: 'chat' });
    const listing = await offered(agents(['send_message', 'session_list']));
    expect(listing.listed.tools.map((t) => t.name)).toEqual(['send_message', 'session_list']);
    expect(listing.input.channelContext.topicTools).toBe(TOPIC_TOOLS_HINT);
    const other = await offered(agents(['send_message', 'watch_list']));
    expect(other.listed.tools.map((t) => t.name)).toEqual(['send_message', 'watch_list']);
    expect(other.input.channelContext.topic).toBeDefined();
    expect(other.input.channelContext).not.toHaveProperty('topicTools');
  });

  it('the watch tools as the module offers them: a watch the agent adds is pinned to its own session and created by its agent identity (a target argument never reaches it), only for an allowlisted source; it removes only its own #CF-7', async () => {
    const holder: { h?: FakeHarness; w?: World } = {};
    const results: { name: string; isError: boolean; text: string }[] = [];
    const owner: Origin = { kind: 'human', principal: { id: 'fake:alice', labels: ['owner'] }, evidence: 'platform_signed', via: 'fake:default:c1', adapter: 'fake' };
    let sessionKey = '';
    const w = await daemon({
      raw: { outputTools: true, policy: { owners: ['fake:alice'], watchAllowlist: [{ channel: 'fake', conversation: 'c-team' }] } },
      script: async (t) => {
        const s = holder.h!.sessions.at(-1)!.args;
        sessionKey = s.sessionKey;
        expect((await holder.w!.gw.addWatch(owner, { id: 'w_owner', source: { channel: 'fake', conversation: 'c-any' }, target: { sessionKey }, mode: 'context' })).ok).toBe(true);
        const call = async (name: string, args: Record<string, unknown>) => results.push({ name, ...(await mcpCall(s.mcp, name, args, `${t.turnId}:${results.length}`)) });
        await call('watch_add', { id: 'w_team', source: { channel: 'fake', conversation: 'c-team' }, mode: 'context', note: 'follow the team' });
        await call('watch_add', { source: { channel: 'fake', conversation: 'c-other' }, mode: 'context' });
        await call('watch_add', { id: 'w_there', source: { channel: 'fake', conversation: 'c-team' }, mode: 'context', target: { sessionKey: 'fake:default:elsewhere' } });
        await call('watch_list', {});
        await call('watch_remove', { id: 'w_owner' });
        await call('watch_remove', { id: 'w_team' });
        t.emit({ t: 'text.snapshot', text: 'ok', final: true }, { audience: 'answer' });
      },
    });
    holder.h = w.harness;
    holder.w = w;
    await w.chat.inject({ sender: alice, text: 'watch the team' });
    await until(() => results.length === 6);
    const [team, other, there, list, theirs, mine] = results;
    expect(team!.isError).toBe(false);
    expect(JSON.parse(team!.text)).toMatchObject({ ok: true, watch: { id: 'w_team', target: { sessionKey }, createdBy: `session:${sessionKey}`, note: 'follow the team', mine: true } });
    expect(other).toMatchObject({ isError: true, text: expect.stringMatching(/is not on the owner's watch allowlist/) });
    expect(JSON.parse(there!.text)).toMatchObject({ ok: true, watch: { id: 'w_there', target: { sessionKey } } });
    expect(JSON.parse(list!.text)).toMatchObject({ ok: true, session: sessionKey, watches: [{ id: 'w_owner', mine: false }, { id: 'w_team', mine: true }, { id: 'w_there', mine: true }] });
    expect(theirs).toMatchObject({ isError: true, text: expect.stringMatching(/you may only remove watches you created/) });
    expect(JSON.parse(mine!.text)).toEqual({ ok: true, removed: true, id: 'w_team' });
    expect(w.gw.listWatches(sessionKey).map((x) => x.id)).toEqual(['w_owner', 'w_there']);
    expect(w.gw.listWatches('fake:default:elsewhere')).toEqual([]);
  });

  it('a group whose section says enabled: false is not there: its tools are not offered (the others are, in order), the topic tools give no hint; naming one of its tools in agents.<name>.tools fails the config, naming the module #CF-6', async () => {
    const groups = [
      ['watchTools', 'tools.watch', TOOL_GROUPS.watch],
      ['scheduleTools', 'tools.schedules', TOOL_GROUPS.schedules],
      ['liveTools', 'tools.live', TOOL_GROUPS.live],
      ['topicTools', 'tools.topics', TOOL_GROUPS.topics],
    ] as const;
    for (const [section, id, names] of groups) {
      // Its channel can open a live: only the group that is off is missing.
      const { w, listed, input } = await offered({ outputTools: true, [section]: { enabled: false } }, { canLive: true });
      expect(listed.tools.map((t) => t.name)).toEqual(TOOL_NAMES.filter((n) => !(names as readonly string[]).includes(n)));
      expect(w.gw.adminStatus().modules.find((m) => m.id === id)).toEqual({ id, origin: 'builtin', enabled: false });
      if (section === 'topicTools') expect(input.channelContext).not.toHaveProperty('topicTools');
      else expect(input.channelContext.topicTools).toBe(TOPIC_TOOLS_HINT);
      await w.stop();
      const resolve = (tools: string[]) => resolveConfig({ [section]: { enabled: false }, agents: { chat: { harness: 'claude-code', tools } }, defaultAgent: 'chat' }, { env: {}, baseDir: '/base', cwd: '/work' });
      expect(() => resolve(['send_message', names[0]])).toThrow(`agents.chat.tools: "${names[0]}" is a tool of module ${id}, which is off`);
      // An unknown name's error lists the tools there are: the kernel's, then the groups that are on.
      expect(() => resolve(['nope'])).toThrow(`agents.chat.tools: unknown tool "nope" (tools: ${TOOL_NAMES.filter((n) => !(names as readonly string[]).includes(n)).join(', ')})`);
    }
    // All four off: the kernel's own six, nothing else.
    const { listed, input } = await offered({ outputTools: true, watchTools: { enabled: false }, scheduleTools: { enabled: false }, liveTools: { enabled: false }, topicTools: { enabled: false } }, { canLive: true });
    expect(listed.tools.map((t) => t.name)).toEqual(KERNEL_TOOL_NAMES);
    expect(input.channelContext).not.toHaveProperty('topicTools');
  });

  it('the live tools are offered only while a running channel can open a live, asked at each tools/list: one started later (console.liveChannels) brings them on the next tools/list of the same binding, removing it takes them away; while none can, calling one answers it is not there; get_channel_context abilities follow #CF-6', async () => {
    const holder: { w?: World } = {};
    const contexts: { abilities: { tools: string[] } }[] = [];
    const { w, doc, put } = await live({
      raw: { outputTools: true },
      channelAdapter: (ch) => (ch.type === 'bridge' ? new LiveChannel('meet') : undefined),
      script: async (t) => {
        const mcp = holder.w!.harness.sessions.at(-1)!.args.mcp;
        contexts.push(JSON.parse((await mcpCall(mcp, 'get_channel_context', {}, `ctx${contexts.length}`)).text));
        t.emit({ t: 'text.snapshot', text: 'ok', final: true }, { audience: 'answer' });
      },
    });
    holder.w = w;
    const liveNames = TOOL_GROUPS.live as readonly string[];
    await w.chat.inject({ sender: alice, text: 'hello' });
    await until(() => contexts.length === 1);
    const mcp = w.harness.sessions.at(-1)!.args.mcp;
    const listed = async () => JSON.stringify(await toolsList(mcp), null, 2) + '\n';
    expect(await listed()).toBe(readFileSync(FIXTURE_NO_LIVE, 'utf8'));
    expect(contexts[0]!.abilities.tools).toEqual(TOOL_NAMES.filter((n) => !liveNames.includes(n)));
    expect(await mcpCall(mcp, 'live_join', { target: '42' }, 'j1')).toEqual({ isError: true, text: 'MCP error -32602: Tool live_join not found' });

    // A channel that can open a live comes up: the same binding lists them on its next tools/list.
    expect(await put({ ...(await doc()).config, channels: [bridge('x1')] })).toMatchObject({ applied: 'live', channels: { started: [{ type: 'bridge', account: 'x1' }] } });
    expect(await listed()).toBe(readFileSync(FIXTURE, 'utf8'));
    await w.chat.inject({ sender: alice, text: 'again' });
    await until(() => contexts.length === 2);
    expect(contexts[1]!.abilities.tools).toEqual(TOOL_NAMES);

    // Removed again: gone from the next tools/list.
    expect(await put({ ...(await doc()).config, channels: [] })).toMatchObject({ applied: 'live', channels: { stopped: [{ type: 'bridge', account: 'x1' }] } });
    expect(await listed()).toBe(readFileSync(FIXTURE_NO_LIVE, 'utf8'));
  });

  it('an agent whose tools list names a live tool is offered it only while a channel can open a live #CF-6', async () => {
    const raw = { outputTools: true, agents: { chat: { harness: 'claude-code', tools: ['send_message', 'live_join'] } }, defaultAgent: 'chat' };
    expect((await offered(raw, { canLive: true })).listed.tools.map((t) => t.name)).toEqual(['send_message', 'live_join']);
    expect((await offered(raw)).listed.tools.map((t) => t.name)).toEqual(['send_message']);
  });

  it('an agent whose tools list names only live tools keeps its endpoint where no channel can open a live: tools/list answers an empty list, not an error #CF-6', async () => {
    const raw = { agents: { voice: { harness: 'claude-code', tools: ['live_join', 'live_say', 'live_leave'] } }, defaultAgent: 'voice' };
    const none = await offered(raw);
    expect(none.w.harness.sessions.at(-1)!.args.mcp).toBeDefined();
    expect(none.listed).toEqual({ tools: [] });
    expect((await offered(raw, { canLive: true })).listed.tools.map((t) => t.name)).toEqual(['live_join', 'live_say', 'live_leave']);
  });
});
