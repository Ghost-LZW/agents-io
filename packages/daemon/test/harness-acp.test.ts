import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { SessionEvent } from '@agents-io/protocol';
import { FakeChannel } from '@agents-io/testkit';
import { LocalClient, readTokenFile, tokenPath } from '@agents-io/kernel';
import { Gateway, resolveConfig } from '../src/defaults.js';
import { cleanups, tmp, until } from './helpers.js';

/*
 * An ACP agent as a harness (`use: "acp"`, harness/acp) in the daemon: a chat message runs a turn
 * on it; what its sessions show (Plan mode among its session modes, `compact` among its commands)
 * reaches the chat commands (CT-2, CT-3); profiles select its session modes; the host's MCP endpoint
 * reaches it through the stdio bridge; at stop its sessions close, and after a restart the next
 * input resumes the same ACP session on a new agent process (`session/load`), its replay never in
 * the log (RS-1, RS-8). The agent is harness/acp's fake (the official SDK's agent side), which
 * records every call it gets.
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..');
const loader = ['--experimental-transform-types', '--disable-warning=ExperimentalWarning', '--import', join(root, 'scripts', 'source-loader.mjs')];
const agent = join(root, 'harness', 'acp', 'test', 'fake-agent.ts');
const alice = { channelUserId: 'alice', evidence: 'platform_signed' as const };
const dm = { conversation: { id: 'c-alice', kind: 'dm' as const } };
type Call = Record<string, any>;

/** An acp instance running the fake agent, which logs to `log` and keeps its sessions in `state`. */
const acp = (dir: string, extra: Record<string, unknown> = {}) => ({
  use: 'acp',
  command: process.execPath,
  args: [...loader, agent],
  env: { FAKE_ACP_LOG: join(dir, 'agent.jsonl'), FAKE_ACP_STATE: join(dir, 'agent-state') },
  ...extra,
});
const calls = (dir: string): Call[] => {
  const f = join(dir, 'agent.jsonl');
  return existsSync(f) ? readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
};

async function start(dir: string, harnesses: Record<string, unknown>, raw: Record<string, unknown> = {}) {
  mkdirSync(join(dir, 'work'), { recursive: true });
  const base = resolveConfig(
    { dataDir: dir, policy: { owners: ['fake:alice'] }, local: { principal: 'fake:alice' }, cwd: join(dir, 'work'), harnesses, defaultHarness: Object.keys(harnesses)[0], ...raw },
    { env: {}, baseDir: here, cwd: dir },
  );
  const chat = new FakeChannel('fake');
  const socketPath = join(dir, 'run', 'aio.sock');
  const gw = await Gateway.start({ config: { ...base, socketPath }, channels: [{ adapter: chat }], logger: () => {} });
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    await gw.stop();
  };
  cleanups.push(stop);
  const replies = () => chat.sent.map((s) => s.edits.at(-1)?.text ?? s.msg.text);
  const say = async (text: string, match: (reply: string) => boolean = () => true) => {
    const before = replies().length;
    await chat.inject({ ...dm, sender: alice, text });
    return until(() => replies().slice(before).find((r) => r !== undefined && match(r)), 10_000);
  };
  const key = () => gw.sessions()[0]!.sessionKey;
  const log = () => gw.hub.log.read(key(), 0) as SessionEvent[];
  const host = async () => {
    const c = await LocalClient.connect(socketPath);
    cleanups.push(() => c.close());
    await c.hello({ token: readTokenFile(tokenPath(socketPath)), name: 'test' });
    return c;
  };
  return { gw, chat, stop, say, replies, key, log, host };
}

