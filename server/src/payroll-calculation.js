import {accessError} from './access.js';
const n=v=>Number(v||0);
const money=v=>Math.round((v+Number.EPSILON)*100)/100;
export function payrollPeriod(value) {
  const month=value==null?new Date().toISOString().slice(0,7):String(value);
  if(!/^\d{4}-\d{2}(?:-01)?$/.test(month)||Number(month.slice(5,7))<1||Number(month.slice(5,7))>12)
    throw accessError('VALIDATION','Месяц должен быть в формате ГГГГ-ММ',422);
  const start=new Date(month.slice(0,7)+'-01T00:00:00Z');
  return [start,new Date(Date.UTC(start.getUTCFullYear(),start.getUTCMonth()+1,1))];
}

// The salary screen, P&L and order profitability consume the same accrual calculation.
export async function calculatePayroll(c,start,end) {
  const users=(await c.query(`SELECT u.id,u.name,u.role,u.active,
    COALESCE(pr.base_salary,0) base_salary,COALESCE(pr.order_percent,0) order_percent,
    COALESCE(pr.work_percent,0) work_percent,COALESCE(pr.gross_profit_percent,0) gross_profit_percent,
    COALESCE(pr.active,true) rule_active
    FROM users u LEFT JOIN payroll_rules pr ON pr.user_id=u.id ORDER BY u.role,u.name`)).rows;
  const orders=(await c.query(`SELECT id,engineer_id,manager_id,total,direct_cost FROM requests
    WHERE deleted_at IS NULL AND status='CLOSED' AND closed_at>=$1 AND closed_at<$2`,[start,end])).rows;
  const works=(await c.query(`SELECT w.request_id,COALESCE(w.performed_by,r.engineer_id) user_id,sum(w.qty*w.unit_price) sales
    FROM request_works w JOIN requests r ON r.id=w.request_id WHERE r.deleted_at IS NULL AND r.status='CLOSED'
    AND r.closed_at>=$1 AND r.closed_at<$2 GROUP BY w.request_id,COALESCE(w.performed_by,r.engineer_id)`,[start,end])).rows;
  const adjustments=(await c.query(`SELECT user_id,sum(amount) amount FROM payroll_adjustments
    WHERE period_month>=$1 AND period_month<$2 GROUP BY user_id`,[start,end])).rows;
  const wm=new Map(works.map(w=>[w.request_id+':'+w.user_id,n(w.sales)]));
  const am=new Map(adjustments.map(a=>[a.user_id,n(a.amount)]));
  const allocations=new Map(orders.map(o=>[o.id,{engineer_commission:0,manager_commission:0,commission:0}]));
  const rows=users.map(u=>{
    let jobs=0,revenue=0,gross_profit=0,work_sales=0,order_commission=0,work_commission=0,gross_profit_commission=0;
    for(const o of orders){
      const assigned=Number(u.role==='ENGINEER'?o.engineer_id:o.manager_id)===Number(u.id);
      const sales=wm.get(o.id+':'+u.id)||0;
      const orderPart=u.rule_active&&assigned?money(n(o.total)*n(u.order_percent)/100):0;
      const workPart=u.rule_active?money(sales*n(u.work_percent)/100):0;
      const grossPart=u.rule_active&&assigned?money((n(o.total)-n(o.direct_cost))*n(u.gross_profit_percent)/100):0;
      if(assigned){jobs++;revenue+=n(o.total);gross_profit+=n(o.total)-n(o.direct_cost)}
      work_sales+=sales;order_commission+=orderPart;work_commission+=workPart;gross_profit_commission+=grossPart;
      const a=allocations.get(o.id),amount=orderPart+workPart+grossPart;
      a.commission+=amount;
      a[u.role==='ENGINEER'?'engineer_commission':'manager_commission']+=amount;
    }
    const adjustment=u.rule_active?(am.get(u.id)||0):0;
    return {...u,jobs,revenue,gross_profit,work_sales,order_commission:money(order_commission),work_commission:money(work_commission),
      gross_profit_commission:money(gross_profit_commission),adjustments:adjustment,
      salary:money((u.rule_active?n(u.base_salary):0)+order_commission+work_commission+gross_profit_commission+adjustment)};
  });
  const totals={salary:money(rows.reduce((s,u)=>s+u.salary,0)),jobs:orders.length,
    revenue:money(orders.reduce((s,o)=>s+n(o.total),0)),gross_profit:money(orders.reduce((s,o)=>s+n(o.total)-n(o.direct_cost),0))};
  const base=money(rows.reduce((s,u)=>s+(u.rule_active?n(u.base_salary):0),0));
  const adjustment=money(rows.reduce((s,u)=>s+u.adjustments,0));
  let baseRemaining=Math.round(base*100),adjustmentRemaining=Math.round(adjustment*100);
  orders.forEach((o,i)=>{
    const last=i===orders.length-1;
    const baseShare=last?baseRemaining:Math.round(base*100/orders.length);
    const adjustmentShare=last?adjustmentRemaining:Math.round(adjustment*100/orders.length);
    baseRemaining-=baseShare;adjustmentRemaining-=adjustmentShare;
    const a=allocations.get(o.id);a.base_salary_allocated=baseShare/100;a.adjustments_allocated=adjustmentShare/100;
    a.payroll_allocated=money(a.commission+a.base_salary_allocated+a.adjustments_allocated);
  });
  return {rows,totals,allocations,unallocated_payroll:orders.length?0:totals.salary};
}
