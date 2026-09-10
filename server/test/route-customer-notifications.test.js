import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {ROUTE_NOTIFICATION_TEMPLATES,createRouteCustomerNotificationSync,routeLocalDate,selectRouteDelayAlerts} from '../src/route-customer-notifications.js';

function board(now){return{branch:{id:1},routes:[{plan:{id:44,revision:2},branch:{id:1},engineer:{id:7},summary:{route_state:'ACTIVE'},stops:[
 {request_id:101,number:'KST-101',execution_state:'ON_ROUTE',planned_at:'2026-09-10T09:00:00+05:00',projected_arrival_at:'2026-09-10T09:25:00+05:00',arrival_delay_minutes:25,at_risk:true},
 {request_id:102,number:'KST-102',execution_state:'PENDING',planned_at:'2026-09-10T10:30:00+05:00',projected_arrival_at:'2026-09-10T10:50:00+05:00',arrival_delay_minutes:20,at_risk:true},
 {request_id:103,number:'KST-103',execution_state:'PENDING',planned_at:'2026-09-10T14:00:00+05:00',projected_arrival_at:'2026-09-10T14:30:00+05:00',arrival_delay_minutes:30,at_risk:true},
 {request_id:104,number:'KST-104',execution_state:'ARRIVED',planned_at:'2026-09-10T08:00:00+05:00',projected_arrival_at:'2026-09-10T08:30:00+05:00',arrival_delay_minutes:30,at_risk:true},
 {request_id:105,number:'KST-105',execution_state:'PENDING',planned_at:'2026-09-10T11:00:00+05:00',projected_arrival_at:'2026-09-10T11:10:00+05:00',arrival_delay_minutes:10,at_risk:false}
 ]}]};}

test('delay alert selection sends on-route immediately and pending only inside 120 minute window',()=>{
 const now=new Date('2026-09-10T09:00:00+05:00'),alerts=selectRouteDelayAlerts(board(now),{now});
 assert.deepEqual(alerts.map(x=>x.request_id),[101,102]);
 assert.equal(alerts[0].dedupe_key,'route-delay:44:101');
 assert.equal(alerts[1].arrival_delay_minutes,20);
 assert.equal(routeLocalDate(now),'2026-09-10');
});

test('inactive route does not generate proactive delay messages',()=>{
 const x=board();x.routes[0].summary.route_state='PLANNED';
 assert.deepEqual(selectRouteDelayAlerts(x,{now:new Date('2026-09-10T09:00:00+05:00')}),[]);
});

test('route notification sync seeds templates, renders ETA and deduplicates by route plan and request',async()=>{
 const db=await PGlite.create();
 try{
  await db.exec(`CREATE TABLE message_templates(id SERIAL PRIMARY KEY,code TEXT UNIQUE NOT NULL,name TEXT NOT NULL,audience TEXT NOT NULL,channel TEXT NOT NULL,body TEXT NOT NULL,active BOOLEAN DEFAULT true);
CREATE TABLE engineer_route_plans(id BIGSERIAL PRIMARY KEY,plan_date DATE NOT NULL,branch_id INT NOT NULL,status TEXT NOT NULL);
INSERT INTO engineer_route_plans(id,plan_date,branch_id,status) VALUES(44,'2026-09-10',1,'PUBLISHED');`);
  const messages=new Map(),enqueue=async m=>{if(messages.has(m.dedupe_key))return null;messages.set(m.dedupe_key,m);return{id:messages.size,...m}};
  const requestData=async id=>({id,number:`KST-${id}`,customer_name:'Клиент',phone:'77010000000',engineer_name:'Сергей',scheduled_at:'2026-09-10T10:30:00+05:00'});
  const vars=x=>({request_number:x.number,customer_name:x.customer_name,engineer_name:x.engineer_name,scheduled_at:'10.09, 10:30'});
  const render=(text,data)=>String(text).replace(/{{\s*([a-z_]+)\s*}}/g,(_,k)=>data[k]??'');
  const routeBuilder=async()=>board();
  const sync=createRouteCustomerNotificationSync(db,{enqueue,requestData,vars,render,routeBuilder});
  await sync.seed();
  const seeded=(await db.query(`SELECT code FROM message_templates ORDER BY code`)).rows.map(x=>x.code);assert.deepEqual(seeded,ROUTE_NOTIFICATION_TEMPLATES.map(x=>x[0]).sort());
  const first=await sync.sync(new Date('2026-09-10T09:00:00+05:00'));assert.equal(first.candidates,2);assert.equal(first.queued,2);assert.equal(first.skipped,0);
  const second=await sync.sync(new Date('2026-09-10T09:00:30+05:00'));assert.equal(second.candidates,2);assert.equal(second.queued,0);assert.equal(second.skipped,2);
  const delay=messages.get('route-delay:44:102');assert.ok(delay);assert.equal(delay.template_code,'CUSTOMER_ROUTE_DELAY');assert.match(delay.body,/20 мин/);assert.match(delay.body,/10\.09/);
 }finally{await db.close()}
});
