// A hand-written harness program (no serveHarness), for what the host does with odd peers. By env:
//   HELLO=<json>        the value it answers probe with (default: version and caps only, an older program)
//   HELLO2=<json>       with LAUNCHES: the value from its second launch on
//   LAUNCHES=<file>     records launches (one line each)
//   MODE=noisy          before answering probe: a malformed line, an unknown frame type, an invalid event, a log
//   MODE=mute           answers nothing
//   MODE=v2             answers probe in a frame of another protocol version
//   MODE=die            exits as soon as it is asked to open
//   MODE=deaf           answers probe and open, nothing after
//   MODE=fatal          after answering open, logs fatal (and keeps running)
// open answers {}; startTurn emits a complete turn echoing the text (`die`: it exits); close answers; shutdown exits.
import { appendFileSync, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';

const env = process.env;
const out = (f) => process.stdout.write(JSON.stringify(f) + '\n');
const caps = { steer: 'none', interrupt: true, approvals: false, questions: false, tokenDeltas: false, cancelQueued: false, injectWithoutTurn: false, resume: true, switchModelMidSession: true, switchProfileMidSession: true };
const second = env.LAUNCHES && existsSync(env.LAUNCHES);
if (env.LAUNCHES) appendFileSync(env.LAUNCHES, `${process.pid}\n`);
const hello = second && env.HELLO2 ? JSON.parse(env.HELLO2) : env.HELLO ? JSON.parse(env.HELLO) : { version: 'raw-1', caps };
const sessions = new Map();
const ev = (sessionKey, turnId, body) =>
  out({ v: 1, type: 'event', sessionKey, generation: sessions.get(sessionKey), event: { ts: Date.now(), turnId, level: 'primary', audience: body.t === 'text.snapshot' ? 'answer' : 'status', durability: 'durable', body } });

for await (const line of createInterface({ input: process.stdin })) {
  if (!line.trim()) continue;
  const f = JSON.parse(line);
  if (env.MODE === 'mute' || (env.MODE === 'deaf' && f.type !== 'probe' && f.type !== 'open')) continue;
  const ok = (value) => out({ v: 1, type: 'result', id: f.id, ok: true, value });
  switch (f.type) {
    case 'probe':
      if (env.MODE === 'noisy') {
        process.stdout.write('this is not json\n');
        out({ v: 1, type: 'from-the-future', id: 'x' });
        out({ v: 1, type: 'event', sessionKey: 'nobody', generation: 1, event: { body: { t: 'nope' } } });
        out({ v: 1, type: 'log', level: 'info', msg: 'noisy program says hi' });
        process.stderr.write('noisy on stderr\n');
      }
      if (env.MODE === 'v2') out({ v: 2, type: 'result', id: f.id, ok: true, value: hello });
      else ok(hello);
      break;
    case 'open':
      if (env.MODE === 'die') process.exit(4);
      sessions.set(f.sessionKey, f.generation);
      ok({});
      if (env.MODE === 'fatal') out({ v: 1, type: 'log', level: 'fatal', msg: 'cannot go on' });
      break;
    case 'startTurn': {
      ok(null);
      const ids = f.inputs.map((i) => i.inputId);
      const text = f.inputs.flatMap((i) => i.content).map((c) => c.text ?? '').join(' ');
      if (text === 'die') process.exit(5);
      ev(f.sessionKey, f.turnId, { t: 'turn.started', turnId: f.turnId, inputIds: ids, replyRoute: f.inputs[0]?.replyRoute ?? null, ...(f.run ? { run: f.run } : {}) });
      ev(f.sessionKey, f.turnId, { t: 'text.snapshot', text: `raw: ${text}`, final: true });
      ev(f.sessionKey, f.turnId, { t: 'input.consumed', inputIds: ids, turnId: f.turnId });
      ev(f.sessionKey, f.turnId, { t: 'turn.completed', turnId: f.turnId, status: 'completed' });
      break;
    }
    case 'steer':
      ok('unsupported');
      break;
    case 'close':
      sessions.delete(f.sessionKey);
      ok(null);
      break;
    case 'shutdown':
      process.exit(0);
    default:
      if (f.id) out({ v: 1, type: 'result', id: f.id, ok: false, error: { code: 'unsupported', message: `raw program has no ${f.type}` } });
  }
}
