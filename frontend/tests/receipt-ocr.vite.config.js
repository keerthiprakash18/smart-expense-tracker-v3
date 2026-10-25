import { defineConfig, mergeConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import appConfig from '../vite.config.js';

// Include the real app/PWA configuration so asset-copy and precache limits are
// checked even while the finance adapter's OCR route is being integrated.
export default mergeConfig(appConfig, defineConfig({
  root: fileURLToPath(new URL('..', import.meta.url)),
  build: {
    outDir: 'node_modules/.cache/receipt-ocr-build', emptyOutDir: true,
    rollupOptions: { input: { app: fileURLToPath(new URL('../index.html', import.meta.url)), ocr: fileURLToPath(new URL('./receipt-ocr.html', import.meta.url)) } },
  },
}));
