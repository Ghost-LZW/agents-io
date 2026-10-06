// A hand-rolled peer that misbehaves on purpose. MODE selects how.
//   noisy  garbage, unknown and invalid frames around valid ones
//   mute   answers hello, then never answers anything
//   die    answers hello, then exits on the first request
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
    out({ v: 1, type: 'result', id: f.id, ok: true, value: { adapterId: 'raw', caps: defaultChannelCaps, methods: [] } });
    if (mode === 'noisy') out({ v: 1, type: 'inbound', id: 'good', envelope: env });
  } else if (f.type === 'result') {
    process.stderr.write(`got-result ${f.id} ok=${f.ok} code=${f.error?.code}\n`);
  } else if (f.type === 'shutdown') {
    process.exit(0);
  } else if (mode === 'die') {
    process.exit(3);
  } else if (mode === 'noisy' && f.type === 'send') {
    out({ v: 1, type: 'result', id: f.id, ok: true, value: { providerMessageId: 'raw-1' } });
  }
}
