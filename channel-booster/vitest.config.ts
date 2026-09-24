import { defineConfig } from 'vitest/config'

// For `npm test` run in channel-booster/ (here, or as the split repository's workspace).
// The host repository's own vitest.config.ts already includes channel-booster/**/*.test.ts.
export default defineConfig({
  test: {
    include: ['**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
})
