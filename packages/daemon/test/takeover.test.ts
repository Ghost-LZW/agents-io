import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { HarnessTakeoverArgs, TuiAttach } from '@agents-io/protocol';
import { MemorySessionLog } from '@agents-io/session';
import { FakeChannel, type FakeHarness } from '@agents-io/testkit';
import { LocalClient } from '../src/client.js';
import { resolveConfig } from '../src/config.js';
import { Gateway } from '../src/gateway.js';
import { cleanups, tmp, until } from './helpers.js';

/*
 * A harness whose own terminal UI takes a session over (`HarnessAdapter.attach: 'takeover'`,
 * `takeover`; decision 15). The daemon's part is the same for any harness that declares it: Claude
 * Code (tui-claude.test.ts, with its real plumbing) and a `use: "module"` harness alike
 * (fixtures/harness-takeover.mjs, a fake terminal). A harness that joins instead: tui.test.ts.
 */

const here = dirname(fileURLToPath(import.meta.url));
const alice = { channelUserId: 'alice', evidence: 'platform_signed' as const };
const dm = { conversation: { id: 'c-alice', kind: 'dm' as const } };

interface FakeTakeover {
  args: HarnessTakeoverArgs;
  terminal: FakeHarness;
  ended: string[];
  closed: string[];
  launches: number;
  connect(): void;
  leave(reason: string): void;
}
const rec = (key: string) => (globalThis as { __takeover?: Record<string, { headless: FakeHarness; takeovers: FakeTakeover[] }> }).__takeover![key]!;
let keys = 0;

/** A daemon whose one instance `plug` is the takeover module harness; the owner's chat is session `main`; `logs`: what it logged. */
async function start(config: Record<string, unknown> = {}) {
  const key = `t${++keys}`;
  const dir = tmp('aio-tko-');
  mkdirSync(join(dir, 'work'), { recursive: true });
  const raw = {
    dataDir: dir,
    cwd: join(dir, 'work'),
    policy: { owners: ['fake:alice'], ownerSessionKey: 'main' },
    local: { principal: 'fake:alice' },
    harnesses: { plug: { use: 'module', module: './fixtures/harness-takeover.mjs', config: { key, ...config } } },
    defaultHarness: 'plug',
  };
  const base = resolveConfig(raw, { env: {}, baseDir: here, cwd: dir });
  const socketPath = join(dir, 'run', 'aio.sock');
  const chat = new FakeChannel('fake');
  const logs: string[] = [];
  const gw = await Gateway.start({ config: { ...base, socketPath }, log: new MemorySessionLog(), channels: [{ adapter: chat }], logger: (_level, msg) => void logs.push(msg) });
  cleanups.push(() => gw.stop());
  const client = await LocalClient.connect(socketPath);
  cleanups.push(() => client.close());
  const replies = () => chat.sent.map((s) => s.edits.at(-1)?.text ?? s.msg.text);
  /** Alice says `text`; the reply to it that `match` finds. */
  const say = async (text: string, match: (reply: string) => boolean) => {
    const before = replies().length;
    await chat.inject({ ...dm, sender: alice, text });
    return until(() => replies().slice(before).find((r) => r !== undefined && match(r)));
  };
  return { gw, dir, socketPath, client, say, logs, rec: rec(key) };
}

