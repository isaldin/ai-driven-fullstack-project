import { loadEnv } from '@app/config';
import { ZenStackClient } from '@zenstackhq/orm';
import { PostgresDialect } from '@zenstackhq/orm/dialects/postgres';
import argon2 from 'argon2';
import { Pool } from 'pg';
import { schema } from './schema.js';

// ─────────────────────────────────────────────────────────────
// One-time admin bootstrap. Deliberately has NO default credentials:
//   - SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD are required.
//   - Password must be >= MIN_PASSWORD_LENGTH.
//   - In production, CONFIRM_PRODUCTION_BOOTSTRAP=true is also required.
//   - The password is NEVER written to stdout/stderr/logs.
//   - Strictly idempotent: if the admin already exists it makes no change
//     (never a second admin, never a silent password reset).
//   - Records a secret-free audit entry (action=admin.bootstrap).
//
// After first use, delete/rotate the one-time SEED_ADMIN_PASSWORD secret — see
// docs/runbooks/ADMIN_BOOTSTRAP.md.
// ─────────────────────────────────────────────────────────────

const MIN_PASSWORD_LENGTH = 12;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function fail(message: string): never {
  console.error(`✗ bootstrap-admin: ${message}`);
  process.exit(1);
}

async function main(): Promise<void> {
  // Validates the whole environment (fail-fast); in production this already
  // rejects placeholder secrets, non-HTTPS origins, etc.
  const env = loadEnv();

  const email = process.env.SEED_ADMIN_EMAIL?.trim();
  const password = process.env.SEED_ADMIN_PASSWORD;
  const name = process.env.SEED_ADMIN_NAME?.trim() || 'Admin';

  if (!email) fail('SEED_ADMIN_EMAIL is required (no default admin is created)');
  if (!EMAIL_RE.test(email)) fail('SEED_ADMIN_EMAIL is not a valid email address');
  if (!password) fail('SEED_ADMIN_PASSWORD is required (no default admin is created)');
  if (password.length < MIN_PASSWORD_LENGTH) {
    fail(`SEED_ADMIN_PASSWORD must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  if (env.NODE_ENV === 'production' && process.env.CONFIRM_PRODUCTION_BOOTSTRAP !== 'true') {
    fail('refusing to bootstrap in production without CONFIRM_PRODUCTION_BOOTSTRAP=true');
  }

  const pool = new Pool({ connectionString: env.DATABASE_URL });
  const db = new ZenStackClient(schema, { dialect: new PostgresDialect({ pool }) });

  try {
    const existing = await db.user.findUnique({ where: { email } });
    if (existing) {
      // Idempotent: no second admin, no password change.
      console.log(`bootstrap-admin: admin already exists (${email}) — no changes made.`);
      return;
    }

    const user = await db.user.create({
      data: { email, name, role: 'ADMIN', passwordHash: await argon2.hash(password) },
    });

    // Secret-free audit record. metadata must never carry the password/token.
    await db.auditLog.create({
      data: {
        action: 'admin.bootstrap',
        actor: 'cli:bootstrap-admin',
        targetId: user.id,
        metadata: JSON.stringify({ email, role: 'ADMIN', nodeEnv: env.NODE_ENV }),
      },
    });

    // Never echo the password. Prompt the operator to rotate the one-time secret.
    console.log(
      `✓ bootstrap-admin: created admin ${email} (id=${user.id}). ` +
        'The password was NOT logged — now delete/rotate the one-time SEED_ADMIN_PASSWORD.',
    );
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  // Print only the message/stack (never the process env), so a DB error can't
  // leak the admin password (which is never part of any query text anyway).
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exit(1);
});
