import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {migrateCore} from '../src/migrate.js';
import {calculatePayroll,payrollPeriod} from '../src/payroll-calculation.js';
import {migrateFinance} from '../src/finance/migrate.js';
import {buildFinanceApp} from '../src/finance/app.js';
import {resolvePayrollExpense} from '../src/finance/pnl.js';

test('Stage D P&L uses approved payroll snapshot instead of recalculating locked salary',async()=>{
  const db=await PGlite.create();
  const query=(sql,params=[])=>params.length?db.query(sql,params):db.exec(sql).then(r=>r.at(-1));
  const pool={query,connect:async()=>({query,release(){}}),end:async()=>{}};
  try{
    await migrateCore(pool);
    await query(`CREATE TABLE IF NOT EXISTS request_works(
      id SERIAL PRIMARY KEY,request_id INT NOT NULL REFERENCES requests(id) ON DELETE CASCADE,name TEXT NOT NULL,
      qty NUMERIC(12,3) NOT NULL DEFAULT 1,unit_price NUMERIC(14,2) NOT NULL DEFAULT 0,direct_cost NUMERIC(14,2) NOT NULL DEFAULT 0,
      performed_by INT REFERENCES users(id),created_at TIMESTAMPTZ NOT NULL DEFAULT now(),updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    const branch=Number((await query("SELECT id FROM branches WHERE code='KST'")).rows[0].id);
    await query(`INSERT INTO users(name,email,password_hash,role,primary_branch_id) VALUES
      ('PnL Owner','pnl-owner@test.invalid','unused','OWNER',$1),
      ('PnL Engineer','pnl-engineer@test.invalid','unused','ENGINEER',$1)`,[branch]);
    const rule=(await query(`INSERT INTO payroll_rule_versions(user_id,effective_from,base_salary,order_percent,work_percent,gross_profit_percent,active,reason,created_by)
      VALUES(2,'2026-09-01',0,10,0,0,true,'September commission',1) RETURNING id`)).rows[0];
    await query("INSERT INTO customers(name,phone) VALUES('PnL Client','706')");
    await query(`INSERT INTO requests(number,customer_id,engineer_id,branch_id,status,complaint,total,direct_cost,paid,created_at,closed_at)
      VALUES('PNL-1',1,2,$1,'CLOSED','First',100000,20000,100000,'2026-09-01T08:00:00Z','2026-09-05T10:00:00Z')`,[branch]);

    const[start,end]=payrollPeriod('2026-09');
    const first=await calculatePayroll(pool,start,end,{branchId:branch});
    const engineer=first.rows.find(x=>Number(x.id)===2);
    assert.equal(Number(engineer.salary),10000);

    const period=(await query(`INSERT INTO payroll_periods(branch_id,period_month,status,created_by) VALUES($1,'2026-09-01','DRAFT',1) RETURNING id`,[branch])).rows[0];
    await query(`INSERT INTO payroll_accruals(period_id,revision,user_id,branch_id,rule_version_id,base_salary,order_commission,work_commission,gross_profit_commission,kpi_bonus,adjustments,total,inputs,fingerprint,created_by)
      VALUES($1,1,2,$2,$3,0,10000,0,0,0,0,10000,'{}','snapshot-pnl',1)`,[period.id,branch,rule.id]);
    await query(`UPDATE payroll_periods SET status='CALCULATED',calculation_revision=1,input_cutoff=now(),totals='{"salary":10000}',snapshot_hash='snapshot-pnl',calculated_by=1,calculated_at=now() WHERE id=$1`,[period.id]);
    await query(`UPDATE payroll_periods SET status='APPROVED',approved_by=1,approved_at=now() WHERE id=$1`,[period.id]);

    const locked=await resolvePayrollExpense(pool,'2026-09-01','2026-10-01');
    assert.equal(locked.available,true);assert.equal(locked.locked_branches,1);assert.equal(Number(locked.amount),10000);

    await query(`INSERT INTO requests(number,customer_id,engineer_id,branch_id,status,complaint,total,direct_cost,paid,created_at,closed_at)
      VALUES('PNL-LATE',1,2,$1,'CLOSED','Late documented import',200000,40000,200000,'2026-09-10T08:00:00Z','2026-09-20T10:00:00Z')`,[branch]);
    const live=await calculatePayroll(pool,start,end,{branchId:branch});
    assert.equal(Number(live.rows.find(x=>Number(x.id)===2).salary),30000);
    const after=await resolvePayrollExpense(pool,'2026-09-01','2026-10-01');
    assert.equal(Number(after.amount),10000,'P&L payroll must remain the approved 10,000 ₸ snapshot');

    const partial=await resolvePayrollExpense(pool,'2026-09-10','2026-10-01');
    assert.equal(partial.available,false);assert.equal(partial.amount,null);assert.equal(partial.reason,'INCOMPLETE_PAYROLL_MONTH');
    await query(`INSERT INTO requests(number,customer_id,engineer_id,branch_id,status,complaint,total,direct_cost,paid,closed_at) VALUES
      ('PNL-BEFORE',1,2,$1,'CLOSED','Boundary',50000,10000,50000,'2026-08-31T18:59:59Z'),
      ('PNL-START',1,2,$1,'CLOSED','Boundary',20000,4000,20000,'2026-08-31T19:00:00Z'),
      ('PNL-END',1,2,$1,'CLOSED','Boundary',30000,6000,30000,'2026-09-30T18:59:59Z'),
      ('PNL-AFTER',1,2,$1,'CLOSED','Boundary',70000,14000,70000,'2026-09-30T19:00:00Z')`,[branch]);
    await query(`INSERT INTO payroll_rule_versions(user_id,effective_from,base_salary,order_percent,active,reason,created_by)
      VALUES(2,'2026-10-01',2000,10,true,'October fixture',1)`);
    await query("SET TIME ZONE 'Pacific/Honolulu'");
    const several=await resolvePayrollExpense(pool,'2026-09-01','2026-11-01');
    assert.equal(several.amount,19000,'September locked 10000 + October live 2000 base and 7000 local-boundary commission');
    assert.deepEqual(several.months.map(x=>x.month),['2026-09','2026-10']);
    await migrateFinance(pool);
    const app=await buildFinanceApp(pool,{logger:false,secret:'synthetic-pnl-range-test-secret'});
    try{
      const get=async query=>{const r=await app.inject({url:'/api/v1/pnl?'+query,headers:{authorization:'Bearer '+app.jwt.sign({id:1,role:'OWNER'})}});assert.equal(r.statusCode,200,r.body);return r.json().data;};
      const post=async(url,payload)=>{const r=await app.inject({method:'POST',url,headers:{authorization:'Bearer '+app.jwt.sign({id:1,role:'OWNER'}),'idempotency-key':'pnl-fixture-'+url.split('/').at(-1)+'-'+payload.occurred_at},payload});assert.equal(r.statusCode,201,r.body);return r.json().data;};
      const account=await post('/api/v1/accounts',{name:'PnL synthetic cash',type:'CASH',branch_id:branch,initial_amount:0});
      await post('/api/v1/transactions',{account_id:account.id,type:'INCOME',amount:50,occurred_at:'2026-09-01',category:'OTHER_INCOME',comment:'Synthetic income'});
      await post('/api/v1/transactions',{account_id:account.id,type:'EXPENSE',amount:20,occurred_at:'2026-09-30',category:'RENT',comment:'Synthetic expense'});
      const monthly=await get('month=2026-09');
      const ranged=await get('from=2026-09-01&to=2026-09-30');
      assert.equal(monthly.service_revenue,350000);assert.equal(monthly.direct_cost,70000);assert.equal(monthly.payroll,10000);assert.equal(monthly.net_profit,270030);assert.equal(monthly.other_income,50);assert.equal(monthly.operating_expenses,20);assert.equal(Number(monthly.expense_categories[0].amount),20);
      assert.deepEqual({...monthly,month:null},ranged);
      const day=await get('from=2026-09-30&to=2026-09-30');
      assert.equal(day.service_revenue,30000);assert.equal(day.payroll,null);assert.equal(day.net_profit,null);assert.equal(day.payroll_unavailable_reason,'INCOMPLETE_PAYROLL_MONTH');
      const period=await get('from=2026-09-01&to=2026-10-31');assert.equal(period.payroll,19000);assert.equal(period.service_revenue,420000);
    }finally{await app.close();}
  }finally{await db.close();}
});
