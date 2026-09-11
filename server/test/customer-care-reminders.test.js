import {test} from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import jwt from '@fastify/jwt';
import {PGlite} from '@electric-sql/pglite';
import {migrateCore} from '../src/migrate.js';
import {authenticate,installOrderAccess} from '../src/access.js';
import {roleAllowed} from '../src/rbac.js';
import {installCustomerFeedback} from '../src/customer-feedback.js';

async function harness(){
  const db=await PGlite.create();
  const query=(sql,p=[])=>p.length?db.query(sql,p):db.exec(sql).then(r=>r.at(-1));
  let chain=Promise.resolve();
  const pool={query,connect:async()=>{const before=chain;let release;chain=new Promise(r=>release=r);await before;return{query,release}},end:async()=>{}};
  await migrateCore(pool);
  await query(`CREATE TABLE message_templates(
    id SERIAL PRIMARY KEY,code TEXT UNIQUE NOT NULL,name TEXT NOT NULL,audience TEXT NOT NULL,
    channel TEXT NOT NULL,body TEXT NOT NULL,active BOOLEAN DEFAULT TRUE)`);
  await query(`CREATE TABLE message_queue(
    id BIGSERIAL PRIMARY KEY,request_id INT REFERENCES requests(id) ON DELETE SET NULL,history_id INT REFERENCES request_history(id) ON DELETE SET NULL,
    template_code TEXT,channel TEXT NOT NULL,audience TEXT NOT NULL,recipient TEXT,body TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'QUEUED',
    attempts INT NOT NULL DEFAULT 0,provider_message_id TEXT,error_text TEXT,dedupe_key TEXT UNIQUE,created_by INT REFERENCES users(id),
    processing_started_at TIMESTAMPTZ,processing_token TEXT,created_at TIMESTAMPTZ DEFAULT now(),sent_at TIMESTAMPTZ,updated_at TIMESTAMPTZ DEFAULT now())`);
  await query("INSERT INTO users(name,email,password_hash,role) VALUES('Owner','owner@a30.test','x','OWNER'),('Supervisor','supervisor@a30.test','x','SUPERVISOR'),('Manager','manager@a30.test','x','MANAGER'),('Engineer','engineer@a30.test','x','ENGINEER')");
  const branch=Number((await query("SELECT id FROM branches WHERE code='KST'")).rows[0].id);
  await query('INSERT INTO user_branches(user_id,branch_id,is_primary) VALUES(2,$1,true),(3,$1,true),(4,$1,true) ON CONFLICT DO NOTHING',[branch]);
  await query("INSERT INTO customers(name,phone) VALUES('A30 Client','77000000999')");
  await query("INSERT INTO equipment(customer_id,category,brand,model) VALUES(1,'Стиральная машина','LG','F2J3')");
  const app=Fastify({logger:false});
  await app.register(jwt,{secret:'x'.repeat(64)});
  const auth=async(req,reply)=>{if(!await authenticate(req,reply,pool))return};
  const roles=(...allowed)=>async(req,reply)=>{await auth(req,reply);if(reply.sent)return;if(!roleAllowed(req.user.role,allowed))return reply.code(403).send({data:null,error:{code:'FORBIDDEN',message:'Недостаточно прав'}})};
  const requestData=async id=>(await query(`SELECT r.*,c.name customer_name,c.phone,e.category,e.brand,e.model
    FROM requests r JOIN customers c ON c.id=r.customer_id LEFT JOIN equipment e ON e.id=r.equipment_id WHERE r.id=$1`,[id])).rows[0];
  const vars=x=>({request_number:x.number,customer_name:x.customer_name||'',equipment:[x.category,x.brand,x.model].filter(Boolean).join(' ')||'Техника'});
  const render=(t,d)=>String(t).replace(/{{\s*([a-z_]+)\s*}}/g,(_,k)=>d[k]??'');
  const enqueue=async x=>{
    const data=x.request_id?await requestData(x.request_id):null,recipient=x.recipient||(x.audience==='CUSTOMER'?data?.phone:null)||null,status=recipient?'QUEUED':'WAITING_RECIPIENT';
    return (await query(`INSERT INTO message_queue(request_id,history_id,template_code,channel,audience,recipient,body,status,dedupe_key,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(dedupe_key) DO NOTHING RETURNING *`,[
      x.request_id||null,x.history_id||null,x.template_code||null,x.channel||'WHATSAPP',x.audience||'CUSTOMER',recipient,x.body||'',status,x.dedupe_key,x.created_by||null
    ])).rows[0]||null;
  };
  installOrderAccess(app,pool,'communications');
  const flow=await installCustomerFeedback(app,pool,{enqueue,requestData,vars,render,roles});
  await app.ready();
  return{db,pool,query,branch,app,flow};
}

