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
  globalThis.__payrollRolePool=pool;
  await migrateCore(pool);
  await query(`CREATE TABLE IF NOT EXISTS request_works(
    id SERIAL PRIMARY KEY,request_id INT NOT NULL REFERENCES requests(id) ON DELETE CASCADE,name TEXT NOT NULL,
    qty NUMERIC(12,3) NOT NULL DEFAULT 1,unit_price NUMERIC(14,2) NOT NULL DEFAULT 0,direct_cost NUMERIC(14,2) NOT NULL DEFAULT 0,
    performed_by INT REFERENCES users(id),created_at TIMESTAMPTZ NOT NULL DEFAULT now(),updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  const branch=(await query("SELECT id FROM branches WHERE code='KST'")).rows[0].id;
  await query(`INSERT INTO users(name,email,password_hash,role,primary_branch_id) VALUES
    ('Owner Role','role-owner@test.invalid','unused','OWNER',$1),
    ('Supervisor Role','role-supervisor@test.invalid','unused','SUPERVISOR',$1),
    ('Accountant Role','role-accountant@test.invalid','unused','ACCOUNTANT',$1),
    ('Manager Role','role-manager@test.invalid','unused','MANAGER',$1),
    ('Engineer Role','role-engineer@test.invalid','unused','ENGINEER',$1),
    ('Trainee Role','role-trainee@test.invalid','unused','TRAINEE',$1)`,[branch]);
  for(const id of [4,5,6])await query(`INSERT INTO payroll_rule_versions(user_id,effective_from,base_salary,active,reason,created_by) VALUES($1,'2026-09-01',$2,true,'Self-view acceptance',1)`,[id,id*10000]);

  let src=await readFile(path.join(root,'payroll.js'),'utf8');
  src=src.replace(/import pg from\s*['"]pg['"];?/g,'const pg={Pool:class {constructor(){return globalThis.__payrollRolePool}}};');
  src=src.replace(/\bfrom\s*(['"])([^'"]+)\1/g,(m,quote,spec)=>{
    if(spec.startsWith('node:')||builtinModules.includes(spec))return m;
    return 'from '+JSON.stringify(pathToFileURL(spec.startsWith('.')?path.resolve(root,spec):require.resolve(spec)).href);
  });
  src=src.replace(/logger:\s*true/g,'logger:false').replaceAll('app.listen(','testListen(').replaceAll('process.on(','testOn(');
  src='const testListen=async()=>{};const testOn=()=>{};\n'+src+'\nexport {app};';
  const {app}=await import('data:text/javascript;base64,'+Buffer.from(src).toString('base64'));
  await app.ready();
  const roles={1:'OWNER',2:'SUPERVISOR',3:'ACCOUNTANT',4:'MANAGER',5:'ENGINEER',6:'TRAINEE'};
  const tokens=Object.fromEntries(Object.entries(roles).map(([id,role])=>[id,app.jwt.sign({id:Number(id),role})]));
  let seq=0;
  async function call(method,url,payload,user){const r=await app.inject({method,url,payload,headers:{authorization:'Bearer '+tokens[user],'idempotency-key':'payroll-role-'+String(++seq).padStart(8,'0')}});let body={};try{body=r.json()}catch{}return{status:r.statusCode,...body}}
  return{db,query,pool,app,branch,call,close:async()=>{await app.close();await db.close();delete globalThis.__payrollRolePool;}};
}

test('Stage D payroll HTTP: six roles see only their intended payroll surface',async()=>{
  const s=await setup();
  try{
    const calc=await s.call('POST','/api/v1/periods/calculate',{branch_id:s.branch,month:'2026-09'},3);
    assert.equal(calc.status,201,JSON.stringify(calc));
    const approved=await s.call('POST',`/api/v1/periods/${calc.data.id}/approve`,{},1);
    assert.equal(approved.status,200,JSON.stringify(approved));

    assert.equal((await s.call('GET','/api/v1/periods?month=2026-09',undefined,1)).status,200);
    assert.equal((await s.call('GET','/api/v1/periods?month=2026-09',undefined,3)).status,200);
    assert.equal((await s.call('GET','/api/v1/periods?month=2026-09',undefined,2)).status,403);
    assert.equal((await s.call('GET','/api/v1/periods?month=2026-09',undefined,4)).status,403);
    assert.equal((await s.call('GET','/api/v1/periods?month=2026-09',undefined,5)).status,403);
    assert.equal((await s.call('GET','/api/v1/periods?month=2026-09',undefined,6)).status,403);

    const supervisorSummary=await s.call('GET','/api/v1/summary?month=2026-09',undefined,2);
    assert.equal(supervisorSummary.status,200,JSON.stringify(supervisorSummary));
    assert.equal((await s.call('GET','/api/v1/summary?month=2026-09',undefined,4)).status,403);
    assert.equal((await s.call('GET','/api/v1/self?month=2026-09',undefined,2)).status,403);

    for(const id of [4,5,6]){
      const self=await s.call('GET','/api/v1/self?month=2026-09',undefined,id);
      assert.equal(self.status,200,JSON.stringify(self));
      assert.ok(self.data);assert.equal(Number(self.data.user_id),id);
      assert.equal(Number(self.data.total),id*10000);
    }

    assert.equal((await s.call('POST','/api/v1/periods/calculate',{branch_id:s.branch,month:'2026-10'},2)).status,403);
    assert.equal((await s.call('POST','/api/v1/periods/calculate',{branch_id:s.branch,month:'2026-10'},4)).status,403);
  }finally{await s.close();}
});
