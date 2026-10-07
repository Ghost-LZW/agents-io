import { chmodSync, closeSync, existsSync, mkdirSync, openSync, statSync } from 'node:fs';

/*
 * Gateway data (session transcripts, tool output, watches) is private to this
 * user: files 0600, directories the gateway creates 0700. Existing files are
 * tightened; existing directories are not chmodded (they may be a project dir),
 * only reported. `warn` gets paths and modes, never contents.
 */

const uid = () => process.getuid?.();
const octal = (m: number) => (m & 0o777).toString(8);

/** Create `dir` 0700 if missing; report an existing one that is not ours or that others can read. */
export function privateDir(dir: string, warn: (msg: string) => void): void {
  if (mkdirSync(dir, { recursive: true, mode: 0o700 }) !== undefined) {
    chmodSync(dir, 0o700);
    return;
  }
  const st = statSync(dir);
  const me = uid();
  if (me !== undefined && st.uid !== me) warn(`data directory ${dir} is owned by uid ${st.uid}, not ${me}`);
  else if (st.mode & 0o077) warn(`data directory ${dir} is accessible to other users (mode ${octal(st.mode)}); its files are 0600, but consider chmod 700`);
}

/** Make `path` an owner-only file: created 0600 if missing, chmodded to 0600 if looser. */
export function privateFile(path: string, warn: (msg: string) => void): void {
  if (!existsSync(path)) closeSync(openSync(path, 'a', 0o600));
  const st = statSync(path);
  const me = uid();
  if (me !== undefined && st.uid !== me) {
    warn(`data file ${path} is owned by uid ${st.uid}, not ${me}`);
    return;
  }
  if (st.mode & 0o077) chmodSync(path, 0o600);
}

/** A SQLite database and its WAL/shared-memory/journal files (SQLite gives those the database's mode). */
export function privateDb(path: string, warn: (msg: string) => void): void {
  privateFile(path, warn);
  for (const suffix of ['-wal', '-shm', '-journal']) if (existsSync(path + suffix)) privateFile(path + suffix, warn);
}
