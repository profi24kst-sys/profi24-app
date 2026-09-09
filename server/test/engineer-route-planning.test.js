import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {engineerRouteStatements} from '../src/engineer-route-schema.js';
import {buildEngineerRouteSuggestion,publishEngineerRoutePlan,resolveEngineerRouteBranchIds,updateRouteCustomerLocation} from '../src/engineer-route-planning.js';

function harness(db){
 const query=(sql,p=[])=>p.length?db.query(sql,p):db.exec(sql).then(r=>r.at(-1));
 let chain=Promise.resolve();
 return{query,connect:async()=>{const before=chain;let release;chain=new Promise(r=>release=r);await before;return{query,release}},end:async()=>db.close()};
}

test('daily route respects appointments, locations, branch scope and immutable revisions',async()=>{
 const db=await PGlite.create(),pool=harness(db),q=pool.query;
 try{
  await q(`CREATE TABLE branches(id SERIAL PRIMARY KEY,code TEXT,name TEXT,address TEXT,timezone TEXT DEFAULT 'Asia/Qostanay',active BOOLEAN DEFAULT true);
CREATE TABLE users(id SERIAL PRIMARY KEY,name TEXT,email TEXT,role TEXT,active BOOLEAN DEFAULT true,primary_branch_id INT);
CREATE TABLE user_branches(user_id INT,branch_id INT,is_primary BOOLEAN DEFAULT false);
CREATE TABLE customers(id SERIAL PRIMARY KEY,name TEXT,phone TEXT,email TEXT,address TEXT,created_at TIMESTAMPTZ DEFAULT now(),updated_at TIMESTAMPTZ DEFAULT now(),deleted_at TIMESTAMPTZ);
CREATE TABLE equipment(id SERIAL PRIMARY KEY,customer_id INT,category TEXT,brand TEXT,model TEXT);
CREATE TABLE requests(id SERIAL PRIMARY KEY,number TEXT UNIQUE,customer_id INT,equipment_id INT,engineer_id INT,status TEXT,priority TEXT,complaint TEXT,scheduled_at TIMESTAMPTZ,sla_deadline TIMESTAMPTZ,created_at TIMESTAMPTZ DEFAULT now(),closed_at TIMESTAMPTZ,original_request_id INT,branch_id INT,deleted_at TIMESTAMPTZ);`);
  for(const s of engineerRouteStatements)await q(s);
  const kst=(await q("INSERT INTO branches(code,name,address,latitude,longitude) VALUES('KST','Kostanay','Base',53.2144,63.6246) RETURNING id")).rows[0].id;
  const other=(await q("INSERT INTO branches(code,name,address) VALUES('TLD','Other','Other') RETURNING id")).rows[0].id;
  const manager=(await q("INSERT INTO users(name,email,role,primary_branch_id) VALUES('Manager','m@test','MANAGER',$1) RETURNING id",[kst])).rows[0].id;
  const engineer=(await q("INSERT INTO users(name,email,role,primary_branch_id) VALUES('Engineer','e@test','ENGINEER',$1) RETURNING id",[kst])).rows[0].id;
  await q('INSERT INTO user_branches(user_id,branch_id,is_primary) VALUES($1,$2,true),($3,$2,true)',[manager,kst,engineer]);
  const c1=(await q("INSERT INTO customers(name,phone,address,latitude,longitude) VALUES('A','1','A st',53.2200,63.6300) RETURNING id")).rows[0].id;
  const c2=(await q("INSERT INTO customers(name,phone,address,latitude,longitude) VALUES('B','2','B st',53.2300,63.6450) RETURNING id")).rows[0].id;
  const c3=(await q("INSERT INTO customers(name,phone,address) VALUES('C','3','Unknown st') RETURNING id")).rows[0].id;
  const c4=(await q("INSERT INTO customers(name,phone,address,latitude,longitude) VALUES('D','4','Near A',53.2210,63.6310) RETURNING id")).rows[0].id;
  const e1=(await q("INSERT INTO equipment(customer_id,category,brand,model) VALUES($1,'Fridge','LG','A') RETURNING id",[c1])).rows[0].id;
  const e2=(await q("INSERT INTO equipment(customer_id,category,brand,model) VALUES($1,'Washer','Samsung','B') RETURNING id",[c2])).rows[0].id;
  const e3=(await q("INSERT INTO equipment(customer_id,category,brand,model) VALUES($1,'TV','LG','C') RETURNING id",[c3])).rows[0].id;
  const e4=(await q("INSERT INTO equipment(customer_id,category,brand,model) VALUES($1,'Fridge','Bosch','D') RETURNING id",[c4])).rows[0].id;
  const r1=(await q("INSERT INTO requests(number,customer_id,equipment_id,engineer_id,status,priority,complaint,scheduled_at,sla_deadline,branch_id) VALUES('R1',$1,$2,$3,'ASSIGNED','NORMAL','A','2026-09-10T09:00:00+05:00','2026-09-10T12:00:00+05:00',$4) RETURNING id",[c1,e1,engineer,kst])).rows[0].id;
  const r2=(await q("INSERT INTO requests(number,customer_id,equipment_id,engineer_id,status,priority,complaint,scheduled_at,sla_deadline,branch_id,original_request_id) VALUES('R2',$1,$2,$3,'ASSIGNED','HIGH','B','2026-09-10T10:00:00+05:00','2026-09-10T09:30:00+05:00',$4,$5) RETURNING id",[c2,e2,engineer,kst,r1])).rows[0].id;
  await q("INSERT INTO requests(number,customer_id,equipment_id,engineer_id,status,priority,complaint,scheduled_at,branch_id) VALUES('R3',$1,$2,$3,'ASSIGNED','NORMAL','C','2026-09-10T12:30:00+05:00',$4)",[c3,e3,engineer,kst]);
  await q("INSERT INTO requests(number,customer_id,equipment_id,engineer_id,status,priority,complaint,branch_id) VALUES('BACKLOG',$1,$2,$3,'ASSIGNED','CRITICAL','D',$4)",[c4,e4,engineer,kst]);

  const scope=await resolveEngineerRouteBranchIds(pool,{id:manager,role:'MANAGER'});assert.deepEqual(scope,[Number(kst)]);
  const engineerScope=await resolveEngineerRouteBranchIds(pool,{id:engineer,role:'ENGINEER'});assert.deepEqual(engineerScope,[Number(kst)]);
  const route=await buildEngineerRouteSuggestion(pool,{branchIds:scope,branchId:kst,engineerId:engineer,date:'2026-09-10',now:new Date('2026-09-09T16:00:00Z')});
  assert.deepEqual(route.stops.map(x=>x.number),['R1','R2','R3']);
  assert.equal(route.summary.stops,3);assert.equal(route.summary.unresolved_locations,1);assert.ok(route.summary.total_distance_km>0);assert.ok(route.summary.total_travel_minutes>0);
  assert.equal(route.stops[1].arrival_risk,true);assert.equal(route.stops[2].travel_estimate_available,false);
  assert.equal(route.backlog_candidates[0].number,'BACKLOG');assert.ok(route.backlog_candidates[0].nearest_route_km<1);assert.match(route.backlog_candidates[0].reason,/согласовать время/i);
  await assert.rejects(buildEngineerRouteSuggestion(pool,{branchIds:scope,branchId:other,engineerId:engineer,date:'2026-09-10'}),e=>e.code==='FORBIDDEN');

  const located=await updateRouteCustomerLocation(pool,{branchIds:scope,branchId:kst,customerId:c3,latitude:53.2400,longitude:63.6600,actorId:manager});assert.equal(Number(located.latitude),53.24);
  const audit=(await q('SELECT * FROM engineer_route_location_audit WHERE customer_id=$1',[c3])).rows[0];assert.ok(audit);assert.equal(audit.before_location.latitude,null);assert.equal(Number(audit.after_location.latitude),53.24);
  await assert.rejects(q("UPDATE engineer_route_location_audit SET after_location='{}' WHERE id=$1",[audit.id]),e=>e.code==='P2401');
  const resolvedRoute=await buildEngineerRouteSuggestion(pool,{branchIds:scope,branchId:kst,engineerId:engineer,date:'2026-09-10',now:new Date('2026-09-09T16:00:00Z')});assert.equal(resolvedRoute.summary.unresolved_locations,0);assert.equal(resolvedRoute.stops[2].travel_estimate_available,true);

  const first=await publishEngineerRoutePlan(pool,{branchIds:scope,branchId:kst,engineerId:engineer,date:'2026-09-10',actorId:manager,now:new Date('2026-09-09T16:00:00Z')});
  assert.equal(Number(first.plan.revision),1);assert.equal(first.stops.length,3);
  await assert.rejects(q('UPDATE engineer_route_plans SET total_distance_km=0 WHERE id=$1',[first.plan.id]),e=>e.code==='P2401');
  await assert.rejects(q('DELETE FROM engineer_route_plan_stops WHERE plan_id=$1',[first.plan.id]),e=>e.code==='P2401');
  await q("UPDATE requests SET scheduled_at='2026-09-10T10:30:00+05:00' WHERE id=$1",[r2]);
  const second=await publishEngineerRoutePlan(pool,{branchIds:scope,branchId:kst,engineerId:engineer,date:'2026-09-10',actorId:manager,now:new Date('2026-09-09T16:05:00Z')});
  assert.equal(Number(second.plan.revision),2);assert.notEqual(Number(second.plan.id),Number(first.plan.id));
  const oldStop=(await q('SELECT planned_at FROM engineer_route_plan_stops WHERE plan_id=$1 AND request_id=$2',[first.plan.id,r2])).rows[0];
  assert.equal(new Date(oldStop.planned_at).toISOString(),new Date('2026-09-10T10:00:00+05:00').toISOString());
 }finally{await pool.end()}
});
