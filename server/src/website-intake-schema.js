export const websiteIntakeStatements=[
  `CREATE TABLE IF NOT EXISTS website_intake_events(
    id BIGSERIAL PRIMARY KEY,
    idempotency_key TEXT NOT NULL UNIQUE,
    payload_hash TEXT NOT NULL,
    request_id INT REFERENCES requests(id),
    status TEXT NOT NULL DEFAULT 'RECEIVED' CHECK(status IN ('RECEIVED','CREATED')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at TIMESTAMPTZ
  )`,
  `CREATE INDEX IF NOT EXISTS idx_website_intake_request ON website_intake_events(request_id)`,
  `CREATE INDEX IF NOT EXISTS idx_website_intake_created ON website_intake_events(created_at DESC)`
];
