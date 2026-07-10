# Runbook: Secret Rotation

How to rotate every secret this stack uses on the `single-vps-production` profile, what
happens to live sessions/connections during each rotation, and how to confirm the old value
is dead afterwards.

Two independent guardrails reject weak/placeholder/duplicated secrets, so a bad rotation
fails **before** it reaches a running service:

- **`@app/config`** (`packages/config/src/index.ts`) — in `NODE_ENV=production` it requires
  `JWT_ACCESS_SECRET` and `SERVICE_API_TOKEN` to be **≥ 32 chars**, **not** a template
  placeholder, and **distinct** from each other; it rejects placeholder credentials embedded
  in `DATABASE_URL` / `REDIS_URL`, non-HTTPS `CORS_ORIGIN`, and `localhost` under
  `DEPLOYMENT_MODE=compose`. The backend/bot **crash-loop on boot** if any of these fail.
- **Ansible preflight** (`infra/ansible/preflight.yml`, run before any deploy with
  `-e deployment_environment=production`) — asserts the same secret floor (`length >= 32`,
  no `change-me`/`REPLACE_WITH`, `vault_jwt_access_secret != vault_service_api_token`) with
  `no_log: true`, so a placeholder deploy never starts.

## 0. Operational rules (apply to every rotation)

- **Generate high-entropy values:**

  ```bash
  openssl rand -base64 48        # ~64 chars, well over the 32-char floor
  ```

- **Never reuse a value across two variables.** `JWT_ACCESS_SECRET` and `SERVICE_API_TOKEN`
  must differ (the validator and preflight both enforce this); DB/Redis/OpenObserve
  passwords are each their own value.
- **Secrets live only in the encrypted Ansible vault**, are rendered to
  `{{ app_dir }}/.env` at `mode 0600`, and must never appear in:
  - `docker compose config` output,
  - CI logs or artifacts,
  - your shell history,
  - Ansible output (the vault-loading and `.env`-templating tasks use `no_log: true`).
- Rotation source of truth is the vault (`vault_*` in
  `infra/ansible/group_vars/all.yml` overrides). Edit the vault, then deploy — do not hand-edit
  `.env` on the server (it is regenerated on the next deploy and is `ansible_managed`).

## 1. JWT access key — `JWT_ACCESS_SECRET`

**What it protects:** the signing/verification key for **access tokens** — short-lived JWTs
(`JWT_ACCESS_TTL`, default **900 s / 15 min**). Verified by `JwtStrategy`
(`apps/backend/src/auth/jwt.strategy.ts`, `ignoreExpiration: false`).

**There is no `JWT_REFRESH_SECRET.`** Refresh tokens are **opaque** random strings of the
shape `<id>.<secret>`; only an Argon2 hash of the secret is stored in the DB
(`AuthService.issueTokens`). Rotating `JWT_ACCESS_SECRET` therefore does **not** touch
refresh tokens.

**Effect of rotation:** every existing access token signed with the old key stops verifying
(401) as soon as the new key is live. Users do **not** get logged out: the frontend's
still-valid opaque refresh token hits `POST /auth/refresh`, which mints a new access token
signed with the new key. The transition is transparent within one access-token TTL.

**Procedure:**

```bash
# 1. Generate + store the new value in the vault.
openssl rand -base64 48        # -> vault_jwt_access_secret
ansible-vault edit infra/ansible/group_vars/all/vault.yml   # set vault_jwt_access_secret

# 2. Deploy. Preflight rejects a weak/duplicate value before anything restarts.
pnpm deploy:vps -e deployment_environment=production

# 3. Backend restarts with the new key; existing access tokens fail within <= 15 min
#    and clients silently re-mint via their refresh tokens.
```

**Verify (see §7 for the reusable snippet):** an access token issued *before* the deploy is
rejected with 401 after the deploy; a fresh login/refresh works.

## 2. Service API token — `SERVICE_API_TOKEN` (bot → backend)

**What it protects:** the static machine token the Telegram bot presents to the backend.
`ServiceTokenGuard` (`apps/backend/src/auth/service-token.guard.ts`) compares the
`x-service-token` request header against the **single** configured value — there is no
multi-token acceptance window in the current guard.

**Because it is a single-value comparison, do the rotation atomically:** update the backend
and the bot together in one deploy so the token they share is swapped in the same change.

```bash
# 1. New value in the vault (must differ from vault_jwt_access_secret).
openssl rand -base64 48        # -> vault_service_api_token
ansible-vault edit infra/ansible/group_vars/all/vault.yml

# 2. Deploy — both backend and bot get the new SERVICE_API_TOKEN from the same .env.
pnpm deploy:vps -e deployment_environment=production
```

There is a brief window during container recreate where the bot may retry until both sides
are on the new value; the bot's requests fail closed (401) until then, so no request is
served with a stale token.

> If you need a true zero-gap changeover, that requires a code change: extend the guard to
> accept a set `{ SERVICE_API_TOKEN, SERVICE_API_TOKEN_NEXT }`, deploy the backend with both,
> cut the bot over to the new value, then drop the old one in a second deploy. The template
> ships the single-token guard; the atomic co-deploy above is the supported path.

## 3. Database / Redis / OpenObserve credentials

These are server-side credentials shared between a server and its consumer. Rotate in the
order **update the consumer config → rotate the server credential → remove the old** so you
never have a window where the consumer holds a credential the server no longer accepts.

**PostgreSQL (`POSTGRES_PASSWORD` / `DATABASE_URL`):**

