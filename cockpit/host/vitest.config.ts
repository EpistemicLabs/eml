import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Before any test file loads: paths.ts reads the home at import time.
    setupFiles: ['tests/setup-home.ts'],
    // Every machine runs the tests in UTC: the time-zone tests set the user's zone apart from it.
    env: { TZ: 'UTC' },
  },
})
