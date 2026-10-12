import { describe, expect, it } from 'vitest';
import type { BodyOf, HarnessLive, HarnessOpenArgs, LiveFrame, LiveStartArgs, LiveTransport } from '@agents-io/protocol';
import { LiveTransportError, type LiveSpeakerOrigin } from '../src/index.js';
import { ManualHarness, ManualSession, RUN, bodies, input, origin, route, setup, until } from './helpers.js';

type LiveCaps = { transports?: LiveTransport[]; video?: boolean };

class LiveSession extends ManualSession {
  readonly liveCalls: { start: LiveStartArgs[]; say: string[]; stop: number } = { start: [], say: [], stop: 0 };
  /** Frames the harness read from a frames transport. */
  readonly framesIn: LiveFrame[] = [];
  readonly live: HarnessLive;
  constructor(args: HarnessOpenArgs, caps: LiveCaps = {}) {
    super(args);
    this.live = {
      ...caps,
      start: async (a) => {
        this.liveCalls.start.push(a);
        if (a.transport.type === 'frames') {
          for await (const f of a.transport.media.frames) this.framesIn.push(f);
          return {};
        }
        return { answerSdp: `answer-to:${a.transport.sdp}` };
      },
      say: async (text) => void this.liveCalls.say.push(text),
      stop: async () => {
        this.liveCalls.stop++;
        this.push({ t: 'live.ended', liveId: this.liveCalls.start.at(-1)!.liveId, reason: 'requested' });
      },
    };
  }
}

class LiveHarness extends ManualHarness {
  override session: LiveSession | undefined;
  constructor(private readonly liveCaps: LiveCaps = {}) {
    super();
  }
  override async open(args: HarnessOpenArgs) {
    this.session = new LiveSession(args, this.liveCaps);
    return this.session;
  }
}

/** A frames transport whose far side sends `fs`, then ends. */
function frames(...fs: LiveFrame[]): LiveStartArgs['transport'] {
  async function* gen() {
    yield* fs;
  }
  return { type: 'frames', audio: { encoding: 'pcm16', rate: 24000 }, video: { encodings: ['image/jpeg'] }, media: { frames: gen(), send: () => {} } };
}
const audio: LiveFrame = { kind: 'audio', pcm: new Uint8Array([1, 2]) };
const video: LiveFrame = { kind: 'video', data: new Uint8Array([3]), mimeType: 'image/jpeg' };

const meeting = { channel: 'chan', account: 'a', conversationId: 'meeting:42' };
const control = route();
const info = { liveId: 'L1', title: 'meeting 42', route: meeting, controlRoute: control };

