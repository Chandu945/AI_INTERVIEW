import { defineConfig } from '@playwright/test';

// The browser tests start their own servers on ports 3100 and 8100: a backend with a fresh,
// seeded database and no Gemini key, and a frontend that builds into .next-test. Your normal
// servers on 3000 and 8000, and your chat.db, are never touched.
export default defineConfig({
  testDir: './tests',
  workers: 1, // the tests share one backend
  timeout: 60_000,
  reporter: [['list']],
  use: { baseURL: 'http://localhost:3100', channel: 'chrome', viewport: { width: 1440, height: 900 } },
  expect: { toHaveScreenshot: { maxDiffPixels: 50 } },
  webServer: [
    {
      command: '../backend/.venv/bin/python ../backend/tests/ui_server.py',
      url: 'http://localhost:8100/api/health',
      reuseExistingServer: false,
    },
    {
      command: 'npm run dev -- --port 3100',
      url: 'http://localhost:3100',
      reuseExistingServer: false,
      timeout: 180_000,
      env: { NEXT_PUBLIC_API_URL: 'http://localhost:8100', INTERACT_TESTS: '1' },
    },
  ],
});
