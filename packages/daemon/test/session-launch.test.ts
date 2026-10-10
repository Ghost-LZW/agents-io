import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { CodexHarness } from '@agents-io/harness-codex';
import type { Binding, BindingTable, HarnessAdapter, Policy, SessionLaunch } from '@agents-io/protocol';
import { LaneUnavailableError } from '@agents-io/session';
import { FakeChannel, FakeHarness } from '@agents-io/testkit';
import { LocalClient } from '../src/client.js';
import { resolveConfig, type HarnessInstance } from '../src/config.js';
import { Gateway, InstanceHarness } from '../src/gateway.js';
import { readTokenFile, tokenPath } from '../src/token.js';
import { cleanups, tmp, until } from './helpers.js';

/*
 * Session launch (decision 7, docs/design/session-launch §8): per-session cwd/env
 * within an agent's sessionParams, pinned with the session.
 */

const alice = { channelUserId: 'alice', evidence: 'platform_signed' as const };
const group = (id = 'g1') => ({ id, kind: 'group' as const });
const table = (version: string, bindings: Binding[]): BindingTable => ({ version, bindings, identities: [], onHostDown: 'keep' });
const SECRET = 'sekret-value-9f3a';

/** Directories under one temp dir: roots with real dirs, a file, and symlinks that escape them. */
function fixture() {
  const d = realpathSync(tmp('aio-launch-'));
  const ws = join(d, 'ws');
  const homes = join(d, 'homes');
  for (const p of [join(ws, 'a'), join(ws, 'b'), join(homes, 'h1'), join(homes, 'h2'), join(d, 'out'), join(d, 'work')]) mkdirSync(p, { recursive: true });
  writeFileSync(join(ws, 'file'), 'x');
  symlinkSync(join(d, 'out'), join(ws, 'escape'));
  symlinkSync(join(d, 'out'), join(homes, 'escape'));
  // A link inside the root to a dir inside the root is fine (pinned by its realpath).
  symlinkSync(join(ws, 'b'), join(ws, 'alias-b'));
  return { d, ws, homes, a: join(ws, 'a'), b: join(ws, 'b'), h1: join(homes, 'h1'), h2: join(homes, 'h2'), out: join(d, 'out'), work: join(d, 'work') };
}

type Fx = ReturnType<typeof fixture>;

const agents = (fx: Fx, extra: Record<string, unknown> = {}) => ({
  dev: {
    harness: 'claude',
    cwd: fx.work,
    sessionParams: { cwdRoots: [fx.ws], envKeys: ['CLAUDE_CONFIG_DIR', 'GIT_AUTHOR_NAME', 'TOKEN'], envPathRoots: { CLAUDE_CONFIG_DIR: [fx.homes] } },
  },
  plain: { harness: 'claude', cwd: fx.work },
  ...extra,
});

interface W {
  gw: Gateway;
  fx: Fx;
  chat: FakeChannel;
  harness: FakeHarness;
  built: HarnessInstance[];
  logs: string[];
  host(o?: { callouts?: boolean }): Promise<LocalClient>;
  client(): Promise<LocalClient>;
  stop(): Promise<void>;
}