describe('a harness whose terminal UI takes the session over', () => {
  it("a module harness declaring it gets the daemon's flow: its terminal holds the session and runs its turns until it leaves, then the adapter resumes the same native session, which the next attach resumes too #LN-9", async () => {
    const w = await start();
    const t = (await w.client.tuiAttach()) as TuiAttach;
    expect(t.nativeId).toMatch(/^[0-9a-f-]{36}$/); // a new session: a new id
    expect(t).toEqual({ sessionKey: 'main', harness: 'plug', nativeId: t.nativeId, cwd: join(w.dir, 'work'), command: 'fake-term', args: ['--new', t.nativeId], env: { TERM_HOME: '/t' }, unsetEnv: ['PARENT_MARKER'] });
    const [first] = w.rec.takeovers;
    expect(first!.args).toMatchObject({ sessionKey: 'main', instance: 'plug', nativeId: t.nativeId, resume: false, services: { dir: join(w.dir, 'tui'), cli: expect.stringMatching(/[/\\]cli\.js$/) } });
    // The session was opened on the terminal before the command line was asked for.
    expect(first!.terminal.sessions).toHaveLength(1);
    expect(first!.launches).toBe(1);
    expect(w.rec.headless.sessions).toHaveLength(0);

    // Connected, it holds the session: another attach is refused, /status says so, the session's turns are the terminal's.
    first!.connect();
    await expect(w.client.tuiAttach()).rejects.toMatchObject({ code: 'conflict' });
    const status = (r: string) => r.startsWith('session ');
    expect(await w.say('/status', status)).toContain('a terminal UI holds this session');
    expect(await w.say('how is the build?', (r) => r.endsWith('build?'))).toBe('terminal: how is the build?');
    expect(w.rec.headless.sessions).toHaveLength(0);

    // It leaves: the session goes on with the adapter, on the native session the terminal ran.
    first!.leave('the terminal UI exited');
    await new Promise((r) => setTimeout(r, 30));
    expect(await w.say('thanks', (r) => r.endsWith('thanks'))).toBe('headless: thanks');
    expect(w.rec.headless.sessions).toHaveLength(1);
    expect(w.rec.headless.sessions[0]!.args.resume).toBe(t.nativeId);
    expect(await w.say('/status', status)).not.toContain('a terminal UI holds this session');

    // The next attach releases that binding and resumes the same native session.
    const again = (await w.client.tuiAttach()) as TuiAttach;
    expect(again).toMatchObject({ nativeId: t.nativeId, args: ['--resume', t.nativeId] });
    expect(w.rec.takeovers[1]!.args).toMatchObject({ nativeId: t.nativeId, resume: true });
    expect(first!.ended).toEqual([]); // it left by itself; nobody ended it
  });

  it('one that never connected is replaced by a new attach; the daemon stopping ends the one that holds a session #LN-9', async () => {
    const w = await start();
    await w.client.tuiAttach();
    const [first] = w.rec.takeovers;
    await w.client.tuiAttach();
    expect(first!.ended).toEqual(['replaced by a new attach']);
    const second = w.rec.takeovers[1]!;
    expect(second.args.nativeId).toBe(first!.args.nativeId);
    second.connect();
    await w.gw.stop();
    expect(second.ended).toEqual(['daemon stopping']);
  });

  it('an open that fails on the terminal ends the takeover; the session goes on with the adapter #LN-9', async () => {
    const w = await start({ failOpen: true });
    await expect(w.client.tuiAttach()).rejects.toMatchObject({ code: 'internal', message: expect.stringContaining('the terminal broke') });
    expect(w.rec.takeovers[0]!.ended).toEqual(['attach failed']);
    expect(await w.say('hi', (r) => r.endsWith('hi'))).toBe('headless: hi');
  });

  it("a takeover whose end throws, or rejects, does not break the daemon's stop: the failure is logged, and the session's lane still closes and the socket goes #RS-8 #LN-9", async () => {
    for (const endFails of ['throw', 'reject']) {
      const w = await start({ endFails });
      await w.client.tuiAttach();
      const [t] = w.rec.takeovers;
      t!.connect();
      await w.gw.stop();
      expect(t!.ended, endFails).toEqual(['daemon stopping']);
      // What comes after the ends ran: the lane closed the session it had open on the terminal, the local server closed.
      expect(t!.closed, endFails).toEqual(['gateway stopping']);
      expect(existsSync(w.socketPath), endFails).toBe(false);
      expect(w.logs, endFails).toContain('harness plug: takeover end failed: end broke');
    }
  });

  it("a takeover whose end throws is logged, never thrown: a new attach replaces it all the same, and a failed open reports the open's error #LN-9", async () => {
    const w = await start({ endFails: 'throw' });
    await w.client.tuiAttach();
    const again = (await w.client.tuiAttach()) as TuiAttach;
    expect(again.nativeId).toBe(w.rec.takeovers[0]!.args.nativeId);
    expect(w.rec.takeovers[0]!.ended).toEqual(['replaced by a new attach']);
    expect(w.logs).toContain('harness plug: takeover end failed: end broke');

    const f = await start({ endFails: 'throw', failOpen: true });
    await expect(f.client.tuiAttach()).rejects.toMatchObject({ code: 'internal', message: expect.stringContaining('the terminal broke') });
    expect(f.rec.takeovers[0]!.ended).toEqual(['attach failed']);
    expect(f.logs).toContain('harness plug: takeover end failed: end broke');
  });
});

