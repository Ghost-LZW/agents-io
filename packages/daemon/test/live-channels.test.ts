import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AdminConfigPutResult, AdminLarkBotJob, check, type AdminConfigDocument } from '@agents-io/protocol';
import { FakeChannel } from '@agents-io/testkit';
import type { ResolvedChannel } from '../src/config.js';
import { daemon, tmp, until } from './helpers.js';

const RAW_CHILD = fileURLToPath(new URL('../../../channel/jsonl-bridge/test/fixtures/raw_child.mjs', import.meta.url));
const FAKE_BOT = fileURLToPath(new URL('./fixtures/fake-create-lark-bot.mjs', import.meta.url));

type Api = (path: string, init?: { method?: string; json?: unknown }) => Promise<{ status: number; body: any }>;

async function live(o: { liveChannels?: boolean; raw?: Record<string, unknown>; consoleEnv?: NodeJS.ProcessEnv; channelAdapter?: (ch: ResolvedChannel) => FakeChannel | undefined } = {}) {
  const raw = o.raw ?? {};
  const w = await daemon({
    console: true,
    raw: { ...raw, console: { port: 0, ...(o.liveChannels !== false ? { liveChannels: true } : {}), ...((raw.console as object) ?? {}) } },
    ...(o.consoleEnv ? { consoleEnv: o.consoleEnv } : {}),
    ...(o.channelAdapter ? { channelAdapter: o.channelAdapter } : {}),
  });
  const api: Api = async (path, init = {}) => {
    const r = await fetch(w.gw.console!.url + path, {
      method: init.method ?? 'GET',
      headers: { Authorization: `Bearer ${w.gw.token}`, ...(init.json !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      ...(init.json !== undefined ? { body: JSON.stringify(init.json) } : {}),
    });
    const text = await r.text();
    return { status: r.status, body: text ? JSON.parse(text) : undefined };
  };
  const doc = async () => (await api('/api/config')).body as AdminConfigDocument;
  const put = async (config: Record<string, unknown>) => {
    const r = await api('/api/config', { method: 'PUT', json: { config } });
    expect(r.status).toBe(200);
    expect(check(AdminConfigPutResult, r.body)).toBe(true);
    return r.body as AdminConfigPutResult;
  };
  const status = () => w.gw.adminStatus().channels;
  return { w, api, doc, put, status };
}

const bridge = (account: string, extra: Record<string, unknown> = {}) => ({ type: 'bridge', id: 'raw', account, command: process.execPath, args: [RAW_CHILD], ...extra });
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe('console.liveChannels', () => {
  it('off (default): a channel added by PUT waits for a restart, as before', async () => {
    const { doc, put, status } = await live({ liveChannels: false });
    const d = await doc();
    const r = await put({ ...d.config, channels: [bridge('b1')] });
    expect(r.applied).toBe('restart');
    expect(r.channels).toBeUndefined();
    expect(status().map((c) => c.account)).toEqual(['default']);
  });

  it('starts added channels, restarts changed ones, keeps unchanged ones, stops removed ones', async () => {
    const pids = join(tmp(), 'pids');
    // Env values are credentials: the console takes references only.
    const { doc, put, status } = await live({ consoleEnv: { T_PIDS: pids } });
    const d = await doc();
    const one = bridge('b1', { env: { PIDS_FILE: 'env:T_PIDS' } });
    const two = bridge('b2', { env: { PIDS_FILE: 'env:T_PIDS' } });

    const r1 = await put({ ...d.config, channels: [one, two] });
    expect(r1).toMatchObject({ applied: 'live', channels: { started: [{ type: 'bridge', account: 'b1' }, { type: 'bridge', account: 'b2' }], stopped: [] } });
    await until(() => status().filter((c) => c.id === 'raw' && c.state === 'running').length === 2);
    await until(() => existsSync(pids) && readFileSync(pids, 'utf8').trim().split('\n').length === 2);
    const [p1, p2] = readFileSync(pids, 'utf8').trim().split('\n').map(Number);

    // Same document again: nothing to do.
    const again = await put((await doc()).config);
    expect(again).toMatchObject({ applied: 'live', channels: { started: [], stopped: [] } });

    // b1 changes (its args), b2 is removed.
    const r2 = await put({ ...(await doc()).config, channels: [bridge('b1', { env: { PIDS_FILE: 'env:T_PIDS' }, args: [RAW_CHILD, 'v2'] })] });
    expect(r2).toMatchObject({ applied: 'live', channels: { started: [{ type: 'bridge', account: 'b1' }], stopped: [{ type: 'bridge', account: 'b1' }, { type: 'bridge', account: 'b2' }] } });
    await until(() => !alive(p1!) && !alive(p2!), 5000);
    await until(() => readFileSync(pids, 'utf8').trim().split('\n').length === 3);
    expect(status().filter((c) => c.id === 'raw').map((c) => c.account)).toEqual(['b1']);
    // The in-process channel is never touched.
    expect(status().find((c) => c.id === 'fake')).toMatchObject({ state: 'running' });

    // Everything removed.
    const r3 = await put({ ...(await doc()).config, channels: [] });
    expect(r3.channels!.stopped).toEqual([{ type: 'bridge', account: 'b1' }]);
    expect(status().map((c) => c.id)).toEqual(['fake']);
  });

  it('with another change pending, channels still apply live and the answer says restart; undoing it says live', async () => {
    const { doc, put, status } = await live();
    const d = await doc();
    const r = await put({ ...d.config, outputTools: false, channels: [bridge('b1')] });
    expect(r).toMatchObject({ applied: 'restart', channels: { started: [{ type: 'bridge', account: 'b1' }] } });
    await until(() => status().some((c) => c.account === 'b1' && c.state === 'running'));
    const { outputTools: _o, ...back } = (await doc()).config as Record<string, unknown>;
    expect(await put(back)).toMatchObject({ applied: 'live', channels: { started: [], stopped: [] } });
  });

  it('sessions already open render to a channel started live', async () => {
    const made: FakeChannel[] = [];
    const { w, doc, put } = await live({ channelAdapter: (ch) => (ch.type === 'bridge' ? (made.push(new FakeChannel('extra')), made.at(-1)) : undefined) });
    await w.chat.inject({ text: 'hello', sender: { channelUserId: 'alice', evidence: 'platform_signed' } as never });
    await until(() => (w.gw as any).lanes.size > 0);
    const before = (w.gw as any).compositors.length as number;
    await put({ ...(await doc()).config, channels: [bridge('x1')] });
    expect(made).toHaveLength(1);
    const lanes = (w.gw as any).lanes.size as number;
    expect((w.gw as any).compositors.length).toBe(before + lanes);
    await put({ ...(await doc()).config, channels: [] });
    expect((w.gw as any).compositors.length).toBe(before);
  });

  it('a lark-bot channel provisioned by POST /api/bots/lark starts at once', async () => {
    const argsOut = join(tmp(), 'args.json');
    const made: FakeChannel[] = [];
    const { api, status } = await live({
      raw: { console: { larkBotCommand: [process.execPath, FAKE_BOT] } },
      consoleEnv: { FAKE_ARGS_OUT: argsOut, PATH: process.env.PATH! },
      channelAdapter: (ch) => (ch.type === 'lark-bot' ? (made.push(new FakeChannel('lark-bot')), made.at(-1)) : undefined),
    });
    const r = await api('/api/bots/lark', { method: 'POST', json: { name: 'Ops Bot', account: 'proj-a' } });
    expect(r.status).toBe(202);
    const id = r.body.job as string;
    let j: AdminLarkBotJob | undefined;
    await until(() => existsSync(argsOut), 5000);
    for (let i = 0; i < 200 && j?.state !== 'waiting_scan'; i++) {
      j = (await api(`/api/bots/lark/${id}`)).body;
      await new Promise((res) => setTimeout(res, 20));
    }
    const argv = JSON.parse(readFileSync(argsOut, 'utf8')) as string[];
    writeFileSync(`${argv[argv.indexOf('--qr-out') + 1]}.scanned`, '');
    for (let i = 0; i < 300 && j?.state !== 'succeeded' && j?.state !== 'failed'; i++) {
      j = (await api(`/api/bots/lark/${id}`)).body;
      await new Promise((res) => setTimeout(res, 20));
    }
    expect(check(AdminLarkBotJob, j)).toBe(true);
    expect(j).toMatchObject({ state: 'succeeded', message: expect.stringContaining('the channel is started'), result: { account: 'proj-a', channelAdded: true, channelStarted: true } });
    expect(made).toHaveLength(1);
    expect(status().find((c) => c.id === 'lark-bot')).toEqual({ id: 'lark-bot', account: 'proj-a', state: 'running' });
  });
});
