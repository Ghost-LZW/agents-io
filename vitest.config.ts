import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['{packages,harness,channel,examples}/*/test/**/*.test.ts'],
  },
});
