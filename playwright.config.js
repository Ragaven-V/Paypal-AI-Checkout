// Browser end-to-end tests: npm run test:e2e
// Starts its own server with the rule-based assistant, an in-memory database and no PayPal
// client ID (so no external scripts load), then drives the real page in Chromium.
import { defineConfig, devices } from '@playwright/test';

const PORT = 3020;

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure'
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { ...devices['Pixel 7'] }, testMatch: /mobile\.spec\.js/ }
  ],
  webServer: {
    command: 'node server.js',
    url: `http://localhost:${PORT}/readyz`,
    reuseExistingServer: false,
    timeout: 30_000,
    env: {
      PORT: String(PORT),
      MOCK_AI: 'true',
      GEMINI_API_KEY: '',
      DATABASE_PATH: ':memory:',
      PAYPAL_CLIENT_ID: '',
      PAYPAL_CLIENT_SECRET: '',
      PAYPAL_WEBHOOK_ID: '',
      ADMIN_TOKEN: 'e2e-admin-password',
      SHIPPING_FLAT_CENTS: '599',
      FREE_SHIPPING_THRESHOLD_CENTS: '5000',
      TAX_RATE_PERCENT: '0',
      RATE_LIMIT_API_PER_MIN: '10000',
      RATE_LIMIT_CHAT_PER_MIN: '10000',
      RATE_LIMIT_AUTH_PER_MIN: '10000',
      BACKUP_INTERVAL_HOURS: '0',
      LOG_LEVEL: 'warn'
    }
  }
});
