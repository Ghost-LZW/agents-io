import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION, type InboundEnvelope } from '@agents-io/protocol';
import { CHOICE_KEY, MENTIONS_KEY, choiceActionId } from '../src/index.js';
import { SK, call, input, route, turnOf, watchWorld, world } from './host-mcp-helpers.js';

describe('HostTools', () => {
  it('reply_to keeps the reply target; message_id overrides it', async () => {
    const w = world();
    await call(w, 'reply_to', { route: 'current', text: 'a' }, 'c1');
    await call(w, 'reply_to', { route: 'current', text: 'b', message_id: 'm9' }, 'c2');
    expect(w.fake.sent.map((s) => s.route.replyToMessageId)).toEqual(['m0', 'm9']);
  });

  it('send_file uploads to the blob store and sends an attachment', async () => {
    const w = world();
    writeFileSync(join(w.cwd, 'README.md'), '# hi\n');
    const r = await call(w, 'send_file', { path: 'README.md', caption: 'here' });
    expect(r).toMatchObject({ ok: true, name: 'README.md', mime: 'text/markdown', bytes: 5 });
    const att = w.fake.sent[0]!.msg.attachments![0]!;
    expect(w.fake.sent[0]!.msg.text).toBe('here');
    expect(att.name).toBe('README.md');
    expect(new TextDecoder().decode((await w.blobs.get(att.ref)).bytes)).toBe('# hi\n');
  });

  it('ask_choice renders buttons where the channel has them, a numbered list elsewhere', async () => {
    const w = world();
    const r = await call(w, 'ask_choice', { question: 'Red or blue?', options: ['red', 'blue'] }, 'q1');
    expect(r.choiceId).toMatch(/^ch_/);
    expect(r.note).toMatch(/next input/);
    const msg = w.fake.sent[0]!.msg;
    expect(msg.actions!.map((a) => a.id)).toEqual([choiceActionId(r.choiceId, 1), choiceActionId(r.choiceId, 2)]);
    expect((msg.channelData as Record<string, unknown>)[CHOICE_KEY]).toMatchObject({ choiceId: r.choiceId, options: ['red', 'blue'], multi: false });

    w.setTurn(turnOf(route('c1', 'mail')));
    await call(w, 'ask_choice', { question: 'Pick', options: ['a', 'b', 'c'], multi: true }, 'q2');
    const text = w.mail.sent[0]!.msg.text;
    expect(text).toContain('1. a\n2. b\n3. c');
    expect(text).toMatch(/numbers of your choices/);
    expect(w.mail.sent[0]!.msg.actions).toBeUndefined();
  });

  it('a button click and a numbered reply come back as a choice event for the asking session', async () => {
    const w = world();
    const r = await call(w, 'ask_choice', { question: 'Red or blue?', options: ['red', 'blue'] }, 'q1');
    const env = (content: InboundEnvelope['content'], r2 = route()): InboundEnvelope => ({
      v: PROTOCOL_VERSION,
      id: 'e1',
      channel: 'fake',
      account: 'default',
      conversation: { id: 'c1', kind: 'other' },
      sender: { channelUserId: 'alice', evidence: 'platform_signed' },
      content,
      replyRoute: r2,
    });
    const origin = input(route()).origin;
    const click = w.tools.rewriteInbound({ env: env([{ type: 'event', name: 'action', data: { actionId: choiceActionId(r.choiceId, 2) } }]), origin, sessionKey: 'elsewhere' });
    expect(click!.sessionKey).toBe(SK);
    expect(click!.content![0]).toMatchObject({ type: 'event', name: 'choice', data: { choiceId: r.choiceId, selected: [{ n: 2, label: 'blue' }], via: 'button' } });
    // answered: a later number is just text again
    expect(w.tools.rewriteInbound({ env: env([{ type: 'text', text: '1' }]), origin, sessionKey: SK })).toBeUndefined();

    const r2 = await call(w, 'ask_choice', { question: 'Again?', options: ['yes', 'no'] }, 'q2');
    const reply = w.tools.rewriteInbound({ env: env([{ type: 'text', text: 'Subject: Re: x\n 1 ' }]), origin, sessionKey: SK });
    expect(reply!.content![0]).toMatchObject({ data: { choiceId: r2.choiceId, selected: [{ n: 1, label: 'yes' }], via: 'reply' } });
    // unrelated text or other routes are left alone
    expect(w.tools.rewriteInbound({ env: env([{ type: 'text', text: 'red please' }]), origin, sessionKey: SK })).toBeUndefined();
  });

  it('local /choose input is normalized; bad answers are refused', async () => {
    const w = world();
    const r = await call(w, 'ask_choice', { question: 'Q', options: ['x', 'y'] }, 'q1');
    const out = w.tools.normalizeLocal([{ type: 'event', name: 'choice', data: { choiceId: r.choiceId, selected: [2] } }]);
    expect(out[0]).toMatchObject({ data: { selected: [{ n: 2, label: 'y' }], via: 'command' } });
    expect(() => w.tools.normalizeLocal([{ type: 'event', name: 'choice', data: { choiceId: r.choiceId, selected: [3] } }])).toThrow(/between 1 and 2/);
    expect(() => w.tools.normalizeLocal([{ type: 'event', name: 'choice', data: { choiceId: 'ch_nope', selected: [1] } }])).toThrow(/unknown choice/);
  });

  it('mention carries targets in channelData and names in the text fallback', async () => {
    const w = world();
    await call(w, 'mention', { user_ids: ['fake:alice', 'bob'], text: 'please look' });
    const msg = w.fake.sent[0]!.msg;
    expect(msg.text).toBe('@Alice @bob please look');
    expect((msg.channelData as Record<string, unknown>)[MENTIONS_KEY]).toEqual({ targets: [{ id: 'alice', name: 'Alice' }, { id: 'bob' }], text: 'please look' });
  });

  it('get_channel_context summarises the route, caps, tier and participants', async () => {
    const w = world({ routes: ['fake:default:ops'] });
    const c = await call(w, 'get_channel_context', {});
    expect(c).toMatchObject({
      route: 'fake:default:c1',
      channel: 'fake',
      conversationKind: 'dm',
      tier: 'card',
      caps: { buttons: true, mediaOut: ['image', 'file'], markdown: 'basic' },
      participants: [{ principal: 'fake:alice', userId: 'alice', name: 'Alice' }],
      allowedDestinations: { current: 'fake:default:c1', preregistered: ['fake:default:ops'] },
    });
  });
});

describe('watch tools', () => {
  it('validates mode and digest period', async () => {
    const w = watchWorld();
    await expect(w.run(SK, 'watch_add', { source: { channel: 'lark-bot', conversation: 'oc_team' }, mode: 'digest' })).rejects.toThrow(/digest_every_minutes/);
    await expect(w.run(SK, 'watch_add', { source: { channel: 'lark-bot' }, mode: 'loud' })).rejects.toThrow(/mode must be/);
  });
});
