import {authenticate,requireOrder,protectOrderTables} from './access.js';
import {can,PERMISSIONS} from './rbac.js';
import {prepareFaultModelSchema} from './fault-model-schema.js';

const clean=(v,max=1000)=>String(v??'').trim().slice(0,max);
const fail=(reply,code,message,status=422)=>reply.code(status).send({data:null,error:{code,message}});
const taxonomy={faults:{table:'fault_catalog',fields:['code','category','subsystem','name','description']},causes:{table:'fault_cause_catalog',fields:['code','name','description']},actions:{table:'repair_action_catalog',fields:['code','name','description']}};

async function classificationRow(pool,requestId){
 return (await pool.query(`SELECT c.request_id,c.note,c.classified_by,c.updated_by,c.created_at,c.updated_at,
 f.id fault_id,f.code fault_code,f.category fault_category,f.subsystem,f.name fault_name,
 ca.id cause_id,ca.code cause_code,ca.name cause_name,
 a.id action_id,a.code action_code,a.name action_name
 FROM request_fault_classifications c
 JOIN fault_catalog f ON f.id=c.fault_id
 JOIN fault_cause_catalog ca ON ca.id=c.cause_id
 JOIN repair_action_catalog a ON a.id=c.action_id
 WHERE c.request_id=$1`,[requestId])).rows[0]||null;
}

