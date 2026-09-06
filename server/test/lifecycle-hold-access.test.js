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

async function loadService(name,poolKey,apps){
  let src=await readFile(path.join(root,name+'.js'),'utf8');
  src=src.replace(/import pg from\s*['"]pg['"];?/g,`const pg={Pool:class {constructor(){return globalThis.${poolKey}}}};`);
  src=src.replace(/\bfrom\s*(['"])([^'"]+)\1/g,(m,quote,spec)=>{
    if(spec.startsWith('node:')||builtinModules.includes(spec))return m;
    return 'from '+JSON.stringify(pathToFileURL(spec.startsWith('.')?path.resolve(root,spec):require.resolve(spec)).href);
  });
  src=src.replace(/logger:\s*true/g,'logger:false').replaceAll('app.listen(','testListen(').replaceAll('process.on(','testOn(');
  src='const testListen=async()=>{};const testOn=()=>{};const setInterval=()=>0;\n'+src+'\nexport {app};';
  const {app}=await import('data:text/javascript;base64,'+Buffer.from(src).toString('base64'));await app.ready();apps.push(app);return app;
}

test('active lifecycle hold blocks repair mutations but keeps append-only evidence',async()=>{
  const db=await PGlite.create();const query=(sql,p=[])=>p.length?db.query(sql,p):db.exec(sql).then(r=>r.at(-1));
  let queue=Promise.resolve();const pool={query,connect:async()=>{const prior=queue;let release;queue=new Promise(r=>{release=r});await prior;return{query,release}},end:async()=>{}};globalThis.__lifeHoldPool=pool;const apps=[];
  try{
    await migrateCore(pool);const branch=(await query("SELECT id FROM branches WHERE code='KST'")).rows[0].id;
    await query(`INSERT INTO users(name,email,password_hash,role) VALUES ('Owner HA','ha-owner@test.invalid','x','OWNER'),('Manager HA','ha-manager@test.invalid','x','MANAGER'),('Engineer HA','ha-engineer@test.invalid','x','ENGINEER')`);
    await query("INSERT INTO customers(name,phone) VALUES('Hold client','700')");
    const order=(await query("INSERT INTO requests(number,customer_id,manager_id,engineer_id,branch_id,status,complaint,total,sla_deadline) VALUES('HA-1',1,2,3,$1,'REPAIR','hold',1000,now()+interval '1 hour') RETURNING id",[branch])).rows[0].id;
    const lifecycle=await loadService('order-lifecycle-v2','__lifeHoldPool',apps),index2=await loadService('index2','__lifeHoldPool',apps);
    const tokens={manager:lifecycle.jwt.sign({id:2,role:'MANAGER'}),engineer:index2.jwt.sign({id:3,role:'ENGINEER'})};let seq=0;
    const call=async(app,token,method,url,payload)=>{const r=await app.inject({method,url,payload,headers:{authorization:'Bearer '+token,'idempotency-key':'hold-access-'+String(++seq).padStart(8,'0')}});return{status:r.statusCode,...r.json()}};
    const hold=await call(lifecycle,tokens.manager,'POST',`/api/v1/requests/${order}/holds`,{hold_type:'WAITING_PART',reason:'Ожидаем заказанную деталь'});assert.equal(hold.status,201,JSON.stringify(hold));
    const diagnosis=await call(index2,tokens.engineer,'POST',`/api/v1/requests/${order}/diagnosis`,{diagnosis:'Не должно сохраниться'});assert.equal(diagnosis.status,409,JSON.stringify(diagnosis));assert.equal(diagnosis.error.code,'ORDER_ON_HOLD');
    const work=await call(index2,tokens.engineer,'POST',`/api/v1/requests/${order}/works`,{name:'Запрещённая работа',qty:1,unit_price:1000});assert.equal(work.status,409,JSON.stringify(work));assert.equal(work.error.code,'ORDER_ON_HOLD');
    const part=await call(index2,tokens.engineer,'POST',`/api/v1/requests/${order}/parts`,{name:'Запрещённая деталь'});assert.equal(part.status,409,JSON.stringify(part));assert.equal(part.error.code,'ORDER_ON_HOLD');
    const note=await call(index2,tokens.engineer,'POST',`/api/v1/requests/${order}/notes`,{text:'Поставщик подтвердил срок доставки'});assert.equal(note.status,201,JSON.stringify(note));
    assert.equal((await query('SELECT diagnosis FROM requests WHERE id=$1',[order])).rows[0].diagnosis,null);
    assert.equal(Number((await query('SELECT count(*) n FROM request_works WHERE request_id=$1',[order])).rows[0].n),0);
    assert.equal(Number((await query('SELECT count(*) n FROM parts WHERE request_id=$1',[order])).rows[0].n),0);
    assert.equal(Number((await query('SELECT count(*) n FROM request_notes WHERE request_id=$1',[order])).rows[0].n),1);
  }finally{for(const app of apps)await app.close();await db.close();delete globalThis.__lifeHoldPool;}
});
