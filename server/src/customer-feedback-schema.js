export const customerFeedbackStatements=[
  `CREATE TABLE IF NOT EXISTS customer_feedback_settings(
    id INT PRIMARY KEY CHECK(id=1),
    active BOOLEAN NOT NULL DEFAULT true,
    low_score_threshold SMALLINT NOT NULL DEFAULT 6 CHECK(low_score_threshold BETWEEN 0 AND 10),
    public_review_url TEXT,
    updated_by INT REFERENCES users(id),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `INSERT INTO customer_feedback_settings(id,active,low_score_threshold) VALUES(1,true,6) ON CONFLICT(id) DO NOTHING`,
  `CREATE TABLE IF NOT EXISTS customer_feedback(
    id BIGSERIAL PRIMARY KEY,
    request_id INT NOT NULL UNIQUE REFERENCES requests(id) ON DELETE CASCADE,
    customer_id INT NOT NULL REFERENCES customers(id),
    engineer_id INT REFERENCES users(id),
    branch_id INT REFERENCES branches(id),
    token_nonce TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'INVITED' CHECK(status IN ('INVITED','RESPONDED')),
    invite_count INT NOT NULL DEFAULT 0 CHECK(invite_count>=0),
    last_invited_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ NOT NULL,
    score SMALLINT CHECK(score BETWEEN 0 AND 10),
    comment TEXT,
    contact_requested BOOLEAN NOT NULL DEFAULT false,
    responded_at TIMESTAMPTZ,
    followup_task_id INT REFERENCES tasks(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_customer_feedback_created ON customer_feedback(created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_customer_feedback_branch ON customer_feedback(branch_id,created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_customer_feedback_engineer ON customer_feedback(engineer_id,responded_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_customer_feedback_status ON customer_feedback(status,expires_at)`,
  `CREATE INDEX IF NOT EXISTS idx_customer_feedback_followup ON customer_feedback(followup_task_id) WHERE followup_task_id IS NOT NULL`
];
