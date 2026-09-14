#!/bin/sh
set -eu

fail(){ echo "production_release_regression_error: $*" >&2; exit 1; }

GO_LIVE=ops/go-live-check.sh
START=ops/start-production.sh
[ -f "$GO_LIVE" ] || fail "$GO_LIVE missing"
[ -f "$START" ] || fail "$START missing"

TMP_ENV=$(mktemp)
trap 'rm -f "$TMP_ENV"' EXIT INT TERM
printf 'NODE_ENV=production\n' >"$TMP_ENV"
if ENV_FILE="$TMP_ENV" BASE_URL= sh "$GO_LIVE" >/dev/null 2>&1; then
  fail "go-live check accepted an empty BASE_URL"
fi

grep -F '[ -n "$BASE_URL" ]' "$GO_LIVE" >/dev/null || fail "go-live BASE_URL guard missing"
grep -F 'BASE_URL="$BASE_URL" sh ops/acceptance.sh' "$GO_LIVE" >/dev/null || fail "go-live public acceptance missing"
grep -F 'public_acceptance=yes' "$GO_LIVE" >/dev/null || fail "go-live success proof missing"
if grep -F 'public_acceptance=skipped' "$GO_LIVE" >/dev/null; then
  fail "go-live still permits skipped public acceptance"
fi

READINESS_LINE=$(grep -n 'npm run production-readiness-check' "$START" | head -1 | cut -d: -f1)
ACCEPTANCE_LINE=$(grep -n 'BASE_URL="$BASE_URL" sh ops/acceptance.sh' "$START" | head -1 | cut -d: -f1)
WORKER_LINE=$(grep -n 'up -d backup' "$START" | head -1 | cut -d: -f1)
BACKUP_LINE=$(grep -n 'backup sh /backup-status.sh' "$START" | head -1 | cut -d: -f1)
[ -n "$READINESS_LINE" ] && [ -n "$ACCEPTANCE_LINE" ] && [ -n "$WORKER_LINE" ] && [ -n "$BACKUP_LINE" ] || fail "start-production release stages missing"
[ "$READINESS_LINE" -lt "$ACCEPTANCE_LINE" ] || fail "readiness must run before acceptance"
[ "$ACCEPTANCE_LINE" -lt "$WORKER_LINE" ] || fail "backup worker must start after acceptance"
[ "$WORKER_LINE" -lt "$BACKUP_LINE" ] || fail "post-start backup must be verified after the worker starts"
grep -F "grep -v '^backup$'" "$START" >/dev/null || fail "initial stack must exclude backup worker"
grep -F 'BACKUP_READY=1' "$START" >/dev/null || fail "verified backup success guard missing"

echo "production_release_regression_ok"
