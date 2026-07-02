# AGENTS.md

Source of truth for AI agents (Claude Code, Codex, etc.) and humans working in this repo.
`CLAUDE.md` simply includes this file.

## What this is

An AI-ready full-stack monorepo template: Vue frontend, NestJS backend, a separate
Telegram bot, PostgreSQL via ZenStack v3, deployable to a VPS with Docker Compose + Ansible.

## Stack

- **Monorepo**: pnpm workspaces + Turborepo. **ESM everywhere.** Node 20+ (repo pins 22), TypeScript 5.9.
- **Backend** (`apps/backend`): NestJS 11, Passport JWT + Argon2 auth, REST/OpenAPI (Swagger at `/docs`).
- **Data layer**: ZenStack v3 (`@zenstackhq/orm`, Kysely engine + `pg`) — no Prisma runtime client.
  Schema is `apps/backend/src/zenstack/schema.zmodel` (ZModel). Migrations wrap Prisma Migrate under the hood.
- **Frontend** (`apps/frontend`): Vue 3 + Vite, PrimeVue v4 + Tailwind v4 (`tailwindcss-primeui`),
  Pinia, Vue Router, TanStack Query (Vue).
- **Telegram bot** (`apps/telegram-bot`): grammY, long polling, Redis session store. Talks to the
  backend over REST with a static service token — it never touches the database directly.
- **Shared packages**: `@app/config` (Zod env), `@app/contracts` (Zod schemas/types),
  `@app/observability` (Pino + OpenTelemetry), `@app/api-client` (typed REST client), `@app/tsconfig`.
- **Tooling**: Biome (format + lint), `tsc`/`vue-tsc` (types), Vitest (tests, unit + e2e).
- **Observability**: Pino logs, OpenTelemetry traces/metrics over OTLP, `@nestjs/terminus` health.
  Default optional backend is OpenObserve (Compose `observability` profile, off by default). OTel is off
  unless `OTEL_EXPORTER_OTLP_ENDPOINT` is set and `OTEL_SDK_DISABLED=false`.

## Structure

```
apps/
  backend/        NestJS API (auth, users, health) + ZenStack schema
  frontend/       Vue 3 SPA (login + dashboard shell)
  telegram-bot/   grammY long-polling service
packages/
  config/         typed env loading + validation (Zod)
  contracts/      shared Zod schemas & types
  observability/  Pino logger + OpenTelemetry setup
  api-client/     typed REST client (frontend + bot)
  tsconfig/       shared TS base config
infra/
  docker/         Dockerfiles + docker-compose.yml
  ansible/        VPS deploy playbooks
scripts/          install-skills.sh
docs/             QUICKSTART.md (template -> your project) + design spec
```

## Commands (run from repo root)

```bash
pnpm install            # install (corepack provides pnpm 11)
pnpm db:generate        # zen generate — REQUIRED before typecheck/build/test (Turbo does this automatically)
pnpm dev                # run all dev servers
pnpm build              # build everything (turbo)
pnpm typecheck          # tsc / vue-tsc across the repo
pnpm lint               # biome check
pnpm format             # biome format --write
pnpm test               # unit tests (all workspaces)
pnpm --filter @app/backend test:e2e   # backend e2e (needs a Postgres; auto-creates & pushes the schema)
pnpm db:migrate:dev     # create+apply a dev migration
pnpm db:seed            # seed an admin user (admin@example.com / admin12345)
pnpm docker:up          # start local postgres + redis
pnpm deploy:vps         # ansible deploy to a VPS
pnpm skills:install     # install the agent skills
```

Local prerequisites: a running Postgres reachable via `DATABASE_URL` (use `pnpm docker:up`).
Copy `.env.example` to `.env` first.

## Architectural rules

- **REST/OpenAPI (hand-written NestJS controllers) is the durable external contract** — used by the
  Telegram bot, external/mobile clients, and public docs. Keep it curated and stable.
- **ZenStack auto-CRUD (RPC + TanStack Query hooks) is an optional first-party frontend layer only.**
  It must not replace the REST contract, and any exposed surface must be sliced so it never leaks
  fields/operations the frontend shouldn't reach. `passwordHash` is never exposed by any DTO.
