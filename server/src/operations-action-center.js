const GLOBAL_ROLES=new Set(['OWNER','SUPERVISOR']);
const ACTIVE_STATUSES="r.deleted_at IS NULL AND r.status NOT IN('CLOSED','CANCELLED')";
const scopeSql=alias=>`($1::int[] IS NULL OR ${alias}.branch_id=ANY($1::int[]))`;
const mins=(a,b)=>Math.max(0,Math.floor((new Date(a).getTime()-new Date(b).getTime())/60000));
const number=v=>Number(v||0);
const businessError=(code,message,statusCode=422)=>Object.assign(new Error(message),{code,statusCode});

export async function resolveOperationsScope(pool,user,requestedBranchId=null){
 if(!user||!['OWNER','SUPERVISOR','MANAGER'].includes(user.role))throw businessError('FORBIDDEN','Недостаточно прав',403);
 const requested=Number(requestedBranchId||0);
 if(requested&&(!Number.isSafeInteger(requested)||requested<1))throw businessError('VALIDATION','Некорректный филиал',422);
 if(GLOBAL_ROLES.has(user.role)){
  if(!requested)return{branchIds:null,selectedBranchId:null};
  const exists=(await pool.query('SELECT id FROM branches WHERE id=$1 AND active=true',[requested])).rows[0];
  if(!exists)throw businessError('NOT_FOUND','Филиал не найден',404);
  return{branchIds:[requested],selectedBranchId:requested};
 }
 const allowed=(await pool.query('SELECT branch_id FROM user_branches WHERE user_id=$1 ORDER BY branch_id',[Number(user.id)])).rows.map(x=>Number(x.branch_id));
 if(requested&&!allowed.includes(requested))throw businessError('FORBIDDEN','Филиал недоступен пользователю',403);
 return{branchIds:requested?[requested]:allowed,selectedBranchId:requested||null};
}

function severityScore(type,row,now){
 const priority=String(row.priority||'NORMAL'),boost=priority==='CRITICAL'?12:priority==='HIGH'?6:0;
 if(type==='SLA_OVERDUE')return{severity:'CRITICAL',score:110+boost};
 if(type==='VISIT_OVERDUE'){const late=mins(now,row.scheduled_at);return{severity:late>=60?'CRITICAL':'HIGH',score:(late>=60?105:88)+boost};}
 if(type==='RESCHEDULE_REQUIRED')return{severity:'CRITICAL',score:104+boost};
 if(type==='TASK_OVERDUE'){const late=mins(now,row.due_at);return{severity:late>=1440?'CRITICAL':'HIGH',score:(late>=1440?102:84)+Math.min(10,Math.floor(late/60))};}
 if(type==='CONFIRMATION_CALL')return{severity:'HIGH',score:90+boost};
 if(type==='UNASSIGNED')return{severity:'HIGH',score:82+boost};
 if(type==='APPROVAL_STUCK')return{severity:'HIGH',score:78+boost};
 if(type==='PART_STUCK')return{severity:'HIGH',score:74+boost};
 if(type==='PAYMENT_STUCK')return{severity:'HIGH',score:72+Math.min(12,Math.floor(number(row.outstanding_amount)/50000))};
 if(type==='COMPLAINT_OPEN')return{severity:String(row.complaint_severity||'NORMAL')==='CRITICAL'?'CRITICAL':'HIGH',score:String(row.complaint_severity||'NORMAL')==='CRITICAL'?108:80};
 return{severity:'MEDIUM',score:50};
}
function actionCopy(type,row){
 const map={
  SLA_OVERDUE:['Просрочен SLA','Связаться с ответственным и зафиксировать план завершения сегодня.'],
  VISIT_OVERDUE:['Просрочен выезд','Проверить статус инженера, связаться с клиентом и скорректировать визит.'],
  UNASSIGNED:['Заявка без инженера','Назначить инженера и согласовать время с клиентом.'],
  APPROVAL_STUCK:['Зависло согласование','Получить решение клиента или зафиксировать причину ожидания.'],
  PART_STUCK:['Зависло ожидание запчасти','Проверить заказ детали, ETA и сообщить клиенту актуальный срок.'],
  PAYMENT_STUCK:['Ремонт ждёт оплату','Связаться с клиентом и закрыть задолженность либо документировать причину.'],
  TASK_OVERDUE:['Просрочена задача','Выполнить, переназначить или документированно изменить срок задачи.'],
  RESCHEDULE_REQUIRED:['Клиент запросил перенос','Связаться с клиентом, назначить новое время и только затем обновить маршрут.'],
  CONFIRMATION_CALL:['Визит требует подтверждения','Срочно связаться с клиентом и подтвердить визит до выезда инженера.'],
  COMPLAINT_OPEN:['Открыта претензия','Связаться с клиентом и довести претензию до зафиксированного решения.']
 };
 return map[type]||['Нужно вмешательство','Проверить ситуацию и назначить ответственное действие.'];
}
function normalize(type,row,now){
 const [title,next_action]=actionCopy(type,row),rank=severityScore(type,row,now);
 const due=row.due_at||row.sla_deadline||row.scheduled_at||row.part_eta||row.updated_at||row.created_at;
 return{
  action_id:`${type}:${row.task_id||row.complaint_id||row.visit_confirmation_id||row.id}`,
  type,title,next_action,severity:rank.severity,score:rank.score,
  request_id:row.id?Number(row.id):row.request_id?Number(row.request_id):null,
  number:row.number||row.request_number||null,
  branch_id:row.branch_id==null?null:Number(row.branch_id),branch_name:row.branch_name||null,
  customer_name:row.customer_name||null,phone:row.phone||null,
  engineer_name:row.engineer_name||null,manager_name:row.manager_name||null,
  request_status:row.status||row.request_status||null,priority:row.priority||null,
  due_at:due||null,age_minutes:due?mins(now,due):0,
  outstanding_amount:number(row.outstanding_amount),
  task_id:row.task_id?Number(row.task_id):null,task_title:row.task_title||null,
  complaint_id:row.complaint_id?Number(row.complaint_id):null,
  visit_confirmation_id:row.visit_confirmation_id?Number(row.visit_confirmation_id):null,
  detail:row.detail||row.response_comment||row.complaint_text||row.complaint||null
 };
}

