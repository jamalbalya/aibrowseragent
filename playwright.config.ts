import { defineConfig } from '@playwright/test';

/**
 * E2E configuration.
 *
 * These tests drive the built extension in a real Chromium, so `npm run build`
 * must have run first; `globalSetup` enforces that rather than letting a test
 * fail confusingly against a stale or missing `dist/`.
 *
 * Workers are limited to 2: each one launches its own browser with a
 * persistent profile plus two HTTP servers, and the extension's service worker
 * is a shared, stateful surface within a profile.
 */
export default defineConfig({
  testDir: './tests/e2e',
  globalSetup: './tests/e2e/global-setup.ts',
  fullyParallel: false,
  workers: 2,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  use: {
    trace: process.env.CI ? 'retain-on-failure' : 'off',
    screenshot: 'only-on-failure',
  },
});
