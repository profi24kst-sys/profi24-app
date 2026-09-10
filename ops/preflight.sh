#!/bin/sh
set -eu

fail(){ echo "preflight_error: $*" >&2; exit 1; }
require(){ eval "v=\${$1:-}"; [ -n "$v" ] || fail "$1 обязателен"; }
placeholder(){ case "$1" in *change-me*|*change-this*|*replace-with*|*example*|*changeme*|*secret*) return 0;; *) return 1;; esac; }
positive_int(){ name=$1; value=$2; case "$value" in ''|*[!0-9]*) fail "$name должен быть числом";; esac; }

require NODE_ENV
[ "$NODE_ENV" = "production" ] || fail "NODE_ENV должен быть production"
require POSTGRES_DB
require POSTGRES_USER
require POSTGRES_PASSWORD
require JWT_SECRET
require CORS_ORIGIN
require PUBLIC_BASE_URL

[ ${#POSTGRES_PASSWORD} -ge 16 ] || fail "POSTGRES_PASSWORD должен быть не короче 16 символов"
placeholder "$POSTGRES_PASSWORD" && fail "POSTGRES_PASSWORD содержит тестовый placeholder"
[ ${#JWT_SECRET} -ge 32 ] || fail "JWT_SECRET должен быть не короче 32 символов"
placeholder "$JWT_SECRET" && fail "JWT_SECRET содержит тестовый placeholder"
[ "$JWT_SECRET" != "$POSTGRES_PASSWORD" ] || fail "JWT_SECRET и POSTGRES_PASSWORD должны отличаться"

if [ -n "${WEBSITE_INTAKE_SECRET:-}" ]; then
  [ ${#WEBSITE_INTAKE_SECRET} -ge 32 ] || fail "WEBSITE_INTAKE_SECRET должен быть не короче 32 символов"
  placeholder "$WEBSITE_INTAKE_SECRET" && fail "WEBSITE_INTAKE_SECRET содержит тестовый placeholder"
  [ "$WEBSITE_INTAKE_SECRET" != "$JWT_SECRET" ] || fail "WEBSITE_INTAKE_SECRET и JWT_SECRET должны отличаться"
  [ "$WEBSITE_INTAKE_SECRET" != "$POSTGRES_PASSWORD" ] || fail "WEBSITE_INTAKE_SECRET и POSTGRES_PASSWORD должны отличаться"
  case "$WEBSITE_INTAKE_SECRET" in *profi24*|*password*|*qwerty*) fail "WEBSITE_INTAKE_SECRET выглядит предсказуемым";; esac
fi

case "$CORS_ORIGIN" in *'*'*) fail "CORS_ORIGIN не может содержать wildcard *";; esac
case "$PUBLIC_BASE_URL" in http://*|https://*) :;; *) fail "PUBLIC_BASE_URL должен быть абсолютным http(s) URL";; esac

ALLOW_INSECURE_HTTP=${ALLOW_INSECURE_HTTP:-NO}
if [ "$ALLOW_INSECURE_HTTP" != "YES" ]; then
  case "$PUBLIC_BASE_URL" in https://*) :;; *) fail "production PUBLIC_BASE_URL должен использовать HTTPS";; esac
  OLDIFS=$IFS; IFS=','
  for origin in $CORS_ORIGIN; do
    origin=$(printf '%s' "$origin" | tr -d ' ')
    case "$origin" in https://*) :;; *) IFS=$OLDIFS; fail "все CORS origins в production должны использовать HTTPS";; esac
    case "$origin" in *localhost*|*127.0.0.1*) IFS=$OLDIFS; fail "localhost запрещён в production CORS_ORIGIN";; esac
  done
  IFS=$OLDIFS
fi

DB_POOL_MAX=${DB_POOL_MAX:-10}
positive_int DB_POOL_MAX "$DB_POOL_MAX"
[ "$DB_POOL_MAX" -gt 0 ] || fail "DB_POOL_MAX должен быть > 0"

WEB_PORT=${WEB_PORT:-5173}
positive_int WEB_PORT "$WEB_PORT"
[ "$WEB_PORT" -gt 0 ] && [ "$WEB_PORT" -le 65535 ] || fail "WEB_PORT вне диапазона 1..65535"

BACKUP_RETENTION_DAYS=${BACKUP_RETENTION_DAYS:-14}
positive_int BACKUP_RETENTION_DAYS "$BACKUP_RETENTION_DAYS"
[ "$BACKUP_RETENTION_DAYS" -ge 7 ] || fail "храните production backup минимум 7 дней"

AUTH_RATE_LIMIT_PER_MINUTE=${AUTH_RATE_LIMIT_PER_MINUTE:-30}
positive_int AUTH_RATE_LIMIT_PER_MINUTE "$AUTH_RATE_LIMIT_PER_MINUTE"
[ "$AUTH_RATE_LIMIT_PER_MINUTE" -ge 10 ] && [ "$AUTH_RATE_LIMIT_PER_MINUTE" -le 120 ] || fail "AUTH_RATE_LIMIT_PER_MINUTE должен быть в диапазоне 10..120"

AUTH_TOKEN_TTL=${AUTH_TOKEN_TTL:-12h}
case "$AUTH_TOKEN_TTL" in
  *h) AUTH_TOKEN_HOURS=${AUTH_TOKEN_TTL%h} ;;
  *) fail "AUTH_TOKEN_TTL задаётся в часах, например 8h или 12h" ;;
esac
positive_int AUTH_TOKEN_TTL "$AUTH_TOKEN_HOURS"
[ "$AUTH_TOKEN_HOURS" -ge 1 ] && [ "$AUTH_TOKEN_HOURS" -le 24 ] || fail "AUTH_TOKEN_TTL должен быть от 1h до 24h"

AUTH_FAILURE_LIMIT=${AUTH_FAILURE_LIMIT:-10}
positive_int AUTH_FAILURE_LIMIT "$AUTH_FAILURE_LIMIT"
[ "$AUTH_FAILURE_LIMIT" -ge 3 ] && [ "$AUTH_FAILURE_LIMIT" -le 20 ] || fail "AUTH_FAILURE_LIMIT должен быть в диапазоне 3..20"

AUTH_FAILURE_WINDOW_MINUTES=${AUTH_FAILURE_WINDOW_MINUTES:-10}
positive_int AUTH_FAILURE_WINDOW_MINUTES "$AUTH_FAILURE_WINDOW_MINUTES"
[ "$AUTH_FAILURE_WINDOW_MINUTES" -ge 1 ] && [ "$AUTH_FAILURE_WINDOW_MINUTES" -le 60 ] || fail "AUTH_FAILURE_WINDOW_MINUTES должен быть в диапазоне 1..60"

AUTH_LOCK_MINUTES=${AUTH_LOCK_MINUTES:-15}
positive_int AUTH_LOCK_MINUTES "$AUTH_LOCK_MINUTES"
[ "$AUTH_LOCK_MINUTES" -ge 1 ] && [ "$AUTH_LOCK_MINUTES" -le 120 ] || fail "AUTH_LOCK_MINUTES должен быть в диапазоне 1..120"

if [ -n "${WHATSAPP_TOKEN:-}" ] || [ -n "${WHATSAPP_PHONE_NUMBER_ID:-}" ]; then
  [ -n "${WHATSAPP_TOKEN:-}" ] && [ -n "${WHATSAPP_PHONE_NUMBER_ID:-}" ] || fail "WHATSAPP_TOKEN и WHATSAPP_PHONE_NUMBER_ID задаются вместе"
fi

case "$JWT_SECRET" in *profi24*|*password*|*qwerty*) fail "JWT_SECRET выглядит предсказуемым";; esac

echo "preflight_ok node_env=$NODE_ENV public_base_url=$PUBLIC_BASE_URL backup_retention_days=$BACKUP_RETENTION_DAYS auth_token_ttl=$AUTH_TOKEN_TTL auth_failure_limit=$AUTH_FAILURE_LIMIT website_intake_configured=$([ -n "${WEBSITE_INTAKE_SECRET:-}" ] && echo yes || echo no)"