async function world(o: { fx?: Fx; dir?: string; raw?: Record<string, unknown>; policy?: Partial<Policy>; build?: (i: HarnessInstance, fake: FakeHarness) => HarnessAdapter } = {}): Promise<W> {
  const fx = o.fx ?? fixture();
  const dir = o.dir ?? tmp();
  const raw = {
    dataDir: dir,
    policy: { owners: ['fake:alice'] },
    local: { principal: 'me' },
    cwd: fx.work,
    harnesses: { claude: { use: 'claude-code' }, other: { use: 'claude-code' } },
    defaultHarness: 'claude',
    agents: agents(fx),
    defaultAgent: 'plain',
    bindings: [],
    ...o.raw,
  };
  const config = { ...resolveConfig(raw, { env: {}, baseDir: dir, cwd: dir }), socketPath: join(dir, 'run', 'aio.sock') };
  const chat = new FakeChannel('fake');
  // Binds a native id per first turn (what a restart resumes), then echoes.
  const harness = new FakeHarness(async (t) => {
    t.emit({ t: 'session.bound', nativeId: `native-${t.turnId}` });
    t.emit({ t: 'text.snapshot', text: 'ok', final: true }, { audience: 'answer' });
  });
  const built: HarnessInstance[] = [];
  const logs: string[] = [];
  const gw = await Gateway.start({
    config,
    buildHarness: (i) => {
      built.push(i);
      return o.build?.(i, harness) ?? new InstanceHarness(i, harness);
    },
    channels: [{ adapter: chat }],
    ...(o.policy ? { policy: o.policy } : {}),
    logger: (level, msg, data) => logs.push(`${level} ${msg} ${data === undefined ? '' : JSON.stringify(data)}`),
  });
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    await gw.stop();
  };
  cleanups.push(stop);
  const client = async () => {
    const c = await LocalClient.connect(config.socketPath);
    cleanups.push(() => c.close());
    return c;
  };
  const host = async (h: { callouts?: boolean } = {}) => {
    const c = await client();
    await c.hello({ token: readTokenFile(tokenPath(config.socketPath)), name: 'xwo', ...(h.callouts ? { callouts: true } : {}) });
    return c;
  };
  return { gw, fx, chat, harness, built, logs, host, client, stop };
}

/** A host that answers every callout with `answer(text)` and installs one callout rule. */
async function calloutHost(w: W, answer: (text: string) => unknown, rule: Partial<Binding> = {}) {
  const h = await w.host({ callouts: true });
  const asked: string[] = [];
  h.onRequest('policy', (f) => {
    const text = ((f as { args: { input: { content: { type: string; text?: string }[] } } }).args.input.content[0]?.text ?? '') as string;
    asked.push(text);
    return answer(text);
  });
  await h.bindingsPut(table('t1', [{ id: 'ask', match: { channel: 'fake' }, on: 'dispatch', agent: 'dev', callout: { timeoutMs: 2000, onFailure: 'host' }, ...rule }]));
  return { h, asked };
}

const completed = (w: W, key: string, n = 1) => until(() => w.gw.hub.log.read(key, 0).filter((e) => e.body.t === 'turn.completed').length >= n, 4000);
const opened = (w: W, key: string) => w.harness.sessions.filter((s) => s.args.sessionKey === key);
const boundId = (w: W, key: string) => {
  let id: string | undefined;
  for (const e of w.gw.hub.log.read(key, 0)) if (e.body.t === 'session.bound') id = e.body.nativeId;
  return id;
};
const matched = (w: W, inputId: string) => w.gw.router.explain(inputId)!.matched.find((m) => m.bindingId === 'ask')!;

describe('session launch: refused without sessionParams (§8.1)', () => {
  it('a callout launch for an agent without sessionParams goes to onFailure; session.prepare says launch_not_allowed #FC-4', async () => {
    const w = await world();
    const { h } = await calloutHost(w, () => ({ on: 'dispatch', agent: 'plain', session: { key: 'P1' }, launch: { cwd: w.fx.a } }));
    const r = await w.chat.inject({ id: 'm1', sender: alice, conversation: group(), text: 'hi' });
    expect(matched(w, r.inputId!)).toMatchObject({ on: 'host', callout: { outcome: 'error', on: 'host', reason: 'launch_not_allowed' }, launch: { cwd: w.fx.a, envKeys: [], outcome: 'launch_not_allowed' } });
    expect((await h.inboundRead({ consumer: 'any' })).items.map((i) => i.channelRef)).toEqual(['channel:fake/m1']);
    expect(w.gw.sessions().find((s) => s.sessionKey === 'P1')).toBeUndefined();
    await expect(h.call('session.prepare', { sessionKey: 'P2', agent: 'plain', launch: { cwd: w.fx.a } })).rejects.toMatchObject({ code: 'launch_not_allowed' });
    await expect(h.call('session.prepare', { sessionKey: 'run:x', agent: 'dev', launch: {} })).rejects.toMatchObject({ code: 'invalid_frame' });
    await expect(h.call('session.prepare', { sessionKey: 'P3', agent: 'nobody', launch: {} })).rejects.toMatchObject({ code: 'unknown_agent' });
  });
});