describe("Claude Code's terminal UI takes the session over", () => {
  it("a claude-code instance's adapter declares it: its TUI starts with the instance's executable as configured and its config dir, on a new Claude session, with the bridge run as `aio tui-bridge` #LN-9", async () => {
    const dir = tmp('aio-tkc-');
    mkdirSync(join(dir, 'work'), { recursive: true });
    // On the instance's PATH: the headless adapter runs it by its path, `aio tui` looks the name up on its own PATH.
    mkdirSync(join(dir, 'bin'));
    writeFileSync(join(dir, 'bin', 'claude-beta'), '#!/bin/sh\n', { mode: 0o755 });
    const raw = {
      dataDir: dir,
      cwd: join(dir, 'work'),
      policy: { owners: ['fake:alice'], ownerSessionKey: 'main' },
      local: { principal: 'fake:alice' },
      harnesses: { cc: { use: 'claude-code', executable: 'claude-beta', configDir: './claude-home', env: { PATH: join(dir, 'bin') } } },
      defaultHarness: 'cc',
    };
    const base = resolveConfig(raw, { env: {}, baseDir: dir, cwd: dir });
    const socketPath = join(dir, 'run', 'aio.sock');
    // The real adapter: nothing starts it (the session opens on its terminal's harness).
    const gw = await Gateway.start({ config: { ...base, socketPath }, log: new MemorySessionLog(), logger: () => {} });
    cleanups.push(() => gw.stop());
    const client = await LocalClient.connect(socketPath);
    cleanups.push(() => client.close());
    expect(gw.harness('cc').attach).toBe('takeover');
    const t = await client.tuiAttach();
    expect(t).toMatchObject({ sessionKey: 'main', harness: 'cc', command: 'claude-beta', env: { CLAUDE_CONFIG_DIR: join(dir, 'claude-home') }, cwd: join(dir, 'work') });
    expect(t.args.slice(0, 2)).toEqual(['--session-id', t.nativeId]);
    expect(t.args.slice(-2)).toEqual(['--model', 'haiku']); // the instance's default model, as the session's next turn would run
    expect(t.unsetEnv).toEqual(expect.arrayContaining(['CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_MESSAGING_TOKEN']));
    const settings = t.args[t.args.indexOf('--settings') + 1]!;
    expect(dirname(dirname(settings))).toBe(join(dir, 'tui'));
    const mcp = JSON.parse(readFileSync(t.args[t.args.indexOf('--mcp-config') + 1]!, 'utf8')) as { mcpServers: Record<string, { command: string; args: string[] }> };
    expect(mcp.mcpServers['agents-io-bridge']).toMatchObject({ command: process.execPath, args: [fileURLToPath(new URL('../src/cli.js', import.meta.url)), 'tui-bridge'] });
  });

  it("a claude-code instance that is unavailable for now (an `env:` reference is not set) still takes the session over when a preset set here names it: its TUI starts on a new Claude session without the headless adapter #LN-9", async () => {
    const dir = tmp('aio-tku-');
    mkdirSync(join(dir, 'work'), { recursive: true });
    const raw = {
      dataDir: dir,
      cwd: join(dir, 'work'),
      policy: { owners: ['fake:alice'], ownerSessionKey: 'main' },
      local: { principal: 'fake:alice' },
      harnesses: {
        plug: { use: 'module', module: './fixtures/harness-declares.mjs' },
        cc: { use: 'claude-code', env: { ANTHROPIC_API_KEY: 'env:AIO_TEST_UNSET_KEY' } },
      },
      presets: { claude: { harness: 'cc' } },
      defaultHarness: 'plug',
    };
    const base = resolveConfig(raw, { env: {}, baseDir: here, cwd: dir });
    expect(base.harnesses.cc!.unavailable).toContain('AIO_TEST_UNSET_KEY');
    const socketPath = join(dir, 'run', 'aio.sock');
    const chat = new FakeChannel('fake');
    const gw = await Gateway.start({ config: { ...base, socketPath }, log: new MemorySessionLog(), channels: [{ adapter: chat }], logger: () => {} });
    cleanups.push(() => gw.stop());
    const client = await LocalClient.connect(socketPath);
    cleanups.push(() => client.close());
    await chat.inject({ ...dm, sender: alice, text: '/preset claude' });
    await until(() => chat.sent.some((s) => (s.edits.at(-1)?.text ?? s.msg.text)?.startsWith('Preset claude from the next turn')));
    const t = await client.tuiAttach();
    expect(t).toMatchObject({ sessionKey: 'main', harness: 'cc', command: 'claude', cwd: join(dir, 'work') });
    expect(t.args.slice(0, 2)).toEqual(['--session-id', t.nativeId]);
    expect(t.args.slice(-2)).toEqual(['--model', 'haiku']);
    expect(t.unsetEnv).toEqual(expect.arrayContaining(['CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_MESSAGING_TOKEN']));
  });
});

