# Runbook: PostgreSQL Backup & Restore

Operational runbook for the `single-vps-production` profile. An operator who did **not**
write the code should be able to follow this end to end.

## 1. Purpose & targets (NFRs)

Regularly copy PostgreSQL data **off the VPS**, keep it **encrypted at rest**, prove it is
**recoverable**, and be able to restore it after a data-loss incident.

Targets from `docs/PRODUCTION_READINESS_P0.md` §1.1 for this profile:

| NFR | Target |
| --- | --- |
| PostgreSQL RPO | ≤ 24 h with the nightly backup (≤ 15 min only if WAL archiving / PITR is added) |
| PostgreSQL RTO | ≤ 4 h |

The `single-vps-production` profile is **not** high-availability: losing the VPS means an
outage until the host is rebuilt and the latest backup is restored. That is the scenario
this runbook covers.

Implementation:

- `scripts/backup/pg-backup.sh` — the nightly backup pipeline.
- `scripts/backup/restore-drill.sh` — the restore verification / recovery pipeline.
- `infra/ansible/roles/backup/` — installs both scripts as systemd timers on the VPS.
- `.github/workflows/ci.yml` → job `backup + restore drill` — runs the full round-trip on every CI run.

## 2. The backup pipeline

`scripts/backup/pg-backup.sh` performs, in order:

1. **Dump** — `pg_dump --format=custom --no-owner --no-privileges` of `DATABASE_URL` to a
   local staging file (`<label>-<UTC-stamp>.pgc`).
2. **Verify readable** — fails if the dump is empty, and runs `pg_restore --list` to confirm
   the archive parses and has ≥ 1 entry. A backup that cannot be listed is treated as failed.
3. **Checksum** — `sha256sum` of the encrypted artifact, written to a sidecar `.sha256` file.
4. **Encrypt** — public-key envelope encryption with OpenSSL CMS
   (`openssl cms -encrypt -aes-256-cbc … -outform DER`) using the recipient **public** cert.
   The plaintext `.pgc` is deleted immediately — **plaintext never leaves the host**.
5. **Upload off-host** — copies the `.cms` + `.sha256` to `BACKUP_DEST`, which is either a
   directory (on a separate volume/host) or an `s3://bucket/prefix` (via the `aws` CLI).
6. **GFS retention** — grandfather-father-son pruning at the destination: keep
   `RETENTION_DAILY` (default **7**) most-recent per day, one per ISO week
   (`RETENTION_WEEKLY`, default **4**), one per month (`RETENTION_MONTHLY`, default **6**).
7. **Alert on failure** — an `ERR` trap POSTs a JSON failure alert to `ALERT_WEBHOOK` if set
   (`{"status":"failed","job":"pg-backup",…}`). Success is silent.

Artifacts at the destination look like: `app-20260710T023000Z.pgc.cms` and its
`app-20260710T023000Z.pgc.cms.sha256`.

## 3. CRITICAL — key management

Encryption is **public-key** (asymmetric). The VPS holds only the **public recipient
certificate** (`cert.pem`) and can therefore only *encrypt*. The matching **private key
(`private.pem`) must be kept OFF the VPS** — in a separate secret manager / password vault.
This is the entire point: an attacker who compromises the VPS gets ciphertext they cannot
decrypt, and the backup source host can never read its own backups.

That is also why the restore drill needs `BACKUP_PRIVATE_KEY` supplied separately — it is
the only place the private key is present, and it must not be the plain backup-source host.

### Generate the keypair (do this once)

```bash
openssl req -x509 -newkey rsa:4096 -nodes \
  -keyout private.pem -out cert.pem -days 3650 \
  -subj "/CN=app-backup"
```

Then:

- Copy **only `cert.pem`** to the VPS as the file referenced by `backup_recipient_cert`
  (default `{{ app_dir }}/backup-recipient.pem`). The Ansible role **fails the deploy** if
  this cert is missing.
- Store **`private.pem`** in a separate secret manager (1Password, Vault, AWS Secrets
  Manager, etc.). Never commit it, never place it on the backup-source VPS.
- If you lose `private.pem`, **every backup becomes permanently unrecoverable.** Back the
  private key up independently.

## 4. Production scheduling (Ansible `backup` role)

The `backup` role (run automatically by `infra/ansible/deploy.yml`) installs the scripts and
two systemd timers:

