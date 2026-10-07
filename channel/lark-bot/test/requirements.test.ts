import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LarkBotAdapter } from '../src/index.js';
import { APP_CALLBACKS, APP_EVENTS, REGISTERABLE_HANDLERS, TENANT_SCOPES, scopesJson } from '../src/requirements.js';
import { FakeLark, startAdapter, tick } from './fake-lark.js';

describe('requirements', () => {
  it('lists every handler the adapter registers', async () => {
    const lark = new FakeLark();
    const adapter = new LarkBotAdapter({ appId: 'cli_x', appSecret: 's', domain: 'feishu' }, { deps: lark.deps });
    const run = startAdapter(adapter);
    await tick();
    const registered = [...lark.handlers.keys()];
    expect(registered.length).toBeGreaterThan(0);
    for (const k of registered) expect(REGISTERABLE_HANDLERS, `adapter registers ${k}`).toContain(k);
    run.ctl.abort();
    await run.done;
  });

  it('source scan: every key passed to dispatcher.register is declared', () => {
    const src = readFileSync(new URL('../src/adapter.ts', import.meta.url), 'utf8');
    const block = /dispatcher\.register\(\{([\s\S]*?)\}\);/.exec(src)?.[1] ?? '';
    const keys = [...block.matchAll(/'([^']+)'\s*:/g)].map((m) => m[1]!);
    expect(keys.length).toBeGreaterThan(0);
    for (const k of keys) expect(REGISTERABLE_HANDLERS).toContain(k);
  });

  it('exports a batch-import json from the same list', () => {
    expect(scopesJson().scopes.tenant).toEqual(TENANT_SCOPES.map((s) => s.name));
    expect(APP_EVENTS).toContain('im.message.receive_v1');
    expect(APP_CALLBACKS).toContain('card.action.trigger');
  });
});
