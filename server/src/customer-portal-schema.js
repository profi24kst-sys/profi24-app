export const customerPortalStatements=[
`CREATE TABLE IF NOT EXISTS customer_portal_links(
 id BIGSERIAL PRIMARY KEY,
 customer_id INT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
 source_request_id INT NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
 token_hash TEXT NOT NULL UNIQUE,
 created_by INT NOT NULL REFERENCES users(id),
 scope_branch_ids INT[],
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 expires_at TIMESTAMPTZ NOT NULL,
 revoked_at TIMESTAMPTZ,
 last_used_at TIMESTAMPTZ,
 CHECK(expires_at>created_at),
 CHECK(scope_branch_ids IS NULL OR cardinality(scope_branch_ids)>0)
)`,
`DO $$
 BEGIN
  IF NOT EXISTS(
   SELECT 1 FROM information_schema.columns
   WHERE table_schema='public' AND table_name='customer_portal_links' AND column_name='scope_branch_ids'
  ) THEN
   ALTER TABLE customer_portal_links ADD COLUMN scope_branch_ids INT[];
   UPDATE customer_portal_links l
    SET scope_branch_ids=ARRAY[r.branch_id]::int[]
    FROM users u,requests r
    WHERE l.created_by=u.id
      AND l.source_request_id=r.id
      AND u.role='MANAGER'
      AND l.scope_branch_ids IS NULL
      AND r.branch_id IS NOT NULL;
  END IF;
 END $$`,
`CREATE INDEX IF NOT EXISTS idx_customer_portal_customer ON customer_portal_links(customer_id,created_at DESC)`,
`CREATE INDEX IF NOT EXISTS idx_customer_portal_active ON customer_portal_links(customer_id,expires_at) WHERE revoked_at IS NULL`
];
