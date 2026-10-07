import { chmodSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';

/*
 * The host token: a fresh secret per daemon start, in a 0600 file next to the
 * socket (`<socket>.token`). A host proves it may speak the host protocol by
 * presenting it in `host.hello`; the CLI's host commands read it from the file.
 */

export const tokenPath = (socketPath: string) => `${socketPath}.token`;

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
