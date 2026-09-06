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
  globalThis.__payrollTestPool=pool;
  await migrateCore(pool);
  // request_works is normally created by the operational API module; the unit harness only loads core migrations.
  await query(`CREATE TABLE IF NOT EXISTS request_works(
    id SERIAL PRIMARY KEY,
    request_id INT NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    qty NUMERIC(12,3) NOT NULL DEFAULT 1,
    unit_price NUMERIC(14,2) NOT NULL DEFAULT 0,
    direct_cost NUMERIC(14,2) NOT NULL DEFAULT 0,
    performed_by INT REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  const branch=(await query("SELECT id FROM branches WHERE code='KST'")).rows[0].id;
  await query(`INSERT INTO users(name,email,password_hash,role,primary_branch_id) VALUES
    ('Owner Pay','pay-owner@test.invalid','unused','OWNER',$1),
    ('Accountant Pay','pay-accountant@test.invalid','unused','ACCOUNTANT',$1),
    ('Manager Pay','pay-manager@test.invalid','unused','MANAGER',$1),
    ('Engineer Pay','pay-engineer@test.invalid','unused','ENGINEER',$1)`,[branch]);
  await query("INSERT INTO customers(name,phone) VALUES('Payroll Client','703')");
  const order=(await query(`INSERT INTO requests(number,customer_id,manager_id,engineer_id,branch_id,status,complaint,total,direct_cost,paid,closed_at)
    VALUES('PAY-ORDER',1,3,4,$1,'CLOSED','Payroll',100000,20000,100000,'2026-09-15T12:00:00Z') RETURNING id`,[branch])).rows[0];
  await query(`INSERT INTO request_works(request_id,name,qty,unit_price,direct_cost,performed_by) VALUES($1,'Repair',1,60000,10000,4)`,[order.id]);

  let src=await readFile(path.join(root,'payroll.js'),'utf8');
  src=src.replace(/import pg from\s*['"]pg['"];?/g,'const pg={Pool:class {constructor(){return globalThis.__payrollTestPool}}};');
  src=src.replace(/\bfrom\s*(['"])([^'"]+)\1/g,(m,quote,spec)=>{
    if(spec.startsWith('node:')||builtinModules.includes(spec))return m;
    return 'from '+JSON.stringify(pathToFileURL(spec.startsWith('.')?path.resolve(root,spec):require.resolve(spec)).href);
  });
  src=src.replace(/logger:\s*true/g,'logger:false').replaceAll('app.listen(','testListen(').replaceAll('process.on(','testOn(');
  src='const testListen=async()=>{};const testOn=()=>{};\n'+src+'\nexport {app};';
  const {app}=await import('data:text/javascript;base64,'+Buffer.from(src).toString('base64'));
  await app.ready();
  const roles={1:'OWNER',2:'ACCOUNTANT',3:'MANAGER',4:'ENGINEER'};
  const tokens=Object.fromEntries(Object.entries(roles).map(([id,role])=>[id,app.jwt.sign({id:Number(id),role})]));
  let seq=0;
  async function call(method,url,payload,user=1){const r=await app.inject({method,url,payload,headers:{authorization:'Bearer '+tokens[user],'idempotency-key':'payroll-test-'+String(++seq).padStart(8,'0')}});let body={};try{body=r.json()}catch{}return{status:r.statusCode,...body}}
  return{db,query,pool,app,branch,call,close:async()=>{await app.close();await db.close();delete globalThis.__payrollTestPool;}};
}

test('Stage D payroll: versioned rules, reversal documents and immutable periods',async t=>{
  const s=await setup();
  try{
    await t.test('OWNER versions compensation rules; ACCOUNTANT cannot edit them',async()=>{
      assert.equal((await s.call('PUT','/api/v1/rules/4',{month:'2026-09',base_salary:100000,order_percent:10,work_percent:5,gross_profit_percent:0,reason:'September terms'},2)).status,403);
      const sep=await s.call('PUT','/api/v1/rules/4',{month:'2026-09',base_salary:100000,order_percent:10,work_percent:5,gross_profit_percent:0,reason:'September terms'},1);
      assert.equal(sep.status,201,JSON.stringify(sep));
      const oct=await s.call('PUT','/api/v1/rules/4',{month:'2026-10',base_salary:150000,order_percent:20,work_percent:8,gross_profit_percent:0,reason:'October terms'},1);
      assert.equal(oct.status,201,JSON.stringify(oct));
      const report=await s.call('GET',`/api/v1/report?month=2026-09&branch_id=${s.branch}`,undefined,2);
      assert.equal(report.status,200,JSON.stringify(report));
      const engineer=report.data.rows.find(x=>Number(x.id)===4);
      assert.equal(Number(engineer.base_salary),100000);
      assert.equal(Number(engineer.order_commission),10000);
      assert.equal(Number(engineer.work_commission),3000);
      assert.equal(Number(engineer.salary),113000);
    });

    await t.test('ACCOUNTANT creates adjustment; DELETE is blocked; reversal preserves both documents',async()=>{
      const adj=await s.call('POST','/api/v1/adjustments',{user_id:4,month:'2026-09',type:'BONUS',amount:5000,reason:'Quality bonus'},2);
      assert.equal(adj.status,201,JSON.stringify(adj));
      assert.equal((await s.call('DELETE',`/api/v1/adjustments/${adj.data.id}`,undefined,2)).status,409);
      const rev=await s.call('POST',`/api/v1/adjustments/${adj.data.id}/reverse`,{reason:'Bonus entered by mistake'},2);
      assert.equal(rev.status,201,JSON.stringify(rev));
      assert.equal(Number(rev.data.reversal_of),Number(adj.data.id));
      assert.equal(Number(rev.data.amount),-5000);
      const rows=(await s.query('SELECT id,amount,reversal_of FROM payroll_adjustments ORDER BY id')).rows;
      assert.equal(rows.length,2);assert.equal(rows.reduce((a,x)=>a+Number(x.amount),0),0);
      await assert.rejects(s.query('DELETE FROM payroll_adjustments WHERE id=$1',[adj.data.id]),e=>e.code==='P2401');
    });

    let periodId,revision1Salary;
    await t.test('ACCOUNTANT calculates revision; prior revision remains immutable',async()=>{
      const calc1=await s.call('POST','/api/v1/periods/calculate',{branch_id:s.branch,month:'2026-09'},2);
      assert.equal(calc1.status,201,JSON.stringify(calc1));periodId=calc1.data.id;
      const a1=calc1.data.accruals.find(x=>Number(x.user_id)===4);revision1Salary=Number(a1.total);assert.equal(a1.revision,1);
      const extra=await s.call('POST','/api/v1/adjustments',{user_id:4,month:'2026-09',type:'BONUS',amount:2000,reason:'Documented extra bonus'},2);
      assert.equal(extra.status,201,JSON.stringify(extra));
      const calc2=await s.call('POST','/api/v1/periods/calculate',{branch_id:s.branch,month:'2026-09'},2);
      assert.equal(calc2.status,201,JSON.stringify(calc2));
      const a2=calc2.data.accruals.find(x=>Number(x.user_id)===4);assert.equal(a2.revision,2);assert.equal(Number(a2.total),revision1Salary+2000);
      assert.equal(Number((await s.query('SELECT count(*) c FROM payroll_accruals WHERE period_id=$1 AND user_id=4',[periodId])).rows[0].c),2);
      await assert.rejects(s.query('UPDATE payroll_accruals SET total=0 WHERE period_id=$1',[periodId]),e=>e.code==='P2401');
    });

    await t.test('only OWNER approves; locked period rejects recalculation, adjustments and retroactive rules',async()=>{
      assert.equal((await s.call('POST',`/api/v1/periods/${periodId}/approve`,{},2)).status,403);
      const approved=await s.call('POST',`/api/v1/periods/${periodId}/approve`,{},1);
      assert.equal(approved.status,200,JSON.stringify(approved));assert.equal(approved.data.status,'APPROVED');
      const recalc=await s.call('POST','/api/v1/periods/calculate',{branch_id:s.branch,month:'2026-09'},2);
      assert.equal(recalc.status,409,JSON.stringify(recalc));
      const late=await s.call('POST','/api/v1/adjustments',{user_id:4,month:'2026-09',type:'BONUS',amount:1000,reason:'Late change'},2);
      assert.equal(late.status,409,JSON.stringify(late));
      await assert.rejects(s.query(`INSERT INTO payroll_adjustments(user_id,period_month,amount,type,reason,created_by,branch_id) VALUES(4,'2026-09-01',1000,'BONUS','Direct late change',2,$1)`,[s.branch]),e=>e.code==='P2401');
      const retro=await s.call('PUT','/api/v1/rules/4',{month:'2026-08',base_salary:90000,order_percent:9,work_percent:4,gross_profit_percent:0,reason:'Backdated terms'},1);
      assert.equal(retro.status,409,JSON.stringify(retro));assert.equal(retro.error.code,'PAYROLL_RULE_RETRO_LOCKED');
      await assert.rejects(s.query(`INSERT INTO payroll_rule_versions(user_id,effective_from,base_salary,order_percent,work_percent,gross_profit_percent,active,reason,created_by) VALUES(4,'2026-08-01',90000,9,4,0,true,'Direct backdate',1)`),e=>e.code==='P2401');
      const versions=(await s.query('SELECT effective_from,base_salary FROM payroll_rule_versions WHERE user_id=4 ORDER BY effective_from')).rows;
      assert.equal(versions.length,2);assert.equal(Number(versions[0].base_salary),100000);assert.equal(Number(versions[1].base_salary),150000);
    });
  }finally{await s.close();}
});
