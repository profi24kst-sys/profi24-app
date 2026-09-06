import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import jwt from '@fastify/jwt';
import pg from 'pg';
import {authenticate,installOrderAccess,requireOrder} from './access.js';
import {can,PERMISSIONS} from './rbac.js';

const app=Fastify({logger:true,bodyLimit:4*1024*1024});
await app.register(cors,{origin:(process.env.CORS_ORIGIN||'http://localhost:5173').split(',').map(x=>x.trim()),credentials:true});
await app.register(helmet,{contentSecurityPolicy:false});
await app.register(jwt,{secret:process.env.JWT_SECRET||'dev-secret-change-me'});
const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,max:Number(process.env.DB_POOL_MAX||8)});
const q=(s,p=[])=>pool.query(s,p);
const fail=(reply,code,message,status=422,details)=>reply.code(status).send({data:null,error:{code,message,details}});
const tx=async fn=>{const c=await pool.connect();try{await c.query('BEGIN');const out=await fn(c);await c.query('COMMIT');return out}catch(e){await c.query('ROLLBACK');throw e}finally{c.release()}};
const HOLD_TYPES=new Set(['WAITING_CUSTOMER','WAITING_APPROVAL','WAITING_PART','REPEAT_VISIT','EXTERNAL_SERVICE','WAITING_DELIVERY','OTHER']);
const ENGINEER_HOLD_TYPES=new Set(['WAITING_PART','REPEAT_VISIT','EXTERNAL_SERVICE','OTHER']);
const VISIT_TYPES=new Set(['FIELD','SHOP','DELIVERY','REMOTE']);
const VISIT_OUTCOMES=new Set(['COMPLETED','NO_ACCESS','CUSTOMER_NO_SHOW','REPEAT_REQUIRED','CANCELLED']);
const LINK_TYPES=new Set(['WARRANTY_REWORK','REWORK']);
const text=(v,max=500)=>String(v||'').trim().slice(0,max);
const positiveId=v=>{const n=Number(v);return Number.isSafeInteger(n)&&n>0?n:null};
const dateValue=v=>{if(!v)return null;const d=new Date(v);return Number.isNaN(d.getTime())?null:d};
const auth=async(req,reply)=>{if(!await authenticate(req,reply,pool))return;};
const office=async(req,reply)=>{await auth(req,reply);if(reply.sent)return;if(!can(req.user.role,PERMISSIONS.ORDERS_EDIT))return fail(reply,'FORBIDDEN','Операционное изменение доступно собственнику, управляющему или менеджеру',403)};
const operations=async(req,reply)=>{await auth(req,reply);if(reply.sent)return;if(!can(req.user.role,PERMISSIONS.OPERATIONS_MANAGE))return fail(reply,'FORBIDDEN','Недостаточно операционных прав',403)};

installOrderAccess(app,pool,'lifecycle');
app.get('/health',async()=>{await q('SELECT 1');return{ok:true,service:'profi24-order-lifecycle',version:'2.0.0'}});

