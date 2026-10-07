import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { PROTOCOL_VERSION, type ChannelCaps, type InboundEnvelope, type InputRecord, type ReplyRoute, type TurnContext } from '@agents-io/protocol';
import { Hub, MemorySessionLog, Outbox, WatchDispatcher, WatchRegistry, defaultPolicy } from '@agents-io/session';
import { FakeChannel, defaultChannelCaps } from '@agents-io/testkit';
import {
  CHOICE_KEY,
  HostMcpServer,
  HostTools,
  MENTIONS_KEY,
  MemoryBlobStore,
  OUTPUT_EVENT,
  TOOL_NAMES,
  ToolError,
  choiceActionId,
  parseChoiceActionId,
  agentOrigin,
  type OutputRecord,
} from '../src/index.js';

const SK = 's1';
const route = (conversationId = 'c1', channel = 'fake'): ReplyRoute => ({ channel, account: 'default', conversationId, replyToMessageId: 'm0' });

function input(r: ReplyRoute | null, principal = 'fake:alice'): InputRecord {
  return {
    inputId: 'in1',
    origin: { kind: 'human', principal: { id: principal, labels: ['owner'] }, evidence: 'platform_signed', via: 'fake:default:c1', adapter: r?.channel ?? 'fake' },
    content: [{ type: 'text', text: 'hi' }],
    replyRoute: r,
    channelContext: { channel: r?.channel ?? 'fake', conversationKind: 'dm', senderName: 'Alice' },
  };
}

function turnOf(r: ReplyRoute | null, profile = 'bypass'): TurnContext {
  return { sessionKey: SK, turnId: 't1', run: { harness: 'fake', model: 'm', profile }, inputs: [input(r)], replyRoute: r, deliveries: [] };
}

const NO_MEDIA: ChannelCaps = { ...defaultChannelCaps, buttons: false, media: { in: [], out: [] } };

function world(o: { turn?: TurnContext | undefined; routes?: string[]; cwd?: string } = {}) {
  const hub = new Hub(new MemorySessionLog());
  const policy = defaultPolicy({ owners: ['fake:alice'], routes: o.routes ?? [] });
  const outbox = new Outbox({ hub, policy, sleep: async () => {} });
  const fake = new FakeChannel('fake', defaultChannelCaps);
  const mail = new FakeChannel('mail', NO_MEDIA);
  const blobs = new MemoryBlobStore();
  const cwd = o.cwd ?? mkdtempSync(join(tmpdir(), 'aio-mcp-'));
  let turn: TurnContext | undefined = 'turn' in o ? o.turn : turnOf(route());
  const tools = new HostTools({
    hub,
    outbox,
    policy,
    turn: () => turn,
    adapter: (ch) => (ch === 'fake' ? fake : ch === 'mail' ? mail : undefined),
    blobs,
    cwd: () => cwd,
    routes: () => o.routes ?? [],
  });
  const events = () => hub.log.read(SK, 0);
  const outputs = () => events().filter((e) => e.body.t === 'native' && e.body.name === OUTPUT_EVENT).map((e) => e.native as OutputRecord);
  return { hub, outbox, fake, mail, blobs, cwd, tools, events, outputs, setTurn: (t: TurnContext | undefined) => (turn = t) };
}

const B = { sessionKey: SK, generation: 1 };
const call = (w: ReturnType<typeof world>, name: string, args: Record<string, unknown>, id?: string) =>
  w.tools.call(B, name, args, id ? { toolCallId: id } : { requestId: Math.random() }).then((t) => JSON.parse(t));

