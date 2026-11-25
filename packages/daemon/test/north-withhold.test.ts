import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough, Readable, Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { client as acpClient, methods, ndJsonStream, type SessionNotification } from '@agentclientprotocol/sdk';
import type { KernelContext, SessionEvent } from '@agents-io/protocol';
import type { FakeTurnScript } from '@agents-io/testkit';
import type { LocalClient } from '@agents-io/kernel';
import { Hub, MemorySessionLog, type EventDraft } from '@agents-io/session';
import { acpPipe } from '../src/acp-server.js';
import { ExternalView } from '../src/external-view.js';
import { cleanups, daemon, tmp, until, type World } from './helpers.js';

/*
 * U20 for the north projections (core-slimming G9): an ACP client and an AG-UI stream are readers
 * outside the daemon, so a checked turn's answer reaches them only once it is past the host's exit
 * check, and a held one never (as the external MCP endpoint's session_events, DL-7).
 */

const SECRET = 'secret plan for the group';
const script: FakeTurnScript = async (t) => {
  const text = t.inputs.flatMap((i) => i.content).map((c) => (c.type === 'text' ? c.text : '')).join(' ');
  if (text === 'warm up') return void t.emit({ t: 'text.snapshot', text: 'warm', final: true }, { audience: 'answer' });
  t.emit({ t: 'text.delta', stream: 'answer', delta: 'secret plan ' }, { audience: 'answer' });
  t.emit({ t: 'text.snapshot', text: SECRET, final: true }, { audience: 'answer' });
};
const KEY = 'fake:default:g1';
const group = { id: 'g1', kind: 'group' as const };
const say = (w: World, id: string, text: string) => w.chat.inject({ id, sender: { channelUserId: 'alice', evidence: 'platform_signed' }, conversation: group, text, admission: 'dispatch' });
const TOKEN = 'reader-token-0123456789abcdef';

describe('north projections and the exit check (U20)', () => {
  it('a checked turn reaches an ACP client and an AG-UI stream only once its answer is past the check; a held one never #DL-7', async () => {
    const dir = tmp();
    const tokDir = join(dir, 'tok');
    mkdirSync(tokDir, { recursive: true, mode: 0o700 });
    const tokenFile = join(tokDir, 'reader.token');
    writeFileSync(tokenFile, TOKEN + '\n', { mode: 0o600 });
    const otherFile = join(tokDir, 'web.token');
    writeFileSync(otherFile, 'web-' + TOKEN + '\n', { mode: 0o600 });
    const w = await daemon({
      dir,
      script,
      raw: { acpServer: { clients: { reader: { tokenFile, scopes: [`read:${KEY}`] } } }, agUi: { listen: '127.0.0.1:0', clients: { web: { tokenFile: otherFile, scopes: [`read:${KEY}`] } } } },
    });
    // The host routes the group's messages; its scope is empty for now (nothing checked yet).
    const h: LocalClient = await w.client();
    await h.hello({ token: w.gw.token, name: 'lb', callouts: ['route', 'outbound.scoped'], outboundScope: { routes: [] } } as never);
    let release: ((v: unknown) => void) | undefined;
    let verdict: unknown = { verdict: 'allow' };
    h.onRequest('policy', (f) => {
      if ((f as { hook: string }).hook !== 'outbound') return { on: 'dispatch' };
      return new Promise((r) => (release = () => r(verdict)));
    });
    await say(w, 'om_0', 'warm up');
    await until(() => w.gw.hub.log.read(KEY, 0).some((e) => e.body.t === 'turn.completed'));

    // An ACP client that loaded the session, and an AG-UI stream from its head.
    const toDaemon = new PassThrough();
    const fromDaemon = new PassThrough();
    void acpPipe({ socket: w.config.socketPath, client: 'reader', token: TOKEN, input: toDaemon, output: fromDaemon, error: () => {} });
    const updates: SessionNotification[] = [];
    const conn = acpClient({ name: 'reader' })
      .onNotification(methods.client.session.update, ({ params }) => void updates.push(params))
      .connect(ndJsonStream(Writable.toWeb(toDaemon) as WritableStream<Uint8Array>, Readable.toWeb(fromDaemon) as ReadableStream<Uint8Array>));
    cleanups.push(() => conn.close());
    await conn.agent.request(methods.agent.initialize, { protocolVersion: 1, clientCapabilities: {} });
    await conn.agent.request(methods.agent.session.load, { sessionId: KEY, cwd: '/tmp', mcpServers: [] });
    const g = (w.gw.host as unknown as { gone(p: unknown): void });
    const orig = g.gone.bind(g);
    const url = (w.gw.adminStatus().modules!.find((m) => m.id === 'ag-ui')!.status as { url: string }).url;
    const res = await fetch(`${url}/threads/${encodeURIComponent(KEY)}/events?fromSeq=${w.gw.hub.log.head(KEY)}`, { headers: { authorization: `Bearer web-${TOKEN}` } });
    let sse = '';
    const reader = res.body!.getReader();
    void (async () => {
      for (;;) {
        const { done, value } = await reader.read().catch(() => ({ done: true, value: undefined }));
        if (done) return;
        sse += new TextDecoder().decode(value);
      }
    })();
    cleanups.push(() => reader.cancel().catch(() => {}));
    const acpText = () => updates.filter((u) => u.update.sessionUpdate === 'agent_message_chunk').map((u) => (u.update as { content: { text: string } }).content.text).join('');

    // The host's scope takes g1 in: its turns are checked from now on.
    expect(await h.exchange({ type: 'host.outboundScope', routes: [{ channel: 'fake', account: 'default', conversationId: 'g1' }] })).toMatchObject({ ok: true });
    release = undefined;
    await say(w, 'om_1', 'tell us');
    await until(() => w.gw.hub.log.read(KEY, 0).filter((e) => e.body.t === 'turn.completed').length === 2 && release);
    await new Promise((r) => setTimeout(r, 100));
    expect(acpText()).toBe('warm');
    expect(sse).not.toContain('secret');
    release!(undefined);
    await until(() => acpText().includes(SECRET) && sse.includes(SECRET));
    // Released whole, from the snapshot: the delta was not kept.
    expect(acpText()).toBe(`warm${SECRET}`);

    verdict = { verdict: 'hold' };
    release = undefined;
    await say(w, 'om_2', 'and again');
    await until(() => w.gw.hub.log.read(KEY, 0).filter((e) => e.body.t === 'turn.completed').length === 3 && release);
    release!(undefined);
    await until(() => w.gw.hub.log.read(KEY, 0).some((e) => e.body.t === 'delivery.settled' && e.body.result === 'held'));
    await new Promise((r) => setTimeout(r, 150));
    expect(acpText()).toBe(`warm${SECRET}`);
    expect(sse.split(SECRET).length - 1).toBe(1);
  });
});

