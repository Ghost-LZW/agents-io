import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import type { HarnessOpenArgs } from '@agents-io/protocol';
import { ClaudeTuiHarness, type TuiFileOf, type TuiHook, type TuiLink } from '@agents-io/harness-claude-code';
import { AsyncQueue } from '@agents-io/testkit';

/**
 * Claude Code's own TUI on a session (decision 15, S2): the plumbing between the daemon and one
 * running TUI. Each hold has a token; the TUI is started with a settings file whose http hooks
 * post to `/tui/<token>/hook`, and an MCP config whose stdio server (`aio tui-bridge`, a child of
 * the TUI, so it has the TUI's inbox token) keeps `/tui/<token>/stream` open and writes each line
 * it gets into the inbox. The stream closing is the TUI leaving: the hold ends, the lane's next
 * turn opens the headless adapter on the same Claude session.
 */

const HOOK_EVENTS = ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Stop', 'PermissionRequest'] as const;
/** How long the TUI has to start and connect its bridge. */
const CONNECT_MS = 60_000;
/** How long a message waits for the bridge before its turn fails. */
const SEND_WAIT_MS = 30_000;

export interface ClaudeTuiLaunch {
  command: string;
  args: string[];
  env: Record<string, string>;
  unsetEnv: string[];
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

export class TuiHold {
  readonly harness: ClaudeTuiHarness;
  private readonly hooks = new AsyncQueue<TuiHook>();
  private stream: ServerResponse | undefined;
  private waiting: (() => void)[] = [];
  private ended = false;
  private readonly connectTimer: ReturnType<typeof setTimeout>;
  mcp: HarnessOpenArgs['mcp'];

  constructor(
    readonly token: string,
    readonly sessionKey: string,
    readonly instance: string,
    readonly nativeId: string,
    readonly dir: string,
    private readonly onEnd: (h: TuiHold, reason: string) => void,
    fileOf?: TuiFileOf,
  ) {
    this.harness = new ClaudeTuiHarness(instance, { nativeId, link: (args) => this.link(args), ...(fileOf ? { fileOf } : {}) });
    this.connectTimer = setTimeout(() => {
      if (!this.stream) this.end('the terminal UI did not start');
    }, CONNECT_MS);
  }

  get connected(): boolean {
    return !!this.stream && !this.ended;
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
    this.onEnd(this, reason);
  }
}

export class ClaudeTuiService {
  private server: Server | undefined;
  private port = 0;
  private readonly holds = new Map<string, TuiHold>();

  constructor(
    private readonly o: {
      /** Where each hold's settings and MCP config are written (0700). */
      dir: string;
      /** The `aio` CLI the bridge runs as (`node <cli> tui-bridge`). */
      cli: string;
      fileOf?: TuiFileOf;
      onEnd: (h: TuiHold, reason: string) => void;
      log: (level: 'info' | 'warn', msg: string) => void;
    },
  ) {}

  /** The hold of a session, while its TUI is attached. */
  holdOf(sessionKey: string): TuiHold | undefined {
    for (const h of this.holds.values()) if (h.sessionKey === sessionKey) return h;
    return undefined;
  }

  async hold(sessionKey: string, instance: string, nativeId: string): Promise<TuiHold> {
    await this.listen();
    const token = randomBytes(24).toString('hex');
    const dir = join(this.o.dir, token.slice(0, 16));
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const h = new TuiHold(token, sessionKey, instance, nativeId, dir, (x, reason) => {
      this.holds.delete(x.token);
      rmSync(x.dir, { recursive: true, force: true });
      this.o.onEnd(x, reason);
    }, this.o.fileOf);
    this.holds.set(token, h);
    return h;
  }

  /**
   * The command line for the TUI of a hold: its own settings (hooks) and MCP config (the bridge,
   * plus the host's output tools when the session has them), for this launch only.
   */
  launch(h: TuiHold, o: { executable: string; resume: boolean; model?: string; configDir?: string }): ClaudeTuiLaunch {
    const base = `http://127.0.0.1:${this.port}/tui/${h.token}`;
    const hooks: Record<string, unknown> = {};
    for (const e of HOOK_EVENTS) {
      hooks[e] = [{ ...(e.startsWith('Pre') || e.startsWith('Post') || e === 'PermissionRequest' ? { matcher: '*' } : {}), hooks: [{ type: 'http', url: `${base}/hook/${e}`, timeout: e === 'PermissionRequest' ? 3600 : 10 }] }];
    }
    const settings = join(h.dir, 'settings.json');
    writeFileSync(settings, JSON.stringify({ hooks }, null, 2), { mode: 0o600 });
    const servers: Record<string, unknown> = {
      'agents-io-bridge': { type: 'stdio', command: process.execPath, args: [this.o.cli, 'tui-bridge'], env: { AIO_TUI_URL: base, AIO_TUI_SESSION: h.nativeId } },
    };
    if (h.mcp) servers['agents-io'] = { type: h.mcp.transport ?? 'http', url: h.mcp.url, headers: { Authorization: `Bearer ${h.mcp.token}` } };
    const mcp = join(h.dir, 'mcp.json');
    writeFileSync(mcp, JSON.stringify({ mcpServers: servers }, null, 2), { mode: 0o600 });
    return {
      command: o.executable,
      args: [o.resume ? '--resume' : '--session-id', h.nativeId, '--settings', settings, '--mcp-config', mcp, ...(o.model ? ['--model', o.model] : [])],
      env: o.configDir ? { CLAUDE_CONFIG_DIR: o.configDir } : {},
      unsetEnv: PARENT_SESSION_ENV,
    };
  }

  async close(): Promise<void> {
    for (const h of [...this.holds.values()]) h.end('daemon stopping');
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
    this.server = undefined;
  }

  private listen(): Promise<void> {
    if (this.server) return Promise.resolve();
    const server = createServer((req, res) => this.route(req, res));
    this.server = server;
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        this.port = (server.address() as AddressInfo).port;
        resolve();
      });
    });
  }

  private route(req: IncomingMessage, res: ServerResponse): void {
    const m = /^\/tui\/([0-9a-f]{48})\/(stream|hook\/([A-Za-z]+))$/.exec(req.url ?? '');
    const h = m ? this.holds.get(m[1]!) : undefined;
    if (!m || !h) {
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
}
