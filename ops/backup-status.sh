#!/bin/sh
set -eu

BACKUP_DIR=${BACKUP_DIR:-/backups}
MAX_BACKUP_AGE_HOURS=${MAX_BACKUP_AGE_HOURS:-26}
fail(){ echo "backup_status_error: $*" >&2; exit 1; }

case "$MAX_BACKUP_AGE_HOURS" in ''|*[!0-9]*) fail "MAX_BACKUP_AGE_HOURS должен быть целым числом";; esac
[ "$MAX_BACKUP_AGE_HOURS" -gt 0 ] || fail "MAX_BACKUP_AGE_HOURS должен быть > 0"
[ -d "$BACKUP_DIR" ] || fail "каталог backup не найден: $BACKUP_DIR"

LATEST=$(find "$BACKUP_DIR" -mindepth 1 -maxdepth 1 -type d -print | sort -r | head -1)
[ -n "$LATEST" ] || fail "backup sets отсутствуют"
[ -f "$LATEST/postgres.dump" ] || fail "в последнем backup отсутствует postgres.dump"
[ -f "$LATEST/SHA256SUMS" ] || fail "в последнем backup отсутствует SHA256SUMS"

(
  cd "$LATEST"
  sha256sum -c SHA256SUMS
) >/dev/null || fail "checksum последнего backup не прошёл проверку"

MTIME=$(stat -c %Y "$LATEST/postgres.dump")
NOW=$(date +%s)
AGE_SECONDS=$((NOW-MTIME))
MAX_SECONDS=$((MAX_BACKUP_AGE_HOURS*3600))
[ "$AGE_SECONDS" -ge 0 ] || fail "время backup находится в будущем"
[ "$AGE_SECONDS" -le "$MAX_SECONDS" ] || fail "последний backup старше ${MAX_BACKUP_AGE_HOURS} часов"
AGE_HOURS=$((AGE_SECONDS/3600))

echo "backup_status_ok backup_set=$(basename "$LATEST") age_hours=$AGE_HOURS max_age_hours=$MAX_BACKUP_AGE_HOURS"
