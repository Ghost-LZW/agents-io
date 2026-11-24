#!/usr/bin/env node
// A stdio MCP server that forwards every JSON-RPC message to the host's MCP endpoint over
// streamable HTTP (`mcp: "stdio-bridge"` of the acp harness kind, harness/acp/README.md): for an
// ACP agent that takes only stdio MCP servers (the protocol's baseline). The agent starts it as
// its own child with AIO_MCP_URL and AIO_MCP_TOKEN in its environment (never on the command line).
// One line in, one POST; what the endpoint answers (JSON, or the `data:` of an event stream) goes
// out on stdout, one message a line. It exits when its stdin ends. No dependencies.
import { createInterface } from 'node:readline';

const url = process.env.AIO_MCP_URL;
const token = process.env.AIO_MCP_TOKEN;
if (!url || !token) {
  process.stderr.write('[agents-io mcp bridge] AIO_MCP_URL / AIO_MCP_TOKEN missing\n');
  process.exit(2);
}

let session;
let pending = 0;
let ended = false;
const out = (m) => process.stdout.write(JSON.stringify(m) + '\n');
const done = () => {
  if (ended && pending === 0) process.exit(0);
};

async function forward(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  const id = msg && typeof msg === 'object' && 'id' in msg && 'method' in msg ? msg.id : undefined;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${token}`,
        ...(session ? { 'mcp-session-id': session } : {}),
      },
      body: line,
    });
    session = res.headers.get('mcp-session-id') ?? session;
    const type = res.headers.get('content-type') ?? '';
    const body = await res.text();
    if (!res.ok) {
      if (id !== undefined) out({ jsonrpc: '2.0', id, error: { code: -32603, message: `the host MCP endpoint answered ${res.status}` } });
      return;
    }
    if (type.includes('text/event-stream')) {
      for (const event of body.split(/\r?\n\r?\n/)) {
        const data = event
          .split(/\r?\n/)
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trimStart())
          .join('\n');
        if (data) out(JSON.parse(data));
      }
    } else if (body.trim()) {
      const v = JSON.parse(body);
      for (const m of Array.isArray(v) ? v : [v]) out(m);
    }
  } catch (e) {
    if (id !== undefined) out({ jsonrpc: '2.0', id, error: { code: -32603, message: `the host MCP endpoint is unreachable: ${e instanceof Error ? e.message : String(e)}` } });
  }
}

const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => {
  if (!line.trim()) return;
  pending++;
  // Each message on its own: a tool that waits (a question for a person) holds up nothing else.
  void forward(line).finally(() => {
    pending--;
    done();
  });
});
lines.on('close', () => {
  ended = true;
  done();
});