async function sameBranchUser(c,userId,branchId,{engineer=false}={}){
  if(!userId)return null;
  const role=engineer?"AND u.role='ENGINEER'":'';
  return (await c.query(`SELECT u.id,u.name,u.role FROM users u JOIN user_branches ub ON ub.user_id=u.id WHERE u.id=$1 AND u.active=true AND ub.branch_id=$2 ${role} LIMIT 1`,[userId,branchId])).rows[0]||null;
}
async function lifecycleSnapshot(c,requestId){
  const [holds,visits,outgoing,incoming]=await Promise.all([
    c.query(`SELECT h.*,u.name responsible_name,s.name started_by_name,r.name resumed_by_name FROM request_holds h LEFT JOIN users u ON u.id=h.responsible_id LEFT JOIN users s ON s.id=h.started_by LEFT JOIN users r ON r.id=h.resumed_by WHERE h.request_id=$1 ORDER BY h.id DESC`,[requestId]),
    c.query(`SELECT v.*,e.name engineer_name,cb.name created_by_name,done.name completed_by_name FROM request_visit_attempts v LEFT JOIN users e ON e.id=v.engineer_id LEFT JOIN users cb ON cb.id=v.created_by LEFT JOIN users done ON done.id=v.completed_by WHERE v.request_id=$1 ORDER BY v.attempt_no DESC`,[requestId]),
    c.query(`SELECT l.*,r.number child_number,r.status child_status,r.engineer_id,r.scheduled_at FROM request_order_links l JOIN requests r ON r.id=l.child_request_id WHERE l.parent_request_id=$1 ORDER BY l.id DESC`,[requestId]),
    c.query(`SELECT l.*,r.number parent_number,r.status parent_status FROM request_order_links l JOIN requests r ON r.id=l.parent_request_id WHERE l.child_request_id=$1 ORDER BY l.id DESC`,[requestId])
  ]);
  return {active_hold:holds.rows.find(x=>!x.resumed_at)||null,holds:holds.rows,visits:visits.rows,links:outgoing.rows,parent_links:incoming.rows};
}
async function createSystemHold(c,{order,user,type,reason,responsibleId=null,pauseSla=true,expected=null}){
  const active=(await c.query('SELECT id FROM request_holds WHERE request_id=$1 AND resumed_at IS NULL LIMIT 1',[order.id])).rows[0];
  if(active)return null;
  const hold=(await c.query(`INSERT INTO request_holds(request_id,hold_type,reason,responsible_id,expected_until,pause_sla,previous_status,previous_sla_deadline,started_by)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,[order.id,type,reason,responsibleId,expected,pauseSla,order.status,order.sla_deadline,user.id])).rows[0];
  if(pauseSla&&order.sla_deadline)await c.query('UPDATE requests SET sla_deadline=NULL,updated_at=now() WHERE id=$1',[order.id]);
  await c.query(`INSERT INTO request_history(request_id,user_id,action,details) VALUES($1,$2,'ORDER_HOLD_STARTED',$3)`,[order.id,user.id,{hold_id:hold.id,hold_type:type,reason,responsible_id:responsibleId,expected_until:expected,pause_sla:pauseSla,previous_status:order.status,previous_sla_deadline:order.sla_deadline,automatic:true}]);
  return hold;
}

app.get('/api/v1/requests/:id/lifecycle',{preHandler:auth},async(req)=>{
  const order=await requireOrder(pool,req.user,req.params.id);
  return{data:{order_id:order.id,request_status:order.status,sla_deadline:order.sla_deadline,...await lifecycleSnapshot(pool,order.id)}};
});

app.post('/api/v1/requests/:id/holds',{preHandler:auth},async(req,reply)=>{
  const type=String(req.body?.hold_type||'').toUpperCase(),reason=text(req.body?.reason),responsibleId=positiveId(req.body?.responsible_id),pauseSla=req.body?.pause_sla!==false,expected=dateValue(req.body?.expected_until);
  if(!HOLD_TYPES.has(type))return fail(reply,'VALIDATION','Выберите корректный тип ожидания');
  const officeAllowed=can(req.user.role,PERMISSIONS.ORDERS_EDIT),engineerAllowed=req.user.role==='ENGINEER'&&ENGINEER_HOLD_TYPES.has(type);
  if(!officeAllowed&&!engineerAllowed)return fail(reply,'FORBIDDEN','Эта роль не может поставить заказ на такой тип ожидания',403);
  if(reason.length<3)return fail(reply,'VALIDATION','Опишите причину ожидания');
  if(req.body?.expected_until&&!expected)return fail(reply,'VALIDATION','Некорректный срок ожидания');
  const result=await tx(async c=>{
    const order=await requireOrder(c,req.user,req.params.id,{mutable:true,lock:true});
    const active=(await c.query('SELECT id FROM request_holds WHERE request_id=$1 AND resumed_at IS NULL FOR UPDATE',[order.id])).rows[0];
    if(active)throw Object.assign(new Error('Заказ уже находится на документированной паузе'),{code:'HOLD_ALREADY_ACTIVE',statusCode:409});
    const effectiveResponsible=responsibleId||(req.user.role==='ENGINEER'?req.user.id:null);
    if(effectiveResponsible&&!await sameBranchUser(c,effectiveResponsible,order.branch_id))throw Object.assign(new Error('Ответственный не относится к филиалу заказа'),{code:'RESPONSIBLE_BRANCH_MISMATCH',statusCode:422});
    const hold=(await c.query(`INSERT INTO request_holds(request_id,hold_type,reason,responsible_id,expected_until,pause_sla,previous_status,previous_sla_deadline,started_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,[order.id,type,reason,effectiveResponsible,expected?.toISOString()||null,pauseSla,order.status,order.sla_deadline,req.user.id])).rows[0];
    if(pauseSla&&order.sla_deadline)await c.query('UPDATE requests SET sla_deadline=NULL,updated_at=now() WHERE id=$1',[order.id]);
    await c.query(`INSERT INTO request_history(request_id,user_id,action,details) VALUES($1,$2,'ORDER_HOLD_STARTED',$3)`,[order.id,req.user.id,{hold_id:hold.id,hold_type:type,reason,responsible_id:effectiveResponsible,expected_until:expected?.toISOString()||null,pause_sla:pauseSla,previous_status:order.status,previous_sla_deadline:order.sla_deadline}]);
    return hold;
  });
  return reply.code(201).send({data:result});
});

