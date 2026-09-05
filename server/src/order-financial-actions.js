import {FinanceError,fingerprint,id,money,text} from './finance/service.js';

const fail=(message,code='VALIDATION',statusCode=422)=>{throw new FinanceError(message,code,statusCode)};
const number=value=>Number(value||0);
export const cancellationCategories=new Set(['CUSTOMER_REFUSAL','DUPLICATE','NO_CONTACT','UNREPAIRABLE','PRICE_REJECTED','OTHER']);

export async function refundPayment(c,{paymentId,user,body={},key,digest=fingerprint({payment:paymentId,...body})}) {
  if(user?.role!=='OWNER')fail('Возврат оплаты доступен только OWNER','FORBIDDEN',403);
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[key]);
  const replay=(await c.query("SELECT * FROM payments WHERE idempotency_key=$1 AND kind='REFUND'",[key])).rows[0];
  if(replay){
    if(replay.request_fingerprint!==digest)fail('Номер возврата уже использован','IDEMPOTENCY_CONFLICT',409);
    const request=(await c.query('SELECT * FROM requests WHERE id=$1',[replay.request_id])).rows[0];
    return {...request,refund_id:replay.id,source_payment_id:replay.source_payment_id,refund_amount:replay.amount,replayed:true};
  }
  const source=(await c.query("SELECT * FROM payments WHERE id=$1 AND kind='PAYMENT' FOR UPDATE",[id(paymentId,'Исходная оплата')])).rows[0];
  if(!source)fail('Исходная оплата не найдена','NOT_FOUND',404);
  const request=(await c.query('SELECT * FROM requests WHERE id=$1 AND deleted_at IS NULL FOR UPDATE',[source.request_id])).rows[0];
  if(!request)fail('Заказ не найден','NOT_FOUND',404);
  const amount=money(body.amount),reason=text(body.reason,'Причина возврата',500),document=text(body.document_reference,'Документ возврата',200);
  const refunded=number((await c.query("SELECT COALESCE(sum(amount),0) amount FROM payments WHERE kind='REFUND' AND source_payment_id=$1",[source.id])).rows[0].amount);
  const available=number(source.amount)-refunded;
  if(number(amount)>available+0.001)fail(`Можно вернуть не больше ${available.toFixed(2)} ₸`,'REFUND_LIMIT',409);
  const refund=(await c.query(`INSERT INTO payments(request_id,amount,method,kind,reference,created_by,account_id,idempotency_key,request_fingerprint,reason,source_payment_id)
    VALUES($1,$2,$3,'REFUND',$4,$5,$6,$7,$8,$9,$10) RETURNING *`,[source.request_id,amount,source.method,document,user.id,source.account_id,key,digest,reason,source.id])).rows[0];
  const paid=Math.max(0,number((await c.query("SELECT COALESCE(sum(CASE WHEN kind='PAYMENT' THEN amount WHEN kind='REFUND' THEN -amount END),0) paid FROM payments WHERE request_id=$1",[source.request_id])).rows[0].paid));
  const status=request.status==='CLOSED'&&paid<number(request.total)-0.001?'PAYMENT_REQUIRED':request.status;
  const row=(await c.query("UPDATE requests SET paid=$1,status=$2,closed_at=CASE WHEN $2='CLOSED' THEN closed_at ELSE NULL END,updated_at=now() WHERE id=$3 RETURNING *",[paid,status,source.request_id])).rows[0];
  await c.query(`INSERT INTO request_history(request_id,user_id,action,details) VALUES($1,$2,'PAYMENT_REFUNDED',$3)`,[source.request_id,user.id,{payment_id:source.id,refund_id:refund.id,amount,account_id:source.account_id,reason,document_reference:document,reopened:request.status==='CLOSED'&&status!=='CLOSED'}]);
  return {...row,refund_id:refund.id,source_payment_id:source.id,refund_amount:refund.amount,replayed:false};
}

export async function cancellationReadiness(c,requestId,{lock=false}={}) {
  const request=(await c.query(`SELECT * FROM requests WHERE id=$1 AND deleted_at IS NULL${lock?' FOR UPDATE':''}`,[id(requestId,'Заказ')])).rows[0];
  if(!request)fail('Заказ не найден','NOT_FOUND',404);
  const [cash,parts,expenses,tasks]=await Promise.all([
    c.query("SELECT COALESCE(sum(CASE WHEN kind='PAYMENT' THEN amount WHEN kind='REFUND' THEN -amount ELSE 0 END),0) net FROM payments WHERE request_id=$1",[request.id]),
    c.query(`SELECT id,name,qty,purchase_price,purchase_reference FROM parts WHERE request_id=$1 AND payment_account_id IS NOT NULL AND returned_at IS NULL ORDER BY id`,[request.id]),
    c.query(`SELECT COALESCE(sum(f.amount),0) amount,count(*)::int count FROM finance_transactions f WHERE f.request_id=$1 AND f.kind IN ('ORDER_EXPENSE','MANUAL') AND f.type='EXPENSE' AND NOT EXISTS(SELECT 1 FROM finance_transactions rev WHERE rev.reversal_of=f.id)`,[request.id]),
    c.query("SELECT count(*)::int count FROM tasks WHERE request_id=$1 AND status NOT IN ('DONE','CANCELLED')",[request.id])
  ]);
  const netPaid=number(cash.rows[0].net),expenseAmount=number(expenses.rows[0].amount);
  return {request,net_paid:netPaid,unreturned_purchases:parts.rows,expense_amount:expenseAmount,expense_count:Number(expenses.rows[0].count||0),open_tasks:Number(tasks.rows[0].count||0),financially_ready:Math.abs(netPaid)<=0.01&&parts.rows.length===0};
}

