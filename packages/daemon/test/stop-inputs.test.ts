import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SessionEvent } from '@agents-io/protocol';
import { SqliteSessionLog, rejectionNotice } from '@agents-io/session';
import { daemon, tmp, until } from './helpers.js';

const alice = { channelUserId: 'alice', evidence: 'platform_signed' as const };
const of = (evs: SessionEvent[], t: string) => evs.map((e) => e.body).filter((b) => b.t === t);

/** The session log a stopped daemon left in `dir`. */
const readLog = (dir: string) => new SqliteSessionLog({ path: join(dir, 'log.sqlite') });

describe('inputs left when the daemon stops or crashes (INVARIANTS IN-1, RS-6)', () => {
  it('stop with queued inputs: they are rejected (lane_closed) and the sender is told on the chat; after a restart nothing stays queued', async () => {
    const dir = tmp();
    // The turn runs until the daemon stops it.
    const w = await daemon({ dir, script: (t) => new Promise((_, reject) => t.signal.addEventListener('abort', () => reject(new Error('aborted')))) });
    await w.chat.inject({ sender: alice, text: 'long job' });
    await until(() => w.chat.sent.length === 1);
    await w.chat.inject({ sender: alice, text: 'then this' });
    const key = await until(() => w.gw.hub.log.sessions().find((k) => w.gw.hub.snapshot(k).queued.length === 1));
    await w.stop();

    const notice = w.chat.sent.find((s) => s.msg.text === rejectionNotice('lane_closed: gateway stopping'));
    expect(notice?.route).toMatchObject({ channel: 'fake', conversationId: 'c1' });
    const log = readLog(dir);
    expect(of(log.read(key, 0), 'input.rejected')[0]).toMatchObject({ reason: 'lane_closed: gateway stopping', replyRoute: { conversationId: 'c1' } });
    expect(log.snapshot(key).queued).toEqual([]);
    log.close();

    const w2 = await daemon({ dir });
    expect(w2.gw.hub.snapshot(key).queued).toEqual([]);
    expect(of(w2.gw.hub.log.read(key, 0), 'input.rejected').filter((b) => (b as { reason: string }).reason === 'host_restarted')).toEqual([]);
  });

  it('crash leftovers: inputs admitted but never settled by the previous process are rejected (host_restarted) at startup, and the snapshot lists none queued', async () => {
    const dir = tmp();
    // What a crashed process leaves: admissions with no turn, no consumed / rejected record.
    const log = readLog(dir);
    const ev = { ts: 1, level: 'primary' as const, audience: 'status' as const, durability: 'durable' as const };
    log.append('fake:default:c9', { ...ev, body: { t: 'input.admitted', inputId: 'lost1', disposition: 'new_turn' } });
    log.append('fake:default:c9', { ...ev, body: { t: 'input.admitted', inputId: 'lost2', disposition: 'queued' } });
    log.close();

    const w = await daemon({ dir });
    expect(w.gw.hub.snapshot('fake:default:c9').queued).toEqual([]);
    expect(of(w.gw.hub.log.read('fake:default:c9', 0), 'input.rejected')).toEqual([{ t: 'input.rejected', inputIds: ['lost1', 'lost2'], reason: 'host_restarted' }]);
    const c = await w.client();
    expect((await c.sessions()).find((s) => s.sessionKey === 'fake:default:c9')).toMatchObject({ queued: 0 });
    // The route of a crashed process's input is not in the log: nothing is sent.
    expect(w.chat.sent).toEqual([]);
  });
});