export async function installFaultClassification(app,pool){
 await prepareFaultModelSchema(pool);
 await protectOrderTables(pool,['request_fault_classifications']);
 const auth=async(req,reply)=>{if(!await authenticate(req,reply,pool))return};
 const view=async(req,reply)=>{await auth(req,reply);if(reply.sent)return;if(!can(req.user.role,PERMISSIONS.KNOWLEDGE_VIEW)&&!can(req.user.role,PERMISSIONS.ORDERS_TECHNICAL))return fail(reply,'FORBIDDEN','Недостаточно прав для классификатора неисправностей',403)};
 const manage=async(req,reply)=>{await auth(req,reply);if(reply.sent)return;if(!can(req.user.role,PERMISSIONS.KNOWLEDGE_MANAGE))return fail(reply,'FORBIDDEN','Управление классификатором доступно владельцу и управляющему',403)};

 app.get('/api/v1/fault-taxonomy',{preHandler:view},async req=>{
  const q=clean(req.query?.q,120),category=clean(req.query?.category,160),p=q?`%${q}%`:null;
  const faults=(await pool.query(`SELECT * FROM fault_catalog WHERE active=true AND ($1::text='' OR category='*' OR lower(category)=lower($1)) AND ($2::text IS NULL OR code ILIKE $2 OR name ILIKE $2 OR subsystem ILIKE $2) ORDER BY CASE WHEN category='*' THEN 1 ELSE 0 END,name`,[category,p])).rows;
  const causes=(await pool.query(`SELECT * FROM fault_cause_catalog WHERE active=true AND ($1::text IS NULL OR code ILIKE $1 OR name ILIKE $1) ORDER BY name`,[p])).rows;
  const actions=(await pool.query(`SELECT * FROM repair_action_catalog WHERE active=true AND ($1::text IS NULL OR code ILIKE $1 OR name ILIKE $1) ORDER BY name`,[p])).rows;
  return{data:{faults,causes,actions}};
 });

 app.post('/api/v1/fault-taxonomy/:kind',{preHandler:manage},async(req,reply)=>{
  const def=taxonomy[req.params.kind];if(!def)return fail(reply,'VALIDATION','Неизвестный справочник');
  const b=req.body||{},code=clean(b.code,80).toUpperCase().replace(/[^A-Z0-9_]+/g,'_'),name=clean(b.name,240);if(!code||!name)return fail(reply,'VALIDATION','Укажите код и название');
  const vals=def.fields.map(f=>f==='code'?code:f==='category'?clean(b.category,160)||'*':f==='subsystem'?clean(b.subsystem,160)||'GENERAL':f==='name'?name:clean(b.description,1000));
  try{const row=(await pool.query(`INSERT INTO ${def.table}(${def.fields.join(',')},created_by,updated_by) VALUES(${vals.map((_,i)=>'$'+(i+1)).join(',')},$${vals.length+1},$${vals.length+2}) RETURNING *`,[...vals,req.user.id,req.user.id])).rows[0];return reply.code(201).send({data:row})}catch(e){if(e.code==='23505')return fail(reply,'DUPLICATE_CODE','Такой код уже существует',409);throw e}
 });

 app.patch('/api/v1/fault-taxonomy/:kind/:id',{preHandler:manage},async(req,reply)=>{
  const def=taxonomy[req.params.kind];if(!def)return fail(reply,'VALIDATION','Неизвестный справочник');const id=Number(req.params.id);if(!id)return fail(reply,'VALIDATION','Некорректный идентификатор');
  const old=(await pool.query(`SELECT * FROM ${def.table} WHERE id=$1`,[id])).rows[0];if(!old)return fail(reply,'NOT_FOUND','Запись справочника не найдена',404);const b=req.body||{};
  const next={...old};for(const f of def.fields){if(b[f]!==undefined)next[f]=f==='code'?clean(b[f],80).toUpperCase().replace(/[^A-Z0-9_]+/g,'_'):clean(b[f],f==='description'?1000:240)}if(b.active!==undefined)next.active=Boolean(b.active);if(!next.code||!next.name)return fail(reply,'VALIDATION','Код и название обязательны');
  const vals=def.fields.map(f=>next[f]);try{const row=(await pool.query(`UPDATE ${def.table} SET ${def.fields.map((f,i)=>`${f}=$${i+1}`).join(',')},active=$${vals.length+1},updated_by=$${vals.length+2},updated_at=clock_timestamp() WHERE id=$${vals.length+3} RETURNING *`,[...vals,next.active,req.user.id,id])).rows[0];return{data:row}}catch(e){if(e.code==='23505')return fail(reply,'DUPLICATE_CODE','Такой код уже существует',409);throw e}
 });

 app.get('/api/v1/requests/:id/fault-classification',{preHandler:auth},async(req,reply)=>{try{await requireOrder(pool,req.user,req.params.id)}catch(e){return fail(reply,e.code||'FORBIDDEN',e.message,e.statusCode||403)}return{data:await classificationRow(pool,Number(req.params.id))}});

 app.put('/api/v1/requests/:id/fault-classification',{preHandler:auth},async(req,reply)=>{
  if(!can(req.user.role,PERMISSIONS.ORDERS_TECHNICAL))return fail(reply,'FORBIDDEN','Эта роль не может классифицировать ремонт',403);let order;try{order=await requireOrder(pool,req.user,req.params.id,{mutable:true})}catch(e){return fail(reply,e.code||'FORBIDDEN',e.message,e.statusCode||403)}
  const faultId=Number(req.body?.fault_id),causeId=Number(req.body?.cause_id),actionId=Number(req.body?.action_id),note=clean(req.body?.note,2000);if(!faultId||!causeId||!actionId)return fail(reply,'VALIDATION','Выберите неисправность, причину и выполненное действие');
  const [fault,cause,action,equipment]=await Promise.all([
   pool.query('SELECT * FROM fault_catalog WHERE id=$1 AND active=true',[faultId]).then(x=>x.rows[0]),
   pool.query('SELECT * FROM fault_cause_catalog WHERE id=$1 AND active=true',[causeId]).then(x=>x.rows[0]),
   pool.query('SELECT * FROM repair_action_catalog WHERE id=$1 AND active=true',[actionId]).then(x=>x.rows[0]),
   pool.query('SELECT category,brand,model FROM equipment WHERE id=$1',[order.equipment_id]).then(x=>x.rows[0])
  ]);if(!fault||!cause||!action)return fail(reply,'INVALID_CLASSIFIER','Выбран неактивный или неизвестный классификатор',409);if(fault.category!=='*'&&equipment?.category&&fault.category.toLowerCase()!==equipment.category.toLowerCase())return fail(reply,'CATEGORY_MISMATCH','Неисправность не относится к типу техники этой заявки',409);
  const c=await pool.connect();try{await c.query('BEGIN');const existing=(await c.query('SELECT * FROM request_fault_classifications WHERE request_id=$1 FOR UPDATE',[order.id])).rows[0];if(existing){await c.query('INSERT INTO request_fault_classification_history(request_id,fault_id,cause_id,action_id,note,changed_by) VALUES($1,$2,$3,$4,$5,$6)',[existing.request_id,existing.fault_id,existing.cause_id,existing.action_id,existing.note,req.user.id])}
   await c.query(`INSERT INTO request_fault_classifications(request_id,fault_id,cause_id,action_id,note,classified_by,updated_by) VALUES($1,$2,$3,$4,$5,$6,$6)
    ON CONFLICT(request_id) DO UPDATE SET fault_id=EXCLUDED.fault_id,cause_id=EXCLUDED.cause_id,action_id=EXCLUDED.action_id,note=EXCLUDED.note,updated_by=EXCLUDED.updated_by,updated_at=clock_timestamp()`,[order.id,faultId,causeId,actionId,note,req.user.id]);
   await c.query('INSERT INTO request_history(request_id,user_id,action,details) VALUES($1,$2,$3,$4::jsonb)',[order.id,req.user.id,'FAULT_CLASSIFIED',JSON.stringify({fault_code:fault.code,cause_code:cause.code,action_code:action.code,model:equipment?.model||null})]);await c.query('COMMIT');
  }catch(e){await c.query('ROLLBACK');throw e}finally{c.release()}
  return{data:await classificationRow(pool,Number(order.id))};
 });

 app.get('/api/v1/requests/:id/fault-patterns',{preHandler:auth},async(req,reply)=>{let order;try{order=await requireOrder(pool,req.user,req.params.id)}catch(e){return fail(reply,e.code||'FORBIDDEN',e.message,e.statusCode||403)}const eq=(await pool.query('SELECT category,brand,model FROM equipment WHERE id=$1',[order.equipment_id])).rows[0];if(!eq?.model)return{data:{context:eq||null,patterns:[]}};
  const rows=(await pool.query(`SELECT f.id fault_id,f.code fault_code,f.name fault_name,f.subsystem,ca.id cause_id,ca.code cause_code,ca.name cause_name,a.id action_id,a.code action_code,a.name action_name,count(*)::int cases,round(avg(r.total),2)::numeric avg_total,max(r.closed_at) last_seen
   FROM request_fault_classifications c JOIN requests r ON r.id=c.request_id JOIN equipment e ON e.id=r.equipment_id JOIN fault_catalog f ON f.id=c.fault_id JOIN fault_cause_catalog ca ON ca.id=c.cause_id JOIN repair_action_catalog a ON a.id=c.action_id
   WHERE r.deleted_at IS NULL AND r.status='CLOSED' AND lower(COALESCE(e.category,''))=lower($1) AND lower(COALESCE(e.brand,''))=lower($2) AND lower(COALESCE(e.model,''))=lower($3)
   GROUP BY f.id,f.code,f.name,f.subsystem,ca.id,ca.code,ca.name,a.id,a.code,a.name ORDER BY cases DESC,last_seen DESC LIMIT 10`,[eq.category||'',eq.brand||'',eq.model])).rows;return{data:{context:eq,patterns:rows}};
 });
 return app;
}

