import {test} from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import jwt from '@fastify/jwt';
import {PGlite} from '@electric-sql/pglite';
import {migrateCore} from '../src/migrate.js';
import {registerDirectoryRoutes} from '../src/directory-routes.js';
import {registerOrderViewRoutes,DEFAULT_ORDER_COLUMNS} from '../src/order-views.js';

test('Personal order views and columns preserve row authorization and custom field scopes',async t=>{
 const db=await PGlite.create(),query=(sql,p=[])=>p.length?db.query(sql,p):db.exec(sql).then(r=>r.at(-1));
 let queue=Promise.resolve();const pool={query,connect:async()=>{const prior=queue;let release;queue=new Promise(r=>release=r);await prior;return{query,release}}};
 await migrateCore(pool);
 await query("INSERT INTO users(name,email,password_hash,role) VALUES('Owner','views-owner@test.invalid','unused','OWNER'),('Manager','views-manager@test.invalid','unused','MANAGER'),('Foreign manager','views-foreign@test.invalid','unused','MANAGER'),('Engineer','views-engineer@test.invalid','unused','ENGINEER'),('Supervisor','views-supervisor@test.invalid','unused','SUPERVISOR'),('Accountant','views-accountant@test.invalid','unused','ACCOUNTANT'),('Trainee','views-trainee@test.invalid','unused','TRAINEE')");
 const kst=(await query("SELECT id FROM branches WHERE code='KST'")).rows[0].id;
 const foreign=(await query("INSERT INTO branches(code,name) VALUES('VIEWS-FOREIGN','Foreign') RETURNING id")).rows[0].id;
 await query('INSERT INTO user_branches(user_id,branch_id) VALUES(4,$1) ON CONFLICT DO NOTHING',[foreign]);
 await query('UPDATE users SET primary_branch_id=$1 WHERE id=3',[foreign]);await query('DELETE FROM user_branches WHERE user_id=3 AND branch_id=$1',[kst]);
 await query("INSERT INTO customers(name,phone) VALUES('Synthetic views client','701')");
 await query("INSERT INTO equipment(customer_id,category,brand,model) VALUES(1,'Washer','BOSCH','Fixture')");
 await query("INSERT INTO order_field_defs(code,label,field_type) VALUES('view_note','Additional note','TEXT'),('view_hidden','Hidden','TEXT')");
 await query("UPDATE order_field_defs SET active=false WHERE code='view_hidden'");
 const own=(await query("INSERT INTO requests(number,customer_id,equipment_id,manager_id,engineer_id,branch_id,status,complaint,custom_fields) VALUES('VIEW-OWN',1,1,2,4,$1,'WAITING_PART','Synthetic','{\"view_note\":\"<b>plain text</b>\",\"view_hidden\":\"Hidden value\"}') RETURNING id",[kst])).rows[0].id;
 const other=(await query("INSERT INTO requests(number,customer_id,equipment_id,manager_id,engineer_id,branch_id,status,complaint) VALUES('VIEW-FOREIGN',1,1,3,4,$1,'WAITING_PART','Synthetic') RETURNING id",[foreign])).rows[0].id;
 const contract=(await query("INSERT INTO service_contracts(number,customer_id,branch_id,start_date) VALUES('VIEW-CONTRACT',1,$1,current_date) RETURNING id",[kst])).rows[0].id;
 const asset=(await query("INSERT INTO service_contract_assets(contract_id,equipment_id,interval_months,next_service_date) VALUES($1,1,3,current_date) RETURNING id",[contract])).rows[0].id;
 await query('INSERT INTO service_maintenance_cycles(contract_asset_id,due_date,request_id) VALUES($1,current_date,$2)',[asset,own]);
 const app=Fastify();await app.register(jwt,{secret:'views-test-secret'});registerDirectoryRoutes(app,pool);registerOrderViewRoutes(app,pool);await app.ready();
 const call=(id,url,method='GET',payload)=>app.inject({url,method,payload,headers:{authorization:'Bearer '+app.jwt.sign({id,role:'OWNER'})}});
 try{
 await t.test('all six roles can save private views; owner cannot delete another employee view',async()=>{
  for(const id of [1,2,4,5,6,7]){
   const r=await call(id,'/api/v1/directory/order-views','POST',{name:'Мои заказы',filters:{status:'ACTIVE',only_mine:true}});assert.equal(r.statusCode,201);
   const personal=(await call(id,'/api/v1/directory/order-views')).json();assert.equal(personal.data.length,1);assert.equal(personal.data[0].name,'Мои заказы');
   if(id!==1)assert.equal((await call(1,'/api/v1/directory/order-views/'+r.json().data.id,'DELETE')).statusCode,404);
  }
  assert.equal((await app.inject('/api/v1/directory/order-views')).statusCode,401);
 });
 await t.test('view validation, case-insensitive names and atomic maximum count',async()=>{
  for(const filters of [{status:'BOGUS'},{engineer_id:-1},{contract_id:'1'},{only_mine:'true'},{brand:{}},{branch_id:foreign},{user_id:1}])assert.equal((await call(2,'/api/v1/directory/order-views','POST',{name:'Invalid',filters})).statusCode,422);
  assert.equal((await call(2,'/api/v1/directory/order-views','POST',{name:'МОИ ЗАКАЗЫ',filters:{}})).statusCode,409);
  assert.equal((await call(2,'/api/v1/directory/order-views','POST',{user_id:1,name:'Spoof',filters:{}})).statusCode,422);
  for(let i=1;i<20;i++)assert.equal((await call(2,'/api/v1/directory/order-views','POST',{name:'View '+i,filters:{}})).statusCode,201);
  assert.equal((await call(2,'/api/v1/directory/order-views','POST',{name:'Overflow',filters:{}})).statusCode,422);
 });
 await t.test('saved filters use server-side pagination/counts and never widen branch access',async()=>{
  const url='/api/v1/directory/orders?status=PART&brand=BOSCH&order_type=REPAIR&engineer_id=4&contract_id='+contract;
  const r=(await call(2,url)).json();assert.deepEqual(r.data.map(x=>x.id),[own]);assert.equal(r.meta.total,1);assert.equal(r.meta.counts.part,1);
  assert.deepEqual(r.data[0].custom_fields,{view_note:'<b>plain text</b>'});
  assert.deepEqual((await call(3,url)).json().data,[]);
  assert.deepEqual((await call(2,'/api/v1/directory/orders?status=ALL&only_mine=true')).json().data.map(x=>x.id),[own]);
  assert.deepEqual((await call(1,'/api/v1/directory/orders?status=ALL&only_mine=true')).json().data,[]);
  assert.equal((await call(2,'/api/v1/directory/orders?engineer_id=0')).statusCode,422);
  const exported=await call(2,url.replace('/orders?','/orders/export?'));assert.equal(exported.statusCode,200);assert.match(exported.headers['content-type'],/spreadsheetml/);
  const metadata=(await call(3,'/api/v1/directory/order-views')).json().meta;assert.deepEqual(metadata.contracts,[]);
 });
 await t.test('column visibility/order is private and stale/disabled custom columns are removed',async()=>{
  const columns=['number','status','custom:view_note'];
  assert.equal((await call(2,'/api/v1/directory/order-columns','PUT',{columns})).statusCode,200);
  assert.deepEqual((await call(2,'/api/v1/directory/order-views')).json().meta.columns,columns);
  assert.deepEqual((await call(3,'/api/v1/directory/order-views')).json().meta.columns,DEFAULT_ORDER_COLUMNS);
  for(const invalid of [[],['status'],['number','number'],['number','direct_cost'],['number','custom:view_hidden']])assert.equal((await call(2,'/api/v1/directory/order-columns','PUT',{columns:invalid})).statusCode,422);
  await query("UPDATE order_field_defs SET active=false WHERE code='view_note'");
  assert.deepEqual((await call(2,'/api/v1/directory/order-views')).json().meta.columns,['number','status']);
  assert.deepEqual((await call(2,'/api/v1/directory/orders?status=ALL')).json().data[0].custom_fields,{});
 });
 await t.test('inactive staff cannot retrieve or change preferences',async()=>{
  await query('UPDATE users SET active=false WHERE id=2');assert.equal((await call(2,'/api/v1/directory/order-views')).statusCode,403);
 });
 }finally{await app.close();await db.close()}
});
