import { describe, expect, it } from 'vitest';
import { ADMIN_ENDPOINTS } from '@agents-io/protocol';
import { AdminLarkBotJob, AdminLarkBotRequest, AdminLarkBotStarted, LARK_BOT_ADMIN_ENDPOINTS } from '../src/admin.js';
import { larkBotChannelModule } from '../src/module.js';
import { CREATE_LARK_BOT, larkBotAdmin } from '../src/provision-admin.js';

describe('admin API', () => {
  it('lists its admin endpoints once, with schemas, none shared with ADMIN_ENDPOINTS #PR-1', () => {
    const key = (e: { method: string; path: string }) => `${e.method} ${e.path}`;
    const mine = LARK_BOT_ADMIN_ENDPOINTS.map(key);
    expect(mine).toEqual(['POST /api/bots/lark', 'GET /api/bots/lark/:job']);
    // What the daemon's console serves: the core endpoints and this module's, each once.
    const all = [...ADMIN_ENDPOINTS, ...LARK_BOT_ADMIN_ENDPOINTS].map(key);
    expect(new Set(all).size).toBe(all.length);
    for (const k of ['GET /api/status', 'GET /api/sessions', 'POST /api/bots/lark', 'GET /api/bots/lark/:job']) expect(all).toContain(k);
    expect(LARK_BOT_ADMIN_ENDPOINTS[0]).toMatchObject({ body: AdminLarkBotRequest, status: 202, response: AdminLarkBotStarted });
    expect(LARK_BOT_ADMIN_ENDPOINTS[1]).toMatchObject({ status: 200, response: AdminLarkBotJob });
    for (const e of LARK_BOT_ADMIN_ENDPOINTS) {
      expect(e.response).toBeTypeOf('object');
      if (e.method === 'GET') expect('body' in e).toBe(false);
    }
  });

  it('contributes them as routes from its channel module, with their schemas and console.larkBotCommand (default the pinned create-lark-bot) #PR-1', () => {
    expect(larkBotChannelModule.admin).toBe(larkBotAdmin);
    const routes = larkBotAdmin.routes ?? [];
    expect(routes.map(({ handle: _handle, ...e }) => e)).toEqual([...LARK_BOT_ADMIN_ENDPOINTS]);
    for (const r of routes) expect(r.handle).toBeTypeOf('function');
    // What `pnpm schema` writes to channel/lark-bot/schema/.
    expect(larkBotAdmin.schemas).toEqual({ AdminLarkBotRequest, AdminLarkBotStarted, AdminLarkBotJob });
    expect(Object.keys(larkBotAdmin.console ?? {})).toEqual(['larkBotCommand']);
    expect(larkBotAdmin.console!.larkBotCommand).toMatchObject({ type: 'array', minItems: 1, items: { type: 'string' }, default: CREATE_LARK_BOT });
    expect(CREATE_LARK_BOT).toEqual(['npx', '-y', 'github:Ghost-LZW/create-lark-bot#v0.2.4']);
  });
});
