import { claudeCodeHarnessModule } from '@agents-io/harness-claude-code';
import { codexHarnessModule } from '@agents-io/harness-codex';
import { HarnessRegistry } from './harness-registry.js';

/*
 * The composition root (docs/design/core-slimming §6): the built-in modules register here, and
 * only here does the daemon import a module package (`scripts/boundaries.json` `bundle`).
 */

/** The built-in harness kinds; Claude Code first, the default kind. */
export const builtinHarnesses = new HarnessRegistry([claudeCodeHarnessModule, codexHarnessModule]);
