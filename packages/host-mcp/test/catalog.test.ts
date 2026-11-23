import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { Hub, MemorySessionLog, Outbox, defaultPolicy } from '@agents-io/session';
import { HostMcpServer, HostTools, MemoryBlobStore, TOOL_NAMES, toolCatalog, type HostToolsOptions } from '../src/index.js';

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
});
