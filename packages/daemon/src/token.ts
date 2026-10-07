import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/*
 * The host token: a fresh secret per daemon start, in a 0600 file next to the
 * socket (`<socket>.token`). A host proves it may speak the host protocol by
 * presenting it in `host.hello`; the CLI's host commands read it from the file.
 */

export const tokenPath = (socketPath: string) => `${socketPath}.token`;

/** The console API URL, written by `aio serve` next to the token file (same 0600 handling). */
export const consoleUrlPath = (socketPath: string) => `${socketPath}.console`;

/** Write atomically, owner-only. */
export function writeTokenFile(path: string, token: string): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, token + '\n', { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

/** Remove the file only if it still holds our token (another daemon may have replaced it). */
export function removeTokenFile(path: string, token: string): void {
  try {
    if (readFileSync(path, 'utf8').trim() === token) unlinkSync(path);
  } catch {
    // already gone
  }
}

export class TokenError extends Error {
  override name = 'TokenError';
}

/** Read the token; refuses a file others can read or that is not ours. */
export function readTokenFile(path: string): string {
  let st;
  try {
    st = statSync(path);
  } catch {
    throw new TokenError(`no host token at ${path}: is \`aio serve\` running (with this config / --socket)?`);
  }
  const uid = process.getuid?.();
  if (uid !== undefined && st.uid !== uid) throw new TokenError(`${path} is owned by uid ${st.uid}, not ${uid}`);
  if (st.mode & 0o077) throw new TokenError(`${path} is accessible to other users (mode ${(st.mode & 0o777).toString(8)}); refusing to use it`);
  return readFileSync(path, 'utf8').trim();
}

/** Shortest operator-set token accepted (`host.tokenFile`, `aio serve --token-file`). */
export const MIN_TOKEN_LENGTH = 16;

/**
 * An operator-set host token (`aio serve --token-file <path>` / config
 * `host.tokenFile`): the same token across restarts, so a host can be
 * provisioned with it once. If the file exists it is read (it must be ours,
 * not accessible to group / others, in a directory others cannot write, and
 * hold at least MIN_TOKEN_LENGTH characters); otherwise a fresh token is
 * generated and written there (0600; a missing directory is created 0700).
 * The daemon never removes this file.
 */
export function loadOrCreateTokenFile(path: string): { token: string; created: boolean } {
  const uid = process.getuid?.();
  const dir = dirname(path);
  if (existsSync(path)) {
    const st = statSync(path);
    if (!st.isFile()) throw new TokenError(`token file ${path} is not a regular file`);
    checkDir(dir, uid);
    const token = readTokenFile(path);
    if (token.length < MIN_TOKEN_LENGTH) throw new TokenError(`token file ${path} holds ${token.length ? 'a token shorter than' : 'no token; at least'} ${MIN_TOKEN_LENGTH} characters${token.length ? '' : ' are needed'}`);
    if (/\s/.test(token)) throw new TokenError(`token file ${path}: the token contains whitespace`);
    return { token, created: false };
  }
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
  }
  checkDir(dir, uid);
  const token = randomBytes(32).toString('hex');
  writeTokenFile(path, token);
  return { token, created: true };
}

/** The token file's directory: ours (or root's) and not writable by group / others, so nobody can swap the file. */
function checkDir(dir: string, uid: number | undefined): void {
  if (uid === undefined) return;
  const st = statSync(dir);
  if (st.uid !== uid && st.uid !== 0) throw new TokenError(`token file directory ${dir} is owned by uid ${st.uid}, not ${uid}`);
  if (st.mode & 0o022 && !(st.mode & 0o1000)) throw new TokenError(`token file directory ${dir} is writable by other users (mode ${(st.mode & 0o777).toString(8)}); use a private directory`);
}