describe('session launch: checks (§8.2–8.4)', () => {
  const prepare = (w: W, launch: SessionLaunch, key = `k${Math.random()}`) => w.gw.prepareSession({ v: 1, type: 'session.prepare', id: 'x', sessionKey: key, agent: 'dev', launch } as never);

  it('cwd: relative, missing, a file, outside the roots, a symlink out of them are refused; a real dir inside (also via a link inside) is pinned by realpath #FC-4', async () => {
    const w = await world();
    const fx = w.fx;
    for (const cwd of ['ws/a', join(fx.ws, 'missing'), join(fx.ws, 'file'), fx.out, join(fx.ws, 'escape'), fx.d]) {
      expect(prepare(w, { cwd })).toMatchObject({ ok: false, code: 'bad_cwd' });
    }
    expect(prepare(w, { cwd: fx.a }, 'ok1')).toMatchObject({ ok: true, value: { sessionKey: 'ok1', agent: 'dev', launch: { cwd: fx.a, envKeys: [] }, created: true } });
    expect(prepare(w, { cwd: fx.ws }, 'ok-root')).toMatchObject({ ok: true });
    expect(prepare(w, { cwd: join(fx.ws, 'alias-b') }, 'ok2')).toMatchObject({ ok: true, value: { launch: { cwd: fx.b } } });
    expect(w.gw.records.launchOf('ok2')).toEqual({ cwd: fx.b });
    // Prepared, never opened: listed with its launch.
    expect(w.gw.sessions().find((s) => s.sessionKey === 'ok2')).toMatchObject({ live: false, launch: { cwd: fx.b, envKeys: [] } });
  });

  it('env: keys outside envKeys, AGENTS_IO_*, malformed names are refused #FC-4', async () => {
    const w = await world();
    for (const env of [{ HOME: '/x' }, { AGENTS_IO_MCP_TOKEN: 't' }, { '1BAD': 'x' }, { 'A-B': 'x' }]) {
      expect(prepare(w, { env })).toMatchObject({ ok: false, code: 'bad_env' });
    }
    expect(prepare(w, { env: { GIT_AUTHOR_NAME: 'Ann', TOKEN: SECRET } }, 'e1')).toMatchObject({ ok: true, value: { launch: { envKeys: ['GIT_AUTHOR_NAME', 'TOKEN'] } } });
  });

  it('path-valued env (CLAUDE_CONFIG_DIR): outside its roots, through a link out, missing are refused; inside accepted (realpath) #FC-4', async () => {
    const w = await world();
    const fx = w.fx;
    for (const v of [fx.out, join(fx.homes, 'escape'), join(fx.homes, 'nope'), 'homes/h1', fx.a]) {
      expect(prepare(w, { env: { CLAUDE_CONFIG_DIR: v } })).toMatchObject({ ok: false, code: 'bad_env' });
    }
    expect(prepare(w, { env: { CLAUDE_CONFIG_DIR: fx.h1 } }, 'p1')).toMatchObject({ ok: true });
    expect(w.gw.records.launchOf('p1')).toEqual({ env: { CLAUDE_CONFIG_DIR: fx.h1 } });
  });

  it('a refused path-valued env names the key, never the value #SE-1', async () => {
    const w = await world();
    for (const v of [w.fx.out, 'homes/h1', join(w.fx.homes, 'nope')]) {
      const r = prepare(w, { env: { CLAUDE_CONFIG_DIR: v } }) as { ok: false; code: string; message: string };
      expect(r).toMatchObject({ ok: false, code: 'bad_env' });
      expect(JSON.stringify(r)).toContain('CLAUDE_CONFIG_DIR');
      expect(JSON.stringify(r)).not.toContain(v);
    }
  });
});

