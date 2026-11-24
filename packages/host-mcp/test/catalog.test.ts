import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { Hub, MemorySessionLog, Outbox, defaultPolicy } from '@agents-io/session';
import {
  HostMcpServer,
  HostTools,
  KERNEL_TOOL_NAMES,
  MemoryBlobStore,
  TOOL_GROUP_DEFS,
  TOOL_GROUPS,
  TOOL_NAMES,
  liveToolHandlers,
  scheduleToolHandlers,
  topicToolHandlers,
  toolCatalog,
  watchToolHandlers,
  type HostToolsOptions,
  type ModuleTools,
} from '../src/index.js';

/*
 * The tool catalog (core-slimming G6): the kernel's tools, then the active modules'. With no module
 * active what an endpoint offers is exactly what it offered before the catalog existed: the fixture
 * is the `tools/list` answer captured from the code before the change, byte for byte (since the
 * merge of origin/main b9b35ed: that code's, with every control, the schedule tools included).
 * `tools-list-no-live.json` is the same answer without the three live tools: what a deployment
 * where no running channel can open a live lists (the daemon's `tools.live` withholds them then).
 */

const FIXTURE = new URL('./fixtures/tools-list.json', import.meta.url);
const FIXTURE_NO_LIVE = new URL('./fixtures/tools-list-no-live.json', import.meta.url);

const servers: HostMcpServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
});

const refuse = async (): Promise<never> => {
  throw new Error('not in this test');
};

/** Host tools with every control (watches, schedules, topics, live), or with `o` over none. */
function hostTools(
  o: Partial<HostToolsOptions> = {
    watches: { add: refuse, remove: refuse, list: () => [] },
    schedules: { put: refuse, remove: refuse, list: () => [] },
    topics: { list: () => [], rotate: refuse, switch: refuse },
    live: { join: refuse, say: refuse, leave: refuse },
  },
) {
  const hub = new Hub(new MemorySessionLog());
  return new HostTools({ hub, outbox: new Outbox({ hub }), policy: defaultPolicy({ owners: ['fake:alice'] }), turn: () => undefined, adapter: () => undefined, blobs: new MemoryBlobStore(), cwd: () => '/', ...o });
}

/** The raw `tools/list` result a harness binding of `s` gets (limited to `names` when given). */
async function toolsList(s: HostMcpServer, names?: string[]): Promise<{ tools: { name: string }[] }> {
  const url = await s.listen();
  const { token } = s.mcpFor({ sessionKey: 's1', generation: 1, harnessId: 'fake' }, names);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });
  return ((await res.json()) as { result: { tools: { name: string }[] } }).result;
}

