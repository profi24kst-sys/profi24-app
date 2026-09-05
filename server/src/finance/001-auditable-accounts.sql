CREATE TABLE IF NOT EXISTS finance_accounts (
  id SERIAL PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'KZT', opening_balance NUMERIC(14,2) NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT true, created_by INT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE finance_accounts DROP CONSTRAINT IF EXISTS finance_accounts_type_check;
ALTER TABLE finance_accounts ADD COLUMN IF NOT EXISTS responsible_id INT REFERENCES users(id);
ALTER TABLE finance_accounts ADD COLUMN IF NOT EXISTS comment TEXT NOT NULL DEFAULT '';
ALTER TABLE finance_accounts ADD COLUMN IF NOT EXISTS creation_key TEXT UNIQUE;
ALTER TABLE finance_accounts ADD COLUMN IF NOT EXISTS creation_fingerprint TEXT;
UPDATE finance_accounts SET type='BANK', comment=concat_ws(' ',nullif(comment,''),'Импорт: счёт Kaspi') WHERE type='KASPI';
ALTER TABLE finance_accounts ADD CONSTRAINT finance_accounts_type_check CHECK(type IN ('BANK','CARD','CASH','ADVANCE','OTHER'));

CREATE TABLE IF NOT EXISTS finance_categories (
  code TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL CHECK(type IN ('INCOME','EXPENSE'))
);
INSERT INTO finance_categories(code,name,type) VALUES
  ('TAXI','Такси / выезд','EXPENSE'),('DELIVERY','Доставка','EXPENSE'),
  ('CONSUMABLES','Расходные материалы','EXPENSE'),('PARKING','Парковка','EXPENSE'),
  ('FUEL','Топливо','EXPENSE'),('PARTS','Покупка запчасти','EXPENSE'),
  ('RENT','Аренда','EXPENSE'),('OTHER','Прочий расход','EXPENSE'),('OTHER_INCOME','Прочий приход','INCOME')
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS finance_transactions (
  id SERIAL PRIMARY KEY, occurred_at DATE NOT NULL DEFAULT CURRENT_DATE,
  type TEXT NOT NULL CHECK(type IN ('INCOME','EXPENSE')), category TEXT NOT NULL,
  amount NUMERIC(14,2) NOT NULL CHECK(amount>0), payment_method TEXT NOT NULL DEFAULT 'CASH',
  request_id INT REFERENCES requests(id), counterparty TEXT, comment TEXT,
  created_by INT REFERENCES users(id), created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE finance_transactions ADD COLUMN IF NOT EXISTS account_id INT REFERENCES finance_accounts(id);
ALTER TABLE finance_transactions ADD COLUMN IF NOT EXISTS transfer_group_id TEXT;
ALTER TABLE finance_transactions ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'MANUAL';
ALTER TABLE finance_transactions ADD COLUMN IF NOT EXISTS responsible_id INT REFERENCES users(id);
ALTER TABLE finance_transactions ADD COLUMN IF NOT EXISTS document_reference TEXT;
ALTER TABLE finance_transactions ADD COLUMN IF NOT EXISTS part_id INT REFERENCES parts(id);
ALTER TABLE finance_transactions ADD COLUMN IF NOT EXISTS source_payment_id INT UNIQUE REFERENCES payments(id);
ALTER TABLE finance_transactions ADD COLUMN IF NOT EXISTS reversal_of INT UNIQUE REFERENCES finance_transactions(id);
ALTER TABLE finance_transactions ADD COLUMN IF NOT EXISTS idempotency_key TEXT UNIQUE;
ALTER TABLE finance_transactions ADD COLUMN IF NOT EXISTS affects_pnl BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE finance_transactions ADD COLUMN IF NOT EXISTS pnl_type TEXT;
ALTER TABLE finance_transactions ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}';
ALTER TABLE payments ADD COLUMN IF NOT EXISTS account_id INT REFERENCES finance_accounts(id);
ALTER TABLE parts ADD COLUMN IF NOT EXISTS payment_account_id INT REFERENCES finance_accounts(id);
ALTER TABLE parts ADD COLUMN IF NOT EXISTS purchase_reference TEXT;
ALTER TABLE parts ADD COLUMN IF NOT EXISTS purchase_idempotency_key TEXT UNIQUE;
ALTER TABLE parts ADD COLUMN IF NOT EXISTS purchase_fingerprint TEXT;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS idempotency_key TEXT UNIQUE;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS request_fingerprint TEXT;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS reason TEXT;

CREATE TABLE finance_audit_log (
  id BIGSERIAL PRIMARY KEY, account_id INT REFERENCES finance_accounts(id),
  transaction_id INT REFERENCES finance_transactions(id), actor_id INT REFERENCES users(id),
  actor_name TEXT NOT NULL, action TEXT NOT NULL, details JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Retain known assignments. Infer only historical unassigned records, once, and mark them.
UPDATE finance_transactions f SET account_id=(SELECT min(a.id) FROM finance_accounts a WHERE a.type=
  CASE f.payment_method WHEN 'CASH' THEN 'CASH' WHEN 'CARD' THEN 'CARD' WHEN 'BANK' THEN 'BANK' WHEN 'BANK_TRANSFER' THEN 'BANK' WHEN 'KASPI' THEN 'BANK' ELSE 'OTHER' END),
  metadata=jsonb_build_object('migration','legacy_payment_method','original_method',f.payment_method)
WHERE f.account_id IS NULL;
UPDATE payments p SET account_id=(SELECT min(a.id) FROM finance_accounts a WHERE a.type=
  CASE p.method WHEN 'CASH' THEN 'CASH' WHEN 'CARD' THEN 'CARD' WHEN 'BANK' THEN 'BANK' WHEN 'BANK_TRANSFER' THEN 'BANK' WHEN 'KASPI' THEN 'BANK' ELSE 'OTHER' END)
WHERE p.account_id IS NULL;
INSERT INTO finance_accounts(name,type,is_active,comment)
SELECT 'Не распределено: старые операции','OTHER',false,'Проверьте исторические источники. Новые операции запрещены.'
WHERE EXISTS(SELECT 1 FROM finance_transactions WHERE account_id IS NULL) OR EXISTS(SELECT 1 FROM payments WHERE account_id IS NULL);
UPDATE finance_transactions SET account_id=(SELECT max(id) FROM finance_accounts WHERE name='Не распределено: старые операции') WHERE account_id IS NULL;
UPDATE payments SET account_id=(SELECT max(id) FROM finance_accounts WHERE name='Не распределено: старые операции') WHERE account_id IS NULL;
UPDATE finance_transactions f SET responsible_id=COALESCE(a.responsible_id,f.created_by),
  kind=CASE WHEN f.transfer_group_id IS NOT NULL THEN 'TRANSFER' WHEN f.request_id IS NOT NULL AND f.type='EXPENSE' THEN 'ORDER_EXPENSE' ELSE 'MANUAL' END,
  affects_pnl=f.transfer_group_id IS NULL,pnl_type=CASE WHEN f.transfer_group_id IS NULL THEN f.type END,
  metadata=f.metadata||jsonb_build_object('imported',true,'legacy_created_at',f.created_at)
FROM finance_accounts a WHERE a.id=f.account_id;

-- Opening balances become explicit signed journal entries; the legacy column is frozen.
INSERT INTO finance_transactions(account_id,type,kind,category,amount,payment_method,comment,created_by,responsible_id,affects_pnl,metadata,idempotency_key)
SELECT id,CASE WHEN opening_balance>=0 THEN 'INCOME' ELSE 'EXPENSE' END,'OPENING','OPENING',abs(opening_balance),type,
  'Перенос ранее введённого начального остатка',created_by,COALESCE(responsible_id,created_by),false,
  jsonb_build_object('imported',true,'legacy_opening_balance',opening_balance),'migration:opening:'||id
FROM finance_accounts WHERE opening_balance<>0;

-- Copy historical payments/refunds once. Soft deletion of an order never erases cash history.
INSERT INTO finance_transactions(account_id,type,kind,category,amount,payment_method,request_id,comment,document_reference,
  created_by,responsible_id,created_at,occurred_at,source_payment_id,affects_pnl,metadata,idempotency_key)
SELECT p.account_id,CASE WHEN p.kind='PAYMENT' THEN 'INCOME' ELSE 'EXPENSE' END,p.kind,p.kind,p.amount,p.method,p.request_id,
  'Импорт оплаты / возврата заказа',p.reference,p.created_by,COALESCE(a.responsible_id,p.created_by),p.created_at,
  (p.created_at AT TIME ZONE 'Asia/Almaty')::date,p.id,false,
  jsonb_build_object('imported',true,'legacy_method',p.method,'deleted_order',r.deleted_at IS NOT NULL),'migration:payment:'||p.id
FROM payments p JOIN finance_accounts a ON a.id=p.account_id JOIN requests r ON r.id=p.request_id;

CREATE TABLE finance_transfers (
  id TEXT PRIMARY KEY, from_account_id INT NOT NULL REFERENCES finance_accounts(id),
  to_account_id INT NOT NULL REFERENCES finance_accounts(id), amount NUMERIC(14,2) NOT NULL CHECK(amount>0),
  created_by INT REFERENCES users(id), comment TEXT NOT NULL,
  reversal_of TEXT UNIQUE REFERENCES finance_transfers(id), created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK(from_account_id<>to_account_id)
);
INSERT INTO finance_transfers(id,from_account_id,to_account_id,amount,created_by,comment,created_at)
SELECT transfer_group_id,min(account_id) FILTER(WHERE type='EXPENSE'),min(account_id) FILTER(WHERE type='INCOME'),
  min(amount),min(created_by),COALESCE(min(comment),'Импорт перевода'),min(created_at)
FROM finance_transactions WHERE transfer_group_id IS NOT NULL GROUP BY transfer_group_id;
ALTER TABLE finance_transactions ADD CONSTRAINT finance_transfer_fk FOREIGN KEY(transfer_group_id) REFERENCES finance_transfers(id);
ALTER TABLE finance_transactions ALTER COLUMN account_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_finance_period ON finance_transactions(occurred_at,type);
CREATE INDEX IF NOT EXISTS idx_finance_request ON finance_transactions(request_id,type);
CREATE INDEX IF NOT EXISTS idx_finance_account ON finance_transactions(account_id,id);
CREATE INDEX IF NOT EXISTS idx_finance_transfer ON finance_transactions(transfer_group_id) WHERE transfer_group_id IS NOT NULL;
CREATE INDEX idx_finance_audit_account ON finance_audit_log(account_id,id);
CREATE UNIQUE INDEX finance_one_opening ON finance_transactions(account_id) WHERE kind='OPENING';
CREATE UNIQUE INDEX finance_one_part_purchase ON finance_transactions(part_id) WHERE kind='PART_PURCHASE';
ALTER TABLE finance_transactions ADD CONSTRAINT finance_kind_check CHECK(kind IN
  ('MANUAL','ORDER_EXPENSE','PART_PURCHASE','PAYMENT','REFUND','OPENING','ADJUSTMENT','TRANSFER','REVERSAL'));

CREATE VIEW finance_account_balances AS
SELECT a.*,COALESCE(t.balance,0)::numeric balance,COALESCE(t.operations_count,0)::int operations_count
FROM finance_accounts a LEFT JOIN (
  SELECT account_id,sum(CASE WHEN type='INCOME' THEN amount ELSE -amount END) balance,count(*) operations_count
  FROM finance_transactions GROUP BY account_id
) t ON t.account_id=a.id;

-- Legacy P&L readers use this projection. Reversals offset their ORIGINAL cost category.
CREATE VIEW finance_pnl_transactions AS
SELECT id,account_id,request_id,category,occurred_at,pnl_type AS type,
  CASE WHEN type=pnl_type THEN amount ELSE -amount END AS amount,comment,created_by
FROM finance_transactions WHERE affects_pnl=true;

INSERT INTO finance_audit_log(account_id,transaction_id,actor_id,actor_name,action,details)
SELECT f.account_id,f.id,f.created_by,COALESCE(u.name,'Исторический импорт'),'LEGACY_IMPORTED',to_jsonb(f)
FROM finance_transactions f LEFT JOIN users u ON u.id=f.created_by;

CREATE FUNCTION finance_immutable() RETURNS trigger AS $$ BEGIN
  RAISE EXCEPTION 'Проведённые денежные записи нельзя изменять или удалять. Используйте сторно с причиной.' USING ERRCODE='P2401';
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER finance_tx_immutable BEFORE UPDATE OR DELETE ON finance_transactions FOR EACH ROW EXECUTE FUNCTION finance_immutable();
CREATE TRIGGER finance_transfer_immutable BEFORE UPDATE OR DELETE ON finance_transfers FOR EACH ROW EXECUTE FUNCTION finance_immutable();
CREATE TRIGGER finance_audit_immutable BEFORE UPDATE OR DELETE ON finance_audit_log FOR EACH ROW EXECUTE FUNCTION finance_immutable();

CREATE FUNCTION finance_account_guard() RETURNS trigger AS $$
DECLARE actor INT; actor_role TEXT;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Счёт нельзя удалить. Отключите его.' USING ERRCODE='P2401'; END IF;
  actor:=NULLIF(current_setting('app.finance_actor',true),'')::int;
  SELECT role INTO actor_role FROM users WHERE id=actor AND active=true;
  IF actor_role IS DISTINCT FROM 'OWNER' THEN RAISE EXCEPTION 'Управление счетами доступно только OWNER' USING ERRCODE='P2403'; END IF;
  IF (TG_OP='INSERT' AND NEW.opening_balance<>0) OR (TG_OP='UPDATE' AND NEW.opening_balance IS DISTINCT FROM OLD.opening_balance) THEN
    RAISE EXCEPTION 'Остаток меняется только документированной операцией' USING ERRCODE='P2401';
  END IF;
  IF NEW.currency<>'KZT' THEN RAISE EXCEPTION 'В первом релизе поддерживается KZT' USING ERRCODE='P2400'; END IF;
  IF NEW.type IN ('CARD','ADVANCE') AND NEW.responsible_id IS NULL THEN RAISE EXCEPTION 'Укажите ответственного сотрудника' USING ERRCODE='P2400'; END IF;
  IF NEW.responsible_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM users WHERE id=NEW.responsible_id AND active=true) THEN
    RAISE EXCEPTION 'Ответственный сотрудник неактивен или не найден' USING ERRCODE='P2400';
  END IF;
  IF TG_OP='UPDATE' AND OLD.is_active AND NOT NEW.is_active AND (SELECT balance FROM finance_account_balances WHERE id=OLD.id)<>0 THEN
    RAISE EXCEPTION 'Перед отключением переведите или скорректируйте остаток до нуля' USING ERRCODE='P2400';
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER finance_account_guard BEFORE INSERT OR UPDATE OR DELETE ON finance_accounts FOR EACH ROW EXECUTE FUNCTION finance_account_guard();
CREATE FUNCTION finance_account_audit() RETURNS trigger AS $$
DECLARE actor INT;
BEGIN
  actor:=NULLIF(current_setting('app.finance_actor',true),'')::int;
  INSERT INTO finance_audit_log(account_id,actor_id,actor_name,action,details)
  VALUES(NEW.id,actor,COALESCE((SELECT name FROM users WHERE id=actor),'Система'),
    CASE WHEN TG_OP='INSERT' THEN 'ACCOUNT_CREATED' ELSE 'ACCOUNT_UPDATED' END,
    jsonb_build_object('before',CASE WHEN TG_OP='UPDATE' THEN to_jsonb(OLD) END,'after',to_jsonb(NEW)));
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER finance_account_audit AFTER INSERT OR UPDATE ON finance_accounts FOR EACH ROW EXECUTE FUNCTION finance_account_audit();

CREATE FUNCTION finance_validate_entry() RETURNS trigger AS $$
DECLARE a finance_accounts; u users; original finance_transactions; current_balance NUMERIC;
BEGIN
  SELECT * INTO a FROM finance_accounts WHERE id=NEW.account_id FOR UPDATE;
  IF NOT FOUND OR NOT a.is_active THEN RAISE EXCEPTION 'Выберите активный источник денег' USING ERRCODE='P2400'; END IF;
  SELECT * INTO u FROM users WHERE id=NEW.created_by AND active=true;
  IF NOT FOUND THEN RAISE EXCEPTION 'Сотрудник неактивен' USING ERRCODE='P2403'; END IF;
  IF u.role<>'OWNER' AND a.responsible_id IS DISTINCT FROM u.id THEN RAISE EXCEPTION 'Нет доступа к этому денежному счёту' USING ERRCODE='P2403'; END IF;
  IF u.role<>'OWNER' AND NEW.kind NOT IN ('ORDER_EXPENSE','PART_PURCHASE','PAYMENT','REFUND') THEN RAISE EXCEPTION 'Операция доступна только OWNER' USING ERRCODE='P2403'; END IF;
  IF u.role='ENGINEER' AND NEW.kind IN ('PAYMENT','REFUND') THEN RAISE EXCEPTION 'Инженер не принимает оплаты клиентов' USING ERRCODE='P2403'; END IF;
  IF NEW.amount<=0 OR NEW.amount>=1000000000000 OR NEW.amount='NaN'::numeric THEN RAISE EXCEPTION 'Некорректная сумма' USING ERRCODE='P2400'; END IF;
  IF length(trim(COALESCE(NEW.comment,'')))<3 THEN RAISE EXCEPTION 'Укажите назначение или причину операции' USING ERRCODE='P2400'; END IF;
  IF NEW.occurred_at>(now() AT TIME ZONE 'Asia/Almaty')::date THEN RAISE EXCEPTION 'Нельзя провести операцию будущей датой' USING ERRCODE='P2400'; END IF;
  IF NEW.kind IN ('ORDER_EXPENSE','PART_PURCHASE','PAYMENT','REFUND') AND NEW.request_id IS NULL THEN RAISE EXCEPTION 'Укажите заказ' USING ERRCODE='P2400'; END IF;
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
CREATE TRIGGER finance_validate_entry BEFORE INSERT ON finance_transactions FOR EACH ROW EXECUTE FUNCTION finance_validate_entry();

CREATE FUNCTION finance_entry_audit() RETURNS trigger AS $$ BEGIN
  INSERT INTO finance_audit_log(account_id,transaction_id,actor_id,actor_name,action,details)
  VALUES(NEW.account_id,NEW.id,NEW.created_by,COALESCE((SELECT name FROM users WHERE id=NEW.created_by),'Система'),'MONEY_POSTED',to_jsonb(NEW));
  IF NEW.request_id IS NOT NULL THEN
    INSERT INTO request_history(request_id,user_id,action,details) VALUES(NEW.request_id,NEW.created_by,'MONEY_POSTED',
      jsonb_build_object('transaction_id',NEW.id,'account_id',NEW.account_id,'account_name',(SELECT name FROM finance_accounts WHERE id=NEW.account_id),
        'type',NEW.type,'amount',NEW.amount,'kind',NEW.kind,'comment',NEW.comment));
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER finance_entry_audit AFTER INSERT ON finance_transactions FOR EACH ROW EXECUTE FUNCTION finance_entry_audit();

CREATE FUNCTION finance_check_transfer() RETURNS trigger AS $$
DECLARE g TEXT; t finance_transfers; valid BOOLEAN;
BEGIN
  IF TG_TABLE_NAME='finance_transfers' THEN g:=NEW.id; ELSE g:=NEW.transfer_group_id; END IF;
  IF g IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO t FROM finance_transfers WHERE id=g;
  SELECT count(*)=2 AND count(*) FILTER(WHERE account_id=t.from_account_id AND type='EXPENSE' AND amount=t.amount)=1
    AND count(*) FILTER(WHERE account_id=t.to_account_id AND type='INCOME' AND amount=t.amount)=1 INTO valid
    FROM finance_transactions WHERE transfer_group_id=g;
  IF NOT COALESCE(valid,false) THEN RAISE EXCEPTION 'Перевод должен содержать две равные связанные записи' USING ERRCODE='P2400'; END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER finance_transfer_pair AFTER INSERT ON finance_transactions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION finance_check_transfer();
CREATE CONSTRAINT TRIGGER finance_transfer_header AFTER INSERT ON finance_transfers DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION finance_check_transfer();

-- All payment writers, including legacy clients, must provide an explicit source.
DROP TRIGGER IF EXISTS trg_assign_payment_account ON payments;
CREATE OR REPLACE FUNCTION assign_payment_account() RETURNS trigger AS $$ BEGIN
  IF NEW.kind='REFUND' AND NEW.account_id IS NULL AND NEW.reference ~ '^refund:[0-9]+$' THEN
    SELECT account_id INTO NEW.account_id FROM payments WHERE id=substring(NEW.reference FROM 8)::int AND kind='PAYMENT' AND request_id=NEW.request_id;
  END IF;
  IF NEW.account_id IS NULL THEN RAISE EXCEPTION 'Обязательно выберите источник оплаты' USING ERRCODE='P2400'; END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER trg_assign_payment_account BEFORE INSERT ON payments FOR EACH ROW EXECUTE FUNCTION assign_payment_account();
CREATE TRIGGER finance_payment_immutable BEFORE UPDATE OR DELETE ON payments FOR EACH ROW EXECUTE FUNCTION finance_immutable();
CREATE FUNCTION finance_post_payment() RETURNS trigger AS $$ BEGIN
  INSERT INTO finance_transactions(account_id,type,kind,category,amount,payment_method,request_id,comment,document_reference,
    created_by,source_payment_id,occurred_at,idempotency_key)
  VALUES(NEW.account_id,CASE WHEN NEW.kind='PAYMENT' THEN 'INCOME' ELSE 'EXPENSE' END,NEW.kind,NEW.kind,NEW.amount,NEW.method,
    NEW.request_id,CASE WHEN NEW.kind='PAYMENT' THEN 'Оплата по заказу' ELSE 'Возврат оплаты: '||COALESCE(NEW.reason,NEW.reference,'по заказу') END,
    NEW.reference,NEW.created_by,NEW.id,(now() AT TIME ZONE 'Asia/Almaty')::date,'payment:'||NEW.id);
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER finance_post_payment AFTER INSERT ON payments FOR EACH ROW EXECUTE FUNCTION finance_post_payment();

-- A paid direct purchase is one part plus one cash movement, in the SAME transaction.
CREATE FUNCTION finance_post_part_purchase() RETURNS trigger AS $$ BEGIN
  IF NEW.payment_account_id IS NOT NULL THEN
    INSERT INTO finance_transactions(account_id,type,kind,category,amount,payment_method,request_id,part_id,comment,
      document_reference,created_by,occurred_at,idempotency_key)
    VALUES(NEW.payment_account_id,'EXPENSE','PART_PURCHASE','PARTS',round(NEW.qty*NEW.purchase_price,2),'ACCOUNT',NEW.request_id,NEW.id,
      'Покупка запчасти: '||NEW.name,NEW.purchase_reference,NEW.created_by,(now() AT TIME ZONE 'Asia/Almaty')::date,'part:'||NEW.id);
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER finance_post_part_purchase AFTER INSERT ON parts FOR EACH ROW EXECUTE FUNCTION finance_post_part_purchase();
CREATE FUNCTION finance_paid_part_guard() RETURNS trigger AS $$ BEGIN
  IF OLD.payment_account_id IS NOT NULL AND (
    TG_OP='DELETE' OR NEW.payment_account_id IS DISTINCT FROM OLD.payment_account_id OR NEW.qty IS DISTINCT FROM OLD.qty
    OR NEW.purchase_price IS DISTINCT FROM OLD.purchase_price OR NEW.request_id IS DISTINCT FROM OLD.request_id) THEN
    RAISE EXCEPTION 'Оплаченную покупку нельзя переписать или удалить. Используйте документированную корректировку.' USING ERRCODE='P2401';
  END IF;
  IF TG_OP='UPDATE' AND OLD.payment_account_id IS NULL AND NEW.payment_account_id IS NOT NULL THEN
    RAISE EXCEPTION 'Оплата оформляется при создании покупки' USING ERRCODE='P2400';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER finance_paid_part_guard BEFORE UPDATE OR DELETE ON parts FOR EACH ROW EXECUTE FUNCTION finance_paid_part_guard();
