#!/bin/sh
set -eu

BACKUP_SET_DIR=${1:-${BACKUP_SET_DIR:-}}
RESTORE_DATABASE_URL=${RESTORE_DATABASE_URL:-}
RESTORE_CONFIRM=${RESTORE_CONFIRM:-}
ALLOW_NONEMPTY=${RESTORE_ALLOW_NONEMPTY:-NO}
RESTORE_UPLOADS=${RESTORE_UPLOADS:-NO}
RESTORE_UPLOAD_ROOT=${RESTORE_UPLOAD_ROOT:-}
ALLOW_NONEMPTY_UPLOADS=${RESTORE_ALLOW_NONEMPTY_UPLOADS:-NO}

fail(){ echo "restore_error: $*" >&2; exit 1; }

[ -n "$BACKUP_SET_DIR" ] || fail "укажите каталог backup set: /backups/YYYYMMDD-HHMMSS"
[ -d "$BACKUP_SET_DIR" ] || fail "каталог backup set не найден: $BACKUP_SET_DIR"
[ -f "$BACKUP_SET_DIR/postgres.dump" ] || fail "postgres.dump не найден"
[ -f "$BACKUP_SET_DIR/SHA256SUMS" ] || fail "SHA256SUMS не найден"
[ -n "$RESTORE_DATABASE_URL" ] || fail "RESTORE_DATABASE_URL обязателен"
[ "$RESTORE_CONFIRM" = "YES" ] || fail "для восстановления установите RESTORE_CONFIRM=YES"

case "$RESTORE_DATABASE_URL" in
  *change-me*|*change-this*|*replace-with*) fail "RESTORE_DATABASE_URL содержит placeholder" ;;
esac

if [ -n "${DATABASE_URL:-}" ] && [ "$RESTORE_DATABASE_URL" = "$DATABASE_URL" ] && [ "$ALLOW_NONEMPTY" != "YES" ]; then
  fail "восстановление поверх рабочего DATABASE_URL запрещено; используйте отдельную БД или RESTORE_ALLOW_NONEMPTY=YES"
fi

(
  cd "$BACKUP_SET_DIR"
  sha256sum -c SHA256SUMS
) || fail "checksum backup set не прошёл проверку"

TABLE_COUNT=$(psql "$RESTORE_DATABASE_URL" -Atqc "SELECT count(*) FROM pg_tables WHERE schemaname='public'" 2>/dev/null || true)
[ -n "$TABLE_COUNT" ] || fail "не удалось подключиться к RESTORE_DATABASE_URL"

PG_RESTORE_FLAGS="--exit-on-error --no-owner --no-privileges"
if [ "$TABLE_COUNT" -gt 0 ]; then
  [ "$ALLOW_NONEMPTY" = "YES" ] || fail "целевая БД не пустая ($TABLE_COUNT таблиц); восстановление остановлено"
  PG_RESTORE_FLAGS="$PG_RESTORE_FLAGS --clean --if-exists"
fi

# shellcheck disable=SC2086
pg_restore $PG_RESTORE_FLAGS --dbname="$RESTORE_DATABASE_URL" "$BACKUP_SET_DIR/postgres.dump"
psql "$RESTORE_DATABASE_URL" -v ON_ERROR_STOP=1 -Atqc "SELECT 1" >/dev/null

if [ "$RESTORE_UPLOADS" = "YES" ]; then
  [ -f "$BACKUP_SET_DIR/uploads.tar.gz" ] || fail "uploads.tar.gz отсутствует в backup set"
  [ -n "$RESTORE_UPLOAD_ROOT" ] || fail "для файлов укажите RESTORE_UPLOAD_ROOT"
  mkdir -p "$RESTORE_UPLOAD_ROOT"
  if [ "$(find "$RESTORE_UPLOAD_ROOT" -mindepth 1 -maxdepth 1 | wc -l | tr -d ' ')" -gt 0 ] && [ "$ALLOW_NONEMPTY_UPLOADS" != "YES" ]; then
    fail "RESTORE_UPLOAD_ROOT не пуст; установите RESTORE_ALLOW_NONEMPTY_UPLOADS=YES только для осознанной замены"
  fi
  tar -xzf "$BACKUP_SET_DIR/uploads.tar.gz" -C "$RESTORE_UPLOAD_ROOT"
fi

echo "restore_ok backup_set=$(basename "$BACKUP_SET_DIR") tables=$(psql "$RESTORE_DATABASE_URL" -Atqc \"SELECT count(*) FROM pg_tables WHERE schemaname='public'\")"
