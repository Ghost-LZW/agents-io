import { execFile, spawn } from 'node:child_process';
import { chmodSync, closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import WebSocket from 'ws';
import type { Transport } from './rpc.js';

/**
 * codex app-server on `unix://` speaks **WebSocket over the Unix socket** (one
 * JSON-RPC message per text frame), not raw JSONL: the acceptor upgrades every
 * connection (`app-server-transport/src/transport/unix_socket.rs`). Codex closes
 * upgrades that offer compression, so permessage-deflate is off.
 */
export function connectUnix(path: string, timeoutMs = 10_000): Promise<Transport> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket('ws://localhost/', {
      perMessageDeflate: false,
      handshakeTimeout: timeoutMs,
      createConnection: () => net.connect(path),
    });
    const lineCbs: ((l: string) => void)[] = [];
    const closeCbs: ((r: string) => void)[] = [];
    let closed: string | undefined;
    let opened = false;
    const fire = (reason: string) => {
      if (closed !== undefined) return;
      closed = reason;
      for (const cb of closeCbs.splice(0)) cb(reason);
    };
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      const s = data.toString();
      for (const cb of lineCbs) cb(s);
    });
    ws.on('error', (err) => {
      if (!opened) reject(new Error(`cannot connect to codex app-server at ${path}: ${err.message}`));
      fire(`codex app-server socket error: ${err.message}`);
    });
    ws.on('close', (code) => fire(`codex app-server connection closed (${code})`));
    ws.on('open', () => {
      opened = true;
      resolve({
        write(line) {
          if (closed === undefined) ws.send(line);
        },
        onLine(cb) {
          lineCbs.push(cb);
        },
        onClose(cb) {
          if (closed !== undefined) cb(closed);
          else closeCbs.push(cb);
        },
        close() {
          ws.close();
          setTimeout(() => ws.terminate(), 1000).unref();
        },
      });
    });
  });
}

/** `unix://` with no path: `$CODEX_HOME/app-server-control/app-server-control.sock` (also the daemon's socket). */
export function defaultCodexSocket(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.CODEX_HOME ?? join(homedir(), '.codex'), 'app-server-control', 'app-server-control.sock');
}

/** Where `spawn: 'own'` keeps its socket and state. Short on purpose: sun_path is ~104 bytes on macOS. */
export function defaultStateDir(): string {
  return join(homedir(), '.agents-io', 'codex');
}

/** Creates `dir` owner-only (0700), tightening it if it already exists. */
export function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
}

/**
 * Any client on the socket can answer approvals, so refuse sockets other users
 * can reach: owner must be us, no group/other bits on the socket (following the
 * symlink codex uses for long paths) or on its directory.
 */
export function assertPrivateSocket(path: string): void {
  const uid = process.getuid?.();
  for (const [p, what] of [
    [path, 'socket'],
    [dirname(path), 'socket directory'],
  ] as const) {
    const st = statSync(p);
    if (uid !== undefined && st.uid !== uid) throw new Error(`codex app-server ${what} ${p} is owned by uid ${st.uid}, not ${uid}`);
    if (st.mode & 0o077) throw new Error(`codex app-server ${what} ${p} is accessible to other users (mode ${(st.mode & 0o777).toString(8)})`);
  }
}

// ---- spawn: 'own' -------------------------------------------------------------------

export interface OwnServerState {
  pid: number;
  socket: string;
  bin: string;
  startedAt: number;
  /** Fingerprint of bin, CODEX_HOME and launch flags (absent in records from older versions). */
  launch?: string;
}

const stateFile = (dir: string) => join(dir, 'server.json');

export function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

/** Atomic, owner-only write. */
export function writeJson(file: string, value: unknown): void {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  renameSync(tmp, file);
}

