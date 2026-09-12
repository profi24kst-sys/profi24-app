export const customerMergeStatements=[
  `CREATE TABLE IF NOT EXISTS customer_merge_aliases(
    source_customer_id INT PRIMARY KEY REFERENCES customers(id),
    target_customer_id INT NOT NULL REFERENCES customers(id),
    phone_norm TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CHECK(source_customer_id<>target_customer_id)
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_customer_merge_alias_phone ON customer_merge_aliases(phone_norm) WHERE phone_norm IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_customer_merge_alias_target ON customer_merge_aliases(target_customer_id)`,
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
  ,`CREATE OR REPLACE FUNCTION redirect_merged_customer_reference() RETURNS trigger AS $$
   DECLARE resolved_id INT;
   BEGIN
     IF NEW.customer_id IS NULL THEN RETURN NEW; END IF;
     PERFORM 1 FROM customers WHERE id=NEW.customer_id FOR KEY SHARE;
     WITH RECURSIVE chain(id,depth) AS (
       SELECT NEW.customer_id,0
       UNION ALL
       SELECT a.target_customer_id,chain.depth+1 FROM chain JOIN customer_merge_aliases a ON a.source_customer_id=chain.id WHERE chain.depth<32
     ) SELECT id INTO resolved_id FROM chain ORDER BY depth DESC LIMIT 1;
     NEW.customer_id=resolved_id;
     RETURN NEW;
   END $$ LANGUAGE plpgsql`,
  ...['requests','equipment','complaints','customer_feedback','customer_visit_confirmations','equipment_pickup_states','service_contracts'].flatMap(table=>[
    `DROP TRIGGER IF EXISTS trg_${table}_redirect_merged_customer ON ${table}`,
    `CREATE TRIGGER trg_${table}_redirect_merged_customer BEFORE INSERT OR UPDATE OF customer_id ON ${table} FOR EACH ROW EXECUTE FUNCTION redirect_merged_customer_reference()`
  ])
];
