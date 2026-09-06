# Stage D — Payroll, KPI and auditable accruals

## Goal
Turn payroll and KPI from live recalculated dashboards into an accounting-grade subsystem where a closed payroll period remains reproducible and cannot change retroactively when rules, KPI plans or orders are edited later.

## Problems in the legacy implementation
- historical payroll is recalculated with the latest `payroll_rules` values;
- `payroll_adjustments` can be physically deleted;
- there is no payroll period state or approval/close workflow;
- KPI bonus is calculated separately and is not posted into payroll;
- manager KPI uses engineer-oriented statistics;
- payroll service is OWNER-only although RBAC already grants payroll permissions to ACCOUNTANT;
- KPI report access is not permission-based;
- no immutable calculation snapshot exists.

## Stage D model

### Compensation rules
Rules are versioned by effective date. Updating compensation inserts a new rule version; old versions remain immutable.

### Payroll period
A payroll period belongs to a branch and calendar month.

States:
`DRAFT → CALCULATED → APPROVED → PAID → CLOSED`.

- DRAFT: inputs may still change;
- CALCULATED: one or more immutable calculation revisions exist;
- APPROVED: current calculation is approved by OWNER; recalculation is blocked;
- PAID: ACCOUNTANT records payroll settlement;
- CLOSED: OWNER closes the accounting period permanently.

### Accrual snapshot
Each calculation creates a new revision of per-employee accruals. Previous revisions are never updated or deleted.

Components:
- base salary;
- order commission;
- work commission;
- gross-profit commission;
- approved KPI bonus;
- manual adjustment documents;
- total accrual.

Inputs and selected rule/KPI references are stored with the snapshot.

### Adjustments
A bonus/penalty/other adjustment is an immutable document. Correction is a new reversal document linked with `reversal_of`; physical deletion is prohibited.

### KPI
KPI results are calculated separately for the employee role and stored as revisioned snapshots. An approved KPI result can feed payroll exactly once through the payroll calculation revision.

## Permissions target
- OWNER: rules, calculation, approval, close, full reports;
- ACCOUNTANT: payroll view/manage, calculation and payment operations, no OWNER approval/close override;
- SUPERVISOR: operational KPI management and aggregate payroll summary without unrestricted salary correction;
- MANAGER: own KPI view;
- ENGINEER: own KPI/payroll self-view where enabled;
- TRAINEE: no payroll administration; self-view can be added only if explicitly configured.

## Invariants
1. No destructive delete of payroll documents or accrual snapshots.
2. Editing a rule never changes an already approved/closed payroll period.
3. Every calculation revision is reproducible from stored inputs.
4. KPI bonus is included at most once in a payroll revision.
5. OWNER approval is distinct from ACCOUNTANT calculation/payment.
6. Payroll periods are branch-aware.
7. Historical accruals remain accessible after employee deactivation.
8. Closed periods cannot be recalculated.
9. Every state transition writes an immutable event.
10. All money is rounded server-side to 0.01 KZT.

## Acceptance target
- create versioned rule and prove previous version remains unchanged;
- calculate monthly period twice and preserve both revisions;
- approve revision and block recalculation;
- post adjustment, reverse it, reject DELETE;
- calculate correct ENGINEER and MANAGER KPI separately;
- approve KPI and include bonus exactly once in payroll;
- ACCOUNTANT can calculate/pay but cannot approve/close;
- SUPERVISOR gets aggregate summary, not payroll correction powers;
- employee sees only own allowed KPI/payroll information;
- branch isolation verified by HTTP tests;
- Docker/CI/smoke remain green.
