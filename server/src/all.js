// Single-process launcher for every backend service.
//
// Historically each of these files was built and deployed as its own Docker
// container (25 containers plus db/web/backup) even though they only ever
// talked to each other through the shared Postgres database, never over
// HTTP. This runs them all inside one Node process instead: each module is
// untouched and still binds its own Fastify instance to its own port
// (see docker-compose.yml's old per-service PORT values), so nginx keeps
// routing to the exact same ports, just on one container ("api") instead of
// twenty-five.
//
// Import order matters: several modules run `CREATE TABLE ... REFERENCES`
// statements at startup that assume an earlier module already created the
// table they reference (the same order the old docker-compose depends_on
// chain enforced). Keep this order in sync with that dependency graph if a
// new service is added.
//
// A failure in one module is logged and does not stop the others from
// starting, so one broken service degrades instead of taking down the whole
// CRM the way a single-process merge otherwise would.
const SERVICES = [
  './index2.js',
  './warehouse.js',
  './payroll.js',
  './analytics.js',
  './finance.js',
  './documents.js',
  './notifications.js',
  './communications.js',
  './workflow.js',
  './discipline.js',
  './owner-control.js',
  './directory-admin.js',
  './order-tasks.js',
  './procurement.js',
  './engineer-performance.js',
  './kpi.js',
  './warranty.js',
  './pricing-guard.js',
  './profitability.js',
  './pricebook.js',
  './diagnostic-flow.js',
  './parts-orchestrator.js',
  './approvals-portal.js',
  './completion.js',
  './operations-center.js',
  './reliability.js',
];

let failed = 0;
for (const service of SERVICES) {
  try {
    await import(service);
    console.log(`[all] started ${service}`);
  } catch (err) {
    failed++;
    console.error(`[all] FAILED to start ${service}:`, err);
  }
}
console.log(`[all] ${SERVICES.length - failed}/${SERVICES.length} services started`);
