#!/bin/sh
set -eu

ENV_FILE=${ENV_FILE:-.env.production}
BASE_URL=${BASE_URL:-}
[ -f "$ENV_FILE" ] || { echo "go_live_error: env file not found: $ENV_FILE" >&2; exit 1; }
[ -n "$BASE_URL" ] || { echo "go_live_error: BASE_URL is required for public post-deploy acceptance" >&2; exit 1; }

set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

sh ops/preflight.sh
docker compose --env-file "$ENV_FILE" config >/dev/null
docker compose --env-file "$ENV_FILE" run --rm api npm run production-user-check
docker compose --env-file "$ENV_FILE" run --rm api npm run production-readiness-check
docker compose --env-file "$ENV_FILE" run --rm \
  -v "$PWD/ops/backup-status.sh:/backup-status.sh:ro" \
  backup sh /backup-status.sh

BASE_URL="$BASE_URL" sh ops/acceptance.sh

echo "go_live_ok preflight=yes users=yes operational_data=yes backup=yes public_acceptance=yes"
