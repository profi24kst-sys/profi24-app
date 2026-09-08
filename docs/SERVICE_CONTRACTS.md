# Service contracts and planned maintenance

## Operational model

A service contract does not create a parallel order system. Each maintenance cycle is linked to a normal CRM request so the existing warehouse, finance, documents, engineer assignment, payroll and audit rules remain authoritative.

Lifecycle:

1. Create a contract for a customer and branch.
2. Add customer equipment with maintenance interval and next service date.
3. The communications process creates/ensures a maintenance cycle.
4. When the due date enters the reminder window, CRM creates an office task and queues a customer WhatsApp reminder.
5. The manager creates a normal CRM request from the maintenance screen; the cycle becomes `PLANNED` and stores the request id.
6. The cycle cannot be completed until the linked request itself is `CLOSED`.
7. Completing maintenance records the actual date, closes the reminder task and calculates the next service date from the actual completion date.
8. Skipping maintenance requires a documented reason and advances the schedule.

## Roles and branch isolation

- OWNER: all contracts and mutations.
- SUPERVISOR / MANAGER: contracts only in branches assigned to the user; can create and operate maintenance.
- ACCOUNTANT: read-only API access.
- ENGINEER / TRAINEE: continue working through the linked ordinary request and do not mutate service contracts directly.

## Audit and safety

Changes are recorded in `service_contract_audit`. Reminder queue entries use deterministic dedupe keys (`service-cycle:<id>:reminder`). Service completion is rejected before the linked order is closed. Existing PostgreSQL backup/restore covers all service-contract tables automatically.
