# Local CI verification (Gitea + act_runner)

Runs the **real** `.github/workflows/ci.yml` on a self-hosted, GitHub-Actions-compatible
runner, so CI changes can be verified without pushing to GitHub. This is optional dev
tooling — it is **not** part of the deployed stack.

## Why it exists

`docker compose` / GitHub Actions behaviour differs from local `pnpm` runs in ways that
only surface on a real runner (service-container networking, rootful Chromium, env
resolution). This harness catches those before they reach real CI.

**Rule:** any change to `.github/workflows/ci.yml` (or the scripts/config it invokes)
must be verified here before it's considered done. See the note in `AGENTS.md`.

## Prerequisites

- Docker (with the daemon socket at `/var/run/docker.sock` — the runner uses
  Docker-out-of-Docker to launch job containers).
- Ports `3010` (Gitea web) **and `5432`** free on the host. The workflow's Postgres
  service publishes `5432:5432` (as it does on GitHub-hosted runners), which on this
  shared daemon clashes with a local Postgres — stop it first (`pnpm docker:down`).
  `ci-local.sh run` preflights this and fails with a clear message otherwise.
- The first run pulls the Gitea, act_runner and `catthehacker/ubuntu:act-latest` images
  (a few GB) and downloads job dependencies — budget ~15 min. Everything is cached and
  the Gitea data + runner registration persist in named volumes, so later runs are fast.

## Usage

```bash
infra/ci-local/ci-local.sh up      # start Gitea + runner, create the repo, register the runner (idempotent)
infra/ci-local/ci-local.sh run     # snapshot the working tree, push -> trigger the workflow, wait for the result
infra/ci-local/ci-local.sh status  # last run's per-job results
infra/ci-local/ci-local.sh logs    # full runner logs
infra/ci-local/ci-local.sh down    # stop containers, keep volumes (fast next time)
infra/ci-local/ci-local.sh reset   # stop + wipe volumes and cached token (clean slate)
```

`run` snapshots your **working tree** (tracked + untracked, honouring `.gitignore`) into a
throwaway commit and force-pushes it to the harness repo's `main` — so you verify exactly
what you have locally, uncommitted changes included, without touching your real index or
branch.

## How it maps to real CI

The harness sets two repo-level Actions variables that a **container-based** runner needs
(and that GitHub-hosted runners don't) — mirroring the notes in the workflow:

| Variable | Value here | On GitHub-hosted |
| --- | --- | --- |
| `E2E_DB_HOST` | `postgres` (service reached by name from inside the job container) | unset → `localhost` |
| `PW_CHROMIUM_NO_SANDBOX` | `1` (jobs run as root; Chromium can't sandbox) | unset → sandbox on |

Web UI: <http://localhost:3010> — user `ci`, password `ci-local-password`.

## Known Gitea-vs-GitHub differences

- `actions/upload-artifact@v4` uses an API Gitea (GHES) doesn't implement, so it errors
  here — the workflow marks that step `continue-on-error: true`, so it's a warning locally
  and a real upload on github.com. Don't "fix" it by pinning `@v3`.
- Jobs run as root in the runner container, so Chromium needs `--no-sandbox`
  (`PW_CHROMIUM_NO_SANDBOX=1`, set as a repo variable by `up`).
