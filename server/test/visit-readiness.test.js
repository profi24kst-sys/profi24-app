import {test} from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import {PGlite} from '@electric-sql/pglite';
import {customerVisitConfirmationStatements} from '../src/customer-visit-confirmation-schema.js';
import {visitReadinessStatements} from '../src/visit-readiness-schema.js';
import {installVisitReadiness} from '../src/visit-readiness.js';

function harness(db){const query=(sql,p=[])=>p.length?db.query(sql,p):db.exec(sql).then(r=>r.at(-1));return{query,connect:async()=>({query,release(){}}),end:()=>db.close()}}

test('visit readiness reminds once, escalates once, scopes managers and blocks reschedule route publication',async()=>{
 const db=await PGlite.create(),pool=harness(db),app=Fastify();
 try{
  await pool.query(`
    CREATE TABLE branches(id SERIAL PRIMARY KEY,code TEXT,name TEXT);
    CREATE TABLE users(id SERIAL PRIMARY KEY,name TEXT,role TEXT,active BOOLEAN DEFAULT true);
    CREATE TABLE user_branches(user_id INT,branch_id INT,is_primary BOOLEAN DEFAULT false);
    CREATE TABLE customers(id SERIAL PRIMARY KEY,name TEXT,phone TEXT);
    CREATE TABLE equipment(id SERIAL PRIMARY KEY,customer_id INT,category TEXT,brand TEXT,model TEXT);
    CREATE TABLE requests(id SERIAL PRIMARY KEY,number TEXT,customer_id INT,equipment_id INT,engineer_id INT,branch_id INT,status TEXT,scheduled_at TIMESTAMPTZ,deleted_at TIMESTAMPTZ);
    CREATE TABLE tasks(id SERIAL PRIMARY KEY,title TEXT,request_id INT,assigned_to INT,priority TEXT,status TEXT DEFAULT 'OPEN',due_at TIMESTAMPTZ,created_by INT,created_at TIMESTAMPTZ DEFAULT now(),completed_at TIMESTAMPTZ);
    CREATE TABLE request_history(id SERIAL PRIMARY KEY,request_id INT,user_id INT,action TEXT,details JSONB,created_at TIMESTAMPTZ DEFAULT now());
    CREATE TABLE message_queue(id BIGSERIAL PRIMARY KEY,request_id INT,template_code TEXT,body TEXT,dedupe_key TEXT UNIQUE,created_at TIMESTAMPTZ DEFAULT now());
    CREATE TABLE engineer_route_plan_stops(id BIGSERIAL PRIMARY KEY,request_id INT NOT NULL);
  `);
  for(const s of customerVisitConfirmationStatements)await pool.query(s);
  for(const s of visitReadinessStatements)await pool.query(s);
  const branch=(await pool.query("INSERT INTO branches(code,name) VALUES('KST','Костанай') RETURNING id")).rows[0].id;
  const foreignBranch=(await pool.query("INSERT INTO branches(code,name) VALUES('TDK','Талдыкорган') RETURNING id")).rows[0].id;
  const manager=(await pool.query("INSERT INTO users(name,role) VALUES('Manager','MANAGER') RETURNING id")).rows[0].id;
  const engineer=(await pool.query("INSERT INTO users(name,role) VALUES('Engineer','ENGINEER') RETURNING id")).rows[0].id;
  await pool.query('INSERT INTO user_branches(user_id,branch_id,is_primary) VALUES($1,$2,true),($3,$2,true)',[manager,branch,engineer]);
  const customer=(await pool.query("INSERT INTO customers(name,phone) VALUES('Client','77020000000') RETURNING id")).rows[0].id;
  const equipment=(await pool.query("INSERT INTO equipment(customer_id,category,brand,model) VALUES($1,'Холодильник','LG','GC') RETURNING id",[customer])).rows[0].id;
  const now=new Date('2026-09-10T06:00:00.000Z'),scheduled=new Date(now.getTime()+120*60000),invited=new Date(now.getTime()-40*60000);
  const request=(await pool.query("INSERT INTO requests(number,customer_id,equipment_id,engineer_id,branch_id,status,scheduled_at) VALUES('KST-READY',$1,$2,$3,$4,'ASSIGNED',$5::timestamptz) RETURNING id",[customer,equipment,engineer,branch,scheduled])).rows[0].id;
  const confirmation=(await pool.query(`INSERT INTO customer_visit_confirmations(request_id,customer_id,engineer_id,branch_id,version,token_nonce,token_hash,scheduled_at_snapshot,expires_at,last_invited_at,invite_count)
    VALUES($1,$2,$3,$4,1,'n','h',$5::timestamptz,$5::timestamptz+interval '12 hours',$6::timestamptz,1) RETURNING id`,[request,customer,engineer,branch,scheduled,invited])).rows[0].id;
  const visitWorkflow={enqueueInvite:async({request_id,dedupe_key})=>{const queued=(await pool.query('INSERT INTO message_queue(request_id,template_code,body,dedupe_key) VALUES($1,$2,$3,$4) ON CONFLICT(dedupe_key) DO NOTHING RETURNING id',[request_id,'CUSTOMER_VISIT_CONFIRMATION','Повторное подтверждение',dedupe_key])).rows[0]||null;return{handled:true,confirmation:{id:confirmation},queued}}};
  const roles=()=>async req=>{req.user={id:Number(manager),role:'MANAGER'}};
  const service=await installVisitReadiness(app,pool,{visitWorkflow,roles});

  let out=await service.sync(now);assert.equal(out.reminders,1);assert.equal(out.tasks,0);
  assert.equal((await pool.query('SELECT count(*)::int c FROM message_queue')).rows[0].c,1);
  assert.ok((await pool.query('SELECT reminder_sent_at FROM customer_visit_confirmations WHERE id=$1',[confirmation])).rows[0].reminder_sent_at);
  out=await service.sync(now);assert.equal(out.reminders,0);assert.equal((await pool.query('SELECT count(*)::int c FROM message_queue')).rows[0].c,1);

  let http=await app.inject({method:'GET',url:`/api/v1/visit-readiness?branch_id=${branch}`});assert.equal(http.statusCode,200,http.body);assert.equal(http.json().data.visits.length,1);assert.equal(http.json().data.visits[0].request_number,'KST-READY');
  http=await app.inject({method:'GET',url:`/api/v1/visit-readiness?branch_id=${foreignBranch}`});assert.equal(http.statusCode,403,http.body);

  const soon=new Date(now.getTime()+60*60000);await pool.query('UPDATE requests SET scheduled_at=$1::timestamptz WHERE id=$2',[soon,request]);await pool.query('UPDATE customer_visit_confirmations SET scheduled_at_snapshot=$1::timestamptz WHERE id=$2',[soon,confirmation]);
  out=await service.sync(now);assert.equal(out.tasks,1);
  const task=(await pool.query('SELECT * FROM tasks WHERE request_id=$1',[request])).rows[0];assert.equal(task.priority,'HIGH');assert.equal(task.status,'OPEN');assert.equal(Number(task.assigned_to),Number(manager));
  out=await service.sync(now);assert.equal(out.tasks,0);assert.equal((await pool.query('SELECT count(*)::int c FROM tasks WHERE request_id=$1',[request])).rows[0].c,1);
  assert.equal((await pool.query("SELECT count(*)::int c FROM request_history WHERE request_id=$1 AND action='CUSTOMER_VISIT_CONFIRMATION_ESCALATED'",[request])).rows[0].c,1);

  await pool.query("UPDATE customer_visit_confirmations SET status='CONFIRMED' WHERE id=$1",[confirmation]);out=await service.sync(now);assert.equal(out.closed_tasks,1);assert.equal((await pool.query('SELECT status FROM tasks WHERE id=$1',[task.id])).rows[0].status,'DONE');

  const blocked=(await pool.query("INSERT INTO requests(number,customer_id,equipment_id,engineer_id,branch_id,status,scheduled_at) VALUES('KST-MOVE',$1,$2,$3,$4,'ASSIGNED',$5::timestamptz) RETURNING id",[customer,equipment,engineer,branch,scheduled])).rows[0].id;
  await pool.query(`INSERT INTO customer_visit_confirmations(request_id,customer_id,engineer_id,branch_id,version,token_nonce,token_hash,scheduled_at_snapshot,expires_at,status)
    VALUES($1,$2,$3,$4,1,'n2','h2',$5::timestamptz,$5::timestamptz+interval '12 hours','RESCHEDULE_REQUESTED')`,[blocked,customer,engineer,branch,scheduled]);
  await assert.rejects(()=>pool.query('INSERT INTO engineer_route_plan_stops(request_id) VALUES($1)',[blocked]),/Клиент запросил перенос визита/);
 }finally{await app.close();await pool.end()}
});