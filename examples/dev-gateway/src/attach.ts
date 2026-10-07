import { createInterface } from 'node:readline';
import type { Tier } from '@agents-io/protocol';
import { CommandError, type LocalClient } from './client.js';
import { EventRenderer } from './render.js';
import { WatchSpecError, formatWatch, parseWatchSpec } from './watch-spec.js';

export type AttachAction =
  | { kind: 'input'; text: string }
  | { kind: 'steer'; text: string }
  | { kind: 'interrupt'; cancelQueue: boolean }
  | { kind: 'approve'; requestId: string; always: boolean }
  | { kind: 'deny'; requestId: string; message?: string }
  | { kind: 'choose'; choiceId: string; selected: number[] }
  | { kind: 'sessions' }
  | { kind: 'watch'; op: 'add'; tokens: string[] }
  | { kind: 'watch'; op: 'list'; all: boolean }
  | { kind: 'watch'; op: 'remove'; id: string }
  | { kind: 'help' }
  | { kind: 'quit' }
  | { kind: 'none' }
  | { kind: 'error'; message: string };

export const ATTACH_HELP = [
  'text            queue an input (a new turn, or after the current one)',
  '/steer <text>   fold into the running turn (degrades to queue when not allowed)',
  '/interrupt      stop the running turn (/interrupt --clear also drops the queue)',
  '/approve <id>   allow a pending request (/approve <id> always: for the session)',
  '/deny <id> [why]',
  '/choose <id> <n>[,<n>…]  answer an ask_choice question (numbers as listed)',
  '/sessions       list sessions',
  '/watch add k=v… watch inputs into this session (e.g. channel=lark-bot conversation=oc_1 mode=digest every=30m)',
  '/watch list     watches into this session (/watch list all: every watch); /watch remove <id>',
  '/quit           detach (Ctrl-D too); //text sends text starting with /',
].join('\n');

/** One stdin line → what the attach end does with it. */
export function parseAttachLine(line: string): AttachAction {
  const s = line.trim();
  if (!s) return { kind: 'none' };
  if (s.startsWith('//')) return { kind: 'input', text: s.slice(1) };
  if (!s.startsWith('/')) return { kind: 'input', text: s };
  const [cmd = '', ...rest] = s.slice(1).split(/\s+/);
  const arg = s.slice(1 + cmd.length).trim();
  switch (cmd) {
    case 'steer':
      return arg ? { kind: 'steer', text: arg } : { kind: 'error', message: 'usage: /steer <text>' };
    case 'interrupt':
    case 'stop':
      if (rest.length > 1 || (rest[0] && rest[0] !== '--clear')) return { kind: 'error', message: 'usage: /interrupt [--clear]' };
      return { kind: 'interrupt', cancelQueue: rest[0] === '--clear' };
    case 'approve':
    case 'allow':
      if (!rest[0] || rest.length > 2 || (rest[1] && rest[1] !== 'always')) return { kind: 'error', message: 'usage: /approve <requestId> [always]' };
      return { kind: 'approve', requestId: rest[0], always: rest[1] === 'always' };
    case 'deny': {
      if (!rest[0]) return { kind: 'error', message: 'usage: /deny <requestId> [reason]' };
      const message = rest.slice(1).join(' ');
      return { kind: 'deny', requestId: rest[0], ...(message ? { message } : {}) };
    }
    case 'choose': {
      const nums = rest.slice(1).join(',').split(/[,\s]+/).filter(Boolean).map(Number);
      if (!rest[0] || !nums.length || nums.some((n) => !Number.isInteger(n) || n < 1)) return { kind: 'error', message: 'usage: /choose <choiceId> <n>[,<n>…]' };
      return { kind: 'choose', choiceId: rest[0], selected: nums };
    }
    case 'sessions':
      return { kind: 'sessions' };
    case 'watch': {
      const [op = 'list', ...more] = rest;
      if (op === 'add') return more.length ? { kind: 'watch', op: 'add', tokens: more } : { kind: 'error', message: 'usage: /watch add channel=<ch> … (see /help)' };
      if (op === 'list' || op === 'ls') return { kind: 'watch', op: 'list', all: more[0] === 'all' };
      if ((op === 'remove' || op === 'rm') && more[0]) return { kind: 'watch', op: 'remove', id: more[0] };
      return { kind: 'error', message: 'usage: /watch add k=v… | /watch list [all] | /watch remove <id>' };
    }
    case 'help':
    case '?':
      return { kind: 'help' };
    case 'quit':
    case 'exit':
      return { kind: 'quit' };
    default:
      return { kind: 'error', message: `unknown command /${cmd} (try /help)` };
  }
}

