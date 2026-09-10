import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {engineerRouteStatements} from '../src/engineer-route-schema.js';
import {buildBranchRouteExecution,buildEngineerRouteExecution,resolveEngineerRouteExecutionBranchIds} from '../src/engineer-route-execution.js';

function harness(db){
 const query=(sql,p=[])=>p.length?db.query(sql,p):db.exec(sql).then(r=>r.at(-1));
 return{query,end:async()=>db.close()};
}

test('route execution uses same-day workflow facts and propagates delay without GPS',async()=>{
 const db=await PGlite.create(),pool=harness(db),q=pool.query;
 try{
  await q(`CREATE TABLE branches(id SERIAL PRIMARY KEY,code TEXT,name TEXT,address TEXT,active BOOLEAN DEFAULT true);
CREATE TABLE users(id SERIAL PRIMARY KEY,name TEXT,role TEXT,active BOOLEAN DEFAULT true);
CREATE TABLE user_branches(user_id INT,branch_id INT,is_primary BOOLEAN DEFAULT false);
CREATE TABLE customers(id SERIAL PRIMARY KEY,name TEXT,address TEXT,updated_at TIMESTAMPTZ DEFAULT now(),deleted_at TIMESTAMPTZ);
CREATE TABLE requests(id SERIAL PRIMARY KEY,number TEXT,customer_id INT,engineer_id INT,status TEXT,branch_id INT,deleted_at TIMESTAMPTZ);
CREATE TABLE request_stage_events(id BIGSERIAL PRIMARY KEY,request_id INT NOT NULL,event TEXT NOT NULL,created_at TIMESTAMPTZ NOT NULL);`);
  for(const s of engineerRouteStatements)await q(s);
  const kst=(await q("INSERT INTO branches(code,name,address) VALUES('KST','Kostanay','Base') RETURNING id")).rows[0].id;
  const tld=(await q("INSERT INTO branches(code,name,address) VALUES('TLD','Other','Other') RETURNING id")).rows[0].id;
  const manager=(await q("INSERT INTO users(name,role) VALUES('Manager','MANAGER') RETURNING id")).rows[0].id;
  const engineer=(await q("INSERT INTO users(name,role) VALUES('Engineer','ENGINEER') RETURNING id")).rows[0].id;
  await q('INSERT INTO user_branches(user_id,branch_id,is_primary) VALUES($1,$2,true),($3,$2,true)',[manager,kst,engineer]);
  const customers=[];for(const name of ['A','B','C'])customers.push((await q('INSERT INTO customers(name,address) VALUES($1,$2) RETURNING id',[name,`${name} street`])).rows[0].id);
  const requests=[];
  requests.push((await q("INSERT INTO requests(number,customer_id,engineer_id,status,branch_id) VALUES('R1',$1,$2,'DIAGNOSTICS',$3) RETURNING id",[customers[0],engineer,kst])).rows[0].id);
  requests.push((await q("INSERT INTO requests(number,customer_id,engineer_id,status,branch_id) VALUES('R2',$1,$2,'ACCEPTED',$3) RETURNING id",[customers[1],engineer,kst])).rows[0].id);
  requests.push((await q("INSERT INTO requests(number,customer_id,engineer_id,status,branch_id) VALUES('R3',$1,$2,'ASSIGNED',$3) RETURNING id",[customers[2],engineer,kst])).rows[0].id);
  const plan=(await q(`INSERT INTO engineer_route_plans(plan_date,engineer_id,branch_id,revision,method_version,generated_by) VALUES('2026-09-10',$1,$2,1,'test',$3) RETURNING id`,[engineer,kst,manager])).rows[0].id;
  const times=['2026-09-10T09:00:00+05:00','2026-09-10T10:30:00+05:00','2026-09-10T12:00:00+05:00'],travels=[10,15,20];
  for(let i=0;i<3;i++)await q(`INSERT INTO engineer_route_plan_stops(plan_id,sequence_no,request_id,planned_at,duration_minutes,location_status,fixed_appointment,distance_from_previous_km,travel_minutes,priority_score,reason,snapshot) VALUES($1,$2,$3,$4,60,'RESOLVED',true,1,$5,1,'test',$6)`,[plan,i+1,requests[i],times[i],travels[i],{number:`R${i+1}`,customer_name:String.fromCharCode(65+i),address:`${String.fromCharCode(65+i)} street`}]);
  await q("INSERT INTO request_stage_events(request_id,event,created_at) VALUES($1,'DEPART','2026-09-10T08:50:00+05:00'),($1,'ARRIVE','2026-09-10T09:10:00+05:00'),($2,'ARRIVE','2026-09-09T12:05:00+05:00')",[requests[0],requests[2]]);

  const scope=await resolveEngineerRouteExecutionBranchIds(pool,{id:manager,role:'MANAGER'});assert.deepEqual(scope,[Number(kst)]);
  const afterArrival=await buildEngineerRouteExecution(pool,{branchIds:scope,branchId:kst,engineerId:engineer,date:'2026-09-10',now:new Date('2026-09-10T10:20:00+05:00')});
  assert.equal(afterArrival.current_stop.request_id,requests[0]);assert.equal(afterArrival.current_stop.execution_state,'ARRIVED');assert.equal(afterArrival.next_stop.request_id,requests[1]);assert.equal(afterArrival.stops[2].arrived_at,null);

  await q("INSERT INTO request_stage_events(request_id,event,created_at) VALUES($1,'DEPART','2026-09-10T10:35:00+05:00')",[requests[1]]);
  const route=await buildEngineerRouteExecution(pool,{branchIds:scope,branchId:kst,engineerId:engineer,date:'2026-09-10',now:new Date('2026-09-10T10:40:00+05:00')});
  assert.equal(Number(route.plan.id),Number(plan));assert.equal(route.summary.route_state,'ACTIVE');assert.equal(route.summary.arrived,1);assert.equal(route.summary.on_route,1);assert.equal(route.summary.pending,1);
  const [one,two,three]=route.stops;
  assert.equal(one.execution_state,'ARRIVED');assert.equal(one.arrival_delay_minutes,10);assert.equal(one.source,'CRM_WORKFLOW_EVENTS');
  assert.equal(two.execution_state,'ON_ROUTE');assert.equal(two.departure_delay_minutes,20);assert.equal(two.arrival_delay_minutes,20);assert.equal(two.at_risk,true);assert.equal(new Date(two.projected_arrival_at).toISOString(),new Date('2026-09-10T10:50:00+05:00').toISOString());
  assert.equal(three.execution_state,'PENDING');assert.equal(three.arrived_at,null);assert.equal(three.arrival_delay_minutes,10);assert.equal(new Date(three.projected_arrival_at).toISOString(),new Date('2026-09-10T12:10:00+05:00').toISOString());
  assert.equal(route.current_stop.request_id,requests[1]);assert.equal(route.next_stop.request_id,requests[2]);assert.equal(route.summary.at_risk,1);assert.match(route.methodology.facts,/GPS не используется/);

  const board=await buildBranchRouteExecution(pool,{branchIds:scope,branchId:kst,date:'2026-09-10',now:new Date('2026-09-10T10:40:00+05:00')});assert.equal(board.summary.routes,1);assert.equal(board.summary.on_route,1);assert.equal(board.routes[0].engineer.id,engineer);
  await assert.rejects(buildBranchRouteExecution(pool,{branchIds:scope,branchId:tld,date:'2026-09-10'}),e=>e.code==='FORBIDDEN');
  const engineerScope=await resolveEngineerRouteExecutionBranchIds(pool,{id:engineer,role:'ENGINEER'});assert.deepEqual(engineerScope,[Number(kst)]);
 }finally{await pool.end()}
});