export async function cancelOrder(c,{requestId,user,body={},key,digest=fingerprint({request:requestId,...body})}) {
  if(user?.role!=='OWNER')fail('Отмена заказа доступна только OWNER','FORBIDDEN',403);
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[key]);
  const replay=(await c.query('SELECT * FROM request_cancellations WHERE idempotency_key=$1',[key])).rows[0];
  if(replay){
    if(replay.request_fingerprint!==digest)fail('Номер отмены уже использован','IDEMPOTENCY_CONFLICT',409);
    const request=(await c.query('SELECT * FROM requests WHERE id=$1',[replay.request_id])).rows[0];
    return {request,cancellation:replay,replayed:true};
  }
  const readiness=await cancellationReadiness(c,requestId,{lock:true});
  if(readiness.request.status==='CANCELLED'){
    const cancellation=(await c.query('SELECT * FROM request_cancellations WHERE request_id=$1 ORDER BY id DESC LIMIT 1',[readiness.request.id])).rows[0];
    return {request:readiness.request,cancellation,replayed:true};
  }
  if(readiness.request.status==='CLOSED')fail('Сначала оформите возврат оплаты — закрытый заказ автоматически откроется','CLOSED_ORDER',409);
  if(Math.abs(readiness.net_paid)>0.01)fail(`Сначала верните клиенту ${readiness.net_paid.toFixed(2)} ₸`,'CUSTOMER_REFUND_REQUIRED',409);
  if(readiness.unreturned_purchases.length)fail('Сначала оформите возврат всех оплаченных покупок','PART_RETURN_REQUIRED',409);
  if(readiness.expense_amount>0&&body.acknowledge_expenses!==true)fail(`В заказе останутся документированные расходы ${readiness.expense_amount.toFixed(2)} ₸. Подтвердите их сохранение.`,'EXPENSE_ACKNOWLEDGEMENT_REQUIRED',409);
  const category=String(body.category||'');
  if(!cancellationCategories.has(category))fail('Выберите причину отмены');
  const reason=text(body.reason,'Описание причины отмены',500),document=text(body.document_reference,'Документ-основание',200);
  const snapshot={status:readiness.request.status,total:readiness.request.total,paid:readiness.request.paid,direct_cost:readiness.request.direct_cost,net_paid:readiness.net_paid,expense_amount:readiness.expense_amount,expense_count:readiness.expense_count,open_tasks:readiness.open_tasks};
  const cancellation=(await c.query(`INSERT INTO request_cancellations(request_id,previous_status,category,reason,document_reference,expense_amount,expenses_acknowledged,snapshot,created_by,idempotency_key,request_fingerprint)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,[readiness.request.id,readiness.request.status,category,reason,document,readiness.expense_amount,readiness.expense_amount===0||body.acknowledge_expenses===true,snapshot,user.id,key,digest])).rows[0];
  await c.query("SELECT set_config('app.order_cancel_request',$1,true)",[String(readiness.request.id)]);
  const request=(await c.query("UPDATE requests SET status='CANCELLED',cancelled_at=now(),closed_at=NULL,updated_at=now() WHERE id=$1 AND status=$2 RETURNING *",[readiness.request.id,readiness.request.status])).rows[0];
  if(!request)fail('Статус заказа изменился. Обновите страницу.','STATE_CONFLICT',409);
  await c.query("UPDATE tasks SET status='CANCELLED' WHERE request_id=$1 AND status NOT IN ('DONE','CANCELLED')",[request.id]);
  const relatedTables=(await c.query("SELECT to_regclass('public.dispatch_controls') dispatch_controls,to_regclass('public.owner_order_corrections') owner_order_corrections")).rows[0];
  if(relatedTables.dispatch_controls)await c.query("UPDATE dispatch_controls SET status='RESOLVED',resolution=COALESCE(resolution,'Заказ отменён'),resolved_at=COALESCE(resolved_at,now()),updated_by=$2,updated_at=now() WHERE request_id=$1 AND status='OPEN'",[request.id,user.id]);
  if(relatedTables.owner_order_corrections)await c.query("UPDATE owner_order_corrections SET active=false,closed_by=$2,closed_at=now(),close_reason='Заказ отменён' WHERE request_id=$1 AND active=true",[request.id,user.id]);
  await c.query(`INSERT INTO request_history(request_id,user_id,action,details) VALUES($1,$2,'REQUEST_CANCELLED',$3)`,[request.id,user.id,{cancellation_id:cancellation.id,previous_status:readiness.request.status,category,reason,document_reference:document,expense_amount:readiness.expense_amount,expenses_acknowledged:cancellation.expenses_acknowledged,cancelled_tasks:readiness.open_tasks}]);
  return {request,cancellation,replayed:false};
}
