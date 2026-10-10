import { describe, expect, it } from 'vitest';
import { APP_CALLBACKS, APP_EVENTS, TENANT_SCOPES, scopesJson } from '../src/requirements.js';

describe('requirements', () => {
  it('exports a batch-import json from the same list', () => {
    expect(scopesJson().scopes.tenant).toEqual(TENANT_SCOPES.map((s) => s.name));
    expect(APP_EVENTS).toContain('im.message.receive_v1');
    expect(APP_CALLBACKS).toContain('card.action.trigger');
  });
});
