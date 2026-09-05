ALTER TABLE payments ADD COLUMN IF NOT EXISTS source_payment_id INT REFERENCES payments(id);
CREATE INDEX IF NOT EXISTS idx_payments_source_payment ON payments(source_payment_id) WHERE source_payment_id IS NOT NULL;

-- Backfill the old text link before restoring immutability.
DROP TRIGGER IF EXISTS finance_payment_immutable ON payments;
UPDATE payments r SET source_payment_id=substring(r.reference FROM 8)::int
WHERE r.kind='REFUND' AND r.source_payment_id IS NULL AND r.reference ~ '^refund:[0-9]+$'
  AND EXISTS(SELECT 1 FROM payments p WHERE p.id=substring(r.reference FROM 8)::int AND p.kind='PAYMENT' AND p.request_id=r.request_id);
CREATE TRIGGER finance_payment_immutable BEFORE UPDATE OR DELETE ON payments FOR EACH ROW EXECUTE FUNCTION finance_immutable();

CREATE OR REPLACE FUNCTION assign_payment_account() RETURNS trigger AS $$
DECLARE original payments; refunded NUMERIC; actor_role TEXT;
BEGIN
  IF NEW.kind='PAYMENT' THEN
    IF NEW.source_payment_id IS NOT NULL THEN
      RAISE EXCEPTION 'Обычная оплата не может ссылаться на другой платёж' USING ERRCODE='P2400';
    END IF;
  ELSIF NEW.kind='REFUND' THEN
    IF NEW.source_payment_id IS NULL AND NEW.reference ~ '^refund:[0-9]+$' THEN
      NEW.source_payment_id:=substring(NEW.reference FROM 8)::int;
    END IF;
    SELECT * INTO original FROM payments WHERE id=NEW.source_payment_id AND kind='PAYMENT' FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Выберите исходную оплату для возврата' USING ERRCODE='P2400'; END IF;
    SELECT role INTO actor_role FROM users WHERE id=NEW.created_by AND active=true;
    IF actor_role IS DISTINCT FROM 'OWNER' THEN RAISE EXCEPTION 'Возврат оплаты доступен только OWNER' USING ERRCODE='P2403'; END IF;
    IF NEW.request_id IS DISTINCT FROM original.request_id THEN RAISE EXCEPTION 'Возврат относится к другому заказу' USING ERRCODE='P2400'; END IF;
    IF NEW.account_id IS NULL THEN NEW.account_id:=original.account_id; END IF;
    IF NEW.account_id IS DISTINCT FROM original.account_id OR NEW.method IS DISTINCT FROM original.method THEN
      RAISE EXCEPTION 'Возврат проводится тем же способом и с исходного счёта' USING ERRCODE='P2400';
    END IF;
    IF length(trim(COALESCE(NEW.reason,'')))<3 THEN RAISE EXCEPTION 'Укажите причину возврата' USING ERRCODE='P2400'; END IF;
    IF length(trim(COALESCE(NEW.reference,'')))<2 OR NEW.reference ~ '^refund:[0-9]+$' THEN
      RAISE EXCEPTION 'Укажите документ возврата' USING ERRCODE='P2400';
    END IF;
    SELECT COALESCE(sum(amount),0) INTO refunded FROM payments WHERE kind='REFUND' AND source_payment_id=original.id;
    IF refunded+NEW.amount>original.amount THEN RAISE EXCEPTION 'Возврат превышает остаток исходной оплаты' USING ERRCODE='P2409'; END IF;
  ELSE
    RAISE EXCEPTION 'Некорректный тип платежа' USING ERRCODE='P2400';
  END IF;
  IF NEW.account_id IS NULL THEN RAISE EXCEPTION 'Обязательно выберите источник оплаты' USING ERRCODE='P2400'; END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION finance_post_payment() RETURNS trigger AS $$ BEGIN
  INSERT INTO finance_transactions(account_id,type,kind,category,amount,payment_method,request_id,comment,document_reference,
    created_by,source_payment_id,occurred_at,idempotency_key,metadata)
  VALUES(NEW.account_id,CASE WHEN NEW.kind='PAYMENT' THEN 'INCOME' ELSE 'EXPENSE' END,NEW.kind,NEW.kind,NEW.amount,NEW.method,
    NEW.request_id,CASE WHEN NEW.kind='PAYMENT' THEN 'Оплата по заказу' ELSE 'Возврат оплаты: '||NEW.reason END,
    NEW.reference,NEW.created_by,NEW.id,(now() AT TIME ZONE 'Asia/Almaty')::date,'payment:'||NEW.id,
    CASE WHEN NEW.kind='REFUND' THEN jsonb_build_object('source_payment_id',NEW.source_payment_id) ELSE '{}'::jsonb END);
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

