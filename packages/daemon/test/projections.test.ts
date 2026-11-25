import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { agent, client, methods, type AgentContext, type SessionNotification } from '@agentclientprotocol/sdk';
import { EventSchema } from '@ag-ui/core/schemas';
import type { SessionEvent } from '@agents-io/protocol';
import { projectionFiles, readProjection, runProjection } from '@agents-io/testkit';
import { AcpProjection, type AcpOut } from '../src/acp-projection.js';
import { AgUiProjection } from '../src/ag-ui-projection.js';

/*
 * The north projections' mapping tables (core-slimming G9), pinned as language-neutral fixtures
 * (`packages/testkit/conformance/projections/`, docs/design/conformance-fixtures §4a): each fixture's
 * events through the projection give exactly its outputs, and every output passes its protocol's
 * own schema: AG-UI's `EventSchema` (`@ag-ui/core`), ACP's through the official SDK's client side,
 * which parses what it receives (a message that fails is not handed on).
 */

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanup.splice(0)) c();
});

const DIR = join(import.meta.dirname, '..', '..', 'testkit', 'conformance', 'projections');

/** An in-process ACP agent and client of the official SDK: what the agent sends arrives at the client only if it parses. */
async function acpPair() {
  let cx: AgentContext | undefined;
  const got: SessionNotification[] = [];
  const asked: string[] = [];
  const a = agent({ name: 'projection' }).onConnect((c) => void (cx = c.client));
  const c = client({ name: 'check' })
    .onNotification(methods.client.session.update, ({ params }) => void got.push(params))
    .onRequest(methods.client.session.requestPermission, () => (asked.push('permission'), { outcome: { outcome: 'cancelled' } }))
    .onRequest(methods.client.elicitation.create, () => (asked.push('question'), { action: 'cancel' }) as never);
  const conn = c.connect(a);
  await until(() => cx !== undefined);
  return { cx: cx!, got, asked, close: () => conn.close() };
}

async function until(f: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !f(); i++) await new Promise((r) => setTimeout(r, 5));
}

/** Send every output as the ACP server does: it must all arrive, parsed. */
async function sendAll(outs: AcpOut[]): Promise<void> {
  const p = await acpPair();
  try {
    let updates = 0;
    for (const o of outs) {
      if ('update' in o) {
        updates++;
        await p.cx.notify(methods.client.session.update, { sessionId: 's', update: o.update });
      } else if ('permission' in o) {
        await p.cx.request(methods.client.session.requestPermission, { sessionId: 's', toolCall: o.permission.toolCall, options: o.permission.options });
      } else if ('question' in o) {
        await p.cx.request(methods.client.elicitation.create, { sessionId: 's', mode: 'form', message: o.question.message, requestedSchema: o.question.requestedSchema } as never);
      }
    }
    await until(() => p.got.length >= updates);
    expect(p.got.map((n) => n.update)).toEqual(outs.flatMap((o) => ('update' in o ? [o.update] : [])));
    expect(p.asked).toEqual(outs.flatMap((o) => ('permission' in o ? ['permission'] : 'question' in o ? ['question'] : [])));
  } finally {
    p.close();
  }
}

describe('north projection fixtures', () => {
  it('the ACP client side of the SDK refuses what does not parse (so the check below means something) #PR-4', async () => {
    const p = await acpPair();
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    cleanup.push(() => quiet.mockRestore());
    await p.cx.notify(methods.client.session.update, { sessionId: 's', update: { sessionUpdate: 'agent_message_chunk' } as never }).catch(() => {});
    await p.cx.notify(methods.client.session.update, { sessionId: 's', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ok' } } });
    await until(() => p.got.length >= 1);
    await new Promise((r) => setTimeout(r, 20));
    expect(p.got.map((n) => n.update)).toEqual([{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ok' } }]);
    p.close();
  });

  for (const file of projectionFiles(join(DIR, 'acp'))) {
    const f = readProjection(file);
    it(`acp ${f.header.name}: ${f.header.description} #PR-4`, async () => {
      const p = new AcpProjection({ principal: String(f.header.options?.principal) });
      const outs = runProjection(f, (e: SessionEvent) => p.push(e)) as AcpOut[];
      await sendAll(outs);
    });
  }

  for (const file of projectionFiles(join(DIR, 'ag-ui'))) {
    const f = readProjection(file);
    it(`ag-ui ${f.header.name}: ${f.header.description} #PR-4`, () => {
      const o = (f.header.options ?? {}) as { threadId: string; runId?: string; inputId?: string };
      const p = new AgUiProjection(o);
      // With a runId, the run's RUN_STARTED comes before the first event's outputs.
      let first = o.runId !== undefined;
      runProjection(
        f,
        (e) => {
          const out = [...(first ? p.begin() : []), ...p.push(e)];
          first = false;
          return out;
        },
        (out) => {
          const r = EventSchema.safeParse(out);
          return r.success ? undefined : r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
        },
      );
    });
  }
});
