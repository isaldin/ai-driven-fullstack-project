# Security Overview

Audience: **adopters of this template.** This is the map of how the template defends the
`single-vps-production` profile — what is enforced in code/CI/IaC, and where to go for the
operational detail. Every claim here points at a mechanism that actually exists in the repo;
runbooks under [`docs/runbooks/`](./runbooks/) carry the step-by-step procedures.

## 1. Threat model summary (single-VPS profile)

The deploy target is **one VPS** running the stack as sibling containers behind a Caddy
reverse proxy, provisioned by Ansible. Assets: the PostgreSQL data, user credentials
(Argon2-hashed), the JWT signing key, the bot service token, and the deploy pipeline itself.

Threats the template actively addresses, and the primary control:

| Threat | Primary control |
| --- | --- |
| Public traffic interception | TLS terminated at Caddy (ACME); HTTPS enforced by config + preflight → [`runbooks/TLS.md`](./runbooks/TLS.md) |
| Exposed internal services (DB, Redis, collector) | Segmented Compose networks; DB/Redis on `internal: true` networks with no internet route; host firewall default-deny → §5 |
| Booting production with template/default secrets | Fail-fast env validation + Ansible preflight reject placeholders/weak/duplicate secrets → §2 |
| Default/known admin credentials | No default admin exists; deliberate one-time bootstrap → [`runbooks/ADMIN_BOOTSTRAP.md`](./runbooks/ADMIN_BOOTSTRAP.md) |
| Credential theft from stolen access token | Short-lived (15 min) access JWTs; opaque, DB-hashed, rotating refresh tokens → §2 |
| Refresh-token replay / double-spend | Conditional revoke gated on affected-row count (TOCTOU-safe rotation) → §2 |
| Vulnerable dependency / image shipped to prod | Blocking audit + Trivy image gate + weekly rescan → §3 |
| Secret committed to the repo | gitleaks gate on every PR and release → §3 |
| Tampered build artifact / supply chain | SHA-pinned actions, build-once + digest-pinned deploy, cosign signatures, SBOM + provenance, skill integrity → §4 |
| Host compromise blast radius | Non-root, `cap_drop: ALL`, `no-new-privileges`, read-only rootfs where possible; encrypted off-host backups → §5, §6 |

**Trust boundaries.** The NestJS controllers/guards are the security boundary — trusted
services use the ZenStack client directly (row/field policies are available but off by
default). The **Telegram bot never touches the database**; it calls the backend over REST
with `SERVICE_API_TOKEN`, validated by `ServiceTokenGuard`. `passwordHash` is never exposed
by any DTO.

## 2. Secrets policy

**Validation (fail-fast).** `@app/config` (`packages/config/src/index.ts`) validates the
whole environment with Zod; in `NODE_ENV=production` it additionally rejects:

- `JWT_ACCESS_SECRET` / `SERVICE_API_TOKEN` shorter than **32 chars**, matching a known
  placeholder pattern, or **equal to each other**;
- placeholder credentials embedded in `DATABASE_URL` / `REDIS_URL`, the BotFather
  placeholder token;
- non-HTTPS or wildcard `CORS_ORIGIN`, `example.com` domains, `localhost` cookie domain;
- `localhost` in DB/Redis/CORS/cookie under `DEPLOYMENT_MODE=compose`;
- an enabled OTel SDK with no OTLP endpoint.

A failed check throws on boot, so a misconfigured backend/bot **crash-loops rather than
serving insecurely**. The Ansible preflight (`infra/ansible/preflight.yml`) asserts the same
invariants **before** a production deploy touches the server.

**No refresh signing secret.** Access tokens are short-lived JWTs signed with
`JWT_ACCESS_SECRET` (TTL `JWT_ACCESS_TTL`, default 900 s). Refresh tokens are **opaque**
random strings (`<id>.<secret>`) stored only as an Argon2 hash; rotation conditionally
revokes and gates on the affected-row count so two concurrent refreshes can't both mint a new
pair. There is deliberately **no** `JWT_REFRESH_SECRET`.

