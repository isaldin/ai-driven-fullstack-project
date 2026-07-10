#!/usr/bin/env bash
# Encrypted, off-host PostgreSQL backup for the single-VPS profile.
#
# Pipeline: pg_dump (custom format) -> verify it's readable (pg_restore --list)
# -> sha256 checksum -> public-key encrypt (OpenSSL CMS; the private key lives
# OFF the VPS) -> upload to an off-host destination -> GFS retention -> alert on
# failure. Designed to be driven by a systemd timer (see infra/ansible/roles/backup).
#
# Required env:
#   DATABASE_URL            postgres connection string to back up
#   BACKUP_RECIPIENT_CERT   path to the recipient's PUBLIC cert (.pem). Encrypt-only;
#                           the matching private key must NOT be on this host.
#   BACKUP_DEST             destination: a directory path, or s3://bucket/prefix
# Optional env:
#   BACKUP_WORKDIR          local staging dir (default: /var/backups/app)
#   RETENTION_DAILY=7 RETENTION_WEEKLY=4 RETENTION_MONTHLY=6
#   ALERT_WEBHOOK           URL to POST a JSON failure alert to
#   BACKUP_LABEL            filename prefix (default: app)
set -euo pipefail

WORKDIR="${BACKUP_WORKDIR:-/var/backups/app}"
LABEL="${BACKUP_LABEL:-app}"
RETENTION_DAILY="${RETENTION_DAILY:-7}"
RETENTION_WEEKLY="${RETENTION_WEEKLY:-4}"
RETENTION_MONTHLY="${RETENTION_MONTHLY:-6}"
# Deterministic-ish timestamp; overridable so tests are reproducible.
STAMP="${BACKUP_STAMP:-$(date -u +%Y%m%dT%H%M%SZ)}"
BASENAME="${LABEL}-${STAMP}"

log() { printf '%s %s\n' "$(date -u +%H:%M:%S)" "$*" >&2; }

alert() {
  local msg="$1"
  log "ALERT: ${msg}"
  if [ -n "${ALERT_WEBHOOK:-}" ]; then
    curl -fsS -m 15 -X POST -H 'content-type: application/json' \
      -d "{\"status\":\"failed\",\"job\":\"pg-backup\",\"label\":\"${LABEL}\",\"message\":\"${msg}\"}" \
      "${ALERT_WEBHOOK}" >/dev/null 2>&1 || log "alert webhook POST failed"
  fi
}
trap 'alert "backup failed (see logs)"' ERR

: "${DATABASE_URL:?DATABASE_URL is required}"
: "${BACKUP_RECIPIENT_CERT:?BACKUP_RECIPIENT_CERT (public cert) is required}"
: "${BACKUP_DEST:?BACKUP_DEST (dir or s3://...) is required}"
[ -f "${BACKUP_RECIPIENT_CERT}" ] || { alert "recipient cert not found: ${BACKUP_RECIPIENT_CERT}"; exit 1; }

mkdir -p "${WORKDIR}"
dump="${WORKDIR}/${BASENAME}.pgc"
enc="${dump}.cms"
sum="${enc}.sha256"

log "dumping database (custom format)…"
pg_dump --format=custom --no-owner --no-privileges --dbname="${DATABASE_URL}" --file="${dump}"

log "verifying dump is readable and non-empty…"
if [ ! -s "${dump}" ]; then alert "dump is empty"; exit 1; fi
entries="$(pg_restore --list "${dump}" | grep -cvE '^;|^$' || true)"
if [ "${entries}" -lt 1 ]; then alert "pg_restore --list produced no entries"; exit 1; fi
log "dump OK (${entries} archive entries)"

log "encrypting (OpenSSL CMS, public-key envelope)…"
openssl cms -encrypt -binary -aes-256-cbc -in "${dump}" -out "${enc}" -outform DER "${BACKUP_RECIPIENT_CERT}"
sha256sum "${enc}" | awk '{print $1}' > "${sum}"
rm -f "${dump}" # plaintext never leaves the host

log "uploading to ${BACKUP_DEST}…"
case "${BACKUP_DEST}" in
  s3://*)
    aws s3 cp "${enc}" "${BACKUP_DEST}/$(basename "${enc}")"
    aws s3 cp "${sum}" "${BACKUP_DEST}/$(basename "${sum}")"
    ;;
  *)
    mkdir -p "${BACKUP_DEST}"
    cp -f "${enc}" "${sum}" "${BACKUP_DEST}/"
    ;;
esac
log "upload complete: $(basename "${enc}")"

# --- GFS retention (local dest / s3 both list then prune) -------------------
prune_retention() {
  # List backup basenames (newest first) at the destination.
  local names
  case "${BACKUP_DEST}" in
    s3://*) names="$(aws s3 ls "${BACKUP_DEST}/" | awk '{print $4}' | grep '\.pgc\.cms$' || true)" ;;
    *)      names="$(ls -1 "${BACKUP_DEST}" 2>/dev/null | grep '\.pgc\.cms$' || true)" ;;
  esac
  [ -n "${names}" ] || return 0

  # Decide which to KEEP: N most-recent per day, one per ISO-week, one per month.
  local keep
  keep="$(printf '%s\n' "${names}" | sort -r | awk -v d="${RETENTION_DAILY}" -v w="${RETENTION_WEEKLY}" -v m="${RETENTION_MONTHLY}" '
    function ym(s){ return substr(s,index(s,"-")+1,6) }      # YYYYMM
    function ymd(s){ return substr(s,index(s,"-")+1,8) }     # YYYYMMDD
    {
      day=ymd($0); mon=ym($0);
      if (dcount[day]++ < d) { print; kept[$0]=1; next }
      if (!(mon in monseen) && mcount < m) { monseen[mon]=1; mcount++; print; kept[$0]=1; next }
    }')"

  # Delete anything not in the keep set.
  local f
  while IFS= read -r f; do
    [ -n "${f}" ] || continue
    if ! printf '%s\n' "${keep}" | grep -qx "${f}"; then
      log "retention: pruning ${f}"
      case "${BACKUP_DEST}" in
        s3://*) aws s3 rm "${BACKUP_DEST}/${f}" >/dev/null; aws s3 rm "${BACKUP_DEST}/${f}.sha256" >/dev/null 2>&1 || true ;;
        *)      rm -f "${BACKUP_DEST}/${f}" "${BACKUP_DEST}/${f}.sha256" ;;
      esac
    fi
  done <<EOF
$(printf '%s\n' "${names}")
EOF
}

log "applying retention (daily=${RETENTION_DAILY} weekly=${RETENTION_WEEKLY} monthly=${RETENTION_MONTHLY})…"
prune_retention

rm -f "${enc}" "${sum}"
trap - ERR
log "backup succeeded: ${BASENAME}"
