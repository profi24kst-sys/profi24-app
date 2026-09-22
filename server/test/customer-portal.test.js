import {test} from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import jwt from '@fastify/jwt';
import {PGlite} from '@electric-sql/pglite';
import {migrateCore} from '../src/migrate.js';
import {installCustomerPortal} from '../src/customer-portal.js';

test('customer portal is customer-scoped, expiring and stores only a token hash',async()=>{
 const db=await PGlite.create();
 const query=(sql,params=[])=>params.length?db.query(sql,params):db.exec(sql).then(r=>r.at(-1));
 let queue=Promise.resolve();
 const pool={query,connect:async()=>{const before=queue;let release;queue=new Promise(r=>{release=r});await before;return{query,release}},end:async()=>{}};
 await migrateCore(pool);
 const users=(await query(`INSERT INTO users(name,email,password_hash,role) VALUES
  ('Owner','owner@portal.test','x','OWNER'),('Engineer','engineer@portal.test','x','ENGINEER') RETURNING id,role`)).rows;
 const owner=users[0],engineer=users[1];
 const customer=(await query("INSERT INTO customers(name,phone) VALUES('Portal Client','+77010000001') RETURNING id")).rows[0];
 const other=(await query("INSERT INTO customers(name,phone) VALUES('Other Client','+77010000002') RETURNING id")).rows[0];
 const equipment=(await query("INSERT INTO equipment(customer_id,category,brand,model,serial_number) VALUES($1,'Стиральная машина','LG','F2J','SN-PORTAL') RETURNING id",[customer.id])).rows[0];
 const order=(await query("INSERT INTO requests(number,customer_id,equipment_id,engineer_id,status,complaint,diagnosis,total,paid) VALUES('PORTAL-1',$1,$2,$3,'REPAIR','Не сливает','Замена насоса',25000,10000) RETURNING id",[customer.id,equipment.id,engineer.id])).rows[0];
 await query("INSERT INTO requests(number,customer_id,status,complaint,total,paid) VALUES('PORTAL-OLD',$1,'CLOSED','Предыдущий ремонт',12000,12000)",[customer.id]);
 await query("INSERT INTO requests(number,customer_id,status,complaint,total,paid) VALUES('OTHER-1',$1,'REPAIR','Чужой заказ',99999,0)",[other.id]);
 await query("INSERT INTO request_history(request_id,action,details) VALUES($1,'REQUEST_CREATED','{}'),($1,'WORKFLOW_START_REPAIR','{}'),($1,'ORDER_COMMENT',$2)",[order.id,{secret:'internal note'}]);

 const app=Fastify({logger:false});await app.register(jwt,{secret:'portal-test-secret'});installCustomerPortal(app,pool);await app.ready();
 const ownerToken=app.jwt.sign({id:owner.id,role:'OWNER'}),engineerToken=app.jwt.sign({id:engineer.id,role:'ENGINEER'});
 const auth=token=>({authorization:`Bearer ${token}`});

 let res=await app.inject({method:'POST',url:'/api/v1/customer-portal/links',headers:auth(engineerToken),payload:{source_request_id:order.id,expires_days:30}});
 assert.equal(res.statusCode,403,res.body);

 res=await app.inject({method:'POST',url:'/api/v1/customer-portal/links',headers:auth(ownerToken),payload:{source_request_id:order.id,expires_days:30}});
 assert.equal(res.statusCode,201,res.body);const first=res.json().data;
 const token=first.url.split('/').at(-1);assert.match(token,/^[a-f0-9]{64}$/);
 const stored=(await query('SELECT token_hash,revoked_at FROM customer_portal_links WHERE id=$1',[first.id])).rows[0];
 assert.notEqual(stored.token_hash,token);assert.equal(stored.revoked_at,null);
 assert.equal(Number((await query('SELECT count(*) n FROM customer_portal_links WHERE token_hash=$1',[token])).rows[0].n),0);

 await query("CREATE TABLE IF NOT EXISTS customer_approvals(id BIGSERIAL PRIMARY KEY,request_id INT NOT NULL REFERENCES requests(id) ON DELETE CASCADE,token TEXT UNIQUE,status TEXT NOT NULL DEFAULT 'PENDING',version INT NOT NULL DEFAULT 1,total NUMERIC(14,2) NOT NULL DEFAULT 0,snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,created_by INT REFERENCES users(id),created_at TIMESTAMPTZ DEFAULT now(),expires_at TIMESTAMPTZ)");
 const approval=(await query("INSERT INTO customer_approvals(request_id,token,status,total,expires_at,created_by) VALUES($1,NULL,'PENDING',25000,now()+interval '1 day',$2) RETURNING id",[order.id,owner.id])).rows[0];
 res=await app.inject({method:'GET',url:`/public/customer-portal/${token}`});assert.equal(res.statusCode,200,res.body);
 const portal=res.json().data;
 const approvalAction=portal.orders.find(x=>x.number==='PORTAL-1')?.actions?.approval_url;
 assert.match(String(approvalAction||''),new RegExp('^/approve/v2\\.'+approval.id+'\\.'));assert.equal(portal.customer.name,'Portal Client');assert.equal(portal.orders.length,2);
 assert.ok(portal.orders.some(x=>x.number==='PORTAL-1'));assert.ok(portal.orders.some(x=>x.number==='PORTAL-OLD'));assert.ok(!portal.orders.some(x=>x.number==='OTHER-1'));
 const current=portal.orders.find(x=>x.number==='PORTAL-1');assert.equal(Number(current.total),25000);assert.equal(Number(current.paid),10000);assert.equal(current.timeline.length,2);
 assert.deepEqual(current.timeline.map(x=>x.label),['Заявка принята','Ремонт начат']);assert.equal('details' in current.timeline[0],false);assert.equal('direct_cost' in current,false);assert.equal('phone' in portal.customer,false);

 await query("UPDATE requests SET status='CLOSED',closed_at=now() WHERE id=$1",[order.id]);
 res=await app.inject({method:'POST',url:'/api/v1/customer-portal/links',headers:auth(ownerToken),payload:{source_request_id:order.id,expires_days:5}});assert.equal(res.statusCode,201,res.body);const second=res.json().data;
 assert.notEqual(second.id,first.id);assert.ok((await query('SELECT revoked_at FROM customer_portal_links WHERE id=$1',[first.id])).rows[0].revoked_at);
 res=await app.inject({method:'GET',url:`/public/customer-portal/${token}`});assert.equal(res.statusCode,410,res.body);assert.equal(res.json().error.code,'PORTAL_REVOKED');

 const token2=second.url.split('/').at(-1);
 await query('UPDATE customers SET deleted_at=now() WHERE id=$1',[customer.id]);
 res=await app.inject({method:'GET',url:`/public/customer-portal/${token2}`});assert.equal(res.statusCode,404,res.body);assert.equal(res.json().error.code,'NOT_FOUND');
 await query('UPDATE customers SET deleted_at=NULL WHERE id=$1',[customer.id]);
 await query("UPDATE customer_portal_links SET created_at=now()-interval '2 days',expires_at=now()-interval '1 day' WHERE id=$1",[second.id]);
 res=await app.inject({method:'GET',url:`/public/customer-portal/${token2}`});assert.equal(res.statusCode,410,res.body);assert.equal(res.json().error.code,'PORTAL_EXPIRED');

 await app.close();await db.close();
});


