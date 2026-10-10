// Lets a plain `node` child process (a test fixture) run the workspace's TypeScript sources
// instead of their dist/ builds, so tests never depend on a prior `pnpm build`:
//   node --experimental-transform-types --disable-warning=ExperimentalWarning \
//     --import <repo>/scripts/source-loader.mjs fixture.mjs
// `@agents-io/<pkg>` resolves to that package's src/index.ts, and a relative `./x.js` that does
// not exist resolves to `./x.ts` (the NodeNext convention). Node transforms the types itself
// (`--experimental-transform-types`: the sources use parameter properties).
import { register } from 'node:module';
import { fileURLToPath } from 'node:url';

register(new URL('./source-loader-hooks.mjs', import.meta.url), {
  data: { root: fileURLToPath(new URL('..', import.meta.url)) },
});
