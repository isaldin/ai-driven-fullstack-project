import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// E2E defaults — set in the config (main process) so both globalSetup and forked
// workers inherit them. Override DATABASE_URL in CI to point at the test Postgres.
process.env.NODE_ENV ??= 'test';
process.env.DATABASE_URL ??= 'postgresql://postgres:postgres@localhost:5432/app_e2e';
process.env.JWT_ACCESS_SECRET ??= 'test-access-secret-0123456789abcdef';
process.env.JWT_REFRESH_SECRET ??= 'test-refresh-secret-0123456789abcdef';
process.env.SERVICE_API_TOKEN ??= 'test-service-token';
process.env.COOKIE_DOMAIN ??= 'localhost';
process.env.OTEL_SDK_DISABLED ??= 'true';
process.env.LOG_LEVEL ??= 'silent';

export default defineConfig({
  plugins: [swc.vite()],
  // swc is the sole TS transformer (decorator metadata for Nest DI); disable the
  // built-in Oxc transform. Replaces the deprecated `esbuild: false` the plugin injects.
  oxc: false,
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.e2e-spec.ts'],
    root: '.',
    testTimeout: 30_000,
    hookTimeout: 60_000,
    fileParallelism: false,
    globalSetup: ['./test/global-setup.ts'],
  },
});