describe('Lane: live (decision 11)', () => {
  it('starts the harness live, records live.started, refuses a second one, and needs a harness that has it #LN-3', async () => {
    const h = new LiveHarness();
    const { lane, events } = setup({ harness: h });
    const r = await lane.startLive(info, { transport: { type: 'webrtc', sdp: 'OFFER' }, instructions: 'be brief' });
    expect(r).toEqual({ answerSdp: 'answer-to:OFFER' });
    // Delegated turns begin under the floor: the plan over no inputs (decision 11 amendment).
    expect(h.session!.liveCalls.start).toEqual([
      { liveId: 'L1', transport: { type: 'webrtc', sdp: 'OFFER' }, instructions: 'be brief', delegationRun: expect.objectContaining({ profile: 'restricted' }) },
    ]);
    expect(lane.liveInfo()).toEqual(info);
    expect(bodies(events(), 'live.started')).toEqual([{ t: 'live.started', liveId: 'L1', title: 'meeting 42', route: meeting, controlRoute: control }]);
    await expect(lane.startLive({ ...info, liveId: 'L2' }, { transport: { type: 'webrtc', sdp: 'x' } })).rejects.toThrow(/already running/);
    await lane.liveSay('hi');
    expect(h.session!.liveCalls.say).toEqual(['hi']);

    const plain = setup({ harness: new ManualHarness() });
    await expect(plain.lane.startLive(info, { transport: { type: 'webrtc', sdp: 'x' } })).rejects.toThrow(/no realtime voice/);
    expect(plain.lane.liveInfo()).toBeUndefined();
  });

  it('a delegation becomes an input from the far side and the harness-started turn runs as the lane turn #LN-6 #LN-2 #ID-1 #LN-4', async () => {
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

  it('a transport the harness live does not take is refused before start, naming the transport; nothing is registered #LN-5', async () => {
    const webrtcOnly = new LiveHarness();
    const a = setup({ harness: webrtcOnly });
    const err = await a.lane.startLive(info, { transport: frames(audio) }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LiveTransportError);
    expect((err as Error).message).toMatch(/\bframes\b/);
    expect(webrtcOnly.session!.liveCalls.start).toEqual([]);
    expect(a.lane.liveInfo()).toBeUndefined();
    expect(bodies(a.events(), 'live.started')).toEqual([]);
    // Nothing left behind: a transport it takes still starts.
    expect(await a.lane.startLive(info, { transport: { type: 'webrtc', sdp: 'OFFER' } })).toEqual({ answerSdp: 'answer-to:OFFER' });

    const framesOnly = new LiveHarness({ transports: ['frames'] });
    const b = setup({ harness: framesOnly });
    const err2 = await b.lane.startLive(info, { transport: { type: 'webrtc', sdp: 'OFFER' } }).catch((e: unknown) => e);
    expect(err2).toBeInstanceOf(LiveTransportError);
    expect((err2 as Error).message).toMatch(/\bwebrtc\b/);
    expect(framesOnly.session!.liveCalls.start).toEqual([]);
    expect(b.lane.liveInfo()).toBeUndefined();
    expect(bodies(b.events(), 'live.started')).toEqual([]);
  });

  it('a frames live without video gets no video frames; one that declares video gets them #LN-5', async () => {
    const noVideo = new LiveHarness({ transports: ['frames'] });
    await setup({ harness: noVideo }).lane.startLive(info, { transport: frames(audio, video, audio) });
    expect(noVideo.session!.framesIn.map((f) => f.kind)).toEqual(['audio', 'audio']);

    const withVideo = new LiveHarness({ transports: ['frames'], video: true });
    await setup({ harness: withVideo }).lane.startLive(info, { transport: frames(audio, video, audio) });
    expect(withVideo.session!.framesIn.map((f) => f.kind)).toEqual(['audio', 'video', 'audio']);
  });

  it('delegations reach the loop checkpoint: past the pair limit one is context labelled loopGuard, and the turn the harness runs for it is interrupted #IN-8 #LN-6', async () => {
    const h = new LiveHarness();
    const { lane, events } = setup({ harness: h, loopGuard: { pair: { maxTurns: 2 } } });
    await lane.startLive(info, { transport: { type: 'webrtc', sdp: 'OFFER' } });
    const s = h.session!;
    const delegate = async (n: number) => {
      s.push({ t: 'live.handoff', liveId: 'L1', inputId: `live:L1:h${n}`, text: `ask ${n}` });
      s.push({ t: 'turn.started', turnId: `codex:d${n}`, inputIds: [`live:L1:h${n}`], replyRoute: null, initiator: 'harness' }, { turnId: `codex:d${n}` });
      await until(() => lane.currentTurn()?.turnId === `codex:d${n}`);
    };
    const finish = async (n: number) => {
      s.push({ t: 'input.consumed', inputIds: [`live:L1:h${n}`], turnId: `codex:d${n}` }, { turnId: `codex:d${n}` });
      s.push({ t: 'turn.completed', turnId: `codex:d${n}`, status: s.interrupts.includes(`codex:d${n}`) ? 'interrupted' : 'completed' }, { turnId: `codex:d${n}` });
      await until(() => !lane.currentTurn());
    };
    await delegate(1);
    await finish(1);
    await delegate(2);
    await finish(2);
    expect(s.interrupts).toEqual([]);
    // The third delegation from the same meeting, with nobody identified writing here in between.
    await delegate(3);
    const a = bodies(events(), 'input.admitted').find((x) => x.inputId === 'live:L1:h3')!;
    expect(a).toMatchObject({ disposition: 'observe_only', input: { channelContext: { loopGuard: 'pair', live: true } } });
    expect(s.interrupts).toEqual(['codex:d3']);
    expect(lane.currentTurn()!.inputs).toEqual([]);
    // A stopped delegation the harness merges into a running turn interrupts that turn too,
    // and its consumed report does not make the turn ambiguous.
    s.push({ t: 'live.handoff', liveId: 'L1', inputId: 'live:L1:h4', text: 'ask 4' });
    await until(() => s.interrupts.length === 2);
    expect(s.interrupts[1]).toBe('codex:d3');
    s.push({ t: 'input.consumed', inputIds: ['live:L1:h4'], turnId: 'codex:d3' }, { turnId: 'codex:d3' });
    await finish(3);
    expect(bodies(events(), 'turn.completed').at(-1)).toMatchObject({ turnId: 'codex:d3', status: 'interrupted' });
    // The owner writes here: the meeting may delegate again.
    const owner = input('from the owner');
    await lane.command({ type: 'input', sessionKey: 's1', input: owner, mode: 'queue' });
    await until(() => s.starts.length === 1);
    s.complete(s.starts[0]!.turnId, [owner.inputId]);
    await until(() => !lane.currentTurn());
    await delegate(5);
    expect(s.interrupts).toHaveLength(2);
  });


  it('the 33rd pending delegation pushes the oldest out, and the evicted one still gets a terminal state #IN-1', async () => {
    const h = new LiveHarness();
    // The pair limit is out of the way: this is about the pending bound, not the loop guard (IN-8).
    const { lane, events } = setup({ harness: h, loopGuard: { pair: { maxTurns: 100 } } });
    await lane.startLive(info, { transport: { type: 'webrtc', sdp: 'OFFER' } });
    for (let i = 0; i < 33; i++) h.session!.push({ t: 'live.handoff', liveId: 'L1', inputId: `live:L1:h${i}`, text: `ask ${i}` });
    await until(() => bodies(events(), 'input.admitted').length === 33);
    await lane.whenIdle();
    const terminal = bodies(events()).filter((b) => (b.t === 'input.consumed' || b.t === 'input.rejected' || b.t === 'input.cancelled') && (b as { inputIds: string[] }).inputIds.includes('live:L1:h0'));
    expect(terminal).toEqual([{ t: 'input.rejected', inputIds: ['live:L1:h0'], reason: 'handoff_overflow' }]);
  });

  it('delegations no turn took are rejected when their live ends, or when the lane closes #IN-1', async () => {
    const h = new LiveHarness();
    const { lane, events } = setup({ harness: h });
    await lane.startLive(info, { transport: { type: 'webrtc', sdp: 'OFFER' } });
    h.session!.push({ t: 'live.handoff', liveId: 'L1', inputId: 'live:L1:a', text: 'a' });
    await until(() => bodies(events(), 'input.admitted').length === 1);
    await lane.stopLive();
    await until(() => bodies(events(), 'input.rejected').length === 1);
    expect(bodies(events(), 'input.rejected')).toEqual([{ t: 'input.rejected', inputIds: ['live:L1:a'], reason: 'live_ended' }]);

    await lane.startLive({ ...info, liveId: 'L2' }, { transport: { type: 'webrtc', sdp: 'OFFER' } });
    h.session!.push({ t: 'live.handoff', liveId: 'L2', inputId: 'live:L2:b', text: 'b' });
    await until(() => bodies(events(), 'input.admitted').length === 2);
    await lane.close('gateway stopping');
    expect(bodies(events(), 'input.rejected').at(-1)).toEqual({ t: 'input.rejected', inputIds: ['live:L2:b'], reason: 'lane_closed: gateway stopping' });
    // The lane recorded the open live as ended when it closed (#LN-4).
    expect(bodies(events(), 'live.ended').map((b) => (b as BodyOf<'live.ended'>).liveId)).toEqual(['L1', 'L2']);
  });
});

describe("Lane: a delegated turn's profile follows its speaker (decision 11 amendment)", () => {
  const owner = { kind: 'human' as const, principal: { id: 'fake:alice', labels: ['owner'] }, evidence: 'platform_signed' as const, displayName: 'Alice' };
  const stranger = { kind: 'human' as const, principal: null, evidence: 'platform_signed' as const };
  const started = { ...info, startedBy: 'fake:alice' };
  const approval = (requestId: string, turnId: string) =>
    [
      { t: 'request.opened' as const, requestId, kind: 'tool_approval' as const, title: 'rm -rf build', risk: {}, allowedDecisions: ['allow_once' as const, 'deny' as const], allowAlways: false, defaultDeny: true },
      { turnId },
    ] as const;
  type Speaker = LiveSpeakerOrigin | undefined;

  async function live(speakers: Speaker[]) {
    const h = new LiveHarness();
    const asked: number[] = [];
    const w = setup({
      harness: h,
      liveSpeaker: async (a) => {
        asked.push(a.atMs);
        return speakers.shift();
      },
    });
    await w.lane.startLive(started, { transport: { type: 'webrtc', sdp: 'OFFER' } });
    return { ...w, h, s: h.session!, asked };
  }

  it("the owner speaking: planned bypass from its own input, its requests are allowed; the harness running it under the live's floor is accepted #LN-7", async () => {
    const { lane, s, events, asked } = await live([owner]);
    expect(s.liveCalls.start[0]!.delegationRun).toMatchObject({ profile: 'restricted' });
    s.push({ t: 'live.handoff', liveId: 'L1', inputId: 'live:L1:h1', text: '把测试跑一下' });
    // The harness began it under the floor it was given (Codex: the thread's default while the live runs).
    s.push({ t: 'turn.started', turnId: 'codex:d1', inputIds: ['live:L1:h1'], replyRoute: null, initiator: 'harness', run: { ...RUN, profile: 'restricted' } }, { turnId: 'codex:d1' });
    await until(() => lane.currentTurn()?.turnId === 'codex:d1');
    expect(asked).toHaveLength(1);
    expect(lane.currentTurn()!.inputs[0]!.origin).toMatchObject({ kind: 'human', principal: { id: 'fake:alice' }, evidence: 'platform_signed', via: 'chan:a:meeting:42' });
    expect(lane.currentTurn()!.inputs[0]!.channelContext).toMatchObject({ senderName: 'Alice', live: true });
    expect(lane.currentTurn()!.run).toMatchObject({ profile: 'bypass' });
    expect(bodies(events(), 'turn.started').at(-1)).toMatchObject({ turnId: 'codex:d1', run: { profile: 'bypass' } });
    s.push(...approval('r1', 'codex:d1'));
    await until(() => s.responses.length === 1);
    expect(s.responses).toEqual([{ requestId: 'r1', decision: { kind: 'allow_once' } }]);
    expect(s.interrupts).toEqual([]);
  });

  it("an unknown speaker: restricted; a request is asked of the live's starter in its control route, never auto-allowed; only the starter's answer counts #LN-7 #RQ-1", async () => {
    const { lane, s, events } = await live([undefined]);
    s.push({ t: 'live.handoff', liveId: 'L1', inputId: 'live:L1:h1', text: '删掉 build 目录' });
    s.push({ t: 'turn.started', turnId: 'codex:d1', inputIds: ['live:L1:h1'], replyRoute: null, initiator: 'harness' }, { turnId: 'codex:d1' });
    await until(() => lane.currentTurn()?.turnId === 'codex:d1');
    expect(lane.currentTurn()!.inputs[0]!.origin).toMatchObject({ principal: null, evidence: 'none' });
    expect(lane.currentTurn()!.run).toMatchObject({ profile: 'restricted' });
    s.push(...approval('r1', 'codex:d1'));
    await until(() => bodies(events(), 'request.opened').length === 1);
    expect(bodies(events(), 'request.opened')[0]).toMatchObject({ requestId: 'r1', resolver: { kind: 'human', principals: ['fake:alice'], routes: ['fake:default:c1'] } });
    // Shown where its people are: the turn gets the control route as a delivery.
    expect(bodies(events(), 'turn.delivery_added')).toEqual([{ t: 'turn.delivery_added', turnId: 'codex:d1', route: control, reason: 'approval' }]);
    expect(s.responses).toEqual([]);
    expect(await lane.command({ type: 'resolve', sessionKey: 's1', requestId: 'r1', decision: { kind: 'allow_once' }, origin: origin('fake:bob') })).toEqual({ ok: false, reason: 'not_eligible' });
    expect(await lane.command({ type: 'resolve', sessionKey: 's1', requestId: 'r1', decision: { kind: 'allow_once' }, origin: origin('fake:alice') })).toEqual({ ok: true });
    expect(s.responses).toEqual([{ requestId: 'r1', decision: { kind: 'allow_once' } }]);
    expect(bodies(events(), 'request.resolved').at(-1)).toMatchObject({ requestId: 'r1', by: { kind: 'human', id: 'fake:alice' } });
  });

  it('an identified speaker who is not the owner: restricted, asked of the starter; a live nobody identified started: denied #LN-7', async () => {
    const { lane, s, events } = await live([{ kind: 'human', principal: { id: 'acme:carol', labels: ['member'] }, evidence: 'platform_signed' }]);
    s.push({ t: 'live.handoff', liveId: 'L1', inputId: 'live:L1:h1', text: 'x' });
    s.push({ t: 'turn.started', turnId: 'codex:d1', inputIds: ['live:L1:h1'], replyRoute: null, initiator: 'harness' }, { turnId: 'codex:d1' });
    await until(() => lane.currentTurn()?.turnId === 'codex:d1');
    expect(lane.currentTurn()!.inputs[0]!.origin.principal).toMatchObject({ id: 'acme:carol' });
    expect(lane.currentTurn()!.run).toMatchObject({ profile: 'restricted' });
    s.push(...approval('r1', 'codex:d1'));
    await until(() => bodies(events(), 'request.opened').length === 1);
    expect(bodies(events(), 'request.opened')[0]).toMatchObject({ resolver: { kind: 'human', principals: ['fake:alice'] } });

    // Nobody identified started it: nobody to ask, the default policy denies.
    const h = new LiveHarness();
    const w = setup({ harness: h });
    await w.lane.startLive({ ...info, startedBy: null }, { transport: { type: 'webrtc', sdp: 'OFFER' } });
    h.session!.push({ t: 'live.handoff', liveId: 'L1', inputId: 'live:L1:h1', text: 'x' });
    h.session!.push({ t: 'turn.started', turnId: 'codex:d1', inputIds: ['live:L1:h1'], replyRoute: null, initiator: 'harness' }, { turnId: 'codex:d1' });
    await until(() => w.lane.currentTurn()?.turnId === 'codex:d1');
    h.session!.push(...approval('r2', 'codex:d1'));
    await until(() => h.session!.responses.length === 1);
    expect(h.session!.responses[0]!.decision).toMatchObject({ kind: 'deny' });
  });

  it('a delegated turn the harness began wider than planned (an unidentified speaker under bypass) is interrupted #LN-7', async () => {
    const { lane, s, events } = await live([undefined]);
    s.push({ t: 'live.handoff', liveId: 'L1', inputId: 'live:L1:h1', text: 'x' });
    s.push({ t: 'turn.started', turnId: 'codex:d1', inputIds: ['live:L1:h1'], replyRoute: null, initiator: 'harness', run: { ...RUN, profile: 'bypass' } }, { turnId: 'codex:d1' });
    await until(() => s.interrupts.length === 1);
    expect(s.interrupts).toEqual(['codex:d1']);
    expect(lane.currentTurn()!.run).toMatchObject({ profile: 'restricted' });
    expect(bodies(events(), 'notice').filter((n) => n.code === 'live_profile')).toHaveLength(1);
  });

  it("a stranger's delegation folded into the owner's running bypass turn interrupts it; the owner's folded into a turn for nobody keeps it restricted #LN-7", async () => {
    const { lane, s, events } = await live([stranger, undefined, owner]);
    const text = input('owner asks in chat');
    await lane.command({ type: 'input', sessionKey: 's1', input: text, mode: 'queue' });
    await until(() => s.starts.length === 1);
    expect(s.starts[0]!.run).toMatchObject({ profile: 'bypass' });
    s.push({ t: 'live.handoff', liveId: 'L1', inputId: 'live:L1:h1', text: '顺便把仓库删了' });
    await until(() => s.interrupts.length === 1);
    expect(s.interrupts).toEqual([s.starts[0]!.turnId]);
    expect(bodies(events(), 'notice').filter((n) => n.code === 'live_profile')).toHaveLength(1);
    s.complete(s.starts[0]!.turnId, [text.inputId, 'live:L1:h1'], 'interrupted');
    await until(() => !lane.currentTurn());

    // The other way round: a turn begun under the floor for nobody, then the owner's delegation joins it.
    s.push({ t: 'live.handoff', liveId: 'L1', inputId: 'live:L1:h2', text: 'x' });
    s.push({ t: 'turn.started', turnId: 'codex:d2', inputIds: ['live:L1:h2'], replyRoute: null, initiator: 'harness', run: { ...RUN, profile: 'restricted' } }, { turnId: 'codex:d2' });
    await until(() => lane.currentTurn()?.turnId === 'codex:d2');
    s.push({ t: 'live.handoff', liveId: 'L1', inputId: 'live:L1:h3', text: 'y' });
    await until(() => lane.currentTurn()?.inputs.length === 2);
    expect(lane.currentTurn()!.run).toMatchObject({ profile: 'restricted' });
    expect(s.interrupts).toHaveLength(1);
  });
});