export interface AttachOptions {
  client: LocalClient;
  sessionKey: string;
  tier: Tier;
  fromSeq?: number;
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  color?: boolean;
  verbose?: boolean;
}

/**
 * An interactive terminal end: prints the session stream and turns stdin lines
 * into commands. Any number of attach processes can share a session; each sees
 * every event and each can talk.
 */
export async function runAttach(o: AttachOptions): Promise<void> {
  const { client, sessionKey } = o;
  const out = (s: string) => void (s && o.output.write(s));
  const renderer = new EventRenderer({ ...(o.color !== undefined ? { color: o.color } : {}), ...(o.verbose ? { verbose: true } : {}), tier: o.tier });
  const sub = await client.subscribe({ sessionKey, tier: o.tier, ...(o.fromSeq !== undefined ? { fromSeq: o.fromSeq } : {}) });
  out(`attached to ${sessionKey} (tier ${o.tier}, head ${sub.head}). Type to talk, /help for commands.\n`);

  const rl = createInterface({ input: o.input, terminal: false });
  let quitting = false;
  const events = (async () => {
    for await (const e of sub) out(renderer.render(e));
    if (!quitting) out('\n[subscription ended]\n');
    rl.close();
  })();

  const report = async (what: string, p: Promise<unknown>) => {
    try {
      const v = (await p) as { disposition?: string; inputId?: string } | undefined;
      if (v?.disposition) out(`   (${what}: ${v.disposition})\n`);
    } catch (e) {
      out(`   (${what} failed: ${e instanceof CommandError ? e.code : (e as Error).message})\n`);
    }
  };

  for await (const line of rl) {
    const a = parseAttachLine(line);
    switch (a.kind) {
      case 'none':
        break;
      case 'error':
        out(`   ${a.message}\n`);
        break;
      case 'help':
        out(ATTACH_HELP + '\n');
        break;
      case 'quit':
        quitting = true;
        rl.close();
        break;
      case 'input':
        await report('input', client.input(sessionKey, a.text, 'queue'));
        break;
      case 'steer':
        await report('steer', client.input(sessionKey, a.text, 'steer'));
        break;
      case 'interrupt':
        await report('interrupt', client.command({ type: 'interrupt', sessionKey, ...(a.cancelQueue ? { cancelQueue: true } : {}) }));
        break;
      case 'approve':
        await report('approve', client.command({ type: 'resolve', sessionKey, requestId: a.requestId, decision: { kind: a.always ? 'allow_session' : 'allow_once' } }));
        break;
      case 'deny':
        await report('deny', client.command({ type: 'resolve', sessionKey, requestId: a.requestId, decision: { kind: 'deny', ...(a.message ? { message: a.message } : {}) } }));
        break;
      case 'watch':
        try {
          if (a.op === 'add') out(`   watch ${formatWatch(await client.watchAdd(parseWatchSpec(a.tokens, sessionKey)))}\n`);
          else if (a.op === 'remove') out(`   ${(await client.watchRemove(a.id)).removed ? `removed ${a.id}` : `no watch ${a.id}`}\n`);
          else {
            const ws = await client.watchList(a.all ? undefined : sessionKey);
            out(ws.length ? ws.map((w) => `   ${formatWatch(w)}\n`).join('') : '   (no watches)\n');
          }
        } catch (e) {
          out(`   (watch failed: ${e instanceof CommandError ? e.message : e instanceof WatchSpecError ? e.message : (e as Error).message})\n`);
        }
        break;
      case 'choose':
        await report(
          'choose',
          client.command({ type: 'input', sessionKey, mode: 'queue', input: { content: [{ type: 'event', name: 'choice', data: { choiceId: a.choiceId, selected: a.selected } }] } }),
        );
        break;
      case 'sessions':
        try {
          for (const s of await client.sessions()) {
            out(`   ${s.sessionKey === sessionKey ? '*' : ' '} ${s.sessionKey}  ${s.state}  seq ${s.head}${s.turnId ? `  turn ${s.turnId}` : ''}${s.queued ? `  ${s.queued} queued` : ''}${s.pendingRequests.length ? `  requests: ${s.pendingRequests.join(', ')}` : ''}\n`);
          }
        } catch (e) {
          out(`   (sessions failed: ${(e as Error).message})\n`);
        }
        break;
    }
    if (quitting) break;
  }
  quitting = true;
  await sub.close();
  client.close();
  await events;
}