describe('session launch: the launched adapter is what runs (§8.5)', () => {
  it('cwd and env reach the harness through harnessFor; another session of the agent keeps its cwd; no restart between turns; another instance chosen by plan keeps the launch #LA-3', async () => {
    const plan: Policy['plan'] = async (d) => {
      const text = d.inputs.flatMap((i) => i.content).map((c) => (c.type === 'text' ? c.text : '')).join(' ');
      return { harness: text.includes('other') ? 'other' : 'claude', model: 'm', profile: 'restricted' };
    };
    const w = await world({ policy: { plan } });
    const launch = { cwd: w.fx.a, env: { CLAUDE_CONFIG_DIR: w.fx.h1, TOKEN: SECRET } };
    await calloutHost(w, (text) => (text.startsWith('plain') ? { on: 'dispatch', session: { key: 'K-plain' } } : { on: 'dispatch', session: { key: 'K1' }, launch }));

    const r1 = await w.chat.inject({ sender: alice, conversation: group(), text: 'first' });
    expect(matched(w, r1.inputId!)).toMatchObject({ on: 'dispatch', sessionKey: 'K1', launch: { cwd: w.fx.a, envKeys: ['CLAUDE_CONFIG_DIR', 'TOKEN'], outcome: 'applied' } });
    await completed(w, 'K1');
    const [s1] = opened(w, 'K1');
    expect(s1!.args).toMatchObject({ cwd: w.fx.a, env: { CLAUDE_CONFIG_DIR: w.fx.h1, TOKEN: SECRET }, run: { harness: 'claude' } });

    const r2 = await w.chat.inject({ sender: alice, conversation: group(), text: 'second' });
    expect(matched(w, r2.inputId!).launch).toMatchObject({ outcome: 'same' });
    await completed(w, 'K1', 2);
    expect(opened(w, 'K1')).toHaveLength(1);
    expect(w.gw.hub.log.read('K1', 0).some((e) => e.body.t === 'notice' && e.body.code === 'runtime_restart')).toBe(false);

    // The plan names another instance: it opens with the launch too.
    await w.chat.inject({ sender: alice, conversation: group(), text: 'use other' });
    await completed(w, 'K1', 3);
    const s2 = opened(w, 'K1')[1]!;
    expect(s2.args).toMatchObject({ cwd: w.fx.a, env: { CLAUDE_CONFIG_DIR: w.fx.h1, TOKEN: SECRET }, run: { harness: 'other' } });

    // The same agent without a launch: its own cwd, no env.
    await w.chat.inject({ sender: alice, conversation: group(), text: 'plain one' });
    await completed(w, 'K-plain');
    const p = opened(w, 'K-plain')[0]!;
    expect(p.args.cwd).toBe(w.fx.work);
    expect(p.args.env).toBeUndefined();
    expect(w.gw.records.agentOf('K-plain')).toBe('dev');
  });
});

