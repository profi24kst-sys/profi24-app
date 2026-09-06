# Stage D — Payroll, KPI and auditable accruals

## Goal
Turn payroll and KPI from live recalculated dashboards into an accounting-grade subsystem where an approved payroll period remains reproducible and cannot change retroactively when rules, KPI plans, adjustments or later operational corrections are made.

## Legacy problems removed by Stage D
- historical payroll was recalculated with the latest `payroll_rules` values;
- future compensation terms could affect current pricing calculations;
- `payroll_adjustments` could be physically deleted;
- there was no payroll period state, revision, approval, settlement or close workflow;
- KPI bonus was calculated separately and did not feed payroll safely;
- manager KPI reused engineer-oriented statistics;
- payroll service was OWNER-only despite ACCOUNTANT payroll permissions;
- KPI report access was not aligned with the six-role RBAC model;
- salary payment risked being counted as a second P&L expense after payroll accrual;
- P&L recalculated old payroll from mutable operational data instead of using an approved payroll snapshot.

## Implemented model

### 1. Effective-dated compensation rules
Compensation is stored in immutable `payroll_rule_versions` with an `effective_from` month.

Components:
- base salary;
- order percent;
- work percent;
- gross-profit percent;
- active flag;
- reason and author.

A new version never rewrites an old one. `calculatePayroll()` resolves the version that was effective for the requested month. A future rule therefore cannot affect an earlier month.

After a payroll period containing an employee has reached `APPROVED`, `PAID` or `CLOSED`, a rule whose effective date would reach that locked period cannot be inserted. This is enforced both by the Payroll API and a PostgreSQL trigger, so direct SQL cannot backdate compensation either.

### 2. Payroll period
A payroll period belongs to one branch and one calendar month.

Canonical states:

`DRAFT → CALCULATED → APPROVED → PAID → CLOSED`

Allowed exceptional settlement transition:

`PAID → APPROVED` only when a documented payroll payment is reversed.

Meaning:
- `DRAFT` — inputs may still change;
- `CALCULATED` — at least one immutable calculation revision exists;
- `APPROVED` — OWNER approved the active revision; recalculation and input changes are blocked;
- `PAID` — documented payroll payments cover the approved amount;
- `CLOSED` — OWNER permanently closes the payroll month.

PostgreSQL enforces the allowed transitions and prevents rewriting approved calculation fields.

### 3. Immutable calculation revisions
Every calculation increments `calculation_revision` and inserts new `payroll_accruals` rows. Previous revisions are never updated or deleted.

Each employee accrual stores:
- rule version used;
- approved KPI snapshot used;
- base salary;
- order commission;
- work commission;
- gross-profit commission;
- KPI bonus;
- adjustments;
- total;
- calculation inputs/fingerprint;
- branch, revision, author and timestamp.

### 4. Payroll adjustments and reversal
`BONUS`, `PENALTY` and `OTHER` are immutable accounting documents.

Rules:
- physical DELETE is forbidden;
- editing a posted document is forbidden;
- correction is a new document linked with `reversal_of`;
- every new document belongs to a branch/month;
- after the payroll period is `APPROVED`, `PAID` or `CLOSED`, new adjustments are rejected by both API and DB trigger.

### 5. KPI plans and result snapshots
KPI is role-correct:
- ENGINEER statistics use `engineer_id` responsibility;
- MANAGER statistics use `manager_id` responsibility.

Metrics include configured targets for jobs, revenue, average check, conversion, SLA, quality, task discipline and bonus limit.

Calculation creates revisioned `kpi_result_snapshots`. OWNER approval freezes the selected result. The approved KPI bonus feeds payroll exactly once through the payroll accrual revision.

After an employee KPI result is approved, the plan/maximum bonus for that employee/month cannot be changed. KPI is also locked once the corresponding payroll period has been approved.

### 6. Real payroll settlement
Payroll settlement is not a cosmetic status. ACCOUNTANT/OWNER posts an actual payment from a selected finance account.

Each payment stores:
- payroll period and revision;
- employee;
- branch;
- finance account;
- linked finance transaction;
- amount;
- document reference;
- idempotency key;
- author/time.

Partial payments are supported. Overpayment is rejected. The period becomes `PAID` only when total effective payments equal the approved amount.

A posted payroll payment is immutable. A mistake is corrected with a linked reversal document, which restores the money in the finance account and returns a fully paid period to `APPROVED` until the missing amount is paid again.

A `CLOSED` period cannot be reversed.

### 7. Payroll settlement versus P&L
Payroll is an accrual expense. Paying it later must not reduce profit a second time.

Therefore the finance journal uses the dedicated `PAYROLL_PAYMENT` kind:
- it reduces the selected cash/bank account;
- it is auditable and reversible;
- `affects_pnl = false`;
- payroll expense enters P&L through payroll accrual, not through settlement cash movement.

Regression tests explicitly prove that payroll payment and its reversal do not create an extra `PAYROLL` row in `finance_pnl_transactions`.

