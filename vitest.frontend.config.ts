// Vitest config for frontend service tests (src/**/__tests__/*.test.ts).
//
// The default vitest.config.ts runs in the Cloudflare workers pool — that's
// right for the Worker but breaks frontend code that relies on Vite's
// `import.meta.env` and standard Node fetch semantics. This config uses the
// default node environment and a dedicated test glob.
//
// Rendered component tests (`*.test.tsx`) opt in to a DOM per file with a
// `// @vitest-environment jsdom` docblock on line 1 and import
// `src/test-utils/dom.ts` (jest-dom matchers + RTL cleanup). Everything else
// keeps running in plain node, so the existing suite is unaffected.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'src/**/__tests__/**/*.test.ts',
      'src/**/__tests__/**/*.test.tsx',
      'src/services/accessIsochrone/**/*.test.ts',
    ],
    environment: 'node',
    globals: false,
  },
});
