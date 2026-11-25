import { createConnection } from 'node:net';
import { describe, expect, it } from 'vitest';
import { encodeFrame, type KernelContext, type ModuleConnection, type ModuleManifest, type SessionEvent } from '@agents-io/protocol';
import { ModuleRegistry } from '@agents-io/kernel';
import { itemStatus, itemTypeOf, permissionDecisions, permissionOutcome, turnOutcome } from '@agents-io/harness-acp';
import { builtinModules } from '../src/bundle.js';
import { permissionDecision, permissionOptions, stopReasonOf, toolKindOf, toolStatusOf } from '../src/acp-projection.js';
import { cli } from './cli-helpers.js';
import { cleanups, daemon, until } from './helpers.js';

/*
 * The seams the north projections need (core-slimming G9): a module takes a local socket
 * connection (`ModuleInstance.connect`, the client frame `module.connect`), reads a session as it
 * goes (`KernelContext.subscribe`), puts a blob (`KernelContext.blobs`), adds a CLI command
 * (`ModuleManifest.cli`); and the ACP tables both ways agree (the north's `acp-projection.ts`,
 * the south's `harness/acp/src/map.ts`). No promise of their own: the ACP server and the AG-UI
 * endpoint are what use them (their tests carry the ids).
 */

/** A raw socket client: JSON lines both ways. */
async function raw(path: string) {
  const s = createConnection(path);
  await new Promise<void>((r) => s.once('connect', () => r()));
  const got: unknown[] = [];
  let buf = '';
  s.on('data', (d) => {
    buf += d.toString();
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.trim()) got.push(JSON.parse(line));
    }
  });
  cleanups.push(() => void s.destroy());
  return { s, got, write: (v: unknown) => s.write(typeof v === 'string' ? v : encodeFrame(v)) };
}

/** A module that takes connections saying `{ ok: true }` and echoes every value back, with what it got from the kernel. */
function echo(seen: { k?: KernelContext; conns: ModuleConnection[] }): ModuleManifest {
  return {
    id: 'echo',
    kind: 'feature',
    cli: { 'echo-cmd': { usage: '[--loud]   (says hi)', options: { loud: 'boolean' }, run: async (a) => (process.stdout.write(`${a.options.loud ? 'HI' : 'hi'} ${a.positionals.join(',')}\n`), 0) } },
    setup: (k) => {
      seen.k = k;
      return {
        connect: (hello, conn) => {
          if ((hello as { ok?: boolean } | undefined)?.ok !== true) return { ok: false, code: 'unauthorized', message: 'no' };
          seen.conns.push(conn);
          conn.send({ early: true });
          conn.onValue((v) => conn.send({ echo: v }));
          return { ok: true, value: { took: true } };
        },
      };
    },
  };
}

describe('module.connect: a module takes a local socket connection', () => {
  it('accepted: the result first, then the module\'s values both ways (also what came before the answer); refused, it stays a client connection; after host.hello it is refused; an id no running module takes is unsupported', async () => {
    const seen: { k?: KernelContext; conns: ModuleConnection[] } = { conns: [] };
    const w = await daemon({ moduleRegistry: new ModuleRegistry([...builtinModules.modules, { manifest: echo(seen), origin: 'module' }], { fields: Object.fromEntries(builtinModules.fields) }) });
    const c = await raw(w.config.socketPath);
    c.write({ v: 1, type: 'module.connect', id: 'm1', module: 'echo', hello: { ok: true } });
    c.write('{"a":1}\n');
    c.write('not json\n');
    c.write({ b: 2 });
    await until(() => c.got.length >= 4);
    expect(c.got).toEqual([{ v: 1, type: 'result', id: 'm1', ok: true, value: { took: true } }, { early: true }, { echo: { a: 1 } }, { echo: { b: 2 } }]);
    // The far end goes: the module's connection says so.
    c.s.destroy();
    await until(() => seen.conns[0]!.signal.aborted);

    const r = await raw(w.config.socketPath);
    r.write({ v: 1, type: 'module.connect', id: 'm2', module: 'echo', hello: {} });
    r.write({ v: 1, type: 'sessions', id: 's1' });
    await until(() => r.got.length >= 2);
    expect(r.got[0]).toEqual({ v: 1, type: 'result', id: 'm2', ok: false, error: { code: 'unauthorized', message: 'no' } });
    expect(r.got[1]).toMatchObject({ type: 'result', id: 's1', ok: true });
    r.write({ v: 1, type: 'module.connect', id: 'm3', module: 'nope' });
    await until(() => r.got.length >= 3);
    expect(r.got[2]).toMatchObject({ id: 'm3', ok: false, error: { code: 'unsupported' } });

    const h = await w.host({ name: 'xwo' });
    expect(await h.exchange({ type: 'module.connect', module: 'echo', hello: { ok: true } })).toMatchObject({ ok: false, error: { code: 'forbidden' } });
  });

  it('KernelContext.subscribe: from no seq a session.snapshot first, then live; from a seq what came after it; blobs.put stores', async () => {
    const seen: { k?: KernelContext; conns: ModuleConnection[] } = { conns: [] };
    const w = await daemon({ moduleRegistry: new ModuleRegistry([...builtinModules.modules, { manifest: echo(seen), origin: 'module' }], { fields: Object.fromEntries(builtinModules.fields) }) });
    const local = await w.client();
    await local.input('S1', 'one');
    await until(() => w.gw.hub.log.read('S1', 0).some((e) => e.body.t === 'turn.completed'));
    const k = seen.k!;
    const take = async (sub: AsyncIterable<SessionEvent>, n: number) => {
      const out: SessionEvent[] = [];
      for await (const e of sub) if (out.push(e) >= n) break;
      return out;
    };
    const fromNone = k.subscribe('S1');
    const [snap] = await take(fromNone, 1);
    expect(snap!.body).toMatchObject({ t: 'session.snapshot', snapshot: { sessionKey: 'S1', seq: w.gw.hub.log.head('S1') } });
    const fromOne = await take(k.subscribe('S1', { fromSeq: 1 }), 2);
    expect(fromOne.map((e) => e.seq)).toEqual([2, 3]);
    expect(() => k.subscribe('S1', { fromSeq: -1 })).toThrow(/fromSeq must be a seq/);
    const ref = await k.blobs.put(new Uint8Array([1, 2, 3]), { mime: 'image/png' });
    expect(ref).toMatch(/^sha256:/);
    expect((await w.gw.blobs.get(ref)).bytes).toEqual(new Uint8Array([1, 2, 3]));
    await expect(k.blobs.put('nope' as never, { mime: 'image/png' })).rejects.toThrow(/Uint8Array/);
  });
});

