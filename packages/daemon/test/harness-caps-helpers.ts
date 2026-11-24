import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SessionEvent } from '@agents-io/protocol';
import { FakeChannel, type FakeHarness } from '@agents-io/testkit';
import { type HarnessRegistry, LocalClient, readTokenFile, tokenPath } from '@agents-io/kernel';
import { Gateway, resolveConfig } from '../src/defaults.js';
import { cleanups, tmp, until } from './helpers.js';

// Shared by harness-caps.test.ts (core) and harness-caps.local.test.ts: a daemon whose instances are fixtures/harness-caps.mjs.

const here = dirname(fileURLToPath(import.meta.url));
const alice = { channelUserId: 'alice', evidence: 'platform_signed' as const };
const dm = { conversation: { id: 'c-alice', kind: 'dm' as const } };
type Rec = { fake: FakeHarness; turns: { text: string; native: boolean }[][] };
let keys = 0;

/** A fresh key for one instance's record (`config.key`). */
export const nextKey = (): string => `c${++keys}`;

/** What the caps module instance with `config.key = key` saw: its FakeHarness and every turn's inputs. */
export const rec = (key: string): Rec => (globalThis as { __caps?: Record<string, Rec> }).__caps![key]!;

const caps = (config: Record<string, unknown>) => ({ use: 'module', module: './fixtures/harness-caps.mjs', config });

/**
 * A daemon whose instances are the caps module with each config (name → config); the first is the
 * default. `agents` may name `<dataDir>/helper.md` (it holds "Be helpful.") as an instructions file.
 * `harnessRegistry`: the harness kinds the deployment registers (default the built-in ones).
 */
export async function start(harnesses: Record<string, Record<string, unknown>>, agents?: (dir: string) => Record<string, unknown>, o: { harnessRegistry?: HarnessRegistry } = {}) {
  const dir = tmp();
  mkdirSync(join(dir, 'work'), { recursive: true });
  writeFileSync(join(dir, 'helper.md'), 'Be helpful.');
  const raw = {
    dataDir: dir,
    policy: { owners: ['fake:alice'] },
    local: { principal: 'fake:alice' },
    cwd: join(dir, 'work'),
    harnesses: Object.fromEntries(Object.entries(harnesses).map(([name, c]) => [name, caps(c)])),
    ...(agents ? { agents: agents(dir) } : {}),
  };
  const base = resolveConfig(raw, { env: {}, baseDir: here, cwd: dir, ...o });
  const socketPath = join(dir, 'run', 'aio.sock');
  const chat = new FakeChannel('fake');
  const gw = await Gateway.start({ config: { ...base, socketPath }, channels: [{ adapter: chat }], logger: () => {}, ...o });
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