| systemd unit | Schedule (default) | What it runs |
| --- | --- | --- |
| `app-backup.timer` → `app-backup.service` | `backup_schedule` = `*-*-* 02:30:00` (nightly 02:30 UTC) | `pg-backup.sh` |
| `app-restore-drill.timer` → `app-restore-drill.service` | `drill_schedule` = `*-*-01 04:00:00` (1st of month 04:00 UTC) | `restore-drill.sh` |

The restore-drill timer is installed **only when `drill_private_key` is set** — without the
off-host private key there is nothing to decrypt with, so the drill is skipped.

Key role variables (`infra/ansible/roles/backup/defaults/main.yml`), override via vault /
group_vars:

| Variable | Default | Meaning |
| --- | --- | --- |
| `manage_backups` | `true` | Toggle the whole role off with `false`. |
| `backup_database_url` | `{{ vault_database_url }}` | Connection string to back up. |
| `backup_dest` | `s3://your-bucket/app-backups` | Off-host destination (`s3://…` or absolute dir). **Never the DB's own disk.** |
| `backup_recipient_cert` | `{{ app_dir }}/backup-recipient.pem` | Public cert used to encrypt (private key stays off-host). |
| `backup_dir` | `{{ app_dir }}/backups-work` | Local staging only. |
| `backup_label` | `app` | Filename prefix. |
| `retention_daily` / `retention_weekly` / `retention_monthly` | `7` / `4` / `6` | GFS retention. |
| `backup_alert_webhook` | `""` | Webhook that receives a JSON POST on backup failure. |
| `backup_schedule` / `drill_schedule` | `*-*-* 02:30:00` / `*-*-01 04:00:00` | systemd `OnCalendar`. |
| `drill_restore_database_url` | `postgresql://postgres:postgres@postgres:5432/app_restore_drill` | Isolated DB the drill drops + recreates each run. |
| `drill_private_key` | `""` | Path to the off-host **private** key on the drill host. Empty ⇒ drill not installed. |

Inspect / trigger on the host:

```bash
# See the timers and their next run
systemctl list-timers 'app-backup*' 'app-restore-drill*'

# Run a backup right now (outside the schedule)
sudo systemctl start app-backup.service
journalctl -u app-backup.service -n 50 --no-pager

# Run the restore drill right now
sudo systemctl start app-restore-drill.service
journalctl -u app-restore-drill.service -n 80 --no-pager
```

## 5. Run a MANUAL backup

Set the environment the script requires and invoke it directly. Required vars are asserted by
the script and it exits if any is missing.

```bash
# Required
export DATABASE_URL="postgresql://app:PASSWORD@127.0.0.1:5432/app"
export BACKUP_RECIPIENT_CERT="/opt/app/backup-recipient.pem"   # PUBLIC cert
export BACKUP_DEST="s3://your-bucket/app-backups"              # or an off-host dir

# Optional (defaults shown)
export BACKUP_WORKDIR="/var/backups/app"
export BACKUP_LABEL="app"
export RETENTION_DAILY=7 RETENTION_WEEKLY=4 RETENTION_MONTHLY=6
export ALERT_WEBHOOK="https://hooks.example.com/backup"

bash scripts/backup/pg-backup.sh
```

Requires `pg_dump`, `pg_restore`, `openssl`, and (for `s3://`) the `aws` CLI on `PATH`.

## 6. Run a MANUAL restore drill

The drill proves the latest off-host backup restores cleanly. It **drops and recreates**
`RESTORE_DATABASE_URL` — point it at an **isolated** database, never production.

```bash
# Required
export BACKUP_DEST="s3://your-bucket/app-backups"             # where backups live
export BACKUP_PRIVATE_KEY="/secure/offhost/private.pem"       # the OFF-HOST private key
export RESTORE_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:5432/app_restore_drill"

# Optional (defaults shown)
export BACKUP_LABEL="app"
export MIN_EXPECTED_TABLES=1
export WORKDIR="/tmp/restore-drill"

bash scripts/backup/restore-drill.sh
```

## 7. How the drill verifies integrity

`scripts/backup/restore-drill.sh`:

1. Locates the **newest** `*.pgc.cms` at `BACKUP_DEST` and fetches it plus its `.sha256`.
2. **Checksum** — recomputes sha256 and fails on mismatch.
3. **Decrypt** — `openssl cms -decrypt` with the off-host `BACKUP_PRIVATE_KEY`.
4. **Readable** — `pg_restore --list` must show ≥ 1 entry.
5. **Isolated target** — derives an admin URL (`…/postgres`) and the target DB name from
   `RESTORE_DATABASE_URL`, then `DROP DATABASE IF EXISTS … WITH (FORCE)` + `CREATE DATABASE`.