- **The Telegram bot goes through REST with the service token. It must not import the ZenStack client
  or hit the DB directly.**
- Trusted NestJS services use the ZenStack client directly; the controllers/guards are the security
  boundary. Row/field access policies (`@@allow`/`@@deny` + `@zenstackhq/plugin-policy`) can be added
  later — they are not enabled by default.
- **ESM discipline**: relative imports use explicit `.js` extensions (NodeNext). Backend/bot build with
  `tsc` (emits decorator metadata); tests use Vitest + `unplugin-swc`.
- Env is validated by `@app/config` (Zod) and fails fast. Add new vars there and in `.env.example`.

## Data layer / migrations

- Edit `apps/backend/src/zenstack/schema.zmodel`, then `pnpm db:generate` (regenerates the typed client).
- `zen migrate dev` (dev) / `zen migrate deploy` (pipeline) / `zen db push` (prototyping, no history).
- The generated client files (`src/zenstack/{schema,models,input}.ts`) are gitignored — regenerate them.

## Testing

- Vitest across the repo. Backend unit tests are `src/**/*.spec.ts`; e2e is `test/**/*.e2e-spec.ts`
  and runs the real Nest app against a real Postgres (a dedicated `app_e2e` DB it creates and pushes).
- Policy/e2e tests must run against a real Postgres, not mocks.

## Deploy & CI — operational invariants (verified; easy to break)

These were verified end-to-end (live Compose deploy on a simulated VPS + a green CI run on a
GitHub-Actions-compatible runner). Keep them intact:

- **Compose requires `--env-file .env` explicitly.** `docker compose` resolves `${VAR}` interpolation
  (published ports, `environment:` secrets, the frontend `VITE_API_URL` build arg) from the compose
  file's own directory (`infra/docker/`), NOT the repo root. Without `--env-file .env` the rendered
  root `.env` is ignored and the stack silently falls back to the `change-me` defaults. The Ansible
  deploy (`infra/ansible/deploy.yml`) and the README/Compose commands already pass it — never drop it.
- **`BACKEND_PORT` maps host→container `3000`** (`"${BACKEND_PORT:-3000}:3000"`) and the app listens on
  `BACKEND_PORT` inside the container. Only `3000` keeps the published and listen ports aligned; you can
  remap the postgres/redis/frontend host ports freely, but leave backend at `3000` (or change both sides).
- **Migrations are committed; the generated client is not.** `apps/backend/src/zenstack/migrations/` is
  tracked — a real deploy runs `zen migrate deploy` off it, and without it the prod DB gets no tables.
  Only `src/zenstack/{schema,models,input}.ts` + `~schema.prisma` are gitignored. Do not gitignore the
  migrations dir; do commit a new migration after `pnpm db:migrate:dev`.
- **CI e2e DB host differs by runner type.** GitHub-hosted: the job runs on the VM, Postgres service on
  `localhost:5432`. Container runners (Gitea `act_runner` / nektos `act`): the job runs in a container,
  service reachable as `postgres:5432`. `.github/workflows/ci.yml` uses `${{ vars.E2E_DB_HOST || 'localhost' }}`
  — set the `E2E_DB_HOST=postgres` Actions variable on self-hosted runners.
- **The bot needs a real `TELEGRAM_BOT_TOKEN`** or it crash-loops (grammY `getMe`). The placeholder is
  fine for build/typecheck/deploy dry-runs, not for a running stack.

New-project fill-in steps (remote, vault secrets, bot token): see [`docs/QUICKSTART.md`](./docs/QUICKSTART.md).

## Code style

- Biome formatting (2-space, single quotes, semicolons, trailing commas, width 100).
- TypeScript strict; **no `any`**, no TODO comments for core logic, no stubbed implementations.
- `.vue` files: Biome's `noUnusedVariables` is disabled (template-only vars); `vue-tsc` covers typing.

## Skills

Run `pnpm skills:install` (or `bash scripts/install-skills.sh`) to install the agent skills for this
stack (ZenStack v3, NestJS, Node backend, Telegram bot, DevOps/Ansible, architecture). See the script
for the exact list.
