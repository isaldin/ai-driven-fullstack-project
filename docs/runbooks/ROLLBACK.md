# Runbook: Application Rollback (immutable digests)

Operational runbook for the `single-vps-production` profile. Roll the running stack back to a
**previous release's image digests** without rebuilding anything.

## 1. The model

Releases are **built once in CI and never rebuilt on the VPS**:

- `.github/workflows/release.yml` builds `backend` / `frontend` / `telegram-bot` images once
  from a fixed commit, pushes them to GHCR, and **pins each by digest** (`…@sha256:…`).
- Each image is **signed with cosign (keyless / OIDC)** and gets an SBOM + SLSA provenance.
- A **release manifest** (`scripts/release-manifest.mjs` → `release-manifest.json`) binds the
  release tag + commit SHA to the exact image digests and the `migrationVersion` (newest
  committed migration). It is uploaded as the `release-manifest` workflow artifact
  (90-day retention). Staging and production get the **same digests** (approval-gated promotion).
- `infra/ansible/deploy.yml` **pulls** those digests (`docker compose pull`), never
  `docker compose build`, and (when `verify_image_signatures: true`) runs `cosign verify`
  against them before starting — failing closed if cosign is missing.

**Rollback = redeploy the digests of the previous known-good release.** No rebuild, no
`git clone` on the host — you point Compose at the older, already-signed digests.

Target: **application rollback ≤ 15 minutes** (`docs/PRODUCTION_READINESS_P0.md` §1.1).

## 2. Find the previous release's digests

Every successful deploy records a manifest on the host (written by `deploy.yml`). Default
`app_dir` is `/opt/app`.

```bash
# On the VPS: list recorded releases and see the current pointer
ls -1 /opt/app/releases/
cat  /opt/app/releases/current.json      # what is running now (has "rolledBack": true after a rollback)
cat  /opt/app/releases/v1.1.0.json       # the release you want to roll back TO
```

A per-release file (`/opt/app/releases/<tag>.json`) looks like:

```json
{
  "releaseTag": "v1.1.0",
  "images": {
    "backend":  "ghcr.io/your-org/your-repo/backend@sha256:…",
    "frontend": "ghcr.io/your-org/your-repo/frontend@sha256:…",
    "bot":      "ghcr.io/your-org/your-repo/telegram-bot@sha256:…"
  }
}
```

If the host file is missing, download the `release-manifest` artifact from that release's
run of `.github/workflows/release.yml` — it carries the same `images.{backend,frontend,bot}`
digests plus `commitSha` and `migrationVersion`.

## 3. Roll back

Run from the control node (the machine with the Ansible inventory), not the VPS. Digests must
be full `…@sha256:…` references — `rollback.yml` asserts `@sha256:` is present in each and
aborts otherwise.

```bash
pnpm deploy:rollback -e "rollback_tag=v1.1.0 \
  backend_image=ghcr.io/your-org/your-repo/backend@sha256:aaaa… \
  frontend_image=ghcr.io/your-org/your-repo/frontend@sha256:bbbb… \
  bot_image=ghcr.io/your-org/your-repo/telegram-bot@sha256:cccc…"
```

(`deploy:rollback` = `ansible-playbook -i infra/ansible/inventory.ini infra/ansible/rollback.yml`.
Add `--ask-vault-pass` / `--vault-password-file` when a `vault.yml` is present.)

`infra/ansible/rollback.yml` then performs, in order:

1. **Assert** `rollback_tag` and all three `*_image` digests are provided and contain `@sha256:`.
2. **Load vaulted secrets** (so `.env` re-renders with real credentials).
3. **Re-render `.env`** (`templates/env.j2` → `{{ app_dir }}/.env`, mode `0600`) with
   `repo_version = rollback_tag` and the rollback digests.
4. **`cosign verify`** each target digest (when `verify_image_signatures: true`; fails closed
   if cosign is missing).
5. **`docker compose pull`** the previous digests (`--env-file .env`).
6. **`docker compose … up -d`** (with the configured `compose_profiles`) to switch the stack.
7. **Wait for readiness** — polls `http://127.0.0.1:{{ backend_port }}/health/ready` (default
   port `3000`) up to 20 times, 6 s apart, until HTTP 200.
8. **Record `releases/current.json`** with `"rolledBack": true` and the rolled-back images.

> Note: like the forward deploy, rollback runs `cosign verify` against the target digests
> before pulling (when `verify_image_signatures: true`), failing closed if cosign is missing.
> Only roll back to digests that came from a real, signed release manifest.

## 4. RTO target & how the drill measures it

The rollback drill measures wall-clock from invoking `pnpm deploy:rollback` to the
`/health/ready` 200 in step 6, and asserts it is **under 15 minutes** (§1.1). Because deploys
pull immutable digests (already present in GHCR, often cached on the host), the pull+recreate
is fast; the readiness wait dominates. Record the measured time as the rollback RTO evidence
for the release.

## 5. Database rollback guidance

**Application rollback does not touch the schema.** `rollback.yml` re-renders `.env`, pulls,
and `up -d`s — it runs **no migrations** and **no down-migrations**.

- **Forward-compatible (expand/contract) schema → application rollback is safe.** The project
  rule (`docs/PRODUCTION_READINESS_P0.md` §3.3.B) is that schema changes are backward
  compatible for at least one release: add nullable columns/tables first, ship code that reads
  both shapes, drop the old shape only a release later. The previous image can run against the
  newer schema, so just roll the app back. The release manifest's `migrationVersion` tells you
  which schema the target release expects — confirm the live schema is compatible.

- **A destructive schema change is NOT covered by application rollback.** If a release dropped
  a column/table or did an incompatible rewrite, the old image cannot run against it. Do **not**
  rely on automatic down-migrations to undo it. Instead either:
  - ship a **forward-fix migration** (a new migration that repairs the schema forward), or
  - **restore / PITR** the database — see [`BACKUP_RESTORE.md`](./BACKUP_RESTORE.md) §9.

  Every destructive migration must have an expand/contract review and a recovery plan agreed
  **before** it ships.

## 6. Post-rollback verification

After `/health/ready` returns 200, confirm the previous version is actually healthy:

```bash
# API — liveness + readiness (readiness pings the DB)
curl -fsS http://127.0.0.1:3000/health/live
curl -fsS http://127.0.0.1:3000/health/ready

# Frontend — served and returns HTML
curl -fsS -o /dev/null -w '%{http_code}\n' https://app.example.com/

# API smoke through the public edge (TLS + routing)
curl -fsS -o /dev/null -w '%{http_code}\n' https://api.example.com/health/ready

# Bot — container is up and not crash-looping (grammY getMe on a bad token crash-loops)
docker compose -f infra/docker/docker-compose.yml --env-file .env ps
docker compose -f infra/docker/docker-compose.yml --env-file .env logs --tail=50 telegram-bot
```

Then watch the signals for a few minutes:

- **Error rate / latency** — 5xx rate and p95 latency should return to the pre-incident
  baseline (traces/metrics in OpenObserve if the `observability` profile is on; 5xx land on
  their trace span via the exception interceptor).
- **`releases/current.json`** on the host now shows the rollback tag with `"rolledBack": true`.
- Run the same user-facing smoke path that surfaced the regression to confirm it is gone.

If the rollback itself does not reach readiness, check `docker compose … ps` / `logs`, verify
the digests exist in GHCR and are pullable from the host, and confirm the target schema is
compatible with the older image (§5).
