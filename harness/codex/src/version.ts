import { CODEX_GENERATED_VERSION } from './generated/version.js';

/**
 * `major.minor` lines of codex-cli whose app-server protocol this adapter was
 * checked against, oldest first. The app-server API is still marked experimental,
 * but Codex updates itself, so the policy (decision 17: "codex 协议不要卡死") is:
 * a version older than the oldest line is refused; a verified line runs; a newer
 * unverified version, or one whose version cannot be read, runs with one warning
 * (`checkCodexVersion`). `strictVersion` refuses everything but the verified lines;
 * `allowUnknownVersion` runs anything without a warning.
 *
 * Types are generated from the newest line (`CODEX_GENERATED_VERSION`). Between
 * 0.160 and 0.171 nothing the adapter sends changed and nothing it reads was
 * removed or renamed (0.171 only adds fields, variants and notifications), so the
 * same code drives both lines; the notifications 0.171 adds are opted out
 * (`DEFAULT_OPT_OUT`), which 0.160 accepts as unknown names.
 */
export const SUPPORTED_CODEX_LINES = ['0.160', '0.171'] as const;

export { CODEX_GENERATED_VERSION };

/** Codex answers `initialize` with `userAgent: "<originator>/<version> (...)"`. */
export function versionFromUserAgent(userAgent: string | undefined): string | undefined {
  return typeof userAgent === 'string' ? userAgent.match(/^[^/]+\/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:[\s(]|$)/)?.[1] : undefined;
}

const lines = () => SUPPORTED_CODEX_LINES.map((l) => `${l}.x`).join(', ');

export class UnsupportedCodexVersionError extends Error {
  constructor(readonly detected: string | undefined) {
    super(
      detected
        ? `codex app-server ${detected} is not supported by @agents-io/harness-codex (supported: ${lines()}; types generated from ${CODEX_GENERATED_VERSION}). ` +
            'Install a supported codex-cli, or regenerate types with scripts/gen-types.sh and extend SUPPORTED_CODEX_LINES after checking the diff. ' +
            'Set options.allowUnknownVersion to run anyway.'
        : 'could not determine the codex app-server version from the initialize response (userAgent)',
    );
    this.name = 'UnsupportedCodexVersionError';
  }
}

/** How the adapter treats a version outside the verified lines (`CodexHarnessOptions`). */
export interface CodexVersionPolicy {
  /** Run any version, and one that cannot be read, without a warning. Wins over `strictVersion`. */
  allowUnknownVersion?: boolean;
  /** Refuse every version outside SUPPORTED_CODEX_LINES, and one that cannot be read (the policy before decision 17). */
  strictVersion?: boolean;
}

/** `[major, minor]` of a version or line, numerically. */
const lineOf = (v: string): [number, number] => {
  const [a = '0', b = '0'] = v.split('.');
  return [Number.parseInt(a, 10) || 0, Number.parseInt(b, 10) || 0];
};

const olderThan = (v: string, line: string): boolean => {
  const [a, b] = lineOf(v);
  const [c, d] = lineOf(line);
  return a < c || (a === c && b < d);
};

const isVerified = (version: string) => (SUPPORTED_CODEX_LINES as readonly string[]).includes(version.split('.').slice(0, 2).join('.'));

/**
 * The version policy (decision 17). Throws `UnsupportedCodexVersionError` for a version older than
 * the oldest verified line, and under `strictVersion` for any unverified or unreadable one. Returns
 * the warning to give once when the version is newer than, or between, the verified lines, or cannot
 * be read; nothing for a verified line, or with `allowUnknownVersion`.
 */
export function checkCodexVersion(version: string | undefined, policy: CodexVersionPolicy = {}): { warning?: string } {
  if (policy.allowUnknownVersion) return {};
  if (policy.strictVersion) {
    assertSupportedVersion(version);
    return {};
  }
  const advice =
    'Unknown fields and messages are recorded as native events, and every server request is still answered. ' +
    'To verify a version, regenerate types with harness/codex/scripts/gen-types.sh, check the diff and extend SUPPORTED_CODEX_LINES (harness/codex/README.md). ' +
    'Set options.strictVersion to refuse unverified versions.';
  if (!version) {
    return {
      warning: `could not determine the codex app-server version from the initialize response (userAgent); running it unverified (verified: ${lines()}; types generated from ${CODEX_GENERATED_VERSION}). ${advice}`,
    };
  }
  if (olderThan(version, SUPPORTED_CODEX_LINES[0])) throw new UnsupportedCodexVersionError(version);
  if (isVerified(version)) return {};
  return {
    warning: `codex app-server ${version} has not been verified with @agents-io/harness-codex (verified: ${lines()}; types generated from ${CODEX_GENERATED_VERSION}); running it anyway. ${advice}`,
  };
}

/** The strict check (`strictVersion`): throws unless `version` is on a verified line. `allowUnknown` skips the line check. */
export function assertSupportedVersion(version: string | undefined, allowUnknown = false): void {
  if (!version) throw new UnsupportedCodexVersionError(undefined);
  if (allowUnknown) return;
  if (!isVerified(version)) throw new UnsupportedCodexVersionError(version);
}
