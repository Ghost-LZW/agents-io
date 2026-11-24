import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SessionEvent } from '@agents-io/protocol';
import { MemorySessionLog } from '@agents-io/session';
import { FakeChannel, FakeHarness } from '@agents-io/testkit';
import { builtinModules } from '../src/bundle.js';
import { COMMAND_HELP } from '../src/commands.js';
import { resolveConfig, type HarnessInstance } from '../src/config.js';
import { Gateway, InstanceHarness } from '../src/gateway.js';
import { ModuleRegistry } from '../src/modules.js';
import { CLAUDE_CODE_DECLARES, CODEX_DECLARES } from './declares.js';
import { cleanups, until } from './gateway-helpers.js';

/*
 * The run-config chat commands (/agent, /preset, /model, /effort, /plan, /bypass, /compact) and
 * their /status line (CT-2) are the owner-commands module's (core-slimming G6 step 5); what they
 * set, and applying it to the next turns, stays the kernel's.
 */

const alice = { channelUserId: 'alice', evidence: 'platform_signed' as const };
const dm = { conversation: { id: 'c-alice', kind: 'dm' as const } };

const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'aio-owner-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

/**
 * A deployment over `raw` (owner fake:alice on a FakeChannel), each instance a FakeHarness declaring
 * what its kind's adapter declares; on `dir`'s SQLite log when given (it survives a restart).
 */
async function deployment(raw: Record<string, unknown>, o: { dir?: string; moduleRegistry?: ModuleRegistry } = {}) {
  const dir = o.dir ?? tmp();
  const registry = o.moduleRegistry ? { moduleRegistry: o.moduleRegistry } : {};
  const base = resolveConfig({ policy: { owners: ['fake:alice'] }, local: { principal: 'fake:alice' }, ...(o.dir ? { dataDir: dir } : {}), ...raw }, { env: {}, baseDir: dir, cwd: dir, ...registry });
  const config = { ...base, socketPath: join(dir, 'run', 'aio.sock') };
  const fakes: Record<string, FakeHarness> = {};
  const chat = new FakeChannel('fake');
  const buildHarness = (i: HarnessInstance) => new InstanceHarness(i, (fakes[i.name] ??= Object.assign(new FakeHarness(), i.kind === 'codex' ? CODEX_DECLARES : CLAUDE_CODE_DECLARES)));
  const gw = await Gateway.start({ config, buildHarness, ...(o.dir ? {} : { log: new MemorySessionLog() }), channels: [{ adapter: chat }], ...registry, logger: () => {} });
  let stopped = false;
  const stop = async () => {
    if (!stopped) await gw.stop();
    stopped = true;
  };
  cleanups.push(stop);
  const text = (i: number) => {
    const s = chat.sent[i]!;
    return (s.edits.at(-1)?.text ?? s.msg.text ?? '').split(dir).join('<dir>').replace(/\btp_[0-9a-f]+\b/g, 'tp_<id>');
  };
  const transcript: string[] = [];
  /** The owner says `said`; the first new message (or the first that `reply` picks) is its answer, kept in the transcript. */
  const say = async (said: string, reply: (t: string) => boolean = () => true) => {
    const before = chat.sent.length;
    await chat.inject({ ...dm, sender: alice, text: said });
    const i = await until(() => {
      for (let j = before; j < chat.sent.length; j++) if (reply(text(j))) return j + 1;
      return undefined;
    });
    transcript.push(`> ${said}`, text(i - 1));
    return text(i - 1);
  };
  /** A turn: the owner says `said` and the echo is final. */
  const turn = async (said: string) => {
    await chat.inject({ ...dm, sender: alice, text: said });
    await until(() => chat.sent.some((s) => s.finalized && (s.edits.at(-1)?.text ?? s.msg.text) === `echo: ${said}`));
  };
  /** The models the session's turns ran with, in order. */
  const models = () =>
    gw.sessions().flatMap((x) => gw.hub.log.read(x.sessionKey, 0).flatMap((e: SessionEvent) => (e.body.t === 'turn.started' ? [e.body.run?.model] : [])));
  return { gw, chat, fakes, say, turn, transcript, models, stop };
}

