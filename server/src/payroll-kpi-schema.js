export const payrollKpiStatements=[
`CREATE TABLE IF NOT EXISTS kpi_plans(
  id SERIAL PRIMARY KEY,
  user_id INT REFERENCES users(id),
  month DATE NOT NULL,
  target_jobs INT DEFAULT 0,
  target_revenue NUMERIC(14,2) DEFAULT 0,
  target_avg_check NUMERIC(14,2) DEFAULT 0,
  target_conversion NUMERIC(6,2) DEFAULT 0,
  target_sla NUMERIC(6,2) DEFAULT 95,
  target_quality NUMERIC(6,2) DEFAULT 95,
  bonus_max NUMERIC(14,2) DEFAULT 0,
  created_by INT REFERENCES users(id),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(user_id,month)
)`,
`ALTER TABLE kpi_plans ADD COLUMN IF NOT EXISTS branch_id INT REFERENCES branches(id)`,
`UPDATE kpi_plans k SET branch_id=u.primary_branch_id FROM users u WHERE u.id=k.user_id AND k.branch_id IS NULL`,
`CREATE INDEX IF NOT EXISTS idx_kpi_plans_branch_month ON kpi_plans(branch_id,month,user_id)`,
`CREATE OR REPLACE FUNCTION kpi_plan_guard() RETURNS trigger AS $$
DECLARE bid INT;
BEGIN
  bid:=COALESCE(OLD.branch_id,NEW.branch_id);
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'План KPI нельзя удалять; создайте новый план на следующий период' USING ERRCODE='P2401';
  END IF;
  IF EXISTS(SELECT 1 FROM kpi_result_snapshots s WHERE s.user_id=OLD.user_id AND s.period_month=OLD.month AND s.branch_id=bid AND s.status='APPROVED') THEN
    RAISE EXCEPTION 'План KPI уже использован в утверждённом результате и не может быть изменён' USING ERRCODE='P2401';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql`,
`DROP TRIGGER IF EXISTS trg_kpi_plan_guard ON kpi_plans`,
`CREATE TRIGGER trg_kpi_plan_guard BEFORE UPDATE OR DELETE ON kpi_plans FOR EACH ROW EXECUTE FUNCTION kpi_plan_guard()`,
`CREATE OR REPLACE FUNCTION kpi_snapshot_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'Снимок KPI нельзя удалять' USING ERRCODE='P2401';
  END IF;
  IF OLD.status='APPROVED' THEN
    RAISE EXCEPTION 'Утверждённый KPI нельзя изменять' USING ERRCODE='P2401';
  END IF;
  IF NEW.branch_id IS DISTINCT FROM OLD.branch_id OR NEW.period_month IS DISTINCT FROM OLD.period_month
    OR NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.revision IS DISTINCT FROM OLD.revision
    OR NEW.employee_role IS DISTINCT FROM OLD.employee_role OR NEW.plan_snapshot IS DISTINCT FROM OLD.plan_snapshot
    OR NEW.metrics IS DISTINCT FROM OLD.metrics OR NEW.score IS DISTINCT FROM OLD.score
    OR NEW.bonus_amount IS DISTINCT FROM OLD.bonus_amount OR NEW.fingerprint IS DISTINCT FROM OLD.fingerprint
    OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'Показатели рассчитанного KPI нельзя переписывать; создайте новую ревизию' USING ERRCODE='P2401';
  END IF;
  IF NEW.status<>'APPROVED' OR NEW.approved_by IS NULL OR NEW.approved_at IS NULL THEN
    RAISE EXCEPTION 'Снимок KPI можно изменить только документированным утверждением' USING ERRCODE='P2400';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql`,
`DROP TRIGGER IF EXISTS trg_kpi_snapshot_guard ON kpi_result_snapshots`,
`CREATE TRIGGER trg_kpi_snapshot_guard BEFORE UPDATE OR DELETE ON kpi_result_snapshots FOR EACH ROW EXECUTE FUNCTION kpi_snapshot_guard()`
];
