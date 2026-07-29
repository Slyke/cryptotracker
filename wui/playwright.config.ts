import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/browser',
  timeout: 30_000,
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? 'http://127.0.0.1:8192',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure'
  }
});
