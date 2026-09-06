# PROFI24 CRM — Production Runbook

## Purpose
This is the supported path for provisioning, starting, checking, backing up and recovering the production CRM. Do not bypass the preflight, account-security or restore safeguards.

## 1. Prepare production environment
Create a production env file outside source control, for example `.env.production`.

Required minimum:
- `NODE_ENV=production`;
- strong `POSTGRES_PASSWORD` (16+ characters, no placeholders);
- strong `JWT_SECRET` (32+ characters, different from database password);
- HTTPS `PUBLIC_BASE_URL`;
- HTTPS `CORS_ORIGIN` without wildcard/localhost;
- `BACKUP_RETENTION_DAYS>=7`.

Validate without starting application services:

```sh
set -a
. ./.env.production
set +a
sh ops/preflight.sh
```

`.env.example` intentionally contains placeholders/localhost values and is expected to fail this production check.

## 2. Bootstrap the first OWNER on a clean database
Current migrations do not seed demo users or default credentials.

For a new database:

```sh
docker compose --env-file .env.production up -d db
docker compose --env-file .env.production build api
docker compose --env-file .env.production run --rm api \
  npm run bootstrap-owner -- owner@example.kz 'Use-A-Unique-Strong-Password-2026' 'Собственник'
```

`bootstrap-owner`:
- runs migrations first;
- enforces the same password policy as the API;
- assigns the active KST branch;
- refuses to run if an active OWNER already exists;
- refuses to reuse an existing email.

For an existing database, do not bootstrap again. Use normal user administration or `npm run set-password`.

## 3. Account-security check
The supported production start executes:

```sh
npm run production-user-check
```

It blocks startup when:
- there is no active OWNER;
- an active account still matches known legacy/default weak passwords such as `profi24`, `password`, `qwerty` or common numeric defaults.

Reset a password before startup when required:

```sh
docker compose --env-file .env.production run --rm api \
  npm run set-password -- employee@example.kz 'Another-Strong-Password-2026'
```

The backend and CLI both enforce at least 10 characters, letters + digits, and reject known weak values.

## 4. Start production

```sh
ENV_FILE=.env.production sh ops/start-production.sh
```

This sequence:
1. loads the env file;
2. runs `ops/preflight.sh`;
3. validates Docker Compose;
4. starts PostgreSQL only;
5. builds the API image and runs migration/account-security validation;
6. requires a safe active OWNER;
7. only then starts the complete CRM stack.

Do not use raw `docker compose up` as the normal production release path.

## 5. Post-start acceptance

```sh
BASE_URL=https://crm.example.kz sh ops/acceptance.sh
```

Acceptance probes all CRM backend services through nginx, including core API, warehouse, procurement, payroll, analytics, finance, documents, notifications, communications, approvals, workflow, operations, performance, KPI, profitability, pricing, pricebook, diagnostics, parts, completion, reliability, warranty, discipline, owner control, directory admin, order tasks, branches, cash registers and lifecycle.

For an additional authenticated core check, pass an already issued owner/service token:

```sh
BASE_URL=https://crm.example.kz ACCEPTANCE_TOKEN='<token>' sh ops/acceptance.sh
```

The independent `Production Acceptance` CI workflow also verifies that backend containers run as non-root and the document volume remains writable.

## 6. Backup
The backup worker runs daily in Docker Compose. A manual backup should be created before a release or risky maintenance:

```sh
docker compose --env-file .env.production run --rm backup sh /backup.sh
```

Each backup set contains:
- `postgres.dump` in PostgreSQL custom format;
- `uploads.tar.gz` when uploads exist;
- `SHA256SUMS` for integrity verification.

Default retention is 14 days and production preflight rejects retention shorter than 7 days.

## 7. Verify backup freshness and integrity

```sh
docker compose --env-file .env.production run --rm \
  -e BACKUP_DIR=/backups \
  -e MAX_BACKUP_AGE_HOURS=26 \
  -v "$PWD/ops/backup-status.sh:/backup-status.sh:ro" \
  backup sh /backup-status.sh
```

The check fails when the latest set is missing, older than the allowed age or fails `SHA256SUMS`.

