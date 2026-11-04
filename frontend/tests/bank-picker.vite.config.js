import { defineConfig, mergeConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import appConfig from '../vite.config.js';

const target = (file) => fileURLToPath(new URL(file, import.meta.url));
// Alias exactly the three dependencies imported by the *actual* bank statements page.
// No live Supabase connection or real user data is used in these browser tests.
export default mergeConfig(appConfig, defineConfig({
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
    rollupOptions:{input:{
      app:target('../index.html'),
      picker:target('./bank-picker.html'),
    }},
  },
}));