import { loadEnv } from '@app/config';
import { ZenStackClient } from '@zenstackhq/orm';
import { PostgresDialect } from '@zenstackhq/orm/dialects/postgres';
import argon2 from 'argon2';
import { Pool } from 'pg';
import { schema } from './schema.js';

async function main(): Promise<void> {
  const env = loadEnv();
  const pool = new Pool({ connectionString: env.DATABASE_URL });
  const db = new ZenStackClient(schema, { dialect: new PostgresDialect({ pool }) });

  const email = 'admin@example.com';
  const existing = await db.user.findUnique({ where: { email } });
  if (existing) {
    console.log(`Admin user already exists: ${email}`);
  } else {
    await db.user.create({
      data: {
        email,
        name: 'Admin',
        role: 'ADMIN',
        passwordHash: await argon2.hash('admin12345'),
      },
    });
    console.log(`Seeded admin user: ${email} (password: admin12345)`);
  }

  await pool.end();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
