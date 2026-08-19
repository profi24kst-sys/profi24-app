#!/bin/sh
set -eu
FILE=${1:-}
if [ -z "$FILE" ] || [ ! -f "$FILE" ]; then
  echo "Usage: sh scripts/restore.sh backups/file.dump"
  exit 1
fi
cat "$FILE" | docker compose exec -T db pg_restore -U "${POSTGRES_USER:-profi24}" -d "${POSTGRES_DB:-profi24}" --clean --if-exists --no-owner