app.post('/api/v1/requests/:id/holds/:holdId/resume',{preHandler:office},async(req,reply)=>{
  const resolution=text(req.body?.resolution),holdId=positiveId(req.params.holdId);
  if(!holdId)return fail(reply,'VALIDATION','Некорректный документ ожидания');
  if(resolution.length<3)return fail(reply,'VALIDATION','Укажите результат ожидания');
  const result=await tx(async c=>{
    const order=await requireOrder(c,req.user,req.params.id,{lock:true});
    if(['CLOSED','CANCELLED'].includes(order.status))throw Object.assign(new Error('Завершённый заказ нельзя возобновить через паузу'),{code:'ORDER_FINISHED',statusCode:409});
    const hold=(await c.query('SELECT * FROM request_holds WHERE id=$1 AND request_id=$2 FOR UPDATE',[holdId,order.id])).rows[0];
    if(!hold)throw Object.assign(new Error('Документ ожидания не найден'),{code:'NOT_FOUND',statusCode:404});
    if(hold.resumed_at)throw Object.assign(new Error('Ожидание уже завершено'),{code:'HOLD_ALREADY_RESUMED',statusCode:409});
    const updated=(await c.query('UPDATE request_holds SET resumed_by=$1,resumed_at=clock_timestamp(),resolution=$2 WHERE id=$3 RETURNING *',[req.user.id,resolution,hold.id])).rows[0];
    let deadline=order.sla_deadline;
    if(hold.pause_sla&&hold.previous_sla_deadline){
      const row=(await c.query('UPDATE requests SET sla_deadline=$1::timestamptz+($2::timestamptz-$3::timestamptz),updated_at=now() WHERE id=$4 RETURNING sla_deadline',[hold.previous_sla_deadline,updated.resumed_at,hold.started_at,order.id])).rows[0];
      deadline=row.sla_deadline;
    }
    const duration=Number((await c.query('SELECT GREATEST(0,EXTRACT(EPOCH FROM ($1::timestamptz-$2::timestamptz))) seconds',[updated.resumed_at,hold.started_at])).rows[0].seconds||0);
    await c.query(`INSERT INTO request_history(request_id,user_id,action,details) VALUES($1,$2,'ORDER_HOLD_RESUMED',$3)`,[order.id,req.user.id,{hold_id:hold.id,hold_type:hold.hold_type,resolution,duration_seconds:Math.round(duration),sla_deadline:deadline}]);
    return {...updated,new_sla_deadline:deadline,duration_seconds:Math.round(duration)};
  });
  return{data:result};
});

