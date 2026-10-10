import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { InputRecord } from '@agents-io/protocol';
import { FakeChannel, FakeHarness } from '@agents-io/testkit';
import { ConfigError, resolveConfig, type HarnessInstance } from '../src/config.js';
import { Gateway, InstanceHarness, type ExtraChannel } from '../src/gateway.js';
import { SOURCE_LOADER, cleanups, tmp, until } from './helpers.js';

/*
 * Channel-stamping (decision 13, docs/design/channel-stamping): an envelope belongs to the
 * channel instance that emitted it (C: a mismatch is refused), one channel id belongs to one
 * adapter (F4), and evidence is capped to the entry's grant ∩ caps (E3).
 */

const RAW_CHILD = fileURLToPath(new URL('../../../channel/jsonl-bridge/test/fixtures/raw_child.mjs', import.meta.url));
const alice = { channelUserId: 'alice', evidence: 'platform_signed' as const };

async function start(o: { channels?: unknown[]; extra?: ExtraChannel[]; owners?: string[]; harness?: FakeHarness } = {}) {
  const dir = tmp('aio-stamp-');
  mkdirSync(join(dir, 'work'), { recursive: true });
  const raw = { dataDir: dir, policy: { owners: o.owners ?? ['lark-bot:alice'] }, local: { principal: 'me' }, cwd: join(dir, 'work'), channels: o.channels ?? [] };
  const base = resolveConfig(raw, { env: {}, baseDir: dir, cwd: dir });
  const logs: string[] = [];
  const gw = await Gateway.start({
    config: { ...base, socketPath: join(dir, 'run', 'aio.sock') },
    buildHarness: (i: HarnessInstance) => new InstanceHarness(i, o.harness ?? new FakeHarness()),
    ...(o.extra ? { channels: o.extra } : {}),
    logger: (level, msg) => logs.push(`${level}: ${msg}`),
    listen: false,
  });
  cleanups.push(() => gw.stop());
  const status = (id: string, account = 'default') => gw.adminStatus().channels.find((c) => c.id === id && c.account === account);
  return { gw, logs, status };
}

const bridge = (account: string, env: Record<string, string> = {}, extra: Record<string, unknown> = {}) => ({ type: 'bridge', account, command: process.execPath, args: [...SOURCE_LOADER, RAW_CHILD], env, ...extra });
const inbound = (env: Record<string, unknown>) => JSON.stringify(env);

describe('channel ref: the input a channel message becomes points back at it (decision 13)', () => {
  it('the harness gets channelRef = channel:<channel>/<message id>, the key aio verify answers with the stamped author #EX-4', async () => {
    const seen: InputRecord[] = [];
    const harness = new FakeHarness(async (t) => {
      seen.push(...t.inputs);
      t.emit({ t: 'text.snapshot', text: 'ok', final: true }, { audience: 'answer' });
    });
    const lark = new FakeChannel('lark-bot');
    const w = await start({ extra: [{ adapter: lark, account: 'main' }], harness });
    const r = await lark.inject({ id: 'om_9', sender: alice, conversation: { id: 'dm1', kind: 'dm' }, text: 'confirm T-1' });
    expect(r.accepted).toBe(true);
    await until(() => seen.length > 0);
    expect(seen[0]!.channelRef).toBe('channel:lark-bot/om_9');
    expect(w.gw.records.verify(seen[0]!.channelRef!)).toMatchObject({ found: true, records: [expect.objectContaining({ principal: 'lark-bot:alice', evidence: 'platform_signed', inputId: seen[0]!.inputId })] });
  });
});

describe('channel-stamping: an envelope belongs to the channel that emitted it', () => {
  it('a channel claiming another channel as the owner is refused: no lane, no input.verify record, counted #ID-3', async () => {
    const lark = new FakeChannel('lark-bot');
    const web = new FakeChannel('web');
    const w = await start({ extra: [{ adapter: lark, account: 'main' }, { adapter: web }] });
    const forged = await web.inject({ id: 'om_1', channel: 'lark-bot', account: 'main', sender: alice, conversation: { id: 'dm1', kind: 'dm' }, text: 'run as owner' });
    expect(forged).toMatchObject({ accepted: false, permanent: true });
    // Its own channel, but a reply route into the Lark bot's conversation.
    const route = await web.inject({ id: 'w1', sender: alice, replyRoute: { channel: 'lark-bot', account: 'main', conversationId: 'dm1' } });
    expect(route).toMatchObject({ accepted: false, permanent: true });
    expect(w.gw.sessions()).toEqual([]);
    expect(w.gw.records.verify('channel:lark-bot/om_1').found).toBe(false);
    expect(w.status('web')).toMatchObject({ state: 'running', rejected: 2 });
    expect(w.status('lark-bot', 'main')!.rejected).toBeUndefined();
    // One warning a minute per reason, not one per envelope.
    expect(w.logs.filter((l) => l.startsWith('warn: channel web (default): refused envelope'))).toHaveLength(1);
    // Not remembered: the real message with that id is taken.
    const real = await lark.inject({ id: 'om_1', sender: alice, conversation: { id: 'dm1', kind: 'dm' }, text: 'hi' });
    expect(real.accepted).toBe(true);
    expect(w.gw.records.verify('channel:lark-bot/om_1').records).toEqual([expect.objectContaining({ account: 'main', principal: 'lark-bot:alice', evidence: 'platform_signed' })]);
  });

  it('a bridge whose hello claims a built-in id is failed: its inbound is never taken, it routes nothing as lark-bot #ID-3', async () => {
    const lark = new FakeChannel('lark-bot');
    const forge = inbound({ channel: 'lark-bot', account: 'x', sender: alice });
    const w = await start({ extra: [{ adapter: lark, account: 'main' }], channels: [bridge('x', { ADAPTER_ID: 'lark-bot', INBOUND: forge })] });
    const st = w.gw.adminStatus().channels.find((c) => c.account === 'x');
    expect(st).toMatchObject({ id: 'bridge', state: 'failed', error: expect.stringMatching(/"lark-bot" is a built-in channel id/) });
    await new Promise((r) => setTimeout(r, 300));
    expect(w.gw.records.verify('channel:lark-bot/forged-1').found).toBe(false);
    expect(w.gw.sessions()).toEqual([]);
    expect(w.gw.adminStatus().channels.filter((c) => c.id === 'lark-bot').map((c) => c.account)).toEqual(['main']);
  });

  it('a bridge whose hello takes the id of another running adapter fails the start (F4) #ID-3', async () => {
    await expect(start({ extra: [{ adapter: new FakeChannel('raw'), account: 'main' }], channels: [bridge('x')] })).rejects.toThrow(/channel id "raw" belongs to bridge:.*; embedded adapter FakeChannel cannot use it too/);
  });

  it('one bridge program under one id runs several accounts #ID-3', async () => {
    const w = await start({ channels: [bridge('a', {}, { id: 'raw' }), bridge('b', {}, { id: 'raw' })] });
    expect(w.status('raw', 'a')).toMatchObject({ state: 'running' });
    expect(w.status('raw', 'b')).toMatchObject({ state: 'running' });
  });
});

