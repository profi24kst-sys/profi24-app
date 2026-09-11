import {test} from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import jwt from '@fastify/jwt';
import {PGlite} from '@electric-sql/pglite';
import {migrateCore} from '../src/migrate.js';
import {installFaultClassification,installFaultModelAnalytics} from '../src/fault-model.js';
import {authenticate} from '../src/access.js';
import {can,PERMISSIONS} from '../src/rbac.js';

test('F27 uses normalized fault/cause/action facts for model analytics and technician patterns',async()=>{
 const db=await PGlite.create(),query=(sql,p=[])=>p.length?db.query(sql,p):db.exec(sql).then(r=>r.at(-1));let chain=Promise.resolve();
 const pool={query,connect:async()=>{const before=chain;let release;chain=new Promise(r=>release=r);await before;return{query,release}},end:async()=>{}};
 await migrateCore(pool);
 const branch=Number((await query("SELECT id FROM branches WHERE code='KST'")).rows[0].id);
 await query("INSERT INTO users(name,email,password_hash,role,primary_branch_id) VALUES('F27 Owner','f27-owner@test','x','OWNER',$1),('F27 Supervisor','f27-supervisor@test','x','SUPERVISOR',$1),('F27 Engineer','f27-engineer@test','x','ENGINEER',$1),('F27 Accountant','f27-accountant@test','x','ACCOUNTANT',$1)",[branch]);
 const users=(await query("SELECT id,email FROM users WHERE email LIKE 'f27-%@test'")).rows,uid=e=>Number(users.find(x=>x.email===e).id),owner=uid('f27-owner@test'),sup=uid('f27-supervisor@test'),eng=uid('f27-engineer@test'),acc=uid('f27-accountant@test');
 await query("INSERT INTO customers(name,phone) VALUES('F27 Client','77000002727')");const customer=Number((await query("SELECT id FROM customers WHERE phone='77000002727'")).rows[0].id);
 await query("INSERT INTO equipment(customer_id,category,brand,model,serial_number) VALUES($1,'Стиральная машина','LG','F2J3NS0W','F27-1'),($1,'Стиральная машина','LG','F2J3NS0W','F27-2'),($1,'Стиральная машина','LG','F2J3NS0W','F27-3'),($1,'Стиральная машина','LG','F2J3NS0W','F27-4')",[customer]);const eq=(await query("SELECT id,serial_number FROM equipment WHERE serial_number LIKE 'F27-%' ORDER BY serial_number")).rows;
 const requests=[];for(let i=0;i<4;i++){const row=(await query("INSERT INTO requests(number,customer_id,equipment_id,engineer_id,branch_id,status,complaint,total,direct_cost) VALUES($1,$2,$3,$4,$5,'REPAIR',$6,$7,$8) RETURNING id",[`F27-${i+1}`,customer,eq[i].id,eng,branch,'Не сливает, разные свободные тексты '+i,20000+i*1000,4000+i*500])).rows[0];requests.push(Number(row.id))}
 const app=Fastify({logger:false});await app.register(jwt,{secret:'f'.repeat(64)});await installFaultClassification(app,pool);
 const analyticsGuard=async(req,reply)=>{if(!await authenticate(req,reply,pool))return;if(!can(req.user.role,PERMISSIONS.ANALYTICS_VIEW))return reply.code(403).send({data:null,error:{code:'FORBIDDEN',message:'Нет аналитики'}})};
 await installFaultModelAnalytics(app,pool,{preHandler:analyticsGuard});await app.ready();
 const token=(id,role)=>app.jwt.sign({id,role}),call=async(method,url,payload,t)=>{const r=await app.inject({method,url,payload,headers:{authorization:'Bearer '+t}});return{status:r.statusCode,...r.json()}};const engT=token(eng,'ENGINEER'),supT=token(sup,'SUPERVISOR'),accT=token(acc,'ACCOUNTANT'),ownerT=token(owner,'OWNER');
 let r=await call('GET','/api/v1/fault-taxonomy?category='+encodeURIComponent('Стиральная машина'),undefined,engT);assert.equal(r.status,200);assert.ok(r.data.faults.length>=5);assert.ok(r.data.causes.length>=5);assert.ok(r.data.actions.length>=5);assert.equal((await call('GET','/api/v1/fault-taxonomy',undefined,accT)).status,403);
 const fault=Number(r.data.faults.find(x=>x.code==='NO_DRAIN').id),cause=Number(r.data.causes.find(x=>x.code==='BLOCKAGE_CONTAMINATION').id),cleanAction=Number(r.data.actions.find(x=>x.code==='CLEAN_SERVICE').id),replaceAction=Number(r.data.actions.find(x=>x.code==='REPLACE_COMPONENT').id);
 r=await call('POST','/api/v1/fault-taxonomy/faults',{code:'FRIDGE_ICE','category':'Холодильник','subsystem':'EVAPORATOR','name':'Обмерзание испарителя'},supT);assert.equal(r.status,201);const fridgeFault=r.data.id;
 r=await call('PUT',`/api/v1/requests/${requests[0]}/fault-classification`,{fault_id:fridgeFault,cause_id:cause,action_id:cleanAction},engT);assert.equal(r.status,409);assert.equal(r.error.code,'CATEGORY_MISMATCH');
 r=await call('PUT',`/api/v1/requests/${requests[0]}/fault-classification`,{fault_id:fault,cause_id:cause,action_id:replaceAction,note:'Первичная гипотеза'},engT);assert.equal(r.status,200);assert.equal(r.data.fault_code,'NO_DRAIN');
 r=await call('PUT',`/api/v1/requests/${requests[0]}/fault-classification`,{fault_id:fault,cause_id:cause,action_id:cleanAction,note:'Подтвержден засор после разборки'},engT);assert.equal(r.status,200);assert.equal(r.data.action_code,'CLEAN_SERVICE');assert.equal(Number((await query('SELECT count(*) c FROM request_fault_classification_history WHERE request_id=$1',[requests[0]])).rows[0].c),1);
 r=await call('PUT',`/api/v1/requests/${requests[1]}/fault-classification`,{fault_id:fault,cause_id:cause,action_id:cleanAction,note:'Очищен фильтр и патрубок'},ownerT);assert.equal(r.status,200);
 await query("UPDATE requests SET status='CLOSED',closed_at=now()-interval '10 days' WHERE id=$1",[requests[0]]);await query("UPDATE requests SET status='CLOSED',closed_at=now()-interval '5 days' WHERE id=$1",[requests[1]]);await query("UPDATE requests SET status='CLOSED',closed_at=now()-interval '2 days' WHERE id=$1",[requests[2]]);
 r=await call('PUT',`/api/v1/requests/${requests[0]}/fault-classification`,{fault_id:fault,cause_id:cause,action_id:replaceAction},engT);assert.equal(r.status,409);assert.equal(r.error.code,'ORDER_FINISHED');
 r=await call('GET',`/api/v1/requests/${requests[3]}/fault-patterns`,undefined,engT);assert.equal(r.status,200);assert.equal(r.data.patterns.length,1);assert.equal(Number(r.data.patterns[0].cases),2);assert.equal(r.data.patterns[0].fault_code,'NO_DRAIN');assert.equal(r.data.patterns[0].action_code,'CLEAN_SERVICE');
 r=await call('GET','/api/v1/fault-models',undefined,supT);assert.equal(r.status,200);assert.equal(r.data.coverage.eligible_orders,3);assert.equal(r.data.coverage.classified_orders,2);assert.equal(r.data.coverage.unclassified_orders,1);assert.equal(r.data.coverage.coverage_pct,66.67);assert.equal(r.data.rows.length,1);assert.equal(r.data.rows[0].model,'F2J3NS0W');assert.equal(Number(r.data.rows[0].cases),2);assert.equal(r.data.rows[0].fault_code,'NO_DRAIN');assert.equal(r.data.rows[0].cause_code,'BLOCKAGE_CONTAMINATION');assert.equal(r.data.rows[0].action_code,'CLEAN_SERVICE');
 assert.equal((await call('GET','/api/v1/fault-models',undefined,accT)).status,403);r=await call('GET',`/api/v1/fault-models/orders?model=F2J3NS0W&fault_id=${fault}`,undefined,ownerT);assert.equal(r.status,200);assert.equal(r.data.length,2);assert.ok(r.data.every(x=>x.action_code==='CLEAN_SERVICE'));
 const historyId=(await query('SELECT id FROM request_fault_classification_history WHERE request_id=$1 LIMIT 1',[requests[0]])).rows[0].id;await assert.rejects(()=>query('UPDATE request_fault_classification_history SET note=$1 WHERE id=$2',['tamper',historyId]));
 await app.close();await db.close();
});
