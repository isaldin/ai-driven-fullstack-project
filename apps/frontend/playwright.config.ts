import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';
import { BACKEND_URL, BASE_URL, backendEnv, FRONTEND_PORT } from './e2e/constants';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

// Container-based runners (self-hosted Gitea act_runner / nektos `act`) run jobs as
// root, where Chromium's sandbox refuses to start. Drop it only when explicitly asked
// via PW_CHROMIUM_NO_SANDBOX=1 — GitHub-hosted runners run as non-root and keep it.
const launchOptions = process.env.PW_CHROMIUM_NO_SANDBOX === '1' ? { args: ['--no-sandbox'] } : {};

// Full-stack e2e: Playwright boots the real backend (built dist) against an
// isolated Postgres, plus the Vite dev server pointed at that backend. Requires
// a reachable Postgres (`pnpm docker:up`) and a prior `pnpm build` (the backend
// runs from dist). Browsers: `pnpm --filter @app/frontend exec playwright install`.
export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  timeout: 30_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], launchOptions } }],
  webServer: [
    {
      command: 'pnpm --filter @app/backend start',
      cwd: repoRoot,
      // Gate on liveness (just "is it listening"), not readiness: readiness pings
      // the DB, but the isolated e2e DB is created in globalSetup, which Playwright
      // runs only after the webServers are up.
      url: `${BACKEND_URL}/health/live`,
      timeout: 60_000,
      reuseExistingServer: !process.env.CI,
      env: backendEnv,
    },
    {
      command: `pnpm --filter @app/frontend exec vite --port ${FRONTEND_PORT} --strictPort`,
      cwd: repoRoot,
      url: BASE_URL,
      timeout: 60_000,
      reuseExistingServer: !process.env.CI,
      env: { VITE_API_URL: BACKEND_URL },
    },
  ],
});
