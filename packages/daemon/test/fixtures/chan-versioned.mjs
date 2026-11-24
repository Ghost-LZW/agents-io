import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createChannel as acme } from './chan-descriptor.mjs';

/**
 * The acme descriptor (chan-descriptor.mjs, without its admin route) as one version of a package
 * exports it: its create also appends the version to the file `starts` in its state directory,
 * so a test (in this process or another) sees which directory each start gave it. A package's
 * entry file: `import { versioned } from '<this file>'; export const createChannel = versioned('1.0.0');`.
 */
export function versioned(version) {
  return {
    ...acme,
    admin: undefined,
    create(entry, init) {
      mkdirSync(init.stateDir, { recursive: true });
      appendFileSync(join(init.stateDir, 'starts'), `${version}\n`);
      return acme.create(entry, init);
    },
  };
}
