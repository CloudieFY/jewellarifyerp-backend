import { defineConfig } from 'vitest/config';

/**
 * Test runner for the PostgreSQL / CRM code paths only.
 *
 * Pure-logic tests always run. DB-backed tests (tenant isolation, outbox,
 * auth guard) run ONLY when TEST_DATABASE_URL is set — they create and then
 * cascade-delete their own throw-away shops, so they must never point at a
 * database you care about. When TEST_DATABASE_URL is absent those suites
 * self-skip (they do not silently pass).
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    testTimeout: 20000,
    hookTimeout: 30000,
    // No global setup: each DB suite manages its own connection + fixtures.
  },
});
