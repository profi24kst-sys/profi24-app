# PROFI24 CRM — Production Runbook

## Purpose
This runbook is the supported path for starting, checking, backing up and recovering the production CRM. Do not bypass the preflight or restore safeguards.

## 1. Prepare production environment
Create a production env file outside source control, for example `.env.production`.

Required minimum:
- `NODE_ENV=production`;
- strong `POSTGRES_PASSWORD` (16+ characters, no placeholders);
- strong `JWT_SECRET` (32+ characters, different from database password);
- HTTPS `PUBLIC_BASE_URL`;
- HTTPS `CORS_ORIGIN` without wildcard/localhost;
- `BACKUP_RETENTION_DAYS>=7`.

Validate without starting containers:

```sh
set -a
. ./.env.production
set +a
sh ops/preflight.sh
```

The production startup wrapper performs the same validation automatically.

## 2. Start production

```sh
ENV_FILE=.env.production sh ops/start-production.sh
```

This sequence:
1. loads the env file;
2. runs `ops/preflight.sh`;
3. validates Docker Compose;
4. only then starts the complete CRM stack.

Do not use raw `docker compose up` as the normal production release path.

## 3. Post-start acceptance

```sh
BASE_URL=https://crm.example.kz sh ops/acceptance.sh
```

Acceptance probes all CRM backend services through nginx, including core API, warehouse, procurement, payroll, analytics, finance, documents, notifications, communications, approvals, workflow, operations, performance, KPI, profitability, pricing, pricebook, diagnostics, parts, completion, reliability, warranty, discipline, owner control, directory admin, order tasks, branches, cash registers and lifecycle.

For an additional authenticated core check, pass an already issued owner/service token:

```sh
BASE_URL=https://crm.example.kz ACCEPTANCE_TOKEN='<token>' sh ops/acceptance.sh
```

## 4. Backup
The backup worker runs daily in Docker Compose. A manual backup can be created before a release or risky maintenance:

```sh
docker compose --env-file .env.production run --rm backup sh /backup.sh
```

Each backup set contains:
- `postgres.dump` in PostgreSQL custom format;
- `uploads.tar.gz` when uploads exist;
- `SHA256SUMS` for integrity verification.

Default retention is 14 days and production preflight rejects retention shorter than 7 days.

## 5. Identify latest backup

```sh
docker compose --env-file .env.production run --rm backup sh -c 'ls -1dt /backups/* | head -1'
```

Record the exact backup-set path before starting recovery.

## 6. Safe database restore — preferred procedure
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

## 7. Restore uploaded files
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

## 8. In-place restore — emergency only
The supported normal path is restore to a new database, verify it, then perform a controlled cutover.

`restore.sh` refuses to overwrite a non-empty database. `RESTORE_ALLOW_NONEMPTY=YES` exists only for a deliberate disaster-recovery procedure during a maintenance window. Before using it:
1. stop application traffic;
2. create a fresh backup of the current state if possible;
3. record the selected backup set;
4. verify checksums;
5. confirm the recovery plan and rollback database;
6. restore;
7. run `ops/acceptance.sh` before reopening traffic.

## 9. Automated recovery proof
CRM CI contains a `recovery` job that:
1. migrates a clean source database;
2. writes a recovery marker;
3. creates a real `pg_dump` backup;
4. restores it to a separate empty database;
5. verifies the marker and critical CRM tables;
6. proves a second restore into the now non-empty database is rejected.

The `Production Acceptance` workflow starts every CRM service (except the periodic backup worker) and probes all services through nginx.

## 10. Release acceptance checklist
A production release is accepted only when:
- normal CRM CI is green;
- recovery drill is green;
- Production Acceptance is green;
- `ops/preflight.sh` passes the real production env;
- latest backup exists and checksum is valid;
- `ops/acceptance.sh` passes after deployment;
- login and core authenticated operations are verified;
- no parent stacked PR is skipped during merge/rebase.

## 11. Current stacked merge order
Until the stack is flattened, preserve dependency order:
1. Stage B — PR #3;
2. Stage B.2 — PR #5;
3. Stage C — PR #6;
4. Stage D — PR #7;
5. Stage E — PR #8.
