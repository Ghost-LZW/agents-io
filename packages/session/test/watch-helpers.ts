import { FakeHarness } from '@agents-io/testkit';
import type { BodyOf, InputRecord, Origin, ReplyRoute, WatchDraft } from '@agents-io/protocol';
import { Hub, Ingress, Lane, SqliteSessionLog, WatchDispatcher, WatchRegistry, defaultPolicy, type SessionPolicy } from '../src/index.js';
import { RUN } from './helpers.js';

export const OWNER: Origin = { kind: 'human', principal: { id: 'fake:alice', labels: ['owner'] }, evidence: 'device_only', via: 'local:local:main', adapter: 'local' };
export const AGENT: Origin = { kind: 'agent', principal: { id: 'session:main', labels: ['agent'] }, evidence: 'none', via: 'mcp', adapter: 'mcp' };
export const STRANGER_HUMAN: Origin = { kind: 'human', principal: null, evidence: 'platform_signed', via: 'fake:default:g1', adapter: 'fake' };

export const alice = { channelUserId: 'alice', evidence: 'platform_signed' as const };
export const eve = { channelUserId: 'eve', evidence: 'platform_signed' as const, displayName: 'Eve' };
export const group = { id: 'g1', kind: 'group' as const };
export const TARGET = 'main';

/** Watches over one SQLite log (`:memory:` unless `path`); trigger and digest turns reply to `home` (default the owner's DM). */
export function world(o: { policy?: Partial<SessionPolicy>; path?: string; allow?: Parameters<typeof defaultPolicy>[0]['watchAllowlist']; home?: ReplyRoute } = {}) {
  const log = new SqliteSessionLog({ path: o.path ?? ':memory:' });
  const hub = new Hub(log);
  const policy: SessionPolicy = {
    ...defaultPolicy({ owners: ['fake:alice'], selfAccounts: ['fake:mybot'], run: RUN, ...(o.allow ? { watchAllowlist: o.allow } : {}) }),
    ...o.policy,
  };
  const lanes = new Map<string, Lane>();
  const turns: InputRecord[][] = [];
  const harness = new FakeHarness(async (t) => {
    turns.push(t.inputs);
    t.emit({ t: 'text.snapshot', text: 'ok', final: true }, { audience: 'answer' });
  });
  const lane = (sessionKey: string) => {
    let l = lanes.get(sessionKey);
    if (!l) lanes.set(sessionKey, (l = new Lane({ sessionKey, harness, hub, policy, thinkingHeadline: null })));
    return l;
  };
  const registry = new WatchRegistry({ db: log.db });
  const home = o.home ?? { channel: 'fake', account: 'default', conversationId: 'owner-dm' };
  const watches = new WatchDispatcher({ registry, policy, lanes: lane, replyRoute: () => home });
  watches.start();
  const ingress = new Ingress({ policy, lanes: lane, watches });
  const events = (k = TARGET) => log.read(k, 0);
  const admitted = (k = TARGET) => events(k).filter((e) => e.body.t === 'input.admitted').map((e) => e.body as BodyOf<'input.admitted'>);
  const idle = async () => {
    await watches.idle();
    await Promise.all([...lanes.values()].map((l) => l.whenIdle()));
  };
  const close = async () => {
    watches.stop();
    await idle();
    log.close();
  };
  return { log, hub, ingress, watches, registry, lanes, turns, events, admitted, idle, close };
}

export const draft = (d: Partial<WatchDraft> = {}): WatchDraft => ({ id: 'w1', source: { channel: 'fake', conversation: 'g1' }, target: { sessionKey: TARGET }, mode: 'context', ...d });