test('unstarted overdue route anchors ETA to current time',async()=>{
 const db=await PGlite.create(),pool=harness(db),q=pool.query;
 try{
  await q(`CREATE TABLE branches(id SERIAL PRIMARY KEY,code TEXT,name TEXT,address TEXT,active BOOLEAN DEFAULT true);
CREATE TABLE users(id SERIAL PRIMARY KEY,name TEXT,role TEXT,active BOOLEAN DEFAULT true);
CREATE TABLE user_branches(user_id INT,branch_id INT,is_primary BOOLEAN DEFAULT false);
CREATE TABLE customers(id SERIAL PRIMARY KEY,name TEXT,address TEXT,updated_at TIMESTAMPTZ DEFAULT now(),deleted_at TIMESTAMPTZ);
CREATE TABLE requests(id SERIAL PRIMARY KEY,number TEXT,customer_id INT,engineer_id INT,status TEXT,branch_id INT,deleted_at TIMESTAMPTZ);
CREATE TABLE request_stage_events(id BIGSERIAL PRIMARY KEY,request_id INT NOT NULL,event TEXT NOT NULL,created_at TIMESTAMPTZ NOT NULL);`);
  for(const s of engineerRouteStatements)await q(s);
  const branch=(await q("INSERT INTO branches(code,name) VALUES('KST','K') RETURNING id")).rows[0].id,owner=(await q("INSERT INTO users(name,role) VALUES('Owner','OWNER') RETURNING id")).rows[0].id,engineer=(await q("INSERT INTO users(name,role) VALUES('E','ENGINEER') RETURNING id")).rows[0].id;await q('INSERT INTO user_branches(user_id,branch_id) VALUES($1,$2)',[engineer,branch]);
  const customer=(await q("INSERT INTO customers(name,address) VALUES('A','A') RETURNING id")).rows[0].id,request=(await q("INSERT INTO requests(number,customer_id,engineer_id,status,branch_id) VALUES('R',$1,$2,'ASSIGNED',$3) RETURNING id",[customer,engineer,branch])).rows[0].id,plan=(await q("INSERT INTO engineer_route_plans(plan_date,engineer_id,branch_id,revision,method_version,generated_by) VALUES('2026-09-10',$1,$2,1,'test',$3) RETURNING id",[engineer,branch,owner])).rows[0].id;
  await q("INSERT INTO engineer_route_plan_stops(plan_id,sequence_no,request_id,planned_at,duration_minutes,location_status,distance_from_previous_km,travel_minutes,priority_score,reason) VALUES($1,1,$2,'2026-09-10T09:00:00+05:00',60,'RESOLVED',1,10,1,'test')",[plan,request]);
  const route=await buildEngineerRouteExecution(pool,{branchId:branch,engineerId:engineer,date:'2026-09-10',now:new Date('2026-09-10T10:00:00+05:00')});assert.equal(route.stops[0].overdue_unstarted,true);assert.equal(route.stops[0].arrival_delay_minutes,60);assert.equal(route.stops[0].at_risk,true);
 }finally{await pool.end()}
});