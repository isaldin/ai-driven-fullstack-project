# Runbook: Admin Bootstrap

How to create the **first** admin user. This template ships with **no default
credentials** — there is no seeded `admin@example.com` with a known password waiting in
production. The first admin is created deliberately, once, from environment you supply.

Implementation: [`apps/backend/src/zenstack/bootstrap-admin.ts`](../../apps/backend/src/zenstack/bootstrap-admin.ts).

## 1. What the command does

`bootstrap-admin`:

1. Runs the full environment validator first (`loadEnv()` from `@app/config`), so in
   production it already fails fast on placeholder secrets, non-HTTPS origins, etc.
2. Requires `SEED_ADMIN_EMAIL` and `SEED_ADMIN_PASSWORD` — with no default for either, it
   refuses to create an admin if either is missing.
3. Hashes the password with Argon2 and creates a single `ADMIN` user.
4. Writes a **secret-free** audit row (`AuditLog`, `action=admin.bootstrap`).
5. **Never prints the password** to stdout/stderr/logs.
6. Is **strictly idempotent**: if an admin with that email already exists it makes no
   change — never a second admin, never a silent password reset.

## 2. Required / optional environment

| Variable | Required | Rule |
| --- | --- | --- |
| `SEED_ADMIN_EMAIL` | yes | Must be a syntactically valid email (`a@b.c`). |
| `SEED_ADMIN_PASSWORD` | yes | Minimum **12** characters. One-time secret — rotate after use. |
| `SEED_ADMIN_NAME` | no | Display name; defaults to `Admin`. |
| `CONFIRM_PRODUCTION_BOOTSTRAP` | **only in production** | Must be exactly `true` when `NODE_ENV=production`, or the command refuses to run. |

All the normal app env (`DATABASE_URL`, `JWT_ACCESS_SECRET`, `SERVICE_API_TOKEN`, …) must
also be present and valid, because `loadEnv()` validates the whole environment before any
DB work.

## 3. Command

From the repo root:

```bash
pnpm bootstrap-admin
```

That is an alias for the backend workspace script:

```bash
pnpm --filter @app/backend bootstrap-admin
```

(`pnpm db:seed` is a second alias for the same script.) For local dev the backend script
loads the repo-root `.env` automatically via Node's `--env-file-if-exists=../../.env`, so
you can put `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` there for a one-off local run.

### Local example

```bash
# .env already has DATABASE_URL etc. (pnpm docker:up gives you Postgres)
SEED_ADMIN_EMAIL='you@your-domain.com' \
SEED_ADMIN_PASSWORD='a-long-one-time-password' \
pnpm bootstrap-admin
```

## 4. Production example

In production `NODE_ENV=production`, so you must also pass
`CONFIRM_PRODUCTION_BOOTSTRAP=true`. Set the one-time secret **inline** (so it never lands
in a dotfile), run once, then remove/rotate it. Run it inside the backend container against
the production database — the container already has the validated production env.

```bash
cd /opt/app

# Run the one-time bootstrap inside the running backend container.
# The password is passed inline for THIS command only — it is never logged.
docker compose -f infra/docker/docker-compose.yml --env-file .env exec \
  -e SEED_ADMIN_EMAIL='admin@your-domain.com' \
  -e SEED_ADMIN_PASSWORD='REPLACE-with-a-strong-one-time-password' \
  -e CONFIRM_PRODUCTION_BOOTSTRAP=true \
  backend node dist/zenstack/bootstrap-admin.js
```

> The `-e` values live only in this single `exec` invocation's process environment; they are
> not written to `.env`, not baked into the image, and not printed by the command. Clear the
> line from your shell history afterwards (see §6).

## 5. Expected output

Success (admin created):

```
✓ bootstrap-admin: created admin admin@your-domain.com (id=<uuid>). The password was NOT logged — now delete/rotate the one-time SEED_ADMIN_PASSWORD.
```

Re-run / already exists (idempotent — no change, no new admin, no password reset):

```
bootstrap-admin: admin already exists (admin@your-domain.com) — no changes made.
```

Refused (missing/invalid input) — exits non-zero, e.g.:

```
✗ bootstrap-admin: SEED_ADMIN_PASSWORD must be at least 12 characters
```

```
✗ bootstrap-admin: refusing to bootstrap in production without CONFIRM_PRODUCTION_BOOTSTRAP=true
```

## 6. AFTER first use — rotate the one-time secret

`SEED_ADMIN_PASSWORD` is a **one-time bootstrap secret**, not a standing credential. As soon
as the admin exists:

1. **Log in** with the new admin and confirm it works.
2. **Change the admin's password** through the application's normal flow so the bootstrap
   value is no longer the live password.
3. **Remove the secret from anywhere it was placed:**

   ```bash
   # If you exported it for a local run, drop it and scrub shell history.
   unset SEED_ADMIN_PASSWORD SEED_ADMIN_EMAIL
   history -d "$(history 1 | awk '{print $1}')"   # remove the last command (bash)
   ```

   If it was ever written to `.env` or a vault, delete/rotate that entry. Re-running
   `bootstrap-admin` later is safe (idempotent), so you lose nothing by removing it.

## 7. What gets audited (and what does not)

A row is written to `AuditLog`:

- `action`: `admin.bootstrap`
- `actor`: `cli:bootstrap-admin`
- `targetId`: the new user id
- `metadata`: `{ email, role: "ADMIN", nodeEnv }` — **no password, no token**

The password is never part of any log line, audit metadata, or query text.

## 8. Related

- Secrets validation / rotation: [`SECRET_ROTATION.md`](./SECRET_ROTATION.md)
- Security overview: [`../SECURITY.md`](../SECURITY.md)
