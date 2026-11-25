import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PassThrough, Readable, Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { client as acpClient, methods, ndJsonStream, type SessionNotification } from '@agentclientprotocol/sdk';
import type { FakeTurnScript } from '@agents-io/testkit';
import type { LocalClient } from '@agents-io/kernel';
import { acpPipe } from '../src/acp-server.js';
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
