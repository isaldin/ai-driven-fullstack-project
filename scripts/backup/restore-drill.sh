#!/usr/bin/env bash
# Restore drill: prove the latest off-host backup actually restores.
#
# Fetches the newest encrypted dump, decrypts it with the OFF-HOST private key,
# verifies its checksum, restores it into an ISOLATED database, and runs integrity
# checks. Run monthly in production (Ansible timer) and on every CI run against a
# seeded throwaway DB. Prints an elapsed time so RTO can be recorded.
#
# Required env:
#   BACKUP_DEST            where backups live: a directory, or s3://bucket/prefix
#   BACKUP_PRIVATE_KEY     path to the recipient PRIVATE key (.pem) — kept off the
#                          backup-source host; only present where the drill runs
#   RESTORE_DATABASE_URL   isolated target DB (DROPPED + recreated by this script)
# Optional env:
#   BACKUP_LABEL=app  MIN_EXPECTED_TABLES=1  WORKDIR=/tmp/restore-drill
set -euo pipefail

LABEL="${BACKUP_LABEL:-app}"
WORKDIR="${WORKDIR:-/tmp/restore-drill}"
MIN_EXPECTED_TABLES="${MIN_EXPECTED_TABLES:-1}"
started=$(date +%s)

log() { printf '%s %s\n' "$(date -u +%H:%M:%S)" "$*" >&2; }
fail() { log "DRILL FAILED: $*"; exit 1; }

: "${BACKUP_DEST:?BACKUP_DEST is required}"
: "${BACKUP_PRIVATE_KEY:?BACKUP_PRIVATE_KEY is required}"
: "${RESTORE_DATABASE_URL:?RESTORE_DATABASE_URL is required}"
[ -f "${BACKUP_PRIVATE_KEY}" ] || fail "private key not found: ${BACKUP_PRIVATE_KEY}"

mkdir -p "${WORKDIR}"

log "locating latest backup at ${BACKUP_DEST}…"
case "${BACKUP_DEST}" in
  s3://*)
    latest="$(aws s3 ls "${BACKUP_DEST}/" | awk '{print $4}' | grep '\.pgc\.cms$' | sort | tail -1)"
    [ -n "${latest}" ] || fail "no backups found"
    aws s3 cp "${BACKUP_DEST}/${latest}" "${WORKDIR}/${latest}"
    aws s3 cp "${BACKUP_DEST}/${latest}.sha256" "${WORKDIR}/${latest}.sha256"
    ;;
  *)
    latest="$(ls -1 "${BACKUP_DEST}" 2>/dev/null | grep '\.pgc\.cms$' | sort | tail -1 || true)"
    [ -n "${latest}" ] || fail "no backups found"
    cp -f "${BACKUP_DEST}/${latest}" "${BACKUP_DEST}/${latest}.sha256" "${WORKDIR}/"
    ;;
esac
enc="${WORKDIR}/${latest}"
log "latest backup: ${latest}"

log "verifying checksum…"
actual="$(sha256sum "${enc}" | awk '{print $1}')"
expected="$(cat "${enc}.sha256")"
[ "${actual}" = "${expected}" ] || fail "checksum mismatch (expected ${expected}, got ${actual})"

log "decrypting with off-host private key…"
dump="${WORKDIR}/${latest%.cms}"
openssl cms -decrypt -binary -inform DER -in "${enc}" -out "${dump}" -inkey "${BACKUP_PRIVATE_KEY}"

log "verifying archive is readable…"
entries="$(pg_restore --list "${dump}" | grep -cvE '^;|^$' || true)"
[ "${entries}" -ge 1 ] || fail "restored archive has no entries"

log "recreating isolated restore target…"
admin_url="$(printf '%s' "${RESTORE_DATABASE_URL}" | sed -E 's#(://[^/]+)/.*#\1/postgres#')"
dbname="$(printf '%s' "${RESTORE_DATABASE_URL}" | sed -E 's#.*/([^/?]+).*#\1#')"
psql "${admin_url}" -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS \"${dbname}\" WITH (FORCE);" >/dev/null
psql "${admin_url}" -v ON_ERROR_STOP=1 -c "CREATE DATABASE \"${dbname}\";" >/dev/null

log "restoring into ${dbname}…"
pg_restore --no-owner --no-privileges --dbname="${RESTORE_DATABASE_URL}" "${dump}"

log "running integrity checks…"
tables="$(psql "${RESTORE_DATABASE_URL}" -tAc "SELECT count(*) FROM information_schema.tables WHERE table_schema='public';")"
[ "${tables}" -ge "${MIN_EXPECTED_TABLES}" ] || fail "expected >= ${MIN_EXPECTED_TABLES} tables, found ${tables}"
log "restored ${tables} tables"

# App-level integrity: the User table must exist and be queryable.
users="$(psql "${RESTORE_DATABASE_URL}" -tAc "SELECT count(*) FROM \"User\";" 2>/dev/null || echo "ERR")"
[ "${users}" != "ERR" ] || fail "User table missing / not queryable after restore"
log "User rows after restore: ${users}"

rm -f "${dump}" "${enc}" "${enc}.sha256"
elapsed=$(( $(date +%s) - started ))
log "✓ restore drill PASSED in ${elapsed}s (RTO sample) — ${tables} tables, ${users} users"
