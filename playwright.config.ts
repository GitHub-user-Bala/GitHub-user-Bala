import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/browser',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: { baseURL: 'http://localhost:5173', trace: 'retain-on-failure' },
  webServer: [
    { command: 'pnpm --filter @kart/api dev', url: 'http://localhost:3001/api/health', reuseExistingServer: !process.env.CI, timeout: 60000 },
    { command: 'pnpm --filter @kart/web dev', url: 'http://localhost:5173', reuseExistingServer: !process.env.CI, timeout: 60000 },
  ],
});
