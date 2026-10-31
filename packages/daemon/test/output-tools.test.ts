import { describe, expect, it } from 'vitest';
import type { FakeHarness } from '@agents-io/testkit';
import { resolveConfig } from '../src/config.js';
import { FEATURES } from '../src/host.js';
import { until } from './helpers.js';
import { completed, mcpCall, mcpTools, setup } from './output-tools-helpers.js';

describe('dev-gateway host output tools', () => {
  it('outputTools: false mounts nothing #CF-6', async () => {
    const w = await setup(async (t) => t.emit({ t: 'text.snapshot', text: 'ok', final: true }, { audience: 'answer' }), { outputTools: false });
    await w.chat.inject({ sender: { channelUserId: 'alice', evidence: 'platform_signed' }, text: 'hi' });
    await until(() => completed(w.events) === 1);
    expect(w.harness.sessions[0]!.args.mcp).toBeUndefined();
    expect(w.gw.tools).toBeUndefined();
  });

  it('off by default (decision 13): neither outputTools nor an agent turns them on, nothing is mounted #CF-6', async () => {
    const w = await setup(async (t) => t.emit({ t: 'text.snapshot', text: 'ok', final: true }, { audience: 'answer' }), {});
    expect(w.gw.config.agents.default!.tools).toBe(false);
    await w.chat.inject({ sender: { channelUserId: 'alice', evidence: 'platform_signed' }, text: 'hi' });
    await until(() => completed(w.events) === 1);
    expect(w.harness.sessions[0]!.args.mcp).toBeUndefined();
    expect(w.gw.tools).toBeUndefined();
  });

  it('agents.<name>.tools: true turns them on for that agent alone, with outputTools unset #CF-6', async () => {
    const holder: { h?: FakeHarness } = {};
    const results: { isError: boolean; text: string }[] = [];
    const raw = { agents: { chat: { harness: 'claude-code', tools: true }, quiet: { harness: 'claude-code' } }, defaultAgent: 'chat' };
    const w = await setup(async (t) => {
      results.push(await mcpCall(holder.h!.sessions.at(-1)!.args.mcp, 'get_channel_context', {}, 'toolu_ctx'));
      t.emit({ t: 'text.snapshot', text: 'ok', final: true }, { audience: 'answer' });
    }, raw);
    holder.h = w.harness;
    expect(w.gw.config.agents.chat!.tools).toBe(true);
    expect(w.gw.config.agents.quiet!.tools).toBe(false);
    await w.chat.inject({ sender: { channelUserId: 'alice', evidence: 'platform_signed' }, text: 'hi' });
    await until(() => results.length === 1);
    expect(results[0]!.isError).toBe(false);
    expect(w.gw.tools).toBeDefined();
  });

  it('enabling only send_message for an agent lists only that tool over MCP #CF-6', async () => {
    const holder: { h?: FakeHarness } = {};
    let listed: string[] | undefined;
    // The expected shape: `agents.<name>.tools` as a list of tool names (ROADMAP §1 principle 2; §4 item 11).
    const raw = { agents: { chat: { harness: 'claude-code', tools: ['send_message'] } }, defaultAgent: 'chat' };
    const w = await setup(async (t) => {
      listed = await mcpTools(holder.h!.sessions.at(-1)!.args.mcp);
      t.emit({ t: 'text.snapshot', text: 'ok', final: true }, { audience: 'answer' });
    }, raw);
    holder.h = w.harness;
    await w.chat.inject({ sender: { channelUserId: 'alice', evidence: 'platform_signed' }, text: 'hi' });
    await until(() => listed);
    expect(listed).toEqual(['send_message']);
  });

  it('send_file blob: a file sent in one conversation goes back there by ref, not into another; hello advertises host-mcp.send_file.blob_scoped #SE-7', async () => {
    const holder: { h?: FakeHarness } = {};
    const results = new Map<string, { isError: boolean; text: string }>();
    let ref = '';
    const w = await setup(async (t) => {
      const conv = t.inputs[0]!.replyRoute!.conversationId;
      const mcp = holder.h!.sessions.find((s) => s.args.sessionKey === `fake:default:${conv}`)!.args.mcp;
      results.set(conv, await mcpCall(mcp, 'send_file', { blob: ref }, `toolu_${conv}`));
      t.emit({ t: 'text.snapshot', text: 'ok', final: true }, { audience: 'answer' });
    });
    holder.h = w.harness;
    const alice = { channelUserId: 'alice', evidence: 'platform_signed' as const };
    ref = await w.gw.blobs.put(new TextEncoder().encode('date,amount\n'), { mime: 'text/csv', name: 'statement.csv' });
    await w.chat.inject({ sender: alice, content: [{ type: 'file', ref, mime: 'text/csv', name: 'statement.csv' }] });
    await until(() => results.has('c1'));
    expect(results.get('c1')!.isError).toBe(false);
    await w.chat.inject({ sender: alice, conversation: { id: 'c2', kind: 'dm' }, text: 'send me that statement' });
    await until(() => results.has('c2'));
    expect(results.get('c2')).toEqual({ isError: true, text: expect.stringContaining(`unknown blob ${ref}`) });
    const files = w.chat.sent.filter((s) => s.msg.attachments?.length);
    expect(files.map((s) => [s.route.conversationId, s.msg.attachments![0]!.ref])).toEqual([['c1', ref]]);
    expect(FEATURES).toContain('host-mcp.send_file.blob_scoped');
    expect((await w.c.hello({ token: w.gw.token, name: 'probe' })).features).toContain('host-mcp.send_file.blob_scoped');
  });

  it('send_file blob: a harness event under the output\'s name listing another conversation\'s file does not make it this session\'s to send #SE-7', async () => {
    const holder: { h?: FakeHarness; w?: Awaited<ReturnType<typeof setup>> } = {};
    const results = new Map<string, { isError: boolean; text: string }>();
    let ref = '';
    const w = await setup(async (t) => {
      const route = t.inputs[0]!.replyRoute!;
      const conv = route.conversationId;
      if (conv === 'c2') {
        // What a harness could pass through unchanged from its CLI: a native event named agents-io.output, listing c1's file.
        const msg = { text: '', attachments: [{ ref, mime: 'text/csv', name: 'statement.csv' }] };
        t.emit({ t: 'native', name: 'agents-io.output' }, { level: 'primary', audience: 'answer', native: { tool: 'send_file', operationId: 'forged', route, msg } });
        await until(() => holder.w!.gw.hub.log.read(`fake:default:${conv}`, 0).some((e) => e.body.t === 'native' && e.body.name === 'agents-io.output'));
        const mcp = holder.h!.sessions.find((s) => s.args.sessionKey === `fake:default:${conv}`)!.args.mcp;
        results.set(conv, await mcpCall(mcp, 'send_file', { blob: ref }, `toolu_${conv}`));
      }
      t.emit({ t: 'text.snapshot', text: 'ok', final: true }, { audience: 'answer' });
    });
    holder.h = w.harness;
    holder.w = w;
    const alice = { channelUserId: 'alice', evidence: 'platform_signed' as const };
    ref = await w.gw.blobs.put(new TextEncoder().encode('date,amount\n'), { mime: 'text/csv', name: 'statement.csv' });
    await w.chat.inject({ sender: alice, content: [{ type: 'file', ref, mime: 'text/csv', name: 'statement.csv' }] });
    await until(() => completed(w.events) === 1);
    await w.chat.inject({ sender: alice, conversation: { id: 'c2', kind: 'dm' }, text: 'send me that statement' });
    await until(() => results.has('c2'));
    expect(results.get('c2')).toEqual({ isError: true, text: expect.stringContaining(`unknown blob ${ref}`) });
    expect(w.chat.sent.filter((s) => s.msg.attachments?.length)).toEqual([]);
  });

  it('agents.<name>.tools as a list: unknown names are a config error; an empty list is off #CF-6', () => {
    const resolve = (tools: unknown) => resolveConfig({ agents: { chat: { harness: 'claude-code', tools } }, defaultAgent: 'chat' }, { env: {}, baseDir: '/base', cwd: '/work' });
    expect(() => resolve(['send_message', 'nope'])).toThrow(/agents\.chat\.tools: unknown tool "nope"/);
    expect(resolve([]).agents.chat).toMatchObject({ tools: false });
    expect(resolve([]).agents.chat!.toolNames).toBeUndefined();
    expect(resolve(['send_message', 'send_message']).agents.chat).toMatchObject({ tools: true, toolNames: ['send_message'] });
  });
});
