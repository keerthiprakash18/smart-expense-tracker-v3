import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  testDir: '.', testMatch: 'receipt-ocr.browser.spec.js', workers: 1, reporter: 'line', timeout: 120000,
  outputDir: fileURLToPath(new URL('../node_modules/.cache/receipt-ocr-results', import.meta.url)),
  use: { baseURL: 'http://127.0.0.1:4176', browserName: 'chromium', serviceWorkers: 'block' },
  webServer: {
    command: 'npx vite build --config tests/receipt-ocr.vite.config.js && npx vite preview --config tests/receipt-ocr.vite.config.js --host 127.0.0.1 --port 4176 --strictPort',
    cwd: fileURLToPath(new URL('..', import.meta.url)), url: 'http://127.0.0.1:4176/tests/receipt-ocr.html', reuseExistingServer: false, timeout: 120000,
  },
});