describe('the U20 gate of the north projections reads the log as it grows', () => {
  it('once a turn of the session was checked, a streamed text delta is decided from what was folded in: the log is read as the view starts and past a gap, never per event; what is withheld and released is as before #DL-7', async () => {
    const hub = new Hub(new MemorySessionLog());
    let reads = 0;
    const k = {
      events: (key: string, fromSeq = 0) => (reads++, hub.log.read(key, fromSeq)),
      subscribe: (key: string, o: { fromSeq?: number } = {}) => hub.subscribe({ sessionKey: key, tier: 'full', ...(o.fromSeq !== undefined ? { fromSeq: o.fromSeq } : {}) }),
    } as unknown as KernelContext;
    const S = 'S';
    const G1 = { channel: 'fake', account: 'default', conversationId: 'g1' };
    const add = (turnId: string, body: SessionEvent['body'], o: Partial<EventDraft> = {}) =>
      hub.append(S, { ts: 0, level: 'primary', audience: body.t.startsWith('text.') ? 'answer' : 'status', durability: body.t === 'text.delta' ? 'ephemeral' : 'durable', turnId, body, ...o } as EventDraft);
    const turn = (turnId: string, checked: boolean, deltas: number, o: { internal?: boolean } = {}) => {
      add(turnId, { t: 'turn.started', turnId, inputIds: [`in_${turnId}`], replyRoute: G1, checked });
      if (o.internal) add(turnId, { t: 'item.started', item: { itemId: `hook_${turnId}`, type: 'hook_prompt', title: 'hook', status: 'running' } } as SessionEvent['body'], { visibility: 'internal' });
      for (let i = 0; i < deltas; i++) add(turnId, { t: 'text.delta', stream: 'answer', delta: `${turnId}-${i} ` });
      add(turnId, { t: 'text.snapshot', text: `answer of ${turnId}`, final: true });
      add(turnId, { t: 'turn.completed', turnId, status: 'completed' });
      add(turnId, { t: 'delivery.settled', operationId: `op_${turnId}`, route: G1, result: 'delivered', kind: 'reply', turnId } as SessionEvent['body']);
    };
    turn('t0', true, 0);
    const view = new ExternalView(k, S, { fromSeq: hub.log.head(S) });
    cleanups.push(() => view.close());
    expect(reads).toBe(1);
    const got: SessionEvent[] = [];
    void (async () => {
      for await (const e of view) got.push(e);
    })();
    const said = () => got.flatMap((e) => (e.body.t === 'text.snapshot' ? [e.body.text] : e.body.t === 'text.delta' ? [e.body.delta] : []));

    // A checked turn: its 300 deltas are dropped, its answer comes once settled; nothing is read for them.
    turn('t1', true, 300);
    await until(() => said().includes('answer of t1'));
    expect(said()).toEqual(['answer of t1']);
    expect(reads).toBe(1);
    // A turn not checked streams as it is; one internal event (the subscription does not give it) is read once.
    turn('t2', false, 300, { internal: true });
    await until(() => said().includes('answer of t2'));
    expect(said()).toEqual(['answer of t1', ...Array.from({ length: 300 }, (_, i) => `t2-${i} `), 'answer of t2']);
    expect(reads).toBe(2);
    expect(got.map((e) => e.seq)).toEqual([...got.map((e) => e.seq)].sort((a, b) => a - b));
  });
});
