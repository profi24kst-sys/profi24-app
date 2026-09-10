export const customerVisitConfirmationStatements=[
  `CREATE TABLE IF NOT EXISTS customer_visit_confirmations(
    id BIGSERIAL PRIMARY KEY,
    request_id INT NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
    customer_id INT NOT NULL REFERENCES customers(id),
    engineer_id INT REFERENCES users(id),
    branch_id INT REFERENCES branches(id),
    version INT NOT NULL CHECK(version>0),
    token_nonce TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    scheduled_at_snapshot TIMESTAMPTZ NOT NULL,
    status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','CONFIRMED','RESCHEDULE_REQUESTED')),
    is_current BOOLEAN NOT NULL DEFAULT true,
    invite_count INT NOT NULL DEFAULT 0 CHECK(invite_count>=0),
    last_invited_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ NOT NULL,
    responded_at TIMESTAMPTZ,
    response_comment TEXT,
    followup_task_id INT REFERENCES tasks(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(request_id,version)
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_customer_visit_confirmation_current ON customer_visit_confirmations(request_id) WHERE is_current`,
  `CREATE INDEX IF NOT EXISTS idx_customer_visit_confirmation_branch ON customer_visit_confirmations(branch_id,scheduled_at_snapshot)`,
  `CREATE INDEX IF NOT EXISTS idx_customer_visit_confirmation_status ON customer_visit_confirmations(status,is_current,expires_at)`,
  `CREATE INDEX IF NOT EXISTS idx_customer_visit_confirmation_task ON customer_visit_confirmations(followup_task_id) WHERE followup_task_id IS NOT NULL`
];
