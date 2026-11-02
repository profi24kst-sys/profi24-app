-- Apply to future closes only; historical shift records are not rewritten.
CREATE OR REPLACE FUNCTION finance_cash_shift_variance_note_guard() RETURNS trigger AS $$
BEGIN
  IF OLD.status='OPEN' AND NEW.status='CLOSED'
     AND abs(NEW.actual_closing_balance-NEW.expected_closing_balance)>=0.01
     AND NULLIF(btrim(NEW.closing_note),'') IS NULL THEN
    RAISE EXCEPTION 'Укажите причину расхождения фактического и ожидаемого остатка кассы' USING ERRCODE='P2400';
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_finance_cash_shift_variance_note ON finance_cash_shifts;
CREATE TRIGGER trg_finance_cash_shift_variance_note BEFORE UPDATE OF status ON finance_cash_shifts
FOR EACH ROW EXECUTE FUNCTION finance_cash_shift_variance_note_guard();
