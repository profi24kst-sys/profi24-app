export const payrollV2Statements=[
`CREATE TABLE IF NOT EXISTS payroll_rules(
  user_id INT PRIMARY KEY REFERENCES users(id),
  base_salary NUMERIC(14,2) NOT NULL DEFAULT 0,
  order_percent NUMERIC(8,3) NOT NULL DEFAULT 0,
  work_percent NUMERIC(8,3) NOT NULL DEFAULT 0,
  gross_profit_percent NUMERIC(8,3) NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT true,
  updated_by INT REFERENCES users(id),
  updated_at TIMESTAMPTZ DEFAULT now()
)`,
`CREATE TABLE IF NOT EXISTS payroll_adjustments(
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id),
  period_month DATE NOT NULL,
  amount NUMERIC(14,2) NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('BONUS','PENALTY','OTHER')),
  reason TEXT NOT NULL,
  created_by INT REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT now()
)`,
`ALTER TABLE payroll_adjustments ADD COLUMN IF NOT EXISTS branch_id INT REFERENCES branches(id)`,
`ALTER TABLE payroll_adjustments ADD COLUMN IF NOT EXISTS reversal_of INT REFERENCES payroll_adjustments(id)`,
`ALTER TABLE payroll_adjustments ADD COLUMN IF NOT EXISTS idempotency_key TEXT`,
`ALTER TABLE payroll_adjustments ADD COLUMN IF NOT EXISTS document_no TEXT`,
`UPDATE payroll_adjustments a SET branch_id=COALESCE(u.primary_branch_id,(SELECT id FROM branches WHERE code='KST' LIMIT 1)) FROM users u WHERE u.id=a.user_id AND a.branch_id IS NULL`,
`CREATE UNIQUE INDEX IF NOT EXISTS uq_payroll_adjustment_idempotency ON payroll_adjustments(idempotency_key) WHERE idempotency_key IS NOT NULL`,
`CREATE INDEX IF NOT EXISTS idx_payroll_adjustments_branch_period ON payroll_adjustments(branch_id,period_month,user_id)`,
`CREATE INDEX IF NOT EXISTS idx_payroll_adjustments_reversal ON payroll_adjustments(reversal_of) WHERE reversal_of IS NOT NULL`,
`CREATE TABLE IF NOT EXISTS payroll_rule_versions(
  id BIGSERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id),
  effective_from DATE NOT NULL,
  base_salary NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK(base_salary>=0),
  order_percent NUMERIC(8,3) NOT NULL DEFAULT 0 CHECK(order_percent>=0),
  work_percent NUMERIC(8,3) NOT NULL DEFAULT 0 CHECK(work_percent>=0),
  gross_profit_percent NUMERIC(8,3) NOT NULL DEFAULT 0 CHECK(gross_profit_percent>=0),
  active BOOLEAN NOT NULL DEFAULT true,
  supersedes_id BIGINT REFERENCES payroll_rule_versions(id),
  reason TEXT NOT NULL DEFAULT 'Initial migration',
  created_by INT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id,effective_from)
)`,
`INSERT INTO payroll_rule_versions(user_id,effective_from,base_salary,order_percent,work_percent,gross_profit_percent,active,reason,created_by)
 SELECT pr.user_id,DATE '1970-01-01',pr.base_salary,pr.order_percent,pr.work_percent,pr.gross_profit_percent,pr.active,'Legacy payroll rule baseline',pr.updated_by
 FROM payroll_rules pr
 WHERE NOT EXISTS(SELECT 1 FROM payroll_rule_versions v WHERE v.user_id=pr.user_id)
 ON CONFLICT(user_id,effective_from) DO NOTHING`,
`CREATE INDEX IF NOT EXISTS idx_payroll_rule_versions_effective ON payroll_rule_versions(user_id,effective_from DESC,id DESC)`,
`CREATE TABLE IF NOT EXISTS payroll_periods(
  id BIGSERIAL PRIMARY KEY,
  branch_id INT NOT NULL REFERENCES branches(id),
  period_month DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK(status IN ('DRAFT','CALCULATED','APPROVED','PAID','CLOSED')),
  calculation_revision INT NOT NULL DEFAULT 0 CHECK(calculation_revision>=0),
  input_cutoff TIMESTAMPTZ,
  totals JSONB NOT NULL DEFAULT '{}',
  snapshot_hash TEXT,
  created_by INT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  calculated_by INT REFERENCES users(id),
  calculated_at TIMESTAMPTZ,
  approved_by INT REFERENCES users(id),
  approved_at TIMESTAMPTZ,
  paid_by INT REFERENCES users(id),
  paid_at TIMESTAMPTZ,
  closed_by INT REFERENCES users(id),
  closed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(branch_id,period_month),
  CHECK(date_trunc('month',period_month)::date=period_month)
)`,
`CREATE INDEX IF NOT EXISTS idx_payroll_period_status ON payroll_periods(status,period_month DESC,branch_id)`,
`CREATE TABLE IF NOT EXISTS kpi_result_snapshots(
  id BIGSERIAL PRIMARY KEY,
  branch_id INT NOT NULL REFERENCES branches(id),
  period_month DATE NOT NULL,
  user_id INT NOT NULL REFERENCES users(id),
  revision INT NOT NULL CHECK(revision>0),
  employee_role TEXT NOT NULL CHECK(employee_role IN ('MANAGER','ENGINEER')),
  plan_snapshot JSONB NOT NULL DEFAULT '{}',
  metrics JSONB NOT NULL DEFAULT '{}',
  score NUMERIC(8,3) NOT NULL DEFAULT 0,
  bonus_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK(status IN ('DRAFT','APPROVED')),
  fingerprint TEXT NOT NULL,
  created_by INT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  approved_by INT REFERENCES users(id),
  approved_at TIMESTAMPTZ,
  UNIQUE(branch_id,period_month,user_id,revision)
)`,
`CREATE UNIQUE INDEX IF NOT EXISTS uq_kpi_result_approved ON kpi_result_snapshots(branch_id,period_month,user_id) WHERE status='APPROVED'`,
`CREATE TABLE IF NOT EXISTS payroll_accruals(
  id BIGSERIAL PRIMARY KEY,
  period_id BIGINT NOT NULL REFERENCES payroll_periods(id),
  revision INT NOT NULL CHECK(revision>0),
  user_id INT NOT NULL REFERENCES users(id),
  branch_id INT NOT NULL REFERENCES branches(id),
  rule_version_id BIGINT REFERENCES payroll_rule_versions(id),
  kpi_result_id BIGINT REFERENCES kpi_result_snapshots(id),
  base_salary NUMERIC(14,2) NOT NULL DEFAULT 0,
  order_commission NUMERIC(14,2) NOT NULL DEFAULT 0,
  work_commission NUMERIC(14,2) NOT NULL DEFAULT 0,
  gross_profit_commission NUMERIC(14,2) NOT NULL DEFAULT 0,
  kpi_bonus NUMERIC(14,2) NOT NULL DEFAULT 0,
  adjustments NUMERIC(14,2) NOT NULL DEFAULT 0,
  total NUMERIC(14,2) NOT NULL DEFAULT 0,
  inputs JSONB NOT NULL DEFAULT '{}',
  fingerprint TEXT NOT NULL,
  created_by INT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(period_id,user_id,revision)
)`,
`CREATE INDEX IF NOT EXISTS idx_payroll_accrual_period_revision ON payroll_accruals(period_id,revision,user_id)`,
`CREATE TABLE IF NOT EXISTS payroll_period_events(
  id BIGSERIAL PRIMARY KEY,
  period_id BIGINT NOT NULL REFERENCES payroll_periods(id),
  actor_id INT REFERENCES users(id),
  action TEXT NOT NULL,
  details JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
)`,
`CREATE INDEX IF NOT EXISTS idx_payroll_period_events_period ON payroll_period_events(period_id,id DESC)`,
`CREATE OR REPLACE FUNCTION payroll_immutable_document() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Проведённый документ расчёта нельзя изменять или удалять; создайте новую ревизию или сторно' USING ERRCODE='P2401';
END $$ LANGUAGE plpgsql`,
`DROP TRIGGER IF EXISTS trg_payroll_rule_versions_immutable ON payroll_rule_versions`,
`CREATE TRIGGER trg_payroll_rule_versions_immutable BEFORE UPDATE OR DELETE ON payroll_rule_versions FOR EACH ROW EXECUTE FUNCTION payroll_immutable_document()`,
`DROP TRIGGER IF EXISTS trg_payroll_accruals_immutable ON payroll_accruals`,
`CREATE TRIGGER trg_payroll_accruals_immutable BEFORE UPDATE OR DELETE ON payroll_accruals FOR EACH ROW EXECUTE FUNCTION payroll_immutable_document()`,
`DROP TRIGGER IF EXISTS trg_payroll_period_events_immutable ON payroll_period_events`,
`CREATE TRIGGER trg_payroll_period_events_immutable BEFORE UPDATE OR DELETE ON payroll_period_events FOR EACH ROW EXECUTE FUNCTION payroll_immutable_document()`,
`CREATE OR REPLACE FUNCTION payroll_adjustment_immutable() RETURNS trigger AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'Корректировку зарплаты нельзя удалять; оформите сторно' USING ERRCODE='P2401';
  END IF;
  IF NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.period_month IS DISTINCT FROM OLD.period_month
     OR NEW.amount IS DISTINCT FROM OLD.amount OR NEW.type IS DISTINCT FROM OLD.type
     OR NEW.reason IS DISTINCT FROM OLD.reason OR NEW.branch_id IS DISTINCT FROM OLD.branch_id
     OR NEW.reversal_of IS DISTINCT FROM OLD.reversal_of OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Корректировку зарплаты нельзя переписывать; оформите сторно' USING ERRCODE='P2401';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql`,
`DROP TRIGGER IF EXISTS trg_payroll_adjustments_immutable ON payroll_adjustments`,
`CREATE TRIGGER trg_payroll_adjustments_immutable BEFORE UPDATE OR DELETE ON payroll_adjustments FOR EACH ROW EXECUTE FUNCTION payroll_adjustment_immutable()`
];
