import { describe, expect, it } from 'vitest';
import type { BodyOf, HarnessLive, HarnessOpenArgs, LiveStartArgs } from '@agents-io/protocol';
import { ManualHarness, ManualSession, bodies, input, route, setup, until } from './helpers.js';

class LiveSession extends ManualSession {
  readonly liveCalls: { start: LiveStartArgs[]; say: string[]; stop: number } = { start: [], say: [], stop: 0 };
  readonly live: HarnessLive = {
    start: async (a) => {
      this.liveCalls.start.push(a);
      return { answerSdp: `answer-to:${a.transport.sdp}` };
    },
    say: async (text) => void this.liveCalls.say.push(text),
    stop: async () => {
      this.liveCalls.stop++;
      this.push({ t: 'live.ended', liveId: this.liveCalls.start.at(-1)!.liveId, reason: 'requested' });
    },
  };
}

class LiveHarness extends ManualHarness {
  override session: LiveSession | undefined;
  override async open(args: HarnessOpenArgs) {
    this.session = new LiveSession(args);
    return this.session;
  }
}

const meeting = { channel: 'chan', account: 'a', conversationId: 'meeting:42' };
const control = route();
const info = { liveId: 'L1', title: 'meeting 42', route: meeting, controlRoute: control };

describe('Lane: live (decision 11)', () => {
  it('starts the harness live, records live.started, refuses a second one, and needs a harness that has it', async () => {
    const h = new LiveHarness();
    const { lane, events } = setup({ harness: h });
    const r = await lane.startLive(info, { transport: { type: 'webrtc', sdp: 'OFFER' }, instructions: 'be brief' });
    expect(r).toEqual({ answerSdp: 'answer-to:OFFER' });
    expect(h.session!.liveCalls.start).toEqual([{ liveId: 'L1', transport: { type: 'webrtc', sdp: 'OFFER' }, instructions: 'be brief' }]);
    expect(lane.liveInfo()).toEqual(info);
    expect(bodies(events(), 'live.started')).toEqual([{ t: 'live.started', liveId: 'L1', title: 'meeting 42', route: meeting, controlRoute: control }]);
    await expect(lane.startLive({ ...info, liveId: 'L2' }, { transport: { type: 'webrtc', sdp: 'x' } })).rejects.toThrow(/already running/);
    await lane.liveSay('hi');
    expect(h.session!.liveCalls.say).toEqual(['hi']);

    const plain = setup({ harness: new ManualHarness() });
    await expect(plain.lane.startLive(info, { transport: { type: 'webrtc', sdp: 'x' } })).rejects.toThrow(/no realtime voice/);
    expect(plain.lane.liveInfo()).toBeUndefined();
  });

  it('a delegation becomes an input from the far side and the harness-started turn runs as the lane turn', async () => {
    const h = new LiveHarness();
    const ended: [string, string][] = [];
    const { lane, events } = setup({ harness: h, onLiveEnded: (id, reason) => ended.push([id, reason]) });
    await lane.startLive(info, { transport: { type: 'webrtc', sdp: 'OFFER' } });
    const s = h.session!;
    s.push({ t: 'live.handoff', liveId: 'L1', inputId: 'live:L1:h1', text: '看看当前目录' });
    s.push({ t: 'turn.started', turnId: 'codex:d1', inputIds: ['live:L1:h1'], replyRoute: null, initiator: 'harness', nativeTurnId: 'd1' }, { turnId: 'codex:d1' });
    s.push({ t: 'input.consumed', inputIds: ['live:L1:h1'], turnId: 'codex:d1' }, { turnId: 'codex:d1' });
    await until(() => lane.currentTurn()?.turnId === 'codex:d1');

    const turn = lane.currentTurn()!;
    expect(turn.replyRoute).toBeNull();
    expect(turn.inputs).toHaveLength(1);
    expect(turn.inputs[0]).toMatchObject({
      inputId: 'live:L1:h1',
      origin: { kind: 'human', principal: null, evidence: 'none', via: 'chan:a:meeting:42', adapter: 'chan' },
      content: [{ type: 'transcript', text: '看看当前目录', stable: true }],
      replyRoute: control,
      channelContext: { live: true, liveId: 'L1', conversationKind: 'meeting', liveTitle: 'meeting 42' },
    });
    expect(lane.provenance('codex:d1')).toMatchObject({ triggeredBy: [null], external: true });
    expect(bodies(events(), 'input.admitted')).toMatchObject([{ inputId: 'live:L1:h1', disposition: 'new_turn' }]);

    // A message arriving meanwhile waits for the delegated turn; a second delegation joins it.
    const owner = input('from the owner');
    expect(await lane.command({ type: 'input', sessionKey: 's1', input: owner, mode: 'queue' })).toEqual({ ok: true, disposition: 'queued' });
    s.push({ t: 'live.handoff', liveId: 'L1', inputId: 'live:L1:h2', text: '挂了吧' });
    s.push({ t: 'input.consumed', inputIds: ['live:L1:h2'], turnId: 'codex:d1' }, { turnId: 'codex:d1' });
    await until(() => lane.currentTurn()?.inputs.length === 2);
    expect(s.starts).toHaveLength(0);
    s.push({ t: 'turn.completed', turnId: 'codex:d1', status: 'completed' }, { turnId: 'codex:d1' });
    await until(() => s.starts.length === 1);
    expect(s.starts[0]!.inputs.map((i) => i.inputId)).toEqual([owner.inputId]);
    const done = bodies(events(), 'turn.completed') as BodyOf<'turn.completed'>[];
    expect(done).toMatchObject([{ turnId: 'codex:d1', status: 'completed' }]);
    expect(bodies(events(), 'input.rejected')).toEqual([]);

    await lane.stopLive();
    await until(() => ended.length === 1);
    expect(ended).toEqual([['L1', 'requested']]);
    expect(lane.liveInfo()).toBeUndefined();
    expect(bodies(events(), 'live.ended')).toEqual([{ t: 'live.ended', liveId: 'L1', reason: 'requested' }]);
  });
});
