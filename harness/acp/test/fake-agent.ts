/*
 * A fake ACP agent on stdio, built on the official SDK's agent side (`agent()` of
 * `@agentclientprotocol/sdk`), for the adapter's tests: the real wire, a scripted agent. Run it
 * with node on the sources (`--experimental-transform-types`, `scripts/source-loader.mjs`).
 *
 * What a prompt does depends on a word in its last text block:
 *   (default)   answers `echo: <text>` in two chunks
 *   pause       waits 300 ms, then answers as the default
 *   tool        a command tool call that runs and completes, then `done`
 *   permission  an edit tool call that asks permission (allow once / always / reject); answers
 *               `permission: <optionId>` (or stops `cancelled` when the outcome is cancelled)
 *   slow        streams a chunk every 30 ms until `session/cancel` (stops `cancelled`)
 *   stubborn    ignores `session/cancel`: streams `stale <i> ` every 30 ms for FAKE_ACP_STUBBORN_MS
 *               (default 1500), stopping early only at `session/close`; then stops `cancelled`
 *   plan        a plan, then `planned`
 *   think       a thought chunk, then `thought`
 *   ask         a form elicitation (when the client advertised one), answers what it got
 *   mcp         lists the tools of the session's MCP server (stdio or http), answers their names
 *   usage       a usage update, then `used`
 *   fail        answers the prompt with an error
 *   null        says something, then answers the prompt with a null result (no stop reason), as a
 *               non-conforming agent may
 *   exit        exits mid-turn (code 1)
 *   twice       two messages around a tool call; the answer is the second
 *   compacting  a compaction reported as Claude Code's ACP agent does (a tool call "Compact
 *               conversation", `_meta.claudeCode.toolName` `compact`), then `compacted`
 *
 * Environment: FAKE_ACP_LOG (append every call, one JSON line each), FAKE_ACP_STATE (a directory
 * the sessions' history is kept in, so another process can `session/load` it), FAKE_ACP_PROTOCOL
 * (the protocol version answered, default 1), FAKE_ACP_CAPS (JSON over the agent capabilities),
 * FAKE_ACP_ENV_KEYS (comma list of variables whose values the log records at start),
 * FAKE_ACP_NO_MODES=1 (no session modes), FAKE_ACP_MODES (comma list of the session mode ids
 * offered, default `default,plan,yolo`), FAKE_ACP_OPEN_MODE (the mode a session opens in, default
 * `default`), FAKE_ACP_NO_COMMANDS=1 (advertise no commands). A prompt's log entry has the session
 * mode it ran in (`mode`); `prompt-end` (with its `sessionId`) is logged as it answers. `session/close`
 * stops a session's work (its prompt answers `cancelled`) and forgets it: `session/load` reopens it.
 */
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { agent, methods, ndJsonStream, RequestError, type AgentContext, type ContentBlock, type McpServer, type PromptRequest, type PromptResponse, type SessionUpdate } from '@agentclientprotocol/sdk';

const env = process.env;
const log = (entry: Record<string, unknown>) => {
  if (env.FAKE_ACP_LOG) appendFileSync(env.FAKE_ACP_LOG, JSON.stringify(entry) + '\n');
};
log({
  call: 'start',
  pid: process.pid,
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  env: Object.fromEntries((env.FAKE_ACP_ENV_KEYS ?? '').split(',').filter(Boolean).map((k) => [k, env[k]])),
});

interface Sess {
  id: string;
  cwd: string;
  mode: string;
  mcp: McpServer[];
  cancelled: boolean;
  closed?: boolean;
  history: { role: 'user' | 'agent'; text: string }[];
}
const sessions = new Map<string, Sess>();
let seq = 0;
let clientCaps: Record<string, unknown> = {};
const stateDir = env.FAKE_ACP_STATE;
const save = (s: Sess) => {
  if (!stateDir) return;
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, `${s.id}.json`), JSON.stringify(s.history));
};
const loaded = (id: string): Sess['history'] | undefined => {
  const f = stateDir ? join(stateDir, `${id}.json`) : undefined;
  return f && existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as Sess['history']) : undefined;
};
const MODE_NAMES: Record<string, { name: string; description?: string }> = { default: { name: 'Default' }, plan: { name: 'Plan', description: 'Plans before acting' }, yolo: { name: 'Bypass permissions' } };
const OPEN_MODE = env.FAKE_ACP_OPEN_MODE ?? 'default';
const modes = (current: string) =>
  env.FAKE_ACP_NO_MODES === '1'
    ? undefined
    : {
        currentModeId: current,
        availableModes: (env.FAKE_ACP_MODES ?? 'default,plan,yolo').split(',').map((id) => ({ id, ...(MODE_NAMES[id] ?? { name: id }) })),
      };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const text = (t: string): ContentBlock => ({ type: 'text', text: t });

