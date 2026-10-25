import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_FIRST_BYTE_TIMEOUT_MS, chainOf, fallbackChain } from '../src/index.js';
import { input } from './fake-query.js';
import { setup } from './claude-code-helpers.js';

// Local tier: where the watchdog reads Claude Code's fallback chain, and its switch.

function tree(files: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), 'aio-wd-chain-'));
  for (const [rel, v] of Object.entries(files)) {
    const p = join(root, rel);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, typeof v === 'string' ? v : JSON.stringify(v));
  }
  return root;
}

describe('fallbackChain', () => {
  it('reads fallbackModel as an array or a comma-separated string', () => {
    expect(chainOf(['a', ' b ', 3, ''])).toEqual(['a', 'b']);
    expect(chainOf('a, b,,c')).toEqual(['a', 'b', 'c']);
    expect(chainOf(undefined)).toBeUndefined();
    expect(chainOf(null)).toBeUndefined();
  });

  it("the first layer that sets it owns it, in the CLI's order: flag, flag settings, local, project, user", () => {
    const root = tree({
      'cwd/.claude/settings.local.json': { fallbackModel: ['local'] },
      'cwd/.claude/settings.json': { fallbackModel: ['project'] },
      'cfg/settings.json': { fallbackModel: ['user-1', 'user-2'] },
      'flag.json': { fallbackModel: 'flag-file' },
    });
    const base = { cwd: join(root, 'cwd'), configDir: join(root, 'cfg') };
    expect(fallbackChain({ ...base, sdkFallbackModel: 'cli-a,cli-b', settings: { fallbackModel: ['flag'] } })).toEqual(['cli-a', 'cli-b']);
    expect(fallbackChain({ ...base, extraArgFallbackModel: 'extra' })).toEqual(['extra']);
    expect(fallbackChain({ ...base, settings: { fallbackModel: ['flag'] } })).toEqual(['flag']);
    expect(fallbackChain({ ...base, settings: join(root, 'flag.json') })).toEqual(['flag-file']);
    expect(fallbackChain({ ...base, settings: '{"fallbackModel":["inline"]}' })).toEqual(['inline']);
    expect(fallbackChain(base)).toEqual(['local']);
    expect(fallbackChain({ ...base, settingSources: ['project', 'user'] })).toEqual(['project']);
    expect(fallbackChain({ ...base, settingSources: ['user'] })).toEqual(['user-1', 'user-2']);
    expect(fallbackChain({ ...base, settingSources: [] })).toEqual([]);
  });

  it('[] in the winning layer means no fallback; a missing or broken file sets nothing', () => {
    const root = tree({ 'cwd/.claude/settings.json': '{ not json', 'cfg/settings.json': { fallbackModel: [] }, 'home/.claude/settings.json': { fallbackModel: ['home'] } });
    expect(fallbackChain({ cwd: join(root, 'cwd'), configDir: join(root, 'cfg') })).toEqual([]);
    expect(fallbackChain({ cwd: join(root, 'cwd'), home: join(root, 'home') })).toEqual(['home']);
    expect(fallbackChain({ cwd: join(root, 'nowhere'), configDir: join(root, 'nowhere') })).toEqual([]);
  });
});

describe('watchdog options', () => {
  it('defaults to 30 s', () => {
    expect(DEFAULT_FIRST_BYTE_TIMEOUT_MS).toBe(30_000);
  });

  it('firstByteTimeoutMs: 0 turns it off; firstByteFallbackModel names the model over the settings', async () => {
    const off = await setup({}, { firstByteTimeoutMs: 0, firstByteFallbackModel: 'x' });
    await off.s.startTurn('t1', [input('a', 'x')]);
    await new Promise((r) => setTimeout(r, 60));
    expect(off.q.calls).toEqual([]);

    const named = await setup({}, { firstByteTimeoutMs: 10, firstByteFallbackModel: 'named' });
    await named.s.startTurn('t1', [input('a', 'x')]);
    await named.q.waitWritten(2);
    expect(named.q.calls).toEqual([{ method: 'interrupt' }, { method: 'setModel', arg: 'named' }]);
  });
});
