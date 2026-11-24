import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ChannelCaps, ProgressView, ReplyRoute } from '@agents-io/protocol';
import { MemorySessionLog } from '@agents-io/session';
import { FakeChannel, FakeHarness, defaultChannelCaps } from '@agents-io/testkit';
import { resolveConfig } from '../src/config.js';
import { Gateway } from '../src/gateway.js';
import { cleanups, tmp, until } from './helpers.js';

/*
 * ChannelCaps.pacing (core-slimming G1): what the process preview carries (the Stop control, the
 * working state before answer text) is left out of the reply only where the adapter has a preview
 * (`previewProgress`). A JSONL bridge's peer may declare Lark's pacing, but no preview crosses it.
 */

const lark: ChannelCaps = { ...defaultChannelCaps, pacing: { openDelayMs: 30, previewDelayMs: 5, requireAnswerToOpen: true, interruptButton: false } };

class Previewing extends FakeChannel {
  readonly previews: boolean[] = [];
  async previewProgress(_route: ReplyRoute, _p: ProgressView, final: boolean): Promise<void> {
    this.previews.push(final);
  }
}

async function start(chat: FakeChannel) {
  const dir = tmp('aio-pacing-');
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  // A turn that runs a while without answer text, then answers.
  const harness = new FakeHarness(async (t) => {
    await held;
    t.emit({ t: 'text.snapshot', text: 'done', final: true }, { audience: 'answer' });
  });
  const config = { ...resolveConfig({ policy: { owners: ['fake:alice'] }, local: { principal: 'me' }, cwd: dir }, { env: {}, baseDir: dir, cwd: dir }), socketPath: join(dir, 'run', 'aio.sock') };
  const gw = await Gateway.start({ config, harness, log: new MemorySessionLog(), channels: [{ adapter: chat }], logger: () => {}, listen: false });
  cleanups.push(() => gw.stop());
  await chat.inject({ sender: { channelUserId: 'alice', evidence: 'platform_signed' }, conversation: { id: 'dm', kind: 'dm' }, text: 'work' });
  return { gw, release };
}

const stops = (chat: FakeChannel) => chat.sent.map((s) => (s.msg.actions ?? []).some((a) => a.label === 'Stop'));

describe('pacing that needs a preview', () => {
  it('a channel without previewProgress keeps the Stop control and opens its card while no answer text came, whatever pacing it declares', async () => {
    const chat = new FakeChannel('fake', lark);
    const w = await start(chat);
    // Opened after openDelayMs without answer text, with the Stop control.
    await until(() => chat.sent.length === 1);
    expect(stops(chat)).toEqual([true]);
    w.release();
  });

  it('one with previewProgress gets the pacing it declares: no Stop control on the card, which waits for answer text', async () => {
    const chat = new Previewing('fake', lark);
    const w = await start(chat);
    await until(() => chat.previews.length > 0);
    await new Promise((r) => setTimeout(r, 100));
    expect(chat.sent).toHaveLength(0);
    w.release();
    await until(() => chat.sent.length === 1);
    expect(stops(chat)).toEqual([false]);
  });
});
