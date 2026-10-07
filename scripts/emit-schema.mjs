// Writes the protocol's JSON Schemas to packages/protocol/schema/ for non-TypeScript implementers.
import { mkdirSync, writeFileSync } from 'node:fs';
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
  'ResolveCalloutAnswer', 'OutboundCalloutAnswer', 'TurnContextView', 'InboundRedispatchResult',
  // Console / admin HTTP API
  'AdminError', 'AdminLoginRequest', 'AdminLoginResult', 'AdminStatus', 'AdminConfigDocument', 'AdminConfigPut', 'AdminConfigPutResult',
  'AdminConfigValidateRequest', 'AdminConfigValidation', 'AdminQueue', 'AdminSessions', 'AdminLarkBotRequest', 'AdminLarkBotStarted', 'AdminLarkBotJob',
];
const dir = new URL('../packages/protocol/schema/', import.meta.url);
mkdirSync(dir, { recursive: true });
for (const n of names) {
  const schema = { $schema: 'https://json-schema.org/draft/2020-12/schema', $id: `agents-io/v${p.PROTOCOL_VERSION}/${n}`, ...p[n] };
  writeFileSync(new URL(`${n}.json`, dir), JSON.stringify(schema, null, 2) + '\n');
}
console.log(`wrote ${names.length} schemas`);
