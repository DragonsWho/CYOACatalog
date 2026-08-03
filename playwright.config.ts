// playwright.config.ts
import { defineConfig, devices } from '@playwright/test';
import { TEST_BASE_URL } from './e2e/constants';

export default defineConfig({
  testDir: './e2e/tests',

  // Output directories
  outputDir: './e2e/test-results',

  // Run tests sequentially — they share a single PocketBase instance
  fullyParallel: false,
  workers: 1,

  // CI behaviour
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,

  reporter: [
    ['list'],
    ['html', { outputFolder: 'e2e/playwright-report', open: 'never' }],
  ],

  use: {
    baseURL: TEST_BASE_URL,

    // Capture artefacts on failure
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    trace: 'retain-on-failure',
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  globalSetup: './e2e/global-setup.ts',
  globalTeardown: './e2e/global-teardown.ts',
});
