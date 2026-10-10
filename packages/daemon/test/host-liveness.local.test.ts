import { describe, expect, it } from 'vitest';
import { resolveConfig } from '../src/config.js';
import { tmp } from './helpers.js';

describe('/ws heartbeat (console.heartbeat)', () => {
  it('config: defaults 30 s / 10 s; intervalMs 0 turns it off', () => {
    const dir = tmp();
    expect(resolveConfig({}, { env: {}, baseDir: dir }).console.heartbeat).toEqual({ intervalMs: 30_000, timeoutMs: 10_000 });
    expect(resolveConfig({ console: { heartbeat: { intervalMs: 0 } } }, { env: {}, baseDir: dir }).console.heartbeat.intervalMs).toBe(0);
    expect(() => resolveConfig({ console: { heartbeat: { timeoutMs: 5 } } }, { env: {}, baseDir: dir })).toThrow();
  });
});
