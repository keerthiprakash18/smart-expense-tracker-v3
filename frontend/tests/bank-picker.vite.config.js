import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const target = (file) => fileURLToPath(new URL(file, import.meta.url));
// Only build the real BankStatements screen under synthetic finance/API mocks.
// Building the entire app here would accidentally apply mocks to unrelated pages.
export default defineConfig({
  plugins: [react()],
  root:target('../'),
  resolve: {
    alias: [
      { find: /^\.\.\/context\/FinanceContext$/, replacement: target('./bank-picker.mockFinance.jsx') },
      { find: /^\.\.\/services\/api$/, replacement: target('./bank-picker.mockApi.js') },
      { find: /^\.\.\/components\/Ui$/, replacement: target('./bank-picker.mockUi.jsx') },
    ],
  },
  build: {
    outDir:'node_modules/.cache/bank-picker-build',
    emptyOutDir:true,
    rollupOptions:{input:{picker:target('./bank-picker.html')}},
  },
});
