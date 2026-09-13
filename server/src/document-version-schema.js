export const documentVersionStatements=[
  `ALTER TABLE generated_documents ADD COLUMN IF NOT EXISTS version INT`,
  `ALTER TABLE generated_documents ADD COLUMN IF NOT EXISTS snapshot JSONB`,
  `ALTER TABLE generated_documents ADD COLUMN IF NOT EXISTS content_hash TEXT`,
  `ALTER TABLE generated_documents ADD COLUMN IF NOT EXISTS supersedes_id INT REFERENCES generated_documents(id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_generated_document_version ON generated_documents(request_id,document_type,version) WHERE version IS NOT NULL`,
  `CREATE OR REPLACE FUNCTION generated_document_immutable() RETURNS trigger AS $$ BEGIN
    RAISE EXCEPTION 'Выпущенный документ нельзя изменять или удалять; создайте новую версию' USING ERRCODE='P2401';
  END $$ LANGUAGE plpgsql`,
  `DROP TRIGGER IF EXISTS trg_generated_document_immutable ON generated_documents`,
  `CREATE TRIGGER trg_generated_document_immutable BEFORE UPDATE OR DELETE ON generated_documents FOR EACH ROW EXECUTE FUNCTION generated_document_immutable()`
];

export async function installDocumentVersionSchema(db){
  for(const statement of documentVersionStatements)await db.query(statement);
}
