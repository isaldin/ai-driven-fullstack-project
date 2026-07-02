# AI-Ready Monorepo Template

A reusable, AI-ready full-stack template that an agent (Claude Code / Codex) or a human can open and
immediately understand: clear package boundaries, predictable scripts, and installed skills.

**Stack:** Vue 3 (PrimeVue + Tailwind) · NestJS 11 · Telegram bot (grammY) · PostgreSQL via
**ZenStack v3** · pnpm + Turborepo (ESM) · Biome · Vitest · OpenTelemetry · Docker Compose + Ansible.

See [`AGENTS.md`](./AGENTS.md) for the agent/developer guide and [the design spec](./docs/superpowers/specs/2026-07-02-ai-ready-monorepo-template-design.md) for rationale.
New here? **[`docs/QUICKSTART.md`](./docs/QUICKSTART.md)** covers local dev plus the three steps to turn this template into your own project (git remote, vault secrets, bot token).

## Quick start

```bash
# 0. prerequisites: Node 20+ (22 recommended), Docker, pnpm via corepack
corepack enable

# 1. install
pnpm install

# 2. configure
cp .env.example .env        # edit secrets; JWT_* must be >= 16 chars

# 3. local infrastructure (Postgres + Redis)
pnpm docker:up

# 4. database
pnpm db:generate            # generate the ZenStack client
pnpm db:migrate:dev         # create & apply the initial migration
pnpm db:seed                # optional: seed admin@example.com / admin12345

# 5. run everything
pnpm dev
```

- Backend API: http://localhost:3000 — Swagger at http://localhost:3000/docs
- Frontend: http://localhost:5173
- Health: http://localhost:3000/health/ready

## Layout

| Path | What |
| --- | --- |
| `apps/backend` | NestJS API — auth (JWT + refresh cookie), users, health, ZenStack schema |
| `apps/frontend` | Vue 3 SPA — login + dashboard shell |
| `apps/telegram-bot` | grammY long-polling bot (talks to backend over REST) |
| `packages/*` | shared config, contracts, observability, api-client, tsconfig |
| `infra/docker` | Dockerfiles + `docker-compose.yml` |
| `infra/ansible` | VPS deploy playbooks |

## Common tasks

```bash
pnpm build        # build all apps + packages
pnpm test         # unit tests
pnpm --filter @app/backend test:e2e   # backend e2e (against a real Postgres)
pnpm typecheck    # tsc / vue-tsc
pnpm lint         # biome
pnpm format       # biome --write
```

## Deployment

Docker Compose on a VPS, automated with Ansible. Optional self-hosted observability (OpenObserve) ships
as an off-by-default Compose profile.

```bash
docker compose --env-file .env -f infra/docker/docker-compose.yml up -d          # base stack
docker compose --env-file .env -f infra/docker/docker-compose.yml --profile observability up -d   # + OpenObserve
pnpm deploy:vps                                                   # Ansible deploy (renders .env, passes --env-file)
```

Manage secrets with Ansible Vault or SOPS — never commit a real `.env`.

## AI skills

```bash
pnpm skills:install   # installs ZenStack v3 / NestJS / bot / DevOps skills via `npx skills`
```

## Notes

- **ESM everywhere** — relative imports use `.js` extensions (NodeNext).
- **ZenStack v3** replaces the Prisma runtime ORM; Prisma Migrate is retained under the hood for
  migrations only. Generated client files are gitignored — run `pnpm db:generate`.
- The default auth is local (no external identity provider).
