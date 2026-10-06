import type { HarnessEvent, InputRecord } from '@agents-io/protocol';
import { AsyncQueue } from '../src/queue.js';
import type { Options, QueryFn, QueryLike, SDKMessage, SDKUserMessage } from '../src/types.js';

/** Scriptable stand-in for the SDK's Query: tests push SDK messages and inspect what was written. */
export class FakeQuery implements QueryLike {
  readonly written: SDKUserMessage[] = [];
  readonly calls: { method: string; arg?: unknown }[] = [];
  /** uuids the fake CLI still holds in its command queue (returned by interrupt, cancellable). */
  readonly cliQueue = new Set<string>();
  private readonly out = new AsyncQueue<SDKMessage>();
  private writeWaiters: (() => void)[] = [];
  promptEnded = false;

  constructor(
    readonly prompt: AsyncIterable<SDKUserMessage>,
    readonly options: Options,
  ) {
    void (async () => {
      for await (const m of prompt) {
        this.written.push(m);
        for (const w of this.writeWaiters.splice(0)) w();
      }
      this.promptEnded = true;
      this.out.close();
    })();
  }

  push(...ms: unknown[]): void {
    for (const m of ms) this.out.push(m as SDKMessage);
  }

  /** Simulates the CLI dying. */
  crash(): void {
    this.out.close();
  }

  async waitWritten(n: number): Promise<void> {
    while (this.written.length < n) await new Promise<void>((r) => this.writeWaiters.push(r));
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
    return this.out[Symbol.asyncIterator]();
  }

  async interrupt() {
    this.calls.push({ method: 'interrupt' });
    return { still_queued: [...this.cliQueue] };
  }
  async setModel(model?: string) {
    this.calls.push({ method: 'setModel', arg: model });
  }
  async setPermissionMode(mode: unknown) {
    this.calls.push({ method: 'setPermissionMode', arg: mode });
  }
  async applyFlagSettings(s: unknown) {
    this.calls.push({ method: 'applyFlagSettings', arg: s });
  }
  async cancelAsyncMessage(uuid: string) {
    this.calls.push({ method: 'cancelAsyncMessage', arg: uuid });
    return this.cliQueue.delete(uuid);
  }
  close() {
    this.calls.push({ method: 'close' });
    this.out.close();
  }
}

export function fakeQueryFn(): { fn: QueryFn; last: () => FakeQuery; all: FakeQuery[] } {
  const all: FakeQuery[] = [];
  return {
    fn: ({ prompt, options }) => {
      const q = new FakeQuery(prompt, options);
      all.push(q);
      return q;
    },
    last: () => all.at(-1)!,
    all,
  };
}

// ---- SDK message builders (shapes from sdk.d.ts 0.3.291) -------------------

const SID = 'sess-1';
let n = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;

export const sdk = {
  init: (session_id = SID) => ({
    type: 'system',
    subtype: 'init',
    session_id,
    uuid: uuid(),
    claude_code_version: '2.1.291',
    cwd: '/tmp',
    tools: [],
    mcp_servers: [],
    model: 'haiku',
    permissionMode: 'default',
    slash_commands: [],
    output_style: 'default',
    skills: [],
    plugins: [],
    apiKeySource: 'none',
  }),
  textDelta: (text: string, parent: string | null = null) => ({
    type: 'stream_event',
    event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    parent_tool_use_id: parent,
    uuid: uuid(),
    session_id: SID,
  }),
  thinkingDelta: (thinking: string) => ({
    type: 'stream_event',
    event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking } },
    parent_tool_use_id: null,
    uuid: uuid(),
    session_id: SID,
  }),
  assistant: (msgId: string, content: unknown[], parent: string | null = null) => ({
    type: 'assistant',
    message: { id: msgId, role: 'assistant', content, stop_reason: null },
    parent_tool_use_id: parent,
    uuid: uuid(),
    session_id: SID,
  }),
  text: (msgId: string, text: string) => sdk.assistant(msgId, [{ type: 'text', text }]),
  toolUse: (id: string, name: string, input: unknown, parent: string | null = null) =>
    sdk.assistant(`m-${id}`, [{ type: 'tool_use', id, name, input }], parent),
  toolResult: (id: string, content: unknown, is_error = false, parent: string | null = null) => ({
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error }] },
    parent_tool_use_id: parent,
    uuid: uuid(),
    session_id: SID,
  }),
  toolProgress: (id: string, secs: number) => ({
    type: 'tool_progress',
    tool_use_id: id,
    tool_name: 'Bash',
    parent_tool_use_id: null,
    elapsed_time_seconds: secs,
    uuid: uuid(),
    session_id: SID,
  }),
  system: (subtype: string, rest: Record<string, unknown> = {}) => ({ type: 'system', subtype, uuid: uuid(), session_id: SID, ...rest }),
  result: (p: {
    uuids?: string[];
    subtype?: string;
    is_error?: boolean;
    result?: string;
    terminal_reason?: string;
    errors?: string[];
    queued_turn_count?: number;
  }) => ({
    type: 'result',
    subtype: p.subtype ?? 'success',
    is_error: p.is_error ?? false,
    duration_ms: 10,
    duration_api_ms: 5,
    num_turns: 1,
    result: p.result ?? '',
    stop_reason: 'end_turn',
    total_cost_usd: 0.001,
    usage: { input_tokens: 10, output_tokens: 5 },
    modelUsage: {},
    permission_denials: [],
    errors: p.errors ?? [],
    ...(p.uuids ? { user_message_uuids: p.uuids, user_message_uuid: p.uuids.at(-1) } : {}),
    ...(p.terminal_reason ? { terminal_reason: p.terminal_reason } : {}),
    ...(p.queued_turn_count !== undefined ? { queued_turn_count: p.queued_turn_count } : {}),
    uuid: uuid(),
    session_id: SID,
  }),
};

export const input = (id: string, text: string, extra: Partial<InputRecord> = {}): InputRecord => ({
  inputId: id,
  origin: {
    kind: 'human',
    principal: { id: 'owner', labels: ['owner'] },
    evidence: 'platform_signed',
    via: 'fake:a:c1',
    adapter: 'fake',
  },
  content: [{ type: 'text', text }],
  replyRoute: { channel: 'fake', account: 'a', conversationId: 'c1' },
  channelContext: {},
  ...extra,
});

/** Collects events until `until` matches (inclusive). */
export async function collectUntil(
  it: AsyncIterator<HarnessEvent>,
  until: (e: HarnessEvent) => boolean,
  out: HarnessEvent[] = [],
): Promise<HarnessEvent[]> {
  for (;;) {
    const r = await it.next();
    if (r.done) return out;
    out.push(r.value);
    if (until(r.value)) return out;
  }
}

export const isTurnCompleted = (e: HarnessEvent) => e.body.t === 'turn.completed';
export const bodies = <T extends HarnessEvent['body']['t']>(evs: HarnessEvent[], t: T) =>
  evs.filter((e) => e.body.t === t).map((e) => e.body as Extract<HarnessEvent['body'], { t: T }>);
