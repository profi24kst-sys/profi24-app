# PROFI24KST CRM

Production-oriented CRM for the PROFI24KST service center.

The system covers the operational chain from intake to repair completion and accounting: orders, customers and equipment, six-role RBAC, branches, cash registers, finance, warehouse, procurement, diagnostics, approvals, parts, completion, warranty/rework, complaints and exception lifecycle, payroll/KPI, analytics, communications and audit trails.

## Roles

The supported role model is exactly:

- `OWNER` — Собственник;
- `SUPERVISOR` — Управляющий;
- `ACCOUNTANT` — Бухгалтер;
- `MANAGER` — Менеджер;
- `ENGINEER` — Инженер;
- `TRAINEE` — Стажёр.

A trainee is not a primary responsible engineer and works through mentor/order participation rules.

## Production rule

Do **not** use `.env.example` as a real production configuration. It intentionally contains placeholders and localhost URLs and must fail production preflight.

Do **not** use a raw `docker compose up` as the normal production deployment path.

The supported production procedure is documented in [`docs/PRODUCTION_RUNBOOK.md`](docs/PRODUCTION_RUNBOOK.md).

## Prepare production configuration

Create `.env.production` outside source control using `.env.example` only as a field list. Set at minimum:

- a unique strong `POSTGRES_PASSWORD`;
- a different long random `JWT_SECRET`;
- `NODE_ENV=production`;
- HTTPS `PUBLIC_BASE_URL`;
- HTTPS `CORS_ORIGIN` without wildcard or localhost;
- backup retention of at least 7 days.

Validate the file:

```bash
set -a
. ./.env.production
set +a
sh ops/preflight.sh
```

## First OWNER on a clean database

Current migrations do **not** create demo users or default passwords.

For a completely new database, start only PostgreSQL, build the API image and explicitly bootstrap the first owner with a strong password:

```bash
docker compose --env-file .env.production up -d db
docker compose --env-file .env.production build api
docker compose --env-file .env.production run --rm api \
  npm run bootstrap-owner -- owner@example.kz 'Use-A-Unique-Strong-Password-2026' 'Собственник'
```

Bootstrap refuses to create another owner when an active `OWNER` already exists. After the first owner exists, use normal CRM account administration.

There are **no supported default credentials** such as `profi24` in production. The production startup check also refuses known legacy weak passwords.

## Start production

```bash
ENV_FILE=.env.production sh ops/start-production.sh
```

This wrapper:

1. validates production secrets and URLs;
2. validates Docker Compose;
3. starts PostgreSQL;
4. migrates/checks account security;
5. requires an active OWNER and rejects known legacy weak credentials;
6. only then starts the complete CRM stack.

## Acceptance after deployment

```bash
BASE_URL=https://crm.example.kz sh ops/acceptance.sh
```

The probe checks every CRM backend service through nginx, not directly through container ports.

GitHub Actions additionally runs:

- `CRM CI` — syntax, finance, full CRM regression, build, recovery drill and authenticated smoke;
- `Production Acceptance` — starts the entire CRM service graph and checks every health endpoint through nginx, including non-root container and document-volume checks.

## Password policy

New/reset employee passwords are enforced by the backend and CLI:

- minimum 10 characters;
- must contain letters and digits;
- known weak/default passwords are rejected.

CLI reset uses the same policy:

```bash
docker compose --env-file .env.production run --rm api \
  npm run set-password -- employee@example.kz 'Another-Strong-Password-2026'
```

## Backup

A backup worker creates daily PostgreSQL custom-format dumps and upload archives. Each backup set contains `SHA256SUMS`.

Manual backup before a release:

```bash
docker compose --env-file .env.production run --rm backup sh /backup.sh
```

Check that the latest backup exists, is fresh and passes checksums:

```bash
docker compose --env-file .env.production run --rm \
  -v "$PWD/ops/backup-status.sh:/backup-status.sh:ro" \
  backup sh /backup-status.sh
```

A backup stored only on the same server is not sufficient protection against server/disk loss. Export a verified backup set to a mounted external/NAS location with `ops/export-backup.sh`; see the production runbook.

## Restore

Never test recovery by overwriting the live database. `ops/restore.sh` restores to a specified database, verifies checksums and refuses a non-empty target by default.

CRM CI performs a real automated drill:

`pg_dump → separate empty database → pg_restore → marker/table verification → prove non-empty restore is blocked`.

Full restore commands and emergency cutover rules are in [`docs/PRODUCTION_RUNBOOK.md`](docs/PRODUCTION_RUNBOOK.md).

## Main repair lifecycle

The operational lifecycle contains normal repair states plus documented exception workflows. The standard path is:

```text
NEW
→ ASSIGNED
→ ACCEPTED
→ DIAGNOSTICS
→ APPROVAL_REQUIRED
→ WAITING_PART / REPAIR
→ TESTING
→ PAYMENT_REQUIRED
→ CLOSED
```

Cancellation, holds, warranty/rework, complaints, purchase returns, payment refunds and other exceptions use documented procedures instead of destructive edits.

## Payroll and KPI

Payroll uses effective-dated compensation rules and immutable monthly revisions. Period lifecycle:

```text
DRAFT → CALCULATED → APPROVED → PAID → CLOSED
```

Approved payroll snapshots are immutable, KPI bonuses enter payroll once, payments are auditable cash movements, and payroll payouts are not double-counted in P&L.

## Security and audit baseline

- JWT access tokens expire;
- login is rate-limited;
- production preflight rejects unsafe secrets/origins;
- backend containers run as a non-root user;
- financial/order critical corrections are documented rather than deleted;
- six-role permissions are enforced server-side;
- manager/engineer/trainee scopes are constrained by branch/order participation;
- backup/restore is checksum-verified and CI-tested.

## Stacked implementation branches

Until the implementation stack is flattened, preserve dependency order:

1. Stage B — PR #3;
2. Stage B.2 — PR #5;
3. Stage C — PR #6;
4. Stage D — PR #7;
5. Stage E — PR #8.

Do not merge a later stage across an unmerged parent stage.
