import { randomUUID } from 'node:crypto';
import type { HarnessAdapter, InputRecord, RunSpec } from '@agents-io/protocol';

/** How long an ephemeral turn's answer is waited for (`KernelLaneHarness.ephemeralTurn`). */
export const EPHEMERAL_TURN_MS = 30_000;

/**
 * One ephemeral turn on `adapter` (one that declares `ephemeralOpen`) for the module `module`, and
 * the text of its answer (the final answer's snapshot, else its deltas): undefined when the turn
 * does not complete or `timeoutMs` passes first. What the turn may do is set here, never by the
 * module: a throwaway session (`options.ephemeral`, no preface) with none of the host's tools (no
 * MCP), `run` at low effort in the default mode, under a profile named after the module that is
 * read-only and never asks; `instructions` in place of the agent's; one input of the kernel's
 * (`origin.kind: "system"`, `via` the module) holding `prompt`. The session is closed whatever
 * happens. The open options are Codex's shape (`HarnessAdapter.ephemeralOpen`).
 */
export async function ephemeralTurn(
  adapter: HarnessAdapter,
  a: { module: string; cwd: string; run: RunSpec; prompt: string; instructions: string; timeoutMs?: number },
): Promise<string | undefined> {
  const id = randomUUID();
  const run: RunSpec = { ...a.run, profile: a.module, effort: 'low', mode: 'default' };
  const session = await adapter.open({
    sessionKey: `${a.module}:${id}`, generation: 1, cwd: a.cwd, run,
    instructions: a.instructions,
    options: {
      ephemeral: true,
      preface: false,
      profiles: { [a.module]: { approvalPolicy: 'never', sandbox: 'read-only' } },
    },
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const input: InputRecord = {
      inputId: `${a.module}:${id}`,
      origin: { kind: 'system', principal: null, evidence: 'daemon', via: a.module, adapter: 'session' },
      content: [{ type: 'text', text: a.prompt }], replyRoute: null, channelContext: {},
    };
    const result = (async () => {
      let answer = '';
      await session.startTurn(id, [input], run);
      for await (const e of session.events) {
        if (e.body.t === 'text.delta' && e.body.stream === 'answer' && e.audience === 'answer') answer += e.body.delta;
        if (e.body.t === 'text.snapshot' && e.body.final && e.audience === 'answer') answer = e.body.text;
        if (e.body.t === 'turn.completed' && e.body.turnId === id) return e.body.status === 'completed' ? answer : undefined;
      }
      return undefined;
    })();
    return await Promise.race([result, new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), a.timeoutMs ?? EPHEMERAL_TURN_MS); })]);
  } finally {
    if (timer) clearTimeout(timer);
    await session.close(`${a.module}: ephemeral turn complete`).catch(() => undefined);
  }
}