test('manager customer portal is branch-scoped and cannot revoke a global portal',async()=>{
 const db=await PGlite.create();
 const query=(sql,params=[])=>params.length?db.query(sql,params):db.exec(sql).then(r=>r.at(-1));
 let queue=Promise.resolve();
 const pool={query,connect:async()=>{const before=queue;let release;queue=new Promise(r=>{release=r});await before;return{query,release}},end:async()=>{}};
 await migrateCore(pool);
 const kst=(await query("SELECT id FROM branches WHERE code='KST'")).rows[0];
 const otherBranch=(await query("INSERT INTO branches(code,name,active) VALUES('ALT','Другой филиал',true) RETURNING id")).rows[0];
 const users=(await query(`INSERT INTO users(name,email,password_hash,role,primary_branch_id) VALUES
  ('Scope Owner','scope-owner@portal.test','x','OWNER',$1),
  ('Scope Manager','scope-manager@portal.test','x','MANAGER',$1)
  RETURNING id,role`,[kst.id])).rows;
 const owner=users[0],manager=users[1];
 const customer=(await query("INSERT INTO customers(name,phone) VALUES('Branch Portal Client','+77010000111') RETURNING id")).rows[0];
 const orderA=(await query("INSERT INTO requests(number,customer_id,branch_id,status,complaint) VALUES('SCOPE-A',$1,$2,'REPAIR','Филиал A') RETURNING id",[customer.id,kst.id])).rows[0];
 const orderB=(await query("INSERT INTO requests(number,customer_id,branch_id,status,complaint) VALUES('SCOPE-B',$1,$2,'CLOSED','Филиал B') RETURNING id",[customer.id,otherBranch.id])).rows[0];

 const app=Fastify({logger:false});await app.register(jwt,{secret:'portal-scope-secret'});installCustomerPortal(app,pool);await app.ready();
 const ownerToken=app.jwt.sign({id:owner.id,role:'OWNER'}),managerToken=app.jwt.sign({id:manager.id,role:'MANAGER'});
 const auth=token=>({authorization:`Bearer ${token}`});

 let res=await app.inject({method:'POST',url:'/api/v1/customer-portal/links',headers:auth(ownerToken),payload:{source_request_id:orderA.id,expires_days:30}});
 assert.equal(res.statusCode,201,res.body);const globalLink=res.json().data,globalToken=globalLink.url.split('/').at(-1);
 assert.equal(globalLink.scope_branch_ids,null);
 res=await app.inject({method:'GET',url:`/public/customer-portal/${globalToken}`});assert.equal(res.statusCode,200,res.body);
 assert.deepEqual(new Set(res.json().data.orders.map(x=>x.number)),new Set(['SCOPE-A','SCOPE-B']));

 res=await app.inject({method:'POST',url:'/api/v1/customer-portal/links',headers:auth(managerToken),payload:{source_request_id:orderA.id,expires_days:30}});
 assert.equal(res.statusCode,201,res.body);const managerLink=res.json().data,managerPortalToken=managerLink.url.split('/').at(-1);
 assert.deepEqual(managerLink.scope_branch_ids,[Number(kst.id)]);
 const stored=(await query('SELECT scope_branch_ids FROM customer_portal_links WHERE id=$1',[managerLink.id])).rows[0];
 assert.deepEqual(stored.scope_branch_ids,[Number(kst.id)]);

 res=await app.inject({method:'GET',url:`/public/customer-portal/${managerPortalToken}`});assert.equal(res.statusCode,200,res.body);
 assert.deepEqual(res.json().data.orders.map(x=>x.number),['SCOPE-A']);
 res=await app.inject({method:'GET',url:`/public/customer-portal/${globalToken}`});assert.equal(res.statusCode,200,res.body);

 res=await app.inject({method:'GET',url:`/api/v1/customer-portal/requests/${orderA.id}/link`,headers:auth(managerToken)});
 assert.equal(res.statusCode,200,res.body);assert.equal(Number(res.json().data.id),Number(managerLink.id));
 res=await app.inject({method:'GET',url:`/api/v1/customer-portal/requests/${orderA.id}/link`,headers:auth(ownerToken)});
 assert.equal(res.statusCode,200,res.body);assert.equal(Number(res.json().data.id),Number(globalLink.id));

 res=await app.inject({method:'POST',url:`/api/v1/customer-portal/links/${globalLink.id}/revoke`,headers:auth(managerToken)});
 assert.equal(res.statusCode,403,res.body);assert.equal(res.json().error.code,'PORTAL_SCOPE_FORBIDDEN');
 res=await app.inject({method:'POST',url:'/api/v1/customer-portal/links',headers:auth(managerToken),payload:{source_request_id:orderB.id,expires_days:30}});
 assert.equal(res.statusCode,403,res.body);

 res=await app.inject({method:'POST',url:'/api/v1/customer-portal/links',headers:auth(managerToken),payload:{source_request_id:orderA.id,expires_days:30}});
 assert.equal(res.statusCode,201,res.body);const replacement=res.json().data;
 assert.notEqual(Number(replacement.id),Number(managerLink.id));
 res=await app.inject({method:'GET',url:`/public/customer-portal/${managerPortalToken}`});assert.equal(res.statusCode,410,res.body);
 res=await app.inject({method:'GET',url:`/public/customer-portal/${globalToken}`});assert.equal(res.statusCode,200,res.body);

 await app.close();await db.close();
});


