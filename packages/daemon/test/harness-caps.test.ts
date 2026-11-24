import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { HarnessAdapter } from '@agents-io/protocol';
import { ClaudeCodeHarness, claudeCodeHarnessModule } from '@agents-io/harness-claude-code';
import { CodexHarness, codexHarnessModule } from '@agents-io/harness-codex';
import { FakeChannel } from '@agents-io/testkit';
import { builtinHarnesses } from '../src/bundle.js';
import { HarnessRegistry } from '@agents-io/kernel';
import { Gateway, resolveConfig } from '../src/defaults.js';
import { CLAUDE_CODE_DECLARES, CODEX_DECLARES } from './declares.js';
import { nextKey, rec, start } from './harness-caps-helpers.js';
import { cleanups, tmp, until } from './helpers.js';

/*
 * Compaction, Plan mode and the owner's profile switch are what a harness adapter declares
 * (HarnessAdapter compact / modes / ownerProfileSwitch, named by displayName); chat commands
 * (CT-2), `/status` and `session.compact` (CT-3) read them, never the instance's kind. A
 * `use: "module"` harness declaring them gets them (fixtures/harness-caps.mjs); one declaring
 * none is answered as a built-in without them. The tests that stand a FakeHarness in for a
 * built-in adapter (commands.test.ts, compact.test.ts) rest on the first test here.
 */

