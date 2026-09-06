-- Stage B.2: branch ownership for financial accounts and auditable cash shifts.
-- The finance test harness can run migrations independently, so ensure the branch catalog exists here too.
CREATE TABLE IF NOT EXISTS branches(
  id SERIAL PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  address TEXT,
  timezone TEXT NOT NULL DEFAULT 'Asia/Qostanay',
  active BOOLEAN NOT NULL DEFAULT true,
  created_by INT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO branches(code,name,address,timezone,active)
VALUES('KST','Костанай','ул. Орджоникидзе 25','Asia/Qostanay',true)
ON CONFLICT(code) DO NOTHING;

ALTER TABLE finance_accounts ADD COLUMN IF NOT EXISTS branch_id INT REFERENCES branches(id);
-- This is a system backfill, not an account edit. Legacy finance_account_guard/audit must not
-- interpret it as a user changing an already-posted account.
ALTER TABLE finance_accounts DISABLE TRIGGER finance_account_guard;
ALTER TABLE finance_accounts DISABLE TRIGGER finance_account_audit;
UPDATE finance_accounts SET branch_id=(SELECT id FROM branches WHERE code='KST') WHERE branch_id IS NULL;
ALTER TABLE finance_accounts ENABLE TRIGGER finance_account_audit;
ALTER TABLE finance_accounts ENABLE TRIGGER finance_account_guard;
ALTER TABLE finance_accounts ALTER COLUMN branch_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_finance_accounts_branch ON finance_accounts(branch_id,is_active,id);

CREATE OR REPLACE FUNCTION finance_account_branch_guard() RETURNS trigger AS $$
DECLARE inferred INT; membership_table regclass;
BEGIN
  membership_table:=to_regclass('public.user_branches');
  IF NEW.branch_id IS NULL AND NEW.responsible_id IS NOT NULL AND to_regclass('public.users') IS NOT NULL THEN
    BEGIN
      SELECT primary_branch_id INTO inferred FROM users WHERE id=NEW.responsible_id AND active=true;
    EXCEPTION WHEN undefined_column THEN inferred:=NULL;
    END;
    NEW.branch_id:=inferred;
  END IF;
  IF NEW.branch_id IS NULL THEN
    SELECT id INTO NEW.branch_id FROM branches WHERE code='KST' AND active=true LIMIT 1;
  END IF;
  IF NOT EXISTS(SELECT 1 FROM branches WHERE id=NEW.branch_id AND active=true) THEN
    RAISE EXCEPTION 'Филиал денежного счёта не найден или отключён' USING ERRCODE='P2403';
  END IF;
  IF NEW.responsible_id IS NOT NULL AND membership_table IS NOT NULL AND NOT EXISTS(
    SELECT 1 FROM user_branches WHERE user_id=NEW.responsible_id AND branch_id=NEW.branch_id
  ) THEN
    RAISE EXCEPTION 'Ответственный сотрудник не относится к филиалу денежного счёта' USING ERRCODE='P2403';
  END IF;
  IF TG_OP='UPDATE' AND NEW.branch_id IS DISTINCT FROM OLD.branch_id AND COALESCE((SELECT balance FROM finance_account_balances WHERE id=OLD.id),0)<>0 THEN
    RAISE EXCEPTION 'Счёт с движениями нельзя переносить между филиалами. Создайте новый счёт и оформите перевод.' USING ERRCODE='P2401';
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_finance_account_branch_guard ON finance_accounts;
CREATE TRIGGER trg_finance_account_branch_guard BEFORE INSERT OR UPDATE OF branch_id,responsible_id ON finance_accounts
FOR EACH ROW EXECUTE FUNCTION finance_account_branch_guard();

CREATE TABLE IF NOT EXISTS finance_cash_shifts(
  id BIGSERIAL PRIMARY KEY,
  account_id INT NOT NULL REFERENCES finance_accounts(id),
  branch_id INT NOT NULL REFERENCES branches(id),
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK(status IN ('OPEN','CLOSED')),
  opening_balance NUMERIC(14,2) NOT NULL,
  actual_opening_balance NUMERIC(14,2),
  opening_variance NUMERIC(14,2),
  opened_by INT NOT NULL REFERENCES users(id),
  opened_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  opening_note TEXT NOT NULL DEFAULT '',
  expected_closing_balance NUMERIC(14,2),
  actual_closing_balance NUMERIC(14,2),
  variance NUMERIC(14,2),
  closed_by INT REFERENCES users(id),
  closed_at TIMESTAMPTZ,
  closing_note TEXT NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_finance_cash_shift_open ON finance_cash_shifts(account_id) WHERE status='OPEN';
CREATE INDEX IF NOT EXISTS idx_finance_cash_shift_branch ON finance_cash_shifts(branch_id,opened_at DESC);
ALTER TABLE finance_transactions ADD COLUMN IF NOT EXISTS cash_shift_id BIGINT REFERENCES finance_cash_shifts(id);
CREATE INDEX IF NOT EXISTS idx_finance_transactions_cash_shift ON finance_transactions(cash_shift_id,id) WHERE cash_shift_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS finance_cash_shift_events(
  id BIGSERIAL PRIMARY KEY,
  shift_id BIGINT NOT NULL REFERENCES finance_cash_shifts(id),
  event_type TEXT NOT NULL CHECK(event_type IN ('OPEN','CLOSE')),
  actor_id INT REFERENCES users(id),
  details JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_finance_cash_shift_events ON finance_cash_shift_events(shift_id,id);

CREATE OR REPLACE FUNCTION finance_cash_shift_guard() RETURNS trigger AS $$
DECLARE account_row finance_accounts;
BEGIN
  SELECT * INTO account_row FROM finance_accounts WHERE id=NEW.account_id;
  IF NOT FOUND OR account_row.type<>'CASH' THEN
    RAISE EXCEPTION 'Смена может быть открыта только по активной кассе CASH' USING ERRCODE='P2400';
  END IF;
  IF TG_OP='INSERT' THEN
    IF account_row.is_active IS NOT TRUE THEN
      RAISE EXCEPTION 'Нельзя открыть смену по отключённой кассе' USING ERRCODE='P2400';
    END IF;
    NEW.branch_id:=account_row.branch_id;
    NEW.status:='OPEN';
    NEW.actual_opening_balance:=COALESCE(NEW.actual_opening_balance,NEW.opening_balance);
    NEW.opening_variance:=NEW.actual_opening_balance-NEW.opening_balance;
    NEW.closed_by:=NULL;NEW.closed_at:=NULL;NEW.expected_closing_balance:=NULL;NEW.actual_closing_balance:=NULL;NEW.variance:=NULL;
  ELSE
    IF OLD.status='CLOSED' THEN
      RAISE EXCEPTION 'Закрытую кассовую смену нельзя изменять' USING ERRCODE='P2401';
    END IF;
    NEW.account_id:=OLD.account_id;NEW.branch_id:=OLD.branch_id;NEW.opened_by:=OLD.opened_by;NEW.opened_at:=OLD.opened_at;NEW.opening_balance:=OLD.opening_balance;NEW.actual_opening_balance:=OLD.actual_opening_balance;NEW.opening_variance:=OLD.opening_variance;
    IF NEW.status='CLOSED' THEN
      IF NEW.closed_by IS NULL OR NEW.expected_closing_balance IS NULL OR NEW.actual_closing_balance IS NULL THEN
        RAISE EXCEPTION 'Для закрытия смены укажите ответственного и фактический остаток' USING ERRCODE='P2400';
      END IF;
      NEW.variance:=NEW.actual_closing_balance-NEW.expected_closing_balance;
      NEW.closed_at:=COALESCE(NEW.closed_at,now());
    ELSE
      NEW.status:='OPEN';NEW.closed_by:=NULL;NEW.closed_at:=NULL;NEW.expected_closing_balance:=NULL;NEW.actual_closing_balance:=NULL;NEW.variance:=NULL;
    END IF;
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_finance_cash_shift_guard ON finance_cash_shifts;
CREATE TRIGGER trg_finance_cash_shift_guard BEFORE INSERT OR UPDATE ON finance_cash_shifts
FOR EACH ROW EXECUTE FUNCTION finance_cash_shift_guard();

CREATE OR REPLACE FUNCTION finance_cash_shift_event_log() RETURNS trigger AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    INSERT INTO finance_cash_shift_events(shift_id,event_type,actor_id,details)
    VALUES(NEW.id,'OPEN',NEW.opened_by,jsonb_build_object('opening_balance',NEW.opening_balance,'actual_opening_balance',NEW.actual_opening_balance,'opening_variance',NEW.opening_variance,'branch_id',NEW.branch_id,'account_id',NEW.account_id));
  ELSIF OLD.status='OPEN' AND NEW.status='CLOSED' THEN
    INSERT INTO finance_cash_shift_events(shift_id,event_type,actor_id,details)
    VALUES(NEW.id,'CLOSE',NEW.closed_by,jsonb_build_object('expected',NEW.expected_closing_balance,'actual',NEW.actual_closing_balance,'variance',NEW.variance));
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_finance_cash_shift_event_log ON finance_cash_shifts;
CREATE TRIGGER trg_finance_cash_shift_event_log AFTER INSERT OR UPDATE ON finance_cash_shifts
FOR EACH ROW EXECUTE FUNCTION finance_cash_shift_event_log();

CREATE OR REPLACE FUNCTION finance_attach_open_cash_shift() RETURNS trigger AS $$
DECLARE account_type TEXT; open_shift BIGINT; shift_account INT; shift_status TEXT;
BEGIN
  SELECT type INTO account_type FROM finance_accounts WHERE id=NEW.account_id;
  IF NEW.cash_shift_id IS NOT NULL THEN
    SELECT account_id,status INTO shift_account,shift_status FROM finance_cash_shifts WHERE id=NEW.cash_shift_id;
    IF shift_account IS NULL OR shift_account<>NEW.account_id OR shift_status<>'OPEN' THEN
      RAISE EXCEPTION 'Кассовая операция относится к другой или закрытой смене' USING ERRCODE='P2409';
    END IF;
  ELSIF account_type='CASH' THEN
    SELECT id INTO open_shift FROM finance_cash_shifts WHERE account_id=NEW.account_id AND status='OPEN' ORDER BY id DESC LIMIT 1;
    NEW.cash_shift_id:=open_shift;
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_finance_attach_open_cash_shift ON finance_transactions;
CREATE TRIGGER trg_finance_attach_open_cash_shift BEFORE INSERT ON finance_transactions
FOR EACH ROW EXECUTE FUNCTION finance_attach_open_cash_shift();

CREATE OR REPLACE FUNCTION finance_cash_shift_event_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Журнал кассовой смены нельзя изменять или удалять' USING ERRCODE='P2401';
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_finance_cash_shift_event_immutable ON finance_cash_shift_events;
CREATE TRIGGER trg_finance_cash_shift_event_immutable BEFORE UPDATE OR DELETE ON finance_cash_shift_events
FOR EACH ROW EXECUTE FUNCTION finance_cash_shift_event_immutable();
