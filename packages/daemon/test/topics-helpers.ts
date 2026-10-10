import type { BodyOf, HarnessOpenArgs, InputRecord, SessionEvent } from '@agents-io/protocol';
import type { FakeHarness, FakeTurnScript } from '@agents-io/testkit';
import { daemon, tmp, type World } from './helpers.js';

// Shared by topics.test.ts (core), topics.e2e.test.ts and topics.local.test.ts.

/** What a harness does with HarnessOpenArgs.mcp: a JSON-RPC tools/call over streamable HTTP. */
export async function mcpCall(mcp: HarnessOpenArgs['mcp'], name: string, args: Record<string, unknown>, callId: string) {
  if (!mcp) throw new Error('no mcp mounted');
  const res = await fetch(mcp.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${mcp.token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args, _meta: { 'claudecode/toolUseId': callId } } }),
  });
  const body = (await res.json()) as { result: { isError?: boolean; content: { text: string }[] } };
  return { isError: !!body.result.isError, json: JSON.parse(body.result.isError ? '{}' : body.result.content[0]!.text), text: body.result.content[0]!.text };
}

export const CONV = 'fake:default:c1';
export const alice = { channelUserId: 'alice', evidence: 'platform_signed' as const };
export const textOf = (t: { inputs: { content: { type: string; text?: string }[] }[] }) => t.inputs.flatMap((i) => i.content).map((c) => c.text ?? '').join('\n');
export const read = (w: World, sk: string) => w.gw.hub.log.read(sk, 0);
export const of = <K extends SessionEvent['body']['t']>(evs: SessionEvent[], t: K) => evs.filter((e) => e.body.t === t).map((e) => e.body as BodyOf<K>);

/**
 * A scripted agent: it remembers per session what it was told (as a real harness
 * session would), rotates when told something "unrelated", switches back when
 * asked to "go back", and binds a native id per session.
 */
export function agent(holder: { h?: FakeHarness; w?: World }, tools: { name: string; isError: boolean; json: any; text: string }[], turns: { sessionKey: string; inputs: InputRecord[] }[]): FakeTurnScript {
  const memory = new Map<string, string[]>();
  return async (t) => {
    const w = holder.w!;
    const topicId = t.inputs.map((i) => i.channelContext.topic).find((x) => typeof x === 'string') as string | undefined;
    const sk = topicId ? w.gw.topics.get(topicId)!.sessionKey : CONV;
    const s = holder.h!.sessions.filter((x) => x.args.sessionKey === sk).at(-1)!;
    turns.push({ sessionKey: sk, inputs: t.inputs });
    t.emit({ t: 'session.bound', nativeId: `native:${sk}` });
    const text = textOf(t);
    const seen = memory.get(sk) ?? [];
    // What the user said in this session (context items such as a rotation summary are not remembered as facts).
    memory.set(sk, [...seen, textOf({ inputs: t.inputs.filter((i) => i.channelContext.context !== true) })]);
    const call = async (name: string, args: Record<string, unknown>) => {
      const r = await mcpCall(s.args.mcp, name, args, `${t.turnId}:${name}`);
      tools.push({ name, ...r });
      return r;
    };
    let answer: string;
    if (/unrelated/.test(text) && !/Summary of the previous topic/.test(text)) {
      await call('session_rotate', { title: 'Capitals', summary: 'The user told me their codename.' });
      answer = '→ Capitals';
    } else if (/go back/.test(text) && !seen.join('\n').includes('HERON')) {
      const list = await call('session_list', {});
      const a = list.json.topics.find((x: { title: string }) => /codename/.test(x.title));
      await call('session_switch', { topicId: a.topicId });
      answer = '→ back';
    } else {
      // Answers from what this session has seen: only the first topic knows the codename.
      answer = /codename/.test(text) && seen.join('\n').includes('HERON') ? 'Your codename is HERON.' : `ok (${seen.length + 1} messages here)`;
    }
    t.emit({ t: 'text.snapshot', text: answer, final: true }, { audience: 'answer' });
  };
}

export async function world(dir = tmp(), raw: Record<string, unknown> = {}) {
  const holder: { h?: FakeHarness; w?: World } = {};
  const tools: { name: string; isError: boolean; json: any; text: string }[] = [];
  const turns: { sessionKey: string; inputs: InputRecord[] }[] = [];
  const w = await daemon({ dir, script: agent(holder, tools, turns), raw: { outputTools: true, ...raw } });
  holder.h = w.harness;
  holder.w = w;
  return { w, tools, turns };
}

export const turnsIn = (w: World, sk: string) => of(read(w, sk), 'turn.completed');