async function update(cx: AgentContext, sessionId: string, u: SessionUpdate) {
  await cx.notify(methods.client.session.update, { sessionId, update: u });
}
async function say(cx: AgentContext, s: Sess, words: string, messageId?: string) {
  const half = Math.ceil(words.length / 2);
  for (const part of [words.slice(0, half), words.slice(half)]) {
    if (part) await update(cx, s.id, { sessionUpdate: 'agent_message_chunk', content: text(part), ...(messageId ? { messageId } : {}) });
  }
}

/** The names of the tools of an MCP server, over stdio (spawned) or HTTP. */
async function listTools(server: McpServer): Promise<string[]> {
  const ask = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake-acp', version: '0' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
  ];
  if ('command' in server) {
    const child = spawn(server.command, server.args, { env: { ...process.env, ...Object.fromEntries(server.env.map((e) => [e.name, e.value])) }, stdio: ['pipe', 'pipe', 'inherit'] });
    const answers = new Map<number, unknown>();
    let buf = '';
    const got = new Promise<void>((resolve, reject) => {
      child.stdout.on('data', (d: Buffer) => {
        buf += d.toString();
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (!line.trim()) continue;
          const m = JSON.parse(line) as { id?: number; result?: unknown };
          if (m.id !== undefined) answers.set(m.id, m.result);
          if (answers.has(2)) resolve();
        }
      });
      child.on('exit', () => reject(new Error('mcp server exited')));
    });
    child.stdin.write(JSON.stringify(ask[0]) + '\n');
    await new Promise((r) => setTimeout(r, 50));
    child.stdin.write(JSON.stringify(ask[1]) + '\n');
    child.stdin.write(JSON.stringify(ask[2]) + '\n');
    await got;
    child.stdin.end();
    child.kill();
    return ((answers.get(2) as { tools?: { name: string }[] })?.tools ?? []).map((t) => t.name);
  }
  const headers = Object.fromEntries([['content-type', 'application/json'], ['accept', 'application/json, text/event-stream'], ...server.headers.map((h) => [h.name, h.value])]);
  let tools: string[] = [];
  for (const m of ask) {
    const res = await fetch(server.url, { method: 'POST', headers, body: JSON.stringify(m) });
    if (m.id === 2) tools = (((await res.json()) as { result?: { tools?: { name: string }[] } }).result?.tools ?? []).map((t) => t.name);
    else await res.text();
  }
  return tools;
}

