# Stage C — Order lifecycle and exception workflows

## Status
Stage C implementation is functionally complete on `feature/order-lifecycle-exceptions`.

Control point before this documentation update: `bd507c7bd9c4473d08bb49fb3e86f8e17f82a290`.
GitHub Actions run `825` passed both `validate` and the extended `smoke` job, including real startup and authenticated health/API checks for the lifecycle service.

The PR remains stacked on Stage B.2 and therefore stays Draft until the parent branches are merged/rebased in order.

## Goal
Make every real service-center order state explicit, auditable and recoverable without rewriting history or abusing generic statuses.

## Canonical lifecycle
`NEW → ASSIGNED → ACCEPTED → DIAGNOSTICS → APPROVAL_REQUIRED → REPAIR → TESTING → PAYMENT_REQUIRED → CLOSED`.

Existing repair statuses remain the operational state machine. Stage C adds immutable exception documents around it instead of multiplying conflicting status values.

## Implemented model

### 1. Documented holds / waiting
An order may have at most one active hold in `request_holds`.

Supported types:
- `WAITING_CUSTOMER` — waiting for customer response/action;
- `WAITING_APPROVAL` — waiting for approval;
- `WAITING_PART` — waiting for part/supply;
- `REPEAT_VISIT` — another visit is required;
- `EXTERNAL_SERVICE` — external contractor/workshop dependency;
- `WAITING_DELIVERY` — delivery/logistics dependency;
- `OTHER` — documented exceptional reason.

Every hold stores reason, responsible employee, expected date, author, start time, previous order status and previous SLA deadline. Resuming requires a documented resolution and stores author/time of resume.

Only one active hold is allowed. Completed holds cannot be rewritten or deleted.

### 2. SLA pause/resume
When `pause_sla=true`, the service clears the live SLA deadline while the hold is active and restores it by adding the exact database-calculated paused duration on resume.

The client never supplies accumulated pause duration.

### 3. Hold mutation guard
The shared `requireOrder` guard checks active holds. While an order is on hold, repair mutations such as diagnosis, works and parts are blocked with `ORDER_ON_HOLD`.

Append-only evidence remains available where explicitly allowed, for example notes/comments/documents. Payment/resume and other dedicated correction routes keep their own controlled exceptions.

### 4. Repeat visits
`request_visit_attempts` stores immutable numbered visit attempts with scheduled time, primary engineer, outcome, reason, creator and completion author/time.

Supported outcomes:
- `COMPLETED`;
- `NO_ACCESS`;
- `CUSTOMER_NO_SHOW`;
- `REPEAT_REQUIRED`;
- `CANCELLED`.

`REPEAT_REQUIRED` automatically creates a `REPEAT_VISIT` hold and pauses SLA. A completed visit result cannot be edited or deleted.

### 5. Rework and warranty rework
A closed original order is not rolled back into repair.

`request_order_links` creates an immutable parent/child relation and a new child request:
- `REWORK` — ordinary repeat repair;
- `WARRANTY_REWORK` — warranty rework.

The child keeps `original_request_id`, branch, customer/equipment and valid responsible staff where possible. The original closed order keeps its original status, close timestamp, payments, works, parts and totals.

`WARRANTY_REWORK` requires an active warranty card and is restricted to OWNER/SUPERVISOR. MANAGER cannot declare a repair warranty rework independently.

### 6. Administrative correction / documented reopen
Stage C reuses the existing OWNER-only `owner-control` correction procedure instead of creating a second reopen mechanism.

A closed order can enter an explicit `owner_order_corrections` session. The original status/close timestamp and reason are recorded. Payments remain immutable; work/part corrections are individually audited; closing the correction runs the normal close procedure and payment checks again.

Cancelled orders cannot be reopened through ordinary editing.

### 7. Return without repair
Return without repair is a dedicated OWNER terminal workflow, not a generic status edit.

It requires:
- a documented reason/category;
- a document/reference for the return;
- confirmation that the equipment was handed back to the customer;
- normal cancellation financial/material readiness.

The existing safe cancellation procedure blocks completion while customer money remains unreturned or paid purchases remain unresolved. Documented expenses require explicit acknowledgement.

The resulting return document is immutable and idempotent. Repeating the same operation key returns the existing result instead of creating another terminal document.

