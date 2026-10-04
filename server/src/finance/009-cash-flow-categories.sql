ALTER TABLE finance_categories ADD COLUMN is_active BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE finance_categories ADD COLUMN is_system BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE finance_categories ADD COLUMN payment_methods TEXT[] NOT NULL DEFAULT ARRAY['BANK','CARD','CASH','ADVANCE','OTHER'];
ALTER TABLE finance_categories ADD COLUMN version INT NOT NULL DEFAULT 1;
ALTER TABLE finance_categories ADD CONSTRAINT finance_category_methods CHECK(
  cardinality(payment_methods)>0 AND payment_methods <@ ARRAY['BANK','CARD','CASH','ADVANCE','OTHER']::text[]);
UPDATE finance_categories SET is_system=true WHERE code='PARTS';
INSERT INTO finance_categories(code,name,type,is_system) VALUES
  ('PAYMENT','Оплата клиента','INCOME',true),('REFUND','Возврат клиенту','EXPENSE',true);
CREATE UNIQUE INDEX finance_category_name ON finance_categories(type,lower(name));
-- Historical postings stay immutable; no reclassification or balance changes.
CREATE FUNCTION finance_cash_flow_method() RETURNS trigger AS $$
DECLARE method TEXT; original finance_transactions;
BEGIN
  IF NEW.reversal_of IS NOT NULL THEN
    SELECT * INTO original FROM finance_transactions WHERE id=NEW.reversal_of;
    method:=original.metadata->>'cash_flow_method';
  END IF;
  IF method IS NULL THEN
    method:=CASE WHEN NEW.payment_method IN ('ACCOUNT','') THEN (SELECT type FROM finance_accounts WHERE id=NEW.account_id)
      WHEN NEW.payment_method IN ('KASPI','BANK_TRANSFER') THEN 'BANK' ELSE NEW.payment_method END;
  END IF;
  NEW.metadata:=COALESCE(NEW.metadata,'{}'::jsonb)||jsonb_build_object('cash_flow_method',method);
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER zz_finance_cash_flow_method BEFORE INSERT ON finance_transactions FOR EACH ROW EXECUTE FUNCTION finance_cash_flow_method();