6. **Restore** — `pg_restore --no-owner --no-privileges` into the fresh DB.
7. **Integrity checks** — table count `≥ MIN_EXPECTED_TABLES`, and the app-level
   `SELECT count(*) FROM "User"` must succeed (proves the schema restored and is queryable).
8. **RTO sample** — prints elapsed wall-clock seconds so recovery time can be recorded.

## 8. Continuous validation in CI

`.github/workflows/ci.yml` job **`backup + restore drill`** runs the real round-trip on every
CI run against a throwaway Postgres service:

1. Seeds a `"User"` table with 25 rows in DB `app_bk`.
2. Generates an **ephemeral** keypair (`openssl req -x509 -newkey rsa:2048 … -days 1`).
3. Runs `scripts/backup/pg-backup.sh` (`BACKUP_DEST=backups`, `BACKUP_RECIPIENT_CERT=keys/cert.pem`).
4. Runs `scripts/backup/restore-drill.sh` into an isolated `app_bk_restore` DB
   (`BACKUP_PRIVATE_KEY=keys/private.pem`).

If encrypt→upload→decrypt→restore→integrity ever breaks, CI goes red. On self-hosted /
container runners set the `E2E_DB_HOST=postgres` Actions variable (services are reached by
name, not `localhost`).

## 9. Recovery — real data-loss incident

Restore the latest backup into the **real** database. You need the **off-host private key**.

1. **Stop writers** so nothing races the restore:

   ```bash
   cd /opt/app
   docker compose -f infra/docker/docker-compose.yml --env-file .env stop backend telegram-bot
   ```

2. **Retrieve the off-host `private.pem`** from your secret manager onto the recovery host
   (not committed, not left on disk afterwards).

3. **Restore.** The safest path is to reuse the drill against the real DB URL — it verifies
   checksum, decrypts, and runs integrity checks. Because the drill **drops and recreates**
   the target DB, only aim it at the real DB when you intend a full replace:

   ```bash
   export BACKUP_DEST="s3://your-bucket/app-backups"
   export BACKUP_PRIVATE_KEY="/secure/tmp/private.pem"
   export RESTORE_DATABASE_URL="postgresql://app:PASSWORD@127.0.0.1:5432/app"   # REAL DB — will be dropped+recreated
   bash scripts/backup/restore-drill.sh
   ```

   To restore **without** dropping the DB (e.g. into a freshly created empty one), do it
   manually:

   ```bash
   latest=$(aws s3 ls s3://your-bucket/app-backups/ | awk '{print $4}' | grep '\.pgc\.cms$' | sort | tail -1)
   aws s3 cp "s3://your-bucket/app-backups/${latest}" ./restore.pgc.cms
   openssl cms -decrypt -binary -inform DER -in restore.pgc.cms -out restore.pgc -inkey /secure/tmp/private.pem
   pg_restore --no-owner --no-privileges --dbname="$RESTORE_DATABASE_URL" restore.pgc
   ```

4. **Bring the stack back up and verify readiness:**

   ```bash
   docker compose -f infra/docker/docker-compose.yml --env-file .env up -d
   curl -fsS http://127.0.0.1:3000/health/ready
   ```

5. **Record the actual RTO/RPO** (backup timestamp → service restored) and shred the
   private key copy from the recovery host.

> Data written since the last nightly backup is lost — that is the ≤ 24 h RPO. For a tighter
> RPO, add WAL archiving / PITR or a managed PostgreSQL. Application rollback is a **separate**
> procedure — see [`ROLLBACK.md`](./ROLLBACK.md).

## 10. Expected output — a successful drill

```
04:00:01 locating latest backup at s3://your-bucket/app-backups…
04:00:02 latest backup: app-20260710T023000Z.pgc.cms
04:00:02 verifying checksum…
04:00:03 decrypting with off-host private key…
04:00:03 verifying archive is readable…
04:00:04 recreating isolated restore target…
04:00:06 restoring into app_restore_drill…
04:00:11 running integrity checks…
04:00:11 restored 7 tables
04:00:11 User rows after restore: 1
04:00:11 ✓ restore drill PASSED in 10s (RTO sample) — 7 tables, 1 users
```

A failure prints `DRILL FAILED: <reason>` and exits non-zero (which turns the CI job red /
fires the systemd unit failure).