describe('session launch: pinned with the session (§8.6–8.7)', () => {
  it('the same launch again passes; another one is launch_conflict and the input waits in the host queue; also with the lane live; an existing session without a launch conflicts #LA-1', async () => {
    const w = await world();
    let launch: SessionLaunch = { cwd: w.fx.a };
    let key = 'K1';
    const { h } = await calloutHost(w, () => ({ on: 'dispatch', session: { key }, launch }));
    await w.chat.inject({ sender: alice, conversation: group(), text: 'one' });
    await completed(w, 'K1');
    expect(w.gw.sessions().find((s) => s.sessionKey === 'K1')).toMatchObject({ live: true, launch: { cwd: w.fx.a, envKeys: [] } });

    launch = { cwd: w.fx.b };
    const r = await w.chat.inject({ id: 'conf', sender: alice, conversation: group(), text: 'two' });
    expect(matched(w, r.inputId!)).toMatchObject({ on: 'host', callout: { outcome: 'error', reason: 'launch_conflict' }, launch: { cwd: w.fx.b, outcome: 'launch_conflict' } });
    expect((await h.inboundRead({ consumer: 'any' })).items.map((i) => i.channelRef)).toEqual(['channel:fake/conf']);
    // Straight at the lane (live): the conflict is not swallowed by the live-lane shortcut.
    expect(() => w.gw.lane('K1', 'dev', { cwd: w.fx.b })).toThrow(LaneUnavailableError);
    expect(() => w.gw.lane('K1', 'dev', { cwd: w.fx.a, env: { TOKEN: 'x' } })).toThrow(/launch_conflict|launched otherwise/);
    expect(w.gw.lane('K1', 'dev', { cwd: w.fx.a })).toBeDefined();
    expect(w.gw.records.launchOf('K1')).toEqual({ cwd: w.fx.a });

    // A session that exists without a launch: a launch for it conflicts.
    key = 'K-old';
    launch = undefined as never;
    h.onRequest('policy', () => ({ on: 'dispatch', session: { key: 'K-old' } }));
    await w.chat.inject({ sender: alice, conversation: group(), text: 'old' });
    await completed(w, 'K-old');
    const p = w.gw.prepareSession({ v: 1, type: 'session.prepare', id: 'x', sessionKey: 'K-old', agent: 'dev', launch: { cwd: w.fx.a } } as never);
    expect(p).toMatchObject({ ok: false, code: 'launch_conflict' });
    h.onRequest('policy', () => ({ on: 'dispatch', session: { key: 'K-old' }, launch: { cwd: w.fx.a } }));
    const r2 = await w.chat.inject({ sender: alice, conversation: group(), text: 'old again' });
    expect(matched(w, r2.inputId!).callout).toMatchObject({ outcome: 'error', reason: 'launch_conflict' });
  });

  it('session.prepare: idempotent with the same values, launch_conflict / agent_conflict otherwise; a log-only session conflicts, topic bookkeeping alone does not #LA-1', async () => {
    const w = await world({ raw: { agents: agents(fixture(), { dev2: { harness: 'claude', sessionParams: { cwdRoots: ['/'], envKeys: [] } } }) } });
    const h = await w.host();
    const launch = { cwd: w.fx.d };
    // fixture() above was another temp dir; use roots that cover this one through dev2.
    expect(await h.call('session.prepare', { sessionKey: 'S1', agent: 'dev2', launch })).toEqual({ sessionKey: 'S1', agent: 'dev2', launch: { cwd: w.fx.d, envKeys: [] }, created: true });
    expect(await h.call('session.prepare', { sessionKey: 'S1', agent: 'dev2', launch })).toMatchObject({ created: false });
    await expect(h.call('session.prepare', { sessionKey: 'S1', agent: 'dev2', launch: { cwd: w.fx.a } })).rejects.toMatchObject({ code: 'launch_conflict' });
    await expect(h.call('session.prepare', { sessionKey: 'S1', agent: 'dev', launch: {} })).rejects.toMatchObject({ code: 'agent_conflict' });

    // Only a log (e.g. a session of the unconfigured default agent, which never gets an agent row).
    w.gw.hub.append('S-log', { ts: Date.now(), level: 'detail', audience: 'status', durability: 'durable', visibility: 'participants', body: { t: 'notice', code: 'other', message: 'old' } });
    await expect(h.call('session.prepare', { sessionKey: 'S-log', agent: 'dev2', launch })).rejects.toMatchObject({ code: 'launch_conflict' });
    w.gw.hub.append('S-topic', { ts: Date.now(), level: 'detail', audience: 'status', durability: 'durable', visibility: 'participants', body: { t: 'topic.changed', conversation: 'c', to: 't1', reason: 'system' } });
    expect(await h.call('session.prepare', { sessionKey: 'S-topic', agent: 'dev2', launch })).toMatchObject({ created: true });
  });

  it('agent and launch rows are written in one transaction #LA-1', async () => {
    const w = await world();
    const ok = w.gw.prepareSession({ v: 1, type: 'session.prepare', id: 'x', sessionKey: 'A1', agent: 'dev', launch: { cwd: w.fx.a } } as never);
    expect(ok).toMatchObject({ ok: true });
    expect(w.gw.records.agentOf('A1')).toBe('dev');
    expect(w.gw.records.launchOf('A1')).toEqual({ cwd: w.fx.a });
    w.gw.records.betweenPinWrites = () => {
      throw new Error('crash between the writes');
    };
    expect(() => w.gw.prepareSession({ v: 1, type: 'session.prepare', id: 'x', sessionKey: 'A2', agent: 'dev', launch: { cwd: w.fx.a } } as never)).toThrow(/crash/);
    expect(w.gw.records.agentOf('A2')).toBeUndefined();
    expect(w.gw.records.launchOf('A2')).toBeUndefined();
    // Neither half was left behind: once the fault is gone the same prepare works.
    w.gw.records.betweenPinWrites = undefined;
    expect(w.gw.prepareSession({ v: 1, type: 'session.prepare', id: 'x', sessionKey: 'A2', agent: 'dev', launch: { cwd: w.fx.a } } as never)).toMatchObject({ ok: true, value: { created: true } });
  });
});

