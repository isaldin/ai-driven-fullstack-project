import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { backendEnv, DATABASE_URL } from './constants';

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
  execSync('pnpm exec node --import @swc-node/register/esm-register src/zenstack/seed.ts', {
    cwd: backendDir,
    env,
    stdio: 'inherit',
  });
}

async function ensureDatabase(url: string): Promise<void> {
  const parsed = new URL(url);
  const dbName = parsed.pathname.slice(1);
  parsed.pathname = '/postgres';

  const client = new pg.Client({ connectionString: parsed.toString() });
  await client.connect();
  try {
    const res = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
    if (res.rowCount === 0) {
      await client.query(`CREATE DATABASE "${dbName}"`);
    }
  } finally {
    await client.end();
  }
}
