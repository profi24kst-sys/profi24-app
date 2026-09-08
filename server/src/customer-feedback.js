import {createHash,createHmac,randomBytes} from 'node:crypto';

const q=(pool,sql,params=[])=>pool.query(sql,params);
const feedbackSecret=()=>process.env.FEEDBACK_TOKEN_SECRET||process.env.JWT_SECRET||'dev-feedback-secret-change-me';
const baseUrl=()=>String(process.env.PUBLIC_BASE_URL||'http://localhost:5173').replace(/\/+$/,'');
const tokenFor=(requestId,nonce)=>createHmac('sha256',feedbackSecret()).update(`${requestId}:${nonce}`).digest('base64url');
const tokenHash=token=>createHash('sha256').update(String(token||'')).digest('hex');
const npsGroup=score=>score<=6?'DETRACTOR':score<=8?'PASSIVE':'PROMOTER';
const publicUrl=feedback=>`${baseUrl()}/feedback/${tokenFor(feedback.request_id,feedback.token_nonce)}`;
const apiError=(code,message,statusCode=409)=>Object.assign(new Error(message),{code,statusCode});
const normalizeUrl=value=>{
  const s=String(value||'').trim();
  if(!s)return null;
  let u;try{u=new URL(s)}catch{throw apiError('VALIDATION','Некорректная ссылка публичного отзыва',422)}
  if(!['http:','https:'].includes(u.protocol))throw apiError('VALIDATION','Ссылка публичного отзыва должна начинаться с http:// или https://',422);
  return u.toString();
};

async function withTransaction(pool,fn){
  const c=await pool.connect();
  try{await c.query('BEGIN');const out=await fn(c);await c.query('COMMIT');return out}catch(e){await c.query('ROLLBACK');throw e}finally{c.release()}
}

async function managerBranchIds(pool,user){
  if(user?.role!=='MANAGER')return null;
  return (await q(pool,'SELECT branch_id FROM user_branches WHERE user_id=$1 ORDER BY branch_id',[user.id])).rows.map(x=>Number(x.branch_id));
}

async function assertOfficeOrderAccess(pool,user,requestId,{closed=true}={}){
  const id=Number(requestId);
  if(!Number.isSafeInteger(id)||id<1)throw apiError('VALIDATION','Некорректный заказ',422);
  const row=(await q(pool,'SELECT id,number,status,branch_id,deleted_at FROM requests WHERE id=$1',[id])).rows[0];
  if(!row||row.deleted_at)throw apiError('NOT_FOUND','Заказ не найден',404);
  if(closed&&row.status!=='CLOSED')throw apiError('ORDER_NOT_CLOSED','Опрос можно отправить только после закрытия заказа',409);
  if(user?.role==='MANAGER'){
    const ok=(await q(pool,'SELECT 1 FROM user_branches WHERE user_id=$1 AND branch_id=$2 LIMIT 1',[user.id,row.branch_id])).rows[0];
    if(!ok)throw apiError('FORBIDDEN','Заказ относится к другому филиалу',403);
  }
  return row;
}

async function pickFollowupAssignee(c,branchId){
  for(const role of ['SUPERVISOR','MANAGER']){
    const row=(await c.query(`SELECT u.id FROM users u JOIN user_branches ub ON ub.user_id=u.id WHERE u.active=true AND u.role=$1 AND ub.branch_id=$2 ORDER BY ub.is_primary DESC,u.id LIMIT 1`,[role,branchId])).rows[0];
    if(row)return Number(row.id);
  }
  const owner=(await c.query("SELECT id FROM users WHERE active=true AND role='OWNER' ORDER BY id LIMIT 1")).rows[0];
  return owner?Number(owner.id):null;
}

