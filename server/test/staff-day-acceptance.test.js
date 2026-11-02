import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {createRequire,builtinModules} from 'node:module';
import {pathToFileURL,fileURLToPath} from 'node:url';
import path from 'node:path';
import {PGlite} from '@electric-sql/pglite';
import {migrateCore} from '../src/migrate.js';
import {buildFinanceApp} from '../src/finance/app.js';

const root=fileURLToPath(new URL('../src/',import.meta.url));
const require=createRequire(import.meta.url);
const png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z1mAAAAAASUVORK5CYII=';

async function setup(){
  const uploadRoot=await mkdtemp(path.join(tmpdir(),'profi24-a32-'));
  const oldUpload=process.env.UPLOAD_DIR,oldFetch=globalThis.fetch;
  process.env.UPLOAD_DIR=uploadRoot;
  const db=await PGlite.create();
  const query=(sql,params=[])=>params.length?db.query(sql,params):db.exec(sql).then(r=>r.at(-1));
  let queue=Promise.resolve();
  const pool={query,connect:async()=>{const prior=queue;let release;queue=new Promise(r=>{release=r});await prior;return{query,release}},end:async()=>{}};
  globalThis.__staffDayPool=pool;
  globalThis.fetch=async(url,options)=>{
    const target=String(url);
    if(target.startsWith('http://pricing:8095/'))return new Response(JSON.stringify({data:{net_margin:10000,margin_percent:60}}),{status:200,headers:{'content-type':'application/json'}});
    if(target.startsWith('http://parts:8098/'))return new Response(JSON.stringify({data:{prepared:true}}),{status:200,headers:{'content-type':'application/json'}});
    return oldFetch(url,options);
  };
  const apps=[];
  async function load(name){
    let src=await readFile(path.join(root,name+'.js'),'utf8');
    src=src.replace(/import pg from\s*['"]pg['"];?/g,'const pg={Pool:class {constructor(){return globalThis.__staffDayPool}}};');
    src=src.replace(/\bfrom\s*(['"])([^'"]+)\1/g,(m,quote,spec)=>{
      if(spec.startsWith('node:')||builtinModules.includes(spec))return m;
      return 'from '+JSON.stringify(pathToFileURL(spec.startsWith('.')?path.resolve(root,spec):require.resolve(spec)).href);
    });
    src=src.replace(/logger:\s*true/g,'logger:false').replaceAll('app.listen(','testListen(').replaceAll('process.on(','testOn(');
    src='const testListen=async()=>{};const testOn=()=>{};const setInterval=()=>0;\n'+src+'\nexport {app};';
    const {app}=await import('data:text/javascript;base64,'+Buffer.from(src).toString('base64'));
    await app.ready();apps.push(app);return app;
  }
  await migrateCore(pool);
  const branch=(await query("SELECT id FROM branches WHERE code='KST'")).rows[0].id;
  await query(`INSERT INTO users(name,email,password_hash,role,active,primary_branch_id) VALUES
    ('A32 Owner','a32-owner@test.invalid','unused','OWNER',true,$1),
    ('A32 Supervisor','a32-supervisor@test.invalid','unused','SUPERVISOR',true,$1),
    ('A32 Accountant','a32-accountant@test.invalid','unused','ACCOUNTANT',true,$1),
    ('A32 Manager','a32-manager@test.invalid','unused','MANAGER',true,$1),
    ('A32 Engineer','a32-engineer@test.invalid','unused','ENGINEER',true,$1),
    ('A32 Trainee','a32-trainee@test.invalid','unused','TRAINEE',true,$1)`,[branch]);
  const users=(await query("SELECT id,role FROM users WHERE email LIKE 'a32-%@test.invalid' ORDER BY id")).rows;
  const ids=Object.fromEntries(users.map(x=>[x.role.toLowerCase(),Number(x.id)]));
  for(const user of users)await query('INSERT INTO user_branches(user_id,branch_id,is_primary) VALUES($1,$2,true) ON CONFLICT(user_id,branch_id) DO UPDATE SET is_primary=true',[user.id,branch]);

  const services={};
  services.index2=await load('index2');
  services.workflow=await load('workflow');
  services.documents=await load('documents');
  services.warehouse=await load('warehouse');
  services.procurement=await load('procurement');
  services.directory=await load('directory-admin');
  services.diagnostic=await load('diagnostic-flow');
  services.approvals=await load('approvals-portal');
  services.completion=await load('completion');
  services.cash=await load('cash-register');
  services.finance=await buildFinanceApp(pool,{logger:false});apps.push(services.finance);
  const tokens=Object.fromEntries(users.map(x=>[Number(x.id),services.index2.jwt.sign({id:Number(x.id),role:x.role})]));
  let seq=0;
  async function call(service,method,url,payload,user,headers={}){
    const auth=user?{authorization:'Bearer '+tokens[user]}:{};
    const res=await services[service].inject({method,url,payload,headers:{...auth,'idempotency-key':'a32-'+String(++seq).padStart(12,'0'),...headers}});
    let body={};try{body=res.json()}catch{body={raw:res.body}}
    return{status:res.statusCode,...body};
  }
  return{db,query,pool,branch,ids,services,call,close:async()=>{
    for(const app of apps.reverse())await app.close();
    await db.close();
    globalThis.fetch=oldFetch;delete globalThis.__staffDayPool;
    if(oldUpload===undefined)delete process.env.UPLOAD_DIR;else process.env.UPLOAD_DIR=oldUpload;
    await rm(uploadRoot,{recursive:true,force:true});
  }};
}

test('A32: полный рабочий день проходит всеми шестью ролями без ручного исправления бизнес-данных',async()=>{
  const s=await setup(),{call,query,ids}=s;
  try{
    // OWNER: opens the real branch cash account used later by ACCOUNTANT.
    let r=await call('finance','POST','/api/v1/accounts',{name:'A32 Касса смены',type:'CASH',branch_id:s.branch,initial_amount:'0'},ids.owner);
    assert.equal(r.status,201,JSON.stringify(r));const cash=r.data;
    r=await call('cash','POST',`/api/v1/accounts/${cash.id}/open`,{actual_opening_balance:0},ids.owner);
    assert.equal(r.status,201,JSON.stringify(r));const shift=r.data;

    // MANAGER: use the same atomic intake as the new UI; simulate a lost response.
    const intakeBody={customer:{name:'A32 Клиент',phone:'+77071234567',address:'Костанай'},equipment:{category:'Стиральная машина',brand:'LG',model:'A32'},order:{complaint:'Не сливает воду',source:'OTHER',order_type:'FIELD',visit_type:'FIELD'}};
    const intakeKey={'x-idempotency-key':'68d236de-c1a0-413d-a44a-2ea088678f2c'};
    r=await call('index2','POST','/api/v1/requests/intake',intakeBody,ids.manager,intakeKey);
    assert.equal(r.status,201,JSON.stringify(r));const order=r.data;
    const retry=await call('index2','POST','/api/v1/requests/intake',intakeBody,ids.manager,intakeKey);
    assert.equal(retry.status,200,JSON.stringify(retry));assert.equal(retry.data.id,order.id);
    assert.equal(Number((await query('SELECT count(*) c FROM customers')).rows[0].c),1);
    assert.equal(Number((await query('SELECT count(*) c FROM equipment')).rows[0].c),1);
    assert.equal(Number((await query('SELECT count(*) c FROM requests')).rows[0].c),1);

    // OWNER: records the mentorship relation before the trainee joins any order.
    r=await call('directory','PUT',`/api/v1/trainees/${ids.trainee}/mentor`,{mentor_id:ids.engineer},ids.owner);assert.ok([200,201].includes(r.status),JSON.stringify(r));

    // SUPERVISOR: dispatches the engineer and prepares one zero-sale-price consumable so parts history is auditable without changing the approved customer price.
    r=await call('index2','PATCH',`/api/v1/requests/${order.id}/schedule`,{engineer_id:ids.engineer,scheduled_at:new Date(Date.now()+3600000).toISOString(),visit_type:'FIELD'},ids.supervisor);
    assert.equal(r.status,200,JSON.stringify(r));
    let wf=await call('workflow','GET',`/api/v1/requests/${order.id}/workflow`,undefined,ids.supervisor);assert.equal(wf.status,200,JSON.stringify(wf));
    if(wf.data.status==='NEW'){
      r=await call('workflow','POST',`/api/v1/requests/${order.id}/workflow`,{event:'ASSIGN'},ids.supervisor);assert.equal(r.status,200,JSON.stringify(r));
    }

    // OWNER: only after the mentor is the order engineer, adds the trainee to that order.
    r=await call('directory','POST',`/api/v1/requests/${order.id}/participants`,{user_id:ids.trainee},ids.owner);assert.equal(r.status,201,JSON.stringify(r));
    r=await call('warehouse','POST','/api/v1/items',{name:'A32 сервисный расходник',sku:'A32-CONSUMABLE',branch_id:s.branch,purchase_price:500,sale_price:0,min_quantity:0},ids.owner);
    assert.equal(r.status,201,JSON.stringify(r));const item=r.data;
    r=await call('warehouse','POST',`/api/v1/items/${item.id}/receive`,{quantity:2,purchase_price:500,comment:'Приход для A32'},ids.owner);assert.equal(r.status,200,JSON.stringify(r));
    r=await call('procurement','POST','/api/v1/reservations',{item_id:item.id,request_id:order.id,quantity:1},ids.supervisor);assert.equal(r.status,201,JSON.stringify(r));

    // TRAINEE: contributes append-only evidence and a note, but does not perform technical or financial mutations.
    r=await call('index2','POST',`/api/v1/requests/${order.id}/notes`,{text:'Стажёр зафиксировал исходное состояние техники'},ids.trainee);assert.equal(r.status,201,JSON.stringify(r));
    r=await call('documents','POST',`/api/v1/requests/${order.id}/files`,{name:'a32-before.png',kind:'PHOTO_BEFORE',data:png},ids.trainee);assert.equal(r.status,201,JSON.stringify(r));

    // ENGINEER: accepts the assigned job, travels, diagnoses and creates the approved repair estimate.
    for(const event of ['ACCEPT','DEPART','ARRIVE']){
      r=await call('workflow','POST',`/api/v1/requests/${order.id}/workflow`,{event},ids.engineer);assert.equal(r.status,200,`${event}: ${JSON.stringify(r)}`);
    }
    r=await call('index2','POST',`/api/v1/requests/${order.id}/diagnosis`,{diagnosis:'Засор сливного тракта, требуется обслуживание'},ids.engineer);assert.equal(r.status,200,JSON.stringify(r));assert.equal(r.data.status,'APPROVAL_REQUIRED');
    // Technical roles cannot set accounting cost on work lines; direct cost comes from the installed stock item below.
    r=await call('index2','POST',`/api/v1/requests/${order.id}/works`,{name:'Очистка сливного тракта',qty:1,unit_price:15000},ids.engineer);assert.equal(r.status,201,JSON.stringify(r));

    // Client approval is recorded through the public approval API, not by rewriting the order.
    r=await call('approvals','POST',`/api/v1/approvals/request/${order.id}`,{expires_days:1},ids.engineer);assert.equal(r.status,200,JSON.stringify(r));const approval=r.data;
    assert.match(approval.token,/^v2\./);
    assert.equal((await query('SELECT token FROM customer_approvals WHERE id=$1',[approval.id])).rows[0].token,null);
    r=await call('approvals','POST',`/public/approvals/${approval.token}/respond`,{decision:'APPROVED',comment:'Согласовано'},null);assert.equal(r.status,200,JSON.stringify(r));
    r=await call('workflow','POST',`/api/v1/requests/${order.id}/workflow`,{event:'START_REPAIR'},ids.engineer);assert.equal(r.status,200,JSON.stringify(r));

    // ENGINEER: completes repair, the reserved consumable is posted atomically, photo and test are recorded.
    r=await call('completion','POST',`/api/v1/requests/${order.id}/repair-done`,{repair_result:'Сливной тракт очищен, расходник установлен'},ids.engineer);assert.equal(r.status,200,JSON.stringify(r));
    assert.equal(r.data.parts_installed,1);
    r=await call('completion','POST',`/api/v1/requests/${order.id}/test`,{test_result:'No after-photo'},ids.engineer);
    assert.equal(r.status,409);assert.equal(r.error?.code,'PHOTO_REQUIRED');
    r=await call('completion','POST',`/api/v1/requests/${order.id}/payment`,{amount:'15000',account_id:cash.id},ids.accountant);
    assert.equal(r.status,409,'payment must wait for functional testing');

    r=await call('documents','POST',`/api/v1/requests/${order.id}/files`,{name:'a32-after.png',kind:'PHOTO_AFTER',data:png},ids.engineer);assert.equal(r.status,201,JSON.stringify(r));
    r=await call('completion','POST',`/api/v1/requests/${order.id}/test`,{test_result:'Три цикла слива пройдены'},ids.engineer);assert.equal(r.status,200,JSON.stringify(r));

    // Account safety: even on a paid, assigned job the engineer cannot collect cash.
    r=await call('completion','POST',`/api/v1/requests/${order.id}/payment`,{amount:'15000',account_id:cash.id,reference:'A32-ENGINEER-DENIED'},ids.engineer);
    assert.equal(r.status,403,'engineer must not post a payment');
    assert.equal(Number((await query('SELECT paid FROM requests WHERE id=$1',[order.id])).rows[0].paid),0,'denied payment mutated request');
    assert.equal(Number((await query('SELECT count(*) c FROM payments WHERE request_id=$1',[order.id])).rows[0].c),0,'denied payment created a receipt');
    r=await call('completion','POST',`/api/v1/requests/${order.id}/payment`,{amount:'15000',account_id:cash.id},ids.supervisor);
    assert.equal(r.status,403,'supervisor default permissions exclude receiving payments');


    // ACCOUNTANT: receives the exact approved amount to the real branch cash account.
    const beforePay=(await query('SELECT total,paid FROM requests WHERE id=$1',[order.id])).rows[0];
    assert.equal(Number(beforePay.total),15000);assert.equal(Number(beforePay.paid),0);
    // Overpayment must be rejected without any payment/ledger entry.
    r=await call('completion','POST',`/api/v1/requests/${order.id}/payment`,{amount:'15001',account_id:cash.id,reference:'A32-OVERPAY-REJECT'},ids.accountant);
    assert.equal(r.status,409,'overpayment must be rejected');
    assert.equal(Number((await query('SELECT paid FROM requests WHERE id=$1',[order.id])).rows[0].paid),0,'overpayment changed paid balance');
    assert.equal(Number((await query("SELECT count(*) c FROM finance_transactions WHERE account_id=$1 AND kind='PAYMENT'",[cash.id])).rows[0].c),0,'overpayment made a ledger movement');

    const paymentPayload={amount:'15000',account_id:cash.id,reference:'A32-RECEIPT-1'};
    const samePaymentKey={'idempotency-key':'a32-exact-approved-payment'};
    r=await call('completion','POST',`/api/v1/requests/${order.id}/payment`,paymentPayload,ids.accountant,samePaymentKey);
    assert.equal(r.status,200,JSON.stringify(r));assert.equal(r.data.fully_paid,true);
    // A browser retry/duplicate click with the same key must replay, not charge twice.
    r=await call('completion','POST',`/api/v1/requests/${order.id}/payment`,paymentPayload,ids.accountant,samePaymentKey);
    assert.equal(r.status,200,'idempotent payment replay failed');assert.equal(Number(r.data.paid),15000);
    r=await call('completion','POST',`/api/v1/requests/${order.id}/payment`,{...paymentPayload,amount:'14000'},ids.accountant,samePaymentKey);
    assert.equal(r.status,409,'reusing a payment key with altered amount must be rejected');

    // Full payment must not bypass signed handover.
    r=await call('completion','POST',`/api/v1/requests/${order.id}/close`,{},ids.manager);
    assert.equal(r.status,409);assert.equal(r.error?.code,'CLIENT_SIGNATURE_REQUIRED');
    assert.equal((await query('SELECT status FROM requests WHERE id=$1',[order.id])).rows[0].status,'PAYMENT_REQUIRED');
    r=await call('documents','POST',`/api/v1/requests/${order.id}/signatures`,{signer_type:'CLIENT',signer_name:'A32 Клиент',signature_data:png},ids.manager);
    assert.equal(r.status,201,JSON.stringify(r));

    // MANAGER: closes through the completion procedure; direct status rewrite is never used.
    r=await call('completion','POST',`/api/v1/requests/${order.id}/close`,{},ids.manager);assert.equal(r.status,200,JSON.stringify(r));assert.equal(r.data.status,'CLOSED');

    // OWNER end-of-day control: money, parts, documents, final state and role-attributed history all agree.
    const final=(await query('SELECT status,total,paid,direct_cost,closed_at,warranty_until FROM requests WHERE id=$1',[order.id])).rows[0];
    assert.equal(final.status,'CLOSED');assert.equal(Number(final.total),15000);assert.equal(Number(final.paid),15000);assert.equal(Number(final.direct_cost),500);assert.ok(final.closed_at);assert.ok(final.warranty_until);
    assert.equal(Number((await query("SELECT count(*) c FROM finance_transactions WHERE account_id=$1 AND kind='PAYMENT' AND amount=15000",[cash.id])).rows[0].c),1);
    assert.equal(Number((await query('SELECT balance FROM finance_account_balances WHERE id=$1',[cash.id])).rows[0].balance),15000);
    assert.equal(Number((await query("SELECT count(*) c FROM parts WHERE request_id=$1 AND status='INSTALLED'",[order.id])).rows[0].c),1);
    assert.equal(Number((await query("SELECT count(*) c FROM warehouse_movements WHERE request_id=$1 AND movement_type='INSTALL'",[order.id])).rows[0].c),1);
    assert.equal(Number((await query('SELECT quantity FROM warehouse_items WHERE id=$1',[item.id])).rows[0].quantity),1,'warehouse quantity was not reduced exactly once');
    assert.equal(Number((await query('SELECT count(*) c FROM generated_documents WHERE request_id=$1',[order.id])).rows[0].c),2);
    assert.equal(Number((await query("SELECT count(*) c FROM request_files WHERE request_id=$1 AND kind='PHOTO_AFTER'",[order.id])).rows[0].c),1);
    assert.equal(Number((await query("SELECT count(*) c FROM request_signatures WHERE request_id=$1 AND signer_type='CLIENT'",[order.id])).rows[0].c),1);
    const actors=(await query('SELECT DISTINCT user_id FROM request_history WHERE request_id=$1 AND user_id IS NOT NULL',[order.id])).rows.map(x=>Number(x.user_id));
    for(const id of Object.values(ids))assert.ok(actors.includes(id),`role user ${id} did not leave request history`);
    assert.equal(Number((await query("SELECT count(*) c FROM finance_transactions WHERE cash_shift_id=$1 AND kind='PAYMENT'",[shift.id])).rows[0].c),1);
    // Reconciliation blocks an unexplained shortage at both HTTP and database layers.
    r=await call('cash','POST',`/api/v1/shifts/${shift.id}/close`,{actual_closing_balance:14900},ids.accountant);
    assert.equal(r.status,422);assert.equal(r.error?.code,'VARIANCE_NOTE_REQUIRED');
    assert.equal((await query('SELECT status FROM finance_cash_shifts WHERE id=$1',[shift.id])).rows[0].status,'OPEN');
    await assert.rejects(query("UPDATE finance_cash_shifts SET status='CLOSED',expected_closing_balance=15000,actual_closing_balance=14900,closed_by=$1 WHERE id=$2",[ids.accountant,shift.id]),error=>error.code==='P2400');
    r=await call('cash','POST',`/api/v1/shifts/${shift.id}/close`,{actual_closing_balance:15000},ids.accountant);
    assert.equal(r.status,200,JSON.stringify(r));assert.equal(Number(r.data.variance),0);
    r=await call('cash','POST',`/api/v1/accounts/${cash.id}/open`,{actual_opening_balance:15000},ids.owner);assert.equal(r.status,201,JSON.stringify(r));
    const discrepancyShift=r.data.id;
    r=await call('cash','POST',`/api/v1/shifts/${discrepancyShift}/close`,{actual_closing_balance:14900,note:'Synthetic documented shortage for reconciliation'},ids.accountant);
    assert.equal(r.status,200,JSON.stringify(r));assert.equal(Number(r.data.variance),-100);
    assert.equal(Number((await query('SELECT balance FROM finance_account_balances WHERE id=$1',[cash.id])).rows[0].balance),15000,'reconciliation must not fabricate cash adjustments');
    assert.ok((await query("SELECT id FROM tasks WHERE title LIKE 'Сверить расхождение кассы%' AND assigned_to=$1",[ids.supervisor])).rows.length);
    r=await call('finance','GET','/api/v1/audit-view',undefined,ids.owner);assert.equal(r.status,200,JSON.stringify(r));
  }finally{await s.close();}
});