### 8. Cancellation reconciliation
When an order is cancelled through the documented cancellation procedure, lifecycle reconciliation automatically:
- completes an active hold as cancelled;
- cancels remaining scheduled visit attempts;
- preserves the lifecycle documents and audit trail.

This prevents cancelled orders from remaining in active exception queues.

### 9. Exception control center
The lifecycle service exposes a control center with active/overdue holds and scheduled/overdue visits.

MANAGER results are branch-scoped through `user_branches`; OWNER/SUPERVISOR see the broader operational contour according to RBAC.

UI integration:
- `Заказ 360` has a `Жизненный цикл` block;
- office users can create/resume holds and schedule repeat visits according to permission;
- engineers can create allowed technical holds and record their visit outcomes;
- accountant/trainee receive read-only lifecycle visibility within normal order access;
- OWNER receives the terminal return-without-repair action;
- `Контроль заказов` is registered in the Work navigation and uses the common panel lifecycle so it closes correctly when navigating elsewhere.

### 10. Runtime service
Dedicated service:
- container: `lifecycle`;
- internal port: `8108`;
- nginx API: `/lifecycle-api/`;
- health endpoint: `/lifecycle-health`.

Port `8107` remains reserved for `cashregister`; Stage C does not conflict with it.

## Role boundaries
- **OWNER** — all lifecycle actions, warranty/rework, return without repair, administrative correction.
- **SUPERVISOR** — broad operational hold/resume/repeat visit and warranty coordination; no finance override.
- **MANAGER** — operational holds/resume/repeat visits/rework within accessible branches; cannot independently create warranty rework or owner terminal correction.
- **ENGINEER** — accessible-order technical holds (`WAITING_PART`, `REPEAT_VISIT`, `EXTERNAL_SERVICE`, `OTHER`) and own visit outcomes; no finance/cancel/reopen.
- **ACCOUNTANT** — lifecycle read visibility plus finance actions from the finance permission model; no technical lifecycle mutation.
- **TRAINEE** — lifecycle read visibility only on accessible mentor/participant orders; notes/files remain governed by Stage B RBAC.

## Invariants
1. Closed/cancelled orders are immutable except through dedicated documented procedures.
2. Exactly one active hold per order.
3. SLA pause duration is calculated server-side/database-side.
4. Holds, resumes, visits, rework links, terminal returns and reconciliations are auditable.
5. Branch and participant access from Stage B/B.2 remains authoritative.
6. A trainee can never become primary accountable engineer through Stage C.
7. Active holds block normal repair mutation across services through shared order access.
8. Rework/warranty rework never rewrites the original repair history.
9. Financial/material blockers fail terminal workflows instead of being silently corrected.
10. Completed lifecycle documents are immutable.
11. Cancellation leaves no active lifecycle hold or scheduled visit behind.

## Automated acceptance
`npm run test:crm` includes Stage C regressions for:
- hold creation/resume and exact SLA handling;
- accountant/trainee negative permissions;
- engineer technical-hold restrictions;
- automatic `REPEAT_VISIT` hold after `REPEAT_REQUIRED`;
- immutable holds/visit outcomes/order links;
- rework child creation without original-order mutation;
- warranty active/inactive rules and OWNER/SUPERVISOR vs MANAGER access;
- manager branch isolation for lifecycle details and exception center;
- active-hold blocking of real `index2` diagnosis/works/parts while allowing append-only notes;
- return-without-repair terminal checks and replay/idempotency;
- cancellation reconciliation of active holds and scheduled visits.

## CI acceptance
Run `825` for control point `bd507c7bd9c4473d08bb49fb3e86f8e17f82a290` passed:
- backend syntax for every service;
- auditable finance tests;
- order + CRM/RBAC/branch/lifecycle regressions;
- web dependency install/build;
- Docker Compose validation;
- build of all service images;
- extended smoke with `db + api + ownercontrol + lifecycle + web`;
- core and lifecycle health;
- ephemeral OWNER creation;
- authenticated core API and authenticated lifecycle exception API;
- DB reachability and clean shutdown.

## Stage C exit criteria
Stage C is considered functionally complete when the latest documentation-only head also remains green. PR #6 must remain Draft while its parent Stage B.2/Stage B stack is still unmerged; merge/rebase the stack in dependency order before promoting this PR.