describe('an ACP agent as a harness', () => {
  it('runs a chat turn; Plan mode and compaction come from what its session showed: /plan selects its plan session mode, /compact and session.compact send its advertised command as a turn of its own; profiles select session modes #CT-2 #CT-3', async () => {
    const dir = tmp();
    const w = await start(dir, { agent: acp(dir, { profiles: { bypass: { mode: 'yolo' }, restricted: { mode: 'default' } } }) });
    expect(await w.say('hello', (r) => r.includes('echo:'))).toContain('hello');
    // The owner's turn runs under bypass: its session mode.
    expect(calls(dir).filter((c) => c.call === 'session/set_mode').map((c) => c.params.modeId)).toEqual(['yolo']);

    expect(await w.say('/plan on')).toBe('Plan mode on from the next turn.');
    await w.say('second', (r) => r.includes('echo:'));
    expect(calls(dir).filter((c) => c.call === 'session/set_mode').map((c) => c.params.modeId)).toEqual(['yolo', 'plan']);
    expect(await w.say('/plan off')).toBe('Plan mode off from the next turn.');
    await w.say('third', (r) => r.includes('echo:'));
    expect(calls(dir).filter((c) => c.call === 'session/set_mode').map((c) => c.params.modeId)).toEqual(['yolo', 'plan', 'yolo']);

    const compacts = () => calls(dir).filter((c) => c.call === 'session/prompt' && c.params.prompt.length === 1 && c.params.prompt[0]?.text === '/compact');
    expect(await w.say('/compact', (r) => r.startsWith('Compacting'))).toBe('Compacting (queued behind anything running).');
    await until(() => compacts().length === 1 && !w.gw.hub.snapshot(w.key()).turn, 10_000);
    // The host's session.compact sends the same command, as a turn of its own.
    const h = await w.host();
    expect(await h.sessionCompact({ sessionKey: w.key(), inputId: 'cmp-1' })).toMatchObject({ sessionKey: w.key(), inputId: 'cmp-1', duplicate: false });
    await until(() => compacts().length === 2, 10_000);
  });

  it("an agent's question (a form elicitation) asks the turn's person, on the owner's bypass turn too: a question card in the chat, the answer goes back typed, and the log records the answer the agent got #RQ-5 #HC-1", async () => {
    const dir = tmp();
    const w = await start(dir, { agent: acp(dir) });
    await w.chat.inject({ ...dm, sender: alice, text: 'ask' });
    const question = (m: { channelData?: unknown }) => (m.channelData as Record<string, unknown> | undefined)?.['agents-io/question'];
    const card = await until(() => w.chat.sent.find((s) => question(s.msg) !== undefined), 10_000);
    expect(question(card.msg)).toMatchObject({
      title: 'Which colour?',
      questions: [
        { id: 'colour', text: 'Colour', options: [{ label: 'Red' }, { label: 'Green' }] },
        { id: 'count', text: 'How many' },
        { id: 'sure', text: 'Sure?' },
      ],
    });
    expect((w.log().find((e) => e.body.t === 'turn.started')!.body as { run: { profile: string } }).run.profile).toBe('bypass');
    const opened = w.log().find((e) => e.body.t === 'request.opened')!.body as Record<string, any>;
    expect(opened).toMatchObject({ kind: 'question', resolver: { kind: 'human', principals: ['fake:alice'] } });
    // Nobody answered for the person: the agent is still waiting.
    expect(calls(dir).some((c) => c.call === 'elicitation-outcome')).toBe(false);

    const code = /\/answer (ask:[A-Za-z0-9_-]+)/.exec(card.msg.text)?.[1];
    expect(code).toBeDefined();
    expect(await w.say(`/answer ${code} {"colour":"Green","count":"2","sure":"yes"}`)).toBe('Answer submitted.');
    await until(() => w.replies().find((r) => r.startsWith('answered:')), 10_000);
    expect(w.replies()).toContain('answered: {"colour":"g","count":2,"sure":true}');
    expect(calls(dir).filter((c) => c.call === 'elicitation-outcome').map((c) => c.outcome)).toEqual([{ action: 'accept', content: { colour: 'g', count: 2, sure: true } }]);
    const resolved = w.log().filter((e) => e.body.t === 'request.resolved').map((e) => e.body as Record<string, any>);
    expect(resolved).toEqual([expect.objectContaining({ requestId: opened.requestId, decision: { kind: 'answer', answers: { colour: 'Green', count: '2', sure: 'yes' } }, by: expect.objectContaining({ kind: 'human', id: 'fake:alice' }) })]);
    expect(w.log().filter((e) => e.body.t === 'notice').map((e) => (e.body as { message: string }).message)).not.toContainEqual(expect.stringMatching(/respond failed/));
  });

  it("an agent with tools gets the host's MCP endpoint, here through the stdio bridge, and lists the kernel's tools; one without gets no MCP server #CF-6", async () => {
    const dir = tmp();
    const w = await start(dir, { agent: acp(dir, { mcp: 'stdio-bridge' }) }, { agents: { chat: { harness: 'agent', tools: true } }, defaultAgent: 'chat' });
    const reply = await w.say('mcp', (r) => r.startsWith('tools:'));
    expect(reply.split(': ')[1]!.split(',')).toEqual(expect.arrayContaining(['get_channel_context', 'send_message', 'reply_to']));
    const quiet = tmp();
    const q = await start(quiet, { agent: acp(quiet) });
    expect(await q.say('mcp', (r) => r.includes('mcp'))).toBe('no mcp');
    expect(calls(quiet).find((c) => c.call === 'session/new')!.params.mcpServers).toEqual([]);
  });

  it('at stop a running turn ends (its session closes) and the agent process is shut down, within the stop bounds; after a restart the next input resumes the same ACP session on a new agent process (session/load), and the replayed history is not in the log #RS-1 #RS-8', async () => {
    const dir = tmp();
    const a = await start(dir, { agent: acp(dir) });
    await a.say('first', (r) => r.includes('echo:'));
    const key = a.key();
    const native = (a.log().find((e) => e.body.t === 'session.bound')!.body as { nativeId: string }).nativeId;
    const firstAnswer = (a.log().filter((e) => e.body.t === 'text.snapshot').at(-1)!.body as { text: string }).text;
    await a.chat.inject({ ...dm, sender: alice, text: 'slow' });
    await until(() => calls(dir).some((c) => c.call === 'session/prompt' && JSON.stringify(c.params).includes('slow')), 10_000);
    const t0 = Date.now();
    await a.stop();
    expect(Date.now() - t0).toBeLessThan(10_000);
    const pid = calls(dir).find((c) => c.call === 'start')!.pid as number;
    await until(() => {
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    }, 5000);

    const b = await start(dir, { agent: acp(dir) });
    const read = () => b.gw.hub.log.read(key, 0) as SessionEvent[];
    expect(read().filter((e) => e.body.t === 'turn.completed').map((e) => (e.body as { status: string }).status)).toEqual(['completed', 'interrupted']);
    const before = read().length;
    await b.say('second', (r) => r.includes('echo:') && r.includes('second'));
    expect(calls(dir).filter((c) => c.call === 'start')).toHaveLength(2);
    expect(calls(dir).filter((c) => c.call === 'session/load').map((c) => c.params.sessionId)).toEqual([native]);
    const after = read().slice(before);
    // The replay (the earlier exchanges, a tool call, a plan) never reached the log: only the new turn.
    expect(after.filter((e) => e.body.t === 'item.started' || e.body.t === 'plan.updated')).toEqual([]);
    expect(after.filter((e) => e.body.t === 'text.snapshot').map((e) => (e.body as { text: string }).text)).not.toContain(firstAnswer);
    expect(after.filter((e) => e.body.t === 'turn.completed')).toHaveLength(1);
  });
});
