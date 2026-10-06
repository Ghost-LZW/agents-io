// A real channel process: serveChannel(FakeChannel). Behaviour is selected by env.
//   INJECT=<n>      emit n inbound messages once started
//   CRASH_FILE=<p>  first launch (file missing) creates it, injects "before-crash", then exits 1;
//                   later launches inject "after-restart" and keep running
import { existsSync, writeFileSync } from 'node:fs';
import { FakeChannel } from '@agents-io/testkit';
import { serveChannel } from '../../dist/index.js';

const ch = new FakeChannel('fake-child');
const started = ch.start.bind(ch);
ch.start = async (ctx) => {
  const run = started(ctx);
  setTimeout(async () => {
    if (process.env.CRASH_FILE) {
      const first = !existsSync(process.env.CRASH_FILE);
      if (first) writeFileSync(process.env.CRASH_FILE, 'x');
      await ch.inject({ text: first ? 'before-crash' : 'after-restart' });
      if (first) setTimeout(() => process.exit(1), 100);
    }
    for (let i = 0; i < Number(process.env.INJECT ?? 0); i++) await ch.inject({ text: `msg-${i}` });
  }, 20);
  process.stderr.write('child started\n');
  await run;
};
await serveChannel(ch);
