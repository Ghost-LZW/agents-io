import { statSync } from 'node:fs';
import { join } from 'node:path';
import { Type } from '@sinclair/typebox';
import { describe, expect, it } from 'vitest';
import { ADMIN_ENDPOINTS, check, type AdminContext, type ChannelModule, type HarnessModule } from '@agents-io/protocol';
import { bridgeChannelModule } from '@agents-io/channel-jsonl-bridge';
import { LARK_BOT_ADMIN_ENDPOINTS } from '@agents-io/channel-lark-bot';
import { mailChannelModule } from '@agents-io/channel-mail';
import { FakeChannel, FakeHarness } from '@agents-io/testkit';
import { builtinChannels } from '../src/bundle.js';
import { adminEndpoints } from '@agents-io/console';
import { ChannelRegistry, HarnessRegistry } from '@agents-io/kernel';
import { ConfigStore } from '../src/defaults.js';
import { consoleDaemon } from './console-helpers.js';

/*
 * Modules contribute admin routes and console settings (core-slimming G5): the console serves the
 * core endpoints, then the routes of its registry's channel types, then its harness kinds', with
 * the same auth.
 */

const key = (e: { method: string; path: string }) => `${e.method} ${e.path}`;

describe('the endpoint table is composed from the registry', () => {
  it('core endpoints, then each registered type\'s routes, each once: the built-in registry lists /api/bots/lark; one without lark-bot does not #PR-1', () => {
    const all = adminEndpoints(builtinChannels);
    const keys = all.map(key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toEqual([...ADMIN_ENDPOINTS.map(key), 'POST /api/bots/lark', 'GET /api/bots/lark/:job']);
    // The same endpoints as the module lists for clients, with their schemas, without handlers.
    expect(all.slice(ADMIN_ENDPOINTS.length)).toEqual([...LARK_BOT_ADMIN_ENDPOINTS]);
    for (const e of all) {
      expect(e.response).toBeTypeOf('object');
      expect('handle' in e).toBe(false);
      if (e.method === 'GET') expect('body' in e).toBe(false);
    }
    expect(adminEndpoints(new ChannelRegistry([mailChannelModule, bridgeChannelModule])).map(key)).toEqual(ADMIN_ENDPOINTS.map(key));
  });

  it('a daemon whose registry lacks lark-bot does not serve /api/bots/lark: it is an unknown route (the generic 404) #PR-1', async () => {
    const w = await consoleDaemon({ channelRegistry: new ChannelRegistry([mailChannelModule, bridgeChannelModule]) });
    expect(await w.api('/api/bots/lark', { method: 'POST', json: { name: 'Bot' } })).toMatchObject({ status: 404, body: { error: { code: 'not_found', message: 'no POST /api/bots/lark' } } });
    expect(await w.api('/api/bots/lark/lark_nope')).toMatchObject({ status: 404, body: { error: { code: 'not_found', message: 'no GET /api/bots/lark/lark_nope' } } });
    // The built-in registry serves them.
    const b = await consoleDaemon();
    expect(await b.api('/api/bots/lark/lark_nope')).toMatchObject({ status: 404, body: { error: { code: 'unknown_job', message: 'no provisioning job lark_nope' } } });
  });
});

describe('a module\'s routes', () => {
  it('are served after the core ones with the same auth: credentials needed, params decoded, the body checked against its schema; the handler gets the context its mount got #SE-3 #PR-1', async () => {
    const mounted: AdminContext[] = [];
    const seen: { params: Record<string, string>; body: unknown; ctx: AdminContext }[] = [];
    let closed = 0;
    const Note = Type.Object({ text: Type.String() });
    const notes: ChannelModule = {
      type: 'notes',
      entry: {},
      resolve: (e) => e,
      create: () => ({ adapter: new FakeChannel('notes') }),
      admin: {
        console: { notesLimit: Type.Integer({ minimum: 1, default: 3 }), notesTitle: Type.String({ default: 'Notes' }) },
        schemas: { Note },
        routes: [
          {
            method: 'POST',
            path: '/api/notes/:book',
            body: Note,
            status: 202,
            response: Note,
            handle: (req, ctx) => {
              seen.push({ ...req, ctx });
              return { status: 202, body: req.body };
            },
          },
          {
            method: 'GET',
            path: '/api/notes/:book',
            status: 200,
            response: Note,
            handle: async (req, ctx) => {
              seen.push({ ...req, ctx });
              if (req.params.book === 'boom') throw new Error('notes are on fire');
              return { status: 200, body: { text: req.params.book } };
            },
          },
          // A path the core serves (`aio console-link`'s): never reached, core routes come first.
          { method: 'POST', path: '/api/login-link', status: 200, response: Note, handle: () => ({ status: 200, body: { text: 'not core' } }) },
        ],
        mount: (ctx) => {
          mounted.push(ctx);
          return { close: () => void closed++ };
        },
      },
    };
    const w = await consoleDaemon({ channelRegistry: new ChannelRegistry([notes]), raw: { console: { notesLimit: 5 } } });
    // One context per contribution: its settings (written, else the schema's default), the private directory, the config file.
    expect(mounted).toHaveLength(1);
    const ctx = mounted[0]!;
    expect(ctx.console).toEqual({ notesLimit: 5, notesTitle: 'Notes' });
    expect(ctx.dir).toBe(join(w.dir, 'provision'));
    expect(statSync(ctx.dir).mode & 0o777).toBe(0o700);
    expect(ctx.config).toBeInstanceOf(ConfigStore);
    expect(ctx.applyChannels).toBeUndefined();

    // Credentials as for every /api route.
    expect(await w.api('/api/notes/a', { token: null })).toMatchObject({ status: 401, body: { error: { code: 'unauthorized' } } });
    expect(await w.api('/api/notes/a', { method: 'POST', json: { text: 'x' }, token: 'nope' })).toMatchObject({ status: 401 });
    expect(seen).toEqual([]);
    // Parameters decoded; the last one takes the rest of the path, as the core's do.
    expect(await w.api('/api/notes/a%20b')).toMatchObject({ status: 200, body: { text: 'a b' } });
    expect(await w.api('/api/notes/a/b')).toMatchObject({ status: 200, body: { text: 'a/b' } });
    expect(await w.api('/api/notes/%E0')).toMatchObject({ status: 400, body: { error: { code: 'invalid_request', message: 'bad URL encoding' } } });
    // The body: JSON, valid against the route's schema.
    expect(await w.api('/api/notes/a', { method: 'POST', json: { text: 'hi' } })).toMatchObject({ status: 202, body: { text: 'hi' } });
    expect(await w.api('/api/notes/a', { method: 'POST', json: { text: 1 } })).toMatchObject({ status: 400, body: { error: { code: 'invalid_request' } } });
    expect(await w.api('/api/notes/a', { method: 'POST', body: 'text', headers: { 'Content-Type': 'text/plain' } })).toMatchObject({ status: 400, body: { error: { code: 'invalid_request', message: 'the body must be application/json' } } });
    // Another method, or a path it does not have: unknown.
    expect(await w.api('/api/notes/a', { method: 'PUT', json: {} })).toMatchObject({ status: 404, body: { error: { code: 'not_found', message: 'no PUT /api/notes/a' } } });
    expect(await w.api('/api/notes')).toMatchObject({ status: 404, body: { error: { code: 'not_found' } } });
    // A handler that throws: 500.
    expect(await w.api('/api/notes/boom')).toMatchObject({ status: 500, body: { error: { code: 'internal', message: 'notes are on fire' } } });
    // The core answers its own paths.
    const link = await w.api('/api/login-link', { method: 'POST', json: {} });
    expect(link.status).toBe(200);
    expect(link.body.url).toMatch(/#login=/);
    expect(check(Note, (await w.api('/api/notes/z')).body)).toBe(true);

    expect(seen.map((s) => [s.params, s.body])).toEqual([
      [{ book: 'a b' }, undefined],
      [{ book: 'a/b' }, undefined],
      [{ book: 'a' }, { text: 'hi' }],
      [{ book: 'boom' }, undefined],
      [{ book: 'z' }, undefined],
    ]);
    // The same context as the mount's, for every call.
    for (const s of seen) expect(s.ctx).toBe(ctx);
    expect(closed).toBe(0);
    await w.stop();
    expect(closed).toBe(1);
  });
});

describe('a harness kind\'s routes', () => {
  it('are served as a channel type\'s are, after them: listed once in the endpoint table, credentials needed, the body checked; its console settings, its own context for mount and handler, closed at stop #SE-3 #PR-1', async () => {
    const mounted: AdminContext[] = [];
    const seen: AdminContext[] = [];
    let closed = 0;
    const Page = Type.Object({ text: Type.String() });
    // A fixture harness kind: what it adds to the console is its `HarnessModule.admin`, as a channel type's `ChannelModule.admin`.
    const notebook: HarnessModule = {
      kind: 'notebook',
      schema: Type.Object({}),
      create: () => new FakeHarness(),
      admin: {
        console: { notebookPages: Type.Integer({ minimum: 1, default: 10 }), notebookTitle: Type.String({ default: 'Notebook' }) },
        schemas: { NotebookPage: Page },
        routes: [
          {
            method: 'GET',
            path: '/api/notebook/:page',
            status: 200,
            response: Page,
            handle: (req, ctx) => {
              seen.push(ctx);
              return { status: 200, body: { text: `${req.params.page} of ${String(ctx.console.notebookPages)}` } };
            },
          },
          {
            method: 'PUT',
            path: '/api/notebook/:page',
            body: Page,
            status: 200,
            response: Page,
            handle: (req, ctx) => {
              seen.push(ctx);
              return { status: 200, body: req.body };
            },
          },
        ],
        mount: (ctx) => {
          mounted.push(ctx);
          return { close: () => void closed++ };
        },
      },
    };
    const harnesses = new HarnessRegistry([notebook]);
    expect(harnesses.adminContributions.map((c) => c.kind)).toEqual(['notebook']);
    // The endpoint table: the core's, the channel types' (lark-bot's), then the harness kinds', each once, without handlers.
    const all = adminEndpoints(builtinChannels, harnesses);
    expect(all.map(key)).toEqual([...ADMIN_ENDPOINTS.map(key), 'POST /api/bots/lark', 'GET /api/bots/lark/:job', 'GET /api/notebook/:page', 'PUT /api/notebook/:page']);
    for (const e of all) expect('handle' in e).toBe(false);

    const w = await consoleDaemon({ harnessRegistry: harnesses, raw: { console: { notebookPages: 3 } } });
    // One context for the kind's contribution: its settings (written, else the schema default), the private directory, the config file.
    expect(mounted).toHaveLength(1);
    const ctx = mounted[0]!;
    expect(ctx.console).toEqual({ notebookPages: 3, notebookTitle: 'Notebook' });
    expect(ctx.dir).toBe(join(w.dir, 'provision'));
    expect(statSync(ctx.dir).mode & 0o777).toBe(0o700);
    expect(ctx.config).toBeInstanceOf(ConfigStore);

    // Credentials as for every /api route.
    expect(await w.api('/api/notebook/p1', { token: null })).toMatchObject({ status: 401, body: { error: { code: 'unauthorized' } } });
    expect(await w.api('/api/notebook/p1', { method: 'PUT', json: { text: 'x' }, token: 'nope' })).toMatchObject({ status: 401 });
    expect(seen).toEqual([]);
    const page = await w.api('/api/notebook/p%201');
    expect(page).toMatchObject({ status: 200, body: { text: 'p 1 of 3' } });
    expect(check(Page, page.body)).toBe(true);
    expect(await w.api('/api/notebook/p1', { method: 'PUT', json: { text: 1 } })).toMatchObject({ status: 400, body: { error: { code: 'invalid_request' } } });
    expect(await w.api('/api/notebook/p1', { method: 'PUT', json: { text: 'hi' } })).toMatchObject({ status: 200, body: { text: 'hi' } });
    expect(await w.api('/api/notebook/p1', { method: 'POST', json: { text: 'hi' } })).toMatchObject({ status: 404, body: { error: { code: 'not_found', message: 'no POST /api/notebook/p1' } } });
    // The channel types' routes are served beside them.
    expect(await w.api('/api/bots/lark/lark_nope')).toMatchObject({ status: 404, body: { error: { code: 'unknown_job', message: 'no provisioning job lark_nope' } } });
    // The same context as the mount's, for every call.
    expect(seen).toHaveLength(2);
    for (const s of seen) expect(s).toBe(ctx);
    expect(closed).toBe(0);
    await w.stop();
    expect(closed).toBe(1);
  });
});
