import { describe, expect, it } from 'vitest';
import { parseAttachLine } from '../src/attach.js';
import { ConfigError, resolveConfig } from '../src/config.js';
import { WatchSpecError, parseDuration, parseWatchSpec } from '../src/watch-spec.js';

describe('watch spec', () => {
  it('parses key=value specs', () => {
    expect(parseWatchSpec(['channel=lark-bot', 'conversation=oc_1', 'every=30m', 'max=5', 'keywords=a,b', 'note=sum', 'it', 'up'], 'main', 0)).toEqual({
      source: { channel: 'lark-bot', conversation: 'oc_1' },
      filter: { keywords: ['a', 'b'] },
      target: { sessionKey: 'main' },
      mode: 'digest',
      digest: { everyMs: 1_800_000, maxItems: 5 },
      note: 'sum it up',
    });
    expect(parseWatchSpec(['channel=mail', 'kind=mail', 'senders=a@b.c', 'mode=trigger', 'expires=1h', 'session=other', 'id=w9', 'self=true'], 'main', 1000)).toEqual({
      id: 'w9',
      source: { channel: 'mail', conversationKind: 'mail', senders: ['a@b.c'] },
      filter: { excludeSelf: false },
      target: { sessionKey: 'other' },
      mode: 'trigger',
      expiresAt: 3_601_000,
    });
    expect(() => parseWatchSpec(['conversation=x'], 'main')).toThrow(WatchSpecError);
    expect(() => parseWatchSpec(['channel=x', 'mode=loud'], 'main')).toThrow(/mode/);
    expect(() => parseWatchSpec(['channel=x', 'mode=trigger', 'every=1m'], 'main')).toThrow(/digest/);
    expect(() => parseWatchSpec(['channel=x', 'bogus=1'], 'main')).toThrow(/unknown/);
    expect(new WatchSpecError('x')).toBeInstanceOf(ConfigError);
    expect(parseDuration('90s')).toBe(90_000);
    expect(parseDuration('250')).toBe(250);
  });

  it('attach /watch commands', () => {
    expect(parseAttachLine('/watch add channel=x mode=trigger')).toEqual({ kind: 'watch', op: 'add', tokens: ['channel=x', 'mode=trigger'] });
    expect(parseAttachLine('/watch')).toEqual({ kind: 'watch', op: 'list', all: false });
    expect(parseAttachLine('/watch list all')).toEqual({ kind: 'watch', op: 'list', all: true });
    expect(parseAttachLine('/watch rm w1')).toEqual({ kind: 'watch', op: 'remove', id: 'w1' });
    expect(parseAttachLine('/watch add')).toMatchObject({ kind: 'error' });
  });
});

describe('config watches', () => {
  it('validates watches and the agent allowlist', () => {
    const c = resolveConfig(
      {
        policy: { watchAllowlist: [{ channel: 'lark-bot', conversationKind: 'group' }] },
        watches: [{ id: 'g', source: { channel: 'lark-bot', conversation: 'oc_1' }, target: { sessionKey: 'main' }, mode: 'digest', digest: { everyMs: 60000 } }],
      },
      { env: {}, baseDir: '/b', cwd: '/w' },
    );
    expect(c.policy.watchAllowlist).toEqual([{ channel: 'lark-bot', conversationKind: 'group' }]);
    expect(c.watches.map((w) => w.id)).toEqual(['g']);
    expect(() => resolveConfig({ watches: [{ source: { channel: 'x' }, target: { sessionKey: 'm' }, mode: 'context' }] }, { env: {}, baseDir: '/b' })).toThrow(ConfigError);
    expect(() => resolveConfig({ policy: { watchAllowlist: [{ chanel: 'x' }] } }, { env: {}, baseDir: '/b' })).toThrow(ConfigError);
  });
});
