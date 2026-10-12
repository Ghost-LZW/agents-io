import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { get, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { describe, expect, it } from 'vitest';
import type { TuiAttach } from '@agents-io/protocol';
import { MemorySessionLog } from '@agents-io/session';
import { FakeChannel, FakeHarness } from '@agents-io/testkit';
import { LocalClient } from '../src/client.js';
import { resolveConfig } from '../src/config.js';
import { Gateway } from '../src/gateway.js';
import { cleanups, until } from './gateway-helpers.js';

/*
 * Claude Code's TUI takes a session (decision 15, S2). This test plays the TUI: it reads the
 * launch the daemon answers, connects the bridge's stream and posts the hooks the TUI would.
 */

const alice = { channelUserId: 'alice', evidence: 'platform_signed' as const };

async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'aio-tuic-'));
  const base = resolveConfig({ policy: { owners: ['fake:alice'], ownerSessionKey: 'main' }, local: { principal: 'fake:alice' } }, { env: {}, baseDir: dir, cwd: dir });
  const config = { ...base, socketPath: join(dir, 'run', 'aio.sock') };
  const chat = new FakeChannel('fake');
  // Stands in for the headless claude-code adapter of the instance.
  const headless = new FakeHarness(undefined, base.defaultHarness);
  const gw = await Gateway.start({ config, harness: headless, log: new MemorySessionLog(), channels: [{ adapter: chat }], logger: () => {} });
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  cleanups.push(() => gw.stop());
  const client = await LocalClient.connect(config.socketPath);
  cleanups.push(() => client.close());
  return { gw, chat, headless, client };
}

/** What the TUI's settings and bridge config point at. */
function plumbing(t: TuiAttach) {
  const settings = JSON.parse(readFileSync(t.args[t.args.indexOf('--settings') + 1]!, 'utf8')) as { hooks: Record<string, { hooks: { url: string }[] }[]> };
  const mcp = JSON.parse(readFileSync(t.args[t.args.indexOf('--mcp-config') + 1]!, 'utf8')) as { mcpServers: Record<string, { env: Record<string, string> }> };
  const hookUrl = (e: string) => settings.hooks[e]![0]!.hooks[0]!.url;
  return { hookUrl, streamUrl: `${mcp.mcpServers['agents-io-bridge']!.env.AIO_TUI_URL}/stream` };
}

function post(url: string, body: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' } }, (res) => {
      let raw = '';
      res.on('data', (d) => (raw += d));
      res.on('end', () => resolve(raw ? JSON.parse(raw) : undefined));
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

/** The bridge's side: the stream of messages for the TUI's inbox. */
function bridge(url: string) {
  const lines: string[] = [];
  const req = get(url, (res) => {
    res.on('error', () => undefined);
    const rl = createInterface({ input: res });
    rl.on('error', () => undefined); // readline re-emits the aborted stream's error
    rl.on('line', (l) => l.trim() && lines.push((JSON.parse(l) as { text: string }).text));
  });
  req.on('error', () => undefined);
  return { lines, close: () => req.destroy() };
}

describe('Claude Code TUI on a session', () => {
  it('channel messages go into the TUI, its answer back to the channel; when it exits the session goes on headless, same Claude session #LN-9', async () => {
    const w = await setup();
    const t = await w.client.tuiAttach();
    expect(t.command).toBe('claude');
    expect(t.args.slice(0, 2)).toEqual(['--session-id', t.nativeId]);
    const p = plumbing(t);
    const b = bridge(p.streamUrl);

    await w.chat.inject({ conversation: { id: 'c-alice', kind: 'dm' }, sender: alice, text: 'how is the build?' });
    await until(() => b.lines.length === 1);
    expect(b.lines[0]).toContain('how is the build?');
    expect(w.headless.sessions).toHaveLength(0); // the TUI has it

    const sid = { session_id: t.nativeId };
    await post(p.hookUrl('UserPromptSubmit'), { ...sid, prompt: b.lines[0], prompt_id: 'p1' });
    await post(p.hookUrl('PreToolUse'), { ...sid, tool_name: 'Bash', tool_input: { command: 'pnpm build' }, tool_use_id: 'tu1' });
    await post(p.hookUrl('PostToolUse'), { ...sid, tool_name: 'Bash', tool_input: { command: 'pnpm build' }, tool_response: 'ok', tool_use_id: 'tu1' });
    await post(p.hookUrl('Stop'), { ...sid, last_assistant_message: 'It passes.' });
    const card = await until(() => w.chat.sent.find((s) => s.finalized));
    expect(card.edits.at(-1)?.text ?? card.msg.text).toBe('It passes.');

    // The TUI exits: the bridge's stream closes. The next message runs headless, resuming the same Claude session.
    b.close();
    await until(() => w.gw.sessions().length > 0);
    await new Promise((r) => setTimeout(r, 30));
    await w.chat.inject({ conversation: { id: 'c-alice', kind: 'dm' }, sender: alice, text: 'thanks' });
    await until(() => w.chat.sent.filter((s) => s.finalized).length === 2);
    expect(w.headless.sessions).toHaveLength(1);
    expect(w.headless.sessions[0]!.args.resume).toBe(t.nativeId);
  });

  it('a hook from another Claude session is ignored; an attach while one is connected is refused #LN-9', async () => {
    const w = await setup();
    const t = await w.client.tuiAttach();
    const p = plumbing(t);
    const b = bridge(p.streamUrl);
    await until(() => true);
    await post(p.hookUrl('UserPromptSubmit'), { session_id: 'someone-else', prompt: 'hi', prompt_id: 'x' });
    await new Promise((r) => setTimeout(r, 30));
    expect(w.gw.hub.log.read('main', 0).some((e) => e.body.t === 'turn.started')).toBe(false);
    await new Promise((r) => setTimeout(r, 30));
    await expect(w.client.tuiAttach()).rejects.toMatchObject({ code: 'conflict' });
    b.close();
  });
});
