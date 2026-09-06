-- Stage B.2 hardening: keep DB-level finance rules aligned with the six-role RBAC model
-- and preserve safe compatibility for legacy schemas/tests that do not have the completion module.

CREATE OR REPLACE FUNCTION finance_validate_entry() RETURNS trigger AS $$
DECLARE
  a finance_accounts;
  u users;
  original finance_transactions;
  current_balance NUMERIC;
  request_exists BOOLEAN;
  participant_ok BOOLEAN := false;
  member_ok BOOLEAN := true;
  has_branch_id BOOLEAN := false;
  request_branch INT;
BEGIN
  SELECT * INTO a FROM finance_accounts WHERE id=NEW.account_id FOR UPDATE;
  IF NOT FOUND OR (NOT a.is_active AND NEW.kind NOT IN ('PART_RETURN','REFUND','REVERSAL')) THEN
    RAISE EXCEPTION 'Выберите активный источник денег' USING ERRCODE='P2400';
  END IF;

  SELECT * INTO u FROM users WHERE id=NEW.created_by AND active=true;
  IF NOT FOUND THEN RAISE EXCEPTION 'Сотрудник неактивен' USING ERRCODE='P2403'; END IF;

  -- OWNER and ACCOUNTANT are finance administrators. Operational roles need their own account
  -- and are intentionally limited to documented order-scoped money flows.
  IF u.role NOT IN ('OWNER','ACCOUNTANT') THEN
    IF a.responsible_id IS DISTINCT FROM u.id THEN
      RAISE EXCEPTION 'Нет доступа к этому денежному счёту' USING ERRCODE='P2403';
    END IF;
    IF u.role='MANAGER' AND NEW.kind NOT IN ('ORDER_EXPENSE','PART_PURCHASE','PAYMENT') THEN
      RAISE EXCEPTION 'Менеджер может проводить только операционные деньги по заказу' USING ERRCODE='P2403';
    ELSIF u.role='ENGINEER' AND NEW.kind NOT IN ('ORDER_EXPENSE','PART_PURCHASE') THEN
      RAISE EXCEPTION 'Инженер может проводить только собственные расходы и покупки по заказу' USING ERRCODE='P2403';
    ELSIF u.role NOT IN ('MANAGER','ENGINEER') THEN
      RAISE EXCEPTION 'Эта роль не проводит денежные операции' USING ERRCODE='P2403';
    END IF;
  END IF;

  IF NEW.amount<=0 OR NEW.amount>=1000000000000 OR NEW.amount='NaN'::numeric THEN
    RAISE EXCEPTION 'Некорректная сумма' USING ERRCODE='P2400';
  END IF;
  IF length(trim(COALESCE(NEW.comment,'')))<3 THEN
    RAISE EXCEPTION 'Укажите назначение или причину операции' USING ERRCODE='P2400';
  END IF;
  IF NEW.occurred_at>(now() AT TIME ZONE 'Asia/Almaty')::date THEN
    RAISE EXCEPTION 'Нельзя провести операцию будущей датой' USING ERRCODE='P2400';
  END IF;
  IF NEW.kind IN ('ORDER_EXPENSE','PART_PURCHASE','PART_RETURN','PAYMENT','REFUND') AND NEW.request_id IS NULL THEN
    RAISE EXCEPTION 'Укажите заказ' USING ERRCODE='P2400';
  END IF;

  IF NEW.request_id IS NOT NULL THEN
    SELECT EXISTS(
      SELECT 1 FROM requests r
      WHERE r.id=NEW.request_id
        AND (r.deleted_at IS NULL OR (u.role IN ('OWNER','ACCOUNTANT') AND NEW.kind='REVERSAL'))
    ) INTO request_exists;
    IF request_exists IS NOT TRUE THEN
      RAISE EXCEPTION 'Нет доступа к заказу или заказ удалён' USING ERRCODE='P2403';
    END IF;

    IF u.role='ENGINEER' THEN
      SELECT EXISTS(SELECT 1 FROM requests r WHERE r.id=NEW.request_id AND r.engineer_id=u.id AND r.deleted_at IS NULL)
      INTO participant_ok;
      IF participant_ok IS NOT TRUE AND to_regclass('public.request_participants') IS NOT NULL THEN
        EXECUTE 'SELECT EXISTS(SELECT 1 FROM request_participants WHERE request_id=$1 AND user_id=$2 AND participant_role=''ENGINEER'' AND removed_at IS NULL)'
          INTO participant_ok USING NEW.request_id,u.id;
      END IF;
      IF participant_ok IS NOT TRUE THEN
        RAISE EXCEPTION 'Нет доступа к заказу или заказ удалён' USING ERRCODE='P2403';
      END IF;
    END IF;

    IF u.role='MANAGER' AND to_regclass('public.user_branches') IS NOT NULL THEN
      SELECT EXISTS(
        SELECT 1 FROM information_schema.columns
        WHERE table_schema='public' AND table_name='requests' AND column_name='branch_id'
      ) INTO has_branch_id;
      IF has_branch_id THEN
        EXECUTE 'SELECT branch_id FROM requests WHERE id=$1' INTO request_branch USING NEW.request_id;
        IF request_branch IS NOT NULL THEN
          EXECUTE 'SELECT EXISTS(SELECT 1 FROM user_branches WHERE user_id=$1 AND branch_id=$2)'
            INTO member_ok USING u.id,request_branch;
          IF member_ok IS NOT TRUE THEN
            RAISE EXCEPTION 'Заказ относится к другому филиалу' USING ERRCODE='P2403';
          END IF;
        END IF;
      END IF;
    END IF;
  END IF;

  IF NEW.kind='REVERSAL' THEN
    IF u.role NOT IN ('OWNER','ACCOUNTANT') THEN
      RAISE EXCEPTION 'Сторно доступно собственнику или бухгалтеру' USING ERRCODE='P2403';
    END IF;
    SELECT * INTO original FROM finance_transactions WHERE id=NEW.reversal_of;
    IF NOT FOUND OR original.kind='REVERSAL' OR original.source_payment_id IS NOT NULL
      OR original.account_id<>NEW.account_id OR original.amount<>NEW.amount OR original.type=NEW.type
      OR original.request_id IS DISTINCT FROM NEW.request_id THEN
      RAISE EXCEPTION 'Некорректное сторно; оплаты отменяются возвратом в заказе' USING ERRCODE='P2400';
    END IF;
    NEW.affects_pnl:=original.affects_pnl;
    NEW.pnl_type:=original.pnl_type;
    NEW.category:=original.category;
  ELSIF NEW.kind='PART_RETURN' THEN
    IF u.role NOT IN ('OWNER','ACCOUNTANT') THEN
      RAISE EXCEPTION 'Возврат покупки доступен собственнику или бухгалтеру' USING ERRCODE='P2403';
    END IF;
    SELECT * INTO original FROM finance_transactions WHERE id=NEW.reversal_of;
    IF NOT FOUND OR original.kind<>'PART_PURCHASE' OR NEW.type<>'INCOME'
      OR original.account_id<>NEW.account_id OR original.amount<>NEW.amount
      OR original.request_id IS DISTINCT FROM NEW.request_id OR original.part_id IS DISTINCT FROM NEW.part_id THEN
      RAISE EXCEPTION 'Некорректный возврат покупки запчасти' USING ERRCODE='P2400';
    END IF;
    NEW.affects_pnl:=false;
    NEW.pnl_type:=NULL;
    NEW.category:=original.category;
  ELSE
    IF NEW.reversal_of IS NOT NULL THEN
      RAISE EXCEPTION 'Некорректная ссылка сторно' USING ERRCODE='P2400';
    END IF;
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
    IF actor_role IS NULL OR actor_role NOT IN ('OWNER','ACCOUNTANT') THEN
      RAISE EXCEPTION 'Возврат оплаты доступен собственнику или бухгалтеру' USING ERRCODE='P2403';
    END IF;
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

-- Production has repair_completions and therefore requires the documented close procedure.
-- A legacy database without that module may still be migrated/tested and can mark CLOSED directly;
-- terminal-order guards continue to make the resulting order immutable.
CREATE OR REPLACE FUNCTION request_close_guard() RETURNS trigger AS $$ BEGIN
  IF NEW.status='CLOSED' AND OLD.status IS DISTINCT FROM 'CLOSED'
    AND COALESCE(current_setting('app.completion_close_request',true),'')<>NEW.id::text
    AND to_regclass('public.repair_completions') IS NOT NULL THEN
    RAISE EXCEPTION 'Закройте заказ через процедуру завершения ремонта' USING ERRCODE='P2401';
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