describe('session launch: restarts, parked topics and new topics (§8.8–8.9)', () => {
  it('a restart reopens the session with its launch and resumes it #LA-1 #RS-1', async () => {
    const fx = fixture();
    const dir = tmp();
    const w = await world({ fx, dir });
    const h = await w.host();
    await h.call('session.prepare', { sessionKey: 'R1', agent: 'dev', launch: { cwd: fx.a, env: { CLAUDE_CONFIG_DIR: fx.h1 } } });
    const c = await w.client();
    await c.input('R1', 'hello');
    await completed(w, 'R1');
    expect(opened(w, 'R1')[0]!.args).toMatchObject({ cwd: fx.a, env: { CLAUDE_CONFIG_DIR: fx.h1 } });
    expect(opened(w, 'R1')[0]!.args.resume).toBeUndefined();
    const native = boundId(w, 'R1');
    expect(native).toBeDefined();
    await w.stop();

    const w2 = await world({ fx, dir });
    const c2 = await w2.client();
    await c2.input('R1', 'again');
    await completed(w2, 'R1', 2);
    expect(opened(w2, 'R1')[0]!.args).toMatchObject({ cwd: fx.a, env: { CLAUDE_CONFIG_DIR: fx.h1 }, resume: native });
  });

  it('a new topic keeps the conversation\'s launch (pinned before its lane opens); switching back uses the old topic\'s; a parked topic that idled out reopens with its launch #LA-1 #TP-1', async () => {
    const w = await world({ raw: { topics: { parkedIdleMs: 40 } } });
    const launch = { cwd: w.fx.a, env: { TOKEN: SECRET } };
    await calloutHost(w, () => ({ on: 'dispatch', session: 'topic', launch }));
    const first = 'dev:fake:default:g1';
    await w.chat.inject({ sender: alice, conversation: group(), text: 'start' });
    await completed(w, first);
    expect(w.gw.records.launchOf(first)).toEqual(launch);

    // A new topic (topic.switch new, like /new and session_rotate: TopicRegistry.create).
    const c = await w.client();
    const seenAtOpen: (SessionLaunch | undefined)[] = [];
    const lane = w.gw.lane.bind(w.gw);
    (w.gw as unknown as { lane: Gateway['lane'] }).lane = (key, agent, l) => {
      if (key !== first) seenAtOpen.push(w.gw.records.launchOf(key));
      return lane(key, agent, l);
    };
    const r = await c.topicSwitch({ conversation: 'fake:default:g1', new: { title: 'second' } });
    const second = r.topic.sessionKey;
    expect(second).not.toBe(first);
    expect(w.gw.records.launchOf(second)).toEqual(launch);
    expect(w.gw.records.agentOf(second)).toBe('dev');
    await w.chat.inject({ sender: alice, conversation: group(), text: 'in the second topic' });
    await completed(w, second);
    expect(seenAtOpen[0]).toEqual(launch);
    expect(opened(w, second)[0]!.args).toMatchObject({ cwd: w.fx.a, env: { TOKEN: SECRET } });

    const native = boundId(w, first);
    // The first topic is parked: its lane idles out and closes.
    await until(() => !w.gw.sessions().find((s) => s.sessionKey === first)?.live);
    const back = await c.topicSwitch({ conversation: 'fake:default:g1', topicId: w.gw.topics.bySession(first)!.id });
    expect(back.topic.sessionKey).toBe(first);
    await w.chat.inject({ sender: alice, conversation: group(), text: 'back in the first' });
    await completed(w, first, 2);
    const reopened = opened(w, first);
    expect(reopened).toHaveLength(2);
    expect(reopened[1]!.args).toMatchObject({ cwd: w.fx.a, env: { TOKEN: SECRET }, resume: native });
  });
});

