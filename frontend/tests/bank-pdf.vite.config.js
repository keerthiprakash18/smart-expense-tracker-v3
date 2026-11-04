import { defineConfig, mergeConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import appConfig from '../vite.config.js';

export default mergeConfig(appConfig, defineConfig({
  root: fileURLToPath(new URL('..', import.meta.url)),
  build: {
    outDir: 'node_modules/.cache/bank-pdf-build',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        app: fileURLToPath(new URL('../index.html', import.meta.url)),
        bankPdf: fileURLToPath(new URL('./bank-pdf.html', import.meta.url)),
      },
    },
  },
}));