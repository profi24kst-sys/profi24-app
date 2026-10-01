import {calculatePayroll} from '../payroll-calculation.js';
import { reject,monthRange } from './service.js';
import {financePeriod} from './period.js';

const n=v=>Number(v||0);

export async function resolvePayrollExpense(pool,start,end) {
  // Approved payroll is monthly. There is no agreed daily allocation in its snapshot.
  if(!/^\d{4}-\d{2}-01$/.test(start)||!/^\d{4}-\d{2}-01$/.test(end)||start>=end)
    return {available:false,amount:null,locked_branches:0,live_branches:0,reason:'INCOMPLETE_PAYROLL_MONTH',months:[]};
  const months=[];
  for(let cursor=start;cursor<end;){
    const [,next]=monthRange(cursor.slice(0,7));
    const state=await resolveMonthPayroll(pool,cursor,next);
    months.push({month:cursor.slice(0,7),...state});cursor=next;
  }
  const available=months.every(x=>x.available);
  return {available,amount:available?Math.round(months.reduce((sum,x)=>sum+x.amount,0)*100)/100:null,
    locked_branches:months.reduce((sum,x)=>sum+x.locked_branches,0),live_branches:months.reduce((sum,x)=>sum+x.live_branches,0),
    reason:available?null:'PAYROLL_UNAVAILABLE',months};
}

async function resolveMonthPayroll(pool,start,end) {
  const period=financePeriod({month:start.slice(0,7)}),options={calendarStart:start,calendarEnd:end};
  const q=(s,p=[])=>pool.query(s,p);
  const tables=(await q("SELECT to_regclass('payroll_rules') rules,to_regclass('payroll_adjustments') adjustments,to_regclass('request_works') works,to_regclass('payroll_periods') periods,to_regclass('payroll_accruals') accruals,to_regclass('branches') branches")).rows[0];
  if(!tables.rules||!tables.adjustments||!tables.works)return{available:false,amount:null,locked_branches:0,live_branches:0};

  if(!tables.periods||!tables.accruals||!tables.branches){
    const live=(await calculatePayroll(pool,period.start,period.end,options)).totals.salary;
    return{available:true,amount:n(live),locked_branches:0,live_branches:0};
  }

  const month=String(start).slice(0,7)+'-01';
  const locked=(await q(`SELECT p.branch_id,COALESCE(sum(a.total),0)::numeric amount
    FROM payroll_periods p
    JOIN payroll_accruals a ON a.period_id=p.id AND a.revision=p.calculation_revision
    WHERE p.period_month=$1::date AND p.status IN ('APPROVED','PAID','CLOSED')
    GROUP BY p.branch_id`,[month])).rows;
  const lockedMap=new Map(locked.map(x=>[Number(x.branch_id),n(x.amount)]));
  const branches=(await q('SELECT id FROM branches WHERE active=true OR EXISTS(SELECT 1 FROM requests r WHERE r.branch_id=branches.id AND r.closed_at>=$1 AND r.closed_at<$2)',[period.start,period.end])).rows;

  let amount=[...lockedMap.values()].reduce((s,x)=>s+x,0),liveBranches=0;
  for(const b of branches){
    const id=Number(b.id);if(lockedMap.has(id))continue;
    amount+=n((await calculatePayroll(pool,period.start,period.end,{...options,branchId:id})).totals.salary);liveBranches++;
  }
  return{available:true,amount,locked_branches:lockedMap.size,live_branches:liveBranches};
}

export async function pnlRoute(app,pool) {
  const q=(s,p=[])=>pool.query(s,p);
  app.get('/api/v1/pnl',{preHandler:async req=>{
    try{await req.jwtVerify();}catch{reject('Требуется авторизация','UNAUTHORIZED',401);}
    if(!(await q("SELECT id FROM users WHERE id=$1 AND role IN ('OWNER','ACCOUNTANT') AND active=true",[req.user.id])).rows.length)reject('Финансовый результат доступен собственнику или бухгалтеру','FORBIDDEN',403);
  }},async req=>{
    const period=financePeriod(req.query),{dateStart:start,dateEnd:end}=period;
    const orders=(await q(`SELECT COALESCE(sum(total),0) revenue,COALESCE(sum(direct_cost),0) direct_cost FROM requests WHERE deleted_at IS NULL AND status='CLOSED' AND closed_at>=$1 AND closed_at<$2`,[period.start,period.end])).rows[0];
    const cash=(await q(`SELECT COALESCE(sum(amount) FILTER(WHERE type='INCOME'),0) other_income,COALESCE(sum(amount) FILTER(WHERE type='EXPENSE'),0) expenses FROM finance_pnl_transactions WHERE occurred_at>=$1 AND occurred_at<$2`,[start,end])).rows[0];
    const cats=(await q(`SELECT category,sum(amount) amount FROM finance_pnl_transactions WHERE type='EXPENSE' AND occurred_at>=$1 AND occurred_at<$2 GROUP BY category ORDER BY amount DESC`,[start,end])).rows;
    const payrollState=await resolvePayrollExpense(pool,start,end),payroll=payrollState.amount;
    const revenue=n(orders.revenue)+n(cash.other_income),gross=n(orders.revenue)-n(orders.direct_cost);
    return {data:{month:req.query?.from?null:String(start).slice(0,7),period:period.metadata,revenue,service_revenue:n(orders.revenue),other_income:n(cash.other_income),direct_cost:n(orders.direct_cost),gross_profit:gross,payroll:payrollState.available?payroll:null,payroll_available:payrollState.available,payroll_unavailable_reason:payrollState.reason,payroll_months:payrollState.months,payroll_locked_branches:payrollState.locked_branches,payroll_live_branches:payrollState.live_branches,operating_expenses:n(cash.expenses),net_profit:payrollState.available?revenue-n(orders.direct_cost)-payroll-n(cash.expenses):null,expense_categories:cats}};
  });
}
