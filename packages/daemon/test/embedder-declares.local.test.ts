import { describe, expect, it } from 'vitest';
import type { InputRecord } from '@agents-io/protocol';
import type { FakeTurnScript } from '@agents-io/testkit';
import { daemon, until, type World } from './helpers.js';

/*
 * Deprecated, kept for one release (packages/daemon/README.md, core-slimming G3): an adapter the
 * embedder passes (`GatewayOptions.harness` / `buildHarness`) that declares none of `displayName`,
 * `compact`, `modes`, `ownerProfileSwitch` gets its instance kind's declarations
 * (`HarnessModule.declares`) for the run-config commands, `/status` and `session.compact`, as
 * when these were decided by the instance's kind. One declaring any of them is read as it declares.
 */

const alice = { channelUserId: 'alice', evidence: 'platform_signed' as const };
const dm = { conversation: { id: 'c-alice', kind: 'dm' as const } };
const textOf = (i: InputRecord) => i.content.map((c) => (c.type === 'text' ? c.text : '')).join('');

/** Echoes, and records each turn's inputs (text, native). */
function recording() {
  const turns: { text: string; native: boolean }[][] = [];
  const script: FakeTurnScript = async (t) => {
    turns.push(t.inputs.map((i) => ({ text: textOf(i), native: i.channelContext.nativeCommand === true })));
    if (!t.inputs.some((i) => i.channelContext.nativeCommand)) t.emit({ t: 'text.snapshot', text: `echo: ${t.inputs.map(textOf).join(' ')}`, final: true }, { audience: 'answer' });
  };
  return { turns, script };
}

const replies = (w: World) => w.chat.sent.map((s) => s.edits.at(-1)?.text ?? s.msg.text);
async function say(w: World, text: string): Promise<string> {
  const before = replies(w).length;
  await w.chat.inject({ ...dm, sender: alice, text });
  // The first non-empty one (a compaction turn's card has no text).
  return until(() => replies(w).slice(before).find((r) => !!r));
}
async function liveSession(w: World): Promise<string> {
  await w.chat.inject({ ...dm, sender: alice, text: 'hello' });
  await until(() => replies(w).includes('echo: hello'));
  return until(() => w.gw.sessions().find((s) => s.live && !w.gw.hub.snapshot(s.sessionKey).turn)?.sessionKey);
}

describe("an embedder's adapter that declares nothing", () => {
  it('on a claude-code instance (buildHarness): session.compact and /compact send /compact as a turn of its own', async () => {
    const r = recording();
    const w = await daemon({ raw: { harnesses: { claude: { use: 'claude-code' } }, defaultHarness: 'claude' }, script: r.script });
    const key = await liveSession(w);
    const h = await w.host({ name: 'lb' });
    expect(await h.sessionCompact({ sessionKey: key, inputId: 'cmp-1' })).toMatchObject({ sessionKey: key, inputId: 'cmp-1', duplicate: false });
    await until(() => r.turns.length === 2 && !w.gw.hub.snapshot(key).turn);
    expect(r.turns[1]).toEqual([{ text: '/compact', native: true }]);
    expect(await say(w, '/compact')).toBe('Compacting (queued behind anything running).');
    await until(() => r.turns.length === 3);
    expect(r.turns[2]).toEqual([{ text: '/compact', native: true }]);
  });

  it('on a codex instance (GatewayOptions.harness): /plan, /bypass and the Plan line of /status as for Codex; no /compact', async () => {
    const r = recording();
    const w = await daemon({ raw: { harnesses: { cx: { use: 'codex' } }, defaultHarness: 'cx', topicTitles: { enabled: false } }, script: r.script, single: true });
    expect(await say(w, '/plan on')).toBe('Plan mode on from the next turn.');
    expect(await say(w, '/bypass off')).toBe('Bypass off for owner turns from the next turn.');
    expect((await say(w, '/status')).split('\n')[2]).toBe('Plan mode on · bypass restricted');
    expect(await say(w, '/compact')).toBe('/compact is not available on codex yet.');
  });

  it('one that declares any of the four is read as it declares: a displayName alone on a claude-code instance has no compaction command', async () => {
    const r = recording();
    const w = await daemon({ raw: { harnesses: { claude: { use: 'claude-code' } }, defaultHarness: 'claude' }, script: r.script, declares: { displayName: 'Mine' } });
    const key = await liveSession(w);
    const h = await w.host({ name: 'lb' });
    await expect(h.sessionCompact({ sessionKey: key })).rejects.toMatchObject({ code: 'unsupported' });
    expect(await say(w, '/compact')).toBe('/compact is not available on claude-code yet.');
    expect(r.turns).toHaveLength(1);
  });
});
