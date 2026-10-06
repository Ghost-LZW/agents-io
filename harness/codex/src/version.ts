import { CODEX_GENERATED_VERSION } from './generated/version.js';

/**
 * `major.minor` lines of codex-cli whose app-server protocol this adapter was
 * checked against. The app-server API is still marked experimental and renames
 * fields between minors, so anything else is refused unless the deployment opts
 * out with `allowUnknownVersion`.
 */
export const SUPPORTED_CODEX_LINES = ['0.160'] as const;

export { CODEX_GENERATED_VERSION };

/** Codex answers `initialize` with `userAgent: "<originator>/<version> (...)"`. */
export function versionFromUserAgent(userAgent: string | undefined): string | undefined {
  return userAgent?.match(/^[^/]+\/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:[\s(]|$)/)?.[1];
}

export class UnsupportedCodexVersionError extends Error {
  constructor(readonly detected: string | undefined) {
    super(
      detected
        ? `codex app-server ${detected} is not supported by @agents-io/harness-codex (supported: ${SUPPORTED_CODEX_LINES.map((l) => `${l}.x`).join(', ')}; types generated from ${CODEX_GENERATED_VERSION}). ` +
            'Install a supported codex-cli, or regenerate types with scripts/gen-types.sh and extend SUPPORTED_CODEX_LINES after checking the diff. ' +
            'Set options.allowUnknownVersion to run anyway.'
        : 'could not determine the codex app-server version from the initialize response (userAgent)',
    );
    this.name = 'UnsupportedCodexVersionError';
  }
}

export function assertSupportedVersion(version: string | undefined, allowUnknown = false): void {
  if (!version) throw new UnsupportedCodexVersionError(undefined);
  if (allowUnknown) return;
  const line = version.split('.').slice(0, 2).join('.');
  if (!(SUPPORTED_CODEX_LINES as readonly string[]).includes(line)) throw new UnsupportedCodexVersionError(version);
}