CREATE TABLE IF NOT EXISTS request_cancellations(
  id BIGSERIAL PRIMARY KEY,
  request_id INT NOT NULL REFERENCES requests(id),
  previous_status TEXT NOT NULL,
  category TEXT NOT NULL CHECK(category IN ('CUSTOMER_REFUSAL','DUPLICATE','NO_CONTACT','UNREPAIRABLE','PRICE_REJECTED','OTHER')),
  reason TEXT NOT NULL,
  document_reference TEXT NOT NULL,
  expense_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
  expenses_acknowledged BOOLEAN NOT NULL DEFAULT false,
  snapshot JSONB NOT NULL DEFAULT '{}',
  created_by INT NOT NULL REFERENCES users(id),
  idempotency_key TEXT UNIQUE NOT NULL,
  request_fingerprint TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_request_cancellations_request ON request_cancellations(request_id,id DESC);

CREATE OR REPLACE FUNCTION request_cancel_guard() RETURNS trigger AS $$
DECLARE net_paid NUMERIC; unreturned_parts INT;
BEGIN
  IF NEW.status='CANCELLED' AND OLD.status IS DISTINCT FROM 'CANCELLED' THEN
    IF COALESCE(current_setting('app.order_cancel_request',true),'')<>NEW.id::text THEN
      RAISE EXCEPTION 'Отмените заказ через документированную процедуру' USING ERRCODE='P2401';
    END IF;
    SELECT COALESCE(sum(CASE WHEN kind='PAYMENT' THEN amount WHEN kind='REFUND' THEN -amount ELSE 0 END),0)
      INTO net_paid FROM payments WHERE request_id=NEW.id;
    IF abs(net_paid)>0.01 THEN RAISE EXCEPTION 'Сначала оформите возврат оплаты клиенту' USING ERRCODE='P2409'; END IF;
    SELECT count(*) INTO unreturned_parts FROM parts
      WHERE request_id=NEW.id AND payment_account_id IS NOT NULL AND returned_at IS NULL;
    IF unreturned_parts>0 THEN RAISE EXCEPTION 'Сначала оформите возврат оплаченных покупок' USING ERRCODE='P2409'; END IF;
    IF NOT EXISTS(SELECT 1 FROM request_cancellations WHERE request_id=NEW.id) THEN
      RAISE EXCEPTION 'Не создан документ отмены заказа' USING ERRCODE='P2401';
    END IF;
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS request_cancel_guard ON requests;
CREATE TRIGGER request_cancel_guard BEFORE UPDATE OF status ON requests FOR EACH ROW EXECUTE FUNCTION request_cancel_guard();

CREATE OR REPLACE FUNCTION release_reservations_on_request_cancel() RETURNS trigger AS $$ BEGIN
  IF NEW.status='CANCELLED' AND OLD.status IS DISTINCT FROM 'CANCELLED' AND to_regclass('public.stock_reservations') IS NOT NULL THEN
    EXECUTE 'UPDATE stock_reservations SET status=''RELEASED_CANCELLED'',released_at=COALESCE(released_at,now()) WHERE request_id=$1 AND status=''ACTIVE''' USING NEW.id;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_release_reservations_on_request_cancel ON requests;
CREATE TRIGGER trg_release_reservations_on_request_cancel AFTER UPDATE OF status ON requests FOR EACH ROW EXECUTE FUNCTION release_reservations_on_request_cancel();
