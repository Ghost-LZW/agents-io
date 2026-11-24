// Writes JSON Schemas for non-TypeScript implementers: the protocol's to packages/protocol/schema/,
// and each built-in module's own wire types into its package: the `schemas` of its admin
// contribution (`ChannelModule.admin`; channel/lark-bot/schema/: its console endpoints).
// Every `$id` is `agents-io/v<PROTOCOL_VERSION>/<name>`, wherever the file lives.
import { mkdirSync, writeFileSync } from 'node:fs';
import * as lark from '../channel/lark-bot/dist/index.js';
import * as p from '../packages/protocol/dist/index.js';

const names = [
  'InboundEnvelope', 'InputRecord', 'Origin', 'SessionEvent', 'HarnessEvent', 'Command', 'RunSpec',
  'HarnessCaps', 'ChannelCaps', 'RenderedMessage', 'Decision', 'Resolver',
  'ChannelHostFrame', 'ChannelAdapterFrame', 'ChannelHello', 'HarnessHostFrame', 'HarnessAdapterFrame',
  // The harness bridge's answers (the probe answer is the program's hello)
  'ProbeResult', 'HarnessDeclares', 'OpenResult', 'NativeClientSpec', 'BlobStat', 'BlobBytes',
  'ClientFrame', 'ServerFrame', 'SessionInfo', 'Attention', 'AttentionChanged', 'ProgressView', 'Watch', 'BindingTable', 'RouteExplanation', 'TurnProvenance', 'InboundItem', 'HostRequestFrame', 'HostEventFrame', 'WatchDraft',
  // Topics (decision 6)
  'Topic', 'TopicSwitchResult',
  // Host request result values
  'HostHelloResult', 'BindingsPutResult', 'BindingsGetResult', 'RunStartResult', 'RunCancelResult', 'RunEnded', 'DeliverResult',
  'InputVerifyResult', 'InboundReadResult', 'InboundAckResult', 'InboundAnswer', 'RouteCalloutAnswer', 'SessionPrepareResult',
  'ResolveCalloutAnswer', 'ReviewCalloutAnswer', 'OutboundCalloutAnswer', 'TurnContextView', 'InboundRedispatchResult', 'SessionCompactResult', 'DeliverUpdateResult', 'ConversationCreateResult', 'MessageAckResult', 'ScheduleDraft', 'ScheduleView', 'SchedulePutResult', 'ScheduleRemoveResult', 'ScheduleListResult', 'HistoryReadResult',
  // Test hooks (AIO_TEST_HOOKS=1 only; HOSTS §4.3)
  'TestReplayResult', 'TestFaultResult',
  // U20: the exit check of an outbound.scoped host
  'OutboundContentCalloutAnswer', 'OutboundKind', 'OutboundScopeRoute', 'HostOutboundScopeResult',
  // Agent messaging: cause chain and explain of side effects / chains
  'InputCause', 'EffectExplanation', 'ChainExplanation', 'ExplainResult', 'ContactCalloutAnswer',
  // External MCP endpoint (docs/design/external-mcp)
  'ExternalCalloutAnswer', 'ExternalSender',
  // Console / admin HTTP API
  'AdminError', 'AdminLoginRequest', 'AdminLoginResult', 'AdminStatus', 'AdminConfigDocument', 'AdminConfigPut', 'AdminConfigPutResult',
  'AdminChannelsApplied', 'AdminConfigValidateRequest', 'AdminConfigValidation', 'AdminQueue', 'AdminSessions',
];
/** Modules whose admin contribution declares schemas, and where they go. */
const modules = [
  // Lark bot provisioning (POST /api/bots/lark, GET /api/bots/lark/:job)
  { dir: '../channel/lark-bot/schema/', module: lark.larkBotChannelModule },
];
const sets = [
  { dir: '../packages/protocol/schema/', schemas: Object.fromEntries(names.map((n) => [n, p[n]])) },
  ...modules.map((m) => ({ dir: m.dir, schemas: m.module.admin?.schemas ?? {} })),
];
let written = 0;
for (const set of sets) {
  const dir = new URL(set.dir, import.meta.url);
  mkdirSync(dir, { recursive: true });
  for (const [n, s] of Object.entries(set.schemas)) {
    if (!s) throw new Error(`${set.dir}: no schema ${n}`);
    const schema = { $schema: 'https://json-schema.org/draft/2020-12/schema', $id: `agents-io/v${p.PROTOCOL_VERSION}/${n}`, ...s };
    writeFileSync(new URL(`${n}.json`, dir), JSON.stringify(schema, null, 2) + '\n');
    written++;
  }
}
console.log(`wrote ${written} schemas`);
