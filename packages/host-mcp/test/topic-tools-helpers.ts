import type { InputRecord, ReplyRoute, Topic, TurnContext } from '@agents-io/protocol';
import { Hub, MemorySessionLog, Outbox, defaultPolicy } from '@agents-io/session';
import { HostTools, MemoryBlobStore, type TopicControl } from '../src/index.js';

export const SK = 's1';
const ROUTE: ReplyRoute = { channel: 'fake', account: 'default', conversationId: 'c1' };
export const input = (id: string, extra: Record<string, string | boolean> = {}): InputRecord => ({
  inputId: id,
  origin: { kind: 'human', principal: { id: 'fake:alice', labels: ['owner'] }, evidence: 'platform_signed', via: 'fake:default:c1', adapter: 'fake' },
  content: [{ type: 'text', text: 'what is the capital of Australia?' }],
  replyRoute: ROUTE,
  channelContext: { channel: 'fake', ...extra },
});
export const turnOf = (inputs: InputRecord[] = [input('in1')]): TurnContext => ({ sessionKey: SK, turnId: 't1', run: { harness: 'fake', model: 'm', profile: 'bypass' }, inputs, replyRoute: ROUTE, deliveries: [] });
const topic = (id: string, sessionKey: string, state: 'current' | 'parked', title?: string): Topic => ({ id, conversation: 'fake:default:c1', sessionKey, state, createdAt: 1, lastActiveAt: 2, ...(title ? { title } : {}) });

export function world() {
  let topics: Topic[] = [topic('tp_a', SK, 'current', 'Rust CLI'), topic('tp_b', 's1#tp_b', 'parked', 'Groceries')];
  const calls: { op: string; sessionKey: string; turn: TurnContext; args: unknown }[] = [];
  const control: TopicControl = {
    list: (sk) => (topics.some((t) => t.sessionKey === sk) ? topics : undefined),
    rotate: async (sk, turn, a) => {
      calls.push({ op: 'rotate', sessionKey: sk, turn, args: a });
      const t = topic('tp_new', 's1#tp_new', 'current', a.title);
      const previous = topics.find((x) => x.state === 'current')!;
      topics = [t, ...topics.map((x) => ({ ...x, state: 'parked' as const }))];
      return { topic: t, previous, handed: turn.inputs.map((i) => `${i.inputId}>tp_new`) };
    },
    switch: async (sk, turn, a) => {
      calls.push({ op: 'switch', sessionKey: sk, turn, args: a });
      return { topic: topics.find((t) => t.id === a.topicId)!, handed: turn.inputs.map((i) => `${i.inputId}>${a.topicId}`) };
    },
  };
  const hub = new Hub(new MemorySessionLog());
  let turn: TurnContext | undefined = turnOf();
  const tools = new HostTools({ hub, outbox: new Outbox({ hub }), policy: defaultPolicy({ owners: ['fake:alice'] }), turn: () => turn, adapter: () => undefined, blobs: new MemoryBlobStore(), cwd: () => '/', topics: control });
  const run = (name: string, args: Record<string, unknown> = {}, id = Math.random().toString(36), sk = SK) => tools.call({ sessionKey: sk, generation: 1 }, name, args, { toolCallId: id }).then((t) => JSON.parse(t));
  return { tools, calls, run, setTurn: (t: TurnContext | undefined) => (turn = t) };
}
