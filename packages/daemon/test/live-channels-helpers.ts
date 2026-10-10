import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';
import { AdminConfigPutResult, AdminLarkBotJob, check, type AdminConfigDocument } from '@agents-io/protocol';
import { FakeChannel } from '@agents-io/testkit';
import type { ResolvedChannel } from '../src/config.js';
import { SOURCE_LOADER, daemon, until } from './helpers.js';

export const RAW_CHILD = fileURLToPath(new URL('../../../channel/jsonl-bridge/test/fixtures/raw_child.mjs', import.meta.url));
export const FAKE_BOT = fileURLToPath(new URL('./fixtures/fake-create-lark-bot.mjs', import.meta.url));

export type Api = (path: string, init?: { method?: string; json?: unknown }) => Promise<{ status: number; body: any }>;

export async function live(o: { liveChannels?: boolean; raw?: Record<string, unknown>; consoleEnv?: NodeJS.ProcessEnv; channelAdapter?: (ch: ResolvedChannel) => FakeChannel | undefined; channelStartGraceMs?: number } = {}) {
  const raw = o.raw ?? {};
  const w = await daemon({
    console: true,
    raw: { ...raw, console: { port: 0, ...(o.liveChannels !== false ? { liveChannels: true } : {}), ...((raw.console as object) ?? {}) } },
    ...(o.consoleEnv ? { consoleEnv: o.consoleEnv } : {}),
    ...(o.channelAdapter ? { channelAdapter: o.channelAdapter } : {}),
    channelStartGraceMs: o.channelStartGraceMs ?? 100,
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

/** Run a provisioning job with the fake create-lark-bot to its end (scanning the QR code). */
export async function provision(api: Api, argsOut: string): Promise<AdminLarkBotJob> {
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
  return j!;
}

/** A channel whose start rejects right away (bad credentials, unreachable service). */
export class BrokenChannel extends FakeChannel {
  override async start(): Promise<void> {
    throw new Error('invalid app secret');
  }
}

export const bridge = (account: string, extra: Record<string, unknown> = {}) => ({ type: 'bridge', id: 'raw', account, command: process.execPath, args: [...SOURCE_LOADER, RAW_CHILD], ...extra });
export const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
