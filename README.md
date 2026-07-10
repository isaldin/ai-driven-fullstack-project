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

Docker Compose on a VPS, automated with Ansible. Optional self-hosted observability (OpenTelemetry
Collector + OpenObserve) ships as an off-by-default Compose profile, with opt-in browser tracing that
makes a click → API → DB query one end-to-end trace — 5xx exceptions are recorded on their span and
frontend errors can go to Sentry (opt-in) tagged with the trace id, so the trace is the hub for
debugging failures. See [`docs/OBSERVABILITY.md`](./docs/OBSERVABILITY.md) for what runs by default, how
to enable traces/metrics/logs with correlation, how to read it in OpenObserve, sampling/alerts, and how
to switch backends.

```bash
# Local full-stack smoke test — NO --env-file. Compose's in-network defaults wire the services by name
# (postgres/redis/otel-collector) and use throwaway change-me secrets — what a local run wants. Passing
# --env-file .env here injects the host-oriented root .env (DATABASE_URL=…@localhost) and the backend
# crash-loops looking for Postgres inside its own container.
docker compose -f infra/docker/docker-compose.yml up -d                                  # base stack
OTEL_SDK_DISABLED=false docker compose -f infra/docker/docker-compose.yml --profile observability up -d   # + OpenObserve

# Production — Ansible renders a container-oriented .env (service-name hosts + real vault secrets) and
# passes --env-file. Don't hand-run raw compose against a public host.
pnpm deploy:vps
```

Manage secrets with Ansible Vault or SOPS — never commit a real `.env`. The repo-root `.env` /
`.env.example` is **host-oriented** (for `pnpm dev`); the container stack gets its in-network hosts from
Compose defaults locally, and from the Ansible-rendered `.env` in production.

## AI skills

```bash
pnpm skills:install   # installs ZenStack v3 / NestJS / bot / DevOps skills via `npx skills`
```

## Notes

- **ESM everywhere** — relative imports use `.js` extensions (NodeNext).
- **ZenStack v3** replaces the Prisma runtime ORM; Prisma Migrate is retained under the hood for
  migrations only. Generated client files are gitignored — run `pnpm db:generate`.
- The default auth is local (no external identity provider).
