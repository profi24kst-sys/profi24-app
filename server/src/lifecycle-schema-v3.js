export const lifecycleV3Statements=[
  `CREATE TABLE IF NOT EXISTS request_returns_without_repair(
    id BIGSERIAL PRIMARY KEY,
    request_id INT NOT NULL UNIQUE REFERENCES requests(id),
    cancellation_id BIGINT REFERENCES request_cancellations(id),
    reason TEXT NOT NULL,
    document_reference TEXT NOT NULL,
    handover_reference TEXT NOT NULL,
    expense_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
    created_by INT NOT NULL REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    idempotency_key TEXT NOT NULL UNIQUE,
    request_fingerprint TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_request_returns_without_repair_created ON request_returns_without_repair(created_at DESC)`,
  `DROP TRIGGER IF EXISTS trg_request_returns_without_repair_guard ON request_returns_without_repair`,
  `CREATE TRIGGER trg_request_returns_without_repair_guard BEFORE UPDATE OR DELETE ON request_returns_without_repair FOR EACH ROW EXECUTE FUNCTION lifecycle_document_guard()`
];
