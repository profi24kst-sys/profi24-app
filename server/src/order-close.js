export class OrderCloseError extends Error {
  constructor(message,code='CLOSE_BLOCKED',statusCode=409){super(message);Object.assign(this,{code,statusCode});}
}

export function assertCloseReady(state){
  if(state.status!=='PAYMENT_REQUIRED')throw new OrderCloseError('Заказ ещё не готов к закрытию','STATE_CONFLICT');
  if(Number(state.paid)+0.001<Number(state.total))throw new OrderCloseError(`Не оплачено ${(Number(state.total)-Number(state.paid)).toLocaleString('ru-RU')} ₸`,'PAYMENT_REQUIRED');
  if(Number(state.paid)>Number(state.total)+0.01)throw new OrderCloseError(`Обнаружена переплата ${(Number(state.paid)-Number(state.total)).toLocaleString('ru-RU')} ₸. Оформите возврат клиенту или проверьте сумму заказа`,'OVERPAYMENT_REQUIRES_REVIEW');
  if(!state.repair_result?.trim()||!state.parts_posted)throw new OrderCloseError('Сначала зафиксируйте выполненный ремонт и списание деталей','REPAIR_COMPLETION_REQUIRED');
  if(!state.test_result?.trim())throw new OrderCloseError('Сначала сохраните результат контрольной проверки','TEST_REQUIRED');
  if(Number(state.after_photos)<1)throw new OrderCloseError('Добавьте хотя бы одно фото после ремонта','PHOTO_REQUIRED');
  if(Number(state.client_signatures)<1)throw new OrderCloseError('Нужна подпись клиента','CLIENT_SIGNATURE_REQUIRED');
}

export async function closeOrder(c,{requestId,userId}){
  const request=(await c.query('SELECT * FROM requests WHERE id=$1 AND deleted_at IS NULL FOR UPDATE',[requestId])).rows[0];
  if(!request)throw new OrderCloseError('Заявка не найдена','NOT_FOUND',404);
  const completion=(await c.query('SELECT * FROM repair_completions WHERE request_id=$1 FOR UPDATE',[request.id])).rows[0];
  const counts=(await c.query(`SELECT
    (SELECT count(*) FROM request_files WHERE request_id=$1 AND kind IN ('AFTER','PHOTO_AFTER'))::int after_photos,
    (SELECT count(*) FROM request_signatures WHERE request_id=$1 AND signer_type='CLIENT')::int client_signatures`,[request.id])).rows[0];
  assertCloseReady({...request,...completion,...counts});
  let warranty=90;
  const optional=(await c.query("SELECT to_regclass('request_quote_lines') quote_lines,to_regclass('pricebook') pricebook")).rows[0];
  if(optional.quote_lines&&optional.pricebook){
    const value=(await c.query(`SELECT max(pb.warranty_days)::int days FROM request_quote_lines l JOIN pricebook pb ON pb.id=l.ref_id WHERE l.request_id=$1 AND l.line_type='WORK'`,[request.id])).rows[0];
    if(Number(value?.days)>0)warranty=Number(value.days);
  }
  await c.query("SELECT set_config('app.completion_close_request',$1,true)",[String(request.id)]);
  const closed=(await c.query(`UPDATE requests SET status='CLOSED',closed_at=now(),warranty_until=CURRENT_DATE+$1::int,updated_at=now()
    WHERE id=$2 AND status='PAYMENT_REQUIRED' AND deleted_at IS NULL RETURNING closed_at,warranty_until`,[warranty,request.id])).rows[0];
  if(!closed)throw new OrderCloseError('Статус заказа изменился. Обновите данные','STATE_CONFLICT');
  await c.query('UPDATE repair_completions SET warranty_days=$1,closed_at=now(),updated_at=now() WHERE request_id=$2',[warranty,request.id]);
  const documents=[];
  for(const [index,type] of ['COMPLETION_ACT','WARRANTY'].entries()){
    const number=`${type}-${request.id}-${Date.now().toString().slice(-8)}-${index+1}`;
    const row=(await c.query(`INSERT INTO generated_documents(request_id,document_type,document_number,created_by)
      SELECT $1,$2,$3,$4 WHERE NOT EXISTS(SELECT 1 FROM generated_documents WHERE request_id=$1 AND document_type=$2) RETURNING document_type`,[request.id,type,number,userId])).rows[0];
    if(row)documents.push(row.document_type);
  }
  await c.query(`INSERT INTO request_history(request_id,user_id,action,details) VALUES($1,$2,'REQUEST_CLOSED',$3)`,[request.id,userId,{warranty_days:warranty,paid:request.paid,total:request.total,checks:{repair:true,test:true,after_photos:counts.after_photos,client_signature:true},documents}]);
  return {status:'CLOSED',closed_at:closed.closed_at,warranty_days:warranty,warranty_until:closed.warranty_until,documents};
}
