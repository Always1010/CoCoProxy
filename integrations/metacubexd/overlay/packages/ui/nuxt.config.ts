// https://nuxt.com/docs/api/configuration/nuxt-config
import tailwindcss from '@tailwindcss/vite'
import pkg from './package.json'

// Keep upstream Workbox/app-shell caching disabled. The notification-only
// worker and manifest are explicit public assets, registered on user opt-in.
const pwaDisabled = true

export default defineNuxtConfig({
  // Keep generated imports under this source tree when dependencies are reused
  // through directory links; a shared node_modules cache can resolve them into
  // another checkout and emit invalid prerender modules on Windows.
  buildDir: '.nuxt',
  // Workspace move: the Nuxt app is the package root. Pin srcDir explicitly
  // so the legacy root layout (top-level pages/, components/, no app/ dir)
  // never depends on Nuxt 4 auto-detection.
  srcDir: '.',

  devtools: { enabled: false },

  css: ['~/assets/css/main.css'],

  // CSR mode - disable SSR completely
  ssr: false,

  // Use hash mode routing (same as original HashRouter)
  router: {
    options: {
      hashMode: true,
    },
  },

  // Runtime config
  // Public keys can be overridden at runtime via NUXT_PUBLIC_* env vars.
  // The standalone panel container maps DEFAULT_BACKEND_URL onto
  // NUXT_PUBLIC_DEFAULT_BACKEND_URL in docker-entrypoint.sh so operators can
  // pre-fill the connect form without rebuilding — see README ("Pre-fill the
  // backend address"). The empty string here is only the build-time default.
  runtimeConfig: {
    public: {
      appVersion: pkg.version,
      mockMode: false,
      defaultBackendURL: '',
      githubToken: '',
    },
  },

  // Modules
  modules: [
    '@vueuse/nuxt',
    '@pinia/nuxt',
    '@nuxtjs/i18n',
    '@vite-pwa/nuxt',
  ],

  // Retain upstream module options for compatibility, with generation disabled.
  // The explicit public manifest/worker provide opt-in notifications only.
  pwa: {
    disable: pwaDisabled,
    registerType: 'prompt',
    includeAssets: ['favicon.svg'],
    manifest: {
      name: 'MetaCubeXD',
      short_name: 'MetaCubeXD',
      description: 'Mihomo Dashboard, The Official One, XD',
      theme_color: '#000000',
      icons: [
        { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
        { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png' },
        {
          src: 'pwa-512x512.png',
          sizes: '512x512',
          type: 'image/png',
          purpose: 'any maskable',
        },
      ],
    },
    workbox: {
      // Precache the built app shell only (relative paths keep subdirectory
      // deployments working). Backend API responses are dynamic and
      // cross-origin, so they are intentionally left uncached.
      globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
      // Keep these out of the precache:
      // - config.js: deploy-time backend URL, editable after build — precaching
      //   would pin a stale address. Always fetch it fresh.
      // - 200.html/404.html: nuxt generate's SPA fallbacks. nitro normalizes
      //   their precache URLs to extension-less "/200" and "/404", which 404 on
      //   static hosts and make the SW install fail (so it never activates). The
      //   app shell is already covered by index.html via the navigation fallback.
      globIgnores: [
        '**/config.js',
        '200.html',
        '404.html',
        // Monaco editor + language worker chunks: large, lazy-loaded only on
        // the profile editor; never precache (would blow the 5MB SW cap and
        // make the service worker install fail silently). Vite emits these as
        // *.worker-*.js / monaco chunks named after their entry.
        '**/*.worker-*.js',
        '**/yaml.worker-*.js',
        '**/json.worker-*.js',
        '**/editor.worker-*.js',
        // The monaco-editor core chunk itself (multi-MB) is lazy; keep it out
        // of precache. Its chunk name contains "monaco".
        '**/monaco-*.js',
      ],
      maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
      // Keep skipWaiting/clientsClaim off to prevent iOS Safari refresh loops (#1740).
      skipWaiting: false,
      clientsClaim: false,
      // Drop outdated precaches so iOS Web Clips don't load stale resources (#1796).
      cleanupOutdatedCaches: true,
    },
  },

  // i18n configuration
  i18n: {
    locales: [
      { code: 'en', name: 'English', file: 'en.json' },
      { code: 'zh', name: '简体中文', file: 'zh.json' },
      { code: 'ru', name: 'Русский', file: 'ru.json' },
      { code: 'ja', name: '日本語', file: 'ja.json' },
      { code: 'ko', name: '한국어', file: 'ko.json' },
      { code: 'fr', name: 'Français', file: 'fr.json' },
      { code: 'fa', name: 'فارسی', file: 'fa.json' },
    ],
    defaultLocale: 'en',
    langDir: 'locales',
    strategy: 'no_prefix',
    detectBrowserLanguage: {
      useCookie: true,
      cookieKey: 'metacubexd_lang',
      fallbackLocale: 'en',
    },
  },

  // Use the existing CSS system-font fallback; builds do not fetch fonts.

  // TypeScript configuration
  typescript: {
    strict: true,
    shim: false,
  },

  // Auto imports
  imports: {
    dirs: ['composables', 'stores', 'utils', 'constants', 'types'],
  },

  // Components auto-import
  components: [
    {
      path: '~/components',
      pathPrefix: false,
    },
  ],

  // App configuration
  app: {
    // Use relative paths for assets to support both root and subdirectory deployments
    // Can be overridden with NUXT_APP_BASE_URL environment variable
    baseURL: process.env.NUXT_APP_BASE_URL || '/',
    head: {
      charset: 'utf-8',
      viewport:
        'width=device-width, initial-scale=1.0, minimum-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover',
      title: 'MetaCubeXD',
      meta: [{ name: 'theme-color', content: '#000000' }],
      link: [
        { rel: 'icon', type: 'image/svg+xml', href: 'favicon.svg' },
        // iOS fills any transparent pixels of an apple-touch-icon with black,
        // which gave the home-screen icon ugly black corners (#436). Point it
        // at the opaque 180x180 PNG (the iOS-recommended size) instead of the
        // 192x192 PWA icon, which has a transparent background.
        {
          rel: 'apple-touch-icon',
          sizes: '180x180',
          href: 'apple-touch-icon-180x180.png',
        },
        // Static public asset: available in development and generated output.
        { rel: 'manifest' as const, href: '/manifest.webmanifest' },
      ],
      script: [
        {
          // Use relative path for config.js to support both root and subdirectory deployments
          // tagPosition: 'head' and blocking load ensure config is available before app runs
          src: 'config.js',
          tagPosition: 'head',
          defer: false,
          async: false,
          onerror:
            "window.__METACUBEXD_CONFIG__={defaultBackendURL:'',githubToken:''}",
        },
        {
          innerHTML: `window.__METACUBEXD_CONFIG__ = window.__METACUBEXD_CONFIG__ || { defaultBackendURL: '', githubToken: '' }`,
        },
      ],
    },
  },

  // Vite configuration
  vite: {
    build: {
      chunkSizeWarningLimit: 1000,
    },
    plugins: [tailwindcss()],
  },

  // Disable app manifest to avoid 404 errors for _nuxt/builds/meta/*.json
  // in non-standard browsers (e.g. VIA on Android). Not needed for CSR-only apps.
  experimental: {
    appManifest: false,
  },

  compatibilityDate: '2025-01-01',
})
