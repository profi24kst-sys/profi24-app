export const lifecycleStatements=[
`CREATE TABLE IF NOT EXISTS request_holds(
  id BIGSERIAL PRIMARY KEY,
  request_id INT NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  hold_type TEXT NOT NULL CHECK(hold_type IN ('WAITING_CUSTOMER','WAITING_APPROVAL','WAITING_PART','EXTERNAL_SERVICE','WAITING_DELIVERY','OTHER')),
  reason TEXT NOT NULL,
  responsible_id INT REFERENCES users(id),
  expected_until TIMESTAMPTZ,
  pause_sla BOOLEAN NOT NULL DEFAULT true,
  previous_status TEXT NOT NULL,
  previous_sla_deadline TIMESTAMPTZ,
  started_by INT NOT NULL REFERENCES users(id),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resumed_by INT REFERENCES users(id),
  resumed_at TIMESTAMPTZ,
  resolution TEXT,
  CHECK(resumed_at IS NULL OR resumed_by IS NOT NULL)
)`,
`CREATE UNIQUE INDEX IF NOT EXISTS uq_request_holds_active ON request_holds(request_id) WHERE resumed_at IS NULL`,
`CREATE INDEX IF NOT EXISTS idx_request_holds_attention ON request_holds(expected_until,request_id) WHERE resumed_at IS NULL`,
`CREATE INDEX IF NOT EXISTS idx_request_holds_history ON request_holds(request_id,id DESC)`,
`CREATE TABLE IF NOT EXISTS request_visit_attempts(
  id BIGSERIAL PRIMARY KEY,
  request_id INT NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  attempt_no INT NOT NULL CHECK(attempt_no>0),
  visit_type TEXT NOT NULL DEFAULT 'FIELD' CHECK(visit_type IN ('FIELD','SHOP','DELIVERY','REMOTE')),
  scheduled_at TIMESTAMPTZ NOT NULL,
  engineer_id INT REFERENCES users(id),
  outcome TEXT NOT NULL DEFAULT 'SCHEDULED' CHECK(outcome IN ('SCHEDULED','COMPLETED','NO_ACCESS','CUSTOMER_NO_SHOW','REPEAT_REQUIRED','CANCELLED')),
  reason TEXT,
  created_by INT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_by INT REFERENCES users(id),
  completed_at TIMESTAMPTZ,
  UNIQUE(request_id,attempt_no),
  CHECK(outcome='SCHEDULED' OR completed_at IS NOT NULL)
)`,
`CREATE INDEX IF NOT EXISTS idx_request_visit_schedule ON request_visit_attempts(scheduled_at,outcome)`,
`CREATE INDEX IF NOT EXISTS idx_request_visit_request ON request_visit_attempts(request_id,id DESC)`,
`CREATE TABLE IF NOT EXISTS request_order_links(
  id BIGSERIAL PRIMARY KEY,
  parent_request_id INT NOT NULL REFERENCES requests(id),
  child_request_id INT NOT NULL UNIQUE REFERENCES requests(id),
  link_type TEXT NOT NULL CHECK(link_type IN ('WARRANTY_REWORK','REWORK')),
  reason TEXT NOT NULL,
  created_by INT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK(parent_request_id<>child_request_id)
)`,
`CREATE INDEX IF NOT EXISTS idx_request_order_links_parent ON request_order_links(parent_request_id,id DESC)`,
`CREATE OR REPLACE FUNCTION lifecycle_document_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'Документы жизненного цикла нельзя удалять' USING ERRCODE='P2401';
  END IF;
  IF TG_TABLE_NAME='request_holds' THEN
    IF OLD.resumed_at IS NOT NULL THEN
      RAISE EXCEPTION 'Завершённую паузу нельзя изменять' USING ERRCODE='P2401';
    END IF;
    IF NEW.request_id IS DISTINCT FROM OLD.request_id
      OR NEW.hold_type IS DISTINCT FROM OLD.hold_type
      OR NEW.reason IS DISTINCT FROM OLD.reason
      OR NEW.responsible_id IS DISTINCT FROM OLD.responsible_id
      OR NEW.expected_until IS DISTINCT FROM OLD.expected_until
      OR NEW.pause_sla IS DISTINCT FROM OLD.pause_sla
      OR NEW.previous_status IS DISTINCT FROM OLD.previous_status
      OR NEW.previous_sla_deadline IS DISTINCT FROM OLD.previous_sla_deadline
      OR NEW.started_by IS DISTINCT FROM OLD.started_by
      OR NEW.started_at IS DISTINCT FROM OLD.started_at THEN
      RAISE EXCEPTION 'Начатую паузу нельзя переписывать; завершите её документированно' USING ERRCODE='P2401';
    END IF;
    IF NEW.resumed_at IS NULL OR NEW.resumed_by IS NULL OR COALESCE(length(trim(NEW.resolution)),0)<3 THEN
      RAISE EXCEPTION 'Для завершения паузы нужны автор, время и результат' USING ERRCODE='P2400';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_TABLE_NAME='request_visit_attempts' THEN
    IF OLD.outcome<>'SCHEDULED' THEN
      RAISE EXCEPTION 'Завершённый выезд нельзя изменять' USING ERRCODE='P2401';
    END IF;
    IF NEW.request_id IS DISTINCT FROM OLD.request_id OR NEW.attempt_no IS DISTINCT FROM OLD.attempt_no
      OR NEW.visit_type IS DISTINCT FROM OLD.visit_type OR NEW.scheduled_at IS DISTINCT FROM OLD.scheduled_at
      OR NEW.engineer_id IS DISTINCT FROM OLD.engineer_id OR NEW.created_by IS DISTINCT FROM OLD.created_by
      OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'Параметры созданного выезда нельзя переписывать; отмените и создайте новый' USING ERRCODE='P2401';
    END IF;
    IF NEW.outcome='SCHEDULED' OR NEW.completed_at IS NULL OR NEW.completed_by IS NULL THEN
      RAISE EXCEPTION 'Выезд завершается только документированным результатом' USING ERRCODE='P2400';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Связи заказов нельзя изменять' USING ERRCODE='P2401';
END $$ LANGUAGE plpgsql`,
`DROP TRIGGER IF EXISTS trg_request_holds_guard ON request_holds`,
`CREATE TRIGGER trg_request_holds_guard BEFORE UPDATE OR DELETE ON request_holds FOR EACH ROW EXECUTE FUNCTION lifecycle_document_guard()`,
`DROP TRIGGER IF EXISTS trg_request_visit_guard ON request_visit_attempts`,
`CREATE TRIGGER trg_request_visit_guard BEFORE UPDATE OR DELETE ON request_visit_attempts FOR EACH ROW EXECUTE FUNCTION lifecycle_document_guard()`,
`DROP TRIGGER IF EXISTS trg_request_order_links_guard ON request_order_links`,
`CREATE TRIGGER trg_request_order_links_guard BEFORE UPDATE OR DELETE ON request_order_links FOR EACH ROW EXECUTE FUNCTION lifecycle_document_guard()`
];
