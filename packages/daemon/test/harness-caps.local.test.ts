import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { HarnessAdapter, SessionEvent } from '@agents-io/protocol';
import { ClaudeCodeHarness } from '@agents-io/harness-claude-code';
import { CodexHarness } from '@agents-io/harness-codex';
import { FakeChannel, type FakeHarness } from '@agents-io/testkit';
import { LocalClient } from '../src/client.js';
import { resolveConfig } from '../src/config.js';
import { Gateway } from '../src/gateway.js';
import { readTokenFile, tokenPath } from '../src/token.js';
import { CLAUDE_CODE_DECLARES, CODEX_DECLARES } from './declares.js';
import { cleanups, tmp, until } from './helpers.js';

/*
 * Compaction, Plan mode and the owner's profile switch are what a harness adapter declares
 * (HarnessAdapter compact / modes / ownerProfileSwitch, named by displayName); chat commands,
 * `/status` and `session.compact` read them, never the instance's kind. A `use: "module"`
 * harness declaring them gets them (fixtures/harness-caps.mjs); one declaring none is answered
 * as a built-in without them.
 */

const here = dirname(fileURLToPath(import.meta.url));
const alice = { channelUserId: 'alice', evidence: 'platform_signed' as const };
const dm = { conversation: { id: 'c-alice', kind: 'dm' as const } };
type Rec = { fake: FakeHarness; turns: { text: string; native: boolean }[][] };
const rec = (key: string): Rec => (globalThis as { __caps?: Record<string, Rec> }).__caps![key]!;
let keys = 0;

const caps = (config: Record<string, unknown>) => ({ use: 'module', module: './fixtures/harness-caps.mjs', config });

/** A daemon whose instances are the caps module with each config (name → config); the first is the default. */
async function start(harnesses: Record<string, Record<string, unknown>>, agents?: Record<string, unknown>) {
  const dir = tmp();
  mkdirSync(join(dir, 'work'), { recursive: true });
  const raw = {
    dataDir: dir,
    policy: { owners: ['fake:alice'] },
    local: { principal: 'fake:alice' },
    cwd: join(dir, 'work'),
    harnesses: Object.fromEntries(Object.entries(harnesses).map(([name, c]) => [name, caps(c)])),
    ...(agents ? { agents } : {}),
  };
  const base = resolveConfig(raw, { env: {}, baseDir: here, cwd: dir });
  const socketPath = join(dir, 'run', 'aio.sock');
  const chat = new FakeChannel('fake');
  const gw = await Gateway.start({ config: { ...base, socketPath }, channels: [{ adapter: chat }], logger: () => {} });
  cleanups.push(() => gw.stop());
  const host = async () => {
    const c = await LocalClient.connect(socketPath);
    cleanups.push(() => c.close());
    await c.hello({ token: readTokenFile(tokenPath(socketPath)), name: 'test' });
    return c;
  };
  const replies = () => chat.sent.map((s) => s.edits.at(-1)?.text ?? s.msg.text);
  /** Alice says `text`; the reply to it that `match` finds. */
  const say = async (text: string, match: (reply: string) => boolean = () => true) => {
    const before = replies().length;
    await chat.inject({ ...dm, sender: alice, text });
    return until(() => replies().slice(before).find((r) => r !== undefined && match(r)));
  };
  const turnStarts = () =>
    gw.sessions().flatMap((s) => gw.hub.log.read(s.sessionKey, 0).filter((e: SessionEvent) => e.body.t === 'turn.started').map((e) => ({ key: s.sessionKey, body: e.body as Extract<SessionEvent['body'], { t: 'turn.started' }> })));
  return { gw, chat, host, replies, say, turnStarts };
}

describe('harness capabilities', () => {
  it('the built-in adapters declare what the test fakes standing in for them declare, without starting anything', () => {
    const declared = (a: HarnessAdapter) => ({ displayName: a.displayName, compact: a.compact, modes: a.modes, ownerProfileSwitch: a.ownerProfileSwitch, ephemeralOpen: a.ephemeralOpen });
    const blank = { displayName: undefined, compact: undefined, modes: undefined, ownerProfileSwitch: undefined, ephemeralOpen: undefined };
    expect(declared(new CodexHarness({ bin: '/nonexistent', transport: { kind: 'stdio' } }))).toEqual({ ...blank, ...CODEX_DECLARES });
    expect(declared(new ClaudeCodeHarness({ claudePath: '/nonexistent' }))).toEqual({ ...blank, ...CLAUDE_CODE_DECLARES });
  });

  it('a module harness declaring them: /plan and /bypass apply to the next turns, /status shows Plan mode, /compact and session.compact send its own command as a turn of its own, topic titles open an ephemeral session', async () => {
    const key = `c${++keys}`;
    const w = await start({ plug: { key, displayName: 'Plug', compact: '/squash', modes: ['plan'], ownerProfileSwitch: true, ephemeralOpen: true } }, { helper: { harness: 'plug' } });
    await w.say('hi', (r) => r.includes('echo: hi'));
    // The first completed turn titles the topic in an ephemeral session of the same harness.
    const title = await until(() => rec(key).fake.sessions.find((s) => s.args.sessionKey.startsWith('topic-title:')));
    expect(title.args.options).toMatchObject({ ephemeral: true, preface: false });

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

  it('a module harness declaring none: /plan and /bypass name the configured harnesses that have them (display name, else instance name), /compact and session.compact are unsupported, /status says Plan mode unavailable, no topic title', async () => {
    const [bare, plug, nameless] = [`c${++keys}`, `c${++keys}`, `c${++keys}`];
    const w = await start(
      { bare: { key: bare }, plug: { key: plug, displayName: 'Plug', modes: ['plan'], ownerProfileSwitch: true }, nameless: { key: nameless, modes: ['plan'] } },
      { helper: { harness: 'bare' } },
    );
    await w.say('hi', (r) => r.includes('echo: hi'));
    expect(await w.say('/plan on')).toBe('/plan is available only on Plug or nameless (this session runs module).');
    expect(await w.say('/bypass on')).toBe('/bypass is available only on Plug (this session runs module).');
    expect(await w.say('/compact')).toBe('/compact is not available on module yet.');
    expect(await w.say('/status', (r) => r.startsWith('session '))).toContain('Plan mode unavailable · bypass default (agent policy)');
    const sessionKey = w.turnStarts()[0]!.key;
    const h = await w.host();
    await expect(h.sessionCompact({ sessionKey })).rejects.toMatchObject({ code: 'unsupported', message: 'unsupported: bare (module) has no compaction command' });
    // Nothing reached the harness but the one turn: no command turn, no title session.
    expect(rec(bare).turns).toEqual([[{ text: 'hi', native: false }]]);
    expect(rec(bare).fake.sessions.map((s) => s.args.sessionKey)).toEqual([sessionKey]);
  });

  it('no configured harness has Plan mode or the profile switch: /plan and /bypass say so', async () => {
    const w = await start({ bare: { key: `c${++keys}` } });
    expect(await w.say('/plan')).toBe('/plan is not available on any harness configured here (this session runs module).');
    expect(await w.say('/bypass')).toBe('/bypass is not available on any harness configured here (this session runs module).');
  });
});
