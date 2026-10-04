// Shared setup for rendered component tests (`*.test.tsx`).
//
// A component test opts in to the DOM with `// @vitest-environment jsdom` on
// its first line and imports this module. The frontend vitest project runs
// with `globals: false`, so React Testing Library cannot register its own
// afterEach cleanup; do it here, and load the jest-dom matchers.
import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

afterEach(() => {
  cleanup();
});
