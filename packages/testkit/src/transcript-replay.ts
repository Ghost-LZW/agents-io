#!/usr/bin/env node
import { FrameDecoder } from '@agents-io/protocol';
import { readTranscript } from './conformance/transcript.js';
import { TranscriptReplay, teardownAnswers } from './conformance/replay.js';

/*
 * A harness transcript played as the harness program, over stdio (docs/design/conformance-fixtures
 * §2.3): spawn it where the real program would go (`codex app-server` for the Codex adapter's stdio
 * transport, a `bridge` harness instance's `command`), in any language's kernel or adapter.
 *
 *   aio-transcript-replay <transcript.ndjson> [--bind name=value]... [--after-end error|answer]
 *
 * Frames read on stdin are checked against the transcript's `expect_outbound` lines; its
 * `emit_inbound` lines are written to stdout. Exit codes: the transcript's `runtime_exit`
 * (success 0, error 1, cancelled 130); 0 when stdin ends after the last line; 3 on a frame that
 * differs from the transcript, or comes after its end with `--after-end error` (the default); 4
 * when stdin ends before the last line; 2 on bad arguments. Why goes to stderr. Gates are for
 * in-process replays (`TranscriptReplay.release`): here lines are played in order.
 */

function usage(msg: string): never {
  process.stderr.write(`${msg}\nusage: aio-transcript-replay <transcript.ndjson> [--bind name=value]... [--after-end error|answer]\n`);
  process.exit(2);
}

const args = process.argv.slice(2);
let file: string | undefined;
const bindings = new Map<string, unknown>();
let afterEnd: 'error' | 'answer' = 'error';
for (let i = 0; i < args.length; i++) {
  const a = args[i]!;
  if (a === '--bind') {
    const kv = args[++i];
    const eq = kv?.indexOf('=') ?? -1;
    if (!kv || eq <= 0) usage('--bind needs name=value');
    bindings.set(kv.slice(0, eq), kv.slice(eq + 1));
  } else if (a === '--after-end') {
    const v = args[++i];
    if (v !== 'error' && v !== 'answer') usage('--after-end is error or answer');
    afterEnd = v;
  } else if (a.startsWith('--')) usage(`unknown option ${a}`);
  else if (file === undefined) file = a;
  else usage(`unexpected ${a}`);
}
if (!file) usage('no transcript');

let transcript;
try {
  transcript = readTranscript(file);
} catch (e) {
  process.stderr.write(`aio-transcript-replay: ${(e as Error).message}\n`);
  process.exit(2);
}

const write = (frame: unknown) => process.stdout.write(JSON.stringify(frame) + '\n');
const replay = new TranscriptReplay(transcript, {
  emit: write,
  bindings,
  afterEnd: afterEnd === 'answer' ? teardownAnswers(transcript.header.protocol) : 'error',
  exit: (status, error) => {
    if (error !== undefined) process.stderr.write(`aio-transcript-replay: runtime_exit ${status}: ${JSON.stringify(error)}\n`);
    process.stdout.write('', () => process.exit(status === 'success' ? 0 : status === 'error' ? 1 : 130));
  },
  onError: (e) => {
    process.stderr.write(`aio-transcript-replay: ${file}: ${e.kind}: ${e.message}\n`);
    process.stdout.write('', () => process.exit(3));
  },
}).start();

const decoder = new FrameDecoder((line, err) => process.stderr.write(`aio-transcript-replay: unreadable line ${JSON.stringify(line.slice(0, 120))}: ${String(err)}\n`));
process.stdin.on('data', (chunk: Buffer) => {
  for (const f of decoder.push(chunk)) {
    // The bridge's `shutdown` after the last line ends the program (`--after-end answer`).
    if (afterEnd === 'answer' && replay.done && (f as { type?: unknown } | null)?.type === 'shutdown') process.exit(0);
    replay.outbound(f);
  }
});
process.stdin.on('end', () => {
  // The other side closed: done if every line was played (inbound lines still to go get a moment).
  setTimeout(() => {
    if (replay.error) return;
    if (replay.done) process.exit(0);
    process.stderr.write(`aio-transcript-replay: ${file}: stdin ended at line ${replay.line} of ${transcript.entries.length + 1}\n`);
    process.exit(4);
  }, 20);
});
