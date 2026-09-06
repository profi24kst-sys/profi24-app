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
`CREATE TRIGGER trg_payroll_payments_immutable BEFORE UPDATE OR DELETE ON payroll_payments FOR EACH ROW EXECUTE FUNCTION payroll_payment_guard()`,
`CREATE OR REPLACE FUNCTION payroll_period_guard() RETURNS trigger AS $$
DECLARE allowed BOOLEAN:=false;
BEGIN
  IF OLD.status='CLOSED' THEN
    RAISE EXCEPTION 'Закрытый расчётный период нельзя изменять' USING ERRCODE='P2401';
  END IF;
  IF NEW.branch_id IS DISTINCT FROM OLD.branch_id OR NEW.period_month IS DISTINCT FROM OLD.period_month OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Основные реквизиты расчётного периода нельзя изменять' USING ERRCODE='P2401';
  END IF;
  IF NEW.status=OLD.status THEN allowed:=true;
  ELSIF OLD.status='DRAFT' AND NEW.status='CALCULATED' THEN allowed:=true;
  ELSIF OLD.status='CALCULATED' AND NEW.status='APPROVED' THEN allowed:=true;
  ELSIF OLD.status='APPROVED' AND NEW.status='PAID' THEN allowed:=true;
  ELSIF OLD.status='PAID' AND NEW.status='APPROVED' THEN allowed:=true;
  ELSIF OLD.status='PAID' AND NEW.status='CLOSED' THEN allowed:=true;
  END IF;
  IF NOT allowed THEN
    RAISE EXCEPTION 'Недопустимый переход расчётного периода: % -> %',OLD.status,NEW.status USING ERRCODE='P2401';
  END IF;
  IF OLD.status IN ('APPROVED','PAID') AND (
    NEW.calculation_revision IS DISTINCT FROM OLD.calculation_revision OR NEW.input_cutoff IS DISTINCT FROM OLD.input_cutoff
    OR NEW.totals IS DISTINCT FROM OLD.totals OR NEW.snapshot_hash IS DISTINCT FROM OLD.snapshot_hash
    OR NEW.calculated_by IS DISTINCT FROM OLD.calculated_by OR NEW.calculated_at IS DISTINCT FROM OLD.calculated_at
    OR NEW.approved_by IS DISTINCT FROM OLD.approved_by OR NEW.approved_at IS DISTINCT FROM OLD.approved_at
  ) THEN
    RAISE EXCEPTION 'Утверждённый расчёт и его исходные суммы нельзя переписывать' USING ERRCODE='P2401';
  END IF;
  IF NEW.status='CALCULATED' AND (NEW.calculation_revision<1 OR NEW.calculated_by IS NULL OR NEW.calculated_at IS NULL) THEN
    RAISE EXCEPTION 'Расчётный период должен содержать ревизию и автора расчёта' USING ERRCODE='P2400';
  END IF;
  IF NEW.status='APPROVED' AND (NEW.approved_by IS NULL OR NEW.approved_at IS NULL) THEN
    RAISE EXCEPTION 'Для утверждения периода нужны собственник и дата утверждения' USING ERRCODE='P2400';
  END IF;
  IF NEW.status='PAID' AND (NEW.paid_by IS NULL OR NEW.paid_at IS NULL) THEN
    RAISE EXCEPTION 'Для статуса PAID нужна документированная выплата' USING ERRCODE='P2400';
  END IF;
  IF NEW.status='CLOSED' AND (NEW.closed_by IS NULL OR NEW.closed_at IS NULL OR OLD.status<>'PAID') THEN
    RAISE EXCEPTION 'Закрыть можно только полностью выплаченный период' USING ERRCODE='P2400';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql`,
`DROP TRIGGER IF EXISTS trg_payroll_period_guard ON payroll_periods`,
`CREATE TRIGGER trg_payroll_period_guard BEFORE UPDATE ON payroll_periods FOR EACH ROW EXECUTE FUNCTION payroll_period_guard()`
];
