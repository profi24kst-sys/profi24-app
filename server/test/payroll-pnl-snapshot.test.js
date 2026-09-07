import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {migrateCore} from '../src/migrate.js';
import {calculatePayroll,payrollPeriod} from '../src/payroll-calculation.js';
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
  }finally{await db.close();}
});
