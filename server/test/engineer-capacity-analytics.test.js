import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {buildEngineerCapacityAnalytics,resolveEngineerCapacityBranchIds} from '../src/engineer-capacity-analytics.js';

const q=(db,sql,p=[])=>p.length?db.query(sql,p):db.exec(sql).then(r=>r.at(-1));

test('capacity respects branch scope and recommends less loaded engineer',async()=>{
 const db=await PGlite.create();
 try{
  await q(db,`CREATE TABLE branches(id SERIAL PRIMARY KEY,code TEXT,name TEXT);
CREATE TABLE users(id SERIAL PRIMARY KEY,name TEXT,role TEXT,active BOOLEAN DEFAULT true,primary_branch_id INT);
CREATE TABLE user_branches(user_id INT,branch_id INT);
CREATE TABLE customers(id SERIAL PRIMARY KEY,name TEXT);
CREATE TABLE equipment(id SERIAL PRIMARY KEY,customer_id INT,category TEXT,brand TEXT,model TEXT);
CREATE TABLE requests(id SERIAL PRIMARY KEY,number TEXT,customer_id INT,equipment_id INT,branch_id INT,status TEXT,priority TEXT,engineer_id INT,sla_deadline TIMESTAMPTZ,scheduled_at TIMESTAMPTZ,created_at TIMESTAMPTZ DEFAULT now(),closed_at TIMESTAMPTZ,deleted_at TIMESTAMPTZ);`);
  const kst=(await q(db,"INSERT INTO branches(code,name) VALUES('KST','Kostanay') RETURNING id")).rows[0].id;
  const tld=(await q(db,"INSERT INTO branches(code,name) VALUES('TLD','Taldykorgan') RETURNING id")).rows[0].id;
  const manager=(await q(db,"INSERT INTO users(name,role,primary_branch_id) VALUES('Manager','MANAGER',$1) RETURNING id",[kst])).rows[0].id;
  const busy=(await q(db,"INSERT INTO users(name,role,primary_branch_id) VALUES('Busy','ENGINEER',$1) RETURNING id",[kst])).rows[0].id;
  const free=(await q(db,"INSERT INTO users(name,role,primary_branch_id) VALUES('Free','ENGINEER',$1) RETURNING id",[kst])).rows[0].id;
  const foreign=(await q(db,"INSERT INTO users(name,role,primary_branch_id) VALUES('Foreign','ENGINEER',$1) RETURNING id",[tld])).rows[0].id;
  await q(db,'INSERT INTO user_branches(user_id,branch_id) VALUES($1,$2),($3,$2),($4,$2),($5,$6)',[manager,kst,busy,free,foreign,tld]);
  const customer=(await q(db,"INSERT INTO customers(name) VALUES('Client') RETURNING id")).rows[0].id;
  const fridge=(await q(db,"INSERT INTO equipment(customer_id,category,brand,model) VALUES($1,'Fridge','LG','X') RETURNING id",[customer])).rows[0].id;
  for(let i=0;i<5;i++)await q(db,"INSERT INTO requests(number,customer_id,equipment_id,branch_id,status,priority,engineer_id,created_at,closed_at) VALUES($1,$2,$3,$4,'CLOSED','NORMAL',$5,'2026-08-01T04:00:00Z','2026-08-01T08:00:00Z')",[`H${i}`,customer,fridge,kst,busy]);
  for(const [i,time] of ['09:00','10:30','12:00','13:30','15:00'].entries())await q(db,"INSERT INTO requests(number,customer_id,equipment_id,branch_id,status,priority,engineer_id,scheduled_at,created_at) VALUES($1,$2,$3,$4,'ASSIGNED','NORMAL',$5,$6,'2026-09-08T04:00:00Z')",[`B${i}`,customer,fridge,kst,busy,`2026-09-09T${time}:00+05:00`]);
  await q(db,"INSERT INTO requests(number,customer_id,equipment_id,branch_id,status,priority,engineer_id,scheduled_at,created_at) VALUES('F1',$1,$2,$3,'ASSIGNED','NORMAL',$4,'2026-09-09T09:00:00+05:00','2026-09-08T04:00:00Z')",[customer,fridge,kst,free]);
  const request=(await q(db,"INSERT INTO requests(number,customer_id,equipment_id,branch_id,status,priority,created_at,sla_deadline) VALUES('NEW',$1,$2,$3,'NEW','CRITICAL','2026-09-09T03:50:00Z','2026-09-09T04:15:00Z') RETURNING id",[customer,fridge,kst])).rows[0].id;
  await q(db,"INSERT INTO requests(number,customer_id,equipment_id,branch_id,status,priority,created_at) VALUES('OTHER',$1,$2,$3,'NEW','NORMAL','2026-09-09T03:30:00Z')",[customer,fridge,tld]);

  const branches=await resolveEngineerCapacityBranchIds(db,{id:manager,role:'MANAGER'});assert.deepEqual(branches,[Number(kst)]);
  const result=await buildEngineerCapacityAnalytics(db,{branchIds:branches,date:'2026-09-09',now:new Date('2026-09-09T04:00:00Z')});
  assert.equal(result.engineers.length,2);assert.equal(result.unassigned.length,1);assert.equal(Number(result.unassigned[0].id),Number(request));
  assert.equal(result.unassigned[0].recommended_engineer.engineer_id,Number(free));assert.equal(result.unassigned[0].recommended_engineer.next_free_time,'10:30');
  assert.ok(result.unassigned[0].candidates.every(x=>x.engineer_id!==Number(foreign)));
  assert.ok(result.engineers.find(x=>x.id===Number(busy)).utilization_pct>result.engineers.find(x=>x.id===Number(free)).utilization_pct);
  await assert.rejects(buildEngineerCapacityAnalytics(db,{branchIds:[Number(kst)],branchId:Number(tld),date:'2026-09-09'}),e=>e.code==='FORBIDDEN');
 }finally{await db.close()}
});