describe('session launch: Codex (§8.10)', () => {
  it('stdio: a session with env gets its own app-server (env merged, CODEX_HOME as its home), disposed with the lane; cwd only shares the instance #LA-3', async () => {
    const fx = fixture();
    const dispose = vi.spyOn(CodexHarness.prototype, 'dispose').mockResolvedValue();
    cleanups.push(() => dispose.mockRestore());
    const w = await world({
      fx,
      raw: {
        harnesses: { claude: { use: 'claude-code' }, cx: { use: 'codex', env: { BASE: '1' }, transport: { kind: 'stdio' } } },
        agents: agents(fx, { cdx: { harness: 'cx', sessionParams: { cwdRoots: [fx.ws], envKeys: ['CODEX_HOME', 'FOO'], envPathRoots: { CODEX_HOME: [fx.homes] } } } }),
      },
      // Each launched Codex instance (it has FOO) is a real CodexHarness, never started: only dispose is watched.
      build: (i, fake) => new InstanceHarness(i, i.env.FOO ? new CodexHarness({ bin: '/nonexistent', env: i.env, transport: { kind: 'stdio' } }) : fake),
    });
    const prep = (key: string, launch: SessionLaunch) => w.gw.prepareSession({ v: 1, type: 'session.prepare', id: 'x', sessionKey: key, agent: 'cdx', launch } as never);
    expect(prep('C1', { cwd: fx.a, env: { FOO: 'bar', CODEX_HOME: fx.h2 } })).toMatchObject({ ok: true });
    const before = w.built.length;
    const lane = w.gw.lane('C1');
    const own = w.built.slice(before);
    expect(own).toHaveLength(1);
    expect(own[0]).toMatchObject({ name: 'cx', kind: 'codex', env: { BASE: '1', FOO: 'bar', CODEX_HOME: fx.h2 }, codex: { transport: { kind: 'stdio' }, codexHome: fx.h2 } });
    // Closed with its lane (a parked topic idling out, or the daemon stopping).
    await (w.gw as unknown as { closeLane(k: string, l: unknown, r: string): Promise<void> }).closeLane('C1', lane, 'test');
    expect(dispose).toHaveBeenCalledTimes(1);

    // cwd only: no own process.
    expect(prep('C2', { cwd: fx.b })).toMatchObject({ ok: true });
    const n = w.built.length;
    w.gw.lane('C2');
    expect(w.built.slice(n).filter((i) => i.name === 'cx' && i.env.FOO)).toHaveLength(0);
  });

  it('unix: a launch with env is launch_unsupported; cwd only is fine #LA-3', async () => {
    const fx = fixture();
    const w = await world({
      fx,
      raw: {
        harnesses: { claude: { use: 'claude-code' }, cx: { use: 'codex', transport: { kind: 'unix', spawn: 'own', stateDir: join(fx.d, 'cx') } } },
        agents: agents(fx, { cdx: { harness: 'cx', sessionParams: { cwdRoots: [fx.ws], envKeys: ['FOO'] } } }),
      },
    });
    const prep = (key: string, launch: SessionLaunch) => w.gw.prepareSession({ v: 1, type: 'session.prepare', id: 'x', sessionKey: key, agent: 'cdx', launch } as never);
    expect(prep('U1', { cwd: fx.a, env: { FOO: 'bar' } })).toMatchObject({ ok: false, code: 'launch_unsupported' });
    expect(prep('U2', { cwd: fx.a })).toMatchObject({ ok: true });
  });
});