describe('the host MCP tool catalog', () => {
  it('with every control and no module, tools: true lists the 18 kernel tools in TOOL_DEFS order, byte for byte (names, descriptions, input schemas, annotations) #CF-6', async () => {
    const s = new HostMcpServer({ tools: hostTools() });
    servers.push(s);
    const listed = await toolsList(s);
    expect(JSON.stringify(listed, null, 2) + '\n').toBe(readFileSync(FIXTURE, 'utf8'));
    expect(listed.tools.map((t) => t.name)).toEqual(TOOL_NAMES);
    expect(TOOL_NAMES).toHaveLength(18);
  });

  it('the catalog is the kernel tools whose control the host passed, in TOOL_DEFS order, then nothing else; an agent list picks from it #CF-6', async () => {
    expect(toolCatalog(hostTools({})).map((t) => t.name)).toEqual(['get_channel_context', 'send_file', 'ask_choice', 'mention', 'reply_to', 'send_message']);
    expect(toolCatalog(hostTools()).map((t) => t.name)).toEqual(TOOL_NAMES);
    expect(toolCatalog(hostTools()).every((t) => t.module === undefined)).toBe(true);
    const s = new HostMcpServer({ tools: hostTools() });
    servers.push(s);
    expect((await toolsList(s, ['session_list', 'send_message'])).tools.map((t) => t.name)).toEqual(['send_message', 'session_list']);
  });

  it('modules that offer the tool groups (TOOL_GROUP_DEFS, run by watchToolHandlers / scheduleToolHandlers / liveToolHandlers / topicToolHandlers), with no control of the host\'s, list the same 18 tools byte for byte; a group the host passed a control for is the kernel\'s #CF-6', async () => {
    const groups: ModuleTools[] = [
      { module: 'tools.watch', tools: TOOL_GROUP_DEFS.watch, handlers: watchToolHandlers(undefined) },
      { module: 'tools.schedules', tools: TOOL_GROUP_DEFS.schedules, handlers: scheduleToolHandlers(undefined) },
      { module: 'tools.live', tools: TOOL_GROUP_DEFS.live, handlers: liveToolHandlers(undefined) },
      { module: 'tools.topics', tools: TOOL_GROUP_DEFS.topics, handlers: topicToolHandlers(undefined) },
    ];
    const tools = hostTools({ modules: groups });
    expect(toolCatalog(tools).map((t) => [t.name, t.module])).toEqual([
      ...KERNEL_TOOL_NAMES.map((n) => [n, undefined]),
      ...TOOL_GROUPS.watch.map((n) => [n, 'tools.watch']),
      ...TOOL_GROUPS.schedules.map((n) => [n, 'tools.schedules']),
      ...TOOL_GROUPS.live.map((n) => [n, 'tools.live']),
      ...TOOL_GROUPS.topics.map((n) => [n, 'tools.topics']),
    ]);
    const s = new HostMcpServer({ tools });
    servers.push(s);
    expect(JSON.stringify(await toolsList(s), null, 2) + '\n').toBe(readFileSync(FIXTURE, 'utf8'));
    // The definitions are what TOOL_DEFS says; the watch and schedule tools and session_list need no turn.
    expect(Object.values(TOOL_GROUP_DEFS).flat().map((d) => [d.name, d.needsTurn])).toEqual([
      ['watch_add', false], ['watch_remove', false], ['watch_list', false],
      ['schedule_add', false], ['schedule_remove', false], ['schedule_list', false],
      ['live_join', true], ['live_say', true], ['live_leave', true],
      ['session_rotate', true], ['session_list', false], ['session_switch', true],
    ]);
    // Over no control each says its group is not available, as the kernel's did; one that needs a turn asks for one first.
    const b = { sessionKey: 's1', generation: 1 };
    await expect(tools.call(b, 'watch_list', {})).rejects.toThrow('watches are not available on this host');
    await expect(tools.call(b, 'schedule_list', {})).rejects.toThrow('schedules are not available on this host');
    await expect(tools.call(b, 'session_list', {})).rejects.toThrow('topics are not available on this host');
    await expect(tools.call(b, 'live_leave', {})).rejects.toThrow('no turn is running in this session');
    // With the host's control for a group, a module offering it clashes with the kernel's.
    expect(() => toolCatalog(hostTools({ watches: { add: refuse, remove: refuse, list: () => [] }, modules: [groups[0]!] }))).toThrow('module tools.watch: tool "watch_add" is a kernel tool');
  });

  it('a module that offers some of its tools only at times (ModuleTools.offered) is asked at every request: what it withholds then is neither listed nor callable, the next tools/list of the same token lists it once offered; without the live tools the answer is the 18 without them, byte for byte; an offered that throws withholds all of its tools #CF-6', async () => {
    let canLive = false;
    let broken = false;
    let asked = 0;
    const groups: ModuleTools[] = [
      { module: 'tools.watch', tools: TOOL_GROUP_DEFS.watch, handlers: watchToolHandlers(undefined) },
      { module: 'tools.schedules', tools: TOOL_GROUP_DEFS.schedules, handlers: scheduleToolHandlers(undefined) },
      {
        module: 'tools.live',
        tools: TOOL_GROUP_DEFS.live,
        handlers: liveToolHandlers(undefined),
        offered: () => {
          asked++;
          if (broken) throw new Error('boom');
          // A name that is not the module's is ignored.
          return canLive ? [...TOOL_GROUPS.live, 'send_message', 'nope'] : ['nope'];
        },
      },
      { module: 'tools.topics', tools: TOOL_GROUP_DEFS.topics, handlers: topicToolHandlers(undefined) },
    ];
    const tools = hostTools({ modules: groups });
    // What may be offered is the whole catalog; what is withheld is asked each time.
    expect(toolCatalog(tools).map((t) => t.name)).toEqual(TOOL_NAMES);
    expect([...tools.withheld()]).toEqual([...TOOL_GROUPS.live]);
    const s = new HostMcpServer({ tools });
    servers.push(s);
    const url = await s.listen();
    const rpc = async (token: string, method: string, params: Record<string, unknown>) => {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });
      return ((await res.json()) as { result: Record<string, unknown> }).result;
    };
    const b = { sessionKey: 's1', generation: 1, harnessId: 'fake' };
    const { token } = s.mcpFor(b);
    const listed = async (t = token) => JSON.stringify(await rpc(t, 'tools/list', {}), null, 2) + '\n';
    const call = async (name: string) => (await rpc(token, 'tools/call', { name, arguments: {} })) as { isError?: boolean; content: { text: string }[] };

    expect(await listed()).toBe(readFileSync(FIXTURE_NO_LIVE, 'utf8'));
    expect(await call('live_leave')).toMatchObject({ isError: true, content: [{ text: 'MCP error -32602: Tool live_leave not found' }] });
    canLive = true;
    expect(await listed()).toBe(readFileSync(FIXTURE, 'utf8'));
    // Offered: the call reaches the tool (which asks for a running turn first).
    expect(await call('live_leave')).toMatchObject({ isError: true, content: [{ text: 'no turn is running in this session: output tools only work while you are answering a message' }] });
    // An agent's list naming a live tool gets it only while it is offered.
    const named = s.mcpFor(b, ['send_message', 'live_join']).token;
    expect(JSON.parse(await listed(named)).tools.map((t: { name: string }) => t.name)).toEqual(['send_message', 'live_join']);
    canLive = false;
    expect(JSON.parse(await listed(named)).tools.map((t: { name: string }) => t.name)).toEqual(['send_message']);
    canLive = true;
    broken = true;
    expect(await listed()).toBe(readFileSync(FIXTURE_NO_LIVE, 'utf8'));
    expect([...tools.withheld()]).toEqual([...TOOL_GROUPS.live]);
    // Asked once per request (seven) and per withheld() (two), never cached.
    expect(asked).toBe(9);
  });

  it('a token whose list names only tools withheld now gets an empty tools/list (not a -32601 error), the same initialize answer as one with tools, and a call answers the tool is not there; once offered they are listed #CF-6', async () => {
    let canLive = false;
    const tools = hostTools({ modules: [{ module: 'tools.live', tools: TOOL_GROUP_DEFS.live, handlers: liveToolHandlers(undefined), offered: () => (canLive ? TOOL_GROUPS.live : []) }] });
    const s = new HostMcpServer({ tools });
    servers.push(s);
    const url = await s.listen();
    const rpc = async (token: string, method: string, params: Record<string, unknown>) => {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });
      return (await res.json()) as { result?: Record<string, unknown>; error?: unknown };
    };
    const b = { sessionKey: 's1', generation: 1, harnessId: 'fake' };
    const onlyLive = s.mcpFor(b, ['live_join', 'live_say', 'live_leave']).token;
    const withTools = s.mcpFor(b, ['send_message', 'live_join']).token;
    const init = { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } };

    expect(await rpc(onlyLive, 'tools/list', {})).toEqual({ jsonrpc: '2.0', id: 1, result: { tools: [] } });
    expect((await rpc(onlyLive, 'tools/call', { name: 'live_join', arguments: {} })).result).toEqual({ isError: true, content: [{ type: 'text', text: 'MCP error -32602: Tool live_join not found' }] });
    expect((await rpc(onlyLive, 'initialize', init)).result).toEqual((await rpc(withTools, 'initialize', init)).result);
    canLive = true;
    expect(((await rpc(onlyLive, 'tools/list', {})).result!.tools as { name: string }[]).map((t) => t.name)).toEqual([...TOOL_GROUPS.live]);
  });
});
