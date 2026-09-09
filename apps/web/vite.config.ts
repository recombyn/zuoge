/// <reference types="vitest/config" />
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { fileURLToPath } from 'url';
import { createSvgIconsPlugin } from 'vite-plugin-svg-icons';
import { resolveDevApiPort } from '../../scripts/dev-api-port.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(root, '../..');
const isTauri = Boolean(process.env.TAURI_ENV_PLATFORM);

function pick(env: Record<string, string>, ...keys: string[]) {
  for (const key of keys) {
    const value = String(env[key] ?? '').trim();
    if (value) return value;
  }
  return '';
}

export default defineConfig(({ mode }) => {
  const env = { ...loadEnv(mode, repoRoot, ''), ...loadEnv(mode, root, '') };
  const devApiPort = resolveDevApiPort(env);
  const apiBaseUrl = pick(env, 'VITE_API_BASE_URL').replace(/\/$/, '');
  const apiProxyTarget =
    apiBaseUrl && /^https?:\/\//i.test(apiBaseUrl) && !/localhost|127\.0\.0\.1/i.test(apiBaseUrl)
      ? apiBaseUrl
      : `http://127.0.0.1:${devApiPort}`;

  return {
    clearScreen: false,
    plugins: [
      react(),
      createSvgIconsPlugin({
        iconDirs: [path.join(root, 'src/assets/svg')],
        symbolId: 'icon-[dir]-[name]',
        inject: 'body-last',
        customDomId: '__svg__icons__dom__',
        svgoOptions: {
          plugins: [{ name: 'preset-default', params: { overrides: { removeViewBox: false } } }],
        },
      }),
    ],
    define: {
      __GOOGLE_CLIENT_ID__: JSON.stringify(pick(env, 'GOOGLE_CLIENT_ID', 'VITE_GOOGLE_CLIENT_ID')),
      __DOCS_URL__: JSON.stringify(
        pick(env, 'VITE_DOCS_URL') ||
          (mode === 'development' ? 'http://localhost:5175' : 'https://recombyn.github.io/recombyn')
      ),
      __DESKTOP_MODE__: JSON.stringify(pick(env, 'VITE_DESKTOP_MODE', 'RECOMBYN_DESKTOP_MODE').toLowerCase()),
      __API_BASE_URL__: JSON.stringify(apiBaseUrl),
    },
    envPrefix: ['VITE_', 'TAURI_ENV_*'],
    resolve: {
      alias: {
        '@': path.join(root, 'src'),
        '@canvas-plugins': path.join(repoRoot, 'plugins/canvas'),
        // Local MIT vector-editor reference (engine + CanvasKit sources).
        '@rcb-vector': path.join(repoRoot, 'vendor/vector-editor-ref/packages/editor/src'),
      },
      extensionAlias: {
        '.js': ['.ts', '.tsx', '.js', '.jsx'],
        '.jsx': ['.tsx', '.jsx'],
      },
    },
    optimizeDeps: {
      include: [
        'fontkit',
        '@orpc/client',
        '@orpc/contract',
        '@orpc/openapi-client',
        '@orpc/openapi-client/fetch',
        '@orpc/tanstack-query',
        '@tanstack/react-query',
        'nuqs',
        'nuqs/adapters/react-router/v6',
      ],
      exclude: [
        '@ffmpeg/ffmpeg',
        '@ffmpeg/util',
        '@ffmpeg/core',
        '@orpc/server',
        '@recombyn/contracts',
      ],
    },
    assetsInclude: ['**/*.wasm'],
    server: {
      host: true,
      port: 3000,
      strictPort: true,
      open: !isTauri,
      fs: { allow: [root, repoRoot, path.join(repoRoot, 'vendor/vector-editor-ref')] },
      watch: { ignored: ['**/src-tauri/**'] },
      proxy: {
        '/api': {
          target: apiProxyTarget,
          changeOrigin: true,
          secure: /^https:/i.test(apiProxyTarget),
          timeout: 0,
          proxyTimeout: 0,
        },
      },
    },
    build: {
      outDir: 'dist',
      sourcemap: isTauri ? Boolean(process.env.TAURI_ENV_DEBUG) : true,
      ...(isTauri && {
        target: process.env.TAURI_ENV_PLATFORM === 'windows' ? 'chrome105' : 'safari13',
        minify: process.env.TAURI_ENV_DEBUG ? false : 'esbuild',
      }),
    },
    test: {
      globals: true,
      environment: 'jsdom',
      setupFiles: ['./src/setupTests.ts'],
      include: ['src/**/*.{test,spec}.{ts,tsx}'],
      // Bench / stress suites are opt-in via `npm run test:stress` — keep them
      // out of default CI so a loaded self-hosted runner does not flake gate.
      exclude: [
        'src/private/**',
        'src/**/*.bench.test.ts',
        'src/**/*stress*.test.ts',
        'src/**/*Stress*.test.ts',
      ],
      css: false,
    },
  };
});
