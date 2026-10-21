import { describe, expect, it } from 'vitest';
import { HOST_RESULT_VALUES, errors, type BodyOf, type InputRecord, type SessionEvent } from '@agents-io/protocol';
import type { FakeTurnScript } from '@agents-io/testkit';
import { FEATURES } from '../src/host.js';
import { daemon, until, type World } from './helpers.js';

/*
 * `session.compact` (CT-3): a host compacts a quiet live session's harness context as a turn of
 * its own: the command only, no context, no reply route; refused while the session is busy;
 * what arrives meanwhile queues behind it.
 */

const alice = { channelUserId: 'alice', evidence: 'platform_signed' as const };
const dm = { conversation: { id: 'dm-alice', kind: 'dm' as const } };
const textOf = (i: InputRecord) => i.content.map((c) => (c.type === 'text' ? c.text : '')).join('');
const isCompact = (i: InputRecord) => i.channelContext.nativeCommand === true;

function gate() {
  let open!: () => void;
  const promise = new Promise<void>((r) => (open = r));
  return { promise, open };
}

/** Echoes; a `/compact` turn reports the compaction (as Claude Code's adapter does) once `hold` opens. */
function scripted() {
  const seen: { inputs: { text: string; context: boolean; native: boolean }[] }[] = [];
  let hold: ReturnType<typeof gate> | undefined;
  const script: FakeTurnScript = async (t) => {
    seen.push({ inputs: t.inputs.map((i) => ({ text: textOf(i), context: i.channelContext.context === true, native: isCompact(i) })) });
    if (t.inputs.some(isCompact)) {
      t.emit({ t: 'notice', code: 'compacting', message: 'compacting context' });
      await hold?.promise;
      t.emit({ t: 'notice', code: 'compacting', message: 'context compacted (manual) 60000 → 5000 tokens' });
      return;
    }
    if (textOf(t.inputs.at(-1)!).includes('slow')) await hold?.promise;
    t.emit({ t: 'text.snapshot', text: `echo: ${t.inputs.map(textOf).join(' ')}`, final: true }, { audience: 'answer' });
  };
  return { seen, script, hold: () => (hold = gate()) };
}

const events = (w: World, key: string): SessionEvent[] => w.gw.hub.log.read(key, 0);
const ofType = <T extends SessionEvent['body']['t']>(w: World, key: string, t: T) =>
  events(w, key)
    .map((e) => e.body)
    .filter((b): b is Extract<SessionEvent['body'], { t: T }> => b.t === t);
const completed = (w: World, key: string) => ofType(w, key, 'turn.completed').length;
const sentTexts = (w: World) => w.chat.sent.map((s) => s.edits.at(-1)?.text ?? s.msg.text);

/** Alice's DM opens a session (one turn); its key. */
async function liveSession(w: World): Promise<string> {
  await w.chat.inject({ ...dm, sender: alice, text: 'hello' });
  const key = await until(() => w.gw.sessions().find((s) => s.live && completed(w, s.sessionKey) === 1)?.sessionKey);
  await until(() => sentTexts(w).some((t) => t?.includes('echo: hello')));
  return key;
}

