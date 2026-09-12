CREATE TABLE finance_bank_statements(
  id BIGSERIAL PRIMARY KEY,
  account_id INT NOT NULL REFERENCES finance_accounts(id),
  statement_reference TEXT NOT NULL,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  opening_balance NUMERIC(14,2) NOT NULL,
  closing_balance NUMERIC(14,2) NOT NULL,
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK(status IN ('DRAFT','RECONCILED')),
  created_by INT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  reconciled_by INT REFERENCES users(id),
  reconciled_at TIMESTAMPTZ,
  UNIQUE(account_id,statement_reference),
  CHECK(period_end>=period_start)
);

CREATE TABLE finance_bank_statement_lines(
  id BIGSERIAL PRIMARY KEY,
  statement_id BIGINT NOT NULL REFERENCES finance_bank_statements(id),
  external_id TEXT NOT NULL,
  occurred_at DATE NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('INCOME','EXPENSE')),
  amount NUMERIC(14,2) NOT NULL CHECK(amount>0),
  document_reference TEXT,
  counterparty TEXT,
  purpose TEXT NOT NULL DEFAULT '',
  matched_transaction_id INT UNIQUE REFERENCES finance_transactions(id),
  matched_by INT REFERENCES users(id),
  matched_at TIMESTAMPTZ,
  UNIQUE(statement_id,external_id)
);

CREATE INDEX idx_bank_statement_account_period ON finance_bank_statements(account_id,period_end DESC);
CREATE INDEX idx_bank_statement_line_unmatched ON finance_bank_statement_lines(statement_id,id) WHERE matched_transaction_id IS NULL;

CREATE FUNCTION finance_reconciled_statement_immutable() RETURNS trigger AS $$
BEGIN
  IF OLD.status='RECONCILED' THEN
    RAISE EXCEPTION 'Сверенную банковскую выписку нельзя изменять или удалять' USING ERRCODE='P2401';
  END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER finance_bank_statement_guard BEFORE UPDATE OR DELETE ON finance_bank_statements FOR EACH ROW EXECUTE FUNCTION finance_reconciled_statement_immutable();

CREATE FUNCTION finance_reconciled_line_immutable() RETURNS trigger AS $$
DECLARE parent_id BIGINT;
BEGIN
  parent_id:=CASE WHEN TG_OP='DELETE' THEN OLD.statement_id ELSE NEW.statement_id END;
  IF EXISTS(SELECT 1 FROM finance_bank_statements s WHERE s.id=parent_id AND s.status='RECONCILED') THEN
    RAISE EXCEPTION 'Строки сверенной банковской выписки неизменяемы' USING ERRCODE='P2401';
  END IF;
  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER finance_bank_statement_line_guard BEFORE INSERT OR UPDATE OR DELETE ON finance_bank_statement_lines FOR EACH ROW EXECUTE FUNCTION finance_reconciled_line_immutable();
