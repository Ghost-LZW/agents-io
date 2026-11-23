import { Type } from '@sinclair/typebox';
import type { ChannelModule } from '@agents-io/protocol';
import { MailChannel } from './adapter.js';
import type { MailChannelConfig } from './types.js';

/*
 * The mail channel type (`{ "type": "mail", "config": { … } }`): its config keys and how its
 * adapter is built. The daemon registers it in its bundle.
 */

/** A `mail` entry's own keys: `config` is a MailChannelConfig (use "env:NAME" for passwords), env-substituted when resolved. */
export type MailChannelEntry = { type: 'mail'; config: Record<string, unknown> };

export const mailChannelModule: ChannelModule<MailChannelEntry> = {
  type: 'mail',
  ids: ['mail'],
  entry: {
    /** IMAP/SMTP mail: a MailChannelConfig (use "env:NAME" for passwords). */
    config: Type.Record(Type.String(), Type.Unknown()),
  },
  // `config` is free-form, so the schema cannot mark the servers' passwords and tokens.
  isCredential: (path) => {
    const leaf = path.at(-1);
    return path[0] === 'config' && (path[1] === 'imap' || path[1] === 'smtp') && path[2] === 'auth' && (leaf === 'pass' || leaf === 'accessToken');
  },
  resolve: (entry, ctx) => ({ ...entry, config: ctx.substitute(entry.config, 'mail.config') as Record<string, unknown> }),
  create: (entry) => ({ adapter: new MailChannel({ ...entry.config, account: entry.account } as MailChannelConfig) }),
};
