import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { HarnessEvent } from '@agents-io/protocol';
import { isBypassModel, permissionModeFor } from '../src/index.js';
import type { ClaudeCodeOptions, ClaudeProfile } from '../src/types.js';
import { collectUntil, input, isTurnCompleted, sdk } from './fake-query.js';
import { run, setup, uuidOf } from './claude-code-helpers.js';

// HC-5: a profile with `bypassModels` runs in bypass on those models and in its own mode on any other,
// decided at each turn's start from the model the CLI really runs; a model change within a turn only tightens.

const MS = 25;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const reviewed: ClaudeProfile = {
  permissionMode: 'default',
  permissionPrompts: 'host',
  bypassModels: ['opus', 'claude-opus-*'],
  allowedTools: ['Read', 'Grep'],
};
const opts: ClaudeCodeOptions = { profiles: { reviewed }, firstByteTimeoutMs: 0 };
const SONNET = { ...run, model: 'claude-sonnet-5-5', profile: 'reviewed' };
const OPUS = { ...run, model: 'claude-opus-5-5', profile: 'reviewed' };

const isMode = (e: HarnessEvent) => e.body.t === 'native' && e.body.name === 'system/permission_mode';
const modeCalls = (q: { calls: { method: string; arg?: unknown }[] }) =>
  q.calls.filter((c) => c.method === 'setPermissionMode').map((c) => c.arg);

async function finishTurn(ctx: Awaited<ReturnType<typeof setup>>, i: number) {
  await ctx.q.waitWritten(i + 1);
  ctx.q.push(sdk.result({ uuids: [uuidOf(ctx.q, i)] }));
  return collectUntil(ctx.it, isTurnCompleted);
}

