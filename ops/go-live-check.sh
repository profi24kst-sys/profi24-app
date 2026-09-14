#!/bin/sh
set -eu

ENV_FILE=${ENV_FILE:-.env.production}
BASE_URL=${BASE_URL:-}
[ -f "$ENV_FILE" ] || { echo "go_live_error: env file not found: $ENV_FILE" >&2; exit 1; }

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

if [ -n "$BASE_URL" ]; then
  BASE_URL="$BASE_URL" sh ops/acceptance.sh
else
  echo "go_live_warning: BASE_URL не задан; post-deploy acceptance пропущен" >&2
fi

echo "go_live_ok preflight=yes users=yes operational_data=yes backup=yes public_acceptance=$([ -n "$BASE_URL" ] && echo yes || echo skipped)"
