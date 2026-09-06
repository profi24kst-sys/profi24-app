-- Stage B.2 compatibility/hardening after branch rollout.
-- Some isolated or legacy finance databases intentionally do not have user_branches yet.
CREATE OR REPLACE FUNCTION finance_account_branch_guard() RETURNS trigger AS $$
DECLARE inferred INT; membership_table regclass; has_primary BOOLEAN; member_ok BOOLEAN;
BEGIN
  membership_table:=to_regclass('public.user_branches');
  SELECT EXISTS(
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='users' AND column_name='primary_branch_id'
  ) INTO has_primary;

  IF NEW.branch_id IS NULL AND NEW.responsible_id IS NOT NULL AND has_primary THEN
    EXECUTE 'SELECT primary_branch_id FROM users WHERE id=$1 AND active=true'
      INTO inferred USING NEW.responsible_id;
    NEW.branch_id:=inferred;
  END IF;
  IF NEW.branch_id IS NULL THEN
    SELECT id INTO NEW.branch_id FROM branches WHERE code='KST' AND active=true LIMIT 1;
  END IF;
  IF NOT EXISTS(SELECT 1 FROM branches WHERE id=NEW.branch_id AND active=true) THEN
    RAISE EXCEPTION 'Филиал денежного счёта не найден или отключён' USING ERRCODE='P2403';
  END IF;

  IF NEW.responsible_id IS NOT NULL AND membership_table IS NOT NULL THEN
    EXECUTE 'SELECT EXISTS(SELECT 1 FROM user_branches WHERE user_id=$1 AND branch_id=$2)'
      INTO member_ok USING NEW.responsible_id,NEW.branch_id;
    IF member_ok IS NOT TRUE THEN
      RAISE EXCEPTION 'Ответственный сотрудник не относится к филиалу денежного счёта' USING ERRCODE='P2403';
    END IF;
  END IF;

  IF TG_OP='UPDATE' AND NEW.branch_id IS DISTINCT FROM OLD.branch_id
     AND COALESCE((SELECT balance FROM finance_account_balances WHERE id=OLD.id),0)<>0 THEN
    RAISE EXCEPTION 'Счёт с движениями нельзя переносить между филиалами. Создайте новый счёт и оформите перевод.' USING ERRCODE='P2401';
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

-- Account configuration is an accounting/security action: OWNER and ACCOUNTANT may perform it.
CREATE OR REPLACE FUNCTION finance_account_guard() RETURNS trigger AS $$
DECLARE actor INT; actor_role TEXT;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Счёт нельзя удалить. Отключите его.' USING ERRCODE='P2401'; END IF;
  actor:=NULLIF(current_setting('app.finance_actor',true),'')::int;
  SELECT role INTO actor_role FROM users WHERE id=actor AND active=true;
  IF actor_role IS NULL OR actor_role NOT IN ('OWNER','ACCOUNTANT') THEN
    RAISE EXCEPTION 'Управление счетами доступно собственнику или бухгалтеру' USING ERRCODE='P2403';
  END IF;
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

-- The database is the last authorization boundary for posted money.
CREATE OR REPLACE FUNCTION finance_validate_entry() RETURNS trigger AS $$
DECLARE a finance_accounts; u users; original finance_transactions; current_balance NUMERIC; finance_admin BOOLEAN;
BEGIN
  SELECT * INTO a FROM finance_accounts WHERE id=NEW.account_id FOR UPDATE;
  IF NOT FOUND OR NOT a.is_active THEN RAISE EXCEPTION 'Выберите активный источник денег' USING ERRCODE='P2400'; END IF;
  SELECT * INTO u FROM users WHERE id=NEW.created_by AND active=true;
  IF NOT FOUND THEN RAISE EXCEPTION 'Сотрудник неактивен' USING ERRCODE='P2403'; END IF;
  finance_admin:=u.role IN ('OWNER','ACCOUNTANT');

  IF NOT finance_admin AND a.responsible_id IS DISTINCT FROM u.id THEN
    RAISE EXCEPTION 'Нет доступа к этому денежному счёту' USING ERRCODE='P2403';
  END IF;
  IF NOT finance_admin THEN
    IF u.role='ENGINEER' AND NEW.kind NOT IN ('ORDER_EXPENSE','PART_PURCHASE') THEN
      RAISE EXCEPTION 'Инженер может проводить только документированные расходы своего заказа' USING ERRCODE='P2403';
    ELSIF u.role='MANAGER' AND NEW.kind NOT IN ('ORDER_EXPENSE','PART_PURCHASE','PAYMENT') THEN
      RAISE EXCEPTION 'Менеджеру недоступна эта финансовая операция' USING ERRCODE='P2403';
    ELSIF u.role NOT IN ('ENGINEER','MANAGER') THEN
      RAISE EXCEPTION 'Эта роль не проводит денежные операции' USING ERRCODE='P2403';
    END IF;
  END IF;

  IF NEW.amount<=0 OR NEW.amount>=1000000000000 OR NEW.amount='NaN'::numeric THEN RAISE EXCEPTION 'Некорректная сумма' USING ERRCODE='P2400'; END IF;
  IF length(trim(COALESCE(NEW.comment,'')))<3 THEN RAISE EXCEPTION 'Укажите назначение или причину операции' USING ERRCODE='P2400'; END IF;
  IF NEW.occurred_at>(now() AT TIME ZONE 'Asia/Almaty')::date THEN RAISE EXCEPTION 'Нельзя провести операцию будущей датой' USING ERRCODE='P2400'; END IF;
  IF NEW.kind IN ('ORDER_EXPENSE','PART_PURCHASE','PAYMENT','REFUND') AND NEW.request_id IS NULL THEN RAISE EXCEPTION 'Укажите заказ' USING ERRCODE='P2400'; END IF;
  IF NEW.request_id IS NOT NULL THEN
    IF NOT EXISTS(SELECT 1 FROM requests r WHERE r.id=NEW.request_id
      AND (r.deleted_at IS NULL OR (u.role='OWNER' AND NEW.kind='REVERSAL'))
      AND (u.role<>'ENGINEER' OR r.engineer_id=u.id)) THEN
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

-- Refund is an accounting correction: OWNER and ACCOUNTANT may execute it.
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
    IF actor_role IS NULL OR actor_role NOT IN ('OWNER','ACCOUNTANT') THEN RAISE EXCEPTION 'Возврат оплаты доступен собственнику или бухгалтеру' USING ERRCODE='P2403'; END IF;
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
