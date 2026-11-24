// A real harness program: serveHarness(a FakeHarness), its behaviour selected by env. Every call it
// gets is appended to RECORD (JSON lines: { call, …, pid }) when set.
//   DECLARES=<json>   its static declarations (HarnessAdapter displayName, compact, modes, …)
//   METHODS=detach    it has detach: it writes its running turns to STATE and ends its sessions
//   STATE=<file>      a reopened session ({ resume }) whose turn is in STATE adopts it (turn.adopted), then completes it
//   CAPS=<json>       over the fake's caps
//   CLIENT=1          a terminal joins a native session with `fake-tui --resume <id>` (nativeClient)
//   MODE=stubborn     ignores shutdown (and SIGTERM): the host has to kill it
// A turn binds native session `native-<sessionKey>`. Its text: `long…` runs until interrupted;
// `die` makes the program exit; an input with media blocks answers what blob.stat / blob.get say of
// each ref; anything else answers `echo: <text>`.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { FakeHarness } from '@agents-io/testkit';
import { serveHarness } from '../../src/index.js';

const env = process.env;
const record = (r) => env.RECORD && appendFileSync(env.RECORD, JSON.stringify({ ...r, pid: process.pid }) + '\n');
const caps = env.CAPS ? JSON.parse(env.CAPS) : {};
const textOf = (inputs) => inputs.flatMap((i) => i.content).map((c) => (c.type === 'text' ? c.text : '')).join(' ');
record({ call: 'start', argv: process.argv, cwd: process.cwd(), role: env.ROLE, foo: env.FOO, runId: env.AGENTS_IO_RUN_ID });
if (env.MODE === 'stubborn') {
  process.on('SIGTERM', () => {});
  setInterval(() => {}, 1000);
}

await serveHarness((init) => {
  record({ call: 'init', instance: init.instance, config: init.config, blobs: !!init.blobs });
  /** sessionKey → its turn now running: { turnId, inputIds } */
  const running = new Map();
  const fake = new FakeHarness(async (t) => {
    const key = [...running].find(([, r]) => r.turnId === t.turnId)?.[0];
    t.emit({ t: 'session.bound', nativeId: `native-${key}` });
    const text = textOf(t.inputs);
    const media = t.inputs.flatMap((i) => i.content).filter((c) => 'ref' in c);
    if (media.length) {
      const seen = [];
      const failed = (e) => `error ${e.code ?? ''}`;
      for (const m of media) {
        const st = await init.blobs.stat(m.ref).then((x) => (x ? `${x.mime} ${x.size} ${existsSync(x.path)}` : 'none'), failed);
        const got = await init.blobs.get(m.ref).then((b) => `${b.mime} ${b.bytes.length} ${Buffer.from(b.bytes).toString('hex').slice(0, 16)}`, failed);
        seen.push(`${m.ref}: stat ${st}; get ${got}`);
      }
      record({ call: 'blobs', seen });
      t.emit({ t: 'text.snapshot', text: `blobs: ${seen.join(' | ')}`, final: true }, { audience: 'answer' });
    } else if (text.startsWith('long')) {
      await new Promise((_, reject) => t.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
    } else if (text === 'die') {
      setTimeout(() => process.exit(3), 20);
      await new Promise(() => {});
    } else t.emit({ t: 'text.snapshot', text: `echo: ${text}`, final: true }, { audience: 'answer' });
    if (key && running.get(key)?.turnId === t.turnId) running.delete(key);
  }, 'fake-program');

  const state = () => (env.STATE && existsSync(env.STATE) ? JSON.parse(readFileSync(env.STATE, 'utf8')) : {});
  const adapter = {
    id: 'fake-program',
    probe: async () => {
      const p = await fake.probe();
      return { version: p.version, caps: { ...p.caps, ...caps } };
    },
    async open(args) {
      record({ call: 'open', sessionKey: args.sessionKey, generation: args.generation, cwd: args.cwd, resume: args.resume, run: args.run, env: args.env, instructions: args.instructions, options: args.options, mcp: !!args.mcp });
      const s = await fake.open(args);
      const start = s.startTurn.bind(s);
      s.startTurn = async (turnId, inputs, run) => {
        record({ call: 'startTurn', sessionKey: args.sessionKey, turnId, inputs: inputs.map((i) => ({ text: textOf([i]), native: i.channelContext.nativeCommand === true })), run });
        running.set(args.sessionKey, { turnId, inputIds: inputs.map((i) => i.inputId) });
        return start(turnId, inputs, run);
      };
      const interrupt = s.interrupt.bind(s);
      s.interrupt = async (turnId) => (record({ call: 'interrupt', sessionKey: args.sessionKey, turnId }), interrupt(turnId));
      const close = s.close.bind(s);
      s.close = async (reason) => (record({ call: 'close', sessionKey: args.sessionKey, reason }), close(reason));
      if (caps.injectWithoutTurn) s.inject = async (inputs) => void record({ call: 'inject', sessionKey: args.sessionKey, inputs: inputs.map((i) => textOf([i])) });
      if (caps.cancelQueued) s.cancelQueued = async (inputIds) => void record({ call: 'cancelQueued', sessionKey: args.sessionKey, inputIds });
      // The turn a previous host left running on this session: adopted, then it completes.
      const left = args.resume !== undefined && JSON.parse(env.DECLARES ?? '{}').adopts ? state()[args.sessionKey] : undefined;
      if (left) {
        record({ call: 'adopt', sessionKey: args.sessionKey, turnId: left.turnId });
        const ev = (body) => s.queue.push({ ts: Date.now(), level: 'primary', audience: body.t === 'text.snapshot' ? 'answer' : 'status', durability: 'durable', turnId: left.turnId, body });
        // Adopted as it opens (before its answer), so the host's lane takes it as its turn; done a moment later.
        ev({ t: 'turn.adopted', turnId: left.turnId, inputIds: left.inputIds });
        setTimeout(() => {
          ev({ t: 'input.consumed', inputIds: left.inputIds, turnId: left.turnId });
          ev({ t: 'text.snapshot', text: 'adopted: done', final: true });
          ev({ t: 'turn.completed', turnId: left.turnId, status: 'completed' });
        }, 50);
      }
      return s;
    },
    async dispose() {
      record({ call: 'dispose' });
    },
  };
  if (env.CLIENT) adapter.nativeClient = (nativeId) => ({ command: 'fake-tui', args: ['--resume', nativeId] });
  if ((env.METHODS ?? '').split(',').includes('detach')) {
    adapter.detach = async () => {
      record({ call: 'detach', running: Object.fromEntries(running) });
      if (env.STATE) writeFileSync(env.STATE, JSON.stringify(Object.fromEntries(running)));
      // No interrupt, no more events: the turns stay open for the next host.
      for (const s of fake.sessions) s.queue.close();
    };
  }
  Object.assign(adapter, JSON.parse(env.DECLARES ?? '{}'));
  return adapter;
});
record({ call: 'exit' });
if (env.MODE !== 'stubborn') process.exit(0);
