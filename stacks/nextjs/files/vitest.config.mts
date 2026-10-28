// QA AI OS: unit and component tests (Vitest + Testing Library).
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

// Tests import what they use (`import { test, expect } from 'vitest'`), so the
// type check knows them without changing tsconfig.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./vitest.setup.ts'],
    include: ['**/*.test.{ts,tsx}'],
    exclude: ['node_modules/**', 'e2e/**', '.next/**'],
    coverage: {
      provider: 'v8',
      // lcov feeds the push gate's "changedLines" check; text is for people.
      reporter: ['text-summary', 'lcov'],
      reportsDirectory: 'coverage',
      include: __COVERAGE_INCLUDE__,
    },
  },
  resolve: {
    alias: { '@': fileURLToPath(new URL('.', import.meta.url)) },
  },
});
