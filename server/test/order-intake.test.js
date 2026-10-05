import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import Fastify from 'fastify';
import jwt from '@fastify/jwt';
import {PGlite} from '@electric-sql/pglite';
import {migrateCore} from '../src/migrate.js';
import {registerOrderIntakeRoutes} from '../src/order-intake.js';

test('Atomic order intake: retries, rollback and current authorization',async t=>{
 const db=await PGlite.create(),query=(sql,p=[])=>p.length?db.query(sql,p):db.exec(sql).then(r=>r.at(-1));
 let queue=Promise.resolve(),failHistory=false;
 const pool={query,connect:async()=>{const prior=queue;let release;queue=new Promise(r=>release=r);await prior;return{query:async(sql,p)=>{if(failHistory&&sql.startsWith('INSERT INTO request_history'))throw Error('synthetic history failure');return query(sql,p)},release}}};
 await migrateCore(pool);
 await query("INSERT INTO users(name,email,password_hash,role) VALUES('Owner','intake-owner@test.invalid','unused','OWNER'),('Manager','intake-manager@test.invalid','unused','MANAGER'),('Foreign','intake-foreign@test.invalid','unused','MANAGER'),('Engineer','intake-engineer@test.invalid','unused','ENGINEER'),('Foreign engineer','intake-engineer2@test.invalid','unused','ENGINEER'),('Accountant','intake-accountant@test.invalid','unused','ACCOUNTANT')");
 const kst=(await query("SELECT id FROM branches WHERE code='KST'")).rows[0].id,foreign=(await query("INSERT INTO branches(code,name) VALUES('INTAKE-OTHER','Other') RETURNING id")).rows[0].id;
 for(const id of [3,5]){await query('UPDATE users SET primary_branch_id=$1 WHERE id=$2',[foreign,id]);await query('DELETE FROM user_branches WHERE user_id=$1 AND branch_id=$2',[id,kst])}
 const app=Fastify();await app.register(jwt,{secret:'intake-test-secret'});registerOrderIntakeRoutes(app,pool);await app.ready();
 let phone=7000000000;
 const body=()=>({customer:{name:'Synthetic client',phone:String(++phone),address:'Synthetic'},equipment:{category:'Washer',brand:'Fixture'},order:{complaint:'Synthetic intake',order_type:'FIELD',visit_type:'FIELD',engineer_id:4,custom_fields:{}}});
 const call=(user,payload,key=randomUUID())=>app.inject({method:'POST',url:'/api/v1/requests/intake',payload,headers:{authorization:'Bearer '+app.jwt.sign({id:user,role:'OWNER'}),'x-idempotency-key':key}});
 const counts=async()=>{const result={};for(const table of ['customers','equipment','requests','request_history','order_intake_operations'])result[table]=Number((await query('SELECT count(*) n FROM '+table)).rows[0].n);return result};
 let saved,savedBody,savedKey;
 try{
 await t.test('lost response replay and simultaneous retries create one complete graph',async()=>{
  savedBody=body();savedKey=randomUUID();const before=await counts();
  const results=await Promise.all([call(2,savedBody,savedKey),call(2,savedBody,savedKey)]);
  assert.deepEqual(results.map(r=>r.statusCode).sort(),[200,201]);saved=results[0].json().data;
  assert.equal(results[1].json().data.id,saved.id);
  const after=await counts();assert.deepEqual(after,{customers:before.customers+1,equipment:before.equipment+1,requests:before.requests+1,request_history:before.request_history+2,order_intake_operations:before.order_intake_operations+1});
  const replay=await call(2,{order:savedBody.order,equipment:savedBody.equipment,customer:savedBody.customer},savedKey);assert.equal(replay.statusCode,200);assert.equal(replay.json().data.replayed,true);assert.deepEqual(await counts(),after);
  assert.equal((await call(2,{...savedBody,order:{...savedBody.order,complaint:'Different'}},savedKey)).statusCode,409);
  assert.deepEqual(await counts(),after);
 });
 await t.test('failed history rolls back client, equipment, order and key; same key can retry',async()=>{
  const payload=body(),key=randomUUID(),before=await counts();failHistory=true;
  assert.equal((await call(2,payload,key)).statusCode,500);failHistory=false;assert.deepEqual(await counts(),before);
  assert.equal((await call(2,payload,key)).statusCode,201);
 });
 await t.test('required custom fields, invalid engineer and unsupported scenario write nothing',async()=>{
  await query("INSERT INTO order_field_defs(code,label,field_type,required,order_types) VALUES('intake_note','Intake note','TEXT',true,ARRAY['PAID_WORKSHOP'])");
  const before=await counts();
  for(const order of [{order_type:'SALE'},{order_type:'PAID_WORKSHOP',visit_type:'FIELD'},{order_type:'PAID_WORKSHOP',visit_type:'WORKSHOP'},{engineer_id:5},{engineer_id:6},{priority:'BOGUS'},{custom_fields:{unknown:'value'}}])assert.equal((await call(2,{...body(),order:{...body().order,...order}})).statusCode,422);
  assert.deepEqual(await counts(),before);
  const payload=body();payload.order={complaint:'Workshop fixture',order_type:'PAID_WORKSHOP',visit_type:'WORKSHOP',custom_fields:{intake_note:'Saved'}};
  const r=await call(2,payload);assert.equal(r.statusCode,201);assert.equal((await query('SELECT custom_fields FROM requests WHERE id=$1',[r.json().data.id])).rows[0].custom_fields.intake_note,'Saved');
 });
 await t.test('existing records are checked for customer ownership, soft deletion and branch',async()=>{
  const before=await counts(),order={complaint:'Existing fixture',engineer_id:4};
  const payload={customer_id:saved.customer_id,equipment_id:saved.equipment_id,order};
  assert.equal((await call(3,payload)).statusCode,422); // engineer must first belong to caller branch
  assert.equal((await call(3,{...payload,order:{...order,engineer_id:null}})).statusCode,404);
  const another=(await query("INSERT INTO customers(name,phone) VALUES('Unrelated fixture','999') RETURNING id")).rows[0].id;
  assert.equal((await call(1,{...payload,customer_id:another})).statusCode,404);
  await query('UPDATE equipment SET deleted_at=now() WHERE id=$1',[saved.equipment_id]);assert.equal((await call(2,payload)).statusCode,404);await query('UPDATE equipment SET deleted_at=NULL WHERE id=$1',[saved.equipment_id]);
  const after=await counts();assert.deepEqual({...after,customers:after.customers-1},before);
  const r=await call(2,payload);assert.equal(r.statusCode,201);assert.equal(r.json().data.equipment_id,saved.equipment_id);assert.equal((await counts()).equipment,before.equipment);
 });
 await t.test('duplicate phones never expose foreign client details',async()=>{
  const before=await counts();const r=await call(3,{...savedBody,order:{complaint:'Other branch fixture'}});
  assert.equal(r.statusCode,409);assert.equal(r.json().error.code,'POSSIBLE_DUPLICATE_CUSTOMER');assert.equal(r.json().error.candidate,undefined);assert.equal(r.json().data,null);assert.deepEqual(await counts(),before);
 });
 await t.test('replays enforce current branch, active account and permission overrides',async()=>{
  const before=await counts();await query('DELETE FROM user_branches WHERE user_id=2');assert.equal((await call(2,savedBody,savedKey)).statusCode,403);
  await query('INSERT INTO user_branches(user_id,branch_id,is_primary) VALUES(2,$1,true)',[kst]);
  await query("INSERT INTO user_permission_overrides(user_id,permission,allowed) VALUES(2,'orders.create',false)");assert.equal((await call(2,savedBody,savedKey)).statusCode,403);
  await query('DELETE FROM user_permission_overrides WHERE user_id=2');await query('UPDATE users SET active=false WHERE id=2');assert.equal((await call(2,savedBody,savedKey)).statusCode,403);
  assert.equal((await call(4,body())).statusCode,403);assert.equal((await call(6,body())).statusCode,403);
  assert.equal((await app.inject({method:'POST',url:'/api/v1/requests/intake',payload:body()})).statusCode,401);
  assert.equal((await call(1,body(),'invalid-key')).statusCode,422);assert.deepEqual(await counts(),before);
 });
 }finally{await app.close();await db.close()}
});
