import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire,builtinModules} from 'node:module';
import {fileURLToPath,pathToFileURL} from 'node:url';
import path from 'node:path';
import {PGlite} from '@electric-sql/pglite';
import {migrateCore} from '../src/migrate.js';

const root=fileURLToPath(new URL('../src/',import.meta.url));
const require=createRequire(import.meta.url);

async function setup(){
  const db=await PGlite.create();
  const query=(sql,params=[])=>params.length?db.query(sql,params):db.exec(sql).then(r=>r.at(-1));
  let queue=Promise.resolve();
  const pool={query,connect:async()=>{const prior=queue;let release;queue=new Promise(r=>{release=r});await prior;return{query,release}},end:async()=>{}};
  globalThis.__lifecycleTestPool=pool;
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
  const baseOrder=(await query("INSERT INTO requests(number,customer_id,manager_id,engineer_id,branch_id,status,complaint,total,sla_deadline) VALUES('LC-ORDER',1,3,4,$1,'REPAIR','Lifecycle',1000,now()+interval '1 hour') RETURNING *",[branch])).rows[0];
  await query('INSERT INTO user_mentors(trainee_id,mentor_id,assigned_by) VALUES(5,4,1)');
  await query("INSERT INTO request_participants(request_id,user_id,participant_role,mentor_id,added_by) VALUES($1,5,'TRAINEE',4,1)",[baseOrder.id]);

  let src=await readFile(path.join(root,'order-lifecycle-v2.js'),'utf8');
  src=src.replace(/import pg from\s*['"]pg['"];?/g,'const pg={Pool:class {constructor(){return globalThis.__lifecycleTestPool}}};');
  src=src.replace(/\bfrom\s*(['"])([^'"]+)\1/g,(m,quote,spec)=>{
    if(spec.startsWith('node:')||builtinModules.includes(spec))return m;
    return 'from '+JSON.stringify(pathToFileURL(spec.startsWith('.')?path.resolve(root,spec):require.resolve(spec)).href);
  });
  src=src.replace(/logger:\s*true/g,'logger:false').replaceAll('app.listen(','testListen(').replaceAll('process.on(','testOn(');
  src='const testListen=async()=>{};const testOn=()=>{};\n'+src+'\nexport {app};';
  const {app}=await import('data:text/javascript;base64,'+Buffer.from(src).toString('base64'));
  await app.ready();
  const roles={1:'OWNER',2:'SUPERVISOR',3:'MANAGER',4:'ENGINEER',5:'TRAINEE',6:'ACCOUNTANT'};
  const tokens=Object.fromEntries(Object.entries(roles).map(([id,role])=>[id,app.jwt.sign({id:Number(id),role})]));
  let operationSeq=0;
  const call=async(method,url,payload,user=1,key=null)=>{
    const operationKey=key||'lifecycle-operation-'+String(++operationSeq).padStart(8,'0');
    const r=await app.inject({method,url,payload,headers:{authorization:'Bearer '+tokens[user],'idempotency-key':operationKey}});
    let body={};try{body=r.json()}catch{}
    return{status:r.statusCode,...body};
  };
  let seq=0;
  const order=async({status='REPAIR',closed=false,engineer=4}={})=>(await query(`INSERT INTO requests(number,customer_id,manager_id,engineer_id,branch_id,status,complaint,total,sla_deadline,closed_at)
    VALUES($1,1,3,$2,$3,$4,'Lifecycle test',1000,now()+interval '1 hour',$5) RETURNING *`,['LC-X-'+(++seq),engineer,branch,status,closed?new Date().toISOString():null])).rows[0];
  return{db,pool,query,app,branch,baseOrder,call,order,close:async()=>{await app.close();await db.close();delete globalThis.__lifecycleTestPool;}};
}

test('Stage C lifecycle: паузы SLA, повторные визиты, rework и возврат без ремонта документированы',async t=>{
  const s=await setup();
  try{
    await t.test('офисная пауза останавливает SLA; бухгалтер и стажёр только читают lifecycle',async()=>{
      const before=new Date(s.baseOrder.sla_deadline).getTime();
      assert.equal((await s.call('GET',`/api/v1/requests/${s.baseOrder.id}/lifecycle`,undefined,6)).status,200);
      assert.equal((await s.call('POST',`/api/v1/requests/${s.baseOrder.id}/holds`,{hold_type:'WAITING_CUSTOMER',reason:'Ждём клиента'},6)).status,403);
      assert.equal((await s.call('POST',`/api/v1/requests/${s.baseOrder.id}/holds`,{hold_type:'WAITING_CUSTOMER',reason:'Ждём клиента'},5)).status,403);
      const hold=await s.call('POST',`/api/v1/requests/${s.baseOrder.id}/holds`,{hold_type:'WAITING_CUSTOMER',reason:'Ждём ответа клиента',responsible_id:3},3);
      assert.equal(hold.status,201,JSON.stringify(hold));
      assert.equal((await s.query('SELECT sla_deadline FROM requests WHERE id=$1',[s.baseOrder.id])).rows[0].sla_deadline,null);
      assert.equal((await s.call('POST',`/api/v1/requests/${s.baseOrder.id}/holds`,{hold_type:'OTHER',reason:'Вторая пауза'},3)).status,409);
      const resumed=await s.call('POST',`/api/v1/requests/${s.baseOrder.id}/holds/${hold.data.id}/resume`,{resolution:'Клиент подтвердил продолжение'},2);
      assert.equal(resumed.status,200,JSON.stringify(resumed));
      assert.ok(new Date(resumed.data.new_sla_deadline).getTime()>=before);
      await assert.rejects(s.query("UPDATE request_holds SET reason='Переписать историю' WHERE id=$1",[hold.data.id]),e=>e.code==='P2401');
    });

    await t.test('инженер ставит только технический hold; repeat-required автоматически создаёт паузу',async()=>{
      const order=await s.order();
      assert.equal((await s.call('POST',`/api/v1/requests/${order.id}/holds`,{hold_type:'WAITING_CUSTOMER',reason:'Нельзя инженеру'},4)).status,403);
      const technical=await s.call('POST',`/api/v1/requests/${order.id}/holds`,{hold_type:'REPEAT_VISIT',reason:'Нужен повторный выезд'},4);
      assert.equal(technical.status,201,JSON.stringify(technical));
      assert.equal(Number(technical.data.responsible_id),4);
      assert.equal((await s.call('POST',`/api/v1/requests/${order.id}/visits`,{scheduled_at:new Date(Date.now()+3600000).toISOString()},3)).status,409);
      assert.equal((await s.call('POST',`/api/v1/requests/${order.id}/holds/${technical.data.id}/resume`,{resolution:'Повторный выезд согласован'},3)).status,200);
      const visit=await s.call('POST',`/api/v1/requests/${order.id}/visits`,{scheduled_at:new Date(Date.now()+3600000).toISOString(),visit_type:'FIELD'},3);
      assert.equal(visit.status,201,JSON.stringify(visit));
      const outcome=await s.call('POST',`/api/v1/requests/${order.id}/visits/${visit.data.id}/outcome`,{outcome:'REPEAT_REQUIRED',reason:'Нужна дополнительная деталь и ещё один визит'},4);
      assert.equal(outcome.status,200,JSON.stringify(outcome));
      assert.equal(outcome.data.repeat_hold?.hold_type,'REPEAT_VISIT');
      assert.equal((await s.query('SELECT sla_deadline FROM requests WHERE id=$1',[order.id])).rows[0].sla_deadline,null);
      await assert.rejects(s.query("UPDATE request_visit_attempts SET reason='Подмена результата' WHERE id=$1",[visit.data.id]),e=>e.code==='P2401');
    });

    await t.test('rework создаёт дочерний заказ, не переписывая закрытый оригинал',async()=>{
      const parent=await s.order({status:'CLOSED',closed:true});
      const rework=await s.call('POST',`/api/v1/requests/${parent.id}/rework`,{link_type:'REWORK',reason:'Повторная неисправность после ремонта'},3);
      assert.equal(rework.status,201,JSON.stringify(rework));
      assert.equal(Number(rework.data.request.original_request_id),Number(parent.id));
      assert.equal(Number(rework.data.request.branch_id),Number(s.branch));
      assert.equal((await s.query('SELECT status FROM requests WHERE id=$1',[parent.id])).rows[0].status,'CLOSED');
      assert.equal((await s.call('POST',`/api/v1/requests/${parent.id}/rework`,{link_type:'REWORK',reason:'Дубликат'},3)).status,409);
      assert.equal((await s.call('POST',`/api/v1/requests/${parent.id}/rework`,{link_type:'WARRANTY_REWORK',reason:'Гарантийная переделка'},3)).status,403);
      await assert.rejects(s.query("UPDATE request_order_links SET reason='Переписать связь' WHERE child_request_id=$1",[rework.data.request.id]),e=>e.code==='P2401');
    });

    await t.test('возврат без ремонта доступен только OWNER и создаёт отдельный неизменяемый документ',async()=>{
      const order=await s.order();
      const body={reason:'Ремонт технически нецелесообразен',document_reference:'Акт возврата №1',handover_reference:'Подпись клиента №1'};
      assert.equal((await s.call('POST',`/api/v1/requests/${order.id}/return-without-repair`,body,3)).status,403,'manager cannot finalize');
      const returned=await s.call('POST',`/api/v1/requests/${order.id}/return-without-repair`,body,1,'lifecycle-return-00000001');
      assert.equal(returned.status,201,JSON.stringify(returned));
      assert.equal(returned.data.request.status,'CANCELLED');
      assert.equal(returned.data.document.handover_reference,body.handover_reference);
      const history=(await s.query("SELECT action FROM request_history WHERE request_id=$1 ORDER BY id",[order.id])).rows.map(x=>x.action);
      assert.ok(history.includes('REQUEST_CANCELLED'));assert.ok(history.includes('RETURNED_WITHOUT_REPAIR'));
      await assert.rejects(s.query("UPDATE request_returns_without_repair SET reason='Переписать документ' WHERE request_id=$1",[order.id]),e=>e.code==='P2401');
      await assert.rejects(s.query('DELETE FROM request_returns_without_repair WHERE request_id=$1',[order.id]),e=>e.code==='P2401');
    });
  }finally{await s.close();}
});
