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
  globalThis.__payrollPaymentPool=pool;
  await migrateCore(pool);
  await query(`CREATE TABLE IF NOT EXISTS request_works(
    id SERIAL PRIMARY KEY,request_id INT NOT NULL REFERENCES requests(id) ON DELETE CASCADE,name TEXT NOT NULL,
    qty NUMERIC(12,3) NOT NULL DEFAULT 1,unit_price NUMERIC(14,2) NOT NULL DEFAULT 0,direct_cost NUMERIC(14,2) NOT NULL DEFAULT 0,
    performed_by INT REFERENCES users(id),created_at TIMESTAMPTZ NOT NULL DEFAULT now(),updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  const branch=(await query("SELECT id FROM branches WHERE code='KST'")).rows[0].id;
  await query(`INSERT INTO users(name,email,password_hash,role,primary_branch_id) VALUES
    ('Owner Salary','salary-owner@test.invalid','unused','OWNER',$1),
    ('Accountant Salary','salary-accountant@test.invalid','unused','ACCOUNTANT',$1),
    ('Engineer Salary','salary-engineer@test.invalid','unused','ENGINEER',$1)`,[branch]);
  await query("INSERT INTO customers(name,phone) VALUES('Salary Client','705')");
  await query(`INSERT INTO requests(number,customer_id,engineer_id,branch_id,status,complaint,total,direct_cost,paid,created_at,closed_at)
    VALUES('SALARY-ORDER',1,3,$1,'CLOSED','Salary',10000,1000,10000,'2026-09-01T08:00:00Z','2026-09-02T10:00:00Z')`,[branch]);
  await query("SELECT set_config('app.finance_actor','1',false)");
  const account=(await query(`INSERT INTO finance_accounts(name,type,branch_id,responsible_id,comment,created_by) VALUES('Payroll Bank','BANK',$1,2,'Payroll test account',1) RETURNING id`,[branch])).rows[0];
  await query(`INSERT INTO finance_transactions(account_id,type,kind,category,amount,payment_method,comment,created_by,responsible_id,affects_pnl,idempotency_key)
    VALUES($1,'INCOME','OPENING','OPENING',200000,'ACCOUNT','Payroll opening funds',1,2,false,'payroll-test-opening')`,[account.id]);

  let src=await readFile(path.join(root,'payroll.js'),'utf8');
  src=src.replace(/import pg from\s*['"]pg['"];?/g,'const pg={Pool:class {constructor(){return globalThis.__payrollPaymentPool}}};');
  src=src.replace(/\bfrom\s*(['"])([^'"]+)\1/g,(m,quote,spec)=>{
    if(spec.startsWith('node:')||builtinModules.includes(spec))return m;
    return 'from '+JSON.stringify(pathToFileURL(spec.startsWith('.')?path.resolve(root,spec):require.resolve(spec)).href);
  });
  src=src.replace(/logger:\s*true/g,'logger:false').replaceAll('app.listen(','testListen(').replaceAll('process.on(','testOn(');
  src='const testListen=async()=>{};const testOn=()=>{};\n'+src+'\nexport {app};';
  const {app}=await import('data:text/javascript;base64,'+Buffer.from(src).toString('base64'));
  await app.ready();
  const tokens={1:app.jwt.sign({id:1,role:'OWNER'}),2:app.jwt.sign({id:2,role:'ACCOUNTANT'}),3:app.jwt.sign({id:3,role:'ENGINEER'})};
  let seq=0;
  async function call(method,url,payload,user=1,key=null){const idem=key||'salary-payment-'+String(++seq).padStart(8,'0');const r=await app.inject({method,url,payload,headers:{authorization:'Bearer '+tokens[user],'idempotency-key':idem}});let body={};try{body=r.json()}catch{}return{status:r.statusCode,...body}}
  return{db,pool,query,branch,account:account.id,app,call,close:async()=>{await app.close();await db.close();delete globalThis.__payrollPaymentPool;}};
}

test('Stage D payroll payments: finance posting, partial settlement, reversal and close',async t=>{
  const s=await setup();
  try{
    const rule=await s.call('PUT','/api/v1/rules/3',{month:'2026-09',base_salary:100000,order_percent:0,work_percent:0,gross_profit_percent:0,reason:'Fixed salary'},1);
    assert.equal(rule.status,201,JSON.stringify(rule));
    const calc=await s.call('POST','/api/v1/periods/calculate',{branch_id:s.branch,month:'2026-09'},2);
    assert.equal(calc.status,201,JSON.stringify(calc));const periodId=calc.data.id;
    const approved=await s.call('POST',`/api/v1/periods/${periodId}/approve`,{},1);
    assert.equal(approved.status,200,JSON.stringify(approved));

    let firstId,secondId;
    await t.test('ACCOUNTANT posts partial cash settlement without double-counting payroll in P&L',async()=>{
      const first=await s.call('POST',`/api/v1/periods/${periodId}/payments`,{user_id:3,account_id:s.account,amount:40000,document_reference:'PAY-001'},2,'salary-payment-first-0001');
      assert.equal(first.status,201,JSON.stringify(first));firstId=first.data.payment.id;
      assert.equal(first.data.period.status,'APPROVED');assert.equal(Number(first.data.period.payment_totals.remaining),60000);
      const tx=(await s.query('SELECT * FROM finance_transactions WHERE id=$1',[first.data.payment.finance_transaction_id])).rows[0];
      assert.equal(tx.type,'EXPENSE');assert.equal(tx.kind,'PAYROLL_PAYMENT');assert.equal(tx.category,'PAYROLL');assert.equal(Number(tx.amount),40000);assert.equal(tx.affects_pnl,false);
      assert.equal(Number((await s.query("SELECT count(*) c FROM finance_pnl_transactions WHERE category='PAYROLL'")).rows[0].c),0);
      const over=await s.call('POST',`/api/v1/periods/${periodId}/payments`,{user_id:3,account_id:s.account,amount:70000,document_reference:'PAY-OVER'},2);
      assert.equal(over.status,409,JSON.stringify(over));assert.equal(over.error.code,'PAYROLL_OVERPAYMENT');
      const replay=await s.call('POST',`/api/v1/periods/${periodId}/payments`,{user_id:3,account_id:s.account,amount:40000,document_reference:'PAY-001'},2,'salary-payment-first-0001');
      assert.equal(replay.status,201,JSON.stringify(replay));assert.equal(Number(replay.data.payment.id),Number(firstId));
    });

    await t.test('full settlement changes period to PAID; ACCOUNTANT cannot close it',async()=>{
      const second=await s.call('POST',`/api/v1/periods/${periodId}/payments`,{user_id:3,account_id:s.account,amount:60000,document_reference:'PAY-002'},2);
      assert.equal(second.status,201,JSON.stringify(second));secondId=second.data.payment.id;
      assert.equal(second.data.period.status,'PAID');assert.equal(Number(second.data.period.payment_totals.remaining),0);
      assert.equal((await s.call('POST',`/api/v1/periods/${periodId}/close`,{reason:'Month closed'},2)).status,403);
      assert.equal(Number((await s.query("SELECT count(*) c FROM finance_pnl_transactions WHERE category='PAYROLL'")).rows[0].c),0);
    });

    await t.test('reversal restores finance balance and returns PAID period to APPROVED',async()=>{
      const before=Number((await s.query('SELECT balance FROM finance_account_balances WHERE id=$1',[s.account])).rows[0].balance);
      const rev=await s.call('POST',`/api/v1/payments/${secondId}/reverse`,{reason:'Wrong payout document',document_reference:'REV-002'},2);
      assert.equal(rev.status,201,JSON.stringify(rev));assert.equal(rev.data.period.status,'APPROVED');assert.equal(Number(rev.data.period.payment_totals.remaining),60000);
      const after=Number((await s.query('SELECT balance FROM finance_account_balances WHERE id=$1',[s.account])).rows[0].balance);assert.equal(after,before+60000);
      const reversalTx=(await s.query('SELECT ft.* FROM finance_transactions ft JOIN payroll_payments pp ON pp.finance_transaction_id=ft.id WHERE pp.id=$1',[rev.data.payment.id])).rows[0];assert.equal(reversalTx.affects_pnl,false);
      await assert.rejects(s.query('DELETE FROM payroll_payments WHERE id=$1',[firstId]),e=>e.code==='P2401');
    });

    await t.test('repayment allows OWNER to close period permanently',async()=>{
      const again=await s.call('POST',`/api/v1/periods/${periodId}/payments`,{user_id:3,account_id:s.account,amount:60000,document_reference:'PAY-003'},2);
      assert.equal(again.status,201,JSON.stringify(again));assert.equal(again.data.period.status,'PAID');
      const closed=await s.call('POST',`/api/v1/periods/${periodId}/close`,{reason:'Payroll checked and paid'},1);
      assert.equal(closed.status,200,JSON.stringify(closed));assert.equal(closed.data.status,'CLOSED');
      assert.equal((await s.call('POST',`/api/v1/payments/${again.data.payment.id}/reverse`,{reason:'Late reversal',document_reference:'REV-LATE'},2)).status,409);
    });
  }finally{await s.close();}
});