async function createClosedRequest(s,number){
  return Number((await s.query(`INSERT INTO requests(number,customer_id,equipment_id,manager_id,engineer_id,branch_id,status,complaint,closed_at)
    VALUES($1,1,1,3,4,$2,'CLOSED','A30 acceptance',now()) RETURNING id`,[number,s.branch])).rows[0].id);
}

async function queuedCount(s,prefix){
  return Number((await s.query("SELECT count(*) c FROM message_queue WHERE dedupe_key LIKE $1",[prefix+'%'])).rows[0].c);
}

test('A30 reminders stop after pickup, feedback response and maintenance planning',async()=>{
  const s=await harness();
  try{
    const notReady=await createClosedRequest(s,'A30-ENGINEER');
    await s.query(`INSERT INTO equipment_custody_events(request_id,event_type,from_holder,to_holder,location_text,created_by)
      VALUES($1,'CUSTOMER_TO_OFFICE','CUSTOMER','OFFICE','Приёмка',3),
            ($1,'OFFICE_TO_STORAGE','OFFICE','STORAGE','Склад',3),
            ($1,'STORAGE_TO_ENGINEER','STORAGE','ENGINEER','У инженера',3)`,[notReady]);
    const notReadySync=await s.flow.pickup.syncReminders(new Date());
    assert.equal(notReadySync.reconciled.discovered,0);
    assert.equal(Number((await s.query('SELECT count(*) c FROM equipment_pickup_states WHERE request_id=$1',[notReady])).rows[0].c),0);

    const pickupRequest=await createClosedRequest(s,'A30-PICKUP');
    await s.query(`INSERT INTO equipment_custody_events(request_id,event_type,from_holder,to_holder,location_text,created_by)
      VALUES($1,'CUSTOMER_TO_OFFICE','CUSTOMER','OFFICE','Приёмка',3)`,[pickupRequest]);
    let pickup=await s.flow.pickup.syncReminders(new Date());
    assert.equal(pickup.reconciled.discovered,1);
    assert.equal(pickup.reminders,1);
    let state=(await s.query('SELECT * FROM equipment_pickup_states WHERE request_id=$1',[pickupRequest])).rows[0];
    assert.equal(state.status,'WAITING');
    assert.equal(Number(state.reminder_count),1);
    await s.query("UPDATE equipment_pickup_states SET storage_due_at=now()-interval '1 day',last_reminder_at=now()-interval '4 days' WHERE request_id=$1",[pickupRequest]);
    pickup=await s.flow.pickup.syncReminders(new Date());
    assert.equal(pickup.reminders,1);
    assert.equal(pickup.escalations,1);
    state=(await s.query('SELECT * FROM equipment_pickup_states WHERE request_id=$1',[pickupRequest])).rows[0];
    const escalation=(await s.query('SELECT * FROM tasks WHERE id=$1',[state.escalation_task_id])).rows[0];
    assert.equal(escalation.status,'OPEN');
    assert.equal(escalation.priority,'HIGH');
    const pickupMessagesBefore=await queuedCount(s,'pickup:');
    await s.query(`INSERT INTO equipment_custody_events(request_id,event_type,from_holder,to_holder,location_text,created_by)
      VALUES($1,'OFFICE_TO_CUSTOMER','OFFICE','CUSTOMER','Выдача клиенту',3)`,[pickupRequest]);
    await s.flow.pickup.syncReminders(new Date(Date.now()+8*86400000));
    state=(await s.query('SELECT * FROM equipment_pickup_states WHERE request_id=$1',[pickupRequest])).rows[0];
    assert.equal(state.status,'PICKED_UP');
    assert.ok(state.picked_up_at);
    assert.equal((await s.query('SELECT status FROM tasks WHERE id=$1',[state.escalation_task_id])).rows[0].status,'DONE');
    assert.equal(await queuedCount(s,'pickup:'),pickupMessagesBefore);
    assert.equal(Number((await s.query("SELECT count(*) c FROM message_queue WHERE dedupe_key LIKE 'pickup:%' AND status='CANCELLED'")).rows[0].c),pickupMessagesBefore);

    const feedbackRequest=await createClosedRequest(s,'A30-NPS');
    const initial=await s.flow.enqueueInvite({request_id:feedbackRequest,dedupe_key:`feedback:${feedbackRequest}:initial`});
    const token=initial.feedback_url.split('/feedback/')[1];
    await s.query("UPDATE customer_feedback SET last_invited_at=now()-interval '4 days' WHERE request_id=$1",[feedbackRequest]);
    let nps=await s.flow.syncFeedbackReminders(new Date());
    assert.equal(nps.queued,1);
    assert.equal(Number((await s.query('SELECT invite_count FROM customer_feedback WHERE request_id=$1',[feedbackRequest])).rows[0].invite_count),2);
    const feedbackMessagesBefore=await queuedCount(s,`feedback:${feedbackRequest}:`);
    const response=await s.app.inject({method:'POST',url:'/public/v1/feedback/'+token,payload:{score:9,comment:'Хорошо'}});
    assert.equal(response.statusCode,200);
    await s.query("UPDATE customer_feedback SET last_invited_at=now()-interval '10 days' WHERE request_id=$1",[feedbackRequest]);
    nps=await s.flow.syncFeedbackReminders(new Date(Date.now()+10*86400000));
    assert.equal(nps.queued,0);
    assert.equal(await queuedCount(s,`feedback:${feedbackRequest}:`),feedbackMessagesBefore);
    assert.equal(Number((await s.query("SELECT count(*) c FROM message_queue WHERE request_id=$1 AND template_code='CUSTOMER_FEEDBACK_REQUEST' AND status='CANCELLED'",[feedbackRequest])).rows[0].c),feedbackMessagesBefore);

    const maintenanceRequest=await createClosedRequest(s,'A30-MAINT');
    const contract=Number((await s.query(`INSERT INTO service_contracts(number,customer_id,branch_id,responsible_id,status,start_date,reminder_days_before,created_by)
      VALUES('SC-A30',1,$1,2,'ACTIVE',CURRENT_DATE,7,1) RETURNING id`,[s.branch])).rows[0].id);
    const asset=Number((await s.query(`INSERT INTO service_contract_assets(contract_id,equipment_id,interval_months,next_service_date)
      VALUES($1,1,6,CURRENT_DATE) RETURNING id`,[contract])).rows[0].id);
    const cycle=Number((await s.query(`INSERT INTO service_maintenance_cycles(contract_asset_id,due_date,status)
      VALUES($1,CURRENT_DATE,'DUE') RETURNING id`,[asset])).rows[0].id);
    let maintenance=await s.flow.maintenance.syncMaintenance();
    assert.equal(maintenance.messages,1);
    const maintenanceMessagesBefore=await queuedCount(s,`service-cycle:${cycle}:`);
    assert.equal(maintenanceMessagesBefore,1);
    await s.query("UPDATE service_maintenance_cycles SET status='PLANNED',request_id=$1,planned_at=now(),reminder_sent_at=NULL WHERE id=$2",[maintenanceRequest,cycle]);
    maintenance=await s.flow.maintenance.syncMaintenance();
    assert.equal(maintenance.messages,0);
    assert.equal(await queuedCount(s,`service-cycle:${cycle}:`),maintenanceMessagesBefore);
  }finally{
    await s.app.close();
    await s.db.close();
  }
});
