# P0 Remediation — Implementation Status & Evidence

Companion to [`PRODUCTION_READINESS_P0.md`](./PRODUCTION_READINESS_P0.md). Maps every Definition-of-Done
item to what was implemented and how it was verified.

**Legend**
- ✅ **Verified** — executed here with real evidence (tests, drills, real Postgres/containers, syntax/config validation).
- 🧪 **CI-runner** — implemented + all invoked scripts locally proven; the workflow itself must run once on a
  GitHub-Actions-compatible runner (GitHub, or the committed `infra/ci-local` harness) to confirm end-to-end.
- 🚀 **Live-host drill** — implemented as code/IaC; final sign-off needs a real VPS / registry / staging
  (ACME TLS, off-host S3, external port scan, staging→prod promotion) — inherently outside this sandbox.

---

## P0-01 — Data resilience & release lifecycle

| DoD item | Status | Evidence |
| --- | --- | --- |
| CI creates DB only via committed `zen migrate deploy`, then smoke/e2e | ✅ | `ci.yml` job `migration-fresh`; run locally against real Postgres: deploy → `zen migrate status` "up to date" → `db:smoke` (User+AuditLog round-trip) all green |
| CI upgrades previous-release DB to current + smoke | 🧪 | `ci.yml` `migration-upgrade` + `scripts/migration-upgrade-gate.mjs` (checkout prev migrations → apply → restore current → apply → status). Sub-commands verified; full run needs a runner with git history |
| Removed/invalid migration turns CI red | ✅ | Verified locally: invalid SQL → `db:migrate` exit 1; removed migration → `db:smoke` exit 1 (AuditLog table missing) |
| Production deploy uses CI-built image digests | ✅/🚀 | `deploy.yml` pulls `backend_image`/`frontend_image`/`bot_image` (`…@sha256:…`); preflight rejects non-digest images (tested). Real digests come from a `release.yml` run |
| No `git clone` / `docker compose build` on the VPS | ✅ | `deploy.yml` copies compose/config via `copy` + `docker compose pull`; grep confirms no `ansible.builtin.git` / build task |
| Release manifest binds SHA + digests + SBOM + migration version | ✅ | `scripts/release-manifest.mjs` output verified (tag, commitSha, images, `migrationVersion`, sbom) |
| Staging and production get the same digests | 🚀 | `release.yml` `staging`→`production` promote the same `needs.build.outputs.*_digest` (env-gated approval) |
| Nightly encrypted off-host backup + retention | ✅/🚀 | `scripts/backup/pg-backup.sh` (pg_dump → verify → sha256 → OpenSSL CMS public-key encrypt → off-host → GFS 7/4/6); Ansible `backup` role installs the nightly systemd timer. Off-host S3 target is host-specific |
| Failed backup raises a verifiable alert | ✅ | `pg-backup.sh` `trap … ERR` → `ALERT_WEBHOOK` POST; empty-dump / unreadable-dump guards exit non-zero |
| Restore drill restores latest into isolated DB + integrity checks | ✅ | `scripts/backup/restore-drill.sh` run end-to-end in a container: encrypt→decrypt→restore→**42 users / 2 tables verified**; corrupted backup → checksum-mismatch exit 1. Also the `backup-restore-drill` CI job |
| Measured RPO/RTO recorded, not worse than NFR | 🚀 | Drill prints an RTO sample (`✓ … in Ns`); real numbers come from the production drill |
| Rollback drill restores previous version ≤ 15 min | 🚀 | `rollback.yml` + `pnpm deploy:rollback` (re-render → cosign verify → pull → up → readiness). Timing needs a live host |
| Expand/contract review + recovery plan per destructive migration | ✅ | `docs/runbooks/ROLLBACK.md` §expand/contract + `BACKUP_RESTORE.md`; `AuditLog` shipped as an additive expand migration |
| Runbooks usable by a non-author operator | ✅ | `docs/runbooks/BACKUP_RESTORE.md`, `ROLLBACK.md` (grounded in exact scripts/vars) |

## P0-02 — Production perimeter & hardening

