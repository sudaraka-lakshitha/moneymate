import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon-16.png', 'favicon-32.png', 'favicon-48.png', 'apple-touch-icon.png'],
      manifest: {
        // A stable id keeps the install identity fixed across deploys, so an
        // update never registers as a second app.
        id: '/',
        name: 'MoneyMate — Split Smarter, Settle Faster',
        short_name: 'MoneyMate',
        description:
          'Split group expenses, settle debts with friends and see where shared money goes, in Sri Lankan rupees.',
        theme_color: '#0B0B16',
        background_color: '#0B0B16',
        display: 'standalone',
        // Chrome installs a WebAPK (app drawer entry) rather than a bookmark
        // shortcut when the manifest is complete and a service worker is live.
        display_override: ['standalone', 'minimal-ui'],
        orientation: 'portrait',
        start_url: '/',
        scope: '/',
        lang: 'en',
        categories: ['finance', 'productivity', 'utilities'],
        prefer_related_applications: false,
        // Screenshots turn Chrome's mini-infobar into the full install dialog.
        screenshots: [
          {
            src: 'screenshot-narrow.png',
            sizes: '540x1170',
            type: 'image/png',
            form_factor: 'narrow',
            label: 'Track balances and split bills',
          },
          {
            src: 'screenshot-wide.png',
            sizes: '1280x800',
            type: 'image/png',
            form_factor: 'wide',
            label: 'MoneyMate on the desktop',
          },
        ],
        shortcuts: [
          { name: 'Add an expense', url: '/?action=add-expense', description: 'Log a new bill' },
          { name: 'Search', url: '/?action=search', description: 'Find any expense' },
        ],
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          // Separate artwork: maskable icons are cropped to a safe zone.
          { src: 'icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // Precache the app shell so a cold launch works with no network.
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
        navigateFallback: '/index.html',
        runtimeCaching: [
          {
            // Fonts are static and versioned — cache them hard.
            urlPattern: /^https:\/\/fonts\.(googleapis|gstatic)\.com\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'google-fonts',
              expiration: { maxEntries: 20, maxAgeSeconds: 60 * 60 * 24 * 365 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            // Read paths only. Writes must reach the server: balances depend on
            // other people's concurrent changes, so a stale replay is not safe.
            urlPattern: ({ url, request }) =>
              url.pathname.startsWith('/rest/v1/') && request.method === 'GET',
            handler: 'NetworkFirst',
            options: {
              cacheName: 'supabase-reads',
              networkTimeoutSeconds: 5,
              expiration: { maxEntries: 120, maxAgeSeconds: 60 * 60 * 24 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            urlPattern: ({ url }) => url.pathname.includes('/storage/v1/object/'),
            handler: 'CacheFirst',
            options: {
              cacheName: 'receipt-images',
              expiration: { maxEntries: 60, maxAgeSeconds: 60 * 60 * 24 * 30 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
      devOptions: { enabled: false },
    }),
  ],
  server: {
    port: 5173,
    host: true,
  },
});
