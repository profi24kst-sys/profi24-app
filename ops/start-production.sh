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

echo "production_start: preflight passed; preparing database"
docker compose --env-file "$ENV_FILE" up -d db
docker compose --env-file "$ENV_FILE" build api

echo "production_start: validating production user accounts"
docker compose --env-file "$ENV_FILE" run --rm api npm run production-user-check

echo "production_start: account security passed; starting CRM stack"
docker compose --env-file "$ENV_FILE" up -d --build

echo "production_start: stack requested; current status"
docker compose --env-file "$ENV_FILE" ps
