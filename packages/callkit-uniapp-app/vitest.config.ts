import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const coreV5Entry = fileURLToPath(new URL('../callkit-core-v5/src/index.ts', import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      // Run against Core v5 sources so tests do not depend on a prior `dist` build.
      '@easemob-community/callkit-core-v5': coreV5Entry
    }
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['uni_modules/**/*.test.ts']
  }
})
