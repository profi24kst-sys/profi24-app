import {createHash,createHmac,randomBytes} from 'node:crypto';

const secret=()=>process.env.VISIT_TOKEN_SECRET||process.env.JWT_SECRET||'dev-visit-secret-change-me';
const baseUrl=()=>String(process.env.PUBLIC_BASE_URL||'http://localhost:5173').replace(/\/+$/,'');
const tokenFor=(requestId,version,nonce)=>createHmac('sha256',secret()).update(`${requestId}:${version}:${nonce}`).digest('base64url');
const tokenHash=token=>createHash('sha256').update(String(token||'')).digest('hex');
const publicUrl=row=>`${baseUrl()}/visit/${tokenFor(row.request_id,row.version,row.token_nonce)}`;
const apiError=(code,message,statusCode=409)=>Object.assign(new Error(message),{code,statusCode});
const fmt=v=>v?new Date(v).toLocaleString('ru-RU',{timeZone:'Asia/Qostanay',day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}):'не назначено';
const sameSnapshot=(row,order)=>Boolean(row&&order&&order.scheduled_at&&new Date(row.scheduled_at_snapshot).getTime()===new Date(order.scheduled_at).getTime()&&Number(row.engineer_id||0)===Number(order.engineer_id||0));
const activeOrder=order=>Boolean(order&&!order.deleted_at&&!['CLOSED','CANCELLED'].includes(order.status)&&order.scheduled_at&&order.engineer_id);

async function withTransaction(pool,fn){const c=await pool.connect();try{await c.query('BEGIN');const out=await fn(c);await c.query('COMMIT');return out}catch(e){await c.query('ROLLBACK');throw e}finally{c.release()}}
async function pickFollowupAssignee(c,branchId){for(const role of ['SUPERVISOR','MANAGER']){const row=(await c.query(`SELECT u.id FROM users u JOIN user_branches ub ON ub.user_id=u.id WHERE u.active=true AND u.role=$1 AND ub.branch_id=$2 ORDER BY ub.is_primary DESC,u.id LIMIT 1`,[role,branchId])).rows[0];if(row)return Number(row.id)}const owner=(await c.query("SELECT id FROM users WHERE active=true AND role='OWNER' ORDER BY id LIMIT 1")).rows[0];return owner?Number(owner.id):null}

