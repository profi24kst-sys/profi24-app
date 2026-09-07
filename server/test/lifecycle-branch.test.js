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

test('Stage C lifecycle exception center respects manager branch scope',async()=>{
  const db=await PGlite.create();
  const query=(sql,params=[])=>params.length?db.query(sql,params):db.exec(sql).then(r=>r.at(-1));
  let queue=Promise.resolve();
  const pool={query,connect:async()=>{const prior=queue;let release;queue=new Promise(r=>{release=r});await prior;return{query,release}},end:async()=>{}};
  globalThis.__lifecycleBranchPool=pool;
  let app;
  try{
    await migrateCore(pool);
    const kst=(await query("SELECT id FROM branches WHERE code='KST'")).rows[0].id;
    const other=(await query("INSERT INTO branches(code,name,timezone) VALUES('LIF2','Другой филиал','Asia/Qostanay') RETURNING id")).rows[0].id;
    await query(`INSERT INTO users(name,email,password_hash,role) VALUES
      ('Owner LB','lb-owner@test.invalid','x','OWNER'),
      ('Supervisor LB','lb-supervisor@test.invalid','x','SUPERVISOR'),
      ('Manager LB','lb-manager@test.invalid','x','MANAGER'),
      ('Engineer LB','lb-engineer@test.invalid','x','ENGINEER')`);
    await query("INSERT INTO customers(name,phone) VALUES('Local client','701'),('Foreign client','702')");
    const local=(await query("INSERT INTO requests(number,customer_id,manager_id,engineer_id,branch_id,status,complaint,sla_deadline) VALUES('LB-LOCAL',1,3,4,$1,'REPAIR','local',now()+interval '1 hour') RETURNING id",[kst])).rows[0].id;
    const foreign=(await query("INSERT INTO requests(number,customer_id,branch_id,status,complaint,sla_deadline) VALUES('LB-FOREIGN',2,$1,'REPAIR','foreign',now()+interval '1 hour') RETURNING id",[other])).rows[0].id;

    let src=await readFile(path.join(root,'order-lifecycle-v2.js'),'utf8');
    src=src.replace(/import pg from\s*['"]pg['"];?/g,'const pg={Pool:class {constructor(){return globalThis.__lifecycleBranchPool}}};');
    src=src.replace(/\bfrom\s*(['"])([^'"]+)\1/g,(m,quote,spec)=>{
      if(spec.startsWith('node:')||builtinModules.includes(spec))return m;
      return 'from '+JSON.stringify(pathToFileURL(spec.startsWith('.')?path.resolve(root,spec):require.resolve(spec)).href);
    });
    src=src.replace(/logger:\s*true/g,'logger:false').replaceAll('app.listen(','testListen(').replaceAll('process.on(','testOn(');
    src='const testListen=async()=>{};const testOn=()=>{};\n'+src+'\nexport {app};';
    ({app}=await import('data:text/javascript;base64,'+Buffer.from(src).toString('base64')));await app.ready();
    const token=(id,role)=>app.jwt.sign({id,role});let seq=0;
    const call=async(method,url,payload,id,role)=>{const r=await app.inject({method,url,payload,headers:{authorization:'Bearer '+token(id,role),'idempotency-key':'lifecycle-branch-'+String(++seq).padStart(8,'0')}});return{status:r.statusCode,...r.json()}};

    assert.equal((await call('POST',`/api/v1/requests/${local}/holds`,{hold_type:'WAITING_CUSTOMER',reason:'Ждём местного клиента'},3,'MANAGER')).status,201);
    assert.equal((await call('POST',`/api/v1/requests/${foreign}/holds`,{hold_type:'WAITING_CUSTOMER',reason:'Ждём клиента другого филиала'},1,'OWNER')).status,201);
    assert.equal((await call('GET',`/api/v1/requests/${foreign}/lifecycle`,undefined,3,'MANAGER')).status,403);

    const manager=await call('GET','/api/v1/lifecycle/exceptions',undefined,3,'MANAGER');
    assert.equal(manager.status,200,JSON.stringify(manager));
    assert.ok(manager.data.holds.some(x=>Number(x.request_id)===Number(local)));
    assert.ok(!manager.data.holds.some(x=>Number(x.request_id)===Number(foreign)));

    const supervisor=await call('GET','/api/v1/lifecycle/exceptions',undefined,2,'SUPERVISOR');
    assert.equal(supervisor.status,200,JSON.stringify(supervisor));
    assert.ok(supervisor.data.holds.some(x=>Number(x.request_id)===Number(local)));
    assert.ok(supervisor.data.holds.some(x=>Number(x.request_id)===Number(foreign)));
  }finally{
    if(app)await app.close();await db.close();delete globalThis.__lifecycleBranchPool;
  }
});
