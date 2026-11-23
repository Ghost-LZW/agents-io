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
  topicToolHandlers,
  toolCatalog,
  watchToolHandlers,
  type HostToolsOptions,
  type ModuleTools,
} from '../src/index.js';

/*
 * The tool catalog (core-slimming G6): the kernel's tools, then the active modules'. With no module
 * active what an endpoint offers is exactly what it offered before the catalog existed: the fixture
 * is the `tools/list` answer captured from the code before the change, byte for byte.
 */

const servers: HostMcpServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
});

const refuse = async (): Promise<never> => {
  throw new Error('not in this test');
};

/** Host tools with every control (watches, topics, live), or with `o` over none. */
function hostTools(o: Partial<HostToolsOptions> = { watches: { add: refuse, remove: refuse, list: () => [] }, topics: { list: () => [], rotate: refuse, switch: refuse }, live: { join: refuse, say: refuse, leave: refuse } }) {
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
  it('with every control and no module, tools: true lists the 15 kernel tools in TOOL_DEFS order, byte for byte (names, descriptions, input schemas, annotations) #CF-6', async () => {
    const s = new HostMcpServer({ tools: hostTools() });
    servers.push(s);
    const listed = await toolsList(s);
    expect(JSON.stringify(listed, null, 2) + '\n').toBe(readFileSync(new URL('./fixtures/tools-list.json', import.meta.url), 'utf8'));
    expect(listed.tools.map((t) => t.name)).toEqual(TOOL_NAMES);
    expect(TOOL_NAMES).toHaveLength(15);
  });

  it('the catalog is the kernel tools whose control the host passed, in TOOL_DEFS order, then nothing else; an agent list picks from it #CF-6', async () => {
    expect(toolCatalog(hostTools({})).map((t) => t.name)).toEqual(['get_channel_context', 'send_file', 'ask_choice', 'mention', 'reply_to', 'send_message']);
    expect(toolCatalog(hostTools()).map((t) => t.name)).toEqual(TOOL_NAMES);
    expect(toolCatalog(hostTools()).every((t) => t.module === undefined)).toBe(true);
    const s = new HostMcpServer({ tools: hostTools() });
    servers.push(s);
    expect((await toolsList(s, ['session_list', 'send_message'])).tools.map((t) => t.name)).toEqual(['send_message', 'session_list']);
  });

  it('modules that offer the tool groups (TOOL_GROUP_DEFS, run by watchToolHandlers / liveToolHandlers / topicToolHandlers), with no control of the host\'s, list the same 15 tools byte for byte; a group the host passed a control for is the kernel\'s #CF-6', async () => {
    const groups: ModuleTools[] = [
      { module: 'tools.watch', tools: TOOL_GROUP_DEFS.watch, handlers: watchToolHandlers(undefined) },
      { module: 'tools.live', tools: TOOL_GROUP_DEFS.live, handlers: liveToolHandlers(undefined) },
      { module: 'tools.topics', tools: TOOL_GROUP_DEFS.topics, handlers: topicToolHandlers(undefined) },
    ];
    const tools = hostTools({ modules: groups });
    expect(toolCatalog(tools).map((t) => [t.name, t.module])).toEqual([
      ...KERNEL_TOOL_NAMES.map((n) => [n, undefined]),
      ...TOOL_GROUPS.watch.map((n) => [n, 'tools.watch']),
      ...TOOL_GROUPS.live.map((n) => [n, 'tools.live']),
      ...TOOL_GROUPS.topics.map((n) => [n, 'tools.topics']),
    ]);
    const s = new HostMcpServer({ tools });
    servers.push(s);
    expect(JSON.stringify(await toolsList(s), null, 2) + '\n').toBe(readFileSync(new URL('./fixtures/tools-list.json', import.meta.url), 'utf8'));
    // The definitions are what TOOL_DEFS says; the watch tools and session_list need no turn.
    expect(Object.values(TOOL_GROUP_DEFS).flat().map((d) => [d.name, d.needsTurn])).toEqual([
      ['watch_add', false], ['watch_remove', false], ['watch_list', false],
      ['live_join', true], ['live_say', true], ['live_leave', true],
      ['session_rotate', true], ['session_list', false], ['session_switch', true],
    ]);
    // Over no control each says its group is not available, as the kernel's did; one that needs a turn asks for one first.
    const b = { sessionKey: 's1', generation: 1 };
    await expect(tools.call(b, 'watch_list', {})).rejects.toThrow('watches are not available on this host');
    await expect(tools.call(b, 'session_list', {})).rejects.toThrow('topics are not available on this host');
    await expect(tools.call(b, 'live_leave', {})).rejects.toThrow('no turn is running in this session');
    // With the host's control for a group, a module offering it clashes with the kernel's.
    expect(() => toolCatalog(hostTools({ watches: { add: refuse, remove: refuse, list: () => [] }, modules: [groups[0]!] }))).toThrow('module tools.watch: tool "watch_add" is a kernel tool');
  });
});