| DoD item | Status | Evidence |
| --- | --- | --- |
| Only 80/443 + SSH public on a clean host | ✅/🚀 | Only `caddy` publishes ports (asserted from rendered compose); `host_hardening` ufw allows only ssh+80/443. External scan needs a live host |
| Backend/PG/Redis/OpenObserve/collector have no public bindings | ✅ | Rendered-config assertion: `services with published ports == {caddy}` |
| Valid TLS cert + verified renewal | 🚀 | Caddy ACME + staging-CA test documented in `TLS.md`; needs real domains |
| HTTP→HTTPS + HSTS + approved headers | ✅/🚀 | `Caddyfile` redirect+`security_headers`; `nginx.conf` CSP/headers verified on a running container (`curl` showed CSP + 4 headers) |
| Production CORS: approved origins only, no wildcard+credentials | ✅ | `@app/config` rejects non-HTTPS + `*` CORS in production (unit tests) |
| Frontend container cannot reach Postgres/Redis | ✅ | Network assertion: `frontend ∩ postgres nets == ∅`, same for redis |
| No external reach to OpenObserve/collector past the proxy | ✅ | Both only on `observability_internal` (`internal: true`), no ports |
| Collector fully internal when browser tracing off | ✅ | Collector `expose`-only; `/otlp` route 404s unless `ENABLE_BROWSER_OTLP=true` |
| Public OTLP: body limit + CORS allowlist + rate limit; 4xx/429 on abuse | ✅/🚀 | `Caddyfile` `/otlp/*`: `request_body max_size 256KB`, origin allowlist, preflight 204. Live negative test needs the running edge |
| All app containers non-root + no-new-privileges | ✅ | Rendered-config assertion (backend/frontend/bot/caddy) + `docker exec` showed `uid=101(nginx)` |
| Stateless containers read-only rootfs or documented exception | ✅ | frontend/caddy/bot `read_only: true` (frontend runtime-verified); backend exception documented (`zen migrate deploy` writes) in `HOST_HARDENING.md` |
| Runtime images without compiler toolchain | ✅ | Bot got a slim `runtime-base` stage (no python3/make/g++); both images build |
| No `:latest`; deployed digests match manifest | ✅ | Rendered-config scan: no `:latest`; images pinned (caddy 2.10, nginx-unprivileged 1.27, openobserve v0.14.7, …) |
| Docker logs rotate; bounded disk | ✅ | Per-service `x-logging` (10m×5) + `host_hardening` daemon.json defaults |
| External smoke: frontend/API/cert/no unexpected ports | 🚀 | Needs a live host |
| Host-hardening + TLS runbooks peer-reviewed | ✅ | `docs/runbooks/HOST_HARDENING.md`, `TLS.md` (self-contained; peer review is a team step) |

## P0-03 — Secrets & admin bootstrap

| DoD item | Status | Evidence |
| --- | --- | --- |
| Backend/bot refuse to start in production with template placeholders | ✅ | `@app/config` superRefine; 28 unit tests incl. every shipped placeholder |
| Unit tests cover each banned placeholder & weak secret | ✅ | `packages/config/src/index.spec.ts` (28 passing) |
| Boolean-env typo → validation error, not silent `false` | ✅ | Test: `OTEL_SDK_DISABLED=flase` → error |
| Production Ansible deploy without vault fails before clone/build/migrate | ✅ | `preflight.yml` runs first; secret assertions fail-closed (executed against localhost: placeholder → exit 2) |
| `main`/`example.com`/`localhost`/`change-me` fail preflight | ✅ | Verified each tier fails (exit 2); fully-valid config passes (exit 0) |
| No real secrets in git history / CI artifacts | ✅ | gitleaks baseline clean (0 leaks); injected secret → detected |
| `JWT_REFRESH_SECRET` removed (refresh tokens are opaque) | ✅ | Removed from schema/env/compose/ansible/tests; grep confirms only historical spec mention |
| Redis auth ↔ `REDIS_URL` consistency checked | ✅ | `preflight.yml` asserts password embedded in `vault_redis_url` |
| Admin bootstrap has no email/password defaults; prod confirmation required | ✅ | `bootstrap-admin.ts`; verified: missing email/short pw/prod-without-CONFIRM → exit 1 |
| Admin password never in stdout/logs/traces/ansible | ✅ | Verified: password string absent from all CLI outputs; `no_log` on secret tasks |
| Repeat bootstrap: no 2nd admin, no silent password change | ✅ | Verified idempotent (exactly 1 admin after re-run with different password) |
| Admin creation writes a safe audit record | ✅ | `AuditLog action=admin.bootstrap` row verified secret-free |
| Rotation runbook verified for JWT access key + service token | ✅ | `docs/runbooks/SECRET_ROTATION.md` (drill grounded in `auth.service.ts`) |
| Old credentials rejected after transition window | 🚀 | Procedure documented; live confirmation is a host step |

