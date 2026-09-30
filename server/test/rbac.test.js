import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {migrateCore} from '../src/migrate.js';
import {requireOrder} from '../src/access.js';
import {
  ROLE_CODES,ROLE_LABELS,PERMISSIONS,can,permissionsForRole,permissionsForUser,canAccessAllOrders,canAdminFinance,canMutateOrder,
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
  assert.equal(can('SUPERVISOR',P.COST_VIEW),true);
  assert.equal(can('SUPERVISOR',P.COST_EDIT),true);
  assert.equal(can('SUPERVISOR',P.ORDERS_DISCOUNT),false);
  assert.equal(can('ACCOUNTANT',P.COST_VIEW),true);
  assert.equal(can('ACCOUNTANT',P.COST_EDIT),false);
  assert.equal(can('MANAGER',P.ORDERS_DISCOUNT),true);
  assert.equal(can('MANAGER',P.COST_VIEW),true);
  assert.equal(can('MANAGER',P.COST_EDIT),true);
  assert.equal(can('ENGINEER',P.COST_VIEW),false);
  assert.equal(can('ENGINEER',P.COST_EDIT),false);
  assert.equal(can('ENGINEER',P.ORDERS_DISCOUNT),false);
  assert.equal(can('OWNER',P.ORDERS_DISCOUNT),true);
  assert.equal(can('OWNER',P.COST_VIEW),true);
  assert.equal(can('OWNER',P.COST_EDIT),true);
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

test('индивидуальные overrides добавляют и отнимают права поверх роли',()=>{
  const P=PERMISSIONS;
  const manager={role:'MANAGER',permission_overrides:{[P.ORDERS_DISCOUNT]:false,[P.FINANCE_REFUND]:true}};
  assert.equal(can('MANAGER',P.ORDERS_DISCOUNT),true);
  assert.equal(can(manager,P.ORDERS_DISCOUNT),false);
  assert.equal(can('MANAGER',P.FINANCE_REFUND),false);
  assert.equal(can(manager,P.FINANCE_REFUND),true);
  assert.ok(!permissionsForUser(manager).includes(P.ORDERS_DISCOUNT));
  assert.ok(permissionsForUser(manager).includes(P.FINANCE_REFUND));
  assert.equal(can({role:'MANAGER',permission_overrides:{}},P.ORDERS_DISCOUNT),true);
  assert.equal(canMutateOrder(manager,{service:'index2',route:'/api/v1/requests/:id/discount',method:'POST'}),false);
  assert.equal(canMutateOrder({...manager,permission_overrides:{[P.ORDERS_DISCOUNT]:true}},{service:'index2',route:'/api/v1/requests/:id/discount',method:'POST'}),true);
});

test('Stage D разделяет зарплату, сводку ФОТ, self-view и управление KPI',()=>{
  const P=PERMISSIONS;
  assert.equal(can('OWNER',P.PAYROLL_VIEW),true);
  assert.equal(can('OWNER',P.PAYROLL_MANAGE),true);
  assert.equal(can('OWNER',P.PAYROLL_SUMMARY_VIEW),true);
  assert.equal(can('OWNER',P.KPI_VIEW_ALL),true);
  assert.equal(can('OWNER',P.KPI_MANAGE),true);

  assert.equal(can('SUPERVISOR',P.PAYROLL_VIEW),false);
  assert.equal(can('SUPERVISOR',P.PAYROLL_MANAGE),false);
  assert.equal(can('SUPERVISOR',P.PAYROLL_SUMMARY_VIEW),true);
  assert.equal(can('SUPERVISOR',P.KPI_VIEW_ALL),true);
  assert.equal(can('SUPERVISOR',P.KPI_MANAGE),true);

  assert.equal(can('ACCOUNTANT',P.PAYROLL_VIEW),true);
  assert.equal(can('ACCOUNTANT',P.PAYROLL_MANAGE),true);
  assert.equal(can('ACCOUNTANT',P.PAYROLL_SUMMARY_VIEW),true);
  assert.equal(can('ACCOUNTANT',P.KPI_VIEW_ALL),true);
  assert.equal(can('ACCOUNTANT',P.KPI_MANAGE),false);

  assert.equal(can('MANAGER',P.PAYROLL_VIEW),false);
  assert.equal(can('MANAGER',P.PAYROLL_SELF_VIEW),true);
  assert.equal(can('MANAGER',P.KPI_VIEW_SELF),true);
  assert.equal(can('MANAGER',P.KPI_VIEW_ALL),false);
  assert.equal(can('MANAGER',P.KPI_MANAGE),false);

  assert.equal(can('ENGINEER',P.PAYROLL_SELF_VIEW),true);
  assert.equal(can('ENGINEER',P.KPI_VIEW_SELF),true);
  assert.equal(can('ENGINEER',P.KPI_VIEW_ALL),false);
  assert.equal(can('TRAINEE',P.PAYROLL_SELF_VIEW),true);
  assert.equal(can('TRAINEE',P.KPI_VIEW_SELF),false);
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
    assert.equal((await query("SELECT to_regclass('public.user_permission_overrides') name")).rows[0].name,'user_permission_overrides');
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

test('отдельные права технических операций, комментариев и файлов независимы',()=>{
  const subject=overrides=>({role:'ENGINEER',permission_overrides:overrides});
  const denied=subject({'orders.technical':false});
  for(const operation of [
    {service:'index2',route:'/api/v1/requests/:id/diagnosis',method:'POST'},
    {service:'index2',route:'/api/v1/requests/:id/works',method:'POST'},
    {service:'diagnostic-flow',route:'/api/v1/requests/:id/diagnosis',method:'PUT'},
    {service:'completion',route:'/api/v1/requests/:id/repair-done',method:'POST'}
  ])assert.equal(canMutateOrder(denied,operation),false,operation.service+operation.route);
  const notes={service:'index2',route:'/api/v1/requests/:id/notes',method:'POST'};
  const files={service:'documents',route:'/api/v1/requests/:id/files',method:'POST'};
  assert.equal(canMutateOrder(denied,notes),true);
  assert.equal(canMutateOrder(denied,files),true);
  assert.equal(canMutateOrder(subject({'orders.notes':false}),notes),false);
  assert.equal(canMutateOrder(subject({'orders.files':false}),files),false);
  assert.equal(canMutateOrder(subject({'orders.notes':false,'orders.files':false}),{service:'index2',route:'/api/v1/requests/:id/diagnosis',method:'POST'}),true);
});
