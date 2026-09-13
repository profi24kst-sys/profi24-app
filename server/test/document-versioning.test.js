import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {migrateCore} from '../src/migrate.js';
import {installDocumentVersionSchema} from '../src/document-version-schema.js';

test('F04 issued document snapshots are versioned and immutable',async()=>{
  const db=await PGlite.create();
  const query=(sql,params=[])=>params.length?db.query(sql,params):db.exec(sql).then(rows=>rows.at(-1));
  const pool={query,connect:async()=>({query,release(){}})};
  try{
    await migrateCore(pool);
    await query(`CREATE TABLE generated_documents(id SERIAL PRIMARY KEY,request_id INT NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
      document_type TEXT NOT NULL,document_number TEXT NOT NULL,created_by INT REFERENCES users(id),created_at TIMESTAMPTZ DEFAULT now())`);
    await installDocumentVersionSchema(pool);
    const customer=(await query("INSERT INTO customers(name,phone) VALUES('Snapshot client','77000000000') RETURNING id")).rows[0];
    const request=(await query("INSERT INTO requests(number,customer_id,status,complaint,total) VALUES('DOC-VERSION-1',$1,'REPAIR','Initial defect',12000) RETURNING id",[customer.id])).rows[0];
    const firstSnapshot={request:{number:'DOC-VERSION-1',complaint:'Initial defect',total:'12000.00'},works:[],parts:[],signatures:[]};
    const first=(await query(`INSERT INTO generated_documents(request_id,document_type,document_number,version,snapshot,content_hash)
      VALUES($1,'WORK_ORDER','WORK_ORDER-1-V01',1,$2,'hash-v1') RETURNING *`,[request.id,firstSnapshot])).rows[0];
    await query("UPDATE requests SET complaint='Corrected defect',total=15000 WHERE id=$1",[request.id]);
    const stored=(await query('SELECT snapshot FROM generated_documents WHERE id=$1',[first.id])).rows[0].snapshot;
    assert.equal(stored.request.complaint,'Initial defect');
    assert.equal(stored.request.total,'12000.00');
    const second=(await query(`INSERT INTO generated_documents(request_id,document_type,document_number,version,snapshot,content_hash,supersedes_id)
      VALUES($1,'WORK_ORDER','WORK_ORDER-1-V02',2,$2,'hash-v2',$3) RETURNING *`,[request.id,{...firstSnapshot,request:{...firstSnapshot.request,complaint:'Corrected defect',total:'15000.00'}},first.id])).rows[0];
    assert.equal(Number(second.supersedes_id),Number(first.id));
    await assert.rejects(query("UPDATE generated_documents SET document_number='FORGED' WHERE id=$1",[first.id]),e=>e.code==='P2401');
    await assert.rejects(query('DELETE FROM generated_documents WHERE id=$1',[first.id]),e=>e.code==='P2401');
    await assert.rejects(query(`INSERT INTO generated_documents(request_id,document_type,document_number,version)
      VALUES($1,'WORK_ORDER','DUPLICATE',2)`,[request.id]),e=>e.code==='23505');
  }finally{await db.close()}
});