export async function installCustomerFeedback(app,pool,{enqueue,requestData,vars,render,roles}){
  await q(pool,`INSERT INTO message_templates(code,name,audience,channel,body)
    VALUES('CUSTOMER_FEEDBACK_REQUEST','Оценка сервиса после ремонта','CUSTOMER','WHATSAPP',
    'Спасибо, {{customer_name}}! Оцените, пожалуйста, сервис PROFI24KST по заказу {{request_number}}: {{feedback_url}}. Опрос займёт меньше минуты.')
    ON CONFLICT(code) DO NOTHING`);

  async function settings(){return (await q(pool,'SELECT * FROM customer_feedback_settings WHERE id=1')).rows[0]}

  async function ensureFeedback(requestId,{rotate=false}={}){
    const order=(await q(pool,`SELECT r.id,r.customer_id,r.engineer_id,r.branch_id,r.status,r.deleted_at
      FROM requests r WHERE r.id=$1`,[requestId])).rows[0];
    if(!order||order.deleted_at)throw apiError('NOT_FOUND','Заказ не найден',404);
    if(order.status!=='CLOSED')throw apiError('ORDER_NOT_CLOSED','Опрос можно отправить только после закрытия заказа',409);
    let row=(await q(pool,'SELECT * FROM customer_feedback WHERE request_id=$1',[requestId])).rows[0];
    if(row?.status==='RESPONDED')throw apiError('ALREADY_RESPONDED','Клиент уже оставил оценку по этому заказу',409);
    if(!row){
      const nonce=randomBytes(24).toString('base64url');
      const hash=tokenHash(tokenFor(requestId,nonce));
      row=(await q(pool,`INSERT INTO customer_feedback(request_id,customer_id,engineer_id,branch_id,token_nonce,token_hash,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,now()+interval '90 days') RETURNING *`,[requestId,order.customer_id,order.engineer_id,order.branch_id,nonce,hash])).rows[0];
    }else if(rotate){
      const nonce=randomBytes(24).toString('base64url');
      const hash=tokenHash(tokenFor(requestId,nonce));
      row=(await q(pool,`UPDATE customer_feedback SET token_nonce=$1,token_hash=$2,expires_at=now()+interval '90 days',updated_at=now() WHERE id=$3 RETURNING *`,[nonce,hash,row.id])).rows[0];
    }
    return row;
  }

  async function enqueueInvite({request_id,history_id=null,rotate=false,dedupe_key=null,created_by=null}={}){
    const cfg=await settings();
    if(!cfg?.active)return {skipped:'disabled'};
    const feedback=await ensureFeedback(Number(request_id),{rotate});
    const data=await requestData(Number(request_id));
    if(!data)throw apiError('NOT_FOUND','Заказ не найден',404);
    const template=(await q(pool,"SELECT * FROM message_templates WHERE code='CUSTOMER_FEEDBACK_REQUEST' AND active=true")).rows[0];
    if(!template)return {skipped:'template_disabled',feedback};
    const feedback_url=publicUrl(feedback);
    const body=render(template.body,{...vars(data),feedback_url});
    const queued=await enqueue({request_id:Number(request_id),history_id,template_code:template.code,audience:'CUSTOMER',channel:template.channel,body,dedupe_key:dedupe_key||`feedback:${request_id}:initial`,created_by});
    if(queued)await q(pool,'UPDATE customer_feedback SET invite_count=invite_count+1,last_invited_at=now(),updated_at=now() WHERE id=$1',[feedback.id]);
    return {feedback,queued,feedback_url};
  }

  async function feedbackByToken(token,client=pool){
    if(!token||String(token).length>256)return null;
    return (await client.query(`SELECT f.*,r.number request_number,r.status request_status,e.category,e.brand,e.model
      FROM customer_feedback f JOIN requests r ON r.id=f.request_id
      LEFT JOIN equipment e ON e.id=r.equipment_id
      WHERE f.token_hash=$1 AND r.deleted_at IS NULL`,[tokenHash(token)])).rows[0]||null;
  }

  app.get('/public/v1/feedback/:token',async(req,reply)=>{
    const row=await feedbackByToken(req.params.token);
    if(!row)return reply.code(404).send({data:null,error:{code:'NOT_FOUND',message:'Ссылка опроса недействительна'}});
    if(row.status!=='RESPONDED'&&new Date(row.expires_at)<new Date())return reply.code(410).send({data:null,error:{code:'EXPIRED',message:'Срок действия ссылки истёк'}});
    const cfg=await settings();
    return {data:{request_number:row.request_number,equipment:[row.category,row.brand,row.model].filter(Boolean).join(' ')||'Техника',responded:row.status==='RESPONDED',score:row.status==='RESPONDED'?Number(row.score):null,review_url:cfg?.public_review_url||null}};
  });

  app.post('/public/v1/feedback/:token',async(req,reply)=>{
    const score=Number(req.body?.score),comment=String(req.body?.comment||'').trim(),contactRequested=req.body?.contact_requested===true;
    if(!Number.isInteger(score)||score<0||score>10)return reply.code(422).send({data:null,error:{code:'VALIDATION',message:'Оценка должна быть целым числом от 0 до 10'}});
    if(comment.length>2000)return reply.code(422).send({data:null,error:{code:'VALIDATION',message:'Комментарий не должен превышать 2000 символов'}});
    const result=await withTransaction(pool,async c=>{
      const row=await feedbackByToken(req.params.token,c);
      if(!row)throw apiError('NOT_FOUND','Ссылка опроса недействительна',404);
      const locked=(await c.query('SELECT * FROM customer_feedback WHERE id=$1 FOR UPDATE',[row.id])).rows[0];
      if(locked.status==='RESPONDED')throw apiError('ALREADY_RESPONDED','Оценка по этому заказу уже сохранена',409);
      if(new Date(locked.expires_at)<new Date())throw apiError('EXPIRED','Срок действия ссылки истёк',410);
      const cfg=(await c.query('SELECT * FROM customer_feedback_settings WHERE id=1')).rows[0];
      let taskId=null;
      if(score<=Number(cfg.low_score_threshold)||contactRequested){
        const assigned=await pickFollowupAssignee(c,locked.branch_id);
        if(assigned){
          const task=(await c.query(`INSERT INTO tasks(title,request_id,assigned_to,priority,status,due_at,created_by)
            VALUES($1,$2,$3,'HIGH','OPEN',now()+interval '4 hours',NULL) RETURNING id`,[`NPS ${score}/10 — связаться с клиентом`,locked.request_id,assigned])).rows[0];
          taskId=Number(task.id);
        }
      }
      await c.query(`UPDATE customer_feedback SET status='RESPONDED',score=$1,comment=$2,contact_requested=$3,responded_at=now(),followup_task_id=$4,updated_at=now() WHERE id=$5`,[score,comment||null,contactRequested,taskId,locked.id]);
      await c.query(`INSERT INTO request_history(request_id,user_id,action,details) VALUES($1,NULL,'CUSTOMER_FEEDBACK_RECEIVED',$2)`,[locked.request_id,{score,nps_group:npsGroup(score),contact_requested:contactRequested,followup_task_id:taskId}]);
      return {score,nps_group:npsGroup(score),followup_created:Boolean(taskId),review_url:cfg.public_review_url||null};
    });
    return reply.send({data:result});
  });

  app.get('/api/v1/customer-feedback/settings',{preHandler:roles('OWNER','MANAGER')},async()=>({data:await settings()}));

  app.patch('/api/v1/customer-feedback/settings',{preHandler:roles('OWNER','SUPERVISOR')},async(req,reply)=>{
    const body=req.body||{},threshold=body.low_score_threshold===undefined?undefined:Number(body.low_score_threshold);
    if(threshold!==undefined&&(!Number.isInteger(threshold)||threshold<0||threshold>10))return reply.code(422).send({data:null,error:{code:'VALIDATION',message:'Порог контакта должен быть от 0 до 10'}});
    const old=await settings();
    const reviewUrl=body.public_review_url===undefined?old.public_review_url:normalizeUrl(body.public_review_url);
    const row=(await q(pool,`UPDATE customer_feedback_settings SET active=$1,low_score_threshold=$2,public_review_url=$3,updated_by=$4,updated_at=now() WHERE id=1 RETURNING *`,[
      body.active===undefined?old.active:Boolean(body.active),threshold===undefined?old.low_score_threshold:threshold,reviewUrl,req.user.id
    ])).rows[0];
    return {data:row};
  });

  app.get('/api/v1/customer-feedback',{preHandler:roles('OWNER','MANAGER')},async req=>{
    const branches=await managerBranchIds(pool,req.user);
    if(req.user.role==='MANAGER'&&!branches.length)return {data:[]};
    const rows=(await q(pool,`SELECT f.*,r.number request_number,c.name customer_name,u.name engineer_name,b.name branch_name,t.status followup_status,t.due_at followup_due_at,
      CASE WHEN f.score IS NULL THEN NULL WHEN f.score<=6 THEN 'DETRACTOR' WHEN f.score<=8 THEN 'PASSIVE' ELSE 'PROMOTER' END nps_group
      FROM customer_feedback f JOIN requests r ON r.id=f.request_id JOIN customers c ON c.id=f.customer_id
      LEFT JOIN users u ON u.id=f.engineer_id LEFT JOIN branches b ON b.id=f.branch_id LEFT JOIN tasks t ON t.id=f.followup_task_id
      WHERE ($1::text<>'MANAGER' OR f.branch_id=ANY($2::int[]))
      ORDER BY f.created_at DESC LIMIT 500`,[req.user.role,branches||[]])).rows;
    return {data:rows};
  });

  app.get('/api/v1/customer-feedback/summary',{preHandler:roles('OWNER','MANAGER')},async(req,reply)=>{
    const days=Number(req.query?.days||30);
    if(!Number.isInteger(days)||days<1||days>3650)return reply.code(422).send({data:null,error:{code:'VALIDATION',message:'Период должен быть от 1 до 3650 дней'}});
    const branches=await managerBranchIds(pool,req.user);
    if(req.user.role==='MANAGER'&&!branches.length)return {data:{days,invited:0,responded:0,response_rate:0,promoters:0,passives:0,detractors:0,nps:null,average_score:null,followups_open:0,by_engineer:[]}};
    const args=[days,req.user.role,branches||[]];
    const total=(await q(pool,`SELECT count(*)::int invited,
      count(*) FILTER(WHERE responded_at IS NOT NULL)::int responded,
      count(*) FILTER(WHERE score>=9)::int promoters,
      count(*) FILTER(WHERE score BETWEEN 7 AND 8)::int passives,
      count(*) FILTER(WHERE score<=6)::int detractors,
      round(avg(score)::numeric,1) average_score,
      count(*) FILTER(WHERE followup_task_id IS NOT NULL AND EXISTS(SELECT 1 FROM tasks t WHERE t.id=followup_task_id AND t.status='OPEN'))::int followups_open
      FROM customer_feedback f WHERE f.created_at>=now()-($1::int*interval '1 day') AND ($2::text<>'MANAGER' OR f.branch_id=ANY($3::int[]))`,args)).rows[0];
    const byEngineer=(await q(pool,`SELECT f.engineer_id,COALESCE(u.name,'Не назначен') engineer_name,count(*) FILTER(WHERE f.responded_at IS NOT NULL)::int responded,
      round(avg(f.score)::numeric,1) average_score,count(*) FILTER(WHERE f.score>=9)::int promoters,count(*) FILTER(WHERE f.score<=6)::int detractors
      FROM customer_feedback f LEFT JOIN users u ON u.id=f.engineer_id
      WHERE f.created_at>=now()-($1::int*interval '1 day') AND ($2::text<>'MANAGER' OR f.branch_id=ANY($3::int[]))
      GROUP BY f.engineer_id,u.name HAVING count(*) FILTER(WHERE f.responded_at IS NOT NULL)>0 ORDER BY responded DESC,engineer_name`,args)).rows;
    const metrics=row=>{const responded=Number(row.responded||0),promoters=Number(row.promoters||0),detractors=Number(row.detractors||0);return {...row,responded,promoters,detractors,nps:responded?Math.round(((promoters-detractors)*1000)/responded)/10:null}};
    const m=metrics(total),invited=Number(total.invited||0);
    return {data:{days,invited,responded:m.responded,response_rate:invited?Math.round((m.responded*1000)/invited)/10:0,promoters:m.promoters,passives:Number(total.passives||0),detractors:m.detractors,nps:m.nps,average_score:total.average_score==null?null:Number(total.average_score),followups_open:Number(total.followups_open||0),by_engineer:byEngineer.map(metrics)}};
  });

  app.post('/api/v1/customer-feedback/invite/:id',{preHandler:roles('OWNER','MANAGER')},async(req,reply)=>{
    await assertOfficeOrderAccess(pool,req.user,req.params.id,{closed:true});
    const existing=(await q(pool,'SELECT id,status FROM customer_feedback WHERE request_id=$1',[req.params.id])).rows[0];
    if(existing?.status==='RESPONDED')return reply.code(409).send({data:null,error:{code:'ALREADY_RESPONDED',message:'Клиент уже оставил оценку'}});
    const result=await enqueueInvite({request_id:Number(req.params.id),rotate:Boolean(existing),dedupe_key:`feedback:${req.params.id}:manual:${Date.now()}`,created_by:req.user.id});
    return reply.code(201).send({data:{feedback_id:result.feedback?.id||null,queued:Boolean(result.queued),status:result.queued?.status||result.skipped||null}});
  });

  app.post('/api/v1/customer-feedback/:id/resend',{preHandler:roles('OWNER','MANAGER')},async(req,reply)=>{
    const feedback=(await q(pool,'SELECT * FROM customer_feedback WHERE id=$1',[req.params.id])).rows[0];
    if(!feedback)return reply.code(404).send({data:null,error:{code:'NOT_FOUND',message:'Опрос не найден'}});
    await assertOfficeOrderAccess(pool,req.user,feedback.request_id,{closed:true});
    if(feedback.status==='RESPONDED')return reply.code(409).send({data:null,error:{code:'ALREADY_RESPONDED',message:'Клиент уже оставил оценку'}});
    const result=await enqueueInvite({request_id:Number(feedback.request_id),rotate:true,dedupe_key:`feedback:${feedback.request_id}:resend:${Date.now()}`,created_by:req.user.id});
    return reply.code(201).send({data:{feedback_id:feedback.id,queued:Boolean(result.queued),status:result.queued?.status||result.skipped||null}});
  });

  return {enqueueInvite,ensureFeedback,npsGroup};
}
