import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {migrateCore} from '../src/migrate.js';
import {requireOrder} from '../src/access.js';
import {
  ROLE_CODES,ROLE_LABELS,canAccessAllOrders,canAdminFinance,canMutateOrder,
  isAssignedOnly,roleAllowed
} from '../src/rbac.js';

test('матрица содержит ровно шесть ролей из ТЗ',()=>{
  assert.deepEqual(ROLE_CODES,['OWNER','SUPERVISOR','ACCOUNTANT','MANAGER','ENGINEER','TRAINEE']);
  assert.equal(ROLE_LABELS.SUPERVISOR,'Управляющий');
  assert.equal(ROLE_LABELS.ACCOUNTANT,'Бухгалтер');
  assert.equal(roleAllowed('SUPERVISOR',['MANAGER']),true);
  assert.equal(canAdminFinance('ACCOUNTANT'),true);
  assert.equal(canAdminFinance('MANAGER'),false);
  assert.equal(canAccessAllOrders('ACCOUNTANT'),true);
  assert.equal(isAssignedOnly('ENGINEER'),true);
  assert.equal(isAssignedOnly('TRAINEE'),true);
});

test('операционные изменения разделены между бухгалтером и стажёром',()=>{
  assert.equal(canMutateOrder('ACCOUNTANT',{service:'index2',route:'/api/v1/requests/:id/payment',method:'POST'}),true);
  assert.equal(canMutateOrder('ACCOUNTANT',{service:'index2',route:'/api/v1/requests/:id/diagnosis',method:'POST'}),false);
  assert.equal(canMutateOrder('TRAINEE',{service:'index2',route:'/api/v1/requests/:id/notes',method:'POST'}),true);
  assert.equal(canMutateOrder('TRAINEE',{service:'index2',route:'/api/v1/requests/:id/works',method:'POST'}),false);
  assert.equal(canMutateOrder('ENGINEER',{service:'index2',route:'/api/v1/requests/:id/works',method:'POST'}),true);
});

test('миграция принимает шесть ролей и БД отвергает неизвестную роль',async()=>{
  const db=await PGlite.create();
  const query=(sql,params=[])=>params.length?db.query(sql,params):db.exec(sql).then(r=>r.at(-1));
  const pool={query,connect:async()=>({query,release(){}}),end:async()=>{}};
  try{
    await migrateCore(pool);
    for(const [i,role] of ROLE_CODES.entries()){
      await query('INSERT INTO users(name,email,password_hash,role) VALUES($1,$2,$3,$4)',[role,`role-${i}@test.invalid`,'unused',role]);
    }
    assert.equal(Number((await query('SELECT count(*) n FROM users')).rows[0].n),6);
    await assert.rejects(
      query("INSERT INTO users(name,email,password_hash,role) VALUES('Bad','bad@test.invalid','unused','ADMIN')"),
      error=>error.code==='23514'
    );
  }finally{await db.close();}
});

test('инженер и стажёр видят только назначенные заказы, офисные роли видят все',async()=>{
  const db=await PGlite.create();
  const query=(sql,params=[])=>params.length?db.query(sql,params):db.exec(sql).then(r=>r.at(-1));
  const pool={query,connect:async()=>({query,release(){}}),end:async()=>{}};
  try{
    await migrateCore(pool);
    for(const [i,role] of ROLE_CODES.entries()){
      await query('INSERT INTO users(name,email,password_hash,role) VALUES($1,$2,$3,$4)',[role,`scope-${i}@test.invalid`,'unused',role]);
    }
    await query("INSERT INTO customers(name,phone) VALUES('Client','000')");
    const engineerOrder=(await query("INSERT INTO requests(number,customer_id,engineer_id,status,complaint) VALUES('RBAC-E',1,5,'REPAIR','Test') RETURNING id")).rows[0].id;
    const traineeOrder=(await query("INSERT INTO requests(number,customer_id,engineer_id,status,complaint) VALUES('RBAC-T',1,6,'REPAIR','Test') RETURNING id")).rows[0].id;
    for(const id of [1,2,3,4]){
      const user=(await query('SELECT id,role FROM users WHERE id=$1',[id])).rows[0];
      assert.equal((await requireOrder(pool,user,engineerOrder)).id,engineerOrder,user.role);
      assert.equal((await requireOrder(pool,user,traineeOrder)).id,traineeOrder,user.role);
    }
    assert.equal((await requireOrder(pool,{id:5,role:'ENGINEER'},engineerOrder)).id,engineerOrder);
    assert.equal((await requireOrder(pool,{id:6,role:'TRAINEE'},traineeOrder)).id,traineeOrder);
    await assert.rejects(requireOrder(pool,{id:5,role:'ENGINEER'},traineeOrder),error=>error.code==='FORBIDDEN');
    await assert.rejects(requireOrder(pool,{id:6,role:'TRAINEE'},engineerOrder),error=>error.code==='FORBIDDEN');
  }finally{await db.close();}
});
