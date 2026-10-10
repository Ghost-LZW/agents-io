import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionEvent } from '@agents-io/protocol';
import { MemorySessionLog } from '@agents-io/session';
import { FakeChannel, FakeHarness, type FakeTurnScript } from '@agents-io/testkit';
import { LocalClient } from '../src/client.js';
import { resolveConfig } from '../src/config.js';
import { Gateway } from '../src/gateway.js';
import { cleanups } from './helpers.js';

type Mcp = { url: string; token: string } | undefined;

async function rpc(mcp: Mcp, method: string, params: Record<string, unknown>) {
  if (!mcp) throw new Error('no mcp mounted');
  const res = await fetch(mcp.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${mcp.token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return (await res.json()) as { result: Record<string, unknown> };
}

/** What a harness does with HarnessOpenArgs.mcp: a JSON-RPC tools/call over streamable HTTP. */
export async function mcpCall(mcp: Mcp, name: string, args: Record<string, unknown>, callId: string) {
  const body = (await rpc(mcp, 'tools/call', { name, arguments: args, _meta: { 'claudecode/toolUseId': callId } })) as { result: { isError?: boolean; content: { text: string }[] } };
  return { isError: !!body.result.isError, text: body.result.content[0]!.text };
}

/** The tool names a harness sees over MCP (tools/list). */
export async function mcpTools(mcp: Mcp): Promise<string[]> {
  const body = (await rpc(mcp, 'tools/list', {})) as { result: { tools: { name: string }[] } };
  return body.result.tools.map((t) => t.name).sort();
}

/** An in-memory gateway with a FakeChannel `fake` (owner fake:alice), subscribed to the session of conversation c1. */
export async function setup(script: FakeTurnScript, raw: Record<string, unknown> = { outputTools: true }) {
  const dir = mkdtempSync(join(tmpdir(), 'aio-out-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const base = resolveConfig({ policy: { owners: ['fake:alice'] }, local: { principal: 'me' }, ...raw }, { env: {}, baseDir: dir, cwd: dir });
  const config = { ...base, socketPath: join(dir, 'run', 'aio.sock'), blobs: { ...base.blobs, dir: join(dir, 'blobs') } };
  const chat = new FakeChannel('fake');
  const harness = new FakeHarness(script);
  const gw = await Gateway.start({ config, harness, log: new MemorySessionLog(), channels: [{ adapter: chat }], logger: () => {} });
  cleanups.push(() => gw.stop());
  const c = await LocalClient.connect(config.socketPath);
  cleanups.push(() => c.close());
  const events: SessionEvent[] = [];
  const sub = await c.subscribe({ sessionKey: 'fake:default:c1', tier: 'full', fromSeq: 0 });
  void (async () => {
    for await (const e of sub) events.push(e);
  })();
  return { gw, chat, harness, events, c };
}

export const completed = (evs: SessionEvent[]) => evs.filter((e) => e.body.t === 'turn.completed').length;
