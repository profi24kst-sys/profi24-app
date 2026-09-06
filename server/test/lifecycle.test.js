import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire,builtinModules} from 'node:module';
import {pathToFileURL,fileURLToPath} from 'node:url';
import path from 'node:path';
import {PGlite} from '@electric-sql/pglite';
import {migrateCore} from '../src/migrate.js';

const root=fileURLToPath(new URL('../src/',import.meta.url));
const require=createRequire(import.meta.url);

async function setup(){
  const db=await PGlite.create();
  const query=(sql,params=[])=>params.length?db.query(sql,params):db.exec(sql).then(r=>r.at(-1));
  let queue=Promise.resolve();
  const pool={query,connect:async()=>{const prior=queue;let release;queue=new Promise(r=>{release=r});await prior;return {query,release}},end:async()=>{}};
  globalThis.__lifecycleTestPool=pool;
  const apps=[];
  async function load(name){
    let src=await readFile(path.join(root,name+'.js'),'utf8');
    src=src.replace(/import pg from\s*['"]pg['"];?/g,'const pg={Pool:class {constructor(){return globalThis.__lifecycleTestPool}}};');
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
  await query(`INSERT INTO users(name,email,password_hash,role) VALUES
    ('Owner LC','lc-owner@test.invalid','unused','OWNER'),
    ('Supervisor LC','lc-supervisor@test.invalid','unused','SUPERVISOR'),
    ('Manager LC','lc-manager@test.invalid','unused','MANAGER'),
    ('Engineer LC','lc-engineer@test.invalid','unused','ENGINEER'),
    ('Trainee LC','lc-trainee@test.invalid','unused','TRAINEE'),
    ('Accountant LC','lc-accountant@test.invalid','unused','ACCOUNTANT')`);
  await query("INSERT INTO customers(name,phone) VALUES('Lifecycle Client','702')");
  const order=(await query("INSERT INTO requests(number,customer_id,manager_id,engineer_id,branch_id,status,complaint,total,sla_deadline) VALUES('LC-ORDER',1,3,4,$1,'REPAIR','Lifecycle',1000,now()+interval '1 hour') RETURNING id,sla_deadline",[branch])).rows[0];
  await query('INSERT INTO user_mentors(trainee_id,mentor_id,assigned_by) VALUES(5,4,1)');
  await query("INSERT INTO request_participants(request_id,user_id,participant_role,mentor_id,added_by) VALUES($1,5,'TRAINEE',4,1)",[order.id]);
  const services={lifecycle:await load('order-lifecycle'),index2:await load('index2')};
  const roles={1:'OWNER',2:'SUPERVISOR',3:'MANAGER',4:'ENGINEER',5:'TRAINEE',6:'ACCOUNTANT'};
  const tokens=Object.fromEntries(Object.entries(roles).map(([id,role])=>[id,services.lifecycle.jwt.sign({id:Number(id),role})]));
  let seq=0;
  async function call(service,method,url,payload,user=1){
    const r=await services[service].inject({method,url,payload,headers:{authorization:'Bearer '+tokens[user],'idempotency-key':'lifecycle-'+String(++seq).padStart(12,'0')}});
    let body;try{body=r.json()}catch{body={raw:r.body}}
    return{status:r.statusCode,...body};
  }
  return{db,pool,query,services,branch,order,call,close:async()=>{for(const app of apps)await app.close();await db.close();delete globalThis.__lifecycleTestPool;}};
}

test('Stage C lifecycle: паузы SLA, повторные визиты и гарантийный rework документированы',async t=>{
  const s=await setup();
  try{
    let holdId;
    await t.test('MANAGER ставит hold, SLA останавливается, ENGINEER/TRAINEE не могут ставить паузу',async()=>{
      const before=new Date(s.order.sla_deadline).getTime();assert.ok(Number.isFinite(before));
      assert.equal((await s.call('lifecycle','POST',`/api/v1/requests/${s.order.id}/holds`,{hold_type:'WAITING_PART',reason:'Ожидаем поставку детали'},4)).status,403);
      assert.equal((await s.call('lifecycle','POST',`/api/v1/requests/${s.order.id}/holds`,{hold_type:'WAITING_PART',reason:'Ожидаем поставку детали'},5)).status,403);
      const hold=await s.call('lifecycle','POST',`/api/v1/requests/${s.order.id}/holds`,{hold_type:'WAITING_PART',reason:'Ожидаем поставку детали',responsible_id:3,expected_until:new Date(Date.now()+86400000).toISOString()},3);
      assert.equal(hold.status,201,JSON.stringify(hold));holdId=hold.data.id;
      assert.equal((await s.query('SELECT sla_deadline FROM requests WHERE id=$1',[s.order.id])).rows[0].sla_deadline,null);
      assert.equal((await s.call('lifecycle','POST',`/api/v1/requests/${s.order.id}/holds`,{hold_type:'WAITING_CUSTOMER',reason:'Ещё одна пауза'},3)).status,409);
    });

    await t.test('активный hold блокирует ремонт, но комментарии остаются append-only',async()=>{
      const blocked=await s.call('index2','POST',`/api/v1/requests/${s.order.id}/diagnosis`,{diagnosis:'Нельзя во время паузы'},4);
      assert.equal(blocked.status,409,JSON.stringify(blocked));assert.equal(blocked.error.code,'ORDER_ON_HOLD');
      assert.equal((await s.call('index2','POST',`/api/v1/requests/${s.order.id}/notes`,{text:'Деталь заказана, ждём поставщика'},4)).status,201);
    });

    await t.test('SUPERVISOR возобновляет заказ и SLA переносится на длительность паузы',async()=>{
      const resumed=await s.call('lifecycle','POST',`/api/v1/requests/${s.order.id}/holds/${holdId}/resume`,{resolution:'Деталь поступила на склад'},2);
      assert.equal(resumed.status,200,JSON.stringify(resumed));assert.ok(resumed.data.resumed_at);
      const deadline=(await s.query('SELECT sla_deadline FROM requests WHERE id=$1',[s.order.id])).rows[0].sla_deadline;
      assert.ok(deadline);assert.ok(new Date(deadline).getTime()>=new Date(s.order.sla_deadline).getTime());
      assert.equal((await s.call('index2','POST',`/api/v1/requests/${s.order.id}/diagnosis`,{diagnosis:'После паузы разрешено'},4)).status,200);
      await assert.rejects(s.query("UPDATE request_holds SET reason='Переписать историю' WHERE id=$1",[holdId]),e=>e.code==='P2401');
      await assert.rejects(s.query('DELETE FROM request_holds WHERE id=$1',[holdId]),e=>e.code==='P2401');
    });

    await t.test('повторный визит имеет номер попытки и неизменяемый исход',async()=>{
      const visit=await s.call('lifecycle','POST',`/api/v1/requests/${s.order.id}/visits`,{scheduled_at:new Date(Date.now()+3600000).toISOString(),visit_type:'FIELD'},3);
      assert.equal(visit.status,201,JSON.stringify(visit));assert.equal(visit.data.attempt_no,1);
      const outcome=await s.call('lifecycle','POST',`/api/v1/requests/${s.order.id}/visits/${visit.data.id}/outcome`,{outcome:'NO_ACCESS',reason:'Клиент отсутствовал по адресу'},4);
      assert.equal(outcome.status,200,JSON.stringify(outcome));assert.equal(outcome.data.outcome,'NO_ACCESS');
      assert.equal((await s.query('SELECT scheduled_at FROM requests WHERE id=$1',[s.order.id])).rows[0].scheduled_at,null);
      assert.equal((await s.call('lifecycle','POST',`/api/v1/requests/${s.order.id}/visits/${visit.data.id}/outcome`,{outcome:'COMPLETED'},4)).status,409);
      await assert.rejects(s.query("UPDATE request_visit_attempts SET reason='Переписать' WHERE id=$1",[visit.data.id]),e=>e.code==='P2401');
    });

    await t.test('гарантийный rework создаёт новый заказ и не изменяет закрытый оригинал',async()=>{
      const parent=(await s.query("INSERT INTO requests(number,customer_id,manager_id,engineer_id,branch_id,status,complaint,total,paid,closed_at,warranty_until) VALUES('LC-CLOSED',1,3,4,$1,'CLOSED','Closed',1500,1500,now(),CURRENT_DATE+90) RETURNING id",[s.branch])).rows[0];
      await s.query(`CREATE TABLE IF NOT EXISTS warranty_cards(id BIGSERIAL PRIMARY KEY,request_id INT UNIQUE NOT NULL REFERENCES requests(id),token TEXT UNIQUE NOT NULL,warranty_days INT NOT NULL DEFAULT 90,issued_at TIMESTAMPTZ NOT NULL DEFAULT now(),warranty_until DATE NOT NULL,created_at TIMESTAMPTZ DEFAULT now())`);
      await s.query("INSERT INTO warranty_cards(request_id,token,warranty_until) VALUES($1,'lc-warranty-token',CURRENT_DATE+90)",[parent.id]);
      const rework=await s.call('lifecycle','POST',`/api/v1/requests/${parent.id}/rework`,{link_type:'WARRANTY_REWORK',reason:'Неисправность повторилась после ремонта'},3);
      assert.equal(rework.status,201,JSON.stringify(rework));
      assert.equal(Number(rework.data.request.original_request_id),Number(parent.id));assert.equal(Number(rework.data.request.branch_id),Number(s.branch));
      assert.equal((await s.query('SELECT status FROM requests WHERE id=$1',[parent.id])).rows[0].status,'CLOSED');
      assert.equal((await s.call('lifecycle','POST',`/api/v1/requests/${parent.id}/rework`,{link_type:'WARRANTY_REWORK',reason:'Дубль'},3)).status,409);
      await assert.rejects(s.query("UPDATE request_order_links SET reason='Переписать связь' WHERE child_request_id=$1",[rework.data.request.id]),e=>e.code==='P2401');
    });
  }finally{await s.close();}
});
