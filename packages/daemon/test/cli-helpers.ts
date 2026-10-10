import { vi } from 'vitest';
import { main } from '../src/cli.js';

/** Run `main` capturing stdout and stderr. */
export async function cli(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = '';
  let err = '';
  const o = vi.spyOn(process.stdout, 'write').mockImplementation((s) => ((out += String(s)), true));
  const e = vi.spyOn(process.stderr, 'write').mockImplementation((s) => ((err += String(s)), true));
  const l = vi.spyOn(console, 'log').mockImplementation((...x) => void (out += x.join(' ') + '\n'));
  const ce = vi.spyOn(console, 'error').mockImplementation((...x) => void (err += x.join(' ') + '\n'));
  try {
    return { code: await main(argv), out, err };
  } finally {
    o.mockRestore();
    e.mockRestore();
    l.mockRestore();
    ce.mockRestore();
  }
}