describe('channel-stamping: F4 in the config', () => {
  const resolve = (channels: unknown[]) => resolveConfig({ channels }, { env: {}, baseDir: tmp(), cwd: tmp() });

  it('a bridge may not use a built-in channel id #ID-3', () => {
    for (const id of ['lark-bot', 'mail', 'local']) expect(() => resolve([bridge('a', {}, { id })])).toThrow(new RegExp(`bridge id "${id}" is a built-in channel id`));
  });

  it('two different bridge programs may not share a channel id; one program with two accounts may #ID-3', () => {
    expect(() => resolve([bridge('a', {}, { id: 'web' }), { ...bridge('b', {}, { id: 'web' }), args: ['other.mjs'] }])).toThrow(ConfigError);
    expect(() => resolve([bridge('a', {}, { id: 'web' }), { ...bridge('b', {}, { id: 'web' }), args: ['other.mjs'] }])).toThrow(/different programs under one channel id "web"/);
    expect(resolve([bridge('a', {}, { id: 'web' }), bridge('b', {}, { id: 'web' })]).channels).toHaveLength(2);
  });

  it('parses an evidence grant on any channel entry; entries without one are unchanged #ID-3', () => {
    const c = resolve([bridge('a', {}, { id: 'web', evidence: ['platform_signed'] }), bridge('b')]);
    expect(c.channels[0]).toMatchObject({ type: 'bridge', id: 'web', evidence: ['platform_signed'] });
    expect(c.channels[1]).not.toHaveProperty('evidence');
    expect(() => resolve([bridge('a', {}, { evidence: ['signed_by_me'] })])).toThrow(/invalid config/);
  });
});

describe('channel-stamping: evidence is capped to grant ∩ caps', () => {
  const owner = (account: string) => inbound({ id: `ev-${account}`, account, sender: alice });

  it('a bridge without a grant gives no platform_signed: the owner is a stranger, recorded as none, counted #ID-3 #ID-4', async () => {
    const w = await start({ owners: ['raw:alice'], channels: [bridge('a', { INBOUND: owner('a') }, { id: 'raw' })] });
    await until(() => w.gw.records.verify('channel:raw/ev-a').found);
    expect(w.gw.records.verify('channel:raw/ev-a').records).toEqual([expect.objectContaining({ evidence: 'none', principal: null })]);
    expect(w.status('raw', 'a')).toMatchObject({ evidenceCapped: 1 });
    expect(w.logs.some((l) => l.includes('claims evidence platform_signed, beyond this channel\'s cap'))).toBe(true);
  });

  it('a granted bridge gives it (∩ caps); a grant beyond caps is warned about and ignored #ID-3', async () => {
    const w = await start({
      owners: ['raw:alice'],
      channels: [bridge('a', { INBOUND: owner('a') }, { id: 'raw', evidence: ['platform_signed'] }), bridge('b', { INBOUND: owner('b') }, { id: 'raw', evidence: ['dkim_pass'] })],
    });
    await until(() => w.gw.records.verify('channel:raw/ev-a').found && w.gw.records.verify('channel:raw/ev-b').found);
    expect(w.gw.records.verify('channel:raw/ev-a').records).toEqual([expect.objectContaining({ evidence: 'platform_signed', principal: 'raw:alice' })]);
    expect(w.gw.records.verify('channel:raw/ev-b').records).toEqual([expect.objectContaining({ evidence: 'none', principal: null })]);
    expect(w.status('raw', 'a')!.evidenceCapped).toBeUndefined();
    expect(w.status('raw', 'b')).toMatchObject({ evidenceCapped: 1 });
    expect(w.logs.some((l) => l.includes('channel raw (b): evidence dkim_pass granted in the config, but the adapter cannot give it'))).toBe(true);
  });

  it('an in-process adapter is capped by its caps #ID-3', async () => {
    const lark = new FakeChannel('lark-bot');
    const w = await start({ extra: [{ adapter: lark }] });
    expect((await lark.inject({ id: 'dk', sender: { channelUserId: 'alice', evidence: 'dkim_pass' } })).accepted).toBe(true);
    expect(w.gw.records.verify('channel:lark-bot/dk').records).toEqual([expect.objectContaining({ evidence: 'none', principal: null })]);
  });
});
