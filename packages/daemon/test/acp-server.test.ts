import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough, Readable, Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { client as acpClient, methods, ndJsonStream, type ClientConnection, type RequestPermissionRequest, type SessionNotification } from '@agentclientprotocol/sdk';
import type { InputRecord, RouteExplanation } from '@agents-io/protocol';
import { ConfigError, LocalClient } from '@agents-io/kernel';
import { resolveConfig } from '../src/defaults.js';
import { acpPipe } from '../src/acp-server.js';
import { SOURCE_LOADER, cleanups, daemon, tmp, until, type World } from './helpers.js';

/*
 * The ACP server (core-slimming G9, north): an editor's ACP client reaches a session through `aio
 * acp`, which pipes ACP between its stdio and the daemon's local socket. Driven with the official
 * SDK's client side (its parser checks every message the server sends), in process through
 * `acpPipe` and once through the real `aio acp` process.
 */

const TOKENS = { zed: 'zed-token-0123456789abcdef', narrow: 'narrow-token-0123456789ab', asker: 'asker-token-0123456789abc' };

function tokenFiles(dir: string): Record<keyof typeof TOKENS, string> {
  const d = join(dir, 'acp');
  mkdirSync(d, { recursive: true, mode: 0o700 });
  const out = {} as Record<keyof typeof TOKENS, string>;
  for (const [k, v] of Object.entries(TOKENS)) {
    const f = join(d, `${k}.token`);
    writeFileSync(f, v + '\n', { mode: 0o600 });
    out[k as keyof typeof TOKENS] = f;
  }
  return out;
}

async function world(o: { raw?: Record<string, unknown>; script?: Parameters<typeof daemon>[0] extends infer X ? (X extends { script?: infer S } ? S : never) : never; clients?: (f: Record<keyof typeof TOKENS, string>) => Record<string, unknown> } = {}) {
  const dir = tmp();
  const f = tokenFiles(dir);
  const clients = o.clients?.(f) ?? {
    zed: { tokenFile: f.zed, scopes: ['read:S*', 'input:S1'], agent: 'dev' },
    narrow: { tokenFile: f.narrow, scopes: ['read:S2'] },
    asker: { tokenFile: f.asker, scopes: [], agent: 'dev', approvals: true },
  };
  const w = await daemon({ dir, ...(o.script ? { script: o.script } : {}), raw: { agents: { dev: { harness: 'claude-code' } }, acpServer: { clients }, ...(o.raw ?? {}) } });
  return { w, files: f };
}

/** An ACP client connected through `acpPipe` (what `aio acp` runs), collecting what the server sends. */
async function editor(w: World, name: keyof typeof TOKENS, o: { session?: string; permission?: (p: RequestPermissionRequest) => Promise<unknown> | unknown; elicitation?: boolean } = {}) {
  const toDaemon = new PassThrough();
  const fromDaemon = new PassThrough();
  const updates: SessionNotification[] = [];
  const asked: RequestPermissionRequest[] = [];
  const exit = acpPipe({ socket: w.config.socketPath, client: name, token: TOKENS[name], ...(o.session ? { session: o.session } : {}), input: toDaemon, output: fromDaemon, error: () => {} });
  const app = acpClient({ name: 'test-editor' })
    .onNotification(methods.client.session.update, ({ params }) => void updates.push(params))
    .onRequest(methods.client.session.requestPermission, async ({ params }) => {
      asked.push(params);
      return (await (o.permission ?? (() => ({ outcome: { outcome: 'selected', optionId: 'allow_once' } })))(params)) as never;
    });
  const conn: ClientConnection = app.connect(ndJsonStream(Writable.toWeb(toDaemon) as WritableStream<Uint8Array>, Readable.toWeb(fromDaemon) as ReadableStream<Uint8Array>));
  cleanups.push(() => {
    conn.close();
    toDaemon.end();
  });
  const init = await conn.agent.request(methods.agent.initialize, { protocolVersion: 1, clientCapabilities: o.elicitation ? { elicitation: { form: {} } } : {} });
  return { conn, agent: conn.agent, updates, asked, init, exit, close: () => toDaemon.end() };
}

