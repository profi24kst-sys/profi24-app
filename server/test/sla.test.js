import {test} from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import jwt from '@fastify/jwt';
import {PGlite} from '@electric-sql/pglite';
import {migrateCore} from '../src/migrate.js';
import {cancelOrder} from '../src/order-financial-actions.js';
import {slaStatements} from '../src/sla-schema.js';
import {registerSlaRoutes,syncSlaControls} from '../src/sla.js';

test('SLA clocks, policies, holds, legacy records and automatic controls',async t=>{
 const db=await PGlite.create();
 const query=(sql,params=[])=>params.length?db.query(sql,params):db.exec(sql).then(results=>results.at(-1));
 const pool={query,connect:async()=>({query,release(){}})};
 await migrateCore(pool);
 await query("INSERT INTO users(name,email,password_hash,role) VALUES('Owner','sla-owner@test.invalid','unused','OWNER'),('Supervisor','sla-supervisor@test.invalid','unused','SUPERVISOR'),('Manager','sla-manager@test.invalid','unused','MANAGER'),('Engineer','sla-engineer@test.invalid','unused','ENGINEER')");
 await query("INSERT INTO customers(name,phone,phone_norm) VALUES('Synthetic SLA','77000000001','77000000001')");
 const create=async(number,extra='')=>(await query(`INSERT INTO requests(number,customer_id,complaint,manager_id${extra?',created_at':''}) VALUES($1,1,'Synthetic fixture',3${extra?','+extra:''}) RETURNING *`,[number])).rows[0];
 const read=async id=>(await query('SELECT * FROM requests WHERE id=$1',[id])).rows[0];
 const app=Fastify();await app.register(jwt,{secret:'sla-test-secret'});registerSlaRoutes(app,pool);await app.ready();
 const call=(id,url,method='GET',payload)=>app.inject({url,method,payload,headers:{authorization:'Bearer '+app.jwt.sign({id,role:'OWNER'})}});
 try{
 await t.test('settings use current database role and validate bounded integers',async()=>{
  assert.equal((await call(1,'/api/v1/sla/policies')).json().data.length,6);
  assert.equal((await call(2,'/api/v1/sla/policies')).statusCode,200);
  for(const id of [3,4])assert.equal((await call(id,'/api/v1/sla/policies')).statusCode,403);
  assert.equal((await app.inject('/api/v1/sla/policies')).statusCode,401);
  for(const value of [0,-1,1.5,525601,'60',null])assert.equal((await call(1,'/api/v1/sla/policies/REPAIR/NORMAL','PUT',{reaction_minutes:value,execution_minutes:120})).statusCode,422);
 });
 const order=await create('SLA-NEW');
 await t.test('snapshot policy, acceptance changes phase once, priority edits do not reset time',async()=>{
  assert.equal(order.sla_reaction_minutes,60);assert.equal(order.sla_execution_minutes,4320);
  assert.equal(+new Date(order.sla_deadline)-+new Date(order.created_at),3600000);
  assert.equal(order.sla_execution_deadline,null);
  assert.equal((await call(1,'/api/v1/sla/policies/REPAIR/NORMAL','PUT',{reaction_minutes:90,execution_minutes:120})).statusCode,200);
  await query("UPDATE requests SET status='ACCEPTED',priority='CRITICAL' WHERE id=$1",[order.id]);
  const accepted=await read(order.id);
  assert.equal(accepted.sla_execution_minutes,4320);
  assert.equal(+new Date(accepted.sla_deadline)-+new Date(accepted.sla_reacted_at),4320*60000);
  await query("UPDATE requests SET status='DIAGNOSTICS' WHERE id=$1",[order.id]);
  assert.equal(+new Date((await read(order.id)).sla_deadline),+new Date(accepted.sla_deadline));
  assert.equal((await create('SLA-UPDATED')).sla_execution_minutes,120);
 });
 await t.test('pause/resume excludes elapsed hold without resetting historical reaction',async()=>{
  const before=await read(order.id);
  await query("INSERT INTO request_holds(request_id,hold_type,reason,previous_status,previous_sla_deadline,started_by,started_at) VALUES($1,'WAITING_PART','Synthetic hold','DIAGNOSTICS',$2,1,now()-interval '2 hours')",[order.id,before.sla_deadline]);
  await query('UPDATE requests SET sla_deadline=NULL WHERE id=$1',[order.id]);
  const paused=await read(order.id);assert.equal(paused.sla_deadline,null);assert.ok(paused.sla_paused_at);
  await query('BEGIN');
  await query("UPDATE request_holds SET resumed_at=now(),resumed_by=1,resolution='Synthetic resume' WHERE request_id=$1",[order.id]);
  const elapsed=(await query('SELECT EXTRACT(EPOCH FROM (now()-$1::timestamptz))*1000 ms',[paused.sla_paused_at])).rows[0].ms;
  await query('UPDATE requests SET sla_deadline=$2::timestamptz WHERE id=$1',[order.id,before.sla_deadline]);
  const resumed=await read(order.id);await query('COMMIT');
  assert.equal(resumed.sla_paused_at,null);
  assert.ok(Math.abs(+new Date(resumed.sla_deadline)-+new Date(before.sla_deadline)-Number(elapsed))<2);
  assert.equal(+new Date(resumed.sla_reaction_deadline),+new Date(before.sla_reaction_deadline));
 });
 await t.test('finished technical work stops SLA; reopening keeps original execution deadline',async()=>{
  const before=await read(order.id);
  await query("UPDATE requests SET status='PAYMENT_REQUIRED' WHERE id=$1",[order.id]);
  assert.equal((await read(order.id)).sla_deadline,null);
  await query("UPDATE requests SET status='REPAIR' WHERE id=$1",[order.id]);
  assert.equal(+new Date((await read(order.id)).sla_deadline),+new Date(before.sla_deadline));
 });
 await t.test('automatic controls are idempotent, skip pauses/finished orders and preserve manual decisions',async()=>{
  const overdue=await create('SLA-OVERDUE',"now()-interval '1 day'");
  const manual=await create('SLA-MANUAL',"now()-interval '1 day'");
  await query("INSERT INTO dispatch_controls(request_id,reason,status,resolution) VALUES($1,'Manual','RESOLVED','Acknowledged')",[manual.id]);
  assert.deepEqual((await syncSlaControls(pool)).rows.map(x=>x.request_id),[overdue.id]);
  assert.equal((await syncSlaControls(pool)).rows.length,0);
  const control=(await query('SELECT * FROM dispatch_controls WHERE request_id=$1',[overdue.id])).rows[0];
  assert.equal(control.reason,'Просрочена реакция SLA');assert.equal(control.owner_id,3);
  assert.equal((await query('SELECT reason FROM dispatch_controls WHERE request_id=$1',[manual.id])).rows[0].reason,'Manual');
  await query("UPDATE dispatch_controls SET status='RESOLVED' WHERE request_id=$1",[overdue.id]);
  assert.equal((await syncSlaControls(pool)).rows.length,0);
  const canceled=await create('SLA-CANCELED',"now()-interval '1 day'");
  await query('BEGIN');
  await cancelOrder(pool,{requestId:canceled.id,user:{id:1,role:'OWNER'},body:{category:'OTHER',reason:'Synthetic cancellation',document_reference:'SLA-TEST'},key:'sla-cancel-test'});
  await query('COMMIT');
  assert.equal((await syncSlaControls(pool)).rows.length,0);
 });
 await t.test('type and priority policies are independent; paused/execution deadlines enter the right queue',async()=>{
  const typed=(await query("INSERT INTO requests(number,customer_id,complaint,order_type,priority) VALUES('SLA-FIELD',1,'Synthetic','FIELD','CRITICAL') RETURNING *")).rows[0];
  assert.equal(typed.sla_reaction_minutes,15);assert.equal(typed.sla_execution_minutes,1440);
  const paused=await create('SLA-PAUSED',"now()-interval '1 day'");
  await query("INSERT INTO request_holds(request_id,hold_type,reason,previous_status,previous_sla_deadline,started_by) VALUES($1,'WAITING_CUSTOMER','Synthetic pause','NEW',$2,1)",[paused.id,paused.sla_deadline]);
  await query('UPDATE requests SET sla_deadline=NULL WHERE id=$1',[paused.id]);
  assert.equal((await syncSlaControls(pool)).rows.length,0);
  const execution=await create('SLA-EXECUTION');
  await query("UPDATE requests SET status='ACCEPTED' WHERE id=$1",[execution.id]);
  // Replay a past acceptance in this isolated fixture; no wall-clock sleeps.
  await query('ALTER TABLE requests DISABLE TRIGGER request_sla_clock');
  await query("UPDATE requests SET sla_reacted_at=now()-interval '1 day',sla_execution_deadline=now()-interval '2 hours',sla_deadline=now()-interval '2 hours' WHERE id=$1",[execution.id]);
  await query('ALTER TABLE requests ENABLE TRIGGER request_sla_clock');
  assert.deepEqual((await syncSlaControls(pool)).rows.map(x=>x.request_id),[execution.id]);
  assert.equal((await query('SELECT reason FROM dispatch_controls WHERE request_id=$1',[execution.id])).rows[0].reason,'Просрочено выполнение SLA');
 });
 await t.test('legacy deadlines survive migration and subsequent status changes',async()=>{
  await query('ALTER TABLE requests DISABLE TRIGGER request_sla_clock');
  const legacy=await create('SLA-LEGACY',"now()-interval '1 day'");
  await query('UPDATE requests SET sla_deadline=now()-interval \'2 hours\' WHERE id=$1',[legacy.id]);
  const before=await read(legacy.id);
  for(const statement of slaStatements)await query(statement);
  await query("UPDATE requests SET status='ACCEPTED' WHERE id=$1",[legacy.id]);
  const after=await read(legacy.id);
  assert.equal(after.sla_reaction_minutes,null);assert.equal(+new Date(after.sla_deadline),+new Date(before.sla_deadline));
  assert.equal((await syncSlaControls(pool)).rows.length,0);
  assert.equal((await query("SELECT reaction_minutes FROM sla_policies WHERE order_type='REPAIR' AND priority='NORMAL'")).rows[0].reaction_minutes,90);
 });
 }finally{await app.close();await db.close()}
});
