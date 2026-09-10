const TZ='Asia/Qostanay';
const REMINDER_WINDOW_MINUTES=180;
const ESCALATION_WINDOW_MINUTES=90;
const MIN_INVITE_AGE_FOR_REMINDER_MINUTES=30;
const MIN_INVITE_AGE_FOR_ESCALATION_MINUTES=10;

const minutesBetween=(a,b)=>Math.floor((new Date(a).getTime()-new Date(b).getTime())/60000);
const sameInstant=(a,b)=>Boolean(a&&b&&new Date(a).getTime()===new Date(b).getTime());
const activeOrder=o=>Boolean(o&&!o.deleted_at&&!['CLOSED','CANCELLED'].includes(o.status)&&o.scheduled_at&&o.engineer_id);
const currentSnapshot=(v,o)=>Boolean(v?.is_current&&activeOrder(o)&&sameInstant(v.scheduled_at_snapshot,o.scheduled_at)&&Number(v.engineer_id||0)===Number(o.engineer_id||0));

async function withTransaction(pool,fn){const c=await pool.connect();try{await c.query('BEGIN');const out=await fn(c);await c.query('COMMIT');return out}catch(e){try{await c.query('ROLLBACK')}catch{}throw e}finally{c.release()}}
async function pickAssignee(c,branchId){
 for(const role of ['SUPERVISOR','MANAGER']){
  const row=(await c.query(`SELECT u.id FROM users u JOIN user_branches ub ON ub.user_id=u.id WHERE u.active=true AND u.role=$1 AND ub.branch_id=$2 ORDER BY ub.is_primary DESC,u.id LIMIT 1`,[role,branchId])).rows[0];
  if(row)return Number(row.id);
 }
 const owner=(await c.query("SELECT id FROM users WHERE active=true AND role='OWNER' ORDER BY id LIMIT 1")).rows[0];
 return owner?Number(owner.id):null;
}
function readinessStatus(row){
 if(row.status==='CONFIRMED')return'READY';
 if(row.status==='RESCHEDULE_REQUESTED')return'RESCHEDULE_REQUIRED';
 if(row.confirmation_task_id&&row.confirmation_task_status==='OPEN')return'CALL_REQUIRED';
 return'AWAITING_CONFIRMATION';
}

