import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { HarnessOpenArgs, HarnessSession, InputRecord, NativeClient } from '@agents-io/protocol';
import { MemorySessionLog } from '@agents-io/session';
import { FakeChannel, FakeHarness, fakeHarnessCaps } from '@agents-io/testkit';
import { CommandError, LocalClient } from '../src/client.js';
import { resolveConfig } from '../src/config.js';
import { Gateway } from '../src/gateway.js';
import { cleanups, until } from './gateway-helpers.js';

/*
 * `tui.attach` (decision 15): the harness's own terminal UI joins a session the daemon keeps.
 * A harness that can host one (Codex over unix) says how; the daemon opens the session first.
 */

/** A fake harness whose sessions a terminal client can join, and that takes context without a turn. */
class AttachableHarness extends FakeHarness {
  readonly injected: InputRecord[][] = [];

  override async probe() {
    return { version: '0.0.0', caps: { ...fakeHarnessCaps, injectWithoutTurn: true } };
  }

  override async open(args: HarnessOpenArgs): Promise<HarnessSession> {
    const s = await super.open(args);
    return Object.assign(s, { inject: async (inputs: InputRecord[]) => void this.injected.push(inputs) });
  }

  nativeClient(nativeId: string): NativeClient {
    return { command: 'fake-tui', args: ['--remote', 'unix:///x.sock', 'resume', nativeId], env: { FAKE_HOME: '/h' } };
  }
}

async function setup(harness: FakeHarness) {
  const dir = mkdtempSync(join(tmpdir(), 'aio-tui-'));
  // A Codex instance (the fake harness stands in for it): its TUI joins, it does not take over.
  const base = resolveConfig(
    { harnesses: { codex: { use: 'codex', transport: { kind: 'unix', spawn: 'none', path: join(dir, 'x.sock') } } }, policy: { owners: ['fake:alice'], ownerSessionKey: 'main' }, local: { principal: 'fake:alice' } },
    { env: {}, baseDir: dir, cwd: dir },
  );
  const config = { ...base, socketPath: join(dir, 'run', 'aio.sock') };
  const chat = new FakeChannel('fake');
  const gw = await Gateway.start({ config, harness, log: new MemorySessionLog(), channels: [{ adapter: chat }], logger: () => {} });
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  cleanups.push(() => gw.stop());
  const client = await LocalClient.connect(config.socketPath);
  cleanups.push(() => client.close());
  return { gw, chat, client, dir };
}

describe('tui.attach', () => {
  it('opens the session and answers how to start the TUI on its native session; a new session gets a context note first #LN-8', async () => {
    const h = new AttachableHarness();
    const w = await setup(h);
    const t = await w.client.tuiAttach();
    expect(t).toMatchObject({ sessionKey: 'main', nativeId: 'native-main', command: 'fake-tui', args: ['--remote', 'unix:///x.sock', 'resume', 'native-main'], env: { FAKE_HOME: '/h' }, cwd: w.dir });
    expect(h.sessions).toHaveLength(1);
    expect(h.injected).toHaveLength(1); // so a new Codex thread has a rollout to resume

    // A session that already ran a turn is not noted again.
    await w.chat.inject({ conversation: { id: 'c-alice', kind: 'dm' }, sender: { channelUserId: 'alice', evidence: 'platform_signed' }, text: 'hi' });
    await until(() => w.chat.sent.find((s) => s.finalized));
    await w.client.tuiAttach('main');
    expect(h.injected).toHaveLength(1);
    expect(h.sessions).toHaveLength(1); // same binding: the TUI joins it, the daemon keeps driving it
  });

  it('a harness without a terminal client that can join is refused #LN-8', async () => {
    const w = await setup(new FakeHarness());
    await expect(w.client.tuiAttach()).rejects.toMatchObject({ code: 'unsupported' } satisfies Partial<CommandError>);
  });
});
