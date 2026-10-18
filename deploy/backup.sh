#!/bin/bash
# Nightly logical backups of both databases, kept for BACKUP_KEEP_DAYS days.
# Restore: see docs/operations.md.
set -euo pipefail
dump() {
  local stamp; stamp=$(date -u +%Y%m%dT%H%M%SZ)
  for db in ragdag airflow; do
    pg_dump -Fc -d "$db" -f "/backups/${db}-${stamp}.dump.partial"
    mv "/backups/${db}-${stamp}.dump.partial" "/backups/${db}-${stamp}.dump"
  done
  find /backups -name '*.dump' -mtime +"${BACKUP_KEEP_DAYS}" -delete
  echo "$(date -u +%FT%TZ) backup ${stamp} done"
}
[[ "${1:-}" == "now" ]] && { dump; exit 0; }
while true; do
  now=$(date -u +%s)
  next=$(date -u -d "today ${BACKUP_HOUR}:00" +%s)
  (( next <= now )) && next=$(date -u -d "tomorrow ${BACKUP_HOUR}:00" +%s)
  sleep $(( next - now ))
  dump || echo "$(date -u +%FT%TZ) backup FAILED" >&2
done