### 8. Approved payroll snapshot in P&L
For each branch/month:
- if payroll is `APPROVED`, `PAID` or `CLOSED`, P&L sums the immutable active `payroll_accruals` revision;
- if payroll is not yet approved, P&L may use the live calculation for that branch.

This means a later documented operational correction or late imported order can change operational reports without silently changing the salary expense that OWNER already approved for the accounting month.

### 9. Pricing guard compatibility
Pricing no longer reads the legacy current-value `payroll_rules` table for commission estimates. It resolves the latest `payroll_rule_versions` row whose `effective_from <= CURRENT_DATE`.

Example protected by regression:
- September engineer commission = 10%;
- future October commission = 50%;
- September pricing must still estimate 10%.

SUPERVISOR also inherits the intended MANAGER pricing-check access; pricing settings remain OWNER-only.

## Six-role permissions

### OWNER
- full payroll details;
- create compensation rule versions;
- calculate payroll if needed;
- create/reverse adjustments;
- approve payroll revision;
- post/reverse payroll payments;
- permanently close a fully paid month;
- full KPI view/manage/approve;
- full P&L visibility.

### ACCOUNTANT
- full payroll view;
- calculate/recalculate an unlocked period;
- create/reverse adjustments;
- post/reverse payroll payments;
- full KPI read-only visibility;
- cannot create compensation rules;
- cannot approve payroll;
- cannot close payroll month;
- cannot approve KPI.

### SUPERVISOR
- aggregate FOT/payroll summary only, without employee salary administration;
- full operational KPI view/manage;
- cannot calculate/pay/adjust/approve/close payroll;
- cannot approve KPI result.

### MANAGER
- own approved payroll self-view only;
- own KPI view only;
- no access to payroll periods, rules, other employees' salaries or payroll mutations.

### ENGINEER
- own approved payroll self-view only;
- own KPI view only;
- no payroll administration.

### TRAINEE
- own approved payroll self-view only;
- no payroll administration;
- no KPI administration/global KPI view.

## UI
`web/payroll-addon.jsx` now exposes three distinct surfaces from the same module:
- OWNER/ACCOUNTANT — `Зарплаты и начисления`;
- SUPERVISOR — aggregate `ФОТ`;
- MANAGER/ENGINEER/TRAINEE — `Моя зарплата`.

Self mode calls only `/payroll-api/v1/self`; it does not request rules, payroll periods or other employees' salary rows.

`web/kpi-addon.jsx` is permission-aware:
- OWNER approves snapshots;
- SUPERVISOR manages plans/calculations;
- ACCOUNTANT reads all KPI;
- MANAGER/ENGINEER see only their own KPI.

## Accounting and security invariants
1. Payroll rule versions, accrual revisions, payroll events and posted payments are never destructively edited.
2. A locked payroll month cannot receive backdated rule changes or new adjustments.
3. KPI plans/results cannot be rewritten after approval.
4. Every payroll calculation revision is preserved.
5. KPI bonus enters an accrual at most once through one approved KPI snapshot reference.
6. OWNER approval is distinct from ACCOUNTANT calculation/payment.
7. Payroll periods and payouts are branch-bound.
8. A payroll payout account must belong to the payroll period branch.
9. Overpayment is rejected.
10. Payout reversal restores cash and payroll debt; it never deletes history.
11. `PAYROLL_PAYMENT` changes cash but does not double-count P&L expense.
12. Approved payroll expense in P&L comes from the locked accrual snapshot.
13. Employee self-view returns only the authenticated employee's approved accrual.
14. Closed payroll periods cannot be recalculated, paid again, reversed or rewritten.
15. Every important state transition writes an immutable payroll event.

## Automated acceptance
The mandatory `npm run test:crm` suite includes dedicated Stage D regressions for:
- historical/effective compensation rules;
- API and DB backdate protection;
- adjustment reversal and direct-SQL late-adjustment protection;
- immutable calculation revisions;
- payroll approval locks;
- correct ENGINEER versus MANAGER KPI responsibility;
- KPI self-scope and approval/plan locks;
- approved KPI bonus included exactly once;
- real partial/full payroll settlement;
- overpayment protection;
- idempotent payroll payments;
- payout reversal and permanent close;
- no payroll settlement double-count in P&L;
- approved payroll snapshot stability in P&L;
- six-role payroll HTTP visibility boundaries;
- effective payroll percentage in pricing and SUPERVISOR pricing access.

## Production smoke
CRM CI production smoke starts the real Docker services:
- core API;
- lifecycle;
- payroll;
- KPI (and its workflow dependency);
- web/nginx.

It verifies:
- core/lifecycle/payroll/KPI health through nginx;
- authenticated OWNER core API;
- authenticated lifecycle API;
- authenticated payroll periods API;
- authenticated KPI report API;
- PostgreSQL reachability and Stage D tables.

PR #7 remains Draft while stacked on still-unmerged Stage C. Merge/rebase order remains Stage B → Stage B.2 → Stage C → Stage D.
