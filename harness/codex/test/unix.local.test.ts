import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CodexHarness, launchFlags, tomlValue } from '../src/index.js';
import { cleanupAfterEach, privDir } from './unix-helpers.js';

// Local tier (decision 14): launch-flag rendering and option checks with no promise behind them.
// When one breaks because the behaviour changed on purpose, delete or rewrite it.
cleanupAfterEach();

describe('launch settings (named instances)', () => {
  it('-c values are inline TOML; keys and feature names are checked', () => {
    expect(launchFlags({ config: { model: 'gpt-x', model_reasoning_effort: 'low', 'shell_environment_policy.inherit': 'all', n: 3, ok: true, list: ['a', 'b"c'], 'mcp_servers.docs': { url: 'http://d', 'odd key': 1 } }, enable: ['web_search'], disable: ['undo'] })).toEqual([
      '-c', 'model="gpt-x"',
      '-c', 'model_reasoning_effort="low"',
      '-c', 'shell_environment_policy.inherit="all"',
      '-c', 'n=3',
      '-c', 'ok=true',
      '-c', 'list=["a", "b\\"c"]',
      '-c', 'mcp_servers.docs={ url = "http://d", "odd key" = 1 }',
      '--enable', 'web_search',
      '--disable', 'undo',
    ]);
    expect(launchFlags({ config: { 'mcp_servers."my server".url': 'u' } })).toEqual(['-c', 'mcp_servers."my server".url="u"']);
    expect(() => launchFlags({ config: { 'a b': 1 } })).toThrow(/not a dotted TOML key/);
    expect(() => launchFlags({ config: { 'x=y': 1 } })).toThrow(/not a dotted TOML key/);
    expect(() => launchFlags({ enable: ['--evil'] })).toThrow(/feature name/);
    expect(() => tomlValue(null, 'config.k')).toThrow('config.k: null cannot be written as TOML');
  });

  it('stdio: launch flags follow app-server; env is merged over process.env and CODEX_HOME set', async () => {
    const dir = privDir();
    const out = join(dir, 'seen.json');
    const fake = join(dir, 'codex');
    writeFileSync(fake, `#!/bin/sh\nprintf '%s|%s|%s|%s' "$*" "$CODEX_HOME" "$AIO_T_INHERITED" "$AIO_T_REMOVED" > "${out}"\nexit 3\n`, { mode: 0o755 });
    process.env.AIO_T_INHERITED = 'yes';
    process.env.AIO_T_REMOVED = 'should-go';
    try {
      const h = new CodexHarness({ bin: fake, codexHome: join(dir, 'home'), env: { AIO_T_REMOVED: undefined, CODEX_HOME: '/loses' }, config: { model: 'm' }, disable: ['undo'], handshakeTimeoutMs: 2000 });
      await expect(h.probe()).rejects.toThrow();
      expect(readFileSync(out, 'utf8')).toBe(`app-server -c model="m" --disable undo|${join(dir, 'home')}|yes|`);
    } finally {
      delete process.env.AIO_T_INHERITED;
      delete process.env.AIO_T_REMOVED;
    }
  });

  it('config/enable/disable need a server the adapter starts', () => {
    expect(() => new CodexHarness({ config: { model: 'x' }, transport: { kind: 'unix', spawn: 'daemon' } })).toThrow(/not unix spawn 'daemon'/);
    expect(() => new CodexHarness({ enable: ['x'], transport: { kind: 'unix', spawn: 'none' } })).toThrow(/not unix spawn 'none'/);
  });
});