const texts = (u: SessionNotification[], kind: string) => u.filter((x) => x.update.sessionUpdate === kind).map((x) => ('content' in x.update && x.update.content.type === 'text' ? x.update.content.text : '')).join('');
const admitted = (w: World, key: string): InputRecord[] => w.gw.hub.log.read(key, 0).flatMap((e) => (e.body.t === 'input.admitted' && e.body.input ? [e.body.input] : []));

describe('ACP server: off by default, tokens, scopes', () => {
  it('is off without acpServer: hello does not advertise acp.server and aio acp is told the daemon does not run it; with it, a wrong token or another client\'s name is refused #SE-5 #CF-10', async () => {
    const off = await daemon();
    const probe = await off.client();
    expect((await probe.hello({ token: off.gw.token, name: 'probe' })).features).not.toContain('acp.server');
    const said: string[] = [];
    expect(await acpPipe({ socket: off.config.socketPath, client: 'zed', token: TOKENS.zed, input: new PassThrough(), output: new PassThrough(), error: (m) => said.push(m) })).toBe(2);
    expect(said[0]).toMatch(/does not run the ACP server/);

    const { w } = await world();
    const h = await w.client();
    expect((await h.hello({ token: w.gw.token, name: 'probe' })).features).toContain('acp.server');
    const refused: string[] = [];
    expect(await acpPipe({ socket: w.config.socketPath, client: 'zed', token: 'not-the-token-0123456789', input: new PassThrough(), output: new PassThrough(), error: (m) => refused.push(m) })).toBe(77);
    expect(await acpPipe({ socket: w.config.socketPath, client: 'narrow', token: TOKENS.zed, input: new PassThrough(), output: new PassThrough(), error: (m) => refused.push(m) })).toBe(77);
    expect(refused).toEqual([expect.stringMatching(/unauthorized/), expect.stringMatching(/unauthorized/)]);
    // The token never reaches the status or the log lines: only client names.
    expect(JSON.stringify(w.gw.adminStatus().modules)).not.toContain(TOKENS.zed);
  });

  it('a client principal is never a person: owner ids, owner labels and non-external principals are config errors; scopes are read and input only #ID-10 #CF-10', () => {
    const at = (clients: Record<string, unknown>) => () =>
      resolveConfig({ policy: { owners: ['fake:alice'] }, agents: { dev: { harness: 'claude-code' } }, acpServer: { clients } }, { env: { T: 'a-token-of-sixteen-chars' }, baseDir: tmp(), cwd: tmp() });
    expect(at({ a: { token: 'env:T', scopes: ['read'], principal: 'fake:alice' } })).toThrow(/acpServer\.clients\.a\.principal must be "external:<id>"/);
    expect(at({ a: { token: 'env:T', scopes: ['read'], principal: 'external:x', labels: ['owner'] } })).toThrow(/never carries the owner label/);
    expect(at({ a: { token: 'env:T', scopes: ['send:fake:*'] } })).toThrow(/is not a scope of this endpoint/);
    expect(at({ a: { token: 'literal-token-0123456789', scopes: ['read'] } })).toThrow(/token must be "env:NAME"/);
    expect(at({ a: { token: 'env:T', scopes: ['read'], agent: 'ghost' } })).toThrow(/agent: no agent "ghost"/);
    expect(at({ a: { token: 'env:T', scopes: ['read'] } })).not.toThrow();
    // Not a ConfigError of its secret: the message names the key, never the value.
    try {
      at({ a: { token: 'env:T', scopes: ['bogus'] } })();
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as Error).message).not.toContain('a-token-of-sixteen-chars');
    }
  });
});

