# Quickstart: from template to your project

This template is verified working end-to-end — build, unit + e2e tests, the Docker Compose stack,
the Ansible deploy, and CI all run green. To turn it into a real project you fill in **three
placeholders**; everything else already works.

## 0. Run it locally (~2 min)

Full version in the [README quick start](../README.md#quick-start). Short version:

```bash
corepack enable
pnpm install
cp .env.example .env          # JWT_ACCESS_SECRET / JWT_REFRESH_SECRET must be >= 16 chars
pnpm docker:up                # local postgres + redis
pnpm db:generate && pnpm db:migrate:dev && pnpm db:seed
pnpm dev
```

Backend http://localhost:3000 (Swagger at `/docs`) · Frontend http://localhost:5173 ·
Health http://localhost:3000/health/ready.

## Make it yours — 3 fill-in steps

### 1. Point it at your own git remote

The repo ships with **no remote** and a placeholder `repo_url`. The Ansible deploy clones from that
URL onto the VPS, so it must be real.

```bash
git remote add origin git@github.com:<you>/<repo>.git
git push -u origin main
```

Then set `repo_url` (and `repo_version`) in `infra/ansible/group_vars/all.yml`.

### 2. Provide real secrets (Ansible Vault)

`group_vars/all.yml` holds `vault_*: change-me` placeholders so the playbook still parses and
dry-runs. A real deploy **must** override them from an encrypted vault — never commit a real `.env`
or real secrets.

```bash
ansible-vault create infra/ansible/group_vars/all/vault.yml
# set real: vault_postgres_password, vault_database_url,
#           vault_jwt_access_secret / vault_jwt_refresh_secret (>= 16 chars, use long random),
#           vault_service_api_token, vault_telegram_bot_token, vault_redis_url, ...
```

The playbook auto-loads `group_vars/all/vault.yml` if present. Deploy with the vault password
(`--ask-vault-pass` or `--vault-password-file`). Also review the non-secret domains in `all.yml`:
`cors_origin`, `cookie_domain`, `vite_api_url` (baked into the frontend bundle at build time),
`backend_url`.

### 3. Give the Telegram bot a real token

With the placeholder token the bot crash-loops (grammY `getMe` rejects). Get a token from
[@BotFather](https://t.me/BotFather) and set `vault_telegram_bot_token`. If you don't need the bot,
remove the `telegram-bot` service from `infra/docker/docker-compose.yml`.

## Deploy

```bash
pnpm deploy:vps -- --ask-vault-pass
```

The playbook is idempotent: clone the repo → render `.env` (0600, root-owned) →
`docker compose build` → start postgres/redis → `zen migrate deploy` → bring the full stack up.

Smoke-test the exact Compose stack locally first (no VPS needed):

```bash
docker compose --env-file .env -f infra/docker/docker-compose.yml up -d --build
curl localhost:3000/health/ready      # -> 200
```

> `--env-file .env` is required — Compose resolves `${VAR}` from the compose file's directory, not
> the repo root. Omitting it silently falls back to the `change-me` defaults. See `AGENTS.md`.

## CI

`.github/workflows/ci.yml` runs on push to `main` and on PRs: checkout → pnpm (corepack) → Node 22 →
install → `db:generate` → typecheck → lint → unit tests → build → backend e2e (with a Postgres
service). It's plain GitHub Actions — push to GitHub and it runs, no extra setup.

**Self-hosted / local runners** (Gitea `act_runner`, nektos `act`) run the job *inside a container*,
so the Postgres service is reachable by name, not `localhost`. Set an Actions variable
`E2E_DB_HOST=postgres` there — the workflow defaults to `localhost` for GitHub-hosted runners.
