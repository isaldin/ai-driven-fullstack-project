# Quickstart: from template to your project

This template is verified working end-to-end — build, unit + e2e tests, the Docker Compose stack,
the Ansible deploy, and CI all run green. To turn it into a real project you fill in **three
placeholders**; everything else already works.

## 0. Run it locally (~2 min)

Full version in the [README quick start](../README.md#quick-start). Short version:

```bash
corepack enable
pnpm install
cp .env.example .env          # JWT_ACCESS_SECRET / SERVICE_API_TOKEN >= 16 chars (dev); >= 32 in prod
pnpm docker:up                # local postgres + redis
pnpm db:generate && pnpm db:migrate:dev
SEED_ADMIN_EMAIL=admin@yourco.dev SEED_ADMIN_PASSWORD='<12+ chars>' pnpm bootstrap-admin  # first admin (no defaults)
pnpm dev
```

Backend http://localhost:3000 (Swagger at `/docs`) · Frontend http://localhost:5173 ·
Health http://localhost:3000/health/ready.

## Make it yours — 3 fill-in steps

### 1. Point it at your own git remote

The repo ships with **no remote**. Push it to your own GitHub repo so Actions can run CI and the
release pipeline — `release.yml` builds each image, cosign-signs it, and pushes it **by digest** to
*your* GHCR. The VPS never clones or builds; it pulls those signed digests (see [Deploy](#deploy)).

```bash
git remote add origin git@github.com:<you>/<repo>.git
git push -u origin main
```

Then, in `infra/ansible/group_vars/all.yml`, set the values tied to your repo: `registry`
(`ghcr.io/<you>/<repo>`) and `cosign_identity_regexp` (must match your `release.yml` OIDC identity).
The per-release `repo_version` (the release tag) and the `*_image` `…@sha256:…` digests are supplied
at deploy time from the release manifest — see [Deploy](#deploy).

### 2. Provide real secrets (Ansible Vault)

`group_vars/all.yml` holds `vault_*: change-me` placeholders so the playbook still parses and
dry-runs. A real deploy **must** override them from an encrypted vault — never commit a real `.env`
or real secrets.

```bash
ansible-vault create infra/ansible/group_vars/all/vault.yml
# set real: vault_postgres_password, vault_database_url,
#           vault_jwt_access_secret (>= 32 random chars — `openssl rand -base64 48`),
#           vault_service_api_token (>= 32 random chars, distinct from the JWT secret),
#           vault_telegram_bot_token, vault_redis_url, ...
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

A production deploy runs **immutable image digests**, so cut a release first:

```bash
git tag v0.1.0 && git push origin v0.1.0   # release.yml: build → cosign-sign → push digests to GHCR + manifest
```

Copy that release's `repo_version` tag and its `backend_image` / `frontend_image` / `bot_image`
`…@sha256:…` digests into `group_vars/all.yml` (or pass them with `-e`), then deploy:

```bash
pnpm deploy:vps -- -e deployment_environment=production --ask-vault-pass
```

The playbook is idempotent and **never clones or builds on the VPS**: production preflight (rejects
placeholders / moving branches / non-digest images) → copy compose + config to the host → render
`.env` (0600, root-owned) → cosign-verify the digests → `docker compose pull` them → start
postgres/redis → `zen migrate deploy` → bring the full stack up → readiness check → write the release
manifest. Rollback = `pnpm deploy:rollback` with the previous release's tag + digests.

Sanity-check the full stack locally first (no VPS, no release needed). Use the **dev overlay** — it
builds the images locally and runs as `NODE_ENV=development` so `@app/config`'s production checks
don't fire:

```bash
pnpm docker:dev                        # base + dev overlay: build, republish host ports, dev mode
curl localhost:3000/health/ready       # -> 200
```

> Don't run the bare production base (`-f docker-compose.yml` alone) with your dev `.env`: it boots as
> `NODE_ENV=production` and `@app/config` fails fast on the placeholder secrets / non-HTTPS origins.
> The hardened base is validated in CI (e2e + image scan) and by the Ansible preflight — not by a
> casual local run. See `AGENTS.md`.

## CI

`.github/workflows/ci.yml` runs on push to `main` and on PRs: checkout → pnpm (corepack) → Node 22 →
install → `db:generate` → typecheck → lint → unit tests → build → backend e2e (with a Postgres
service). It's plain GitHub Actions — push to GitHub and it runs, no extra setup.

**Self-hosted / local runners** (Gitea `act_runner`, nektos `act`) run the job *inside a container*,
so the Postgres service is reachable by name, not `localhost`. Set an Actions variable
`E2E_DB_HOST=postgres` there — the workflow defaults to `localhost` for GitHub-hosted runners.
