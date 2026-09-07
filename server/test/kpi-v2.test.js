import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire,builtinModules} from 'node:module';
import {fileURLToPath,pathToFileURL} from 'node:url';
import path from 'node:path';
import {PGlite} from '@electric-sql/pglite';
import {migrateCore} from '../src/migrate.js';
import {calculatePayroll,payrollPeriod} from '../src/payroll-calculation.js';

const root=fileURLToPath(new URL('../src/',import.meta.url));
const require=createRequire(import.meta.url);

async function setup(){
  const db=await PGlite.create();
  const query=(sql,params=[])=>params.length?db.query(sql,params):db.exec(sql).then(r=>r.at(-1));
  let queue=Promise.resolve();
  const pool={query,connect:async()=>{const prior=queue;let release;queue=new Promise(r=>{release=r});await prior;return{query,release}},end:async()=>{}};
  globalThis.__kpiTestPool=pool;
  await migrateCore(pool);
  await query(`CREATE TABLE IF NOT EXISTS request_works(
    id SERIAL PRIMARY KEY,request_id INT NOT NULL REFERENCES requests(id) ON DELETE CASCADE,name TEXT NOT NULL,
    qty NUMERIC(12,3) NOT NULL DEFAULT 1,unit_price NUMERIC(14,2) NOT NULL DEFAULT 0,direct_cost NUMERIC(14,2) NOT NULL DEFAULT 0,
    performed_by INT REFERENCES users(id),created_at TIMESTAMPTZ NOT NULL DEFAULT now(),updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  const branch=(await query("SELECT id FROM branches WHERE code='KST'")).rows[0].id;
  await query(`INSERT INTO users(name,email,password_hash,role,primary_branch_id) VALUES
    ('Owner KPI','kpi-owner@test.invalid','unused','OWNER',$1),
    ('Supervisor KPI','kpi-supervisor@test.invalid','unused','SUPERVISOR',$1),
    ('Accountant KPI','kpi-accountant@test.invalid','unused','ACCOUNTANT',$1),
    ('Manager A','kpi-manager-a@test.invalid','unused','MANAGER',$1),
    ('Manager B','kpi-manager-b@test.invalid','unused','MANAGER',$1),
    ('Engineer A','kpi-engineer-a@test.invalid','unused','ENGINEER',$1)`,[branch]);
  await query("INSERT INTO customers(name,phone) VALUES('KPI Client','704')");
  await query(`INSERT INTO requests(number,customer_id,manager_id,engineer_id,branch_id,status,complaint,total,direct_cost,paid,created_at,closed_at,sla_deadline) VALUES
    ('KPI-A',1,4,6,$1,'CLOSED','A',100000,20000,100000,'2026-09-02T09:00:00Z','2026-09-05T10:00:00Z','2026-09-06T10:00:00Z'),
    ('KPI-B',1,5,6,$1,'CLOSED','B',50000,10000,50000,'2026-09-03T09:00:00Z','2026-09-06T10:00:00Z','2026-09-07T10:00:00Z')`,[branch]);
  await query(`INSERT INTO payroll_rule_versions(user_id,effective_from,base_salary,order_percent,work_percent,gross_profit_percent,active,reason,created_by) VALUES(6,'2026-09-01',0,0,0,0,true,'KPI bonus only',1)`);

  let src=await readFile(path.join(root,'kpi.js'),'utf8');
  src=src.replace(/import pg from\s*['"]pg['"];?/g,'const pg={Pool:class {constructor(){return globalThis.__kpiTestPool}}};');
  src=src.replace(/\bfrom\s*(['"])([^'"]+)\1/g,(m,quote,spec)=>{
    if(spec.startsWith('node:')||builtinModules.includes(spec))return m;
    return 'from '+JSON.stringify(pathToFileURL(spec.startsWith('.')?path.resolve(root,spec):require.resolve(spec)).href);
  });
  src=src.replace(/logger:\s*true/g,'logger:false').replaceAll('app.listen(','testListen(').replaceAll('process.on(','testOn(');
  src='const testListen=async()=>{};const testOn=()=>{};\n'+src+'\nexport {app};';
  const {app}=await import('data:text/javascript;base64,'+Buffer.from(src).toString('base64'));
  await app.ready();
  const roles={1:'OWNER',2:'SUPERVISOR',3:'ACCOUNTANT',4:'MANAGER',5:'MANAGER',6:'ENGINEER'};
  const tokens=Object.fromEntries(Object.entries(roles).map(([id,role])=>[id,app.jwt.sign({id:Number(id),role})]));
  async function call(method,url,payload,user=1){const r=await app.inject({method,url,payload,headers:{authorization:'Bearer '+tokens[user]}});let body={};try{body=r.json()}catch{}return{status:r.statusCode,...body}}
  return{db,pool,query,branch,app,call,close:async()=>{await app.close();await db.close();delete globalThis.__kpiTestPool;}};
}

test('Stage D KPI: role-correct metrics, permission scope and approved payroll bonus',async t=>{
  const s=await setup();
  try{
    await t.test('SUPERVISOR manages plans; ACCOUNTANT cannot mutate KPI',async()=>{
      assert.equal((await s.call('PUT','/api/v1/plans/4',{month:'2026-09',target_jobs:1,target_revenue:100000,target_avg_check:100000,target_conversion:100,target_sla:95,target_quality:95,bonus_max:10000},3)).status,403);
      assert.equal((await s.call('PUT','/api/v1/plans/4',{month:'2026-09',target_jobs:1,target_revenue:100000,target_avg_check:100000,target_conversion:100,target_sla:95,target_quality:95,bonus_max:10000},2)).status,200);
      assert.equal((await s.call('PUT','/api/v1/plans/6',{month:'2026-09',target_jobs:2,target_revenue:150000,target_avg_check:75000,target_conversion:100,target_sla:95,target_quality:95,bonus_max:20000},2)).status,200);
    });

    await t.test('MANAGER and ENGINEER metrics use their own responsibility fields and self-view is isolated',async()=>{
      const manager=await s.call('GET','/api/v1/report?month=2026-09',undefined,4);
      assert.equal(manager.status,200,JSON.stringify(manager));assert.equal(manager.data.rows.length,1);assert.equal(Number(manager.data.rows[0].id),4);
      assert.equal(manager.data.rows[0].closed,1);assert.equal(Number(manager.data.rows[0].revenue),100000);
      const engineer=await s.call('GET','/api/v1/report?month=2026-09',undefined,6);
      assert.equal(engineer.status,200,JSON.stringify(engineer));assert.equal(engineer.data.rows.length,1);assert.equal(Number(engineer.data.rows[0].id),6);
      assert.equal(engineer.data.rows[0].closed,2);assert.equal(Number(engineer.data.rows[0].revenue),150000);
      const accountant=await s.call('GET',`/api/v1/report?month=2026-09&branch_id=${s.branch}`,undefined,3);
      assert.equal(accountant.status,200,JSON.stringify(accountant));assert.ok(accountant.data.rows.length>=3);
    });

    let engineerSnapshot;
    await t.test('SUPERVISOR calculates snapshots; only OWNER approves and approved plan is locked',async()=>{
      assert.equal((await s.call('POST','/api/v1/results/calculate',{branch_id:s.branch,month:'2026-09'},3)).status,403);
      const calc=await s.call('POST','/api/v1/results/calculate',{branch_id:s.branch,month:'2026-09'},2);
      assert.equal(calc.status,201,JSON.stringify(calc));engineerSnapshot=calc.data.snapshots.find(x=>Number(x.user_id)===6);assert.ok(engineerSnapshot);
      assert.equal(Number(engineerSnapshot.bonus_amount),20000);
      assert.equal((await s.call('POST',`/api/v1/results/${engineerSnapshot.id}/approve`,{},2)).status,403);
      const approved=await s.call('POST',`/api/v1/results/${engineerSnapshot.id}/approve`,{},1);
      assert.equal(approved.status,200,JSON.stringify(approved));assert.equal(approved.data.status,'APPROVED');
      const rewrite=await s.call('PUT','/api/v1/plans/6',{month:'2026-09',target_jobs:2,target_revenue:150000,target_avg_check:75000,target_conversion:100,target_sla:95,target_quality:95,bonus_max:999999},2);
      assert.equal(rewrite.status,409,JSON.stringify(rewrite));assert.equal(rewrite.error.code,'KPI_ALREADY_APPROVED');
      await assert.rejects(s.query('UPDATE kpi_result_snapshots SET bonus_amount=0 WHERE id=$1',[engineerSnapshot.id]),e=>e.code==='P2401');
      await assert.rejects(s.query('DELETE FROM kpi_result_snapshots WHERE id=$1',[engineerSnapshot.id]),e=>e.code==='P2401');
    });

    await t.test('approved KPI bonus enters payroll exactly once and locks the used plan from direct rewrite',async()=>{
      const[start,end]=payrollPeriod('2026-09');const calc=await calculatePayroll(s.pool,start,end,{branchId:s.branch});const engineer=calc.rows.find(x=>Number(x.id)===6);
      assert.equal(Number(engineer.kpi_bonus),20000);assert.equal(Number(engineer.salary),20000);assert.equal(Number(engineer.kpi_result_id),Number(engineerSnapshot.id));
      await assert.rejects(s.query('UPDATE kpi_plans SET bonus_max=999999 WHERE user_id=6 AND month=$1::date',['2026-09-01']),e=>e.code==='P2401');
      const duplicateApproval=await s.call('POST',`/api/v1/results/${engineerSnapshot.id}/approve`,{},1);assert.equal(duplicateApproval.status,200);
      const after=await calculatePayroll(s.pool,start,end,{branchId:s.branch});assert.equal(Number(after.rows.find(x=>Number(x.id)===6).kpi_bonus),20000);
    });
  }finally{await s.close();}
});
