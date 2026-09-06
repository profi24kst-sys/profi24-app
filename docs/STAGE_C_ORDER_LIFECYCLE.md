# Stage C — Order lifecycle and exception workflows

## Goal
Make every real service-center order state explicit, auditable and recoverable without editing history or abusing generic statuses.

## Canonical lifecycle
`NEW → ASSIGNED → ACCEPTED → DIAGNOSTICS → APPROVAL_REQUIRED → REPAIR → TESTING → PAYMENT_REQUIRED → CLOSED`.

`WAITING_PART` remains a repair-flow state for an ordered/expected part.

## Exception workflow model
Stage C adds an explicit hold/reopen layer instead of multiplying mutually incompatible status values.

### Order holds
An order may have at most one active hold. A hold contains:
- reason code;
- human comment;
- who started it and when;
- optional expected/resume date;
- who resumed it and when;
- immutable audit history.

Initial reason codes:
- `WAITING_CUSTOMER` — waiting for customer response/action;
- `WAITING_APPROVAL` — waiting for approval of price/work;
- `WAITING_PART` — waiting for part/supply;
- `REPEAT_VISIT` — repeat visit is required;
- `EXTERNAL_SERVICE` — external contractor/workshop dependency;
- `OTHER` — exceptional documented reason.

Starting a hold pauses SLA. Resuming closes the hold and extends the SLA by the exact paused duration. Historical holds are never deleted.

### Reopen / warranty / rework
A `CLOSED` order is never silently returned to repair. Reopening creates an explicit event with reason and relation to the original repair.

Reopen reason codes:
- `WARRANTY_REWORK` — warranty rework attributable to the previous repair;
- `REPEAT_FAILURE` — repeat failure requiring investigation;
- `CUSTOMER_RETURN` — customer returned after completed repair;
- `ADMIN_CORRECTION` — owner-authorized correction of an incorrectly closed order.

Reopening must preserve payments, parts, works and the original close event. It creates a new active service cycle/audit event; it must not erase history.

### Return without repair
Return without repair is a documented terminal workflow, not a generic cancel. It requires a reason and handover/return confirmation. Any unresolved financial or material obligations must block finalization.

## Permissions
- OWNER: all lifecycle and exception actions; administrative reopen.
- SUPERVISOR: operational hold/resume/repeat-visit/warranty coordination; no financial override.
- MANAGER: customer/approval/part/repeat-visit holds and resume within accessible branch/orders.
- ENGINEER: technical hold request/repeat-visit participation on accessible orders; cannot financially finalize/cancel.
- ACCOUNTANT: read lifecycle; finance actions only, no technical state mutation.
- TRAINEE: read accessible lifecycle and append allowed notes/files only.

## Invariants
1. Closed/cancelled orders remain immutable except through a documented dedicated procedure.
2. Exactly one active hold per order.
3. SLA pause/resume is server-calculated; clients never submit accumulated pause duration.
4. Every hold, resume, reopen, warranty/rework and return-without-repair action writes `request_history`.
5. Branch and participant access rules from Stage B/B.2 remain authoritative.
6. A trainee can never become the accountable engineer through an exception workflow.
7. Finance/warehouse/procurement guards remain active while an order is on hold.
8. Reopen never deletes or rewrites prior payment/part/work history.
9. Terminal workflows must fail on unresolved material/financial blockers instead of silently correcting them.

## Acceptance scenarios
- Manager puts an active order on `WAITING_CUSTOMER`; SLA pauses.
- Manager resumes it; SLA deadline extends by paused duration and audit records both actions.
- A second active hold is rejected with conflict.
- Engineer can create an allowed technical/repeat-visit hold only for an accessible order.
- Engineer cannot reopen a closed order or bypass payment/cancellation procedures.
- Supervisor coordinates a warranty rework while financial overrides remain forbidden.
- Accountant sees lifecycle but cannot mutate diagnosis/repair/hold/reopen state.
- Trainee cannot hold/resume/reopen/finalize an order.
- Closed order can only be reopened by the dedicated procedure with a documented reason.
- Return without repair is blocked while money/material obligations remain unresolved.
- Every action is branch-safe and appears in request history.
