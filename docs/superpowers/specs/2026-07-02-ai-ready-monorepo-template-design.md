# AI-Ready Monorepo Template Design

Date: 2026-07-02

Revision 1 (2026-07-02): data layer switched from Prisma to **ZenStack v3**. The Prisma runtime ORM/client is removed (engine is now Kysely + `pg`); Prisma Migrate is retained only under the hood as ZenStack's migration engine. tRPC is superseded by ZenStack auto-CRUD (RPC) plus generated TanStack Query hooks. See "Data Layer (ZenStack v3)".

Revision 2 (2026-07-02): resolved cross-cutting decisions after a docs-backed research pass — ESM across the monorepo, a minimal GitHub Actions gate, static service-token auth for the Telegram bot, and TanStack Query (Vue) as the frontend data layer for ZenStack hooks. Added toolchain pinning, the Turborepo codegen pipeline, the official NestJS integration recipe, `turbo prune` Docker builds, and an environment contract.

Revision 3 (2026-07-02): added an Observability layer. `packages/logger` is folded into a single `packages/observability` package covering Pino logging, OpenTelemetry traces/metrics, `@nestjs/terminus` health checks, and optional Sentry error tracking — vendor-neutral (OTLP/Prometheus), with heavier pieces optional and off by default. See "Observability".

Revision 4 (2026-07-02): after a docs-backed comparison, the default (optional) observability backend is **OpenObserve** — a lightweight, single-binary, OTLP-native all-in-one for metrics, traces, and logs with its own UI. Because the app emits only OTLP, the backend is swappable; SigNoz, Grafana + Prometheus, and hosted (Grafana Cloud / SigNoz Cloud) are documented alternatives.

## Goal

Create a reusable AI-ready monorepo template for product projects that can be opened by Codex or Claude and immediately understood through project instructions, installed skills, clear package boundaries, and predictable scripts.

The template should support a modern full-stack setup:

- Vue frontend.
- NestJS backend.
- Separate Telegram bot service.
- PostgreSQL persistence through ZenStack v3 (Kysely-based ORM with a Prisma-compatible API; no Prisma runtime client).
- Docker Compose deployment to a VPS, automated through Ansible.
- AI agent instructions through `AGENTS.md` and `CLAUDE.md`.
- One-command skill installation.

## Monorepo Stack

Use `pnpm workspaces` with Turborepo.

Rationale:

- Simple enough for AI agents to understand quickly.
- Works well with `apps/*` and `packages/*`.
- Avoids heavier Nx-specific concepts for a starter template.
- Still supports cached `build`, `test`, `lint`, and `typecheck` tasks.

Initial structure:

```text
apps/
  backend/
  frontend/
  telegram-bot/
packages/
  api-client/
  config/
  contracts/
  observability/
  tooling/
  tsconfig/
infra/
  ansible/
  docker/
scripts/
docs/
```

### Module system and toolchain

- **ESM across the whole monorepo** (`"type": "module"` in every package). This aligns with Vite, ZenStack v3, grammY, and the NestJS v12 direction. On the current stable NestJS v11 (CJS-oriented) the backend needs care: emit-friendly `tsconfig`, and `unplugin-swc` for Vitest so decorator metadata survives (see Tooling). Migrating the backend to native ESM becomes trivial once it moves to NestJS v12.
- **Pin the toolchain** so a fresh clone is reproducible: Node 20+ via `.nvmrc` and `engines`, pnpm via the root `packageManager` field (Corepack), TypeScript 5.8+.

### Turborepo pipeline

ZenStack code generation is a hard prerequisite for type checking and building, so it must be sequenced in `turbo.json`:

- `db:generate` (runs `zen generate`) is a `dependsOn` of `build`, `typecheck`, and `dev`.
- `build` also depends on `^build`; declare `outputs` for cache correctness.
- `dev` is `persistent: true` and uncached but still depends on `db:generate`.

This guarantees an agent or CI can clone and run `turbo run build`/`typecheck` without a missing-generated-types failure.

## Backend

`apps/backend` is a NestJS API application.

Core stack:

