export const payrollPaymentStatements=[
`CREATE TABLE IF NOT EXISTS payroll_payments(
  id BIGSERIAL PRIMARY KEY,
  period_id BIGINT NOT NULL REFERENCES payroll_periods(id),
  revision INT NOT NULL CHECK(revision>0),
  user_id INT NOT NULL REFERENCES users(id),
  branch_id INT NOT NULL REFERENCES branches(id),
  account_id INT NOT NULL REFERENCES finance_accounts(id),
  finance_transaction_id INT NOT NULL UNIQUE REFERENCES finance_transactions(id),
  kind TEXT NOT NULL DEFAULT 'PAYMENT' CHECK(kind IN ('PAYMENT','REVERSAL')),
  amount NUMERIC(14,2) NOT NULL CHECK(amount>0),
  reversal_of BIGINT UNIQUE REFERENCES payroll_payments(id),
  document_reference TEXT NOT NULL,
  reason TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  created_by INT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK((kind='PAYMENT' AND reversal_of IS NULL) OR (kind='REVERSAL' AND reversal_of IS NOT NULL))
)`,
`CREATE INDEX IF NOT EXISTS idx_payroll_payments_period_user ON payroll_payments(period_id,user_id,id)`,
`CREATE INDEX IF NOT EXISTS idx_payroll_payments_account ON payroll_payments(account_id,id)`,
`CREATE OR REPLACE FUNCTION payroll_payment_guard() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Проведённую выплату зарплаты нельзя изменять или удалять; оформите сторно' USING ERRCODE='P2401';
END $$ LANGUAGE plpgsql`,
`DROP TRIGGER IF EXISTS trg_payroll_payments_immutable ON payroll_payments`,
`CREATE TRIGGER trg_payroll_payments_immutable BEFORE UPDATE OR DELETE ON payroll_payments FOR EACH ROW EXECUTE FUNCTION payroll_payment_guard()`
];