describe('permission mode by model', () => {
  it('matching: exact names and a trailing * prefix; with bypassModels a profile never bypasses on another model #HC-5', () => {
    expect(isBypassModel(reviewed, 'opus')).toBe(true);
    expect(isBypassModel(reviewed, 'claude-opus-5-5')).toBe(true);
    expect(isBypassModel(reviewed, 'claude-sonnet-5-5')).toBe(false);
    expect(isBypassModel(reviewed, 'opusx')).toBe(false);
    expect(isBypassModel({ bypassModels: ['*'] }, 'anything')).toBe(false);
    expect(permissionModeFor(reviewed, 'gemini-3.8-flash-high')).toBe('default');
    expect(permissionModeFor({ permissionMode: 'bypassPermissions', bypassModels: ['opus'] }, 'sonnet')).toBe('default');
    expect(permissionModeFor({ permissionMode: 'bypassPermissions' }, 'sonnet')).toBe('bypassPermissions');
  });

  it('a Sonnet session launches reviewed (default, prompts to the host) but may enter bypass later; an Opus one launches in bypass and keeps canUseTool #HC-5', async () => {
    const a = await setup({ run: SONNET }, opts);
    expect(a.q.options.permissionMode).toBe('default');
    expect(a.q.options.allowDangerouslySkipPermissions).toBe(true);
    expect(typeof a.q.options.canUseTool).toBe('function');
    expect(a.q.options.permissionPrompts).toBe('host');
    expect(a.q.options.allowedTools).toEqual(['Read', 'Grep']);
    const b = await setup({ run: OPUS }, opts);
    expect(b.q.options.permissionMode).toBe('bypassPermissions');
    expect(b.q.options.allowDangerouslySkipPermissions).toBe(true);
    expect(typeof b.q.options.canUseTool).toBe('function');
    // A plain bypass profile is launched as before: no canUseTool.
    const c = await setup({}, { profiles: { bypass: { permissionMode: 'bypassPermissions' } } });
    expect(c.q.options.canUseTool).toBeUndefined();
  });

  it('each turn starts in the mode of its model, and the host hears it after turn.started #HC-5', async () => {
    const ctx = await setup({ run: SONNET }, opts);
    ctx.give('t1', 'a');
    await ctx.s.startTurn('t1', [input('a', 'x')], SONNET);
    expect(modeCalls(ctx.q)).toEqual([]);
    let evs = await finishTurn(ctx, 0);
    const first = evs.find(isMode)!;
    expect(evs.findIndex(isMode)).toBeGreaterThan(evs.findIndex((e) => e.body.t === 'turn.started'));
    expect(first.native).toMatchObject({ permission_mode: 'default', previous_mode: 'default', model: 'claude-sonnet-5-5', trigger: 'turn_start', source: 'agents-io' });
    expect(first.turnId).toBe('t1');

    ctx.give('t2', 'b');
    await ctx.s.startTurn('t2', [input('b', 'y')], OPUS);
    expect(ctx.q.calls.map((c) => c.method)).toEqual(['setModel', 'setPermissionMode']);
    expect(modeCalls(ctx.q)).toEqual(['bypassPermissions']);
    evs = await finishTurn(ctx, 1);
    expect(evs.find(isMode)!.native).toMatchObject({ permission_mode: 'bypassPermissions', previous_mode: 'default', model: 'claude-opus-5-5' });

    ctx.give('t3', 'c');
    await ctx.s.startTurn('t3', [input('c', 'z')], SONNET);
    expect(modeCalls(ctx.q)).toEqual(['bypassPermissions', 'default']);
    await finishTurn(ctx, 2);
    ctx.conform();
  });

  it('within a turn: Opus falling back to Sonnet leaves bypass at once; Sonnet falling back to Opus stays reviewed; the next turn follows its own model again #HC-5', async () => {
    const ctx = await setup({ run: OPUS }, opts);
    ctx.give('t1', 'a');
    await ctx.s.startTurn('t1', [input('a', 'x')], OPUS);
    ctx.q.push(sdk.system('model_fallback', { trigger: 'overloaded', original_model: 'claude-opus-5-5', fallback_model: 'claude-sonnet-5-5' }));
    const evs = await collectUntil(ctx.it, (e) => isMode(e) && (e.native as { trigger?: string }).trigger === 'model_fallback');
    expect(modeCalls(ctx.q)).toEqual(['default']);
    expect(evs.at(-1)!.native).toMatchObject({ permission_mode: 'default', previous_mode: 'bypassPermissions', model: 'claude-sonnet-5-5' });
    await finishTurn(ctx, 0);

    // Claude Code tries its primary model again at the next turn: back in bypass.
    ctx.give('t2', 'b');
    await ctx.s.startTurn('t2', [input('b', 'y')], OPUS);
    expect(modeCalls(ctx.q)).toEqual(['default', 'bypassPermissions']);
    await finishTurn(ctx, 1);

    const b = await setup({ run: SONNET }, opts);
    b.give('t1', 'a');
    await b.s.startTurn('t1', [input('a', 'x')], SONNET);
    b.q.push(sdk.system('model_fallback', { trigger: 'overloaded', original_model: 'claude-sonnet-5-5', fallback_model: 'claude-opus-5-5' }));
    await wait(MS);
    expect(modeCalls(b.q)).toEqual([]);
    await finishTurn(b, 0);
    ctx.conform();
    b.conform();
  });

  it('a refusal fallback that keeps the session on another model decides the next turn too; a subagent-local one changes nothing #HC-5', async () => {
    const ctx = await setup({ run: OPUS }, opts);
    ctx.give('t1', 'a');
    await ctx.s.startTurn('t1', [input('a', 'x')], OPUS);
    ctx.q.push(sdk.system('model_refusal_fallback', { trigger: 'refusal', direction: 'retry', scope: 'local', original_model: 'claude-opus-5-5', fallback_model: 'claude-sonnet-5-5', request_id: null }));
    await wait(MS);
    expect(modeCalls(ctx.q)).toEqual([]);
    ctx.q.push(sdk.system('model_refusal_fallback', { trigger: 'refusal', direction: 'retry', scope: 'session', original_model: 'claude-opus-5-5', fallback_model: 'claude-sonnet-5-5', request_id: null }));
    await wait(MS);
    expect(modeCalls(ctx.q)).toEqual(['default']);
    await finishTurn(ctx, 0);
    // The CLI stays on Sonnet (run.model did not change, so no setModel): the turn starts reviewed.
    ctx.give('t2', 'b');
    await ctx.s.startTurn('t2', [input('b', 'y')], OPUS);
    expect(ctx.q.calls.filter((c) => c.method === 'setModel')).toEqual([]);
    expect(modeCalls(ctx.q)).toEqual(['default']);
    const evs = await finishTurn(ctx, 1);
    expect(evs.find(isMode)!.native).toMatchObject({ permission_mode: 'default', model: 'claude-sonnet-5-5', trigger: 'turn_start' });
    ctx.conform();
  });

  it('the first-byte watchdog moving an Opus turn to Sonnet tightens it too #HC-5 #HC-3', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aio-pm-'));
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ fallbackModel: ['claude-sonnet-5-5'] }));
    const ctx = await setup({ run: OPUS, env: { CLAUDE_CONFIG_DIR: dir } }, { ...opts, firstByteTimeoutMs: MS }, { settingSources: ['user'] });
    await ctx.s.startTurn('t1', [input('a', 'x')], OPUS);
    await collectUntil(ctx.it, (e) => isMode(e) && (e.native as { trigger?: string }).trigger === 'first_byte_timeout');
    expect(ctx.q.calls.map((c) => c.method)).toEqual(['interrupt', 'setModel', 'setPermissionMode']);
    expect(modeCalls(ctx.q)).toEqual(['default']);
  });

  it('when the CLI does not take the tighter mode the turn is stopped, not run on in bypass #HC-5', async () => {
    const ctx = await setup({ run: OPUS }, opts);
    ctx.q.setPermissionMode = async (mode: unknown) => {
      ctx.q.calls.push({ method: 'setPermissionMode', arg: mode });
      throw new Error('control request failed');
    };
    await ctx.s.startTurn('t1', [input('a', 'x')], OPUS);
    ctx.q.push(sdk.system('model_fallback', { trigger: 'overloaded', original_model: 'claude-opus-5-5', fallback_model: 'claude-sonnet-5-5' }));
    const evs = await collectUntil(ctx.it, (e) => e.body.t === 'notice' && /could not leave bypassPermissions/.test((e.body as { message: string }).message));
    expect(evs.length).toBeGreaterThan(0);
    await wait(MS);
    expect(ctx.q.calls.map((c) => c.method)).toContain('interrupt');
  });

  it('profiles without bypassModels behave as before: no mode events, no mode calls at a turn start #HC-5', async () => {
    const ctx = await setup({}, { profiles: { bypass: { permissionMode: 'bypassPermissions' } } });
    ctx.give('t1', 'a');
    await ctx.s.startTurn('t1', [input('a', 'x')]);
    ctx.q.push(sdk.system('model_fallback', { trigger: 'overloaded', original_model: 'haiku', fallback_model: 'claude-sonnet-5-5' }));
    const evs = await finishTurn(ctx, 0);
    expect(evs.some(isMode)).toBe(false);
    expect(modeCalls(ctx.q)).toEqual([]);
  });
});
