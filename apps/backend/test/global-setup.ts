import { execSync } from 'node:child_process';
import pg from 'pg';

/** Ensures the e2e database exists and its schema is pushed before tests run. */
export default async function setup(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required for e2e tests');

  await ensureDatabase(url);
  execSync('pnpm exec zen db push --schema src/zenstack/schema.zmodel --accept-data-loss', {
    stdio: 'inherit',
    env: process.env,
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
