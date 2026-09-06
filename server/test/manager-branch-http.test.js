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

test('MANAGER не видит чужой филиал в списках и dashboard',async()=>{
  const db=await PGlite.create();
  const query=(sql,params=[])=>params.length?db.query(sql,params):db.exec(sql).then(r=>r.at(-1));
  let queue=Promise.resolve();
  const pool={query,connect:async()=>{const prior=queue;let release;queue=new Promise(r=>{release=r});await prior;return {query,release}},end:async()=>{}};
  globalThis.__managerBranchPool=pool;
  let app;
  try{
    await migrateCore(pool);
    const kst=(await query("SELECT id FROM branches WHERE code='KST'")).rows[0].id;
    const other=(await query("INSERT INTO branches(code,name) VALUES('MB2','Чужой филиал') RETURNING id")).rows[0].id;
    await query(`INSERT INTO users(name,email,password_hash,role) VALUES
      ('Owner','mb-owner@test.invalid','unused','OWNER'),
      ('Manager','mb-manager@test.invalid','unused','MANAGER'),
      ('Engineer KST','mb-eng1@test.invalid','unused','ENGINEER'),
      ('Engineer Other','mb-eng2@test.invalid','unused','ENGINEER')`);
    await query('UPDATE users SET primary_branch_id=$1 WHERE id=4',[other]);
    await query("INSERT INTO customers(name,phone) VALUES('Shared client','701')");
    const own=(await query("INSERT INTO requests(number,customer_id,manager_id,engineer_id,branch_id,status,complaint,total,paid,direct_cost) VALUES('MB-KST',1,2,3,$1,'REPAIR','Own',1000,200,100) RETURNING id",[kst])).rows[0].id;
    const foreign=(await query("INSERT INTO requests(number,customer_id,engineer_id,branch_id,status,complaint,total,paid,direct_cost) VALUES('MB-OTHER',1,4,$1,'REPAIR','Foreign',9000,8000,4000) RETURNING id",[other])).rows[0].id;
    await query("INSERT INTO complaints(number,request_id,customer_id,text,status) VALUES('MB-C1',$1,1,'Own complaint','OPEN'),('MB-C2',$2,1,'Foreign complaint','OPEN')",[own,foreign]);
    await query("INSERT INTO dispatch_controls(request_id,reason,status,created_by,updated_by) VALUES($1,'Own control','OPEN',1,1),($2,'Foreign control','OPEN',1,1)",[own,foreign]);

    let src=await readFile(path.join(root,'index2.js'),'utf8');
    src=src.replace(/import pg from\s*['"]pg['"];?/g,'const pg={Pool:class {constructor(){return globalThis.__managerBranchPool}}};');
    src=src.replace(/\bfrom\s*(['"])([^'"]+)\1/g,(m,quote,spec)=>{
      if(spec.startsWith('node:')||builtinModules.includes(spec))return m;
      return 'from '+JSON.stringify(pathToFileURL(spec.startsWith('.')?path.resolve(root,spec):require.resolve(spec)).href);
    });
    src=src.replace(/logger:\s*true/g,'logger:false').replaceAll('app.listen(','testListen(').replaceAll('process.on(','testOn(');
    src='const testListen=async()=>{};const testOn=()=>{};\n'+src+'\nexport {app};';
    ({app}=await import('data:text/javascript;base64,'+Buffer.from(src).toString('base64')));await app.ready();
    const token=app.jwt.sign({id:2,role:'MANAGER'});
    const call=async url=>{const r=await app.inject({method:'GET',url,headers:{authorization:'Bearer '+token}});return {status:r.statusCode,...r.json()}};

    const orders=await call('/api/v1/requests');
    assert.equal(orders.status,200);assert.ok(orders.data.some(x=>x.id===own));assert.ok(!orders.data.some(x=>x.id===foreign));
    const complaints=await call('/api/v1/complaints');
    assert.equal(complaints.status,200);assert.ok(complaints.data.some(x=>x.request_id===own));assert.ok(!complaints.data.some(x=>x.request_id===foreign));
    const controls=await call('/api/v1/dispatch-controls');
    assert.equal(controls.status,200);assert.ok(controls.data.some(x=>x.request_id===own));assert.ok(!controls.data.some(x=>x.request_id===foreign));
    const dashboard=await call('/api/v1/dashboard');
    assert.equal(dashboard.status,200);assert.equal(dashboard.data.total,1);assert.equal(Number(dashboard.data.gross_profit),0);
    const finance=await call('/api/v1/dashboard/finance');
    assert.equal(finance.status,200);assert.equal(Number(finance.data.totals.revenue),1000);assert.equal(Number(finance.data.totals.paid),200);
    const customers=await call('/api/v1/customers');
    assert.equal(customers.status,200);const client=customers.data.find(x=>x.id===1);assert.equal(client.request_count,1);assert.equal(Number(client.lifetime_paid),200);
  }finally{
    if(app)await app.close();await db.close();delete globalThis.__managerBranchPool;
  }
});
