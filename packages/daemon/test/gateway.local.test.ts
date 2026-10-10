import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { runAttach } from '../src/attach.js';
import { setup, until } from './gateway-helpers.js';

describe('gateway wiring', () => {
  it('attach end: prints the stream and turns lines into commands', async () => {
    const w = await setup();
    const c = await w.client();
    const input = new PassThrough();
    const output = new PassThrough();
    let text = '';
    output.on('data', (d) => (text += d.toString()));
    const done = runAttach({ client: c, sessionKey: 's', tier: 'full', input, output, color: false });
    await until(() => text.includes('attached to s'));
    input.write('hello\n');
    await until(() => text.includes('turn') && text.includes('completed'));
    input.write('/bogus\n');
    input.write('/sessions\n');
    await until(() => text.includes('* s  idle'));
    input.write('/quit\n');
    await done;
    expect(text).toContain('echo: hello');
    expect(text).toContain('(input: new_turn)');
    expect(text).toContain('unknown command /bogus');
  });
});
