import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire,builtinModules} from 'node:module';
import {pathToFileURL,fileURLToPath} from 'node:url';
import path from 'node:path';
import {PGlite} from '@electric-sql/pglite';
import {migrateCore} from '../src/migrate.js';
import {buildFinanceApp} from '../src/finance/app.js';
import {payrollPeriod} from '../src/payroll-calculation.js';

// Execute the shipped route handlers, replacing only process/network/DB infrastructure.
// PGlite has one connection: this suite proves outcomes and replay, not PostgreSQL lock contention.
const root=fileURLToPath(new URL('../src/',import.meta.url));
const require=createRequire(import.meta.url);
async function setup(){
 const db=await PGlite.create();
 const query=(sql,params=[])=>params.length?db.query(sql,params):db.exec(sql).then(r=>r.at(-1));
 let queue=Promise.resolve();
 const pool={query,connect:async()=>{const before=queue;let release;queue=new Promise(r=>{release=r});await before;return {query,release}},end:async()=>{}};
 globalThis.__crmRegressionPool=pool;
 const apps=[],probes={};
 async function load(name){
  let src=await readFile(path.join(root,name+'.js'),'utf8');
  probes[name]=[...src.matchAll(/app\.get\(\s*['"]([^'"]+)/g)].map(m=>m[1]).find(url=>url.startsWith('/api/'))?.replace(/:[A-Za-z]+/g,'1');
  src=src.replace(/import pg from\s*['"]pg['"];?/g,'const pg={Pool:class {constructor(){return globalThis.__crmRegressionPool}}};');
  src=src.replace(/\bfrom\s*(['"])([^'"]+)\1/g,(m,quote,spec)=>{
   if(spec.startsWith('node:')||builtinModules.includes(spec))return m;
   return 'from '+JSON.stringify(pathToFileURL(spec.startsWith('.')?path.resolve(root,spec):require.resolve(spec)).href);
  });
  src=src.replace(/logger:\s*true/g,'logger:false').replaceAll('app.listen(','testListen(').replaceAll('process.on(','testOn(');
  src='const testListen=async()=>{};const testOn=()=>{};const setInterval=()=>0;const fetch=async()=>{throw new Error("Network disabled in regression test")};\n'+src+'\nexport {app};';
  const {app}=await import('data:text/javascript;base64,'+Buffer.from(src).toString('base64'));
  await app.ready();apps.push(app);return app;
 }
 await migrateCore(pool);
 await query("INSERT INTO users(name,email,password_hash,role) VALUES ('Owner','owner@test.invalid','unused','OWNER'),('Manager','manager@test.invalid','unused','MANAGER'),('Engineer','engineer@test.invalid','unused','ENGINEER'),('Other engineer','other@test.invalid','unused','ENGINEER')");
 await query("INSERT INTO customers(name,phone) VALUES('Test client','0000')");
 const services={};
 for(const name of ['index2','warehouse','procurement','payroll','pricebook','diagnostic-flow','parts-orchestrator','documents','completion','communications','approvals-portal','analytics','order-tasks','kpi','profitability','owner-control','workflow','pricing-guard','notifications','operations-center','engineer-performance','reliability','discipline','directory-admin'])services[name]=await load(name);
 services.finance=await buildFinanceApp(pool,{logger:false});apps.push(services.finance);
 probes.finance='/api/v1/accounts';
 const tokens={};for(const [id,role]of [[1,'OWNER'],[2,'MANAGER'],[3,'ENGINEER'],[4,'ENGINEER']])tokens[id]=services.index2.jwt.sign({id,role});
 let seq=0;
 async function call(service,method,url,payload,user=1,key){
  const app=services[service];
  const res=await app.inject({method,url,payload,headers:{authorization:'Bearer '+tokens[user],'idempotency-key':key||'regression-'+String(++seq).padStart(12,'0')}});
  return {status:res.statusCode,...res.json()};
 }
 const order=async(status='REPAIR',engineer=3,total=1000)=>(await query("INSERT INTO requests(number,customer_id,engineer_id,manager_id,status,complaint,total) VALUES($1,1,$2,2,$3,'Test',$4) RETURNING id",['TEST-'+(++seq),engineer,status,total])).rows[0].id;
 const closeFixture=async id=>{await query('BEGIN');try{await query("SELECT set_config('app.completion_close_request',$1,true)",[String(id)]);await query("UPDATE requests SET status='CLOSED',closed_at=now() WHERE id=$1",[id]);await query('COMMIT')}catch(e){await query('ROLLBACK');throw e}};
 return {query,services,probes,load,call,order,closeFixture,close:async()=>{for(const app of apps)await app.close();await db.close();delete globalThis.__crmRegressionPool;}};
}

test('Сквозные регрессии доступа, заказов, склада и расчётов',async t=>{
 const s=await setup();const {query,call,order}=s;
 try{
  await t.test('Чужой заказ закрыт через диагностику, прайс, файлы, согласование и дочерние строки',async()=>{
   const foreign=await order('REPAIR',4);
   for(const [service,url]of [['diagnostic-flow',`/api/v1/requests/${foreign}`],['documents',`/api/v1/requests/${foreign}/files`],['completion',`/api/v1/requests/${foreign}`]])assert.equal((await call(service,'GET',url,undefined,3)).status,403);
   assert.equal((await call('diagnostic-flow','PUT',`/api/v1/requests/${foreign}/diagnosis`,{diagnosis:'Forbidden'},3)).status,403);
   assert.equal((await call('pricebook','POST',`/api/v1/requests/${foreign}/add`,{item_id:1},3)).status,403);
   assert.equal((await call('approvals-portal','GET',`/api/v1/approvals/request/${foreign}`,undefined,3)).status,403);
   const own=await order();
   assert.equal((await call('diagnostic-flow','PUT',`/api/v1/requests/${own}/diagnosis`,{diagnosis:'Allowed'},3)).status,200);
   const line=(await query("INSERT INTO request_quote_lines(request_id,line_type,name) VALUES($1,'WORK','Private line') RETURNING id",[foreign])).rows[0];
   assert.equal((await call('diagnostic-flow','DELETE',`/api/v1/lines/${line.id}`,undefined,3)).status,403);
   await query("INSERT INTO message_queue(request_id,channel,audience,body,status) VALUES($1,'WHATSAPP','CUSTOMER','Private','QUEUED'),($2,'WHATSAPP','CUSTOMER','Own','QUEUED')",[foreign,own]);
   const messages=await call('communications','GET','/api/v1/communications/queue',undefined,3);
   assert.equal(messages.status,200);assert.ok(messages.data.some(m=>m.request_id===own));assert.ok(!messages.data.some(m=>m.request_id===foreign));
  });
  await t.test('Блокировка и изменение роли применяются к уже выданным токенам',async()=>{
   await query('UPDATE users SET active=false WHERE id=2');
   try{
   for(const [service,url]of Object.entries(s.probes)){
    assert.ok(url,service+' must expose a private route');
    assert.equal((await call(service,'GET',url,undefined,2)).status,403,service);
   }
   }finally{await query('UPDATE users SET active=true WHERE id=2');}
   await query("UPDATE users SET role='ENGINEER' WHERE id=1");
   assert.equal((await call('payroll','GET','/api/v1/rules')).status,403);
   assert.equal((await call('warehouse','GET','/api/v1/stock')).status,403);
   await query("UPDATE users SET role='OWNER' WHERE id=1");
  });
  await t.test('Обычные операции не меняют закрытый или отменённый заказ',async()=>{
   for(const status of ['CLOSED','CANCELLED']){
    const id=await order(status);
    assert.equal((await call('index2','POST',`/api/v1/requests/${id}/diagnosis`,{diagnosis:'Bad'},3)).status,409);
    assert.equal((await call('index2','POST',`/api/v1/requests/${id}/works`,{name:'Bad',qty:1,unit_price:5000})).status,409);
    assert.equal((await call('index2','POST',`/api/v1/requests/${id}/payment`,{amount:100,account_id:1})).status,409);
    assert.equal((await call('parts-orchestrator','POST',`/api/v1/requests/${id}/prepare`,{})).status,409);
    assert.equal((await call('diagnostic-flow','PUT',`/api/v1/requests/${id}/diagnosis`,{diagnosis:'Bad'})).status,409);
    await assert.rejects(query("UPDATE requests SET diagnosis='Bypass',total=5000 WHERE id=$1",[id]),e=>e.code==='P2409');
    await assert.rejects(query("INSERT INTO request_works(request_id,name,qty,unit_price) VALUES($1,'Bypass',1,5000)",[id]),e=>e.code==='P2409');
    const actual=(await query('SELECT status,total FROM requests WHERE id=$1',[id])).rows[0];assert.equal(actual.status,status);assert.equal(Number(actual.total),1000);
    assert.equal((await call('index2','POST',`/api/v1/requests/${id}/notes`,{text:'Append-only comment'})).status,201);
   }
  });
  await t.test('Резерв нельзя выдать или списать для чужого заказа; свой резерв устанавливается',async()=>{
   const id=await order(),foreign=await order('REPAIR',4);
   const item=(await query("INSERT INTO warehouse_items(name,quantity,purchase_price,sale_price) VALUES('Reserved item',1,100,200) RETURNING id")).rows[0].id;
   assert.equal((await call('procurement','POST','/api/v1/reservations',{item_id:item,request_id:id,quantity:1})).status,201);
   for(const [action,body]of [['issue',{quantity:1,engineer_id:4}],['write-off',{quantity:1,comment:'Проверка защиты резерва'}],['install',{quantity:1,request_id:foreign}]])assert.equal((await call('warehouse','POST',`/api/v1/items/${item}/${action}`,body)).status,409,action);
   assert.equal((await call('procurement','POST','/api/v1/reservations',{item_id:item,request_id:foreign,quantity:1})).status,409);
   const install=await call('warehouse','POST',`/api/v1/items/${item}/install`,{quantity:1,request_id:id});assert.equal(install.status,200,JSON.stringify(install));
   assert.equal(Number((await query('SELECT quantity FROM warehouse_items WHERE id=$1',[item])).rows[0].quantity),0);
   assert.equal(Number((await query("SELECT count(*) n FROM stock_reservations WHERE item_id=$1 AND status='ACTIVE'",[item])).rows[0].n),0);
  });
  await t.test('Повтор подготовки закупки и получения не увеличивает количество',async()=>{
   await query("INSERT INTO suppliers(name) VALUES('Supplier')");
   const item=(await query("INSERT INTO warehouse_items(name,quantity,purchase_price,sale_price,supplier) VALUES('Shortage',0,100,200,'Supplier') RETURNING id")).rows[0].id;
   const id=await order();await query("INSERT INTO request_quote_lines(request_id,line_type,ref_id,name,qty,unit_price,direct_cost) VALUES($1,'PART',$2,'Shortage',1,200,100)",[id,item]);
   for(let i=0;i<2;i++){const prep=await call('parts-orchestrator','POST',`/api/v1/requests/${id}/prepare`,{});assert.equal(prep.status,200,JSON.stringify(prep));}
   const demand=(await query('SELECT * FROM part_demands WHERE request_id=$1',[id])).rows[0];
   assert.equal(Number((await query('SELECT sum(qty) n FROM purchase_order_items WHERE item_id=$1',[item])).rows[0].n),1);
   for(let i=0;i<2;i++)assert.equal((await call('procurement','POST',`/api/v1/orders/${demand.purchase_order_id}/receive`,{})).status,200);
   assert.equal(Number((await query('SELECT quantity FROM warehouse_items WHERE id=$1',[item])).rows[0].quantity),1);
   assert.equal(Number((await query("SELECT count(*) n FROM warehouse_movements WHERE item_id=$1 AND movement_type='RECEIPT'",[item])).rows[0].n),1);
  });
  await t.test('Прайс сохраняет скидку и себестоимость',async()=>{
   const id=await order();await query('UPDATE requests SET discount_amount=100 WHERE id=$1',[id]);
   const item=(await query("INSERT INTO pricebook(category,name,base_price,labor_cost) VALUES('Test','Work',1000,100) RETURNING id")).rows[0].id;
   const result=await call('pricebook','POST',`/api/v1/requests/${id}/add`,{item_id:item});assert.equal(result.status,200,JSON.stringify(result));
   const r=(await query('SELECT total,direct_cost FROM requests WHERE id=$1',[id])).rows[0];assert.equal(Number(r.total),900);assert.equal(Number(r.direct_cost),100);
  });
  await t.test('Зарплата, прибыль заказа и P&L учитывают фактического исполнителя одинаково',async()=>{
   const id=await order();await query('UPDATE requests SET direct_cost=100 WHERE id=$1',[id]);
   await query("INSERT INTO request_works(request_id,name,qty,unit_price,direct_cost,performed_by) VALUES($1,'Other performed',1,1000,100,4)",[id]);
   await query('INSERT INTO payroll_rules(user_id,work_percent) VALUES(3,10),(4,20)');await s.closeFixture(id);
   const month=new Date().toISOString().slice(0,7);
   const salary=await call('payroll','GET','/api/v1/report?month='+month),profit=await call('profitability','GET','/api/v1/orders?month='+month),pnl=await call('finance','GET','/api/v1/pnl?month='+month);
   for(const r of [salary,profit,pnl])assert.equal(r.status,200,JSON.stringify(r));
   assert.equal(salary.data.month,month);assert.equal(salary.data.rows.find(u=>u.id===4).salary,200);
   assert.equal(profit.data.orders.find(o=>o.id===id).payroll_allocated,200);assert.equal(pnl.data.payroll,salary.data.totals.salary);assert.equal(profit.data.totals.payroll,salary.data.totals.salary);
  });
  await t.test('Месяц не сдвигается в UTC, Костанае или положительном часовом поясе',()=>{
   const old=process.env.TZ;
   try{for(const tz of ['UTC','Asia/Almaty','Europe/Istanbul']){process.env.TZ=tz;assert.equal(payrollPeriod('2026-09')[0].toISOString(),'2026-09-01T00:00:00.000Z');assert.equal(payrollPeriod('2026-09-01')[0].toISOString(),'2026-09-01T00:00:00.000Z');}}
   finally{if(old===undefined)delete process.env.TZ;else process.env.TZ=old;}
   assert.throws(()=>payrollPeriod('2026-13'),e=>e.statusCode===422);
  });
  await t.test('KPI открывается без плана; отменённые задачи не просрочены; рекламация не теряется',async()=>{
   const id=await order();
   await query("INSERT INTO tasks(title,request_id,assigned_to,status,due_at) VALUES('Cancelled',$1,3,'CANCELLED',now()-interval '1 day')",[id]);
   const tasks=await call('order-tasks','GET','/api/v1/my',undefined,3);assert.equal(tasks.status,200);assert.ok(!tasks.data.some(x=>x.status==='CANCELLED'));
   const kpi=await call('kpi','GET','/api/v1/report',undefined,3);assert.equal(kpi.status,200,JSON.stringify(kpi));assert.ok(kpi.data.rows.some(u=>u.id===3));
   await query("INSERT INTO complaints(number,request_id,customer_id,text) VALUES('C-TEST',$1,1,'Complaint')",[id]);
   const analytics=await call('analytics','GET','/api/v1/dashboard');assert.equal(analytics.status,200);assert.equal(analytics.data.claims.total,1);
  });
  await t.test('Штатное закрытие и документированное открытие собственником работают с защитой БД',async()=>{
   const id=await order('PAYMENT_REQUIRED');await query('UPDATE requests SET paid=1000 WHERE id=$1',[id]);
   await query("INSERT INTO repair_completions(request_id,repair_result,test_result,parts_posted) VALUES($1,'Repaired','Passed',true)",[id]);
   await query("INSERT INTO request_files(request_id,kind,original_name,stored_name,mime_type,size_bytes) VALUES($1,'PHOTO_AFTER','test','test','image/png',1)",[id]);
   await query("INSERT INTO request_signatures(request_id,signer_type,signature_data) VALUES($1,'CLIENT','test')",[id]);
   const result=await call('completion','POST',`/api/v1/requests/${id}/close`,{});assert.equal(result.status,200,JSON.stringify(result));
   const number=(await query('SELECT number FROM requests WHERE id=$1',[id])).rows[0].number;
   assert.equal((await call('owner-control','PATCH',`/api/v1/orders/${number}`,{complaint:'Ordinary change'})).status,409);
   const reopen=await call('owner-control','POST',`/api/v1/orders/${number}/reopen`,{reason:'Документированная корректировка'});assert.equal(reopen.status,200,JSON.stringify(reopen));
   assert.equal((await query('SELECT status FROM requests WHERE id=$1',[id])).rows[0].status,'PAYMENT_REQUIRED');
  });
  await t.test('Публичное согласование не возобновляет отменённый заказ',async()=>{
   const id=await order('CANCELLED');
   await query("INSERT INTO customer_approvals(request_id,token,total,expires_at,created_by) VALUES($1,'cancelled-test-token',1000,now()+interval '1 day',1)",[id]);
   const res=await s.services['approvals-portal'].inject({method:'POST',url:'/public/approvals/cancelled-test-token/respond',payload:{decision:'APPROVED'}});
   assert.equal(res.statusCode,409,res.body);
   assert.equal((await query("SELECT status FROM customer_approvals WHERE token='cancelled-test-token'")).rows[0].status,'PENDING');
  });
  await t.test('Гарантия создаётся после закрытия, предоплата и отмена её не активируют',async()=>{
   const closed=await order('PAYMENT_REQUIRED'),paid=await order(),cancelled=await order('CANCELLED');
   await query('UPDATE requests SET paid=1000,warranty_until=CURRENT_DATE+90 WHERE id=ANY($1::int[])',[[closed,paid]]);
   await s.closeFixture(closed);
   await query("INSERT INTO request_history(request_id,action) VALUES($1,'REQUEST_CLOSED'),($2,'PAYMENT_RECEIVED'),($3,'PAYMENT_RECEIVED')",[closed,paid,cancelled]);
   const warranty=await s.load('warranty');
   const cards=(await query('SELECT * FROM warranty_cards')).rows;
   assert.ok(cards.some(c=>c.request_id===closed));assert.ok(!cards.some(c=>[paid,cancelled].includes(c.request_id)));
   const card=cards.find(c=>c.request_id===closed);
   assert.equal(card.warranty_days,90);
   assert.equal((await warranty.inject({method:'GET',url:'/public/warranty/'+card.token})).statusCode,200);
   await query("INSERT INTO warranty_cards(request_id,token,warranty_until) VALUES($1,'old-cancelled-card',CURRENT_DATE+90)",[cancelled]);
   assert.equal((await warranty.inject({method:'GET',url:'/public/warranty/old-cancelled-card'})).statusCode,404);
  });
 }finally{await s.close();}
});
