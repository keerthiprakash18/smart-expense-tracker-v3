import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  testDir:'.',
  testMatch:'bank-picker.browser.spec.js',
  workers:1,
  reporter:'line',
  timeout:90000,
  outputDir:fileURLToPath(new URL('../node_modules/.cache/bank-picker-results',import.meta.url)),
  use:{baseURL:'http://127.0.0.1:4182',browserName:'chromium',serviceWorkers:'block'},
  webServer:{
    command:'npx vite build --config tests/bank-picker.vite.config.js && npx vite preview --config tests/bank-picker.vite.config.js --host 127.0.0.1 --port 4182 --strictPort',
    cwd:fileURLToPath(new URL('..',import.meta.url)),
    url:'http://127.0.0.1:4182/tests/bank-picker.html',
    reuseExistingServer:false,timeout:120000,
  },
});