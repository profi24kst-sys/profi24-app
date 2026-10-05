import {randomUUID} from 'node:crypto';
import {financePeriod} from './period.js';
import {reject,text,id,transaction} from './service.js';

export const paymentMethods=['BANK','CARD','CASH','ADVANCE','OTHER'];
function methods(value){
  if(!Array.isArray(value)||!value.length||value.some(x=>!paymentMethods.includes(x)))reject('Выберите способы оплаты статьи');
  return [...new Set(value)].sort();
}
export async function validateCategory(c,code,type,accountType){
  const category=(await c.query('SELECT * FROM finance_categories WHERE code=$1 FOR SHARE',[code])).rows[0];
  if(!category||!category.is_active||category.is_system)reject('Выберите активную статью ДДС для ручной операции');
  if(category.type!==type)reject('Тип статьи не соответствует приходу или расходу');
  if(!category.payment_methods.includes(accountType))reject('Статья недоступна для способа оплаты выбранного счёта');
}
export function cashFlowRoutes(app,pool,{auth,owner,allowedSql}){
  app.post('/api/v1/categories',{preHandler:owner},async(req,reply)=>{
    const b=req.body||{},name=text(b.name,'Название статьи',100),type=b.type;
    if(!['INCOME','EXPENSE'].includes(type))reject('Выберите тип статьи');
    const selected=methods(b.payment_methods);
    const result=await transaction(pool,req.user,async c=>{
      const row=(await c.query('INSERT INTO finance_categories(code,name,type,payment_methods) VALUES($1,$2,$3,$4) RETURNING *',['CUSTOM_'+randomUUID(),name,type,selected])).rows[0];
      await c.query("INSERT INTO finance_audit_log(actor_id,actor_name,action,details) VALUES($1,$2,'CATEGORY_CREATED',$3)",[req.user.id,req.user.name,{after:row}]);
      return row;
    });return reply.code(201).send({data:result});
  });
  app.patch('/api/v1/categories/:code',{preHandler:owner},async req=>{
    const b=req.body||{};
    if(Object.keys(b).some(k=>!['name','payment_methods','is_active','version'].includes(k)))reject('Код и тип статьи нельзя изменять');
    if(!Number.isSafeInteger(b.version)||b.version<1)reject('Обновите справочник перед сохранением');
    return {data:await transaction(pool,req.user,async c=>{
      const old=(await c.query('SELECT * FROM finance_categories WHERE code=$1 FOR UPDATE',[req.params.code])).rows[0];
      if(!old)reject('Статья не найдена','NOT_FOUND',404);
      if(old.is_system)reject('Системная статья доступна только для просмотра');
      if(old.version!==b.version)reject('Статья уже изменена. Обновите справочник','VERSION_CONFLICT',409);
      const active=b.is_active??old.is_active;
      if(typeof active!=='boolean')reject('Некорректная активность статьи');
      const row=(await c.query('UPDATE finance_categories SET name=$1,payment_methods=$2,is_active=$3,version=version+1 WHERE code=$4 RETURNING *',[text(b.name??old.name,'Название статьи',100),methods(b.payment_methods??old.payment_methods),active,old.code])).rows[0];
      await c.query("INSERT INTO finance_audit_log(actor_id,actor_name,action,details) VALUES($1,$2,'CATEGORY_UPDATED',$3)",[req.user.id,req.user.name,{before:old,after:row}]);
      return row;
    })};
  });
  app.get('/api/v1/cash-flow',{preHandler:auth},async req=>{
    const period=financePeriod(req.query),account=req.query.account_id?id(req.query.account_id):null,method=req.query.payment_method||null;
    if(method&&!paymentMethods.includes(method))reject('Неизвестный способ оплаты');
    if(account&&!(await pool.query(`SELECT a.id FROM finance_accounts a WHERE a.id=$3 AND ${allowedSql}`,[req.user.role,req.user.id,account])).rows[0])reject('Нет доступа к счёту','FORBIDDEN',403);
    const result=(await pool.query(`WITH scoped AS (
      SELECT f.*,COALESCE(c.name,f.category) category_name,
        COALESCE(f.metadata->>'cash_flow_method',CASE WHEN f.payment_method IN ('ACCOUNT','') THEN a.type
          WHEN f.payment_method IN ('KASPI','BANK_TRANSFER') THEN 'BANK' ELSE f.payment_method END) effective_method,
        CASE COALESCE(original.kind,f.kind) WHEN 'OPENING' THEN 'opening' WHEN 'ADJUSTMENT' THEN 'adjustment'
          WHEN 'TRANSFER' THEN 'transfer' ELSE 'flow' END bucket
      FROM finance_transactions f JOIN finance_accounts a ON a.id=f.account_id
      LEFT JOIN finance_categories c ON c.code=f.category
      LEFT JOIN finance_transactions original ON original.id=f.reversal_of
      WHERE ${allowedSql} AND ($3::int IS NULL OR a.id=$3)
    ), filtered AS (SELECT * FROM scoped WHERE ($6::text IS NULL OR effective_method=$6)),
    grouped AS (
      SELECT category,category_name,effective_method payment_method,bucket,count(*) operations,
        COALESCE(sum(amount) FILTER(WHERE type='INCOME'),0) income,
        COALESCE(sum(amount) FILTER(WHERE type='EXPENSE'),0) expense,
        sum(CASE WHEN type='INCOME' THEN amount ELSE -amount END) net
      FROM filtered WHERE occurred_at>=$4 AND occurred_at<$5 GROUP BY category,category_name,effective_method,bucket
    ) SELECT jsonb_build_object(
      'opening',COALESCE(sum(CASE WHEN type='INCOME' THEN amount ELSE -amount END) FILTER(WHERE occurred_at<$4),0),
      'closing',COALESCE(sum(CASE WHEN type='INCOME' THEN amount ELSE -amount END) FILTER(WHERE occurred_at<$5),0),
      'income',COALESCE(sum(amount) FILTER(WHERE occurred_at>=$4 AND occurred_at<$5 AND bucket='flow' AND type='INCOME'),0),
      'expense',COALESCE(sum(amount) FILTER(WHERE occurred_at>=$4 AND occurred_at<$5 AND bucket='flow' AND type='EXPENSE'),0),
      'net',COALESCE(sum(CASE WHEN type='INCOME' THEN amount ELSE -amount END) FILTER(WHERE occurred_at>=$4 AND occurred_at<$5 AND bucket='flow'),0)
    ) summary,(SELECT COALESCE(jsonb_agg(to_jsonb(g) ORDER BY bucket,category_name,payment_method),'[]'::jsonb) FROM grouped g) rows FROM filtered`,[req.user.role,req.user.id,account,period.dateStart,period.dateEnd,method])).rows[0];
    return {data:{...result,period:period.metadata}};
  });
}
