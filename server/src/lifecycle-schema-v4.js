export const lifecycleV4Statements=[
  `CREATE OR REPLACE FUNCTION lifecycle_reconcile_request_cancellation() RETURNS trigger AS $$
  DECLARE actor_id INT; cancel_reason TEXT; hold_row request_holds%ROWTYPE; visit_row request_visit_attempts%ROWTYPE;
  BEGIN
    IF NEW.status='CANCELLED' AND OLD.status IS DISTINCT FROM 'CANCELLED' THEN
      SELECT created_by,reason INTO actor_id,cancel_reason FROM request_cancellations WHERE request_id=NEW.id ORDER BY id DESC LIMIT 1;
      IF actor_id IS NULL THEN RETURN NEW; END IF;
      FOR hold_row IN SELECT * FROM request_holds WHERE request_id=NEW.id AND resumed_at IS NULL FOR UPDATE LOOP
        UPDATE request_holds SET resumed_by=actor_id,resumed_at=clock_timestamp(),resolution='Заказ отменён: '||cancel_reason WHERE id=hold_row.id;
        INSERT INTO request_history(request_id,user_id,action,details) VALUES(NEW.id,actor_id,'ORDER_HOLD_RESUMED',jsonb_build_object('hold_id',hold_row.id,'hold_type',hold_row.hold_type,'resolution','Заказ отменён: '||cancel_reason,'automatic_cancellation',true));
      END LOOP;
      FOR visit_row IN SELECT * FROM request_visit_attempts WHERE request_id=NEW.id AND outcome='SCHEDULED' FOR UPDATE LOOP
        UPDATE request_visit_attempts SET outcome='CANCELLED',reason='Заказ отменён: '||cancel_reason,completed_by=actor_id,completed_at=clock_timestamp() WHERE id=visit_row.id;
        INSERT INTO request_history(request_id,user_id,action,details) VALUES(NEW.id,actor_id,'VISIT_OUTCOME_RECORDED',jsonb_build_object('visit_id',visit_row.id,'attempt_no',visit_row.attempt_no,'outcome','CANCELLED','reason','Заказ отменён: '||cancel_reason,'automatic_cancellation',true));
      END LOOP;
    END IF;
    RETURN NEW;
  END $$ LANGUAGE plpgsql`,
  `DROP TRIGGER IF EXISTS trg_lifecycle_reconcile_request_cancellation ON requests`,
  `CREATE TRIGGER trg_lifecycle_reconcile_request_cancellation AFTER UPDATE OF status ON requests FOR EACH ROW EXECUTE FUNCTION lifecycle_reconcile_request_cancellation()`
];
