import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {migrateCore} from '../src/migrate.js';
import {branchStatements} from '../src/branch-schema.js';

test('branch migration backfills legacy users and orders into Kostanay',async()=>{
  const db=await PGlite.create();
  const query=(sql,params=[])=>params.length?db.query(sql,params):db.exec(sql).then(r=>r.at(-1));
  const pool={query,connect:async()=>({query,release(){}}),end:async()=>{}};
  try{
    await migrateCore(pool);
    const kst=(await query("SELECT id,code,name,timezone FROM branches WHERE code='KST'")).rows[0];
    assert.ok(kst?.id);
    assert.equal(kst.name,'Костанай');
    assert.equal(kst.timezone,'Asia/Qostanay');

    const user=(await query("INSERT INTO users(name,email,password_hash,role) VALUES('Legacy Manager','legacy-manager@test.invalid','unused','MANAGER') RETURNING id")).rows[0];
    const customer=(await query("INSERT INTO customers(name,phone) VALUES('Legacy Client','000') RETURNING id")).rows[0];
    const request=(await query("INSERT INTO requests(number,customer_id,status,complaint) VALUES('BR-LEGACY',$1,'NEW','Test') RETURNING id",[customer.id])).rows[0];
    assert.equal((await query('SELECT primary_branch_id FROM users WHERE id=$1',[user.id])).rows[0].primary_branch_id,null);
    assert.equal((await query('SELECT branch_id FROM requests WHERE id=$1',[request.id])).rows[0].branch_id,null);

    for(const sql of branchStatements)await query(sql);

    assert.equal(Number((await query('SELECT primary_branch_id FROM users WHERE id=$1',[user.id])).rows[0].primary_branch_id),Number(kst.id));
    assert.equal(Number((await query('SELECT branch_id FROM requests WHERE id=$1',[request.id])).rows[0].branch_id),Number(kst.id));
    const membership=(await query('SELECT branch_id,is_primary FROM user_branches WHERE user_id=$1',[user.id])).rows[0];
    assert.equal(Number(membership.branch_id),Number(kst.id));
    assert.equal(membership.is_primary,true);

    const other=(await query("INSERT INTO branches(code,name) VALUES('TEST2','Другой филиал') RETURNING id")).rows[0];
    await assert.rejects(
      query('INSERT INTO user_branches(user_id,branch_id,is_primary) VALUES($1,$2,true)',[user.id,other.id]),
      error=>error.code==='23505'
    );
    await assert.rejects(
      query('UPDATE requests SET branch_id=999999 WHERE id=$1',[request.id]),
      error=>error.code==='23503'
    );
  }finally{await db.close();}
});
