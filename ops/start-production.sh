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

echo "production_start: preflight passed; starting CRM stack"
docker compose --env-file "$ENV_FILE" up -d --build

echo "production_start: stack requested; current status"
docker compose --env-file "$ENV_FILE" ps