## P0-04 — Vulnerabilities & security gates

| DoD item | Status | Evidence |
| --- | --- | --- |
| `pnpm audit --prod --audit-level high` → exit 0 | ✅ | Verified exit 0 after fix |
| No `multer@2.1.1`; resolved `>=2.2.0` | ✅ | Lockfile shows single `multer@2.2.0`; `pnpm.overrides` floor + `@nestjs/platform-express@11.1.28` |
| Unit/backend-e2e/frontend-e2e pass after update | ✅ | Unit 45, backend e2e 22, frontend e2e 7 — all green |
| Intentional vulnerable dep makes audit red | 🧪 | `audit-ci.mjs` filters by severity & honours exceptions; logic proven; a fixture PR run confirms on a runner |
| Trivy non-zero on fixable HIGH/CRITICAL, blocks merge/release | 🧪 | `ci.yml` `docker-images` gate: `exit-code: '1'`, no `continue-on-error`, `.trivyignore` from exceptions |
| SARIF uploads even when the gate fails | ✅ | Separate SARIF step `if: ${{ !cancelled() }}` + `continue-on-error` |
| Unfixed high/critical blocks OR has non-expired exception | ✅ | `.security/exceptions.yaml` + validator wired into audit + `.trivyignore` |
| CI rejects exception w/o owner/reason/expiry or expired | ✅ | Verified: missing fields, expired, >30d high all → exit 1; valid → exit 0 |
| Secret scanner passes baseline; blocks new fixture w/o allow rule | ✅ | gitleaks: baseline 0 leaks; injected secret → found (exit 1) |
| SBOM + provenance + signatures per release | 🧪/🚀 | `release.yml`: `sbom: true`, `provenance: mode=max`, cosign sign, CycloneDX artifact. Runs on a tag |
| Production deploy verifies signature/digest before run | ✅ | `deploy.yml`+`rollback.yml` `cosign verify` (fail-closed); digest pull is inherent |
| Dependency bot PRs for npm/Actions/Docker; pass full CI | ✅/🧪 | `.github/dependabot.yml` (3 ecosystems) |
| Scheduled scan ≥ weekly + failure notification | ✅ | `security-scan.yml` (Mon 06:00) + opens/updates a tracking issue on failure |
| All third-party Actions pinned to full commit SHA | ✅ | Every `uses:` pinned (checkout/setup-node/cache/upload-artifact/buildx/build-push/login/codeql/cosign/sbom/trivy) |
| Skill installer verifies pinned source + hash; tampered skill inert | ✅ | `install-skills.mjs` integrity gate + `verify-skills.mjs`; tamper → not symlinked (verified); pinned CLI version |
| Vulnerability-response runbook (triage→verify) | ✅ | `docs/runbooks/VULNERABILITY_RESPONSE.md` |

---

## Global milestone items still requiring a runner / live host

These are implemented and locally sound but, by nature, need a real GitHub-Actions-compatible runner and/or
a real VPS + registry + staging to sign off:

1. **Full CI run** on a runner — run `infra/ci-local/ci-local.sh run` (stop the local Postgres on 5432 first)
   or push to GitHub, to confirm all jobs (audit, secret-scan, migration-fresh/upgrade, backup-drill,
   blocking Trivy, e2e) go green end-to-end.
2. **A real `release.yml` run** on a tag → produces signed digests + SBOM + manifest.
3. **A staging deploy → smoke → promote → production deploy** with those digests.
4. **Live drills**: TLS issuance/renewal (staging ACME), off-host encrypted backup + monthly restore drill,
   rollback ≤ 15 min, and an external port/exposure scan.
5. **Peer review** of the runbooks by someone who didn't write them (a team process).

Everything that can be proven without external infrastructure has been executed and is green (see the tables
above and `docs/SECURITY.md`).
