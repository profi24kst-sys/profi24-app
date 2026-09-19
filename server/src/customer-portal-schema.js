export const customerPortalStatements=[
`CREATE TABLE IF NOT EXISTS customer_portal_links(
 id BIGSERIAL PRIMARY KEY,
 customer_id INT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
 source_request_id INT NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
 token_hash TEXT NOT NULL UNIQUE,
 created_by INT NOT NULL REFERENCES users(id),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 expires_at TIMESTAMPTZ NOT NULL,
 revoked_at TIMESTAMPTZ,
 last_used_at TIMESTAMPTZ,
 CHECK(expires_at>created_at)
)`,
`CREATE INDEX IF NOT EXISTS idx_customer_portal_customer ON customer_portal_links(customer_id,created_at DESC)`,
`CREATE INDEX IF NOT EXISTS idx_customer_portal_active ON customer_portal_links(customer_id,expires_at) WHERE revoked_at IS NULL`
];
