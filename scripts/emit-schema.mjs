// Writes JSON Schemas for non-TypeScript implementers: the protocol's to packages/protocol/schema/,
// and a module's own wire types next to it (channel/lark-bot/schema/: its console endpoints).
// Every `$id` is `agents-io/v<PROTOCOL_VERSION>/<name>`, wherever the file lives.
import { mkdirSync, writeFileSync } from 'node:fs';
import * as lark from '../channel/lark-bot/dist/index.js';
import * as p from '../packages/protocol/dist/index.js';

const names = [
  'InboundEnvelope', 'InputRecord', 'Origin', 'SessionEvent', 'HarnessEvent', 'Command', 'RunSpec',
  'HarnessCaps', 'ChannelCaps', 'RenderedMessage', 'Decision', 'Resolver',
  'ChannelHostFrame', 'ChannelAdapterFrame', 'ChannelHello', 'HarnessHostFrame', 'HarnessAdapterFrame',
  'ClientFrame', 'ServerFrame', 'SessionInfo', 'ProgressView', 'Watch', 'BindingTable', 'RouteExplanation', 'TurnProvenance', 'InboundItem', 'HostRequestFrame', 'HostEventFrame', 'WatchDraft',
  // Topics (decision 6)
  'Topic', 'TopicSwitchResult',
  // Host request result values
  'HostHelloResult', 'BindingsPutResult', 'BindingsGetResult', 'RunStartResult', 'RunCancelResult', 'RunEnded', 'DeliverResult',
  'InputVerifyResult', 'InboundReadResult', 'InboundAckResult', 'InboundAnswer', 'RouteCalloutAnswer', 'SessionPrepareResult',
  'ResolveCalloutAnswer', 'ReviewCalloutAnswer', 'OutboundCalloutAnswer', 'TurnContextView', 'InboundRedispatchResult', 'SessionCompactResult',
  // Agent messaging: cause chain and explain of side effects / chains
  'InputCause', 'EffectExplanation', 'ChainExplanation', 'ExplainResult', 'ContactCalloutAnswer',
  // External MCP endpoint (docs/design/external-mcp)
  'ExternalCalloutAnswer', 'ExternalSender',
  // Console / admin HTTP API
  'AdminError', 'AdminLoginRequest', 'AdminLoginResult', 'AdminStatus', 'AdminConfigDocument', 'AdminConfigPut', 'AdminConfigPutResult',
  'AdminChannelsApplied', 'AdminConfigValidateRequest', 'AdminConfigValidation', 'AdminQueue', 'AdminSessions',
];
const sets = [
  { dir: '../packages/protocol/schema/', mod: p, names },
  // Lark bot provisioning (POST /api/bots/lark, GET /api/bots/lark/:job)
  { dir: '../channel/lark-bot/schema/', mod: lark, names: ['AdminLarkBotRequest', 'AdminLarkBotStarted', 'AdminLarkBotJob'] },
];
let written = 0;
for (const set of sets) {
  const dir = new URL(set.dir, import.meta.url);
  mkdirSync(dir, { recursive: true });
  for (const n of set.names) {
    if (!set.mod[n]) throw new Error(`${set.dir}: no schema ${n}`);
    const schema = { $schema: 'https://json-schema.org/draft/2020-12/schema', $id: `agents-io/v${p.PROTOCOL_VERSION}/${n}`, ...set.mod[n] };
    writeFileSync(new URL(`${n}.json`, dir), JSON.stringify(schema, null, 2) + '\n');
    written++;
  }
}
console.log(`wrote ${written} schemas`);
