import {createHash} from 'node:crypto';
import {runSchemaStatements} from './schema-retry.js';

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

export async function installDocumentVersionSchema(db,{logger=console}={}){
  await runSchemaStatements(db,documentVersionStatements,{logger});
}

export async function insertDocumentVersion(db,{requestId,documentType,snapshot,createdBy}){
  const previous=(await db.query(`SELECT id,version FROM generated_documents
    WHERE request_id=$1 AND document_type=$2 ORDER BY version DESC NULLS LAST,id DESC LIMIT 1`,[requestId,documentType])).rows[0];
  const version=Number(previous?.version||0)+1;
  const documentNumber=`${documentType}-${requestId}-V${String(version).padStart(2,'0')}`;
  const contentHash=createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
  return (await db.query(`INSERT INTO generated_documents(request_id,document_type,document_number,version,snapshot,content_hash,supersedes_id,created_by)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,[requestId,documentType,documentNumber,version,snapshot,contentHash,previous?.id||null,createdBy])).rows[0];
}