export async function installVisitReadiness(app,pool,{visitWorkflow,roles}){
 async function closeResolvedTasks(now=new Date()){
  const result=await pool.query(`UPDATE tasks t SET
      status=CASE WHEN v.status='CONFIRMED' THEN 'DONE' ELSE 'CANCELLED' END,
      completed_at=CASE WHEN v.status='CONFIRMED' THEN COALESCE(t.completed_at,$1) ELSE t.completed_at END
    FROM customer_visit_confirmations v
    JOIN requests r ON r.id=v.request_id
    WHERE t.id=v.confirmation_task_id AND t.status='OPEN'
      AND (v.status<>'PENDING' OR v.is_current=false OR r.deleted_at IS NOT NULL OR r.status IN('CLOSED','CANCELLED')
        OR r.scheduled_at IS NULL OR r.engineer_id IS NULL
        OR v.scheduled_at_snapshot<>r.scheduled_at OR COALESCE(v.engineer_id,0)<>COALESCE(r.engineer_id,0)
        OR r.scheduled_at<=$1)`,[now]);
  return Number(result.rowCount||0);
 }

 async function createConfirmationTask(confirmationId,now=new Date()){
  return withTransaction(pool,async c=>{
   const v=(await c.query('SELECT * FROM customer_visit_confirmations WHERE id=$1 FOR UPDATE',[confirmationId])).rows[0];
   if(!v||v.status!=='PENDING'||!v.is_current||v.confirmation_task_id)return null;
   const order=(await c.query('SELECT id,number,branch_id,engineer_id,status,scheduled_at,deleted_at FROM requests WHERE id=$1 FOR UPDATE',[v.request_id])).rows[0];
   if(!currentSnapshot(v,order))return null;
   const remaining=minutesBetween(order.scheduled_at,now),inviteAge=v.last_invited_at?minutesBetween(now,v.last_invited_at):0;
   if(remaining<=0||remaining>ESCALATION_WINDOW_MINUTES||inviteAge<MIN_INVITE_AGE_FOR_ESCALATION_MINUTES)return null;
   const assigned=await pickAssignee(c,v.branch_id||order.branch_id);if(!assigned)return null;
   const dueMinutes=Math.max(1,Math.min(15,remaining-1));
   const task=(await c.query(`INSERT INTO tasks(title,request_id,assigned_to,priority,status,due_at,created_by) VALUES($1,$2,$3,'HIGH','OPEN',$4,NULL) RETURNING id,title,assigned_to,priority,status,due_at`,[`Срочно подтвердить визит с клиентом · ${order.number}`,order.id,assigned,new Date(now.getTime()+dueMinutes*60000)])).rows[0];
   await c.query('UPDATE customer_visit_confirmations SET confirmation_task_id=$1,updated_at=$2 WHERE id=$3',[task.id,now,v.id]);
   await c.query('INSERT INTO request_history(request_id,user_id,action,details) VALUES($1,NULL,$2,$3)',[order.id,'CUSTOMER_VISIT_CONFIRMATION_ESCALATED',{visit_confirmation_id:Number(v.id),version:Number(v.version),task_id:Number(task.id),scheduled_at:v.scheduled_at_snapshot,minutes_to_visit:remaining}]);
   return task;
  });
 }

 async function sync(now=new Date()){
  const closed_tasks=await closeResolvedTasks(now);
  const rows=(await pool.query(`SELECT v.*,r.number request_number,r.status request_status,r.scheduled_at current_scheduled_at,r.engineer_id current_engineer_id,r.deleted_at request_deleted_at
    FROM customer_visit_confirmations v JOIN requests r ON r.id=v.request_id
    WHERE v.is_current=true AND v.status='PENDING'
      AND r.deleted_at IS NULL AND r.status NOT IN('CLOSED','CANCELLED')
      AND r.scheduled_at IS NOT NULL AND r.engineer_id IS NOT NULL
      AND v.scheduled_at_snapshot=r.scheduled_at AND COALESCE(v.engineer_id,0)=COALESCE(r.engineer_id,0)
      AND r.scheduled_at>$1
    ORDER BY r.scheduled_at,v.id`,[now])).rows;
  let reminders=0,tasks=0;
  for(const v of rows){
   const remaining=minutesBetween(v.current_scheduled_at,now),inviteAge=v.last_invited_at?minutesBetween(now,v.last_invited_at):0;
   if(remaining<=REMINDER_WINDOW_MINUTES&&!v.reminder_sent_at&&v.last_invited_at&&inviteAge>=MIN_INVITE_AGE_FOR_REMINDER_MINUTES){
    const out=await visitWorkflow.enqueueInvite({request_id:Number(v.request_id),dedupe_key:`visit:${v.id}:readiness-reminder`});
    if(out?.handled&&Number(out.confirmation?.id)===Number(v.id)){
     const mark=await pool.query('UPDATE customer_visit_confirmations SET reminder_sent_at=COALESCE(reminder_sent_at,$1),updated_at=$1 WHERE id=$2 AND reminder_sent_at IS NULL',[now,v.id]);
     reminders+=Number(mark.rowCount||0);
    }
   }
   if(remaining<=ESCALATION_WINDOW_MINUTES&&inviteAge>=MIN_INVITE_AGE_FOR_ESCALATION_MINUTES){const task=await createConfirmationTask(v.id,now);if(task)tasks++}
  }
  return{checked:rows.length,reminders,tasks,closed_tasks};
 }

 async function rowsForUser(req,reply){
  const p=[],where=['v.is_current=true','r.deleted_at IS NULL'];
  if(req.user.role==='MANAGER'){
   const branchIds=(await pool.query('SELECT branch_id FROM user_branches WHERE user_id=$1 ORDER BY branch_id',[req.user.id])).rows.map(x=>Number(x.branch_id));
   if(!branchIds.length)return[];
   p.push(branchIds);where.push(`v.branch_id=ANY($${p.length}::int[])`);
  }
  const branchId=Number(req.query?.branch_id||0);if(branchId){
   if(req.user.role==='MANAGER'){
    const allowed=(await pool.query('SELECT 1 FROM user_branches WHERE user_id=$1 AND branch_id=$2',[req.user.id,branchId])).rows[0];
    if(!allowed){reply.code(403).send({data:null,error:{code:'FORBIDDEN',message:'Филиал недоступен пользователю'}});return null}
   }
   p.push(branchId);where.push(`v.branch_id=$${p.length}`);
  }
  const engineerId=Number(req.query?.engineer_id||0);if(engineerId){p.push(engineerId);where.push(`v.engineer_id=$${p.length}`)}
  const date=String(req.query?.date||'');if(/^\d{4}-\d{2}-\d{2}$/.test(date)){p.push(date);where.push(`DATE(v.scheduled_at_snapshot AT TIME ZONE '${TZ}')=$${p.length}::date`)}
  return(await pool.query(`SELECT v.id,v.request_id,v.customer_id,v.engineer_id,v.branch_id,v.version,v.status,v.scheduled_at_snapshot,v.invite_count,v.last_invited_at,v.reminder_sent_at,v.responded_at,v.response_comment,v.followup_task_id,v.confirmation_task_id,
      r.number request_number,r.status request_status,c.name customer_name,u.name engineer_name,
      ft.status followup_status,ft.due_at followup_due_at,ct.status confirmation_task_status,ct.due_at confirmation_task_due_at
    FROM customer_visit_confirmations v JOIN requests r ON r.id=v.request_id JOIN customers c ON c.id=v.customer_id
    LEFT JOIN users u ON u.id=v.engineer_id LEFT JOIN tasks ft ON ft.id=v.followup_task_id LEFT JOIN tasks ct ON ct.id=v.confirmation_task_id
    WHERE ${where.join(' AND ')} ORDER BY v.scheduled_at_snapshot,v.id`,p)).rows;
 }

 app.get('/api/v1/visit-readiness',{preHandler:roles('OWNER','SUPERVISOR','MANAGER')},async(req,reply)=>{
  const rows=await rowsForUser(req,reply);if(rows==null||reply.sent)return;
  const now=new Date(),data=rows.map(x=>({...x,minutes_to_visit:minutesBetween(x.scheduled_at_snapshot,now),readiness_status:readinessStatus(x)}));
  return{data:{summary:{total:data.length,ready:data.filter(x=>x.readiness_status==='READY').length,awaiting_confirmation:data.filter(x=>x.readiness_status==='AWAITING_CONFIRMATION').length,call_required:data.filter(x=>x.readiness_status==='CALL_REQUIRED').length,reschedule_required:data.filter(x=>x.readiness_status==='RESCHEDULE_REQUIRED').length},visits:data}};
 });

 return{sync,createConfirmationTask,closeResolvedTasks};
}
