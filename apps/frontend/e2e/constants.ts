// Shared constants for the frontend e2e suite (Playwright config + global setup).
//
// The suite runs against dedicated ports so it never collides with `pnpm dev`
// (backend 3000 / frontend 5173), and against an isolated database so it never
// touches dev data.

const dbHost = process.env.E2E_DB_HOST ?? 'localhost';

export const FRONTEND_PORT = 5273;
export const BACKEND_PORT = 3100;
export const BASE_URL = `http://localhost:${FRONTEND_PORT}`;
export const BACKEND_URL = `http://localhost:${BACKEND_PORT}`;

/** Isolated e2e database — created, schema-pushed and seeded by global-setup. */
export const DATABASE_URL = `postgresql://postgres:postgres@${dbHost}:5432/app_e2e_web`;

/**
 * Full environment the e2e backend needs. Passed explicitly (not via a .env file)
 * so the suite is self-contained and runs in CI with no .env present. The app
 * scripts load `.env` with `--env-file-if-exists` in non-override mode, so these win.
 */
export const backendEnv: Record<string, string> = {
  NODE_ENV: 'test',
  DATABASE_URL,
  JWT_ACCESS_SECRET: 'e2e-access-secret-0123456789abcdef',
  JWT_REFRESH_SECRET: 'e2e-refresh-secret-0123456789abcdef',
  SERVICE_API_TOKEN: 'e2e-service-token',
  BACKEND_PORT: String(BACKEND_PORT),
  CORS_ORIGIN: BASE_URL,
  COOKIE_DOMAIN: 'localhost',
  OTEL_SDK_DISABLED: 'true',
  LOG_LEVEL: 'silent',
};
