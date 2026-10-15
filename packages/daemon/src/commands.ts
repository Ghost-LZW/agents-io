import type { InboundEnvelope, InputRecord, Origin } from '@agents-io/protocol';
import type { CommandResult, RouteDelivery } from '@agents-io/session';

/**
 * `/commands` typed into a chat with the deployment (Ingress `onCommand`): the owner operates
 * the session and its harness from the channel. Anyone else's `/text` is an ordinary message.
 * Topic commands without an agent (`/new`, `/topics`, `/switch`) stay with Ingress when the chat
 * keeps topics; here they only say why they do nothing when it does not.
 */

export const COMMAND_HELP = [
  '/help — this list',
  '/status — this conversation: session, agent, harness, model, what runs, what waits',
  '/stop [--clear] — stop the running turn (--clear also drops what is queued)',
  '/steer <text> — add to the running turn instead of queueing',
  '/answer <question-code> <answer> — answer a native Codex / Claude Code question',
  '/new [@agent] [title] — a new topic (with @agent: talk to that agent from now on)',
  '/topics, /switch <n> — list topics, go back to one',
  '/agent [name] — which agent this chat talks to; with a name, switch (new turns go to its current topic)',
  '/model [name], /effort [level] — show, or set for this session from the next turn (/model default to undo)',
  '/plan [on|off] — show or set Codex Plan mode from the next turn',
  '/bypass [on|off|default] — show or set Codex permissions for owner turns',
  '/compact — compact the harness context (Claude Code)',
  '/tui — how to open this session in the harness’s own terminal UI',
].join('\n');

const FIXED_SESSION = 'This chat goes to one fixed session (policy.ownerSessionKey), so it has no topics or agents to switch; remove ownerSessionKey to use them.';

export interface CommandHost {
  /** May this origin operate the session (Policy.control, as for topic commands)? */
  allowed(sessionKey: string, origin: Origin): Promise<boolean>;
  status(sessionKey: string, delivery: RouteDelivery): string;
  interrupt(sessionKey: string, origin: Origin, clear: boolean): Promise<CommandResult>;
  /** Sessions of this flat conversation (its topics) with a turn running, the most recent first. */
  running(conversation: string): string[];
  /** Deliver an input to the session (the delivery's lane), with a mode. */
  input(delivery: RouteDelivery, input: InputRecord, mode: 'steer' | 'queue'): Promise<CommandResult>;
  /** The question code names its original session, even if the chat has switched topics. */
  answer(code: string, text: string, origin: Origin): Promise<CommandResult>;
  run(sessionKey: string): { harness: string; kind: string; model?: string; effort?: string; mode?: 'default' | 'plan'; profile?: 'bypass' | 'restricted'; overridden: boolean };
  setRun(sessionKey: string, o: { model?: string | null; effort?: string | null; mode?: 'default' | 'plan'; profile?: 'bypass' | 'restricted' | null }): void;
  agents(): string[];
  conversationAgent(conversation: string): string | undefined;
  setConversationAgent(conversation: string, agent: string): void;
  newTopic(agent: string, conversation: string, title: string | undefined): string;
  tuiHint(sessionKey: string): string;
}

