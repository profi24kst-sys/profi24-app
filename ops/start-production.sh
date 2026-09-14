#!/bin/sh
set -eu

ENV_FILE=${ENV_FILE:-.env}
[ -f "$ENV_FILE" ] || { echo "start_error: env file not found: $ENV_FILE" >&2; exit 1; }

set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

sh ops/preflight.sh
docker compose --env-file "$ENV_FILE" config >/dev/null
BASE_URL=${BASE_URL:-${PUBLIC_BASE_URL:-}}
[ -n "$BASE_URL" ] || { echo "start_error: BASE_URL or PUBLIC_BASE_URL is required" >&2; exit 1; }

echo "production_start: preflight passed; preparing database"
docker compose --env-file "$ENV_FILE" up -d db
docker compose --env-file "$ENV_FILE" build api

echo "production_start: validating production user accounts"
docker compose --env-file "$ENV_FILE" run --rm api npm run production-user-check

echo "production_start: account security passed; starting CRM stack without backup worker"
SERVICES=$(docker compose --env-file "$ENV_FILE" config --services | grep -v '^backup$' | tr '\n' ' ')
[ -n "$SERVICES" ] || { echo "start_error: no application services found" >&2; exit 1; }
# shellcheck disable=SC2086
docker compose --env-file "$ENV_FILE" up -d --build $SERVICES

echo "production_start: validating staffing, branches, accounts and integrations"
docker compose --env-file "$ENV_FILE" run --rm api npm run production-readiness-check

echo "production_start: verifying the deployed public edge"
BASE_URL="$BASE_URL" sh ops/acceptance.sh

echo "production_start: acceptance passed; starting periodic backup worker"
docker compose --env-file "$ENV_FILE" up -d backup

echo "production_start: waiting for a verified post-start backup"
BACKUP_READY=0
for _ in $(seq 1 20); do
  if docker compose --env-file "$ENV_FILE" run --rm \
    -v "$PWD/ops/backup-status.sh:/backup-status.sh:ro" \
    backup sh /backup-status.sh; then
    BACKUP_READY=1
    break
  fi
  sleep 3
done
[ "$BACKUP_READY" = "1" ] || { echo "start_error: backup worker did not create a fresh verified backup" >&2; exit 1; }

echo "production_start: stack requested; current status"
docker compose --env-file "$ENV_FILE" ps
echo "production_start_ok readiness=yes public_acceptance=yes post_start_backup=yes backup_worker=yes"
