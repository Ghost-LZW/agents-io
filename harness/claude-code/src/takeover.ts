import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import type { HarnessOpenArgs, HarnessTakeover, HarnessTakeoverArgs, TakeoverLaunch } from '@agents-io/protocol';
import { TUI_BRIDGE_COMMAND } from './bridge.js';
import { AsyncQueue } from './queue.js';
import { ClaudeTuiHarness, type TuiHook, type TuiLink } from './tui.js';

/**
 * Claude Code's own TUI on a session (decision 15, S2): the plumbing between the host and one
 * running TUI (`HarnessAdapter.takeover`). Each takeover has a token and a local HTTP endpoint;
 * the TUI is started with a settings file whose http hooks post to `/tui/<token>/hook`, and an
 * MCP config whose stdio server (`aio tui-bridge`, a child of the TUI, so it has the TUI's inbox
 * token) keeps `/tui/<token>/stream` open and writes each line it gets into the inbox. The stream
 * closing is the TUI leaving: the takeover ends, the session's next turn opens the headless
 * adapter on the same Claude session.
 */

const HOOK_EVENTS = ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Stop', 'PermissionRequest'] as const;
/** How long the TUI has to start and connect its bridge. */
const CONNECT_MS = 60_000;
/** How long a message waits for the bridge before its turn fails. */
const SEND_WAIT_MS = 30_000;

/** How the TUI is started: what an instance's launch settings say (`ClaudeLaunch`). */
export interface ClaudeTuiSettings {
  /** The `claude` command the TUI runs as, as configured (a bare name is looked up on the caller's PATH; default `claude`). */
  executable?: string;
  /** CLAUDE_CONFIG_DIR for the TUI (the instance's, so it sees the same sessions as the headless adapter). */
  configDir?: string;
}

/**
 * Markers of a Claude session the `aio tui` client may itself run inside (a `!` command, an agent's
 * shell): inherited, they would make this TUI a child session (no transcript saved, so nothing to
 * resume) wired to the other session's inbox.
 */
const PARENT_SESSION_ENV = [
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_SESSION_ATTENDED',
];

/** Hand a session to Claude Code's TUI (`HarnessAdapter.takeover`): its endpoint listens once this resolves. */
export async function claudeTuiTakeover(a: HarnessTakeoverArgs, settings: ClaudeTuiSettings = {}): Promise<HarnessTakeover> {
  const token = randomBytes(24).toString('hex');
  const dir = join(a.services.dir, token.slice(0, 16));
  let hold: TuiHold | undefined;
  const server: Server = createServer((req, res) => route(hold, req, res));
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
  });
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch (e) {
    server.close();
    throw e;
  }
  const h = new TuiHold(token, a, (reason) => {
    rmSync(dir, { recursive: true, force: true });
    server.close();
    a.services.onEnd(reason);
  });
  hold = h;
  return {
    harness: h.harness,
    get connected() {
      return h.connected;
    },
    launch: () => launch(h, `http://127.0.0.1:${port}/tui/${token}`, dir, a, settings),
    end: (reason) => h.end(reason),
  };
}

/** The command line for the TUI: its own settings (hooks) and MCP config (the bridge, plus the host's output tools when the session has them), for this launch only. */
function launch(h: TuiHold, base: string, dir: string, a: HarnessTakeoverArgs, settings: ClaudeTuiSettings): TakeoverLaunch {
  const hooks: Record<string, unknown> = {};
  for (const e of HOOK_EVENTS) {
    hooks[e] = [{ ...(e.startsWith('Pre') || e.startsWith('Post') || e === 'PermissionRequest' ? { matcher: '*' } : {}), hooks: [{ type: 'http', url: `${base}/hook/${e}`, timeout: e === 'PermissionRequest' ? 3600 : 10 }] }];
  }
  const settingsFile = join(dir, 'settings.json');
  writeFileSync(settingsFile, JSON.stringify({ hooks }, null, 2), { mode: 0o600 });
  const servers: Record<string, unknown> = {
    'agents-io-bridge': { type: 'stdio', command: process.execPath, args: [a.services.cli, TUI_BRIDGE_COMMAND], env: { AIO_TUI_URL: base, AIO_TUI_SESSION: a.nativeId } },
  };
  if (h.mcp) servers['agents-io'] = { type: h.mcp.transport ?? 'http', url: h.mcp.url, headers: { Authorization: `Bearer ${h.mcp.token}` } };
  const mcp = join(dir, 'mcp.json');
  writeFileSync(mcp, JSON.stringify({ mcpServers: servers }, null, 2), { mode: 0o600 });
  return {
    command: settings.executable ?? 'claude',
    args: [a.resume ? '--resume' : '--session-id', a.nativeId, '--settings', settingsFile, '--mcp-config', mcp, ...(a.model ? ['--model', a.model] : [])],
    env: settings.configDir ? { CLAUDE_CONFIG_DIR: settings.configDir } : {},
    unsetEnv: [...PARENT_SESSION_ENV],
  };
}

