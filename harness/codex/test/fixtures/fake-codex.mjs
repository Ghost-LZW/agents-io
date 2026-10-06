#!/usr/bin/env node
// Stand-in for `codex app-server --listen unix://PATH`: WebSocket over a Unix
// socket (0600), enough JSON-RPC for the spawn:'own' tests. A turn completes
// after FAKE_CODEX_TURN_MS (default 400ms), even if no client is connected.
import { chmodSync } from 'node:fs';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';

const listen = process.argv[process.argv.indexOf('--listen') + 1] ?? '';
if (process.argv[2] !== 'app-server' || !listen.startsWith('unix://')) {
  console.error('usage: fake-codex app-server --listen unix://PATH');
  process.exit(2);
}
const path = listen.slice('unix://'.length);
const turnMs = Number(process.env.FAKE_CODEX_TURN_MS ?? 400);
const clients = new Set();
const broadcast = (m) => {
  for (const c of clients) c.send(JSON.stringify(m));
};
let turnSeq = 0;
const active = new Map();
let connections = 0;

const http = createServer();
const wss = new WebSocketServer({ server: http, perMessageDeflate: false });
wss.on('connection', (ws) => {
  clients.add(ws);
  connections++;
  ws.on('close', () => clients.delete(ws));
  ws.on('message', (d) => {
    const m = JSON.parse(d.toString());
    if (m.id === undefined || !m.method) return;
    const reply = (result) => ws.send(JSON.stringify({ id: m.id, result }));
    const p = m.params ?? {};
    switch (m.method) {
      case 'initialize':
        return reply({ userAgent: `fake/0.160.1 (pid ${process.pid}; conn ${connections})`, codexHome: '/tmp', platformFamily: 'unix', platformOs: 'test' });
      case 'thread/start':
      case 'thread/resume': {
        const id = p.threadId ?? 'thr-own';
        return reply({
          thread: { id, status: active.has(id) ? { type: 'active', activeFlags: [] } : { type: 'idle' }, turns: [] },
          model: 'fake', reasoningEffort: null,
        });
      }
      case 'thread/turns/list':
        return reply({ data: [], nextCursor: null, backwardsCursor: null });
      case 'thread/unsubscribe':
        return reply({ status: 'unsubscribed' });
      case 'turn/start': {
        const id = `turn-${++turnSeq}`;
        const th = p.threadId;
        active.set(th, id);
        reply({ turn: { id, items: [], status: 'inProgress', error: null } });
        broadcast({ method: 'turn/started', params: { threadId: th, turn: { id, items: [], status: 'inProgress', error: null } } });
        const item = { type: 'userMessage', id: `um-${id}`, clientId: p.clientUserMessageId, content: [] };
        broadcast({ method: 'item/completed', params: { threadId: th, turnId: id, item } });
        setTimeout(() => {
          active.delete(th);
          broadcast({ method: 'turn/completed', params: { threadId: th, turn: { id, items: [], status: 'completed', error: null } } });
        }, turnMs);
        return;
      }
      default:
        ws.send(JSON.stringify({ id: m.id, error: { code: -32601, message: `fake: ${m.method}` } }));
    }
  });
});
http.listen(path, () => chmodSync(path, 0o600));
process.on('SIGTERM', () => process.exit(0));
