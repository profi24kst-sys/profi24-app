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