describe('session launch: visibility and leaks (§8.12–8.13)', () => {
  it('env values never show in the event log, explain, sessions, the daemon log or the harness argv; keys do #SE-1', async () => {
    const w = await world();
    const launch = { cwd: w.fx.a, env: { TOKEN: SECRET, CLAUDE_CONFIG_DIR: w.fx.h1 } };
    await calloutHost(w, () => ({ on: 'dispatch', session: { key: 'L1' }, launch }));
    const r = await w.chat.inject({ sender: alice, conversation: group(), text: 'leak?' });
    await completed(w, 'L1');
    const h = await w.host();
    await h.call('session.prepare', { sessionKey: 'L2', agent: 'dev', launch });
    expect(JSON.stringify(w.gw.hub.log.read('L1', 0))).not.toContain(SECRET);
    expect(JSON.stringify(w.gw.router.explain(r.inputId!))).not.toContain(SECRET);
    expect(JSON.stringify(await h.explain(r.inputId!))).not.toContain(SECRET);
    const sessions = await h.sessions();
    expect(JSON.stringify(sessions)).not.toContain(SECRET);
    expect(sessions.find((s) => s.sessionKey === 'L1')).toMatchObject({ launch: { cwd: w.fx.a, envKeys: ['CLAUDE_CONFIG_DIR', 'TOKEN'] } });
    expect(JSON.stringify(w.gw.adminSessions())).not.toContain(SECRET);
    expect(w.logs.join('\n')).not.toContain(SECRET);
    expect(w.logs.join('\n')).toContain('L2: prepared for agent dev');
    // The value reaches the harness only through the open args' env.
    const args = opened(w, 'L1')[0]!.args;
    expect(args.env?.TOKEN).toBe(SECRET);
    const { env: _env, ...rest } = args;
    expect(JSON.stringify(rest)).not.toContain(SECRET);
  });

  // Kept (proposal §3.3 lists it as c1): host-callouts' "… features advertise it" does not check session.launch.
  it('host.hello advertises session.launch #LA-1', async () => {
    const w = await world();
    const c = await w.client();
    const r = await c.hello({ token: w.gw.token, name: 'xwo' });
    expect(r.features).toContain('session.launch');
  });
});

describe('session launch: agent gone, skipWhenPinned (§8.14–8.15)', () => {
  it('a launched session whose agent was removed refuses input instead of falling back to the default agent #FC-1', async () => {
    const fx = fixture();
    const dir = tmp();
    const w = await world({ fx, dir });
    const h = await w.host();
    await h.call('session.prepare', { sessionKey: 'G1', agent: 'dev', launch: { cwd: fx.a } });
    await w.stop();
    const w2 = await world({ fx, dir, raw: { agents: { plain: { harness: 'claude', cwd: fx.work } } } });
    const c = await w2.client();
    await expect(c.input('G1', 'still there?')).rejects.toMatchObject({ code: 'agent_unavailable' });
    const log = w2.gw.hub.log.read('G1', 0);
    expect(log.some((e) => e.body.t === 'notice' && e.body.message.includes('agent_unavailable'))).toBe(true);
    expect(log.some((e) => e.body.t === 'input.rejected' && e.body.reason === 'agent_unavailable')).toBe(true);
    expect(opened(w2, 'G1')).toHaveLength(0);
  });

  it('skipWhenPinned: the host is asked for the first input of a session only; later ones route by the rule with the pinned launch #LA-2', async () => {
    const w = await world();
    const { asked } = await calloutHost(w, () => ({ on: 'dispatch', launch: { cwd: w.fx.a } }), { session: 'per-conversation', callout: { timeoutMs: 2000, onFailure: 'host', skipWhenPinned: true } });
    const key = 'dev:fake:default:g1';
    const r1 = await w.chat.inject({ sender: alice, conversation: group(), text: 'first' });
    expect(matched(w, r1.inputId!)).toMatchObject({ sessionKey: key, callout: { outcome: 'answered' }, launch: { outcome: 'applied' } });
    await completed(w, key);
    const r2 = await w.chat.inject({ sender: alice, conversation: group(), text: 'second' });
    expect(asked).toEqual(['first']);
    expect(matched(w, r2.inputId!)).toMatchObject({ on: 'dispatch', sessionKey: key, callout: { outcome: 'skipped_pinned', on: 'dispatch' } });
    await completed(w, key, 2);
    expect(opened(w, key)).toHaveLength(1);
    expect(opened(w, key)[0]!.args.cwd).toBe(w.fx.a);
    // Another conversation is not pinned yet: asked.
    await w.chat.inject({ sender: alice, conversation: group('g2'), text: 'other conversation' });
    expect(asked).toEqual(['first', 'other conversation']);
  });
});