describe('session.compact', () => {
  it('starts a turn whose one input is the command, from the host, with no reply route; nothing reaches the channel #CT-3', async () => {
    const s = scripted();
    const w = await daemon({ raw: { harnesses: { claude: { use: 'claude-code' } }, defaultHarness: 'claude' }, script: s.script });
    const key = await liveSession(w);
    const h = await w.host({ name: 'lb' });
    const sentBefore = w.chat.sent.length;
    const r = await h.sessionCompact({ sessionKey: key, inputId: 'lbz_1' });
    expect(errors(HOST_RESULT_VALUES['session.compact'], r)).toEqual([]);
    expect(r).toMatchObject({ sessionKey: key, inputId: 'lbz_1', duplicate: false });
    await until(() => completed(w, key) === 2);
    const started = ofType(w, key, 'turn.started').at(-1) as BodyOf<'turn.started'>;
    expect(started).toMatchObject({ turnId: r.turnId, inputIds: ['lbz_1'], replyRoute: null, owner: 'host:lb' });
    expect(s.seen.at(-1)!.inputs).toEqual([{ text: '/compact', context: false, native: true }]);
    const admitted = ofType(w, key, 'input.admitted').find((b) => b.inputId === 'lbz_1')!;
    expect(admitted.input?.origin).toMatchObject({ kind: 'system', adapter: 'host', principal: { id: 'host:lb' } });
    expect(ofType(w, key, 'notice').map((n) => n.message)).toContain('context compacted (manual) 60000 → 5000 tokens');
    expect(ofType(w, key, 'turn.completed').at(-1)).toMatchObject({ turnId: r.turnId, status: 'completed' });
    // No reply, no progress card, no notice on the channel.
    await new Promise((res) => setTimeout(res, 50));
    expect(w.chat.sent.length).toBe(sentBefore);
    // The same id again starts nothing.
    expect(await h.sessionCompact({ sessionKey: key, inputId: 'lbz_1' })).toEqual({ sessionKey: key, inputId: 'lbz_1', duplicate: true });
    expect(completed(w, key)).toBe(2);
  });

  it('context recorded before it waits for the next turn: the compaction is handed none #CT-3 #IN-6', async () => {
    const s = scripted();
    const w = await daemon({ raw: { harnesses: { claude: { use: 'claude-code' } }, defaultHarness: 'claude' }, script: s.script });
    const key = await liveSession(w);
    const h = await w.host({ name: 'lb' });
    await h.command({ type: 'input', sessionKey: key, mode: 'observe', input: { inputId: 'note-1', content: [{ type: 'text', text: 'a note for later' }] } });
    await h.sessionCompact({ sessionKey: key });
    await until(() => completed(w, key) === 2);
    expect(s.seen.at(-1)!.inputs).toEqual([{ text: '/compact', context: false, native: true }]);
    await w.chat.inject({ ...dm, sender: alice, text: 'next' });
    await until(() => completed(w, key) === 3);
    expect(s.seen.at(-1)!.inputs).toEqual([
      { text: 'a note for later', context: true, native: false },
      { text: 'next', context: false, native: false },
    ]);
  });

  it('a person\'s message while it runs queues behind it and is answered on the channel afterwards #CT-3 #IN-1', async () => {
    const s = scripted();
    const w = await daemon({ raw: { harnesses: { claude: { use: 'claude-code' } }, defaultHarness: 'claude' }, script: s.script });
    const key = await liveSession(w);
    const h = await w.host({ name: 'lb' });
    const hold = s.hold();
    const r = await h.sessionCompact({ sessionKey: key });
    await until(() => ofType(w, key, 'notice').some((n) => n.message === 'compacting context'));
    await w.chat.inject({ ...dm, sender: alice, text: 'are you there?' });
    await until(() => ofType(w, key, 'input.admitted').some((b) => b.disposition === 'queued'));
    // Busy now: a second compaction is refused, nothing recorded.
    await expect(h.sessionCompact({ sessionKey: key, inputId: 'lbz_again' })).rejects.toMatchObject({ code: 'busy' });
    hold.open();
    await until(() => completed(w, key) === 3);
    const turns = ofType(w, key, 'turn.started').map((b) => b.inputIds.length);
    expect(turns).toEqual([1, 1, 1]);
    expect(ofType(w, key, 'turn.started')[1]!.turnId).toBe(r.turnId);
    expect(s.seen.at(-1)!.inputs.map((i) => i.text)).toEqual(['are you there?']);
    await until(() => sentTexts(w).some((t) => t?.includes('echo: are you there?')));
    expect(ofType(w, key, 'input.admitted').some((b) => b.inputId === 'lbz_again')).toBe(false);
  });

  it('refused while a turn runs or inputs are queued (busy); never opens a session (not_live); bad ids and task runs refused #CT-3', async () => {
    const s = scripted();
    const w = await daemon({ raw: { harnesses: { claude: { use: 'claude-code' } }, defaultHarness: 'claude' }, script: s.script });
    const key = await liveSession(w);
    const h = await w.host({ name: 'lb' });
    const hold = s.hold();
    await w.chat.inject({ ...dm, sender: alice, text: 'slow one' });
    await until(() => ofType(w, key, 'turn.started').length === 2);
    await expect(h.sessionCompact({ sessionKey: key })).rejects.toMatchObject({ code: 'busy' });
    hold.open();
    await until(() => completed(w, key) === 2);
    await expect(h.sessionCompact({ sessionKey: 'nobody' })).rejects.toMatchObject({ code: 'not_live' });
    expect(w.gw.sessions().some((x) => x.sessionKey === 'nobody')).toBe(false);
    await expect(h.sessionCompact({ sessionKey: key, inputId: 'ctxo_x' })).rejects.toMatchObject({ code: 'bad_input_id' });
    await expect(h.sessionCompact({ sessionKey: key, inputId: 'a b' })).rejects.toMatchObject({ code: 'bad_input_id' });
    await expect(h.sessionCompact({ sessionKey: 'run:r1' })).rejects.toMatchObject({ code: 'invalid_frame' });
    expect(completed(w, key)).toBe(2);
  });

  it('a session whose harness has no compaction command is refused (unsupported) #CT-3', async () => {
    const w = await daemon({ raw: { harnesses: { cx: { use: 'codex' } }, defaultHarness: 'cx' } });
    const key = await liveSession(w);
    const h = await w.host({ name: 'lb' });
    await expect(h.sessionCompact({ sessionKey: key })).rejects.toMatchObject({ code: 'unsupported' });
    expect(completed(w, key)).toBe(1);
  });

  it('host.hello advertises session.compact #CT-3', async () => {
    expect(FEATURES).toContain('session.compact');
    const w = await daemon();
    const c = await w.client();
    const hello = await c.hello({ token: w.gw.token, name: 'probe' });
    expect(hello.features).toContain('session.compact');
  });
});
