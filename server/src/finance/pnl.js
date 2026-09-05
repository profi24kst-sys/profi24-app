import { reject,monthRange } from './service.js';

export async function pnlRoute(app,pool) {
  const q=(s,p=[])=>pool.query(s,p),n=v=>Number(v||0);
  app.get('/api/v1/pnl',{preHandler:async req=>{
    try{await req.jwtVerify();}catch{reject('Требуется авторизация','UNAUTHORIZED',401);}
    if(!(await q("SELECT id FROM users WHERE id=$1 AND role='OWNER' AND active=true",[req.user.id])).rows.length)reject('Финансовый результат доступен только OWNER','FORBIDDEN',403);
  }},async req=>{
    const [start,end]=monthRange(req.query?.month);
    const orders=(await q(`SELECT COALESCE(sum(total),0) revenue,COALESCE(sum(direct_cost),0) direct_cost FROM requests WHERE deleted_at IS NULL AND status='CLOSED' AND closed_at>=$1 AND closed_at<$2`,[start,end])).rows[0];
    const cash=(await q(`SELECT COALESCE(sum(amount) FILTER(WHERE type='INCOME'),0) other_income,COALESCE(sum(amount) FILTER(WHERE type='EXPENSE'),0) expenses FROM finance_pnl_transactions WHERE occurred_at>=$1 AND occurred_at<$2`,[start,end])).rows[0];
    const cats=(await q(`SELECT category,sum(amount) amount FROM finance_pnl_transactions WHERE type='EXPENSE' AND occurred_at>=$1 AND occurred_at<$2 GROUP BY category ORDER BY amount DESC`,[start,end])).rows;
    let payroll=0,payrollAvailable=false;
    const tables=(await q("SELECT to_regclass('payroll_rules') rules,to_regclass('payroll_adjustments') adjustments,to_regclass('request_works') works")).rows[0];
    if(tables.rules&&tables.adjustments&&tables.works){
      const users=(await q(`SELECT u.id,u.role,pr.* FROM payroll_rules pr JOIN users u ON u.id=pr.user_id WHERE pr.active=true AND u.active=true`)).rows;
      for(const user of users){
        const totals=(await q(`SELECT COALESCE(sum(r.total),0) revenue,COALESCE(sum(r.total-r.direct_cost),0) gross,
          COALESCE(sum((SELECT sum(w.qty*w.unit_price) FROM request_works w WHERE w.request_id=r.id)),0) work
          FROM requests r WHERE r.deleted_at IS NULL AND r.status='CLOSED' AND r.closed_at>=$1 AND r.closed_at<$2 AND ${user.role==='ENGINEER'?'r.engineer_id':'r.manager_id'}=$3`,[start,end,user.user_id])).rows[0];
        payroll+=n(user.base_salary)+n(totals.revenue)*n(user.order_percent)/100+n(totals.gross)*n(user.gross_profit_percent)/100+n(totals.work)*n(user.work_percent)/100;
      }
      payroll+=n((await q('SELECT COALESCE(sum(amount),0) amount FROM payroll_adjustments WHERE period_month>=$1 AND period_month<$2',[start,end])).rows[0].amount);
      payrollAvailable=true;
    }
    const revenue=n(orders.revenue)+n(cash.other_income),gross=n(orders.revenue)-n(orders.direct_cost);
    return {data:{month:start.slice(0,7),revenue,service_revenue:n(orders.revenue),other_income:n(cash.other_income),direct_cost:n(orders.direct_cost),gross_profit:gross,payroll:payrollAvailable?payroll:null,payroll_available:payrollAvailable,operating_expenses:n(cash.expenses),net_profit:payrollAvailable?revenue-n(orders.direct_cost)-payroll-n(cash.expenses):null,expense_categories:cats}};
  });
}
