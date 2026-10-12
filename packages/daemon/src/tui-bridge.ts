import { get } from 'node:http';
import { createConnection } from 'node:net';
import { createInterface } from 'node:readline';

/**
 * `aio tui-bridge` (decision 15, S2): a stdio MCP server Claude Code's TUI starts as its own child.
 * It offers no tools; it exists because a child of the TUI holds the TUI's inbox token
 * (`CLAUDE_CODE_MESSAGING_SOCKET` / `_TOKEN`), so what it writes there is delivered in any
 * permission mode. It keeps the daemon's stream for this TUI open (`AIO_TUI_URL/stream`) and writes
 * each message it gets into the inbox; it exits when the TUI closes its stdin, which closes the
 * stream and tells the daemon the TUI left.
 */
export async function tuiBridge(env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const url = env.AIO_TUI_URL;
  const sessionId = env.AIO_TUI_SESSION;
  const inbox = env.CLAUDE_CODE_MESSAGING_SOCKET;
  const token = env.CLAUDE_CODE_MESSAGING_TOKEN;
  const log = (msg: string) => process.stderr.write(`[agents-io bridge] ${msg}\n`);
  if (!url || !sessionId) {
    log('AIO_TUI_URL / AIO_TUI_SESSION missing; started outside `aio tui`?');
    return 2;
  }

  const deliver = (text: string) =>
    new Promise<void>((resolve) => {
      if (!inbox) {
        log('no CLAUDE_CODE_MESSAGING_SOCKET: this Claude Code has no inbox (started with --bare?)');
        return resolve();
      }
      const s = createConnection(inbox);
      s.on('error', (e) => {
        log(`inbox: ${e.message}`);
        resolve();
      });
      s.on('connect', () => {
        if (token) s.write(`${JSON.stringify({ type: 'auth', token })}\n`);
        s.end(`${JSON.stringify({ type: 'user', message: { role: 'user', content: text }, from: 'agents-io', session_id: sessionId })}\n`, () => resolve());
      });
    });

  // Messages are written in order: the next waits for the previous one's connection.
  let chain = Promise.resolve();
  const stream = get(`${url}/stream`, (res) => {
    res.on('error', () => undefined); // aborted when the bridge exits
    if (res.statusCode !== 200) {
      log(`daemon refused the stream (${res.statusCode}); is aio serve running?`);
      res.resume();
      return;
    }
    const lines = createInterface({ input: res });
    lines.on('error', () => undefined); // readline re-emits the aborted stream's error
    lines.on('line', (line) => {
      if (!line.trim()) return;
      try {
        const { text } = JSON.parse(line) as { text?: unknown };
        if (typeof text === 'string' && text) chain = chain.then(() => deliver(text));
      } catch {
        log('bad line from the daemon');
      }
    });
    res.on('end', () => log('daemon closed the stream'));
  });
  stream.on('error', (e) => log(`stream: ${e.message}`));

  // MCP over stdio: enough to be a server with no tools.
  const rpc = createInterface({ input: process.stdin });
  const reply = (id: unknown, result: unknown) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
  rpc.on('line', (line) => {
    let m: { id?: unknown; method?: string; params?: { protocolVersion?: string } };
    try {
      m = JSON.parse(line) as typeof m;
    } catch {
      return;
    }
    if (m.id === undefined) return; // a notification
    if (m.method === 'initialize') reply(m.id, { protocolVersion: m.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'agents-io-bridge', version: '1' } });
    else if (m.method === 'tools/list') reply(m.id, { tools: [] });
    else if (m.method === 'ping') reply(m.id, {});
    else process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: `${m.method} is not supported` } })}\n`);
  });
  await new Promise<void>((resolve) => rpc.on('close', () => resolve()));
  stream.destroy();
  await chain;
  return 0;
}
