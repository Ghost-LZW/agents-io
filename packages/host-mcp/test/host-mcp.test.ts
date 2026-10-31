import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { ContentBlock, ReplyRoute } from '@agents-io/protocol';
import { Hub, MemorySessionLog, Outbox, defaultPolicy } from '@agents-io/session';
import { FakeChannel, defaultChannelCaps } from '@agents-io/testkit';
import { HostMcpServer, HostTools, MemoryBlobStore, OUTPUT_EVENT, TOOL_NAMES, ToolError, agentOrigin, type OutputRecord } from '../src/index.js';
import { B, SK, admit, call, input, route, turnOf, watchWorld, world } from './host-mcp-helpers.js';

describe('HostTools', () => {
  it('refuses when no turn is running #EX-3', async () => {
    const w = world({ turn: undefined });
    await expect(call(w, 'send_message', { route: 'current', text: 'x' })).rejects.toThrow(/no turn is running/);
  });

  it('send_message to the current route delivers through the outbox and records the output #DL-1 #DL-2', async () => {
    const w = world();
    const r = await call(w, 'send_message', { route: 'current', text: 'hello' }, 'toolu_1');
    expect(r.ok).toBe(true);
    expect(w.fake.sent).toHaveLength(1);
    expect(w.fake.sent[0]!.msg.text).toBe('hello');
    // send_message is a new message, not a reply
    expect(w.fake.sent[0]!.route.replyToMessageId).toBeUndefined();
    expect(w.outputs()[0]!.tool).toBe('send_message');
    const settled = w.events().filter((e) => e.body.t === 'delivery.settled');
    expect(settled).toHaveLength(1);
    expect(settled[0]!.body).toMatchObject({ result: 'delivered', operationId: 'tool:s1:toolu_1' });
  });

  it('tags every write with the turn provenance (never blocks it) #EX-3', async () => {
    const hub = new Hub(new MemorySessionLog());
    const policy = defaultPolicy({ owners: ['fake:alice'] });
    const fake = new FakeChannel('fake', defaultChannelCaps);
    const prov = { sessionKey: SK, turnId: 't1', triggeredBy: ['fake:alice'], watched: true, external: true, group: true };
    const asked: string[] = [];
    const tools = new HostTools({
      hub,
      outbox: new Outbox({ hub, policy, sleep: async () => {} }),
      policy,
      turn: () => turnOf(route()),
      adapter: () => fake,
      blobs: new MemoryBlobStore(),
      cwd: () => tmpdir(),
      provenance: (key, turnId) => (asked.push(`${key}/${turnId}`), prov),
    });
    expect(tools.provenanceOf(B)).toEqual(prov);
    await tools.call(B, 'send_message', { route: 'current', text: 'after reading a watched group' }, { toolCallId: 'p1' });
    expect(fake.sent).toHaveLength(1);
    const rec = hub.log.read(SK, 0).find((e) => e.body.t === 'native' && e.body.name === OUTPUT_EVENT)!.native as OutputRecord;
    expect(rec.provenance).toEqual(prov);
    expect(asked).toContain('s1/t1');
  });

  it('is idempotent per tool call id #DL-2', async () => {
    const w = world();
    await call(w, 'send_message', { route: 'current', text: 'once' }, 'toolu_same');
    await call(w, 'send_message', { route: 'current', text: 'once' }, 'toolu_same');
    expect(w.fake.sent).toHaveLength(1);
    expect(w.outputs()).toHaveLength(1);
    expect(w.events().filter((e) => e.body.t === 'delivery.settled')).toHaveLength(1);
  });

  it('denies destinations outside Policy.outbound with a clear error and a notice #DL-5', async () => {
    // Someone else's turn: a turn whose every input is from an owner may send anywhere under the default policy.
    const w = world({ turn: turnOf(route(), 'restricted') });
    const err = await call(w, 'send_message', { route: 'fake:default:other', text: 'leak' }).catch((e) => e);
    expect(err).toBeInstanceOf(ToolError);
    expect(err.message).toMatch(/not allowed by the host's outbound policy/);
    expect(err.message).toContain('fake:default:c1');
    expect(w.fake.sent).toHaveLength(0);
    expect(w.events().some((e) => e.body.t === 'notice' && e.body.message.includes('denied'))).toBe(true);
  });

  it('allows preregistered routes #DL-5', async () => {
    const w = world({ routes: ['fake:default:ops'] });
    await call(w, 'send_message', { route: 'fake:default:ops', text: 'fyi' });
    expect(w.fake.sent[0]!.route.conversationId).toBe('ops');
  });

  it('send_file refuses missing files, both/neither args, outside cwd in a restricted turn, and channels without media #SE-4', async () => {
    const w = world({ turn: turnOf(route(), 'restricted') });
    await expect(call(w, 'send_file', { path: 'nope.txt' })).rejects.toThrow(/file not found/);
    await expect(call(w, 'send_file', {})).rejects.toThrow(/exactly one/);
    const other = mkdtempSync(join(tmpdir(), 'aio-out-'));
    writeFileSync(join(other, 'secret.txt'), 'x');
    await expect(call(w, 'send_file', { path: join(other, 'secret.txt') })).rejects.toThrow(/outside the working directory/);
    w.setTurn(turnOf(route('c1', 'mail')));
    writeFileSync(join(w.cwd, 'a.txt'), 'x');
    await expect(call(w, 'send_file', { path: 'a.txt' })).rejects.toThrow(/cannot send files/);
  });

  it('send_file in a restricted turn: symlinks and .. cannot escape the working directory #SE-4', async () => {
    const w = world({ turn: turnOf(route(), 'restricted') });
    const other = mkdtempSync(join(tmpdir(), 'aio-out-'));
    writeFileSync(join(other, 'secret.txt'), 'x');
    symlinkSync(join(other, 'secret.txt'), join(w.cwd, 'link.txt'));
    symlinkSync(other, join(w.cwd, 'dirlink'));
    mkdirSync(join(w.cwd, 'sub'));
    await expect(call(w, 'send_file', { path: 'link.txt' })).rejects.toThrow(/outside the working directory/);
    await expect(call(w, 'send_file', { path: 'dirlink/secret.txt' })).rejects.toThrow(/outside the working directory/);
    await expect(call(w, 'send_file', { path: join(w.cwd, 'dirlink', 'secret.txt') })).rejects.toThrow(/outside the working directory/);
    await expect(call(w, 'send_file', { path: `sub/../../${join(other, 'secret.txt').split('/').slice(-2).join('/')}` })).rejects.toThrow(/outside the working directory/);
    await expect(call(w, 'send_file', { path: `../${other.split('/').pop()}/secret.txt` })).rejects.toThrow(/outside the working directory/);
    expect(w.fake.sent).toEqual([]);
    // Inside is fine, also through a symlink that stays inside and for names starting with "..".
    writeFileSync(join(w.cwd, 'sub', 'ok.txt'), 'ok');
    symlinkSync(join(w.cwd, 'sub', 'ok.txt'), join(w.cwd, 'inner.txt'));
    writeFileSync(join(w.cwd, '..notes'), 'n');
    expect((await call(w, 'send_file', { path: 'inner.txt' })).ok).toBe(true);
    expect((await call(w, 'send_file', { path: 'sub/../..notes' })).ok).toBe(true);
    expect((await call(w, 'send_file', { path: join(w.cwd, 'sub', 'ok.txt') })).ok).toBe(true);
  });

  it('send_file blob: a ref this session saw (an input, a file it sent) goes out; another session\'s reads as unknown, like a missing one #SE-7', async () => {
    const w = world();
    const put = (text: string) => w.blobs.put(new TextEncoder().encode(text), { mime: 'text/csv', name: `${text}.csv` });
    const mine = await put('mine');
    const theirs = await put('theirs');
    admit(w, SK, [{ type: 'file', ref: mine, mime: 'text/csv', name: 'mine.csv' }]);
    admit(w, 's2', [{ type: 'file', ref: theirs, mime: 'text/csv', name: 'theirs.csv' }]);
    // Both are in the shared store; each session sends only its own, and is told no more than for a missing ref.
    await expect(call(w, 'send_file', { blob: theirs })).rejects.toThrow(`unknown blob ${theirs}`);
    await expect(call(w, 'send_file', { blob: `sha256:${'0'.repeat(64)}` })).rejects.toThrow(/unknown blob/);
    await expect(w.tools.call({ sessionKey: 's2', generation: 1 }, 'send_file', { blob: mine })).rejects.toThrow(`unknown blob ${mine}`);
    expect(w.fake.sent).toEqual([]);
    expect(w.outputs()).toEqual([]);
    expect(await call(w, 'send_file', { blob: mine })).toMatchObject({ ok: true, ref: mine, name: 'mine.csv' });
    expect(JSON.parse(await w.tools.call({ sessionKey: 's2', generation: 1 }, 'send_file', { blob: theirs }))).toMatchObject({ ok: true, ref: theirs });
    // This turn's own inputs count, and so does a file the session sent by path.
    const now = await put('now');
    w.setTurn({ ...turnOf(route()), inputs: [{ ...input(route()), content: [{ type: 'file', ref: now, mime: 'text/csv' }] }] });
    expect((await call(w, 'send_file', { blob: now })).ok).toBe(true);
    writeFileSync(join(w.cwd, 'out.txt'), 'out');
    const out = await call(w, 'send_file', { path: 'out.txt' });
    expect((await call(w, 'send_file', { blob: out.ref })).ok).toBe(true);
    expect(w.fake.sent.map((s) => s.msg.attachments![0]!.ref)).toEqual([mine, theirs, now, out.ref, out.ref]);
  });

  it('send_file blob: the name shown is the one this session saw, not the store\'s (the same bytes came first under another session\'s name) #SE-7', async () => {
    const w = world();
    // The store keeps the name the bytes first came with: here the private chat's.
    const ref = await w.blobs.put(new TextEncoder().encode('same bytes'), { mime: 'text/csv', name: 'private-statement.csv' });
    admit(w, 'dm', [{ type: 'file', ref, mime: 'text/csv', name: 'private-statement.csv' }]);
    admit(w, SK, [{ type: 'file', ref, mime: 'text/csv', name: 'group.csv' }]);
    admit(w, 's3', [{ type: 'file', ref, mime: 'text/csv' }]);
    const send = (sk: string, args: Record<string, unknown> = {}) => w.tools.call({ sessionKey: sk, generation: 1 }, 'send_file', { blob: ref, ...args }).then((t) => JSON.parse(t));
    expect(await send(SK)).toMatchObject({ ok: true, name: 'group.csv' });
    expect(await send('dm')).toMatchObject({ ok: true, name: 'private-statement.csv' });
    // Seen without a name: a neutral one, never the store's.
    expect(await send('s3')).toMatchObject({ ok: true, name: 'file' });
    expect(await send(SK, { name: 'mine.csv' })).toMatchObject({ ok: true, name: 'mine.csv' });
    expect(w.fake.sent.map((s) => s.msg.attachments![0]!.name)).toEqual(['group.csv', 'private-statement.csv', 'file', 'mine.csv']);
  });

  it('send_file blob: pages past the first count, the newest name wins, trimmed history does not #SE-7', async () => {
    const w = world({ retain: 700 });
    const put = (text: string) => w.blobs.put(new TextEncoder().encode(text), { mime: 'text/csv', name: `${text}.csv` });
    const send = (sk: string, blob: string) => w.tools.call({ sessionKey: sk, generation: 1 }, 'send_file', { blob }).then((t) => JSON.parse(t));
    const deep = await put('deep');
    const old = await put('old');
    admit(w, SK, [{ type: 'file', ref: deep, mime: 'text/csv', name: 'deep.csv' }]);
    admit(w, SK, [{ type: 'file', ref: old, mime: 'text/csv', name: 'old.csv' }]);
    for (let i = 0; i < 600; i++) admit(w, SK, [{ type: 'text', text: `filler ${i}` }]);
    admit(w, SK, [{ type: 'file', ref: old, mime: 'text/csv', name: 'renamed.csv' }]);
    // 603 events, more than two pages back: both are still in the log.
    expect(await send(SK, deep)).toMatchObject({ ok: true, name: 'deep.csv' });
    expect(await send(SK, old)).toMatchObject({ ok: true, name: 'renamed.csv' });
    // A file the log no longer keeps (its input and the send of it both trimmed) no longer counts.
    const gone = await put('gone');
    admit(w, 's2', [{ type: 'file', ref: gone, mime: 'text/csv', name: 'gone.csv' }]);
    expect((await send('s2', gone)).ok).toBe(true);
    for (let i = 0; i < 700; i++) admit(w, 's2', [{ type: 'text', text: `filler ${i}` }]);
    expect(w.hub.log.floor('s2')).toBeGreaterThan(0);
    await expect(send('s2', gone)).rejects.toThrow(`unknown blob ${gone}`);
  });

  it('send_file blob: a session\'s log is read once, then only what it gained; a ref it never saw does not read it all again #SE-7', async () => {
    const w = world();
    const put = (text: string) => w.blobs.put(new TextEncoder().encode(text), { mime: 'text/csv', name: `${text}.csv` });
    const send = (blob: string) => call(w, 'send_file', { blob });
    const old = await put('old');
    const missing = `sha256:${'0'.repeat(64)}`;
    admit(w, SK, [{ type: 'file', ref: old, mime: 'text/csv', name: 'old.csv' }]);
    for (let i = 0; i < 600; i++) admit(w, SK, [{ type: 'text', text: `filler ${i}` }]);
    const read = vi.spyOn(w.hub.log, 'read');
    const events = () => read.mock.results.reduce((n, r) => n + (r.value as unknown[]).length, 0);
    await expect(send(missing)).rejects.toThrow(`unknown blob ${missing}`);
    expect(events()).toBe(601);
    read.mockClear();
    await expect(send(missing)).rejects.toThrow(`unknown blob ${missing}`);
    expect(read).not.toHaveBeenCalled();
    // What the log gains later counts, and is all that is read: a newer name, a ref first seen now.
    const later = await put('later');
    admit(w, SK, [{ type: 'file', ref: old, mime: 'text/csv', name: 'renamed.csv' }]);
    admit(w, SK, [{ type: 'file', ref: later, mime: 'text/csv', name: 'later.csv' }]);
    expect(await send(old)).toMatchObject({ ok: true, name: 'renamed.csv' });
    expect(await send(later)).toMatchObject({ ok: true, name: 'later.csv' });
    await expect(send(missing)).rejects.toThrow(`unknown blob ${missing}`);
    // The two inputs, then each send's own output record and settlement as the log gained them.
    expect(events()).toBe(w.hub.log.head(SK) - 601);
  });

  it('send_file blob: only image, file and audio blocks and the outputs host-mcp recorded count; a stray ref on another block or a harness event under the output\'s name does not #SE-7', async () => {
    const w = world();
    const ref = await w.blobs.put(new TextEncoder().encode('bill'), { mime: 'text/csv', name: 'bill.csv' });
    // A harness's own native event under the output's name, as the lane writes it (operators, or internal).
    for (const visibility of ['operators', 'internal'] as const) {
      const native: OutputRecord = { tool: 'send_file', operationId: `forged-${visibility}`, route: route(), msg: { text: '', attachments: [{ ref, mime: 'text/csv', name: 'bill.csv' }] } };
      w.hub.append(SK, { ts: Date.now(), level: 'primary', audience: 'answer', durability: 'durable', visibility, body: { t: 'native', name: OUTPUT_EVENT }, native });
    }
    await expect(call(w, 'send_file', { blob: ref })).rejects.toThrow(`unknown blob ${ref}`);
    // The schema does not stop an event block or a pointer from carrying an extra top-level `ref`.
    admit(w, SK, [{ type: 'event', name: 'card', data: {}, ref } as unknown as ContentBlock, { type: 'ref', uri: 'https://example.test/x', ref } as unknown as ContentBlock]);
    await expect(call(w, 'send_file', { blob: ref })).rejects.toThrow(`unknown blob ${ref}`);
    expect(w.fake.sent).toEqual([]);
    admit(w, SK, [{ type: 'image', ref, mime: 'image/png', name: 'bill.png' }]);
    expect(await call(w, 'send_file', { blob: ref })).toMatchObject({ ok: true, name: 'bill.png' });
    admit(w, SK, [{ type: 'audio', ref, mime: 'audio/ogg', name: 'bill.ogg' }]);
    expect(await call(w, 'send_file', { blob: ref })).toMatchObject({ ok: true, name: 'bill.ogg' });
  });

  it('send_file path is not scoped to refs: the bytes of another session\'s blob go out from the cwd #SE-7 #SE-4', async () => {
    const w = world({ turn: turnOf(route(), 'restricted') });
    const theirs = await w.blobs.put(new TextEncoder().encode('theirs'), { mime: 'text/csv', name: 'theirs.csv' });
    await expect(call(w, 'send_file', { blob: theirs })).rejects.toThrow(/unknown blob/);
    writeFileSync(join(w.cwd, 'copy.csv'), 'theirs');
    expect(await call(w, 'send_file', { path: 'copy.csv' })).toMatchObject({ ok: true, ref: theirs, name: 'copy.csv' });
  });

  it('send_file on the local route is event-only (no adapter), still settled #DL-1', async () => {
    const local: ReplyRoute = { channel: 'local', account: 'local', conversationId: SK };
    const w = world({ turn: turnOf(local) });
    writeFileSync(join(w.cwd, 'f.txt'), 'abc');
    const r = await call(w, 'send_file', { path: 'f.txt' });
    expect(r.ok).toBe(true);
    expect(w.outputs()[0]!.msg.attachments![0]!.name).toBe('f.txt');
    expect(w.events().find((e) => e.body.t === 'delivery.settled')!.body).toMatchObject({ result: 'delivered', route: local });
  });

  it('choices survive a restart through the session log #RS-1', async () => {
    const w = world();
    const r = await call(w, 'ask_choice', { question: 'Q', options: ['x', 'y'] }, 'q1');
    const fresh = new HostTools({ hub: w.hub, outbox: w.outbox, policy: defaultPolicy({ owners: [] }), turn: () => undefined, adapter: () => undefined, blobs: w.blobs, cwd: () => w.cwd });
    expect(fresh.choiceAnswer(r.choiceId, [1], 'button').sessionKey).toBe(SK);
  });
});

describe('HostMcpServer (streamable HTTP)', () => {
  const servers: HostMcpServer[] = [];
  afterEach(async () => {
    for (const s of servers.splice(0)) await s.close();
  });

  async function connect(url: string, token?: string) {
    const client = new Client({ name: 't', version: '0' });
    const transport = new StreamableHTTPClientTransport(new URL(url), token ? { requestInit: { headers: { Authorization: `Bearer ${token}` } } } : {});
    await client.connect(transport);
    return client;
  }

  it('listens on loopback only #SE-3', async () => {
    const w = world();
    const s = new HostMcpServer({ tools: w.tools });
    servers.push(s);
    expect(new URL(await s.listen()).hostname).toBe('127.0.0.1');
    for (const host of ['0.0.0.0', '::', '192.168.1.10', 'example.com']) {
      await expect(new HostMcpServer({ tools: w.tools, host }).listen()).rejects.toThrow(/loopback/);
    }
  });

  it('rejects requests without a valid token #SE-3', async () => {
    const w = world();
    const s = new HostMcpServer({ tools: w.tools });
    servers.push(s);
    const url = await s.listen();
    expect((await fetch(url, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } })).status).toBe(401);
    expect((await fetch(url, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json', authorization: 'Bearer nope' } })).status).toBe(401);
    await expect(connect(url, 'wrong')).rejects.toThrow();
    const t = s.mint(B);
    s.revoke(t);
    await expect(connect(url, t)).rejects.toThrow();
  });

  it('lists the tools and maps the harness tool-call id from _meta to the operationId #DL-2 #DL-5', async () => {
    const w = world({ turn: turnOf(route(), 'restricted') });
    const calls: { tool: string; meta: unknown }[] = [];
    const s = new HostMcpServer({ tools: w.tools, onCall: (e) => calls.push({ tool: e.tool, meta: e.meta }) });
    servers.push(s);
    await s.listen();
    const client = await connect(s.url, s.mcpFor({ sessionKey: SK, generation: 1, harnessId: 'fake' }).token);
    const listed = await client.listTools();
    expect(listed.tools.map((t) => t.name).sort()).toEqual(TOOL_NAMES.filter((n) => !n.startsWith('watch_') && !n.startsWith('schedule_') && !n.startsWith('session_') && !n.startsWith('live_')).sort());
    for (const t of listed.tools) expect(t.description!.length).toBeGreaterThan(80);
    const args = { name: 'send_message', arguments: { route: 'current', text: 'via mcp' }, _meta: { 'claudecode/toolUseId': 'toolu_abc' } };
    const r1 = await client.callTool(args);
    const r2 = await client.callTool(args);
    expect(r1.isError).toBeFalsy();
    expect(JSON.parse((r2.content as { text: string }[])[0]!.text).operationId).toBe('tool:s1:toolu_abc');
    expect(w.fake.sent).toHaveLength(1);
    const denied = await client.callTool({ name: 'send_message', arguments: { route: 'fake:default:x', text: 'no' } });
    expect(denied.isError).toBe(true);
    expect((denied.content as { text: string }[])[0]!.text).toMatch(/outbound policy/);
    expect(calls[0]!.meta).toMatchObject({ 'claudecode/toolUseId': 'toolu_abc' });
    await client.close();
  });
});

describe('watch tools', () => {
  it('adds a watch pinned to the caller session, created by its agent identity #CF-7 #DL-4b', async () => {
    const w = watchWorld();
    const r = await w.run(SK, 'watch_add', { source: { channel: 'lark-bot', conversation: 'oc_team' }, mode: 'digest', digest_every_minutes: 30, keywords: ['deploy'], note: 'follow deploys' });
    expect(r.watch).toMatchObject({ target: { sessionKey: SK }, mode: 'digest', digest: { everyMs: 1_800_000 }, filter: { keywords: ['deploy'] }, createdBy: `session:${SK}`, mine: true });
    const list = await w.run(SK, 'watch_list', {});
    expect(list.watches.map((x: { id: string }) => x.id)).toEqual([r.watch.id]);
    expect(await w.run('other', 'watch_list', {})).toMatchObject({ watches: [] });
  });

  it('forbids a target argument #CF-7', async () => {
    const w = watchWorld();
    await expect(w.run(SK, 'watch_add', { source: { channel: 'lark-bot', conversation: 'oc_team' }, mode: 'context', target: { sessionKey: 'main' } })).rejects.toThrow(/always delivers to your own session/);
  });

  it('removes only watches the agent created #CF-7', async () => {
    const w = watchWorld();
    const owner = { kind: 'human' as const, principal: { id: 'fake:alice', labels: ['owner'] }, evidence: 'platform_signed' as const, via: 'fake:default:c1', adapter: 'fake' };
    const theirs = await w.d.add(owner, { id: 'w_owner', source: { channel: 'lark-bot', conversation: 'oc_any' }, target: { sessionKey: SK }, mode: 'context' });
    expect(theirs.ok).toBe(true);
    await expect(w.run(SK, 'watch_remove', { id: 'w_owner' })).rejects.toThrow(/only remove watches you created/);
    // Another session's agent cannot remove this session's watch either.
    const mine = await w.run(SK, 'watch_add', { id: 'w_mine', source: { channel: 'lark-bot', conversation: 'oc_team' }, mode: 'context' });
    expect((await w.d.remove(agentOrigin('other'), 'w_mine')).ok).toBe(false);
    expect(await w.run(SK, 'watch_remove', { id: mine.watch.id })).toMatchObject({ ok: true, removed: true });
    expect(w.d.list().map((x) => x.id)).toEqual(['w_owner']);
  });

  it('are listed over MCP only when the host provides watches #CF-6', async () => {
    const w = watchWorld();
    const s = new HostMcpServer({ tools: w.tools });
    await s.listen();
    const client = new Client({ name: 't', version: '0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(s.url), { requestInit: { headers: { Authorization: `Bearer ${s.mint(B)}` } } }));
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['watch_add', 'watch_remove', 'watch_list']));
    const add = (await client.listTools()).tools.find((t) => t.name === 'watch_add')!;
    expect(add.description).toMatch(/untrusted/);
    expect(add.description).toMatch(/context.*digest.*trigger/s);
    await client.close();
    await s.close();
  });
});
