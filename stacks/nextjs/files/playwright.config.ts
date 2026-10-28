/// <reference types="node" />
// QA AI OS: end-to-end tests (Playwright).
//
// No PLAYWRIGHT_BASE_URL: Playwright builds and starts the app itself.
// With it (a preview or production URL): tests run against that site instead.
import { defineConfig, devices } from '@playwright/test';

const raw = process.env.PLAYWRIGHT_BASE_URL;
const external = raw && raw.trim() ? raw.trim().replace(/\/$/, '') : null;
const port = Number(process.env.PORT || 3100);

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  // One retry on CI records a trace of the failure, but a test that only
  // passes on retry still FAILS the run: flaky is a bug, not a pass.
  retries: process.env.CI ? 1 : 0,
  failOnFlakyTests: true,
  forbidOnly: Boolean(process.env.CI),
  reporter: process.env.CI ? [['line'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: external ?? `http://localhost:${port}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: external
    ? undefined
    : {
        command: `npm run build && npm run start -- -p ${port}`,
        url: `http://localhost:${port}`,
        timeout: 240_000,
        reuseExistingServer: !process.env.CI,
      },
});
