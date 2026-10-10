import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { main } from '../src/cli.js';
import { cli } from './cli-helpers.js';
import { daemon } from './helpers.js';

describe('cli against a daemon', () => {
  it('aio tail --once / ack / send / bindings / explain / verify #HQ-1 #DL-2 #EX-1', async () => {
    const w = await daemon();
    const s = ['--socket', w.config.socketPath];
    const tableFile = join(w.dir, 'table.json');
    writeFileSync(tableFile, JSON.stringify({ version: 't1', bindings: [{ id: 'h', match: { keywords: ['xwo'] }, on: 'host' }], identities: [], onHostDown: 'keep' }));
    const put = await cli(['bindings', 'put', ...s, '--file', tableFile]);
    expect(put.code).toBe(0);
    expect(JSON.parse(put.out)).toMatchObject({ version: 't1', active: true });
    expect(JSON.parse((await cli(['bindings', 'get', ...s])).out).host.table.version).toBe('t1');

    const alice = { channelUserId: 'alice', evidence: 'platform_signed' as const };
    const r = await w.chat.inject({ id: 'x1', sender: alice, text: 'xwo one' });
    await w.chat.inject({ id: 'x2', sender: alice, text: 'xwo two' });
    const t1 = await cli(['tail', ...s, '--consumer', 'xwo', '--once']);
    const lines = t1.out.trim().split('\n').map((l) => JSON.parse(l));
    expect(lines.map((l) => l.channelRef)).toEqual(['channel:fake/x1', 'channel:fake/x2']);
    expect(typeof lines[0].cursor).toBe('number');
    expect((await cli(['ack', ...s, '--consumer', 'xwo', String(lines[0].cursor)])).out).toMatch(/xwo acked/);
    expect((await cli(['tail', ...s, '--consumer', 'xwo', '--once'])).out.trim().split('\n')).toHaveLength(1);
    expect((await cli(['tail', ...s, '--consumer', 'xwo', '--once', '--from', String(lines[1].cursor)])).out).toBe('');

    const sent = await cli(['send', ...s, '--route', '{"channel":"fake","account":"default","conversationId":"c9"}', '--operation-id', 'o1', '--text', 'hi there']);
    expect(sent.code).toBe(0);
    expect(JSON.parse(sent.out)).toMatchObject({ status: 'delivered', duplicate: false });
    expect(JSON.parse((await cli(['send', ...s, '--route', '{"channel":"fake","account":"default","conversationId":"c9"}', '--operation-id', 'o1', '--text', 'hi there'])).out).duplicate).toBe(true);
    expect(w.chat.sent.filter((x) => x.msg.text === 'hi there')).toHaveLength(1);

    const ex = await cli(['explain', ...s, r.inputId!]);
    expect(JSON.parse(ex.out).matched.find((m: { bindingId: string }) => m.bindingId === 'h')).toMatchObject({ source: 'host', on: 'host' });
    expect((await cli(['verify', ...s, 'channel:fake/x1'])).code).toBe(0);
    expect((await cli(['verify', ...s, 'channel:fake/zz'])).code).toBe(1);
    await expect(main(['explain', ...s, 'in_unknown'])).rejects.toMatchObject({ code: 'unknown_input' });
  });
});
