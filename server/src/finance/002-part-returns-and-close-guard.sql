ALTER TABLE parts ADD COLUMN IF NOT EXISTS returned_at TIMESTAMPTZ;
ALTER TABLE parts ADD COLUMN IF NOT EXISTS return_reason TEXT;
ALTER TABLE parts ADD COLUMN IF NOT EXISTS return_document_reference TEXT;
ALTER TABLE parts ADD COLUMN IF NOT EXISTS returned_by INT REFERENCES users(id);

ALTER TABLE finance_transactions DROP CONSTRAINT IF EXISTS finance_kind_check;
ALTER TABLE finance_transactions ADD CONSTRAINT finance_kind_check CHECK(kind IN
  ('MANUAL','ORDER_EXPENSE','PART_PURCHASE','PART_RETURN','PAYMENT','REFUND','OPENING','ADJUSTMENT','TRANSFER','REVERSAL'));

CREATE OR REPLACE FUNCTION finance_validate_entry() RETURNS trigger AS $$
DECLARE a finance_accounts; u users; original finance_transactions; current_balance NUMERIC;
BEGIN
  SELECT * INTO a FROM finance_accounts WHERE id=NEW.account_id FOR UPDATE;
  IF NOT FOUND OR (NOT a.is_active AND NEW.kind<>'PART_RETURN') THEN RAISE EXCEPTION 'Выберите активный источник денег' USING ERRCODE='P2400'; END IF;
  SELECT * INTO u FROM users WHERE id=NEW.created_by AND active=true;
  IF NOT FOUND THEN RAISE EXCEPTION 'Сотрудник неактивен' USING ERRCODE='P2403'; END IF;
  IF u.role<>'OWNER' AND a.responsible_id IS DISTINCT FROM u.id THEN RAISE EXCEPTION 'Нет доступа к этому денежному счёту' USING ERRCODE='P2403'; END IF;
  IF u.role<>'OWNER' AND NEW.kind NOT IN ('ORDER_EXPENSE','PART_PURCHASE','PAYMENT','REFUND') THEN RAISE EXCEPTION 'Операция доступна только OWNER' USING ERRCODE='P2403'; END IF;
  IF u.role='ENGINEER' AND NEW.kind IN ('PAYMENT','REFUND') THEN RAISE EXCEPTION 'Инженер не принимает оплаты клиентов' USING ERRCODE='P2403'; END IF;
  IF NEW.amount<=0 OR NEW.amount>=1000000000000 OR NEW.amount='NaN'::numeric THEN RAISE EXCEPTION 'Некорректная сумма' USING ERRCODE='P2400'; END IF;
  IF length(trim(COALESCE(NEW.comment,'')))<3 THEN RAISE EXCEPTION 'Укажите назначение или причину операции' USING ERRCODE='P2400'; END IF;
  IF NEW.occurred_at>(now() AT TIME ZONE 'Asia/Almaty')::date THEN RAISE EXCEPTION 'Нельзя провести операцию будущей датой' USING ERRCODE='P2400'; END IF;
  IF NEW.kind IN ('ORDER_EXPENSE','PART_PURCHASE','PART_RETURN','PAYMENT','REFUND') AND NEW.request_id IS NULL THEN RAISE EXCEPTION 'Укажите заказ' USING ERRCODE='P2400'; END IF;
  IF NEW.request_id IS NOT NULL THEN
    IF NOT EXISTS(SELECT 1 FROM requests r WHERE r.id=NEW.request_id AND (r.deleted_at IS NULL OR (u.role='OWNER' AND NEW.kind='REVERSAL')) AND (u.role<>'ENGINEER' OR r.engineer_id=u.id)) THEN
      RAISE EXCEPTION 'Нет доступа к заказу или заказ удалён' USING ERRCODE='P2403';
    END IF;
  END IF;
  IF NEW.kind='REVERSAL' THEN
    SELECT * INTO original FROM finance_transactions WHERE id=NEW.reversal_of;
    IF NOT FOUND OR original.kind='REVERSAL' OR original.source_payment_id IS NOT NULL
      OR original.account_id<>NEW.account_id OR original.amount<>NEW.amount OR original.type=NEW.type
      OR original.request_id IS DISTINCT FROM NEW.request_id THEN
      RAISE EXCEPTION 'Некорректное сторно; оплаты отменяются возвратом в заказе' USING ERRCODE='P2400';
    END IF;
    NEW.affects_pnl:=original.affects_pnl; NEW.pnl_type:=original.pnl_type; NEW.category:=original.category;
  ELSIF NEW.kind='PART_RETURN' THEN
    SELECT * INTO original FROM finance_transactions WHERE id=NEW.reversal_of;
    IF u.role<>'OWNER' OR NOT FOUND OR original.kind<>'PART_PURCHASE' OR NEW.type<>'INCOME'
      OR original.account_id<>NEW.account_id OR original.amount<>NEW.amount
      OR original.request_id IS DISTINCT FROM NEW.request_id OR original.part_id IS DISTINCT FROM NEW.part_id THEN
      RAISE EXCEPTION 'Некорректный возврат покупки запчасти' USING ERRCODE='P2400';
    END IF;
    NEW.affects_pnl:=false; NEW.pnl_type:=NULL; NEW.category:=original.category;
  ELSE
    IF NEW.reversal_of IS NOT NULL THEN RAISE EXCEPTION 'Некорректная ссылка сторно' USING ERRCODE='P2400'; END IF;
    NEW.affects_pnl:=NEW.kind IN ('MANUAL','ORDER_EXPENSE');
    NEW.pnl_type:=CASE WHEN NEW.affects_pnl THEN NEW.type END;
  END IF;
  SELECT balance INTO current_balance FROM finance_account_balances WHERE id=NEW.account_id;
  IF NEW.type='EXPENSE' AND NEW.kind NOT IN ('ADJUSTMENT','OPENING') AND current_balance<NEW.amount THEN
    RAISE EXCEPTION 'Недостаточно средств на счёте. Доступно: %',current_balance USING ERRCODE='P2409';
  END IF;
  NEW.responsible_id:=COALESCE(a.responsible_id,u.id);
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION finance_paid_part_guard() RETURNS trigger AS $$ BEGIN
  IF OLD.payment_account_id IS NOT NULL AND (
    TG_OP='DELETE' OR NEW.payment_account_id IS DISTINCT FROM OLD.payment_account_id OR NEW.qty IS DISTINCT FROM OLD.qty
    OR NEW.purchase_price IS DISTINCT FROM OLD.purchase_price OR NEW.request_id IS DISTINCT FROM OLD.request_id) THEN
    RAISE EXCEPTION 'Оплаченную покупку нельзя переписать или удалить. Используйте документированный возврат.' USING ERRCODE='P2401';
  END IF;
  IF TG_OP='UPDATE' AND OLD.payment_account_id IS NULL AND NEW.payment_account_id IS NOT NULL THEN
    RAISE EXCEPTION 'Оплата оформляется при создании покупки' USING ERRCODE='P2400';
  END IF;
  IF TG_OP='UPDATE' AND OLD.payment_account_id IS NOT NULL AND NEW.status='CANCELLED'
    AND OLD.status IS DISTINCT FROM 'CANCELLED' AND NEW.returned_at IS NULL THEN
    RAISE EXCEPTION 'Оплаченную покупку можно отменить только документированным возвратом' USING ERRCODE='P2401';
  END IF;
  IF TG_OP='UPDATE' AND OLD.returned_at IS NOT NULL AND (
    NEW.returned_at IS DISTINCT FROM OLD.returned_at OR NEW.return_reason IS DISTINCT FROM OLD.return_reason
    OR NEW.return_document_reference IS DISTINCT FROM OLD.return_document_reference OR NEW.returned_by IS DISTINCT FROM OLD.returned_by
    OR NEW.status IS DISTINCT FROM OLD.status) THEN
    RAISE EXCEPTION 'Документированный возврат нельзя изменять' USING ERRCODE='P2401';
  END IF;
  IF TG_OP='UPDATE' AND OLD.returned_at IS NULL AND NEW.returned_at IS NOT NULL AND NOT EXISTS(
    SELECT 1 FROM finance_transactions f WHERE f.part_id=OLD.id AND f.kind='PART_RETURN'
  ) THEN RAISE EXCEPTION 'Сначала проведите возврат денег' USING ERRCODE='P2401'; END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION request_close_guard() RETURNS trigger AS $$ BEGIN
  IF NEW.status='CLOSED' AND OLD.status IS DISTINCT FROM 'CLOSED'
    AND COALESCE(current_setting('app.completion_close_request',true),'')<>NEW.id::text THEN
    RAISE EXCEPTION 'Закройте заказ через процедуру завершения ремонта' USING ERRCODE='P2401';
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS request_close_guard ON requests;
CREATE TRIGGER request_close_guard BEFORE UPDATE OF status ON requests FOR EACH ROW EXECUTE FUNCTION request_close_guard();
