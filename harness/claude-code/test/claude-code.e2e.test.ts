import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ClaudeCodeHarness } from '../src/index.js';

// e2e tier (decision 14): runs a real child process (a shell script standing in for `claude`).

describe('open → SDK options', () => {
  it('probe runs the configured `claude` with the instance environment #HC-1', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aio-cc-'));
    try {
      const bin = join(dir, 'claude');
      writeFileSync(bin, `#!/bin/sh\nprintf '%s|%s' "$CLAUDE_CONFIG_DIR" "$X_INST" > "${join(dir, 'seen')}"\necho "2.1.291 (Claude Code)"\n`, { mode: 0o755 });
      const h = new ClaudeCodeHarness({ sdkVersion: '0.3.291', claudePath: bin, configDir: join(dir, 'cfg'), env: { X_INST: 'on' } });
      expect((await h.probe()).version).toBe('claude-code 2.1.291 (agent-sdk 0.3.291)');
      expect(readFileSync(join(dir, 'seen'), 'utf8')).toBe(`${join(dir, 'cfg')}|on`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