const app = agent({ name: 'fake-acp' })
  .onRequest(methods.agent.initialize, ({ params }) => {
    log({ call: 'initialize', params });
    clientCaps = (params.clientCapabilities ?? {}) as Record<string, unknown>;
    return {
      protocolVersion: Number(env.FAKE_ACP_PROTOCOL ?? 1),
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: true, embeddedContext: true },
        mcpCapabilities: { http: true },
        sessionCapabilities: { systemPrompt: {} },
        ...(env.FAKE_ACP_CAPS ? (JSON.parse(env.FAKE_ACP_CAPS) as object) : {}),
      },
      agentInfo: { name: 'fake-acp', title: 'Fake ACP', version: '1.2.3' },
      authMethods: [],
    };
  })
  .onRequest(methods.agent.session.new, ({ params, client }) => {
    log({ call: 'session/new', params });
    const s: Sess = { id: `sess-${process.pid}-${++seq}`, cwd: params.cwd, mode: OPEN_MODE, mcp: params.mcpServers, cancelled: false, history: [] };
    sessions.set(s.id, s);
    save(s);
    if (env.FAKE_ACP_NO_COMMANDS !== '1')
      setTimeout(() => void update(client, s.id, { sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'compact', description: 'Compact the context' }] }), 5);
    const m = modes(s.mode);
    return { sessionId: s.id, ...(m ? { modes: m } : {}) };
  })
  .onRequest(methods.agent.session.load, async ({ params, client }) => {
    log({ call: 'session/load', params });
    const history = loaded(params.sessionId);
    if (!history) throw RequestError.resourceNotFound(params.sessionId);
    const s: Sess = { id: params.sessionId, cwd: params.cwd, mode: OPEN_MODE, mcp: params.mcpServers, cancelled: false, history };
    sessions.set(s.id, s);
    // Replays the conversation before answering (the spec), a tool call and a plan among it.
    for (const [i, h] of history.entries()) {
      await update(client, s.id, { sessionUpdate: h.role === 'user' ? 'user_message_chunk' : 'agent_message_chunk', content: text(h.text) });
      if (i === 0) await update(client, s.id, { sessionUpdate: 'tool_call', toolCallId: `old-${i}`, title: 'Old tool', kind: 'execute', status: 'completed' });
    }
    await update(client, s.id, { sessionUpdate: 'plan', entries: [{ content: 'old plan', priority: 'low', status: 'completed' }] });
    const m = modes(s.mode);
    return m ? { modes: m } : {};
  })
  .onRequest(methods.agent.session.setMode, async ({ params, client }) => {
    log({ call: 'session/set_mode', params });
    const s = sessions.get(params.sessionId);
    if (!s) throw RequestError.resourceNotFound(params.sessionId);
    s.mode = params.modeId;
    await update(client, s.id, { sessionUpdate: 'current_mode_update', currentModeId: params.modeId });
    return {};
  })
  .onNotification(methods.agent.session.cancel, ({ params }) => {
    log({ call: 'session/cancel', params });
    const s = sessions.get(params.sessionId);
    if (s) s.cancelled = true;
  })
  .onRequest(methods.agent.session.close, ({ params }) => {
    log({ call: 'session/close', params });
    const s = sessions.get(params.sessionId);
    if (s) s.cancelled = s.closed = true;
    sessions.delete(params.sessionId);
    return {};
  })
  .onRequest(methods.agent.session.prompt, async ({ params, client }) => {
    try {
      return await prompt(params, client);
    } finally {
      log({ call: 'prompt-end', sessionId: params.sessionId });
    }
  });

