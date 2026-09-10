import {test} from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import {PGlite} from '@electric-sql/pglite';
import {customerVisitConfirmationStatements} from '../src/customer-visit-confirmation-schema.js';
import {installCustomerVisitConfirmation} from '../src/customer-visit-confirmation.js';

function harness(db){const query=(sql,p=[])=>p.length?db.query(sql,p):db.exec(sql).then(r=>r.at(-1));return{query,connect:async()=>({query,release(){}}),end:()=>db.close()}}
const render=(text,data)=>String(text||'').replace(/{{\s*([a-z_]+)\s*}}/g,(_,k)=>data[k]??'');

test('visit confirmation is versioned, scoped, deduplicated and creates reschedule task',async()=>{
 const db=await PGlite.create(),pool=harness(db),app=Fastify();
 try{
  await pool.query(`CREATE TABLE branches(id SERIAL PRIMARY KEY,code TEXT,name TEXT);CREATE TABLE users(id SERIAL PRIMARY KEY,name TEXT,role TEXT,active BOOLEAN DEFAULT true);CREATE TABLE user_branches(user_id INT,branch_id INT,is_primary BOOLEAN DEFAULT false);CREATE TABLE customers(id SERIAL PRIMARY KEY,name TEXT,phone TEXT);CREATE TABLE equipment(id SERIAL PRIMARY KEY,customer_id INT,category TEXT,brand TEXT,model TEXT);CREATE TABLE requests(id SERIAL PRIMARY KEY,number TEXT,customer_id INT,equipment_id INT,engineer_id INT,branch_id INT,status TEXT,scheduled_at TIMESTAMPTZ,deleted_at TIMESTAMPTZ);CREATE TABLE tasks(id SERIAL PRIMARY KEY,title TEXT,request_id INT,assigned_to INT,priority TEXT,status TEXT,due_at TIMESTAMPTZ,created_by INT);CREATE TABLE request_history(id SERIAL PRIMARY KEY,request_id INT,user_id INT,action TEXT,details JSONB,created_at TIMESTAMPTZ DEFAULT now());CREATE TABLE message_templates(id SERIAL PRIMARY KEY,code TEXT UNIQUE,name TEXT,audience TEXT,channel TEXT,body TEXT,active BOOLEAN DEFAULT true);CREATE TABLE message_queue(id BIGSERIAL PRIMARY KEY,request_id INT,history_id INT,template_code TEXT,channel TEXT,audience TEXT,recipient TEXT,body TEXT,status TEXT,dedupe_key TEXT UNIQUE,created_by INT,created_at TIMESTAMPTZ DEFAULT now())`);
  for(const s of customerVisitConfirmationStatements)await pool.query(s);
  const branch=(await pool.query("INSERT INTO branches(code,name) VALUES('KST','Костанай') RETURNING id")).rows[0].id;
  const other=(await pool.query("INSERT INTO branches(code,name) VALUES('TLD','Другой') RETURNING id")).rows[0].id;
  const manager=(await pool.query("INSERT INTO users(name,role) VALUES('Manager','MANAGER') RETURNING id")).rows[0].id;
  const engineer=(await pool.query("INSERT INTO users(name,role) VALUES('Engineer','ENGINEER') RETURNING id")).rows[0].id;
  await pool.query('INSERT INTO user_branches(user_id,branch_id,is_primary) VALUES($1,$2,true),($3,$2,true)',[manager,branch,engineer]);
  const customer=(await pool.query("INSERT INTO customers(name,phone) VALUES('Client','77020000000') RETURNING id")).rows[0].id;
  const equipment=(await pool.query("INSERT INTO equipment(customer_id,category,brand,model) VALUES($1,'Холодильник','LG','GC') RETURNING id",[customer])).rows[0].id;
  const request=(await pool.query("INSERT INTO requests(number,customer_id,equipment_id,engineer_id,branch_id,status,scheduled_at) VALUES('KST-TEST',$1,$2,$3,$4,'ASSIGNED',now()+interval '1 day') RETURNING id",[customer,equipment,engineer,branch])).rows[0].id;
  const requestData=async id=>(await pool.query(`SELECT r.*,c.name customer_name,c.phone,e.category,e.brand,e.model,u.name engineer_name FROM requests r JOIN customers c ON c.id=r.customer_id LEFT JOIN equipment e ON e.id=r.equipment_id LEFT JOIN users u ON u.id=r.engineer_id WHERE r.id=$1`,[id])).rows[0];
  const vars=x=>({request_number:x.number,customer_name:x.customer_name,engineer_name:x.engineer_name,scheduled_at:String(x.scheduled_at||'')});
  const enqueue=async x=>{const d=await requestData(x.request_id);const recipient=d.phone||null;return (await pool.query(`INSERT INTO message_queue(request_id,history_id,template_code,channel,audience,recipient,body,status,dedupe_key,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(dedupe_key) DO NOTHING RETURNING *`,[x.request_id,x.history_id,x.template_code,x.channel,x.audience,recipient,x.body,recipient?'QUEUED':'WAITING_RECIPIENT',x.dedupe_key,x.created_by])).rows[0]||null};
  const roles=()=>async req=>{req.user={id:manager,role:'MANAGER'}};
  const service=await installCustomerVisitConfirmation(app,pool,{enqueue,requestData,vars,render,roles});

  const first=await service.enqueueInvite({request_id:request,dedupe_key:'visit:first'});assert.equal(first.handled,true);assert.match(first.visit_url,/\/visit\//);assert.equal(Number(first.confirmation.version),1);
  const same=await service.enqueueInvite({request_id:request,dedupe_key:'visit:first'});assert.equal(Number(same.confirmation.id),Number(first.confirmation.id));assert.equal((await pool.query('SELECT count(*)::int c FROM customer_visit_confirmations')).rows[0].c,1);assert.equal((await pool.query("SELECT count(*)::int c FROM message_queue WHERE template_code='CUSTOMER_VISIT_CONFIRMATION'")).rows[0].c,1);
  const token1=first.visit_url.split('/').at(-1),public1=await app.inject({method:'GET',url:`/public/v1/visit/${token1}`});assert.equal(public1.statusCode,200);assert.equal(public1.json().data.request_number,'KST-TEST');
  const confirmed=await app.inject({method:'POST',url:`/public/v1/visit/${token1}`,payload:{decision:'CONFIRM'}});assert.equal(confirmed.statusCode,200);assert.equal(confirmed.json().data.status,'CONFIRMED');assert.equal((await pool.query("SELECT count(*)::int c FROM tasks WHERE request_id=$1",[request])).rows[0].c,0);assert.equal((await pool.query("SELECT count(*)::int c FROM request_history WHERE request_id=$1 AND action='CUSTOMER_VISIT_CONFIRMED'",[request])).rows[0].c,1);

  await pool.query("UPDATE requests SET scheduled_at=scheduled_at+interval '2 hours' WHERE id=$1",[request]);
  const second=await service.enqueueInvite({request_id:request,dedupe_key:'visit:second'});assert.equal(Number(second.confirmation.version),2);assert.notEqual(Number(second.confirmation.id),Number(first.confirmation.id));
  const old=await app.inject({method:'GET',url:`/public/v1/visit/${token1}`});assert.equal(old.statusCode,410);assert.equal(old.json().error.code,'SUPERSEDED');
  const token2=second.visit_url.split('/').at(-1),reschedule=await app.inject({method:'POST',url:`/public/v1/visit/${token2}`,payload:{decision:'RESCHEDULE',comment:'После 16:00'}});assert.equal(reschedule.statusCode,200);assert.equal(reschedule.json().data.status,'RESCHEDULE_REQUESTED');assert.equal(reschedule.json().data.followup_created,true);
  const task=(await pool.query("SELECT * FROM tasks WHERE request_id=$1 ORDER BY id DESC LIMIT 1",[request])).rows[0];assert.equal(task.priority,'HIGH');assert.equal(task.status,'OPEN');assert.equal(Number(task.assigned_to),Number(manager));assert.match((await pool.query("SELECT details FROM request_history WHERE request_id=$1 AND action='CUSTOMER_VISIT_RESCHEDULE_REQUESTED' ORDER BY id DESC LIMIT 1",[request])).rows[0].details.comment,/16:00/);

  await pool.query('UPDATE requests SET scheduled_at=NULL WHERE id=$1',[request]);const noSchedule=await service.ensureConfirmation(request);assert.equal(noSchedule.skipped,'no_schedule');assert.equal((await pool.query('SELECT count(*)::int c FROM customer_visit_confirmations WHERE request_id=$1 AND is_current=true',[request])).rows[0].c,0);assert.equal((await app.inject({method:'GET',url:`/public/v1/visit/${token2}`})).statusCode,410);
  await pool.query("UPDATE requests SET status='ASSIGNED',scheduled_at=now()+interval '2 days',engineer_id=$2 WHERE id=$1",[request,engineer]);const third=await service.enqueueInvite({request_id:request,dedupe_key:'visit:third'});assert.equal(Number(third.confirmation.version),3);const token3=third.visit_url.split('/').at(-1);assert.equal((await app.inject({method:'GET',url:`/public/v1/visit/${token3}`})).statusCode,200);await pool.query("UPDATE requests SET status='CANCELLED' WHERE id=$1",[request]);const cancelled=await app.inject({method:'GET',url:`/public/v1/visit/${token3}`});assert.equal(cancelled.statusCode,410);assert.equal(cancelled.json().error.code,'SUPERSEDED');
  await pool.query("UPDATE requests SET status='ASSIGNED',scheduled_at=now()+interval '3 days',engineer_id=NULL WHERE id=$1",[request]);const noEngineer=await service.ensureConfirmation(request);assert.equal(noEngineer.skipped,'no_engineer');assert.equal((await pool.query('SELECT count(*)::int c FROM customer_visit_confirmations WHERE request_id=$1 AND is_current=true',[request])).rows[0].c,0);

  const foreign=(await pool.query("INSERT INTO requests(number,customer_id,equipment_id,engineer_id,branch_id,status,scheduled_at) VALUES('TLD-TEST',$1,$2,$3,$4,'ASSIGNED',now()+interval '1 day') RETURNING id",[customer,equipment,engineer,other])).rows[0].id;
  const forbidden=await app.inject({method:'POST',url:`/api/v1/visit-confirmations/${foreign}/resend`});assert.equal(forbidden.statusCode,403);assert.equal(forbidden.json().error.code,'FORBIDDEN');assert.equal((await pool.query('SELECT count(*)::int c FROM customer_visit_confirmations WHERE request_id=$1',[foreign])).rows[0].c,0);
  const stale=await service.onHistory({id:999,request_id:request,action:'SCHEDULE_CHANGED',created_at:new Date(Date.now()-2*60*60*1000).toISOString()});assert.equal(stale.handled,false);assert.equal(stale.skipped,'stale_history');
 }finally{await app.close();await pool.end()}
});
