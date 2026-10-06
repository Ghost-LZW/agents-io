import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Brand } from './requirements.js';

export interface StoredCredentials {
  appId: string;
  appSecret: string;
  brand: Brand;
  /** Verified owner principal key (`lark-bot:<union_id>`), when one was resolved. */
  owner?: string;
}

export const defaultCredentialsPath = (appId: string, home = homedir()): string =>
  join(home, '.config', 'agents-io', 'lark', `${appId}.json`);

/** JSON file, mode 0600; its directory is created 0700. */
export function writeCredentials(path: string, c: StoredCredentials): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(c, null, 2) + '\n', { mode: 0o600 });
  chmodSync(path, 0o600); // writeFileSync's mode is ignored for an existing file
}

export function readCredentials(path: string): StoredCredentials {
  const c = JSON.parse(readFileSync(path, 'utf8')) as Partial<StoredCredentials>;
  if (!c.appId || !c.appSecret) throw new Error(`${path}: not a credentials file`);
  return { appId: c.appId, appSecret: c.appSecret, brand: c.brand === 'lark' ? 'lark' : 'feishu', ...(c.owner ? { owner: c.owner } : {}) };
}

/**
 * Insert or update `KEY=value` lines (other lines untouched). `AGENTS_IO_OWNERS` is a comma list and is
 * merged rather than replaced. File mode ends up 0600 because it holds a secret.
 */
export function updateEnvFile(path: string, vars: Record<string, string | undefined>): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lines = existsSync(path) ? readFileSync(path, 'utf8').split('\n') : [];
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) continue;
    const idx = lines.findIndex((l) => new RegExp(`^\\s*(export\\s+)?${key}=`).test(l));
    let next = value;
    if (key === 'AGENTS_IO_OWNERS' && idx >= 0) {
      const old = lines[idx]!.slice(lines[idx]!.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '');
      next = [...new Set([...old.split(',').map((s) => s.trim()).filter(Boolean), ...value.split(',')])].join(',');
    }
    if (idx >= 0) lines[idx] = `${key}=${next}`;
    else lines.push(`${key}=${next}`);
  }
  writeFileSync(path, lines.join('\n') + '\n', { mode: 0o600 });
  chmodSync(path, 0o600);
}