describe('ACP server: sessions as ACP agents', () => {
  it('through the real `aio acp` process: initialize says what agents-io supports, session/new opens a session of the client\'s own, a prompt is a turn whose answer comes as agent_message_chunk, then end_turn #ID-10', async () => {
    const { w, files } = await world();
    const cli = join(import.meta.dirname, '..', 'src', 'cli.ts');
    const child = spawn(process.execPath, [...SOURCE_LOADER, cli, 'acp', '--socket', w.config.socketPath, '--client', 'zed', '--token-file', files.zed], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d));
    const exited = new Promise<number | null>((r) => child.on('exit', (c) => r(c)));
    cleanups.push(() => void child.kill());
    const updates: SessionNotification[] = [];
    const conn = acpClient({ name: 'zed-like' })
      .onNotification(methods.client.session.update, ({ params }) => void updates.push(params))
      .connect(ndJsonStream(Writable.toWeb(child.stdin) as WritableStream<Uint8Array>, Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>));
    const init = await conn.agent.request(methods.agent.initialize, { protocolVersion: 1, clientCapabilities: {} });
    expect(init).toMatchObject({ protocolVersion: 1, agentCapabilities: { loadSession: true, promptCapabilities: { image: true, audio: false } }, agentInfo: { name: 'agents-io' }, authMethods: [] });
    const s = await conn.agent.request(methods.agent.session.new, { cwd: '/tmp', mcpServers: [] });
    expect(s.sessionId).toMatch(/^acp-server:zed:[0-9a-f-]{36}$/);
    const r = await conn.agent.request(methods.agent.session.prompt, { sessionId: s.sessionId, prompt: [{ type: 'text', text: 'hello there' }] });
    expect(r).toEqual({ stopReason: 'end_turn' });
    expect(texts(updates, 'agent_message_chunk')).toBe('echo: hello there');
    // The client shows its own prompt: no user_message_chunk of it.
    expect(updates.some((u) => u.update.sessionUpdate === 'user_message_chunk')).toBe(false);
    // Stamped by the daemon as the client: a peer with its own principal, never a person; a cause, a routing record.
    const [input] = admitted(w, s.sessionId);
    expect(input!.origin).toEqual({ kind: 'peer', principal: { id: 'external:zed', labels: ['external'] }, evidence: 'device_only', via: 'acp-server:zed', adapter: 'acp-server' });
    expect(input!.cause).toEqual({ peer: 'acp-server:zed', basis: 'none' });
    expect(input!.replyRoute).toEqual({ channel: 'local', account: 'local', conversationId: s.sessionId });
    const record = w.gw.explain(input!.inputId, false);
    expect(record.ok && (record.value as RouteExplanation).matched[0]).toMatchObject({ bindingId: 'acp-server:zed', sessionKey: s.sessionId, agent: 'dev' });
    const started = w.gw.hub.log.read(s.sessionId, 0).find((e) => e.body.t === 'turn.started')!;
    expect((started.body as { run?: { profile?: string } }).run?.profile).toBe('restricted');
    child.stdin.end();
    expect(await exited).toBe(0);
    expect(stderr).toBe('');
  });

  it('session/load replays the log as session/update (what was said, by whom), then goes on live; session/list lists what the client may read #CF-10', async () => {
    const { w } = await world();
    const local = await w.client();
    await local.input('S1', 'from the owner side');
    await until(() => w.gw.hub.log.read('S1', 0).some((e) => e.body.t === 'turn.completed'));
    const e = await editor(w, 'zed');
    const list = await e.agent.request(methods.agent.session.list, {});
    expect(list.sessions.map((x) => x.sessionId)).toEqual(['S1']);
    await e.agent.request(methods.agent.session.load, { sessionId: 'S1', cwd: '/tmp', mcpServers: [] });
    expect(e.updates.map((u) => u.update.sessionUpdate)).toEqual(['user_message_chunk', 'agent_message_chunk']);
    expect(texts(e.updates, 'user_message_chunk')).toBe('[me] from the owner side');
    expect(texts(e.updates, 'agent_message_chunk')).toBe('echo: from the owner side');
    // Live from here: another end's turn shows as it happens.
    await local.input('S1', 'and again');
    await until(() => texts(e.updates, 'agent_message_chunk').endsWith('echo: and again'));
    // Outside its read scope: as if there were no such session.
    await local.input('T9', 'private');
    await until(() => w.gw.hub.log.read('T9', 0).some((x) => x.body.t === 'turn.completed'));
    await expect(e.agent.request(methods.agent.session.load, { sessionId: 'T9', cwd: '/tmp', mcpServers: [] })).rejects.toMatchObject({ code: -32002 });
    await expect(e.agent.request(methods.agent.session.prompt, { sessionId: 'T9', prompt: [{ type: 'text', text: 'x' }] })).rejects.toMatchObject({ code: -32002 });
  });

  it('a session given with --session: session/new binds it; prompting it needs an input scope, reading it a read scope #CF-10', async () => {
    const { w } = await world();
    const local = await w.client();
    await local.input('S2', 'hi');
    await until(() => w.gw.hub.log.read('S2', 0).some((e) => e.body.t === 'turn.completed'));
    const n = await editor(w, 'narrow', { session: 'S2' });
    const s = await n.agent.request(methods.agent.session.new, { cwd: '/tmp', mcpServers: [] });
    expect(s.sessionId).toBe('S2');
    await expect(n.agent.request(methods.agent.session.prompt, { sessionId: 'S2', prompt: [{ type: 'text', text: 'may I' }] })).rejects.toMatchObject({ data: { code: 'forbidden' } });
    expect(admitted(w, 'S2')).toHaveLength(1);
    // A client with no agent opens no session of its own, and one outside its read scope is not bound.
    const none = await editor(w, 'narrow');
    await expect(none.agent.request(methods.agent.session.new, { cwd: '/tmp', mcpServers: [] })).rejects.toMatchObject({ data: { code: 'forbidden' } });
    const other = await editor(w, 'narrow', { session: 'S1' });
    await expect(other.agent.request(methods.agent.session.new, { cwd: '/tmp', mcpServers: [] })).rejects.toThrow();
  });

  it('a prompt with an image puts it in the blob store; the turn gets it as an image block #ID-10', async () => {
    const { w } = await world();
    const e = await editor(w, 'zed');
    const s = await e.agent.request(methods.agent.session.new, { cwd: '/tmp', mcpServers: [] });
    const png = Buffer.from('89504e470d0a1a0a', 'hex').toString('base64');
    await e.agent.request(methods.agent.session.prompt, { sessionId: s.sessionId, prompt: [{ type: 'text', text: 'look' }, { type: 'image', data: png, mimeType: 'image/png' }] });
    const [input] = admitted(w, s.sessionId);
    expect(input!.content).toEqual([{ type: 'text', text: 'look' }, { type: 'image', ref: expect.stringMatching(/^sha256:/), mime: 'image/png' }]);
    expect((await w.gw.blobs.get((input!.content[1] as { ref: string }).ref)).mime).toBe('image/png');
  });
});

