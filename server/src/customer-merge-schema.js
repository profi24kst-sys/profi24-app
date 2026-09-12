export const customerMergeStatements=[
  `CREATE TABLE IF NOT EXISTS customer_merge_audit(
    id BIGSERIAL PRIMARY KEY,
    source_customer_id INT NOT NULL REFERENCES customers(id),
    target_customer_id INT NOT NULL REFERENCES customers(id),
    actor_id INT NOT NULL REFERENCES users(id),
    reason TEXT NOT NULL,
    source_snapshot JSONB NOT NULL,
    target_before JSONB NOT NULL,
    target_after JSONB NOT NULL,
    moved_counts JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CHECK(source_customer_id<>target_customer_id)
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_customer_merge_source ON customer_merge_audit(source_customer_id)`,
  `CREATE INDEX IF NOT EXISTS idx_customer_merge_target ON customer_merge_audit(target_customer_id,created_at DESC)`,
  `CREATE OR REPLACE FUNCTION customer_merge_audit_immutable() RETURNS trigger AS $$
   BEGIN
     RAISE EXCEPTION 'Журнал объединения клиентов нельзя изменять или удалять' USING ERRCODE='P2401';
   END $$ LANGUAGE plpgsql`,
  `DROP TRIGGER IF EXISTS trg_customer_merge_audit_immutable ON customer_merge_audit`,
  `CREATE TRIGGER trg_customer_merge_audit_immutable BEFORE UPDATE OR DELETE ON customer_merge_audit FOR EACH ROW EXECUTE FUNCTION customer_merge_audit_immutable()`
];