- NestJS.
- ZenStack v3 (data/ORM + access-control layer).
- PostgreSQL (via the `pg` driver used by ZenStack's engine).
- Passport JWT.
- Argon2.
- REST controllers with Swagger/OpenAPI as the curated external contract.
- Optional ZenStack auto-CRUD (RPC handler + generated TanStack Query hooks) for first-party frontend calls.
- Zod validation, with model schemas generated from ZModel by ZenStack.

The backend should follow clean DDD/hexagonal principles where they create useful boundaries, without adding excessive ceremony to early-stage product code. Note the tension with ZenStack: plain CRUD should go straight through the ZenStack client rather than a hand-rolled repository/infrastructure layer; reserve the hexagonal structure for genuine domain logic (workflows, side effects, integrations).

Recommended internal module shape:

```text
src/modules/<feature>/
  application/
  domain/
  infrastructure/
  presentation/
```

REST/OpenAPI (hand-written NestJS controllers) is the stable public and cross-service API contract. It should be used for:

- External integrations.
- Telegram bot to backend communication.
- Mobile clients.
- Public documentation.
- Stable service boundaries.

ZenStack's auto-generated CRUD (an RPC handler plus generated TanStack Query hooks) is an optional first-party developer-experience layer for `apps/frontend` only. It replaces the role tRPC held in earlier drafts: end-to-end TypeScript inference derived from the ZModel schema without hand-written client code. It must not replace REST/OpenAPI as the durable external contract, and its auto-CRUD surface must be sliced/omitted (`queryOptions`) so it never exposes fields or operations the frontend should not reach.

## Data Layer (ZenStack v3)

The data and authorization layer is ZenStack v3, replacing a direct Prisma setup.

- Schema is written in ZModel (`apps/backend/zenstack/schema.zmodel`), a superset of the Prisma schema language.
- The runtime ORM is ZenStack's own Kysely-based engine (`@zenstackhq/orm`) talking to PostgreSQL through the `pg` driver. There is no `@prisma/client` at runtime.
- Row/field access control lives in the schema via the policy plugin (`@zenstackhq/plugin-policy`) and is enforced at runtime by a per-request, policy-enhanced client (`$setAuth`) used inside NestJS services.
- `zen generate` derives the typed client, Zod model schemas, and the Vue TanStack Query hooks from ZModel. Because the client is schema-derived and standalone, the frontend does not import backend app types (this avoids the app→package type-coupling that a shared tRPC `AppRouter` type would have required).

Packages:

- Runtime: `@zenstackhq/schema`, `@zenstackhq/orm`, `pg`.
- Dev: `@zenstackhq/cli` (CLI is `zen`, alias `zenstack`).
- Optional: `@zenstackhq/plugin-policy` (access control), `@zenstackhq/server` (auto-CRUD handlers/adapters), `@zenstackhq/tanstack-query` (frontend hooks).

Toolchain floor required by v3: **Node 20+ and TypeScript 5.8+**.

### Migrations — honest caveat

Migrations still run on **Prisma Migrate under the hood**: `zen migrate` generates a Prisma schema from ZModel and wraps the matching Prisma command, so `@zenstackhq/cli` keeps `prisma` as a transitive CLI/dev dependency. The Prisma *ORM/client is removed*, but the Prisma *migration engine remains* (invisible, wrapped by `zen`). Commands:

- `zen migrate dev --name <n>` — create and apply a migration in development.
- `zen migrate deploy` — idempotent, non-interactive; the command for the deploy pipeline.
- `zen migrate status` — inspect applied vs. pending (useful in CI before deploy).
- `zen db push` — prototyping only, syncs the DB with no migration file; never in production.

Migration history lives under `apps/backend/zenstack/migrations`.

### NestJS integration (official recipe)

ZenStack v3's first-class server adapters are Express, Fastify, Next.js, Nuxt, SvelteKit, Hono, Elysia, and TanStack Start — there is **no dedicated `nestjs` adapter in v3**. The template follows the official ZenStack NestJS recipe (`zenstack.dev/docs/recipe/nestjs`):

1. Default: use the policy-enhanced ORM client directly inside NestJS services and keep hand-written controllers as the curated REST/OpenAPI contract. This preserves the external-contract principle.
2. Optional first-party auto-CRUD: a single catch-all controller forwards to a ZenStack API handler:

   ```ts
   @Controller('api')
   export class ZenStackController {
     private readonly apiHandler = new RestApiHandler({ schema, endpoint: '/api' });

     @All('/*path')
     async handleAll(@Req() req, @Res() res, @Param('path') path: string[], @Query() query) {
       const result = await this.apiHandler.handleRequest({
         method: req.method,
         path: path.join('/'),
         query,
         requestBody: req.body,
         client: this.requestScopedEnhancedClient, // policy-enforced per request
       });
       res.status(result.status).json(result.body);
     }
   }
   ```

## Authentication

The template includes production-oriented local authentication.

Backend auth includes:

- `AuthModule`.
- `UsersModule`.
- Access JWT.
- Refresh token stored through an HttpOnly cookie.
- Refresh token persistence through ZenStack (a ZModel model).
- Argon2 password hashing.
- Guards and current-user decorators.
- Role enum with at least `USER` and `ADMIN`.
- A `SERVICE` role (or equivalent scope) for machine callers such as the Telegram bot.

Because the SPA frontend and the API may run on different origins, the auth setup must document CORS with credentials and the refresh cookie's `SameSite`/`Secure` attributes — a common cross-origin footgun.

Frontend auth includes:

- Login screen shell.
- Pinia auth store.
- `me`, `login`, `logout`, and `refresh` flows.
- Vue Router guards.
- Authenticated application layout.

The default auth system should stay local to the project. External auth providers can be added later, but the template should not depend on Keycloak, Supabase Auth, Auth.js, or any SaaS identity provider by default.

## Frontend

`apps/frontend` is a Vue application.

Core stack:

- Vue 3.
- Vite.
- TypeScript.
- PrimeVue (v4) as the main UI component system.
- Tailwind CSS (v4) for layout and low-level styling, integrated with PrimeVue through the official `tailwindcss-primeui` plugin (avoids style/layer conflicts).
- Pinia.
- Vue Router.
- TanStack Query (Vue) as the data-fetching/cache layer, consumed through ZenStack's generated hooks (`@zenstackhq/tanstack-query/vue`, `useClientQueries(schema)`).

The frontend should start as an application shell, not a marketing landing page.

Initial UI surfaces:

- Login page.
- Authenticated app layout.
- Dashboard page.
- Basic error/loading states.
- API client integration (REST client for the curated backend API plus ZenStack-generated TanStack Query hooks for first-party CRUD).

PrimeVue is the only primary UI kit. Do not add shadcn-vue by default.

## Telegram Bot

`apps/telegram-bot` is a separate Node service using grammY.

Core expectations:

- grammY bot instance.
- Command and middleware structure.
- **Long polling by default** — the natural fit for a long-running service in Docker Compose on a VPS (no public HTTPS ingress required for the bot). Webhook mode is an opt-in alternative if a project already terminates HTTPS for the bot.
- Session/state through the grammY session plugin with a **Redis storage adapter** (uses the compose `redis` service).
- Shared env/config validation from `packages/config`.
- Shared logger and telemetry from `packages/observability`.
- Graceful shutdown via `SIGINT`/`SIGTERM` → `bot.stop()`.
- Backend communication through the REST/OpenAPI client, authenticated with a **static service token (machine API key)** sent in a header; the backend validates it and maps it to the `SERVICE` role. The token is stored via Ansible Vault/SOPS, never committed.

The Telegram bot should not read or write the backend database directly by default, and must not import the ZenStack client. Keeping communication through the hand-written REST contract preserves service boundaries and makes the bot replaceable.

## Shared Packages

`packages/contracts` contains shared schemas and types.

Model-level Zod schemas are generated from ZModel by ZenStack; hand-written Zod covers non-model transport payloads (e.g. auth requests, bot webhooks). Contracts should still avoid coupling domain entities directly to transport payloads.

`packages/api-client` contains clients for frontend and bot use:

- REST client for the stable, hand-written backend APIs (used by the Telegram bot and external/mobile clients).
- ZenStack's generated Vue TanStack Query hooks for frontend-only first-party CRUD (replaces the former tRPC client).

`packages/config` contains typed environment loading and validation helpers (Zod), and owns the environment contract below.

`packages/observability` is the cross-cutting telemetry package (it replaces `packages/logger`): Pino logging, OpenTelemetry tracing/metrics initialization, health-check helpers, and shared service-identity/correlation conventions for the backend and bot. See "Observability".

`packages/tooling` and `packages/tsconfig` provide shared tooling configuration.

## Tooling

Use Biome as the primary formatter and linter.

Tooling responsibilities:

- Biome formats the repository.
- Biome handles the default lint rules for JavaScript, TypeScript, JSON, and supported frontend files.
- TypeScript compiler checks backend, bot, shared packages, and build-time type safety.
- `vue-tsc` checks Vue single-file component typing.
- Vitest is the default test runner for apps and shared packages.
- Framework-specific lint plugins should not be added by default unless Biome cannot cover an important project rule.

Do not add Prettier by default. Do not add a full ESLint stack by default. If a future project needs framework-specific rules that Biome does not support well enough, add ESLint narrowly and document why.

Known caveats to encode in config:

- Biome's `.vue` support is usable (v2.3+) but experimental: in `<script setup>`, variables used only in the template are falsely flagged as unused because Biome only analyzes the script block. Disable `noUnusedVariables` for `.vue` and rely on `vue-tsc` for that class of check.
- NestJS on the current stable v11 needs `unplugin-swc` for Vitest so decorator metadata (`emitDecoratorMetadata`) survives esbuild. This becomes native once the project moves to NestJS v12.

Expected shared config files:

- `biome.json`.
- `packages/tsconfig/base.json`.
- App-specific `tsconfig.json` files extending the shared base.

## Observability

`packages/observability` is the single cross-cutting telemetry package. It owns three pillars plus health, with starter-appropriate defaults: the standard, cheap pieces are on by default; heavier/self-hosted pieces are optional and off by default. Everything is vendor-neutral (OpenTelemetry/OTLP + Prometheus), so a project can send data to a local stack or any hosted backend without code changes.

### Logging (on by default)

- **Pino** structured JSON logging. The backend integrates through **`nestjs-pino`** (`LoggerModule.forRoot()`, then `app.useLogger(app.get(Logger))` with `bufferLogs: true`); request/correlation id is attached to every log line. `pino-pretty` transport in development only; raw JSON in production.
- The grammY bot (non-Nest) uses the same base Pino config exported from `packages/observability`, so log shape is uniform across services.
- `LOG_LEVEL` controls verbosity; service identity comes from the shared OTel resource (`OTEL_SERVICE_NAME`).

### Metrics and tracing via OpenTelemetry (vendor-neutral)

- A single `@opentelemetry/sdk-node` `NodeSDK`, initialized **before app modules load**, with `getNodeAutoInstrumentations()` from `@opentelemetry/auto-instrumentations-node` — this auto-instruments HTTP and the `pg` driver, so ZenStack queries are traced without manual spans. `service.name` is set via resource attributes.
- **Traces**: `OTLPTraceExporter` (`@opentelemetry/exporter-trace-otlp-proto`) → any OTLP collector (default `:4318`).
- **Metrics** — the default path is **OTLP push** (`OTLPMetricExporter` + `PeriodicExportingMetricReader`) to the same OTLP endpoint as traces and logs, so all three signals land in one backend. A **Prometheus pull** `/metrics` endpoint (`@opentelemetry/exporter-prometheus`) is available as an alternative for the Grafana + Prometheus path (`METRICS_EXPORTER=prometheus`). Note: Prometheus can also receive OTLP directly (`--web.enable-otlp-receiver`), but its own docs mark that as a low-volume, use-cautiously path rather than a scraping replacement.
- **Custom app metrics** via the OTel Meter API (counters/histograms) for domain events — logins, jobs processed, bot commands.
- **Log↔trace correlation**: OTel injects `trace_id`/`span_id` into Pino logs — the reason logging and tracing live in one package.
- Graceful `sdk.shutdown()` on `SIGTERM` in both backend and bot.
- All OTLP export is env-toggled (`OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_SDK_DISABLED`), so the template runs with no collector out of the box.

### Health checks (on by default)

- **`@nestjs/terminus`** exposes `/health/live` and `/health/ready`, including a custom database indicator that runs `SELECT 1` through the ZenStack/`pg` client. These endpoints back each service's Docker Compose `healthcheck` and the Ansible restart logic.

### Error tracking (optional, off by default)

- **Sentry** wiring is documented but stays disabled unless `SENTRY_DSN` is set: `@sentry/nestjs` (backend), `@sentry/vue` (frontend), `@sentry/node` plus grammY `bot.catch` (bot).

### Local stack and frontend

- **Backend — default (optional `observability` Compose profile, off by default): OpenObserve.** A single-binary, Rust, OTLP-native all-in-one that ingests metrics, traces, and logs and serves its own UI, storing data as Parquet on local disk or S3-compatible object storage. Chosen for the smallest footprint on a modest VPS and a clean match to our single-OTLP-endpoint emission. The profile is off by default so the base stack stays light; one flag brings it up.
- **Swappable alternatives** (the app only emits OTLP, so switching is code-free): **SigNoz** — heavier ClickHouse all-in-one with a richer APM/metrics UI (needs ~2–4 GB RAM); **Grafana + Prometheus** — composable and maximally familiar, add Tempo/Loki for traces/logs; **hosted** — Grafana Cloud or SigNoz Cloud free tier (just point `OTEL_EXPORTER_OTLP_ENDPOINT` at it and skip local infra).
- Frontend observability stays light: `web-vitals` reporting and optional Sentry browser SDK; no heavy client instrumentation by default.

## Continuous Integration

A minimal GitHub Actions gate ships with the template so agents and humans get a verification barrier without heavy platform integration.

- One workflow (`.github/workflows/ci.yml`) triggered on pull requests and pushes to the main branch.
- Steps: Corepack/pnpm setup → `pnpm install` → `zen generate` → `typecheck` → `lint` → `test` → `build`, driven through Turborepo (`turbo run ...`, using affected/`--filter` where practical).
- Keep it single-file and dependency-light; remote caching and richer pipelines are out of scope for the starter.

## Scripts

Root scripts should include:

- `dev`: run all development services.
- `build`: build all apps/packages.
- `test`: run all tests.
- `test:watch`: run tests in watch mode where supported.
- `lint`: lint all workspaces.
- `format`: format the repository.
- `typecheck`: typecheck all workspaces.
- `db:generate`: run `zen generate` to refresh the generated client, Zod schemas, and hooks.
- `db:migrate`: run ZenStack migrations (`zen migrate dev` locally, `zen migrate deploy` in the pipeline).
- `db:seed`: seed local development data.
- `docker:up`: start local Docker dependencies.
- `docker:down`: stop local Docker dependencies.
- `deploy:vps`: deploy to a VPS through Ansible-managed Docker Compose.
- `skills:install`: run `scripts/install-skills.sh`.

## AI Agent Instructions

`AGENTS.md` is the source of truth for AI agent instructions.

`CLAUDE.md` must not duplicate the same content. It should only include `AGENTS.md`, for example:

```md
@AGENTS.md
```

`AGENTS.md` should document:

- Project stack.
- Monorepo structure and the ESM module-system rule.
- Commands (including the Turborepo `db:generate` prerequisite).
- Architectural rules.
- REST versus ZenStack auto-CRUD usage rule.
- Data layer (ZenStack v3) and migration commands.
- Testing expectations.
- Code style expectations.
- Skill installation command.
- Installed skill list.

## Skills

Add `scripts/install-skills.sh` with the required skills:

```bash
npx skills add https://github.com/ccheney/robust-skills --skill clean-ddd-hexagonal
npx skills add https://github.com/kadajett/agent-nestjs-skills --skill nestjs-best-practices
npx skills add https://github.com/wshobson/agents --skill nodejs-backend-patterns
npx skills add https://github.com/mrgoonie/claudekit-skills --skill backend-development
npx skills add https://github.com/claude-office-skills/skills --skill telegram-bot
npx skills add https://github.com/jeffallan/claude-skills --skill devops-engineer
npx skills add https://github.com/jeffallan/claude-skills --skill architecture-designer
npx skills add https://github.com/zenstackhq/skills --skill zenstack-project-setup
npx skills add https://github.com/zenstackhq/skills --skill zenstack-schema-modeling
npx skills add https://github.com/zenstackhq/skills --skill zenstack-access-control
npx skills add https://github.com/zenstackhq/skills --skill zenstack-querying
npx skills add https://github.com/zenstackhq/skills --skill zenstack-crud-server
npx skills add https://github.com/zenstackhq/skills --skill zenstack-db-migration
npx skills add https://github.com/aj-geddes/useful-ai-prompts --skill ansible-automation
```

Notes:

- The duplicate `telegram-bot` skill from the original candidate list is intentionally omitted.
- The former `prisma/skills` entries (`prisma-database-setup`, `prisma-client-api`) are replaced by the official `zenstackhq/skills` set above.
- `ansible-automation` is spelled without a trailing underscore (the earlier `ansible-automation_` was a typo that would fail; the real skill path is `skills/ansible-automation`).
- All ten install commands were verified against the live repositories. For a durable template, consider pinning each `npx skills add` to a specific commit/ref, since these are third-party repos whose default branches can change.

## Deployment

Default deployment target is a VPS through Docker Compose, automated through Ansible.

Compose services:

- `backend`.
- `frontend`.
- `telegram-bot`.
- `postgres`.
- `redis`, used for Telegram bot sessions and available for rate limits, queues, or future background jobs.

The first version should keep deployment understandable:

- `.env.example` documents required variables (see the environment contract below).
- Compose files live under `infra/docker` or at the repository root with clear naming.
- Ansible inventory and playbooks live under `infra/ansible`.
- Secrets (JWT signing keys, database credentials, the bot's Telegram token and service API token) are managed through Ansible Vault or SOPS rather than committed `.env` files.
- Docker images are built with **multi-stage Dockerfiles using `turbo prune --docker`** so each app installs only its pruned dependency subset (smaller images, better layer caching). Use Corepack to pin pnpm inside the image, and account for Argon2's native build (or use a prebuilt binding such as `@node-rs/argon2`).
- Health checks (`/health/ready`) back each service's Compose `healthcheck`; an optional `observability` Compose profile (OpenObserve by default) is available but off by default so the base stack stays light. See "Observability".
- Deployment script should call Ansible to prepare the server, sync or pull the app, run migrations (`zen migrate deploy`), and restart Compose services predictably.
- Direct Docker Compose commands remain available for local development and manual server troubleshooting.

### Environment contract

`packages/config` validates these variables at startup (fail fast on missing/invalid):

- `DATABASE_URL` — Postgres connection string used by ZenStack's `pg` driver.
- `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET` — access and refresh signing keys.
- `TELEGRAM_BOT_TOKEN` — bot token from BotFather.
- `SERVICE_API_TOKEN` — static machine token the bot presents to the backend (`SERVICE` role).
- `REDIS_URL` — bot session store and optional shared infrastructure.
- `CORS_ORIGIN` / cookie domain settings — for cross-origin SPA auth.
- `LOG_LEVEL`, `OTEL_SERVICE_NAME` — logging verbosity and service identity.
- `OTEL_EXPORTER_OTLP_ENDPOINT` (+ `OTEL_EXPORTER_OTLP_HEADERS` for auth), `OTEL_SDK_DISABLED`, `METRICS_EXPORTER` (`otlp` default → OpenObserve | `prometheus` for the Grafana + Prometheus alternative) — telemetry export; the app runs with no collector by default.
- `SENTRY_DSN` — optional; enables error tracking when set.

## Testing

Testing should be present from the beginning.

Expected baseline:

- Backend unit tests with Vitest and Nest testing utilities.
- Backend e2e tests for auth.
- Access-policy tests for critical ZenStack `@@allow`/`@@deny` rules, since authorization now lives in the schema.
- Frontend component or route-level tests.
- Telegram bot handler tests.
- Contract/schema tests where shared contracts affect more than one app.

Integration/policy/e2e tests that need a database should run against a real Postgres — Testcontainers or a dedicated throwaway compose test database — because ZenStack policies are enforced at the query layer and cannot be meaningfully mocked.

The template should prioritize fast local tests and clear examples over broad generated coverage.

## Non-Goals

The initial template should not include:

- Nx.
- Nuxt.
- shadcn-vue.
- Keycloak, Supabase Auth, Auth.js, or other external auth providers.
- tRPC (superseded by ZenStack's generated RPC client and TanStack Query hooks).
- A separate Prisma ORM runtime (ZenStack v3 supersedes it; Prisma Migrate remains only as ZenStack's underlying migration engine).
- Direct database access from the Telegram bot.
- A full admin product UI beyond the starter auth shell and dashboard.
- Complex CI/CD platform integration beyond the minimal lint/typecheck/test/build workflow (no remote cache, matrices, or multi-environment pipelines by default).
- A paid APM or heavyweight monitoring platform required by default. Observability is OTLP-based and vendor-neutral; the optional self-hosted backend defaults to lightweight OpenObserve and is off by default, and because the app only speaks OTLP the backend is swappable (SigNoz, Grafana + Prometheus, or hosted).

## Open Decisions Resolved

- Monorepo: `pnpm workspaces + Turborepo`.
- Module system: ESM across the entire monorepo.
- Deployment: Docker Compose on VPS automated by Ansible, images built with `turbo prune`.
- Database: PostgreSQL.
- Data layer: ZenStack v3 (Kysely-based ORM, Prisma-compatible API; no Prisma runtime client; Prisma Migrate retained under the hood for migrations).
- Frontend UI: PrimeVue v4 with Tailwind v4 via `tailwindcss-primeui`.
- Frontend data layer: TanStack Query (Vue) through ZenStack-generated hooks.
- Telegram framework: grammY, long polling by default, Redis session store.
- Auth: local JWT plus HttpOnly refresh cookie; static service token (machine API key) for bot→backend.
- AI instructions: `AGENTS.md` source of truth, `CLAUDE.md` includes it.
- API strategy: hand-written REST/OpenAPI (NestJS) for public and service contracts; ZenStack auto-CRUD (RPC + TanStack Query hooks) as the optional first-party frontend layer (replaces tRPC).
- Tooling: Biome for formatting and primary linting, with `tsc` and `vue-tsc` for type checks.
- CI: a single minimal GitHub Actions gate (typecheck/lint/test/build after `zen generate`).
- Observability: `packages/observability` with Pino logging (`nestjs-pino`), OpenTelemetry traces/metrics/logs over OTLP, `@nestjs/terminus` health checks, and optional Sentry. Default optional backend is **OpenObserve** (lightweight OTLP-native all-in-one); alternatives are SigNoz, Grafana + Prometheus, or hosted. Vendor-neutral and swappable.
- Tests: Vitest across the monorepo; real Postgres (Testcontainers) for policy/e2e tests.
- Validation: Zod for env validation and shared contracts, with backend model schemas generated from ZModel.
- Toolchain floor: Node 20+, TypeScript 5.8+ (required by ZenStack v3).

## Spec Self-Review

- Placeholder scan: no unresolved placeholders remain.
- Internal consistency: REST/OpenAPI remains the stable external contract; ZenStack auto-CRUD is scoped to first-party frontend usage; the Telegram bot stays on REST with a service token and never imports the ZenStack client; Redis is now actually consumed (bot sessions).
- Codegen ordering: `db:generate` is wired as a Turborepo dependency of build/typecheck/dev so clones and CI never hit missing generated types.
- ZenStack v3 verification: package names, `zen` CLI/migration commands, the server-adapter list, the official NestJS recipe, Vue TanStack Query hooks, and the Prisma-Migrate-under-the-hood behavior were checked against the live docs and the official `zenstackhq/skills` files.
- Observability consistency: `packages/logger` is fully folded into `packages/observability` (all references updated); logging, tracing, metrics, and health share one package so log↔trace correlation and service identity stay in one place; heavier pieces are optional and off by default to respect the starter scope.
- Scope check: this is a single starter-template implementation, not a multi-product platform.
- Ambiguity check: major stack decisions, the data-layer swap, the module system, CI, and service-to-service auth are explicit.