test('manager portal keeps the full branch permission snapshot for later customer orders',async()=>{
 const db=await PGlite.create();
 const query=(sql,params=[])=>params.length?db.query(sql,params):db.exec(sql).then(r=>r.at(-1));
 let queue=Promise.resolve();
 const pool={query,connect:async()=>{const before=queue;let release;queue=new Promise(r=>{release=r});await before;return{query,release}},end:async()=>{}};
 await migrateCore(pool);
 const kst=(await query("SELECT id FROM branches WHERE code='KST'")).rows[0];
 const allowedLater=(await query("INSERT INTO branches(code,name,active) VALUES('LATER','Разрешённый второй филиал',true) RETURNING id")).rows[0];
 const blocked=(await query("INSERT INTO branches(code,name,active) VALUES('BLOCK','Недоступный филиал',true) RETURNING id")).rows[0];
 const manager=(await query("INSERT INTO users(name,email,password_hash,role,primary_branch_id) VALUES('Snapshot Manager','snapshot-manager@portal.test','x','MANAGER',$1) RETURNING id,role",[kst.id])).rows[0];
 await query("INSERT INTO user_branches(user_id,branch_id,is_primary) VALUES($1,$2,false) ON CONFLICT(user_id,branch_id) DO NOTHING",[manager.id,allowedLater.id]);
 const customer=(await query("INSERT INTO customers(name,phone) VALUES('Snapshot Client','+77010000222') RETURNING id")).rows[0];
 const firstOrder=(await query("INSERT INTO requests(number,customer_id,branch_id,status,complaint) VALUES('SNAP-A',$1,$2,'REPAIR','Первый филиал') RETURNING id",[customer.id,kst.id])).rows[0];

 const app=Fastify({logger:false});await app.register(jwt,{secret:'portal-snapshot-secret'});installCustomerPortal(app,pool);await app.ready();
 const managerToken=app.jwt.sign({id:manager.id,role:'MANAGER'}),auth={authorization:`Bearer ${managerToken}`};

 let res=await app.inject({method:'POST',url:'/api/v1/customer-portal/links',headers:auth,payload:{source_request_id:firstOrder.id,expires_days:30}});
 assert.equal(res.statusCode,201,res.body);const link=res.json().data,token=link.url.split('/').at(-1);
 assert.deepEqual(link.scope_branch_ids,[Number(kst.id),Number(allowedLater.id)].sort((a,b)=>a-b));

 await query("INSERT INTO requests(number,customer_id,branch_id,status,complaint) VALUES('SNAP-B',$1,$2,'NEW','Поздний заказ во втором разрешённом филиале')",[customer.id,allowedLater.id]);
 const blockedOrder=(await query("INSERT INTO requests(number,customer_id,branch_id,status,complaint) VALUES('SNAP-C',$1,$2,'NEW','Недоступный филиал') RETURNING id",[customer.id,blocked.id])).rows[0];

 res=await app.inject({method:'GET',url:`/public/customer-portal/${token}`});assert.equal(res.statusCode,200,res.body);
 assert.deepEqual(new Set(res.json().data.orders.map(x=>x.number)),new Set(['SNAP-A','SNAP-B']));
 res=await app.inject({method:'POST',url:'/api/v1/customer-portal/links',headers:auth,payload:{source_request_id:blockedOrder.id,expires_days:30}});
 assert.equal(res.statusCode,403,res.body);

 await app.close();await db.close();
});