describe('run-config chat commands', () => {
  it('with the bundled modules, /help, /status and every reply of /agent, /preset, /model, /effort, /plan, /bypass and /compact are as they were before they were a module, byte for byte #CT-2', async () => {
    // Captured from the gateway before the commands moved into the owner-commands module.
    const out: Record<string, string[]> = {};
    {
      // Codex and Claude Code configured, presets, two agents.
      const w = await deployment({
        harnesses: { cx: { use: 'codex' }, cc: { use: 'claude-code', run: { model: 'sonnet' } } },
        presets: { fast: { harness: 'cx', model: 'gpt-x', effort: 'low' }, claude: { harness: 'cc', model: 'opus', effort: 'high', description: 'Claude on the gateway' } },
        agents: { helper: { preset: 'fast' }, coder: { harness: 'cc', model: 'sonnet' } },
        defaultAgent: 'helper',
        // Not the generated topic titles (a turn on Codex starts one): /status names the topic.
        topicTitles: { enabled: false },
      });
      await w.say('/help');
      await w.say('/status');
      await w.turn('hi');
      for (const c of ['/status', '/agent', '/agent nobody', '/preset', '/preset nope', '/model', '/effort', '/model gpt-y', '/effort high', '/model', '/effort', '/status'])
        await w.say(c);
      for (const c of ['/plan', '/plan on', '/plan maybe', '/plan', '/plan off', '/bypass', '/bypass on', '/bypass maybe', '/bypass', '/bypass default', '/bypass off', '/status', '/compact'])
        await w.say(c);
      for (const c of ['/preset claude', '/preset', '/status', '/plan on', '/bypass on']) await w.say(c);
      await w.say('/compact', (t) => !t.startsWith('echo: '));
      await until(() => w.fakes.cc?.sessions.length === 1 && w.chat.sent.some((s) => s.finalized && (s.edits.at(-1)?.text ?? s.msg.text) === 'echo: /compact'));
      for (const c of ['/preset default', '/model default', '/effort default', '/plan on', '/status', '/agent coder', '/status', '/agent', '/agent helper', '/status']) await w.say(c);
      out.configured = w.transcript;
    }
    {
      // The default deployment: only Claude Code, no presets.
      const w = await deployment({ agents: { helper: { harness: 'claude-code' }, coder: { harness: 'claude-code', model: 'sonnet' } }, defaultAgent: 'helper' });
      for (const c of ['/help', '/preset', '/preset fast', '/plan on', '/bypass off', '/model', '/effort', '/agent', '/status']) await w.say(c);
      await w.say('/compact', (t) => !t.startsWith('echo: '));
      await until(() => w.chat.sent.some((s) => s.finalized && (s.edits.at(-1)?.text ?? s.msg.text) === 'echo: /compact'));
      await w.say('/status');
      out.default = w.transcript;
    }
    {
      // A fixed owner session.
      const w = await deployment({ agents: { helper: { harness: 'claude-code' }, coder: { harness: 'claude-code', model: 'sonnet' } }, defaultAgent: 'helper', policy: { owners: ['fake:alice'], ownerSessionKey: 'main' } });
      for (const c of ['/agent', '/agent coder', '/new @coder x', '/status']) await w.say(c);
      out.fixed = w.transcript;
    }
    {
      // No agents configured.
      const w = await deployment({});
      for (const c of ['/agent', '/agent someone', '/agent default', '/status']) await w.say(c);
      out.bare = w.transcript;
    }
    expect(out).toEqual(JSON.parse(readFileSync(new URL('./fixtures/owner-commands.json', import.meta.url), 'utf8')));
  });

  it('off (ownerCommands: { enabled: false }, or a build without the module), the seven are ordinary messages: each is a turn of the session; /help is the kernel\'s lines and /status has no Plan line; what was set for the session while it was on still holds, the kernel keeps and applies it #CT-2', async () => {
    const dir = tmp();
    const raw = { agents: { helper: { harness: 'claude-code' }, coder: { harness: 'claude-code', model: 'sonnet' } }, defaultAgent: 'helper' };
    const on = await deployment(raw, { dir });
    await on.turn('hi');
    expect(await on.say('/model opus')).toBe('model opus from the next turn.');
    await on.stop();

    const off = await deployment({ ...raw, ownerCommands: { enabled: false } }, { dir });
    expect(off.gw.adminStatus().modules!.find((m) => m.id === 'owner-commands')).toEqual({ id: 'owner-commands', origin: 'builtin', enabled: false });
    expect(await off.say('/help')).toBe(COMMAND_HELP);
    const said = ['/agent coder', '/preset', '/model sonnet', '/effort high', '/plan on', '/bypass on', '/compact'];
    for (const text of said) await off.turn(text);
    // Each went to the harness as a message, and every turn ran with what /model set before the restart.
    expect(off.fakes['claude-code']!.sessions.map((x) => x.args.sessionKey)).toHaveLength(1);
    expect(off.models()).toEqual(['haiku', ...said.map(() => 'opus')]);
    const status = (await off.say('/status')).split('\n');
    expect(status[1]).toBe('agent helper · claude-code (claude-code) · model opus (set here)');
    expect(status[2]).toBe('cwd <dir>');
    expect(status.join('\n')).not.toContain('Plan mode');

    // A registry without the module: the same.
    const without = new ModuleRegistry(
      builtinModules.modules.filter((m) => m.manifest.id !== 'owner-commands'),
      { fields: Object.fromEntries(builtinModules.fields) },
    );
    const bare = await deployment(raw, { moduleRegistry: without });
    expect(await bare.say('/help')).toBe(COMMAND_HELP);
    await bare.turn('/model opus');
    expect(bare.models()).toEqual(['haiku']);
    const lines = (await bare.say('/status')).split('\n');
    expect(lines[1]).toBe('agent helper · claude-code (claude-code) · model haiku');
    expect(lines[2]).toBe('cwd <dir>');
  });
});
