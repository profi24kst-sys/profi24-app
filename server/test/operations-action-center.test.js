import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {buildOperationsActions,resolveOperationsScope} from '../src/operations-action-center.js';
function harness(db){const query=(sql,p=[])=>p.length?db.query(sql,p):db.exec(sql).then(r=>r.at(-1));return{query,connect:async()=>({query,release(){}}),end:()=>db.close()}}

test('operations action center is branch-safe and ranks measurable service risks',async()=>{
 const db=await PGlite.create(),pool=harness(db);try{
  await pool.query(`
   CREATE TABLE branches(id SERIAL PRIMARY KEY,name TEXT,active BOOLEAN DEFAULT true);
   CREATE TABLE users(id SERIAL PRIMARY KEY,name TEXT,role TEXT,active BOOLEAN DEFAULT true);
   CREATE TABLE user_branches(user_id INT,branch_id INT,is_primary BOOLEAN DEFAULT false);
   CREATE TABLE customers(id SERIAL PRIMARY KEY,name TEXT,phone TEXT);
   CREATE TABLE requests(id SERIAL PRIMARY KEY,number TEXT,branch_id INT,status TEXT,priority TEXT,customer_id INT,engineer_id INT,manager_id INT,sla_deadline TIMESTAMPTZ,scheduled_at TIMESTAMPTZ,updated_at TIMESTAMPTZ,created_at TIMESTAMPTZ,total NUMERIC,paid NUMERIC,complaint TEXT,deleted_at TIMESTAMPTZ);
   CREATE TABLE request_stage_events(id SERIAL PRIMARY KEY,request_id INT,event TEXT,created_at TIMESTAMPTZ DEFAULT now());
   CREATE TABLE parts(id SERIAL PRIMARY KEY,request_id INT,eta DATE);
   CREATE TABLE tasks(id SERIAL PRIMARY KEY,title TEXT,request_id INT,status TEXT,due_at TIMESTAMPTZ,created_at TIMESTAMPTZ DEFAULT now());
   CREATE TABLE customer_visit_confirmations(id SERIAL PRIMARY KEY,request_id INT,status TEXT,is_current BOOLEAN,confirmation_task_id INT,response_comment TEXT);
   CREATE TABLE complaints(id SERIAL PRIMARY KEY,request_id INT,customer_id INT,status TEXT,text TEXT,severity TEXT,created_at TIMESTAMPTZ DEFAULT now());
  `);
  const kst=(await pool.query("INSERT INTO branches(name) VALUES('Костанай') RETURNING id")).rows[0].id;
  const tdk=(await pool.query("INSERT INTO branches(name) VALUES('Талдыкорган') RETURNING id")).rows[0].id;
  const manager=(await pool.query("INSERT INTO users(name,role) VALUES('Manager KST','MANAGER') RETURNING id")).rows[0].id;
  const supervisor=(await pool.query("INSERT INTO users(name,role) VALUES('Supervisor','SUPERVISOR') RETURNING id")).rows[0].id;
  const engineer=(await pool.query("INSERT INTO users(name,role) VALUES('Engineer','ENGINEER') RETURNING id")).rows[0].id;
  await pool.query('INSERT INTO user_branches(user_id,branch_id,is_primary) VALUES($1,$2,true),($3,$2,true)',[manager,kst,engineer]);
  const customer=(await pool.query("INSERT INTO customers(name,phone) VALUES('Client','77020000000') RETURNING id")).rows[0].id;
  const now=new Date('2026-09-10T07:00:00Z');
  const past=h=>new Date(now.getTime()-h*3600000);
  const sla=(await pool.query("INSERT INTO requests(number,branch_id,status,priority,customer_id,engineer_id,manager_id,sla_deadline,scheduled_at,updated_at,created_at,total,paid,complaint) VALUES('KST-SLA',$1,'REPAIR','CRITICAL',$2,$3,$4,$5,$6,$7,$7,100000,0,'SLA test') RETURNING id",[kst,customer,engineer,manager,past(2),past(3),past(4)])).rows[0].id;
  const foreign=(await pool.query("INSERT INTO requests(number,branch_id,status,priority,customer_id,sla_deadline,updated_at,created_at,total,paid,complaint) VALUES('TDK-SLA',$1,'REPAIR','CRITICAL',$2,$3,$4,$4,900000,0,'foreign') RETURNING id",[tdk,customer,past(5),past(6)])).rows[0].id;
  const pay=(await pool.query("INSERT INTO requests(number,branch_id,status,priority,customer_id,engineer_id,manager_id,updated_at,created_at,total,paid,complaint) VALUES('KST-PAY',$1,'PAYMENT_REQUIRED','NORMAL',$2,$3,$4,$5,$5,120000,20000,'payment') RETURNING id",[kst,customer,engineer,manager,past(30)])).rows[0].id;
  const task=(await pool.query("INSERT INTO tasks(title,request_id,status,due_at) VALUES('Просроченная задача',$1,'OPEN',$2) RETURNING id",[sla,past(6)])).rows[0].id;
  const move=(await pool.query("INSERT INTO requests(number,branch_id,status,priority,customer_id,engineer_id,manager_id,scheduled_at,updated_at,created_at,total,paid,complaint) VALUES('KST-MOVE',$1,'ASSIGNED','HIGH',$2,$3,$4,$5,$6,$6,0,0,'reschedule') RETURNING id",[kst,customer,engineer,manager,new Date(now.getTime()+2*3600000),past(1)])).rows[0].id;
  await pool.query("INSERT INTO customer_visit_confirmations(request_id,status,is_current,response_comment) VALUES($1,'RESCHEDULE_REQUESTED',true,'После 18:00')",[move]);
  await pool.query("INSERT INTO complaints(request_id,customer_id,status,text,severity,created_at) VALUES($1,$2,'OPEN','Клиент ждёт решение','NORMAL',$3)",[sla,customer,past(1)]);
  await pool.query("INSERT INTO complaints(request_id,customer_id,status,text,severity,created_at) VALUES($1,$2,'OPEN','Чужая претензия','CRITICAL',$3)",[foreign,customer,past(1)]);

  let scope=await resolveOperationsScope(pool,{id:manager,role:'MANAGER'});assert.deepEqual(scope.branchIds,[Number(kst)]);
  await assert.rejects(()=>resolveOperationsScope(pool,{id:manager,role:'MANAGER'},tdk),e=>e.code==='FORBIDDEN');
  scope=await resolveOperationsScope(pool,{id:supervisor,role:'SUPERVISOR'});assert.equal(scope.branchIds,null);

  const own=await buildOperationsActions(pool,{branchIds:[Number(kst)],now});
  assert.ok(own.actions.some(x=>x.type==='SLA_OVERDUE'&&x.number==='KST-SLA'));
  assert.ok(own.actions.some(x=>x.type==='TASK_OVERDUE'&&x.task_id===Number(task)));
  assert.ok(own.actions.some(x=>x.type==='PAYMENT_STUCK'&&x.request_id===Number(pay)&&x.outstanding_amount===100000));
  assert.ok(own.actions.some(x=>x.type==='RESCHEDULE_REQUIRED'&&x.request_id===Number(move)));
  assert.ok(own.actions.some(x=>x.type==='COMPLAINT_OPEN'&&x.number==='KST-SLA'));
  assert.ok(!own.actions.some(x=>x.number==='TDK-SLA'));
  assert.equal(own.summary.payment_at_risk,100000);
  assert.equal(own.actions[0].severity,'CRITICAL');

  const all=await buildOperationsActions(pool,{branchIds:null,now});
  assert.ok(all.actions.some(x=>x.number==='TDK-SLA'));
  assert.ok(all.summary.total>own.summary.total);
 }finally{await pool.end()}
});
