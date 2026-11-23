/**
 * A config the daemon cannot run with (`aio serve` exits 2). Its message names keys and variables,
 * never values. In a module of its own so the daemon's channel module (`module-channel.ts`, which
 * `bundle.ts` registers) can throw it without importing `config.ts`.
 */
export class ConfigError extends Error {
  override name = 'ConfigError';
}
