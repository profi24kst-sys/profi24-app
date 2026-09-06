import {accessError} from './access.js';
const n=v=>Number(v||0);
const money=v=>Math.round((Number(v||0)+Number.EPSILON)*100)/100;
export function payrollPeriod(value) {
  const month=value==null?new Date().toISOString().slice(0,7):String(value);
  if(!/^\d{4}-\d{2}(?:-01)?$/.test(month)||Number(month.slice(5,7))<1||Number(month.slice(5,7))>12)
    throw accessError('VALIDATION','Месяц должен быть в формате ГГГГ-ММ',422);
  const start=new Date(month.slice(0,7)+'-01T00:00:00Z');
  return [start,new Date(Date.UTC(start.getUTCFullYear(),start.getUTCMonth()+1,1))];
}

async function versionedUsers(c,start,branchId=null){
  const params=[start];let branch='';
  if(branchId){params.push(branchId);branch=` AND u.primary_branch_id=$${params.length}`;}
  return (await c.query(`SELECT u.id,u.name,u.email,u.role,u.active,u.primary_branch_id,
    rv.id rule_version_id,COALESCE(rv.base_salary,0) base_salary,COALESCE(rv.order_percent,0) order_percent,
    COALESCE(rv.work_percent,0) work_percent,COALESCE(rv.gross_profit_percent,0) gross_profit_percent,
    COALESCE(rv.active,false) rule_active
    FROM users u
    LEFT JOIN LATERAL (
      SELECT v.* FROM payroll_rule_versions v
      WHERE v.user_id=u.id AND v.effective_from<=$1::date
      ORDER BY v.effective_from DESC,v.id DESC LIMIT 1
    ) rv ON true
    WHERE 1=1${branch}
    ORDER BY u.role,u.name`,params)).rows;
}

// Single source for live preview, payroll snapshots, P&L and order profitability.
// branchId limits both employee ownership (primary branch) and orders used for commissions.
export async function calculatePayroll(c,start,end,{branchId=null}={}) {
  const users=await versionedUsers(c,start,branchId);
  const orderParams=[start,end];let orderBranch='';
  if(branchId){orderParams.push(branchId);orderBranch=` AND branch_id=$${orderParams.length}`;}
  const orders=(await c.query(`SELECT id,branch_id,engineer_id,manager_id,total,direct_cost FROM requests
    WHERE deleted_at IS NULL AND status='CLOSED' AND closed_at>=$1 AND closed_at<$2${orderBranch}`,orderParams)).rows;
  const workParams=[start,end];let workBranch='';
  if(branchId){workParams.push(branchId);workBranch=` AND r.branch_id=$${workParams.length}`;}
  const works=(await c.query(`SELECT w.request_id,COALESCE(w.performed_by,r.engineer_id) user_id,sum(w.qty*w.unit_price) sales
    FROM request_works w JOIN requests r ON r.id=w.request_id
    WHERE r.deleted_at IS NULL AND r.status='CLOSED' AND r.closed_at>=$1 AND r.closed_at<$2${workBranch}
    GROUP BY w.request_id,COALESCE(w.performed_by,r.engineer_id)`,workParams)).rows;
  const adjustmentParams=[start,end];let adjustmentBranch='';
  if(branchId){adjustmentParams.push(branchId);adjustmentBranch=` AND branch_id=$${adjustmentParams.length}`;}
  const adjustments=(await c.query(`SELECT user_id,sum(amount) amount FROM payroll_adjustments
    WHERE period_month>=$1 AND period_month<$2${adjustmentBranch} GROUP BY user_id`,adjustmentParams)).rows;
  const kpiParams=[start];let kpiBranch='';
  if(branchId){kpiParams.push(branchId);kpiBranch=` AND branch_id=$${kpiParams.length}`;}
  const kpi=(await c.query(`SELECT DISTINCT ON(user_id) id,user_id,bonus_amount,score FROM kpi_result_snapshots
    WHERE period_month=$1::date AND status='APPROVED'${kpiBranch}
    ORDER BY user_id,revision DESC,id DESC`,kpiParams)).rows;

  const wm=new Map(works.map(w=>[w.request_id+':'+w.user_id,n(w.sales)]));
  const am=new Map(adjustments.map(a=>[Number(a.user_id),n(a.amount)]));
  const km=new Map(kpi.map(x=>[Number(x.user_id),x]));
  const allocations=new Map(orders.map(o=>[o.id,{engineer_commission:0,manager_commission:0,commission:0}]));
  const rows=users.map(u=>{
    let jobs=0,revenue=0,gross_profit=0,work_sales=0,order_commission=0,work_commission=0,gross_profit_commission=0;
    for(const o of orders){
      const assigned=u.role==='ENGINEER'?Number(o.engineer_id)===Number(u.id):u.role==='MANAGER'?Number(o.manager_id)===Number(u.id):false;
      const sales=wm.get(o.id+':'+u.id)||0;
      const orderPart=u.rule_active&&assigned?money(n(o.total)*n(u.order_percent)/100):0;
      const workPart=u.rule_active&&sales?money(sales*n(u.work_percent)/100):0;
      const grossPart=u.rule_active&&assigned?money((n(o.total)-n(o.direct_cost))*n(u.gross_profit_percent)/100):0;
      if(assigned){jobs++;revenue+=n(o.total);gross_profit+=n(o.total)-n(o.direct_cost)}
      work_sales+=sales;order_commission+=orderPart;work_commission+=workPart;gross_profit_commission+=grossPart;
      const a=allocations.get(o.id),amount=orderPart+workPart+grossPart;
      a.commission+=amount;
      if(u.role==='ENGINEER')a.engineer_commission+=amount;
      if(u.role==='MANAGER')a.manager_commission+=amount;
    }
    const adjustment=u.rule_active?(am.get(Number(u.id))||0):0;
    const kpiRow=km.get(Number(u.id));
    const kpiBonus=u.rule_active?money(kpiRow?.bonus_amount||0):0;
    const base=u.rule_active?n(u.base_salary):0;
    const salary=money(base+order_commission+work_commission+gross_profit_commission+kpiBonus+adjustment);
    return {...u,jobs,revenue:money(revenue),gross_profit:money(gross_profit),work_sales:money(work_sales),
      order_commission:money(order_commission),work_commission:money(work_commission),gross_profit_commission:money(gross_profit_commission),
      kpi_result_id:kpiRow?.id||null,kpi_score:kpiRow?Number(kpiRow.score):null,kpi_bonus:kpiBonus,adjustments:money(adjustment),salary};
  });
  const totals={salary:money(rows.reduce((s,u)=>s+u.salary,0)),jobs:orders.length,
    revenue:money(orders.reduce((s,o)=>s+n(o.total),0)),gross_profit:money(orders.reduce((s,o)=>s+n(o.total)-n(o.direct_cost),0)),
    kpi_bonus:money(rows.reduce((s,u)=>s+n(u.kpi_bonus),0)),adjustments:money(rows.reduce((s,u)=>s+n(u.adjustments),0))};

  const base=money(rows.reduce((s,u)=>s+(u.rule_active?n(u.base_salary):0),0));
  const adjustment=money(rows.reduce((s,u)=>s+n(u.adjustments)+n(u.kpi_bonus),0));
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
