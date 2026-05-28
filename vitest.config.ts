import { defineConfig } from 'vitest/config'
import tsconfigPaths from 'vite-tsconfig-paths'

/**
 * Vitest config for LinguaLink Online.
 *
 * - tsconfigPaths() makes the "@/*" alias from tsconfig.json work in tests,
 *   so imports like `import { localToUtc } from '@/lib/utils/timezone'` resolve.
 * - Tests live next to the code as `<file>.test.ts` (co-located, matches Next.js
 *   convention). The include pattern below picks them up under src/.
 * - environment 'node' for now — pure logic tests. We'll switch to 'jsdom'
 *   later if/when we test React components.
 */
export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    globals: false,
    // Reasonable defaults; bump if any test legitimately needs longer.
    testTimeout: 10000,
  },
})
