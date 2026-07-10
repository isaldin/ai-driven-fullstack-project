import { loadEnv } from '@app/config';
import { ZenStackClient } from '@zenstackhq/orm';
import { PostgresDialect } from '@zenstackhq/orm/dialects/postgres';
import { Pool } from 'pg';
import { schema } from './schema.js';

// Post-migration application smoke test. Exercises the GENERATED ZenStack client
// (the same one the app uses) against the freshly-migrated database: a User
// round-trip and an AuditLog write. If a committed migration diverged from the
// schema the client was generated for (missing table/column), one of these calls
// throws and the gate fails.
async function main(): Promise<void> {
  const env = loadEnv();
  const pool = new Pool({ connectionString: env.DATABASE_URL });
  const db = new ZenStackClient(schema, { dialect: new PostgresDialect({ pool }) });

  try {
    const email = `smoke+${process.pid}-${Date.now()}@smoke.local`;
    const user = await db.user.create({
      data: { email, name: 'migration-smoke', passwordHash: 'not-a-real-hash' },
    });
    const found = await db.user.findUnique({ where: { id: user.id } });
    if (!found || found.email !== email) throw new Error('User round-trip failed');

    await db.auditLog.create({ data: { action: 'migration.smoke', actor: 'ci' } });
    const count = await db.auditLog.count({ where: { action: 'migration.smoke' } });
    if (count < 1) throw new Error('AuditLog round-trip failed');

    // Leave the database clean.
    await db.auditLog.deleteMany({ where: { action: 'migration.smoke' } });
    await db.user.delete({ where: { id: user.id } });

    console.log('✓ migration smoke: migrated schema + generated client OK');
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
