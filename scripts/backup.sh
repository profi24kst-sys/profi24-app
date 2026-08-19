#!/bin/sh
set -eu
mkdir -p backups
STAMP=$(date +%Y%m%d_%H%M%S)
docker compose exec -T db pg_dump -U "${POSTGRES_USER:-profi24}" -d "${POSTGRES_DB:-profi24}" -Fc > "backups/profi24_${STAMP}.dump"
echo "Backup created: backups/profi24_${STAMP}.dump"
