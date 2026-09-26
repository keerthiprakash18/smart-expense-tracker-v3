import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['app-logo.svg'],
      manifest: {
        name: 'Smart Expense Tracker',
        short_name: 'Smart Expense',
        description: 'Track expenses, income, bills, money commitments and savings goals.',
        theme_color: '#071019',
        background_color: '#05090d',
        display: 'standalone',
        start_url: '/',
        scope: '/',
        icons: [
          { src: 'app-logo.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' },
        ],
      },
      workbox: {
        navigateFallback: 'index.html',
        cleanupOutdatedCaches: true,
        clientsClaim: true,
        skipWaiting: true,
        navigateFallbackDenylist: [/^\/api\//, /^\/assets\//],
        globPatterns: ['**/*.{js,css,html,svg,png,webp,woff2}'],
        globIgnores: ['**/smt.png'],
        maximumFileSizeToCacheInBytes: 3 * 1024 * 1024,
      },
    }),
  ],
  server: {
    host: true,
    port: 5173,
    proxy: {
      '/api': { target: 'http://127.0.0.1:8000', changeOrigin: true, secure: false },
      '/media': { target: 'http://127.0.0.1:8000', changeOrigin: true, secure: false },
    },
  },
});
