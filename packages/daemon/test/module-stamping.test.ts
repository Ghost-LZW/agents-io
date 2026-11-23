import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { InputRecord, KernelContext, ModuleManifest, Origin, SessionEvent } from '@agents-io/protocol';
import { MemorySessionLog } from '@agents-io/session';
import { FakeChannel, FakeHarness } from '@agents-io/testkit';
import { resolveConfig } from '../src/config.js';
import { Gateway } from '../src/gateway.js';
import { HarnessRegistry } from '../src/harness-registry.js';
import { ChannelRegistry } from '../src/channel-registry.js';
import { ModuleRegistry } from '../src/modules.js';
import { cleanups, tmp, until } from './helpers.js';

/*
 * What a feature module gives a lane (`KernelContext.lanes.input`, `lanes.command`) the kernel
 * takes only as a peer's (an agent outside this daemon): never a person's, a host's or the
 * kernel's origin, never one carrying the owner label or naming an owner. The default policy
 * would run an owner's turn with `bypass` (ID-10: what comes from outside is never a person).
 */

const owner = { id: 'fake:alice', labels: ['owner'] };
const asOwner: Origin = { kind: 'human', principal: owner, evidence: 'platform_signed', via: 'fake:default', adapter: 'fake' };
const peer = (principal: { id: string; labels: string[] }): Origin => ({ kind: 'peer', principal, evidence: 'device_only', via: 'module:probe', adapter: 'probe' });
const input = (inputId: string, origin: Origin, channelContext: InputRecord['channelContext'] = {}): InputRecord => ({ inputId, origin, content: [{ type: 'text', text: 'hi' }], replyRoute: null, channelContext });

/** A kernel with one feature module (`probe`, no needs) whose KernelContext the test drives. */
async function start() {
  const dir = tmp('aio-stamp-');
  let k!: KernelContext;
  const probe: ModuleManifest<undefined> = { id: 'probe', kind: 'feature', setup: (ctx) => ((k = ctx), {}) };
  const registries = { harnessRegistry: new HarnessRegistry([]), channelRegistry: new ChannelRegistry([]), moduleRegistry: new ModuleRegistry([probe]) };
  const raw = { policy: { owners: ['fake:alice'] }, local: { principal: 'me' }, cwd: dir };
  const config = { ...resolveConfig(raw, { env: {}, baseDir: dir, cwd: dir, ...registries }), socketPath: join(dir, 'run', 'aio.sock') };
  const given: InputRecord[] = [];
  const harness = new FakeHarness(async (t) => {
    given.push(...t.inputs);
    t.emit({ t: 'text.snapshot', text: 'ok', final: true }, { audience: 'answer' });
  });
  const gw = await Gateway.start({ config, ...registries, harness, log: new MemorySessionLog(), channels: [{ adapter: new FakeChannel('fake') }], logger: () => {} });
  cleanups.push(() => gw.stop());
  const turns = (key: string) => gw.hub.log.read(key, 0).filter((e: SessionEvent) => e.body.t === 'turn.started');
  return { k: () => k, gw, harness, turns, given };
}

describe('a module acts in a session only as a peer', () => {
  it('lanes.command and lanes.input refuse a person\'s origin, an owner-labelled peer and a peer named as an owner; nothing reaches the lane #ID-10 #ID-3', async () => {
    const w = await start();
    const k = w.k();
    const cmd = { type: 'input' as const, sessionKey: 's1', mode: 'queue' as const, input: { content: [{ type: 'text' as const, text: 'hi' }] } };
    await expect(k.lanes.command(cmd, asOwner)).rejects.toThrow('module probe: lanes.command takes a peer\'s origin (origin.kind "peer", not "human")');
    await expect(k.lanes.command(cmd, peer(owner))).rejects.toThrow('module probe: lanes.command takes a peer\'s origin (a peer never carries the owner label)');
    await expect(k.lanes.command(cmd, peer({ id: 'fake:alice', labels: [] }))).rejects.toThrow('module probe: lanes.command takes a peer\'s origin (fake:alice is an owner, never a peer)');
    await expect(k.lanes.input('s2', input('i1', asOwner))).rejects.toThrow('module probe: lanes.input takes a peer\'s input (origin.kind "peer", not "human")');
    await expect(k.lanes.input('s2', input('i2', peer(owner)))).rejects.toThrow('module probe: lanes.input takes a peer\'s input (a peer never carries the owner label)');
    await expect(k.lanes.input('s2', input('i3', peer({ id: 'fake:alice', labels: [] })))).rejects.toThrow('module probe: lanes.input takes a peer\'s input (fake:alice is an owner, never a peer)');
    expect([w.turns('s1'), w.turns('s2')]).toEqual([[], []]);
    expect(w.harness.sessions).toHaveLength(0);
  });

  it("a peer's input runs restricted, without the native-command mark or a loop-guard label it brought; a peer's command reaches the lane as from it #ID-10 #CT-2", async () => {
    const w = await start();
    const k = w.k();
    const agent = peer({ id: 'external:bot', labels: ['external'] });
    expect(await k.lanes.input('s3', input('i4', agent, { channel: 'probe', nativeCommand: true, loopGuard: 'forged' } as never))).toMatchObject({ ok: true, disposition: 'new_turn' });
    await until(() => w.given.length === 1);
    expect(w.turns('s3').map((e) => (e.body as { run?: { profile?: string } }).run?.profile)).toEqual(['restricted']);
    expect(w.given[0]!.channelContext).toEqual({ channel: 'probe' });
    expect(w.given[0]!.origin).toMatchObject({ kind: 'peer', principal: { id: 'external:bot' } });
    expect(await k.lanes.command({ type: 'input', sessionKey: 's4', mode: 'queue', input: { content: [{ type: 'text', text: 'hi' }] } }, agent)).toMatchObject({ ok: true });
    await until(() => w.turns('s4').length === 1);
    expect((w.turns('s4')[0]!.body as { run?: { profile?: string } }).run?.profile).toBe('restricted');
  });
});
