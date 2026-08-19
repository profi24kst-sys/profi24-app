#!/bin/sh
set -eu
STAMP=$(date +%Y%m%d-%H%M%S)
DEST=${BACKUP_DIR:-/backups}
RETENTION_DAYS=${BACKUP_RETENTION_DAYS:-14}
mkdir -p "$DEST/$STAMP"
pg_dump "$DATABASE_URL" -Fc -f "$DEST/$STAMP/postgres.dump"
if [ -d /data/uploads ]; then tar -czf "$DEST/$STAMP/uploads.tar.gz" -C /data uploads; fi
sha256sum "$DEST/$STAMP"/* > "$DEST/$STAMP/SHA256SUMS"
find "$DEST" -mindepth 1 -maxdepth 1 -type d -mtime +"$RETENTION_DAYS" -exec rm -rf {} +
echo "backup_ok $STAMP"
