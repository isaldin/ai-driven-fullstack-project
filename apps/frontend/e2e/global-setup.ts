import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { backendEnv, DATABASE_URL, E2E_ADMIN } from './constants';

const backendDir = fileURLToPath(new URL('../../backend', import.meta.url));

/**
 * Prepares the isolated e2e database before the suite runs: creates it if
 * missing, pushes the current ZenStack schema, and seeds the admin user the
 * tests log in with. Mirrors the backend's own e2e DB bootstrap.
 */
export default async function globalSetup(): Promise<void> {
  await ensureDatabase(DATABASE_URL);

  const env = { ...process.env, ...backendEnv };
  execSync('pnpm exec zen db push --schema src/zenstack/schema.zmodel --accept-data-loss', {
    cwd: backendDir,
    env,
    stdio: 'inherit',
  });
  execSync(
    'pnpm exec node --import @swc-node/register/esm-register src/zenstack/bootstrap-admin.ts',
    {
      cwd: backendDir,
      env: { ...env, SEED_ADMIN_EMAIL: E2E_ADMIN.email, SEED_ADMIN_PASSWORD: E2E_ADMIN.password },
      stdio: 'inherit',
    },
  );
}

async function ensureDatabase(url: string): Promise<void> {
  const parsed = new URL(url);
  const dbName = parsed.pathname.slice(1);
  parsed.pathname = '/postgres';

  const client = new pg.Client({ connectionString: parsed.toString() });
  await client.connect();
  try {
    // Recreate for a pristine run: `db push` doesn't wipe unchanged tables, so a
    // stale admin row from a previous run would make the idempotent bootstrap
    // skip and leave old credentials. DROP … WITH (FORCE) needs PostgreSQL 13+.
    await client.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    await client.query(`CREATE DATABASE "${dbName}"`);
  } finally {
    await client.end();
  }
}