describe('HostTools', () => {
  it('refuses when no turn is running', async () => {
    const w = world({ turn: undefined });
    await expect(call(w, 'send_message', { route: 'current', text: 'x' })).rejects.toThrow(/no turn is running/);
  });

  it('send_message to the current route delivers through the outbox and records the output', async () => {
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

  it('tags every write with the turn provenance (never blocks it)', async () => {
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

  it('reply_to keeps the reply target; message_id overrides it', async () => {
    const w = world();
    await call(w, 'reply_to', { route: 'current', text: 'a' }, 'c1');
    await call(w, 'reply_to', { route: 'current', text: 'b', message_id: 'm9' }, 'c2');
    expect(w.fake.sent.map((s) => s.route.replyToMessageId)).toEqual(['m0', 'm9']);
  });

  it('is idempotent per tool call id', async () => {
    const w = world();
    await call(w, 'send_message', { route: 'current', text: 'once' }, 'toolu_same');
    await call(w, 'send_message', { route: 'current', text: 'once' }, 'toolu_same');
    expect(w.fake.sent).toHaveLength(1);
    expect(w.outputs()).toHaveLength(1);
    expect(w.events().filter((e) => e.body.t === 'delivery.settled')).toHaveLength(1);
  });

  it('denies destinations outside Policy.outbound with a clear error and a notice', async () => {
    const w = world();
    const err = await call(w, 'send_message', { route: 'fake:default:other', text: 'leak' }).catch((e) => e);
    expect(err).toBeInstanceOf(ToolError);
    expect(err.message).toMatch(/not allowed by the host's outbound policy/);
    expect(err.message).toContain('fake:default:c1');
    expect(w.fake.sent).toHaveLength(0);
    expect(w.events().some((e) => e.body.t === 'notice' && e.body.message.includes('denied'))).toBe(true);
  });

  it('allows preregistered routes', async () => {
    const w = world({ routes: ['fake:default:ops'] });
    await call(w, 'send_message', { route: 'fake:default:ops', text: 'fyi' });
    expect(w.fake.sent[0]!.route.conversationId).toBe('ops');
  });

  it('send_file uploads to the blob store and sends an attachment', async () => {
    const w = world();
    writeFileSync(join(w.cwd, 'README.md'), '# hi\n');
    const r = await call(w, 'send_file', { path: 'README.md', caption: 'here' });
    expect(r).toMatchObject({ ok: true, name: 'README.md', mime: 'text/markdown', bytes: 5 });
    const att = w.fake.sent[0]!.msg.attachments![0]!;
    expect(w.fake.sent[0]!.msg.text).toBe('here');
    expect(att.name).toBe('README.md');
    expect(new TextDecoder().decode((await w.blobs.get(att.ref)).bytes)).toBe('# hi\n');
  });

  it('send_file refuses missing files, both/neither args, outside cwd in a restricted turn, and channels without media', async () => {
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

  it('send_file in a restricted turn: symlinks and .. cannot escape the working directory', async () => {
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

  it('send_file on the local route is event-only (no adapter), still settled', async () => {
    const local: ReplyRoute = { channel: 'local', account: 'local', conversationId: SK };
    const w = world({ turn: turnOf(local) });
    writeFileSync(join(w.cwd, 'f.txt'), 'abc');
    const r = await call(w, 'send_file', { path: 'f.txt' });
    expect(r.ok).toBe(true);
    expect(w.outputs()[0]!.msg.attachments![0]!.name).toBe('f.txt');
    expect(w.events().find((e) => e.body.t === 'delivery.settled')!.body).toMatchObject({ result: 'delivered', route: local });
  });

  it('ask_choice renders buttons where the channel has them, a numbered list elsewhere', async () => {
    const w = world();
    const r = await call(w, 'ask_choice', { question: 'Red or blue?', options: ['red', 'blue'] }, 'q1');
    expect(r.choiceId).toMatch(/^ch_/);
    expect(r.note).toMatch(/next input/);
    const msg = w.fake.sent[0]!.msg;
    expect(msg.actions!.map((a) => a.id)).toEqual([choiceActionId(r.choiceId, 1), choiceActionId(r.choiceId, 2)]);
    expect((msg.channelData as Record<string, unknown>)[CHOICE_KEY]).toMatchObject({ choiceId: r.choiceId, options: ['red', 'blue'], multi: false });

    w.setTurn(turnOf(route('c1', 'mail')));
    await call(w, 'ask_choice', { question: 'Pick', options: ['a', 'b', 'c'], multi: true }, 'q2');
    const text = w.mail.sent[0]!.msg.text;
    expect(text).toContain('1. a\n2. b\n3. c');
    expect(text).toMatch(/numbers of your choices/);
    expect(w.mail.sent[0]!.msg.actions).toBeUndefined();
  });

  it('a button click and a numbered reply come back as a choice event for the asking session', async () => {
    const w = world();
    const r = await call(w, 'ask_choice', { question: 'Red or blue?', options: ['red', 'blue'] }, 'q1');
    const env = (content: InboundEnvelope['content'], r2 = route()): InboundEnvelope => ({
      v: PROTOCOL_VERSION,
      id: 'e1',
      channel: 'fake',
      account: 'default',
      conversation: { id: 'c1', kind: 'other' },
      sender: { channelUserId: 'alice', evidence: 'platform_signed' },
      content,
      replyRoute: r2,
    });
    const origin = input(route()).origin;
    const click = w.tools.rewriteInbound({ env: env([{ type: 'event', name: 'action', data: { actionId: choiceActionId(r.choiceId, 2) } }]), origin, sessionKey: 'elsewhere' });
    expect(click!.sessionKey).toBe(SK);
    expect(click!.content![0]).toMatchObject({ type: 'event', name: 'choice', data: { choiceId: r.choiceId, selected: [{ n: 2, label: 'blue' }], via: 'button' } });
    // answered: a later number is just text again
    expect(w.tools.rewriteInbound({ env: env([{ type: 'text', text: '1' }]), origin, sessionKey: SK })).toBeUndefined();

    const r2 = await call(w, 'ask_choice', { question: 'Again?', options: ['yes', 'no'] }, 'q2');
    const reply = w.tools.rewriteInbound({ env: env([{ type: 'text', text: 'Subject: Re: x\n 1 ' }]), origin, sessionKey: SK });
    expect(reply!.content![0]).toMatchObject({ data: { choiceId: r2.choiceId, selected: [{ n: 1, label: 'yes' }], via: 'reply' } });
    // unrelated text or other routes are left alone
    expect(w.tools.rewriteInbound({ env: env([{ type: 'text', text: 'red please' }]), origin, sessionKey: SK })).toBeUndefined();
  });

  it('local /choose input is normalized; bad answers are refused', async () => {
    const w = world();
    const r = await call(w, 'ask_choice', { question: 'Q', options: ['x', 'y'] }, 'q1');
    const out = w.tools.normalizeLocal([{ type: 'event', name: 'choice', data: { choiceId: r.choiceId, selected: [2] } }]);
    expect(out[0]).toMatchObject({ data: { selected: [{ n: 2, label: 'y' }], via: 'command' } });
    expect(() => w.tools.normalizeLocal([{ type: 'event', name: 'choice', data: { choiceId: r.choiceId, selected: [3] } }])).toThrow(/between 1 and 2/);
    expect(() => w.tools.normalizeLocal([{ type: 'event', name: 'choice', data: { choiceId: 'ch_nope', selected: [1] } }])).toThrow(/unknown choice/);
  });

  it('choices survive a restart through the session log', async () => {
    const w = world();
    const r = await call(w, 'ask_choice', { question: 'Q', options: ['x', 'y'] }, 'q1');
    const fresh = new HostTools({ hub: w.hub, outbox: w.outbox, policy: defaultPolicy({ owners: [] }), turn: () => undefined, adapter: () => undefined, blobs: w.blobs, cwd: () => w.cwd });
    expect(fresh.choiceAnswer(r.choiceId, [1], 'button').sessionKey).toBe(SK);
  });

  it('mention carries targets in channelData and names in the text fallback', async () => {
    const w = world();
    await call(w, 'mention', { user_ids: ['fake:alice', 'bob'], text: 'please look' });
    const msg = w.fake.sent[0]!.msg;
    expect(msg.text).toBe('@Alice @bob please look');
    expect((msg.channelData as Record<string, unknown>)[MENTIONS_KEY]).toEqual({ targets: [{ id: 'alice', name: 'Alice' }, { id: 'bob' }], text: 'please look' });
  });

  it('get_channel_context summarises the route, caps, tier and participants', async () => {
    const w = world({ routes: ['fake:default:ops'] });
    const c = await call(w, 'get_channel_context', {});
    expect(c).toMatchObject({
      route: 'fake:default:c1',
      channel: 'fake',
      conversationKind: 'dm',
      tier: 'card',
      caps: { buttons: true, mediaOut: ['image', 'file'], markdown: 'basic' },
      participants: [{ principal: 'fake:alice', userId: 'alice', name: 'Alice' }],
      allowedDestinations: { current: 'fake:default:c1', preregistered: ['fake:default:ops'] },
    });
  });

  it('parses choice action ids', () => {
    expect(parseChoiceActionId(choiceActionId('ch_1', 3))).toEqual({ choiceId: 'ch_1', n: 3 });
    expect(parseChoiceActionId(choiceActionId('ch_1', 'form'))).toEqual({ choiceId: 'ch_1', n: 'form' });
    expect(parseChoiceActionId('req:x:allow_once')).toBeUndefined();
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

  it('listens on loopback only', async () => {
    const w = world();
    const s = new HostMcpServer({ tools: w.tools });
    servers.push(s);
    expect(new URL(await s.listen()).hostname).toBe('127.0.0.1');
    for (const host of ['0.0.0.0', '::', '192.168.1.10', 'example.com']) {
      await expect(new HostMcpServer({ tools: w.tools, host }).listen()).rejects.toThrow(/loopback/);
    }
  });

  it('rejects requests without a valid token', async () => {
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

  it('lists the tools and maps the harness tool-call id from _meta to the operationId', async () => {
    const w = world();
    const calls: { tool: string; meta: unknown }[] = [];
    const s = new HostMcpServer({ tools: w.tools, onCall: (e) => calls.push({ tool: e.tool, meta: e.meta }) });
    servers.push(s);
    await s.listen();
    const client = await connect(s.url, s.mcpFor({ sessionKey: SK, generation: 1, harnessId: 'fake' }).token);
    const listed = await client.listTools();
    expect(listed.tools.map((t) => t.name).sort()).toEqual(TOOL_NAMES.filter((n) => !n.startsWith('watch_')).sort());
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
  function watchWorld() {
    const hub = new Hub(new MemorySessionLog());
    const policy = defaultPolicy({ owners: ['fake:alice'], watchAllowlist: [{ channel: 'lark-bot', conversation: 'oc_team' }] });
    const d = new WatchDispatcher({ registry: new WatchRegistry(), policy, lanes: () => { throw new Error('no lanes'); } });
    const tools = new HostTools({
      hub,
      outbox: new Outbox({ hub }),
      policy,
      turn: () => undefined,
      adapter: () => undefined,
      blobs: new MemoryBlobStore(),
      cwd: () => '/',
      watches: { add: (by, w) => d.add(by, w), remove: (by, id) => d.remove(by, id), list: (sk) => d.list({ target: sk }) },
    });
    const run = (sk: string, name: string, args: Record<string, unknown>) => tools.call({ sessionKey: sk, generation: 1 }, name, args).then((t) => JSON.parse(t));
    return { d, tools, run };
  }

  it('adds a watch pinned to the caller session, created by its agent identity', async () => {
    const w = watchWorld();
    const r = await w.run(SK, 'watch_add', { source: { channel: 'lark-bot', conversation: 'oc_team' }, mode: 'digest', digest_every_minutes: 30, keywords: ['deploy'], note: 'follow deploys' });
    expect(r.watch).toMatchObject({ target: { sessionKey: SK }, mode: 'digest', digest: { everyMs: 1_800_000 }, filter: { keywords: ['deploy'] }, createdBy: `session:${SK}`, mine: true });
    const list = await w.run(SK, 'watch_list', {});
    expect(list.watches.map((x: { id: string }) => x.id)).toEqual([r.watch.id]);
    expect(await w.run('other', 'watch_list', {})).toMatchObject({ watches: [] });
  });

  it('forbids a target argument', async () => {
    const w = watchWorld();
    await expect(w.run(SK, 'watch_add', { source: { channel: 'lark-bot', conversation: 'oc_team' }, mode: 'context', target: { sessionKey: 'main' } })).rejects.toThrow(/always delivers to your own session/);
  });

  it('denies sources off the owner allowlist with a clear error', async () => {
    const w = watchWorld();
    await expect(w.run(SK, 'watch_add', { source: { channel: 'lark-bot', conversation: 'oc_secret' }, mode: 'trigger' })).rejects.toThrow(/not on the owner's watch allowlist/);
    expect(w.d.list()).toHaveLength(0);
  });

  it('validates mode and digest period', async () => {
    const w = watchWorld();
    await expect(w.run(SK, 'watch_add', { source: { channel: 'lark-bot', conversation: 'oc_team' }, mode: 'digest' })).rejects.toThrow(/digest_every_minutes/);
    await expect(w.run(SK, 'watch_add', { source: { channel: 'lark-bot' }, mode: 'loud' })).rejects.toThrow(/mode must be/);
  });

  it('removes only watches the agent created', async () => {
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

  it('are listed over MCP only when the host provides watches', async () => {
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
