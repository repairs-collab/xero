import { defineConfig, devices } from '@playwright/test';

const databaseUrl =
  process.env.DATABASE_URL ??
  'postgres://bc5000:bc5000@127.0.0.1:5432/bc5000';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 8_000 },
  globalSetup: './e2e/global-setup.ts',
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: {
    baseURL: 'http://127.0.0.1:3100',
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
    screenshot: 'only-on-failure',
    ...devices['Desktop Chrome'],
    ...(process.env.CI ? {} : { channel: 'chrome' })
  },
  webServer: [
    {
      command: 'node e2e/fake-retell-server.mjs',
      url: 'http://127.0.0.1:3201/health',
      reuseExistingServer: !process.env.CI,
      timeout: 30_000
    },
    {
      command: 'pnpm dev --hostname 127.0.0.1 --port 3100',
      url: 'http://127.0.0.1:3100/health/live',
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: {
        DATABASE_URL: databaseUrl,
        SESSION_SECRET_BASE64: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
        NODE_ENV: 'test',
        RETELL_API_BASE_URL: 'http://127.0.0.1:3201',
        RETELL_API_KEY: 'fake-retell-private-key',
        VOICE_PREVIEW_ALLOWED_ORIGINS:
          'https://billchaser.motts.com.au,https://staging.billchaser.motts.com.au',
        VOICE_PREVIEW_RECAPTCHA_MODE: 'unsupported',
        VOICE_PREVIEW_RECORDING_DISABLED: 'true'
      }
    }
  ]
});
