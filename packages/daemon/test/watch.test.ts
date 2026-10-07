import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION, type BodyOf, type SessionEvent } from '@agents-io/protocol';
import { FakeChannel, FakeHarness } from '@agents-io/testkit';
import { parseAttachLine } from '../src/attach.js';
import { CommandError, LocalClient } from '../src/client.js';
import { ConfigError, resolveConfig, type Config } from '../src/config.js';
import { parseClientFrame } from '../src/frames.js';
import { Gateway } from '../src/gateway.js';
import { WatchSpecError, formatWatch, parseDuration, parseWatchSpec } from '../src/watch-spec.js';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function until<T>(get: () => T | undefined | false, ms = 3000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = get();
    if (v !== undefined && v !== false) return v;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

const eve = { channelUserId: 'eve', evidence: 'platform_signed' as const };
const group = { id: 'g1', kind: 'group' as const };

function config(dir: string, raw: Record<string, unknown> = {}): Config {
  const base = resolveConfig({ policy: { owners: ['fake:alice'] }, local: { principal: 'me', session: 'main' }, logPath: join(dir, 'log.sqlite'), ...raw }, { env: {}, baseDir: dir, cwd: dir });
  return { ...base, socketPath: join(dir, 'run', 'aio.sock') };
}

async function start(dir: string, c: Config) {
  const chat = new FakeChannel('fake');
  const gw = await Gateway.start({ config: c, harness: new FakeHarness(), channels: [{ adapter: chat }], logger: () => {} });
  let stopped = false;
  const stop = async () => {
    if (!stopped) await gw.stop();
    stopped = true;
  };
  cleanups.push(stop);
  const client = await LocalClient.connect(c.socketPath);
  cleanups.push(() => client.close());
  return { gw, chat, client, stop };
}

function tmp() {
  const dir = mkdtempSync(join(tmpdir(), 'aio-w-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

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

  it('client watch frames validate', () => {
    const w = { source: { channel: 'x' }, target: { sessionKey: 's' }, mode: 'context' };
    expect(parseClientFrame({ v: PROTOCOL_VERSION, type: 'watch.add', id: '1', watch: w }).ok).toBe(true);
    expect(parseClientFrame({ v: PROTOCOL_VERSION, type: 'watch.remove', id: '2', watchId: 'w' }).ok).toBe(true);
    expect(parseClientFrame({ v: PROTOCOL_VERSION, type: 'watch.list', id: '3' }).ok).toBe(true);
    expect(parseClientFrame({ v: PROTOCOL_VERSION, type: 'watch.add', id: '4', watch: { ...w, mode: 'loud' } })).toMatchObject({ ok: false, id: '4' });
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

describe('gateway watches', () => {
  it('loads config watches; local client adds, lists and removes as the owner', async () => {
    const dir = tmp();
    const c = config(dir, { watches: [{ id: 'cfg', source: { channel: 'fake', conversation: 'g1' }, target: { sessionKey: 'main' }, mode: 'context' }] });
    const { gw, chat, client } = await start(dir, c);
    expect((await client.watchList()).map((w) => [w.id, w.createdBy])).toEqual([['cfg', 'me']]);
    const added = await client.watchAdd({ id: 'trig', source: { channel: 'fake', conversation: 'g2' }, target: { sessionKey: 'main' }, mode: 'trigger' });
    expect(added).toMatchObject({ id: 'trig', createdBy: 'me' });
    expect(formatWatch(added)).toMatch(/^trig\t→ main\tchannel=fake conversation=g2 mode=trigger\tby me/);
    expect((await client.watchList('main')).length).toBe(2);
    expect((await client.watchList('elsewhere')).length).toBe(0);
    await expect(client.watchAdd({ source: { channel: 'fake' }, target: { sessionKey: 'main' }, mode: 'digest' })).rejects.toThrow(CommandError);
    expect(await client.watchRemove('trig')).toEqual({ removed: true });
    expect(await client.watchRemove('trig')).toEqual({ removed: false });

    const sub = await client.subscribe({ sessionKey: 'main', tier: 'full', fromSeq: 0 });
    const events: SessionEvent[] = [];
    void (async () => {
      for await (const e of sub) events.push(e);
    })();
    await chat.inject({ sender: eve, conversation: group, text: 'overheard' });
    const a = await until(() => events.find((e) => e.body.t === 'input.admitted')?.body as BodyOf<'input.admitted'> | undefined);
    expect(a).toMatchObject({ disposition: 'observe_only', input: { channelContext: { watch: 'cfg' }, origin: { principal: null } } });
    // Agents are limited by the allowlist (empty here), the owner is not.
    const agent = { kind: 'agent' as const, principal: { id: 'session:main', labels: ['agent'] }, evidence: 'none' as const, via: 'mcp', adapter: 'mcp' };
    expect(await gw.addWatch(agent, { source: { channel: 'fake', conversationKind: 'group' }, target: { sessionKey: 'main' }, mode: 'context' })).toMatchObject({ ok: false, code: 'forbidden' });
  });

  it('agents may watch allowlisted sources (policy.watchAllowlist from config)', async () => {
    const dir = tmp();
    const c = config(dir, { policy: { owners: ['fake:alice'], watchAllowlist: [{ channel: 'fake', conversationKind: 'group' }] } });
    const { gw } = await start(dir, c);
    const agent = { kind: 'agent' as const, principal: { id: 'session:main', labels: ['agent'] }, evidence: 'none' as const, via: 'mcp', adapter: 'mcp' };
    expect(await gw.addWatch(agent, { source: { channel: 'fake', conversationKind: 'group' }, target: { sessionKey: 'main' }, mode: 'context' })).toMatchObject({ ok: true });
    expect(await gw.addWatch(agent, { source: { channel: 'fake', conversationKind: 'dm' }, target: { sessionKey: 'main' }, mode: 'context' })).toMatchObject({ ok: false });
  });

  it('a digest buffered before a gateway restart is delivered after it; it replies to the target home route', async () => {
    const dir = tmp();
    const c = config(dir);
    const one = await start(dir, c);
    // The owner talks to `main` locally first: that becomes its home route.
    await one.client.input('main', 'hello');
    await until(() => one.gw.hub.log.read('main', 0).some((e) => e.body.t === 'turn.completed'));
    await one.client.watchAdd({ id: 'dg', source: { channel: 'fake', conversation: 'g1' }, target: { sessionKey: 'main' }, mode: 'digest', digest: { everyMs: 300 } });
    await one.chat.inject({ sender: eve, conversation: group, text: 'first' });
    await one.chat.inject({ sender: eve, conversation: group, text: 'second' });
    await one.stop();

    const two = await start(dir, c);
    const started = await until(
      () => two.gw.hub.log.read('main', 0).filter((e) => e.body.t === 'turn.started').map((e) => e.body as BodyOf<'turn.started'>)[1],
      3000,
    );
    expect(started.replyRoute).toEqual({ channel: 'local', account: 'local', conversationId: 'main' });
    expect(started.run?.profile).toBe('restricted');
    const log = two.gw.hub.log.read('main', 0);
    const digest = log.map((e) => e.body).find((b): b is BodyOf<'input.admitted'> => b.t === 'input.admitted' && b.input?.origin.kind === 'system');
    expect((digest!.input!.content[0] as { text: string }).text).toMatch(/2 new items[\s\S]*first[\s\S]*second/);
    expect(log.some((e) => e.body.t === 'notice' && e.body.message.startsWith('watch dg: digest of 2 items'))).toBe(true);
  });
});