export function removeFile(file: string): void {
  try {
    unlinkSync(file);
  } catch {
    /* already gone */
  }
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export async function canConnect(path: string): Promise<boolean> {
  try {
    const t = await connectUnix(path, 2000);
    t.close();
    return true;
  } catch {
    return false;
  }
}

/**
 * Finds or starts this deployment's own app-server. A running one recorded in the
 * state file is reused (a restarted host reattaches); otherwise `codex app-server
 * --listen unix://PATH` is spawned detached, in its own process group, so it
 * survives the host. Two hosts racing is safe: codex refuses to bind a socket
 * that is already accepting connections, and the loser connects to the winner.
 */
export async function ensureOwnServer(opts: {
  stateDir: string;
  socket?: string;
  bin: string;
  env?: NodeJS.ProcessEnv;
  /** Extra `app-server` arguments (`-c`, `--enable`, …). */
  args?: string[];
  /** Launch fingerprint; a recorded live server with a different one is refused. */
  launch?: string;
  startTimeoutMs?: number;
}): Promise<{ socket: string; state: OwnServerState; spawned: boolean }> {
  ensurePrivateDir(opts.stateDir);
  const socket = opts.socket ?? join(opts.stateDir, 'app-server.sock');
  ensurePrivateDir(dirname(socket));
  const prev = readJson<OwnServerState>(stateFile(opts.stateDir));
  if (prev && prev.socket === socket && opts.launch && prev.launch && prev.launch !== opts.launch && pidAlive(prev.pid))
    throw new Error(
      `codex app-server ${prev.pid} on ${socket} was started with other settings (binary, CODEX_HOME or -c/--enable/--disable); ` +
        `stop it (kill ${prev.pid}) to restart with the new ones, or give this harness its own stateDir`,
    );
  if (await canConnect(socket)) {
    const state = prev && prev.socket === socket && pidAlive(prev.pid) ? prev : { pid: 0, socket, bin: opts.bin, startedAt: Date.now() };
    return { socket, state, spawned: false };
  }
  if (prev && prev.socket === socket && pidAlive(prev.pid)) {
    // Recorded process is alive but not accepting (still starting, or wedged): give it a moment.
    if (await waitForSocket(socket, 5000)) return { socket, state: prev, spawned: false };
  }

  const log = openSync(join(opts.stateDir, 'app-server.log'), 'a', 0o600);
  const child = spawn(opts.bin, ['app-server', '--listen', `unix://${socket}`, ...(opts.args ?? [])], {
    detached: true,
    stdio: ['ignore', log, log],
    env: opts.env ?? process.env,
  });
  closeSync(log);
  const exited = new Promise<string>((resolve) => {
    child.once('exit', (code, sig) => resolve(`exited (${sig ?? `code ${code}`})`));
    child.once('error', (e) => resolve(`failed to start: ${e.message}`));
  });
  child.unref();
  const ready = await Promise.race([waitForSocket(socket, opts.startTimeoutMs ?? 20_000), exited]);
  if (ready !== true) {
    // Lost a race with another host? Then its server is there now.
    if (await canConnect(socket)) return { socket, state: { pid: 0, socket, bin: opts.bin, startedAt: Date.now() }, spawned: false };
    const tail = (() => {
      try {
        return readFileSync(join(opts.stateDir, 'app-server.log'), 'utf8').slice(-1500);
      } catch {
        return '';
      }
    })();
    throw new Error(`codex app-server on ${socket} ${typeof ready === 'string' ? ready : 'did not start in time'}\n${tail}`);
  }
  const state: OwnServerState = { pid: child.pid!, socket, bin: opts.bin, startedAt: Date.now(), ...(opts.launch ? { launch: opts.launch } : {}) };
  writeJson(stateFile(opts.stateDir), state);
  return { socket, state, spawned: true };
}

/** Stops the recorded own server (SIGTERM to its process group). */
export function stopOwnServer(stateDir: string): boolean {
  const s = readJson<OwnServerState>(stateFile(stateDir));
  removeFile(stateFile(stateDir));
  if (!s?.pid || !pidAlive(s.pid)) return false;
  try {
    process.kill(-s.pid, 'SIGTERM');
  } catch {
    process.kill(s.pid, 'SIGTERM');
  }
  return true;
}

async function waitForSocket(path: string, timeoutMs: number): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await canConnect(path)) return true;
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

// ---- spawn: 'daemon' ----------------------------------------------------------------

/**
 * `codex app-server daemon start` is idempotent (reports `alreadyRunning`) and
 * prints JSON with `socketPath`. It needs the standalone managed install
 * (`$CODEX_HOME/packages/standalone/current/codex`) and is shared by every Codex
 * client on the machine, so this adapter never stops it.
 */
export function startDaemon(bin: string, env?: NodeJS.ProcessEnv): Promise<{ socket: string; output: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    execFile(bin, ['app-server', 'daemon', 'start'], { env: env ?? process.env, timeout: 60_000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`codex app-server daemon start failed: ${(stderr || err.message).trim()}`));
      try {
        const output = JSON.parse(stdout.trim().split('\n').at(-1) ?? '{}') as Record<string, unknown>;
        if (typeof output.socketPath !== 'string') throw new Error('no socketPath');
        resolve({ socket: output.socketPath, output });
      } catch (e) {
        reject(new Error(`unexpected output from codex app-server daemon start: ${stdout.trim()} (${(e as Error).message})`));
      }
    });
  });
}
