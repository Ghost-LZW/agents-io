import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseCli, parseEnvPairs, runRequest, socketOf } from '../src/cli.js';
import { ConfigError, configTable, resolveConfig } from '../src/config.js';
import { tmp } from './helpers.js';

const ctx = (dir: string) => ({ env: {}, baseDir: dir, cwd: dir });

describe('config: agents and bindings', () => {
  it('without agents: one `default` agent on the default instance, and the owners default table', () => {
    const c = resolveConfig({ policy: { owners: ['lark-bot:ou_1'] } }, ctx('/tmp'));
    expect(c.agents).toEqual({ default: { name: 'default', harness: 'claude-code', mode: 'interactive', tools: false, configured: false } }); // tools off by default (decision 13)
    expect(c.defaultAgent).toBe('default');
    const t = configTable(c)!;
    expect(t.bindings.map((b) => b.id)).toContain('default:owner-dm');
    expect(t.identities).toEqual([{ channel: 'lark-bot', channelUserId: 'ou_1', principal: 'lark-bot:ou_1', labels: ['owner'] }]);
  });

  it('named agents: paths resolved, the default is the first interactive one, instructions read', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'exec.md'), 'be terse');
    const c = resolveConfig(
      { agents: { exec: { harness: 'claude-code', mode: 'task', instructionsFile: 'exec.md', cwd: 'w' }, chat: { harness: 'claude-code', model: 'opus', tools: false } } },
      ctx(dir),
    );
    expect(c.defaultAgent).toBe('chat');
    expect(c.agents.exec).toMatchObject({ mode: 'task', instructions: 'be terse', cwd: join(dir, 'w'), configured: true, tools: false }); // the outputTools default (off)
    expect(c.agents.chat).toMatchObject({ mode: 'interactive', model: 'opus', tools: false });
    // Without bindings the owners table targets the default agent.
    expect(configTable(c)!.bindings.every((b) => b.agent === 'chat')).toBe(true);
  });
});

describe('cli arguments', () => {
  it('parses run requests: env pairs, cwd resolved, observe routes, timeout; errors are usage errors (exit 2)', () => {
    const a = parseCli(['run', '--agent', 'exec', '--run-id', 'r1', '--cwd', 'sub', '--env', 'A=1', '--env', 'B=x=y', '--timeout', '2m', '--observe', '{"channel":"c","account":"a","conversationId":"o"}', '--', 'do', 'the', 'thing']);
    expect(runRequest(a, '/base')).toEqual({
      runId: 'r1',
      agent: 'exec',
      input: [{ type: 'text', text: 'do the thing' }],
      cwd: '/base/sub',
      env: { A: '1', B: 'x=y' },
      observe: { routes: [{ channel: 'c', account: 'a', conversationId: 'o' }] },
      timeoutMs: 120_000,
    });
    expect(runRequest(parseCli(['run', '--agent', 'e', '--', 'x'])).runId).toMatch(/^run_/);
    expect(() => runRequest(parseCli(['run', '--', 'x']))).toThrow(/--agent is required/);
    expect(() => runRequest(parseCli(['run', '--agent', 'e']))).toThrow(/no instruction/);
    expect(() => parseEnvPairs(['NOEQ'])).toThrow(ConfigError);
    expect(() => parseEnvPairs(['1A=2'])).toThrow(ConfigError);
    expect(() => parseCli(['tail', '--bogus'])).toThrow(ConfigError);
    expect(() => parseCli(['tail', '--from', 'x'])).toThrow(/cursor number/);
  });

  it('--socket / $AIO_SOCKET pick the daemon without loading a config', () => {
    expect(socketOf(parseCli(['tail', '--socket', '/x/aio.sock']))).toBe('/x/aio.sock');
    expect(socketOf(parseCli(['tail']), { AIO_SOCKET: '/y/aio.sock' })).toBe('/y/aio.sock');
  });
});
