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

 let res=await app.inject({method:'POST',url:`/api/v1/customer-portal/requests/${order.id}/link`,headers:auth(engineerToken),payload:{expires_days:30}});
 assert.equal(res.statusCode,403,res.body);

 res=await app.inject({method:'POST',url:`/api/v1/customer-portal/requests/${order.id}/link`,headers:auth(ownerToken),payload:{expires_days:30}});
 assert.equal(res.statusCode,201,res.body);const first=res.json().data;
 const token=first.url.split('/').at(-1);assert.match(token,/^[a-f0-9]{64}$/);
 const stored=(await query('SELECT token_hash,revoked_at FROM customer_portal_links WHERE id=$1',[first.id])).rows[0];
 assert.notEqual(stored.token_hash,token);assert.equal(stored.revoked_at,null);
 assert.equal(Number((await query('SELECT count(*) n FROM customer_portal_links WHERE token_hash=$1',[token])).rows[0].n),0);

 res=await app.inject({method:'GET',url:`/public/customer-portal/${token}`});assert.equal(res.statusCode,200,res.body);
 const portal=res.json().data;assert.equal(portal.customer.name,'Portal Client');assert.equal(portal.orders.length,2);
 assert.ok(portal.orders.some(x=>x.number==='PORTAL-1'));assert.ok(portal.orders.some(x=>x.number==='PORTAL-OLD'));assert.ok(!portal.orders.some(x=>x.number==='OTHER-1'));
 const current=portal.orders.find(x=>x.number==='PORTAL-1');assert.equal(Number(current.total),25000);assert.equal(Number(current.paid),10000);assert.equal(current.timeline.length,2);
 assert.deepEqual(current.timeline.map(x=>x.label),['Заявка принята','Ремонт начат']);assert.equal('details' in current.timeline[0],false);assert.equal('direct_cost' in current,false);assert.equal('phone' in portal.customer,false);

 res=await app.inject({method:'POST',url:`/api/v1/customer-portal/requests/${order.id}/link`,headers:auth(ownerToken),payload:{expires_days:5}});assert.equal(res.statusCode,201,res.body);const second=res.json().data;
 assert.notEqual(second.id,first.id);assert.ok((await query('SELECT revoked_at FROM customer_portal_links WHERE id=$1',[first.id])).rows[0].revoked_at);
 res=await app.inject({method:'GET',url:`/public/customer-portal/${token}`});assert.equal(res.statusCode,410,res.body);assert.equal(res.json().error.code,'PORTAL_REVOKED');

 const token2=second.url.split('/').at(-1);await query("UPDATE customer_portal_links SET created_at=now()-interval '2 days',expires_at=now()-interval '1 day' WHERE id=$1",[second.id]);
 res=await app.inject({method:'GET',url:`/public/customer-portal/${token2}`});assert.equal(res.statusCode,410,res.body);assert.equal(res.json().error.code,'PORTAL_EXPIRED');

 await app.close();await db.close();
});
