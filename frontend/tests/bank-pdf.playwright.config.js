import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  testDir: '.',
  testMatch: 'bank-pdf.browser.spec.js',
  workers: 1,
  reporter: 'line',
  timeout: 100000,
  outputDir: fileURLToPath(new URL('../node_modules/.cache/bank-pdf-results', import.meta.url)),
  use: { baseURL: 'http://127.0.0.1:4178', browserName: 'chromium', serviceWorkers: 'block' },
  webServer: {
    command: 'npx vite build --config tests/bank-pdf.vite.config.js && npx vite preview --config tests/bank-pdf.vite.config.js --host 127.0.0.1 --port 4178 --strictPort',
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    url: 'http://127.0.0.1:4178/tests/bank-pdf.html',
    reuseExistingServer: false, timeout: 120000,
  },
});