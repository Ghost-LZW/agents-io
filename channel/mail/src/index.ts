export * from './types.js';
export * from './adapter.js';
export { ImapSource } from './imap.js';
export { mailauthVerifier, verdictFromAuth } from './auth.js';
export { parseInbound, isAutomated, threadRootOf, QUOTE_MAX_CHARS } from './inbound.js';
export { splitQuote } from './quote.js';
export { messageIdFor } from './outbound.js';
