import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChannelCaps, InputRecord, ReplyRoute, TurnContext } from '@agents-io/protocol';
import { Hub, MemorySessionLog, Outbox, WatchDispatcher, WatchRegistry, defaultPolicy } from '@agents-io/session';
import { FakeChannel, defaultChannelCaps } from '@agents-io/testkit';
import { HostTools, MemoryBlobStore, OUTPUT_EVENT, type OutputRecord } from '../src/index.js';

export const SK = 's1';
export const route = (conversationId = 'c1', channel = 'fake'): ReplyRoute => ({ channel, account: 'default', conversationId, replyToMessageId: 'm0' });

export function input(r: ReplyRoute | null, principal = 'fake:alice'): InputRecord {
  return {
    inputId: 'in1',
    origin: { kind: 'human', principal: { id: principal, labels: ['owner'] }, evidence: 'platform_signed', via: 'fake:default:c1', adapter: r?.channel ?? 'fake' },
    content: [{ type: 'text', text: 'hi' }],
    replyRoute: r,
    channelContext: { channel: r?.channel ?? 'fake', conversationKind: 'dm', senderName: 'Alice' },
  };
}

export function turnOf(r: ReplyRoute | null, profile = 'bypass'): TurnContext {
  return { sessionKey: SK, turnId: 't1', run: { harness: 'fake', model: 'm', profile }, inputs: [input(r)], replyRoute: r, deliveries: [] };
}

const NO_MEDIA: ChannelCaps = { ...defaultChannelCaps, buttons: false, media: { in: [], out: [] } };

export function world(o: { turn?: TurnContext | undefined; routes?: string[]; cwd?: string } = {}) {
  const hub = new Hub(new MemorySessionLog());
  const policy = defaultPolicy({ owners: ['fake:alice'], routes: o.routes ?? [] });
  const outbox = new Outbox({ hub, policy, sleep: async () => {} });
  const fake = new FakeChannel('fake', defaultChannelCaps);
  const mail = new FakeChannel('mail', NO_MEDIA);
  const blobs = new MemoryBlobStore();
  const cwd = o.cwd ?? mkdtempSync(join(tmpdir(), 'aio-mcp-'));
  let turn: TurnContext | undefined = 'turn' in o ? o.turn : turnOf(route());
  const tools = new HostTools({
    hub,
    outbox,
    policy,
    turn: () => turn,
    adapter: (r) => (r.channel === 'fake' ? fake : r.channel === 'mail' ? mail : undefined),
    blobs,
    cwd: () => cwd,
    routes: () => o.routes ?? [],
  });
  const events = () => hub.log.read(SK, 0);
  const outputs = () => events().filter((e) => e.body.t === 'native' && e.body.name === OUTPUT_EVENT).map((e) => e.native as OutputRecord);
  return { hub, outbox, fake, mail, blobs, cwd, tools, events, outputs, setTurn: (t: TurnContext | undefined) => (turn = t) };
}

export const B = { sessionKey: SK, generation: 1 };
export const call = (w: ReturnType<typeof world>, name: string, args: Record<string, unknown>, id?: string) =>
  w.tools.call(B, name, args, id ? { toolCallId: id } : { requestId: Math.random() }).then((t) => JSON.parse(t));

export function watchWorld() {
  const hub = new Hub(new MemorySessionLog());
  const policy = defaultPolicy({ owners: ['fake:alice'], watchAllowlist: [{ channel: 'lark-bot', conversation: 'oc_team' }] });
  const d = new WatchDispatcher({ registry: new WatchRegistry(), policy, lanes: () => { throw new Error('no lanes'); } });
  const tools = new HostTools({
    hub,
    outbox: new Outbox({ hub }),
    policy,
    turn: () => undefined,
    adapter: () => undefined,
    blobs: new MemoryBlobStore(),
    cwd: () => '/',
    watches: { add: (by, w) => d.add(by, w), remove: (by, id) => d.remove(by, id), list: (sk) => d.list({ target: sk }) },
  });
  const run = (sk: string, name: string, args: Record<string, unknown>) => tools.call({ sessionKey: sk, generation: 1 }, name, args).then((t) => JSON.parse(t));
  return { d, tools, run };
}
