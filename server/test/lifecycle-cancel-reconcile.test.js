import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {migrateCore} from '../src/migrate.js';
import {cancelOrder} from '../src/order-financial-actions.js';
import {fingerprint} from '../src/finance/service.js';

test('documented cancellation closes active hold and scheduled visit history',async()=>{
  const db=await PGlite.create();const query=(sql,p=[])=>p.length?db.query(sql,p):db.exec(sql).then(r=>r.at(-1));let queue=Promise.resolve();
  const pool={query,connect:async()=>{const prior=queue;let release;queue=new Promise(r=>{release=r});await prior;return{query,release}},end:async()=>{}};
  try{
    await migrateCore(pool);const branch=(await query("SELECT id FROM branches WHERE code='KST'")).rows[0].id;
    await query(`INSERT INTO users(name,email,password_hash,role) VALUES ('Owner CR','cr-owner@test.invalid','x','OWNER'),('Manager CR','cr-manager@test.invalid','x','MANAGER'),('Engineer CR','cr-engineer@test.invalid','x','ENGINEER')`);
    await query("INSERT INTO customers(name,phone) VALUES('Cancel lifecycle client','700')");
    const order=(await query("INSERT INTO requests(number,customer_id,manager_id,engineer_id,branch_id,status,complaint,total,sla_deadline) VALUES('CR-1',1,2,3,$1,'REPAIR','cancel lifecycle',1000,now()+interval '1 hour') RETURNING *",[branch])).rows[0];
    const hold=(await query("INSERT INTO request_holds(request_id,hold_type,reason,responsible_id,pause_sla,previous_status,previous_sla_deadline,started_by) VALUES($1,'WAITING_CUSTOMER','Клиент отказался от продолжения',2,true,$2,$3,2) RETURNING *",[order.id,order.status,order.sla_deadline])).rows[0];
    const visit=(await query("INSERT INTO request_visit_attempts(request_id,attempt_no,visit_type,scheduled_at,engineer_id,created_by) VALUES($1,1,'FIELD',now()+interval '1 day',3,2) RETURNING *",[order.id])).rows[0];
    const body={category:'CUSTOMER_REFUSAL',reason:'Клиент отказался от ремонта',document_reference:'Акт отказа CR-1',acknowledge_expenses:false};const key='1:lifecycle-cancel-reconcile-0001',digest=fingerprint({request:order.id,...body});
    const c=await pool.connect();try{await c.query('BEGIN');await cancelOrder(c,{requestId:order.id,user:{id:1,role:'OWNER'},body,key,digest});await c.query('COMMIT')}catch(e){await c.query('ROLLBACK');throw e}finally{c.release()}
    const afterHold=(await query('SELECT * FROM request_holds WHERE id=$1',[hold.id])).rows[0];assert.ok(afterHold.resumed_at);assert.equal(Number(afterHold.resumed_by),1);assert.match(afterHold.resolution,/Заказ отменён/);
    const afterVisit=(await query('SELECT * FROM request_visit_attempts WHERE id=$1',[visit.id])).rows[0];assert.equal(afterVisit.outcome,'CANCELLED');assert.equal(Number(afterVisit.completed_by),1);assert.ok(afterVisit.completed_at);assert.match(afterVisit.reason,/Заказ отменён/);
    const history=(await query("SELECT action,details FROM request_history WHERE request_id=$1 ORDER BY id",[order.id])).rows;assert.ok(history.some(x=>x.action==='ORDER_HOLD_RESUMED'&&x.details?.automatic_cancellation===true));assert.ok(history.some(x=>x.action==='VISIT_OUTCOME_RECORDED'&&x.details?.automatic_cancellation===true));assert.ok(history.some(x=>x.action==='REQUEST_CANCELLED'));
  }finally{await db.close();}
});