export async function runCommand(
  h: CommandHost,
  a: { name: string; args: string; env: InboundEnvelope; origin: Origin; input: InputRecord; delivery: RouteDelivery },
): Promise<{ ok: boolean; reply: string } | undefined> {
  const { name, args, delivery } = a;
  const key = delivery.sessionKey;
  const topicConversation = delivery.topic?.conversation;
  const known = ['help', 'status', 'stop', 'steer', 'answer', 'model', 'effort', 'plan', 'bypass', 'compact', 'agent', 'tui', 'new', 'topics', 'switch'];
  if (!known.includes(name)) return undefined;
  // The lane checks the question's resolver principal. A guest may answer a question
  // addressed to them even though they cannot operate owner-only chat commands.
  if (name === 'answer') {
    const split = args.search(/\s/);
    if (split < 0 || !args.slice(split).trim()) return { ok: false, reply: 'Usage: /answer <question-code> <answer>' };
    const r = await h.answer(args.slice(0, split), args.slice(split).trim(), a.origin);
    return r.ok ? { ok: true, reply: 'Answer submitted.' } : { ok: false, reply: `Answer not submitted: ${r.reason ?? 'refused'}.` };
  }
  // Plain topic commands in a chat that keeps topics: Ingress answers them.
  if ((name === 'new' && !args.startsWith('@')) || name === 'topics' || name === 'switch') {
    if (topicConversation) return undefined;
  }
  if (!(await h.allowed(key, a.origin))) return name === 'help' ? { ok: true, reply: 'Commands are for the owner of this deployment.' } : undefined;
  const ok = (reply: string) => ({ ok: true, reply });
  const no = (reply: string) => ({ ok: false, reply });
  const res = (r: CommandResult, done: string) => (r.ok ? ok(done) : no(`Not done: ${r.reason ?? 'refused'}.`));

  switch (name) {
    case 'help':
      return ok(COMMAND_HELP);
    case 'status':
      return ok(h.status(key, delivery));
    case 'stop': {
      // Lark's thinking bubble has a Stop that sends a plain `/stop`: it may belong to a topic left
      // running behind the current one, so with nothing running here the chat's running turn stops.
      const others = topicConversation ? h.running(topicConversation).filter((k) => k !== key) : [];
      const target = h.running(topicConversation ?? '').includes(key) || !others.length ? key : others[0]!;
      const r = await h.interrupt(target, a.origin, args === '--clear');
      if (!r.ok && /no_active_turn|stale_turn/.test(r.reason)) return ok('Nothing is running.');
      const where = target === key ? '' : ` (in another topic of this chat)`;
      return res(r, args === '--clear' ? `Stopped${where}; the queue is cleared.` : `Stopped${where}.`);
    }
    case 'steer': {
      if (!args) return no('Usage: /steer <text>');
      const r = await h.input(delivery, { ...a.input, content: [{ type: 'text', text: args }] }, 'steer');
      if (!r.ok) return no(`Not done: ${r.reason ?? 'refused'}.`);
      return ok(r.disposition === 'steer' ? 'Added to the running turn.' : 'Nothing was running: it starts a turn.');
    }
    case 'model':
    case 'effort': {
      const cur = h.run(key);
      if (!args) return ok(`${name === 'model' ? `model ${cur.model ?? '(harness default)'}` : `effort ${cur.effort ?? '(default)'}`} on ${cur.harness}${cur.overridden ? ' (set here)' : ''}`);
      const value = args === 'default' ? null : args;
      h.setRun(key, name === 'model' ? { model: value } : { effort: value });
      return ok(value === null ? `${name} back to the agent's default from the next turn.` : `${name} ${value} from the next turn.`);
    }
    case 'plan': {
      const cur = h.run(key);
      if (cur.kind !== 'codex') return no(`/plan is available only on Codex (this agent uses ${cur.kind}).`);
      if (!args) return ok(`Plan mode ${cur.mode === 'plan' ? 'on' : 'off'} for this session.`);
      if (args !== 'on' && args !== 'off') return no('Usage: /plan [on|off]');
      h.setRun(key, { mode: args === 'on' ? 'plan' : 'default' });
      return ok(`Plan mode ${args} from the next turn.`);
    }
    case 'bypass': {
      const cur = h.run(key);
      if (cur.kind !== 'codex') return no(`/bypass is available only on Codex (this agent uses ${cur.kind}).`);
      if (!args) return ok(`Bypass ${cur.profile ?? 'default'} for owner turns in this session.`);
      if (args !== 'on' && args !== 'off' && args !== 'default') return no('Usage: /bypass [on|off|default]');
      h.setRun(key, { profile: args === 'default' ? null : args === 'on' ? 'bypass' : 'restricted' });
      return ok(args === 'default' ? 'Bypass back to the agent policy from the next turn.' : `Bypass ${args} for owner turns from the next turn.`);
    }
    case 'compact': {
      const cur = h.run(key);
      if (cur.kind !== 'claude-code') return no(`/compact is not available on ${cur.kind} yet.`);
      const r = await h.input(delivery, { ...a.input, content: [{ type: 'text', text: '/compact' }], channelContext: { ...a.input.channelContext, nativeCommand: true } }, 'queue');
      return r.ok ? ok('Compacting (queued behind anything running).') : no(`Not done: ${r.reason ?? 'refused'}.`);
    }
    case 'agent':
    case 'new': {
      const conversation = topicConversation;
      const agents = h.agents();
      if (name === 'agent' && !args) return ok(`This chat talks to ${delivery.agent ?? '(default)'}. Agents: ${agents.join(', ')}`);
      if (!conversation) return no(FIXED_SESSION);
      const [first, ...rest] = args.split(/\s+/);
      const wanted = (first ?? '').replace(/^@/, '');
      if (!agents.includes(wanted)) return no(`No agent ${wanted || '(none given)'}. Agents: ${agents.join(', ')}`);
      h.setConversationAgent(conversation, wanted);
      if (name === 'agent') return ok(`This chat talks to ${wanted} now (its current topic, or a new one).`);
      const title = rest.join(' ').trim() || undefined;
      const topic = h.newTopic(wanted, conversation, title);
      return ok(`New topic with ${wanted}${title ? `: ${title}` : ''} (${topic}). Your next message starts it.`);
    }
    case 'topics':
    case 'switch':
      return no(FIXED_SESSION);
    case 'tui':
      return ok(h.tuiHint(key));
  }
  return undefined;
}
