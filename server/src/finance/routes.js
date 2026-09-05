import { randomUUID } from 'node:crypto';
import { reject,money,text,id,date,today,monthRange,fingerprint,operationKey,transaction,lockAccounts,requestAccess,insertEntry,replay,createTransfer,recalcParts } from './service.js';

export async function financeRoutes(app,pool) {
  const q=(s,p=[])=>pool.query(s,p);
  const auth=async req=>{
    try{await req.jwtVerify();}catch{reject('Требуется авторизация','UNAUTHORIZED',401);}
    const user=(await q('SELECT id,name,role FROM users WHERE id=$1 AND active=true',[req.user.id])).rows[0];
    if(!user)reject('Пользователь неактивен','FORBIDDEN',403);
    req.user=user;
  };
  const owner=async req=>{await auth(req);if(req.user.role!=='OWNER')reject('Доступно только OWNER','FORBIDDEN',403);};
  const allowedSql=`($1::text='OWNER' OR a.responsible_id=$2)`;
  app.get('/health',async()=>{await q('SELECT 1');return {ok:true,service:'profi24-finance',version:'2.0-audit'};});
  app.get('/api/v1/accounts',{preHandler:auth},async req=>({data:(await q(`SELECT a.*,u.name responsible_name FROM finance_account_balances a LEFT JOIN users u ON u.id=a.responsible_id WHERE ${allowedSql} ORDER BY a.is_active DESC,a.id`,[req.user.role,req.user.id])).rows}));
  app.get('/api/v1/categories',{preHandler:auth},async()=>({data:(await q('SELECT * FROM finance_categories ORDER BY type,name')).rows}));
  app.get('/api/v1/responsibles',{preHandler:owner},async()=>({data:(await q('SELECT id,name,role,active FROM users ORDER BY active DESC,name')).rows}));

  app.post('/api/v1/accounts',{preHandler:owner},async(req,reply)=>{
    const b=req.body||{},name=text(b.name,'Название',120),type=text(b.type,'Тип'),responsible=b.responsible_id?id(b.responsible_id,'Ответственный'):null;
    if(!['BANK','CARD','CASH','ADVANCE','OTHER'].includes(type))reject('Неизвестный тип счёта');
    const initial=money(b.initial_amount??0,{signed:true,zero:true}),key=operationKey(req),digest=fingerprint(b);
    const result=await transaction(pool,req.user,async c=>{
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[key]);
      const previous=(await c.query('SELECT * FROM finance_accounts WHERE creation_key=$1',[key])).rows[0];
      if(previous){if(previous.creation_fingerprint!==digest)reject('Номер создания счёта уже использован','IDEMPOTENCY_CONFLICT',409);return previous;}
      const a=(await c.query(`INSERT INTO finance_accounts(name,type,responsible_id,comment,created_by,creation_key,creation_fingerprint) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,[name,type,responsible,String(b.comment||'').slice(0,1000),req.user.id,key,digest])).rows[0];
      if(Number(initial)!==0)await insertEntry(c,req.user,{account_id:a.id,type:initial.startsWith('-')?'EXPENSE':'INCOME',kind:'OPENING',category:'OPENING',amount:initial.replace('-',''),comment:text(b.initial_reason,'Основание начального остатка'),document_reference:b.document_reference||null,idempotency_key:key,metadata:{fingerprint:digest}});
      return a;
    });return reply.code(201).send({data:result});
  });
  app.patch('/api/v1/accounts/:id',{preHandler:owner},async req=>{
    const b=req.body||{};
    const allowed=new Set(['name','type','responsible_id','comment','is_active']);
    if(Object.keys(b).some(k=>!allowed.has(k)))reject('В настройках счёта нельзя изменять остаток. Используйте корректировку.');
    return {data:await transaction(pool,req.user,async c=>{
      const [a]=await lockAccounts(c,[req.params.id],req.user,{active:false});
      const merged={...a,...b};
      if(typeof merged.is_active!=='boolean')reject('Некорректная активность счёта');
      return (await c.query(`UPDATE finance_accounts SET name=$1,type=$2,responsible_id=$3,comment=$4,is_active=$5,updated_at=now() WHERE id=$6 RETURNING *`,[
        text(merged.name,'Название',120),text(merged.type,'Тип'),merged.responsible_id?id(merged.responsible_id,'Ответственный'):null,String(merged.comment||'').slice(0,1000),merged.is_active,a.id])).rows[0];
    })};
  });
  app.post('/api/v1/accounts/:id/adjustments',{preHandler:owner},async(req,reply)=>{
    const b=req.body||{},key=operationKey(req),digest=fingerprint({account:req.params.id,...b}),delta=money(b.delta,{signed:true});
    const result=await transaction(pool,req.user,async c=>{
      const prev=await replay(c,key,digest);if(prev)return prev;
      const [a]=await lockAccounts(c,[req.params.id],req.user);
      return insertEntry(c,req.user,{account_id:a.id,type:delta.startsWith('-')?'EXPENSE':'INCOME',kind:'ADJUSTMENT',category:'ADJUSTMENT',amount:delta.replace('-',''),occurred_at:date(b.occurred_at),comment:text(b.reason,'Причина корректировки'),document_reference:text(b.document_reference,'Документ-основание',200),idempotency_key:key,metadata:{fingerprint:digest}});
    });return reply.code(201).send({data:result});
  });

  app.get('/api/v1/transactions',{preHandler:auth},async req=>{
    const [start,end]=monthRange(req.query?.month),account=req.query?.account_id?id(req.query.account_id):null;
    const page=Math.max(1,Math.min(100000,Number(req.query?.page)||1)),limit=50;
    if(!Number.isInteger(page))reject('Некорректная страница');
    if(account){const a=(await q(`SELECT a.id FROM finance_accounts a WHERE a.id=$3 AND ${allowedSql}`,[req.user.role,req.user.id,account])).rows[0];if(!a)reject('Нет доступа к счёту','FORBIDDEN',403);}
    const params=[req.user.role,req.user.id,account,start,end];
    const rows=(await q(`WITH ledger AS (
      SELECT f.*,a.name account_name,r.number request_number,u.name created_by_name,res.name responsible_name,
      sum(CASE WHEN f.type='INCOME' THEN f.amount ELSE -f.amount END) OVER(PARTITION BY f.account_id ORDER BY f.id) balance_after,
      (SELECT rev.id FROM finance_transactions rev WHERE rev.reversal_of=f.id) reversed_by
      FROM finance_transactions f JOIN finance_accounts a ON a.id=f.account_id
      LEFT JOIN requests r ON r.id=f.request_id LEFT JOIN users u ON u.id=f.created_by LEFT JOIN users res ON res.id=f.responsible_id
      WHERE ${allowedSql} AND ($3::int IS NULL OR a.id=$3)
    ) SELECT * FROM ledger WHERE occurred_at>=$4 AND occurred_at<$5 AND ($8::boolean=false OR transfer_group_id IS NOT NULL) ORDER BY id DESC LIMIT $6 OFFSET $7`,[...params,limit+1,(page-1)*limit,req.query?.transfers==='true'])).rows;
    const summary=(await q(`SELECT
      COALESCE(sum(CASE WHEN f.type='INCOME' THEN f.amount ELSE -f.amount END) FILTER(WHERE occurred_at<$4),0) opening,
      COALESCE(sum(CASE WHEN f.type='INCOME' THEN f.amount ELSE -f.amount END) FILTER(WHERE occurred_at<$5),0) closing,
      COALESCE(sum(f.amount) FILTER(WHERE occurred_at>=$4 AND occurred_at<$5 AND f.type='INCOME'),0) income,
      COALESCE(sum(f.amount) FILTER(WHERE occurred_at>=$4 AND occurred_at<$5 AND f.type='EXPENSE'),0) expense
      FROM finance_transactions f JOIN finance_accounts a ON a.id=f.account_id WHERE ${allowedSql} AND ($3::int IS NULL OR a.id=$3)`,params)).rows[0];
    return {data:{rows:rows.slice(0,limit),has_more:rows.length>limit,page,summary}};
  });

  async function postExpense(req,reply,requestId=null) {
    const b=req.body||{},key=operationKey(req),digest=fingerprint({request:requestId,...b});
    const result=await transaction(pool,req.user,async c=>{
      const prev=await replay(c,key,digest);if(prev)return prev;
      if(requestId)await requestAccess(c,requestId,req.user,{write:true});
      const [account]=await lockAccounts(c,[b.account_id],req.user);
      const type=requestId?'EXPENSE':b.type;
      if(!['INCOME','EXPENSE'].includes(type))reject('Выберите приход или расход');
      const category=text(b.category,'Категория',100);
      if(category==='PARTS')reject('Покупку детали оформляйте в разделе «Запчасти», чтобы не удвоить себестоимость');
      return insertEntry(c,req.user,{account_id:account.id,type,kind:requestId?'ORDER_EXPENSE':'MANUAL',request_id:requestId,category,
        amount:money(b.amount),occurred_at:date(b.occurred_at),comment:text(b.comment,'Назначение'),document_reference:b.document_reference||null,counterparty:b.counterparty||null,idempotency_key:key,metadata:{fingerprint:digest}});
    });return reply.code(201).send({data:result});
  }
  app.post('/api/v1/transactions',{preHandler:owner},(req,reply)=>postExpense(req,reply,req.body?.request_id?id(req.body.request_id,'Заказ'):null));
  app.post('/api/v1/requests/:id/expenses',{preHandler:auth},(req,reply)=>postExpense(req,reply,id(req.params.id,'Заказ')));
  app.get('/api/v1/requests/:id/expenses',{preHandler:auth},async req=>({data:await transaction(pool,req.user,async c=>{
    await requestAccess(c,req.params.id,req.user);
    return (await c.query(`SELECT f.*,a.name account_name,u.name created_by_name,
      (SELECT rev.id FROM finance_transactions rev WHERE rev.reversal_of=f.id) reversed_by
      FROM finance_transactions f JOIN finance_accounts a ON a.id=f.account_id LEFT JOIN users u ON u.id=f.created_by
      WHERE f.request_id=$3 AND f.kind IN ('ORDER_EXPENSE','MANUAL') AND f.type='EXPENSE' AND ${allowedSql} ORDER BY f.id DESC`,[req.user.role,req.user.id,req.params.id])).rows;
  })}));

  app.get('/api/v1/requests/:id/part-purchases',{preHandler:auth},async req=>({data:await transaction(pool,req.user,async c=>{
    await requestAccess(c,req.params.id,req.user);
    return (await c.query(`SELECT f.id,f.part_id,f.amount,f.created_at,f.document_reference,p.return_reason,a.name account_name,u.name created_by_name,
      rev.id return_transaction_id,rev.created_at returned_at,rev.document_reference return_document_reference,ru.name returned_by_name
      FROM finance_transactions f JOIN parts p ON p.id=f.part_id JOIN finance_accounts a ON a.id=f.account_id LEFT JOIN users u ON u.id=f.created_by
      LEFT JOIN finance_transactions rev ON rev.reversal_of=f.id AND rev.kind='PART_RETURN' LEFT JOIN users ru ON ru.id=rev.created_by
      WHERE f.request_id=$3 AND f.kind='PART_PURCHASE' AND ${allowedSql} ORDER BY f.id DESC`,[req.user.role,req.user.id,req.params.id])).rows;
  })}));

  app.post('/api/v1/requests/:id/part-purchases',{preHandler:auth},async(req,reply)=>{
    const b=req.body||{},key=operationKey(req),digest=fingerprint({request:req.params.id,...b});
    const result=await transaction(pool,req.user,async c=>{
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[key]);
      const existing=(await c.query('SELECT * FROM parts WHERE purchase_idempotency_key=$1',[key])).rows[0];
      if(existing){const entry=(await c.query('SELECT metadata FROM finance_transactions WHERE part_id=$1',[existing.id])).rows[0];if(existing.purchase_fingerprint!==digest)reject('Номер покупки уже использован','IDEMPOTENCY_CONFLICT',409);return existing;}
      const request=await requestAccess(c,req.params.id,req.user,{write:true});
      await lockAccounts(c,[b.account_id],req.user);
      const part=(await c.query(`INSERT INTO parts(request_id,name,qty,purchase_price,sale_price,supplier,status,created_by,payment_account_id,purchase_reference,purchase_idempotency_key,purchase_fingerprint)
        VALUES($1,$2,$3,$4,$5,$6,'RECEIVED',$7,$8,$9,$10,$11) RETURNING *`,[
        request.id,text(b.name,'Название запчасти',200),money(b.qty??1),money(b.purchase_price),money(b.sale_price??0,{zero:true}),b.supplier||null,req.user.id,id(b.account_id),text(b.document_reference,'Чек / документ покупки',200),key,digest])).rows[0];
      await recalcParts(c,request.id);return part;
    });return reply.code(201).send({data:result});
  });

  app.post('/api/v1/requests/:requestId/part-purchases/:partId/return',{preHandler:owner},async(req,reply)=>{
    const b=req.body||{},reason=text(b.reason,'Причина возврата',500),document=text(b.document_reference,'Документ возврата',200);
    const key=operationKey(req),digest=fingerprint({request:req.params.requestId,part:req.params.partId,...b});
    const result=await transaction(pool,req.user,async c=>{
      const previous=await replay(c,key,digest);if(previous)return previous;
      const request=await requestAccess(c,req.params.requestId,req.user,{write:true});
      const row=(await c.query(`SELECT p.*,f.id purchase_transaction_id,f.amount purchase_amount,f.account_id
        FROM parts p JOIN finance_transactions f ON f.part_id=p.id AND f.kind='PART_PURCHASE'
        WHERE p.id=$1 AND p.request_id=$2 FOR UPDATE OF p,f`,[id(req.params.partId,'Запчасть'),request.id])).rows[0];
      if(!row)reject('Оплаченная покупка не найдена','NOT_FOUND',404);
      if(row.returned_at)reject('Покупка уже возвращена','ALREADY_RETURNED',409);
      if(['ISSUED','INSTALLED'].includes(row.status))reject('Установленную или выданную деталь сначала нужно снять с ремонта','PART_IN_USE',409);
      await lockAccounts(c,[row.account_id],req.user,{active:false});
      const entry=await insertEntry(c,req.user,{account_id:row.account_id,type:'INCOME',kind:'PART_RETURN',category:'PARTS',amount:row.purchase_amount,
        request_id:request.id,part_id:row.id,reversal_of:row.purchase_transaction_id,comment:'Возврат покупки «'+row.name+'»: '+reason,
        document_reference:document,idempotency_key:key,metadata:{fingerprint:digest,reason}});
      await c.query(`UPDATE parts SET status='CANCELLED',returned_at=now(),return_reason=$1,return_document_reference=$2,returned_by=$3 WHERE id=$4`,[reason,document,req.user.id,row.id]);
      await recalcParts(c,request.id);
      await c.query(`INSERT INTO request_history(request_id,user_id,action,details) VALUES($1,$2,'PART_PURCHASE_RETURNED',$3)`,[request.id,req.user.id,{part_id:row.id,purchase_transaction_id:row.purchase_transaction_id,return_transaction_id:entry.id,amount:row.purchase_amount,reason,document_reference:document}]);
      return entry;
    });return reply.code(201).send({data:result});
  });

  app.post('/api/v1/transfers',{preHandler:owner},async(req,reply)=>{
    const key=operationKey(req),digest=fingerprint(req.body||{});
    const result=await transaction(pool,req.user,async c=>(await replay(c,key,digest))||createTransfer(c,req.user,req.body||{},key,digest));
    return reply.code(201).send({data:result});
  });
  app.post('/api/v1/transactions/:id/reverse',{preHandler:owner},async(req,reply)=>{
    const b=req.body||{},key=operationKey(req),digest=fingerprint({id:req.params.id,...b}),reason=text(b.reason,'Причина сторно');
    const result=await transaction(pool,req.user,async c=>{
      const prev=await replay(c,key,digest);if(prev)return prev;
      const old=(await c.query('SELECT * FROM finance_transactions WHERE id=$1',[id(req.params.id,'Операция')])).rows[0];
      if(!old)reject('Операция не найдена','NOT_FOUND',404);
      if(old.source_payment_id)reject('Используйте возврат оплаты в заказе — так сохранится долг клиента');
      if(old.kind==='REVERSAL')reject('Сторно нельзя повторно сторнировать');
      if(old.kind==='PART_PURCHASE')reject('Для возврата купленной детали оформите корректировку с документом; денежная покупка и её себестоимость сохраняются в истории');
      const originals=old.transfer_group_id?(await c.query('SELECT * FROM finance_transactions WHERE transfer_group_id=$1 ORDER BY id',[old.transfer_group_id])).rows:[old];
      await lockAccounts(c,originals.map(x=>x.account_id),req.user);
      const reversed=(await c.query('SELECT id FROM finance_transactions WHERE reversal_of=ANY($1::int[])',[originals.map(x=>x.id)])).rows;
      if(reversed.length)reject('Операция уже сторнирована','ALREADY_REVERSED',409);
      let group=null;
      if(old.transfer_group_id){const from=originals.find(x=>x.type==='INCOME'),to=originals.find(x=>x.type==='EXPENSE');group=randomUUID();await c.query('INSERT INTO finance_transfers(id,from_account_id,to_account_id,amount,created_by,comment,reversal_of) VALUES($1,$2,$3,$4,$5,$6,$7)',[group,from.account_id,to.account_id,from.amount,req.user.id,reason,old.transfer_group_id]);}
      const outputs=[];
      // Debit first: cancellation cannot fund its own insufficient debit.
      originals.sort((a,b)=>a.type==='INCOME'?-1:b.type==='INCOME'?1:0);
      for(const [i,x] of originals.entries())outputs.push(await insertEntry(c,req.user,{account_id:x.account_id,type:x.type==='INCOME'?'EXPENSE':'INCOME',kind:'REVERSAL',category:x.category,amount:x.amount,request_id:x.request_id,transfer_group_id:group,reversal_of:x.id,comment:reason,document_reference:b.document_reference||null,idempotency_key:i?key+':pair':key,metadata:{fingerprint:digest}}));
      return outputs[0];
    });return reply.code(201).send({data:result});
  });
  const noDelete=()=>reject('Удаление денежных операций запрещено. OWNER может оформить сторно с причиной.','IMMUTABLE',409);
  app.delete('/api/v1/transactions/:id',{preHandler:owner},noDelete);
  app.delete('/api/v1/requests/:requestId/expenses/:id',{preHandler:auth},noDelete);
  app.get('/api/v1/audit',{preHandler:owner},async req=>{
    const account=req.query?.account_id?id(req.query.account_id):null,before=req.query?.before?id(req.query.before,'Запись журнала'):null;
    return {data:(await q(`SELECT l.*,a.name account_name FROM finance_audit_log l LEFT JOIN finance_accounts a ON a.id=l.account_id WHERE ($1::int IS NULL OR l.account_id=$1) AND ($2::bigint IS NULL OR l.id<$2) ORDER BY l.id DESC LIMIT 100`,[account,before])).rows};
  });
}
