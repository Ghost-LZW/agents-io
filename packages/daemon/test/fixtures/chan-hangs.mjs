import { defaultChannelCaps } from '@agents-io/testkit';

/** A channel plugin that never stops: start() ignores the abort signal and close() never returns. */
export default (init) => ({
  id: init.config?.id ?? 'hang',
  caps: () => defaultChannelCaps,
  start: () => new Promise(() => {}),
  async send() {
    return { providerMessageId: 'm1' };
  },
  close: () => new Promise(() => {}),
});