export async function buildOperationsActions(pool,{branchIds=null,now=new Date()}={}){
 const p=[branchIds,now];
 const base=`SELECT r.id,r.number,r.branch_id,r.status,r.priority,r.sla_deadline,r.scheduled_at,r.updated_at,r.created_at,r.total,r.paid,r.complaint,c.name customer_name,c.phone,eng.name engineer_name,m.name manager_name,b.name branch_name FROM requests r JOIN customers c ON c.id=r.customer_id LEFT JOIN users eng ON eng.id=r.engineer_id LEFT JOIN users m ON m.id=r.manager_id LEFT JOIN branches b ON b.id=r.branch_id`;
 const [sla,visits,unassigned,approvals,parts,payments,tasks,confirmations,complaints]=await Promise.all([
  pool.query(`${base} WHERE ${scopeSql('r')} AND ${ACTIVE_STATUSES} AND r.sla_deadline IS NOT NULL AND r.sla_deadline<$2`,p),
  pool.query(`${base} WHERE ${scopeSql('r')} AND ${ACTIVE_STATUSES} AND r.scheduled_at IS NOT NULL AND r.scheduled_at<$2-interval '20 minutes' AND r.status<>'PAYMENT_REQUIRED' AND NOT EXISTS(SELECT 1 FROM request_stage_events se WHERE se.request_id=r.id AND se.event='ARRIVE' AND se.created_at>=r.scheduled_at-interval '12 hours')`,p),
  pool.query(`${base} WHERE ${scopeSql('r')} AND ${ACTIVE_STATUSES} AND r.engineer_id IS NULL AND r.created_at<$2-interval '15 minutes'`,p),
  pool.query(`${base} WHERE ${scopeSql('r')} AND ${ACTIVE_STATUSES} AND r.status='APPROVAL_REQUIRED' AND r.updated_at<$2-interval '30 minutes'`,p),
  pool.query(`${base},LATERAL(SELECT min(eta) part_eta FROM parts p2 WHERE p2.request_id=r.id AND p2.eta IS NOT NULL) px WHERE ${scopeSql('r')} AND ${ACTIVE_STATUSES} AND r.status='WAITING_PART' AND (r.updated_at<$2-interval '72 hours' OR px.part_eta<(($2 AT TIME ZONE 'Asia/Qostanay')::date))`,p),
  pool.query(`${base} WHERE ${scopeSql('r')} AND r.deleted_at IS NULL AND r.status='PAYMENT_REQUIRED' AND GREATEST(COALESCE(r.total,0)-COALESCE(r.paid,0),0)>0 AND r.updated_at<$2-interval '24 hours'`,p),
  pool.query(`SELECT r.id,r.number,r.branch_id,r.status,r.priority,r.scheduled_at,r.updated_at,r.complaint,c.name customer_name,c.phone,eng.name engineer_name,m.name manager_name,b.name branch_name,t.id task_id,t.title task_title,t.due_at,t.created_at FROM tasks t JOIN requests r ON r.id=t.request_id JOIN customers c ON c.id=r.customer_id LEFT JOIN users eng ON eng.id=r.engineer_id LEFT JOIN users m ON m.id=r.manager_id LEFT JOIN branches b ON b.id=r.branch_id WHERE ${scopeSql('r')} AND r.deleted_at IS NULL AND t.status='OPEN' AND t.due_at IS NOT NULL AND t.due_at<$2`,p),
  pool.query(`SELECT r.id,r.number,r.branch_id,r.status,r.priority,r.scheduled_at,r.updated_at,r.complaint,c.name customer_name,c.phone,eng.name engineer_name,m.name manager_name,b.name branch_name,v.id visit_confirmation_id,v.status visit_status,v.response_comment,ct.id confirmation_task_id,ct.status confirmation_task_status,ct.due_at confirmation_task_due_at FROM customer_visit_confirmations v JOIN requests r ON r.id=v.request_id JOIN customers c ON c.id=r.customer_id LEFT JOIN users eng ON eng.id=r.engineer_id LEFT JOIN users m ON m.id=r.manager_id LEFT JOIN branches b ON b.id=r.branch_id LEFT JOIN tasks ct ON ct.id=v.confirmation_task_id WHERE ${scopeSql('r')} AND r.deleted_at IS NULL AND r.status NOT IN('CLOSED','CANCELLED') AND v.is_current=true AND ((v.status='RESCHEDULE_REQUESTED') OR (v.status='PENDING' AND ct.status='OPEN'))`,p),
  pool.query(`SELECT r.id,r.number,r.branch_id,r.status,r.priority,r.scheduled_at,r.updated_at,r.complaint,cus.name customer_name,cus.phone,eng.name engineer_name,m.name manager_name,b.name branch_name,co.id complaint_id,co.text complaint_text,co.severity complaint_severity,co.created_at FROM complaints co LEFT JOIN requests r ON r.id=co.request_id LEFT JOIN customers cus ON cus.id=co.customer_id LEFT JOIN users eng ON eng.id=r.engineer_id LEFT JOIN users m ON m.id=r.manager_id LEFT JOIN branches b ON b.id=r.branch_id WHERE co.status='OPEN' AND (($1::int[] IS NULL) OR (r.branch_id=ANY($1::int[])))`,p)
 ]);
 const actions=[];
 for(const row of sla.rows)actions.push(normalize('SLA_OVERDUE',row,now));
 for(const row of visits.rows)actions.push(normalize('VISIT_OVERDUE',row,now));
 for(const row of unassigned.rows)actions.push(normalize('UNASSIGNED',row,now));
 for(const row of approvals.rows)actions.push(normalize('APPROVAL_STUCK',row,now));
 for(const row of parts.rows)actions.push(normalize('PART_STUCK',row,now));
 for(const row of payments.rows){row.outstanding_amount=Math.max(0,number(row.total)-number(row.paid));actions.push(normalize('PAYMENT_STUCK',row,now));}
 for(const row of tasks.rows)actions.push(normalize('TASK_OVERDUE',row,now));
 for(const row of confirmations.rows){row.due_at=row.confirmation_task_due_at;if(row.visit_status==='RESCHEDULE_REQUESTED')actions.push(normalize('RESCHEDULE_REQUIRED',row,now));else actions.push(normalize('CONFIRMATION_CALL',row,now));}
 for(const row of complaints.rows)actions.push(normalize('COMPLAINT_OPEN',row,now));
 actions.sort((a,b)=>b.score-a.score||String(a.due_at||'').localeCompare(String(b.due_at||''))||String(a.action_id).localeCompare(String(b.action_id)));
 const by_type={};for(const a of actions)by_type[a.type]=(by_type[a.type]||0)+1;
 return{generated_at:now.toISOString(),summary:{total:actions.length,critical:actions.filter(x=>x.severity==='CRITICAL').length,high:actions.filter(x=>x.severity==='HIGH').length,medium:actions.filter(x=>x.severity==='MEDIUM').length,payment_at_risk:actions.filter(x=>x.type==='PAYMENT_STUCK').reduce((s,x)=>s+x.outstanding_amount,0),by_type},actions:actions.slice(0,300)};
}
