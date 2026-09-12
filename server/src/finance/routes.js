import { randomUUID } from 'node:crypto';
import {canAdminFinance,isKnownRole} from '../rbac.js';
import { reject,money,text,id,date,today,monthRange,fingerprint,operationKey,transaction,lockAccounts,requestAccess,insertEntry,replay,createTransfer,recalcParts } from './service.js';

export async function financeRoutes(app,pool) {
  const q=(s,p=[])=>pool.query(s,p);
  const auth=async req=>{
    try{await req.jwtVerify();}catch{reject('Требуется авторизация','UNAUTHORIZED',401);}
    const user=(await q('SELECT id,name,role FROM users WHERE id=$1 AND active=true',[req.user.id])).rows[0];
    if(!user)reject('Пользователь неактивен','FORBIDDEN',403);
    if(!isKnownRole(user.role))reject('Роль пользователя не поддерживается','FORBIDDEN',403);
    req.user=user;
  };
  const owner=async req=>{await auth(req);if(!canAdminFinance(req.user.role))reject('Доступно собственнику или бухгалтеру','FORBIDDEN',403);};
  const allowedSql=`($1::text IN ('OWNER','SUPERVISOR','ACCOUNTANT') OR a.responsible_id=$2)`;
  const resolveBranch=async(c,value)=>{
    if(value!=null&&value!==''){
      const branch=id(value,'Филиал');
      if(!(await c.query('SELECT id FROM branches WHERE id=$1 AND active=true',[branch])).rows[0])reject('Филиал денежного счёта не найден или отключён','BRANCH_NOT_FOUND',422);
      return branch;
    }
    const active=(await c.query('SELECT id FROM branches WHERE active=true ORDER BY id LIMIT 2')).rows;
    if(active.length===1)return Number(active[0].id);
    if(active.length>1)reject('Выберите филиал денежного счёта','BRANCH_REQUIRED',422);
    reject('Нет активного филиала для денежного счёта','BRANCH_NOT_FOUND',422);
  };
  const responsibleBelongs=async(c,userId,branchId)=>{
    if(!userId)return true;
    const table=(await c.query("SELECT to_regclass('public.user_branches') name")).rows[0]?.name;
    if(!table)return true;
    return Boolean((await c.query('SELECT 1 FROM user_branches WHERE user_id=$1 AND branch_id=$2',[userId,branchId])).rows[0]);
  };
  app.get('/health',async()=>{await q('SELECT 1');return {ok:true,service:'profi24-finance',version:'2.2-branches'};});
  app.get('/api/v1/accounts',{preHandler:auth},async req=>({data:(await q(`SELECT a.*,fa.branch_id,u.name responsible_name,b.code branch_code,b.name branch_name FROM finance_account_balances a JOIN finance_accounts fa ON fa.id=a.id LEFT JOIN users u ON u.id=a.responsible_id JOIN branches b ON b.id=fa.branch_id WHERE ${allowedSql} ORDER BY a.is_active DESC,b.name,a.id`,[req.user.role,req.user.id])).rows}));
  app.get('/api/v1/categories',{preHandler:auth},async()=>({data:(await q('SELECT * FROM finance_categories ORDER BY type,name')).rows}));
  app.get('/api/v1/responsibles',{preHandler:owner},async()=>({data:(await q('SELECT id,name,role,active FROM users ORDER BY active DESC,name')).rows}));
  app.get('/api/v1/branches',{preHandler:owner},async()=>({data:(await q('SELECT id,code,name,address,timezone FROM branches WHERE active=true ORDER BY name')).rows}));

  app.post('/api/v1/accounts',{preHandler:owner},async(req,reply)=>{
    const b=req.body||{},name=text(b.name,'Название',120),type=text(b.type,'Тип'),responsible=b.responsible_id?id(b.responsible_id,'Ответственный'):null;
    if(!['BANK','CARD','CASH','ADVANCE','OTHER'].includes(type))reject('Неизвестный тип счёта');
    const initial=money(b.initial_amount??0,{signed:true,zero:true}),key=operationKey(req),digest=fingerprint(b);
    const result=await transaction(pool,req.user,async c=>{
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[key]);
      const previous=(await c.query('SELECT * FROM finance_accounts WHERE creation_key=$1',[key])).rows[0];
      if(previous){if(previous.creation_fingerprint!==digest)reject('Номер создания счёта уже использован','IDEMPOTENCY_CONFLICT',409);return previous;}
      const branch=await resolveBranch(c,b.branch_id);
      if(responsible&&!await responsibleBelongs(c,responsible,branch))reject('Ответственный сотрудник не относится к выбранному филиалу','RESPONSIBLE_BRANCH_MISMATCH',422);
      const a=(await c.query(`INSERT INTO finance_accounts(name,type,branch_id,responsible_id,comment,created_by,creation_key,creation_fingerprint) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,[name,type,branch,responsible,String(b.comment||'').slice(0,1000),req.user.id,key,digest])).rows[0];
      if(Number(initial)!==0)await insertEntry(c,req.user,{account_id:a.id,type:initial.startsWith('-')?'EXPENSE':'INCOME',kind:'OPENING',category:'OPENING',amount:initial.replace('-',''),comment:text(b.initial_reason,'Основание начального остатка'),document_reference:b.document_reference||null,idempotency_key:key,metadata:{fingerprint:digest}});
      return a;
    });return reply.code(201).send({data:result});
  });
  app.patch('/api/v1/accounts/:id',{preHandler:owner},async req=>{
    const b=req.body||{};
    const allowed=new Set(['name','type','branch_id','responsible_id','comment','is_active']);
    if(Object.keys(b).some(k=>!allowed.has(k)))reject('В настройках счёта нельзя изменять остаток. Используйте корректировку.');
    return {data:await transaction(pool,req.user,async c=>{
      const [a]=await lockAccounts(c,[req.params.id],req.user,{active:false});
      const merged={...a,...b};
      if(typeof merged.is_active!=='boolean')reject('Некорректная активность счёта');
      const branch=await resolveBranch(c,merged.branch_id);
      const responsible=merged.responsible_id?id(merged.responsible_id,'Ответственный'):null;
      if(responsible&&!await responsibleBelongs(c,responsible,branch))reject('Ответственный сотрудник не относится к выбранному филиалу','RESPONSIBLE_BRANCH_MISMATCH',422);
      return (await c.query(`UPDATE finance_accounts SET name=$1,type=$2,branch_id=$3,responsible_id=$4,comment=$5,is_active=$6,updated_at=now() WHERE id=$7 RETURNING *`,[
        text(merged.name,'Название',120),text(merged.type,'Тип'),branch,responsible,String(merged.comment||'').slice(0,1000),merged.is_active,a.id])).rows[0];
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
  app.get('/api/v1/bank-statements',{preHandler:owner},async req=>{
    const account=req.query?.account_id?id(req.query.account_id,'Счёт'):null;
    return{data:(await q(`SELECT s.*,a.name account_name,u.name created_by_name,ru.name reconciled_by_name,
      count(l.id)::int line_count,count(l.id) FILTER(WHERE l.matched_transaction_id IS NULL)::int unmatched_count
      FROM finance_bank_statements s JOIN finance_accounts a ON a.id=s.account_id
      LEFT JOIN finance_bank_statement_lines l ON l.statement_id=s.id LEFT JOIN users u ON u.id=s.created_by LEFT JOIN users ru ON ru.id=s.reconciled_by
      WHERE ($1::int IS NULL OR s.account_id=$1) GROUP BY s.id,a.name,u.name,ru.name ORDER BY s.period_end DESC,s.id DESC`,[account])).rows};
  });
  app.post('/api/v1/bank-statements',{preHandler:owner},async(req,reply)=>{
    const b=req.body||{},lines=Array.isArray(b.lines)?b.lines:[];
    if(!lines.length||lines.length>5000)reject('Выписка должна содержать от 1 до 5000 строк');
    const result=await transaction(pool,req.user,async c=>{
      const [account]=await lockAccounts(c,[b.account_id],req.user,{active:false});
      if(account.type!=='BANK')reject('Сверка выписки доступна только для банковского счёта','BANK_ACCOUNT_REQUIRED',422);
      const start=date(b.period_start),end=date(b.period_end);if(end<start)reject('Дата окончания выписки раньше начала');
      const statement=(await c.query(`INSERT INTO finance_bank_statements(account_id,statement_reference,period_start,period_end,opening_balance,closing_balance,created_by)
        VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,[account.id,text(b.statement_reference,'Номер выписки',200),start,end,money(b.opening_balance,{signed:true,zero:true}),money(b.closing_balance,{signed:true,zero:true}),req.user.id])).rows[0];
      for(const [index,line] of lines.entries()){
        const occurred=date(line.occurred_at);if(occurred<start||occurred>end)reject(`Строка ${index+1}: дата вне периода выписки`);
        if(!['INCOME','EXPENSE'].includes(line.type))reject(`Строка ${index+1}: укажите приход или расход`);
        await c.query(`INSERT INTO finance_bank_statement_lines(statement_id,external_id,occurred_at,type,amount,document_reference,counterparty,purpose)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[statement.id,text(line.external_id||String(index+1),'ID строки',200),occurred,line.type,money(line.amount),String(line.document_reference||'').slice(0,200)||null,String(line.counterparty||'').slice(0,300)||null,String(line.purpose||'').slice(0,2000)]);
      }
      await c.query(`INSERT INTO finance_audit_log(account_id,actor_id,actor_name,action,details) VALUES($1,$2,$3,'BANK_STATEMENT_IMPORTED',$4)`,[account.id,req.user.id,req.user.name,{statement_id:statement.id,statement_reference:statement.statement_reference,line_count:lines.length}]);
      return statement;
    });return reply.code(201).send({data:result});
  });
  app.get('/api/v1/bank-statements/:id',{preHandler:owner},async req=>{
    const statement=(await q(`SELECT s.*,a.name account_name FROM finance_bank_statements s JOIN finance_accounts a ON a.id=s.account_id WHERE s.id=$1`,[id(req.params.id,'Выписка')])).rows[0];
    if(!statement)reject('Выписка не найдена','NOT_FOUND',404);
    const lines=(await q(`SELECT l.*,f.kind transaction_kind,f.comment transaction_comment,f.document_reference transaction_reference
      FROM finance_bank_statement_lines l LEFT JOIN finance_transactions f ON f.id=l.matched_transaction_id WHERE l.statement_id=$1 ORDER BY l.occurred_at,l.id`,[statement.id])).rows;
    return{data:{...statement,lines}};
  });
  app.get('/api/v1/bank-statements/:statementId/lines/:lineId/candidates',{preHandler:owner},async req=>{
    const line=(await q(`SELECT l.*,s.account_id,s.status FROM finance_bank_statement_lines l JOIN finance_bank_statements s ON s.id=l.statement_id WHERE l.id=$1 AND s.id=$2`,[id(req.params.lineId),id(req.params.statementId)])).rows[0];
    if(!line)reject('Строка выписки не найдена','NOT_FOUND',404);
    return{data:(await q(`SELECT f.*,r.number request_number,
      (CASE WHEN f.occurred_at=$4 THEN 100 ELSE 70 END + CASE WHEN NULLIF($5,'') IS NOT NULL AND f.document_reference=$5 THEN 20 ELSE 0 END)::int match_score
      FROM finance_transactions f LEFT JOIN requests r ON r.id=f.request_id LEFT JOIN finance_bank_statement_lines used ON used.matched_transaction_id=f.id
      WHERE f.account_id=$1 AND f.type=$2 AND f.amount=$3 AND f.occurred_at BETWEEN $4::date-2 AND $4::date+2 AND used.id IS NULL
      ORDER BY match_score DESC,f.id DESC LIMIT 20`,[line.account_id,line.type,line.amount,line.occurred_at,line.document_reference||''])).rows};
  });
  app.post('/api/v1/bank-statements/:statementId/lines/:lineId/match',{preHandler:owner},async req=>({data:await transaction(pool,req.user,async c=>{
    const line=(await c.query(`SELECT l.*,s.account_id,s.status FROM finance_bank_statement_lines l JOIN finance_bank_statements s ON s.id=l.statement_id WHERE l.id=$1 AND s.id=$2 FOR UPDATE OF l,s`,[id(req.params.lineId),id(req.params.statementId)])).rows[0];
    if(!line)reject('Строка выписки не найдена','NOT_FOUND',404);if(line.status!=='DRAFT')reject('Выписка уже сверена','STATEMENT_CLOSED',409);
    const tx=(await c.query('SELECT * FROM finance_transactions WHERE id=$1',[id(req.body?.transaction_id,'Операция')])).rows[0];
    const dayDiff=tx?Math.abs((new Date(tx.occurred_at)-new Date(line.occurred_at))/86400000):Infinity;
    if(!tx||Number(tx.account_id)!==Number(line.account_id)||tx.type!==line.type||Number(tx.amount)!==Number(line.amount)||dayDiff>2)reject('Операция не совпадает со счётом, направлением, суммой или допустимой датой','MATCH_MISMATCH',409);
    const out=(await c.query('UPDATE finance_bank_statement_lines SET matched_transaction_id=$1,matched_by=$2,matched_at=clock_timestamp() WHERE id=$3 RETURNING *',[tx.id,req.user.id,line.id])).rows[0];
    await c.query(`INSERT INTO finance_audit_log(account_id,transaction_id,actor_id,actor_name,action,details) VALUES($1,$2,$3,$4,'BANK_LINE_MATCHED',$5)`,[line.account_id,tx.id,req.user.id,req.user.name,{statement_id:line.statement_id,line_id:line.id}]);return out;
  })}));
  app.post('/api/v1/bank-statements/:statementId/lines/:lineId/unmatch',{preHandler:owner},async req=>({data:await transaction(pool,req.user,async c=>{
    const line=(await c.query(`SELECT l.*,s.account_id,s.status FROM finance_bank_statement_lines l JOIN finance_bank_statements s ON s.id=l.statement_id WHERE l.id=$1 AND s.id=$2 FOR UPDATE OF l,s`,[id(req.params.lineId),id(req.params.statementId)])).rows[0];
    if(!line)reject('Строка выписки не найдена','NOT_FOUND',404);if(line.status!=='DRAFT')reject('Выписка уже сверена','STATEMENT_CLOSED',409);if(!line.matched_transaction_id)return line;
    const out=(await c.query('UPDATE finance_bank_statement_lines SET matched_transaction_id=NULL,matched_by=NULL,matched_at=NULL WHERE id=$1 RETURNING *',[line.id])).rows[0];
    await c.query(`INSERT INTO finance_audit_log(account_id,transaction_id,actor_id,actor_name,action,details) VALUES($1,$2,$3,$4,'BANK_LINE_UNMATCHED',$5)`,[line.account_id,line.matched_transaction_id,req.user.id,req.user.name,{statement_id:line.statement_id,line_id:line.id,reason:String(req.body?.reason||'Исправление сопоставления').slice(0,500)}]);return out;
  })}));
  app.post('/api/v1/bank-statements/:id/reconcile',{preHandler:owner},async req=>({data:await transaction(pool,req.user,async c=>{
    const s=(await c.query('SELECT * FROM finance_bank_statements WHERE id=$1 FOR UPDATE',[id(req.params.id,'Выписка')])).rows[0];if(!s)reject('Выписка не найдена','NOT_FOUND',404);if(s.status==='RECONCILED')return s;
    const totals=(await c.query(`SELECT count(*) FILTER(WHERE matched_transaction_id IS NULL)::int unmatched,
      COALESCE(sum(CASE WHEN type='INCOME' THEN amount ELSE -amount END),0)::numeric movement,
      ($2::numeric+COALESCE(sum(CASE WHEN type='INCOME' THEN amount ELSE -amount END),0)=$3::numeric) statement_balanced
      FROM finance_bank_statement_lines WHERE statement_id=$1`,[s.id,s.opening_balance,s.closing_balance])).rows[0];
    if(totals.unmatched)reject(`Не сопоставлено строк: ${totals.unmatched}`,'UNMATCHED_LINES',409);
    if(!totals.statement_balanced)reject('Начальный остаток и движения не сходятся с конечным остатком выписки','STATEMENT_BALANCE_MISMATCH',409);
    const books=(await c.query(`SELECT
      COALESCE(sum(CASE WHEN type='INCOME' THEN amount ELSE -amount END) FILTER(WHERE kind='OPENING' OR occurred_at<$2),0)::numeric opening,
      COALESCE(sum(CASE WHEN type='INCOME' THEN amount ELSE -amount END) FILTER(WHERE kind='OPENING' OR occurred_at<=$3),0)::numeric closing,
      count(*) FILTER(WHERE kind<>'OPENING' AND occurred_at BETWEEN $2 AND $3 AND NOT EXISTS(
        SELECT 1 FROM finance_bank_statement_lines l WHERE l.statement_id=$4 AND l.matched_transaction_id=finance_transactions.id
      ))::int unmatched_book
      FROM finance_transactions WHERE account_id=$1`,[s.account_id,s.period_start,s.period_end,s.id])).rows[0];
    if(books.unmatched_book)reject(`В CRM есть банковские операции, отсутствующие в выписке: ${books.unmatched_book}`,'UNMATCHED_BOOK_TRANSACTIONS',409);
    const bookMatches=(await c.query('SELECT $1::numeric=$2::numeric opening_matches,$3::numeric=$4::numeric closing_matches',[books.opening,s.opening_balance,books.closing,s.closing_balance])).rows[0];
    if(!bookMatches.opening_matches||!bookMatches.closing_matches)reject('Остатки банковской выписки не совпадают с денежной книгой CRM','BOOK_BALANCE_MISMATCH',409);
    const out=(await c.query("UPDATE finance_bank_statements SET status='RECONCILED',reconciled_by=$1,reconciled_at=clock_timestamp() WHERE id=$2 RETURNING *",[req.user.id,s.id])).rows[0];
    await c.query(`INSERT INTO finance_audit_log(account_id,actor_id,actor_name,action,details) VALUES($1,$2,$3,'BANK_STATEMENT_RECONCILED',$4)`,[s.account_id,req.user.id,req.user.name,{statement_id:s.id,closing_balance:s.closing_balance}]);return out;
  })}));
  const noDelete=()=>reject('Удаление денежных операций запрещено. Собственник или бухгалтер может оформить сторно с причиной.','IMMUTABLE',409);
  app.delete('/api/v1/transactions/:id',{preHandler:owner},noDelete);
  app.delete('/api/v1/requests/:requestId/expenses/:id',{preHandler:auth},noDelete);
  app.get('/api/v1/audit',{preHandler:owner},async req=>{
    const account=req.query?.account_id?id(req.query.account_id):null,before=req.query?.before?id(req.query.before,'Запись журнала'):null;
    return {data:(await q(`SELECT l.*,a.name account_name FROM finance_audit_log l LEFT JOIN finance_accounts a ON a.id=l.account_id WHERE ($1::int IS NULL OR l.account_id=$1) AND ($2::bigint IS NULL OR l.id<$2) ORDER BY l.id DESC LIMIT 100`,[account,before])).rows};
  });
}
