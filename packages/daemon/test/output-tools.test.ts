import { describe, expect, it } from 'vitest';
import type { FakeHarness } from '@agents-io/testkit';
import { resolveConfig } from '../src/config.js';
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

  it('agents.<name>.tools as a list: unknown names are a config error; an empty list is off #CF-6', () => {
    const resolve = (tools: unknown) => resolveConfig({ agents: { chat: { harness: 'claude-code', tools } }, defaultAgent: 'chat' }, { env: {}, baseDir: '/base', cwd: '/work' });
    expect(() => resolve(['send_message', 'nope'])).toThrow(/agents\.chat\.tools: unknown tool "nope"/);
    expect(resolve([]).agents.chat).toMatchObject({ tools: false });
    expect(resolve([]).agents.chat!.toolNames).toBeUndefined();
    expect(resolve(['send_message', 'send_message']).agents.chat).toMatchObject({ tools: true, toolNames: ['send_message'] });
  });
});