async function prompt(params: PromptRequest, client: AgentContext): Promise<PromptResponse> {
  const s = sessions.get(params.sessionId);
  log({ call: 'session/prompt', params, ...(s && env.FAKE_ACP_NO_MODES !== '1' ? { mode: s.mode } : {}) });
  if (!s) throw RequestError.resourceNotFound(params.sessionId);
  s.cancelled = false;
  const words = params.prompt.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('\n');
  const last = [...params.prompt].reverse().find((b) => b.type === 'text');
  const cmd = last && last.type === 'text' ? last.text.split('\n').at(-1)!.trim() : '';
  s.history.push({ role: 'user', text: cmd });
  let answer: string;
  const has = (w: string) => cmd.split(/\s+/).includes(w);

  if (has('fail')) throw RequestError.internalError({ why: 'asked to fail' }, 'the fake agent failed');
  if (has('null')) {
    await say(client, s, 'no stop reason');
    return null as never;
  }
  if (has('exit')) {
    await say(client, s, 'about to exit');
    setTimeout(() => process.exit(1), 10);
    await sleep(10_000);
  }
  if (has('pause')) await sleep(300);
  if (has('stubborn')) {
    const until = Date.now() + Number(env.FAKE_ACP_STUBBORN_MS ?? 1500);
    for (let i = 0; !s.closed && Date.now() < until; i++) {
      await update(client, s.id, { sessionUpdate: 'agent_message_chunk', content: text(`stale ${i} `) });
      await sleep(30);
    }
    return { stopReason: 'cancelled' };
  }
  if (has('slow')) {
    for (let i = 0; !s.cancelled && i < 400; i++) {
      await update(client, s.id, { sessionUpdate: 'agent_message_chunk', content: text(`${i} `) });
      await sleep(30);
    }
    return { stopReason: s.cancelled ? 'cancelled' : 'end_turn' };
  }
  if (has('tool')) {
    await update(client, s.id, { sessionUpdate: 'tool_call', toolCallId: 'call-1', title: 'Run ls', kind: 'execute', status: 'pending', rawInput: { command: 'ls -la' } });
    await update(client, s.id, { sessionUpdate: 'tool_call_update', toolCallId: 'call-1', status: 'in_progress' });
    await update(client, s.id, { sessionUpdate: 'tool_call_update', toolCallId: 'call-1', status: 'completed', content: [{ type: 'content', content: text('a.txt\nb.txt') }] });
    answer = 'done';
  } else if (has('twice')) {
    await say(client, s, 'let me look', 'm1');
    await update(client, s.id, { sessionUpdate: 'tool_call', toolCallId: 'call-2', title: 'mcp__agents-io__get_channel_context', name: 'mcp__agents-io__get_channel_context', kind: 'other', status: 'pending' });
    await update(client, s.id, { sessionUpdate: 'tool_call_update', toolCallId: 'call-2', status: 'completed', rawOutput: { ok: true } });
    answer = 'here it is';
    await say(client, s, answer, 'm2');
    s.history.push({ role: 'agent', text: answer });
    save(s);
    return { stopReason: 'end_turn' };
  } else if (has('permission')) {
    await update(client, s.id, { sessionUpdate: 'tool_call', toolCallId: 'call-p', title: 'Edit a.txt', kind: 'edit', status: 'pending', rawInput: { path: '/tmp/a.txt' }, locations: [{ path: '/tmp/a.txt' }] });
    const r = await client.request(methods.client.session.requestPermission, {
      sessionId: s.id,
      toolCall: { toolCallId: 'call-p', title: 'Edit a.txt', kind: 'edit', status: 'pending', rawInput: { path: '/tmp/a.txt' } },
      options: [
        { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
        { optionId: 'always', name: 'Always allow edits', kind: 'allow_always' },
        { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
      ],
    });
    log({ call: 'permission-outcome', outcome: r.outcome });
    if (r.outcome.outcome === 'cancelled') return { stopReason: 'cancelled' };
    const ok = r.outcome.optionId !== 'reject';
    await update(client, s.id, { sessionUpdate: 'tool_call_update', toolCallId: 'call-p', status: ok ? 'completed' : 'failed' });
    answer = `permission: ${r.outcome.optionId}`;
  } else if (has('plan')) {
    await update(client, s.id, {
      sessionUpdate: 'plan',
      entries: [
        { content: 'look', priority: 'high', status: 'completed' },
        { content: 'think', priority: 'medium', status: 'in_progress' },
        { content: 'answer', priority: 'low', status: 'pending' },
      ],
    });
    answer = 'planned';
  } else if (has('think')) {
    await update(client, s.id, { sessionUpdate: 'agent_thought_chunk', content: text('hmm') });
    answer = 'thought';
  } else if (has('usage')) {
    await update(client, s.id, { sessionUpdate: 'usage_update', used: 1200, size: 200000, cost: { amount: 0.01, currency: 'USD' } });
    answer = 'used';
  } else if (has('ask')) {
    if (!(clientCaps.elicitation as { form?: unknown } | undefined)?.form) answer = 'no elicitation';
    else {
      const r = await client.request(methods.client.elicitation.create, {
        sessionId: s.id,
        mode: 'form',
        message: 'Which colour?',
        requestedSchema: {
          type: 'object',
          properties: {
            colour: { type: 'string', title: 'Colour', oneOf: [{ const: 'r', title: 'Red' }, { const: 'g', title: 'Green' }] },
            count: { type: 'integer', title: 'How many' },
            sure: { type: 'boolean', title: 'Sure?' },
          },
          required: ['colour'],
        },
      });
      log({ call: 'elicitation-outcome', outcome: r });
      if (r.action === 'cancel') return { stopReason: 'cancelled' };
      answer = r.action === 'accept' ? `answered: ${JSON.stringify((r as { content?: unknown }).content ?? {})}` : `declined`;
    }
  } else if (has('mcp')) {
    const server = s.mcp[0];
    answer = server ? `tools: ${(await listTools(server)).join(',')}` : 'no mcp';
  } else if (cmd === '/compact') {
    answer = 'compacted';
  } else if (has('compacting')) {
    const meta = { claudeCode: { toolName: 'compact' } };
    await update(client, s.id, { sessionUpdate: 'tool_call', toolCallId: 'compact-1', title: 'Compact conversation', kind: 'think', status: 'in_progress', _meta: meta });
    await update(client, s.id, { sessionUpdate: 'tool_call_update', toolCallId: 'compact-1', status: 'completed', rawOutput: { trigger: 'auto' }, _meta: meta });
    answer = 'compacted';
  } else answer = `echo: ${words}`;

  await say(client, s, answer);
  s.history.push({ role: 'agent', text: answer });
  save(s);
  return { stopReason: 'end_turn' };
}

app.connect(ndJsonStream(Writable.toWeb(process.stdout) as WritableStream<Uint8Array>, Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>));
