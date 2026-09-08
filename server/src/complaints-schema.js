export const complaintStatements=[
  `CREATE SEQUENCE IF NOT EXISTS complaint_number_seq START 1001`,
  `ALTER TABLE complaints ADD COLUMN IF NOT EXISTS stage TEXT DEFAULT 'REGISTERED'`,
  `UPDATE complaints SET stage=CASE WHEN status='CLOSED' THEN 'RESOLVED' ELSE 'REGISTERED' END WHERE stage IS NULL`,
  `ALTER TABLE complaints ALTER COLUMN stage SET DEFAULT 'REGISTERED'`,
  `ALTER TABLE complaints ALTER COLUMN stage SET NOT NULL`,
  `ALTER TABLE complaints ADD COLUMN IF NOT EXISTS root_cause TEXT`,
  `ALTER TABLE complaints ADD COLUMN IF NOT EXISTS prevention TEXT`,
  `ALTER TABLE complaints ADD COLUMN IF NOT EXISTS rework_request_id INT REFERENCES requests(id)`,
  `ALTER TABLE complaints ADD COLUMN IF NOT EXISTS due_at TIMESTAMPTZ`,
  `ALTER TABLE complaints ADD COLUMN IF NOT EXISTS updated_by INT REFERENCES users(id)`,
  `ALTER TABLE complaints ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now()`,
  `CREATE INDEX IF NOT EXISTS idx_complaints_status_stage ON complaints(status,stage,created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_complaints_responsible ON complaints(responsible_id,status,due_at)`,
  `CREATE INDEX IF NOT EXISTS idx_complaints_rework ON complaints(rework_request_id)`,
  `CREATE TABLE IF NOT EXISTS complaint_financial_impacts(
    complaint_id INT PRIMARY KEY REFERENCES complaints(id) ON DELETE CASCADE,
    amount NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK(amount>=0),
    note TEXT,
    updated_by INT REFERENCES users(id),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`
];
