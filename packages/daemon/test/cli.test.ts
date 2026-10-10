import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { FakeTurnScript } from '@agents-io/testkit';
import { exitCodeFor, main } from '../src/cli.js';
import { CommandError, DaemonUnavailable } from '../src/client.js';
import { ConfigError, configTable, resolveConfig } from '../src/config.js';
import { TokenError, tokenPath } from '../src/token.js';
import { cli } from './cli-helpers.js';
import { daemon, tmp } from './helpers.js';

const ctx = (dir: string) => ({ env: {}, baseDir: dir, cwd: dir });

describe('config: agents and bindings', () => {
  it('rejects: unknown harness, unknown / task targets, a task default, a missing instructions file, identity conflicts, bad digests #RT-1', () => {
    const d = '/tmp';
    const bad = (raw: unknown, re: RegExp) => expect(() => resolveConfig(raw, ctx(d))).toThrow(re);
    bad({ agents: { a: { harness: 'nope' } } }, /agents\.a\.harness: unknown harness instance/);
    bad({ agents: { a: { harness: 'claude-code', mode: 'task' } }, bindings: [{ id: 'x', match: {}, on: 'dispatch', agent: 'a' }] }, /task agent/);
    bad({ agents: { a: { harness: 'claude-code' } }, bindings: [{ id: 'x', match: {}, on: 'context', agent: 'ghost' }] }, /unknown agent "ghost"/);
    bad({ agents: { a: { harness: 'claude-code', mode: 'task' } }, defaultAgent: 'a' }, /defaultAgent "a" is a task agent/);
    bad({ agents: { a: { harness: 'claude-code', instructionsFile: 'missing.md' } } }, /instructionsFile: cannot read/);
    bad(
      { identities: [{ channel: 'c', channelUserId: 'u', principal: 'p1', labels: [] }, { channel: 'c', channelUserId: 'u', principal: 'p2', labels: [] }] },
      /mapped twice/,
    );
    bad({ bindings: [{ id: 'x', match: {}, on: 'digest' }] }, /digest needs digest.everyMs/);
    bad({ agents: { a: { harness: 'claude-code', bogus: 1 } } }, /invalid config/);
    bad({ defaultAgent: 'x' }, /`defaultAgent` needs `agents`/);
  });

  it('a callout onFailure that targets a task agent is rejected too; host rules need no agent #RT-1', () => {
    expect(() =>
      resolveConfig({ agents: { t: { harness: 'claude-code', mode: 'task' } }, bindings: [{ id: 'x', match: {}, on: 'host', agent: 't', callout: { onFailure: 'dispatch' } }] }, ctx('/tmp')),
    ).toThrow(/task agent/);
    const c = resolveConfig({ agents: { t: { harness: 'claude-code', mode: 'task' } }, bindings: [{ id: 'x', match: { actionPrefix: 'xwo:' }, on: 'host' }] }, ctx('/tmp'));
    expect(c.defaultAgent).toBeUndefined();
    expect(configTable(c)!.bindings).toHaveLength(1);
  });
});

describe('cli arguments', () => {
  it('maps errors to exit codes #RN-1', () => {
    expect(exitCodeFor(new ConfigError('x'))).toBe(2);
    expect(exitCodeFor(new DaemonUnavailable('x'))).toBe(69);
    expect(exitCodeFor(new TokenError('x'))).toBe(69);
    expect(exitCodeFor(new CommandError('unauthorized', 'x'))).toBe(77);
    expect(exitCodeFor(new CommandError('not_task_agent', 'x'))).toBe(2);
    expect(exitCodeFor(new CommandError('internal', 'x'))).toBe(1);
  });

  it('a daemon that is not running is a clear error (exit 69) #RN-1', async () => {
    const dir = tmp();
    const err = await main(['explain', 'in_x', '--socket', join(dir, 'aio.sock')]).catch((e: Error) => e);
    expect(err).toBeInstanceOf(TokenError);
    expect((err as Error).message).toMatch(/is `aio serve` running/);
    expect(exitCodeFor(err)).toBe(69);
    writeFileSync(tokenPath(join(dir, 'aio.sock')), 'tok', { mode: 0o600 });
    const err2 = await main(['explain', 'in_x', '--socket', join(dir, 'aio.sock')]).catch((e: Error) => e);
    expect(err2).toBeInstanceOf(DaemonUnavailable);
  });
});

const echo: FakeTurnScript = async (t) => {
  const text = t.inputs.flatMap((i) => i.content).map((c) => (c.type === 'text' ? c.text : '')).join(' ');
  if (text.includes('fail')) throw new Error('boom');
  t.emit({ t: 'item.started', item: { itemId: 'i', type: 'command', title: 'ls -la', status: 'running' } });
  t.emit({ t: 'text.snapshot', text: `echo: ${text}`, final: true }, { audience: 'answer' });
};

describe('cli against a daemon', () => {
  it('aio run blocks until run.ended, prints the answer, streams progress to stderr, exits with the run exit code #RN-1', async () => {
    const w = await daemon({ raw: { agents: { exec: { harness: 'claude-code', mode: 'task' }, chat: { harness: 'claude-code' } } }, script: echo });
    const s = ['--socket', w.config.socketPath];
    const ok = await cli(['run', ...s, '--agent', 'exec', '--run-id', 'cli-1', '--cwd', w.dir, '--', 'reply', 'pong']);
    expect(ok.code).toBe(0);
    expect(ok.out).toBe('echo: reply pong\n');
    expect(ok.err).toMatch(/▸ started \(claude-code, haiku, restricted\)/);
    expect(ok.err).toMatch(/· command: ls -la/);
    expect(ok.err).toMatch(/run cli-1 completed \(exit 0\)/);
    expect((await cli(['run', ...s, '--agent', 'exec', '--run-id', 'cli-2', '--', 'please fail'])).code).toBe(1);
    // Rerunning an id reports the first outcome.
    expect((await cli(['run', ...s, '--agent', 'exec', '--run-id', 'cli-1', '-q', '--', 'x'])).code).toBe(0);
    await expect(main(['run', ...s, '--agent', 'chat', '--', 'x'])).rejects.toMatchObject({ code: 'not_task_agent' });
  });

  it('a wrong token is refused (exit 77) #SE-3', async () => {
    const w = await daemon();
    writeFileSync(tokenPath(w.config.socketPath), 'not-the-token\n', { mode: 0o600 });
    const e = await main(['explain', 'x', '--socket', w.config.socketPath]).catch((x: Error) => x);
    expect(exitCodeFor(e)).toBe(77);
  });
});