```bash
# 1. Choose the new password; update BOTH the DB user and the connection string in the vault.
openssl rand -base64 48        # -> new password
ansible-vault edit infra/ansible/group_vars/all/vault.yml
#   vault_postgres_password: <new>
#   vault_database_url: postgresql://app:<new>@postgres:5432/app   # must stay in sync

# 2. Rotate the credential on the server, then deploy so consumers pick up the new URL.
docker compose -f infra/docker/docker-compose.yml --env-file .env exec postgres \
  psql -U app -d app -c "ALTER ROLE app WITH PASSWORD '<new>';"
pnpm deploy:vps -e deployment_environment=production
```

The preflight asserts `vault_database_url` carries no `change-me` placeholder.

**Redis (`REDIS_URL` / optional `redis_password`):** update `vault_redis_url` (and
`redis_password` if used) — the preflight asserts they are consistent
(`redis://:<password>@redis:6379`) — then deploy. Rotate the Redis `requirepass` on the
server and deploy so the backend/bot reconnect with the new URL.

**OpenObserve (`ZO_ROOT_USER_PASSWORD`, observability profile):** update
`vault_openobserve_password`. The collector's `OPENOBSERVE_AUTH_HEADER` is **derived** from
`vault_openobserve_email:vault_openobserve_password` in `env.j2`, so it always matches — no
separate credential to keep in sync. Deploy to restart OpenObserve + collector together.

## 4. Telegram bot token — `TELEGRAM_BOT_TOKEN`

The bot token is a live BotFather credential. A real value is required or grammY's `getMe`
crash-loops on start.

```bash
# 1. Revoke + reissue at @BotFather:  /revoke  -> select bot  (issues a new token)
# 2. Store the new token in the vault.
ansible-vault edit infra/ansible/group_vars/all/vault.yml   # vault_telegram_bot_token
# 3. Controlled restart via deploy (preflight rejects the 000000:replace-with-botfather placeholder).
pnpm deploy:vps -e deployment_environment=production
```

Revoking at BotFather invalidates the old token immediately, so there is no overlap window —
the bot is unauthenticated until the new token is live, then reconnects.

## 5. Sentry DSN / OTLP endpoint + headers

`SENTRY_DSN`, `OTEL_EXPORTER_OTLP_ENDPOINT`, and `OTEL_EXPORTER_OTLP_HEADERS` (which may
carry an auth token). Update the corresponding vars (`vault_sentry_dsn`,
`otel_exporter_otlp_*`) and deploy. These flow through the same `no_log` vault/template path
— never echo the DSN or headers into logs or CI output.

## 6. Verified rotation drill — JWT access key AND service token

An operator who did not write the code can follow this to prove a rotation took effect.

**Preconditions:** you can reach the backend (`https://api.<your-domain>`), you have the
old + new values recorded, and a test user exists.

```bash
API=https://api.your-domain.com

# --- BEFORE the rotation: capture a live access token -----------------------
OLD_ACCESS=$(curl -fsS -X POST "$API/auth/login" \
  -H 'content-type: application/json' \
  -d '{"email":"you@your-domain.com","password":"<pw>"}' | jq -r .accessToken)

# Sanity: the old token works now.
curl -fsS "$API/auth/me" -H "authorization: Bearer $OLD_ACCESS" >/dev/null && echo "old token OK (pre-rotation)"

# --- Rotate JWT_ACCESS_SECRET (and/or SERVICE_API_TOKEN) via §1/§2, deploy ---
pnpm deploy:vps -e deployment_environment=production

# --- AFTER the rotation: confirm the OLD access token is rejected -----------
# (Wait > JWT_ACCESS_TTL, ~15 min, or just test immediately after restart.)
code=$(curl -s -o /dev/null -w '%{http_code}' "$API/auth/me" -H "authorization: Bearer $OLD_ACCESS")
[ "$code" = "401" ] && echo "OLD access token rejected (401) — JWT key rotation confirmed" || echo "UNEXPECTED: $code"

# Confirm a fresh login mints a working token under the NEW key.
NEW_ACCESS=$(curl -fsS -X POST "$API/auth/login" \
  -H 'content-type: application/json' \
  -d '{"email":"you@your-domain.com","password":"<pw>"}' | jq -r .accessToken)
curl -fsS "$API/auth/me" -H "authorization: Bearer $NEW_ACCESS" >/dev/null && echo "new token OK — rotation live"
```

**Confirm the OLD service token is rejected** (run against any `ServiceTokenGuard`-protected
route your app exposes; substitute the real path):

```bash
# Old service token must now 401.
code=$(curl -s -o /dev/null -w '%{http_code}' "$API/<service-route>" -H "x-service-token: <OLD_SERVICE_TOKEN>")
[ "$code" = "401" ] && echo "OLD service token rejected (401)" || echo "UNEXPECTED: $code"

# New service token must be accepted.
curl -fsS "$API/<service-route>" -H "x-service-token: <NEW_SERVICE_TOKEN>" >/dev/null && echo "new service token OK"

# And the bot is healthy again (it uses the new token internally):
docker compose -f infra/docker/docker-compose.yml --env-file .env logs --tail=20 telegram-bot
```

## 7. If a secret leaked

Treat a leaked secret as an incident: rotate the affected value immediately per the relevant
section above (target: revoke/rotate within ~1 hour). A leaked credential that reached a
running deploy is also a supply-chain concern — see
[`VULNERABILITY_RESPONSE.md`](./VULNERABILITY_RESPONSE.md). The `gitleaks` gate
(`.gitleaks.toml`) blocks new credential-shaped strings from entering the repo in the first
place.

## 8. Related

- Admin bootstrap secret (`SEED_ADMIN_PASSWORD`): [`ADMIN_BOOTSTRAP.md`](./ADMIN_BOOTSTRAP.md)
- Security overview: [`../SECURITY.md`](../SECURITY.md)
- Rollback (re-deploy a previous release's digests): [`ROLLBACK.md`](./ROLLBACK.md)
