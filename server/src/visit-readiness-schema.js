export const visitReadinessStatements=[
  `ALTER TABLE customer_visit_confirmations ADD COLUMN IF NOT EXISTS reminder_sent_at TIMESTAMPTZ`,
  `ALTER TABLE customer_visit_confirmations ADD COLUMN IF NOT EXISTS confirmation_task_id INT REFERENCES tasks(id)`,
  `CREATE INDEX IF NOT EXISTS idx_customer_visit_confirmation_confirmation_task ON customer_visit_confirmations(confirmation_task_id) WHERE confirmation_task_id IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_customer_visit_confirmation_pending_schedule ON customer_visit_confirmations(scheduled_at_snapshot) WHERE is_current AND status='PENDING'`,
  `CREATE OR REPLACE FUNCTION block_route_stop_for_customer_reschedule() RETURNS trigger AS $$
    BEGIN
      IF EXISTS(
        SELECT 1
        FROM customer_visit_confirmations v
        WHERE v.request_id=NEW.request_id
          AND v.is_current=true
          AND v.status='RESCHEDULE_REQUESTED'
      ) THEN
        RAISE EXCEPTION USING
          ERRCODE='P0001',
          MESSAGE='Клиент запросил перенос визита. Сначала согласуйте новое время, затем публикуйте маршрут.';
      END IF;
      RETURN NEW;
    END
  $$ LANGUAGE plpgsql`,
  `DROP TRIGGER IF EXISTS trg_route_stop_customer_reschedule ON engineer_route_plan_stops`,
  `CREATE TRIGGER trg_route_stop_customer_reschedule BEFORE INSERT ON engineer_route_plan_stops FOR EACH ROW EXECUTE FUNCTION block_route_stop_for_customer_reschedule()`
];
