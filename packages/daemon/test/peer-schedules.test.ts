import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { KernelContext, ModuleManifest, Origin, ReplyRoute, ScheduleView } from '@agents-io/protocol';
import { MemorySessionLog } from '@agents-io/session';
import { FakeChannel, FakeHarness } from '@agents-io/testkit';
import { resolveConfig } from '../src/config.js';
import { Gateway } from '../src/gateway.js';
import { HarnessRegistry } from '../src/harness-registry.js';
import { ChannelRegistry } from '../src/channel-registry.js';
import { ModuleRegistry, type ModuleFields } from '../src/modules.js';
import { cleanups, tmp } from './helpers.js';

/*
 * A peer's schedules (an agent outside this daemon; set through a module's
 * `KernelContext.schedules.addAs`) fire only through that module, as the peer: never as the
 * daemon's own message, and a wake goes to the host only while the module still acts for the
 * peer (SC-3). The external MCP endpoint is such a module (external-mcp.test.ts); these are an
 * embedder's.
 */

const route: ReplyRoute = { channel: 'fake', account: 'default', conversationId: 'c1' };
const peer = (id: string): Origin => ({ kind: 'peer', principal: { id, labels: [] }, evidence: 'device_only', via: `module:${id}`, adapter: 'probe' });
const message = (id: string, text = `${id} text`) => ({ id, when: { everyMinutes: 60 }, action: 'message' as const, route, text });
const wake = (id: string) => ({ id, when: { everyMinutes: 60 }, action: 'host' as const, route, text: `${id} text`, meta: { wake: 'resume' } });

/** A module that acts for its peers (`peer:…` creators) while `acts.now` says so; every ask is written to `asked`. */
function peersModule(id: string, acts: { now: boolean }, asked: string[]): { manifest: ModuleManifest<undefined>; k: () => KernelContext } {
  let k!: KernelContext;
  const answer =
    (hook: string) =>
    ({ schedule }: { schedule: ScheduleView }) => {
      asked.push(`${id} ${hook} ${schedule.id}`);
      return acts.now && schedule.createdBy.startsWith('peer:');
    };
  return { manifest: { id, kind: 'feature', setup: (ctx) => ((k = ctx), { hooks: { scheduledMessage: answer('message'), scheduledWake: answer('wake') } }) }, k: () => k };
}

async function start(modules: ModuleManifest<any>[], fields: Record<string, ModuleFields> = {}) {
  const dir = tmp('aio-peer-schedules-');
  const registries = { harnessRegistry: new HarnessRegistry([]), channelRegistry: new ChannelRegistry([]), moduleRegistry: new ModuleRegistry(modules, { fields }) };
  const raw = { policy: { owners: ['fake:alice'] }, local: { principal: 'me' }, cwd: dir };
  const config = { ...resolveConfig(raw, { env: {}, baseDir: dir, cwd: dir, ...registries }), socketPath: join(dir, 'run', 'aio.sock') };
  const chat = new FakeChannel('fake');
  const logs: string[] = [];
  const gw = await Gateway.start({ config, ...registries, harness: new FakeHarness(), log: new MemorySessionLog(), channels: [{ adapter: chat }], logger: (_level, msg) => logs.push(msg) });
  cleanups.push(() => gw.stop());
  /** These schedules due now, fired (their timer would, an hour from now). */
  const fire = async (...ids: string[]) => {
    await gw.schedules.idle();
    for (const id of ids) gw.schedules.registry.db.prepare('UPDATE schedules SET next_at = ? WHERE id = ?').run(Date.now() - 1000, id);
    await gw.schedules.tick();
  };
  /** Why a schedule's firings failed, as logged. */
  const failures = (id: string) => logs.filter((m) => m.startsWith(`schedule ${id}: the firing due `)).map((m) => m.replace(/^.*not tried again: /, ''));
  return { gw, chat, fire, failures };
}