describe("a module harness's attach and takeover", () => {
  /** Gateway.start with instance `plug` (fixtures/harness-declares.mjs) whose adapter has `members`. */
  async function declares(members: Record<string, unknown>) {
    const dir = tmp('aio-tkd-');
    mkdirSync(join(dir, 'work'), { recursive: true });
    const raw = { dataDir: dir, local: { principal: 'me' }, cwd: join(dir, 'work'), harnesses: { plug: { use: 'module', module: './fixtures/harness-declares.mjs', config: { members } } }, defaultHarness: 'plug' };
    const base = resolveConfig(raw, { env: {}, baseDir: here, cwd: dir });
    const gw = await Gateway.start({ config: { ...base, socketPath: join(dir, 'run', 'aio.sock') }, logger: () => {}, listen: false });
    cleanups.push(() => gw.stop());
    return gw;
  }

  it('of the wrong type fail the start, naming the instance and the member; right ones start and read as declared #CF-4', async () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ attach: 'remote' }, "attach ('join' or 'takeover' when present)"],
      [{ attach: true }, "attach ('join' or 'takeover' when present)"],
      [{ attach: 'takeover' }, "attach ('takeover' needs takeover)"],
      [{ takeover: { harness: {} } }, 'takeover (a function when present)'],
    ];
    for (const [members, what] of cases) {
      const start = declares(members);
      await expect(start, JSON.stringify(members)).rejects.toThrow(/^harnesses\.plug \(module .*harness-declares\.mjs\)/);
      await expect(start, JSON.stringify(members)).rejects.toThrow(`: the factory did not return a HarnessAdapter (bad ${what})`);
    }
    expect((await declares({ attach: 'join' })).harness('plug').attach).toBe('join');
    expect((await declares({})).harness('plug').attach).toBeUndefined();
  });
});