export async function installCustomerVisitConfirmation(app,pool,{enqueue,requestData,vars,render,roles}){
  await pool.query(`INSERT INTO message_templates(code,name,audience,channel,body) VALUES('CUSTOMER_VISIT_CONFIRMATION','Подтверждение времени визита','CUSTOMER','WHATSAPP','{{customer_name}}, инженер {{engineer_name}} планирует визит по заявке {{request_number}} на {{scheduled_at}}. Подтвердите время или сообщите, что нужен перенос: {{visit_url}}') ON CONFLICT(code) DO NOTHING`);

  async function currentOrder(requestId,client=pool){return (await client.query(`SELECT r.id,r.number,r.customer_id,r.engineer_id,r.branch_id,r.status,r.scheduled_at,r.deleted_at,c.name customer_name,e.category,e.brand,e.model,u.name engineer_name FROM requests r JOIN customers c ON c.id=r.customer_id LEFT JOIN equipment e ON e.id=r.equipment_id LEFT JOIN users u ON u.id=r.engineer_id WHERE r.id=$1`,[requestId])).rows[0]||null}
  async function managerCanAccess(user,requestId){if(user?.role!=='MANAGER')return true;return Boolean((await pool.query(`SELECT 1 FROM requests r JOIN user_branches ub ON ub.branch_id=r.branch_id AND ub.user_id=$2 WHERE r.id=$1 AND r.deleted_at IS NULL LIMIT 1`,[requestId,user.id])).rows[0])}

  async function ensureConfirmation(requestId){
    return withTransaction(pool,async c=>{
      await c.query('SELECT id FROM requests WHERE id=$1 FOR UPDATE',[requestId]);
      const order=await currentOrder(requestId,c);
      if(!order||order.deleted_at)throw apiError('NOT_FOUND','Заказ не найден',404);
      const current=(await c.query('SELECT * FROM customer_visit_confirmations WHERE request_id=$1 AND is_current=true FOR UPDATE',[requestId])).rows[0]||null;
      if(!activeOrder(order)){
        if(current)await c.query('UPDATE customer_visit_confirmations SET is_current=false,updated_at=now() WHERE id=$1',[current.id]);
        const skipped=['CLOSED','CANCELLED'].includes(order.status)?'inactive_order':!order.scheduled_at?'no_schedule':'no_engineer';
        return {skipped};
      }
      if(current&&sameSnapshot(current,order))return {confirmation:current,order,reused:true};
      if(current)await c.query('UPDATE customer_visit_confirmations SET is_current=false,updated_at=now() WHERE id=$1',[current.id]);
      const version=Number((await c.query('SELECT COALESCE(max(version),0)+1 version FROM customer_visit_confirmations WHERE request_id=$1',[requestId])).rows[0].version);
      const nonce=randomBytes(24).toString('base64url'),hash=tokenHash(tokenFor(requestId,version,nonce));
      const row=(await c.query(`INSERT INTO customer_visit_confirmations(request_id,customer_id,engineer_id,branch_id,version,token_nonce,token_hash,scheduled_at_snapshot,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,GREATEST($8::timestamptz+interval '12 hours',now()+interval '1 hour')) RETURNING *`,[requestId,order.customer_id,order.engineer_id,order.branch_id||null,version,nonce,hash,order.scheduled_at])).rows[0];
      return {confirmation:row,order,reused:false};
    });
  }

  async function enqueueInvite({request_id,history_id=null,dedupe_key=null,created_by=null}={}){
    const ensured=await ensureConfirmation(Number(request_id));
    if(!ensured.confirmation)return {...ensured,handled:false};
    const {confirmation,order}=ensured;
    if(confirmation.status!=='PENDING')return {confirmation,order,skipped:'already_responded',handled:true};
    const template=(await pool.query("SELECT * FROM message_templates WHERE code='CUSTOMER_VISIT_CONFIRMATION' AND active=true")).rows[0];
    if(!template)return {confirmation,order,skipped:'template_disabled',handled:false};
    const visit_url=publicUrl(confirmation),data=await requestData(Number(request_id));
    const body=render(template.body,{...vars(data||order),scheduled_at:fmt(confirmation.scheduled_at_snapshot),visit_url});
    const queued=await enqueue({request_id:Number(request_id),history_id,template_code:template.code,audience:'CUSTOMER',channel:template.channel,body,dedupe_key:dedupe_key||`visit:${confirmation.id}:invite`,created_by});
    if(queued)await pool.query('UPDATE customer_visit_confirmations SET invite_count=invite_count+1,last_invited_at=now(),updated_at=now() WHERE id=$1',[confirmation.id]);
    return {confirmation,queued,visit_url,handled:true};
  }

  async function onHistory(h){
    if(!['REQUEST_ASSIGNED','SCHEDULE_CHANGED'].includes(h.action))return {handled:false};
    const created=new Date(h.created_at).getTime();
    if(!Number.isFinite(created)||Date.now()-created>60*60*1000)return {handled:false,skipped:'stale_history'};
    return enqueueInvite({request_id:h.request_id,history_id:h.id,dedupe_key:`history:${h.id}:CUSTOMER_VISIT_CONFIRMATION`});
  }

  async function byToken(token,client=pool){if(!token||String(token).length>256)return null;return (await client.query(`SELECT v.*,r.number request_number,r.status request_status,r.scheduled_at current_scheduled_at,r.engineer_id current_engineer_id,r.deleted_at request_deleted_at,e.category,e.brand,e.model,u.name engineer_name FROM customer_visit_confirmations v JOIN requests r ON r.id=v.request_id LEFT JOIN equipment e ON e.id=r.equipment_id LEFT JOIN users u ON u.id=v.engineer_id WHERE v.token_hash=$1`,[tokenHash(token)])).rows[0]||null}
  const tokenCurrent=row=>Boolean(row&&row.is_current&&!row.request_deleted_at&&!['CLOSED','CANCELLED'].includes(row.request_status)&&row.current_scheduled_at&&row.current_engineer_id&&new Date(row.scheduled_at_snapshot).getTime()===new Date(row.current_scheduled_at).getTime()&&Number(row.engineer_id||0)===Number(row.current_engineer_id||0));

  app.get('/public/v1/visit/:token',async(req,reply)=>{
    const row=await byToken(req.params.token);if(!row)return reply.code(404).send({data:null,error:{code:'NOT_FOUND',message:'Ссылка подтверждения недействительна'}});
    if(!tokenCurrent(row))return reply.code(410).send({data:null,error:{code:'SUPERSEDED',message:'Время визита изменилось. Используйте последнюю ссылку из сообщения сервисного центра.'}});
    if(row.status==='PENDING'&&new Date(row.expires_at)<new Date())return reply.code(410).send({data:null,error:{code:'EXPIRED',message:'Срок действия ссылки истёк'}});
    return {data:{request_number:row.request_number,equipment:[row.category,row.brand,row.model].filter(Boolean).join(' ')||'Техника',engineer_name:row.engineer_name||'Инженер',scheduled_at:row.scheduled_at_snapshot,status:row.status,version:Number(row.version),responded:row.status!=='PENDING'}};
  });

  app.post('/public/v1/visit/:token',async(req,reply)=>{
    const decision=String(req.body?.decision||''),comment=String(req.body?.comment||'').trim();
    if(!['CONFIRM','RESCHEDULE'].includes(decision))return reply.code(422).send({data:null,error:{code:'VALIDATION',message:'Выберите подтверждение или перенос визита'}});
    if(comment.length>500)return reply.code(422).send({data:null,error:{code:'VALIDATION',message:'Комментарий не должен превышать 500 символов'}});
    try{
      const result=await withTransaction(pool,async c=>{
        const row=await byToken(req.params.token,c);if(!row)throw apiError('NOT_FOUND','Ссылка подтверждения недействительна',404);
        await c.query('SELECT id FROM requests WHERE id=$1 FOR UPDATE',[row.request_id]);
        const order=await currentOrder(row.request_id,c);
        const locked=(await c.query('SELECT * FROM customer_visit_confirmations WHERE id=$1 FOR UPDATE',[row.id])).rows[0];
        if(!locked.is_current||!activeOrder(order)||!sameSnapshot(locked,order))throw apiError('SUPERSEDED','Время визита уже изменилось. Используйте последнюю ссылку.',410);
        if(locked.status!=='PENDING')throw apiError('ALREADY_RESPONDED','Ответ по этому времени уже сохранён',409);
        if(new Date(locked.expires_at)<new Date())throw apiError('EXPIRED','Срок действия ссылки истёк',410);
        let taskId=null,status='CONFIRMED',action='CUSTOMER_VISIT_CONFIRMED';
        if(decision==='RESCHEDULE'){
          status='RESCHEDULE_REQUESTED';action='CUSTOMER_VISIT_RESCHEDULE_REQUESTED';
          const assigned=await pickFollowupAssignee(c,locked.branch_id);
          if(assigned){const task=(await c.query(`INSERT INTO tasks(title,request_id,assigned_to,priority,status,due_at,created_by) VALUES($1,$2,$3,'HIGH','OPEN',now()+interval '30 minutes',NULL) RETURNING id`,[`Клиент просит перенести визит`,locked.request_id,assigned])).rows[0];taskId=Number(task.id)}
        }
        await c.query('UPDATE customer_visit_confirmations SET status=$1,response_comment=$2,responded_at=now(),followup_task_id=$3,updated_at=now() WHERE id=$4',[status,comment||null,taskId,locked.id]);
        await c.query('INSERT INTO request_history(request_id,user_id,action,details) VALUES($1,NULL,$2,$3)',[locked.request_id,action,{visit_confirmation_id:Number(locked.id),version:Number(locked.version),scheduled_at:locked.scheduled_at_snapshot,comment:comment||null,followup_task_id:taskId}]);
        return {status,followup_created:Boolean(taskId)};
      });
      return reply.send({data:result});
    }catch(e){return reply.code(e.statusCode||422).send({data:null,error:{code:e.code||'VALIDATION',message:e.message}})}
  });

  app.get('/api/v1/visit-confirmations',{preHandler:roles('OWNER','SUPERVISOR','MANAGER')},async req=>{
    const branchIds=req.user.role==='MANAGER'?(await pool.query('SELECT branch_id FROM user_branches WHERE user_id=$1',[req.user.id])).rows.map(x=>Number(x.branch_id)):null;
    if(req.user.role==='MANAGER'&&!branchIds.length)return {data:[]};
    const rows=(await pool.query(`SELECT v.*,r.number request_number,c.name customer_name,u.name engineer_name,t.status followup_status,t.due_at followup_due_at FROM customer_visit_confirmations v JOIN requests r ON r.id=v.request_id JOIN customers c ON c.id=v.customer_id LEFT JOIN users u ON u.id=v.engineer_id LEFT JOIN tasks t ON t.id=v.followup_task_id WHERE v.is_current=true AND ($1::text<>'MANAGER' OR v.branch_id=ANY($2::int[])) ORDER BY v.scheduled_at_snapshot DESC LIMIT 500`,[req.user.role,branchIds||[]])).rows;
    return {data:rows};
  });

  app.post('/api/v1/visit-confirmations/:requestId/resend',{preHandler:roles('OWNER','SUPERVISOR','MANAGER')},async(req,reply)=>{
    const requestId=Number(req.params.requestId);
    if(!Number.isSafeInteger(requestId)||requestId<1)return reply.code(422).send({data:null,error:{code:'VALIDATION',message:'Некорректная заявка'}});
    if(!await managerCanAccess(req.user,requestId))return reply.code(403).send({data:null,error:{code:'FORBIDDEN',message:'Заявка другого филиала недоступна'}});
    try{const out=await enqueueInvite({request_id:requestId,created_by:req.user.id,dedupe_key:`visit-resend:${requestId}:${Date.now()}`});if(!out.confirmation)return reply.code(409).send({data:null,error:{code:'NOT_AVAILABLE',message:'Для заявки нет активного времени визита с назначенным инженером'}});return reply.code(201).send({data:out})}catch(e){return reply.code(e.statusCode||422).send({data:null,error:{code:e.code||'VALIDATION',message:e.message}})}
  });

  return {ensureConfirmation,enqueueInvite,onHistory,byToken};
}
