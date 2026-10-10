import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { FakeTurnScript } from '@agents-io/testkit';
import { exitCodeFor, main, parseCli, parseEnvPairs, runRequest, socketOf } from '../src/cli.js';
import { CommandError, DaemonUnavailable } from '../src/client.js';
import { ConfigError, configTable, resolveConfig } from '../src/config.js';
import { TokenError, tokenPath } from '../src/token.js';
import { daemon, tmp } from './helpers.js';

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

  it('rejects: unknown harness, unknown / task targets, a task default, a missing instructions file, identity conflicts, bad digests', () => {
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

  it('a callout onFailure that targets a task agent is rejected too; host rules need no agent', () => {
    expect(() =>
      resolveConfig({ agents: { t: { harness: 'claude-code', mode: 'task' } }, bindings: [{ id: 'x', match: {}, on: 'host', agent: 't', callout: { onFailure: 'dispatch' } }] }, ctx('/tmp')),
    ).toThrow(/task agent/);
    const c = resolveConfig({ agents: { t: { harness: 'claude-code', mode: 'task' } }, bindings: [{ id: 'x', match: { actionPrefix: 'xwo:' }, on: 'host' }] }, ctx('/tmp'));
    expect(c.defaultAgent).toBeUndefined();
    expect(configTable(c)!.bindings).toHaveLength(1);
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

  it('maps errors to exit codes', () => {
    expect(exitCodeFor(new ConfigError('x'))).toBe(2);
    expect(exitCodeFor(new DaemonUnavailable('x'))).toBe(69);
    expect(exitCodeFor(new TokenError('x'))).toBe(69);
    expect(exitCodeFor(new CommandError('unauthorized', 'x'))).toBe(77);
    expect(exitCodeFor(new CommandError('not_task_agent', 'x'))).toBe(2);
    expect(exitCodeFor(new CommandError('internal', 'x'))).toBe(1);
  });

  it('--socket / $AIO_SOCKET pick the daemon without loading a config', () => {
    expect(socketOf(parseCli(['tail', '--socket', '/x/aio.sock']))).toBe('/x/aio.sock');
    expect(socketOf(parseCli(['tail']), { AIO_SOCKET: '/y/aio.sock' })).toBe('/y/aio.sock');
  });

  it('a daemon that is not running is a clear error (exit 69)', async () => {
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

/** Run `main` capturing stdout and stderr. */
async function cli(argv: string[]): Promise<{ code: number; out: string; err: string }> {
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

const echo: FakeTurnScript = async (t) => {
  const text = t.inputs.flatMap((i) => i.content).map((c) => (c.type === 'text' ? c.text : '')).join(' ');
  if (text.includes('fail')) throw new Error('boom');
  t.emit({ t: 'item.started', item: { itemId: 'i', type: 'command', title: 'ls -la', status: 'running' } });
  t.emit({ t: 'text.snapshot', text: `echo: ${text}`, final: true }, { audience: 'answer' });
};

describe('cli against a daemon', () => {
  it('aio run blocks until run.ended, prints the answer, streams progress to stderr, exits with the run exit code', async () => {
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

  it('aio tail --once / ack / send / bindings / explain / verify', async () => {
    const w = await daemon();
    const s = ['--socket', w.config.socketPath];
    const tableFile = join(w.dir, 'table.json');
    writeFileSync(tableFile, JSON.stringify({ version: 't1', bindings: [{ id: 'h', match: { keywords: ['xwo'] }, on: 'host' }], identities: [], onHostDown: 'keep' }));
    const put = await cli(['bindings', 'put', ...s, '--file', tableFile]);
    expect(put.code).toBe(0);
    expect(JSON.parse(put.out)).toMatchObject({ version: 't1', active: true });
    expect(JSON.parse((await cli(['bindings', 'get', ...s])).out).host.table.version).toBe('t1');

    const alice = { channelUserId: 'alice', evidence: 'platform_signed' as const };
    const r = await w.chat.inject({ id: 'x1', sender: alice, text: 'xwo one' });
    await w.chat.inject({ id: 'x2', sender: alice, text: 'xwo two' });
    const t1 = await cli(['tail', ...s, '--consumer', 'xwo', '--once']);
    const lines = t1.out.trim().split('\n').map((l) => JSON.parse(l));
    expect(lines.map((l) => l.channelRef)).toEqual(['channel:fake/x1', 'channel:fake/x2']);
    expect(typeof lines[0].cursor).toBe('number');
    expect((await cli(['ack', ...s, '--consumer', 'xwo', String(lines[0].cursor)])).out).toMatch(/xwo acked/);
    expect((await cli(['tail', ...s, '--consumer', 'xwo', '--once'])).out.trim().split('\n')).toHaveLength(1);
    expect((await cli(['tail', ...s, '--consumer', 'xwo', '--once', '--from', String(lines[1].cursor)])).out).toBe('');

    const sent = await cli(['send', ...s, '--route', '{"channel":"fake","account":"default","conversationId":"c9"}', '--operation-id', 'o1', '--text', 'hi there']);
    expect(sent.code).toBe(0);
    expect(JSON.parse(sent.out)).toMatchObject({ status: 'delivered', duplicate: false });
    expect(JSON.parse((await cli(['send', ...s, '--route', '{"channel":"fake","account":"default","conversationId":"c9"}', '--operation-id', 'o1', '--text', 'hi there'])).out).duplicate).toBe(true);
    expect(w.chat.sent.filter((x) => x.msg.text === 'hi there')).toHaveLength(1);

    const ex = await cli(['explain', ...s, r.inputId!]);
    expect(JSON.parse(ex.out).matched.find((m: { bindingId: string }) => m.bindingId === 'h')).toMatchObject({ source: 'host', on: 'host' });
    expect((await cli(['verify', ...s, 'channel:fake/x1'])).code).toBe(0);
    expect((await cli(['verify', ...s, 'channel:fake/zz'])).code).toBe(1);
    await expect(main(['explain', ...s, 'in_unknown'])).rejects.toMatchObject({ code: 'unknown_input' });
  });

  it('a wrong token is refused (exit 77)', async () => {
    const w = await daemon();
    writeFileSync(tokenPath(w.config.socketPath), 'not-the-token\n', { mode: 0o600 });
    const e = await main(['explain', 'x', '--socket', w.config.socketPath]).catch((x: Error) => x);
    expect(exitCodeFor(e)).toBe(77);
  });
});
