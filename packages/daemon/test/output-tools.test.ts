import { describe, expect, it } from 'vitest';
import type { FakeHarness } from '@agents-io/testkit';
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

  // INVARIANTS CF-6 状态: there is no per-tool switch (`tools` is a boolean; this list form is refused by the config schema), so an agent gets all 15 tools or none; turns red when fixed — make it `it` and update INVARIANTS.
  it.fails('enabling only send_message for an agent lists only that tool over MCP #CF-6', async () => {
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
});