app.post('/api/v1/requests/:id/visits',{preHandler:office},async(req,reply)=>{
  const scheduled=dateValue(req.body?.scheduled_at),visitType=String(req.body?.visit_type||'FIELD').toUpperCase(),engineerId=positiveId(req.body?.engineer_id);
  if(!scheduled)return fail(reply,'VALIDATION','Укажите дату и время выезда');
  if(!VISIT_TYPES.has(visitType))return fail(reply,'VALIDATION','Некорректный тип визита');
  const result=await tx(async c=>{
    const order=await requireOrder(c,req.user,req.params.id,{mutable:true,lock:true});
    const effectiveEngineer=engineerId||positiveId(order.engineer_id);
    if(!effectiveEngineer)throw Object.assign(new Error('Сначала назначьте основного инженера'),{code:'ENGINEER_REQUIRED',statusCode:422});
    if(Number(order.engineer_id)!==Number(effectiveEngineer))throw Object.assign(new Error('Повторный визит назначается основному ответственному инженеру; смените инженера заказа штатным назначением'),{code:'PRIMARY_ENGINEER_REQUIRED',statusCode:409});
    if(!await sameBranchUser(c,effectiveEngineer,order.branch_id,{engineer:true}))throw Object.assign(new Error('Инженер не относится к филиалу заказа'),{code:'ENGINEER_BRANCH_MISMATCH',statusCode:422});
    const attempt=Number((await c.query('SELECT COALESCE(max(attempt_no),0)+1 n FROM request_visit_attempts WHERE request_id=$1',[order.id])).rows[0].n);
    const visit=(await c.query(`INSERT INTO request_visit_attempts(request_id,attempt_no,visit_type,scheduled_at,engineer_id,created_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,[order.id,attempt,visitType,scheduled.toISOString(),effectiveEngineer,req.user.id])).rows[0];
    await c.query('UPDATE requests SET scheduled_at=$1,updated_at=now() WHERE id=$2',[scheduled.toISOString(),order.id]);
    await c.query(`INSERT INTO request_history(request_id,user_id,action,details) VALUES($1,$2,'REPEAT_VISIT_SCHEDULED',$3)`,[order.id,req.user.id,{visit_id:visit.id,attempt_no:attempt,visit_type:visitType,scheduled_at:scheduled.toISOString(),engineer_id:effectiveEngineer}]);
    return visit;
  });
  return reply.code(201).send({data:result});
});

app.post('/api/v1/requests/:id/visits/:visitId/outcome',{preHandler:auth},async(req,reply)=>{
  const outcome=String(req.body?.outcome||'').toUpperCase(),reason=text(req.body?.reason),visitId=positiveId(req.params.visitId);
  if(!visitId||!VISIT_OUTCOMES.has(outcome))return fail(reply,'VALIDATION','Выберите результат визита');
  if(outcome!=='COMPLETED'&&reason.length<3)return fail(reply,'VALIDATION','Опишите причину результата визита');
  if(!can(req.user.role,PERMISSIONS.ORDERS_TECHNICAL)&&!can(req.user.role,PERMISSIONS.ORDERS_EDIT))return fail(reply,'FORBIDDEN','Недостаточно прав для результата визита',403);
  const result=await tx(async c=>{
    const order=await requireOrder(c,req.user,req.params.id,{mutable:true,lock:true});
    const visit=(await c.query('SELECT * FROM request_visit_attempts WHERE id=$1 AND request_id=$2 FOR UPDATE',[visitId,order.id])).rows[0];
    if(!visit)throw Object.assign(new Error('Визит не найден'),{code:'NOT_FOUND',statusCode:404});
    if(visit.outcome!=='SCHEDULED')throw Object.assign(new Error('Результат визита уже зафиксирован'),{code:'VISIT_ALREADY_COMPLETED',statusCode:409});
    if(req.user.role==='ENGINEER'&&Number(visit.engineer_id)!==Number(req.user.id))throw Object.assign(new Error('Зафиксировать результат может назначенный на этот визит инженер'),{code:'FORBIDDEN',statusCode:403});
    const updated=(await c.query('UPDATE request_visit_attempts SET outcome=$1,reason=$2,completed_by=$3,completed_at=clock_timestamp() WHERE id=$4 RETURNING *',[outcome,reason||null,req.user.id,visit.id])).rows[0];
    if(['NO_ACCESS','CUSTOMER_NO_SHOW','REPEAT_REQUIRED','CANCELLED'].includes(outcome))await c.query('UPDATE requests SET scheduled_at=NULL,updated_at=now() WHERE id=$1 AND scheduled_at=$2',[order.id,visit.scheduled_at]);
    let repeatHold=null;
    if(outcome==='REPEAT_REQUIRED')repeatHold=await createSystemHold(c,{order,user:req.user,type:'REPEAT_VISIT',reason,responsibleId:positiveId(order.manager_id),pauseSla:true});
    await c.query(`INSERT INTO request_history(request_id,user_id,action,details) VALUES($1,$2,'VISIT_OUTCOME_RECORDED',$3)`,[order.id,req.user.id,{visit_id:visit.id,attempt_no:visit.attempt_no,outcome,reason:reason||null,repeat_hold_id:repeatHold?.id||null}]);
    return {...updated,repeat_hold:repeatHold};
  });
  return{data:result};
});

app.post('/api/v1/requests/:id/rework',{preHandler:office},async(req,reply)=>{
  const type=String(req.body?.link_type||'WARRANTY_REWORK').toUpperCase(),reason=text(req.body?.reason),scheduled=dateValue(req.body?.scheduled_at);
  if(!LINK_TYPES.has(type))return fail(reply,'VALIDATION','Некорректный тип повторного заказа');
  if(type==='WARRANTY_REWORK'&&!['OWNER','SUPERVISOR'].includes(req.user.role))return fail(reply,'FORBIDDEN','Гарантийную переделку создаёт собственник или управляющий',403);
  if(reason.length<3)return fail(reply,'VALIDATION','Опишите причину повторного обращения');
  if(req.body?.scheduled_at&&!scheduled)return fail(reply,'VALIDATION','Некорректная дата визита');
  const result=await tx(async c=>{
    const parent=await requireOrder(c,req.user,req.params.id,{lock:true});
    if(parent.status!=='CLOSED'||!parent.closed_at)throw Object.assign(new Error('Повторный заказ создаётся только из закрытого исходного заказа'),{code:'PARENT_NOT_CLOSED',statusCode:409});
    if(type==='WARRANTY_REWORK'){
      const exists=(await c.query("SELECT to_regclass('public.warranty_cards') name")).rows[0]?.name;
      if(!exists)throw Object.assign(new Error('Гарантийный талон ещё не выпущен'),{code:'WARRANTY_NOT_ACTIVE',statusCode:409});
      const warranty=(await c.query('SELECT id,warranty_until FROM warranty_cards WHERE request_id=$1 AND warranty_until>=CURRENT_DATE',[parent.id])).rows[0];
      if(!warranty)throw Object.assign(new Error('Гарантия по исходному заказу не активна'),{code:'WARRANTY_NOT_ACTIVE',statusCode:409});
    }
    const duplicate=(await c.query(`SELECT l.child_request_id,r.number FROM request_order_links l JOIN requests r ON r.id=l.child_request_id WHERE l.parent_request_id=$1 AND l.link_type=$2 AND r.deleted_at IS NULL AND r.status NOT IN('CLOSED','CANCELLED') ORDER BY l.id DESC LIMIT 1`,[parent.id,type])).rows[0];
    if(duplicate)throw Object.assign(new Error(`Уже есть активный повторный заказ ${duplicate.number}`),{code:'ACTIVE_REWORK_EXISTS',statusCode:409});
    const branch=(await c.query('SELECT id,code FROM branches WHERE id=$1 AND active=true',[parent.branch_id])).rows[0];
    if(!branch)throw Object.assign(new Error('Филиал исходного заказа отключён'),{code:'BRANCH_NOT_FOUND',statusCode:409});
    let engineerId=positiveId(parent.engineer_id);
    if(engineerId&&!await sameBranchUser(c,engineerId,parent.branch_id,{engineer:true}))engineerId=null;
    let managerId=positiveId(parent.manager_id);
    if(managerId&&!await sameBranchUser(c,managerId,parent.branch_id))managerId=null;
    if(req.user.role==='MANAGER')managerId=req.user.id;
    const seq=(await c.query("SELECT nextval('request_number_seq') n")).rows[0].n;
    const number=`${branch.code}-${new Date().getFullYear()}-${String(seq).padStart(7,'0')}`;
    const complaint=(type==='WARRANTY_REWORK'?'Гарантийное повторное обращение: ':'Повторный ремонт: ')+reason;
    const child=(await c.query(`INSERT INTO requests(number,customer_id,equipment_id,manager_id,engineer_id,status,priority,source,complaint,scheduled_at,sla_deadline,original_request_id,branch_id)
      VALUES($1,$2,$3,$4,$5,$6,'HIGH',$7,$8,$9,now()+interval '1 hour',$10,$11) RETURNING *`,[number,parent.customer_id,parent.equipment_id,managerId,engineerId,engineerId?'ASSIGNED':'NEW',type,complaint,scheduled?.toISOString()||null,parent.id,parent.branch_id])).rows[0];
    const link=(await c.query('INSERT INTO request_order_links(parent_request_id,child_request_id,link_type,reason,created_by) VALUES($1,$2,$3,$4,$5) RETURNING *',[parent.id,child.id,type,reason,req.user.id])).rows[0];
    await c.query(`INSERT INTO request_history(request_id,user_id,action,details) VALUES($1,$2,'REWORK_CHILD_CREATED',$3),($4,$2,'REWORK_CREATED_FROM_PARENT',$5)`,[parent.id,req.user.id,{link_id:link.id,child_request_id:child.id,child_number:child.number,link_type:type,reason},child.id,{link_id:link.id,parent_request_id:parent.id,parent_number:parent.number,link_type:type,reason}]);
    return{link,request:child};
  });
  return reply.code(201).send({data:result});
});

app.get('/api/v1/lifecycle/exceptions',{preHandler:operations},async req=>{
  let branches=null;
  if(req.user.role==='MANAGER')branches=(await q('SELECT branch_id FROM user_branches WHERE user_id=$1',[req.user.id])).rows.map(x=>Number(x.branch_id));
  const params=[],branchSql=branches?(params.push(branches),` AND r.branch_id=ANY($${params.length}::int[])`):'';
  const holds=(await q(`SELECT h.*,r.number,r.status request_status,r.branch_id,c.name customer_name,u.name responsible_name FROM request_holds h JOIN requests r ON r.id=h.request_id JOIN customers c ON c.id=r.customer_id LEFT JOIN users u ON u.id=h.responsible_id WHERE h.resumed_at IS NULL AND r.deleted_at IS NULL AND r.status NOT IN('CLOSED','CANCELLED')${branchSql} ORDER BY (h.expected_until IS NOT NULL AND h.expected_until<now()) DESC,h.expected_until NULLS LAST,h.started_at`,params)).rows;
  const visits=(await q(`SELECT v.*,r.number,r.status request_status,r.branch_id,c.name customer_name,e.name engineer_name FROM request_visit_attempts v JOIN requests r ON r.id=v.request_id JOIN customers c ON c.id=r.customer_id LEFT JOIN users e ON e.id=v.engineer_id WHERE v.outcome='SCHEDULED' AND r.deleted_at IS NULL AND r.status NOT IN('CLOSED','CANCELLED')${branchSql} ORDER BY (v.scheduled_at<now()) DESC,v.scheduled_at`,params)).rows;
  return{data:{holds,visits,summary:{active_holds:holds.length,overdue_holds:holds.filter(x=>x.expected_until&&new Date(x.expected_until)<new Date()).length,scheduled_visits:visits.length,overdue_visits:visits.filter(x=>new Date(x.scheduled_at)<new Date()).length}}};
});

const close=async()=>{try{await pool.end()}finally{process.exit(0)}};process.on('SIGTERM',close);process.on('SIGINT',close);
app.listen({port:Number(process.env.PORT||8108),host:'0.0.0.0'});