describe("a peer's schedules fire only through its module", () => {
  it("only the module it was set through is asked (not one registered before it that would take it); while that module does not act for the peer, a firing sends nothing, as the daemon or to the host, and fails once, recorded; the schedule is kept #SC-3 #SC-1 #ID-10", async () => {
    const asked: string[] = [];
    const acts = { now: true };
    const greedy = peersModule('greedy', { now: true }, asked);
    const peers = peersModule('peers', acts, asked);
    const w = await start([greedy.manifest, peers.manifest]);
    const k = peers.k();
    expect(await k.schedules.addAs(peer('peer:x'), message('m1'))).toMatchObject({ ok: true, schedule: { id: 'm1', createdBy: 'peer:x', module: 'peers' } });
    expect(await k.schedules.addAs(peer('peer:x'), wake('w1'))).toMatchObject({ ok: true, schedule: { id: 'w1', action: 'host', module: 'peers' } });
    const queued = w.gw.hostQueue.head();
    await w.fire('m1', 'w1');
    // It acts for them: the message is its to send (it says it did), the wake goes to the host.
    expect(asked.sort()).toEqual(['peers message m1', 'peers wake w1']);
    expect(w.chat.sent).toEqual([]);
    expect(w.gw.hostQueue.head()).toBe(queued + 1);
    expect(w.gw.hostQueue.get(queued + 1)!.input.channelContext).toMatchObject({ schedule: 'w1', createdBy: 'peer:x' });
    // It no longer acts for the peer: nothing goes out, not as the daemon either.
    acts.now = false;
    asked.length = 0;
    await w.fire('m1', 'w1');
    expect(asked.sort()).toEqual(['peers message m1', 'peers wake w1']);
    expect(w.chat.sent).toEqual([]);
    expect(w.gw.hostQueue.head()).toBe(queued + 1);
    expect(w.failures('m1')).toEqual(['set by peer:x through module peers, which does not act for peer:x now; not sent']);
    expect(w.failures('w1')).toEqual(['set by peer:x through module peers, which does not act for peer:x now; not handed to the host']);
    for (const id of ['m1', 'w1']) {
      const s = w.gw.listSchedules().find((x) => x.id === id)!;
      expect(s.nextAt).toBeGreaterThan(Date.now());
      expect(s.lastFailure?.reason).toBe(w.failures(id)[0]);
    }
    expect(w.gw.schedules.registry.pending()).toEqual([]);
  });

  it("one set before schedules recorded their module is its module's by its creator (ModuleFields.schedules); one recorded for a module this daemon does not have sends nothing; a peer sets one only through a module. The owner's are as before: the daemon's message #SC-3 #SC-1", async () => {
    const asked: string[] = [];
    const greedy = peersModule('greedy', { now: false }, asked);
    const peers = peersModule('peers', { now: true }, asked);
    const w = await start([greedy.manifest, peers.manifest], { peers: { schedules: 'peer:' } });
    const reg = w.gw.schedules.registry;
    // As schedules were kept before: no module.
    reg.put(message('old'), 'peer:x');
    reg.put(message('gone'), 'other:z', undefined, 'elsewhere');
    reg.put(message('own', 'from the owner'), 'config');
    expect(await w.gw.putSchedule(peer('peer:y'), message('direct'))).toMatchObject({ ok: false, code: 'forbidden', message: expect.stringMatching(/through the module it is a peer of/) });
    expect(reg.get('direct')).toBeUndefined();
    await w.fire('old', 'gone', 'own');
    // The old one is the peers module's alone; the owner's is asked of every module, none takes it, the daemon sends it.
    expect(asked.sort()).toEqual(['greedy message own', 'peers message old', 'peers message own']);
    expect(w.failures('old')).toEqual([]);
    expect(w.failures('gone')).toEqual(['set by other:z through module elsewhere, which this daemon does not have; not sent']);
    expect(w.chat.sent.map((s) => s.msg.text)).toEqual(['from the owner']);
  });
});