describe('ACP server: requests, cancel and the loop guard', () => {
  it('a request is asked of the client only when its resolver names it (approvals: true): its answer resolves it as the client, checked by the lane; without it, nothing is asked #RQ-1 #RQ-3', async () => {
    const script = async (t: { emit: (b: never, x?: never) => void; waitDecision: (id: string) => Promise<unknown> }) => {
      t.emit({ t: 'request.opened', requestId: 'r1', kind: 'tool_approval', title: 'Run ls', risk: {}, allowedDecisions: ['allow_once', 'deny'], allowAlways: false, defaultDeny: true } as never);
      const d = (await t.waitDecision('r1')) as { kind: string };
      t.emit({ t: 'text.snapshot', text: `decided ${d.kind}`, final: true } as never, { audience: 'answer' } as never);
    };
    const { w } = await world({ script: script as never });
    const a = await editor(w, 'asker');
    const s = await a.agent.request(methods.agent.session.new, { cwd: '/tmp', mcpServers: [] });
    const r = await a.agent.request(methods.agent.session.prompt, { sessionId: s.sessionId, prompt: [{ type: 'text', text: 'go' }] });
    expect(r.stopReason).toBe('end_turn');
    expect(a.asked).toHaveLength(1);
    expect(a.asked[0]!.options.map((o) => o.optionId)).toEqual(['allow_once', 'deny']);
    const resolved = w.gw.hub.log.read(s.sessionId, 0).find((e) => e.body.t === 'request.resolved')!.body as { decision: { kind: string }; by: unknown };
    // Answered as itself (never on someone's behalf): no via.
    expect(resolved).toMatchObject({ decision: { kind: 'allow_once' }, by: { kind: 'human', id: 'external:asker' } });
    expect((resolved.by as { via?: string }).via).toBeUndefined();
    expect(texts(a.updates, 'agent_message_chunk')).toBe('decided allow_once');

    // zed has no approvals: the policy decides (a peer's restricted turn: denied), nothing is asked.
    const z = await editor(w, 'zed');
    const zs = await z.agent.request(methods.agent.session.new, { cwd: '/tmp', mcpServers: [] });
    await z.agent.request(methods.agent.session.prompt, { sessionId: zs.sessionId, prompt: [{ type: 'text', text: 'go' }] });
    expect(z.asked).toHaveLength(0);
    expect(w.gw.hub.log.read(zs.sessionId, 0).find((e) => e.body.t === 'request.resolved')!.body).toMatchObject({ decision: { kind: 'deny' }, by: { kind: 'auto' } });
    // The client sees the request as a pending tool call either way, and how it went.
    expect(z.updates.filter((u) => u.update.sessionUpdate === 'tool_call' || u.update.sessionUpdate === 'tool_call_update').map((u) => (u.update as { status?: string }).status)).toEqual(['pending', 'failed']);
  });

  it('answered first by someone else: the client\'s ask is withdrawn and its late answer is refused (first wins) #RQ-1', async () => {
    let decided = '';
    const script = async (t: { emit: (b: never, x?: never) => void; waitDecision: (id: string) => Promise<unknown> }) => {
      t.emit({ t: 'request.opened', requestId: 'r2', kind: 'tool_approval', title: 'Edit a.txt', risk: { writes: true }, allowedDecisions: [], allowAlways: true, defaultDeny: true } as never);
      decided = ((await t.waitDecision('r2')) as { kind: string }).kind;
    };
    const { w } = await world({ script: script as never, raw: { policy: { owners: ['fake:alice'], answerOnBehalf: true } } });
    let release: (v: unknown) => void = () => {};
    const late = new Promise((r) => (release = r));
    const a = await editor(w, 'asker', { permission: () => late });
    const s = await a.agent.request(methods.agent.session.new, { cwd: '/tmp', mcpServers: [] });
    const prompt = a.agent.request(methods.agent.session.prompt, { sessionId: s.sessionId, prompt: [{ type: 'text', text: 'go' }] });
    await until(() => a.asked.length === 1);
    expect(a.asked[0]!.options.map((o) => o.kind)).toEqual(['allow_once', 'allow_always', 'reject_once']);
    // The host answers on the client principal's behalf first (decision 13, RQ-3: the host only).
    const host = await w.host({ name: 'xwo' });
    await host.command({ type: 'resolve', sessionKey: s.sessionId, requestId: 'r2', decision: { kind: 'deny' }, onBehalfOf: 'external:asker' });
    expect(await prompt).toEqual({ stopReason: 'end_turn' });
    release({ outcome: { outcome: 'selected', optionId: 'allow_session' } });
    await new Promise((x) => setTimeout(x, 50));
    expect(decided).toBe('deny');
    const res = w.gw.hub.log.read(s.sessionId, 0).filter((e) => e.body.t === 'request.resolved');
    expect(res).toHaveLength(1);
    expect(res[0]!.body).toMatchObject({ decision: { kind: 'deny' }, by: { kind: 'human', id: 'external:asker', via: 'host:xwo' } });
  });

  it('session/cancel interrupts the client\'s own turn (stopReason cancelled); a turn someone else started is not touched #CT-1', async () => {
    const script = async (t: { emit: (b: never, x?: never) => void; signal: AbortSignal; inputs: InputRecord[] }) => {
      if (t.inputs.some((i) => i.content.some((c) => c.type === 'text' && c.text.includes('long')))) await new Promise<void>((r) => t.signal.addEventListener('abort', () => r(), { once: true }));
      t.emit({ t: 'text.snapshot', text: 'done', final: true } as never, { audience: 'answer' } as never);
    };
    const { w } = await world({ script: script as never, clients: (f) => ({ zed: { tokenFile: f.zed, scopes: ['read:S*', 'input:S*'], agent: 'dev' } }) });
    const e = await editor(w, 'zed');
    const s = await e.agent.request(methods.agent.session.new, { cwd: '/tmp', mcpServers: [] });
    const p = e.agent.request(methods.agent.session.prompt, { sessionId: s.sessionId, prompt: [{ type: 'text', text: 'a long one' }] });
    await until(() => w.gw.hub.log.read(s.sessionId, 0).some((x) => x.body.t === 'turn.started'));
    await e.agent.notify(methods.agent.session.cancel, { sessionId: s.sessionId });
    expect(await p).toEqual({ stopReason: 'cancelled' });
    expect(w.gw.hub.log.read(s.sessionId, 0).find((x) => x.body.t === 'turn.completed')!.body).toMatchObject({ status: 'interrupted' });

    // The owner's turn in S1: the client's cancel interrupts nothing.
    const local: LocalClient = await w.client();
    await local.input('S1', 'a long one from me');
    await until(() => w.gw.hub.log.read('S1', 0).some((x) => x.body.t === 'turn.started'));
    await e.agent.request(methods.agent.session.load, { sessionId: 'S1', cwd: '/tmp', mcpServers: [] });
    await e.agent.notify(methods.agent.session.cancel, { sessionId: 'S1' });
    await new Promise((x) => setTimeout(x, 100));
    expect(w.gw.hub.log.read('S1', 0).some((x) => x.body.t === 'turn.completed')).toBe(false);
    await local.command({ type: 'interrupt', sessionKey: 'S1' });
  });

  it('prompts go through the lane\'s loop guard: past pair.maxTurns the prompt is kept as context and answered an error saying so #IN-8 #ID-10', async () => {
    const { w } = await world({ raw: { policy: { owners: ['fake:alice'], loopGuard: { pair: { maxTurns: 2 } } } } });
    const e = await editor(w, 'zed');
    const s = await e.agent.request(methods.agent.session.new, { cwd: '/tmp', mcpServers: [] });
    for (let i = 0; i < 2; i++) expect(await e.agent.request(methods.agent.session.prompt, { sessionId: s.sessionId, prompt: [{ type: 'text', text: `p${i}` }] })).toEqual({ stopReason: 'end_turn' });
    await expect(e.agent.request(methods.agent.session.prompt, { sessionId: s.sessionId, prompt: [{ type: 'text', text: 'p2' }] })).rejects.toThrow(/loop guard/);
    expect(admitted(w, s.sessionId).at(-1)!.channelContext.loopGuard).toBe('pair');
  });

  it('the host that declared the external hook decides every prompt (endpoint acp-server), and while it is away nothing goes in #CF-10', async () => {
    const { w } = await world();
    const host = await w.host({ name: 'xwo', callouts: ['external'] });
    const asked: unknown[] = [];
    host.onRequest('policy', async (f) => {
      asked.push(f);
      return { verdict: 'deny', reason: 'not now' };
    });
    const e = await editor(w, 'zed');
    const s = await e.agent.request(methods.agent.session.new, { cwd: '/tmp', mcpServers: [] });
    await expect(e.agent.request(methods.agent.session.prompt, { sessionId: s.sessionId, prompt: [{ type: 'text', text: 'x' }] })).rejects.toThrow(/denied by the host: not now/);
    expect(asked[0]).toMatchObject({ hook: 'external', args: { client: 'zed', principal: 'external:zed', op: 'input', sessionKey: s.sessionId, endpoint: 'acp-server' } });
    host.close();
    await until(() => w.gw.host.hostPeer() === undefined);
    await expect(e.agent.request(methods.agent.session.prompt, { sessionId: s.sessionId, prompt: [{ type: 'text', text: 'y' }] })).rejects.toThrow(/is not connected/);
    expect(admitted(w, s.sessionId)).toHaveLength(0);
  });
});
