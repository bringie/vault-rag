// vt-0332: Playwright e2e harness for brain.itiswednesdaymydud.es.
// Single-worker — the suite mutates shared prod state (toggle features,
// create agent-roles) and must serialize to keep teardown deterministic.

const { defineConfig, devices } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './specs',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [
    ['list'],
    ['json', { outputFile: 'last-run.json' }],
  ],
  use: {
    baseURL: process.env.PORTAL_URL || 'https://brain.itiswednesdaymydud.es',
    extraHTTPHeaders: {},
    ignoreHTTPSErrors: false,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    actionTimeout: 10_000,
    navigationTimeout: 15_000,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