describe('ModuleManifest.cli: a module adds a command to aio', () => {
  it('names and options are checked when registering, one module\'s each; the CLI parses its options and runs it; --help prints its usage', async () => {
    const m = (cli: unknown, id = 'x'): ModuleManifest => ({ id, kind: 'feature', cli: cli as never, setup: () => ({}) });
    expect(() => new ModuleRegistry([m({ 'Bad Name': { usage: 'u', run: async () => 0 } })])).toThrow(/cli: "Bad Name" is not a command name/);
    expect(() => new ModuleRegistry([m({ go: { usage: '', run: async () => 0 } })])).toThrow(/cli\.go must be \{ usage/);
    expect(() => new ModuleRegistry([m({ go: { usage: 'u', options: { socket: 'string' }, run: async () => 0 } })])).toThrow(/one of the CLI's common options/);
    expect(() => new ModuleRegistry([m({ go: { usage: 'u', run: async () => 0 } }), m({ go: { usage: 'u', run: async () => 0 } }, 'y')])).toThrow(/CLI command go is also module x's/);
    expect(builtinModules.cliCommand('acp')).toMatchObject({ module: 'acp-server', command: { options: { client: 'string', 'token-file': 'string', session: 'string' } } });

    const help = await cli(['acp', '--help']);
    expect(help.code).toBe(0);
    expect(help.out).toMatch(/^aio acp --client <name>/);
    const top = await cli(['help']);
    expect(top.out).toMatch(/aio acp +--client <name>.*\[module acp-server\]/);
    await expect(cli(['acp', '--nope'])).rejects.toThrow(/acp: Unknown option '--nope'/);
    const noClient = await cli(['acp', '--socket', '/tmp/none.sock']);
    expect(noClient.code).toBe(2);
    expect(noClient.err).toMatch(/--client <name> is required/);
  });
});

describe('the ACP tables, north and south, agree', () => {
  it('an item kind, a status and a stop reason read back as they were written; permission options read back as the decisions they offer and the option each decision picks', () => {
    for (const t of ['command', 'file_change', 'web_search'] as const) expect(itemTypeOf({ toolCallId: 'x', kind: toolKindOf(t) }, undefined, false)).toBe(t);
    for (const t of ['tool', 'mcp_tool', 'subagent', 'hook', 'compaction'] as const) expect(itemTypeOf({ toolCallId: 'x', kind: toolKindOf(t) }, undefined, false)).toBe('tool');
    for (const s of ['running', 'completed', 'failed'] as const) expect(itemStatus(toolStatusOf(s))).toBe(s);
    for (const status of ['completed', 'interrupted'] as const) expect(turnOutcome((stopReasonOf({ t: 'turn.completed', turnId: 't', status }) as { stopReason: string }).stopReason).status).toBe(status);
    for (const code of ['refusal', 'max_tokens', 'max_turn_requests']) {
      const r = stopReasonOf({ t: 'turn.completed', turnId: 't', status: 'failed', error: { code, retryable: false } }) as { stopReason: string };
      expect(turnOutcome(r.stopReason)).toMatchObject({ status: 'failed', error: { code } });
    }
    for (const b of [
      { allowedDecisions: [], allowAlways: true },
      { allowedDecisions: ['allow_once', 'deny'], allowAlways: false },
      { allowedDecisions: ['allow_once', 'allow_session', 'deny'], allowAlways: true },
    ]) {
      const options = permissionOptions(b);
      const offered = permissionDecisions(options).filter((d) => d !== 'native');
      for (const o of options) {
        const d = permissionDecision(o.optionId)!;
        expect(offered).toContain(d.kind);
        // The south picks, for the north's decision, the very option the north offered for it.
        expect(permissionOutcome(options, d)).toEqual({ outcome: 'selected', optionId: o.optionId });
      }
    }
  });
});