/** One TUI on one session: its hooks in, its inbox stream out. */
class TuiHold {
  readonly harness: ClaudeTuiHarness;
  readonly nativeId: string;
  private readonly hooks = new AsyncQueue<TuiHook>();
  private stream: ServerResponse | undefined;
  private waiting: (() => void)[] = [];
  private ended = false;
  private readonly connectTimer: ReturnType<typeof setTimeout>;
  mcp: HarnessOpenArgs['mcp'];

  constructor(
    readonly token: string,
    a: HarnessTakeoverArgs,
    private readonly onEnd: (reason: string) => void,
  ) {
    this.nativeId = a.nativeId;
    this.harness = new ClaudeTuiHarness(a.instance, { nativeId: a.nativeId, link: (args) => this.link(args), fileOf: (ref) => a.services.fileOf(ref) });
    this.connectTimer = setTimeout(() => {
      if (!this.stream) this.end('the terminal UI did not start');
    }, CONNECT_MS);
  }

  get connected(): boolean {
    return !!this.stream && !this.ended;
  }

  get over(): boolean {
    return this.ended;
  }

  private link(args: HarnessOpenArgs): TuiLink {
    this.mcp = args.mcp;
    return {
      send: (text) => this.send(text),
      hooks: this.hooks,
      close: () => this.end('released'),
    };
  }

  private async send(text: string): Promise<void> {
    if (!this.stream) {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('the terminal UI is not connected')), SEND_WAIT_MS);
        this.waiting.push(() => {
          clearTimeout(t);
          resolve();
        });
      });
    }
    if (this.ended || !this.stream) throw new Error('the terminal UI is gone');
    this.stream.write(`${JSON.stringify({ text })}\n`);
  }

  /** The bridge connected: messages go down this response, one JSON line each. */
  attachStream(res: ServerResponse): void {
    if (this.ended) {
      res.writeHead(410).end();
      return;
    }
    this.stream?.end();
    this.stream = res;
    clearTimeout(this.connectTimer);
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store' });
    res.write('\n');
    res.on('close', () => {
      if (this.stream === res) this.end('the terminal UI exited');
    });
    for (const w of this.waiting.splice(0)) w();
  }

  hook(event: string, body: Record<string, unknown>, res: ServerResponse, req: IncomingMessage): void {
    if (event !== 'PermissionRequest') {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end('{}');
      this.hooks.push({ event, body });
      return;
    }
    let answered = false;
    let abandoned: (() => void) | undefined;
    res.on('close', () => {
      if (!answered) abandoned?.();
    });
    this.hooks.push({
      event,
      body,
      answer: (out) => {
        if (answered) return;
        answered = true;
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(out ?? {}));
      },
      onAbandoned: (fn) => {
        abandoned = fn;
        if (req.destroyed && !answered) fn();
      },
    });
  }

  end(reason: string): void {
    if (this.ended) return;
    this.ended = true;
    clearTimeout(this.connectTimer);
    this.stream?.end();
    this.hooks.close();
    this.onEnd(reason);
  }
}

/** A request to a takeover's endpoint: once it ended, nothing there is its own any more. */
function route(h: TuiHold | undefined, req: IncomingMessage, res: ServerResponse): void {
  const m = /^\/tui\/([0-9a-f]{48})\/(stream|hook\/([A-Za-z]+))$/.exec(req.url ?? '');
  if (!m || !h || h.over || m[1] !== h.token) {
    res.writeHead(404).end();
    return;
  }
  if (m[2] === 'stream') {
    if (req.method !== 'GET') return void res.writeHead(405).end();
    h.attachStream(res);
    return;
  }
  if (req.method !== 'POST') return void res.writeHead(405).end();
  let raw = '';
  req.setEncoding('utf8');
  req.on('data', (d: string) => {
    raw += d;
    if (raw.length > 4_000_000) req.destroy();
  });
  req.on('end', () => {
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(raw || '{}') as Record<string, unknown>;
    } catch {
      res.writeHead(400).end();
      return;
    }
    // A hook from another Claude session (a stray settings file) is not this hold's.
    if (typeof body.session_id === 'string' && body.session_id !== h.nativeId) {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end('{}');
      return;
    }
    h.hook(m[3]!, body, res, req);
  });
}