describe('harness capabilities', () => {
  it('the built-in adapters declare what the test fakes standing in for them declare, without starting anything #CT-2 #CT-3', () => {
    const declared = (a: HarnessAdapter) => ({ displayName: a.displayName, compact: a.compact, modes: a.modes, ownerProfileSwitch: a.ownerProfileSwitch, ephemeralOpen: a.ephemeralOpen });
    const blank = { displayName: undefined, compact: undefined, modes: undefined, ownerProfileSwitch: undefined, ephemeralOpen: undefined };
    expect(declared(new CodexHarness({ bin: '/nonexistent', transport: { kind: 'stdio' } }))).toEqual({ ...blank, ...CODEX_DECLARES });
    expect(declared(new ClaudeCodeHarness({ claudePath: '/nonexistent' }))).toEqual({ ...blank, ...CLAUDE_CODE_DECLARES });
  });

  it('each built-in kind declares without an adapter what its adapters declare (the names /plan and /bypass give when no configured instance has them) #CT-2', () => {
    expect(builtinHarnesses.kinds).toEqual(['claude-code', 'codex', 'bridge', 'acp']);
    const adapters: Record<string, HarnessAdapter> = { 'claude-code': new ClaudeCodeHarness({ claudePath: '/nonexistent' }), codex: new CodexHarness({ bin: '/nonexistent', transport: { kind: 'stdio' } }) };
    for (const m of builtinHarnesses.modules) {
      for (const [k, v] of Object.entries(m.declares ?? {})) expect((adapters[m.kind] as unknown as Record<string, unknown>)[k], `${m.kind} ${k}`).toEqual(v);
    }
    expect(claudeCodeHarnessModule.declares).toMatchObject(CLAUDE_CODE_DECLARES);
    expect(codexHarnessModule.declares).toMatchObject(CODEX_DECLARES);
  });

  it('a module harness declaring them: /plan and /bypass apply to the next turns, /status shows Plan mode, /compact and session.compact send its own command as a turn of its own #CT-2 #CT-3', async () => {
    const key = nextKey();
    const w = await start({ plug: { key, displayName: 'Plug', compact: '/squash', modes: ['plan'], ownerProfileSwitch: true } }, () => ({ helper: { harness: 'plug' } }));
    await w.say('hi', (r) => r.includes('echo: hi'));

    expect(await w.say('/plan on')).toBe('Plan mode on from the next turn.');
    expect(await w.say('/bypass off')).toBe('Bypass off for owner turns from the next turn.');
    expect(await w.say('/status', (r) => r.startsWith('session '))).toContain('Plan mode on · bypass restricted');
    await w.say('second', (r) => r.includes('echo: second'));
    const [first, second] = w.turnStarts();
    expect(first!.body.run).not.toHaveProperty('mode');
    expect(second!.body.run).toMatchObject({ harness: 'plug', mode: 'plan', profile: 'restricted' });

    // Its own command, as a turn of its own (the lane's native-command path), once on the chat and once from the host.
    const commands = () => rec(key).turns.filter((t) => t.some((i) => i.native));
    expect(await w.say('/compact', (r) => r.startsWith('Compacting'))).toBe('Compacting (queued behind anything running).');
    await until(() => commands().length === 1 && !w.gw.hub.snapshot(second!.key).turn);
    expect(commands()).toEqual([[{ text: '/squash', native: true }]]);
    const h = await w.host();
    expect(await h.sessionCompact({ sessionKey: second!.key, inputId: 'cmp-1' })).toMatchObject({ sessionKey: second!.key, inputId: 'cmp-1', duplicate: false });
    await until(() => commands().length === 2);
    expect(commands()[1]).toEqual([{ text: '/squash', native: true }]);
  });

  it('a module harness declaring none: /plan and /bypass name the configured harnesses that have them (display name, else instance name), /compact and session.compact are unsupported, /status says Plan mode unavailable; nothing but the one turn reaches the harness #CT-2 #CT-3', async () => {
    const [bare, plug, nameless] = [nextKey(), nextKey(), nextKey()];
    const w = await start(
      { bare: { key: bare }, plug: { key: plug, displayName: 'Plug', modes: ['plan'], ownerProfileSwitch: true }, nameless: { key: nameless, modes: ['plan'] } },
      () => ({ helper: { harness: 'bare' } }),
    );
    await w.say('hi', (r) => r.includes('echo: hi'));
    expect(await w.say('/plan on')).toBe('/plan is available only on Plug or nameless (this session runs module).');
    expect(await w.say('/bypass on')).toBe('/bypass is available only on Plug (this session runs module).');
    expect(await w.say('/compact')).toBe('/compact is not available on module yet.');
    expect(await w.say('/status', (r) => r.startsWith('session '))).toContain('Plan mode unavailable · bypass default (agent policy)');
    const sessionKey = w.turnStarts()[0]!.key;
    const h = await w.host();
    await expect(h.sessionCompact({ sessionKey })).rejects.toMatchObject({ code: 'unsupported', message: 'unsupported: bare (module) has no compaction command' });
    // Nothing reached the harness but the one turn: no command turn, no other session (no topic title either).
    expect(rec(bare).turns).toEqual([[{ text: 'hi', native: false }]]);
    expect(rec(bare).fake.sessions.map((s) => s.args.sessionKey)).toEqual([sessionKey]);
  });

  it('an instance unavailable for now (an env: reference not set) answers as its adapter will once it is available: on Codex /plan, /bypass and the Plan line of /status as before; on Claude Code /compact is queued #CT-2 #CT-3', async () => {
    // The real adapters, built from the config as a deployment's are (none is started: no turn runs on the unavailable ones).
    const dir = tmp();
    mkdirSync(join(dir, 'work'), { recursive: true });
    const raw = {
      dataDir: dir,
      policy: { owners: ['fake:alice'] },
      local: { principal: 'fake:alice' },
      cwd: join(dir, 'work'),
      harnesses: {
        cc: { use: 'claude-code', executable: '/nonexistent/claude' },
        cx: { use: 'codex', executable: '/nonexistent/codex', env: { OPENAI_API_KEY: 'env:AIO_TEST_NOT_SET_CX' } },
        cu: { use: 'claude-code', executable: '/nonexistent/claude', env: { ANTHROPIC_API_KEY: 'env:AIO_TEST_NOT_SET_CU' } },
      },
      defaultHarness: 'cc',
      presets: { fast: { harness: 'cx' }, other: { harness: 'cu' } },
      topicTitles: { enabled: false },
    };
    const config = { ...resolveConfig(raw, { env: {}, baseDir: dir, cwd: dir }), socketPath: join(dir, 'run', 'aio.sock') };
    expect([config.harnesses.cx!.unavailable, config.harnesses.cu!.unavailable]).toEqual([expect.stringContaining('AIO_TEST_NOT_SET_CX'), expect.stringContaining('AIO_TEST_NOT_SET_CU')]);
    const chat = new FakeChannel('fake');
    const gw = await Gateway.start({ config, channels: [{ adapter: chat }], logger: () => {} });
    cleanups.push(() => gw.stop());
    const replies = () => chat.sent.map((s) => s.edits.at(-1)?.text ?? s.msg.text);
    const say = async (text: string) => {
      const before = replies().length;
      await chat.inject({ conversation: { id: 'c-alice', kind: 'dm' }, sender: { channelUserId: 'alice', evidence: 'platform_signed' }, text });
      return until(() => replies().slice(before).find((r) => r !== undefined));
    };
    expect(await say('/preset fast')).toMatch(/^Preset fast from the next turn: cx \(codex\)/);
    expect((await say('/status')).split('\n')[2]).toBe('Plan mode off · bypass default (agent policy)');
    expect(await say('/plan')).toBe('Plan mode off for this session.');
    expect(await say('/plan on')).toBe('Plan mode on from the next turn.');
    expect(await say('/bypass on')).toBe('Bypass on for owner turns from the next turn.');
    expect(await say('/compact')).toBe('/compact is not available on codex yet.');
    expect(await say('/preset other')).toMatch(/^Preset other from the next turn: cu \(claude-code\)/);
    expect(await say('/plan on')).toBe('/plan is available only on Codex (this session runs claude-code).');
    // Past the check: the command is queued as a turn of its own, which fails to start (the instance is unavailable).
    const before = replies().length;
    await chat.inject({ conversation: { id: 'c-alice', kind: 'dm' }, sender: { channelUserId: 'alice', evidence: 'platform_signed' }, text: '/compact' });
    await until(() => replies().length === before + 2);
    expect(replies().slice(before).sort()).toEqual(['Compacting (queued behind anything running).', 'This message was not processed: the agent could not start. Try again later, or ask the operator.']);
  });

  it('no configured harness and no registered kind has Plan mode or the profile switch: /plan and /bypass say so #CT-2', async () => {
    // A deployment whose bundle registers only Claude Code: no kind declares them either.
    const w = await start({ bare: { key: nextKey() } }, undefined, { harnessRegistry: new HarnessRegistry([claudeCodeHarnessModule]) });
    expect(await w.say('/plan')).toBe('/plan is not available on any harness configured here (this session runs module).');
    expect(await w.say('/bypass')).toBe('/bypass is not available on any harness configured here (this session runs module).');
  });
});
