import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    setupFiles: ['./tests/setup.ts'],
    // Each file gets its own module registry so OS_READ_ONLY resets work cleanly
    isolate: true,
  },
});
