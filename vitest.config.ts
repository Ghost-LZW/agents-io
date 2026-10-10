import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Test tiers (decision 14, docs/TESTING.md). The tier is the file suffix:
//   *.test.ts        core   every test guards a promise in docs/INVARIANTS.md and carries its #ID
//   *.local.test.ts  local  cheap feature-path tests with no promise behind them; delete or rewrite on change
//   *.e2e.test.ts    e2e    real child processes, real timers, cross-layer smoke; before merging
//   *.live.test.ts   live   real platforms and harnesses, gated by env; by hand
const dirs = '{packages,harness,channel,examples}/*/test/**';
const tiers = ['local', 'e2e', 'live'] as const;

// Workspace packages resolve to their sources, so no tier depends on a prior `pnpm build`.
const src = (dir: string) => fileURLToPath(new URL(`./${dir}/src/index.ts`, import.meta.url));
const alias = [
  { find: /^@agents-io\/protocol$/, replacement: src('packages/protocol') },
  { find: /^@agents-io\/testkit$/, replacement: src('packages/testkit') },
  { find: /^@agents-io\/session$/, replacement: src('packages/session') },
  { find: /^@agents-io\/host-mcp$/, replacement: src('packages/host-mcp') },
  { find: /^@agents-io\/daemon$/, replacement: src('packages/daemon') },
  { find: /^@agents-io\/channel-jsonl-bridge$/, replacement: src('channel/jsonl-bridge') },
  { find: /^@agents-io\/channel-lark-bot$/, replacement: src('channel/lark-bot') },
  { find: /^@agents-io\/channel-mail$/, replacement: src('channel/mail') },
  { find: /^@agents-io\/harness-claude-code$/, replacement: src('harness/claude-code') },
  { find: /^@agents-io\/harness-codex$/, replacement: src('harness/codex') },
];

export default defineConfig({
  resolve: { alias },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'core',
          include: [`${dirs}/*.test.ts`],
          exclude: ['**/node_modules/**', ...tiers.map((t) => `**/*.${t}.test.ts`)],
        },
      },
      ...tiers.map((t) => ({ extends: true, test: { name: t, include: [`${dirs}/*.${t}.test.ts`] } })),
    ],
  },
});
