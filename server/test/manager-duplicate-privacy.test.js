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

test('duplicate phone does not reveal a foreign-branch customer to MANAGER',async()=>{
  const db=await PGlite.create();
  const query=(sql,params=[])=>params.length?db.query(sql,params):db.exec(sql).then(r=>r.at(-1));
  let queue=Promise.resolve();
  const pool={query,connect:async()=>{const prior=queue;let release;queue=new Promise(r=>{release=r});await prior;return{query,release}},end:async()=>{}};
  globalThis.__duplicatePrivacyPool=pool;
  let app;
  try{
    await migrateCore(pool);
    const kst=(await query("SELECT id FROM branches WHERE code='KST'")).rows[0].id;
    const other=(await query("INSERT INTO branches(code,name) VALUES('DP2','Чужой филиал') RETURNING id")).rows[0].id;
    await query(`INSERT INTO users(name,email,password_hash,role) VALUES
      ('Owner','privacy-owner@test.invalid','unused','OWNER'),
      ('Manager','privacy-manager@test.invalid','unused','MANAGER')`);
    await query('INSERT INTO user_branches(user_id,branch_id) VALUES(2,$1) ON CONFLICT DO NOTHING',[kst]);
    await query(`INSERT INTO customers(name,phone,phone_norm) VALUES
      ('Own contact','+77010000901','77010000901'),
      ('Foreign contact','+77010000902','77010000902')`);
    await query("INSERT INTO requests(number,customer_id,branch_id,status,complaint) VALUES('DP-OWN',1,$1,'NEW','Own'),('DP-FOREIGN',2,$2,'NEW','Foreign')",[kst,other]);

    let src=await readFile(path.join(root,'index2.js'),'utf8');
    src=src.replace(/import pg from\s*['"]pg['"];?/g,'const pg={Pool:class {constructor(){return globalThis.__duplicatePrivacyPool}}};');
    src=src.replace(/\bfrom\s*(['"])([^'"]+)\1/g,(m,quote,spec)=>{
      if(spec.startsWith('node:')||builtinModules.includes(spec))return m;
      return 'from '+JSON.stringify(pathToFileURL(spec.startsWith('.')?path.resolve(root,spec):require.resolve(spec)).href);
    });
    src=src.replace(/logger:\s*true/g,'logger:false').replaceAll('app.listen(','testListen(').replaceAll('process.on(','testOn(');
    src='const testListen=async()=>{};const testOn=()=>{};\n'+src+'\nexport {app};';
    ({app}=await import('data:text/javascript;base64,'+Buffer.from(src).toString('base64')));
    await app.ready();

    const call=async(id,number,force=false)=>{
      const response=await app.inject({method:'POST',url:'/api/v1/customers',
        headers:{authorization:'Bearer '+app.jwt.sign({id,role:id===1?'OWNER':'MANAGER'})},
        payload:{name:'New applicant',phone:number,...(force?{force:true}:{})}});
      return{status:response.statusCode,body:response.json()};
    };
    const foreign=await call(2,'+77010000902');
    assert.equal(foreign.status,409);
    assert.equal(foreign.body.error.code,'POSSIBLE_DUPLICATE_CUSTOMER');
    assert.equal(foreign.body.error.candidate,undefined,'do not leak foreign customer name, phone or id');
    const own=await call(2,'+77010000901');
    assert.equal(own.status,409);
    assert.equal(own.body.error.candidate.name,'Own contact','manager can identify a customer on own branch');
    const owner=await call(1,'+77010000902');
    assert.equal(owner.status,409);
    assert.equal(owner.body.error.candidate.name,'Foreign contact','owner retains global deduplication');
    const forced=await call(2,'+77010000902',true);
    assert.equal(forced.status,201,'a manager can register a separate customer without exposing foreign data');
    await query("INSERT INTO requests(number,customer_id,branch_id,status,complaint) VALUES('DP-SHARED',$1,$2,'NEW','Shared phone on own branch')",[forced.body.data.id,kst]);
    const shared=await call(2,'+77010000902');
    assert.equal(shared.status,409);
    assert.equal(shared.body.error.candidate.id,forced.body.data.id,'manager sees accessible duplicate even when older foreign match exists');
  }finally{
    if(app)await app.close();
    await db.close();
    delete globalThis.__duplicatePrivacyPool;
  }
});
