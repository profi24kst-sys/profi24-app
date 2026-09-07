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

test('Stage D pricing uses current effective payroll rule and lets SUPERVISOR check margin',async()=>{
  const db=await PGlite.create();
  const query=(sql,params=[])=>params.length?db.query(sql,params):db.exec(sql).then(r=>r.at(-1));
  let queue=Promise.resolve();
  const pool={query,connect:async()=>{const prior=queue;let release;queue=new Promise(r=>{release=r});await prior;return{query,release}},end:async()=>{}};
  globalThis.__pricingStageDPool=pool;
  try{
    await migrateCore(pool);
    await query(`CREATE TABLE IF NOT EXISTS request_works(
      id SERIAL PRIMARY KEY,request_id INT NOT NULL REFERENCES requests(id) ON DELETE CASCADE,name TEXT NOT NULL,
      qty NUMERIC(12,3) NOT NULL DEFAULT 1,unit_price NUMERIC(14,2) NOT NULL DEFAULT 0,direct_cost NUMERIC(14,2) NOT NULL DEFAULT 0,
      performed_by INT REFERENCES users(id),created_at TIMESTAMPTZ NOT NULL DEFAULT now(),updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    const branch=Number((await query("SELECT id FROM branches WHERE code='KST'")).rows[0].id);
    await query(`INSERT INTO users(name,email,password_hash,role,primary_branch_id) VALUES
      ('Pricing Owner','pricing-owner@test.invalid','unused','OWNER',$1),
      ('Pricing Supervisor','pricing-supervisor@test.invalid','unused','SUPERVISOR',$1),
      ('Pricing Engineer','pricing-engineer@test.invalid','unused','ENGINEER',$1)`,[branch]);
    await query(`INSERT INTO payroll_rule_versions(user_id,effective_from,base_salary,order_percent,work_percent,gross_profit_percent,active,reason,created_by) VALUES
      (3,'2026-09-01',0,10,0,0,true,'September commission',1),
      (3,'2026-10-01',0,50,0,0,true,'October commission',1)`);
    await query("INSERT INTO customers(name,phone) VALUES('Pricing Client','707')");
    const request=(await query(`INSERT INTO requests(number,customer_id,engineer_id,branch_id,status,complaint,total,direct_cost,paid,created_at)
      VALUES('PRICE-EFFECTIVE',1,3,$1,'REPAIR','Pricing',100000,0,0,'2026-09-06T10:00:00Z') RETURNING id`,[branch])).rows[0];

    let src=await readFile(path.join(root,'pricing-guard.js'),'utf8');
    src=src.replace(/import pg from\s*['"]pg['"];?/g,'const pg={Pool:class {constructor(){return globalThis.__pricingStageDPool}}};');
    src=src.replace(/\bfrom\s*(['"])([^'"]+)\1/g,(m,quote,spec)=>{
      if(spec.startsWith('node:')||builtinModules.includes(spec))return m;
      return 'from '+JSON.stringify(pathToFileURL(spec.startsWith('.')?path.resolve(root,spec):require.resolve(spec)).href);
    });
    src=src.replace(/logger:\s*true/g,'logger:false').replaceAll('app.listen(','testListen(').replaceAll('process.on(','testOn(');
    src='const testListen=async()=>{};const testOn=()=>{};\n'+src+'\nexport {app};';
    const {app}=await import('data:text/javascript;base64,'+Buffer.from(src).toString('base64'));
    await app.ready();
    try{
      const owner=app.jwt.sign({id:1,role:'OWNER'}),supervisor=app.jwt.sign({id:2,role:'SUPERVISOR'});
      const call=async token=>{const r=await app.inject({method:'GET',url:`/api/v1/requests/${request.id}/check`,headers:{authorization:'Bearer '+token}});return{status:r.statusCode,body:r.json()}};
      const a=await call(owner);assert.equal(a.status,200,JSON.stringify(a.body));assert.equal(Number(a.body.data.payroll_estimate),10000);
      const b=await call(supervisor);assert.equal(b.status,200,JSON.stringify(b.body));assert.equal(Number(b.body.data.payroll_estimate),10000);
    }finally{await app.close()}
  }finally{await db.close();delete globalThis.__pricingStageDPool;}
});
