// A hand-rolled peer that misbehaves on purpose. MODE selects how.
//   noisy  garbage, unknown and invalid frames around valid ones
//   mute   answers hello, then never answers anything
//   die    answers hello, then exits on the first request
//   flap   answers hello, then exits after 20ms
//   flaky  first launch (FLAKY_FILE missing) answers hello and exits after 50ms; later launches
//          answer hello only after 300ms, then stay up
//   fatal  answers hello, then logs `fatal` and keeps running
//   badresult  answers send with an error that lacks `code`
//   newer  declares an optional method this host does not know
// PIDS_FILE=<p> appends each launch's pid, one per line.
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { defaultChannelCaps } from '@agents-io/testkit';

const mode = process.env.MODE;
const out = (f) => process.stdout.write((typeof f === 'string' ? f : JSON.stringify(f)) + '\n');
const env = {
  v: 1, id: 'ok-1', channel: 'raw', account: 'default',
  conversation: { id: 'c1', kind: 'dm' },
  sender: { channelUserId: 'u1', evidence: 'none' },
  content: [{ type: 'text', text: 'valid' }],
  replyRoute: null,
};

if (process.env.PIDS_FILE) appendFileSync(process.env.PIDS_FILE, `${process.pid}\n`);
let firstFlaky = false;
if (mode === 'flaky') {
  firstFlaky = !existsSync(process.env.FLAKY_FILE);
  if (firstFlaky) writeFileSync(process.env.FLAKY_FILE, 'x');
}

if (mode === 'noisy') {
  out('this is not json');
  out('[1,2]');
  out({ v: 1, type: 'mystery', id: 'x' });
  out({ v: 1, type: 'inbound', id: 'bad', envelope: { nope: true } });
}

for await (const line of createInterface({ input: process.stdin })) {
  let f;
  try { f = JSON.parse(line); } catch { continue; }
  if (f.type === 'hello') {
    const hello = () =>
      out({ v: 1, type: 'result', id: f.id, ok: true, value: { adapterId: 'raw', caps: defaultChannelCaps, methods: mode === 'newer' ? ['edit', 'react'] : [] } });
    if (mode === 'flaky' && !firstFlaky) setTimeout(hello, 300);
    else hello();
    if (mode === 'flap' || (mode === 'flaky' && firstFlaky)) setTimeout(() => process.exit(1), mode === 'flap' ? 20 : 50);
    if (mode === 'fatal') out({ v: 1, type: 'log', level: 'fatal', msg: 'cannot log in' });
    if (mode === 'noisy') out({ v: 1, type: 'inbound', id: 'good', envelope: env });
  } else if (f.type === 'result') {
    process.stderr.write(`got-result ${f.id} ok=${f.ok} code=${f.error?.code}\n`);
  } else if (f.type === 'shutdown') {
    process.exit(0);
  } else if (mode === 'die') {
    process.exit(3);
  } else if (mode === 'badresult' && f.type === 'send') {
    out({ v: 1, type: 'result', id: f.id, ok: false, error: { message: 'not found' } });
  } else if (mode === 'newer' && f.type === 'edit') {
    out({ v: 1, type: 'result', id: f.id, ok: true });
  } else if (mode === 'noisy' && f.type === 'send') {
    out({ v: 1, type: 'result', id: f.id, ok: true, value: { providerMessageId: 'raw-1' } });
  }
}