function dateValue(v,fallback){if(!v)return fallback;const d=new Date(v);return Number.isNaN(d.getTime())?null:d}
export async function installFaultModelAnalytics(app,pool,{preHandler}={}){
 await prepareFaultModelSchema(pool);const guard=preHandler||((req,reply)=>{if(!can(req.user?.role,PERMISSIONS.ANALYTICS_VIEW))return fail(reply,'FORBIDDEN','Недостаточно прав для аналитики',403)});
 app.get('/api/v1/fault-models',{preHandler:guard},async(req,reply)=>{const now=new Date(),fallbackFrom=new Date(now.getTime()-365*86400000),from=dateValue(req.query?.from,fallbackFrom),to=dateValue(req.query?.to,now);if(!from||!to||from>=to)return fail(reply,'VALIDATION','Некорректный период');const params=[from,to],where=["r.deleted_at IS NULL","r.status='CLOSED'","r.closed_at>=$1","r.closed_at<$2"];
  for(const [field,column] of [['branch_id','r.branch_id'],['category','e.category'],['brand','e.brand'],['model','e.model']])if(req.query?.[field]){params.push(field==='branch_id'?Number(req.query[field]):clean(req.query[field],200));where.push(field==='branch_id'?`${column}=$${params.length}`:`lower(COALESCE(${column},''))=lower($${params.length})`)}
  const base=where.join(' AND ');const coverage=(await pool.query(`SELECT count(*) FILTER(WHERE COALESCE(trim(e.model),'')<>'')::int eligible_orders,count(*) FILTER(WHERE COALESCE(trim(e.model),'')<>'' AND c.request_id IS NOT NULL)::int classified_orders FROM requests r LEFT JOIN equipment e ON e.id=r.equipment_id LEFT JOIN request_fault_classifications c ON c.request_id=r.id WHERE ${base}`,params)).rows[0];
  const rows=(await pool.query(`SELECT e.category,e.brand,e.model,f.id fault_id,f.code fault_code,f.name fault_name,f.subsystem,ca.id cause_id,ca.code cause_code,ca.name cause_name,a.id action_id,a.code action_code,a.name action_name,count(*)::int cases,round(avg(r.total),2)::numeric avg_total,round(avg(r.direct_cost),2)::numeric avg_direct_cost,min(r.closed_at) first_seen,max(r.closed_at) last_seen
   FROM requests r JOIN equipment e ON e.id=r.equipment_id JOIN request_fault_classifications c ON c.request_id=r.id JOIN fault_catalog f ON f.id=c.fault_id JOIN fault_cause_catalog ca ON ca.id=c.cause_id JOIN repair_action_catalog a ON a.id=c.action_id WHERE ${base} AND COALESCE(trim(e.model),'')<>'' GROUP BY e.category,e.brand,e.model,f.id,f.code,f.name,f.subsystem,ca.id,ca.code,ca.name,a.id,a.code,a.name ORDER BY cases DESC,last_seen DESC LIMIT 500`,params)).rows;
  const eligible=Number(coverage.eligible_orders||0),classified=Number(coverage.classified_orders||0);return{data:{period:{from:from.toISOString(),to:to.toISOString()},coverage:{eligible_orders:eligible,classified_orders:classified,unclassified_orders:Math.max(0,eligible-classified),coverage_pct:eligible?Math.round(classified/eligible*10000)/100:0},rows}};
 });
 app.get('/api/v1/fault-models/orders',{preHandler:guard},async(req,reply)=>{const model=clean(req.query?.model,200),faultId=Number(req.query?.fault_id||0);if(!model||!faultId)return fail(reply,'VALIDATION','Укажите model и fault_id');const params=[model,faultId],extra=[];if(req.query?.branch_id){params.push(Number(req.query.branch_id));extra.push(`r.branch_id=$${params.length}`)}const rows=(await pool.query(`SELECT r.id,r.number,r.closed_at,r.total,r.direct_cost,e.category,e.brand,e.model,f.code fault_code,f.name fault_name,ca.code cause_code,ca.name cause_name,a.code action_code,a.name action_name,c.note FROM requests r JOIN equipment e ON e.id=r.equipment_id JOIN request_fault_classifications c ON c.request_id=r.id JOIN fault_catalog f ON f.id=c.fault_id JOIN fault_cause_catalog ca ON ca.id=c.cause_id JOIN repair_action_catalog a ON a.id=c.action_id WHERE r.deleted_at IS NULL AND r.status='CLOSED' AND lower(e.model)=lower($1) AND c.fault_id=$2 ${extra.length?'AND '+extra.join(' AND '):''} ORDER BY r.closed_at DESC LIMIT 200`,params)).rows;return{data:rows}});
 return app;
}
