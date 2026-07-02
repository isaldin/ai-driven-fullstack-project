import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [swc.vite()],
  // unplugin-swc handles all TS transforms (incl. decorator metadata for Nest DI).
  // Disable Vitest's built-in Oxc transform so swc is authoritative and there's no
  // double-transform. (Replaces the deprecated `esbuild: false` the plugin injects.)
  oxc: false,
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.spec.ts'],
    root: '.',
  },
});
