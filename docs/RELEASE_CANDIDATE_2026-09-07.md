# PROFI24 CRM release candidate — 2026-09-07

This marker records the final integration gate for merging the complete CRM stack into `main`.

## Included stages

- auditable financial accounts and order finance;
- six-role RBAC and trainee/mentor model;
- branches, cash responsibility, warehouse and procurement boundaries;
- complete order lifecycle and exception workflows;
- payroll, KPI and immutable accrual periods;
- production authentication, attachment hardening, backup/recovery and deterministic dependency controls.

## Final merge gate

The release branch must pass, against `main`, all required GitHub Actions workflows:

- CRM CI, including validate, recovery and authenticated smoke;
- Operational Safety;
- Dependency Security;
- Production Acceptance.

Only after all checks are green on the exact release-candidate head may the pull request be marked ready and merged into `main`.

Production deployment is a separate post-merge operation and requires the real server environment, HTTPS/TLS endpoint, persistent backup destination, production secrets and post-deploy verification.
