#!/bin/sh
set -eu

fail(){ echo "runtime_env_error: $*" >&2; exit 78; }

if [ "${NODE_ENV:-development}" = "production" ]; then
  [ -n "${DATABASE_URL:-}" ] || fail "DATABASE_URL is required in production"
  [ -n "${JWT_SECRET:-}" ] || fail "JWT_SECRET is required in production"
  [ ${#JWT_SECRET} -ge 32 ] || fail "JWT_SECRET must be at least 32 characters in production"

  case "$JWT_SECRET" in
    *change-me*|*change-this*|*replace-with*|*changeme*|*dev-secret*|*example*|*qwerty*|*password*)
      fail "JWT_SECRET contains a known placeholder or predictable value"
      ;;
  esac

  [ -n "${CORS_ORIGIN:-}" ] || fail "CORS_ORIGIN is required in production"
  case "$CORS_ORIGIN" in
    *'*'*) fail "CORS_ORIGIN wildcard is forbidden in production" ;;
  esac
fi

exec "$@"
