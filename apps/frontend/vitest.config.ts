import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [vue()],
  test: {
    environment: 'jsdom',
    globals: true,
    // Unit tests live in src/. Keep the Playwright e2e/ dir out of Vitest (its specs
    // use @playwright/test and crash Vitest's collector).
    include: ['src/**/*.spec.ts'],
  },
});
