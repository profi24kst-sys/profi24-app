import {test} from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import jwt from '@fastify/jwt';
import {PGlite} from '@electric-sql/pglite';
import {migrateCore} from '../src/migrate.js';
import {authenticate,installOrderAccess} from '../src/access.js';
import {roleAllowed} from '../src/rbac.js';
import {installCustomerFeedback} from '../src/customer-feedback.js';

test('NPS survey is private, auditable and creates low-score follow-up',async()=>{
 const db=await PGlite.create(),query=(sql,p=[])=>p.length?db.query(sql,p):db.exec(sql).then(r=>r.at(-1));let chain=Promise.resolve();
 const pool={query,connect:async()=>{const before=chain;let release;chain=new Promise(r=>release=r);await before;return{query,release}},end:async()=>{}};await migrateCore(pool);
 await query("INSERT INTO users(name,email,password_hash,role) VALUES('Owner','o@nps.test','x','OWNER'),('Supervisor','s@nps.test','x','SUPERVISOR'),('Manager','m@nps.test','x','MANAGER'),('Engineer','e@nps.test','x','ENGINEER')");
 await query("INSERT INTO customers(name,phone) VALUES('Client','77000000101')");await query("INSERT INTO equipment(customer_id,category,brand,model) VALUES(1,'Стиральная машина','LG','F2J3')");const branch=(await query("SELECT id FROM branches WHERE code='KST'")).rows[0].id;
 const request=(await query("INSERT INTO requests(number,customer_id,equipment_id,manager_id,engineer_id,branch_id,status,complaint,closed_at) VALUES('NPS-T1',1,1,3,4,$1,'CLOSED','NPS test',now()) RETURNING id",[branch])).rows[0].id;
 await query("CREATE TABLE message_templates(id SERIAL PRIMARY KEY,code TEXT UNIQUE NOT NULL,name TEXT NOT NULL,audience TEXT NOT NULL,channel TEXT NOT NULL,body TEXT NOT NULL,active BOOLEAN DEFAULT TRUE)");
 const app=Fastify({logger:false});await app.register(jwt,{secret:'x'.repeat(64)});const auth=async(req,reply)=>{if(!await authenticate(req,reply,pool))return},roles=(...allowed)=>async(req,reply)=>{await auth(req,reply);if(reply.sent)return;if(!roleAllowed(req.user.role,allowed))return reply.code(403).send({data:null,error:{code:'FORBIDDEN',message:'Недостаточно прав'}})};
 const requestData=async id=>(await query('SELECT r.*,c.name customer_name,c.phone FROM requests r JOIN customers c ON c.id=r.customer_id WHERE r.id=$1',[id])).rows[0],vars=x=>({request_number:x.number,customer_name:x.customer_name}),render=(t,d)=>String(t).replace(/{{\s*([a-z_]+)\s*}}/g,(_,k)=>d[k]??'');const messages=[];
 const enqueue=async x=>{if(messages.some(m=>m.dedupe_key===x.dedupe_key))return null;const m={id:messages.length+1,status:'QUEUED',...x};messages.push(m);return m};installOrderAccess(app,pool,'communications');const flow=await installCustomerFeedback(app,pool,{enqueue,requestData,vars,render,roles});await app.ready();
 const tokenOwner=app.jwt.sign({id:1,role:'OWNER'}),tokenSupervisor=app.jwt.sign({id:2,role:'SUPERVISOR'}),call=async(method,url,payload,token)=>{const h=token?{authorization:'Bearer '+token}:{};const r=await app.inject({method,url,payload,headers:h});return{status:r.statusCode,...r.json()}};
 let r=await call('PATCH','/api/v1/customer-feedback/settings',{public_review_url:'https://example.com/review'},tokenSupervisor);assert.equal(r.status,200,JSON.stringify(r));
 const invited=await flow.enqueueInvite({request_id:request,dedupe_key:'nps:test'}),raw=invited.queued.body.match(/\/feedback\/([A-Za-z0-9_-]+)/)[1];assert.ok(raw);const stored=(await query('SELECT * FROM customer_feedback WHERE request_id=$1',[request])).rows[0];assert.notEqual(stored.token_hash,raw);
 r=await call('GET','/public/v1/feedback/'+raw);assert.equal(r.status,200);assert.equal(Object.hasOwn(r.data,'phone'),false);assert.equal(Object.hasOwn(r.data,'total'),false);
 r=await call('POST','/public/v1/feedback/'+raw,{score:4,comment:'Нужно быстрее информировать',contact_requested:true});assert.equal(r.status,200);assert.equal(r.data.nps_group,'DETRACTOR');assert.match(r.data.review_url,/example\.com/);assert.equal((await call('POST','/public/v1/feedback/'+raw,{score:10})).status,409);
 const feedback=(await query('SELECT * FROM customer_feedback WHERE request_id=$1',[request])).rows[0],task=(await query('SELECT * FROM tasks WHERE id=$1',[feedback.followup_task_id])).rows[0];assert.equal(Number(task.assigned_to),2);assert.equal(task.priority,'HIGH');assert.equal(Number((await query("SELECT count(*) c FROM request_history WHERE request_id=$1 AND action='CUSTOMER_FEEDBACK_RECEIVED'",[request])).rows[0].c),1);
 r=await call('GET','/api/v1/customer-feedback/summary?days=30',undefined,tokenOwner);assert.equal(r.status,200);assert.equal(r.data.nps,-100);assert.equal(r.data.response_rate,100);
 await app.close();await db.close();
});
