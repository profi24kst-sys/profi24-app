#!/bin/sh
set -eu

BACKUP_DIR=${BACKUP_DIR:-/backups}
BACKUP_SET=${1:-}
OFFSITE_BACKUP_DIR=${OFFSITE_BACKUP_DIR:-}
fail(){ echo "backup_export_error: $*" >&2; exit 1; }

[ -n "$OFFSITE_BACKUP_DIR" ] || fail "OFFSITE_BACKUP_DIR обязателен и должен указывать на внешнее смонтированное хранилище"
[ -d "$OFFSITE_BACKUP_DIR" ] || fail "внешний каталог не найден: $OFFSITE_BACKUP_DIR"

if [ -z "$BACKUP_SET" ]; then
  BACKUP_SET=$(find "$BACKUP_DIR" -mindepth 1 -maxdepth 1 -type d -print | sort -r | head -1)
fi
[ -n "$BACKUP_SET" ] && [ -d "$BACKUP_SET" ] || fail "backup set не найден"
[ -f "$BACKUP_SET/postgres.dump" ] || fail "postgres.dump отсутствует"
[ -f "$BACKUP_SET/SHA256SUMS" ] || fail "SHA256SUMS отсутствует"

(
  cd "$BACKUP_SET"
  sha256sum -c SHA256SUMS
) >/dev/null || fail "checksum source backup не прошёл проверку"

NAME=$(basename "$BACKUP_SET")
DEST="$OFFSITE_BACKUP_DIR/$NAME"
TMP="$OFFSITE_BACKUP_DIR/.${NAME}.tmp.$$"
[ ! -e "$DEST" ] || fail "backup уже экспортирован: $DEST"
trap 'rm -rf "$TMP"' EXIT INT TERM
mkdir "$TMP"
cp -a "$BACKUP_SET"/. "$TMP"/
(
  cd "$TMP"
  sha256sum -c SHA256SUMS
) >/dev/null || fail "checksum экспортированной копии не прошёл проверку"
mv "$TMP" "$DEST"
trap - EXIT INT TERM

echo "backup_export_ok backup_set=$NAME destination=$DEST"
