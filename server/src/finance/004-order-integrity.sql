-- Terminal orders cannot be changed through a second service or a concurrent request.
CREATE OR REPLACE FUNCTION guard_terminal_order() RETURNS trigger AS $$
DECLARE before_doc jsonb; after_doc jsonb;
BEGIN
  IF OLD.status NOT IN ('CLOSED','CANCELLED') THEN RETURN NEW; END IF;
  before_doc := to_jsonb(OLD) - ARRAY['updated_at','deleted_at','deleted_by','delete_reason','deleted_snapshot'];
  after_doc := to_jsonb(NEW) - ARRAY['updated_at','deleted_at','deleted_by','delete_reason','deleted_snapshot'];
  IF before_doc = after_doc THEN RETURN NEW; END IF;
  IF OLD.status='CLOSED' AND NEW.status='PAYMENT_REQUIRED' AND NEW.closed_at IS NULL
     AND COALESCE(current_setting('app.order_correction_request',true),'')=OLD.id::text
     AND (before_doc - ARRAY['status','closed_at']) = (after_doc - ARRAY['status','closed_at']) THEN
    RETURN NEW;
  END IF;
  IF COALESCE(current_setting('app.order_refund_request',true),'')=OLD.id::text
     AND NEW.paid <= OLD.paid
     AND (NEW.status=OLD.status OR (OLD.status='CLOSED' AND NEW.status='PAYMENT_REQUIRED'))
     AND (before_doc - ARRAY['status','closed_at','paid']) = (after_doc - ARRAY['status','closed_at','paid']) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION USING ERRCODE='P2409', MESSAGE='Закрытый или отменённый заказ нельзя изменить обычной операцией';
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS guard_terminal_order ON requests;
CREATE TRIGGER guard_terminal_order BEFORE UPDATE ON requests FOR EACH ROW EXECUTE FUNCTION guard_terminal_order();

CREATE OR REPLACE FUNCTION guard_order_child_mutation() RETURNS trigger AS $$
DECLARE target_id int; parent_status text; parent_deleted timestamptz;
BEGIN
  IF TG_OP='UPDATE' AND OLD.request_id IS DISTINCT FROM NEW.request_id THEN
    RAISE EXCEPTION USING ERRCODE='P2409', MESSAGE='Нельзя переносить проведённую запись в другой заказ';
  END IF;
  IF TG_OP='DELETE' THEN target_id:=OLD.request_id; ELSE target_id:=NEW.request_id; END IF;
  IF target_id IS NULL THEN
    IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;
  SELECT status,deleted_at INTO parent_status,parent_deleted FROM requests WHERE id=target_id FOR UPDATE;
  IF parent_deleted IS NOT NULL OR parent_status IN ('CLOSED','CANCELLED') THEN
    IF TG_TABLE_NAME='payments' AND TG_OP='INSERT'
       AND to_jsonb(NEW)->>'kind'='REFUND'
       AND COALESCE(current_setting('app.order_refund_request',true),'')=target_id::text THEN RETURN NEW; END IF;
    RAISE EXCEPTION USING ERRCODE='P2409', MESSAGE='Заказ закрыт, отменён или удалён. Используйте документированную процедуру';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END; $$ LANGUAGE plpgsql;
DO $$ DECLARE tab text; BEGIN
  FOREACH tab IN ARRAY ARRAY['request_works','parts','payments','request_quote_lines','request_diagnostics','repair_completions','request_files','request_signatures','special_part_orders'] LOOP
    IF to_regclass('public.'||tab) IS NOT NULL THEN
      EXECUTE format('DROP TRIGGER IF EXISTS guard_order_mutation ON %I',tab);
      EXECUTE format('CREATE TRIGGER guard_order_mutation BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION guard_order_child_mutation()',tab);
    END IF;
  END LOOP;
END $$;
