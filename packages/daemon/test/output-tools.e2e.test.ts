import { describe, expect, it } from 'vitest';
import type { FakeHarness } from '@agents-io/testkit';
import { until } from './helpers.js';
import { completed, mcpCall, setup } from './output-tools-helpers.js';

describe('dev-gateway host output tools', () => {
  it('mounts a per-binding token; ask_choice buttons → click → choice event in the asking session; outbound denial #CF-6 #DL-5 #SE-3', async () => {
    const holder: { h?: FakeHarness } = {};
    const results: { isError: boolean; text: string }[] = [];
    const w = await setup(async (t) => {
      const mcp = holder.h!.sessions.at(-1)!.args.mcp;
      const first = t.inputs[0]!.content[0]!;
      if (first.type === 'text') {
        results.push(await mcpCall(mcp, 'ask_choice', { question: 'Red or blue?', options: ['red', 'blue'] }, 'toolu_1'));
        results.push(await mcpCall(mcp, 'send_message', { route: 'fake:default:elsewhere', text: 'leak' }, 'toolu_2'));
        t.emit({ t: 'text.snapshot', text: 'waiting', final: true }, { audience: 'answer' });
      } else {
        t.emit({ t: 'text.snapshot', text: `got ${JSON.stringify(first)}`, final: true }, { audience: 'answer' });
      }
    });
    holder.h = w.harness;
    await w.chat.inject({ sender: { channelUserId: 'alice', evidence: 'platform_signed' }, text: 'ask me' });
    const choiceMsg = await until(() => w.chat.sent.find((s) => s.msg.actions?.some((a) => a.id.startsWith('choice:'))));
    const mcp = w.harness.sessions[0]!.args.mcp!;
    expect(mcp.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    expect(mcp.token.length).toBeGreaterThan(20);
    await until(() => results.length === 2);
    expect(results[0]!.isError).toBe(false);
    expect(results[1]).toMatchObject({ isError: true, text: expect.stringMatching(/outbound policy/) });
    await until(() => completed(w.events) === 1);
    const blue = choiceMsg.msg.actions!.find((a) => a.label === 'blue')!;
    // A card click comes from a conversation kind the policy does not tie to the DM session; it still reaches the asker.
    await w.chat.inject({ sender: { channelUserId: 'alice', evidence: 'platform_signed' }, conversation: { id: 'c1', kind: 'dm' }, content: [{ type: 'event', name: 'action', data: { actionId: blue.id } }] });
    await until(() => completed(w.events) === 2);
    const answer = w.events.filter((e) => e.body.t === 'text.snapshot').map((e) => (e.body as { text: string }).text).at(-1)!;
    expect(answer).toContain('"name":"choice"');
    expect(answer).toContain('"label":"blue"');
    expect((await fetch(mcp.url, { method: 'POST', body: '{}' })).status).toBe(401);
  });
});
