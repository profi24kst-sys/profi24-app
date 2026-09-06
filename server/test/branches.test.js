import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {migrateCore} from '../src/migrate.js';
import {requireOrder} from '../src/access.js';

test('branch foundation assigns defaults and enforces branch responsibility',async()=>{
  const db=await PGlite.create();
  const query=(sql,params=[])=>params.length?db.query(sql,params):db.exec(sql).then(r=>r.at(-1));
  const pool={query,connect:async()=>({query,release(){}}),end:async()=>{}};
  try{
    await migrateCore(pool);
    const kst=(await query("SELECT id,code,name,timezone FROM branches WHERE code='KST'")).rows[0];
    assert.ok(kst?.id);
    assert.equal(kst.name,'Костанай');
    assert.equal(kst.timezone,'Asia/Qostanay');

    const owner=(await query("INSERT INTO users(name,email,password_hash,role) VALUES('Owner','branch-owner@test.invalid','unused','OWNER') RETURNING id,primary_branch_id")).rows[0];
    const manager=(await query("INSERT INTO users(name,email,password_hash,role) VALUES('Manager KST','branch-manager@test.invalid','unused','MANAGER') RETURNING id,primary_branch_id")).rows[0];
    const engineer=(await query("INSERT INTO users(name,email,password_hash,role) VALUES('Engineer KST','branch-engineer@test.invalid','unused','ENGINEER') RETURNING id,primary_branch_id")).rows[0];
    assert.equal(Number(manager.primary_branch_id),Number(kst.id));
    assert.equal(Number(engineer.primary_branch_id),Number(kst.id));
    assert.equal((await query('SELECT is_primary FROM user_branches WHERE user_id=$1 AND branch_id=$2',[manager.id,kst.id])).rows[0].is_primary,true);

    const customer=(await query("INSERT INTO customers(name,phone) VALUES('Client','000') RETURNING id")).rows[0];
    const kstOrder=(await query("INSERT INTO requests(number,customer_id,manager_id,engineer_id,status,complaint) VALUES('BR-KST',$1,$2,$3,'ASSIGNED','Test') RETURNING id,branch_id",[customer.id,manager.id,engineer.id])).rows[0];
    assert.equal(Number(kstOrder.branch_id),Number(kst.id));

    const other=(await query("INSERT INTO branches(code,name,address) VALUES('TST','Тестовый филиал','Другой адрес') RETURNING id")).rows[0];
    const otherManager=(await query("INSERT INTO users(name,email,password_hash,role,primary_branch_id) VALUES('Manager TST','manager-tst@test.invalid','unused','MANAGER',$1) RETURNING id,primary_branch_id",[other.id])).rows[0];
    assert.equal(Number(otherManager.primary_branch_id),Number(other.id));

    const otherOrder=(await query("INSERT INTO requests(number,customer_id,manager_id,branch_id,status,complaint) VALUES('BR-TST',$1,$2,$3,'NEW','Other') RETURNING id,branch_id",[customer.id,otherManager.id,other.id])).rows[0];
    assert.equal(Number(otherOrder.branch_id),Number(other.id));

    assert.equal((await requireOrder(pool,{id:manager.id,role:'MANAGER'},kstOrder.id)).id,kstOrder.id);
    await assert.rejects(requireOrder(pool,{id:manager.id,role:'MANAGER'},otherOrder.id),error=>error.code==='FORBIDDEN');
    assert.equal((await requireOrder(pool,{id:owner.id,role:'OWNER'},otherOrder.id)).id,otherOrder.id);

    await assert.rejects(
      query('UPDATE requests SET engineer_id=$1 WHERE id=$2',[engineer.id,otherOrder.id]),
      error=>error.code==='P2403'
    );
    await query('INSERT INTO user_branches(user_id,branch_id,is_primary) VALUES($1,$2,false)',[engineer.id,other.id]);
    await query('UPDATE requests SET engineer_id=$1 WHERE id=$2',[engineer.id,otherOrder.id]);
    assert.equal(Number((await query('SELECT engineer_id FROM requests WHERE id=$1',[otherOrder.id])).rows[0].engineer_id),Number(engineer.id));

    await assert.rejects(
      query('INSERT INTO user_branches(user_id,branch_id,is_primary) VALUES($1,$2,true)',[manager.id,other.id]),
      error=>error.code==='23505'
    );
    await assert.rejects(
      query('UPDATE requests SET branch_id=999999 WHERE id=$1',[kstOrder.id]),
      error=>error.code==='P2403'||error.code==='23503'
    );
  }finally{await db.close();}
});
