import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: ['supabase-auth.browser.spec.js', 'supabase-finance.browser.spec.js'],
  workers: 1,
  reporter: 'line',
  use: { baseURL: 'http://127.0.0.1:4175', browserName: 'chromium' },
  webServer: {
    command: 'npm run dev -- --host 127.0.0.1 --port 4175 --strictPort',
    cwd: new URL('..', import.meta.url).pathname.replace(/^\/(?=[A-Za-z]:)/, ''),
    url: 'http://127.0.0.1:4175',
    reuseExistingServer: false,
    env: {
      VITE_BACKEND_PROVIDER: 'supabase',
      VITE_SUPABASE_URL: 'https://auth-test.supabase.co',
      VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_offline_test',
    },
  },
});