## 8. Export backup off the application server
A backup in the local Docker volume does not protect against loss of the whole host/disk.

Mount a NAS/external/off-site destination and export the verified set:

```sh
mkdir -p /mnt/profi24-backups

docker compose --env-file .env.production run --rm \
  -e OFFSITE_BACKUP_DIR=/offsite \
  -v /mnt/profi24-backups:/offsite \
  -v "$PWD/ops/export-backup.sh:/export-backup.sh:ro" \
  backup sh /export-backup.sh
```

`export-backup.sh`:
- selects the latest set unless a specific set is supplied;
- verifies source checksums;
- copies into a temporary destination;
- verifies the copy again;
- atomically renames it into the final external backup directory;
- refuses to overwrite an already exported set.

For real disaster protection the external mount should live on different storage/host infrastructure from the CRM server.

## 9. Identify latest backup

```sh
docker compose --env-file .env.production run --rm backup sh -c 'ls -1dt /backups/* | head -1'
```

Record the exact backup-set path before recovery.

## 10. Safe database restore — preferred procedure
Never test recovery by overwriting the live database. Restore into a separate empty database first.

Example:

```sh
docker compose --env-file .env.production exec db createdb -U profi24 profi24_restore_check

BACKUP_SET=/backups/20260907-120000
RESTORE_URL='postgresql://profi24:<password>@db:5432/profi24_restore_check'

docker compose --env-file .env.production run --rm \
  -e RESTORE_CONFIRM=YES \
  -e RESTORE_DATABASE_URL="$RESTORE_URL" \
  -v "$PWD/ops/restore.sh:/restore.sh:ro" \
  backup sh /restore.sh "$BACKUP_SET"
```

`restore.sh` verifies `SHA256SUMS`, verifies the target connection and refuses a non-empty target by default.

## 11. Restore uploaded files
File restoration is opt-in and requires an explicit target root:

```sh
docker compose --env-file .env.production run --rm \
  -e RESTORE_CONFIRM=YES \
  -e RESTORE_DATABASE_URL="$RESTORE_URL" \
  -e RESTORE_UPLOADS=YES \
  -e RESTORE_UPLOAD_ROOT=/restore-data \
  -v "$PWD/ops/restore.sh:/restore.sh:ro" \
  -v "$PWD/restore-data:/restore-data" \
  backup sh /restore.sh "$BACKUP_SET"
```

A non-empty upload target is refused unless `RESTORE_ALLOW_NONEMPTY_UPLOADS=YES` is explicitly set.

## 12. In-place restore — emergency only
The supported normal path is restore to a new database, verify it, then perform a controlled cutover.

`restore.sh` refuses to overwrite a non-empty database. `RESTORE_ALLOW_NONEMPTY=YES` exists only for a deliberate disaster-recovery procedure during a maintenance window. Before using it:
1. stop application traffic;
2. create a fresh backup of the current state if possible;
3. record the selected backup set;
4. verify checksums;
5. confirm the recovery plan and rollback database;
6. restore;
7. run `ops/acceptance.sh` before reopening traffic.

## 13. Automated recovery proof
CRM CI contains a `recovery` job that:
1. migrates a clean source database;
2. writes a recovery marker;
3. creates a real `pg_dump` backup;
4. restores it to a separate empty database;
5. verifies the marker and critical CRM tables;
6. proves a second restore into the now non-empty database is rejected.

The `Production Acceptance` workflow starts every CRM service except the periodic backup worker and probes all services through nginx.

## 14. Release acceptance checklist
A production release is accepted only when:
- normal CRM CI is green;
- recovery drill is green;
- Production Acceptance is green;
- `ops/preflight.sh` passes the real production env;
- `npm run production-user-check` passes;
- latest local backup exists, is fresh and checksum-valid;
- latest critical backup has an off-server copy;
- `ops/acceptance.sh` passes after deployment;
- login and core authenticated operations are verified;
- no parent stacked PR is skipped during merge/rebase.

## 15. Current stacked merge order
Until the stack is flattened, preserve dependency order:
1. Stage B — PR #3;
2. Stage B.2 — PR #5;
3. Stage C — PR #6;
4. Stage D — PR #7;
5. Stage E — PR #8.
