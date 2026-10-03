import {authenticate} from './access.js';

// One control per request. A manual/acknowledged control is never overwritten.
export async function syncSlaControls(pool){
 return pool.query(`INSERT INTO dispatch_controls(request_id,reason,owner_id,control_due_at)
  SELECT id,CASE WHEN sla_reacted_at IS NULL THEN 'Просрочена реакция SLA' ELSE 'Просрочено выполнение SLA' END,manager_id,sla_deadline
  FROM requests WHERE sla_reaction_minutes IS NOT NULL AND deleted_at IS NULL
   AND status NOT IN ('CLOSED','CANCELLED','PAYMENT_REQUIRED') AND sla_deadline<now()
  ON CONFLICT(request_id) DO NOTHING RETURNING request_id`);
}

export function registerSlaRoutes(app,pool){
 const auth=async(req,reply)=>{
  if(!await authenticate(req,reply,pool))return;
  if(!['OWNER','SUPERVISOR'].includes(req.user.role))return reply.code(403).send({data:null,error:{code:'FORBIDDEN',message:'Недостаточно прав'}});
 };
 app.get('/api/v1/sla/policies',{preHandler:auth},async()=>({data:(await pool.query('SELECT * FROM sla_policies ORDER BY order_type,priority')).rows}));
 app.put('/api/v1/sla/policies/:orderType/:priority',{preHandler:auth},async(req,reply)=>{
  const {reaction_minutes,execution_minutes}=req.body||{};
  if(!['REPAIR','FIELD','PAID_WORKSHOP'].includes(req.params.orderType)||!['NORMAL','CRITICAL'].includes(req.params.priority)
   ||![reaction_minutes,execution_minutes].every(n=>Number.isSafeInteger(n)&&n>=1&&n<=525600))
   return reply.code(422).send({data:null,error:{code:'VALIDATION',message:'Сроки должны быть целыми: от 1 до 525600 минут'}});
  const row=(await pool.query(`UPDATE sla_policies SET reaction_minutes=$3,execution_minutes=$4,updated_by=$5,updated_at=now()
   WHERE order_type=$1 AND priority=$2 RETURNING *`,[req.params.orderType,req.params.priority,reaction_minutes,execution_minutes,req.user.id])).rows[0];
  return {data:row};
 });
}