**Generation & rotation.** Generate every secret with `openssl rand -base64 48`; never reuse
a value across variables; store only in the encrypted vault (rendered to `.env` at
`mode 0600`, never logged — `no_log: true` on secret tasks). Full per-secret procedures and a
verified rotation drill: [`runbooks/SECRET_ROTATION.md`](./runbooks/SECRET_ROTATION.md).

## 3. CI/CD security gates

Blocking on every PR and on the release commit (`.github/workflows/ci.yml`,
`release.yml`):

- **Dependency audit** — `scripts/audit-ci.mjs` wraps `pnpm audit --json` and blocks any
  un-excepted production advisory at **≥ high**; it distinguishes a registry **outage**
  (exit 2) from a clean result. Dev-dependency audit runs as advisory.
- **Secret scan** — `gitleaks dir .` against `.gitleaks.toml` (narrow allowlist of the
  template's own placeholders; a new real-looking secret still trips it).
- **Image scan** — Trivy gates each built image (backend/frontend/bot) on **fixable
  HIGH/CRITICAL**, with SARIF uploaded to the Security tab and an advisory secret/misconfig
  scan of the image filesystem.
- **Migration gate** — production `zen migrate deploy` is exercised on committed migrations
  (fresh install **and** upgrade-from-previous-release) against a real Postgres, plus a
  backup + restore drill — so a broken/missing migration or backup pipeline turns CI red.
- **Exceptions** — `.security/exceptions.yaml`, validated by
  `scripts/check-security-exceptions.mjs`: required fields, future expiry, **30-day max** for
  high/critical, no indefinite or duplicate entries. Template ships with none.

A **weekly rescan** (`security-scan.yml`, Mondays 06:00 UTC) re-audits and re-scans
independent of code changes and files a tracking issue on failure. Response procedure:
[`runbooks/VULNERABILITY_RESPONSE.md`](./runbooks/VULNERABILITY_RESPONSE.md).

## 4. Supply-chain hardening

- **SHA-pinned actions.** Every third-party GitHub Action is pinned to a full commit SHA with
  a trailing `# vX.Y.Z` comment; Dependabot tracks and bumps them.
- **Dependabot** proposes dependency / base-image / action updates as PRs that must pass the
  full gate set before merge.
- **Build once, deploy by digest.** The release pipeline builds each image a single time,
  pushes it to GHCR **by digest**, and the Ansible deploy **pulls** that digest — images are
  never rebuilt on the VPS. The preflight rejects non-digest (`@sha256:`) image references in
  production.
- **Signing + attestation.** Images are signed with **cosign** (keyless/OIDC) and ship with
  an **SBOM** (in-registry attestation + a standalone CycloneDX SBOM) and **SLSA provenance**
  (`provenance: mode=max`). The deploy verifies cosign signatures on the host before running
  (fails closed if cosign is absent).
- **Skill integrity.** Agent skills are pinned by source repo and `SKILL.md` SHA-256 in
  `skills-lock.json` (trust-on-first-use, verified thereafter). A tampered skill is not
  activated; `pnpm skills:verify` (`scripts/verify-skills.mjs`) re-checks installed skills
  offline.

## 5. Perimeter & host hardening

- **TLS** at the Caddy edge (automatic ACME certificates); `CORS_ORIGIN` and `VITE_API_URL`
  must be HTTPS in production. → [`runbooks/TLS.md`](./runbooks/TLS.md)
- **Network segmentation** (`infra/docker/docker-compose.yml`): a public `edge` network for
  Caddy, and `app_internal` / `observability_internal` networks marked `internal: true` — so
  Postgres, Redis, and the collector have **no direct internet route**.
- **Container hardening**: stateless containers run non-root with `cap_drop: ALL`,
  `security_opt: no-new-privileges`, and read-only root filesystems where the workload allows.
- **Host firewall** (`ufw`): default-deny inbound, allowing only SSH (from a permitted CIDR)
  and 80/443; SSH allowed *before* enabling the firewall so you can't lock yourself out.
- **Automatic security updates** (`unattended-upgrades`), Docker log-size limits, and optional
  SSH hardening (no root login, no password auth). → [`runbooks/HOST_HARDENING.md`](./runbooks/HOST_HARDENING.md)
- **App-layer headers & limits**: `helmet` (full defaults in production), a global rate
  limiter (`@nestjs/throttler`, 120 req / 60 s), and the refresh cookie set `httpOnly`,
  `sameSite=lax`, `secure` in production.

## 6. Data resilience

- **Backups**: nightly `pg_dump`, public-key **encrypted at rest**, uploaded **off-host**,
  with GFS retention. The private key is kept off the VPS, and a restore drill runs monthly
  and in CI on every run. → [`runbooks/BACKUP_RESTORE.md`](./runbooks/BACKUP_RESTORE.md)
- **Rollback**: switch the running stack back to a previous release's **signed digests**
  without rebuilding (forward-compatible-migration model; the schema is left as-is).
  → [`runbooks/ROLLBACK.md`](./runbooks/ROLLBACK.md)

## 7. Admin bootstrap

There are **no default credentials.** The first `ADMIN` is created deliberately, once, from
`SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` (≥ 12 chars), and in production requires
`CONFIRM_PRODUCTION_BOOTSTRAP=true`. The command is idempotent (never a second admin, never a
silent password reset), never logs the password, and writes a secret-free audit row. Rotate
the one-time secret afterwards. → [`runbooks/ADMIN_BOOTSTRAP.md`](./runbooks/ADMIN_BOOTSTRAP.md)

## 8. Reporting a vulnerability

Report suspected vulnerabilities **privately** — do not open a public issue for an
unfixed security bug.

- Contact: **security@your-domain.example** *(replace with your project's real security
  contact / GitHub private vulnerability reporting before going live)*.
- Include affected component + version, reproduction, and impact assessment.
- For a leaked secret, rotate immediately per
  [`runbooks/SECRET_ROTATION.md`](./runbooks/SECRET_ROTATION.md) in parallel with reporting.

## 9. What is NOT covered (P1 and beyond)

This is a **single-VPS profile**, not a high-availability one. Out of scope here — adopt a
dedicated HA profile if you need them:

- **High availability / zero-downtime**: losing the VPS means an outage until the host is
  rebuilt and the latest backup is restored. Deploys recreate containers (brief interruption),
  they are not rolling/blue-green.
- **Managed / replicated PostgreSQL** and point-in-time recovery (default RPO is ≤ 24 h from
  the nightly backup; tighter RPO needs WAL archiving/PITR or managed DB).
- **External object storage / multi-region**, WAF-as-a-service, centralized SIEM, secrets
  manager integration beyond the Ansible vault, and row/field-level authorization policies
  (available via ZenStack `@@allow`/`@@deny` but **not enabled by default**).

## Runbook index

- [`runbooks/ADMIN_BOOTSTRAP.md`](./runbooks/ADMIN_BOOTSTRAP.md) — first admin
- [`runbooks/SECRET_ROTATION.md`](./runbooks/SECRET_ROTATION.md) — rotating every secret
- [`runbooks/VULNERABILITY_RESPONSE.md`](./runbooks/VULNERABILITY_RESPONSE.md) — triage → deploy → verify
- [`runbooks/BACKUP_RESTORE.md`](./runbooks/BACKUP_RESTORE.md) — backup & restore
- [`runbooks/ROLLBACK.md`](./runbooks/ROLLBACK.md) — application rollback
- [`runbooks/TLS.md`](./runbooks/TLS.md) — TLS / reverse proxy
- [`runbooks/HOST_HARDENING.md`](./runbooks/HOST_HARDENING.md) — firewall, updates, SSH
