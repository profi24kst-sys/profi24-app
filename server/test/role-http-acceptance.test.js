import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire,builtinModules} from 'node:module';
import {pathToFileURL,fileURLToPath} from 'node:url';
import path from 'node:path';
import {PGlite} from '@electric-sql/pglite';
import {migrateCore} from '../src/migrate.js';
import {buildFinanceApp} from '../src/finance/app.js';

const root=fileURLToPath(new URL('../src/',import.meta.url));
const require=createRequire(import.meta.url);

async function setup(){
  const db=await PGlite.create();
  const query=(sql,params=[])=>params.length?db.query(sql,params):db.exec(sql).then(r=>r.at(-1));
  let queue=Promise.resolve();
  const pool={query,connect:async()=>{const prior=queue;let release;queue=new Promise(r=>{release=r});await prior;return {query,release}},end:async()=>{}};
  globalThis.__roleAcceptancePool=pool;
  const apps=[];
  async function load(name){
    let src=await readFile(path.join(root,name+'.js'),'utf8');
    src=src.replace(/import pg from\s*['"]pg['"];?/g,'const pg={Pool:class {constructor(){return globalThis.__roleAcceptancePool}}};');
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
  await query(`INSERT INTO users(name,email,password_hash,role) VALUES
    ('Owner','owner-http@test.invalid','unused','OWNER'),
    ('Supervisor','supervisor-http@test.invalid','unused','SUPERVISOR'),
    ('Accountant','accountant-http@test.invalid','unused','ACCOUNTANT'),
    ('Manager','manager-http@test.invalid','unused','MANAGER'),
    ('Engineer','engineer-http@test.invalid','unused','ENGINEER'),
    ('Trainee','trainee-http@test.invalid','unused','TRAINEE'),
    ('Other engineer','other-engineer-http@test.invalid','unused','ENGINEER')`);
  await query("INSERT INTO customers(name,phone) VALUES('HTTP Client','70000000001')");
  const kst=(await query("SELECT id FROM branches WHERE code='KST'")).rows[0].id;
  const other=(await query("INSERT INTO branches(code,name,address) VALUES('HTTP2','HTTP второй филиал','Тестовый адрес') RETURNING id")).rows[0].id;
  await query('UPDATE users SET primary_branch_id=$1 WHERE id=7',[other]);
  const ownOrder=(await query("INSERT INTO requests(number,customer_id,manager_id,engineer_id,branch_id,status,complaint,total) VALUES('HTTP-KST',1,4,5,$1,'REPAIR','Role acceptance',1000) RETURNING id",[kst])).rows[0].id;
  const foreignOrder=(await query("INSERT INTO requests(number,customer_id,engineer_id,branch_id,status,complaint,total) VALUES('HTTP-OTHER',1,7,$1,'REPAIR','Other branch',800) RETURNING id",[other])).rows[0].id;
  await query('INSERT INTO user_mentors(trainee_id,mentor_id,assigned_by) VALUES(6,5,1)');
  await query("INSERT INTO request_participants(request_id,user_id,participant_role,mentor_id,added_by) VALUES($1,6,'TRAINEE',5,1)",[ownOrder]);

  const services={};
  services.index2=await load('index2');
  services.warehouse=await load('warehouse');
  services.procurement=await load('procurement');
  services.finance=await buildFinanceApp(pool,{logger:false});apps.push(services.finance);
  const roles={1:'OWNER',2:'SUPERVISOR',3:'ACCOUNTANT',4:'MANAGER',5:'ENGINEER',6:'TRAINEE',7:'ENGINEER'};
  const tokens=Object.fromEntries(Object.entries(roles).map(([id,role])=>[id,services.index2.jwt.sign({id:Number(id),role})]));
  let seq=0;
  async function call(service,method,url,payload,user=1,key){
    const res=await services[service].inject({method,url,payload,headers:{authorization:'Bearer '+tokens[user],'idempotency-key':key||'role-http-'+String(++seq).padStart(12,'0')}});
    let body;try{body=res.json()}catch{body={raw:res.body}}
    return {status:res.statusCode,...body};
  }
  const ownerAccount=(await call('finance','POST','/api/v1/accounts',{name:'Общая касса',type:'CASH',branch_id:kst,initial_amount:'10000',initial_reason:'Открытие тестовой кассы'},1)).data;
  const managerAccount=(await call('finance','POST','/api/v1/accounts',{name:'Касса менеджера',type:'CASH',branch_id:kst,responsible_id:4,initial_amount:'5000',initial_reason:'Открытие кассы менеджера'},1)).data;
  return {db,query,pool,services,call,kst,other,ownOrder,foreignOrder,ownerAccount,managerAccount,close:async()=>{for(const app of apps)await app.close();await db.close();delete globalThis.__roleAcceptancePool;}};
}

test('HTTP acceptance: шесть ролей соблюдают границы заказов, денег, склада и закупок',async t=>{
  const s=await setup();const {call,query}=s;
  try{
    await t.test('OWNER имеет критические права, а отмена недоступна остальным',async()=>{
      assert.equal((await call('index2','GET',`/api/v1/requests/${s.foreignOrder}`,undefined,1)).status,200);
      assert.equal((await call('index2','GET',`/api/v1/requests/${s.ownOrder}/cancellation-readiness`,undefined,1)).status,200);
      assert.equal((await call('index2','GET',`/api/v1/requests/${s.ownOrder}/cancellation-readiness`,undefined,2)).status,403);
      assert.equal((await call('index2','POST',`/api/v1/requests/${s.ownOrder}/cancel`,{category:'OTHER',reason:'Проверка запрета',document_reference:'TEST-1'},3)).status,403);
    });

    await t.test('SUPERVISOR видит финансовый аудит и управляет операциями, но не корректирует деньги',async()=>{
      assert.equal((await call('finance','GET','/api/v1/accounts',undefined,2)).status,200);
      assert.equal((await call('finance','GET','/api/v1/audit-view',undefined,2)).status,200);
      assert.equal((await call('finance','POST',`/api/v1/accounts/${s.ownerAccount.id}/adjustments`,{delta:'10',reason:'Не должно пройти',document_reference:'SUP-ADJ'},2)).status,403);
      assert.equal((await call('index2','PATCH',`/api/v1/requests/${s.foreignOrder}/schedule`,{scheduled_at:'2026-09-07T10:00:00'},2)).status,200);
    });

    await t.test('ACCOUNTANT видит оба филиала, не меняет ремонт и может принять/вернуть оплату',async()=>{
      assert.equal((await call('index2','GET',`/api/v1/requests/${s.foreignOrder}`,undefined,3)).status,200);
      assert.equal((await call('index2','POST',`/api/v1/requests/${s.ownOrder}/diagnosis`,{diagnosis:'Запрещено бухгалтеру'},3)).status,403);
      const pay=await call('index2','POST',`/api/v1/requests/${s.ownOrder}/payment`,{amount:'400',account_id:s.ownerAccount.id},3);
      assert.equal(pay.status,200,JSON.stringify(pay));
      const payment=(await query("SELECT id FROM payments WHERE request_id=$1 AND kind='PAYMENT' ORDER BY id DESC LIMIT 1",[s.ownOrder])).rows[0];
      assert.ok(payment?.id);
      assert.equal((await call('index2','POST',`/api/v1/payments/${payment.id}/refund`,{amount:'400',reason:'Возврат клиенту',document_reference:'РКО-HTTP-1'},2)).status,403);
      const refund=await call('index2','POST',`/api/v1/payments/${payment.id}/refund`,{amount:'400',reason:'Возврат клиенту',document_reference:'РКО-HTTP-1'},3);
      assert.equal(refund.status,200,JSON.stringify(refund));
      assert.equal(Number((await query('SELECT paid FROM requests WHERE id=$1',[s.ownOrder])).rows[0].paid),0);
    });

    await t.test('MANAGER ограничен филиалом и собственной кассой',async()=>{
      assert.equal((await call('index2','GET',`/api/v1/requests/${s.ownOrder}`,undefined,4)).status,200);
      assert.equal((await call('index2','GET',`/api/v1/requests/${s.foreignOrder}`,undefined,4)).status,403);
      const list=await call('index2','GET','/api/v1/requests',undefined,4);
      assert.equal(list.status,200); // список проверяется отдельно на отсутствие утечки в Stage B.2 hardening
      assert.equal((await call('index2','POST',`/api/v1/requests/${s.ownOrder}/payment`,{amount:'100',account_id:s.ownerAccount.id},4)).status,403);
      assert.equal((await call('index2','POST',`/api/v1/requests/${s.ownOrder}/payment`,{amount:'100',account_id:s.managerAccount.id},4)).status,200);
      assert.equal((await call('finance','GET','/api/v1/audit-view',undefined,4)).status,403);
    });

    await t.test('ENGINEER работает только со своими заказами и не получает глобальные деньги/склад/закупки',async()=>{
      assert.equal((await call('index2','GET',`/api/v1/requests/${s.ownOrder}`,undefined,5)).status,200);
      assert.equal((await call('index2','GET',`/api/v1/requests/${s.foreignOrder}`,undefined,5)).status,403);
      assert.equal((await call('index2','POST',`/api/v1/requests/${s.ownOrder}/works`,{name:'Работа инженера',qty:1,unit_price:100},5)).status,201);
      assert.equal((await call('index2','POST',`/api/v1/requests/${s.ownOrder}/payment`,{amount:'10',account_id:s.managerAccount.id},5)).status,403);
      assert.equal((await call('warehouse','GET','/api/v1/stock',undefined,5)).status,403);
      assert.equal((await call('procurement','GET','/api/v1/suppliers',undefined,5)).status,403);
    });

    await t.test('TRAINEE только участник заказа наставника: комментарии да, работы/деньги/склад нет',async()=>{
      assert.equal((await call('index2','GET',`/api/v1/requests/${s.ownOrder}`,undefined,6)).status,200);
      assert.equal((await call('index2','GET',`/api/v1/requests/${s.foreignOrder}`,undefined,6)).status,403);
      assert.equal((await call('index2','POST',`/api/v1/requests/${s.ownOrder}/notes`,{text:'Комментарий стажёра'},6)).status,201);
      assert.equal((await call('index2','POST',`/api/v1/requests/${s.ownOrder}/works`,{name:'Запрещённая работа',qty:1,unit_price:1},6)).status,403);
      assert.equal((await call('warehouse','GET','/api/v1/stock',undefined,6)).status,403);
      assert.equal((await call('procurement','GET','/api/v1/suppliers',undefined,6)).status,403);
    });

    await t.test('Склад и закупки разделяют SUPERVISOR / ACCOUNTANT / MANAGER',async()=>{
      const item=(await call('warehouse','POST','/api/v1/items',{name:'HTTP складская позиция',branch_id:s.kst,purchase_price:100,sale_price:200},1)).data;
      assert.ok(item?.id);
      assert.equal((await call('warehouse','POST',`/api/v1/items/${item.id}/receive`,{quantity:3,purchase_price:100},1)).status,200);
      assert.equal((await call('warehouse','GET','/api/v1/stock',undefined,2)).status,200);
      assert.equal((await call('warehouse','GET','/api/v1/stock',undefined,3)).status,200);
      assert.equal((await call('warehouse','POST',`/api/v1/items/${item.id}/write-off`,{quantity:1,comment:'Управляющий оформляет списание'},3)).status,403);
      assert.equal((await call('warehouse','POST',`/api/v1/items/${item.id}/write-off`,{quantity:1,comment:'Документированное списание'},2)).status,200);
      assert.equal((await call('warehouse','POST',`/api/v1/items/${item.id}/issue`,{quantity:1,engineer_id:6},4)).status,403);
      assert.equal((await call('warehouse','POST',`/api/v1/items/${item.id}/issue`,{quantity:1,engineer_id:5},4)).status,200);
      assert.equal((await call('procurement','GET','/api/v1/suppliers',undefined,3)).status,200);
      assert.equal((await call('procurement','POST','/api/v1/suppliers',{name:'Запрещённый поставщик бухгалтера'},3)).status,403);
      assert.equal((await call('procurement','POST','/api/v1/suppliers',{name:'Поставщик управляющего'},2)).status,201);
      assert.equal((await call('procurement','POST','/api/v1/suppliers',{name:'Поставщик менеджера'},4)).status,201);
    });
  }finally{await s.close();}
});
