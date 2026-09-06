import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {migrateCore} from '../src/migrate.js';
import {requireOrder} from '../src/access.js';
import {
  ROLE_CODES,ROLE_LABELS,PERMISSIONS,can,permissionsForRole,canAccessAllOrders,canAdminFinance,canMutateOrder,
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

test('permission layer разделяет операционные, финансовые, филиальные и критические права',()=>{
  const P=PERMISSIONS;
  assert.equal(can('OWNER',P.ROLES_MANAGE),true);
  assert.equal(can('OWNER',P.BRANCHES_MANAGE),true);
  assert.equal(can('SUPERVISOR',P.STAFF_MANAGE),true);
  assert.equal(can('SUPERVISOR',P.BRANCHES_MANAGE),true);
  assert.equal(can('SUPERVISOR',P.ROLES_MANAGE),false);
  assert.equal(can('SUPERVISOR',P.FINANCE_ADJUST),false);
  assert.equal(can('SUPERVISOR',P.PROCUREMENT_MANAGE),true);
  assert.equal(can('ACCOUNTANT',P.FINANCE_ADJUST),true);
  assert.equal(can('ACCOUNTANT',P.ORDERS_TECHNICAL),false);
  assert.equal(can('ACCOUNTANT',P.PROCUREMENT_VIEW),true);
  assert.equal(can('ACCOUNTANT',P.PROCUREMENT_MANAGE),false);
  assert.equal(can('ACCOUNTANT',P.BRANCHES_VIEW),true);
  assert.equal(can('ACCOUNTANT',P.BRANCHES_MANAGE),false);
  assert.equal(can('MANAGER',P.FINANCE_RECEIVE_PAYMENT),true);
  assert.equal(can('MANAGER',P.PAYROLL_VIEW),false);
  assert.equal(can('MANAGER',P.PROCUREMENT_MANAGE),true);
  assert.equal(can('MANAGER',P.BRANCHES_VIEW),true);
  assert.equal(can('MANAGER',P.BRANCHES_MANAGE),false);
  assert.equal(can('ENGINEER',P.ORDERS_TECHNICAL),true);
  assert.equal(can('ENGINEER',P.FINANCE_VIEW),false);
  assert.equal(can('ENGINEER',P.PROCUREMENT_VIEW),false);
  assert.equal(can('ENGINEER',P.BRANCHES_VIEW),true);
  assert.equal(can('TRAINEE',P.ORDERS_NOTES),true);
  assert.equal(can('TRAINEE',P.ORDERS_TECHNICAL),false);
  assert.equal(can('TRAINEE',P.WAREHOUSE_VIEW),false);
  assert.equal(can('TRAINEE',P.PROCUREMENT_VIEW),false);
  assert.equal(can('TRAINEE',P.BRANCHES_VIEW),true);
  assert.ok(permissionsForRole('OWNER').length>permissionsForRole('SUPERVISOR').length);
  assert.deepEqual(permissionsForRole('UNKNOWN'),[]);
});

test('операционные изменения разделены между бухгалтером, инженером и стажёром',()=>{
  assert.equal(canMutateOrder('ACCOUNTANT',{service:'index2',route:'/api/v1/requests/:id/payment',method:'POST'}),true);
  assert.equal(canMutateOrder('ACCOUNTANT',{service:'index2',route:'/api/v1/requests/:id/diagnosis',method:'POST'}),false);
  assert.equal(canMutateOrder('TRAINEE',{service:'index2',route:'/api/v1/requests/:id/notes',method:'POST'}),true);
  assert.equal(canMutateOrder('TRAINEE',{service:'index2',route:'/api/v1/requests/:id/works',method:'POST'}),false);
  assert.equal(canMutateOrder('ENGINEER',{service:'index2',route:'/api/v1/requests/:id/works',method:'POST'}),true);
  assert.equal(canMutateOrder('ENGINEER',{service:'index2',route:'/api/v1/requests/:id/payment',method:'POST'}),false);
  assert.equal(canMutateOrder('ENGINEER',{service:'index2',route:'/api/v1/requests/:id/schedule',method:'PATCH'}),false);
  assert.equal(canMutateOrder('ENGINEER',{service:'index2',route:'/api/v1/requests/:id/close',method:'POST'}),false);
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

test('стажёр получает заказ только как участник заказа своего активного наставника и не может быть основным инженером',async()=>{
  const db=await PGlite.create();
  const query=(sql,params=[])=>params.length?db.query(sql,params):db.exec(sql).then(r=>r.at(-1));
  const pool={query,connect:async()=>({query,release(){}}),end:async()=>{}};
  try{
    await migrateCore(pool);
    for(const [i,role] of ROLE_CODES.entries()){
      await query('INSERT INTO users(name,email,password_hash,role) VALUES($1,$2,$3,$4)',[role,`scope-${i}@test.invalid`,'unused',role]);
    }
    await query("INSERT INTO customers(name,phone) VALUES('Client','000')");
    const mentorOrder=(await query("INSERT INTO requests(number,customer_id,engineer_id,status,complaint) VALUES('RBAC-E',1,5,'REPAIR','Test') RETURNING id")).rows[0].id;
    const otherMentorOrder=(await query("INSERT INTO requests(number,customer_id,engineer_id,status,complaint) VALUES('RBAC-E2',1,5,'REPAIR','Test') RETURNING id")).rows[0].id;
    await assert.rejects(
      query("INSERT INTO requests(number,customer_id,engineer_id,status,complaint) VALUES('RBAC-T',1,6,'REPAIR','Test')"),
      error=>error.code==='P2403'
    );
    await query('INSERT INTO user_mentors(trainee_id,mentor_id,assigned_by) VALUES(6,5,1)');
    await query("INSERT INTO request_participants(request_id,user_id,participant_role,mentor_id,added_by) VALUES($1,6,'TRAINEE',5,1)",[mentorOrder]);

    for(const id of [1,2,3,4]){
      const user=(await query('SELECT id,role FROM users WHERE id=$1',[id])).rows[0];
      assert.equal((await requireOrder(pool,user,mentorOrder)).id,mentorOrder,user.role);
    }
    assert.equal((await requireOrder(pool,{id:5,role:'ENGINEER'},mentorOrder)).id,mentorOrder);
    assert.equal((await requireOrder(pool,{id:5,role:'ENGINEER'},otherMentorOrder)).id,otherMentorOrder);
    assert.equal((await requireOrder(pool,{id:6,role:'TRAINEE'},mentorOrder)).id,mentorOrder);
    await assert.rejects(requireOrder(pool,{id:6,role:'TRAINEE'},otherMentorOrder),error=>error.code==='FORBIDDEN');

    await query('UPDATE user_mentors SET mentor_id=1,updated_at=now() WHERE trainee_id=6');
    await assert.rejects(requireOrder(pool,{id:6,role:'TRAINEE'},mentorOrder),error=>error.code==='FORBIDDEN');
  }finally{await db.close();}
});
