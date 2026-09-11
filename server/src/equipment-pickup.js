const fail=(reply,code,message,status=422)=>reply.code(status).send({data:null,error:{code,message}});
const json=value=>{
  if(!value)return{};
  if(typeof value==='object')return value;
  try{return JSON.parse(value)}catch{return{}};
};
const labelDate=value=>value?new Date(value).toLocaleDateString('ru-RU',{day:'2-digit',month:'2-digit',year:'numeric',timeZone:'Asia/Qostanay'}):'—';

export async function installEquipmentPickup(app,pool,{enqueue,roles}){
  const q=(sql,params=[])=>pool.query(sql,params);

  async function settings(){return (await q('SELECT * FROM equipment_pickup_settings WHERE id=1')).rows[0]}
  async function responsible(c,branchId){
    for(const role of ['SUPERVISOR','MANAGER']){
      const row=(await c.query(`SELECT u.id FROM users u JOIN user_branches ub ON ub.user_id=u.id
        WHERE u.active=true AND u.role=$1 AND ub.branch_id=$2 ORDER BY ub.is_primary DESC,u.id LIMIT 1`,[role,branchId])).rows[0];
      if(row)return Number(row.id);
    }
    const owner=(await c.query("SELECT id FROM users WHERE active=true AND role='OWNER' ORDER BY id LIMIT 1")).rows[0];
    return owner?Number(owner.id):null;
  }
  async function cancelPendingMessages(c,requestId){
    try{
      await c.query(`UPDATE message_queue SET status='CANCELLED',processing_started_at=NULL,processing_token=NULL,updated_at=now()
        WHERE request_id=$1 AND dedupe_key LIKE 'pickup:%' AND status IN ('QUEUED','WAITING_RECIPIENT','ERROR')`,[requestId]);
    }catch(error){if(error?.code!=='42P01')throw error}
  }

  async function ensureReady(history){
    const requestId=Number(history?.request_id);
    if(!Number.isSafeInteger(requestId)||requestId<1)return{skipped:'request'};
    const cfg=await settings();
    const row=(await q(`SELECT r.id,r.customer_id,r.branch_id,r.status,r.closed_at,c.name customer_name,c.phone customer_phone,
      cur.holder,cur.location_text
      FROM requests r JOIN customers c ON c.id=r.customer_id
      LEFT JOIN equipment_custody_current cur ON cur.request_id=r.id
      WHERE r.id=$1 AND r.deleted_at IS NULL`,[requestId])).rows[0];
    if(!row||row.status!=='CLOSED')return{skipped:'not_closed'};
    if(!row.holder||row.holder==='CUSTOMER')return{skipped:'no_pickup'};
    const readyAt=history?.created_at||row.closed_at||new Date();
    const inserted=(await q(`INSERT INTO equipment_pickup_states(request_id,customer_id,branch_id,status,ready_at,storage_due_at,last_holder,source_history_id)
      VALUES($1,$2,$3,'WAITING',$4,$4::timestamptz+($5::int*interval '1 day'),$6,$7)
      ON CONFLICT(request_id) DO NOTHING RETURNING *`,[row.id,row.customer_id,row.branch_id,readyAt,Number(cfg.storage_days),row.holder,history?.id||null])).rows[0];
    if(inserted){
      await q(`INSERT INTO request_history(request_id,user_id,action,details) VALUES($1,NULL,'EQUIPMENT_PICKUP_READY',$2)`,[
        row.id,{pickup_state_id:inserted.id,ready_at:inserted.ready_at,storage_due_at:inserted.storage_due_at,holder:row.holder}
      ]);
      return{created:true,state:inserted};
    }
    const state=(await q('SELECT * FROM equipment_pickup_states WHERE request_id=$1',[row.id])).rows[0];
    if(state?.status==='WAITING'&&state.last_holder!==row.holder)await q('UPDATE equipment_pickup_states SET last_holder=$1,updated_at=now() WHERE id=$2',[row.holder,state.id]);
    return{created:false,state};
  }

  async function finish(requestId,at=new Date(),historyId=null){
    const c=await pool.connect();
    try{
      await c.query('BEGIN');
      const state=(await c.query('SELECT * FROM equipment_pickup_states WHERE request_id=$1 FOR UPDATE',[requestId])).rows[0];
      if(!state||state.status!=='WAITING'){await c.query('COMMIT');return{changed:false,state}}
      const updated=(await c.query(`UPDATE equipment_pickup_states SET status='PICKED_UP',picked_up_at=$1,last_holder='CUSTOMER',updated_at=now()
        WHERE id=$2 RETURNING *`,[at,state.id])).rows[0];
      if(state.escalation_task_id)await c.query("UPDATE tasks SET status='DONE',completed_at=COALESCE(completed_at,$1) WHERE id=$2 AND status='OPEN'",[at,state.escalation_task_id]);
      await cancelPendingMessages(c,requestId);
      await c.query(`INSERT INTO request_history(request_id,user_id,action,details) VALUES($1,NULL,'EQUIPMENT_PICKUP_COMPLETED',$2)`,[
        requestId,{pickup_state_id:state.id,picked_up_at:at,source_history_id:historyId}
      ]);
      await c.query('COMMIT');
      return{changed:true,state:updated};
    }catch(error){await c.query('ROLLBACK');throw error}finally{c.release()}
  }

  async function cancel(requestId,historyId=null){
    const c=await pool.connect();
    try{
      await c.query('BEGIN');
      const state=(await c.query('SELECT * FROM equipment_pickup_states WHERE request_id=$1 FOR UPDATE',[requestId])).rows[0];
      if(!state||state.status!=='WAITING'){await c.query('COMMIT');return{changed:false,state}}
      const updated=(await c.query("UPDATE equipment_pickup_states SET status='CANCELLED',updated_at=now() WHERE id=$1 RETURNING *",[state.id])).rows[0];
      if(state.escalation_task_id)await c.query("UPDATE tasks SET status='CANCELLED' WHERE id=$1 AND status='OPEN'",[state.escalation_task_id]);
      await cancelPendingMessages(c,requestId);
      await c.query('COMMIT');
      return{changed:true,state:updated,source_history_id:historyId};
    }catch(error){await c.query('ROLLBACK');throw error}finally{c.release()}
  }

  async function onHistory(history){
    if(history?.action==='REQUEST_CLOSED')return ensureReady(history);
    if(history?.action==='REQUEST_CANCELLED')return cancel(Number(history.request_id),history.id);
    if(history?.action==='EQUIPMENT_CUSTODY_EVENT'){
      const details=json(history.details);
      if(String(details.to_holder||'').toUpperCase()==='CUSTOMER')return finish(Number(history.request_id),history.created_at||new Date(),history.id);
    }
    return{skipped:'unrelated'};
  }

  async function reconcileTargets(){
    const undiscovered=(await q(`SELECT r.id request_id,h.id history_id,h.created_at
      FROM requests r JOIN equipment_custody_current cur ON cur.request_id=r.id
      LEFT JOIN equipment_pickup_states s ON s.request_id=r.id
      LEFT JOIN LATERAL(
        SELECT id,created_at FROM request_history rh WHERE rh.request_id=r.id AND rh.action='REQUEST_CLOSED' ORDER BY id DESC LIMIT 1
      ) h ON true
      WHERE s.id IS NULL AND r.deleted_at IS NULL AND r.status='CLOSED' AND cur.holder<>'CUSTOMER'
      ORDER BY r.closed_at NULLS LAST,r.id LIMIT 500`)).rows;
    for(const row of undiscovered)await ensureReady({request_id:row.request_id,id:row.history_id,created_at:row.created_at});
    const picked=(await q(`SELECT s.request_id FROM equipment_pickup_states s
      JOIN equipment_custody_current cur ON cur.request_id=s.request_id
      WHERE s.status='WAITING' AND cur.holder='CUSTOMER' LIMIT 500`)).rows;
    for(const row of picked)await finish(Number(row.request_id));
    const cancelled=(await q(`SELECT s.request_id FROM equipment_pickup_states s JOIN requests r ON r.id=s.request_id
      WHERE s.status='WAITING' AND r.status='CANCELLED' LIMIT 500`)).rows;
    for(const row of cancelled)await cancel(Number(row.request_id));
    return{discovered:undiscovered.length,picked:picked.length,cancelled:cancelled.length};
  }

  async function syncReminders(now=new Date()){
    const cfg=await settings();
    const reconciled=await reconcileTargets();
    if(!cfg?.active)return{active:false,reconciled,scanned:0,reminders:0,escalations:0};
    const rows=(await q(`SELECT s.*,r.number request_number,c.name customer_name,c.phone customer_phone,
      e.category,e.brand,e.model,cur.holder
      FROM equipment_pickup_states s JOIN requests r ON r.id=s.request_id JOIN customers c ON c.id=s.customer_id
      LEFT JOIN equipment e ON e.id=r.equipment_id LEFT JOIN equipment_custody_current cur ON cur.request_id=s.request_id
      WHERE s.status='WAITING' AND r.status='CLOSED' AND cur.holder IS NOT NULL AND cur.holder<>'CUSTOMER'
      ORDER BY s.storage_due_at,s.id LIMIT 500`)).rows;
    let reminders=0,escalations=0;
    for(const state of rows){
      const last=state.last_reminder_at?new Date(state.last_reminder_at):null;
      const dueReminder=!last||Number(now)-Number(last)>=Number(cfg.reminder_interval_days)*86400000;
      if(dueReminder&&state.customer_phone){
        const seq=Number(state.reminder_count||0)+1;
        const equipment=[state.category,state.brand,state.model].filter(Boolean).join(' ')||'техника';
        const body=`${state.customer_name}, ваша ${equipment} по заказу ${state.request_number} готова к выдаче в PROFI24KST. Просим забрать её до ${labelDate(state.storage_due_at)}. Если нужна помощь с выдачей, свяжитесь с сервисным центром.`;
        const queued=await enqueue({request_id:Number(state.request_id),template_code:null,audience:'CUSTOMER',channel:'WHATSAPP',recipient:state.customer_phone,body,dedupe_key:`pickup:${state.id}:reminder:${seq}`,created_by:null});
        if(queued){
          await q("UPDATE equipment_pickup_states SET reminder_count=$1,last_reminder_at=$2,updated_at=now() WHERE id=$3 AND status='WAITING'",[seq,now,state.id]);
          await q(`INSERT INTO request_history(request_id,user_id,action,details) VALUES($1,NULL,'EQUIPMENT_PICKUP_REMINDER',$2)`,[state.request_id,{pickup_state_id:state.id,reminder_number:seq,storage_due_at:state.storage_due_at}]);
          reminders++;
        }
      }
      if(!state.escalation_task_id&&new Date(state.storage_due_at)<=now){
        const c=await pool.connect();
        try{
          await c.query('BEGIN');
          const locked=(await c.query('SELECT * FROM equipment_pickup_states WHERE id=$1 FOR UPDATE',[state.id])).rows[0];
          if(locked?.status==='WAITING'&&!locked.escalation_task_id){
            const assignee=await responsible(c,locked.branch_id);
            if(assignee){
              const task=(await c.query(`INSERT INTO tasks(title,request_id,assigned_to,priority,status,due_at,created_by)
                VALUES($1,$2,$3,'HIGH','OPEN',$4,NULL) RETURNING id`,[`Невостребованная техника · ${state.request_number}`,state.request_id,assignee,now])).rows[0];
              await c.query('UPDATE equipment_pickup_states SET escalation_task_id=$1,updated_at=now() WHERE id=$2',[task.id,state.id]);
              await c.query(`INSERT INTO request_history(request_id,user_id,action,details) VALUES($1,NULL,'EQUIPMENT_PICKUP_ESCALATED',$2)`,[state.request_id,{pickup_state_id:state.id,task_id:task.id,storage_due_at:state.storage_due_at}]);
              escalations++;
            }
          }
          await c.query('COMMIT');
        }catch(error){await c.query('ROLLBACK');throw error}finally{c.release()}
      }
    }
    return{active:true,reconciled,scanned:rows.length,reminders,escalations};
  }

  app.get('/api/v1/equipment-pickup/settings',{preHandler:roles('OWNER','SUPERVISOR','MANAGER')},async()=>({data:await settings()}));
  app.patch('/api/v1/equipment-pickup/settings',{preHandler:roles('OWNER','SUPERVISOR')},async(req,reply)=>{
    const old=await settings(),storage=Number(req.body?.storage_days??old.storage_days),interval=Number(req.body?.reminder_interval_days??old.reminder_interval_days);
    if(!Number.isInteger(storage)||storage<1||storage>90)return fail(reply,'VALIDATION','Срок хранения должен быть от 1 до 90 дней');
    if(!Number.isInteger(interval)||interval<1||interval>30)return fail(reply,'VALIDATION','Интервал напоминаний должен быть от 1 до 30 дней');
    const row=(await q(`UPDATE equipment_pickup_settings SET active=$1,storage_days=$2,reminder_interval_days=$3,updated_by=$4,updated_at=now() WHERE id=1 RETURNING *`,[
      req.body?.active===undefined?old.active:Boolean(req.body.active),storage,interval,req.user.id
    ])).rows[0];
    return{data:row};
  });
  app.get('/api/v1/equipment-pickup',{preHandler:roles('OWNER','SUPERVISOR','MANAGER')},async req=>{
    const params=[];let where='1=1';
    if(req.user.role==='MANAGER'){params.push(req.user.id);where+=` AND EXISTS(SELECT 1 FROM user_branches ub WHERE ub.user_id=$${params.length} AND ub.branch_id=s.branch_id)`}
    if(req.query?.status){params.push(String(req.query.status).toUpperCase());where+=` AND s.status=$${params.length}`}
    const rows=(await q(`SELECT s.*,r.number request_number,c.name customer_name,c.phone customer_phone,e.category,e.brand,e.model,
      cur.holder,t.status escalation_status,t.due_at escalation_due_at
      FROM equipment_pickup_states s JOIN requests r ON r.id=s.request_id JOIN customers c ON c.id=s.customer_id
      LEFT JOIN equipment e ON e.id=r.equipment_id LEFT JOIN equipment_custody_current cur ON cur.request_id=s.request_id
      LEFT JOIN tasks t ON t.id=s.escalation_task_id WHERE ${where}
      ORDER BY CASE s.status WHEN 'WAITING' THEN 0 ELSE 1 END,s.storage_due_at,s.id DESC LIMIT 500`,params)).rows;
    return{data:rows};
  });

  return{settings,ensureReady,onHistory,reconcileTargets,syncReminders,finish,cancel};
}
