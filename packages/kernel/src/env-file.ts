import { readFileSync } from 'node:fs';

/**
 * Minimal KEY=VALUE parser for the gitignored `.env.live` (no dependency). Supports
 * blank lines, `#` comments, an optional `export ` prefix and single/double quotes.
 * Values are never logged.
 */
export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2]!;
    const q = v[0];
    if ((q === '"' || q === "'") && v.endsWith(q) && v.length >= 2) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, '');
    out[m[1]!] = v;
  }
  return out;
}

/** Reads `path` if it exists; returns {} otherwise. */
export function loadEnvFile(path: string | URL): Record<string, string> {
  try {
    return parseEnv(readFileSync(path, 'utf8'));
  } catch {
    return {};
  }
}
