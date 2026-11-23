import { FakeHarness } from '@agents-io/testkit';

/** A turn answers `<who>: <text>`. */
const script = (who) => async (t) => {
  const text = t.inputs.flatMap((i) => i.content).map((c) => (c.type === 'text' ? c.text : '')).join(' ');
  t.emit({ t: 'text.snapshot', text: `${who}: ${text}`, final: true }, { audience: 'answer' });
};

/**
 * A module harness whose terminal UI takes sessions over (`attach: 'takeover'`, `takeover`).
 * globalThis.__takeover[config.key] = { headless, takeovers }: the headless FakeHarness, and per
 * takeover its args, its terminal (a FakeHarness whose sessions bind the takeover's native id,
 * `terminal`), `connect()` / `leave(reason)` to play the terminal, `ended` (the reasons `end` was
 * called with), `closed` (the reasons its terminal's sessions were closed with) and `launches`
 * (how often `launch` was asked). With `config.failOpen` the terminal's sessions cannot open; with
 * `config.endFails` (`'throw'` / `'reject'`) its `end` is broken: it throws, or returns a rejected
 * promise, and ends nothing.
 */
export function createHarness(init) {
  const c = init.config ?? {};
  const headless = new FakeHarness(script('headless'), 'takeover');
  const rec = { headless, takeovers: [] };
  (globalThis.__takeover ??= {})[c.key] = rec;
  return {
    id: 'takeover',
    attach: 'takeover',
    probe: () => headless.probe(),
    open: (args) => headless.open(args),
    async takeover(a) {
      const terminal = new FakeHarness(script('terminal'), a.instance);
      const t = { args: a, terminal, ended: [], closed: [], launches: 0 };
      // The terminal runs on the native session it was given: the session's log says so (`session.bound`).
      const harness = {
        id: a.instance,
        probe: () => terminal.probe(),
        async open(args) {
          if (c.failOpen) throw new Error('the terminal broke');
          const s = await terminal.open(args);
          s.nativeId = () => a.nativeId;
          s.queue.push({ ts: Date.now(), level: 'primary', audience: 'status', durability: 'durable', body: { t: 'session.bound', nativeId: a.nativeId } });
          const close = s.close.bind(s);
          s.close = (reason) => {
            t.closed.push(reason);
            return close(reason);
          };
          return s;
        },
      };
      let connected = false;
      let over = false;
      const leave = (reason) => {
        if (over) return;
        over = true;
        connected = false;
        // The terminal's sessions end with it: the lane's next turn opens the headless adapter again.
        for (const s of terminal.sessions) void s.close(reason);
        a.services.onEnd(reason);
      };
      t.connect = () => void (connected = true);
      t.leave = leave;
      rec.takeovers.push(t);
      return {
        harness,
        get connected() {
          return connected;
        },
        launch() {
          t.launches++;
          return { command: 'fake-term', args: [a.resume ? '--resume' : '--new', a.nativeId], env: { TERM_HOME: '/t' }, unsetEnv: ['PARENT_MARKER'] };
        },
        end(reason) {
          t.ended.push(reason);
          if (c.endFails === 'throw') throw new Error('end broke');
          if (c.endFails === 'reject') return Promise.reject(new Error('end broke'));
          leave(reason);
        },
      };
    },
  };
}
